/**
 * Read-only inspection tools + gated write/exec tools for the agent.
 *
 * This is the local equivalent of the "Evidence Protocol": the agent may not
 * review, judge or conclude anything about code it has not fully read, and it
 * may not call anything dead without proving reachability. The four read tools
 * are safe and need no approval. The three write/exec tools are registered
 * with `danger: true` so they flow through the same approval gate as orders.
 *
 * Safety model (three layers):
 *   1. Project-root jail — every path is resolved under the repo root and any
 *      escape (`..`, absolute paths outside) is refused.
 *   2. Secret files are unreadable — `.env*`, `*.pem`, `*.key` are refused
 *      outright, so a key can never end up in a tool result or a chat message.
 *   3. Approval gate — write_file / edit_file / run_command are danger tools;
 *      in chat they wait for the user's tap, and autonomous loops never call
 *      them blindly (see agent.js requireApproval).
 *
 * edit_file additionally mirrors the backup + syntax-rollback discipline:
 * exact-match only (ambiguous matches are rejected, never guessed), a backup
 * under .agent_backups/, and `node --check` rollback for .js files so a
 * broken edit can never land.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, '..', '..');

const MAX_READ = 20000;
const MAX_HITS = 400;
const BACKUP_DIR = '.agent_backups';
const IGNORES = new Set(['.git', '__pycache__', 'node_modules', '.venv', 'venv', 'data', BACKUP_DIR]);
const READABLE_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.sql', '.example', '']);

const SECRET_NAME = /(^\.env(\.|$))|(\.pem$)|(\.key$)/i;
const DENY_CMD = /(rm\s+-rf?\s+(\/|~(\/|$)?|\*))|(mkfs\b)|(:\(\)\s*\{)/;

/** Resolve a user-supplied path inside the project jail. Throws on escape. */
export function resolveInRoot(p) {
  const raw = String(p || '.');
  const abs = path.resolve(PROJECT_ROOT, raw);
  if (abs !== PROJECT_ROOT && !abs.startsWith(PROJECT_ROOT + path.sep)) {
    throw new Error(`refused: "${raw}" escapes the project directory`);
  }
  if (SECRET_NAME.test(path.basename(abs))) {
    throw new Error(`refused: "${raw}" looks like a secret file — describe the key name, never its value`);
  }
  return abs;
}

function rel(p) {
  return path.relative(PROJECT_ROOT, p) || '.';
}

function walk(root, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (IGNORES.has(e.name)) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

function backup(p) {
  const dir = path.join(PROJECT_ROOT, BACKUP_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${Date.now()}_${path.basename(p)}`);
  fs.copyFileSync(p, dest);
  return dest;
}

function diffSnippet(oldText, newText, name) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  // tiny unified-ish view: first differing hunk with 2 lines of context
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ctx = 2;
  const head = a.slice(Math.max(0, start - ctx), start).map((l) => `  ${l}`);
  const del = a.slice(start, endA).map((l) => `- ${l}`);
  const add = b.slice(start, endB).map((l) => `+ ${l}`);
  const text = [`--- ${name} (before)`, `+++ ${name} (after)`, ...head, ...del, ...add].join('\n');
  return text.length > 1500 ? text.slice(0, 1500) + '\n...[diff truncated]' : text;
}

/** Split "12" / "1-40" style line args. */
function lineRange(args, total) {
  let start = Number(args?.start_line ?? 1);
  let end = Number(args?.end_line ?? total);
  if (!Number.isFinite(start) || start < 1) start = 1;
  if (!Number.isFinite(end) || end > total) end = total;
  start = Math.floor(start); end = Math.floor(end);
  return [start, end];
}

export const fileToolHandlers = {
  async read_file({ path: p, start_line, end_line }) {
    const abs = resolveInRoot(p);
    if (!fs.existsSync(abs)) return `Not found: ${rel(abs)}`;
    if (fs.statSync(abs).isDirectory()) return `${rel(abs)} is a directory — use list_files.`;
    const lines = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n');
    const total = lines.length;
    const [start, end] = lineRange({ start_line, end_line }, total);
    if (start > total) return `[${rel(abs)} | ${total} lines] start_line ${start} is past the end.`;
    const out = [];
    let size = 0, last = start - 1;
    for (let i = start; i <= end; i++) {
      const row = `${i}: ${lines[i - 1]}`;
      if (size + row.length + 1 > MAX_READ) break;
      size += row.length + 1;
      out.push(row);
      last = i;
    }
    let head = `[${rel(abs)} | lines ${start}-${last} of ${total}]`;
    if (last < end) head += ` TRUNCATED - call again with start_line=${last + 1} to read the rest`;
    else if (last >= total) head += ' (end of file)';
    return head + '\n' + out.join('\n');
  },

  async list_files({ path: p }) {
    const abs = resolveInRoot(p || '.');
    if (!fs.existsSync(abs)) return `Not found: ${rel(abs)}`;
    if (!fs.statSync(abs).isDirectory()) return `${rel(abs)} is a file — use read_file.`;
    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .filter((e) => !IGNORES.has(e.name))
      .sort((a, b) => Number(a.isFile()) - Number(b.isFile()) || a.name.localeCompare(b.name))
      .slice(0, 200);
    if (!entries.length) return '(empty)';
    return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n');
  },

  async search_files({ query, path: p }) {
    const q = String(query ?? '');
    if (!q) return 'query is required.';
    const root = resolveInRoot(p || '.');
    const base = fs.existsSync(root) && fs.statSync(root).isDirectory() ? root : path.dirname(root);
    let rx = null;
    try { rx = new RegExp(q); } catch { rx = null; }
    const hits = [];
    for (const f of walk(base)) {
      let lines;
      try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { continue; }
      for (let i = 0; i < lines.length; i++) {
        const ok = rx ? rx.test(lines[i]) : lines[i].includes(q);
        if (ok) {
          hits.push(`${rel(f)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (hits.length >= MAX_HITS) {
            return hits.join('\n') + `\n[stopped at ${MAX_HITS} hits - narrow the query]`;
          }
        }
      }
    }
    return hits.length ? hits.join('\n') : 'No matches.';
  },

  async find_usages({ symbol, path: p }) {
    const sym = String(symbol ?? '').trim();
    if (!sym) return 'symbol is required.';
    const root = resolveInRoot(p || '.');
    const base = fs.existsSync(root) && fs.statSync(root).isDirectory() ? root : path.dirname(root);
    const word = new RegExp(`\\b${sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    const hits = [];
    for (const f of walk(base)) {
      if (!READABLE_EXT.has(path.extname(f).toLowerCase()) && path.extname(f)) continue;
      let lines;
      try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { continue; }
      for (let i = 0; i < lines.length; i++) {
        if (word.test(lines[i])) {
          const kind = /^\s*(import|export\s+.*from|require\s*\()/.test(lines[i]) || /from\s+['"]/.test(lines[i])
            ? 'IMPORT' : 'REF';
          hits.push(`${kind} ${rel(f)}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
          if (hits.length >= MAX_HITS) break;
        }
      }
      if (hits.length >= MAX_HITS) break;
    }
    if (!hits.length) return `No references to '${sym}' anywhere under ${rel(base)}.`;
    const imports = hits.filter((h) => h.startsWith('IMPORT')).length;
    return `${hits.length} references (${imports} imports) to '${sym}':\n`
      + hits.slice(0, MAX_HITS).join('\n');
  },

  async write_file({ path: p, content }) {
    const abs = resolveInRoot(p);
    const text = String(content ?? '');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    let note = '';
    if (fs.existsSync(abs)) {
      const b = backup(abs);
      note = ` Previous version backed up to ${rel(b)}.`;
    }
    fs.writeFileSync(abs, text);
    if (abs.endsWith('.json')) {
      try { JSON.parse(text); }
      catch (e) { return `WROTE BUT INVALID JSON: ${e.message} — fix it before anything reads this file.`; }
    }
    return `Wrote ${text.length} chars to ${rel(abs)}.${note}`;
  },

  async edit_file({ path: p, old, new: nw }) {
    const abs = resolveInRoot(p);
    if (!fs.existsSync(abs)) return `Not found: ${rel(abs)}`;
    const text = fs.readFileSync(abs, 'utf8');
    const o = String(old ?? '');
    const n = String(nw ?? '');
    if (!o) return "'old' is empty.";
    const count = text.split(o).length - 1;
    if (count === 0) return "'old' string not found in file. Re-read the file and copy the exact text.";
    if (count > 1) {
      return `'old' matches ${count} places - ambiguous. Add more surrounding lines so it matches exactly once.`;
    }
    const updated = text.replace(o, n);
    const b = backup(abs);
    fs.writeFileSync(abs, updated);
    if (/\.m?js$/.test(abs)) {
      const ok = await new Promise((resolve) => {
        exec(process.execPath + ' --check ' + JSON.stringify(abs), { timeout: 15000 }, (e) => resolve(!e));
      });
      if (!ok) {
        fs.copyFileSync(b, abs); // rollback
        return `EDIT ROLLED BACK - syntax error after change (backup kept at ${rel(b)}). Re-read the file and retry.`;
      }
    }
    if (abs.endsWith('.json')) {
      try { JSON.parse(updated); }
      catch (e) {
        fs.copyFileSync(b, abs);
        return `EDIT ROLLED BACK - invalid JSON after change: ${e.message} (backup kept at ${rel(b)}).`;
      }
    }
    return `Edited ${rel(abs)}. Syntax OK. Backup: ${rel(b)}\n${diffSnippet(text, updated, path.basename(abs))}`;
  },

  async run_command({ command }) {
    const cmd = String(command ?? '').trim();
    if (!cmd) return 'command is required.';
    if (DENY_CMD.test(cmd)) return 'refused: destructive command pattern.';
    return new Promise((resolve) => {
      exec(cmd, { cwd: PROJECT_ROOT, timeout: 60000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
        let out = (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '');
        if (err && err.killed) out = `[timed out after 60s]\n` + out;
        else if (err && err.code) out = `[exit ${err.code}]\n` + out;
        if (out.length > 8000) out = out.slice(0, 8000) + `\n...[output truncated, ${out.length} chars total]`;
        resolve(out.trim() || '(no output)');
      });
    });
  },
};

/** Tool-registration entries appended to TOOLS in tools.js. */
export function fileToolSpecs() {
  const S = { type: 'string' };
  const P = (props, required) => ({ type: 'object', properties: props, required: required || [] });
  return [
    {
      name: 'read_file',
      description: 'Read a file with line numbers. The header says total lines and whether output was TRUNCATED — if so, read the rest with start_line. Read fully before judging any code.',
      parameters: P({ path: S, start_line: S, end_line: S }, ['path']),
      handler: (a) => fileToolHandlers.read_file(a),
    },
    {
      name: 'list_files',
      description: 'List files and directories under a path (project-rooted). node_modules, .git and data/ are skipped.',
      parameters: P({ path: S }),
      handler: (a) => fileToolHandlers.list_files(a),
    },
    {
      name: 'search_files',
      description: 'Search file contents by regex or substring. Returns every matching line as file:line. Use to find error strings, setting keys, function definitions.',
      parameters: P({ query: S, path: S }, ['query']),
      handler: (a) => fileToolHandlers.search_files(a),
    },
    {
      name: 'find_usages',
      description: 'Find every import and reference of a symbol or module name. Run this BEFORE calling anything a bug or dead code — zero results is itself evidence. Returns IMPORT vs REF lines with file:line.',
      parameters: P({ symbol: S, path: S }, ['symbol']),
      handler: (a) => fileToolHandlers.find_usages(a),
    },
    {
      name: 'write_file',
      description: 'LIVE: create or overwrite a file. Backs up any existing file first. Secret files (.env, keys) are refused. Requires user approval in chat.',
      danger: true,
      parameters: P({ path: S, content: S }, ['path', 'content']),
      handler: (a) => fileToolHandlers.write_file(a),
    },
    {
      name: 'edit_file',
      description: 'LIVE: replace one exact string in a file. Ambiguous matches are rejected — add context. Backs up first, syntax-checks .js (node --check) and rolls back on error. Requires user approval in chat.',
      danger: true,
      parameters: P({ path: S, old: S, new: S }, ['path', 'old', 'new']),
      handler: (a) => fileToolHandlers.edit_file(a),
    },
    {
      name: 'run_command',
      description: 'LIVE: run a shell command in the project directory (60s timeout). Use for git, tests (node tests/run.js), node --check. Destructive patterns are refused. Requires user approval in chat.',
      danger: true,
      parameters: P({ command: S }, ['command']),
      handler: (a) => fileToolHandlers.run_command(a),
    },
  ];
}
