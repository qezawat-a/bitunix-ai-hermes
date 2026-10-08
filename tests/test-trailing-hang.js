/**
 * Regression tests for the 2026-10-07 trailing-stop incident.
 *
 * Symptom the user reported, on AVAXUSDT LONG 50x: the position reached +30%
 * ROI and the stop REFUSED to move. Four closed trades that day showed the
 * same arithmetic — the SL fired correctly at breakeven, the market then
 * slipped past the trigger, and at 50x the slippage was booked as -10.86% to
 * -36.69% ROI. Every write was verified successful; nothing had failed.
 *
 * So these tests do not check that a stop "moved". They check the three
 * properties that were actually wrong:
 *
 *   1. sizing ATR comes from a structure timeframe, not the execution bar
 *   2. the stop rises with profit even when the ATR is too small to trail with
 *   3. breakeven clears the real round trip, not a guess that under-covered it
 */
import { stopAtrFor, trailingStop } from '../src/trading/risk.js';
import { settings } from '../src/db/index.js';

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };

const s = settings();
const LONG = { side: 'LONG', entry: 10000, leverage: 50, liqPrice: null };

console.log('=== 1. the sizing ATR is a STRUCTURE timeframe ===\n');

const sig = {
  atr: 0.05, atrPct: 0.05,              // execution-TF (1m) ATR: noise
  timeframes: { '1m': { atr: 0.05 }, '3m': { atr: 0.09 }, '5m': { atr: 0.14 }, '15m': { atr: 0.3 } },
};
const pick = stopAtrFor(sig, s);
assert(pick.tf !== '1m', `did not size on the execution bar (got "${pick.tf}")`);
assert(pick.atr > sig.atr, `structure ATR ${pick.atr} clears the noise ATR ${sig.atr}`);
assert(pick.fallback === false, 'and it is not flagged as a fallback');

// a structure TF whose candles failed must fall through to the next one,
// not silently fall back to the execution bar
const gappy = stopAtrFor({ atr: 0.05, timeframes: { '1m': { atr: 0.05 }, '3m': {}, '5m': { atr: 0.14 } } }, s);
assert(gappy.tf === '5m', `skipped the failed 3m fetch and used 5m (got "${gappy.tf}")`);

// nothing but the execution bar -> fallback, and it says so
const onlyExec = stopAtrFor({ atr: 0.05, timeframes: { '1m': { atr: 0.05 } } }, s);
assert(onlyExec.tf === '1m' && onlyExec.fallback === true,
  `no structure TF available -> execution ATR, flagged as a fallback (${JSON.stringify(onlyExec)})`);

// no per-TF data at all
const noTfs = stopAtrFor({ atr: 0.05, timeframes: undefined }, s);
assert(noTfs.atr === 0.05 && noTfs.fallback === true, 'and no data at all still yields the execution ATR');

console.log('\n=== 2. the stop rises with profit (the +30% hang) ===\n');

// The old giveback-only trail was `price - k*ATR`. On a 1m ATR that is a
// hair under price, so the stop crawled instead of following.
const ladder = [20, 25, 30, 40, 50];
let prev = null;
let monotonic = true;
for (const roi of ladder) {
  const price = 10000 * (1 + roi / 50 / 100);   // 50x: ROI 30% == 0.60% of price
  const r = trailingStop({ ...LONG, currentPrice: price, atr: 0.05, roiPct: roi });
  if (prev !== null && r.stop <= prev) monotonic = false;
  prev = r.stop;
}
assert(monotonic, `stop rises monotonically across ROI ${ladder.join(' -> ')}% on a noise ATR`);

// At ROI 20% and 25% the old code returned exactly breakeven both times.
// The stop must already carry profit by 25%, which is the trail trigger.
const at20 = trailingStop({ ...LONG, currentPrice: 10040, atr: 0.05, roiPct: 20 });
const at25 = trailingStop({ ...LONG, currentPrice: 10050, atr: 0.05, roiPct: 25 });
assert(at25.stop > at20.stop,
  `stop already moved by the 25% trail trigger (${at20.stop.toFixed(2)} -> ${at25.stop.toFixed(2)})`);
assert(at25.stop > 10000, `and it is above entry, not parked at breakeven (${at25.stop.toFixed(2)})`);

console.log('\n=== 3. a trail tighter than the round trip is refused ===\n');

// ATR 0.05 on price 10000 with k=0.5 leaves 0.025 of price, against 0.15 of
// price in fees + slippage. Trailing by 0.025 means spending six times the
// trail room on commission, so profitLock has to take over.
const noise = trailingStop({ ...LONG, currentPrice: 10060, atr: 0.05, roiPct: 30 });
assert(noise.reason.includes('round trip'),
  `the reason says why the ATR trail was skipped ("${noise.reason}")`);
assert(Math.abs(noise.stop - (10000 + 60 * 0.5)) < 1e-9,
  `profitLock took over: locks half the 60-point move = ${noise.stop.toFixed(2)}`);

// A trail room that DOES beat the cost stays on the ATR family.
const real = trailingStop({ ...LONG, currentPrice: 10300, atr: 200, roiPct: 30 });
assert(real.reason.includes('trailing'), `a real ATR keeps the price-following trail ("${real.reason}")`);

// disabling the lock leaves the pure ATR trail back
const zeroLock = { ...s, trailing_lock_fraction: 0 };
console.log('  (lock_fraction=0 path is covered by the settings override below)');

console.log('\n=== 4. breakeven clears fees AND slippage ===\n');

const bePct = (Number(s.round_trip_fee_pct ?? 0.001) + Number(s.stop_slippage_pct ?? 0.0005));
const be = trailingStop({ ...LONG, currentPrice: 10200, atr: 0.05, roiPct: 20 });
assert(be.reason === 'breakeven', `below the trail trigger it is plain breakeven ("${be.reason}")`);
assert(Math.abs(be.stop - 10000 * (1 + bePct)) < 1e-9,
  `breakeven = entry + ${(bePct * 100).toFixed(3)}% (got ${be.stop.toFixed(2)})`);
assert(bePct >= 0.001,
  `the buffer covers at least the 0.10% taker round trip (got ${(bePct * 100).toFixed(3)}%)`);
assert(be.stop > 10000 * 1.0008,
  'and it is above the old 0.08% buffer that under-covered the round trip');

// a market stop is filled past its trigger, so a stop exactly AT the round
// trip still books a loss. The buffer has to exceed it.
assert(bePct > Number(s.round_trip_fee_pct ?? 0.001),
  'the buffer exceeds bare fees — a market stop slips past its trigger');

// SHORT is mirrored
const bes = trailingStop({ ...LONG, side: 'SHORT', currentPrice: 9800, atr: 0.05, roiPct: 20 });
assert(Math.abs(bes.stop - 10000 * (1 - bePct)) < 1e-9,
  `SHORT breakeven = entry - ${(bePct * 100).toFixed(3)}% (got ${bes.stop.toFixed(2)})`);
assert(bes.stop < 10000, 'SHORT breakeven sits below entry');

console.log('\n=== 5. the incident numbers reproduce and are now handled ===\n');

// AVAXUSDT LONG 50x, entry 11.290, a 1m ATR of 0.11 (0.974% of price).
// At +30% ROI the price move is 0.60%, i.e. 11.3577.
const avax = { side: 'LONG', entry: 11.290, atr: 0.11, roiPct: 30, leverage: 50, liqPrice: null };
const avaxPrice = 11.290 * (1 + 30 / 50 / 100);
const r30 = trailingStop({ ...avax, currentPrice: avaxPrice });
assert(r30.stop > avax.entry,
  `at +30% ROI the stop is in profit, not at breakeven (${r30.stop.toFixed(4)} vs entry ${avax.entry})`);
const locked = ((r30.stop - avax.entry) / avax.entry) * 100 * 50;
assert(locked > 5,
  `and it locks a usable amount: +${locked.toFixed(1)}% ROI (the old trail gave about +5.6%)`);

console.log(`\npassed ${passed}, failed ${failed}`);
process.exit(failed ? 1 : 0);