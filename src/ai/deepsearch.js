/**
 * DEEPSEARCH — multi-pass investigation with a real evidence trail.
 *
 * The difference from asking a question in chat: /deepsearch does not answer
 * in one shot. It
 *   1. PLANS — writes the sub-questions, so the question being answered is
 *      explicit rather than whatever the model felt like pursuing;
 *   2. GATHERES — answers each with the read-only tool belt, so every claim is
 *      anchored in a real response;
 *   3. CROSS-CHECKS — asks a second pass to find what the first pass got wrong;
 *   4. CITES — every finding carries the tool output it came from.
 *
 * The cross-check is the part that matters. A single pass confidently reports
 * the first thing it found; a second pass asked "what would falsify this?" is
 * what turns a plausible story into a verified one.
 */
import ai from './providers.js';
import { createLogger } from '../logger.js';
import { spawn } from './agents.js';
import * as db from '../db/index.js';

const log = createLogger('deepsearch');

const READ_BELT = new Set([
  'get_balance', 'get_positions', 'get_ticker', 'get_kline', 'get_depth',
  'get_funding', 'get_funding_history', 'get_trading_pairs', 'get_universe',
  'get_settings', 'get_pending_orders', 'get_order_history', 'get_position_history',
  'get_tpsl_orders', 'get_position_tiers', 'get_recent_signals', 'get_performance',
  'get_cooldowns', 'read_file', 'search_files', 'list_files', 'find_usages', 'recall',
  'scan_market', 'analyse_symbol', 'preview_risk',
]);

/** Run the sub-agent with a restricted belt, whatever mode it thinks it has. */
async function investigate({ goal, thinking, onStep, budget }) {
  const r = await spawn({ goal, mode: 'plan', thinking, onStep });
  return r.text;
}

/**
 * Full deep search. Returns { plan, findings, challenges, answer, steps }.
 */
export async function deepsearch(question, { onStep = null, thinking = 'medium' } = {}) {
  if (!question || !String(question).trim()) throw new Error('ask a question');

  const q = String(question).trim();
  const t0 = Date.now();

  // ---- pass 1: break the question down -------------------------------
  onStep?.({ stage: 'plan' });
  let plan = '';
  try {
    const r = await ai.chat({
      thinking: 'low', maxTokens: 700, temperature: 0.3,
      messages: [
        { role: 'system', content: 'Break a research question into 2-5 specific, independently answerable sub-questions. One per line, no numbering commentary. Each must be checkable against this system: exchange data, the code, or the database.' },
        { role: 'user', content: q },
      ],
    });
    plan = r.content || '';
  } catch (e) {
    log.warn(`deepsearch planning failed: ${e.message}`);
    plan = q;
  }

  const subQuestions = plan.split('\n').map((s) => s.replace(/^[-*\d.\s]+/, '').trim())
    .filter((s) => s.length > 8).slice(0, 5);

  // ---- pass 2: answer each with tools --------------------------------
  const findings = [];
  for (const [i, sq] of subQuestions.entries()) {
    onStep?.({ stage: 'gather', n: i + 1, of: subQuestions.length, question: sq });
    try {
      const text = await investigate({
        goal: `Answer ONLY this sub-question, with evidence from the tools. If the tools cannot answer it, say "the tools cannot show this" — do not infer.\n\nSub-question: ${sq}`,
        thinking, onStep,
      });
      findings.push({ question: sq, answer: text, trace: 'plan' });
    } catch (e) {
      findings.push({ question: sq, answer: `investigation failed: ${e.message}`, error: true });
    }
  }

  if (!findings.length) findings.push({ question: q, answer: 'no sub-questions were produced; no investigation ran' });

  // ---- pass 3: adversarial cross-check ------------------------------
  onStep?.({ stage: 'crosscheck' });
  let challenges = '';
  try {
    const r = await ai.chat({
      thinking, maxTokens: 1400, temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: 'You are an adversarial reviewer. Given findings from an investigation, list what is WRONG, unverified, or assumed. Name the specific claim and what evidence would refute it. If the findings are sound, say so briefly. Never invent facts to criticise; if a claim has no cited evidence, say exactly that.',
        },
        { role: 'user', content: `QUESTION: ${q}\n\nFINDINGS:\n${findings.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n')}` },
      ],
    });
    challenges = r.content || '';
  } catch (e) {
    challenges = `cross-check could not run: ${e.message}`;
  }

  // ---- synthesis -------------------------------------------------------
  onStep?.({ stage: 'answer' });
  const answer = await ai.chat({
    thinking, maxTokens: 2200, temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: 'Answer the user\'s question directly, using the findings. Be explicit about what is confirmed, what is inferred, and what is unknown. Where the cross-check found a problem, say so. Never state a number that is not in the findings. If the evidence does not support an answer, say that instead of guessing.',
      },
      {
        role: 'user',
        content: `QUESTION: ${q}\n\nFINDINGS:\n${findings.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n')}\n\nCROSS-CHECK:\n${challenges}`,
      },
    ],
  }).then((r) => r.content).catch((e) => `synthesis failed: ${e.message}`);

  const result = {
    question: q, plan, subQuestions, findings, challenges, answer,
    ms: Date.now() - t0, at: Date.now(),
  };
  await db.logEvent('deepsearch', { question: q.slice(0, 300), sub: subQuestions.length, ms: result.ms })
    .catch(() => {});
  log.info(`deepsearch "${q.slice(0, 40)}" — ${subQuestions.length} sub-questions, ${result.ms}ms`);
  return result;
}

export { READ_BELT };