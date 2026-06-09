/**
 * Regression for the leader-lock split-brain (HIGH) — was the PoC that proved it.
 *
 * Before the fix: `_renew()` did a blind `SET key value XX` that renewed against
 * ANY existing holder, so a stalled-then-resumed leader stole the lock back and
 * both nodes stayed leader. `stop()` did an unconditional `DEL`.
 *
 * After the fix: renew/release are atomic compare-and-set scripts (renew only if
 * value == identity; delete only if value == identity). These tests assert the
 * scenario that previously split-brained now DEMOTES the stale node and leaves
 * the rightful holder's lock intact.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@percolatorct/shared", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { LeaderLock, RENEW_SCRIPT, RELEASE_SCRIPT } from "../../src/lib/leader.js";
import type { RedisLike } from "../../src/lib/redis-client.js";

/** Minimal Redis honoring nx/xx/ex + the lock's two CAS scripts. TTL is manual. */
class FakeRedis implements RedisLike {
  store = new Map<string, string>();

  async set(
    key: string,
    value: string,
    opts: { ex: number; nx?: true } | { ex: number; xx?: true },
  ): Promise<"OK" | null> {
    const exists = this.store.has(key);
    if ("nx" in opts && opts.nx && exists) return null;
    if ("xx" in opts && opts.xx && !exists) return null;
    this.store.set(key, value);
    return "OK";
  }
  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n++;
    return n;
  }
  async eval<T = unknown>(script: string, keys: string[], args: (string | number)[]): Promise<T> {
    const key = keys[0];
    const identity = String(args[0]);
    const owns = this.store.get(key) === identity;
    if (script === RENEW_SCRIPT) return (owns ? 1 : 0) as T;
    if (script === RELEASE_SCRIPT) { if (owns) this.store.delete(key); return (owns ? 1 : 0) as T; }
    throw new Error(`unexpected script: ${script}`);
  }
  /** Simulate the lock's TTL lapsing (Redis evicting the key) while a node stalls. */
  expire(key: string): void {
    this.store.delete(key);
  }
}

const OPTS = { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000, renewTimeoutMs: 3_000 };
const LOCK_KEY = "keeper:leader:test";

describe("regression: leader lock no longer split-brains (CAS renew/release)", () => {
  let redis: FakeRedis;

  beforeEach(() => {
    vi.useFakeTimers();
    redis = new FakeRedis();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a stalled-then-resumed leader detects the loss and DEMOTES — no split-brain", async () => {
    const demoteA = vi.fn();
    const nodeA = new LeaderLock(redis, "node-A", OPTS);
    const nodeB = new LeaderLock(redis, "node-B", OPTS);

    nodeA.start({ network: "test", onPromote: () => {}, onDemote: demoteA });
    await vi.advanceTimersByTimeAsync(0);
    expect(nodeA.role()).toBe("leader");

    nodeB.start({ network: "test", onPromote: () => {}, onDemote: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(nodeB.role()).toBe("standby");

    // A stalls; its TTL lapses (Redis evicts the key) before its renew fires.
    redis.expire(LOCK_KEY);

    // B's poll legitimately acquires the lock.
    await vi.advanceTimersByTimeAsync(OPTS.pollMs);
    expect(nodeB.role()).toBe("leader");
    expect(redis.store.get(LOCK_KEY)).toBe("node-B");

    // A resumes; its renew CAS finds the value is "node-B" (not "node-A") → returns 0.
    await vi.advanceTimersByTimeAsync(OPTS.renewMs - OPTS.pollMs);

    // FIXED: A demotes instead of stealing the lock back.
    expect(nodeA.role()).toBe("standby");
    expect(demoteA).toHaveBeenCalledWith("redis-lock-lost");
    // B keeps sole ownership — A never overwrote it.
    expect(redis.store.get(LOCK_KEY)).toBe("node-B");
    // And only one node is leader.
    expect([nodeA, nodeB].filter((n) => n.role() === "leader")).toHaveLength(1);

    await nodeA.stop();
    await nodeB.stop();
  });

  it("stop() on a stale leader does NOT delete a lock another node owns", async () => {
    const nodeA = new LeaderLock(redis, "node-A", OPTS);

    nodeA.start({ network: "test", onPromote: () => {}, onDemote: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(nodeA.role()).toBe("leader");

    // A's TTL lapsed and node B legitimately took the lock.
    redis.store.set(LOCK_KEY, "node-B");

    // A is still a stale in-memory leader. CAS release deletes only if it still
    // owns the key — so B's lock survives.
    await nodeA.stop();
    expect(redis.store.get(LOCK_KEY)).toBe("node-B");
  });
});
