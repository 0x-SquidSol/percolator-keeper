import os from "node:os";
import { createLogger } from "@percolatorct/shared";
import type { RedisLike } from "./redis-client.js";

const logger = createLogger("keeper:leader");

export type LeaderRole = "leader" | "standby" | "starting";

/**
 * Atomic compare-and-set scripts. The lock VALUE is this node's identity, so
 * these only mutate the key when the caller still owns it — closing the
 * split-brain window where a stalled-then-resumed leader's blind `SET XX` renew
 * (or unconditional `DEL`) would clobber a lock a standby legitimately took.
 *
 * Renew uses `pexpire` (refresh TTL, value untouched) so even renew can never
 * rewrite a foreign value. Exported so test fakes execute the exact same logic.
 */
export const RENEW_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('pexpire', KEYS[1], ARGV[2]); return 1 else return 0 end";
export const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export interface LeaderLockOptions {
  ttlMs?: number;
  renewMs?: number;
  pollMs?: number;
  /** Per-call timeout for renew/release Redis ops; a hung Redis demotes instead of stranding a stale leader. */
  renewTimeoutMs?: number;
}

export interface StartOptions {
  network: string;
  onPromote: () => void;
  onDemote: (reason: string) => void;
}

export class LeaderLock {
  private readonly redis: RedisLike;
  private readonly identity: string;
  private readonly ttlMs: number;
  private readonly renewMs: number;
  private readonly pollMs: number;
  private readonly renewTimeoutMs: number;

  private _role: LeaderRole = "starting";
  private _renewTimer: NodeJS.Timeout | null = null;
  private _pollTimer: NodeJS.Timeout | null = null;
  private _renewFailures = 0;
  private _lockKey = "";
  private _onDemote: ((reason: string) => void) | null = null;

  constructor(redis: RedisLike, identity: string, opts: LeaderLockOptions = {}) {
    this.redis = redis;
    this.identity = identity;
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.renewMs = opts.renewMs ?? 10_000;
    this.pollMs = opts.pollMs ?? 5_000;
    // Strictly below renewMs so a timed-out renew still leaves room for the
    // 2-strike retry before the TTL lapses.
    this.renewTimeoutMs = opts.renewTimeoutMs ?? Math.min(Math.floor(this.renewMs / 2), 5_000);
  }

  private async _withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`redis op timed out after ${ms}ms`)), ms);
      timer.unref?.();
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  role(): LeaderRole {
    return this._role;
  }

  start(opts: StartOptions): void {
    this._lockKey = `keeper:leader:${opts.network}`;
    this._onDemote = opts.onDemote;

    logger.info("LeaderLock starting", {
      identity: this.identity,
      lockKey: this._lockKey,
      ttlMs: this.ttlMs,
      renewMs: this.renewMs,
      pollMs: this.pollMs,
    });

    void this._tryAcquire(opts);
  }

  async stop(): Promise<void> {
    this._clearTimers();

    if (this._role === "leader") {
      try {
        // Compare-and-delete: release only if we still own the lock. An
        // unconditional `del` from a stale leader would wipe a lock a new
        // leader currently holds.
        const deleted = Number(
          await this._withTimeout(
            this.redis.eval(RELEASE_SCRIPT, [this._lockKey], [this.identity]),
            this.renewTimeoutMs,
          ),
        );
        logger.info("LeaderLock released (graceful stop)", { identity: this.identity, deleted });
      } catch (err) {
        logger.warn("LeaderLock release failed during stop", {
          identity: this.identity,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this._role = "standby";
  }

  private async _tryAcquire(opts: StartOptions): Promise<void> {
    const ttlSec = Math.ceil(this.ttlMs / 1000);

    try {
      const result = await this.redis.set(this._lockKey, this.identity, { ex: ttlSec, nx: true } as { ex: number; nx: true });

      if (result === "OK") {
        this._promote(opts);
      } else {
        this._enterStandby(opts);
      }
    } catch (err) {
      logger.warn("LeaderLock initial acquire error — entering standby", {
        identity: this.identity,
        error: err instanceof Error ? err.message : String(err),
      });
      this._enterStandby(opts);
    }
  }

  private _promote(opts: StartOptions): void {
    this._role = "leader";
    this._renewFailures = 0;
    logger.info("LeaderLock promoted to leader", { identity: this.identity });
    opts.onPromote();
    this._scheduleRenew(opts);
  }

  private _scheduleRenew(opts: StartOptions): void {
    this._renewTimer = setTimeout(async () => {
      await this._renew(opts);
    }, this.renewMs);
    this._renewTimer.unref?.();
  }

  private async _renew(opts: StartOptions): Promise<void> {
    if (this._role !== "leader") return;

    try {
      // Compare-and-set: refresh the TTL only if we still own the key. A blind
      // `SET XX` here would succeed against ANY holder and let a stalled-then-
      // resumed leader silently steal the lock back (split-brain).
      const owned = Number(
        await this._withTimeout(
          this.redis.eval(RENEW_SCRIPT, [this._lockKey], [this.identity, this.ttlMs]),
          this.renewTimeoutMs,
        ),
      );

      if (owned === 1) {
        this._renewFailures = 0;
        this._scheduleRenew(opts);
      } else {
        // CAS proved we are NO LONGER the owner — a standby legitimately took the
        // lock while we stalled. Definitive loss: demote immediately, do not
        // retry, do not touch the key (the new leader owns it).
        logger.warn("LeaderLock renew: no longer owner (lock lost) — demoting", {
          identity: this.identity,
        });
        this._demote("redis-lock-lost");
      }
    } catch (err) {
      // Transport error OR timeout — ambiguous (we may still own it). Keep the
      // 2-strike tolerance so a single blip doesn't cause needless failover, but
      // demote on the second so a hung Redis can't strand a stale leader past TTL.
      this._renewFailures++;
      logger.warn("LeaderLock renew error", {
        identity: this.identity,
        renewFailures: this._renewFailures,
        error: err instanceof Error ? err.message : String(err),
      });

      if (this._renewFailures >= 2) {
        logger.error("LeaderLock renew failed twice — demoting", { identity: this.identity });
        this._demote("redis-renew-failed");
      } else {
        this._scheduleRenew(opts);
      }
    }
  }

  private _enterStandby(opts: StartOptions): void {
    this._role = "standby";
    logger.info("LeaderLock entering standby", { identity: this.identity });
    this._schedulePoll(opts);
  }

  private _schedulePoll(opts: StartOptions): void {
    this._pollTimer = setTimeout(async () => {
      await this._poll(opts);
    }, this.pollMs);
    this._pollTimer.unref?.();
  }

  private async _poll(opts: StartOptions): Promise<void> {
    if (this._role !== "standby") return;

    try {
      const current = await this.redis.get(this._lockKey);

      if (current === null) {
        const ttlSec = Math.ceil(this.ttlMs / 1000);
        const result = await this.redis.set(this._lockKey, this.identity, { ex: ttlSec, nx: true } as { ex: number; nx: true });
        if (result === "OK") {
          this._promote(opts);
          return;
        }
      }

      this._schedulePoll(opts);
    } catch (err) {
      logger.warn("LeaderLock standby poll error — staying in standby (fail-safe)", {
        identity: this.identity,
        error: err instanceof Error ? err.message : String(err),
      });
      this._schedulePoll(opts);
    }
  }

  private _demote(reason: string): void {
    if (this._role !== "leader") return;
    this._role = "standby";
    this._clearTimers();
    logger.warn("LeaderLock demoted", { identity: this.identity, reason });
    this._onDemote?.(reason);
  }

  private _clearTimers(): void {
    if (this._renewTimer) {
      clearTimeout(this._renewTimer);
      this._renewTimer = null;
    }
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }
}

export function makeIdentity(): string {
  return `${os.hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}
