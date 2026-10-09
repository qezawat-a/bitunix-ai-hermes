import { settings } from '../db/index.js';

/**
 * FULLY DYNAMIC TP/SL — no static percentages anywhere, no min/max clamps in settings.
 *
 * Stop distance  = ATR * k_sl
 *   k_sl shrinks when the signal is strong and the market is orderly,
 *   widens in volatile / low-conviction conditions.
 *
 * Reward:risk    = f(signal strength, agreement, regime)
 *   a 100-confidence 6-strategy trend signal is allowed to run much further
 *   than a barely-qualified 2-strategy range signal.
 *
 * Everything below is derived per-signal at runtime.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** "15m" -> 900. Used to reason about how fast price moves between guard ticks. */
const TF_SECONDS = { m: 60, h: 3600, d: 86400, w: 604800 };
function tfToSeconds(tf) {
  const m = String(tf || '').trim().match(/^(\d+)\s*([mhdw])$/i);
  if (!m) return 0;
  return Number(m[1]) * (TF_SECONDS[m[2].toLowerCase()] || 60);
}

/**
 * Maintenance margin rate fallback.
 *
 * The authoritative source is GET /api/v1/futures/position/get_position_tiers,
 * which returns maintenanceMarginRate per position-value band. Use
 * bitunix.tierFor({symbol, notional}) and pass the result in as `mmr`.
 *
 * This heuristic only runs when the tier lookup fails (network, new listing).
 * It over-states MMR on every pair measured — BTC real tier-1 is 0.30% and
 * this returns 0.50%, SOL real 0.50% against 1.00% here — which places
 * liquidation closer to entry than reality. That is the safe direction to be
 * wrong in, but it does needlessly cap leverage, so it is a fallback and not
 * the main path.
 */
export function mmrFor(maxLeverage) {
  const maxLev = Number(maxLeverage);
  if (!(maxLev > 0)) return 0.005;
  return clamp(1 / maxLev, 0.004, 0.05);
}

/**
 * Estimate the liquidation price BEFORE the position exists.
 *
 * Bitunix help centre, "Forced Liquidation in Futures Trading":
 *
 *   Liq = Entry x [1 - (Margin - Margin x Lev x MMR) / (Margin x Lev)]
 *
 * Margin cancels out, leaving the standard published form:
 *
 *   Long  : Liq = Entry x (1 - 1/Lev + MMR)
 *   Short : Liq = Entry x (1 + 1/Lev - MMR)
 *
 * Verified against the doc's worked example: entry 100000, 100x, MMR 0.5%
 * -> 100000 x (1 - 0.01 + 0.005) = 99500. The doc prints 99505 because it
 * carries the margin term through unrounded; the 5 USDT difference is 0.005%
 * and lands on the conservative side.
 *
 * CROSS margin liquidates later than this, because the whole account balance
 * backs the position. Using the isolated formula for both modes therefore
 * under-states the distance to liquidation, which is the safe error to make.
 * When the account balance and the position size are both known, the CROSS
 * branch below substitutes the real per-unit backing into the SAME published
 * form; the old code multiplied the isolated distance by 1.3, which was a
 * guess that could go either way depending on the balance.
 *
 * Fees and funding are excluded here exactly as they are in the doc. They move
 * liquidation closer over time, which is why clampStopInsideLiq keeps a buffer.
 */
export function estimateLiqPrice({
  side, entry, leverage, mmr = 0.005, marginMode = 'CROSS',
  balance = null, qty = null,
}) {
  const e = Number(entry);
  const r = Number(mmr);
  if (!(e > 0) || !(r >= 0 && r < 1)) return null;
  const lev = Math.max(1, Number(leverage) || 1);
  const mm = String(marginMode || '').toUpperCase();
  const isCross = mm === 'CROSS';

  // Liquidation is where equity meets the maintenance requirement:
  //
  //   long : M + Q(P - E) = r * Q * P
  //   short: M + Q(E - P) = r * Q * P
  //
  // The exchange's published form is this equation with the margin term
  // approximated, and it is what the liq engine actually approximates, so it
  // is used in every branch rather than mixing in an exact solve. The only
  // thing that differs between modes is perUnit -- the collateral standing
  // behind one unit of size, as a fraction of entry:
  //
  //   ISOLATION: perUnit = 1 / lev. Leverage is the whole story, and the form
  //              collapses to the published E(1 -+ 1/lev -+ MMR).
  //   CROSS:     the entire account balance backs the position, so perUnit is
  //              B/Q/E and leverage drops out. Own committed margin stays a
  //              FLOOR -- the account can only be more secure than one
  //              position's margin implies, never less.
  const b = Number(balance) || 0;
  const q = Number(qty) || 0;
  const crossKnown = isCross && b > 0 && q > 0;
  const perUnit = crossKnown ? Math.max(1 / lev, (b / q) / e) : 1 / lev;

  // perUnit <= r: the maintenance requirement already swallows the collateral.
  // Liquidation sits at or through entry and no stop can outrun it; collapse
  // to entry so the caller refuses the trade.
  if (perUnit <= r) return e;

  // The published form, generalized to the real per-unit backing. One formula
  // for every mode: the CROSS branch only ever EXTENDS the distance from the
  // isolated baseline, never shortens it, so a CROSS position is never modelled
  // as riskier than the same position isolated.
  const liq = side === 'LONG' ? e * (1 - perUnit + r) : e * (1 + perUnit - r);
  if (side === 'LONG' && liq >= e) return e;
  if (side === 'SHORT' && liq <= e) return e;
  return liq;
}

/**
 * Pull a stop back inside the liquidation price.
 *
 * A stop beyond liquidation is not a stop — the exchange closes the position
 * first and takes the whole margin. The stop must sit in front of liq with
 * room to spare, because liq itself drifts (funding, fees, mark-vs-last).
 */
export function clampStopInsideLiq({ side, entry, slPrice, liqPrice, buffer = null }) {
  if (!liqPrice || !Number.isFinite(liqPrice)) return { slPrice, adjusted: false };
  // liq_distance is the user-facing control for this; 0.25 was the old fixed
  // constant. Reading it here means one /set changes every clamp in the system.
  if (buffer == null) buffer = Number(settings().liq_distance ?? 0.5);
  buffer = clamp(Number(buffer), 0.05, 0.9);
  const isLong = side === 'LONG';
  const e = Number(entry);
  const stop = Number(slPrice);

  // A stop sitting on the PROFIT side of entry is already in front of
  // liquidation — it can never be reached by price without the position being
  // closed first. This guard exists for stops on the LOSING side only.
  //
  // It used to measure |entry - stop| and pull in anything "too far", without
  // asking which side of entry it was on. A breakeven or trailing stop on a
  // winner is always farther from entry than the liquidation distance, so every
  // one of them was rewritten to exactly `entry - maxDist` — a fixed level just
  // inside liq that is BELOW entry and below the breakeven it was meant to
  // protect. The recomputed value never changed, so the write "succeeded",
  // the ratchet saw no improvement on the next pass, and the stop sat at the
  // original wide level forever while breakeven_threshold and
  // trailing_trigger_roi_pct appeared to do nothing.
  if ((isLong && stop >= e) || (!isLong && stop <= e)) {
    return { slPrice, adjusted: false };
  }

  const liqDist = Math.abs(e - Number(liqPrice));
  // keep the stop at most (1 - buffer) of the way to liquidation
  const maxDist = liqDist * (1 - buffer);
  const wantDist = Math.abs(e - stop);
  if (wantDist <= maxDist) return { slPrice, adjusted: false };
  const safe = isLong ? e - maxDist : e + maxDist;
  return {
    slPrice: safe,
    adjusted: true,
    reason: `stop was ${wantDist.toFixed(6)} from entry but liquidation is only `
      + `${liqDist.toFixed(6)} away; pulled in to ${maxDist.toFixed(6)}`,
  };
}

/**
 * The largest leverage at which this signal's ATR stop still fits inside
 * liquidation with the safety buffer intact. Used to refuse or de-lever a
 * trade instead of opening one that can only end in liquidation.
 */
export function maxSafeLeverage({
  entry, slDist, mmr = 0.005, buffer = null,
  marginMode = 'ISOLATION', cap = null,
  // `side`/`balance`/`qty` are accepted so callers pass one uniform argument
  // shape. The published liq form is side-independent, so side is not read
  // here; balance/qty only matter for the CROSS branch.
  side: _side = null, balance = null, qty = null,
}) {
  // No cap means "the caller did not set one", NOT "1x". Defaulting an absent
  // cap to 1 would silently force every caller that omits it onto 1x leverage.
  const ceiling = Number(cap) > 0 && Number.isFinite(Number(cap))
    ? Number(cap) : Number.MAX_SAFE_INTEGER;
  const e = Number(entry);
  const r = Number(mmr);
  if (!(e > 0) || !(r >= 0 && r < 1) || !(Number(slDist) > 0)) {
    return Math.max(1, Math.floor(ceiling));
  }
  if (buffer == null) buffer = Number(settings().liq_distance ?? 0.5);
  buffer = clamp(Number(buffer), 0.05, 0.9);

  // Required entry->liq distance once the safety buffer is reserved.
  const needed = Number(slDist) / (1 - buffer);
  const mm = String(marginMode || 'ISOLATION').toUpperCase();
  const b = Number(balance) || 0;
  const q = Number(qty) || 0;

  // CROSS with known backing: liquidation is set by the account balance, not
  // by leverage, so there is no leverage to solve for. De-levering here would
  // be a silent downgrade that fixes nothing -- the liq price barely moves,
  // because it never depended on leverage in the first place.
  if (mm === 'CROSS' && b > 0 && q > 0) return Math.max(1, Math.floor(ceiling));

  // ISOLATION, and CROSS with unknown backing (isolated bound as the
  // conservative stand-in). The published form gives
  // |entry - liq| = entry * (1/lev - MMR) for BOTH sides, so solving
  // |entry - liq| >= needed for lev is side-independent:
  //
  //   1/lev >= r + needed/E   ->   lev <= 1 / (r + needed/E)
  //
  // This deliberately does NOT use the exact-equity (1 -+ r) denominator: the
  // estimator above uses the published form, and the solver has to agree with
  // it or it would compute a "safe" leverage against a different liq price
  // than the one the stop is later clamped against.
  const frac = r + needed / e;
  if (!(frac > 0)) return Math.max(1, Math.floor(ceiling));
  return Math.max(1, Math.min(Math.floor(1 / frac), Math.floor(ceiling)));
}

/**
 * Choose a target from what the tape is actually doing, instead of a fixed
 * multiple of the stop.
 *
 * A fixed R target has one failure mode in each direction: in chop it asks for
 * a move that is not coming, and in a real trend it hands back the part of the
 * move that pays for all the losers. On 20x a 3R target is roughly 100% ROI
 * and the trade is closed — a 25% price run that would have been 500% never
 * gets the chance.
 *
 * So the target widens only when there is evidence to justify it:
 *
 *   strong trend, expanding range   -> NO fixed target; the trailing stop
 *                                      decides when the move is over
 *   trend, but ordinary             -> wide R, scaled by trend strength
 *   squeeze breaking out            -> the measured move (the coiled range
 *                                      projected from the break)
 *   range                           -> the opposite band, and nothing beyond;
 *                                      a range is the one place a runner is
 *                                      simply wrong
 *   weak / no trend                 -> tight, take what is there
 *
 * Returns { tpPrice|null, rr, basis }. A null tpPrice means "let it run" and
 * the caller must ensure a trailing stop is active, otherwise the position has
 * no exit at all.
 */
export function adaptiveTarget({
  side, price, slDist, regime, adx = 0, atrExpansion = 1,
  donHigh = null, donLow = null, trailingEnabled = true,
}) {
  const isLong = side === 'LONG';
  const aligned = isLong ? regime === 'TREND_UP' : regime === 'TREND_DOWN';
  const rrTo = (target) => Math.abs(target - price) / slDist;
  const mk = (target, basis) => ({ tpPrice: target, rr: rrTo(target), basis });

  // --- 1. the runner ------------------------------------------------------
  // Strong directional trend AND a range that is still opening up. Both are
  // required: high ADX on a contracting range is a trend running out of fuel.
  if (aligned && adx >= 30 && atrExpansion >= 1.15) {
    if (trailingEnabled) {
      return { tpPrice: null, rr: null, basis: `trend ADX ${adx.toFixed(0)}, range expanding ${atrExpansion.toFixed(2)}x — no fixed target, trailing it` };
    }
    // Without a trailing stop an open-ended target is an open-ended position.
    const t = isLong ? price + slDist * 8 : price - slDist * 8;
    return mk(t, `strong trend but trailing is off — capped at 8R`);
  }

  // --- 2. range: the other side of the box, never past it -----------------
  if (regime === 'RANGE' && donHigh != null && donLow != null) {
    const band = isLong ? donHigh : donLow;
    const rr = rrTo(band);
    // if the band is closer than the stop the trade is not worth taking on
    // structure alone; fall back to a modest multiple
    if (rr >= 1.2) return mk(band, `range — opposite band at ${band.toFixed(6)}`);
    return mk(isLong ? price + slDist * 1.5 : price - slDist * 1.5, 'range, band too close — 1.5R');
  }

  // --- 3. squeeze break: the measured move --------------------------------
  if (regime === 'SQUEEZE' && donHigh != null && donLow != null) {
    const height = donHigh - donLow;
    if (height > 0) {
      const t = isLong ? price + height : price - height;
      const rr = rrTo(t);
      if (rr >= 1.5) return mk(t, `squeeze — measured move ${height.toFixed(6)}`);
    }
  }

  // --- 4. trending, ordinary ----------------------------------------------
  if (aligned) {
    // ADX 22 -> 3R, ADX 30 -> 5R, flattening off above that
    const rr = clamp(3 + (adx - 22) * 0.25, 3, 5);
    return mk(isLong ? price + slDist * rr : price - slDist * rr,
      `trend ADX ${adx.toFixed(0)} — ${rr.toFixed(1)}R`);
  }

  // --- 5. nothing to lean on ----------------------------------------------
  const rr = adx < 20 ? 1.5 : 2.2;
  return mk(isLong ? price + slDist * rr : price - slDist * rr,
    `no aligned trend (ADX ${adx.toFixed(0)}) — ${rr}R`);
}

/**
 * Which ATR stop/target distances scale to?
 *
 * One policy, shared by the executor's initial bracket and the guard's
 * trailing engine. The bug this exists for (2026-10-07, measured live):
 * TIMEFRAMES=1m,3m,5m,15m and the FIRST timeframe sizes the bracket.
 * 1m ATR is noise-level (BTC measured 0.052% of price), so SL came out
 * ~0.09% and TP ~0.14% — inside the 0.08–0.10% taker round trip. Fifty
 * closes later: 38 at PnL≈0, net +0.17 USDT. The account paid commission.
 *
 * Contract:
 *   input : signal (signal.atr + signal.timeframes {[tf]: {atr, ...}}), settings
 *   output: { atr: <number> to size distances with, tf: '<tf>' it came from }
 *   policy: size off a STRUCTURE timeframe, not the execution one; walk the
 *           configured list to the first TF with a valid ATR; fall back to
 *           signal.atr when nothing is valid.
 *
 * The pick below is the human's design task (see the TODO marker in the body).
 */
export function stopAtrFor(signal, s) {
  // signal.timeframes — per-TF analysis; a TF whose candles failed is absent
  // s.timeframes      — "1m,3m,5m,15m" (first entry = the execution TF)
  // return { atr, tf } — tf names the timeframe actually used
  const configured = String(s?.timeframes || '1m').split(',').map((x) => x.trim()).filter(Boolean);
  const executionTf = configured[0] || '1m';
  const per = signal?.timeframes || {};

  // Walk the configured list and take the first timeframe whose ATR is real.
  //
  // Why this exists: sizing on the execution TF put both the initial bracket
  // and the TRAILING stop inside the fee band. On 1m the ATR is noise — the
  // trail became `price - 0.5 * noise`, i.e. a stop a hair under price that
  // the next 15s guard tick walked straight through. The user saw a position
  // sit at +30% ROI with a stop that refused to rise.
  //
  // The EXECUTION timeframe is deliberately skipped: that is the one whose
  // ATR is noise by definition (it is the bar you intend to scalp). The first
  // STRUCTURE timeframe with a usable ATR wins, so 1m,3m,5m,15m sizes on 3m.
  let best = null;
  for (let i = 1; i < configured.length; i++) {
    const tf = configured[i];
    const atr = Number(per[tf]?.atr);
    if (Number.isFinite(atr) && atr > 0) { best = { atr, tf }; break; }
  }

  // No structure TF available (unconfigured list, or every other candle
  // fetch failed): the execution ATR is still better than nothing, but the
  // caller must know it fell back so it can widen the bracket itself.
  if (!best) {
    const atr = Number(signal?.atr) || 0;
    return { atr, tf: executionTf, fallback: true };
  }
  return { ...best, fallback: false };
}

export function computeDynamicTpSl(signal) {
  const s = settings();
  const price = Number(signal.price);
  // Distance is sized by ONE policy (stopAtrFor), never by the raw scan ATR:
  // the execution TF's ATR is noise-level and puts the bracket in the fee band.
  const picked = stopAtrFor(signal, s);
  const atr = picked.atr || Number(signal.atr);
  const stopTf = picked.tf;
  const conf = Number(signal.confidence);
  const agreement = Number(signal.agreement);
  const atrPct = price ? (atr / price) * 100 : 0;
  const regime = signal.regime || 'RANGE';

  // ---- strength score 0..1 -------------------------------------------
  const minConf = Number(s.min_confidence || 80);
  const confPart = clamp((conf - minConf) / (100 - minConf || 1), 0, 1);      // how far above the bar
  const agreePart = clamp((agreement - Number(s.min_agreement || 2)) / 4, 0, 1);
  const strength = clamp(0.55 * confPart + 0.45 * agreePart, 0, 1);

  // ---- stop multiplier ------------------------------------------------
  // base 1.5 ATR, tighter for strong signals, wider for volatile tape
  let kSl = 1.5 - 0.35 * strength;
  if (regime === 'VOLATILE') kSl += 0.6;
  if (regime === 'SQUEEZE') kSl += 0.25;              // breakouts need room for the retest
  if (regime === 'RANGE') kSl -= 0.1;
  if (atrPct < 0.25) kSl += 0.4;                      // very quiet tape -> noise stops
  kSl = clamp(kSl, 0.8, 3.2);

  // ---- reward:risk ----------------------------------------------------
  let rr = 1.3 + 2.2 * strength;                      // 1.3R .. 3.5R
  if (regime === 'TREND_UP' || regime === 'TREND_DOWN') rr += 0.5;
  if (regime === 'RANGE') rr -= 0.35;                 // take what the range gives
  if (regime === 'VOLATILE') rr += 0.2;
  if (signal.htfRegime && signal.side === 'LONG' && signal.htfRegime === 'TREND_UP') rr += 0.3;
  if (signal.htfRegime && signal.side === 'SHORT' && signal.htfRegime === 'TREND_DOWN') rr += 0.3;
  rr = clamp(rr, 1.1, 4.5);

  let slDist = atr * kSl;

  // A bracket inside the fee band can never pay: measured 2026-10-07, a
  // 1m-scaled SL of ~0.09% of price on a 0.08-0.10% taker round trip, and
  // 38 of the last 50 closes landed at PnL ~ 0. The liq clamp below may
  // still pull a floored stop in — that is the safe direction to be wrong in.
  const minPct = Number(s.min_stop_pct ?? 0.25);
  if (minPct > 0) slDist = Math.max(slDist, price * (minPct / 100));

  // ---- liquidation guard ----------------------------------------------
  // An ATR stop knows nothing about leverage. At high leverage the liquidation
  // price can sit CLOSER to entry than the stop, so the exchange liquidates
  // first and the stop never fires. Clamp the stop inside liq, always.
  const isLong = signal.side === 'LONG';
  const lev = Number(signal.leverage) || Number(s.leverage) || 1;
  const mmr = signal.mmr ?? mmrFor(signal.maxLeverage);
  // The margin mode decides whether leverage even appears in the liq formula,
  // so it has to reach both the estimate and the leverage solver below.
  const marginMode = String(signal.marginMode || s.margin_mode || 'CROSS').toUpperCase();
  const liqPrice = signal.liqPrice
    ?? estimateLiqPrice({
      side: signal.side, entry: price, leverage: lev, mmr, marginMode,
      balance: Number(signal.accountBalance) || null,
      qty: Number(signal.qty) || null,
    });
  let liqAdjusted = false;
  let liqNote = null;
  // liq at/through entry: the position is unopenable at this leverage
  const liqUnsafe = liqPrice != null
    && (isLong ? liqPrice >= price : liqPrice <= price);

  if (liqPrice) {
    const raw = isLong ? price - slDist : price + slDist;
    const c = clampStopInsideLiq({ side: signal.side, entry: price, slPrice: raw, liqPrice });
    if (c.adjusted) {
      slDist = Math.abs(price - c.slPrice);
      liqAdjusted = true;
      liqNote = c.reason;
    }
  }

  const slPrice = isLong ? price - slDist : price + slDist;

  // tp_mode ADAPTIVE lets the target come from the tape; FIXED_R keeps the
  // original behaviour of a confidence-scaled multiple of the stop.
  let tpPrice;
  let tpBasis;
  let effRr = rr;
  if (String(s.tp_mode || 'ADAPTIVE').toUpperCase() === 'ADAPTIVE') {
    const t = adaptiveTarget({
      side: signal.side, price, slDist, regime,
      adx: Number(signal.adx) || 0,
      atrExpansion: Number(signal.atrExpansion) || 1,
      donHigh: signal.donHigh ?? null,
      donLow: signal.donLow ?? null,
      // Read the real setting rather than hardcoding true: the "no fixed target,
      // let it run" branch is only safe while a trailing stop is actually
      // active. With trailing_method=RATIO/INTERVAL and a position that never
      // reaches its activation price, the open-ended branch would leave the
      // position with a stop but no exit.
      trailingEnabled: String(s.trailing_method || 'ATR').toUpperCase() === 'ATR'
        && Number(s.auto_trade ?? 1) !== 0,
    });
    tpPrice = t.tpPrice;
    tpBasis = t.basis;
    effRr = t.rr;
  } else {
    tpPrice = isLong ? price + slDist * rr : price - slDist * rr;
    tpBasis = `fixed ${rr.toFixed(2)}R`;
  }
  const tpDist = tpPrice == null ? null : Math.abs(tpPrice - price);
  // The cap is the exchange's own max for this pair: the solver may never
  // recommend MORE than the account can take. Without it the absent-cap
  // default (MAX_SAFE_INTEGER) would read as "unbounded".
  const safeLev = maxSafeLeverage({
    entry: price, slDist: atr * kSl, mmr, marginMode, side: signal.side,
    cap: Number(signal.maxLeverage) || null,
    balance: Number(signal.accountBalance) || null,
    qty: Number(signal.qty) || null,
  });

  return {
    slPrice,
    tpPrice,
    slDist,
    tpDist,
    tpBasis,
    rr: effRr == null ? null : Number(effRr.toFixed(2)),
    liqPrice,
    liqAdjusted,
    liqNote,
    liqUnsafe,
    maxSafeLeverage: safeLev,
    mmr,
    atrTf: stopTf,
    kSl: Number(kSl.toFixed(2)),
    baseRr: Number(rr.toFixed(2)),
    strength: Number(strength.toFixed(2)),
    slPct: Number(((slDist / price) * 100).toFixed(3)),
    tpPct: tpDist == null ? null : Number(((tpDist / price) * 100).toFixed(3)),
    explain: `ATR ${atr.toFixed(6)} (${stopTf}) x ${kSl.toFixed(2)} stop, `
      + (tpPrice == null ? 'NO fixed target (trailing)' : `${effRr.toFixed(2)}R target`)
      + ` — ${tpBasis} (strength ${(strength * 100).toFixed(0)}%, regime ${regime})`
      + (liqAdjusted ? ` — STOP PULLED INSIDE LIQUIDATION: ${liqNote}` : ''),
  };
}

/**
 * Trailing stop level once the position is in profit.
 * Uses the same ATR engine, ratcheting behind price.
 *
 * The stop is the BETTER of two families, never the second one alone:
 *
 *   1. giveback   — currentPrice - k*ATR. The classic "follows price" trail.
 *   2. profitLock — entry + lockFraction * (currentPrice - entry).
 *
 * Measured failure this fixes (AVAXUSDT LONG, 50x, 2026-10-07):
 *   the giveback family produced stop = price - 0.5 * (1m ATR). Because the
 *   ATR was noise-level, that stop sat a fraction of a basis point under
 *   price while the guard polled only every 15s. Price crossed it inside the
 *   polling interval, so the position never actually trailed: at +20% and
 *   +25% ROI the computed stop was still exactly breakeven (+0.08% of price,
 *   worth +4% ROI), and by +30% it had crawled up by 0.03% of price. The
 *   user watched a winner sit there with a stop that refused to move.
 *
 * The profitLock family is anchored to ENTRY, not to price, so it is immune
 * to how tight the ATR is: the stop always reflects a fraction of the profit
 * actually made. It only wins when it is genuinely more protective, which the
 * `better` comparison enforces. On a quiet tape the trail is a giveback stop
 * (it follows price closely); on a fast one it is a ratchet that keeps a
 * slice of the move.
 *
 * The 50x arithmetic behind the incident, for anyone revisiting this: at 50x
 * a +30% ROI is a 0.60% move in PRICE. A trailing stop trailing by 0.5% of
 * price is already behind where the position started — it has nowhere to go.
 * Leverage shrinks the room a trail needs, so the ATR given above must come
 * from a structure timeframe (see stopAtrFor), never from the execution bar.
 */
export function trailingStop({ side, entry, currentPrice, atr, roiPct, leverage, liqPrice }) {
  const s = settings();
  const beThreshold = Number(s.breakeven_threshold || 20);        // ROI %
  const trailTrigger = Number(s.trailing_trigger_roi_pct || 25);  // ROI %
  const isLong = side === 'LONG';

  // ROI here is leveraged return on margin, matching what the exchange UI shows
  if (roiPct < beThreshold) return null;

  // ---- 1. breakeven, clear of the real round trip ---------------------
  //
  // roundTripFees is the actual per-side-plus-exit cost; the old constant
  // 0.0008 was 0.08% while the taker round trip is ~0.10% (0.05% each way),
  // so "breakeven" sat BELOW true breakeven and a correctly-fired stop still
  // booked a loss. Add the baseline slippage too: this is a MARKET stop, so
  // it is filled past its trigger by however far the market moved.
  const fee = Number(s.round_trip_fee_pct ?? 0.001) || 0.001;   // 0.10%
  const slip = Number(s.stop_slippage_pct ?? 0.0005) || 0.0005; // 0.05%
  const bufferPct = fee + slip;
  const buffer = entry * bufferPct;
  let stop = isLong ? entry + buffer : entry - buffer;
  let reason = 'breakeven';

  if (roiPct >= trailTrigger) {
    const k = clamp(Number(s.trailing_distance_atr ?? 0.5), 0.1, 5);

    // giveback: a fixed distance behind price
    const giveback = isLong ? currentPrice - atr * k : currentPrice + atr * k;

    // profitLock: keep a fraction of the move, measured from ENTRY. This is
    // the family that scales with profit instead of with ATR, so it keeps
    // working when the ATR is too small to trail with.
    const lockFraction = clamp(Number(s.trailing_lock_fraction ?? 0.5), 0, 0.95);
    const move = Math.abs(Number(currentPrice) - Number(entry));
    const locked = isLong ? entry + move * lockFraction : entry - move * lockFraction;

    // --- the 50x hang, decided here -----------------------------------
    //
    // The giveback family alone produces `price - 0.5 * ATR`. On an
    // execution-TF ATR that is a hair below price, and the consequence
    // compounds with leverage: the room the trail leaves behind is
    // (k*ATR) of price, while the round trip costs (fees+slippage) of
    // price. Leverage multiplies both, but it does not change their RATIO
    // — and when the room is smaller than the cost, the trail is spending
    // more to exit than it can ever have made.
    //
    // Measured on AVAXUSDT LONG 50x, 2026-10-07: at ROI 20% and 25% the
    // computed stop was still exactly breakeven, and at 30% it had crawled
    // up 0.03% of price. The user watched a winner sit with a stop that
    // refused to move. With the 1m ATR at 0.05 of price and k=0.5 the trail
    // left 0.025 of price — against 0.15 of price in fees and slippage, a
    // 6:1 loss. At 50x that gap is the whole 36% ROI on TRBUSDT.
    //
    // So the test is not "can price reach the stop before the next tick" —
    // it is "is the trail room worth more than the round trip". When it is
    // not, a tight giveback stop is just an expensive coin flip, and
    // profitLock (anchored to entry, scaled by profit made) is the honest
    // choice.
    //
    // Both sides are compared as a FRACTION OF PRICE. `atr` arrives in price
    // units (it is the exchange's absolute ATR) while bufferPct is a
    // fraction, so comparing them directly is a unit error that silently
    // passes every time — trailRoom looked like 0.025 "bigger than" 0.0015.
    const atrPct = entry > 0 ? (Number(atr) || 0) / entry : 0;
    const trailRoom = atrPct * k;          // fraction of price
    const costRoom = bufferPct;            // fraction of price
    const trailUsable = atrPct > 0 && trailRoom >= costRoom;

    if (trailUsable && ((isLong && giveback > stop) || (!isLong && giveback < stop))) {
      stop = giveback;
      reason = `trailing ${k} ATR`;
    }
    if (lockFraction > 0 && ((isLong && locked > stop) || (!isLong && locked < stop))) {
      stop = locked;
      reason = trailUsable
        ? `trailing ${k} ATR, locking ${(lockFraction * 100).toFixed(0)}% of move`
        : `locking ${(lockFraction * 100).toFixed(0)}% of move `
          + `(ATR trail ${(trailRoom * 100).toFixed(4)}% < round trip ${(costRoom * 100).toFixed(4)}%)`;
    }
  }
  // Never hand the exchange a stop behind liquidation, even a breakeven one:
  // on a position already deep in loss, breakeven can be the wrong side of liq.
  if (liqPrice) {
    const c = clampStopInsideLiq({ side, entry, slPrice: stop, liqPrice });
    if (c.adjusted) { stop = c.slPrice; reason += ' (clamped inside liq)'; }
  }
  return { stop, reason };
}

/** Position sizing: margin_pct of available balance (order unit = COST/USDT). */
export function computeMargin({ available, marginPct, openPositions, maxPositions }) {
  const pct = Number(marginPct) / 100;
  let margin = Number(available) * pct;
  // never let the book exceed what the remaining slots can carry
  const slotsLeft = Math.max(1, Number(maxPositions) - Number(openPositions));
  const cap = Number(available) / slotsLeft;
  if (margin > cap) margin = cap;
  return Math.max(0, margin);
}
