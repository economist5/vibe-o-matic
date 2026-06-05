import { NextRequest, NextResponse } from "next/server";
import {
  createPublicClient,
  decodeEventLog,
  http,
  parseAbi,
  getAddress,
  type Hex,
} from "viem";
import { mainnet } from "viem/chains";
import {
  CHAIN_ID,
  RPC_URL,
  SPLIT_RECIPIENTS,
  TOTAL_VIBESTR,
  VIBESTR_ADDRESS,
  getSplitAmounts,
} from "@/lib/payment-config";
import {
  generateVibetown,
  prepareImage,
  readSourceKind,
  readSourceTokenId,
  resolveVibeifyParams,
} from "@/lib/vibeify-render";

export const runtime = "nodejs";
export const maxDuration = 120;

// ── In-memory replay protection ─────────────────────────────────────
// Resets when the dev server restarts. For production, persist this
// (Redis / KV / DB) so a restart can't unlock previously-spent txs.
const USED_TX_HASHES = new Set<string>();

const transferEventAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(RPC_URL),
});

async function verifyPayment(txHashes: Hex[], payer: `0x${string}`) {
  const expectedAmounts = getSplitAmounts();
  if (txHashes.length !== SPLIT_RECIPIENTS.length) {
    throw new Error(
      `Expected ${SPLIT_RECIPIENTS.length} payment tx(s), got ${txHashes.length}.`
    );
  }

  for (let i = 0; i < txHashes.length; i++) {
    const hash = txHashes[i].toLowerCase() as Hex;
    if (USED_TX_HASHES.has(hash)) {
      throw new Error(`Payment tx ${hash} has already been used.`);
    }

    const recipient = SPLIT_RECIPIENTS[i];
    const expectedAmount = expectedAmounts[i];

    const receipt = await publicClient.getTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`Payment tx ${hash} did not succeed on-chain.`);
    }

    // Find the Transfer log emitted by the VIBESTR contract for this payer.
    const vibestrLog = receipt.logs.find(
      (l) => l.address.toLowerCase() === VIBESTR_ADDRESS.toLowerCase()
    );
    if (!vibestrLog) {
      throw new Error(`Tx ${hash} does not contain a VIBESTR Transfer event.`);
    }

    const decoded = decodeEventLog({
      abi: transferEventAbi,
      data: vibestrLog.data,
      topics: vibestrLog.topics,
    });

    const from = getAddress(decoded.args.from);
    const to = getAddress(decoded.args.to);
    const value = decoded.args.value as bigint;

    if (from.toLowerCase() !== payer.toLowerCase()) {
      throw new Error(
        `Tx ${hash} was sent from ${from}, not the connected wallet ${payer}.`
      );
    }
    if (to.toLowerCase() !== recipient.address.toLowerCase()) {
      throw new Error(
        `Tx ${hash} sent to ${to}, expected ${recipient.address} (${recipient.name}).`
      );
    }
    if (value !== expectedAmount) {
      throw new Error(
        `Tx ${hash} sent ${value} raw VIBESTR, expected ${expectedAmount} (${recipient.percent}% of ${TOTAL_VIBESTR}).`
      );
    }
  }

  // All checks passed — burn the tx hashes so they can't be reused.
  for (const h of txHashes) USED_TX_HASHES.add(h.toLowerCase());
}

/**
 * VIBESTR-rail entry point for the web UI.
 *
 * Responsibilities:
 *   1. Parse the multipart form
 *   2. Gate access via VIBESTR on-chain payment verification (or test bypass)
 *   3. Delegate the actual describe → prompt → Flux render pipeline to the
 *      shared `generateVibetown()` helper (so this route and the x402 route
 *      cannot drift apart on prompt logic)
 *
 * The sibling rail lives at /api/vibeify/x402 (USDC, agentic-capable).
 */
export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  // ── Payment verification ───────────────────────────────────────
  // Test mode is gated by a password stored ONLY in the server's
  // VIBEIFY_BYPASS_PASSWORD env var — never hardcoded in source.
  // If the env var is unset, every bypass attempt is rejected; that
  // means a fork of this repo with no env config has test mode fully
  // disabled by default. Server is the sole source of truth — the
  // client only sends whatever the user typed.
  //
  // VIBEIFY_OPEN_ACCESS=1 escape hatch — used for time-bound public
  // promos (e.g. GVC Day weekend). When set, bypass=1 is accepted
  // WITHOUT a password match. Surfaced to the client via the GET
  // handler so the UI can swap the password input for an open-access
  // banner. Flip to 0 / unset to return to password-gated test mode.
  const TEST_PASSWORD = process.env.VIBEIFY_BYPASS_PASSWORD;
  const OPEN_ACCESS = process.env.VIBEIFY_OPEN_ACCESS === "1";
  const bypassRequested = form.get("bypass") === "1";
  const bypassPassword = (form.get("bypassPassword") as string | null) || "";
  const isTestMode =
    bypassRequested &&
    (OPEN_ACCESS ||
      (!!TEST_PASSWORD && bypassPassword === TEST_PASSWORD));

  if (bypassRequested && !isTestMode) {
    return NextResponse.json(
      {
        error: TEST_PASSWORD
          ? "Test-mode password incorrect."
          : "Test mode is disabled on this server.",
      },
      { status: 403 }
    );
  }

  if (!isTestMode) {
    const payer = (form.get("payer") as string | null)?.trim() as
      | `0x${string}`
      | undefined;
    const txHashesRaw = (form.get("txHashes") as string | null) || "";
    const txHashes = txHashesRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean) as Hex[];

    if (!payer || !payer.startsWith("0x")) {
      return NextResponse.json(
        { error: "Missing 'payer' wallet address." },
        { status: 402 }
      );
    }
    if (txHashes.length === 0) {
      return NextResponse.json(
        {
          error: `Payment required: ${TOTAL_VIBESTR} VIBESTR before generating.`,
        },
        { status: 402 }
      );
    }

    try {
      await verifyPayment(txHashes, payer);
    } catch (e) {
      return NextResponse.json(
        { error: `Payment check failed: ${(e as Error).message}` },
        { status: 402 }
      );
    }
  }

  // ── Hand off to the shared render pipeline ─────────────────────
  const img = await prepareImage(form);
  if (img.kind === "err") return img.response;

  // Supports both explicit-mode (web UI default) and agent-mode (form has
  // `agentMode=1`) — the resolver decides based on form fields.
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

  return generateVibetown({
    buffer: img.buffer,
    filename: img.filename,
    mime: img.mime,
    scene: resolved.scene,
    action: resolved.action,
    mood: resolved.mood,
    size: resolved.size,
    sceneBgFilenames: resolved.sceneBgFilenames,
    sourceKind: readSourceKind(form),
    sourceTokenId: readSourceTokenId(form),
    extra: {
      paymentRail: "vibestr",
      testMode: isTestMode,
      ...(resolved.agentPicks ? { agentPicks: resolved.agentPicks } : {}),
    },
  });
}

export async function GET() {
  return NextResponse.json({
    price: TOTAL_VIBESTR.toString(),
    chainId: CHAIN_ID,
    splits: SPLIT_RECIPIENTS.map((r) => ({
      name: r.name,
      address: r.address,
      percent: r.percent,
    })),
    // Test mode is always available, but gated by a password the client
    // must POST in the `bypassPassword` form field. See route POST handler.
    bypassAvailable: true,
    // True when VIBEIFY_OPEN_ACCESS=1 is set server-side — clients use
    // this to flip the test-mode card into "open access" UX (no password
    // input, banner instead). Time-bound public promo flag.
    openAccess: process.env.VIBEIFY_OPEN_ACCESS === "1",
  });
}
