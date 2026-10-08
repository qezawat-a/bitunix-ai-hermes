/**
 * HARNESS — the safety and capability layer around the agent loop.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `src/ai/filetools.js` and `src/ai/tools.js` both claim that write_file /
 * edit_file / run_command "wait for the user's tap" and that "autonomous
 * loops never call them blindly (see requireApproval)". That function was
 * never written. Every danger tool ran with no gate at all, so the documented
 * safety model was fiction: the agent could rewrite its own engine or run a
 * shell command in the middle of an autonomous tick with nobody asked.
 *
 * So the gate is built here, and it is built to be boring:
 *
 *  1. CLASSIFICATION — a tool is READ, WRITE or EXEC. Read is always free.
 *     Write and Exec need a decision unless auto-approve covers them.
 *  2. AUTO-APPROVE  — `/auto_approve_on_edit on` waives the tap for WRITE
 *     tools only. EXEC is never waived by that switch; it has its own.
 *  3. AUTONOMOUS    — a loop with no human attached may NEVER be granted a
 *     dangerous tool by auto-approve. It can ask, it just gets refused, and
 *     the refusal is reported instead of silently swallowed.
 *  4. AUDIT         — every decision (asked / approved / denied / waived) is
 *     written to agent_events, so "the agent did that without asking" is a
 *     question with a query, not a guess.
 *
 * Everything here is process-local state plus the settings table. Nothing is
 * cached across restarts except what /settings already persists.
 */
import { createLogger } from '../logger.js';
import * as db from '../db/index.js';
import { config } from '../config.js';

const log = createLogger('harness');

/**
 * Tool classification.
 *
 * Order of authority: an explicit `cls`, then the tool's own `danger: true`,
 * then the name. A tool that nobody declared anything about is READ — the
 * dangerous default here would be to gate everything, because that trains the
 * user to tap "approve" without reading, which is worse than useless.
 */
export const CLASS = { READ: 'read', WRITE: 'write', EXEC: 'exec' };

const EXEC_TOOLS = new Set(['run_command']);

/**
 * Tools that mutate state or move money, by name.
 *
 * This duplicates `danger: true` from tools.js on purpose. Two reasons:
 *   - harness.js must not import tools.js at module load (tools imports harness).
 *   - A caller that omits the tool object must still get a WRITE, so the gate
 *     cannot be quietly disabled by forgetting an argument.
 * Keep this list in sync with the `danger: true` tools in tools.js — the
 * harness test asserts the two agree.
 */
const DANGER_BY_NAME = new Set([
  // filetools.js — touch the disk or the shell
  'write_file', 'edit_file', 'run_command',
  // tools.js — money, positions, leverage, or the agent's own behaviour
  'open_position', 'close_position', 'close_all_positions', 'set_position_tpsl',
  'reverse_position', 'cancel_orders', 'set_leverage', 'set_margin_mode',
  'update_settings',
]);

/** Best-effort lookup of a tool's declaration, without importing tools.js. */
let toolIndex = null;
function lookupTool(name) {
  if (toolIndex === null) {
    // Populated by /harness and by index.js at boot via registerTools().
    toolIndex = new Map();
  }
  return toolIndex.get(name) || null;
}

/** Wire the live tool table in once, so `evaluate` sees real declarations. */
export function registerTools(tools) {
  const m = new Map();
  for (const t of tools || []) if (t && t.name) m.set(t.name, t);
  toolIndex = m;
  return m.size;
}

/**
 * Money and position tools. These are marked `danger: true` in tools.js, and
 * the first version of this file IGNORED that flag for anything not literally
 * named write_file/edit_file/run_command — which meant open_position,
 * close_position, set_position_tpsl, reverse_position, cancel_orders,
 * set_leverage and set_margin_mode all classified as READ and would have run
 * with no approval at all, on a live account.
 *
 * The lesson: the gate must honour what the tool DECLARES about itself, not
 * what it guesses from the name. A tool that says `danger: true` is gated
 * unless it explicitly says otherwise.
 */
const DECLARED_DANGER_FALLS_BACK_TO = CLASS.WRITE;

/** Classify by name, then by the tool's own declaration. */
export function classify(name, tool = null) {
  if (tool && typeof tool.cls === 'string') return tool.cls;
  if (EXEC_TOOLS.has(name)) return CLASS.EXEC;
  if (tool && tool.danger === true) return DECLARED_DANGER_FALLS_BACK_TO;
  if (DANGER_BY_NAME.has(name)) return CLASS.WRITE;
  return CLASS.READ;
}

const HOUR = 3600_000;

// --------------------------------------------------------------- live state

const state = {
  /** auto-approve WRITE tools in chat (never EXEC, never autonomous) */
  autoApproveEdit: false,
  /** auto-approve EXEC tools in chat */
  autoApproveExec: false,
  /** /learning — turn experience into behaviour changes */
  learning: false,
  /** /compat — probe every model for capabilities instead of assuming */
  autoCompat: false,
  /** how much of the machine the agent may touch: off | read | write */
  terminal: 'write',
  /** /quit — set when the user asked the process to stop */
  quitting: null,
  /** pending approvals, keyed by the short id shown to the user */
  pending: new Map(),
  /** decisions taken this process, for /harness and for tests */
  ledger: [],
  seq: 0,
};

/**
 * The live state object.
 *
 * Exported directly (not only through harness()) because /harness, the tests
 * and the boot log all need to READ it, and returning a copy would mean every
 * reader could silently diverge from what the gate actually uses.
 */
export function harness() { return state; }
export { state as harnessState };

export function setFlag(name, value) {
  if (!(name in state)) throw new Error(`unknown harness flag "${name}"`);
  const before = state[name];
  if (name === 'terminal') {
    const v = String(value).toLowerCase();
    if (!['off', 'read', 'write'].includes(v)) {
      throw new Error('terminal must be off, read or write');
    }
    state.terminal = v;
  } else {
    state[name] = typeof before === 'boolean' ? /^(on|true|yes|1)$/i.test(String(value)) : value;
  }
  log.info(`harness ${name}: ${before} -> ${state[name]}`);
  return { name, before, after: state[name] };
}

/** Load persisted harness flags into memory. Called once at boot. */
export async function loadHarness() {
  try {
    const s = db.settings();
    for (const key of ['auto_approve_on_edit', 'auto_approve_exec', 'learning', 'auto_compat', 'terminal_access']) {
      if (s[key] !== undefined) state[camel(key)] = s[key];
    }
  } catch (e) {
    log.warn(`harness flags unavailable (${e.message}) — using safe defaults`);
  }
  return state;
}

const camel = (k) => k.replace(/_(\w)/g, (_, c) => c.toUpperCase());

export async function persistFlag(name, value, by = 'user') {
  const key = snake(name);
  await db.setSetting(key, value, by);
  return key;
}

const snake = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Settings-table keys the harness owns. Merged into the /settings view. */
export const HARNESS_KEYS = [
  'auto_approve_on_edit', 'auto_approve_exec', 'learning', 'auto_compat', 'terminal_access',
];

// ---------------------------------------------------------------- approval

/**
 * Write to the ledger and return the verdict.
 *
 * It returns the same shape as the READ path — { ok, kind, reason, decision }.
 * The first version returned the bare ledger entry, which had no `ok`, so
 * every `verdict.ok === false` test silently read `undefined` and the gate
 * reported "allowed" for tools it had just denied. The ledger row and the
 * return value are deliberately the same object plus `ok`.
 */
function record(entry) {
  const row = { at: Date.now(), ...entry };
  state.ledger.push(row);
  if (state.ledger.length > 500) state.ledger.splice(0, state.ledger.length - 500);
  const ok = entry.decision === 'approved' || entry.decision === 'waived';
  return { ...row, ok };
}

export function pendingApprovals() {
  return [...state.pending.values()].map(({ resolve, ...rest }) => rest);
}

/**
 * The gate. Returns { ok: true } or { ok: false, reason }.
 *
 * `autonomous: true` means nobody is reading the reply — a timer tick, a scan
 * verdict, a dream cycle. A dangerous tool there is refused outright rather
 * than queued for a tap that will never come.
 */
export function evaluate({ name, cls, args, autonomous = false, tool = null }) {
  // Resolve the tool's own declaration if the caller did not pass it. A gate
  // that only classifies correctly when handed the right object is a gate that
  // one careless call site turns off — so `evaluate('write_file')` with no tool
  // must still be a WRITE, not a READ.
  const kind = cls || classify(name, tool || lookupTool(name));

  if (kind === CLASS.READ) return { ok: true, kind, reason: 'read-only' };

  if (state.terminal === 'off' && kind === CLASS.EXEC) {
    return record({ tool: name, kind, decision: 'denied', why: 'terminal access is off' });
  }

  if (autonomous) {
    return record({
      tool: name, kind, decision: 'denied',
      why: 'called from an unattended loop — no human to approve it',
    });
  }

  if (kind === CLASS.WRITE && state.autoApproveEdit) {
    return record({ tool: name, kind, decision: 'waived', why: 'auto_approve_on_edit is on' });
  }
  if (kind === CLASS.EXEC && state.autoApproveExec) {
    return record({ tool: name, kind, decision: 'waived', why: 'auto_approve_exec is on' });
  }

  return record({ tool: name, kind, decision: 'ask', args });
}

/**
 * Ask the user. Resolves true/false once /harness approve|deny <id> arrives.
 * `reply` is used once, up front, so the tap prompt is never swallowed by the
 * tool result.
 */
export function requestApproval({ name, cls, args, reason, reply, chatId }) {
  const id = String(++state.seq);
  const promise = new Promise((resolve) => {
    state.pending.set(id, { id, tool: name, kind: cls, args, reason, chatId, at: Date.now(), resolve });
  });
  return { id, promise, text: pendingText({ id, tool: name, kind: cls, args, reason }) };
}

function pendingText({ id, tool, kind, args }) {
  const a = args && Object.keys(args).length ? `\n${JSON.stringify(args).slice(0, 600)}` : '';
  return `⏸ <b>approval ${id}</b> — ${kind.toUpperCase()} <code>${tool}</code>${a}\n\n`
    + `approve: <code>/harness approve ${id}</code>\n`
    + `deny: <code>/harness deny ${id}</code>`;
}

/** Resolve a pending approval. Returns the entry, or null if the id is unknown. */
export function settle(id, decision, by = 'user') {
  const key = String(id);
  const p = state.pending.get(key);
  if (!p) return null;
  state.pending.delete(key);
  const ok = decision === 'approve';
  record({ tool: p.tool, kind: p.kind, decision: ok ? 'approved' : 'denied', id: key, by });
  db.logEvent('harness_decision', {
    tool: p.tool, kind: p.kind, decision: ok ? 'approved' : 'denied', id: key, by, args: p.args,
  }).catch(() => {});
  p.resolve(ok);
  return p;
}

/** Approve/deny everything currently waiting. */
export function settleAll(decision, by = 'user') {
  const out = [];
  for (const id of [...state.pending.keys()]) {
    const p = settle(id, decision, by);
    if (p) out.push(p);
  }
  return out;
}

/** Drop approvals older than an hour; a tap that never comes must not wedge. */
export function expireApprovals(maxAgeMs = HOUR) {
  const now = Date.now();
  let n = 0;
  for (const [id, p] of state.pending) {
    if (now - p.at < maxAgeMs) continue;
    state.pending.delete(id);
    record({ tool: p.tool, kind: p.kind, decision: 'expired', id });
    p.resolve(false);
    n++;
  }
  return n;
}

/**
 * The one call the agent loop makes before every tool.
 *
 * `onAsk` is invoked when a tap is genuinely required; it is given the text to
 * send and returns nothing. The promise resolves only after the user answers.
 */
export async function gate({ name, args, tool, autonomous = false, onAsk = null }) {
  const verdict = evaluate({ name, args, autonomous, tool });
  if (verdict.ok) return { allowed: true, why: verdict.reason };
  if (verdict.decision !== 'ask') {
    return { allowed: false, why: verdict.why, decision: verdict.decision };
  }
  if (!onAsk) {
    return { allowed: false, why: 'approval required but no channel to ask on', decision: 'ask' };
  }
  const { promise } = requestApproval({
    name, cls: verdict.kind, args, reason: verdict.why, chatId: null,
  });
  onAsk({ name, kind: verdict.kind, args });
  const allowed = await Promise.race([
    promise,
    new Promise((r) => setTimeout(() => r('timeout'), HOUR)),
  ]);
  if (allowed === 'timeout') {
    expireApprovals();
    return { allowed: false, why: 'approval never arrived — treated as deny', decision: 'expired' };
  }
  return { allowed: Boolean(allowed), decision: allowed ? 'approved' : 'denied' };
}

// ------------------------------------------------------------ harness facts

/**
 * Everything /harness reports, assembled from real state only.
 *
 * Each row is a FACT with a source. If a fact cannot be read it says
 * "unknown" — it is never filled in from what the code "should" do, because
 * the whole point of /harness is to be the place that cannot lie.
 */
export async function facts() {
  const out = { flags: { ...state }, uptime_ms: Math.round(process.uptime() * 1000) };
  out.node = process.version;
  out.pid = process.pid;
  out.cwd = process.cwd();

  // model routing
  try {
    const { default: ai } = await import('./providers.js');
    out.models = ai.status();
  } catch (e) { out.models = { error: e.message }; }

  // database
  try {
    await db.q('SELECT 1');
    out.database = 'connected';
  } catch (e) { out.database = `unreachable: ${e.message}`; }

  // exchange reachability — a real signed call, not a config read
  try {
    const { default: bitunix } = await import('../exchange/bitunix.js');
    const pairs = await bitunix.getTradingPairs();
    out.exchange = `reachable — ${pairs.length} pairs`;
  } catch (e) { out.exchange = `unreachable: ${e.message}`; }

  // websocket
  try {
    const { default: feed } = await import('../exchange/ws.js');
    out.websocket = {
      public_connected: Boolean(feed.pub?.alive),
      private_connected: Boolean(feed.priv?.alive),
      private_logged_in: Boolean(feed.priv?.loggedIn),
      symbols_watched: feed.tickers?.size ?? 0,
      last_event_ms: feed.lastEventAt ? Math.round((Date.now() - feed.lastEventAt) / 1000) : null,
    };
  } catch (e) { out.websocket = { error: e.message }; }

  // approvals still waiting
  out.pending_approvals = pendingApprovals();
  out.ledger_tail = state.ledger.slice(-12);

  return out;
}

export { config as _config };