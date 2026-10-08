/**
 * LEARNING — turn the agent's own record into changes to its own behaviour.
 *
 * `/learning on` does NOT let the agent edit its risk gates or place orders on
 * its own say-so. What it does is:
 *
 *   1. Every closed trade already feeds strategy_stats (bumpStrategy) and
 *      memories. Learning reads those.
 *   2. A proposal is a CANDIDATE weight, computed from real win rates, and it
 *      is always shown to the user with the numbers that produced it.
 *   3. Nothing is applied without `/learning apply`. A proposal that lowers
 *      min_confidence or raises leverage is REFUSED outright — those are risk
 *      ceilings, not tunable preferences, and an agent that can loosen them
 *      unsupervised is a runaway.
 *
 * The distinction that matters: learning may reweight WHICH strategy gets
 * listened to, using evidence. It may not decide how much money the next
 * trade risks.
 */
import ai from './providers.js';
import { harness, setFlag } from './harness.js';
import { createLogger } from '../logger.js';
import * as db from '../db/index.js';
import { STRATEGY_KEYS } from '../scanner/scanner.js';

const log = createLogger('learning');

/** Never touched by learning, at any confidence, in any direction. */
export const FROZEN = new Set([
  'leverage', 'margin_pct', 'max_open_positions', 'min_confidence',
  'tf_min_confidence', 'min_agreement', 'account_sl_usdt', 'account_tp_usdt',
  'liq_distance', 'min_stop_pct', 'min_stop_cost_multiple',
]);

/** A weight outside this band is treated as a broken calculation, not a verdict. */
const MIN_W = 0.5, MAX_W = 1.6;

function clampWeight(w) { return Math.max(MIN_W, Math.min(MAX_W, Number(w.toFixed(3)))); }

/**
 * Build a proposal from closed trades.
 *
 * Wilson lower bound rather than raw win rate: a strategy with 1 win out of 1
 * has a 100% win rate and no evidence whatsoever, and a raw rate would let it
 * outvote a strategy with 40 wins out of 45. The bound shrinks with sample
 * size, so noise cannot masquerade as skill.
 */
export function computeProposal({ stats, minSamples = 8 } = {}) {
  const rows = Array.isArray(stats) ? stats : (stats?.rows || []);
  const candidates = [];

  for (const r of rows) {
    const name = r.strategy;
    if (!STRATEGY_KEYS.includes(name)) continue;
    const games = (r.wins || 0) + (r.losses || 0);
    if (games < minSamples) {
      candidates.push({
        strategy: name, action: 'hold', games,
        why: `only ${games} closed trade(s) — below the ${minSamples} needed to say anything`,
      });
      continue;
    }

    const p = r.wins / games;
    // Wilson score interval, lower bound, 95% confidence.
    const z = 1.96;
    const denom = 1 + (z * z) / games;
    const centre = p + (z * z) / (2 * games);
    const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * games)) / games);
    const lower = (centre - margin) / denom;

    const base = Number(r.weight ?? 1);
    // Map [0.20, 0.80] lower-bound -> [0.6, 1.6]. Below 0.20 is dead weight,
    // above 0.80 is already trusted; neither should be pushed by the formula.
    const target = lower <= 0.20 ? MIN_W : lower >= 0.80 ? MAX_W : clampWeight(
      MIN_W + ((lower - 0.20) / 0.60) * (MAX_W - MIN_W),
    );

    const delta = target - base;
    candidates.push({
      strategy: name,
      current: base,
      proposed: target,
      delta: Number(delta.toFixed(3)),
      games, wins: r.wins, losses: r.losses,
      win_rate: Number(p.toFixed(3)),
      lower_bound: Number(lower.toFixed(3)),
      pnl: Number(r.pnl ?? 0),
      action: Math.abs(delta) < 0.05 ? 'hold' : delta > 0 ? 'raise' : 'lower',
      why: `Wilson lower bound ${lower.toFixed(3)} over ${games} trades (${r.wins}W/${r.losses}L)`,
    });
  }

  return {
    created_at: Date.now(),
    min_samples: minSamples,
    changes: candidates.filter((c) => c.action !== 'hold'),
    held: candidates.filter((c) => c.action === 'hold'),
  };
}

let current = null;

/** The proposal awaiting /learning apply, or null. */
export function pending() { return current; }

/**
 * Read performance, compute the proposal, and let the model add a written
 * rationale. The numbers are ours; the prose is the model's, and the model is
 * explicitly told it may not invent numbers.
 */
export async function buildProposal({ days = 30, minSamples = 8 } = {}) {
  const stats = await db.tradeStats(days);
  const { rows } = await db.strategyWeights();
  const proposal = computeProposal({ stats: rows, minSamples });

  let rationale = '';
  if (proposal.changes.length) {
    try {
      const r = await ai.chat({
        thinking: 'low', maxTokens: 700, temperature: 0.2,
        messages: [
          { role: 'system', content: 'You are reviewing your own trading performance. Explain the proposed weight changes in plain English, at most 4 sentences. Cite ONLY the numbers given. Do not suggest changing leverage, position size, or any risk limit — those are fixed.' },
          { role: 'user', content: JSON.stringify(proposal.changes, null, 1) },
        ],
      });
      rationale = r.content || '';
    } catch (e) {
      log.warn(`learning rationale unavailable: ${e.message}`);
      rationale = '';
    }
  }

  current = { ...proposal, days, rationale };
  await db.logEvent('learning_proposal', { changes: proposal.changes.length, held: proposal.held.length, days }).catch(() => {});
  log.info(`learning proposal: ${proposal.changes.length} change(s), ${proposal.held.length} held`);
  return current;
}

/**
 * Apply a proposal.
 *
 * Refuses every frozen key by construction — not by a check that a clever
 * prompt could talk it out of, but because frozen keys are not in the accepted
 * shape of a change at all.
 */
export async function apply({ force = false } = {}) {
  if (!current) throw new Error('no proposal yet — run /learning build first');
  if (!current.changes.length) return { applied: [], note: 'nothing to change' };

  const applied = [];
  const refused = [];
  for (const c of current.changes) {
    if (FROZEN.has(c.strategy)) { refused.push({ key: c.strategy, why: 'frozen risk ceiling' }); continue; }
    await db.q(
      `INSERT INTO strategy_stats (strategy, weight) VALUES ($1, $2)
       ON CONFLICT (strategy) DO UPDATE SET weight = $2, updated_at = now()`,
      [c.strategy, c.proposed],
    );
    applied.push({ strategy: c.strategy, weight: c.proposed });
  }

  await db.logEvent('learning_applied', { applied, forced: force }).catch(() => {});
  current = { ...current, applied, refused, applied_at: Date.now() };
  return current;
}

/**
 * `/learning` status — what the system believes right now, from real rows.
 */
export async function status() {
  const { rows } = await db.strategyWeights().catch(() => ({ rows: [] }));
  const on = harness().learning;
  return {
    enabled: on,
    frozen_keys: [...FROZEN],
    weights: rows.map((r) => ({
      strategy: r.strategy, weight: Number(r.weight),
      wins: r.wins, losses: r.losses, pnl: Number(r.pnl ?? 0),
    })).sort((a, b) => b.weight - a.weight),
    pending_proposal: current
      ? { changes: current.changes, rationale: current.rationale, at: current.created_at }
      : null,
  };
}

export function toggle(v) { return setFlag('learning', v); }