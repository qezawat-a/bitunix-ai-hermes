import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

/**
 * .env is authoritative for the critical keys.
 *
 * dotenv deliberately never overrides a variable that already exists in the
 * process environment. For this deployment that is the wrong default: .env is
 * the ONLY place credentials are managed, and the app can be started from a
 * shell that happens to export unrelated variables. Measured on this box
 * (2026-10-07): the surrounding session leaked DATABASE_URL=sqlite:///...
 * (from a different app), a foreign TELEGRAM_BOT_TOKEN and a local
 * ANTHROPIC_BASE_URL=http://127.0.0.1:8082 — every one of which would have
 * silently rerouted the agent to the wrong database / bot / AI endpoint.
 *
 * So: when a .env file exists in CWD, its values win for the keys below, and
 * any conflict with the process environment is logged — never silent.
 */
const CRITICAL_ENV_KEYS = [
  'DATABASE_URL',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ALLOWED_CHAT_IDS',
  'BITUNIX_API_KEY',
  'BITUNIX_API_SECRET',
  'BITUNIX_BASE_URL',
  'OPENAI_COMPATIBLE_KEY',
  'OPENAI_COMPATIBLE_URL',
  'OPENAI_COMPATIBLE_MODEL',
  'GEMINI_GOOGLE_KEY',
  'GEMINI_GOOGLE_URL',
  'GEMINI_GOOGLE_MODEL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'AI_PROVIDER',
];

function enforceDotenvAuthority() {
  const envPath = path.resolve(process.cwd(), '.env');
  let parsed;
  try { parsed = dotenv.parse(fs.readFileSync(envPath)); }
  catch { return; } // no .env file -> ordinary dotenv semantics, nothing to enforce
  const shadowed = [];
  for (const key of CRITICAL_ENV_KEYS) {
    const fileVal = parsed[key];
    if (fileVal === undefined || fileVal === '') continue;
    const envVal = process.env[key];
    if (envVal !== undefined && envVal !== fileVal) {
      process.env[key] = fileVal;
      shadowed.push(key);
    }
  }
  if (shadowed.length) {
    console.warn(`[config] .env takes authority over leaked process env for: ${shadowed.join(', ')}`);
  }
}
enforceDotenvAuthority();

const bool = (v, d) => (v === undefined || v === '' ? d : String(v).toLowerCase() === 'true');
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const str = (v, d) => (v === undefined || v === '' ? d : String(v));

/**
 * Static / boot configuration.
 * Everything under `defaults` is only a *seed*: the live values live in Neon
 * (table agent_settings) and are editable at runtime through Telegram /set
 * or by the agent itself through the `update_settings` tool.
 */
export const config = {
  agentName: str(process.env.AGENT_NAME, 'ARIA'),

  ai: {
    provider: str(process.env.AI_PROVIDER, 'AUTO').toUpperCase(),
    autoRefreshModel: bool(process.env.AUTO_REFRESH_MODEL, true),
    autocompact: bool(process.env.AUTOCOMPACT, true),
    thinkingLevel: str(process.env.THINKING_LEVEL, 'high'),
    openai: {
      key: str(process.env.OPENAI_COMPATIBLE_KEY, ''),
      url: str(process.env.OPENAI_COMPATIBLE_URL, 'https://api.openai.com/v1').replace(/\/+$/, ''),
      model: str(process.env.OPENAI_COMPATIBLE_MODEL || process.env.OPENAI_COMPATIBALE_MODEL, 'AUTO'),
    },
    gemini: {
      key: str(process.env.GEMINI_GOOGLE_KEY, ''),
      url: str(process.env.GEMINI_GOOGLE_URL, 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, ''),
      model: str(process.env.GEMINI_GOOGLE_MODEL || process.env.MODEL, 'AUTO'),
    },
    anthropic: {
      key: str(process.env.ANTHROPIC_API_KEY, ''),
      url: str(process.env.ANTHROPIC_BASE_URL || process.env.BASE_URL, 'https://api.anthropic.com/v1').replace(/\/+$/, ''),
      model: str(process.env.ANTHROPIC_MODEL, 'AUTO'),
    },
  },

  db: { url: str(process.env.DATABASE_URL, '') },

  bitunix: {
    key: str(process.env.BITUNIX_API_KEY, ''),
    secret: str(process.env.BITUNIX_API_SECRET, ''),
    baseUrl: str(process.env.BITUNIX_BASE_URL, 'https://fapi.bitunix.com').replace(/\/+$/, ''),
    wsPublic: str(process.env.BITUNIX_WS_PUBLIC, 'wss://fapi.bitunix.com/public/'),
    wsPrivate: str(process.env.BITUNIX_WS_PRIVATE, 'wss://fapi.bitunix.com/private/'),
    marginCoin: str(process.env.MARGIN_COIN, 'USDT'),
  },

  telegram: {
    token: str(process.env.TELEGRAM_BOT_TOKEN, ''),
    allowed: str(process.env.TELEGRAM_ALLOWED_CHAT_IDS, '')
      .split(',').map((s) => s.trim()).filter(Boolean),
  },

  mcpEnabled: bool(process.env.MCP_ENABLED, true),

  // seeds for agent_settings
  defaults: {
    leverage: num(process.env.LEVERAGE, 10),
    margin_mode: str(process.env.MARGIN_MODE, 'CROSS').toUpperCase(),          // CROSS | ISOLATION
    position_mode: str(process.env.POSITION_MODE, 'HEDGE').toUpperCase(),      // HEDGE | ONE_WAY
    order_unit: str(process.env.ORDER_UNIT, 'COST').toUpperCase(),             // NOMINAL (position value) | COST (margin you commit) | QTY (base coin)
    margin_pct: num(process.env.MARGIN_PCT, 5),                                // % of available balance used as margin
    // Hard ceiling on what ONE position may commit, regardless of anything
    // else asking for it (including the AI judge). The 2026-10-09 losses came
    // from positions sized at ~83% of a 1.40 USDT account; margin_pct says 5%
    // but nothing enforced it. 25% leaves room for several positions and still
    // stops any one of them being the whole account.
    max_margin_pct: num(process.env.MAX_MARGIN_PCT, 25),
    symbols: str(process.env.SYMBOLS, 'AUTO'),                                 // AUTO = full pair list from exchange
    universe_rank: str(process.env.UNIVERSE_RANK, 'VOLUME').toUpperCase(),       // VOLUME | GAINERS | LOSERS | MOVERS
    universe_size: num(process.env.UNIVERSE_SIZE, 40),
    min_24h_volume_usd: num(process.env.MIN_24H_VOLUME_USD, 20_000_000),
    // Scalping-first: 1m/3m for entry timing, 5m/15m for structure.
    // The FIRST timeframe is the execution one, so the ATR stop and target
    // scale to it — this is a scalper, not a swing trader.
    timeframes: str(process.env.TIMEFRAMES, '1m,3m,5m,15m'),

    auto_trade: bool(process.env.AUTO_TRADE, true),
    scan_interval_sec: num(process.env.SCAN_INTERVAL_SEC, 15),
    manage_interval_sec: num(process.env.MANAGE_INTERVAL_SEC, 15),
    guard_interval_sec: num(process.env.GUARD_INTERVAL_SEC, 15),
    report_interval_sec: num(process.env.REPORT_INTERVAL_SEC, 30),
    agent_autonomous_sec: num(process.env.AGENT_AUTONOMOUS_SEC, 15),

    min_agreement: num(process.env.MIN_AGREEMENT, 2),
    min_confidence: num(process.env.MIN_CONFIDENCE, 80),
    tf_min_confidence: num(process.env.TF_MIN_CONFIDENCE, 60),
    signal_confirm_scans: num(process.env.SIGNAL_CONFIRM_SCANS, 1),
    cooldown_min: num(process.env.COOLDOWN_MIN, 5),

    reversal_enabled: bool(process.env.REVERSAL_ENABLED, true),
    reversal_confidence: num(process.env.REVERSAL_CONFIDENCE, 85),

    breakeven_threshold: num(process.env.BREAKEVEN_THRESHOLD, 20),             // ROI %
    trailing_trigger_roi_pct: num(process.env.TRAILING_TRIGGER_ROI_PCT, 25),
    trailing_distance_atr: num(process.env.TRAILING_DISTANCE_ATR, 0.5),
    // Fraction of the entry->price move the stop keeps once trailing starts.
    // Anchored to ENTRY, so it scales with profit made rather than with ATR:
    // this is what actually stopped a 50x position at +30% ROI from ratcheting
    // its stop. 0 disables it and leaves the pure ATR trail.
    trailing_lock_fraction: num(process.env.TRAILING_LOCK_FRACTION, 0.5),
    // The cost model the breakeven stop has to clear: taker fees each way
    // (0.05% in + 0.05% out) plus baseline slippage on a MARKET stop. The
    // trailing engine also refuses a pure ATR trail when k*ATR is smaller
    // than this, because a trail tighter than the round trip cannot pay.
    round_trip_fee_pct: num(process.env.ROUND_TRIP_FEE_PCT, 0.001),
    stop_slippage_pct: num(process.env.STOP_SLIPPAGE_PCT, 0.0005),
    // Ceiling on what ONE round trip may cost as a share of the whole account.
    // All the other cost checks are fractions of notional and so are blind to
    // balance size; on a small account that blindness is the whole problem.
    // Measured 2026-10-09: 0.058 USDT per round trip against a 1.40 USDT
    // balance = 4.1% of the account burned before any profit. Set to 1, a
    // normal 50x scalping position is refused outright at this balance, which
    // is the correct answer - see the refusal message for what to change.
    max_fee_pct_of_balance: num(process.env.MAX_FEE_PCT_OF_BALANCE, 1),
    // --- the four TP/SL methods (help centre id=290) ---
    tp_mode: str(process.env.TP_MODE, 'ADAPTIVE').toUpperCase(),                 // ADAPTIVE | FIXED_R
    tpsl_method: str(process.env.TPSL_METHOD, 'POSITION').toUpperCase(),       // POSITION | PARTIAL
    partial_tp_ladder: str(process.env.PARTIAL_TP_LADDER, '40@1,35@2,25@3'),   // share@R, share@R
    trailing_method: str(process.env.TRAILING_METHOD, 'ATR').toUpperCase(),    // ATR | RATIO | INTERVAL
    trailing_callback: num(process.env.TRAILING_CALLBACK, 1.5),                // % if RATIO, price if INTERVAL
    // Stop/target distances must clear this fraction of price: a bracket
    // inside the taker round-trip fee band can never pay (2026-10-07:
    // 1m-scaled SLs at 0.09% of price on a 0.08-0.10% round trip).
    min_stop_pct: num(process.env.MIN_STOP_PCT, 0.25),
    // RETIRED. The ATR-stop-to-round-trip ratio is still computed and logged, but
    // it no longer refuses a trade: as a scalper on 1m/3m the ATR stop is small
    // by construction, so a ratio floor blocked nearly every signal and the bot
    // stopped trading. Kept at 0 so it survives a DB reset as disabled rather
    // than coming back as 3.
    min_stop_cost_multiple: num(process.env.MIN_STOP_COST_MULTIPLE, 0),
    account_tp_usdt: num(process.env.ACCOUNT_TP_USDT, 0),                      // 0 = off
    account_sl_usdt: num(process.env.ACCOUNT_SL_USDT, 0),                      // 0 = off
    // Safety gap kept between the stop and the liquidation price, as a
    // fraction of the entry->liq distance. 0.50 = the stop may use at most
    // half the distance to liquidation, i.e. it always sits at least as far
    // from liq as it is from entry. Lower = tighter stops, more room to be
    // swept by a wick that grazes liq; higher = safer, but the stop gets
    // pulled in and the position carries more risk per unit of edge.
    liq_distance: num(process.env.LIQ_DISTANCE, 0.5),
    heartbeat_minutes: num(process.env.HEARTBEAT_MINUTES, 15),                 // idle 'still alive' ping
    // Dream: off-hours reflection over its own closed trades and memories.
    // Off by default because it spends a model call; ON makes the agent
    // consolidate its lessons once a day and write them back to Neon.
    dream_enabled: bool(process.env.DREAM_ENABLED, false),
    dream_interval_hours: num(process.env.DREAM_INTERVAL_HOURS, 24),

    max_open_positions: num(process.env.MAX_OPEN_POSITIONS, 5),
    thinking_level: str(process.env.THINKING_LEVEL, 'high'),
    autocompact: bool(process.env.AUTOCOMPACT, true),
    auto_refresh_model: bool(process.env.AUTO_REFRESH_MODEL, true),
  },
};

export function assertBootConfig() {
  const missing = [];
  if (!config.bitunix.key) missing.push('BITUNIX_API_KEY');
  if (!config.bitunix.secret) missing.push('BITUNIX_API_SECRET');
  if (!config.db.url) missing.push('DATABASE_URL');
  if (!config.telegram.token) missing.push('TELEGRAM_BOT_TOKEN');
  const anyAi = config.ai.openai.key || config.ai.gemini.key || config.ai.anthropic.key;
  if (!anyAi) missing.push('at least one of OPENAI_COMPATIBLE_KEY / GEMINI_GOOGLE_KEY / ANTHROPIC_API_KEY');
  if (missing.length) {
    throw new Error(`Missing required environment variables:\n  - ${missing.join('\n  - ')}`);
  }
}
