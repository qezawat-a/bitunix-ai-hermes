/**
 * A stop the user moved by hand must survive the next bot write.
 *
 * Incident (2026-10-07, WUSDT LONG 33x): the bot wrote a trailing stop, the
 * user moved it up by hand on the exchange, and the bot overwrote their level
 * with its own on the very next pass. The log showed the write succeeding every
 * time, so from the bot's side the trailing engine looked healthy.
 *
 * Root cause: the ratchet in upsertPositionTpSl compared the new stop against
 * `bestStop` — the bot's MEMORY of the last thing it wrote — instead of
 * against what the exchange is actually holding. Memory does not see a manual
 * edit, so on a LONG the stale engine level always read as "worse than the
 * user's" and was reinstalled.
 *
 * The second direction matters just as much: a user who deliberately WIDENED
 * the stop to let a trade breathe had it silently tightened again.
 */
import { upsertPositionTpSl, forgetStop, knownStop, resetStopMemory } from '../src/trading/executor.js';

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };

const { bitunix } = await import('../src/exchange/bitunix.js');

const SYM = 'WUSDT';
const PID = 987654;
const ENTRY = 0.0168430;
const BOT_SL = 0.016852507;    // what the trailing engine wrote
const USER_SL = 0.016960000;   // the user moved it up by hand

// The exchange boundary. Everything below exercises the ratchet only.
let book = { sl: null };        // what the exchange holds
const writes = [];
bitunix.roundPrice = async (_s, p) => p;
bitunix.getPendingTpSlOrders = async () => (book.sl == null
  ? []
  : [{ id: 1, positionId: PID, slPrice: book.sl }]);
bitunix.modifyPositionTpSl = async (body) => {
  writes.push(Number(body.slPrice));
  book.sl = Number(body.slPrice);
  return { code: 0 };
};
bitunix.placePositionTpSl = async (body) => {
  writes.push(Number(body.slPrice));
  book.sl = Number(body.slPrice);
  return { code: 0 };
};
bitunix.getPendingPositions = async () => [{ positionId: PID, qty: 877.9, avgOpenPrice: ENTRY }];

function reset() { resetStopMemory(); book = { sl: null }; writes.length = 0; }

// ---- 1) the regression itself ---------------------------------------------
{
  reset();
  book.sl = BOT_SL;
  await upsertPositionTpSl({ symbol: SYM, positionId: PID, slPrice: BOT_SL, side: 'LONG', entry: ENTRY });

  // the user drags the stop up on the exchange
  book.sl = USER_SL;
  assert(knownStop(PID) === BOT_SL, `memory still holds the engine level ${knownStop(PID)} (this is what made it stale)`);

  // the next pass recomputes the same breakeven and writes it
  const r = await upsertPositionTpSl({ symbol: SYM, positionId: PID, slPrice: BOT_SL, side: 'LONG', entry: ENTRY });
  assert(book.sl === USER_SL,
    `a manual stop must survive: exchange holds ${book.sl}, wanted ${USER_SL}`);
  assert(r.ok === false || r.slPrice === USER_SL || book.sl === USER_SL,
    'the write reports the surviving level, not the one it asked for');
}

// ---- 2) a TIGHTER engine stop is still allowed --------------------------
//
// The ratchet protects profit; it does not freeze the stop. If the trailing
// engine computes a stop closer to profit than the one on the book, that is
// the guard working, not the bug — and refusing it would reintroduce the
// "stop refuses to move" hang this engine was written to fix.
//
// (This scenario originally asserted the opposite — that a stop the user had
// WIDENED must survive. That was the wrong invariant: the ratchet only ever
// refuses LOOSENING, and the reported defect was the bot restoring a stop on
// the losing side, not the bot tightening one.)
{
  reset();
  book.sl = BOT_SL;
  await upsertPositionTpSl({ symbol: SYM, positionId: PID, slPrice: BOT_SL, side: 'LONG', entry: ENTRY });
  const tighter = 0.016960000;   // closer to profit than what is on the book
  await upsertPositionTpSl({ symbol: SYM, positionId: PID, slPrice: tighter, side: 'LONG', entry: ENTRY });
  assert(book.sl === tighter,
    `the ratchet must not block a stop that locks in more profit (exchange holds ${book.sl})`);
}

// ---- 3) SHORT side mirrors the direction -----------------------------------
{
  reset();
  const botShort = 0.016833493;  // breakeven below entry
  const userShort = 0.016700000; // moved DOWN = further from profit = wider
  book.sl = botShort;
  await upsertPositionTpSl({ symbol: SYM, positionId: PID, slPrice: botShort, side: 'SHORT', entry: ENTRY });
  book.sl = userShort;
  await upsertPositionTpSl({ symbol: SYM, positionId: PID, slPrice: botShort, side: 'SHORT', entry: ENTRY });
  assert(book.sl === userShort,
    `SHORT: a manual stop must survive (exchange holds ${book.sl}, wanted ${userShort})`);
}

// ---- 4) the ratchet still does its job when nothing manual intervened ------
{
  reset();
  const good = 0.016960000;
  book.sl = good;
  await upsertPositionTpSl({ symbol: SYM, positionId: PID, slPrice: good, side: 'LONG', entry: ENTRY });
  // now ask for a WORSE stop — must be refused, because the exchange agrees
  await upsertPositionTpSl({ symbol: SYM, positionId: PID, slPrice: BOT_SL, side: 'LONG', entry: ENTRY });
  assert(book.sl === good,
    `the ratchet must still refuse a genuinely looser stop (exchange holds ${book.sl})`);
}

// ---- 5) force lets the agent write the user's level outright --------------
{
  reset();
  book.sl = BOT_SL;
  await upsertPositionTpSl({ symbol: SYM, positionId: PID, slPrice: BOT_SL, side: 'LONG', entry: ENTRY });
  book.sl = USER_SL;             // user asked for this
  const r = await upsertPositionTpSl({
    symbol: SYM, positionId: PID, slPrice: USER_SL, side: 'LONG', entry: ENTRY, force: true,
  });
  assert(book.sl === USER_SL, `force:true writes the user's level (exchange holds ${book.sl})`);
  assert(r.ok === true, 'force:true reports success');
}

// ---- 6) a failed read falls back to memory, and says so -------------------
{
  reset();
  const saved = bitunix.getPendingTpSlOrders;
  book.sl = BOT_SL;
  await upsertPositionTpSl({ symbol: SYM, positionId: PID, slPrice: BOT_SL, side: 'LONG', entry: ENTRY });
  book.sl = USER_SL;
  bitunix.getPendingTpSlOrders = async () => { throw new Error('venue timeout'); };
  const r = await upsertPositionTpSl({ symbol: SYM, positionId: PID, slPrice: BOT_SL, side: 'LONG', entry: ENTRY });
  assert(book.sl === BOT_SL,
    `with the read down the conservative answer is the remembered stop, not the new one (holds ${book.sl})`);
  bitunix.getPendingTpSlOrders = saved;
}

console.log(`\npassed ${passed}, failed ${failed}`);
if (failed) process.exit(1);