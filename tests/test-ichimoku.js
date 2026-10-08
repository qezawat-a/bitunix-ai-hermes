/**
 * Ichimoku: indicator + strategy, on synthetic candles, with no network.
 *
 * The cases are the ones that decide whether this strategy is useful or just
 * another vote generator:
 *
 *   1. A clean uptrend sitting ABOVE the cloud with tenkan above kijun votes
 *      LONG. This is the case the strategy exists for.
 *   2. The same uptrend that has fallen back INTO the cloud votes nothing —
 *      a cloud cross inside the balance zone is the classic whipsaw.
 *   3. A downtrend below the cloud with tenkan below kijun votes SHORT.
 *   4. Price above the cloud but tenkan BELOW kijun (trend up, turn down)
 *      votes nothing, because that disagreement is the early warning.
 *   5. A trendless series with ADX under 15 is skipped even when the cloud
 *      structure looks perfect, because a thick cloud in a flat market is a
 *      description, not a signal.
 *   6. Fewer than 90 candles returns a NONE with a reason instead of guessing.
 *   7. The indicator itself: tenkan/kijun are the midpoint of their windows,
 *      and the cloud is only defined 26 bars forward.
 */

import { ichimokuCloud } from '../src/strategies/index.js';
import * as I from '../src/strategies/indicators.js';

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };

/**
 * Deterministic candles from a price path. Candle i spans [p, p*w] where w is
 * the given intra-bar width, so highs/lows are real and ATR is non-zero.
 */
function candles(path, w = 0.004) {
  return path.map((p) => ({
    open: p,
    high: p * (1 + w),
    low: p * (1 - w),
    close: p,
    volume: 1000,
    time: 0,
  }));
}

/** A steady drift: n bars, each +step. */
function trend(n, start = 100, step = 1) {
  return candles(Array.from({ length: n }, (_, i) => start + i * step));
}

async function test() {
  console.log('=== Ichimoku (real indicators.js + index.js) ===\n');

  // ---------------------------------------------------------------- indicator
  console.log('The indicator computes the lines, not approximations');
  {
    const n = 120;
    const path = Array.from({ length: n }, (_, i) => 100 + i);
    const c = candles(path);
    const ik = I.ichimoku(c.map((x) => x.high), c.map((x) => x.low), c.map((x) => x.close));

    // tenkan on bar 20 = (max HIGH, min LOW) over bars 12..20 — the two series
    // are mixed on purpose, which is what the standard defines. In a straight
    // line the max high is bar 20 and the min low is bar 12.
    const hi = Math.max(...c.slice(12, 21).map((x) => x.high));
    const lo = Math.min(...c.slice(12, 21).map((x) => x.low));
    const expTenkan = (hi + lo) / 2;
    assert(I.last(ik.tenkan) != null, 'tenkan has a value at the end');
    assert(ik.tenkan[20] != null && Math.abs(ik.tenkan[20] - expTenkan) < 1e-9,
      `tenkan[20] = (max high + min low)/2 over 9 bars (${ik.tenkan[20]?.toFixed(4)} vs ${expTenkan.toFixed(4)})`);

    // kijun uses the SAME formula over 26 bars, so it is defined from bar 25.
    const hi26 = Math.max(...c.slice(0, 26).map((x) => x.high));
    const lo26 = Math.min(...c.slice(0, 26).map((x) => x.low));
    assert(ik.kijun[25] != null && Math.abs(ik.kijun[25] - (hi26 + lo26) / 2) < 1e-9,
      'kijun[25] = (max high + min low)/2 over 26 bars');
    assert(ik.kijun[24] == null, 'kijun is undefined before bar 25');
    assert(ik.senkouB[51] != null, 'senkou B is defined by bar 51');

    // the forward cloud exists only because of the shift
    assert(ik.cloudTop[26] == null, 'no cloud 26 bars ahead of bar 0');
    assert(ik.cloudTop[77] != null, 'cloud exists 26 bars ahead of bar 51');

    // cloud top > bottom in a rising market
    const top = I.last(ik.cloudTop), bot = I.last(ik.cloudBottom);
    assert(top != null && bot != null && top > bot,
      `cloud is well formed (top ${top?.toFixed(2)} > bottom ${bot?.toFixed(2)})`);
  }

  // ------------------------------------------------------------ clean uptrend
  console.log('\nA clean uptrend above the cloud votes LONG');
  {
    const r = ichimokuCloud(trend(140, 100, 1.5));
    assert(r.name === 'ichimoku_cloud', 'names itself ichimoku_cloud');
    assert(r.side === 'LONG', `votes LONG (got ${r.side})`);
    assert(r.confidence >= 60, `confidence is meaningful (${r.confidence})`);
    assert(r.notes.some((n) => /above cloud/.test(n)), 'says why');
  }

  // --------------------------------------------------------- short downtrend
  console.log('\nA clean downtrend below the cloud votes SHORT');
  {
    const r = ichimokuCloud(trend(140, 300, -1.5));
    assert(r.side === 'SHORT', `votes SHORT (got ${r.side})`);
    assert(r.confidence >= 60, `confidence is meaningful (${r.confidence})`);
  }

  // ------------------------------------------------------ inside the cloud
  console.log('\nA trend that has fallen back into the cloud votes NOTHING');
  {
    // rise hard, then flatten hard inside the old range: price ends up between
    // the (now far below) and (now far above) cloud edges.
    const up = Array.from({ length: 90 }, (_, i) => 100 + i * 2);
    const flat = Array.from({ length: 60 }, () => 275);
    const r = ichimokuCloud(candles([...up, ...flat]));
    assert(r.side === null, `no side taken (got ${r.side})`);
    assert(r.confidence === 0, 'confidence is 0 when it abstains');
    assert(/cloud|no edge|ADX|tenkan/.test(r.notes.join(' ')),
      `explains the abstention: ${r.notes[0]}`);
  }

  // ------------------------------------------------- trend up, turn down
  console.log('\nPrice above the cloud but tenkan BELOW kijun abstains');
  {
    // long rise (cloud ends far below price), then a short sharp drop that
    // pulls tenkan under kijun while leaving price above the old cloud edge.
    const up = Array.from({ length: 110 }, (_, i) => 100 + i * 2);
    const dip = Array.from({ length: 8 }, (_, i) => 320 - i * 4);
    const r = ichimokuCloud(candles([...up, ...dip]));
    assert(r.side === null, `abstains on internal disagreement (got ${r.side})`);
    assert(/tenkan|cloud/.test(r.notes.join(' ')), `says which way the disagreement runs: ${r.notes[0]}`);
  }

  // ------------------------------------------------------- trendless market
  console.log('\nA flat, trendless series abstains even with cloud structure');
  {
    const flat = candles(Array.from({ length: 140 }, (_, i) => 100 + Math.sin(i / 3) * 0.4));
    const r = ichimokuCloud(flat);
    assert(r.side === null, `no trade in a flat market (got ${r.side})`);
    assert(/ADX|cloud|tenkan/.test(r.notes.join(' ')), `explains why: ${r.notes[0]}`);
  }

  // ------------------------------------------------------------- not enough
  console.log('\nToo few candles abstains instead of guessing');
  {
    const r = ichimokuCloud(trend(40, 100, 1));
    assert(r.side === null, 'no side');
    assert(/not enough/i.test(r.notes[0]), `says it needs more data: ${r.notes[0]}`);
  }

  // ----------------------------------------------------- never throws
  console.log('\nDegenerate input never throws');
  {
    for (const [label, c] of [
      ['empty', []],
      ['one bar', candles([100])],
      ['zero width', candles(Array.from({ length: 140 }, () => 100), 0)],
    ]) {
      let r = null, threw = null;
      try { r = ichimokuCloud(c); } catch (e) { threw = e.message; }
      assert(!threw, `${label} does not throw (${threw || 'ok'})`);
      assert(r && r.name === 'ichimoku_cloud' && typeof r.confidence === 'number',
        `${label} still returns a well-formed verdict`);
    }
  }

  // ------------------------------------------------ registered in the book
  console.log('\nIt is registered as a real strategy, so consensus counts it');
  {
    const { STRATEGY_KEYS } = await import('../src/scanner/scanner.js');
    const { regimeWeights, STRATEGY_COUNT } = await import('../src/strategies/index.js');
    assert(STRATEGY_KEYS.includes('ichimoku_cloud'), 'ichimoku_cloud is in STRATEGY_KEYS');
    assert(STRATEGY_COUNT === STRATEGY_KEYS.length, `STRATEGY_COUNT is derived, not hardcoded (${STRATEGY_COUNT})`);
    const w = regimeWeights('TREND_UP');
    assert(typeof w.ichimoku_cloud === 'number', 'it has a regime weight');
    assert(w.ichimoku_cloud > regimeWeights('RANGE').ichimoku_cloud,
      'it is trusted in a trend more than in a range');
  }

  console.log(`\npassed ${passed}, failed ${failed}`);
  return failed === 0;
}

test().then((ok) => process.exit(ok ? 0 : 1));