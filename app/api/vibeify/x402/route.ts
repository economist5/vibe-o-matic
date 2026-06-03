import { NextRequest, NextResponse } from "next/server";
import { getAddress } from "viem";
import { exact } from "x402/schemes";
import {
  findMatchingPaymentRequirements,
  processPriceToAtomicAmount,
  safeBase64Encode,
  toJsonSafe,
} from "x402/shared";
import { useFacilitator } from "x402/verify";
import type {
  ERC20TokenAmount,
  PaymentPayload,
  PaymentRequirements,
  Resource,
} from "x402/types";
import {
  USDC_NETWORK,
  USDC_PRICE_DOLLARS,
  USDC_RECIPIENT,
  X402_FACILITATOR_URL,
} from "@/lib/payment-config";
import {
  generateVibetown,
  prepareImage,
  readSourceKind,
  readSourceTokenId,
  resolveVibeifyParams,
} from "@/lib/vibeify-render";
import { checkCommunityEligibility } from "@/lib/community-eligibility";
import {
  decrementCounter,
  readCounter,
} from "@/lib/free-render-counter";
import { facilitator } from "@coinbase/x402";

export const runtime = "nodejs";
export const maxDuration = 120;

const X402_VERSION = 1;
// We use Coinbase CDP's hosted facilitator because the public x402.org
// facilitator only supports Base Sepolia + a handful of testnets — Base
// MAINNET requires the CDP facilitator. The `facilitator` export from
// @coinbase/x402 packages the URL + createAuthHeaders() that signs each
// request with a JWT built from CDP_API_KEY_ID + CDP_API_KEY_SECRET (env).
// If those env vars are unset, verify() / settle() will throw at request
// time with a clear error — caller is never charged because we always
// verify before render and settle only after render success.
//
// The cast is because @coinbase/x402's facilitator.url is typed as
// `string | undefined` (defensive against env override) but v1 x402's
// useFacilitator() expects a Resource template-literal type. Runtime
// shape is correct — the cast just appeases the type checker.
const { verify, settle } = useFacilitator(
  facilitator as Parameters<typeof useFacilitator>[0]
);

function buildRequirements(resource: Resource): PaymentRequirements[] {
  const atomic = processPriceToAtomicAmount(USDC_PRICE_DOLLARS, USDC_NETWORK);
  if ("error" in atomic) {
    throw new Error(atomic.error);
  }
  const { maxAmountRequired, asset } = atomic;

  return [
    {
      scheme: "exact",
      network: USDC_NETWORK,
      maxAmountRequired,
      resource,
      description: "One Vibetown render via FLUX.2 [pro]",
      mimeType: "application/json",
      payTo: getAddress(USDC_RECIPIENT),
      maxTimeoutSeconds: 300,
      asset: getAddress(asset.address),
      outputSchema: {
        input: { type: "http", method: "POST", discoverable: true },
      },
      extra: (asset as ERC20TokenAmount["asset"]).eip712,
    },
  ];
}

function paymentRequiredResponse(
  requirements: PaymentRequirements[],
  message = "X-PAYMENT header is required"
) {
  // Surface in the dev log so we don't have to dig into the response body
  // every time a 402 fires. Discovery 402s ("X-PAYMENT header is required")
  // are expected on the first POST of the two-step flow; any other reason
  // string indicates a real verification/settlement failure.
  console.log(`[vibeify-x402] 402: ${message}`);
  return NextResponse.json(
    {
      x402Version: X402_VERSION,
      error: message,
      accepts: toJsonSafe(requirements),
    },
    { status: 402 }
  );
}

export async function POST(req: NextRequest) {
  // Resource URL the payment is for (the route itself).
  const resource = req.url as Resource;

  let requirements: PaymentRequirements[];
  try {
    requirements = buildRequirements(resource);
  } catch (e) {
    return NextResponse.json(
      { error: `x402 misconfigured: ${(e as Error).message}` },
      { status: 500 }
    );
  }

  // ── 1. Parse FormData up front (so we can validate inputs before charging) ──
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  // ── 1.5. Community-free path (FEEDBACK-V1.md § Eligibility) ──
  // If the caller asked for a free render via `freeRender=1 + wallet=0x…`,
  // verify on-chain eligibility + that the program counter still has
  // headroom, and skip the entire x402 payment flow. Falls through to
  // the regular payment path if anything fails, so the caller's only
  // downside on a failed free attempt is a 402 + a clear error message.
  //
  // Threat model note: server independently verifies the wallet's
  // on-chain eligibility — a malicious client can't spoof their way
  // through by sending an unowned address. The only theoretical abuse
  // (someone using a qualifying address they don't own) is bounded by
  // the public 200-render cap; total damage is ≤ ~$10 per refill cycle.
  const wantsFreeRender = form.get("freeRender") === "1";
  if (wantsFreeRender) {
    const walletRaw = (form.get("wallet") as string | null)?.trim() ?? "";
    if (!/^0x[a-fA-F0-9]{40}$/.test(walletRaw)) {
      return NextResponse.json(
        { error: "Free-render path requires a `wallet` form field (0x…)." },
        { status: 400 }
      );
    }
    const wallet = walletRaw.toLowerCase() as `0x${string}`;

    // Counter state first — cheaper than the RPC + saves a no-op render
    // path if the program is exhausted or KV isn't connected.
    const counterState = await readCounter();
    if (!counterState) {
      return NextResponse.json(
        {
          error:
            "Community free-render program is not yet available (counter not provisioned).",
        },
        { status: 503 }
      );
    }
    if (counterState.remaining <= 0) {
      return NextResponse.json(
        {
          error:
            "Community free-render program exhausted for now. Try paying via x402 or ping @economist for a reload.",
          remaining: counterState.remaining,
        },
        { status: 429 }
      );
    }

    // Eligibility — fail closed on RPC errors.
    const eligibility = await checkCommunityEligibility(wallet);
    if (!eligibility.isMember) {
      return NextResponse.json(
        {
          error:
            "Wallet doesn't meet community-eligibility (≥1 GVC NFT OR ≥69,000 VIBESTR on Ethereum mainnet).",
          qualifier: eligibility.qualifier,
          gvcCount: eligibility.gvcCount.toString(),
          vibestrBalance: eligibility.vibestrBalance.toString(),
        },
        { status: 403 }
      );
    }

    // ── Run the render (same code path as the paid case) ──
    const img = await prepareImage(form);
    if (img.kind === "err") return img.response;

    let resolved;
    try {
      const openaiKey = process.env.OPENAI_API_KEY;
      if (!openaiKey) throw new Error("OPENAI_API_KEY not configured");
      resolved = await resolveVibeifyParams(
        form,
        { buffer: img.buffer, mime: img.mime },
        openaiKey
      );
    } catch (e) {
      return NextResponse.json(
        { error: `Param resolution failed: ${(e as Error).message}` },
        { status: 502 }
      );
    }

    const response = await generateVibetown({
      ...img,
      scene: resolved.scene,
      action: resolved.action,
      mood: resolved.mood,
      size: resolved.size,
      sceneBgFilenames: resolved.sceneBgFilenames,
      sourceKind: readSourceKind(form),
      sourceTokenId: readSourceTokenId(form),
      extra: {
        paymentRail: "community-free",
        agentMode: form.get("agentMode") === "1",
        qualifier: eligibility.qualifier,
        ...(resolved.agentPicks ? { agentPicks: resolved.agentPicks } : {}),
      },
    });

    if (response.status >= 400) {
      // Render failed; counter NOT decremented (we charge nothing).
      return response;
    }

    // Decrement the counter AFTER the render succeeds (FEEDBACK-V1.md
    // risk note: at-most-one-off-budget render is acceptable if the
    // DECR itself fails after a successful render).
    const newRemaining = await decrementCounter();
    if (newRemaining !== null) {
      response.headers.set(
        "X-FREE-RENDER",
        JSON.stringify({
          remaining: newRemaining,
          qualifier: eligibility.qualifier,
        })
      );
    }
    console.log(
      `[vibeify-x402] community-free render granted to ${wallet} via ${eligibility.qualifier}; remaining=${newRemaining}`
    );
    return response;
  }

  // ── 2. Payment header present? ──
  const paymentHeader = req.headers.get("X-PAYMENT");
  if (!paymentHeader) {
    return paymentRequiredResponse(requirements);
  }

  // ── 3. Decode + match + verify ──
  let decoded: PaymentPayload;
  try {
    decoded = exact.evm.decodePayment(paymentHeader);
    decoded.x402Version = X402_VERSION;
  } catch (e) {
    return paymentRequiredResponse(
      requirements,
      `Invalid X-PAYMENT header: ${(e as Error).message}`
    );
  }

  const matched = findMatchingPaymentRequirements(requirements, decoded);
  if (!matched) {
    return paymentRequiredResponse(
      requirements,
      "No matching payment requirement for the supplied payment."
    );
  }

  try {
    const verification = await verify(decoded, matched);
    if (!verification.isValid) {
      return paymentRequiredResponse(
        requirements,
        verification.invalidReason || "Payment verification failed"
      );
    }
  } catch (e) {
    return paymentRequiredResponse(
      requirements,
      `Payment verification error: ${(e as Error).message}`
    );
  }

  // ── 4. Run the actual generation ──
  const img = await prepareImage(form);
  if (img.kind === "err") return img.response; // No payment settled — user not charged.

  // x402 supports two modes via the shared resolver:
  //   - Explicit:   caller sends scene/action/mood/size/sceneBgImages directly.
  //   - Agent mode: caller sends `agentMode=1` (+ optional `intent` text) and
  //                 our server-side picker chooses the params from the curated
  //                 catalog. The caller doesn't need to know the preset ids.
  let resolved;
  try {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) throw new Error("OPENAI_API_KEY not configured");
    resolved = await resolveVibeifyParams(
      form,
      { buffer: img.buffer, mime: img.mime },
      openaiKey
    );
  } catch (e) {
    console.error(`[vibeify-x402] agent picker failed:`, (e as Error).message);
    return NextResponse.json(
      { error: `Param resolution failed: ${(e as Error).message}` },
      { status: 502 }
    );
  }

  const response = await generateVibetown({
    ...img,
    scene: resolved.scene,
    action: resolved.action,
    mood: resolved.mood,
    size: resolved.size,
    sceneBgFilenames: resolved.sceneBgFilenames,
    sourceKind: readSourceKind(form),
    sourceTokenId: readSourceTokenId(form),
    extra: {
      paymentRail: "usdc",
      agentMode: form.get("agentMode") === "1",
      ...(resolved.agentPicks ? { agentPicks: resolved.agentPicks } : {}),
    },
  });

  // ── 5. Settle only if the handler succeeded ──
  if (response.status >= 400) {
    return response;
  }

  try {
    const settlement = await settle(decoded, matched);
    if (!settlement.success) {
      throw new Error(settlement.errorReason || "Settlement failed");
    }
    response.headers.set(
      "X-PAYMENT-RESPONSE",
      safeBase64Encode(
        JSON.stringify({
          success: true,
          transaction: settlement.transaction,
          network: settlement.network,
          payer: settlement.payer,
        })
      )
    );
    return response;
  } catch (e) {
    return NextResponse.json(
      {
        x402Version: X402_VERSION,
        error: `Payment settlement failed: ${(e as Error).message}`,
        accepts: toJsonSafe(requirements),
      },
      { status: 402 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    network: USDC_NETWORK,
    price: USDC_PRICE_DOLLARS,
    payTo: USDC_RECIPIENT,
    facilitator: X402_FACILITATOR_URL,
  });
}
