/**
 * Atomic counter for the free-render program (FEEDBACK-V1.md § The 200-
 * render counter).
 *
 * Backed by Upstash Redis (REST API). Three operations:
 *   - readCounter(): returns { remaining, refillCount } for the public endpoint
 *   - decrementCounter(): atomic DECR after a successful free render
 *   - refillCounter(by): admin-only INCRBY, exposed via /api/admin/refill
 *
 * Env var detection:
 *   We accept either of the two naming schemes Vercel injects depending on
 *   which marketplace integration version provisioned the Redis instance:
 *     - KV_REST_API_URL + KV_REST_API_TOKEN          (legacy Vercel KV pattern)
 *     - UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN  (current Upstash pattern)
 *   Either pair works; we read whichever is set.
 *
 * Graceful degrade: if NEITHER pair is set (Redis not provisioned yet),
 * all three operations return null / refuse to act. The route handlers
 * interpret null as "counter unavailable" and turn the free-render
 * surface off until provisioning lands. Lets the code ship + deploy
 * before Redis is created in the dashboard; the moment env vars land,
 * the counter starts working with zero code changes.
 */

import { Redis } from "@upstash/redis";

const REMAINING_KEY = "vibeify:free-renders:remaining";
const REFILL_COUNT_KEY = "vibeify:free-renders:refill-count";

/**
 * Resolve Upstash Redis credentials from either env-var naming scheme.
 * Returns null if neither pair is present.
 */
function getRedisCreds(): { url: string; token: string } | null {
  const url =
    process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

/**
 * Build a cached Redis client. Returns null if creds aren't set so the
 * caller can degrade without exception throws.
 */
let cachedClient: Redis | null = null;
function client(): Redis | null {
  if (cachedClient) return cachedClient;
  const creds = getRedisCreds();
  if (!creds) return null;
  cachedClient = new Redis({ url: creds.url, token: creds.token });
  return cachedClient;
}

export type CounterState = {
  /** Remaining free renders in the current cycle. Decrements after each free render. */
  remaining: number;
  /** How many times the admin endpoint has been called to top up. */
  refillCount: number;
};

/**
 * Read the public counter state. Returns null if Redis is not
 * provisioned (route handlers interpret this as "free-render program off").
 */
export async function readCounter(): Promise<CounterState | null> {
  const c = client();
  if (!c) return null;
  try {
    const [remaining, refillCount] = await Promise.all([
      c.get<number>(REMAINING_KEY),
      c.get<number>(REFILL_COUNT_KEY),
    ]);
    return {
      remaining: typeof remaining === "number" ? remaining : 0,
      refillCount: typeof refillCount === "number" ? refillCount : 0,
    };
  } catch (e) {
    console.error(
      `[free-render-counter] read failed:`,
      (e as Error).message
    );
    return null;
  }
}

/**
 * Atomically decrement the counter. Returns the NEW value of remaining
 * after the decrement, or null if Redis is unavailable / decrement failed.
 *
 * The route handler MUST call this AFTER the render succeeds — if it
 * fails before render, the counter would burn off-budget renders.
 */
export async function decrementCounter(): Promise<number | null> {
  const c = client();
  if (!c) return null;
  try {
    const newValue = await c.decr(REMAINING_KEY);
    return typeof newValue === "number" ? newValue : null;
  } catch (e) {
    console.error(
      `[free-render-counter] decrement failed:`,
      (e as Error).message
    );
    return null;
  }
}

/**
 * Admin-only SET — overrides the remaining counter to an exact value
 * (atomic Redis SET, not INCR). Used when refillCounter() was called
 * by mistake, or for marketing dial-ups to a specific count. Does NOT
 * touch the refill-count metric since it's not a refill — it's a
 * correction.
 *
 * Caller is responsible for authorization. Returns the new state, or
 * null on failure.
 */
export async function setCounter(
  to: number
): Promise<CounterState | null> {
  const c = client();
  if (!c) return null;
  if (to < 0 || !Number.isInteger(to)) return null;
  try {
    await c.set(REMAINING_KEY, to);
    // Refill-count is unaffected; read it back to return a complete state.
    const refillCount = await c.get<number>(REFILL_COUNT_KEY);
    return {
      remaining: to,
      refillCount: typeof refillCount === "number" ? refillCount : 0,
    };
  } catch (e) {
    console.error(
      `[free-render-counter] set failed:`,
      (e as Error).message
    );
    return null;
  }
}

/**
 * Admin-only refill. Adds `by` to the remaining counter and increments
 * the refill-count metric (so the UI can show "refilled N times this
 * month" or similar). Returns the new state, or null on failure.
 *
 * Caller is responsible for authorization (the route handler checks
 * the VIBEIFY_ADMIN_TOKEN env var).
 */
export async function refillCounter(
  by: number
): Promise<CounterState | null> {
  const c = client();
  if (!c) return null;
  if (by <= 0 || !Number.isInteger(by)) return null;
  try {
    const [remaining, refillCount] = await Promise.all([
      c.incrby(REMAINING_KEY, by),
      c.incr(REFILL_COUNT_KEY),
    ]);
    return {
      remaining: typeof remaining === "number" ? remaining : 0,
      refillCount: typeof refillCount === "number" ? refillCount : 0,
    };
  } catch (e) {
    console.error(
      `[free-render-counter] refill failed:`,
      (e as Error).message
    );
    return null;
  }
}

/**
 * Whether the free-render program is "open" — Redis provisioned AND
 * remaining > 0. Convenience for the render route's branching.
 */
export async function isFreeRenderProgramOpen(): Promise<boolean> {
  const state = await readCounter();
  return !!state && state.remaining > 0;
}
