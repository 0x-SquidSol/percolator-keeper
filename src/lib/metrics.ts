import {
  collectDefaultMetrics,
  Registry,
  Counter,
  Gauge,
  Histogram,
} from "prom-client";

const registry = new Registry();

if (process.env.DRY_RUN === "true") {
  registry.setDefaultLabels({ dry_run: "true" });
}

export const txSentTotal = new Counter({
  name: "keeper_tx_sent_total",
  help: "Total transactions sent by the keeper, partitioned by result and type",
  labelNames: ["result", "type"] as const,
  registers: [registry],
});

export const solSpentLamportsTotal = new Counter({
  name: "keeper_sol_spent_lamports_total",
  help: "Total SOL spent in lamports, partitioned by transaction type",
  labelNames: ["type"] as const,
  registers: [registry],
});

export const jitoBundleFailCountTotal = new Counter({
  name: "keeper_jito_bundle_fail_count_total",
  help: "Total number of Jito bundle submission failures",
  registers: [registry],
});

export const oraclePushCountTotal = new Counter({
  name: "keeper_oracle_push_count_total",
  help: "Total oracle price pushes, partitioned by mint and source",
  labelNames: ["mint", "source"] as const,
  registers: [registry],
});

export const accountStreamEventTotal = new Counter({
  name: "keeper_account_stream_event_total",
  help: "Total account stream events received, partitioned by type",
  labelNames: ["type"] as const,
  registers: [registry],
});

export const accountStreamDropTotal = new Counter({
  name: "keeper_account_stream_drop_total",
  help: "Total account stream events dropped due to backpressure or errors",
  registers: [registry],
});

export const walletBalanceSol = new Gauge({
  name: "keeper_wallet_balance_sol",
  help: "Current SOL balance of the keeper wallet",
  registers: [registry],
});

export const oracleStalenessSeconds = new Gauge({
  name: "keeper_oracle_staleness_seconds",
  help: "Seconds since the last oracle price push, partitioned by mint",
  labelNames: ["mint"] as const,
  registers: [registry],
});

export const slotDrift = new Gauge({
  name: "keeper_slot_drift",
  help: "Difference between the account stream slot and the RPC confirmed slot",
  registers: [registry],
});

export const activeMarketsCount = new Gauge({
  name: "keeper_active_markets_count",
  help: "Number of markets currently tracked by the keeper",
  registers: [registry],
});

export const roleGauge = new Gauge({
  name: "keeper_role",
  help: "Keeper HA role: 1 if leader, 0 if standby",
  registers: [registry],
});

export const budgetHalted = new Gauge({
  name: "keeper_budget_halted",
  help: "Budget circuit-breaker state: 1 if halted, 0 if normal",
  registers: [registry],
});

export const cycleDurationSeconds = new Histogram({
  name: "keeper_cycle_duration_seconds",
  help: "Duration of a keeper service cycle in seconds, partitioned by service",
  labelNames: ["service"] as const,
  buckets: [0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

export const txLandTimeSeconds = new Histogram({
  name: "keeper_tx_land_time_seconds",
  help: "Time from transaction submission to on-chain confirmation, partitioned by type and lane",
  labelNames: ["type", "lane"] as const,
  buckets: [0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

export const txSuccessRate = new Histogram({
  name: "keeper_tx_success_rate",
  help: "Rolling 60-second transaction success rate, partitioned by type",
  labelNames: ["type"] as const,
  buckets: [0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

export const simulateCuUsed = new Histogram({
  name: "keeper_simulate_cu_used",
  help: "Simulated compute units consumed per transaction, partitioned by type",
  labelNames: ["type"] as const,
  buckets: [10_000, 50_000, 100_000, 200_000, 500_000, 1_000_000, 1_400_000],
  registers: [registry],
});

// ── RPC pool metrics (Workstream G) ──────────────────────────────────────

export const rpcRequestTotal = new Counter({
  name: "keeper_rpc_request_total",
  help: "Total RPC requests routed by the pool, partitioned by provider, method, and result",
  labelNames: ["provider", "method", "result"] as const,
  registers: [registry],
});

export const rpcLatencyP50 = new Gauge({
  name: "keeper_rpc_latency_ms",
  help: "Rolling P50/P99 latency in ms for each RPC provider, updated on every health-check tick",
  labelNames: ["provider", "percentile"] as const,
  registers: [registry],
});

// P99 exported separately for direct set calls — the gauge name uses a label
// dimension "percentile" shared with rpcLatencyP50. Both resolve to the same
// registered gauge; callers set the "p50" / "p99" label value.
export const rpcLatencyP99 = rpcLatencyP50;

export const rpcProviderHealthy = new Gauge({
  name: "keeper_rpc_provider_healthy",
  help: "1 if the RPC provider is healthy, 0 if unhealthy",
  labelNames: ["provider"] as const,
  registers: [registry],
});

export const rpcFailoverTotal = new Counter({
  name: "keeper_rpc_failover_total",
  help: "Total RPC failover events, partitioned by from-provider, to-provider, and reason",
  labelNames: ["from", "to", "reason"] as const,
  registers: [registry],
});

export const rpcSlotLag = new Gauge({
  name: "keeper_rpc_slot_lag",
  help: "Slot lag for each provider vs the other provider (positive = behind, negative = ahead)",
  labelNames: ["provider"] as const,
  registers: [registry],
});

// ── Workstream K: /metrics enrichment ────────────────────────────────────

// Priority fee gauge — label `tier` is the tx-type name ("crank", "liquidation",
// "oracle", "adl") because each tx type maps to exactly one configured percentile.
// Using the tx-type name rather than the raw percentile number makes dashboards
// readable without needing a legend that maps "p50" to "oracle".
// Emitted from priority-fee.ts on every successful estimate() call.
export const priorityFeeMicrolamports = new Gauge({
  name: "keeper_priority_fee_microlamports",
  help: "Most-recent priority fee estimate in microlamports, partitioned by account-set hash and tx-type tier",
  labelNames: ["accountSet_hash", "tier"] as const,
  registers: [registry],
});

// Counter — incremented on every estimate() call regardless of cache hit/miss.
// Wired in priority-fee.ts HeliusPriorityFeeEstimator.estimate().
export const priorityFeeEstimateTotal = new Counter({
  name: "keeper_priority_fee_estimate_total",
  help: "Total priority fee estimate() calls, partitioned by tier (tx type)",
  labelNames: ["tier"] as const,
  registers: [registry],
});

// Per-DEX-type UpdateHyperpMark instruction outcome counter.
// Wired in crank.ts crankMarket() HYPERP branch.
export const updateHyperpMarkTotal = new Counter({
  name: "keeper_update_hyperp_mark_total",
  help: "Total UpdateHyperpMark instructions attempted, partitioned by dex_type and result",
  labelNames: ["dex_type", "result"] as const,
  registers: [registry],
});

// Per-DEX-type CU histogram for UpdateHyperpMark instructions.
// Observed with simulatedCu from CuEstimator when simulation ran for that send.
// Wired in crank.ts crankMarket() HYPERP branch.
export const updateHyperpMarkCu = new Histogram({
  name: "keeper_update_hyperp_mark_cu",
  help: "Simulated compute units consumed by UpdateHyperpMark instructions, partitioned by dex_type",
  labelNames: ["dex_type"] as const,
  buckets: [10_000, 50_000, 100_000, 200_000, 300_000, 500_000, 800_000, 1_400_000],
  registers: [registry],
});

// ── Queue metrics (Workstream H) ──────────────────────────────────────────

export const txQueueWaitSeconds = new Histogram({
  name: "keeper_tx_queue_wait_seconds",
  help: "Time a transaction spends waiting in the priority queue before dispatch, partitioned by lane",
  labelNames: ["lane"] as const,
  buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

export const txQueuePending = new Gauge({
  name: "keeper_tx_queue_pending",
  help: "Number of transactions waiting in the priority queue (not yet dispatched), partitioned by lane",
  labelNames: ["lane"] as const,
  registers: [registry],
});

export const txQueueActive = new Gauge({
  name: "keeper_tx_queue_active",
  help: "Number of transactions currently being executed (dispatched but not yet resolved), partitioned by lane",
  labelNames: ["lane"] as const,
  registers: [registry],
});

export const txQueueCompletedTotal = new Counter({
  name: "keeper_tx_queue_completed_total",
  help: "Total transactions that completed successfully through the priority queue, partitioned by lane",
  labelNames: ["lane"] as const,
  registers: [registry],
});

export const txQueueFailedTotal = new Counter({
  name: "keeper_tx_queue_failed_total",
  help: "Total transactions that failed (threw) through the priority queue, partitioned by lane",
  labelNames: ["lane"] as const,
  registers: [registry],
});

// ── Workstream I: fraud-detection layer ──────────────────────────────────────

// Per-mint divergence gauge: |onchain_mark - offchain_consensus| / offchain * 10_000.
// Updated on every fraud-detector cycle regardless of whether the divergence
// exceeds the alert threshold — allows trend analysis in Grafana.
export const fraudDivergenceBps = new Gauge({
  name: "keeper_fraud_divergence_bps",
  help: "Absolute divergence in basis points between the on-chain EMA and the off-chain reference price, partitioned by mint",
  labelNames: ["mint"] as const,
  registers: [registry],
});

// Incremented each time a divergence alert fires for a mint (after cooldown passes).
// Use rate() in Grafana to see alert frequency per mint.
export const fraudAlertTotal = new Counter({
  name: "keeper_fraud_alert_total",
  help: "Total fraud-detection divergence alerts fired, partitioned by mint",
  labelNames: ["mint"] as const,
  registers: [registry],
});

// Incremented when the off-chain price is unavailable (null return, throw, or zero)
// for a market. A sustained count indicates a feed outage for that mint.
export const fraudOffchainUnavailableTotal = new Counter({
  name: "keeper_fraud_offchain_unavailable_total",
  help: "Total cycles where the off-chain price was unavailable for a market, partitioned by mint",
  labelNames: ["mint"] as const,
  registers: [registry],
});

// ── Workstream J: shadow-keeper observation harness ──────────────────────────

// Incremented on every decision the shadow keeper would have fired.
// Partitioned by txType so the operator can tell which crank type the shadow
// is most active on. Wired from decision-log.ts append().
export const shadowDecisionsTotal = new Counter({
  name: "keeper_shadow_decisions_total",
  help: "Total shadow-keeper decisions logged (would-have-fired), partitioned by txType",
  labelNames: ["txType"] as const,
  registers: [registry],
});

// Incremented on every compared decision/tx pair. result is one of:
//   "match"        — shadow decision matched a live tx
//   "live_only"    — live tx had no corresponding shadow decision
//   "shadow_only"  — shadow decision had no corresponding live tx
// Wired from shadow-harness.ts compare().
export const shadowMatchTotal = new Counter({
  name: "keeper_shadow_match_total",
  help: "Total shadow-keeper comparison outcomes, partitioned by txType and result",
  labelNames: ["txType", "result"] as const,
  registers: [registry],
});

// Updated after each comparison cycle. divergence_pct per txType computed
// independently: (live_only + shadow_only) / total * 100. Wired from
// shadow-harness.ts compare().
export const shadowDivergencePct = new Gauge({
  name: "keeper_shadow_divergence_pct",
  help: "Divergence percentage between shadow-keeper decision and live-keeper decision, partitioned by txType",
  labelNames: ["txType"] as const,
  registers: [registry],
});

// ─── kind=2 (Polymarket-perp) linked-market registry ────────────────────────
//
// Track only actionable kind=2 slabs (linked, not force-closed, oracle_source
// == 0). Downstream cranks (formula mirror, push cranker, force-close cranker)
// iterate the registry.

export const kind2RegistrySize = new Gauge({
  name: "keeper_kind2_registry_size",
  help: "Actionable kind=2 (Polymarket-perp) slabs currently tracked",
  registers: [registry],
});

export const kind2RegistryReady = new Gauge({
  name: "keeper_kind2_registry_ready",
  help: "0/1 — set to 1 after the initial seed populates the registry",
  registers: [registry],
});

export const kind2RegistryUpsertTotal = new Counter({
  name: "keeper_kind2_registry_upsert_total",
  help: "Registry upserts partitioned by source path (seed / stream / reconcile)",
  labelNames: ["source"] as const,
  registers: [registry],
});

export const kind2RegistryEvictTotal = new Counter({
  name: "keeper_kind2_registry_evict_total",
  help: "Registry evictions partitioned by reason (unlinked / resolved / unsupported_source / reconcile)",
  labelNames: ["reason"] as const,
  registers: [registry],
});

export const kind2RegistryReconcileDiffsTotal = new Counter({
  name: "keeper_kind2_registry_reconcile_diffs_total",
  help: "Diffs observed during reconcile, partitioned by kind (missing_from_chain / missing_from_memory / content_drift)",
  labelNames: ["kind"] as const,
  registers: [registry],
});

export const kind2RegistryReconcileLastDurationMs = new Gauge({
  name: "keeper_kind2_registry_reconcile_last_duration_ms",
  help: "Wall-clock duration of the most recent reconcile cycle",
  registers: [registry],
});

export const kind2RegistryReconcileFailureTotal = new Counter({
  name: "keeper_kind2_registry_reconcile_failure_total",
  help: "Reconcile cycles that ended in error, partitioned by reason classification",
  labelNames: ["reason"] as const,
  registers: [registry],
});

// ─── kind=2 push cranker ────────────────────────────────────────────────
//
// Permissionless `PushOracleSnapshot` cranker for actionable kind=2 slabs.
// Reads the bound Pyth `PriceUpdateV2`, gates on monotonic publish_time,
// computes `p_yes_e6` via the K2' formula mirror, submits via the existing
// keeper send path. Three rejection codes are tracked separately because
// each carries different operational meaning:
//   * stale = monotonic gate (expected; Pyth hasn't ticked)
//   * deviation = formula mismatch (CRITICAL; our mirror has drifted)
//   * resolved = market force-closed (deregister)

export const kind2PushAttemptTotal = new Counter({
  name: "keeper_kind2_push_attempt_total",
  help: "PushOracleSnapshot submission attempts (post-gate)",
  registers: [registry],
});

export const kind2PushSuccessTotal = new Counter({
  name: "keeper_kind2_push_success_total",
  help: "PushOracleSnapshot submissions that confirmed on-chain",
  registers: [registry],
});

export const kind2PushSkippedTotal = new Counter({
  name: "keeper_kind2_push_skipped_total",
  help: "Push attempts skipped before tx build, partitioned by reason (gate / inflight / not_actionable / pyth_parse_fail / formula_fail)",
  labelNames: ["reason"] as const,
  registers: [registry],
});

export const kind2PushRejectTotal = new Counter({
  name: "keeper_kind2_push_reject_total",
  help: "PushOracleSnapshot submissions rejected by the wrapper, partitioned by classification (stale / deviation / resolved / other)",
  labelNames: ["reason"] as const,
  registers: [registry],
});

export const kind2PythReadFailTotal = new Counter({
  name: "keeper_kind2_pyth_read_fail_total",
  help: "Pyth account reads that returned no usable data (cache miss / wrong owner / parse fail)",
  registers: [registry],
});

export const kind2WatchdogFireTotal = new Counter({
  name: "keeper_kind2_watchdog_fire_total",
  help: "Watchdog forced a fresh getAccountInfo because the cache was stale beyond the watchdog window",
  registers: [registry],
});

export const kind2PushTickOverlapTotal = new Counter({
  name: "keeper_kind2_push_tick_overlap_total",
  help: "Number of ticks dropped because the previous tick was still in flight (cadence too tight)",
  registers: [registry],
});

export const kind2PushTickDurationMs = new Histogram({
  name: "keeper_kind2_push_tick_duration_ms",
  help: "Wall-clock duration of each push-cranker tick",
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [registry],
});

// ─── kind=2 force-close cranker ─────────────────────────────────────────
//
// Permissionless `ForceCloseKind2` (tag 88) cranker. Each kind=2 market has
// a configured `force_close_unix_timestamp`. Once that timestamp + a small
// post-buffer + per-market jitter has elapsed, any caller can fire the
// instruction and settle the market at the captured TWAP. One-shot
// per-market — the first successful call wins; subsequent calls hit
// `InvalidAccountData` (counted under `race_loss`, NOT errors).

export const kind2ForceCloseEligible = new Gauge({
  name: "keeper_kind2_force_close_eligible",
  help: "Number of actionable markets currently within their fire window",
  registers: [registry],
});

export const kind2ForceCloseAttemptTotal = new Counter({
  name: "keeper_kind2_force_close_attempt_total",
  help: "ForceCloseKind2 submissions attempted",
  registers: [registry],
});

export const kind2ForceCloseSuccessTotal = new Counter({
  name: "keeper_kind2_force_close_success_total",
  help: "ForceCloseKind2 submissions that confirmed (we won the race)",
  registers: [registry],
});

export const kind2ForceCloseRaceLossTotal = new Counter({
  name: "keeper_kind2_force_close_race_loss_total",
  help: "Submissions that returned InvalidAccountData (another caller already resolved the market)",
  registers: [registry],
});

export const kind2ForceCloseRejectTotal = new Counter({
  name: "keeper_kind2_force_close_reject_total",
  help: "Submissions rejected for non-success non-race reasons, partitioned by classification (paused / not_yet_eligible / other)",
  labelNames: ["reason"] as const,
  registers: [registry],
});

export const kind2ForceCloseTickDurationMs = new Histogram({
  name: "keeper_kind2_force_close_tick_duration_ms",
  help: "Wall-clock duration of each force-close cranker tick",
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [registry],
});

export function registerDefaultMetrics(): void {
  collectDefaultMetrics({ register: registry, prefix: "nodejs_" });
}

export function getRegistry(): Registry {
  return registry;
}
