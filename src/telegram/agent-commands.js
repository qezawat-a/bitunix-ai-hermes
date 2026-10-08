/**
 * The J+Rock command surface — every command the user asked for, in one file.
 *
 * WHY A SEPARATE FILE
 * -------------------
 * src/telegram/commands.js already held the TRADER commands (status, scan,
 * close, leverage, TPSL…). Those belong to the engine, and the engine must stay
 * usable without the agent. So this file holds the AGENT commands — harness,
 * models, provider, skills, soul, memory, dream, deepsearch, code-review,
 * bugfixes, learning, tools, config, generator, sessions, team, agents, compat,
 * app_connector, quit — and reaches into the trader only where an agent
 * command genuinely needs it (/harness reports live state).
 *
 * Nothing here is a stub that prints "not implemented". Every handler does the
 * work or says plainly why it cannot.
 *
 * On /models and /set models: the requirement was "no fallback, no hardcoded
 * model — auto-find what my key can call". That is providers.autoSetModelByKey():
 * it lists /models on the base URL from .env, filters to chat-capable ids,
 * ranks them, and PROBES each with a real tool-calling request. Nothing in this
 * file contains a model name.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ai from '../ai/providers.js';
import agent from '../ai/agent.js';
import * as harnessMod from '../ai/harness.js';
import * as compat from '../ai/compat.js';
import * as learning from '../ai/learning.js';
import * as agentsMod from '../ai/agents.js';
import * as deepsearch from '../ai/deepsearch.js';
import * as codereview from '../ai/codereview.js';
import * as generator from '../ai/generator.js';
import { loadSoul, loadSkillFiles } from '../ai/soul.js';
import { allTools, TOOL_MAP, mcpStatus, reloadMcpTools } from '../ai/tools.js';
import * as db from '../db/index.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { md, mdt, bold, italic, code, agentText } from './format.js';

const log = createLogger('agentcmd');

function onOff(v) {
  const s = String(v || '').toLowerCase();
  if (['on', 'true', 'yes', '1', 'enable', 'enabled'].includes(s)) return true;
  if (['off', 'false', 'no', '0', 'disable', 'disabled'].includes(s)) return false;
  throw new Error(`expected on or off, got "${v}"`);
}

const skillsDir = () => path.resolve(process.cwd(), 'soul/skills');
const soulFile = (n) => path.resolve(process.cwd(), 'soul', n);

/**
 * Build the agent-command table.
 * @param {{bot: object, orchestrator: object}} ctx
 */
export function createAgentCommands(ctx) {
  const bot = ctx && ctx.bot;
  const orchestrator = ctx && ctx.orchestrator;

  const reply = (chatId, text, extra) => bot.sendMessage(chatId, text, extra);
  const fail = (chatId, e) => reply(chatId, mdt`❌ ${e.message || e}`);

  const C = {};

  // =============================================================== /harness
  /**
   * /harness — the place that cannot lie about what is switched on.
   * Every row is a live read: a real signed exchange call, a real Neon query,
   * real WebSocket state. Anything unreadable prints as unknown, never as a
   * plausible default.
   */
  C.harness = async (chatId, args) => {
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'approve' || sub === 'yes' || sub === 'no' || sub === 'deny') {
      const id = args[1];
      if (!id) return reply(chatId, mdt`Usage: /harness ${sub} <id>`);
      const ok = sub === 'approve' || sub === 'yes';
      const p = harnessMod.settle(id, ok ? 'approve' : 'deny');
      if (!p) {
        return reply(chatId, mdt`No pending approval ${id}. ${harnessMod.pendingApprovals().length} waiting.`);
      }
      return reply(chatId, mdt`${ok ? '✅' : '🚫'} ${p.tool} (${p.kind}) ${ok ? 'approved' : 'denied'}.`);
    }

    if (sub === 'allow' || sub === 'deny-all') {
      const n = harnessMod.settleAll(sub === 'allow' ? 'approve' : 'deny');
      return reply(chatId, mdt`${n.length} approval(s) settled.`);
    }

    const FLAG_MAP = {
      'auto-approve': 'autoApproveEdit',
      auto_approve_on_edit: 'autoApproveEdit',
      'auto-approve-edit': 'autoApproveEdit',
      auto_approve_exec: 'autoApproveExec',
      'auto-approve-exec': 'autoApproveExec',
      exec: 'autoApproveExec',
      learning: 'learning',
      'auto-compat': 'autoCompat',
      auto_compat: 'autoCompat',
      terminal: 'terminal',
    };
    const flag = FLAG_MAP[sub];

    if ((sub === 'on' || sub === 'off') && flag) {
      try {
        const value = flag === 'terminal' ? (args[2] || 'write') : onOff(sub);
        const r = harnessMod.setFlag(flag, value);
        await harnessMod.persistFlag(flag, r.after);
        return reply(chatId, mdt`${flag}: ${r.before} → ${r.after}`);
      } catch (e) {
        return fail(chatId, e);
      }
    }

    if (sub === 'switches' || ((sub === 'on' || sub === 'off') && !flag)) {
      const h = harnessMod.harness();
      return reply(chatId, [
        bold('⚙️ Harness switches'), '',
        mdt`  /harness on|off auto-approve      ${h.autoApproveEdit ? 'ON' : 'OFF'}   (write_file, edit_file)`,
        mdt`  /harness on|off auto-approve-exec  ${h.autoApproveExec ? 'ON' : 'OFF'}   (run_command)`,
        mdt`  /harness on|off learning          ${h.learning ? 'ON' : 'OFF'}`,
        mdt`  /harness on|off auto-compat       ${h.autoCompat ? 'ON' : 'OFF'}`,
        mdt`  terminal access: ${h.terminal}   (/harness on|off terminal <off|read|write>)`,
        '',
        italic('Unattended loops are NEVER granted a dangerous tool, whatever these say.'),
      ].join('\n'));
    }

    await bot.sendTyping(chatId);
    let f;
    try {
      f = await harnessMod.facts();
    } catch (e) {
      return fail(chatId, e);
    }
    const h = f.flags;
    const ws = f.websocket || {};
    const L = [
      bold('🛠 Harness'), '',
      bold('Switches'),
      mdt`  auto-approve edits  ${h.autoApproveEdit ? '🟢 ON' : '⚪️ OFF'}   (write_file, edit_file)`,
      mdt`  auto-approve exec   ${h.autoApproveExec ? '🟢 ON' : '⚪️ OFF'}   (run_command)`,
      mdt`  learning            ${h.learning ? '🟢 ON' : '⚪️ OFF'}`,
      mdt`  auto-compat         ${h.autoCompat ? '🟢 ON' : '⚪️ OFF'}`,
      mdt`  terminal access     ${bold(h.terminal)}`,
      '',
      bold('Runtime'),
      mdt`  node ${f.node} · pid ${f.pid} · up ${Math.round(f.uptime_ms / 1000)}s`,
      mdt`  database   ${f.database}`,
      mdt`  exchange   ${f.exchange}`,
      mdt`  websocket  pub ${ws.public_connected ? '🟢' : '🔴'} · priv ${ws.private_connected ? '🟢' : '🔴'} · login ${ws.private_logged_in ? '🟢' : '🔴'} · ${ws.symbols_watched || 0} symbols`,
      '',
      bold('Models'),
    ];

    if (Array.isArray(f.models)) {
      if (!f.models.length) L.push(italic('  no provider configured'));
      for (const p of f.models) {
        L.push(mdt`  ${p.active ? '▸' : ' '} ${p.provider}: ${p.model}${p.pinned ? ' (pinned)' : ''}`);
      }
    } else {
      L.push(italic(`  ${f.models && f.models.error ? f.models.error : 'unknown'}`));
    }

    const pend = f.pending_approvals || [];
    L.push('', bold('Approvals'));
    if (!pend.length) L.push(italic('  none waiting'));
    for (const p of pend) {
      L.push(mdt`  #${p.id} ${p.tool} (${p.kind}) — ${Math.round((Date.now() - p.at) / 1000)}s ago`);
      L.push(italic(`     /harness approve ${p.id}    /harness deny ${p.id}`));
    }

    L.push('', bold('Recent decisions'));
    const tail = f.ledger_tail || [];
    if (!tail.length) L.push(italic('  none yet'));
    for (const d of tail) {
      const icon = { approved: '✅', denied: '🚫', waived: '⏩', ask: '⏸', expired: '⌛' }[d.decision] || '·';
      L.push(mdt`  ${icon} ${d.tool} — ${d.why || d.decision}`);
    }
    L.push('', italic('Every write/exec tool passes through this gate before it runs.'));
    return reply(chatId, L.join('\n'));
  };

  // ============================================================== /thinking
  C.thinking = async (chatId, args) => {
    if (!args[0]) {
      const s = db.settings();
      return reply(chatId, [
        bold('🧠 Thinking'), '',
        mdt`current: ${bold(s.thinking_level)}`,
        '',
        mdt`off      1 step,  no reasoning`,
        mdt`low      3 steps`,
        mdt`medium   6 steps`,
        mdt`high    10 steps, deepest reasoning`,
        '',
        italic("/thinking high — also raises the model's thinking budget."),
      ].join('\n'));
    }
    const level = String(args[0]).toLowerCase();
    if (!['off', 'low', 'medium', 'high'].includes(level)) {
      return reply(chatId, mdt`Thinking must be off, low, medium or high — got "${args[0]}".`);
    }
    await db.setSetting('thinking_level', level, 'user');
    return reply(chatId, mdt`🧠 thinking → ${level}. The next message uses it.`);
  };

  // ================================================================ /models
  C.models = async (chatId, args) => {
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'set') {
      const prov = args[1];
      const modelId = args.slice(2).join(' ');
      if (!prov) return reply(chatId, mdt`Usage: /models set <provider> <model-id|AUTO>`);
      try {
        const st = await ai.setModel(prov.toLowerCase(), modelId || 'AUTO');
        const lines = [bold('✅ Model routing'), ''];
        for (const p of st) {
          lines.push(mdt`${p.active ? '▸' : ' '} ${p.provider}: ${p.model}${p.pinned ? ' (pinned)' : ''}`);
        }
        return reply(chatId, lines.join('\n'));
      } catch (e) {
        return fail(chatId, e);
      }
    }

    if (sub === 'auto') {
      await reply(chatId, mdt`🔎 Re-discovering — listing models and probing each with a real request…`);
      try {
        const st = await ai.refreshModels({ clearBlacklist: true });
        const lines = [bold('🔎 Auto-discovery'), ''];
        for (const p of st) {
          lines.push(mdt`${p.active ? '▸' : ' '} ${p.provider}: ${p.model}`);
          if (p.rejected && p.rejected.length) {
            lines.push(italic(`     rejected: ${p.rejected.slice(0, 8).join(', ')}`));
          }
        }
        return reply(chatId, lines.join('\n'));
      } catch (e) {
        return fail(chatId, e);
      }
    }

    if (sub === 'list') {
      const prov = args[1] ? args[1].toLowerCase() : null;
      let all;
      try {
        all = await ai.listAvailable(prov);
      } catch (e) {
        return fail(chatId, e);
      }
      const L = [bold('📋 Models this key can call')];
      for (const entry of Object.entries(all)) {
        L.push('', bold(entry[0]));
        const ids = entry[1];
        if (ids && ids.error) { L.push(italic(`  ⚠️ ${ids.error}`)); continue; }
        if (!ids || !ids.length) { L.push(italic('  (none)')); continue; }
        for (const id of ids.slice(0, 40)) L.push(mdt`  ${id}`);
        if (ids.length > 40) L.push(italic(`  …and ${ids.length - 40} more`));
      }
      L.push('', italic('/models auto — let me find the best working one'));
      return reply(chatId, L.join('\n'));
    }

    if (sub === 'refresh') {
      try {
        const st = await ai.refreshModels();
        const lines = [bold('🔄 Refreshed'), ''];
        for (const p of st) lines.push(mdt`${p.active ? '▸' : ' '} ${p.provider}: ${p.model}`);
        return reply(chatId, lines.join('\n'));
      } catch (e) {
        return fail(chatId, e);
      }
    }

    const st = ai.status();
    const L = [bold('🧠 Model routing'), ''];
    for (const p of st) {
      L.push(mdt`${p.active ? '▸' : ' '} ${bold(p.provider)}: ${code(p.model)}`);
      const cfg = config.ai[p.provider];
      if (cfg && cfg.url) L.push(italic(`     ${cfg.url}`));
      if (p.rejected && p.rejected.length) {
        L.push(italic(`     key cannot use: ${p.rejected.slice(0, 6).join(', ')}`));
      }
      const caps = compat.capabilities(p.provider, p.model);
      if (caps.tools != null) {
        const t = caps.temperature === null ? 'unknown' : caps.temperature ? 'ok' : 'rejected';
        L.push(italic(`     probed: tools ${caps.tools ? 'yes' : 'NO'} · temperature ${t}`));
      }
    }
    L.push('', italic('/models list · /models auto · /models set <prov> <model|AUTO>'));
    L.push(italic('/compat — probe what each model can actually do'));
    return reply(chatId, L.join('\n'));
  };

  C.model = (chatId, args) => C.models(chatId, args);

  // ============================================================= /provider
  C.provider = async (chatId, args) => {
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'set') {
      const name = (args[1] || '').toLowerCase();
      const field = (args[2] || '').toLowerCase();
      const value = args.slice(3).join(' ');
      if (!name || !field) {
        return reply(chatId, [
          mdt`Usage: /provider set <openai|gemini|anthropic> <url|model> <value>`,
          italic('Keys go through /set-api-key — they are never typed into chat twice.'),
        ].join('\n'));
      }
      const cfg = config.ai[name];
      if (!cfg || !['url', 'model'].includes(field)) {
        return reply(chatId, mdt`Can set url or model only. Keys → /set-api-key.`);
      }
      if (!value) return reply(chatId, mdt`Missing value.`);
      cfg[field] = value;
      await db.setSetting(`provider_${name}_${field}`, value, 'user');
      return reply(chatId, mdt`✅ ${name}.${field} = ${value} (persisted; write the same into .env to survive a restart)`);
    }

    const L = [bold('🔌 Providers'), '',
      mdt`routing: ${bold(ai.activeProvider || 'AUTO')} — AUTO means any key that answers`,
    ];
    for (const name of ['openai', 'gemini', 'anthropic']) {
      const cfg = config.ai[name];
      if (!cfg) continue;
      L.push('', bold(name));
      L.push(mdt`  key    ${cfg.key ? `set (${cfg.key.slice(0, 6)}…)` : italic('not set')}`);
      L.push(mdt`  url    ${cfg.url || italic('vendor default')}`);
      L.push(mdt`  model  ${cfg.model || italic('AUTO — discovered at boot')}`);
    }
    L.push('', italic('/provider set <name> <url|model> <value>'));
    L.push(italic('/set-api-key <ENV_NAME> <value> — writes .env, never echoes'));
    return reply(chatId, L.join('\n'));
  };

  // ========================================================= /set-api-key
  /**
   * Write a key into .env without echoing it back.
   * The value is already in the chat history by virtue of the user sending it;
   * what this guarantees is that we do not repeat it into a log, a prompt or a
   * tool result.
   */
  C.set_api_key = async (chatId, args) => {
    const name = String(args[0] || '').toUpperCase();
    const value = args.slice(1).join(' ').trim();
    if (!name || !value) return reply(chatId, mdt`Usage: /set-api-key <ENV_NAME> <value>`);
    if (!/^[A-Z0-9_]+$/.test(name)) return reply(chatId, mdt`Name must be A-Z0-9_.`);

    try {
      const p = path.resolve(process.cwd(), '.env');
      let raw = '';
      try { raw = fs.readFileSync(p, 'utf8'); } catch { /* new file */ }
      const re = new RegExp(`^${name}=.*$`, 'm');
      const next = re.test(raw)
        ? raw.replace(re, `${name}=${value}`)
        : `${raw.replace(/\n*$/, '\n')}${name}=${value}\n`;
      fs.writeFileSync(p, next, { mode: 0o600 });
      return reply(chatId, [
        mdt`🔑 ${name} written to .env (${value.length} chars, mode 600).`,
        italic('Not echoed. Restart, or /models auto to re-discover with it.'),
        italic('It is in this chat\'s history — rotate it if that matters.'),
      ].join('\n'));
    } catch (e) {
      return fail(chatId, e);
    }
  };

  // ================================================================= /soul
  C.soul = async (chatId, args) => {
    const sub = (args[0] || '').toLowerCase();
    const rest = args.slice(1);

    if (!sub || sub === 'show') {
      return reply(chatId, [bold('🫀 soul/SOUL.md'), '', agentText(loadSoul().soul)].join('\n'));
    }
    if (sub === 'style') {
      return reply(chatId, [bold('🎨 soul/STYLE.md'), '', agentText(loadSoul().style)].join('\n'));
    }
    if (sub === 'skill') return C.skills(chatId, ['show', ...rest]);
    if (sub === 'add' || sub === 'append') {
      const text = rest.join(' ').trim();
      if (!text) return reply(chatId, mdt`Usage: /soul add <text to append>`);
      fs.appendFileSync(soulFile('SOUL.md'), `\n\n${text}\n`);
      if (agent.reloadSoul) agent.reloadSoul();
      return reply(chatId, mdt`✅ Appended to soul/SOUL.md — active from the next message.`);
    }
    if (sub === 'set' || sub === 'replace') {
      const text = rest.join('\n').trim();
      if (!text) return reply(chatId, mdt`Usage: /soul set <the full new SOUL.md>`);
      fs.writeFileSync(soulFile('SOUL.md'), `${text}\n`);
      if (agent.reloadSoul) agent.reloadSoul();
      return reply(chatId, mdt`✅ soul/SOUL.md replaced (${text.split('\n').length} lines).`);
    }
    return reply(chatId, mdt`Unknown: /soul ${sub}. Use show / style / add / set / skill.`);
  };

  // =============================================================== /skills
  C.skills = async (chatId, args) => {
    const sub = (args[0] || '').toLowerCase();
    const rest = args.slice(1);
    const dir = skillsDir();
    const files = loadSkillFiles();
    const find = (n) => files.find((f) => f.file.replace(/\.md$/i, '').toLowerCase() === String(n || '').toLowerCase());

    if (sub === 'add') {
      const joined = rest.join(' ');
      const bar = joined.indexOf('|');
      if (bar < 0) return reply(chatId, mdt`Usage: /skills add <name> | <text>`);
      const name = joined.slice(0, bar).trim();
      const body = joined.slice(bar + 1).trim();
      if (!name || !body) return reply(chatId, mdt`Both a name and a body are required.`);
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'skill';
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${slug}.md`), `---\nname: ${name}\nenabled: true\n---\n\n${body}\n`);
      if (agent.reloadSoul) agent.reloadSoul();
      return reply(chatId, mdt`✅ soul/skills/${slug}.md — active from the next message.`);
    }
    if (sub === 'show') {
      const hit = find(rest[0]);
      if (!hit) return reply(chatId, mdt`No skill "${rest[0]}".`);
      return reply(chatId, [bold(hit.name),
        hit.when ? italic(`when: ${hit.when}`) : null,
        '', agentText(hit.body)].filter(Boolean).join('\n'));
    }
    if (sub === 'on' || sub === 'off') {
      const hit = find(rest[0]);
      if (!hit) return reply(chatId, mdt`No skill "${rest[0]}". /skills to list.`);
      const p = path.join(dir, hit.file);
      const raw = fs.readFileSync(p, 'utf8');
      const want = sub === 'on';
      const next = /^enabled\s*:/m.test(raw)
        ? raw.replace(/^(enabled\s*:\s*).*$/m, `$1${want}`)
        : `---\nenabled: ${want}\n---\n${raw}`;
      fs.writeFileSync(p, next);
      if (agent.reloadSoul) agent.reloadSoul();
      return reply(chatId, mdt`${want ? '🟢' : '⚪️'} ${hit.file} is ${sub}.`);
    }
    if (sub === 'rm' || sub === 'delete') {
      const hit = find(rest[0]);
      if (!hit) return reply(chatId, mdt`No skill "${rest[0]}".`);
      fs.unlinkSync(path.join(dir, hit.file));
      if (agent.reloadSoul) agent.reloadSoul();
      return reply(chatId, mdt`🗑 Deleted ${hit.file}.`);
    }

    const L = [bold('🎓 Skills'), '', mdt`Base: soul/SKILL.md (always on)`];
    if (!files.length) {
      L.push('', italic('none yet — /skills add <name> | <text>'));
    } else {
      L.push('');
      for (const f of files) {
        L.push(mdt`${f.enabled ? '🟢' : '⚪️'} ${f.file} — ${f.name}`);
        if (f.when) L.push(italic(`    when: ${f.when}`));
      }
    }
    L.push('', italic('/skills show|on|off|add|rm <name>'));
    return reply(chatId, L.join('\n'));
  };

  // ================================================================== /mcp
  C.mcp = async (chatId, args) => {
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'tools') return C.tools(chatId, []);

    if (sub === 'add') {
      const name = args[1];
      const command = args[2];
      if (!name || !command) return reply(chatId, mdt`Usage: /mcp add <name> <command> [args...]`);
      const p = path.resolve(process.cwd(), 'mcp.json');
      let cfg = { mcpServers: {} };
      try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* fresh */ }
      if (!cfg.mcpServers) cfg.mcpServers = {};
      cfg.mcpServers[name] = { command, args: args.slice(3) };
      fs.writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`);
      await reloadMcpTools();
      return reply(chatId, mdt`✅ Added "${name}" to mcp.json and reloaded. /mcp for status.`);
    }

    if (sub === 'reload') {
      await reloadMcpTools();
      return C.mcp(chatId, []);
    }

    const st = mcpStatus();
    if (!st || !st.length) {
      return reply(chatId, [bold('🔌 MCP servers'), '', italic('None configured.'), '',
        italic('/mcp add <name> <command> [args]'),
        italic('or edit mcp.json — see mcp.example.json')].join('\n'));
    }
    const L = [bold('🔌 MCP servers'), ''];
    for (const x of st) {
      L.push(mdt`${x.running ? '🟢' : '🔴'} ${x.name} — ${x.tools} tool(s)`);
      L.push(italic(`    ${x.command}`));
      if (x.toolNames && x.toolNames.length) L.push(italic(`    ${x.toolNames.slice(0, 8).join(', ')}`));
      if (x.error) L.push(italic(`    ⚠️ ${x.error}`));
    }
    L.push('', italic('/mcp reload · /mcp tools'));
    return reply(chatId, L.join('\n'));
  };

  // ================================================================ /memory
  C.memory = async (chatId, args) => {
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'add' || sub === 'remember') {
      const joined = args.slice(1).join(' ');
      const bar = joined.indexOf('|');
      const subject = bar < 0 ? null : joined.slice(0, bar).trim();
      const content = (bar < 0 ? joined : joined.slice(bar + 1)).trim();
      if (!content) return reply(chatId, mdt`Usage: /memory add <subject|> <fact>`);
      const m = await db.remember({ kind: 'preference', subject, content });
      return reply(chatId, mdt`🧠 remembered (id ${m.id}). It goes into every prompt from now on.`);
    }

    let mems;
    try {
      mems = args.length ? await db.searchMemories(args.join(' '), 15) : await db.recall({ limit: 15 });
    } catch (e) {
      return fail(chatId, e);
    }
    if (!mems || !mems.length) return reply(chatId, italic('Nothing in long-term memory yet.'));
    const L = [bold('🧠 Long-term memory'), ''];
    for (const m of mems) {
      L.push(mdt`[${m.kind}${m.subject ? `/${m.subject}` : ''}] ${m.content}`);
    }
    return reply(chatId, L.join('\n'));
  };

  // ================================================================= /dream
  C.dream = async (chatId, args) => {
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'on' || sub === 'off') {
      const v = onOff(sub);
      await db.setSetting('dream_enabled', v, 'user');
      return reply(chatId, mdt`💭 dream ${v}. /dream run to force one now.`);
    }
    if (sub === 'status') {
      const s = db.settings();
      return reply(chatId, mdt`dream: ${s.dream_enabled ? 'on' : 'off'} · every ${s.dream_interval_hours}h`);
    }

    await bot.sendTyping(chatId);
    const mod = await import('../ai/dream.js');
    try {
      const r = await mod.dream();
      return reply(chatId, mod.formatDream(r));
    } catch (e) {
      return fail(chatId, e);
    }
  };

  // =========================================================== /deepsearch
  C.deepsearch = async (chatId, args) => {
    const q = args.join(' ').trim();
    if (!q) return reply(chatId, mdt`Usage: /deepsearch <question>`);

    await bot.sendTyping(chatId);
    const typing = setInterval(() => bot.sendTyping(chatId), 6000);
    try {
      const r = await deepsearch.deepsearch(q, {
        onStep: async ({ stage, n, of, question }) => {
          if (stage === 'gather' && n === 1) {
            await reply(chatId, italic(`🔎 gathering evidence (1/${of})…`));
          }
          if (stage === 'crosscheck') await reply(chatId, italic('🔎 cross-checking the findings…'));
        },
      });
      clearInterval(typing);

      const L = [bold('🔎 Deep search'), '', italic(r.question), ''];
      if (r.subQuestions.length) {
        L.push(bold('Plan'));
        r.subQuestions.forEach((s, i) => L.push(mdt`  ${i + 1}. ${s}`));
        L.push('');
      }
      L.push(bold('Findings'));
      for (const f of r.findings) {
        L.push(mdt`  Q: ${f.question}`);
        L.push(`     ${String(f.answer).slice(0, 600)}`);
        L.push('');
      }
      L.push(bold('Cross-check'), agentText(String(r.challenges).slice(0, 1000)), '');
      L.push(bold('Answer'), agentText(r.answer));
      L.push('', italic(`${r.ms}ms · ${r.subQuestions.length} sub-questions`));
      return reply(chatId, L.join('\n'));
    } catch (e) {
      clearInterval(typing);
      return fail(chatId, e);
    }
  };

  // ========================================================= /code-review
  C.code_review = async (chatId, args) => {
    await bot.sendTyping(chatId);
    const typing = setInterval(() => bot.sendTyping(chatId), 6000);
    try {
      const r = await codereview.review({ scope: args[0] || null, onStep: () => {} });
      clearInterval(typing);

      if (!r.findings.length) {
        return reply(chatId, [bold('🔍 Code review'), '',
          mdt`scope ${r.scope} · ${r.files.length} file(s) read`, '',
          r.rejected.length
            ? italic(`${r.rejected.length} claim(s) dropped as unevidenced — they cited a line in a file the reviewer never opened.`)
            : italic('No defects found in what was read.')].join('\n'));
      }

      const L = [bold('🔍 Code review'),
        mdt`${r.files.length} file(s) · ${r.findings.length} verified finding(s)`, ''];
      for (const f of r.findings) {
        const icon = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' }[f.severity] || '🔵';
        L.push(mdt`${icon} ${f.severity.toUpperCase()} ${f.file}:${f.line} — ${f.title}`);
        L.push(italic(`     why: ${f.why}`));
        L.push(italic(`     fix: ${f.fix}`));
        if (f.dead_code_claim) L.push(italic(`     dead-code check: ${f.dead_code_claim}`));
        L.push('', '```', String(f.source).slice(0, 600), '```', '');
      }
      if (r.rejected.length) L.push(italic(`${r.rejected.length} unevidenced claim(s) discarded.`));
      L.push(italic('/bugfixes [scope] — fix these and run the tests'));
      return reply(chatId, L.join('\n'));
    } catch (e) {
      clearInterval(typing);
      return fail(chatId, e);
    }
  };

  // ============================================================ /bugfixes
  C.bugfixes = async (chatId, args) => {
    await bot.sendTyping(chatId);
    const typing = setInterval(() => bot.sendTyping(chatId), 6000);
    try {
      const r = await codereview.bugfix({
        scope: args[0] || null,
        maxFindings: Number(args[1]) || 5,
        onStep: () => {},
      });
      clearInterval(typing);

      const L = [bold('🐛 Bugfixes'), ''];
      L.push(mdt`baseline: ${r.baseline.ok ? '🟢 green' : `🔴 red (exit ${r.baseline.exit})`}`);

      if (!r.fixed.length) {
        L.push('', italic(r.note || 'nothing to fix'));
        L.push('', '```', (r.baseline.tail || '').slice(-1000), '```');
        return reply(chatId, L.join('\n'));
      }

      L.push(mdt`attempted: ${r.fixed.length} finding(s)`);
      L.push('', bold('Verdict'), mdt`${bold(r.verdict)}`);
      L.push('', bold('Tests after'), mdt`${r.tests.ok ? '🟢 green' : `🔴 red (exit ${r.tests.exit})`}`);
      L.push('', '```', (r.tests.tail || '').slice(-1200), '```');
      L.push('', bold('What the build agent did'), agentText(String(r.report).slice(0, 1800)));
      return reply(chatId, L.join('\n'));
    } catch (e) {
      clearInterval(typing);
      return fail(chatId, e);
    }
  };

  // ================================================================= /tools
  C.tools = async (chatId, args) => {
    const sub = (args[0] || '').toLowerCase();
    const all = allTools();

    if (sub === 'show') {
      const t = TOOL_MAP[args[1]];
      if (!t) return reply(chatId, mdt`No tool "${args[1]}". /tools to list.`);
      return reply(chatId, [
        bold(`🧰 ${t.name}`),
        mdt`class: ${t.danger ? 'DANGER — gated by /harness' : 'safe (read-only)'}`,
        '', italic(t.description), '',
        '```json', JSON.stringify(t.parameters, null, 1), '```',
      ].join('\n'));
    }

    const safe = all.filter((t) => !t.danger);
    const danger = all.filter((t) => t.danger);
    return reply(chatId, [
      bold('🧰 Tools'), '',
      bold(`Safe (${safe.length})`),
      ...safe.map((t) => mdt`  · ${t.name}${t.external ? ` ${italic(`(${t.server})`)}` : ''}`),
      '', bold(`⚡ Danger (${danger.length}) — gated by /harness`),
      ...danger.map((t) => mdt`  ⚡ ${t.name}`),
      '', italic('⚡ tools wait for your tap unless auto-approved. Unattended loops never get them.'),
      italic('/tools show <name>'),
    ].join('\n'));
  };

  // ============================================================== /sessions
  C.sessions = async (chatId, args) => {
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'save' || sub === 'new') {
      const name = args.slice(1).join(' ').trim()
        || `session ${new Date().toISOString().slice(0, 16)}`;
      const s = await db.createSession({ chatId, name });
      return reply(chatId, mdt`💾 Saved session #${s.id} "${name}". /resume-session ${s.id}`);
    }
    if (sub === 'rm' || sub === 'delete') {
      const id = Number(args[1]);
      if (!Number.isInteger(id)) return reply(chatId, mdt`Usage: /sessions rm <id>`);
      const ok = await db.deleteSession(id);
      return reply(chatId, ok ? mdt`🗑 session ${id} deleted.` : mdt`No session ${id}.`);
    }

    const list = await db.listSessions(chatId, 15);
    if (!list || !list.length) return reply(chatId, italic('No saved sessions. /sessions save <name>'));
    const L = [bold('💬 Sessions'), ''];
    for (const s of list) {
      const when = s.last_resumed ? ` · resumed ${new Date(s.last_resumed).toISOString().slice(0, 16)}` : '';
      L.push(mdt`  #${s.id} ${s.name} — ${s.messages} msg${when}`);
    }
    L.push('', italic('/resume-session <id> · /sessions save <name>'));
    return reply(chatId, L.join('\n'));
  };

  C.resume_session = async (chatId, args) => {
    const id = Number(args[0]);
    if (!Number.isInteger(id)) return reply(chatId, mdt`Usage: /resume-session <id>`);
    let msgs;
    try { msgs = await db.sessionTail(id, 60); }
    catch (e) { return fail(chatId, e); }
    if (!msgs || !msgs.length) return reply(chatId, mdt`Session ${id} is empty or unknown.`);

    const transcript = msgs.filter((m) => m.role !== 'tool')
      .map((m) => `${m.role}: ${String(m.content).slice(0, 600)}`).join('\n');
    await db.touchSession(id);
    const r = await agent.run({
      chatId,
      userMessage: `Resuming session ${id}. Transcript:\n\n${transcript}\n\nAcknowledge briefly and continue.`,
    });
    return reply(chatId, agentText(r.text || '(no answer)'));
  };

  C.resume = (chatId, args) => C.resume_session(chatId, args);

  // =================================================================== /team
  C.team = async (chatId) => {
    let st;
    try { st = await agentsMod.teamStatus(); }
    catch (e) { return fail(chatId, e); }
    const cat = agentsMod.agentCatalogue();

    const L = [bold('👥 Team'), ''];
    for (const a of cat) {
      L.push(mdt`  ${bold(a.key)} — ${a.kind} · ${a.step_budget} steps`);
      L.push(`     ${a.description}`);
    }
    L.push('', bold('Authority'));
    L.push(mdt`  terminal     ${st.terminal}`);
    L.push(mdt`  auto-approve edit ${st.auto_approve_edit ? 'ON' : 'OFF'} · exec ${st.auto_approve_exec ? 'ON' : 'OFF'}`);
    if (st.recent && st.recent.length) {
      L.push('', bold('Recent runs'));
      for (const r of st.recent.slice(0, 5)) {
        L.push(mdt`  [${r.mode}] ${String(r.goal || '').slice(0, 70)}`);
      }
    }
    L.push('', italic('/agents plan <goal> · /agents build <goal>'));
    return reply(chatId, L.join('\n'));
  };

  // ================================================================ /agents
  C.agents = async (chatId, args) => {
    const mode = (args[0] || '').toLowerCase();
    const goal = args.slice(1).join(' ').trim();

    if (!mode) {
      const cat = agentsMod.agentCatalogue();
      const L = [bold('🤖 Sub-agents'), ''];
      for (const a of cat) L.push(mdt`  ${a.key} — ${a.kind} · ${a.step_budget} steps`);
      L.push('', italic('/agents plan <goal> — read-only, returns a plan, changes nothing'),
        italic('/agents build <goal> — edits files, runs commands'));
      return reply(chatId, L.join('\n'));
    }
    if (!goal) return reply(chatId, mdt`Usage: /agents ${mode} <goal>`);
    if (!['plan', 'build'].includes(mode)) {
      return reply(chatId, mdt`Mode must be plan or build. /agents to list.`);
    }
    if (mode === 'build' && harnessMod.harness().terminal === 'off') {
      return reply(chatId, mdt`❌ terminal access is off. /harness on|off terminal <read|write> first.`);
    }

    await reply(chatId, mdt`🤖 ${mode} agent running…`);
    await bot.sendTyping(chatId);
    const typing = setInterval(() => bot.sendTyping(chatId), 6000);
    try {
      const r = await agentsMod.spawn({
        goal, mode,
        onStep: async (s) => {
          if (s.type === 'tool') await reply(chatId, italic(`· ${s.name}`));
        },
      });
      clearInterval(typing);
      const used = [...new Set((r.trace || []).map((t) => t.tool))];
      return reply(chatId, [
        bold(`🤖 ${mode} agent — ${r.steps} steps`), '',
        agentText(r.text),
        '', italic(`tools used: ${used.join(', ') || 'none'}`),
      ].join('\n'));
    } catch (e) {
      clearInterval(typing);
      return fail(chatId, e);
    }
  };

  // ================================================================ /config
  C.config = async (chatId, args) => {
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'set') {
      const key = args[1];
      const value = args.slice(2).join(' ');
      if (!key || !value) return reply(chatId, mdt`Usage: /config set <key> <value>`);
      const { validateSetting } = await import('../settings-schema.js');
      try {
        const v = validateSetting(key, value);
        await db.setSetting(key, v, 'user');
        return reply(chatId, mdt`✅ ${key} = ${v}`);
      } catch (e) {
        return fail(chatId, e);
      }
    }

    const s = db.settings();
    if (sub && sub !== 'get' && sub !== 'show') {
      const hit = Object.entries(s).filter(([k]) => k.includes(sub));
      if (!hit.length) return reply(chatId, mdt`No setting matches "${sub}".`);
      const L = [bold(`⚙️ ${sub}`), ''];
      for (const [k, v] of hit) L.push(mdt`  ${k} = ${JSON.stringify(v)}`);
      return reply(chatId, L.join('\n'));
    }

    const groups = {};
    for (const entry of Object.entries(s)) {
      const g = entry[0].split('_')[0];
      if (!groups[g]) groups[g] = [];
      groups[g].push(entry);
    }
    const L = [bold('⚙️ Config'), ''];
    for (const g of Object.keys(groups).sort()) {
      L.push(bold(g));
      for (const [k, v] of groups[g]) {
        L.push(mdt`  ${k} = ${typeof v === 'object' ? JSON.stringify(v) : v}`);
      }
      L.push('');
    }
    L.push(italic('/config set <key> <value> — validated exactly like /set'),
      italic('/config <substring> — just the matching keys'));
    return reply(chatId, L.join('\n'));
  };

  // ============================================================= /generator
  C.generator = async (chatId, args) => {
    const kind = (args[0] || '').toLowerCase();

    if (!kind) {
      const caps = generator.capabilities();
      const L = [bold('🎨 Generators'), ''];
      for (const k of Object.keys(caps)) {
        const v = caps[k];
        L.push(mdt`  ${k}: ${typeof v === 'boolean' ? (v ? '🟢 ready' : '🔴 needs OPENAI_COMPATIBLE_KEY') : v}`);
      }
      L.push('', italic('/generator image <prompt>'), italic('/generator tts <text>'),
        italic('/generator video <prompt>'), italic('/generator codes js <source>'),
        italic('/generator files <path> <content>'), italic('/generator docs <name> <markdown>'));
      return reply(chatId, L.join('\n'));
    }

    try {
      const r = await generator.generate(kind, args.slice(1));
      const L = [bold(`🎨 ${kind} done`), ''];
      for (const entry of Object.entries(r)) {
        const v = entry[1];
        L.push(mdt`  ${entry[0]}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 400) : v}`);
      }
      L.push('', italic(`saved under ${generator.OUT_DIR}`));
      return reply(chatId, L.join('\n'));
    } catch (e) {
      return fail(chatId, e);
    }
  };

  // ================================================================= /compat
  C.compat = async (chatId, args) => {
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'show' || sub === 'known') {
      const known = compat.known();
      if (!known.length) return reply(chatId, italic('Nothing probed yet. /compat to probe.'));
      const L = [bold('🔬 Known capabilities'), ''];
      for (const k of known) {
        const t = k.tools === null ? '?' : k.tools ? 'yes' : 'NO';
        const tmp = k.temperature === null ? '?' : k.temperature ? 'ok' : 'rejected';
        L.push(mdt`  ${k.id} — tools ${t} · temperature ${tmp}`);
      }
      return reply(chatId, L.join('\n'));
    }

    await reply(chatId, mdt`🔬 Probing — a real tool-calling request per model. May take a minute.`);
    const prov = args[0] && args[0] !== 'auto' ? args[0].toLowerCase() : null;
    try {
      const results = await compat.runCompat(ai, { provider: prov });
      const adv = compat.routingAdvice(results);
      const L = [bold('🔬 Compat'), ''];
      for (const r of adv) {
        const icon = r.verdict === 'unusable' ? '🔴' : r.verdict === 'chat_only' ? '🟡' : '🟢';
        L.push(mdt`  ${icon} ${r.provider}/${r.model} — ${r.verdict}`);
        L.push(italic(`     ${r.action}`));
      }
      L.push('', italic(`${adv.length} model(s) probed with real requests.`));
      return reply(chatId, L.join('\n'));
    } catch (e) {
      return fail(chatId, e);
    }
  };

  C.auto_compat = async (chatId, args) => {
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'on' || sub === 'off') {
      const v = onOff(sub);
      harnessMod.setFlag('autoCompat', v);
      await harnessMod.persistFlag('autoCompat', v);
      return reply(chatId, mdt`auto-compat ${v}.`);
    }
    return C.compat(chatId, []);
  };

  // ================================================= /auto_approve_on_edit
  C.auto_approve_on_edit = async (chatId, args) => {
    let v;
    try { v = onOff(args[0]); }
    catch (e) { return fail(chatId, e); }
    harnessMod.setFlag('autoApproveEdit', v);
    await harnessMod.persistFlag('autoApproveEdit', v);
    return v
      ? reply(chatId, mdt`⏩ auto-approve edits ON. write_file and edit_file run without asking — in THIS chat only. Unattended loops stay refused.`)
      : reply(chatId, mdt`⏸ auto-approve edits OFF. Edits ask first.`);
  };

  // ============================================================== /learning
  C.learning = async (chatId, args) => {
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'on' || sub === 'off') {
      const v = onOff(sub);
      learning.toggle(v);
      await harnessMod.persistFlag('learning', harnessMod.harness().learning);
      return reply(chatId, mdt`📚 learning ${v}.${v ? ' /learning build to propose changes.' : ''}`);
    }

    if (sub === 'build') {
      await bot.sendTyping(chatId);
      try {
        const p = await learning.buildProposal({ days: Number(args[1]) || 30 });
        const L = [bold('📚 Learning proposal'), ''];
        if (p.rationale) L.push(agentText(p.rationale), '');
        if (p.changes.length) L.push(bold('Proposed weight changes'));
        else L.push(italic('No weight changes justified by the data yet.'));
        for (const c of p.changes) {
          L.push(mdt`  ${c.strategy}: ${c.current} → ${c.proposed}`);
          L.push(italic(`     ${c.why} · ${c.games} trades · ${(c.win_rate * 100).toFixed(0)}% win · pnl ${c.pnl}`));
        }
        if (p.held.length) {
          L.push('', bold('Held (not enough evidence)'));
          for (const c of p.held) L.push(mdt`  ${c.strategy}: ${c.why}`);
        }
        L.push('', italic('/learning apply — write these weights'),
          italic(`Never auto-tuned: ${learning.FROZEN.size} risk keys (leverage, size, confidence floors).`));
        return reply(chatId, L.join('\n'));
      } catch (e) {
        return fail(chatId, e);
      }
    }

    if (sub === 'apply') {
      try {
        const r = await learning.apply();
        const L = [bold('📚 Applied'), ''];
        for (const a of r.applied || []) L.push(mdt`  ${a.strategy} → ${a.weight}`);
        for (const x of r.refused || []) L.push(italic(`  refused ${x.key}: ${x.why}`));
        if (r.note) L.push(italic(r.note));
        return reply(chatId, L.join('\n'));
      } catch (e) {
        return fail(chatId, e);
      }
    }

    let st;
    try { st = await learning.status(); }
    catch (e) { return fail(chatId, e); }
    const L = [bold('📚 Learning'), '',
      mdt`enabled: ${st.enabled ? 'ON' : 'OFF'}`,
      st.enabled ? '' : italic('  /learning build to propose changes from closed trades'),
      '', bold('Current strategy weights')];
    if (!st.weights.length) L.push(italic('  no closed trades yet'));
    for (const w of st.weights) {
      L.push(mdt`  ${w.strategy}: ${w.weight} — ${w.wins}W/${w.losses}L · pnl ${w.pnl}`);
    }
    L.push('', italic(`never auto-tuned: ${st.frozen_keys.join(', ')}`));
    return reply(chatId, L.join('\n'));
  };

  // ======================================================= /app_connector
  /**
   * /app_connector — pair this agent with another bot or app.
   *
   * It mints a signed secret and explains the bridge. It deliberately does NOT
   * open an inbound HTTP listener: this process is a Telegram long-poller, and
   * exposing a port to the internet is a decision a user makes on purpose, not
   * something a chat command does behind their back.
   */
  C.app_connector = async (chatId, args) => {
    if ((args[0] || '').toLowerCase() === 'key') {
      const secret = crypto.randomBytes(24).toString('hex');
      const dir = path.resolve(process.cwd(), '.connectors');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'secrets.json'),
        `${JSON.stringify({ created_at: new Date().toISOString(), key: secret }, null, 2)}\n`,
        { mode: 0o600 },
      );
      return reply(chatId, [bold('🔗 Connector key'), '', code(secret), '',
        mdt`written to .connectors/secrets.json (mode 600)`,
        italic('It is now in this chat\'s history — rotate it if that matters.')].join('\n'));
    }

    return reply(chatId, [
      bold('🔗 App connector'), '',
      mdt`This agent talks to Telegram by long-polling. It does not open an`,
      mdt`inbound port, and /app_connector will not start a public listener`,
      mdt`without you putting one in front of it deliberately.`, '',
      bold('To connect another app'), '',
      mdt`  1. /app_connector key — mint a shared secret`,
      mdt`  2. Run a small webhook of your own (Cloudflare Tunnel, ngrok, a VPS)`,
      mdt`  3. Have it POST {"chat_id": "...", "text": "..."} to your bridge`,
      mdt`  4. The bridge sends the text to this chat; the reply is recorded in Neon`, '',
      bold('Already working, no bridge needed'), '',
      mdt`  Telegram (this chat)`, mdt`  MCP servers  → /mcp add <name> <command>`,
      mdt`  Neon        → long-term memory, survives restarts`, '',
      italic('/app_connector key — generate the secret to sign a bridge with'),
    ].join('\n'));
  };

  // =================================================================== /quit
  C.quit = async (chatId, args) => {
    if ((args[0] || '').toLowerCase() === 'cancel') return reply(chatId, italic('Staying alive.'));
    let open = null;
    try {
      const { portfolioSnapshot } = await import('../trading/manager.js');
      open = (await portfolioSnapshot()).count;
    } catch { open = null; }

    await reply(chatId, [
      bold('👋 Shutting down'), '',
      mdt`open positions: ${open === null ? 'unknown' : open} — they are NOT closed.`,
      mdt`Exchange-side TP/SL orders stay on the book and keep protecting them.`,
      italic('Restart with: npm start'),
    ].join('\n'));
    log.warn('shutdown requested from Telegram');
    setTimeout(() => process.exit(0), 1500);
  };

  // ------------------------------------------------------------- aliases
  C.autoapproveoned = C.auto_approve_on_edit;
  C.auto_approve = C.auto_approve_on_edit;
  C.autocompat = C.auto_compat;
  C.setmodels = C.models;
  C.set_api_key_cmd = C.set_api_key;

  return C;
}

export default createAgentCommands;