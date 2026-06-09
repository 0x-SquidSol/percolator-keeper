import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LeaderLock, RENEW_SCRIPT, RELEASE_SCRIPT } from "../../src/lib/leader.js";
import type { RedisLike } from "../../src/lib/redis-client.js";

// ─── Mock Redis ───────────────────────────────────────────────────────────────

type SetOpts = { ex: number; nx?: true } | { ex: number; xx?: true };

function makeMockRedis(): {
  redis: RedisLike;
  store: Map<string, string>;
  calls: { set: number; get: number; del: number; eval: number };
  failNext: { set?: boolean; get?: boolean };
} {
  const store = new Map<string, string>();
  const calls = { set: 0, get: 0, del: 0, eval: 0 };
  const failNext = { set: false, get: false };

  const redis: RedisLike = {
    async set(key: string, value: string, opts: SetOpts): Promise<"OK" | null> {
      calls.set++;
      if (failNext.set) { failNext.set = false; throw new Error("Redis error"); }
      const hasNx = "nx" in opts && opts.nx === true;
      const hasXx = "xx" in opts && (opts as { xx?: true }).xx === true;
      if (hasNx && store.has(key)) return null;
      if (hasXx && !store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async get(key: string): Promise<string | null> {
      calls.get++;
      if (failNext.get) { failNext.get = false; throw new Error("Redis error"); }
      return store.get(key) ?? null;
    },
    async del(...keys: string[]): Promise<number> {
      calls.del++;
      let count = 0;
      for (const k of keys) {
        if (store.delete(k)) count++;
      }
      return count;
    },
    // Faithful CAS emulation of the two scripts the lock ships (matched by the
    // exact exported strings, so the fake can't silently diverge from prod).
    async eval<T = unknown>(script: string, keys: string[], args: (string | number)[]): Promise<T> {
      calls.eval++;
      const key = keys[0];
      const identity = String(args[0]);
      const owns = store.get(key) === identity;
      if (script === RENEW_SCRIPT) return (owns ? 1 : 0) as T;           // TTL refresh is a no-op in the fake
      if (script === RELEASE_SCRIPT) { if (owns) store.delete(key); return (owns ? 1 : 0) as T; }
      throw new Error(`unexpected script in fake: ${script}`);
    },
  };

  return { redis, store, calls, failNext };
}

// ─── Unit tests: state machine ────────────────────────────────────────────────

describe("LeaderLock state machine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts in 'starting' role before start() is called", () => {
    const { redis } = makeMockRedis();
    const lock = new LeaderLock(redis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    expect(lock.role()).toBe("starting");
  });

  it("promotes to leader when lock is free", async () => {
    const { redis } = makeMockRedis();
    const lock = new LeaderLock(redis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const onPromote = vi.fn();
    const onDemote = vi.fn();

    lock.start({ network: "devnet", onPromote, onDemote });
    await vi.advanceTimersByTimeAsync(100);

    expect(lock.role()).toBe("leader");
    expect(onPromote).toHaveBeenCalledOnce();
    expect(onDemote).not.toHaveBeenCalled();

    await lock.stop();
  });

  it("enters standby when another leader holds the lock", async () => {
    const { redis, store } = makeMockRedis();
    store.set("keeper:leader:devnet", "other-keeper-id");

    const lock = new LeaderLock(redis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const onPromote = vi.fn();
    const onDemote = vi.fn();

    lock.start({ network: "devnet", onPromote, onDemote });
    await vi.advanceTimersByTimeAsync(100);

    expect(lock.role()).toBe("standby");
    expect(onPromote).not.toHaveBeenCalled();
    expect(onDemote).not.toHaveBeenCalled();

    await lock.stop();
  });

  it("standby promotes when leader releases lock", async () => {
    const { redis, store } = makeMockRedis();
    store.set("keeper:leader:devnet", "other-keeper-id");

    const lock = new LeaderLock(redis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const onPromote = vi.fn();
    const onDemote = vi.fn();

    lock.start({ network: "devnet", onPromote, onDemote });
    await vi.advanceTimersByTimeAsync(100);

    expect(lock.role()).toBe("standby");

    store.delete("keeper:leader:devnet");

    // Advance past pollMs (5000ms)
    await vi.advanceTimersByTimeAsync(6_000);

    expect(lock.role()).toBe("leader");
    expect(onPromote).toHaveBeenCalledOnce();

    await lock.stop();
  });

  it("leader renews lock on schedule (via CAS eval, not SET)", async () => {
    const { redis, calls } = makeMockRedis();
    const lock = new LeaderLock(redis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const onPromote = vi.fn();
    const onDemote = vi.fn();

    lock.start({ network: "devnet", onPromote, onDemote });
    await vi.advanceTimersByTimeAsync(100);

    const evalCountAfterPromote = calls.eval; // 0 — acquire uses SET NX, not eval
    const setCountAfterPromote = calls.set;
    expect(lock.role()).toBe("leader");

    await vi.advanceTimersByTimeAsync(10_100);
    expect(calls.eval).toBeGreaterThan(evalCountAfterPromote); // renew is a CAS eval
    expect(calls.set).toBe(setCountAfterPromote);              // renew never re-SETs the value
    expect(lock.role()).toBe("leader");

    await lock.stop();
  });

  it("demotes after two consecutive renew failures", async () => {
    const mockRedis: RedisLike = {
      async set(_key: string, _value: string, opts: SetOpts): Promise<"OK" | null> {
        const hasNx = "nx" in opts && opts.nx === true;
        return hasNx ? "OK" : null; // acquire succeeds
      },
      async get(_key: string): Promise<string | null> { return null; },
      async del(..._keys: string[]): Promise<number> { return 0; },
      // renew/release fail with a transport error (ambiguous → 2-strike demote)
      async eval<T = unknown>(): Promise<T> { throw new Error("Redis connection refused"); },
    };

    const lock = new LeaderLock(mockRedis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const onPromote = vi.fn();
    const onDemote = vi.fn();

    lock.start({ network: "devnet", onPromote, onDemote });
    await vi.advanceTimersByTimeAsync(100);

    expect(lock.role()).toBe("leader");
    expect(onPromote).toHaveBeenCalledOnce();

    // First renew failure
    await vi.advanceTimersByTimeAsync(10_100);
    expect(lock.role()).toBe("leader");
    expect(onDemote).not.toHaveBeenCalled();

    // Second renew failure triggers demotion
    await vi.advanceTimersByTimeAsync(10_100);
    expect(lock.role()).toBe("standby");
    expect(onDemote).toHaveBeenCalledWith("redis-renew-failed");
  });

  it("standby poll error does NOT promote (fail-safe)", async () => {
    let pollCallCount = 0;
    const { redis, store } = makeMockRedis();
    store.set("keeper:leader:devnet", "other-id");

    const mockRedis: RedisLike = {
      set: redis.set.bind(redis),
      del: redis.del.bind(redis),
      async get(key: string): Promise<string | null> {
        pollCallCount++;
        if (pollCallCount <= 2) throw new Error("network partition");
        return redis.get(key);
      },
    };

    const lock = new LeaderLock(mockRedis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const onPromote = vi.fn();
    const onDemote = vi.fn();

    lock.start({ network: "devnet", onPromote, onDemote });
    await vi.advanceTimersByTimeAsync(100);

    expect(lock.role()).toBe("standby");

    // Poll errors — must stay standby
    await vi.advanceTimersByTimeAsync(5_100);
    expect(lock.role()).toBe("standby");
    expect(onPromote).not.toHaveBeenCalled();

    await lock.stop();
  });

  it("stop() releases the key (via CAS) when leader", async () => {
    const { redis, store } = makeMockRedis();
    const lock = new LeaderLock(redis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const onPromote = vi.fn();
    const onDemote = vi.fn();

    lock.start({ network: "devnet", onPromote, onDemote });
    await vi.advanceTimersByTimeAsync(100);

    expect(lock.role()).toBe("leader");
    expect(store.has("keeper:leader:devnet")).toBe(true);

    await lock.stop();

    expect(store.has("keeper:leader:devnet")).toBe(false);
    expect(lock.role()).toBe("standby");
  });

  it("stop() when standby does not call del", async () => {
    const { redis, store, calls } = makeMockRedis();
    store.set("keeper:leader:devnet", "other-id");

    const lock = new LeaderLock(redis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    lock.start({ network: "devnet", onPromote: vi.fn(), onDemote: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);

    expect(lock.role()).toBe("standby");

    await lock.stop();
    expect(calls.del).toBe(0);
  });

  it("demotes immediately when renew CAS reports not-owner (lock stolen)", async () => {
    const mockRedis: RedisLike = {
      async get(_key: string): Promise<string | null> { return null; },
      async del(..._keys: string[]): Promise<number> { return 0; },
      async set(_key: string, _value: string, opts: SetOpts): Promise<"OK" | null> {
        const hasNx = "nx" in opts && opts.nx === true;
        return hasNx ? "OK" : null; // acquire succeeds
      },
      // CAS renew returns 0 = "not the owner" → definitive loss, demote at once.
      async eval<T = unknown>(): Promise<T> { return 0 as T; },
    };

    const lock = new LeaderLock(mockRedis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const onDemote = vi.fn();
    lock.start({ network: "devnet", onPromote: vi.fn(), onDemote });
    await vi.advanceTimersByTimeAsync(100);

    expect(lock.role()).toBe("leader");

    await vi.advanceTimersByTimeAsync(10_100);

    expect(lock.role()).toBe("standby");
    expect(onDemote).toHaveBeenCalledWith("redis-lock-lost");
  });

  it("lock key includes the network name", async () => {
    const { redis, store } = makeMockRedis();
    const lock = new LeaderLock(redis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    lock.start({ network: "mainnet", onPromote: vi.fn(), onDemote: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);

    expect(store.has("keeper:leader:mainnet")).toBe(true);
    expect(store.has("keeper:leader:devnet")).toBe(false);

    await lock.stop();
  });

  it("renews via the CAS eval script (never a blind SET XX)", async () => {
    const setOpts: Array<SetOpts> = [];
    const evalScripts: string[] = [];
    const store = new Map<string, string>();
    const mockRedis: RedisLike = {
      async get(key: string): Promise<string | null> { return store.get(key) ?? null; },
      async del(..._keys: string[]): Promise<number> { return 0; },
      async set(key: string, value: string, opts: SetOpts): Promise<"OK" | null> {
        setOpts.push(opts);
        const hasNx = "nx" in opts && opts.nx === true;
        if (hasNx && store.has(key)) return null;
        store.set(key, value);
        return "OK";
      },
      async eval<T = unknown>(script: string, keys: string[], args: (string | number)[]): Promise<T> {
        evalScripts.push(script);
        return (store.get(keys[0]) === String(args[0]) ? 1 : 0) as T;
      },
    };

    const lock = new LeaderLock(mockRedis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    lock.start({ network: "devnet", onPromote: vi.fn(), onDemote: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(10_100);

    // Acquire used SET NX exactly once; renew used the CAS eval, never an XX SET.
    expect(evalScripts).toContain(RENEW_SCRIPT);
    expect(setOpts.every((o) => !("xx" in o))).toBe(true);

    await lock.stop();
  });

  it("demotes when the renew Redis call hangs past renewTimeoutMs (liveness)", async () => {
    const mockRedis: RedisLike = {
      async get(): Promise<string | null> { return null; },
      async del(): Promise<number> { return 0; },
      async set(_key: string, _value: string, opts: SetOpts): Promise<"OK" | null> {
        return "nx" in opts && opts.nx === true ? "OK" : null;
      },
      // renew/release never resolve — simulates a hung Upstash REST call.
      eval<T = unknown>(): Promise<T> { return new Promise<T>(() => {}); },
    };

    const lock = new LeaderLock(mockRedis, "test-id", {
      ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000, renewTimeoutMs: 3_000,
    });
    const onDemote = vi.fn();
    lock.start({ network: "devnet", onPromote: vi.fn(), onDemote });
    await vi.advanceTimersByTimeAsync(100);
    expect(lock.role()).toBe("leader");

    // Two renew cycles, each timing out at renewTimeoutMs → 2-strike demote.
    await vi.advanceTimersByTimeAsync(30_000);

    expect(lock.role()).toBe("standby");
    expect(onDemote).toHaveBeenCalledWith("redis-renew-failed");
  });

  it("initial acquire error falls back to standby gracefully", async () => {
    const mockRedis: RedisLike = {
      async set(): Promise<"OK" | null> { throw new Error("connection refused"); },
      async get(): Promise<string | null> { return "other"; },
      async del(): Promise<number> { return 0; },
    };

    const lock = new LeaderLock(mockRedis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const onPromote = vi.fn();
    const onDemote = vi.fn();

    lock.start({ network: "devnet", onPromote, onDemote });
    await vi.advanceTimersByTimeAsync(100);

    expect(lock.role()).toBe("standby");
    expect(onPromote).not.toHaveBeenCalled();

    await lock.stop();
  });
});

// ─── Chaos tests ─────────────────────────────────────────────────────────────

describe("LeaderLock chaos (STRESS=true)", { skip: process.env.STRESS !== "true" }, () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("failover completes in < 35s p99 when leader is killed", async () => {
    const { redis } = makeMockRedis();

    const leader = new LeaderLock(redis, "leader-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const standby = new LeaderLock(redis, "standby-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });

    const leaderPromote = vi.fn();
    const standbyPromote = vi.fn();

    leader.start({ network: "devnet", onPromote: leaderPromote, onDemote: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);

    standby.start({ network: "devnet", onPromote: standbyPromote, onDemote: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);

    expect(leader.role()).toBe("leader");
    expect(standby.role()).toBe("standby");

    const killTime = Date.now();
    // Graceful kill: release lock immediately
    await leader.stop();

    // Standby should pick up within pollMs (5s) + processing time
    await vi.advanceTimersByTimeAsync(6_000);

    const elapsedMs = Date.now() - killTime;
    expect(standby.role()).toBe("leader");
    expect(standbyPromote).toHaveBeenCalledOnce();
    expect(elapsedMs).toBeLessThan(35_000);
  });

  it("network partition: standby stays in standby (does not split-brain)", async () => {
    const { redis, store } = makeMockRedis();

    const leader = new LeaderLock(redis, "leader-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    leader.start({ network: "devnet", onPromote: vi.fn(), onDemote: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);

    expect(leader.role()).toBe("leader");

    // Standby with partitioned network: get() always throws
    const partitioned: RedisLike = {
      set: redis.set.bind(redis),
      del: redis.del.bind(redis),
      async get(): Promise<string | null> {
        throw new Error("network partition");
      },
    };

    const standbyPartitioned = new LeaderLock(partitioned, "standby-id", {
      ttlMs: 30_000,
      renewMs: 10_000,
      pollMs: 5_000,
    });
    const standbyPromote = vi.fn();
    standbyPartitioned.start({ network: "devnet", onPromote: standbyPromote, onDemote: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);

    // Advance well past TTL — standby must NOT take over
    await vi.advanceTimersByTimeAsync(60_000);

    expect(standbyPartitioned.role()).toBe("standby");
    expect(standbyPromote).not.toHaveBeenCalled();
    expect(leader.role()).toBe("leader");

    await leader.stop();
    await standbyPartitioned.stop();
  });

  // A.6: SIGKILL / ungraceful death path — leader dies without calling stop(),
  // so the Redis lock is NOT explicitly DEL'd; standby must wait until the
  // TTL elapses for Redis to expire it, then promote on the next poll cycle.
  // The existing "failover < 35s" test simulates graceful kill; this one
  // simulates the real-world process-killed-by-OOM case.
  it("A.6: failover within ttlMs+pollMs when leader dies ungracefully (SIGKILL)", async () => {
    const { redis, store } = makeMockRedis();
    const TTL = 30_000;
    const POLL = 5_000;
    const KEY = "keeper:leader:devnet";

    const leader = new LeaderLock(redis, "leader-id", {
      ttlMs: TTL,
      renewMs: 10_000,
      pollMs: POLL,
    });
    const standby = new LeaderLock(redis, "standby-id", {
      ttlMs: TTL,
      renewMs: 10_000,
      pollMs: POLL,
    });

    const standbyPromote = vi.fn();
    leader.start({ network: "devnet", onPromote: vi.fn(), onDemote: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);
    standby.start({ network: "devnet", onPromote: standbyPromote, onDemote: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);

    expect(leader.role()).toBe("leader");
    expect(standby.role()).toBe("standby");
    expect(store.has(KEY)).toBe(true);

    // Ungraceful death: kill the leader's timers without releasing the lock.
    // The lock entry stays in Redis until its TTL expires server-side.
    (leader as { _clearTimers(): void })._clearTimers();
    const deathTime = Date.now();

    // Mock store does not auto-expire on `ex`, so simulate the TTL by deleting
    // the key at the moment Redis would have expired it.
    await vi.advanceTimersByTimeAsync(TTL);
    store.delete(KEY);

    // Standby's next poll happens within pollMs; allow that window plus a
    // small tick for async settlement.
    await vi.advanceTimersByTimeAsync(POLL + 500);

    expect(standby.role()).toBe("leader");
    expect(standbyPromote).toHaveBeenCalledOnce();
    const elapsedMs = Date.now() - deathTime;
    expect(elapsedMs).toBeLessThanOrEqual(TTL + POLL + 1_000);

    await standby.stop();
  });

  it("split-brain: two instances starting concurrently, only one wins", async () => {
    const { redis } = makeMockRedis();

    const lockA = new LeaderLock(redis, "node-a", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const lockB = new LeaderLock(redis, "node-b", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });

    const promoteA = vi.fn();
    const promoteB = vi.fn();

    lockA.start({ network: "devnet", onPromote: promoteA, onDemote: vi.fn() });
    lockB.start({ network: "devnet", onPromote: promoteB, onDemote: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);

    const leaders = [lockA, lockB].filter(l => l.role() === "leader");
    const standbys = [lockA, lockB].filter(l => l.role() === "standby");

    expect(leaders).toHaveLength(1);
    expect(standbys).toHaveLength(1);
    expect(promoteA.mock.calls.length + promoteB.mock.calls.length).toBe(1);

    await lockA.stop();
    await lockB.stop();
  });
});

// ─── Integration test (real Upstash) ─────────────────────────────────────────

describe("LeaderLock integration (INTEGRATION=true)", { skip: process.env.INTEGRATION !== "true" }, () => {
  it("acquires and releases real Upstash lock", async () => {
    const { getRedisClient } = await import("../../src/lib/redis-client.js");
    const redis = getRedisClient();
    if (!redis) throw new Error("KEEPER_REDIS_URL must be set for integration tests");

    const lock = new LeaderLock(redis, `integration-test-${Date.now()}`, {
      ttlMs: 10_000,
      renewMs: 4_000,
      pollMs: 2_000,
    });

    const promoted = await new Promise<boolean>((resolve) => {
      lock.start({
        network: "integration-test",
        onPromote: () => resolve(true),
        onDemote: () => {},
      });
      setTimeout(() => resolve(false), 5_000);
    });

    expect(promoted).toBe(true);
    expect(lock.role()).toBe("leader");

    await lock.stop();
    expect(lock.role()).toBe("standby");
  }, 15_000);
});
