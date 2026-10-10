import bitunix from '../exchange/bitunix.js';
import { createLogger } from '../logger.js';
import { orderGotFill, orderRejected } from '../exchange/errors.js';
import { computeDynamicTpSl, computeMargin } from './risk.js';
import { applyPartialTpSl, entryMethod } from './tpsl.js';
import { MAX_LEVERAGE } from '../settings-schema.js';
import {
  settings, openTrade, attachPositionId, logEvent, setCooldown, remember,
} from '../db/index.js';

const log = createLogger('executor');

/**
 * LIVE order execution on Bitunix futures.
 * There is no dry-run path in this module — every call hits the real exchange.
 */

const leverageApplied = new Map();   // symbol -> {leverage, marginMode}
let positionModeApplied = null;

/** Make sure position mode / margin mode / leverage match the settings. */
export async function ensureSymbolConfig(symbol, overrideLev = null) {
  const s = settings();
  const wantLev = Number(overrideLev ?? s.leverage);
  const wantMargin = String(s.margin_mode).toUpperCase() === 'ISOLATED'
    ? 'ISOLATION' : String(s.margin_mode).toUpperCase();   // docs enum: ISOLATION | CROSS
  const wantPosMode = String(s.position_mode).toUpperCase();

  if (positionModeApplied !== wantPosMode) {
    try {
      await bitunix.changePositionMode(wantPosMode);
      positionModeApplied = wantPosMode;
      log.info(`position mode -> ${wantPosMode}`);
    } catch (e) {
      // 30005 / 20009: cannot change with open positions — read actual mode instead
      try {
        const acc = await bitunix.getAccount();
        const actual = Array.isArray(acc) ? acc[0]?.positionMode : acc?.positionMode;
        positionModeApplied = actual || wantPosMode;
        log.warn(`position mode stays ${positionModeApplied} (${e.message})`);
      } catch {}
    }
  }

  const cached = leverageApplied.get(symbol);
  if (cached && cached.leverage === wantLev && cached.marginMode === wantMargin) return;

  let current = null;
  try { current = await bitunix.getLeverageAndMarginMode(symbol); } catch {}

  if (!current || String(current.marginMode).toUpperCase() !== wantMargin) {
    try { await bitunix.changeMarginMode({ symbol, marginMode: wantMargin }); }
    catch (e) { log.warn(`${symbol} margin mode: ${e.message}`); }
  }
  if (!current || Number(current.leverage) !== wantLev) {
    // respect the pair's tier limits
    const info = await bitunix.pairInfo(symbol);
    const lev = Math.max(Number(info?.minLeverage ?? 1),
      Math.min(Number(info?.maxLeverage ?? MAX_LEVERAGE), wantLev));
    try { await bitunix.changeLeverage({ symbol, leverage: lev }); }
    catch (e) { log.warn(`${symbol} leverage: ${e.message}`); }
  }
  leverageApplied.set(symbol, { leverage: wantLev, marginMode: wantMargin });
}

export function resetSymbolConfigCache() {
  leverageApplied.clear();
  positionModeApplied = null;
}

/** Available USDT (available + cross unrealised PnL, per docs note). */
export async function availableBalance() {
  const acc = await bitunix.getAccount();
  const a = Array.isArray(acc) ? acc[0] : acc;
  if (!a) return { available: 0, raw: null };
  const available = Number(a.available || 0) + Number(a.crossUnrealizedPNL || 0);
  return {
    available,
    margin: Number(a.margin || 0),
    frozen: Number(a.frozen || 0),
    bonus: Number(a.bonus || 0),
    positionMode: a.positionMode,
    unrealized: Number(a.crossUnrealizedPNL || 0) + Number(a.isolationUnrealizedPNL || 0),
    raw: a,
  };
}

/**
 * Open a position from a qualified signal.
 * HEDGE mode:  side BUY  + tradeSide OPEN -> long
 *              side SELL + tradeSide OPEN -> short
 * TP/SL are attached dynamically (ATR + signal strength), never static.
 */
export async function openFromSignal(signal, { aiVerdict = null, marginOverride = null } = {}) {
  const s = settings();
  const symbol = signal.symbol;

  await ensureSymbolConfig(symbol);

  const bal = await availableBalance();
  const positions = await bitunix.getPendingPositions();
  const openCount = (positions || []).length;
  if (openCount >= Number(s.max_open_positions)) {
    return { ok: false, reason: `max_open_positions reached (${openCount})` };
  }
  if ((positions || []).some((p) => p.symbol === symbol
    && p.side === (signal.side === 'LONG' ? 'LONG' : 'SHORT'))) {
    return { ok: false, reason: `already in ${signal.side} on ${symbol}` };
  }

  // ---- size the position ------------------------------------------------
  //
  // `computeMargin` is the only sizing rule in this codebase, and it commits
  // `margin_pct` of the available balance, capped by the free slots.
  //
  // The AI judge can also propose a size (`margin_usdt` in its verdict), which
  // used to REPLACE that computation outright with an unvalidated number. A
  // model asked for a number has no reason to respect margin_pct, and on
  // 2026-10-09 it proposed ~1.16 USDT against a 1.40 USDT account - 83% of the
  // whole balance on one 50x position, from a setting that says 5%. The
  // position history shows the fee that resulted: 0.058 USDT per round trip,
  // i.e. ~58 USDT of notional, which is the tell.
  //
  // The proposal is now a REQUEST, not an instruction: it is clamped to the
  // engine's own figure. Sizing is a risk decision, and the code that owns the
  // risk rules is the only thing allowed to make it.
  const engineMargin = computeMargin({
    available: bal.available,
    marginPct: s.margin_pct,
    openPositions: openCount,
    maxPositions: Number(s.max_open_positions),
  });

  let marginUsdt = engineMargin;
  let marginRequested = null;
  let marginCapped = false;
  if (marginOverride != null) {
    const asked = Number(marginOverride);
    if (Number.isFinite(asked) && asked > 0) {
      marginRequested = asked;
      if (asked > engineMargin) {
        marginCapped = true;
        log.warn(`${symbol}: AI asked for ${asked.toFixed(4)} USDT margin, `
          + `capping to ${engineMargin.toFixed(4)} (margin_pct ${s.margin_pct}% of `
          + `${bal.available.toFixed(4)} available)`);
      }
    } else {
      log.warn(`${symbol}: AI proposed an unusable margin (${marginOverride}); using the engine size`);
    }
  }

  if (!(marginUsdt > 0)) return { ok: false, reason: 'no available margin' };

  // The account itself is a hard ceiling: no single position may risk more
  // than this fraction of what is actually there, whatever asked for it.
  const maxMarginPct = Number(s.max_margin_pct ?? 25);
  if (Number.isFinite(maxMarginPct) && maxMarginPct > 0) {
    const hardCap = (bal.available * maxMarginPct) / 100;
    if (marginUsdt > hardCap) {
      marginCapped = true;
      log.warn(`${symbol}: margin ${marginUsdt.toFixed(4)} exceeds ${maxMarginPct}% of `
        + `available (${hardCap.toFixed(4)}) — capping`);
      marginUsdt = hardCap;
    }
  }
  if (!(marginUsdt > 0)) return { ok: false, reason: `no margin left under the ${maxMarginPct}% per-trade cap` };

  // live price from tickers (mark price preferred)
  const tick = await bitunix.getTickers(symbol);
  const t = Array.isArray(tick) ? tick[0] : tick;
  const price = Number(t?.markPrice || t?.lastPrice || signal.price);
  if (!price) return { ok: false, reason: 'no price' };

  const info = await bitunix.pairInfo(symbol);
  let leverage = Math.max(Number(info?.minLeverage ?? 1),
    Math.min(Number(info?.maxLeverage ?? MAX_LEVERAGE), Number(s.leverage)));
  // What the signal/settings asked for, captured before any exchange limit or
  // guard touches it, so a filled position always reports the difference.
  const leverageRequested = Number(s.leverage) || 1;

  // ---- margin mode: it decides which liq formula applies -----------------
  //
  // ISOLATION moves the liquidation price with leverage; CROSS moves it with
  // the account balance standing behind the position, and leverage drops out.
  // Reading this from settings alone was wrong — the exchange's own mode is
  // what decides the physics, and a settings/exchange mismatch would size the
  // whole bracket against the wrong formula without any signal that it had.
  let marginMode = String(s.margin_mode || 'CROSS').toUpperCase();
  try {
    const lm = await bitunix.getLeverageAndMarginMode(symbol);
    if (lm?.marginMode) marginMode = String(lm.marginMode).toUpperCase();
  } catch (e) {
    log.warn(`${symbol}: margin mode unreadable (${e.message}); assuming ${marginMode}`);
  }

  // Every leverage change from here down is recorded, never applied silently.
  const adjustments = [];

  // ---- the exchange's own leverage limit (a limit, not a downgrade) -------
  //
  // Both the maintenance margin rate AND the maximum leverage depend on the
  // position's notional value, so a big position on a thin pair silently loses
  // access to high leverage. Ask the exchange rather than guessing:
  // get_position_tiers is authoritative. This is an exchange limit being
  // respected, not the bot deciding the trade is too hot — it is surfaced as
  // an adjustment rather than booked as the requested leverage.
  {
    const maxLev = Number(info?.maxLeverage);

    let mmr = null;
    try {
      const tier = await bitunix.tierFor({ symbol, notional: marginUsdt * leverage });
      mmr = tier.mmr;
      if (tier.leverage < leverage) {
        log.warn(`${symbol}: tier L${tier.level} (notional up to ${tier.endValue}) caps leverage at ${tier.leverage}x, requested ${leverage}x`);
        adjustments.push({
          kind: 'tier_cap', from: leverage, to: tier.leverage,
          reason: `risk tier L${tier.level} maximum`, tier,
        });
        leverage = tier.leverage;
        await ensureSymbolConfig(symbol, leverage);
      }
    } catch (e) {
      log.warn(`${symbol}: position tiers unavailable (${e.message}); falling back to the maxLeverage heuristic`);
    }

    // The size this trade is about to take. CROSS liquidation depends on how
    // much of the account stands behind one unit, so the intended qty is part
    // of the liquidation estimate, not an afterthought.
    const intendedQty = price > 0 ? (Number(marginUsdt) * leverage) / price : 0;

    const probe = computeDynamicTpSl({
      ...signal, price, leverage: 1, maxLeverage: maxLev, mmr,
      marginMode, accountBalance: bal.available, qty: intendedQty,
    });
    const atLev = computeDynamicTpSl({
      ...signal, price, leverage, maxLeverage: maxLev, mmr,
      marginMode, accountBalance: bal.available, qty: intendedQty,
    });
    if (atLev.liqUnsafe) {
      return {
        ok: false,
        reason: `refusing ${symbol}: at ${leverage}x (${marginMode}) liquidation sits at the entry price`,
      };
    }
    const safeLev = probe.maxSafeLeverage;
    if (safeLev < leverage) {
      // REFUSE, do not cut. A signal sized for 50x that gets booked at 7x is a
      // different trade with a different risk profile, reported to the user as
      // the one they asked for. In CROSS this branch is unreachable whenever
      // the account backing is known — the solver returns the exchange cap,
      // because leverage is not what sets a CROSS liquidation price.
      await logEvent('position_refused_leverage', {
        symbol, side: signal.side, requested: leverage, maxSafe: safeLev,
        stopPct: probe.slPct, marginMode,
        reason: 'stop would sit beyond liquidation at the requested leverage',
      }, symbol);
      return {
        ok: false,
        reason: `refusing ${symbol}: at ${leverage}x (${marginMode}) the ${probe.slPct}% ATR stop sits `
          + `beyond liquidation — safe limit is ${safeLev}x. Lower leverage or widen the stop timeframe.`,
      };
    }
  }

  // ---- refuse a position too small to survive its own costs -------------
  //
  // Measured 2026-10-07: balance 1.44 USDT at 50x committed ~0.35-0.52 USDT
  // of margin per trade. A market stop slipped 0.73% of price (TRBUSDT) and
  // that alone was ~70% of the position's margin; the AVAXUSDT close booked
  // -10.86% ROI on a 0.0974% price move. Every trade was arithmetically
  // correct and structurally unprofitable — the fixed costs of entering and
  // exiting, multiplied by the leverage, were larger than the account.
  //
  // Leverage multiplies the cost ratio but cannot change it. What decides
  // whether a position is viable is how many round trips fit in the move it
  // is targeting, so that is what is checked here: the ATR stop has to be
  // worth at least `min_cost_multiple` round trips, or the trade cannot pay
  // for itself no matter where it closes.
  //
  // That last sentence is also why the only honest outcome here is a refusal.
  // Both the stop distance and the round-trip fee are proportional to
  // notional, so their ratio is invariant under leverage — the old code
  // computed a `cutTo` that solves for a leverage leaving the ratio exactly
  // where it already was, i.e. a downgrade that fixed nothing.
  const atrAbs = Math.abs(Number(signal?.atr) || 0);

  // ---- the cost floor the ratio check above cannot see -----------------
  //
  // Every other guard in this file is expressed as a fraction of NOTIONAL:
  // the stop as a % of price, the round trip as a % of price. Their ratio is
  // therefore blind to leverage AND to the size of the account, which is
  // exactly the two things that decide whether a trade can pay for itself.
  //
  // On this account the fee is the binding constraint: at 1.40 USDT the
  // observed round trip was 0.058 USDT on ~58 USDT of notional, so ~4% of the
  // balance was burned entering and exiting before any profit existed.
  //
  // The first version of this check REFUSED any trade whose fee exceeded 1% of
  // the balance. That was wrong, and it was mine: 1% of 1.40 USDT is 0.014,
  // while the exchange's minimum round trip on these pairs is several times
  // that, so the guard refused EVERY trade. It turned a risk control into a
  // kill switch that looked like caution - the worst possible failure, because
  // a bot that stops trading is indistinguishable from one that found no
  // opportunities.
  //
  // The fix is to treat the fee as a SIZING budget rather than a gate. If the
  // intended position costs too much to trade, the position gets SMALLER, and
  // the trade still happens. That is what makes a small account work: the same
  // edge, taken at a size where the fee cannot eat it.
  //
  //   fee        = notional * roundTripPct
  //   notional   = margin * leverage
  //   => max margin the fee budget allows = (balance * budget) / roundTripPct / leverage
  //
  // Only one thing still refuses: a position so small the exchange will not
  // accept it (below minTradeVolume), which is a genuine "this account cannot
  // trade this pair", not a policy choice.
  const roundTripPct = Number(s.round_trip_fee_pct ?? 0.001) + Number(s.stop_slippage_pct ?? 0.0005);
  const balanceForCosts = Number(bal.available);
  // Share of the BALANCE one round trip may cost. Small by design: it is the
  // margin of safety that keeps profit larger than cost. The fallback matches
  // the seed in config.js on purpose — the two used to disagree (1 vs 0.5), and
  // since the seed is always present in settings the 0.5 never applied, so
  // reading it here only misstated what the live budget actually was.
  const feeBudgetPct = Number(s.max_fee_pct_of_balance ?? 1);
  if (Number.isFinite(feeBudgetPct) && feeBudgetPct > 0
      && balanceForCosts > 0 && roundTripPct > 0 && leverage > 0) {
    const maxNotional = (balanceForCosts * (feeBudgetPct / 100)) / roundTripPct;
    const maxMarginAtLev = maxNotional / leverage;
    if (marginUsdt > maxMarginAtLev) {
      log.warn(`${symbol}: ${marginUsdt.toFixed(4)} USDT margin would cost `
        + `${(marginUsdt * leverage * roundTripPct).toFixed(4)} USDT in fees `
        + `(${(marginUsdt * leverage * roundTripPct / balanceForCosts * 100).toFixed(2)}% `
        + `of balance, over the ${feeBudgetPct}% budget) — sizing down to `
        + `${maxMarginAtLev.toFixed(4)} USDT margin`);
      marginCapped = true;
      marginUsdt = maxMarginAtLev;
    }
  }
  if (!(marginUsdt > 0)) {
    return {
      ok: false,
      reason: `no viable size on ${symbol}: the ${feeBudgetPct}% fee budget of `
        + `${balanceForCosts.toFixed(2)} USDT does not cover a minimum position at ${leverage}x`,
    };
  }

  // The ATR stop is still MEASURED against the round trip, but it no longer
  // refuses. Removed at the user's instruction: as a scalper on 1m/3m the ATR
  // stop is small by construction, so a ratio floor refused nearly everything
  // and the bot stopped trading. A guard that blocks the strategy is not a
  // guard, it is a kill switch with a technical name.
  //
  // What replaces it is visibility rather than a veto: the multiple is recorded
  // on the position and surfaced in the Telegram history, so a trade whose
  // stop could not have covered its own costs is visible as exactly that
  // instead of being silently taken or silently blocked.
  const stopPct = atrAbs > 0 && price > 0 ? atrAbs / price : null;
  const roundTrip = Number(s.round_trip_fee_pct ?? 0.001) + Number(s.stop_slippage_pct ?? 0.0005);
  const costMultiple = stopPct != null ? stopPct / (roundTrip || 1) : null;
  if (costMultiple != null && costMultiple < 1) {
    // Below 1.0 the stop is narrower than the cost of trading it: a winning
    // move of that size still books a loss. Worth saying out loud, never worth
    // blocking.
    log.warn(`${symbol} ${signal.side}: ATR stop is ${costMultiple.toFixed(2)}x the `
      + `round trip - a full stop-out costs more than the stop is wide. `
      + `Trading it anyway per configuration; consider a wider timeframe.`);
  }

  // The sizing engine always produces a USDT figure to commit (marginUsdt).
  // order_unit decides how that figure is interpreted on the way to base qty:
  //   COST     -> it is the margin; notional = margin * leverage   (default)
  //   NOMINAL  -> it is the position value; margin = value / leverage
  //   QTY      -> the agent supplied base coin directly
  // See bitunix.sizeOrder() for the doc-derived formulas.
  const unit = String(s.order_unit || 'COST').toUpperCase();
  const amount = unit === 'QTY' && signal.qty != null ? Number(signal.qty) : marginUsdt;
  let sized;
  try {
    sized = await bitunix.sizeOrder({ symbol, unit, amount, leverage, price });
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  const qty = sized.qty;
  if (Number(qty) <= 0) return { ok: false, reason: 'computed qty is 0 (increase margin_pct)' };
  log.info(`${symbol} size: unit ${unit} · qty ${qty} · cost ${sized.cost.toFixed(2)} USDT · notional ${sized.nominal.toFixed(2)} USDT @ ${leverage}x`);

  const minQty = Number(info?.minTradeVolume ?? 0);
  if (minQty && Number(qty) < minQty) {
    return { ok: false, reason: `qty ${qty} below minTradeVolume ${minQty} for ${symbol}` };
  }

  // The pair's own ceilings, from GET /api/v1/futures/market/trading_pairs:
  //   minTradeVolume         minimum opening amount (base currency)
  //   maxMarketOrderVolume   maximum market order base amount
  //   maxLimitOrderVolume    maximum limit order base amount
  //   symbolStatus           OPEN | CANCEL_ONLY | STOP
  //   isApiSupported         false = API trading disabled
  // Only the min was ever checked, so an oversized order was discovered by
  // being rejected at the exchange rather than before it was sent. A position
  // that is simply too big for the pair should be refused and explained, not
  // attempted and logged as an exchange error.
  const maxQty = Number(info?.maxMarketOrderVolume ?? 0);
  if (maxQty && Number(qty) > maxQty) {
    return {
      ok: false,
      reason: `qty ${qty} above maxMarketOrderVolume ${maxQty} for ${symbol} `
        + `— lower margin_pct or leverage`,
    };
  }
  if (info && String(info.symbolStatus || 'OPEN').toUpperCase() === 'STOP') {
    return { ok: false, reason: `${symbol} is STOP — the pair cannot open or close positions` };
  }
  if (info && info.isApiSupported === false) {
    return { ok: false, reason: `${symbol} has API trading disabled (isApiSupported=false)` };
  }

  let realMmr = null;
  try { realMmr = (await bitunix.tierFor({ symbol, notional: marginUsdt * leverage })).mmr; } catch {}
  const risk = computeDynamicTpSl({
    ...signal, price, leverage, maxLeverage: Number(info?.maxLeverage), mmr: realMmr,
  });
  if (risk.liqAdjusted) log.warn(`${symbol}: ${risk.liqNote}`);
  // A null tpPrice is deliberate: in ADAPTIVE mode a strong, expanding trend
  // gets NO fixed target so the trailing stop can decide when the move ends.
  // The stop is never optional.
  const tpPrice = risk.tpPrice == null ? null : await bitunix.roundPrice(symbol, risk.tpPrice);
  const slPrice = await bitunix.roundPrice(symbol, risk.slPrice);
  if (tpPrice == null) log.info(`${symbol}: no fixed TP — ${risk.tpBasis}`);

  const isLong = signal.side === 'LONG';
  const clientId = `aria${Date.now().toString(36)}`;

  const order = {
    symbol,
    qty,
    side: isLong ? 'BUY' : 'SELL',
    orderType: 'MARKET',
    clientId,
    slPrice,
    slStopType: 'MARK_PRICE',
    slOrderType: 'MARKET',
  };
  if (tpPrice != null) {
    order.tpPrice = tpPrice;
    order.tpStopType = 'MARK_PRICE';
    order.tpOrderType = 'MARKET';
  }
  if (String(s.position_mode).toUpperCase() === 'HEDGE') order.tradeSide = 'OPEN';

  let res;
  try {
    res = await bitunix.placeOrder(order);
  } catch (e) {
    await logEvent('order_failed', { symbol, error: e.message, order }, symbol);
    await remember({
      kind: 'error', subject: symbol, importance: 6,
      content: `Order failed on ${symbol} ${signal.side}: ${e.message}`,
    });
    return { ok: false, reason: e.message };
  }

  // Confirm the order actually filled before booking a trade against it.
  // A MARKET order can still come back CANCELED (price protection, no
  // liquidity, margin recheck), and PART_FILLED_CANCELED means a real but
  // SMALLER position than we sized for — recording the requested qty in that
  // case would make every later PnL and stop calculation wrong.
  let filledQty = Number(qty);
  try {
    const detail = await bitunix.getOrderDetail({ orderId: res?.orderId, clientId });
    const d = Array.isArray(detail) ? detail[0] : detail;
    if (d?.status) {
      if (orderRejected(d.status)) {
        await logEvent('order_rejected', { symbol, status: d.status, orderId: res?.orderId }, symbol);
        return { ok: false, reason: `order ${d.status} — nothing filled` };
      }
      if (orderGotFill(d.status)) {
        const got = Number(d.tradeQty ?? d.dealQty ?? d.filledQty ?? 0);
        if (got > 0 && Math.abs(got - filledQty) / filledQty > 0.001) {
          log.warn(`${symbol}: ${d.status} — filled ${got} of ${filledQty}, booking the real size`);
          filledQty = got;
        }
      }
    }
  } catch (e) {
    log.warn(`${symbol}: could not confirm order status (${e.message}); assuming full fill`);
  }

  const tradeId = await openTrade({
    clientId, symbol, side: signal.side, entryPrice: price, qty: filledQty,
    leverage, marginMode: s.margin_mode, marginUsdt: sized.cost, tpPrice: tpPrice == null ? null : Number(tpPrice),
    slPrice: Number(slPrice), atr: signal.atr, confidence: signal.confidence,
    agreement: signal.agreement, strategies: signal.strategies?.map((x) => x.name) || [],
    reasoning: aiVerdict?.reasoning || risk.explain,
  });

  // resolve the exchange positionId (it appears right after the fill)
  let positionId = null;
  for (let i = 0; i < 6 && !positionId; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const ps = await bitunix.getPendingPositions({ symbol });
      const match = (ps || []).find((p) => p.side === (isLong ? 'LONG' : 'SHORT'));
      if (match) positionId = match.positionId;
    } catch {}
  }
  if (positionId) await attachPositionId(tradeId, positionId);

  // ---- method 2: partial TP ladder ---------------------------------------
  // The entry order already carries a whole-position TP/SL. When the settings
  // ask for PARTIAL we additionally lay a scale-out ladder over it, so profit
  // is banked in stages while a runner stays on for the rest of the move. The
  // stop is deliberately NOT laddered: scaling out of a loser is just being
  // wrong more slowly.
  let ladder = null;
  if (positionId && entryMethod() === 'PARTIAL') {
    try {
      ladder = await applyPartialTpSl({
        symbol, positionId, side: signal.side, entry: price, qty: filledQty,
        slDist: risk.slDist, ladder: s.partial_tp_ladder,
        liqPrice: risk.liqPrice,
      });
      if (ladder.ok) {
        log.info(`${symbol} partial ladder: ${ladder.placed.map((x) => `${x.share}%@${x.r}R`).join(' · ')}`
          + (ladder.runnerQty ? ` · runner ${ladder.runnerQty}` : ''));
      }
      for (const sk of ladder.skipped || []) log.warn(`${symbol} ladder ${sk.share}%@${sk.r}R skipped: ${sk.reason}`);
      await logEvent('partial_ladder', { symbol, placed: ladder.placed, skipped: ladder.skipped }, symbol);
    } catch (e) {
      log.warn(`${symbol} partial ladder failed: ${e.message}`);
    }
  }

  await setCooldown(symbol, Number(s.cooldown_min), 'opened position');
  await logEvent('position_opened', {
    symbol, side: signal.side, qty, price, marginUsdt, leverage,
    leverageRequested, leverageApplied: leverage,
    // How the size was actually decided, so a capped trade is distinguishable
    // in the record from one that was sized this way to begin with.
    marginRequested, marginApplied: Number(marginUsdt), marginCapped,
    // ATR stop as a multiple of the round-trip cost. Below 1.0 the stop is
    // narrower than trading it, and that is worth seeing in the record now
    // that it no longer blocks the trade.
    costMultiple, roundTrip, feeBudgetPct,
    marginMode, adjustments,
    tpPrice, slPrice, rr: risk.rr, confidence: signal.confidence,
    agreement: signal.agreement, orderId: res?.orderId, positionId,
  }, symbol);

  return {
    ok: true, tradeId, positionId, orderId: res?.orderId, clientId,
    symbol, side: signal.side, qty: filledQty, price, leverage,
    leverageRequested, leverageApplied: leverage,
    marginMode, adjustments,
    marginUsdt: sized.cost, nominalUsdt: sized.nominal, orderUnit: unit,
    tpPrice: tpPrice == null ? null : Number(tpPrice), slPrice: Number(slPrice), risk, ladder,
  };
}

/** Close a position at market (flash close). */
export async function closePosition(positionId, reason = 'manual') {
  try {
    const res = await bitunix.flashClosePosition(positionId);
    await logEvent('position_closed', { positionId, reason });
    return { ok: true, res };
  } catch (e) {
    await logEvent('close_failed', { positionId, reason, error: e.message });
    return { ok: false, reason: e.message };
  }
}

/** Close everything (optionally one symbol). */
export async function closeAll(symbol = null) {
  try {
    const res = await bitunix.closeAllPositions(symbol ? { symbol } : {});
    await logEvent('close_all', { symbol });
    return { ok: true, res };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** Update the position-level TP/SL (place if missing, modify if present). */
/**
 * The furthest-advanced stop we have successfully written for each position.
 *
 * A stop is a ratchet: it may tighten toward profit, never loosen back toward
 * the entry. Every path that writes one (entry, the naked-position rescue, the
 * trailing engine) goes through here, so the rule is enforced in one place
 * rather than trusted to each caller — the QNTUSDT short lost its locked-in
 * profit precisely because the rescue path did not know the trailing engine
 * had already moved the stop.
 */
const bestStop = new Map();     // positionId -> { side, stop }

export function forgetStop(positionId) { bestStop.delete(String(positionId)); }
export function knownStop(positionId) { return bestStop.get(String(positionId))?.stop ?? null; }

/**
 * Forget every remembered stop.
 *
 * forgetStop(positionId) is the runtime path — it runs when a position is booked
 * closed, which is the only time this map should lose an entry on its own.
 * There was no way to clear it wholesale, so the ratchet leaked across test
 * scenarios: one scenario's locked-in stop silently vetoed the next scenario's
 * write, and the test then "passed" for the wrong reason.
 *
 * Exported for tests only. Nothing in the running system should call it.
 */
export function resetStopMemory() { bestStop.clear(); }

/**
 * Read the position-level TP/SL row back from the exchange.
 *
 * `get_pending_tpsl_orders` can return more than one row for a symbol: the
 * whole-position order plus any partial ladder rungs (those carry tpQty/slQty).
 * Bluntly taking row 0 means "the current stop" can be read off a partial rung,
 * so every read here picks the whole-position row for the requested position
 * and only falls back when there is nothing better.
 */
export async function readPositionTpSl({ symbol, positionId, side = null }) {
  let rows;
  try {
    // NO `side` filter: positionId is already exact, and the bot's side is
    // LONG/SHORT while the API speaks BUY/SELL. Passing it made the read-back
    // come up empty -> "exchange still shows no stop" and a bogus place_order.
    rows = await bitunix.getPendingTpSlOrders({ symbol, positionId });
  } catch (e) {
    log.warn(`${symbol}: cannot read back TP/SL (${e.message})`);
    return null;
  }

  const list = Array.isArray(rows) ? rows : (rows?.orderList || []);
  const forPos = list.filter(
    (r) => r && (positionId == null || String(r.positionId) === String(positionId)),
  );
  const pool = forPos.length ? forPos : list;
  const withStop = pool.filter((r) => r && r.slPrice != null);
  // With several rows (order-attached SL + position SL + rungs) the stop that
  // actually protects is the MOST protective one, not whichever came first.
  const pick = (a, b) => (side === 'LONG'
    ? (Number(a.slPrice) >= Number(b.slPrice) ? a : b)
    : (Number(a.slPrice) <= Number(b.slPrice) ? a : b));
  const row = side && withStop.length
    ? withStop.reduce(pick)
    : (withStop.find((r) => r.tpQty == null && r.slQty == null) || withStop[0] || null);
  if (!row) return null;

  // ---- verify what KIND of stop this is ---------------------------------
  //
  // Verified against the official SDK (github.com/qezawat-a/open-api,
  // Demo/Java/.../TpslPendingOrderResp.java): a pending TP/SL row carries
  //     slPrice        the TRIGGER price
  //     slOrderType    "MARKET" or "LIMIT"
  //     slOrderPrice   the LIMIT price, only meaningful when the type is LIMIT
  //
  // Nothing in this file read slOrderPrice or slOrderType before, so the bot
  // assumed every stop it owned was a market stop and priced exits against
  // the trigger. Every stop this project places IS a market stop today, so
  // nothing was wrong — but a LIMIT stop (added by hand in the web UI, or by
  // a future change) would have been read at its trigger price and its
  // limit price silently ignored. Reading both makes the assumption explicit
  // and lets the caller tell the difference.
  const slOrderType = String(row.slOrderType || 'MARKET').toUpperCase();
  const slOrderPrice = row.slOrderPrice != null && row.slOrderPrice !== ''
    ? Number(row.slOrderPrice) : null;
  const isLimit = slOrderType === 'LIMIT' && slOrderPrice != null
    && Number.isFinite(slOrderPrice) && slOrderPrice > 0;

  return {
    slPrice: Number(row.slPrice),
    tpPrice: row.tpPrice != null ? Number(row.tpPrice) : null,
    // The price the position is actually filled at. Identical to the trigger
    // for a market stop; the limit price for a limit stop.
    exitPrice: isLimit ? slOrderPrice : Number(row.slPrice),
    slOrderType,
    slOrderPrice,
    isLimitStop: isLimit,
    row,
  };
}

/**
 * Did the stop we just asked for actually land on the exchange?
 *
 * `modify_order` resolving with code 0 is NOT proof the order changed — the
 * read-back is the only proof. Retried because the pending-orders view can lag
 * the write by a moment.
 */
async function verifyStopApplied({ symbol, positionId, side, want, tries = 3 }) {
  let current = null;
  for (let i = 0; i < tries; i++) {
    current = await readPositionTpSl({ symbol, positionId, side });
    if (current) {
      // quotePrecision can differ from what we sent by a hair; a genuine no-op
      // leaves the OLD stop far away, so a loose band is safe here.
      const tol = Math.max(Math.abs(want) * 1e-4, 1e-9);
      if (Math.abs(current.slPrice - want) <= tol) return { ok: true, current };
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 350));
  }
  return { ok: false, current };
}

export async function upsertPositionTpSl({ symbol, positionId, tpPrice, slPrice, side = null, entry = null, force = false }) {
  // ---- ratchet guard --------------------------------------------------
  //
  // The ratchet must compare against the level the EXCHANGE is holding, not
  // against our own memory of the last thing we wrote. The memory is only a
  // fallback for when the read is unavailable.
  //
  // Why that distinction is the whole bug: `bestStop` survives the user
  // moving the stop by hand on the exchange. The exchange is at 0.016960,
  // the memory still says 0.016852507, and the next write — whether it came
  // from the guard's trailing pass or from the agent calling this tool to
  // "just re-apply it" — is measured against the stale memory. On a LONG the
  // stale value reads as "the new stop is worse, put the old one back", so
  // the bot overwrote the user's level with the engine's. Measured 2026-10-07
  // on WUSDT LONG 33x: the user moved the stop up by hand, and the bot wrote
  // 0.016852507 back over their 0.016960 on the next pass.
  //
  // It also fires in the opposite direction and that one is worse: if the
  // user deliberately WIDENED the stop to give a trade room, the engine
  // would have refused it as a loosening move and reinstalled the tight one.
  // A user placing a stop by hand is a decision, and the guard's job is to
  // never argue with it.
  //
  // `force: true` is how the agent repairs a stop after the user has asked
  // for a specific level — it skips the ratchet entirely, because by then
  // the user IS the authority.
  if (slPrice != null && side && !force) {
    const key = String(positionId);
    let baseline = null;

    // Ask the exchange what it actually holds. A read failure is not a
    // licence to overwrite — fall back to memory, but say so.
    let sawExchange = false;
    try {
      const resp = await bitunix.getPendingTpSlOrders({ symbol, positionId });
      const rows = (Array.isArray(resp) ? resp : (resp?.orderList || []))
        .filter((r) => r && r.slPrice != null && String(r.positionId) === String(positionId));
      if (rows.length) {
        sawExchange = true;
        // best level = the one closest to profit, matching what would fire first
        baseline = rows.reduce((a, b) => (side === 'LONG'
          ? (Number(b.slPrice) > Number(a) ? Number(b.slPrice) : Number(a))
          : (Number(b.slPrice) < Number(a) ? Number(b.slPrice) : Number(a))), rows[0].slPrice);
      }
    } catch (e) {
      log.warn(`${symbol}: cannot read the exchange stop for the ratchet (${e.message}) — using memory`);
    }

    if (baseline == null || !Number.isFinite(Number(baseline))) {
      baseline = bestStop.get(key)?.stop ?? null;
    }

    const prev = bestStop.get(key);
    if (baseline != null && prev && prev.side === side) {
      const loosening = side === 'LONG' ? Number(slPrice) < Number(baseline) : Number(slPrice) > Number(baseline);
      if (loosening) {
        log.warn(`${symbol}: refusing to loosen the stop on a ${side} `
          + `(exchange holds ${baseline}, asked ${slPrice}); keeping ${baseline}`
          + (sawExchange ? '' : ' [read failed — compared against memory]'));
        slPrice = baseline;
      }
    }
  }

  const body = { symbol, positionId };
  if (tpPrice != null) body.tpPrice = await bitunix.roundPrice(symbol, tpPrice);
  if (slPrice != null) body.slPrice = await bitunix.roundPrice(symbol, slPrice);
  body.tpStopType = 'MARK_PRICE';
  body.slStopType = 'MARK_PRICE';

  // NOT named `remember`: that identifier is imported from ../db/index.js at
  // the top of this file, and shadowing it inside this function meant any
  // future db.remember call added here would silently log a trade outcome
  // instead of writing a memory.
  const noted = (mode, res) => {
    if (slPrice != null && side) bestStop.set(String(positionId), { side, stop: Number(body.slPrice) });
    return { ok: true, res, mode, slPrice: Number(body.slPrice), tpPrice: body.tpPrice ? Number(body.tpPrice) : null };
  };

  const wanted = slPrice != null ? Number(body.slPrice) : null;

  // Resolve the write, then PROVE it. Recording the stop in bestStop — and
  // letting the caller record it in its own ratchet — off a write that never
  // reached the book is what made this look like a working trailing stop: the
  // bot believed the stop was locked at breakeven, the ratchet then refused to
  // loosen it, and every later guard pass saw "nothing to improve" and returned
  // an empty action list while the position kept its original wide stop.
  const finish = async (mode, res) => {
    if (wanted == null) return noted(mode, res);   // TP-only edit: nothing to verify
    const v = await verifyStopApplied({ symbol, positionId, side, want: wanted });
    if (v.ok) return noted(mode, res);

    const seen = v.current?.slPrice ?? null;
    log.error(
      `${symbol} ${side || ''} ${positionId}: exchange accepted ${mode} but the stop is still `
      + `${seen ?? 'unset'} — asked for ${wanted}. Not recording it as moved.`,
    );
    await logEvent('tpsl_write_unverified', {
      symbol, positionId, side, mode, wanted, exchangeSl: seen,
    }, symbol);
    return {
      ok: false,
      mode,
      reason: `stop did not take effect: asked ${wanted}, exchange still shows ${seen ?? 'no stop'}`,
      slPrice: wanted,
      exchangeSl: seen,
    };
  };

  try {
    const existing = await bitunix.getPendingTpSlOrders({ symbol, positionId });
    const rows = (Array.isArray(existing) ? existing : (existing?.orderList || []))
      .filter((r) => r && String(r.positionId) === String(positionId));

    if (!rows.length) {
      return await finish('placed', await bitunix.placePositionTpSl(body));
    }

    // 1) position-level modify (works when the stop was made by position/place_order)
    const first = await finish('modified', await bitunix.modifyPositionTpSl(body));
    if (first.ok || wanted == null) return first;

    // 2) The entry order carries its SL attached (placeOrder slPrice=...). That
    //    row is an ORDER-level tp/sl with its own id; position/modify_order
    //    answers code 0 for it and changes nothing. Modify it by orderId.
    const row = rows.find((r) => r.slPrice != null) || rows[0];
    const id = row.id ?? row.orderId;
    const qty = row.slQty ?? row.tpQty ?? await positionQtyOf(symbol, positionId);
    if (id != null && qty != null) {
      try {
        const mbody = {
          orderId: String(id), symbol, positionId: String(positionId),
          slPrice: body.slPrice, slStopType: 'MARK_PRICE', slOrderType: 'MARKET', slQty: String(qty),
        };
        const keepTp = body.tpPrice ?? row.tpPrice;
        if (keepTp != null) {
          Object.assign(mbody, {
            tpPrice: String(keepTp), tpStopType: 'MARK_PRICE', tpOrderType: 'MARKET',
            tpQty: String(row.tpQty ?? qty),
          });
        }
        const second = await finish('modified-by-orderId', await bitunix.modifyTpSlOrder(mbody));
        if (second.ok) return second;
      } catch (e) { log.warn(`${symbol}: modify_order by id failed: ${e.message}`); }
    }

    // 3) Last resort: ADD a new full-size stop next to the old one. Never cancel
    //    the old stop first — a failed swap would leave the position naked.
    if (qty != null) {
      try {
        const third = await finish('added-order-stop', await bitunix.placeTpSlOrder({
          symbol, positionId: String(positionId),
          slPrice: body.slPrice, slStopType: 'MARK_PRICE', slOrderType: 'MARKET', slQty: String(qty),
        }));
        if (third.ok) return third;
      } catch (e) { log.warn(`${symbol}: add stop failed: ${e.message}`); }
    }
    return first;   // unverified result; manager arms the software stop
  } catch (e) {
    // duplicate tp/sl -> fall back to modify
    try {
      return await finish('modified-fallback', await bitunix.modifyPositionTpSl(body));
    } catch (e2) {
      return { ok: false, reason: `${e.message} | ${e2.message}` };
    }
  }
}

async function positionQtyOf(symbol, positionId) {
  try {
    const ps = await bitunix.getPendingPositions({ symbol });
    const p = (Array.isArray(ps) ? ps : []).find((x) => String(x.positionId) === String(positionId));
    return p ? p.qty : null;
  } catch { return null; }
}

/** Reversal: flatten the current side and immediately open the opposite one. */
export async function reverse(position, signal, aiVerdict = null) {
  const closed = await closePosition(position.positionId, 'reversal');
  if (!closed.ok) return { ok: false, reason: `close failed: ${closed.reason}` };
  await new Promise((r) => setTimeout(r, 1200));
  const opened = await openFromSignal(signal, { aiVerdict });
  await logEvent('reversal', {
    symbol: position.symbol, from: position.side, to: signal.side,
    confidence: signal.confidence, ok: opened.ok,
  }, position.symbol);
  return opened;
}
