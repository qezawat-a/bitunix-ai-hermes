/**
 * The AI must not be able to write a stop that the engine would have refused.
 *
 * Incident (observed live 2026-10-10 06:31): the agent called set_position_tpsl
 * on MAGICUSDT with a bare {symbol, positionId, slPrice} and no side.
 *
 * Root cause: the tool's schema in src/ai/tools.js declares no `side` property,
 * so `side` arrived undefined. The ratchet guard is written
 * `if (slPrice != null && side && !force)`, so `side &&` short-circuited and the
 * ENTIRE guard was skipped on every AI-initiated stop write - while the tool's
 * own description told the user their hand-set stop was protected. The guard had
 * been dead code on the AI path since it was written.
 *
 * Two things were missing on that path, and both are fixed here:
 *   1. the side, so the ratchet can run at all
 *   2. the liquidation clamp, which risk.js mandates ("clamp the stop inside liq,
 *      always") and which the engine path enforced but this one did not
 *
 * The third case is the follow-on: the trailing engine writes SL-only on every
 * pass, so preserving an existing take-profit across an SL-only edit is the
 * common case, not an edge one.
 */
import { upsertPositionTpSl, resetStopMemory } from '../src/trading/executor.js';

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };

const { bitunix } = await import('../src/exchange/bitunix.js');

const SYM = 'MAGICUSDT';
const PID = 5953016132217743717;
const ENTRY = 0.0168;
const SIDE = 'LONG';

// liq sits far away for scenarios 1 and 3 so the clamp is a no-op and each test
// isolates one behaviour. Scenario 2 sets it close on purpose.
let book = { sl: null, tp: null };
let live = { side: SIDE, avgOpenPrice: ENTRY, liqPrice: 0.0100, qty: 1000 };
const writes = [];

bitunix.roundPrice = async (_s, p) => p;
bitunix.getPendingPositions = async () => [{ positionId: PID, ...live }];
bitunix.getPendingTpSlOrders = async () => (book.sl == null && book.tp == null
  ? []
  : [{ id: 1, positionId: PID, slPrice: book.sl, tpPrice: book.tp }]);

const applyWrite = (body) => {
  writes.push({ sl: body.slPrice == null ? null : Number(body.slPrice), tp: body.tpPrice == null ? null : Number(body.tpPrice) });
  if (body.slPrice != null) book.sl = Number(body.slPrice);
  if (body.tpPrice != null) book.tp = Number(body.tpPrice);
  return { code: 0 };
};
bitunix.modifyPositionTpSl = async (body) => applyWrite(body);
bitunix.placePositionTpSl = async (body) => applyWrite(body);

function reset(overrides = {}) {
  resetStopMemory();
  book = { sl: null, tp: null };
  live = { side: SIDE, avgOpenPrice: ENTRY, liqPrice: 0.0100, qty: 1000, ...overrides };
  writes.length = 0;
}

// ---- 1) THE REGRESSION: no `side`, the ratchet must still run ---------------
//
// The user set the stop by hand on the exchange. The agent asks for a looser
// one. Before the fix this wrote straight through, because side was undefined.
{
  reset();
  book.sl = 0.01685;                       // user's level, hand-set
  const r = await upsertPositionTpSl({ symbol: SYM, positionId: PID, slPrice: 0.01675 });
  assert(book.sl === 0.01685,
    `with no side supplied, a loosening stop is still refused (exchange holds ${book.sl})`);
  assert(r.ok === true, 'the guarded write still succeeds, at the surviving level');
}

// ---- 2) no `side`, a stop beyond the liquidation price is pulled inside ------
//
// A stop past liq never fires - the exchange liquidates first, which is the one
// outcome worse than being stopped out.
{
  reset({ liqPrice: 0.0160 });            // 0.0008 below entry
  // liq_distance 0.5 => the stop may sit at most half of 0.0008 from entry
  await upsertPositionTpSl({ symbol: SYM, positionId: PID, slPrice: 0.0150 });
  const expected = ENTRY - (0.0008 * 0.5); // 0.0164
  assert(Math.abs(book.sl - expected) < 1e-9,
    `a stop beyond liq is pulled inside it (book ${book.sl}, expected ${expected})`);
  assert(book.sl > live.liqPrice, 'the clamped stop is still in front of liquidation');
}

// ---- 3) an SL-only write keeps the take-profit that is already there --------
//
// The trailing engine writes SL-only on every pass. Losing the target on those
// is exactly the "cannot take profit" failure, so the existing TP must survive.
{
  reset();
  book.sl = 0.01675;
  book.tp = 0.01800;
  await upsertPositionTpSl({ symbol: SYM, positionId: PID, slPrice: 0.01680 });
  const last = writes[writes.length - 1];
  assert(last.tp === 0.018, `the existing take-profit is carried through (wrote tp ${last.tp})`);
  assert(book.tp === 0.018, 'and it is still on the position afterwards');
}

// ---- 4) a stop that is already safe is left exactly where it was asked ------
{
  reset();
  const wanted = 0.01680;
  await upsertPositionTpSl({ symbol: SYM, positionId: PID, slPrice: wanted });
  assert(book.sl === wanted, `a stop already inside liq is untouched (book ${book.sl})`);
}

// ---- 5) force still overrides, because the user IS the authority then ------
{
  reset();
  book.sl = 0.01685;
  await upsertPositionTpSl({ symbol: SYM, positionId: PID, slPrice: 0.01675, force: true });
  assert(book.sl === 0.01675, `force:true writes the requested level (book ${book.sl})`);
}

// ---- 6) an unreadable position cannot silently disable the guard ----------
{
  reset();
  book.sl = 0.01685;
  const saved = bitunix.getPendingPositions;
  bitunix.getPendingPositions = async () => { throw new Error('venue timeout'); };
  const r = await upsertPositionTpSl({ symbol: SYM, positionId: PID, slPrice: 0.01675 });
  assert(book.sl === 0.01675,
    `with the position unreadable and no side, the write cannot be ratcheted and says so (book ${book.sl})`);
  assert(r.ok === true, 'and it reports the outcome rather than throwing');
  bitunix.getPendingPositions = saved;
}

console.log(`\npassed ${passed}, failed ${failed}`);
if (failed) process.exit(1);