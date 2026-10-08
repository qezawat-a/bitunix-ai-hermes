# AGENT.md — J-ROCK Operational Configuration

Runtime parameters. These are read live from Neon `agent_settings` at prompt
build time — you may edit this document as your own reference, but never treat a
hardcoded number here as ground truth while the system is running.

## Scanner / signal gates
- `min_agreement` — minimum distinct strategies matching direction (default 2)
- `min_confidence` — aggregate weighted confidence floor (default 80)
- `tf_min_confidence` — minimum confidence per strategy vote (default 60)
- `signal_confirm_scans` — confirmatory scan passes (default 1)
- `cooldown_min` — cooldown between trades on same symbol (default 5)
- `reversal_enabled` — allow reversing an existing position (default true)
- `reversal_confidence` — confidence required to reverse (default 85)

## Timeframes
- `timeframes` — comma list; first = execution timeframe (default `1m,3m,5m,15m`)

## Execution sizing
- `margin_pct` — % of available balance used as margin (default 5)
- `cost_pct` — allocation ceiling per signal, cap 25 (user-set value)
- `leverage` — pair-max clamped, aggressive within risk (default 10)
- `max_open_positions` — concurrent positions (default 5)
- `order_unit` — NOMINAL | COST | QTY (default COST)

## Stop / TP / trailing
- `liq_distance` — stop keeps this fraction of entry→liq clear (default 0.5)
- `breakeven_threshold` — ROI % at which stop moves to entry (default 20)
- `trailing_trigger_roi_pct` — trailing activates here (default 25)
- `trailing_distance_atr` — ATR multiples behind price (default 0.5)
- `trailing_lock_fraction` — profit-anchored lock fraction (default 0.5)
- `tp_mode` — ADAPTIVE | FIXED_R (default ADAPTIVE)
- `tpsl_method` — POSITION | PARTIAL (default POSITION)
- `partial_tp_ladder` — share@R ladder (default `40@1,35@2,25@3`)
- `trailing_method` — ATR | RATIO | INTERVAL (default ATR)
- `trailing_callback` — % if RATIO, price if INTERVAL (default 1.5)
- `account_tp_usdt` — close all at unrealised PnL (default 0 = off)
- `account_sl_usdt` — close all at max loss (default 0 = off)

## Scanning universe
- `symbols` — AUTO or explicit list
- `universe_rank` — VOLUME | GAINERS | LOSERS | MOVERS (default VOLUME)
- `universe_size` — pairs to scan (default 40)
- `min_24h_volume_usd` — liquidity floor (default 20,000,000)

## Loop intervals (seconds)
- `scan_interval_sec` — scan cadence (default 15)
- `manage_interval_sec` — position management cadence (default 15)
- `guard_interval_sec` — protection pass cadence (default 15)
- `agent_autonomous_sec` — autonomous agent pass cadence (default 15)
- `report_interval_sec` — report push cadence (default 30)
- `heartbeat_minutes` — idle alive ping (default 15)

## Risk floor
- `min_stop_pct` — stop must clear this % of price (default 0.25)
- `min_stop_cost_multiple` — stop must be worth this many round trips (default 3)
- `round_trip_fee_pct` — cost model for breakeven (default 0.001)
- `stop_slippage_pct` — baseline stop slippage (default 0.0005)

## Mode flags
- `auto_trade` — autotrade on (default true)
- `position_mode` — HEDGE | ONE_WAY (default HEDGE)
- `margin_mode` — CROSS | ISOLATION (default CROSS)
- `dream_enabled` — off-hours reflection (default false)
- `dream_interval_hours` — dream cycle hours (default 24)
- `thinking_level` — off|low|medium|high (default high)
- `autocompact` — prompt compaction (default true)
- `auto_refresh_model` — model probing refresh (default true)
- `liquidation_buffer` — safety gap on liquidation estimate (default 0.5)
