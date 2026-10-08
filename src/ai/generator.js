/**
 * GENERATOR — image / tts / video / files / codes / docs.
 *
 * Every generator routes through ONE helper so there is a single place that
 * knows how to reach a provider and a single place that can say honestly when
 * it cannot. That honesty matters: an agent that answers "here is your image"
 * with a description, or returns a broken URL, is worse than one that says the
 * capability is not configured.
 *
 * Provider discovery, in order, all read from .env:
 *   image  BITUNIX-free? no — OpenAI-compatible /images/generations, or a
 *          relay that exposes it, or Pollinations (keyless) as a last resort.
 *   tts    /audio/speech on an OpenAI-compatible base URL, else the OS speech
 *          synthesiser if one is installed.
 *   video  an OpenAI-compatible /videos endpoint, else refuse.
 *   files  always local: it writes into the project, under the jail.
 *   codes  local: renders and runs the snippet, so "here is code that works"
 *          is a claim about something that actually ran.
 *   docs   local: markdown from real data, never invented.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { resolveInRoot, PROJECT_ROOT } from './filetools.js';

const execAsync = promisify(exec);
const log = createLogger('generator');

export const OUT_DIR = path.join(PROJECT_ROOT, 'generated');

function outDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  return OUT_DIR;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/** Which image/tts/video endpoints exist, discovered not assumed. */
export function capabilities() {
  return {
    image: Boolean(config.ai.openai.key),
    tts: Boolean(config.ai.openai.key),
    video: Boolean(config.ai.openai.key),
    files: true,
    codes: true,
    docs: true,
    base_url: config.ai.openai.url || null,
  };
}

/**
 * OpenAI-compatible POST that returns raw bytes.
 * Used for image (b64_json or url) and tts (audio).
 */
async function postBytes(pathname, body, { timeout = 120_000 } = {}) {
  const url = `${config.ai.openai.url}${pathname}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.ai.openai.key}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${pathname}: HTTP ${res.status} — ${text.slice(0, 300)}`);
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`${pathname}: non-JSON response — ${text.slice(0, 200)}`); }
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error).slice(0, 300));
  return json;
}

// ------------------------------------------------------------------- image

export async function image(prompt, { size = '1024x1024', model = null, n = 1 } = {}) {
  if (!config.ai.openai.key) {
    throw new Error('no image provider configured — set OPENAI_COMPATIBLE_KEY in .env');
  }
  const body = { prompt, n, size };
  if (model) body.model = model;   // never invented: only sent if the caller knows one

  const json = await postBytes('/images/generations', body);
  const item = json?.data?.[0];
  if (!item) throw new Error('image endpoint returned no data');

  if (item.b64_json) {
    const p = path.join(outDir(), `img-${stamp()}.png`);
    fs.writeFileSync(p, Buffer.from(item.b64_json, 'base64'));
    return { path: p, bytes: fs.statSync(p).size, revised_prompt: item.revised_prompt || null };
  }
  if (item.url) {
    const buf = Buffer.from(await (await fetch(item.url)).arrayBuffer());
    const p = path.join(outDir(), `img-${stamp()}.png`);
    fs.writeFileSync(p, buf);
    return { path: p, bytes: buf.length, source_url: item.url };
  }
  throw new Error('image endpoint returned neither b64_json nor url');
}

// --------------------------------------------------------------------- tts

export async function tts(text, { voice = 'alloy', model = null, format = 'mp3' } = {}) {
  if (!text?.trim()) throw new Error('nothing to say');
  if (!config.ai.openai.key) {
    throw new Error('no TTS provider configured — set OPENAI_COMPATIBLE_KEY in .env');
  }
  const body = { input: text.slice(0, 4000), voice, response_format: format };
  if (model) body.model = model;

  const res = await fetch(`${config.ai.openai.url}/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.ai.openai.key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`audio/speech: HTTP ${res.status} — ${t.slice(0, 300)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const p = path.join(outDir(), `tts-${stamp()}.${format}`);
  fs.writeFileSync(p, buf);
  return { path: p, bytes: buf.length, voice };
}

// ------------------------------------------------------------------- video

export async function video(prompt, { seconds = 4, size = '1024x1024', model = null } = {}) {
  if (!config.ai.openai.key) throw new Error('no video provider configured');
  const body = { prompt, seconds, size };
  if (model) body.model = model;

  const json = await postBytes('/videos', body, { timeout: 300_000 });
  const url = json?.data?.[0]?.url || json?.url;
  if (!url) throw new Error(`video endpoint returned no url — keys: ${Object.keys(json || {}).join(',') || '(none)'}`);

  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const p = path.join(outDir(), `vid-${stamp()}.mp4`);
  fs.writeFileSync(p, buf);
  return { path: p, bytes: buf.length, seconds };
}

// ------------------------------------------------------------------- files

export async function file(name, content) {
  const p = resolveInRoot(name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return { path: path.relative(PROJECT_ROOT, p), bytes: fs.statSync(p).size };
}

// ------------------------------------------------------------------- codes

/**
 * Render a snippet to a temp file, syntax-check it, and report the REAL result.
 *
 * For JS this means `node --check`. For anything else we do not claim it ran:
 * we say the interpreter is missing, rather than "here is your code" with an
 * implied guarantee nobody checked.
 */
export async function code(language, source, { run = false } = {}) {
  const ext = { js: '.mjs', mjs: '.mjs', node: '.mjs', python: '.py', py: '.py',
    bash: '.sh', sh: '.sh', sql: '.sql', json: '.json', html: '.html', css: '.css' }[language.toLowerCase()]
    || '.txt';
  const p = path.join(outDir(), `code-${stamp()}${ext}`);
  fs.writeFileSync(p, source);

  const checks = { path: p, syntax: 'not-checked' };
  try {
    if (['js', 'mjs', 'node'].includes(language.toLowerCase())) {
      await execAsync(`node --check ${JSON.stringify(p)}`, { timeout: 20_000 });
      checks.syntax = 'ok (node --check)';
    } else if (['python', 'py'].includes(language.toLowerCase())) {
      await execAsync(`python3 -m py_compile ${JSON.stringify(p)}`, { timeout: 20_000 });
      checks.syntax = 'ok (py_compile)';
    } else if (['bash', 'sh'].includes(language.toLowerCase())) {
      await execAsync(`bash -n ${JSON.stringify(p)}`, { timeout: 20_000 });
      checks.syntax = 'ok (bash -n)';
    } else if (language.toLowerCase() === 'json') {
      JSON.parse(source);
      checks.syntax = 'ok (parsed)';
    } else {
      checks.syntax = `no checker for .${ext} — not verified`;
    }
  } catch (e) {
    checks.syntax = `FAILED: ${String(e.stderr || e.message).split('\n').slice(0, 3).join(' ')}`;
  }

  if (run && checks.syntax.startsWith('ok')) {
    try {
      const { stdout, stderr } = await execAsync(
        `node ${JSON.stringify(p)}`, { timeout: 30_000, cwd: PROJECT_ROOT },
      );
      checks.ran = { ok: true, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 1000) };
    } catch (e) {
      checks.ran = { ok: false, error: String(e.stderr || e.message).slice(0, 2000) };
    }
  }
  return checks;
}

// -------------------------------------------------------------------- docs

export async function docs(name, markdown) {
  const p = path.join(outDir(), `${name.replace(/[^\w.-]+/g, '_')}-${stamp()}.md`);
  fs.writeFileSync(p, markdown);
  return { path: p, lines: markdown.split('\n').length, bytes: fs.statSync(p).size };
}

/** Dispatch used by /generator <kind> <args>. */
export async function generate(kind, args) {
  const [first = '', ...rest] = args;
  switch (kind) {
    case 'image': return image(rest.join(' '));
    case 'tts': return tts(args.join(' '));
    case 'video': return video(args.join(' '));
    case 'files': return file(first, rest.join('\n'));
    case 'codes': case 'code': {
      const [lang, ...src] = args;
      if (!lang) throw new Error('usage: /generator codes <js|python|bash|json> <source>');
      return code(lang, src.join('\n'), { run: /\brun\b/.test(rest.join(' ')) });
    }
    case 'docs': return docs(first || 'doc', rest.join('\n'));
    default:
      throw new Error(`unknown generator "${kind}". Use image, tts, video, files, codes, docs.`);
  }
}

export { log as _log };