import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOUL_DIR = path.join(__dirname, '../../soul');

function read(file, fallback = '') {
  try { return fs.readFileSync(path.join(SOUL_DIR, file), 'utf8').trim(); }
  catch { return fallback; }
}

export const SKILLS_DIR = path.join(SOUL_DIR, 'skills');

/**
 * Drop-in skills.
 * Any `.md` file in `soul/skills/` is appended to the SKILL section, in
 * filename order. Create a file, restart (or /reload) — no code changes.
 *
 * A file may start with an optional front-matter block:
 *   ---
 *   name: Funding carry
 *   when: symbol funding is above 0.05% per 8h
 *   enabled: true
 *   ---
 * `when:` is shown to the model as the trigger for that skill, so it knows
 * when the knowledge applies instead of reading everything as always-on.
 */
export function loadSkillFiles() {
  let files;
  try {
    files = fs.readdirSync(SKILLS_DIR)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .filter((f) => f.toLowerCase() !== 'readme.md')   // docs, not a skill
      .sort();
  } catch { return []; }

  const out = [];
  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(path.join(SKILLS_DIR, f), 'utf8'); } catch { continue; }

    const meta = {};
    let body = raw;
    const fm = raw.match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (fm) {
      for (const line of fm[1].split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
        if (m) meta[m[1].toLowerCase()] = m[2].trim();
      }
      body = raw.slice(fm[0].length);
    }
    body = body.trim();
    if (!body) continue;

    const enabled = !/^(false|no|off|0)$/i.test(meta.enabled ?? 'true');
    out.push({
      file: f,
      name: meta.name || f.replace(/\.md$/i, '').replace(/[-_]/g, ' '),
      when: meta.when || null,
      enabled,
      body,
    });
  }
  return out;
}

function renderSkills(skills) {
  return skills.filter((s) => s.enabled).map((s) => {
    const head = `## ${s.name}` + (s.when ? `\n_Apply when: ${s.when}_` : '');
    return `${head}\n\n${s.body}`;
  }).join('\n\n');
}

/**
 * SKILL / SOUL / STYLE
 * Three editable markdown files that are injected into the system prompt.
 * Edit them freely — the agent's personality and expertise live there,
 * not in the code.
 */
export function loadSoul() {
  const extra = loadSkillFiles();
  const base = read('SKILL.md');
  const addon = renderSkills(extra);
  return {
    soul: read('SOUL.md'),
    skill: addon ? `${base}\n\n# ADDITIONAL SKILLS\n\n${addon}` : base,
    style: read('STYLE.md'),
    skillFiles: extra,
  };
}

export function buildSystemPrompt({ settings, memories = [], summary = null, portfolio = null, providerStatus = [] }) {
  const { soul, skill, style } = loadSoul();
  const name = config.agentName;

  const settingsBlock = Object.entries(settings)
    .map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`).join('\n');

  // The three facts that cannot live in SOUL.md, because the user can change
  // any of them at runtime with /set and the prompt must never go stale.
  const tpMode = String(settings.tp_mode || 'ADAPTIVE').toUpperCase();
  const tpModeNote = tpMode === 'FIXED_R'
    ? 'every target is a FIXED multiple of the stop distance; it does NOT scale with signal strength, agreement or regime'
    : 'targets scale with signal strength, agreement and regime';

  const trailMethod = String(settings.trailing_method || 'ATR').toUpperCase();
  const trailNote = trailMethod === 'ATR'
    ? `the stop is the more protective of an ATR giveback trail and a profit-anchored lock (${settings.trailing_lock_fraction} of the entry-to-price move). The ATR family is refused when its room is smaller than the round trip — a trail tighter than the cost of exiting cannot pay`
    : `NOT ATR — the profit-anchored lock (${settings.trailing_lock_fraction}) and the structure-timeframe ATR are BOTH bypassed. The stop is a ${trailMethod === 'INTERVAL' ? 'fixed absolute price distance' : 'percentage callback'} of ${settings.trailing_callback} from the best price seen. At high leverage that is far too much giveback; say so if the user relies on it`;

  const rtPct = `${(((Number(settings.round_trip_fee_pct) || 0) + (Number(settings.stop_slippage_pct) || 0)) * 100).toFixed(3)}% of price`;

  const memBlock = memories.length
    ? memories.map((m) => `  - [${m.kind}${m.subject ? '/' + m.subject : ''}] ${m.content}`).join('\n')
    : '  (no long-term memories yet)';

  const portfolioBlock = portfolio
    ? `  open positions: ${portfolio.count}\n  unrealised PnL: ${portfolio.totalPnl?.toFixed?.(4)} USDT\n  margin in use: ${portfolio.totalMargin?.toFixed?.(4)} USDT`
    : '  (unknown)';

  return `# IDENTITY
You are **${name}**, an autonomous AI futures trader operating a REAL, LIVE Bitunix USDT-M perpetual futures account. You are not a bot following a fixed script — you are an agent that reasons, weighs evidence, learns from its own trade history and explains itself like a professional desk trader.

${soul}

# SKILL
${skill}

# STYLE
${style}

# LIVE CONFIGURATION
# The operating rules live in SOUL.md, which is yours to edit without touching
# code. These few cannot live there, because they are true only of the CURRENT
# values below and the user can change any of them with /set at any moment:
#
#   tp_mode          ${tpMode} — ${tpModeNote}
#   trailing_method  ${trailMethod} — ${trailNote}
#   thresholds       breakeven at ${settings.breakeven_threshold}% ROI, trailing arms at
#                    ${settings.trailing_trigger_roi_pct}% ROI, lock fraction
#                    ${settings.trailing_lock_fraction}, round trip
#                    ${rtPct}. Both thresholds are LEVERAGED returns on margin:
#                    at ${settings.leverage}x a ${settings.trailing_trigger_roi_pct}% ROI trigger
#                    is a ${(Number(settings.trailing_trigger_roi_pct || 0) / (Number(settings.leverage) || 1)).toFixed(3)}% move in
#                    price. Convert before commenting on whether one fired.
#   book             min_agreement ${settings.min_agreement}, min_confidence ${settings.min_confidence}, ${settings.leverage}x,
#                    ${settings.margin_mode} margin, ${settings.position_mode} mode, unit ${settings.order_unit},
#                    max ${settings.max_open_positions} positions at ${settings.margin_pct}% each.
#
# Read these before describing how anything behaves. Anything in SOUL.md that a
# setting can change is not a fact until you have checked this block.

# CURRENT SETTINGS
${settingsBlock}

# PORTFOLIO
${portfolioBlock}

# LONG-TERM MEMORY (Neon)
${memBlock}
${summary ? `\n# EARLIER CONVERSATION (compacted)\n${summary}` : ''}

# MODEL ROUTING
${providerStatus.map((p) => `  ${p.provider}: ${p.model}`).join('\n') || '  (none)'}

Think before you act. Use tools to ground every claim. Then answer the user like a sharp, candid human colleague — never like a form letter.`;
}
