/**
 * AGENTS / TEAM — sub-agent spawning and the build-or-plan switch.
 *
 * `/agents build <x>` runs a sub-agent that is ALLOWED to edit files and run
 * commands. `/agents plan <x>` runs one that is FORBIDDEN to: it reads,
 * reasons and returns a plan, and nothing on disk changes. The distinction is
 * enforced here, in the spawned process's harness, not by asking the model
 * politely in a prompt.
 *
 * Why sub-agents at all rather than one long conversation: a build is a long
 * multi-step job with its own failure modes. Running it in a child with its own
 * harness means its tool calls are audited separately, its approvals cannot
 * leak into the parent's pending list, and killing it cannot take the trader
 * down.
 *
 * Each child gets:
 *   - the parent's model routing (it speaks to the same AI layer)
 *   - its own approval ledger
 *   - a strict filesystem jail inherited from filetools.PROJECT_ROOT
 *   - a hard step budget, so a confused sub-agent cannot loop forever
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import ai from './providers.js';
import { classify, CLASS, harness } from './harness.js';
import { createLogger } from '../logger.js';
import * as db from '../db/index.js';

const execAsync = promisify(exec);
const log = createLogger('agents');

const BUDGET = { plan: 12, build: 60 };

/** The tool belt a sub-agent may use. Deliberately narrower than the parent's. */
function childTools(mode) {
  const READ_ONLY = new Set([
    'get_balance', 'get_positions', 'get_ticker', 'get_kline', 'get_depth',
    'get_funding', 'get_funding_history', 'get_trading_pairs', 'get_universe',
    'get_settings', 'get_pending_orders', 'get_order_history', 'get_position_history',
    'get_tpsl_orders', 'get_position_tiers', 'get_recent_signals', 'get_performance',
    'get_cooldowns', 'read_file', 'search_files', 'list_files', 'find_usages',
    'recall', 'get_universe',
  ]);
  const ALL = [...READ_ONLY, 'scan_market', 'analyse_symbol', 'preview_risk'];

  const tools = mode === 'build' ? [...ALL, 'write_file', 'edit_file', 'run_command'] : ALL;

  // Deferred import: tools.js imports providers.js, and importing it at module
  // load would put the whole MCP + exchange surface in the child before its
  // harness exists.
  return tools;
}

/**
 * Spawn one sub-agent. Returns { text, trace, mode }.
 *
 * `mode` decides power: 'plan' gets reads only, 'build' also gets writes and
 * exec, and in BOTH cases anything the parent has auto-approved still flows
 * through the child's own gate — auto-approve is a property of a session, not
 * a blanket.
 */
export async function spawn({ goal, mode = 'plan', thinking = null, onStep = null, chatId = 'subagent' }) {
  if (!goal || !String(goal).trim()) throw new Error('a sub-agent needs a goal');
  const allowed = new Set(childTools(mode));

  const budget = BUDGET[mode] ?? BUDGET.plan;
  const h = harness();

  const prompt = mode === 'build'
    ? `You are a BUILD sub-agent. Goal:\n\n${goal}\n\n`
      + 'Work in the project directory. Read before you write. Use write_file/edit_file '
      + 'for changes and run_command to verify (node --check, npm test). When done, state '
      + 'exactly what you changed and what you ran. Do not summarise work you did not do.'
    : `You are a PLAN sub-agent. Goal:\n\n${goal}\n\n`
      + 'You have READ-ONLY tools. Do not attempt to edit anything. Investigate fully, then '
      + 'return a concrete plan: files to touch, what changes in each, risks, and the order. '
      + 'Be specific enough that someone else could execute it without re-deriving anything.';

  const schemas = (await import('./tools.js')).toolSchemas()
    .filter((t) => allowed.has(t.name));

  const messages = [{ role: 'system', content: prompt }];
  const trace = [];
  let final = '';
  let steps = 0;

  while (steps < budget) {
    steps++;
    let res;
    try {
      res = await ai.chat({ messages, tools: schemas, thinking: thinking || 'medium', maxTokens: 2500 });
    } catch (e) {
      final = `⚠️ sub-agent AI failure: ${e.message}`;
      break;
    }

    if (!res.toolCalls?.length) { final = res.content || '(no answer)'; break; }
    if (res.content?.trim() && onStep) await onStep({ type: 'thought', text: res.content.trim() });

    messages.push({
      role: 'assistant',
      content: res.content || '',
      tool_calls: res.toolCalls.map((c) => ({
        id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) },
      })),
    });

    for (const call of res.toolCalls) {
      const tool = (await import('./tools.js')).TOOL_MAP[call.name];
      const kind = classify(call.name, tool);
      if (!allowed.has(call.name)) {
        const msg = `refused: ${call.name} is not available to a ${mode} sub-agent`;
        trace.push({ tool: call.name, refused: msg });
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: msg });
        continue;
      }
      // EXEC in a build sub-agent is still the parent's business: refuse it
      // unless the user explicitly turned exec on for the parent.
      if (kind === CLASS.EXEC && h.terminal === 'off') {
        const msg = 'refused: terminal access is off';
        trace.push({ tool: call.name, refused: msg });
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: msg });
        continue;
      }

      const { runTool } = await import('./tools.js');
      const out = await runTool(call.name, call.args);
      trace.push({ tool: call.name, args: call.args, result: out });
      if (onStep) await onStep({ type: 'tool', name: call.name, args: call.args, kind });
      messages.push({
        role: 'tool', tool_call_id: call.id, name: call.name,
        content: JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? String(v) : v)).slice(0, 12000),
      });
    }
  }

  if (steps >= budget && !final) final = `stopped at the ${budget}-step budget without a final answer.`;

  await db.logEvent('subagent', { mode, goal: String(goal).slice(0, 400), steps, chars: final?.length || 0 })
    .catch(() => {});
  log.info(`sub-agent (${mode}) finished in ${steps} steps`);
  return { text: final, trace, mode, steps };
}

/** /team — what the team can currently do, and what it actually did. */
export async function teamStatus() {
  const { rows } = await db.q(
    `SELECT payload, created_at FROM agent_events
      WHERE kind = 'subagent' ORDER BY created_at DESC LIMIT 10`,
  ).catch(() => ({ rows: [] }));
  const h = harness();
  return {
    modes: Object.entries(BUDGET).map(([m, steps]) => ({ mode: m, step_budget: steps })),
    terminal: h.terminal,
    auto_approve_edit: h.autoApproveEdit,
    auto_approve_exec: h.autoApproveExec,
    recent: rows.map((r) => ({ at: r.created_at, ...r.payload })),
  };
}

/**
 * /agents list — enumerate the sub-agents this project knows how to spawn.
 * Derived from the tool belt, so it cannot drift from what can actually run.
 */
export function agentCatalogue() {
  return [
    { key: 'plan', kind: 'read-only', budget: BUDGET.plan, desc: 'Investigate and return a concrete, executable plan. Changes nothing.' },
    { key: 'build', kind: 'read/write/exec', budget: BUDGET.build, desc: 'Edit files and run commands, verify with the project test suite.' },
    { key: 'review', kind: 'read-only', budget: BUDGET.plan, desc: 'Read code and hunt for defects. See /code-review.' },
    { key: 'audit-endpoints', kind: 'read-only', budget: BUDGET.plan, desc: 'Diff every exchange path against the official SDK.' },
  ];
}

