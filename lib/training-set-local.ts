"use client";

/**
 * Browser-local training set for the FEEDBACK-V1 program (Phase 1b).
 *
 * Spec: FEEDBACK-V1.md § What gets persisted, and where.
 *
 * Privacy floor: only renders where sourceKind === "gvc-token" are
 * stored here. Photo-source renders show the feedback widget for UX
 * symmetry but their data NEVER enters this store or the (future)
 * upload path. The privacy guarantee is enforced at every entry point
 * — addEntry() rejects non-gvc-token entries; setEntryFeedback() only
 * updates entries that are already present (so a photo render can't
 * leak via "I rated this" either).
 *
 * Storage budget: each entry contains the full PNG output as a data
 * URL (~500 KB – 1 MB). localStorage cap is typically ~5–10 MB across
 * the origin, shared with the existing history feature. We cap at
 * MAX_ENTRIES (50) with FIFO eviction so the worst case stays bounded.
 * If localStorage refuses our write (quota / private-mode), we fail
 * silently — the user just doesn't accumulate a training set.
 *
 * Nothing here ever sends data over the network. That's Phase 1c's job.
 */

export type TrainingEntry = {
  /** Stable local id for the render, e.g. "r_abc123". */
  id: string;
  /** Unix epoch ms when the render completed. */
  ts: number;
  /** Privacy floor: only GVC-token renders end up here. */
  sourceKind: "gvc-token";
  /**
   * Numeric GVC token id rendered (0..6968) when the source was loaded
   * via the token-ID picker. null when the user manually tagged an
   * uploaded image as GVC (we don't know which token, if any, it's
   * derived from).
   */
  sourceTokenId: number | null;
  /** Full prompt sent to Flux for the render — provides the caption for
   *  LoRA training when paired with the output image. */
  prompt: string;
  /** Optional gpt-4o-mini source description (empty for gvc-token path). */
  description?: string;
  /** data:image/png;base64,... — the rendered PNG. */
  outputImage: string;
  /** User's verdict: up / down / not yet rated. */
  feedback: "up" | "down" | null;
  /**
   * Optional 1-line user reason for the verdict ("nose came back",
   * "perfect skin tone", etc.). Trimmed to 200 chars in the UI. Saved
   * alongside feedback verdict; uploaded to the training-set as a
   * caption-quality signal.
   */
  feedbackReason?: string;
  /**
   * Unix epoch ms when this entry was successfully POSTed to the
   * training-set contribution endpoint. null = not yet contributed.
   * Used by the ContributionsPanel to compute "X new entries to upload"
   * so users don't waste bandwidth re-uploading the same data.
   */
  uploadedAt: number | null;
};

const STORAGE_KEY = "vibe-o-matic:training-set";
const MAX_ENTRIES = 50;

function safeRead(): TrainingEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e) =>
          e &&
          typeof e === "object" &&
          e.sourceKind === "gvc-token" &&
          typeof e.id === "string"
      )
      .map((e) => ({
        // Backfill uploadedAt for pre-Phase-1c entries that wouldn't have it.
        uploadedAt: null as number | null,
        ...e,
      })) as TrainingEntry[];
  } catch {
    return [];
  }
}

function safeWrite(set: TrainingEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(set));
  } catch {
    // Quota exceeded / private mode / disabled — silently no-op.
    // The user just doesn't accumulate a training set this session.
  }
}

/** Read the current training set from localStorage. */
export function loadTrainingSet(): TrainingEntry[] {
  return safeRead();
}

/**
 * Add a new entry. Returns the updated set. Rejects non-gvc-token
 * entries — the privacy-floor enforcement point.
 *
 * Takes `current` as the React-state source of truth so a stale or
 * failed localStorage write never corrupts the live UI state. Writes
 * to localStorage as best-effort (silent no-op on quota); the returned
 * set is always correct regardless of localStorage success.
 */
export function addEntry(
  current: TrainingEntry[],
  entry: TrainingEntry
): TrainingEntry[] {
  if (entry.sourceKind !== "gvc-token") return current;
  // Newest at front; cap at MAX_ENTRIES with FIFO eviction.
  const next = [entry, ...current.filter((e) => e.id !== entry.id)].slice(
    0,
    MAX_ENTRIES
  );
  safeWrite(next);
  return next;
}

/**
 * Update the feedback verdict for an existing entry. If no entry with
 * `id` exists in the passed-in set, no-ops.
 *
 * Source of truth is the passed-in `current` set (i.e. React state),
 * NOT localStorage. This prevents a class of bugs where a silently-
 * failed localStorage write (quota exceeded etc.) makes subsequent
 * read-modify-write operations divergent from live UI state — the
 * exact bug that caused render-2+ ratings to fail to stick.
 */
export function setEntryFeedback(
  current: TrainingEntry[],
  id: string,
  feedback: "up" | "down" | null
): TrainingEntry[] {
  const idx = current.findIndex((e) => e.id === id);
  if (idx === -1) return current;
  const next = [...current];
  next[idx] = { ...next[idx], feedback };
  safeWrite(next);
  return next;
}

/**
 * Update the optional reason text on an existing entry. Trims + caps
 * at 200 chars (the server endpoint enforces the same cap). Empty
 * string clears the reason. Source-of-truth pattern matches
 * setEntryFeedback above.
 */
export function setEntryFeedbackReason(
  current: TrainingEntry[],
  id: string,
  reason: string
): TrainingEntry[] {
  const idx = current.findIndex((e) => e.id === id);
  if (idx === -1) return current;
  const trimmed = reason.trim().slice(0, 200);
  const next = [...current];
  next[idx] = {
    ...next[idx],
    feedbackReason: trimmed || undefined,
  };
  safeWrite(next);
  return next;
}

/**
 * Mark all entries with the given ids as uploaded (sets uploadedAt to
 * `now`). Returns the updated set. Used by the Phase 1c contribution
 * flow once /api/training-set/submit returns success.
 *
 * Same React-state-as-source-of-truth pattern as setEntryFeedback.
 */
export function markUploaded(
  current: TrainingEntry[],
  ids: string[]
): TrainingEntry[] {
  if (!ids.length) return current;
  const lookup = new Set(ids);
  const now = Date.now();
  const next = current.map((e) =>
    lookup.has(e.id) ? { ...e, uploadedAt: now } : e
  );
  safeWrite(next);
  return next;
}

/** Count entries that have been rated AND not yet uploaded (Phase 1c). */
export function pendingUploadCount(set: TrainingEntry[]): number {
  return set.filter((e) => e.feedback !== null && e.uploadedAt === null)
    .length;
}

/** Wipe the entire local training set. */
export function clearTrainingSet(): TrainingEntry[] {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }
  return [];
}

/** Count entries that have a feedback verdict set (Phase 1c upload trigger). */
export function ratedCount(set: TrainingEntry[]): number {
  return set.filter((e) => e.feedback !== null).length;
}
