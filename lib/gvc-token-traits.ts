/**
 * Server-side reader for /public/gvc-metadata.json — used by the
 * vibeify render pipeline to extract canonical traits for a GVC token
 * ID and inject them as a CHARACTER LOCK into the Flux prompt (belt-
 * and-suspenders alongside the SOURCE-CHARACTER reference image).
 *
 * Why server-side: the metadata file is the source of truth. Client-
 * trusted trait fields would let a caller override what we render
 * (e.g. claim a Plastic-Yellow Type for a Grayscale token); doing the
 * lookup server-side from a numeric tokenId keeps the prompt grounded
 * in canonical data.
 *
 * The file is ~5 MB so we cache the parsed object at module scope
 * after the first read. Vercel keeps the function instance warm for a
 * while; subsequent invocations hit the cache, not disk.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Subset of GVC traits we care about for the LOCK section. Other
 * traits (Background, etc.) are in the metadata but not surfaced
 * because they don't help anchor the figurine's appearance.
 */
export type GvcTraitLock = {
  /** "Plastic Yellow", "Grayscale", "Robot Cobalt", "Gold", etc. */
  Type: string;
  /** Free-text describing the head + face (eyewear, expression). */
  Face: string;
  /** Hair / headwear description, e.g. "Ballcap Forward Black SuperRare". */
  Hair: string;
  /** Body / clothing description, e.g. "Hoodie Black SuperRare". */
  Body: string;
};

type GvcMetadataEntry = {
  name?: string;
  traits?: Partial<GvcTraitLock> & Record<string, string>;
  image?: string;
};

let cachedMetadata: Record<string, GvcMetadataEntry> | null = null;

async function loadMetadata(): Promise<Record<string, GvcMetadataEntry> | null> {
  if (cachedMetadata) return cachedMetadata;
  try {
    const path = join(process.cwd(), "public", "gvc-metadata.json");
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    cachedMetadata = parsed as Record<string, GvcMetadataEntry>;
    return cachedMetadata;
  } catch (e) {
    console.error(
      `[gvc-token-traits] could not load metadata:`,
      (e as Error).message
    );
    return null;
  }
}

/**
 * Look up a token's trait lock by numeric ID. Returns null if the
 * tokenId is out of range, metadata is missing, or required trait
 * fields aren't present (renderer falls back to source-image-only
 * prompting).
 */
export async function getGvcTraitLock(
  tokenId: number
): Promise<GvcTraitLock | null> {
  if (!Number.isInteger(tokenId) || tokenId < 0 || tokenId > 6968) return null;
  const meta = await loadMetadata();
  if (!meta) return null;
  const entry = meta[String(tokenId)];
  const t = entry?.traits;
  if (!t) return null;
  // All four fields must be present and non-empty for the lock to be
  // useful — partial locks just confuse the model. Bail clean if
  // anything's missing.
  const Type = String(t.Type ?? "").trim();
  const Face = String(t.Face ?? "").trim();
  const Hair = String(t.Hair ?? "").trim();
  const Body = String(t.Body ?? "").trim();
  if (!Type || !Face || !Hair || !Body) return null;
  return { Type, Face, Hair, Body };
}
