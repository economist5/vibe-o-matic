/**
 * Admin endpoint to top up the free-render counter.
 *
 * Spec: FEEDBACK-V1.md § The 200-render counter / X-reload viral loop.
 *
 * Usage (browser or curl, from the project owner's machine):
 *   POST /api/admin/refill?n=200
 *   Authorization: Bearer <VIBEIFY_ADMIN_TOKEN>
 *
 * The token is a server-side env var only — never exposed to the client.
 * If the env var is unset, the endpoint returns 503 (admin path
 * disabled). If it's set but the caller's token doesn't match, 401.
 *
 * Defaults: ?n is required, must be 1–10,000. We cap at 10k as a sanity
 * guard against typos like ?n=2000000 — anyone wanting to actually
 * grant more can call repeatedly.
 */

import { NextRequest, NextResponse } from "next/server";
import { refillCounter, setCounter } from "@/lib/free-render-counter";

const MAX_REFILL_PER_CALL = 10_000;
const MAX_SET_VALUE = 100_000;

export async function POST(req: NextRequest) {
  const adminToken = process.env.VIBEIFY_ADMIN_TOKEN;
  if (!adminToken) {
    return NextResponse.json(
      {
        error:
          "Admin endpoint disabled — VIBEIFY_ADMIN_TOKEN not set in environment.",
      },
      { status: 503 }
    );
  }

  // Accept either a Bearer header OR a ?token= query param so it's
  // easy to refill from a browser tab without browser auth tooling.
  const headerToken = req.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();
  const queryToken = req.nextUrl.searchParams.get("token")?.trim();
  const provided = headerToken || queryToken;
  if (!provided || provided !== adminToken) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  // Two modes:
  //   ?set=N  → override the counter to exactly N (atomic SET).
  //             Doesn't bump refillCount. Used to correct a mistake
  //             or to dial up/down for a marketing moment.
  //   ?n=N    → add N to the counter (atomic INCRBY) + bump refillCount.
  //             The default refill behavior.
  // If both are present, ?set= wins (it's the more deliberate action).
  const setRaw = req.nextUrl.searchParams.get("set");
  if (setRaw !== null) {
    const target = Number(setRaw);
    if (!Number.isInteger(target) || target < 0 || target > MAX_SET_VALUE) {
      return NextResponse.json(
        {
          error: `?set must be an integer 0..${MAX_SET_VALUE}`,
        },
        { status: 400 }
      );
    }
    const state = await setCounter(target);
    if (!state) {
      return NextResponse.json(
        {
          error:
            "Counter set failed — KV not provisioned or write error. Check server logs.",
        },
        { status: 503 }
      );
    }
    console.log(
      `[admin/refill] SET → remaining=${state.remaining} (refillCount untouched at ${state.refillCount})`
    );
    return NextResponse.json({
      ok: true,
      operation: "set",
      remaining: state.remaining,
      refillCount: state.refillCount,
    });
  }

  // ?n=200 — how many credits to add to the remaining counter.
  const nRaw = req.nextUrl.searchParams.get("n");
  const n = Number(nRaw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_REFILL_PER_CALL) {
    return NextResponse.json(
      {
        error: `?n must be an integer 1..${MAX_REFILL_PER_CALL} (or use ?set=N to override the counter to an exact value)`,
      },
      { status: 400 }
    );
  }

  const state = await refillCounter(n);
  if (!state) {
    return NextResponse.json(
      {
        error:
          "Counter refill failed — KV not provisioned or write error. Check server logs.",
      },
      { status: 503 }
    );
  }

  console.log(
    `[admin/refill] +${n} → remaining=${state.remaining}, refillCount=${state.refillCount}`
  );
  return NextResponse.json({
    ok: true,
    operation: "add",
    added: n,
    remaining: state.remaining,
    refillCount: state.refillCount,
  });
}
