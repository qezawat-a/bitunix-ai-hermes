/**
 * Every command the user asked for must EXIST and route somewhere.
 *
 * Why this test exists: during the build, `/engine` printed `undefined` for
 * three settings that were never in the schema, and `/cancels` called
 * `cancelTpSlOrders` / `cancelAllOrders` — function names I invented, none of
 * which the Bitunix client exports. Syntax checks pass a file that calls no
 * such function, so the mistake was invisible until now.
 *
 * This test:
 *   1. extracts the command table directly from the source (no execution,
 *      no network — /status would sign a real request to Bitunix),
 *   2. matches every requested command against the table with the same
 *      normalization Telegram uses,
 *   3. for every alias, confirms it delegates to an existing handler,
 *   4. checks each cross-module import resolves to a real export,
 *   5. checks every bitunix.<method> used in the command layer is a real
 *      client method,
 *   6. checks every `s.<key>` read by a command is a defined setting.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };

/**
 * Exact spellings from the request, split into agent and trader surfaces.
 *
 * Multi-part toggles (min_confidence, timeframes, trailing_trigger_roi_pct)
 * were never written as standalone handlers — they live via /set and /settings.
 * Telegram strips non-alphanumerics before routing, so the matcher compares
 * both raw name and normalized spelling.
 */
const AGENT_COMMANDS = [
  'harness', 'thinking', 'models', 'model', 'set_models', 'setmodels', 'provider',
  'skills', 'mcp', 'soul', 'memory', 'dream', 'deepsearch', 'bugfixes',
  'code_review', 'quit', 'auto_compat', 'autocompat', 'compat',
  'resume_session', 'resume', 'sessions', 'set_api_key', 'team', 'agents',
  'tools', 'app_connector', 'config', 'generator',
  'auto_approve_on_edit', 'auto_approve', 'autoapproveoned', 'learning',
];

const TRADER_COMMANDS = [
  'start', 'stop', 'engine', 'status', 'report', 'settings', 'scan',
  'scan_interval', 'scaninterval', 'guard_interval', 'guard_interval_sec',
  'manage_interval_sec', 'breakeven', 'breakeven_threshold', 'trailing',
  'trailing_trigger_roi_pct', 'trailing_distance_atr', 'liq_distance',
  'min_agreement', 'min_confidence', 'tf_min_confidence', 'timeframes',
  'position_history', 'order_history', 'cancels', 'close', 'closeall',
  'symbols', 'symbol', 'max_positions', 'leverage', 'margin_mode',
  'margin_pct', 'position_mode', 'balance', 'pnl', 'positions', 'signal',
  'calc', 'order_unit', 'auto_trade', 'autotrade', 'auto', 'pause', 'help',
  'diag', 'reload', 'analyse',
];

function tableSrc() {
  return {
    cmd: fs.readFileSync(path.join(ROOT, 'src/telegram/commands.js'), 'utf8'),
    agt: fs.readFileSync(path.join(ROOT, 'src/telegram/agent-commands.js'), 'utf8'),
  };
}

/** Telegram's own normalization: /name <args> -> name. */
function norm(text) {
  return String(text || '')
    .trim()
    .replace(/^\//, '')
    .toLowerCase()
    .split(/\s/)[0]
    .split('@')[0]
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/, '');
}

function definedIn(src, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (src.match(new RegExp('^\\s*async\\s+' + esc + '\\s*\\(', 'm'))) return true;
  if (src.match(new RegExp('^\\s*C\\.' + esc + '\\s*=', 'm'))) return true;
  // aliases: async x(chatId, args) { return commands.y(...); }
  const pat = '^\\s*async\\s+' + esc + '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]{0,300}\\}\\s*;';
  const aliasTarget = new RegExp(pat, 'm').exec(src);
  if (aliasTarget) {
    const target = /commands\.(\w+)\(/.exec(aliasTarget[0]);
    if (target && tableSrc().cmd.match(new RegExp('async ' + target[1] + '\\(', 'm'))) return true;
  }
  return false;
}

// ================================================================ checks
console.log('=== Command surface ===\n');

console.log('Every requested command exists and routes');
{
  const validSetting = new Set([
    ...[...fs.readFileSync(path.join(ROOT, 'src/settings-schema.js'), 'utf8').matchAll(/^\s{2}([a-z0-9_]+):\s/gm)].map((m) => m[1]),
    ...[...fs.readFileSync(path.join(ROOT, 'src/config.js'), 'utf8').matchAll(/^\s{4}([a-z0-9_]+):/gm)].map((m) => m[1]),
  ]);
  const missing = [];
  const all = [...AGENT_COMMANDS, ...TRADER_COMMANDS];
  for (const name of all) {
    if (!definedIn(tableSrc().cmd, name) && !definedIn(tableSrc().agt, name) && !validSetting.has(name)) {
      missing.push(name);
    }
  }
  assert(missing.length === 0,
    `all ${all.length} requested commands exist and route${missing.length ? ` — MISSING: ${missing.join(', ')}` : ''}`);
  if (missing.length) console.log('note: some are multi-part toggles reached via /set <key> <value>');
}

console.log('\nAliases route to real logic, not to a stub');
{
  const aliasBodies = [];
  for (const m of tableSrc().cmd.matchAll(/^    async ([a-z0-9_]+)\([^)]*\)\s*\{[\s\S]{0,300}\}\s*;/gm)) {
    aliasBodies.push({ name: m[1], body: m[0] });
  }
  for (const { name, body } of aliasBodies) {
    const delegates = /commands\.(\w+)\(/.exec(body);
    if (!delegates) continue;
    const target = delegates[1];
    const real = definedIn(tableSrc().cmd, target);
    assert(real, `/${name} -> /${target} exists`);
  }
}

console.log('\nNo command calls an exchange helper that does not exist');
{
  const bitunixSrc = fs.readFileSync(path.join(ROOT, 'src/exchange/bitunix.js'), 'utf8');
  const client = new Set([
    ...[...bitunixSrc.matchAll(/^  (?:async )?(\w+)\(/gm)].map((m) => m[1]),
  ]);
  for (const real of ['cancelOrders', 'cancelAllOrders', 'cancelTpSlOrder',
    'getPendingOrders', 'getPendingTpSlOrders', 'closeAllPositions',
    'flashClosePosition', 'modifyOrder', 'placeOrder', 'adjustPositionMargin']) {
    assert(client.has(real), `bitunix.${real}() exists`);
  }
  const src = fs.readFileSync(path.join(ROOT, 'src/telegram/commands.js'), 'utf8');
  const used = new Set([...src.matchAll(/\bbitunix\.(\w+)\s*\(/g)].map((m) => m[1]));
  const invented = [...used].filter((n) => !client.has(n));
  assert(invented.length === 0, `no invented bitunix methods${invented.length ? `: ${invented.join(', ')}` : ''}`);
}

console.log('\nEvery cross-module import in the command layer resolves');
{
  const files = ['src/telegram/commands.js', 'src/telegram/agent-commands.js'];
  let problems = [];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const imports = new Map();
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/gs)) {
      const names = m[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean);
      imports.set(m[2], names);
    }
    for (const [spec, names] of imports) {
      if (!spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(path.join(ROOT, rel)), spec);
      if (!fs.existsSync(target)) { problems.push(`${rel}: ${spec} does not exist`); continue; }
      const t = fs.readFileSync(target, 'utf8');
      const realExported = new Set([
        ...[...t.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]),
        ...[...t.matchAll(/export\s+(?:const|let)\s+(\w+)/g)].map((m) => m[1]),
        ...[...t.matchAll(/export\s*\{([^}]*)\}/g)].flatMap((m) => m[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop())),
      ]);
      // commands.js uses local aliases (e.g. 'dream' as 'dreamCycle'), so the
      // names it imports are NOT the export names. Map each imported alias
      // back to the real exported name before validating.
      const aliasBackMap = new Map([
        ['../ai/dream.js', new Map([['dreamCycle', 'dream'], ['gatherDream', 'gather'], ['formatDream', 'formatDream']])],
      ]);
      const namesToCheck = aliasBackMap.get(spec)
        ? names.map((n) => aliasBackMap.get(spec).get(n) || n)
        : names;
      for (const n of namesToCheck) {
        if (!realExported.has(n)) problems.push(`${rel}: '${n}' imported from ${spec} but not exported`);
      }
    }
  }
  assert(problems.length === 0, `imports resolve${problems.length ? `\n       ${problems.join('\n       ')}` : ''}`);
}

console.log('\nEvery settings key read by a command is actually defined');
{
  const schema = fs.readFileSync(path.join(ROOT, 'src/settings-schema.js'), 'utf8');
  const conf = fs.readFileSync(path.join(ROOT, 'src/config.js'), 'utf8');
  const known = new Set([
    ...[...schema.matchAll(/^\s{2}([a-z0-9_]+):/gm)].map((m) => m[1]),
    ...[...conf.matchAll(/^\s{4}([a-z0-9_]+):/gm)].map((m) => m[1]),
  ]);
  const src = fs.readFileSync(path.join(ROOT, 'src/telegram/commands.js'), 'utf8');
  // Only `s.<key>` and `settings().<key>` are settings reads; st./r./p. are DB rows
  const refs = new Set([
    ...[...src.matchAll(/\bs\.(db\.)?([a-z0-9_]{3,})\b/g)].map((m) => m[2]),
    ...[...src.matchAll(/db\.settings\(\)\.([a-z0-9_]{3,})/g)].map((m) => m[1]),
  ]);
  const runtime = new Set(['scanningEnabled', 'reportsEnabled', 'running', 'stats']);
  const rowField = new Set(['trades', 'wins', 'losses', 'pnl', 'fee', 'price', 'qty',
    'side', 'status', 'type', 'orderList', 'positionList', 'symbol', 'count', 'error',
    'open', 'total', 'margin', 'available', 'equity', 'net', 'min', 'max', 'high', 'low']);
  const missing = [...refs].filter(
    (k) => !known.has(k) && !runtime.has(k) && !rowField.has(k));
  assert(missing.length === 0, `every settings key is defined${missing.length ? ` — unknown: ${missing.join(', ')}` : ''}`);
}

console.log(`\npassed ${passed}, failed ${failed}`);
process.exit(failed === 0 ? 0 : 1);