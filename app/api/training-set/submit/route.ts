/**
 * Voluntary contribution endpoint for the FEEDBACK-V1 training-set
 * program (Phase 1c).
 *
 * Accepts a JSON payload from the user's browser containing:
 *   - wallet: address that should own this contribution
 *   - entries: array of TrainingEntry objects
 *
 * Writes each entry to Vercel Blob as:
 *   training-set/images/{wallet}/{entry.id}.png
 * and updates a per-wallet manifest at:
 *   training-set/manifests/{wallet}.json
 *
 * Privacy floor: every entry MUST have sourceKind === "gvc-token".
 * Anything else is rejected as a 400 — the privacy commitment we
 * make to users (only NFT-source data leaves their browser) is
 * enforced at this server-side validation, in addition to the
 * client-side floor in lib/training-set-local.ts.
 *
 * Auth: no wallet signature (per FEEDBACK-V1.md spec — keep contribution
 * friction minimal). Trade-off: anyone could POST data tied to a wallet
 * they don't own. Mitigations:
 *   - Server validates the sourceKind floor (no random non-gvc payloads)
 *   - Server validates the basic data shape (no random bytes claiming to
 *     be PNGs)
 *   - Manifest stores who-claimed-what; the project owner can audit at
 *     export time
 *
 * Graceful degrade: if Vercel Blob isn't provisioned yet
 * (BLOB_READ_WRITE_TOKEN missing), returns 503 with a clear message.
 * Same pattern as the Phase 1a KV setup — the route is safe to deploy
 * before ops finishes the dashboard work.
 */

import { NextRequest, NextResponse } from "next/server";
import { put, get } from "@vercel/blob";

const MAX_ENTRIES_PER_REQUEST = 50;
const MAX_PROMPT_LEN = 50_000;
const MAX_DESCRIPTION_LEN = 10_000;
const MAX_PNG_BYTES = 2 * 1024 * 1024; // 2 MB per render

type SubmittedEntry = {
  id: string;
  ts: number;
  sourceKind: "gvc-token";
  sourceTokenId: number;
  prompt: string;
  description?: string;
  outputImage: string;
  feedback: "up" | "down" | null;
  uploadedAt: number | null;
};

type ServerManifestEntry = Omit<SubmittedEntry, "outputImage"> & {
  /** URL to the uploaded PNG in Blob. Replaces the raw data: URL. */
  imageUrl: string;
  /** Server-recorded upload timestamp. */
  serverUploadedAt: number;
};

type ServerManifest = {
  wallet: string;
  firstUploadAt: number;
  lastUploadAt: number;
  entryCount: number;
  entries: ServerManifestEntry[];
};

function isWalletString(v: unknown): v is `0x${string}` {
  return typeof v === "string" && /^0x[a-fA-F0-9]{40}$/.test(v);
}

function dataUrlToPngBuffer(dataUrl: string): Buffer | null {
  // Accept "data:image/png;base64,..." only. Reject anything that isn't
  // PNG to keep the dataset homogeneous and to refuse obvious abuse.
  const m = dataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  try {
    const buf = Buffer.from(m[1], "base64");
    if (buf.length === 0 || buf.length > MAX_PNG_BYTES) return null;
    // PNG magic: 0x89 P N G 0x0D 0x0A 0x1A 0x0A
    if (
      buf[0] !== 0x89 ||
      buf[1] !== 0x50 ||
      buf[2] !== 0x4e ||
      buf[3] !== 0x47
    ) {
      return null;
    }
    return buf;
  } catch {
    return null;
  }
}

function validateEntry(e: unknown): SubmittedEntry | null {
  if (!e || typeof e !== "object") return null;
  const o = e as Record<string, unknown>;
  if (typeof o.id !== "string" || !/^r_[a-z0-9]+$/i.test(o.id)) return null;
  if (typeof o.ts !== "number" || !Number.isFinite(o.ts)) return null;
  if (o.sourceKind !== "gvc-token") return null; // PRIVACY FLOOR
  if (
    typeof o.sourceTokenId !== "number" ||
    !Number.isInteger(o.sourceTokenId) ||
    o.sourceTokenId < 0 ||
    o.sourceTokenId > 6968
  ) {
    return null;
  }
  if (typeof o.prompt !== "string" || o.prompt.length > MAX_PROMPT_LEN) {
    return null;
  }
  if (
    o.description !== undefined &&
    (typeof o.description !== "string" ||
      o.description.length > MAX_DESCRIPTION_LEN)
  ) {
    return null;
  }
  if (typeof o.outputImage !== "string") return null;
  if (
    o.feedback !== "up" &&
    o.feedback !== "down" &&
    o.feedback !== null
  ) {
    return null;
  }
  return {
    id: o.id,
    ts: o.ts,
    sourceKind: "gvc-token",
    sourceTokenId: o.sourceTokenId,
    prompt: o.prompt,
    description:
      typeof o.description === "string" ? o.description : undefined,
    outputImage: o.outputImage,
    feedback: o.feedback as "up" | "down" | null,
    uploadedAt: typeof o.uploadedAt === "number" ? o.uploadedAt : null,
  };
}

async function readExistingManifest(
  wallet: string
): Promise<ServerManifest | null> {
  try {
    const key = `training-set/manifests/${wallet}.json`;
    // For private blobs, list()+fetch(url) doesn't work — the URL is a
    // signed reference that requires the SDK to resolve. get() streams
    // the content directly using the store's auth token.
    const result = await get(key, { access: "private" });
    if (!result) return null;
    const text = await new Response(result.stream).text();
    return JSON.parse(text) as ServerManifest;
  } catch (e) {
    // First-upload case: the blob doesn't exist yet, get() throws a
    // BlobNotFoundError. That's expected — return null so the caller
    // treats it as "no existing manifest, start fresh".
    const msg = (e as Error).message || String(e);
    if (/not\s*found|404/i.test(msg)) return null;
    console.error(
      `[training-set/submit] manifest read failed: ${msg}`
    );
    return null;
  }
}

/**
 * Diagnostic GET — read-only check of which Blob-related env vars are
 * visible to the server runtime. Returns ONLY existence flags + token
 * lengths, NEVER the actual token values. Lets us debug Blob env-var
 * detection without exposing secrets in the response.
 *
 * Public route, no auth. Output is non-sensitive.
 */
export function GET() {
  const blobVarNames = Object.keys(process.env).filter((k) =>
    /BLOB/i.test(k)
  );
  const hasDefault = !!process.env.BLOB_READ_WRITE_TOKEN;
  return NextResponse.json({
    available: hasDefault,
    defaultTokenLength: process.env.BLOB_READ_WRITE_TOKEN?.length ?? 0,
    blobEnvVarsVisible: blobVarNames,
    deployedAt: new Date().toISOString(),
  });
}

export async function POST(req: NextRequest) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      {
        error:
          "Training-set contribution endpoint not yet available (Vercel Blob not provisioned).",
      },
      { status: 503 }
    );
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Body must be JSON." },
      { status: 400 }
    );
  }

  if (!payload || typeof payload !== "object") {
    return NextResponse.json(
      { error: "Body must be an object." },
      { status: 400 }
    );
  }

  const { wallet, entries } = payload as {
    wallet?: unknown;
    entries?: unknown;
  };

  if (!isWalletString(wallet)) {
    return NextResponse.json(
      { error: "Missing/invalid `wallet` (expected 0x… 40-hex)." },
      { status: 400 }
    );
  }
  const walletLower = wallet.toLowerCase();

  if (!Array.isArray(entries) || entries.length === 0) {
    return NextResponse.json(
      { error: "`entries` must be a non-empty array." },
      { status: 400 }
    );
  }
  if (entries.length > MAX_ENTRIES_PER_REQUEST) {
    return NextResponse.json(
      {
        error: `Too many entries in one request (max ${MAX_ENTRIES_PER_REQUEST}). Split into multiple submissions.`,
      },
      { status: 413 }
    );
  }

  const validated: SubmittedEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const v = validateEntry(entries[i]);
    if (!v) {
      return NextResponse.json(
        {
          error: `Entry at index ${i} failed validation (must be a well-formed gvc-token TrainingEntry with a PNG data URL).`,
        },
        { status: 400 }
      );
    }
    validated.push(v);
  }

  // ── Upload each PNG to Blob ──
  const uploaded: ServerManifestEntry[] = [];
  for (const entry of validated) {
    const pngBuf = dataUrlToPngBuffer(entry.outputImage);
    if (!pngBuf) {
      return NextResponse.json(
        {
          error: `Entry ${entry.id}: outputImage is not a valid base64 PNG data URL.`,
        },
        { status: 400 }
      );
    }
    try {
      const blob = await put(
        `training-set/images/${walletLower}/${entry.id}.png`,
        pngBuf,
        {
          access: "private" as const,
          contentType: "image/png",
          allowOverwrite: true,
          // Store is configured PRIVATE in the Vercel dashboard — blobs
          // are only reachable via the SDK's get()/download() with the
          // store's read-write token. The project owner accesses the
          // dataset via the Vercel dashboard OR a future bulk-export
          // script that uses the SDK directly.
        }
      );
      uploaded.push({
        id: entry.id,
        ts: entry.ts,
        sourceKind: "gvc-token",
        sourceTokenId: entry.sourceTokenId,
        prompt: entry.prompt,
        description: entry.description,
        feedback: entry.feedback,
        uploadedAt: entry.uploadedAt,
        imageUrl: blob.url,
        serverUploadedAt: Date.now(),
      });
    } catch (e) {
      // Surface the underlying Blob error directly to the client.
      // Previously we returned a canned message that hid the actual
      // failure mode (token permission, quota, path issue, etc.) and
      // made debugging the upload pipeline much harder.
      const msg = (e as Error).message || String(e);
      const name = (e as Error).name || "Error";
      console.error(
        `[training-set/submit] put failed for ${entry.id}: ${name}: ${msg}`
      );
      return NextResponse.json(
        {
          error: `Blob put failed for ${entry.id}: ${name}: ${msg}`,
          underlying: { name, message: msg },
        },
        { status: 502 }
      );
    }
  }

  // ── Merge with existing manifest (per-wallet, append-only) ──
  const existing = await readExistingManifest(walletLower);
  const merged: ServerManifest = (() => {
    if (!existing) {
      return {
        wallet: walletLower,
        firstUploadAt: Date.now(),
        lastUploadAt: Date.now(),
        entryCount: uploaded.length,
        entries: uploaded,
      };
    }
    // Dedupe by id — re-uploads overwrite older copies.
    const byId = new Map<string, ServerManifestEntry>();
    for (const e of existing.entries) byId.set(e.id, e);
    for (const e of uploaded) byId.set(e.id, e);
    const mergedEntries = Array.from(byId.values()).sort(
      (a, b) => b.serverUploadedAt - a.serverUploadedAt
    );
    return {
      wallet: walletLower,
      firstUploadAt: existing.firstUploadAt,
      lastUploadAt: Date.now(),
      entryCount: mergedEntries.length,
      entries: mergedEntries,
    };
  })();

  try {
    await put(
      `training-set/manifests/${walletLower}.json`,
      JSON.stringify(merged, null, 2),
      {
        access: "private" as const,
        contentType: "application/json",
        allowOverwrite: true,
      }
    );
  } catch (e) {
    const msg = (e as Error).message || String(e);
    const name = (e as Error).name || "Error";
    console.error(
      `[training-set/submit] manifest put failed: ${name}: ${msg}`
    );
    return NextResponse.json(
      {
        error: `Images uploaded but manifest write failed: ${name}: ${msg}. Re-submit to repair the manifest.`,
        underlying: { name, message: msg },
        uploadedIds: uploaded.map((e) => e.id),
      },
      { status: 502 }
    );
  }

  console.log(
    `[training-set/submit] ${walletLower}: +${uploaded.length} entries (total ${merged.entryCount})`
  );
  return NextResponse.json({
    ok: true,
    wallet: walletLower,
    accepted: uploaded.length,
    uploadedIds: uploaded.map((e) => e.id),
    totalEntries: merged.entryCount,
  });
}
