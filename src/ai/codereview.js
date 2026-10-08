/**
 * CODE REVIEW and BUGFIXES — the evidence protocol, mechanised.
 *
 * The rule that makes this worth having: a defect may only be reported against
 * a line the reviewer actually READ, and a symbol may only be called dead
 * after its reachability was PROVEN. That is not a prompt instruction to the
 * model, it is a filter applied to the model's output afterwards:
 *
 *   - every claimed defect must cite file:line inside a file the reviewer
 *     actually opened (enforced by the call log, not by trust);
 *   - a claim that a function is unused is only accepted if a whole-project
 *     search for it returned nothing;
 *   - every finding carries the actual source lines it is about, so the user
 *     can check it in one tap instead of taking the word for it.
 *
 * /bugfixes then takes confirmed findings and repairs them with the build
 * sub-agent, then RUNS THE TEST SUITE, because "I fixed it" and "the tests
 * still pass" are different claims and only one of them is evidence.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import ai from './providers.js';
import { spawn } from './agents.js';
import { createLogger } from '../logger.js';
import { PROJECT_ROOT } from './filetools.js';
import * as db from '../db/index.js';

const execAsync = promisify(exec);
const log = createLogger('code-review');

const IGNORE = new Set(['node_modules', '.git', '.agent_backups', 'generated', '.venv', 'data']);
const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.sql', '.json']);

/** Every source file, grouped by area, for the reviewer to choose from. */
export function inventory() {
  const areas = {};
  const walk = (dir, area) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      if (IGNORE.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, area);
      else if (SOURCE_EXT.has(path.extname(e.name))) {
        (areas[area] ||= []).push(path.relative(PROJECT_ROOT, full));
      }
    }
  };
  walk(path.join(PROJECT_ROOT, 'src'), 'src');
  walk(path.join(PROJECT_ROOT, 'tests'), 'tests');
  walk(path.join(PROJECT_ROOT, 'scripts'), 'scripts');
  return areas;
}

/** Whole-project search for an identifier, ignoring node_modules. */
export async function usages(identifier) {
  try {
    const { stdout } = await execAsync(
      `grep -rn --include='*.js' --include='*.mjs' --include='*.sql' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.agent_backups ${JSON.stringify(identifier)} .`,
      { cwd: PROJECT_ROOT, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout.split('\n').filter(Boolean);
  } catch (e) {
    if (e.code === 1) return [];        // grep: no match — that IS the answer
    throw e;
  }
}

/**
 * Run the project's own tests. Returns the real exit code and tail.
 */
export async function runTests({ timeout = 180_000 } = {}) {
  try {
    const { stdout, stderr } = await execAsync('npm test', { cwd: PROJECT_ROOT, timeout, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, exit: 0, tail: `${stdout}\n${stderr}`.trim().split('\n').slice(-40).join('\n') };
  } catch (e) {
    return {
      ok: false,
      exit: e.code ?? -1,
      tail: `${e.stdout || ''}\n${e.stderr || e.message}`.trim().split('\n').slice(-40).join('\n'),
    };
  }
}

function readLines(rel, around, radius = 6) {
  const abs = path.join(PROJECT_ROOT, rel);
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  const from = Math.max(1, around - radius);
  const to = Math.min(lines.length, around + radius);
  return { from, to, text: lines.slice(from - 1, to).map((l, i) => `${from + i}| ${l}`).join('\n') };
}

/**
 * REVIEW — spawn a read-only sub-agent over a scope, then filter its findings
 * through the evidence rules. Returns only findings that survived.
 */
export async function review({ scope = null, onStep = null } = {}) {
  const areas = inventory();
  const target = scope
    ? Object.fromEntries(Object.entries(areas).map(([k, v]) => [k, v.filter((f) => f.includes(scope))]).filter(([, v]) => v.length))
    : areas;

  if (!Object.values(target).flat().length) {
    throw new Error(`nothing to review matching "${scope}" — try /code-review src/trading`);
  }

  const listing = Object.entries(target)
    .map(([area, files]) => `${area}:\n${files.map((f) => `  ${f}`).join('\n')}`).join('\n\n');

  const prompt = `You are a rigorous code reviewer. Read the files you need with read_file, in full, before judging any of them.

Rules you must follow:
- Never report a defect on a line you have not read.
- Never call a symbol "unused" without running search_files for it across the whole project and seeing zero hits outside its own definition.
- Quote the exact source line for every finding, with its line number.
- Prefer defects that cost money, corrupt state, or lie to the user, over style.
- Do not invent defects to fill space. "No defects found" is a valid and useful answer.

This project's context: a LIVE Bitunix futures trader. Real money. Position guards, stop placement and order sizing are the highest-value targets. There is no dry-run mode.

Files in scope:
${listing}

Report as a JSON array, each element:
{"file":"relative/path.js","line":123,"severity":"critical|high|medium|low","title":"short","evidence":"the exact line you are objecting to","why":"the concrete failure mode — what breaks, and when","fix":"the specific change"}`;

  const r = await spawn({ goal: prompt, mode: 'plan', thinking: 'high', onStep });
  const raw = r.text || '';

  const m = raw.match(/\[[\s\S]*\]/);
  let findings = [];
  try { findings = JSON.parse(m ? m[0] : '[]'); } catch { findings = []; }

  // ---- evidence filter -------------------------------------------------
  const read = new Set();
  for (const t of r.trace || []) {
    if (t.tool === 'read_file' && t.args?.path) read.add(t.args.path);
  }

  const verified = [];
  const rejected = [];

  for (const f of findings) {
    if (!f?.file || !f.line) { rejected.push({ f, why: 'no file:line' }); continue; }

    const abs = path.join(PROJECT_ROOT, f.file);
    if (!fs.existsSync(abs)) { rejected.push({ f, why: `file does not exist: ${f.file}` }); continue; }

    // The reviewer must have actually opened this file.
    const opened = [...read].some((p) => path.normalize(p).endsWith(path.normalize(f.file)));
    if (!opened) { rejected.push({ f, why: `${f.file} was never read by the reviewer` }); continue; }

    const src = readLines(f.file, Number(f.line));
    verified.push({
      ...f,
      severity: ['critical', 'high', 'medium', 'low'].includes(f.severity) ? f.severity : 'low',
      line: Number(f.line),
      source: src.text,
      source_range: `${src.from}-${src.to}`,
    });
  }

  // "unused" claims get an independent whole-project check.
  for (const v of verified) {
    if (!/unused|dead code|never called|unreferenced/i.test(`${v.title} ${v.why}`)) continue;
    const sym = (v.title.match(/[`'"]([\w$]+)[`'"]/) || [])[1];
    if (!sym) { v.dead_code_claim = 'unverified — no symbol named to search'; continue; }
    const hits = await usages(sym);
    v.dead_code_claim = hits.length ? `REFUTED — ${hits.length} reference(s) exist` : 'confirmed — zero references';
  }

  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  verified.sort((a, b) => order[a.severity] - order[b.severity]);

  await db.logEvent('code_review', {
    scope: scope || 'all', found: verified.length, rejected: rejected.length, files: Object.values(target).flat().length,
  }).catch(() => {});

  log.info(`review: ${verified.length} verified, ${rejected.length} rejected as unevidenced`);
  return { scope: scope || 'all', findings: verified, rejected, files: Object.values(target).flat() };
}

/**
 * BUGFIX — take verified findings and repair them, then prove it with tests.
 *
 * Baseline first: if the suite is already red, the fix is measured against
 * that, and the report says so instead of claiming a clean run.
 */
export async function bugfix({ scope = null, maxFindings = 5, onStep = null } = {}) {
  const before = await runTests();
  log.info(`baseline: ${before.ok ? 'green' : `red (exit ${before.exit})`}`);

  const reviewResult = await review({ scope, onStep });
  const targets = reviewResult.findings.slice(0, maxFindings);

  if (!targets.length) {
    return { baseline: before, fixed: [], skipped: reviewResult, note: 'no verified findings to fix' };
  }

  const brief = targets.map((f, i) => `${i + 1}. ${f.file}:${f.line} [${f.severity}] ${f.title}\n   why: ${f.why}\n   fix: ${f.fix}`).join('\n');

  const build = await spawn({
    mode: 'build',
    thinking: 'high',
    onStep,
    goal: `Fix these ${targets.length} confirmed defects in the LIVE futures trader. Fix the root cause, not the symptom. Do not change unrelated behaviour, do not loosen a risk limit, and do not "improve" anything that was not asked for. After each fix, run \`node --check\` on the file. When all are done, run \`npm test\` and report the real result — including if it fails.\n\n${brief}`,
  });

  const after = await runTests();

  await db.logEvent('bugfix_run', {
    findings: targets.length, baseline_ok: before.ok, after_ok: after.ok,
    improved: after.ok && !before.ok,
  }).catch(() => {});

  return {
    baseline: before,
    fixed: targets,
    report: build.text,
    tests: after,
    verdict: after.ok && !before.ok ? 'FIXED — suite went from red to green'
      : after.ok && before.ok ? 'still green (the fix did not break anything, but the suite does not cover it)'
        : after.ok ? 'STILL RED — the suite was red before and after'
          : 'BROKE IT — the suite went from green to red',
  };
}

export { log as _log };