# kind=2 (Polymarket-Perp) Keeper Operations

> **Audience:** on-call keeper operator. This is the single source of truth for running the kind=2 stack — bring it up, watch it, intervene when it misbehaves, and clean up after a market resolves.

The kind=2 keeper stack is the Polymarket-perp half of the keeper. Unlike the kind=0/1 keeper, which cranks every active slab on a single global cadence, the kind=2 stack is **per-market-aware**: it iterates a `Kind2Registry` of actionable slabs (linked, not resolved, `oracle_source == Pyth`), reads each market's bound `PriceUpdateV2` from cache, computes `p_yes_e6` via the K2' formula mirror, and submits `PushOracleSnapshot` (tag 85) at Pyth's publish cadence. A second cranker fires the permissionless `ForceCloseKind2` (tag 88) once each market's `force_close_unix_timestamp` elapses. Five services collaborate: `Kind2Registry` (K1'), `kind2-formula.ts` (K2'), `Kind2PushCranker` (K3'), `Kind2ForceCloseCranker` (K4'), and `Kind2MetricsService` (K5' per-slab gauges + Grafana). The Grafana row is titled **"Kind=2 / Polymarket-Perp"** in `dashboards/keeper.json`.

## Operator quickstart

Five commands that establish whether the kind=2 stack is healthy right now. Run from the keeper host (or a pod with `kubectl exec` into the leader):

```bash
# 1. Registry is populated and ready (kind2_registry_ready == 1).
curl -s localhost:9100/metrics | grep -E '^keeper_kind2_registry_(size|ready)\b'

# 2. No slab is silently degraded (every series should be < 60s).
curl -s localhost:9100/metrics | grep '^keeper_kind2_last_push_age_secs' | sort -t' ' -k2 -n | tail -5

# 3. Push outcomes are dominated by Success, not Reject.
curl -s localhost:9100/metrics | grep -E '^keeper_kind2_push_(success|reject|skipped)_total'

# 4. Pyth reads are working (counter should be flat — non-zero rate is bad).
curl -s localhost:9100/metrics | grep '^keeper_kind2_pyth_read_fail_total'

# 5. Leader is who we think it is (a renewed lock; standby keeper returns "standby").
curl -s localhost:8081/health | jq '.role, .identity'
```

Healthy output: `kind2_registry_ready == 1`, every `last_push_age_secs` series under 30s, `push_success_total` climbing 1–3 ops/sec per market, `push_reject_total{reason="deviation"}` flat at zero, `pyth_read_fail_total` flat.

---

## 1. Bring-up

### 1.1 Required environment

The kind=2 stack reuses the keeper's existing config. The variables that specifically affect kind=2 behavior:

| Var | Default | Notes |
|---|---|---|
| `HA_ENABLED` | `false` | Set `true` to engage `LeaderLock`; the push + force-close + registry-reconcile timers are leader-only. |
| `KEEPER_LEADER_LOCK_TTL_MS` | `30000` | Lock TTL — also bounds the worst-case promotion delay on leader death. |
| `KEEPER_LEADER_LOCK_RENEW_MS` | `10000` | Renew cadence — must be < TTL/2. |
| `CRANK_KEYPAIR` | — | Tx-signer for both cranks. Wallet must be funded (priority fees come out of this). |
| `NETWORK` | — | `mainnet-beta` / `devnet`. The kind=2 stack does not run on localnet. |
| `KEEPER_HEALTH_PORT` | `8081` | `/health` returns leader role + last-crank timestamps. |

There is no kind=2-specific feature flag — the registry boots if the keeper boots. To disable kind=2 entirely without redeploying, the supported workaround is `HA_ENABLED=true` with this pod intentionally not winning the lock (i.e. ship a sibling pod that does); the standby keeper still seeds the registry but the cranks stay quiet.

### 1.2 First kind=2 market (onboarding)

The admin must execute these instructions **in this exact order** — each step gates the next (the wrapper enforces these orderings on-chain):

1. `InitMarket` — creates the slab. **Important:** the `index_feed_id` constructor argument must be the 32-byte Pyth feed id for this market. There is no separate setter — if you forget here, you must `CloseSlab` and re-init. `market_kind` defaults to `0`; `LinkPolymarketMarket` (step 3) lifts it to `2`.
2. `SetCouncilAuthority` (tag 89) — admin + incoming-council both sign. Sets `config.council_authority`. Required before Link will accept the co-signed call.
3. `LinkPolymarketMarket` (tag 84) — admin + council co-signed. Supplies `condition_id`, `oracle_source` (must be `0`/Pyth for V1), and `metadata_uri_hash`. The handler validates the bound Pyth account at this point (`oracle::validate_pyth_feed_account`), so the Pyth account must be passed as the 4th `AccountInfo`. The handler also lifts `engine.params.market_kind` to `2`, which switches the engine's notional formula to the side-aware branch.
4. `SetPythPriceMapping` (tag 86) — admin + council co-signed. Sets `pyth_threshold_e6`, `pyth_scale_bps_per_pct`, and `value_deviation_bps` together. The K2' formula mirror reads the first two; the wrapper's on-chain recompute uses all three.
5. `SetForceCloseTimestamp` (tag 87) — admin + council co-signed. Unix-seconds, **at least 7 days past expected Polymarket resolution**. The K4' cranker fires here regardless of resolution state. There is no undo.
6. **Wait 24h** for the activation timelock. The user-entry handlers reject new account creation until `clock.slot >= linked_at_slot + MIN_ACTIVATION_DELAY_SLOTS`. The keeper does NOT gate on this — push attempts begin immediately so the ring is populated when user entry opens.

Linking before steps 4–5 are complete produces a linked-but-unmapped market. The push cranker will fire `PushOracleSnapshot` (it has everything it needs from `index_feed_id`), but the wrapper will reject those pushes with `OracleInvalid` (deviation guard rejects because `value_deviation_bps == 0` makes any non-zero deviation an error). If the admin gets stuck here, immediately complete steps 4–5, OR set `force_close_unix_timestamp` to `now() + 24h + 60s` so K4' settles the slab permissionlessly after activation, then re-init on a fresh slab.

### 1.3 First-push sanity check

After `LinkPolymarketMarket` confirms, within 5 seconds:

- [ ] `keeper_kind2_registry_size` increases by exactly 1 (or by 1 per pod on an HA pair).
- [ ] `keeper_kind2_registry_upsert_total{source="stream"}` increments.
- [ ] **Grafana panel "Linked markets / force-close eligible"** reflects the new count.
- [ ] `keeper_kind2_push_attempt_total` rate goes non-zero.
- [ ] First successful push: `keeper_kind2_push_success_total` increments by 1; **panel "Push outcomes (rate, 5m)"** shows a Success blip.
- [ ] `keeper_kind2_last_push_age_secs{slab="<SLAB>"}` settles below 5; **panel "Last push age per slab"** shows the new series green.

Within 5 minutes:

- [ ] No `keeper_kind2_push_reject_total{reason="deviation"}` events for this slab. If deviation rejections fire on a freshly-linked market, the admin shipped wrong `pyth_threshold_e6` / `pyth_scale_bps_per_pct`, OR our K2' formula mirror has drifted — **escalate before more capital arrives**.
- [ ] `keeper_kind2_time_to_force_close_secs{slab="<SLAB>"}` matches `force_close_unix_timestamp - now()` on **panel "Time to force-close per slab"**.

The cold-start `OracleStale` rejection on the very first push is expected and harmless — K3' swallows it and advances `lastSubmittedPublishTime`. Anything else on the first 10 pushes is a P1.

---

## 2. Steady state

What "normal" looks like in production. If the panels match these descriptions and no alert is firing, **do not page**.

### 2.1 Per-market freshness

- **Panel "Last push age per slab"** — every series oscillates 0–2s, climbs briefly during Pyth slot gaps, never crosses 30s (yellow). The panel thresholds in `dashboards/keeper.json` are 30s yellow, 60s red; the 60s line is the alerting threshold (see §3.2).
- **Panel "Time to force-close per slab"** — straight downward lines toward zero. Negative values for at most ~60s before K4' fires (post-buffer 30s + jitter up to 30s).

### 2.2 Push success rate

- **Panel "Push outcomes (rate, 5m)"** — Success line dominates; Skip:`gate` is normal (monotonic gate skips between Pyth ticks); Skip:`backoff` should be near zero. Reject:`stale` is expected after every leader failover (cold-start watermark vs warm on-chain ring). Reject:`deviation`, Reject:`other`, Skip:`pyth_cache_miss`, and Skip:`pyth_parse_fail` should all be flat at zero.
- `keeper_kind2_pyth_read_fail_total` — flat. Any rate > 0 over 5m means the LaserStream subscription is dropping Pyth account updates.
- `keeper_kind2_watchdog_fire_total` — sparse increments (1–2 per hour per market in normal Pyth-slot-gap conditions). A sustained rate > 0.1 ops/sec across the cluster means LaserStream is unhealthy and the watchdog is becoming the primary push trigger.
- `keeper_kind2_push_tick_overlap_total` — flat at zero. Non-zero means cadence is too tight for the current market count; consider raising `tickMs` from 500 to 1000.

### 2.3 Registry health

- `keeper_kind2_registry_ready == 1` always after first 10s of boot.
- `keeper_kind2_registry_reconcile_diffs_total` — flat. Any non-zero increment is a P1: the hot-path stream missed an event (parser bug, LaserStream drop, etc.). The reconcile cycle self-heals the registry but the diff counter is the proof-of-failure.
- `keeper_kind2_registry_reconcile_last_duration_ms` — a few hundred ms on a 5-minute cadence. Trending up over weeks means `getProgramAccounts` is paginating more accounts than expected; revisit when it exceeds 5000ms.

### 2.4 Force-close lifecycle

- **Panel "Force-close outcomes (rate, 5m)"** — Success and Race loss are both correct outcomes; the sum equals "markets that hit T+post-buffer this window." Reject:`paused` indicates the operator pause was engaged (intentional). Reject:`not_yet_eligible` indicates host clock drift > 30s — page sysadmin.

---

## 3. Incident response

Three alert classifications. Each is a paged page; respond to symptom → cause → diagnostic → remediation → escalation in order. Do not skip the diagnostic step even if the cause looks obvious.

### 3.1 Deviation rejections — formula drift

**Alert:** `rate(keeper_kind2_push_reject_total{reason="deviation"}[5m]) > 0` for any market.

**Symptom:** **Panel "Push outcomes (rate, 5m)"** shows a non-zero Reject:`deviation` line. The push cranker has parked the affected market for 60s (`nextEligibleMs` set by `handleSubmitError`) and fired a deduped P1 alert. Per-slab `last_push_age_secs` is climbing.

**Likely cause** (in order of probability):

1. **Misconfigured market.** The admin shipped `pyth_threshold_e6` or `pyth_scale_bps_per_pct` different from what the council signed off on — the on-chain recompute disagrees with what we submitted.
2. **K2' mirror drift.** A program upgrade changed the on-chain formula and `src/services/kind2-formula.ts` was not updated to match. This is the protocol-engineer-page version.
3. **Pyth feed misconfiguration.** The bound feed id points at a different asset than the threshold expects (e.g. SOL price feed bound to a BTC condition market).

**Diagnostic commands:**

```bash
# Which slab is rejecting?
curl -s localhost:9100/metrics | grep 'kind2_push_reject_total{reason="deviation"' | head -10

# What did we submit vs what does the chain expect? Read the slab's kind=2 fields.
solana account <SLAB> --output json-compact --output-file /tmp/slab.json
node -e 'const d=require("fs").readFileSync("/tmp/slab.json"); /* hand-decode pyth_threshold_e6 + pyth_scale_bps_per_pct via decodeKind2Fields */'

# Compare against the most recent Pyth observation.
curl -s localhost:9100/metrics | grep 'kind2_last_push_age_secs{slab="<SLAB>"'

# Pull the actual rejection log from a recent failed tx.
solana logs <PROGRAM_ID> | grep -A 2 -i 'deviation\|oracleinvalid'
```

**Remediation:**

- If diagnostic (1) — admin re-runs `SetKind2Threshold` / `SetKind2Scale` with the correct values. K3' resumes on its next tick.
- If diagnostic (2) — **stop the world.** Page protocol engineer; the K2' formula in `src/services/kind2-formula.ts` must be reconciled with the on-chain `handle_push_oracle_snapshot` before the keeper resumes. Until the fix lands, the rejecting market will eventually force-close itself at the captured TWAP — capital is not at immediate risk.
- If diagnostic (3) — the admin must `SetIndexFeedId` to the right feed, then the market must continue (or be force-closed early via a one-off `SetForceCloseTimestamp` to `now() + 60s`).

**Escalation:** Page protocol engineer immediately if (a) more than one market shows deviation rejections simultaneously, or (b) the rejecting market has any open positions. Single-market deviation on an empty market = ticket, not page.

### 3.2 last_push_age_secs > 300 — keeper degraded for that market

**Alert:** `max by (slab)(keeper_kind2_last_push_age_secs) > 300`.

**Symptom:** **Panel "Last push age per slab"** shows one or more series sustained above 60s (red threshold), 300s alert threshold breached. **Panel "Push outcomes (rate, 5m)"** Success line for the affected market is flat. Other markets push normally.

**Likely cause** (in order):

1. **Per-market backoff stuck.** Repeated transient submit errors pushed `nextEligibleMs` to `maxBackoffMs` (60s); the cranker keeps re-queueing but every attempt rejects. Often a downstream issue (`KeeperBudget` exhausted, blockhash cache stale).
2. **Pyth feed gone silent.** The bound `PriceUpdateV2` account is no longer being updated — Pyth pulled the feed, or the publishers all dropped offline.
3. **Watchdog also not firing.** Indicates LaserStream is feeding stale Pyth data to the cache and the 30s watchdog `getAccountInfo` is also failing.

**Diagnostic commands:**

```bash
# Which slab is degraded?
curl -s localhost:9100/metrics | grep 'kind2_last_push_age_secs' | awk '$2 > 300 {print $1, $2}'

# Pull the feed id for that slab, then check Pyth liveness directly.
solana account <SLAB> --output json-compact | head -c 4096
# Compute the PriceUpdateV2 PDA from the feed id; then:
solana account <PRICE_UPDATE_PDA> --output json-compact

# Check budget + blockhash cache aren't the bottleneck.
curl -s localhost:9100/metrics | grep -E 'keeper_budget_|blockhash_cache_'

# Force watchdog by restarting the leader (only if HA — promotes standby).
kubectl delete pod keeper-leader-0
```

**Remediation:**

- If diagnostic (1) — clear the per-market backoff by bouncing the leader pod (state is in-process, not persisted). After promotion the new leader's `MarketState` starts fresh.
- If diagnostic (2) — the market is unrecoverable until Pyth restores the feed. If the feed is permanently gone, the council must `SetForceCloseTimestamp` to `now() + 60s` to settle the market at the last good TWAP via K4'.
- If diagnostic (3) — page infra to check the LaserStream subscription, then bounce the leader.

**Escalation:** Page if more than 3 markets cross the 300s threshold simultaneously (system-wide issue, not per-market).

### 3.3 pyth_read_fail rate spike — Pyth network issue

**Alert:** `rate(keeper_kind2_pyth_read_fail_total[5m]) > 0.1`.

**Symptom:** Cluster-wide `keeper_kind2_pyth_read_fail_total` counter climbs. **Panel "Push outcomes (rate, 5m)"** Skip:`pyth_cache_miss` and Skip:`pyth_parse_fail` lines spike. `keeper_kind2_watchdog_fire_total` also climbs as the cranker compensates. Many markets' `last_push_age_secs` climb simultaneously.

**Likely cause** (in order):

1. **LaserStream subscription dropped.** Our Helius LaserStream feed stopped delivering `PriceUpdateV2` account updates — the `AccountCache` returns misses on every read.
2. **Pyth Receiver program redeployed.** The `getOwnerVerified` gate rejects accounts not owned by `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`. If Pyth changed the receiver program id, every read fails.
3. **Pyth-side outage.** Pyth itself is down or publishing malformed accounts.

**Diagnostic commands:**

```bash
# Is the watchdog compensating? If yes, LaserStream is the failure point.
curl -s localhost:9100/metrics | grep -E 'kind2_watchdog_fire_total|kind2_pyth_read_fail_total'

# Pyth public health.
curl -s https://hermes.pyth.network/api/latest_price_feeds?ids[]=<FEED_HEX> | jq '.[0].price.publish_time'

# Verify the receiver program id matches the constant in kind2-push-cranker.ts.
solana account rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ

# Sample one PriceUpdateV2 directly to confirm it parses.
solana account <PRICE_UPDATE_PDA> --output json | jq '.account.owner'
```

**Remediation:**

- If diagnostic (1) — restart the keeper to force a fresh LaserStream subscription. Page infra if it recurs within an hour.
- If diagnostic (2) — page protocol engineer; the constant `PYTH_RECEIVER_PROGRAM_ID` in `src/services/kind2-push-cranker.ts` needs updating with the new id. No hotfix available; markets will run on the watchdog (RPC fallback) until shipped.
- If diagnostic (3) — Pyth outages typically resolve within minutes. The watchdog `getAccountInfo` path will keep markets functional if RPC still has data. If Pyth is down for > 30 minutes, the protocol engineer may choose to mass-force-close affected markets at the last good TWAP.

**Escalation:** Always page Pyth's status channel and our infra on-call simultaneously for this alert. Customer-facing impact is high (all kind=2 markets affected at once).

### 3.4 Keeper failover (planned or unplanned)

`LeaderLock` promotes the standby via Redis lock takeover. The standby's already-seeded `Kind2Registry` means there is no cold-start scan — only `start()` on the cranks and metrics service. After promotion verify:

1. `curl -s localhost:8081/health | jq .role` returns `"leader"`.
2. `keeper_kind2_registry_size` matches the previous leader's value (registry was warm).
3. Within 5s, `keeper_kind2_push_attempt_total` rate goes non-zero (cranks resumed).
4. Within 30s, every `keeper_kind2_last_push_age_secs` series drops back below 30s.
5. A small Reject:`stale` blip is normal — cold-start watermarks vs warm on-chain ring. Reject:`deviation` after promotion is **not normal** — investigate per §3.1.

---

## 4. Teardown — market force-closes

When a market reaches `force_close_unix_timestamp + post-buffer + jitter`, the K4' cranker fires `ForceCloseKind2` (tag 88). Whether we won the race or another caller fired first, the result is the same: the on-chain slab's `forced_close_price_e6` flips from zero to the captured TWAP, and the slab is no longer actionable.

### 4.1 Expected sequence

1. **Panel "Force-close outcomes (rate, 5m)"** shows either a Success or Race-loss blip.
2. The next slab-account update arrives via the hot-path `AccountLoader.onAccount`. The registry's classifier returns non-`actionable` (because `forced_close_price_e6 != 0`).
3. `Kind2Registry.applyUpdate` calls `evict(slab, "decoder_reject")`. `keeper_kind2_registry_evict_total{reason="decoder_reject"}` increments.
4. `Kind2MetricsService` receives the `evict` event and calls `kind2LastPushAgeSecs.remove({ slab })` and `kind2TimeToForceCloseSecs.remove({ slab })` — both gauge series disappear from Prometheus.
5. `keeper_kind2_registry_size` decreases by 1.
6. **Panel "Last push age per slab"** stops rendering the slab.
7. **Panel "Time to force-close per slab"** stops rendering the slab.

### 4.2 Verification checklist

Within 60 seconds of the force-close confirming:

- [ ] `keeper_kind2_registry_size` decremented.
- [ ] `keeper_kind2_registry_evict_total` incremented.
- [ ] The slab no longer appears in `keeper_kind2_last_push_age_secs` (`curl -s localhost:9100/metrics | grep '<SLAB>'` returns nothing).
- [ ] `keeper_kind2_push_attempt_total` rate for that slab stops contributing to the cluster total.
- [ ] **Panel "Linked markets / force-close eligible"** matches the new count.

### 4.3 If the slab does NOT disappear

The hot-path `AccountLoader.onAccount` missed the post-force-close update. The reconcile loop (leader-only, 5-minute cadence) will catch this and increment `keeper_kind2_registry_reconcile_diffs_total{kind="missing_from_chain"}`. The diff counter being non-zero is itself a P1 — file a ticket noting which slab triggered it; the reconcile cycle self-heals the registry so no immediate operator action is required.

If after a full reconcile cycle (5+ minutes) the slab is still in the registry, force a manual reconcile by bouncing the leader pod — the standby promotes with a fresh `getProgramAccounts` seed.

---

## Known limitations

These are V1 design choices documented for the next engineer who reads "huh, why does it work this way?"

- **Force-close fires regardless of Polymarket resolution state.** The K4' cranker uses only the on-chain `force_close_unix_timestamp` gate. If Polymarket has not yet resolved when our timestamp elapses, we still settle the market — at whatever TWAP the ring captured. The council's responsibility is to set `force_close_unix_timestamp` far enough past expected resolution (≥7 days) that this race essentially never fires. The deferred V2 design hooks resolution-state into the gate.
- **TWAP, not last-trade.** We use a time-weighted average across the ring rather than the single most recent push because (a) the most-recent push is one keeper's view at one moment and can be manipulated by a well-timed adversarial submit, and (b) the ring's TWAP smooths over Pyth's per-slot price discontinuities. Cost: a sharp move in the final hours before force-close is partially smoothed away.
- **No haircut routing.** When `ForceCloseKind2` settles a market with insufficient ring depth, the on-chain handler currently distributes losses pro-rata to LPs. The deferred design routes haircuts to the insurance fund first, then LPs. The cranker does not need to know about this — it's a wrapper concern — but operators should be aware that LP loss-events on force-close are intentional, not a bug.
- **No on-chain hash attestation.** The K2' formula mirror in `src/services/kind2-formula.ts` is asserted equivalent to the on-chain formula by code review and test parity. The deferred design adds an on-chain hash of the formula's parameters (`pyth_threshold_e6`, `pyth_scale_bps_per_pct`, formula version) that the keeper reads and checks against a constant, fail-closing if they ever drift. Until then, our deviation-rejection alert (§3.1) is the only drift detector.
- **Hand-rolled tag-85 / tag-88 encoders.** The shipped `@percolatorct/sdk` (2.0.9) does not yet expose `encodePushOracleSnapshot` or `encodeForceCloseKind2`. Both encoders are isolated to one function each in `kind2-push-cranker.ts` and `kind2-force-close-cranker.ts` — the SDK swap will be a one-line change in each file when SDK 3.x ships.
- **Hand-rolled `decodeKind2Fields`.** Same reason — the SDK does not yet expose the kind=2 extension fields on `MarketConfig`. Lives in `src/services/kind2-decoder.ts` behind `KIND2_MIN_CONFIG_LEN = 1600`.
- **Per-market jitter is per-process, not persisted.** Each keeper samples its own random jitter for force-close dispatch. Two concurrent keepers on the same market get different jitter values (correct: collision avoidance) but a single keeper restart re-rolls (acceptable: the on-chain handler is idempotent under race-loss).
