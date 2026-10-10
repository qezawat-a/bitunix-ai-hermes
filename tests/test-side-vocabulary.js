/**
 * The exchange says BUY. The engine says LONG. That gap cost real money.
 *
 * Observed live 2026-10-10, NEARUSDT LONG 50x, entry 5.180000:
 *
 *   🔒 Stop moved — NEARUSDT BUY
 *   ROI 11.6% → SL 5.1722300 (breakeven)
 *
 * The Telegram line says BUY. That is the raw exchange field, passed straight
 * through. trailingStop() does `const isLong = side === 'LONG'`, so 'BUY'
 * made every direction test false and the LONG was run through the SHORT
 * branch end to end. The breakeven stop is written as
 * `isLong ? entry + buffer : entry - buffer`, so it came out at entry MINUS the
 * fee buffer: 5.180000 - 0.15% = 5.1722300, exactly what was reported.
 *
 * That is not a breakeven, it is a stop that books a loss the moment it fills:
 * -7.5% ROI at 50x, on a position the bot had just announced as winning.
 *
 * Two more sites compared the raw field against LONG/SHORT and so could never
 * match at all: the duplicate-position guard in openFromSignal, and the
 * positionId lookup that follows a fill.
 */
import { normalizeSide, normalizePosition } from '../src/exchange/bitunix.js';
import { trailingStop } from '../src/trading/risk.js';

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };

// ---- the vocabulary itself -------------------------------------------------
assert(normalizeSide('BUY') === 'LONG', "BUY becomes LONG");
assert(normalizeSide('SELL') === 'SHORT', "SELL becomes SHORT");
assert(normalizeSide('LONG') === 'LONG', 'LONG passes through unchanged');
assert(normalizeSide('SHORT') === 'SHORT', 'SHORT passes through unchanged');
assert(normalizeSide('buy') === 'LONG', 'lowercase is handled');
assert(normalizeSide('') === null, 'an unknown side is rejected, not guessed');
assert(normalizeSide(undefined) === null, 'undefined is rejected, not guessed');

{
  const p = normalizePosition({ symbol: 'NEARUSDT', side: 'BUY', positionId: 1 });
  assert(p.side === 'LONG', 'a position row is normalized');
  assert(p.exchangeSide === 'BUY', 'and keeps the original under exchangeSide');
}

// ---- THE REGRESSION: the exact NEARUSDT numbers ----------------------------
{
  const ENTRY = 5.180000, LEV = 50;
  const buffer = ENTRY * (0.001 + 0.0005);

  // The reported fill was "ROI 11.6% -> SL 5.1722300". trailingStop() returns
  // null below breakeven_threshold (20), so that ROI cannot have come from
  // this function - the only other writer of a 5.1722300 stop is the breakeven
  // leg itself. 5.1722300 is exactly entry - buffer, so the reported level is
  // the SHORT branch of the line below. Reproduce it at the threshold ROI,
  // which is where that branch is reachable, and assert the arithmetic.
  const roi = 20;
  const price = ENTRY * (1 + roi / (100 * LEV));

  const raw = trailingStop({ side: 'BUY', entry: ENTRY, currentPrice: price, atr: 0.010165, roiPct: roi, leverage: LEV });
  assert(raw && raw.stop < ENTRY,
    `unnormalized, a BUY is handled as a SHORT and the stop lands below entry (${raw?.stop})`);
  assert(Math.abs(raw.stop - (ENTRY - buffer)) < 1e-9,
    `and that reproduces the reported 5.1722300 exactly (${raw?.stop?.toFixed(7)})`);

  const fixed = trailingStop({ side: normalizeSide('BUY'), entry: ENTRY, currentPrice: price, atr: 0.010165, roiPct: roi, leverage: LEV });
  assert(fixed && fixed.stop > ENTRY,
    `normalized, the same position puts the stop ABOVE entry (${fixed?.stop?.toFixed(7)})`);
  assert(Math.abs(fixed.stop - (ENTRY + buffer)) < 1e-9,
    `at entry + the fee buffer, the true breakeven (${fixed?.stop?.toFixed(7)})`);
}

// ---- SELL must mirror, not be assumed --------------------------------------
{
  const ENTRY = 5.18, LEV = 50;
  const price = ENTRY * (1 - 20 / (100 * LEV));
  const s = trailingStop({ side: normalizeSide('SELL'), entry: ENTRY, currentPrice: price, atr: 0.010165, roiPct: 20, leverage: LEV });
  assert(s && s.stop < ENTRY, `a SELL breakeven sits below entry (${s?.stop?.toFixed(7)})`);
}

// ---- trailing still ratchets once the side is right ------------------------
{
  const ENTRY = 5.18, LEV = 50;
  const at = (roi) => trailingStop({
    side: 'LONG', entry: ENTRY, currentPrice: ENTRY * (1 + roi / (100 * LEV)),
    atr: ENTRY * 0.0015, roiPct: roi, leverage: LEV,
  });
  assert(at(10) === null, 'nothing below breakeven');
  const b = at(20), t = at(25), f = at(50);
  assert(b && b.stop > ENTRY, 'breakeven is above entry on a long');
  assert(t && t.stop > b.stop, `trailing ratchets up past breakeven (${b.stop.toFixed(7)} -> ${t.stop.toFixed(7)})`);
  assert(f && f.stop > t.stop, `and keeps ratcheting (${t.stop.toFixed(7)} -> ${f.stop.toFixed(7)})`);
  assert(f.stop === ENTRY + (f.stop - ENTRY) && Math.abs((f.stop - ENTRY) / ((ENTRY * (1 + 50 / (100 * LEV))) - ENTRY) - 0.5) < 1e-6,
    'the lock keeps exactly 50% of the move');
}

console.log(`\npassed ${passed}, failed ${failed}`);
if (failed) process.exit(1);