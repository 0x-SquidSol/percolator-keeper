# kind=2 devnet smoke test — operator runbook

End-to-end on-chain bring-up of a Polymarket-perp (kind=2) market against a freshly deployed wrapper binary. Exercises every governance setter the V1 launch runbook calls in production order, populates the oracle ring with at least one Pyth-validated snapshot, then force-closes the market 48 hours later via the permissionless crank.

The smoke test runs in two phases separated by the wrapper's `MIN_FUTURE_SECS = 172_800` (48-hour) gap between configuring the force-close timestamp and the crank becoming eligible.

## Scope

In scope:
- All eight kind=2 wrapper handlers (tags 84–90) reachable in their bootstrap order.
- Pyth Pull oracle integration on devnet (BTC/USD feed by default).
- Council co-signing flow (Squads on mainnet → local keypair on devnet).
- Force-close TWAP capture and resolution transition.

Out of scope (deferred to Phase 8 full devnet trial):
- Trade path (matcher CPI). The smoke flow keeps the slab empty so the activation timelock + no-OI invariants stay simple.
- LP collateral, ADL, dispute, audit crank.
- Insurance fund interactions.

## Prerequisites

1. **Deployed wrapper binary on devnet.** The committed source must be built and deployed:
   ```
   cd percolator-prog
   cargo build-sbf
   solana program deploy --url devnet target/deploy/percolator_prog.so
   ```
   Note the program id that `solana program deploy` prints. Export it:
   ```
   export KIND2_PROGRAM_ID=<id-from-deploy>
   ```

2. **Payer keypair** with ≥ 8 SOL devnet (large tier rent ≈ 7.2 SOL + tx fees). Default path is `/tmp/deployer.json`; override via `DEPLOYER_KEYPAIR`.

3. **Helius devnet API key** for reliable RPC throughput. Export `HELIUS_DEVNET_API_KEY`. The scripts fall back to the public devnet RPC if unset, but Pyth account reads + transaction confirms can rate-limit.

4. **Live Pyth devnet feed.** Default is BTC/USD (`e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43`). Override via `KIND2_SMOKE_FEED_ID` if you want a different asset. Confirm the feed is publishing before starting:
   ```
   solana account --url devnet <derived-pyth-account>
   ```

5. **Slab tier** selected to match the deployed program's compiled `MAX_ACCOUNTS`. Default is `large` (4096 accounts) to match the historical devnet program. Override via `KIND2_SLAB_TIER=small|medium|large`.

## Phase 1 — Setup (~2 minutes)

Run the setup script:
```
KIND2_PROGRAM_ID=<id> \
HELIUS_DEVNET_API_KEY=<key> \
pnpm tsx scripts/kind2-smoke-setup.ts
```

What it does, in order:
1. Generates (or reuses) a council keypair → `kind2-smoke-council.json` and funds it with 0.1 SOL.
2. Creates an SPL mint, slab account, vault ATA, and seeds 1000 tokens into the vault.
3. `InitMarket` with the BTC/USD feed id → slab is created at `market_kind = 0` (legacy perp default).
4. `SetCouncilAuthority(council)` co-signed by admin + council → atomically binds the council pubkey AND lifts `market_kind` from 0 to 2. Per the 2026-06-04 wrapper fix this is the kind=2 init step.
5. `LinkPolymarketMarket` co-signed by admin + council, passing the derived Pyth `PriceUpdateV2` account → binds `polymarket_condition_id`, `oracle_source = 0` (Pyth), and `metadata_uri_hash`. Stamps `linked_at_slot`.
6. `SetPythPriceMapping` co-signed → writes `pyth_threshold_e6` pinned to the live BTC/USD price at run time, `pyth_scale_bps_per_pct = 1`, `value_deviation_bps = 500` (max tolerance, 5 %).
7. `SetForceCloseTimestamp` co-signed → writes `force_close_unix_timestamp = now + 48h + 5min`.
8. `PushOracleSnapshot(p_yes_e6 = 500_000)` signed by payer only → permissionless ring write. Threshold pinned to live price means the formula evaluates near `POLY_MID_E6 = 500_000`, so the 500-bps deviation guard passes.

Writes `kind2-smoke-state.json` with every pubkey + the force-close timestamp.

### Pass criteria (Phase 1)

Each step prints `✅` with a transaction signature. The state file ends with `forceCloseUnixTs` set to `now + ~48h`.

### Common failure modes (Phase 1)

| Symptom | Likely cause | Fix |
|---|---|---|
| `0x4 InvalidSlabLen` on InitMarket | `KIND2_SLAB_TIER` doesn't match the deployed program's compiled `MAX_ACCOUNTS` | Set `KIND2_SLAB_TIER` to match. The `large` default expects 4096. |
| `LinkPolymarketMarket: ...refuses market_kind=0...` | Deployed binary predates the fix where `SetCouncilAuthority` lifts kind 0→2 | Rebuild + redeploy `percolator-prog` at the latest integration-branch HEAD. |
| `validate_pyth_feed_account` reject | Wrong feed id, or the Pyth account doesn't exist on devnet | Verify `KIND2_SMOKE_FEED_ID` against [Pyth's published feed list](https://www.pyth.network/developers/price-feed-ids). Check the derived account exists. |
| `OracleStale` on PushOracleSnapshot | Pyth feed hasn't updated within `max_staleness_secs = 60` | Wait 30–60 s for the next Pyth tick and re-run only the push step manually. |
| `SetForceCloseTimestamp: ...< 172800 secs in future...` | Clock drift between client and devnet validators | Re-run the setup; the script computes the timestamp from local `Date.now()`. |

### Optional: boot the keeper against the new slab

Once setup completes, the K1' registry will discover the new kind=2 slab via its periodic scan or the LaserStream account-update stream. To exercise the K3'/K4'/K5' stack against it:
```
NETWORK=devnet \
PROGRAM_ID=<id> \
HELIUS_DEVNET_API_KEY=<key> \
pnpm dev
```
- The K3' push cranker should start submitting `PushOracleSnapshot` every ~500 ms (subject to Pyth `publish_time` advancing).
- The K4' force-close cranker will tick every 5 s and stay quiet until the force-close timestamp elapses.
- The K5' metrics dashboard panels `kind2_last_push_age_secs` and `kind2_time_to_force_close_secs` should show the slab.

Booting the keeper is not required for the smoke test to succeed — the setup script's single push is enough — but it validates the keeper's end-to-end wiring.

## The 48-hour wait

The wrapper's `MIN_FUTURE_SECS = 172_800` floor on `SetForceCloseTimestamp` is non-negotiable in V1; markets resolving sooner than 48 h are out of scope.

**Wall-clock wait.** Park the state file and the council keypair, then come back ≥ 48 h later. This is the production-realistic path and the only one the released binary supports — the wrapper hard-codes the floor and offers no test-mode escape hatch, so divergence between "what we test on devnet" and "what mainnet runs" is zero.

While waiting, monitor:
- `kind2_time_to_force_close_secs{slab}` in Grafana → counts down to 0 then goes negative.
- Periodic re-runs of `getAccountInfo` on the slab → confirm `config.force_close_unix_timestamp` and `config.linked_at_slot` are unchanged (no governance drift).

## Phase 2 — Force-close (~1 minute)

After `forceCloseUnixTs` has elapsed:
```
KIND2_PROGRAM_ID=<id> \
HELIUS_DEVNET_API_KEY=<key> \
pnpm tsx scripts/kind2-smoke-close.ts
```

What it does:
1. Loads `kind2-smoke-state.json`. Refuses to fire if `now < forceCloseUnixTs`.
2. Submits `ForceCloseKind2` signed by payer only (permissionless crank).
3. Prints the resolution signature.

### Pass criteria (Phase 2)

- `ForceCloseKind2 → <sig>` prints with no error.
- `solana account --url devnet --output json <slab>` after the call shows the slab's `MarketConfig.forced_close_price_e6` non-zero (the captured ring TWAP) and `engine.market_mode == Resolved`.

To decode the kind=2 fields directly off the slab buffer, re-use the close script's own sanity-check path — it parses `market_kind`, `force_close_unix_timestamp`, and `forced_close_price_e6` via the keeper's hand-rolled `decodeKind2Fields` and refuses to fire if the slab doesn't look right. A successful close run that prints `⚠ Slab already force-closed (forcedClosePriceE6=…)` is the same signal as a `getAccountInfo` decode.

### Common failure modes (Phase 2)

| Symptom | Likely cause | Fix |
|---|---|---|
| `ForceCloseKind2: not yet eligible` | Devnet validator clock lags wall clock | Wait 1–2 min and re-run. The wrapper reads `Clock` via syscall, not the local wall clock. |
| `already force-closed` | The crank already fired (the keeper's K4' service may have beat you to it) | Race-loss is success — the on-chain state is the goal. Verify via the parse one-liner above. |
| `OracleStale` / `OracleInvalid` from the TWAP capture | Ring is empty or all entries are too stale | Run a manual push first (re-run the relevant block in `kind2-smoke-setup.ts`), then retry. |

## Teardown

After verification:
1. `solana account --url devnet --output json <slab>` once, archive the output for the audit trail.
2. Optional — close the slab to recover rent. The slab is in `Resolved` mode with no users, so `CloseSlab` (tag 13) should accept it. Not part of the smoke test scope.
3. Delete `kind2-smoke-state.json` and `kind2-smoke-council.json` (devnet keys; not safe for reuse).

## Mainnet differences

Substitute on mainnet:
- Council = a Squads multisig pubkey. The smoke script's `kind2-smoke-council.json` is a local single-signer — for production, the council multisig signs each governance ix off-chain and the smoke flow becomes a multi-tx coordination.
- `force_close_unix_timestamp` is placed several hours before Polymarket's advertised UMA finalisation, not arbitrarily `now + 48h`.
- The 24-hour activation timelock between `LinkPolymarketMarket` (which stamps `linked_at_slot`) and the first user entry is a hard real-time wait. The smoke test sidesteps this by never entering a user — operators bringing up a real market do not have that luxury.
- Pyth feed id should be the asset the Polymarket market resolves on. Mismatched feed id is the single highest-blast-radius governance error; the council's diligence at `LinkPolymarketMarket` co-sign time is the protection.
