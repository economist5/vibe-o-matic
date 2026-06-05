"use client";

import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import toast from "react-hot-toast";
import { formatUnits, type Hex } from "viem";
import { getStats, type CollectionStats } from "@/lib/gvc-api";
import { compressForUpload } from "@/lib/compress-image";
import {
  SCENE_PRESETS,
  ACTION_PRESETS,
  MOOD_PRESETS,
} from "@/lib/presets";
import {
  addEntry as addTrainingEntry,
  clearTrainingSet,
  loadTrainingSet,
  markUploaded,
  pendingUploadCount,
  ratedCount as countRated,
  setEntryFeedback,
  setEntryFeedbackReason,
  type TrainingEntry,
} from "@/lib/training-set-local";
import {
  CHAIN_ID,
  SPLIT_RECIPIENTS,
  TOTAL_VIBESTR,
  TOTAL_VIBESTR_RAW,
  USDC_PRICE_DOLLARS,
  VIBESTR_DECIMALS,
} from "@/lib/payment-config";
import {
  connectWallet,
  ensureMainnet,
  getUsdcBalanceBase,
  getVibestrBalance,
  getX402Fetch,
  payVibestrSplit,
  shortAddr,
  type PayProgress,
} from "@/lib/wallet";

// ── Payment rails ────────────────────────────────────────────────────
// Two rails are exposed in the human UI:
//   - USDC (active, default): Base mainnet via x402, gasless EIP-3009 signature.
//   - VIBESTR (coming soon): Ethereum mainnet, GVC's native token. Currently
//     disabled in the UI because VIBESTR enforces a private recipient
//     allowlist inside its _transfer; our treasury hasn't been added yet
//     (coordinating with the GVC team). The plumbing is fully in place —
//     once allowlist add lands, the toggle's "soon" pill flips off.
// Autonomous AI agents always use the USDC rail directly via /api/vibeify/x402.
type PaymentRail = "usdc" | "vibestr";

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
// SCENE_PRESETS / ACTION_PRESETS / MOOD_PRESETS now live in lib/presets.ts
// so the server-side x402 agent can use the same source of truth.

type Generation = {
  id: string;
  ts: number;
  scene: string;
  thumb: string;
  full: string;
  /** Full prompt sent to FLUX.2 [pro] for this render. */
  prompt?: string;
  /** Text description produced by gpt-4o-mini that fed the renderer. */
  description?: string;
};

const STORAGE_KEY = "vibe-o-matic:gens";

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function ipfsToHttp(url: string): string {
  return url.startsWith("ipfs://")
    ? url.replace("ipfs://", "https://ipfs.io/ipfs/")
    : url;
}

async function makeThumb(dataUrl: string, size = 280): Promise<string> {
  return new Promise((resolve) => {
    const img = new globalThis.Image();
    img.onload = () => {
      const ratio = Math.min(size / img.width, size / img.height, 1);
      const w = img.width * ratio;
      const h = img.height * ratio;
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL("image/jpeg", 0.78));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function formatVibestr(raw: bigint): string {
  const whole = Number(formatUnits(raw, VIBESTR_DECIMALS));
  if (whole >= 1000) return whole.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return whole.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// ─────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────

export default function Home() {
  // ── Image source ─────────────────────────────────────────
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState<string>("");
  const [sourceIsRemote, setSourceIsRemote] = useState<boolean>(false);
  /**
   * What the image actually is, semantically. Drives the server-side
   * pipeline branch:
   *  - "photo"     → user upload; describer extracts identity, source pixels
   *                  never reach Flux
   *  - "gvc-token" → user loaded a GVC NFT via the token-ID picker; the
   *                  source IS a canonical Vibetown character — server
   *                  skips the describer and injects the NFT as a Flux
   *                  reference image (preserves body color, type, hair
   *                  exactly). See lib/vibeify-render.ts → generateVibetown.
   */
  const [sourceKind, setSourceKind] = useState<"photo" | "gvc-token">("photo");
  /**
   * Numeric GVC token id when sourceKind === "gvc-token". Used as a
   * stable label for the training-set entry produced from this render
   * (Phase 1b — see lib/training-set-local.ts).
   */
  const [sourceTokenId, setSourceTokenId] = useState<number | null>(null);

  // ── Prompt inputs ────────────────────────────────────────
  const [scene, setScene] = useState<string>(SCENE_PRESETS[0].scene);
  /** Background reference images bound to the currently-active preset, or [] when scene is custom-edited. */
  const [sceneBgImages, setSceneBgImages] = useState<string[]>(
    SCENE_PRESETS[0].bgImages ?? []
  );
  /** Which view of the scene to show when a preset is active: the reference image(s) or the prompt text. */
  const [sceneView, setSceneView] = useState<"reference" | "text">("reference");
  /** Index of the currently visible scene reference image (used when a preset has more than one). */
  const [activeBgIndex, setActiveBgIndex] = useState(0);
  const [action, setAction] = useState<string>("");
  const [mood, setMood] = useState<string>("");
  const [size, setSize] = useState<"1024x1024" | "1024x1536" | "1536x1024">(
    "1024x1024"
  );

  // ── NFT loader ───────────────────────────────────────────
  const [tokenInput, setTokenInput] = useState<string>("");
  const [loadingNft, setLoadingNft] = useState(false);

  // ── Generation state ─────────────────────────────────────
  const [generating, setGenerating] = useState(false);
  const [paying, setPaying] = useState(false);
  const [payProgress, setPayProgress] = useState<PayProgress | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [showBefore, setShowBefore] = useState(false);
  /** Last render's full prompt + describer output — for the debug panel. */
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  const [lastDescription, setLastDescription] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  // NOTE: Agent mode was previously exposed in the web UI under test mode so
  // we could exercise the x402 picker without a Base Sepolia wallet. After the
  // headless terminal flow (scripts/test-x402-agent.mjs) was verified end-to-
  // end, the in-UI agent toggle was removed. The web UI is now a pure VIBESTR
  // human flow; agent-mode rendering happens exclusively at /api/vibeify/x402.
  // The server-side resolver (lib/vibeify-render.ts → resolveVibeifyParams)
  // still supports agentMode for the x402 endpoint — only the UI surface here
  // changed.

  // ── Wallet state ─────────────────────────────────────────
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  /** VIBESTR balance (Ethereum mainnet, 18 decimals). */
  const [balance, setBalance] = useState<bigint | null>(null);
  /** USDC balance on Base mainnet (6 decimals). Read from a public RPC so it
   *  reflects on-chain reality regardless of MetaMask's currently-selected chain. */
  const [usdcBalance, setUsdcBalance] = useState<bigint | null>(null);
  const [pendingHashes, setPendingHashes] = useState<Hex[]>([]);

  // ── Payment rail ─────────────────────────────────────────
  // Default to USDC since VIBESTR is gated on the allowlist add.
  const [paymentRail, setPaymentRail] = useState<PaymentRail>("usdc");

  // ── Community-free program (FEEDBACK-V1.md) ──────────────
  // Two independent state objects:
  //   - `community`: server-confirmed eligibility for the connected
  //     wallet (≥1 GVC NFT OR ≥69,000 VIBESTR). Server is source of truth.
  //   - `freeCounter`: the public 200-render counter — visible to ALL
  //     visitors regardless of wallet status (per FEEDBACK-V1.md spec).
  const [community, setCommunity] = useState<{
    status: "pending" | "ok" | "error";
    isMember: boolean;
    qualifier: "gvc-nft" | "vibestr" | "both" | "none";
    gvcCount: number;
    vibestrWhole: number;
  } | null>(null);
  const [freeCounter, setFreeCounter] = useState<{
    available: boolean;
    remaining: number;
    refillCount: number;
  } | null>(null);
  /** User opts into the free render path when both: counter available + community member. */
  const [useFreeRender, setUseFreeRender] = useState(true);

  // ── Test-mode bypass ─────────────────────────────────────
  const [bypassAvailable, setBypassAvailable] = useState(false);
  /**
   * True when server has VIBEIFY_OPEN_ACCESS=1 set — time-bound public
   * promo (e.g. the GVC Day weekend). When on, the test-mode card drops
   * the password input and shows an open-access banner; submit sends
   * bypass=1 with no password (server accepts because OPEN_ACCESS).
   */
  const [openAccess, setOpenAccess] = useState(false);
  const [bypassMode, setBypassMode] = useState(false);
  // Test mode is server-gated by a password stored ONLY in the server's
  // VIBEIFY_BYPASS_PASSWORD env var — the client never knows the actual
  // value. We just collect whatever the user typed and let the server
  // validate on POST. Wrong password → 403 + clear toast. This keeps the
  // password out of the public client bundle entirely.
  const [bypassPassword, setBypassPassword] = useState("");

  // ── External data ────────────────────────────────────────
  const [stats, setStats] = useState<CollectionStats | null>(null);
  const [history, setHistory] = useState<Generation[]>([]);

  // ── Phase 1b training set (browser-local; GVC-source renders only) ──
  // The set lives entirely in this user's browser localStorage. We hydrate
  // on mount and only push back to storage via the helper functions in
  // lib/training-set-local.ts (privacy-floor enforced there).
  const [trainingSet, setTrainingSet] = useState<TrainingEntry[]>([]);
  /**
   * The id of the entry corresponding to the CURRENTLY displayed result.
   * Powers the sticky-state on the 👍/👎 buttons under the preview so
   * the user can see their last verdict and toggle it without re-rendering.
   * `null` when the displayed result didn't get persisted (photo source,
   * or before localStorage write completed).
   */
  const [currentEntryId, setCurrentEntryId] = useState<string | null>(null);
  /** True while a /api/training-set/submit POST is in flight. */
  const [uploadingTrainingSet, setUploadingTrainingSet] = useState(false);

  // ── Load persisted history + GVC stats + bypass flag + training set ─
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setHistory(JSON.parse(raw));
    } catch {}
    setTrainingSet(loadTrainingSet());
    getStats().then(setStats).catch(() => {});
    fetch("/api/vibeify")
      .then((r) => r.json())
      .then((d) => {
        setBypassAvailable(!!d?.bypassAvailable);
        setOpenAccess(!!d?.openAccess);
      })
      .catch(() => {});
  }, []);

  // ── Wallet bootstrap + event listeners ───────────────────
  useEffect(() => {
    if (typeof window === "undefined" || !window.ethereum) return;
    const provider = window.ethereum;

    provider
      .request({ method: "eth_accounts" })
      .then((accs: string[]) => {
        if (accs?.[0]) setAccount(accs[0] as `0x${string}`);
      })
      .catch(() => {});
    provider
      .request({ method: "eth_chainId" })
      .then((hex: string) => setChainId(parseInt(hex, 16)))
      .catch(() => {});

    const onAccounts = (accs: string[]) =>
      setAccount((accs[0] as `0x${string}`) ?? null);
    const onChain = (hex: string) => setChainId(parseInt(hex, 16));

    provider.on?.("accountsChanged", onAccounts);
    provider.on?.("chainChanged", onChain);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
    };
  }, []);

  // ── Refresh VIBESTR balance when account changes ───
  // VIBESTR lives on Ethereum mainnet, but we read it via a public mainnet RPC
  // (lib/wallet.ts → publicClient) so the balance shows regardless of which
  // chain MetaMask is currently selected. This matters because the default
  // payment rail is USDC on Base — so MetaMask is usually NOT on Ethereum
  // mainnet, and gating on chainId here would always show "…" for VIBESTR
  // even when the user actually has tokens. Mirrors the USDC effect below.
  useEffect(() => {
    if (!account) {
      setBalance(null);
      return;
    }
    getVibestrBalance(account).then(setBalance).catch(() => setBalance(null));
  }, [account]);

  // ── Refresh USDC (Base mainnet) balance when account changes ───
  // Reads via a public Base RPC, so it works regardless of MetaMask's
  // currently-selected chain. Refetched after every successful render in
  // the vibeify() handler so the displayed balance decrements live.
  useEffect(() => {
    if (!account) {
      setUsdcBalance(null);
      return;
    }
    getUsdcBalanceBase(account).then(setUsdcBalance).catch(() => setUsdcBalance(null));
  }, [account]);

  // ── Community eligibility check (server-authoritative) ───
  // Hits a small server route that runs the dual-condition check
  // (GVC NFT balance + VIBESTR balance) and returns the result. We
  // could compute it client-side too, but server-side keeps the policy
  // in one place + the server is the only one that matters for actual
  // free-render access. Re-runs whenever the connected wallet changes.
  useEffect(() => {
    if (!account) {
      setCommunity(null);
      return;
    }
    // Surface a "pending" state immediately so the UI knows the check is
    // in flight; switches to ok or error once the server responds.
    setCommunity({
      status: "pending",
      isMember: false,
      qualifier: "none",
      gvcCount: 0,
      vibestrWhole: 0,
    });
    fetch(`/api/community/eligibility?wallet=${account}`)
      .then((r) => r.json())
      .then((d) => {
        if (typeof d?.isMember === "boolean") {
          setCommunity({
            status: "ok",
            isMember: d.isMember,
            qualifier: d.qualifier,
            gvcCount: Number(d.gvcCount ?? 0),
            vibestrWhole: Number(d.vibestrWhole ?? 0),
          });
        } else {
          setCommunity({
            status: "error",
            isMember: false,
            qualifier: "none",
            gvcCount: 0,
            vibestrWhole: 0,
          });
        }
      })
      .catch(() =>
        setCommunity({
          status: "error",
          isMember: false,
          qualifier: "none",
          gvcCount: 0,
          vibestrWhole: 0,
        })
      );
  }, [account]);

  // ── Public free-render counter (visible to everyone) ─────
  // Polled on mount + every 30s so the counter stays vaguely fresh.
  // No auth — anyone visiting the site sees the live counter, which is
  // the point of the viral X-reload loop.
  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const r = await fetch("/api/free-renders/remaining");
        const d = await r.json();
        if (alive) setFreeCounter(d);
      } catch {
        if (alive) setFreeCounter(null);
      }
    }
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // ── Image source handlers ────────────────────────────────
  function setSource(
    url: string,
    label: string,
    remote: boolean,
    kind: "photo" | "gvc-token" = "photo",
    tokenId: number | null = null
  ) {
    setSourceUrl(url);
    setSourceLabel(label);
    setSourceIsRemote(remote);
    setSourceKind(kind);
    setSourceTokenId(kind === "gvc-token" ? tokenId : null);
    setResult(null);
    setShowBefore(false);
    setCurrentEntryId(null);
  }

  // Compress any locally-uploaded image to ≤~220KB before storing as the
  // source. Vercel's serverless body limit is 4.5MB; raw phone photos blow
  // through that easily (typical iPhone PNG: 15–25MB), causing 413s that
  // surface as opaque JSON-parse errors on the client. Compressing here
  // also shrinks the gpt-4o-mini describer's input + speeds up the upload.
  async function ingestLocalFile(f: File) {
    if (!f.type.startsWith("image/")) {
      toast.error("Please pick an image file");
      return;
    }
    const ingestToast = toast.loading("Preparing image…");
    try {
      const compressed = await compressForUpload(f);
      setSource(compressed.dataUrl, f.name, false);
      toast.success(
        `Image ready (${Math.round(compressed.bytes / 1024)} KB)`,
        { id: ingestToast }
      );
    } catch (e) {
      toast.error(
        `Could not process image: ${(e as Error).message}`,
        { id: ingestToast }
      );
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    void ingestLocalFile(f);
  }

  function clearSource() {
    setSourceUrl(null);
    setSourceLabel("");
    setSourceIsRemote(false);
    setSourceKind("photo");
    setSourceTokenId(null);
    setResult(null);
    setShowBefore(false);
    setTokenInput("");
    setCurrentEntryId(null);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    void ingestLocalFile(f);
  }

  async function loadGvcNft(idRaw: string) {
    const id = parseInt(idRaw, 10);
    if (Number.isNaN(id) || id < 0 || id > 6968) {
      toast.error("Token ID must be 0–6968");
      return;
    }
    setLoadingNft(true);
    try {
      const meta = await fetch("/gvc-metadata.json").then((r) => r.json());
      const token = meta[String(id)];
      if (!token?.image) throw new Error("not found");
      setSource(
        ipfsToHttp(token.image),
        token.name || `GVC #${id}`,
        true,
        "gvc-token",
        id
      );
      toast.success(`Loaded ${token.name || `GVC #${id}`}`);
    } catch {
      toast.error("Could not load that token");
    } finally {
      setLoadingNft(false);
    }
  }

  // ── Wallet ───────────────────────────────────────────────
  async function handleConnect() {
    try {
      const addr = await connectWallet();
      setAccount(addr);
      try {
        await ensureMainnet();
        const id = await (window.ethereum as { request: (a: { method: string }) => Promise<string> }).request({ method: "eth_chainId" });
        setChainId(parseInt(id, 16));
      } catch (e) {
        toast.error((e as Error).message);
      }
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  // ── The big one: pay + generate ──────────────────────────
  async function vibeify() {
    if (!sourceUrl) {
      toast.error("Pick an image first");
      return;
    }

    const testMode = bypassMode && bypassAvailable;
    // Community-free path: ONLY when (a) wallet is server-confirmed
    // eligible, (b) public counter has remaining renders, (c) the user
    // hasn't explicitly opted out, and (d) test mode isn't active
    // (test mode falls through first — see FEEDBACK-V1.md §
    // Test-mode coexistence).
    const communityFree =
      !testMode &&
      useFreeRender &&
      !!community?.isMember &&
      !!freeCounter?.available &&
      (freeCounter?.remaining ?? 0) > 0;
    const usdcRail = paymentRail === "usdc" && !testMode && !communityFree;
    const vibestrRail = paymentRail === "vibestr" && !testMode && !communityFree;

    if (!testMode) {
      if (!account) {
        toast.error("Connect your wallet first");
        return;
      }
      if (
        vibestrRail &&
        balance !== null &&
        balance < TOTAL_VIBESTR_RAW
      ) {
        toast.error(
          `Need ${TOTAL_VIBESTR} VIBESTR — you have ${formatVibestr(balance)}`
        );
        return;
      }
    }

    setGenerating(true);
    setResult(null);
    setShowBefore(false);
    setLastPrompt(null);
    setLastDescription(null);

    // ── 1. VIBESTR rail only: send the multi-tx split up front ──
    let hashes: Hex[] = pendingHashes;
    if (vibestrRail && hashes.length < SPLIT_RECIPIENTS.length) {
      setPaying(true);
      const payToast = toast.loading(
        hashes.length > 0
          ? `Resuming payment (${hashes.length}/${SPLIT_RECIPIENTS.length} sent)…`
          : `Approving ${TOTAL_VIBESTR} VIBESTR in your wallet…`
      );
      try {
        hashes = await payVibestrSplit(account!, setPayProgress, hashes);
        setPendingHashes(hashes);
        toast.success("Payment sent. Generating…", { id: payToast });
      } catch (e) {
        const msg = (e as Error).message || "Payment cancelled";
        toast.error(msg, { id: payToast });
        setGenerating(false);
        setPaying(false);
        setPayProgress(null);
        return;
      } finally {
        setPaying(false);
        setPayProgress(null);
      }
    }

    // ── 2. Build the request body ──
    const fd = new FormData();
    if (sourceIsRemote) {
      fd.set("imageUrl", sourceUrl);
    } else {
      const blob = await (await fetch(sourceUrl)).blob();
      const file = new File([blob], "source.png", {
        type: blob.type || "image/png",
      });
      fd.set("image", file);
    }
    fd.set("scene", scene);
    fd.set("action", action);
    fd.set("mood", mood);
    fd.set("size", size);
    fd.set("sourceKind", sourceKind);
    // When the source was loaded via the token-ID picker, send the
    // numeric id so the server can look up canonical traits and inject
    // a CHARACTER LOCK in the prompt. Null for photo sources OR for
    // uploaded images that were user-tagged as GVC (no specific token
    // id known).
    if (sourceKind === "gvc-token" && sourceTokenId !== null) {
      fd.set("sourceTokenId", String(sourceTokenId));
    }
    if (sceneBgImages.length > 0) {
      fd.set("sceneBgImages", sceneBgImages.join(","));
    }

    if (testMode) {
      fd.set("bypass", "1");
      // In open-access mode, the server ignores the password (env-gated
      // by VIBEIFY_OPEN_ACCESS). We still send the field for the normal
      // password-gated path; harmless extra when open access is on.
      if (!openAccess) {
        fd.set("bypassPassword", bypassPassword);
      }
    } else if (communityFree) {
      // FEEDBACK-V1.md community-free path — wallet field gets re-verified
      // server-side; no client trust on the eligibility decision.
      fd.set("freeRender", "1");
      fd.set("wallet", account!);
    } else if (vibestrRail) {
      fd.set("payer", account!);
      fd.set("txHashes", hashes.join(","));
    }

    // ── 3. Choose the right endpoint + fetch ──
    // testMode      → /api/vibeify with bypass (free)
    // communityFree → /api/vibeify/x402 with NO x402-fetch (skip signing)
    // usdcRail      → /api/vibeify/x402 with x402-fetch (real USDC payment)
    // vibestrRail   → /api/vibeify with on-chain VIBESTR txs verified server-side
    let endpoint = "/api/vibeify";
    let fetcher: typeof fetch = globalThis.fetch;

    if (communityFree) {
      // Free community render goes to the x402 route's bypass branch.
      // Plain fetch — no payment signature needed.
      endpoint = "/api/vibeify/x402";
    } else if (usdcRail) {
      endpoint = "/api/vibeify/x402";
      try {
        setPaying(true);
        const payToast = toast.loading(
          `Sign ${USDC_PRICE_DOLLARS} USDC payment in your wallet…`
        );
        fetcher = (await getX402Fetch(account!)) as typeof fetch;
        toast.dismiss(payToast);
      } catch (e) {
        toast.error((e as Error).message || "Could not prep USDC payment");
        setGenerating(false);
        setPaying(false);
        return;
      } finally {
        setPaying(false);
      }
    }

    const genToast = toast.loading("Rendering Vibetown…");
    try {
      const res = await fetcher(endpoint, { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      setResult(data.image);
      setLastPrompt(typeof data.prompt === "string" ? data.prompt : null);
      setLastDescription(
        typeof data.description === "string" ? data.description : null
      );
      setPendingHashes([]); // consumed on success
      toast.success("Vibe-ified!", { id: genToast });

      const thumb = await makeThumb(data.image);
      const rec: Generation = {
        id: Math.random().toString(36).slice(2, 9),
        ts: Date.now(),
        scene: scene.slice(0, 140),
        thumb,
        full: data.image,
        prompt: typeof data.prompt === "string" ? data.prompt : undefined,
        description:
          typeof data.description === "string" ? data.description : undefined,
      };

      // Phase 1b: persist GVC-token renders to the browser-local training set.
      // Privacy floor enforced in lib/training-set-local.ts (addEntry rejects
      // anything where sourceKind !== "gvc-token"), but we ALSO gate here so
      // we don't do the work for photo renders.
      if (sourceKind === "gvc-token") {
        // sourceTokenId may be null if the user manually tagged an
        // uploaded image as GVC (no specific token id known). The
        // privacy floor + training-set entry persistence still apply.
        const entryId = `r_${rec.id}`;
        const newSet = addTrainingEntry(trainingSet, {
          id: entryId,
          ts: rec.ts,
          sourceKind: "gvc-token",
          sourceTokenId,
          prompt: rec.prompt ?? "",
          description: rec.description,
          outputImage: data.image,
          feedback: null,
          uploadedAt: null,
        });
        setTrainingSet(newSet);
        setCurrentEntryId(entryId);
      } else {
        setCurrentEntryId(null);
      }
      const next = [rec, ...history].slice(0, 24);
      setHistory(next);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        try {
          localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify(next.map((g) => ({ ...g, full: g.thumb })))
          );
        } catch {}
      }

      // Refresh the public counter immediately after any successful free
      // render so the UI ticks down in real time (rather than waiting for
      // the next 30s poll).
      if (communityFree) {
        fetch("/api/free-renders/remaining")
          .then((r) => r.json())
          .then((d) => setFreeCounter(d))
          .catch(() => {});
      }

      // Refresh balances after payment lands. Skip in test mode where there's
      // no connected wallet (account is null and there's no balance to refetch).
      if (account) {
        getVibestrBalance(account)
          .then(setBalance)
          .catch(() => {});
        getUsdcBalanceBase(account)
          .then(setUsdcBalance)
          .catch(() => {});
      }
    } catch (e) {
      toast.error((e as Error).message || "Generation failed", { id: genToast });
      // Note: payment is already consumed on-chain. Server marks hashes used.
      // We clear pendingHashes so the user doesn't try to re-use them.
      setPendingHashes([]);
    } finally {
      setGenerating(false);
    }
  }

  /**
   * Resolve which training-set entry the current display corresponds to.
   * Falls back to the most-recent GVC-token entry if currentEntryId is
   * null for any reason (e.g. race condition after an async render +
   * state update). This keeps the feedback widget functional in edge
   * cases where the React state lifecycle didn't latch cleanly.
   */
  const currentEntry = currentEntryId
    ? trainingSet.find((e) => e.id === currentEntryId)
    : trainingSet[0]; // newest is at the front; see lib/training-set-local.ts

  /**
   * Handle a 👍/👎 click on the current render's feedback widget.
   * Sticky toggle: clicking the SAME verdict twice clears it back to null.
   */
  function handleFeedback(verdict: "up" | "down") {
    const target = currentEntry?.id;
    if (!target) return;
    const nextVerdict = currentEntry?.feedback === verdict ? null : verdict;
    const newSet = setEntryFeedback(trainingSet, target, nextVerdict);
    setTrainingSet(newSet);
  }

  /**
   * Persist the optional 1-line reason for the current render's feedback
   * (FEEDBACK-V1 — caption-quality signal beyond the binary 👍/👎).
   * Called on blur from the input so we don't write on every keystroke.
   */
  function handleFeedbackReason(reason: string) {
    const target = currentEntry?.id;
    if (!target) return;
    const newSet = setEntryFeedbackReason(trainingSet, target, reason);
    setTrainingSet(newSet);
  }

  /**
   * Voluntarily contribute rated GVC-token renders to the LoRA training
   * dataset (FEEDBACK-V1.md Phase 1c). Sends all entries that have a
   * feedback verdict AND haven't been uploaded yet. On success, marks
   * those entries with uploadedAt locally so the user doesn't see them
   * in the next batch.
   *
   * No wallet signature — per the v1 spec we keep contribution friction
   * minimal. Server-side validation enforces the gvc-token privacy
   * floor + per-batch shape checks.
   */
  async function uploadTrainingContributions() {
    if (!account) {
      toast.error("Connect a wallet first — uploads are attributed by address.");
      return;
    }
    const pending = trainingSet.filter(
      (e) => e.feedback !== null && e.uploadedAt === null
    );
    if (pending.length === 0) {
      toast("Nothing new to upload — every rated render is already in the dataset.");
      return;
    }

    setUploadingTrainingSet(true);
    const uploadToast = toast.loading(
      `Uploading 0/${pending.length}…`
    );

    // One render per POST. Each entry can be ~500 KB-1 MB as base64
    // PNG; sending 3+ in one body easily exceeds Vercel's 4.5 MB
    // serverless cap and returns a plain-text 413 (which JSON.parse
    // chokes on with "Unexpected token 'R'"). Per-entry uploads stay
    // well under the cap and give us partial-success semantics if
    // one fails mid-batch.
    const succeeded: string[] = [];
    const failures: { id: string; error: string }[] = [];
    let runningSet = trainingSet;

    for (let i = 0; i < pending.length; i++) {
      const entry = pending[i];
      toast.loading(`Uploading ${i + 1}/${pending.length}…`, {
        id: uploadToast,
      });

      try {
        const res = await fetch("/api/training-set/submit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ wallet: account, entries: [entry] }),
        });

        // Safely parse the response — 413 / 502 etc. often return
        // plain text (Vercel's "Request Entity Too Large" page),
        // which JSON.parse would throw on with a cryptic message.
        let data: { error?: string; accepted?: number; totalEntries?: number; uploadedIds?: string[] } = {};
        const text = await res.text();
        try {
          data = JSON.parse(text);
        } catch {
          data = {
            error:
              `HTTP ${res.status}: ${text.slice(0, 80) || res.statusText}`.trim(),
          };
        }

        if (!res.ok) {
          failures.push({
            id: entry.id,
            error: data.error || `HTTP ${res.status}`,
          });
        } else {
          succeeded.push(entry.id);
          // Mark this entry uploaded immediately so a partial failure
          // doesn't lose the successful uploads from this batch.
          runningSet = markUploaded(runningSet, [entry.id]);
          setTrainingSet(runningSet);
        }
      } catch (e) {
        failures.push({ id: entry.id, error: (e as Error).message });
      }
    }

    setUploadingTrainingSet(false);

    if (failures.length === 0) {
      toast.success(
        `Contributed ${succeeded.length} render${
          succeeded.length === 1 ? "" : "s"
        } 🙏`,
        { id: uploadToast }
      );
    } else if (succeeded.length === 0) {
      toast.error(
        `All ${failures.length} uploads failed. First error: ${failures[0].error}`,
        { id: uploadToast }
      );
    } else {
      toast.success(
        `Uploaded ${succeeded.length}/${pending.length}. ${failures.length} failed — first error: ${failures[0].error}`,
        { id: uploadToast }
      );
    }
  }

  function downloadResult() {
    if (!result) return;
    const a = document.createElement("a");
    a.href = result;
    a.download = `vibetown-${Date.now()}.png`;
    a.click();
  }

  function clearHistory() {
    setHistory([]);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }

  // ── Derived ──────────────────────────────────────────────
  const totalGens = history.length;
  const lastGenAgo = useMemo(() => {
    if (!history[0]) return "—";
    const m = Math.floor((Date.now() - history[0].ts) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    return `${Math.floor(m / 60)}h ago`;
  }, [history]);

  const wrongChainForVibestr =
    paymentRail === "vibestr" &&
    account &&
    chainId !== null &&
    chainId !== CHAIN_ID;
  const insufficientFunds =
    paymentRail === "vibestr" &&
    balance !== null &&
    balance < TOTAL_VIBESTR_RAW &&
    !!account &&
    !wrongChainForVibestr;
  const resumeAvailable =
    paymentRail === "vibestr" && pendingHashes.length > 0;
  const testMode = bypassMode && bypassAvailable;
  // Mirrors the server-side branch used in vibeify().
  const communityFree =
    !testMode &&
    useFreeRender &&
    !!community?.isMember &&
    !!freeCounter?.available &&
    (freeCounter?.remaining ?? 0) > 0;

  const primaryDisabled =
    !sourceUrl ||
    generating ||
    paying ||
    (!testMode && (!account || !!wrongChainForVibestr || insufficientFunds));

  const primaryLabel = (() => {
    if (paying)
      return payProgress
        ? `Approve ${payProgress.recipient} (${payProgress.index + 1}/${payProgress.total})…`
        : paymentRail === "usdc"
        ? `Sign ${USDC_PRICE_DOLLARS} payment…`
        : "Approving…";
    if (generating) return "Generating…";
    if (testMode)
      return result ? "Test render another" : "Test render (free)";
    if (!account) return "Connect wallet to Vibe-ify";
    if (communityFree)
      return result
        ? "Vibe-ify another · GVC community (free)"
        : "Vibe-ify it · GVC community (free)";
    if (paymentRail === "usdc")
      return result
        ? `Vibe-ify another · ${USDC_PRICE_DOLLARS}`
        : `Vibe-ify it · ${USDC_PRICE_DOLLARS}`;
    // VIBESTR-rail branches (effectively unreachable while VIBESTR is disabled
    // in the UI, but kept for when the GVC allowlist add re-enables it).
    if (wrongChainForVibestr) return "Switch to Ethereum Mainnet";
    if (insufficientFunds)
      return `Need ${TOTAL_VIBESTR} VIBESTR (you have ${
        balance ? formatVibestr(balance) : "0"
      })`;
    if (resumeAvailable)
      return `Resume payment (${pendingHashes.length}/${SPLIT_RECIPIENTS.length} sent)`;
    if (result) return "Vibe-ify another";
    return "Vibe-ify it";
  })();

  return (
    <main className="min-h-screen relative px-4 sm:px-8 py-10 overflow-hidden">
      {/* Ambient embers */}
      <div className="absolute inset-0 pointer-events-none">
        {[...Array(12)].map((_, i) => (
          <div
            key={i}
            className={`ember ${i % 3 === 0 ? "ember-lg" : ""}`}
            style={{
              left: `${5 + i * 8}%`,
              top: `${10 + (i % 5) * 18}%`,
              animationDelay: `${i * 0.5}s`,
              animationDuration: `${5 + (i % 4)}s`,
            }}
          />
        ))}
      </div>

      <div className="relative z-10 max-w-7xl mx-auto">
        {/* ── GVC Day Open Weekend banner ──────────────────
            Only renders when the server has VIBEIFY_OPEN_ACCESS=1 set
            (time-bound promo flag — flip off post-event to disappear).
            Echoes the 6.9 GVC Day artwork; gold-on-dark with a soft
            pulse to draw the eye without being shouty. */}
        {openAccess && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6 px-4 sm:px-6 py-3 rounded-2xl border border-gvc-gold/40 bg-gradient-to-r from-gvc-gold/15 via-gvc-gold/8 to-gvc-gold/15 flex items-center gap-3 sm:gap-4 flex-wrap"
          >
            <span className="font-display text-xl sm:text-2xl text-gvc-gold tracking-tight whitespace-nowrap">
              🎉 GVC Day Open Weekend
            </span>
            <span className="font-body text-sm sm:text-base text-white/80">
              Free renders for everyone through{" "}
              <span className="text-gvc-gold font-semibold">6.9.26</span> — no
              wallet, no password. Just turn on{" "}
              <span className="text-gvc-gold">Test mode</span> and Vibeify.
            </span>
          </motion.div>
        )}

        {/* ── Header ─────────────────────────────────────── */}
        <motion.header
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center justify-between mb-10 flex-wrap gap-4"
        >
          <div className="flex items-center gap-5">
            <Image
              src="/shaka.png"
              alt="GVC"
              width={72}
              height={72}
              className="shaka-idle drop-shadow-[0_0_24px_rgba(255,224,72,0.45)]"
            />
            <div>
              <h1 className="text-4xl sm:text-6xl font-display font-black text-shimmer leading-none tracking-tight">
                VIBE-O-MATIC
              </h1>
              <p className="text-white/50 font-body text-sm sm:text-base mt-2">
                Drop any image → get it back as a tiny, cinematic Vibetown scene.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <WalletPill
              account={account}
              balance={balance}
              usdcBalance={usdcBalance}
              wrongChain={!!wrongChainForVibestr}
              onConnect={handleConnect}
            />
          </div>
        </motion.header>

        {/* ── Main grid ──────────────────────────────────── */}
        <div className="grid lg:grid-cols-[1fr_400px] gap-6">
          {/* Preview */}
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="rounded-2xl bg-gvc-dark border border-white/[0.08] p-5 card-glow"
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <span
                  className={`w-2 h-2 rounded-full ${
                    generating || paying
                      ? "bg-pink-accent animate-pulse"
                      : "bg-gvc-green animate-pulse"
                  }`}
                />
                <p className="font-body text-sm uppercase tracking-wider text-white/50">
                  {paying
                    ? "Awaiting wallet…"
                    : generating
                    ? "Rendering Vibetown…"
                    : "Preview"}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {result && sourceUrl && (
                  <button
                    onClick={() => setShowBefore((s) => !s)}
                    className="text-white/50 hover:text-gvc-gold text-sm font-body transition-colors"
                  >
                    {showBefore ? "Show after" : "Show before"}
                  </button>
                )}
                <p className="text-white/30 font-body text-sm">
                  {sourceLabel || size}
                </p>
              </div>
            </div>

            <div
              onDrop={onDrop}
              onDragOver={(e) => e.preventDefault()}
              className={`relative rounded-xl overflow-hidden border border-white/[0.08] bg-gvc-black flex items-center justify-center ${
                size === "1024x1536"
                  ? "aspect-[2/3]"
                  : size === "1536x1024"
                  ? "aspect-[3/2]"
                  : "aspect-square"
              }`}
            >
              <AnimatePresence mode="wait">
                {result && !showBefore && (
                  <motion.img
                    key="after"
                    src={result}
                    alt="Vibetown render"
                    initial={{ opacity: 0, scale: 1.02 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.4 }}
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                )}
                {sourceUrl && (!result || showBefore) && (
                  <motion.img
                    key="before"
                    src={sourceUrl}
                    alt="Source"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: result ? 1 : 0.85 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.3 }}
                    className="absolute inset-0 w-full h-full object-contain bg-gvc-black"
                  />
                )}
              </AnimatePresence>

              {!sourceUrl && !generating && (
                <div className="relative text-center p-8">
                  <div className="text-5xl mb-3 opacity-70">🎬</div>
                  <p className="text-white/60 font-display text-lg mb-1">
                    Drop an image here
                  </p>
                  <p className="text-white/30 font-body text-sm">
                    or pick a GVC token on the right →
                  </p>
                </div>
              )}

              {(generating || paying) && (
                <div className="absolute inset-0 bg-gvc-black/60 backdrop-blur-sm flex flex-col items-center justify-center">
                  <div className="text-4xl animate-pulse mb-2">
                    {paying ? "💸" : "✨"}
                  </div>
                  <p className="text-gvc-gold font-display text-sm mb-1">
                    {paying
                      ? payProgress
                          ? `Sign ${payProgress.recipient} payment (${payProgress.index + 1}/${payProgress.total})`
                          : "Waiting for wallet…"
                      : "Rendering Vibetown"}
                  </p>
                  <p className="text-white/40 font-body text-sm">
                    {paying ? "Approve in your wallet" : "Usually 30–60 seconds"}
                  </p>
                </div>
              )}

              {result && !showBefore && (
                <div className="absolute top-3 left-3 flex items-center gap-1.5 bg-black/60 backdrop-blur px-2.5 py-1 rounded-full text-xs font-body uppercase tracking-wider text-gvc-gold border border-gvc-gold/30">
                  <span className="w-1.5 h-1.5 rounded-full bg-gvc-gold animate-pulse" />
                  Vibetown v6
                </div>
              )}
              {showBefore && result && (
                <div className="absolute top-3 left-3 bg-black/60 backdrop-blur px-2.5 py-1 rounded-full text-xs font-body uppercase tracking-wider text-white/70 border border-white/20">
                  Original
                </div>
              )}
            </div>

            {/* Community-free program (FEEDBACK-V1.md). A prominent card
                replacing the prior tiny pill — sits between the preview
                and the payment-rail toggle so users read the free-render
                context BEFORE choosing a payment path.

                Always visible when the program is provisioned. When a
                wallet is connected, also surfaces the per-wallet
                eligibility status (loading / eligible / not eligible)
                so the user can SEE why they do or don't see the free
                option. */}
            {freeCounter?.available && (
              <div
                className={`mt-4 rounded-2xl border-2 p-4 transition-all ${
                  freeCounter.remaining > 20
                    ? "bg-gvc-gold/[0.08] border-gvc-gold/40 shadow-[0_0_24px_rgba(255,224,72,0.15)]"
                    : freeCounter.remaining > 0
                    ? "bg-orange-accent/10 border-orange-accent/40"
                    : "bg-pink-accent/10 border-pink-accent/40"
                }`}
              >
                {/* Big public counter */}
                <div className="flex items-center justify-center gap-3">
                  <span
                    className={`w-3 h-3 rounded-full ${
                      freeCounter.remaining > 20
                        ? "bg-gvc-green animate-pulse"
                        : freeCounter.remaining > 0
                        ? "bg-orange-accent animate-pulse"
                        : "bg-pink-accent"
                    }`}
                  />
                  {freeCounter.remaining > 0 ? (
                    <p className="font-display text-xl text-white">
                      <span className="text-3xl text-gvc-gold">
                        {freeCounter.remaining}
                      </span>{" "}
                      <span className="text-white/70 text-base">
                        / 200 free community renders left
                      </span>
                    </p>
                  ) : (
                    <p className="font-display text-xl text-pink-accent">
                      Free tier exhausted — ping for a reload
                    </p>
                  )}
                </div>

                {/* Connected-wallet eligibility status — always visible when
                    a wallet is connected so the user can see what the server
                    thinks of their wallet, even if they're not eligible. */}
                {account && (
                  <div className="mt-3 pt-3 border-t border-white/[0.08] text-center">
                    {community?.status === "pending" && (
                      <p className="text-sm font-body text-white/40">
                        Checking community eligibility…
                      </p>
                    )}

                    {community?.status === "ok" &&
                      community.isMember &&
                      freeCounter.remaining > 0 && (
                        <label className="inline-flex items-center gap-2.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={useFreeRender}
                            onChange={(e) =>
                              setUseFreeRender(e.target.checked)
                            }
                            className="w-4 h-4 accent-gvc-gold"
                          />
                          <span className="font-body text-sm text-white">
                            <span className="font-display text-gvc-gold">
                              Community member ✓
                            </span>{" "}
                            — use free render{" "}
                            <span className="text-white/50">
                              (qualified via{" "}
                              {community.qualifier === "gvc-nft"
                                ? `${community.gvcCount} GVC NFT${
                                    community.gvcCount === 1 ? "" : "s"
                                  }`
                                : community.qualifier === "vibestr"
                                ? `${community.vibestrWhole.toLocaleString()} VIBESTR`
                                : `${community.gvcCount} GVC + ${community.vibestrWhole.toLocaleString()} VIBESTR`}
                              )
                            </span>
                          </span>
                        </label>
                      )}

                    {community?.status === "ok" && !community.isMember && (
                      <p className="text-sm font-body text-white/50">
                        Wallet not eligible for free renders ·{" "}
                        <span className="text-white/40">
                          have {community.gvcCount} GVC NFT
                          {community.gvcCount === 1 ? "" : "s"} ·{" "}
                          {community.vibestrWhole.toLocaleString()} VIBESTR
                          (need ≥1 GVC OR ≥69,000 VIBESTR)
                        </span>
                      </p>
                    )}

                    {community?.status === "error" && (
                      <p className="text-sm font-body text-pink-accent">
                        Could not check eligibility — try refreshing
                      </p>
                    )}
                  </div>
                )}

                {/* X-reload button — shows at low counter regardless of wallet */}
                {freeCounter.remaining <= 20 && (
                  <div className="mt-3 pt-3 border-t border-white/[0.08] text-center">
                    <a
                      href={`https://x.com/intent/tweet?text=${encodeURIComponent(
                        `Hey @economist — the @GoodVibesClub vibe-o-matic free tier is on ${freeCounter.remaining} / 200 renders. Reload incoming? 🙏 https://vibe-o-matic.vercel.app`
                      )}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 text-sm font-body font-semibold text-pink-accent hover:text-gvc-gold transition-colors"
                    >
                      🐦 Ping @economist on X for a reload
                    </a>
                  </div>
                )}
              </div>
            )}

            {/* Payment rail selector — sits directly below the preview so the
                user sees their payment choice before the Vibe-ify CTA.
                VIBESTR on the left (disabled — pending GVC allowlist add),
                USDC on the right (active default). */}
            <div
              className={`mt-4 flex items-center justify-center gap-2 transition-opacity ${
                testMode ? "opacity-30 pointer-events-none" : ""
              }`}
            >
              <div className="inline-flex rounded-full bg-black/40 border border-white/[0.08] p-0.5">
                <button
                  onClick={() =>
                    toast(
                      "VIBESTR rail goes live once the GVC team adds our treasury to the recipient allowlist. Coordinating now."
                    )
                  }
                  className="px-3 py-1 rounded-full text-sm font-display text-white/40 cursor-not-allowed flex items-center gap-1.5"
                >
                  {TOTAL_VIBESTR.toString()} VIBESTR
                  <span className="px-1.5 py-px rounded-full bg-pink-accent/20 text-pink-accent text-[11px] uppercase tracking-wider">
                    soon
                  </span>
                </button>
                <button
                  onClick={() => setPaymentRail("usdc")}
                  disabled={testMode}
                  className={`px-3 py-1 rounded-full text-sm font-display transition-all ${
                    paymentRail === "usdc"
                      ? "bg-gvc-gold text-gvc-black"
                      : "text-white/60 hover:text-white"
                  }`}
                >
                  {USDC_PRICE_DOLLARS} USDC
                </button>
              </div>
            </div>
            <div
              className={`mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs font-body transition-opacity ${
                testMode ? "opacity-30" : "text-white/40"
              }`}
            >
              {paymentRail === "usdc" ? (
                <>
                  <span>Base</span>
                  <span className="text-white/20">·</span>
                  <span>1 signature</span>
                  <span className="text-white/20">·</span>
                  <span>gasless (x402)</span>
                </>
              ) : (
                <>
                  <span>Ethereum · 1 sig per render</span>
                  {SPLIT_RECIPIENTS.map((r) => (
                    <span key={r.address} className="flex items-center gap-1">
                      <span className="text-white/20">·</span>
                      <span className="text-white/60">
                        {(Number(TOTAL_VIBESTR) * r.percent) / 100}
                      </span>
                      <span>→ {r.name}</span>
                    </span>
                  ))}
                </>
              )}
            </div>

            <div className="flex gap-3 mt-5">
              <button
                onClick={vibeify}
                disabled={primaryDisabled}
                className="flex-1 px-4 py-3 rounded-xl bg-gvc-gold text-gvc-black font-display font-bold text-sm hover:shadow-[0_0_24px_rgba(255,224,72,0.4)] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {primaryLabel}
              </button>
              <button
                onClick={downloadResult}
                disabled={!result}
                className="px-4 py-3 rounded-xl bg-gvc-gray/60 border border-white/[0.08] text-white/80 font-body text-sm hover:border-gvc-gold/30 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Download PNG
              </button>
            </div>

            {/* Phase 1b: feedback widget — 👍/👎 under each render.
                Shows ANY time there's a rendered result so the user
                always sees the feedback affordance — photo-source
                renders get a clear "not saved" disclosure inline
                rather than silently hiding the widget (privacy floor
                still holds: photo renders never persist, but we want
                the UI to explain that, not just vanish). */}
            {result && sourceKind === "gvc-token" && (
              <FeedbackWidget
                currentVerdict={currentEntry?.feedback ?? null}
                currentReason={currentEntry?.feedbackReason ?? ""}
                onVote={handleFeedback}
                onReason={handleFeedbackReason}
              />
            )}
            {result && sourceKind === "photo" && (
              <p className="mt-3 text-center text-xs font-body text-white/30 italic">
                Photo renders aren&apos;t saved — only GVC token renders
                contribute to the LoRA training set.
              </p>
            )}

            {/* Debug panel — prompt + describer output for the last render */}
            {(lastPrompt || lastDescription) && (
              <div className="mt-3 rounded-xl border border-white/[0.08] bg-black/40 overflow-hidden">
                <button
                  onClick={() => setShowDebug((v) => !v)}
                  className="w-full px-4 py-2 flex items-center justify-between text-left text-sm font-body text-white/50 hover:text-white/80 transition-colors"
                >
                  <span className="flex items-center gap-2">
                    <span className="text-gvc-gold/70">{showDebug ? "▾" : "▸"}</span>
                    <span>Show what was sent to the model</span>
                  </span>
                  <span className="text-white/30">
                    {lastPrompt ? `${Math.round(lastPrompt.length / 4)} tokens approx` : ""}
                  </span>
                </button>
                {showDebug && (
                  <div className="border-t border-white/[0.08] px-4 py-3 space-y-3 max-h-[400px] overflow-y-auto">
                    {lastDescription && (
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <p className="text-xs uppercase tracking-wider font-body text-white/40">
                            Describer output (gpt-4o-mini)
                          </p>
                          <button
                            onClick={() => {
                              navigator.clipboard?.writeText(lastDescription);
                              toast.success("Description copied");
                            }}
                            className="text-xs font-body text-white/30 hover:text-gvc-gold"
                          >
                            copy
                          </button>
                        </div>
                        <pre className="text-sm font-mono text-white/70 whitespace-pre-wrap leading-snug">
                          {lastDescription}
                        </pre>
                      </div>
                    )}
                    {lastPrompt && (
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <p className="text-xs uppercase tracking-wider font-body text-white/40">
                            Render prompt (to FLUX.2 [pro])
                          </p>
                          <button
                            onClick={() => {
                              navigator.clipboard?.writeText(lastPrompt);
                              toast.success("Prompt copied");
                            }}
                            className="text-xs font-body text-white/30 hover:text-gvc-gold"
                          >
                            copy
                          </button>
                        </div>
                        <pre className="text-sm font-mono text-white/70 whitespace-pre-wrap leading-snug">
                          {lastPrompt}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

          </motion.section>

          {/* Controls — panels stack at their natural heights. The
              test-mode panel sits at the bottom of this column so it
              co-locates with the other render controls and fills the
              vertical space below Action & mood without forcing flex-1
              stretching (which created internal dead space). */}
          <motion.aside
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className="flex flex-col gap-4"
          >
            <Panel title="1. Your image">
              {sourceUrl && (
                <div className="flex items-center gap-2 mb-3 px-2.5 py-1.5 rounded-lg bg-gvc-gold/10 border border-gvc-gold/30">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={sourceUrl}
                    alt={sourceLabel}
                    className="w-8 h-8 rounded object-cover border border-white/10"
                  />
                  <span className="flex-1 text-sm font-body text-gvc-gold truncate">
                    {sourceLabel || "Loaded"}
                  </span>
                  <button
                    onClick={clearSource}
                    aria-label="Clear current image"
                    className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full bg-black/40 border border-white/10 text-white/60 text-sm hover:text-pink-accent hover:border-pink-accent/40 transition-all"
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* Tag-as-GVC toggle — when checked, routes the source
                  through the gvc-token pipeline (skip describer, inject
                  source as Flux reference). For token-loader sources,
                  the toggle is pre-checked + disabled (the loader path
                  always sets sourceKind=gvc-token + a real tokenId).
                  For uploads, toggle is user-controlled; checking it
                  treats the upload as a canonical GVC character with
                  no specific token id known. */}
              {sourceUrl && (
                <label
                  className={`mb-3 flex items-center gap-2 text-xs font-body select-none ${
                    sourceTokenId !== null
                      ? "text-white/40 cursor-not-allowed"
                      : "text-white/70 cursor-pointer"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={sourceKind === "gvc-token"}
                    disabled={sourceTokenId !== null}
                    onChange={(e) =>
                      setSourceKind(e.target.checked ? "gvc-token" : "photo")
                    }
                    className="accent-gvc-gold"
                  />
                  <span>
                    This is a GVC character{" "}
                    <span className="text-white/30">
                      ({sourceTokenId !== null
                        ? "set automatically from token loader"
                        : "skip describer, use image as a direct reference"})
                    </span>
                  </span>
                </label>
              )}
              <label className="block">
                <span className="block text-white/50 font-body text-sm mb-2">
                  Upload
                </span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={onFile}
                  onClick={(e) => {
                    // Reset value so picking the same file twice still fires onChange.
                    (e.currentTarget as HTMLInputElement).value = "";
                  }}
                  className="block w-full text-sm text-white/70 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-gvc-gold file:text-gvc-black file:font-body file:font-semibold file:cursor-pointer"
                />
              </label>
              <div className="mt-4">
                <span className="block text-white/50 font-body text-sm mb-2">
                  Or load a GVC token (0–6968)
                </span>
                <div className="flex gap-2">
                  <input
                    type="number"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    placeholder="5618"
                    className="flex-1 px-3 py-2 rounded-lg bg-black/60 border border-white/[0.08] text-white text-sm font-body focus:border-gvc-gold/40 outline-none"
                  />
                  <button
                    onClick={() => loadGvcNft(tokenInput)}
                    disabled={loadingNft}
                    className="px-3 py-2 rounded-lg bg-gvc-gold/15 border border-gvc-gold/30 text-gvc-gold font-body text-sm font-semibold hover:bg-gvc-gold/25 transition-all disabled:opacity-50"
                  >
                    {loadingNft ? "…" : "Load"}
                  </button>
                </div>
              </div>
            </Panel>

            <Panel title="2. The scene">
              <div className="flex flex-wrap gap-1 mb-3">
                {SCENE_PRESETS.map((p) => {
                  const active = scene === p.scene;
                  return (
                    <button
                      key={p.label}
                      onClick={() => {
                        setScene(p.scene);
                        setSceneBgImages(p.bgImages ?? []);
                        setSceneView("reference");
                        setActiveBgIndex(0);
                      }}
                      className={`text-sm font-body px-2 py-1 rounded-full border transition-all ${
                        active
                          ? "bg-gvc-gold/15 border-gvc-gold/50 text-gvc-gold"
                          : "bg-black/30 border-white/[0.08] text-white/60 hover:border-white/20"
                      }`}
                    >
                      {p.emoji} {p.label}
                    </button>
                  );
                })}
                {/* "Freeform" chip — clears the preset + reference
                    backgrounds entirely. Lets users type their own
                    scene prompt in the textarea below (or leave it
                    blank for a generic Vibetown fallback). */}
                <button
                  onClick={() => {
                    setScene("");
                    setSceneBgImages([]);
                    setSceneView("text");
                  }}
                  className={`text-sm font-body px-2 py-1 rounded-full border transition-all ${
                    scene.trim() === "" && sceneBgImages.length === 0
                      ? "bg-gvc-gold/15 border-gvc-gold/50 text-gvc-gold"
                      : "bg-black/30 border-white/[0.08] text-white/60 hover:border-white/20"
                  }`}
                  title="Skip scene preset; type your own (or leave blank for default)"
                >
                  ✍️ Freeform
                </button>
              </div>

              {sceneBgImages.length > 0 ? (
                <>
                  {/* View toggle — reference image vs text prompt */}
                  <div className="flex items-center gap-1 mb-3 p-0.5 bg-black/40 rounded-lg w-fit">
                    <button
                      onClick={() => setSceneView("reference")}
                      className={`text-xs font-body uppercase tracking-wider px-3 py-1 rounded-md transition-all ${
                        sceneView === "reference"
                          ? "bg-gvc-gold/15 text-gvc-gold"
                          : "text-white/40 hover:text-white/70"
                      }`}
                    >
                      Reference
                    </button>
                    <button
                      onClick={() => setSceneView("text")}
                      className={`text-xs font-body uppercase tracking-wider px-3 py-1 rounded-md transition-all ${
                        sceneView === "text"
                          ? "bg-gvc-gold/15 text-gvc-gold"
                          : "text-white/40 hover:text-white/70"
                      }`}
                    >
                      Text
                    </button>
                  </div>

                  {sceneView === "reference" ? (
                    <div>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/scenes/${sceneBgImages[activeBgIndex] ?? sceneBgImages[0]}`}
                        alt={sceneBgImages[activeBgIndex] ?? sceneBgImages[0]}
                        className="w-full aspect-video object-contain rounded-lg border border-gvc-gold/30 bg-black/40"
                      />
                      {sceneBgImages.length > 1 && (
                        <div className="flex gap-1.5 mt-2 justify-center">
                          {sceneBgImages.map((_, i) => (
                            <button
                              key={i}
                              onClick={() => setActiveBgIndex(i)}
                              aria-label={`Show scene reference ${i + 1}`}
                              className={`w-6 h-6 rounded-full text-xs font-body font-semibold transition-all ${
                                activeBgIndex === i
                                  ? "bg-gvc-gold text-gvc-black"
                                  : "bg-black/40 border border-white/10 text-white/50 hover:border-gvc-gold/40 hover:text-white/80"
                              }`}
                            >
                              {i + 1}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <textarea
                      value={scene}
                      onChange={(e) => {
                        setScene(e.target.value);
                        // Custom text-edited scenes get no bg refs — clear them.
                        setSceneBgImages([]);
                      }}
                      rows={4}
                      placeholder="Describe the environment…"
                      className="w-full px-3 py-2 rounded-lg bg-black/60 border border-white/[0.08] text-white text-sm font-body focus:border-gvc-gold/40 outline-none resize-none"
                    />
                  )}
                </>
              ) : (
                <textarea
                  value={scene}
                  onChange={(e) => {
                    setScene(e.target.value);
                    setSceneBgImages([]);
                  }}
                  rows={3}
                  placeholder="Describe the environment…"
                  className="w-full px-3 py-2 rounded-lg bg-black/60 border border-white/[0.08] text-white text-sm font-body focus:border-gvc-gold/40 outline-none resize-none"
                />
              )}
            </Panel>

            <Panel title="3. Action & mood (optional)">
              <p className="text-xs font-body uppercase tracking-wider text-white/40 mb-1.5">
                Action
              </p>
              <div className="flex flex-wrap gap-1 mb-2">
                {ACTION_PRESETS.map((p) => {
                  const active = action === p.prompt;
                  return (
                    <button
                      key={p.label}
                      onClick={() => setAction(active ? "" : p.prompt)}
                      className={`text-sm font-body px-2 py-1 rounded-full border transition-all ${
                        active
                          ? "bg-gvc-gold/15 border-gvc-gold/50 text-gvc-gold"
                          : "bg-black/30 border-white/[0.08] text-white/60 hover:border-white/20"
                      }`}
                    >
                      {p.emoji} {p.label}
                    </button>
                  );
                })}
              </div>
              <input
                type="text"
                value={action}
                onChange={(e) => setAction(e.target.value)}
                placeholder="…or type your own action"
                className="w-full px-3 py-2 rounded-lg bg-black/60 border border-white/[0.08] text-white text-sm font-body focus:border-gvc-gold/40 outline-none mb-4"
              />

              <p className="text-xs font-body uppercase tracking-wider text-white/40 mb-1.5">
                Mood
              </p>
              <div className="flex flex-wrap gap-1 mb-2">
                {MOOD_PRESETS.map((p) => {
                  const active = mood === p.prompt;
                  return (
                    <button
                      key={p.label}
                      onClick={() => setMood(active ? "" : p.prompt)}
                      className={`text-sm font-body px-2 py-1 rounded-full border transition-all ${
                        active
                          ? "bg-gvc-gold/15 border-gvc-gold/50 text-gvc-gold"
                          : "bg-black/30 border-white/[0.08] text-white/60 hover:border-white/20"
                      }`}
                    >
                      {p.emoji} {p.label}
                    </button>
                  );
                })}
              </div>
              <input
                type="text"
                value={mood}
                onChange={(e) => setMood(e.target.value)}
                placeholder="…or type your own mood"
                className="w-full px-3 py-2 rounded-lg bg-black/60 border border-white/[0.08] text-white text-sm font-body focus:border-gvc-gold/40 outline-none"
              />
              <div className="flex gap-2 mt-3">
                {(["1024x1024", "1024x1536", "1536x1024"] as const).map((s) => {
                  const label =
                    s === "1024x1024"
                      ? "Square"
                      : s === "1024x1536"
                      ? "Portrait"
                      : "Landscape";
                  const active = size === s;
                  return (
                    <button
                      key={s}
                      onClick={() => setSize(s)}
                      className={`flex-1 px-2 py-1.5 rounded-lg text-sm font-body transition-all ${
                        active
                          ? "bg-gvc-gold/15 border border-gvc-gold/50 text-gvc-gold"
                          : "bg-black/30 border border-white/[0.08] text-white/60"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </Panel>

            {/* Test-mode panel — two surfaces depending on server state.
                Default: password-gated free renders for the team. The
                toggle stays disabled until the typed password is non-empty
                client-side; the server independently validates on POST
                and returns 403 if wrong. The password lives ONLY in
                VIBEIFY_BYPASS_PASSWORD on the server.
                Open-access (VIBEIFY_OPEN_ACCESS=1 server-side): the
                password input is dropped + a GVC-Day-themed banner takes
                its place; toggle works without any input. Time-bound
                public promo. Server enforces — client just adapts UX. */}
            {bypassAvailable && (
              <div
                className={`px-3 py-2 rounded-xl border ${
                  testMode
                    ? "bg-pink-accent/10 border-pink-accent/40"
                    : openAccess
                    ? "bg-gvc-gold/10 border-gvc-gold/40"
                    : "bg-black/30 border-white/[0.08]"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-base">{openAccess ? "🎉" : "🧪"}</span>
                    <div className="min-w-0">
                      <p
                        className={`font-display text-sm ${
                          testMode
                            ? "text-pink-accent"
                            : openAccess
                            ? "text-gvc-gold"
                            : "text-white/70"
                        }`}
                      >
                        {openAccess
                          ? "GVC Day Open Weekend"
                          : "Test mode"}
                      </p>
                      <p className="text-xs font-body text-white/50 truncate">
                        {testMode
                          ? openAccess
                            ? "Free render — happy GVC Day weekend!"
                            : "Free render — no payment. Disable for real renders."
                          : openAccess
                          ? "Free renders all weekend — no password, no wallet"
                          : "Password-gated free renders for the team."}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      // Open access: toggle freely.
                      // Password-gated: require SOMETHING typed (server
                      // does the real validation on POST).
                      if (openAccess || bypassPassword.length > 0) {
                        setBypassMode((v) => !v);
                      } else {
                        toast.error("Enter the test-mode password first");
                      }
                    }}
                    disabled={!openAccess && bypassPassword.length === 0}
                    className={`shrink-0 relative w-10 h-5 rounded-full transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                      testMode
                        ? "bg-pink-accent"
                        : openAccess
                        ? "bg-gvc-gold/70"
                        : "bg-gvc-gray"
                    }`}
                    aria-label="Toggle test mode"
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                        testMode ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>
                {/* Password input — required to unlock the toggle UNLESS
                    open-access is on (in which case the toggle is the only
                    affordance needed). */}
                {!testMode && !openAccess && (
                  <input
                    type="password"
                    value={bypassPassword}
                    onChange={(e) => setBypassPassword(e.target.value)}
                    placeholder="Password"
                    className="mt-2 w-full px-2.5 py-1.5 rounded-lg bg-black/40 border border-white/[0.08] text-white text-sm font-body focus:border-pink-accent/40 outline-none"
                  />
                )}
              </div>
            )}
          </motion.aside>
        </div>

        {/* ── Phase 1b/1c: training contributions panel ──────
            Sits ABOVE the Agent API panel so users who just rendered
            see their accumulated contributions and the upload
            affordance before scrolling past to the agent-developer
            content. Appears as soon as the user has rendered 1+
            GVC-token (dropped from the spec's original 3+ rated
            threshold per user feedback). */}
        {trainingSet.length >= 1 && (
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="mt-6"
          >
            <ContributionsPanel
              entries={trainingSet}
              ratedCount={countRated(trainingSet)}
              pendingUpload={pendingUploadCount(trainingSet)}
              uploadedCount={
                trainingSet.filter((e) => e.uploadedAt !== null).length
              }
              uploading={uploadingTrainingSet}
              walletConnected={!!account}
              onUpload={uploadTrainingContributions}
              onClear={() => {
                if (
                  typeof window !== "undefined" &&
                  window.confirm(
                    "Clear all locally-saved training contributions? This cannot be undone."
                  )
                ) {
                  setTrainingSet(clearTrainingSet());
                  setCurrentEntryId(null);
                }
              }}
            />
          </motion.section>
        )}

        {/* ── Agent API — full-width CTA for autonomous integrations ─── */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.22 }}
          className={trainingSet.length >= 1 ? "mt-4" : "mt-6"}
        >
          <AgentEndpointCard />
        </motion.section>

        {/* ── Stats — single full-width card matching Agent API's width ─ */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="mt-4"
        >
          <div className="rounded-2xl bg-gvc-dark border border-white/[0.08] p-5 grid grid-cols-2 gap-6">
            <Stat inline label="Total renders" value={totalGens} />
            <Stat inline label="Last render" valueText={lastGenAgo} />
          </div>
        </motion.section>

        {/* ── History ────────────────────────────────────── */}
        {history.length > 0 && (
          <motion.section
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
            className="mt-6 rounded-2xl bg-gvc-dark border border-white/[0.08] p-5"
          >
            <div className="flex items-center justify-between mb-4">
              <p className="text-white/40 font-body text-sm uppercase tracking-wider">
                Your Vibetown gallery
              </p>
              <button
                onClick={clearHistory}
                className="text-white/30 hover:text-pink-accent text-sm font-body transition-colors"
              >
                Clear history
              </button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {history.map((g) => (
                <button
                  key={g.id}
                  onClick={() => {
                    setResult(g.full);
                    setShowBefore(false);
                    setScene(g.scene);
                    // If the loaded scene matches a preset, restore its bg refs;
                    // otherwise the user was on custom text and we leave bgs empty.
                    const matched = SCENE_PRESETS.find((p) => p.scene === g.scene);
                    setSceneBgImages(matched?.bgImages ?? []);
                    setLastPrompt(g.prompt ?? null);
                    setLastDescription(g.description ?? null);
                  }}
                  className="group text-left rounded-xl overflow-hidden border border-white/[0.08] bg-black/40 hover:border-gvc-gold/40 transition-all"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={g.thumb}
                    alt={g.scene}
                    className="w-full aspect-square object-cover group-hover:opacity-90 transition-opacity"
                  />
                  <div className="p-2">
                    <p className="font-body text-sm text-white/70 line-clamp-2 leading-snug">
                      {g.scene}
                    </p>
                    <p className="text-xs text-white/30 font-body mt-1">
                      {new Date(g.ts).toLocaleString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        month: "short",
                        day: "numeric",
                      })}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </motion.section>
        )}

        <p className="text-center text-white/30 text-sm font-body mt-10">
          vibe-o-matic · FLUX.2 [pro] · OpenAI gpt-4o-mini · x402 on Base · made
          for the GVC community
        </p>
        <p className="text-center text-white/30 text-sm font-body mt-1.5">
          <a
            href="https://github.com/economist5/vibe-o-matic"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-gvc-gold transition-colors inline-flex items-center gap-1.5"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="w-4 h-4 fill-current"
            >
              <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2.17c-3.2.7-3.87-1.37-3.87-1.37-.52-1.32-1.27-1.68-1.27-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.76 2.69 1.25 3.35.96.1-.74.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.21-1.5 3.18-1.18 3.18-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.84 1.18 3.1 0 4.42-2.7 5.39-5.27 5.68.41.36.78 1.07.78 2.16v3.2c0 .31.21.68.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
            </svg>
            View source on GitHub
          </a>
        </p>
      </div>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────
// Small components
// ─────────────────────────────────────────────────────────────

/**
 * 👍 / 👎 feedback widget for the FEEDBACK-V1 training-set program.
 * Sticky state: shows the current verdict, clicking the same vote twice
 * clears it back to no-verdict. Once a verdict is set, an optional
 * 1-line reason input appears for users who want to add caption-quality
 * context ("nose came back", "perfect skin tone", etc.). Only rendered
 * for GVC-token sources.
 */
function FeedbackWidget({
  currentVerdict,
  currentReason,
  onVote,
  onReason,
}: {
  currentVerdict: "up" | "down" | null;
  currentReason: string;
  onVote: (verdict: "up" | "down") => void;
  onReason: (reason: string) => void;
}) {
  // Local input state — only commits to the training set on blur or
  // Enter so we don't churn the React state + localStorage on every
  // keystroke. Synced down whenever the parent's currentReason changes
  // (e.g. after a new render where the new entry has its own reason).
  const [localReason, setLocalReason] = useState(currentReason);
  useEffect(() => {
    setLocalReason(currentReason);
  }, [currentReason]);

  return (
    <div className="mt-3 flex flex-col items-center gap-2">
      <div className="flex items-center justify-center gap-3">
        <span className="text-xs font-body text-white/40 uppercase tracking-wider">
          Rate this render
        </span>
        <button
          onClick={() => onVote("up")}
          aria-label="Mark this render as good"
          className={`px-3 py-1.5 rounded-full text-base transition-all border ${
            currentVerdict === "up"
              ? "bg-gvc-green/20 border-gvc-green/50 shadow-[0_0_12px_rgba(46,255,46,0.15)]"
              : "bg-black/30 border-white/[0.08] hover:border-gvc-green/40 hover:bg-gvc-green/[0.08]"
          }`}
        >
          👍
        </button>
        <button
          onClick={() => onVote("down")}
          aria-label="Mark this render as off-spec"
          className={`px-3 py-1.5 rounded-full text-base transition-all border ${
            currentVerdict === "down"
              ? "bg-pink-accent/20 border-pink-accent/50 shadow-[0_0_12px_rgba(255,107,157,0.15)]"
              : "bg-black/30 border-white/[0.08] hover:border-pink-accent/40 hover:bg-pink-accent/[0.08]"
          }`}
        >
          👎
        </button>
      </div>

      {/* Optional 1-line reason — only surfaces once a verdict is set
          so the widget stays compact until the user has chosen to
          engage. Saved on blur or Enter to avoid keystroke-rate writes. */}
      {currentVerdict !== null && (
        <input
          type="text"
          value={localReason}
          onChange={(e) => setLocalReason(e.target.value.slice(0, 200))}
          onBlur={() => onReason(localReason)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder={
            currentVerdict === "up"
              ? "Optional: what worked? (e.g. perfect skin tone, hair color)"
              : "Optional: what was off? (e.g. nose came back, scene felt flat)"
          }
          maxLength={200}
          aria-label="Optional reason for your rating"
          className="w-full max-w-md px-3 py-1.5 rounded-lg bg-black/40 border border-white/[0.08] text-white text-sm font-body placeholder:text-white/30 focus:border-gvc-gold/40 outline-none"
        />
      )}
    </div>
  );
}

/**
 * "Your contributions" panel — surfaces once the user has rated 3+
 * GVC-token renders. Shows the count, a thumbnail strip, and a (Phase
 * 1c, not yet wired) upload button placeholder.
 */
function ContributionsPanel({
  entries,
  ratedCount,
  pendingUpload,
  uploadedCount,
  uploading,
  walletConnected,
  onUpload,
  onClear,
}: {
  entries: TrainingEntry[];
  ratedCount: number;
  pendingUpload: number;
  uploadedCount: number;
  uploading: boolean;
  walletConnected: boolean;
  onUpload: () => void;
  onClear: () => void;
}) {
  const recent = entries.slice(0, 8);
  const uploadDisabled = pendingUpload === 0 || uploading || !walletConnected;
  return (
    <div className="rounded-2xl bg-gradient-to-br from-gvc-dark to-black border border-gvc-gold/30 p-6 shadow-[0_0_40px_rgba(255,224,72,0.05)]">
      <div className="flex items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-2">
          <span className="text-base">📁</span>
          <p className="font-display text-sm uppercase tracking-[0.18em] text-gvc-gold">
            Your training contributions
          </p>
        </div>
        <button
          onClick={onClear}
          className="text-white/30 hover:text-pink-accent text-xs font-body transition-colors"
        >
          Clear
        </button>
      </div>

      <div className="flex items-center gap-4 mb-4 flex-wrap">
        <div className="flex flex-col">
          <p className="font-display text-3xl text-gvc-gold tracking-wide tabular-nums">
            {ratedCount}
          </p>
          <p className="text-[11px] font-body uppercase tracking-wider text-white/40">
            rated renders
          </p>
        </div>
        <div className="h-12 w-px bg-white/10" />
        <div className="flex flex-col">
          <p className="font-display text-3xl text-white/80 tracking-wide tabular-nums">
            {uploadedCount}
          </p>
          <p className="text-[11px] font-body uppercase tracking-wider text-white/40">
            already uploaded
          </p>
        </div>
        <div className="h-12 w-px bg-white/10" />
        <div className="flex flex-col">
          <p
            className={`font-display text-3xl tracking-wide tabular-nums ${
              pendingUpload > 0 ? "text-orange-accent" : "text-white/40"
            }`}
          >
            {pendingUpload}
          </p>
          <p className="text-[11px] font-body uppercase tracking-wider text-white/40">
            ready to upload
          </p>
        </div>
      </div>

      {recent.length > 0 && (
        <div className="grid grid-cols-4 sm:grid-cols-8 gap-2 mb-4">
          {recent.map((e) => (
            <div
              key={e.id}
              className={`relative aspect-square rounded-lg overflow-hidden border ${
                e.uploadedAt !== null
                  ? "border-gvc-green/40"
                  : "border-white/[0.08]"
              }`}
              title={`Token #${e.sourceTokenId}${
                e.feedback === "up"
                  ? " · 👍"
                  : e.feedback === "down"
                  ? " · 👎"
                  : ""
              }${e.uploadedAt !== null ? " · uploaded" : ""}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={e.outputImage}
                alt={`Token #${e.sourceTokenId}`}
                className="w-full h-full object-cover"
              />
              {e.feedback && (
                <span className="absolute bottom-1 right-1 text-xs">
                  {e.feedback === "up" ? "👍" : "👎"}
                </span>
              )}
              {e.uploadedAt !== null && (
                <span className="absolute top-1 left-1 text-[10px] bg-gvc-green/90 text-gvc-black font-display rounded px-1">
                  ↑
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3">
        <button
          onClick={onUpload}
          disabled={uploadDisabled}
          className={`w-full px-4 py-3 rounded-xl font-display font-bold text-sm transition-all ${
            uploadDisabled
              ? "bg-gvc-gray/30 border border-white/[0.06] text-white/30 cursor-not-allowed"
              : "bg-gvc-gold text-gvc-black hover:shadow-[0_0_24px_rgba(255,224,72,0.4)]"
          }`}
        >
          {uploading
            ? "Uploading…"
            : !walletConnected
            ? "Connect wallet to upload"
            : pendingUpload === 0
            ? "All rated renders uploaded ✓"
            : `📤 Upload ${pendingUpload} render${
                pendingUpload === 1 ? "" : "s"
              } for LoRA training`}
        </button>
        <p className="text-xs font-body text-white/40 leading-relaxed text-center">
          Voluntary. Only rated GVC-token renders upload. Nothing else leaves
          your browser. Your renders contribute to a future GVC LoRA fine-tune
          that closes the stochastic-artifact gap. 🐢
        </p>
      </div>
    </div>
  );
}

function Panel({
  title,
  children,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl bg-gvc-dark border border-white/[0.08] p-5 ${className}`}
    >
      <p className="font-display text-sm text-white mb-3">{title}</p>
      {children}
    </div>
  );
}

function WalletPill({
  account,
  balance,
  usdcBalance,
  wrongChain,
  onConnect,
}: {
  account: `0x${string}` | null;
  balance: bigint | null;
  usdcBalance: bigint | null;
  wrongChain: boolean;
  onConnect: () => void;
}) {
  if (!account) {
    return (
      <button
        onClick={onConnect}
        className="px-4 py-2 rounded-full bg-gvc-gold text-gvc-black font-display font-bold text-sm hover:shadow-[0_0_20px_rgba(255,224,72,0.4)] transition-all"
      >
        Connect Wallet
      </button>
    );
  }
  if (wrongChain) {
    return (
      <button
        onClick={onConnect}
        className="px-4 py-2 rounded-full bg-pink-accent/20 border border-pink-accent/40 text-pink-accent font-body font-semibold text-sm"
      >
        Switch to Mainnet
      </button>
    );
  }
  // USDC has 6 decimals. Use viem's formatUnits + a Number-based decimal
  // formatter so the result is guaranteed to be e.g. "$3.25" or "$1,234.56"
  // — never "$325" or "$3250000" if a bigint→Number conversion went wonky.
  const usdcText =
    usdcBalance !== null
      ? `$${Number(formatUnits(usdcBalance, 6)).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`
      : "…";
  const vibestrText =
    balance !== null ? formatVibestr(balance) : "…";
  return (
    // Two-row card: address on top, both balances clearly labeled below.
    // Width is constrained to 400px on lg+ to align the right edge with
    // the controls column (image / scene / action panels), so the wallet
    // visually sits "above" its rails. On mobile it stretches naturally.
    // Balances are justified to the two ends of the row so VIBESTR sits
    // at the left edge and USDC at the right — full-width air between
    // them, no awkward middle clump.
    <div className="flex flex-col gap-1.5 px-4 py-2.5 rounded-2xl bg-gvc-dark border border-white/[0.08] w-full lg:w-[400px]">
      <div className="flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-gvc-green" />
        <span className="font-body text-sm text-white/70">{shortAddr(account)}</span>
      </div>
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col items-start leading-tight">
          <span className="font-body text-[10px] uppercase tracking-wider text-white/40">
            VIBESTR
          </span>
          <span className="font-display text-base text-gvc-gold tracking-wide tabular-nums">
            {vibestrText}
          </span>
        </div>
        <div className="flex flex-col items-end leading-tight">
          <span className="font-body text-[10px] uppercase tracking-wider text-white/40">
            USDC (Base)
          </span>
          <span className="font-display text-base text-gvc-gold tracking-wide tabular-nums">
            {usdcText}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * AgentEndpointCard — CTA cell for AI-agent developers landing on the
 * page. Lives in the stats row in place of the prior "GVC floor" stat.
 * Designed to fill more vertical space than the neighboring Stat cells so
 * its contents (header, endpoint code block, price line, copy buttons) have
 * breathing room without feeling crowded.
 */
function AgentEndpointCard() {
  const endpoint =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/vibeify/x402`
      : "https://vibe-o-matic.vercel.app/api/vibeify/x402";
  const repoBase = "https://github.com/economist5/vibe-o-matic";

  // A one-liner that anyone can paste into a terminal to see what the
  // endpoint quotes (price, network, facilitator). No payment, no setup.
  const discoverySnippet = `curl -s ${endpoint}`;

  // Multi-line "where to start" snippet that points users at the script
  // itself as the source of truth (--help lists every option) and demos
  // the recommended flag-based call shape rather than putting a raw
  // private key on the command line.
  const runSnippet = `# vibe-o-matic agent runner ($0.69 USDC per call, Base mainnet)
# The Node script is self-documenting — start with --help.

# 1) Clone + install (one-time)
git clone https://github.com/economist5/vibe-o-matic
cd vibe-o-matic && npm install

# 2) See every available option (canonical reference)
node scripts/test-x402-agent.mjs --help

# 3) Recommended call shape — reads your key DIRECTLY from a JSON
#    credentials store (no jq, no temp files, no shell history exposure).
#    --credential-path: any JSON file with the key under a top-level field
#                       (default field name: privateKey; override with
#                       --credential-key <name>).
#    --image <path>:    any portrait of a PERSON. Non-person subjects
#                       (logos, animals, objects) produce unpredictable
#                       renders — the describer is tuned for humans.
node scripts/test-x402-agent.mjs \\
  --credential-path ~/.your-creds-store/base-default.json \\
  --image ~/.your-media-store/inbound/portrait.jpg \\
  "your free-text intent"
`;

  const copy = (text: string, label: string) => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => toast.success(`${label} copied — paste into your terminal`))
      .catch(() => toast.error("Copy failed"));
  };

  return (
    <div className="rounded-2xl bg-gradient-to-br from-gvc-dark to-black border border-gvc-gold/30 p-6 shadow-[0_0_40px_rgba(255,224,72,0.05)]">
      {/* Header spans the whole width */}
      <div className="flex items-center justify-between gap-2 mb-4">
        <p className="font-display text-sm uppercase tracking-[0.18em] text-gvc-gold flex items-center gap-1.5">
          <span className="text-base">🤖</span>
          Agent API
        </p>
        <a
          href={`${repoBase}/blob/main/X402.md`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-body text-gvc-gold/70 hover:text-gvc-gold transition-colors"
        >
          Full docs ↗
        </a>
      </div>

      {/* Three-column body for the full-width layout. Stacks on mobile. */}
      <div className="grid md:grid-cols-3 gap-4">
        {/* Column 1 — How it works */}
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] font-body uppercase tracking-wider text-white/30">
            How it works
          </p>
          <ol className="space-y-1.5 text-sm font-body text-white/70 leading-snug">
            <li className="flex gap-2">
              <span className="text-gvc-gold/70 font-display">1.</span>
              <span>Agent sends a photo + free-text intent</span>
            </li>
            <li className="flex gap-2">
              <span className="text-gvc-gold/70 font-display">2.</span>
              <span>Agent signs one gasless USDC authorization ($0.69)</span>
            </li>
            <li className="flex gap-2">
              <span className="text-gvc-gold/70 font-display">3.</span>
              <span>~40s later, image returned + USDC settled on-chain</span>
            </li>
          </ol>
        </div>

        {/* Column 2 — Endpoint */}
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] font-body uppercase tracking-wider text-white/30">
            Endpoint
          </p>
          <div className="rounded-lg bg-black/50 border border-white/[0.08] px-3 py-2 flex-1">
            <code className="font-mono text-[12px] text-gvc-gold break-all leading-tight block">
              POST /api/vibeify/x402
            </code>
            <p className="text-xs font-body text-white/40 mt-1.5">
              Base mainnet · x402 / EIP-3009
            </p>
            <p className="text-xs font-body text-white/40">
              No API key required
            </p>
          </div>
        </div>

        {/* Column 3 — Actions */}
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] font-body uppercase tracking-wider text-white/30">
            Try it
          </p>
          <button
            onClick={() => copy(discoverySnippet, "Discovery curl")}
            title="One curl command that shows the endpoint's current price quote."
            className="font-body px-4 py-3 rounded-lg bg-black/40 border border-white/[0.08] text-white/80 hover:border-gvc-gold/40 hover:text-gvc-gold transition-all text-left"
          >
            <span className="block text-sm font-semibold">See the price</span>
            <span className="block text-sm text-white/40 mt-1">
              Discovery curl
            </span>
          </button>
          <button
            onClick={() => copy(runSnippet, "Run script")}
            title="Multi-line annotated setup + first render command. Paste, read the comments, fill in your key + photo, run."
            className="font-body px-4 py-3 rounded-lg bg-black/40 border border-white/[0.08] text-white/80 hover:border-gvc-gold/40 hover:text-gvc-gold transition-all text-left"
          >
            <span className="block text-sm font-semibold">Run a render</span>
            <span className="block text-sm text-white/40 mt-1">
              Setup + first render script
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  valueText,
  inline = false,
}: {
  label: string;
  value?: number;
  valueText?: string;
  /** When true, render WITHOUT the rounded-card wrapper — useful when
   *  the parent already provides a card and just needs the label+value
   *  block inline (e.g. multiple stats in one shared card). */
  inline?: boolean;
}) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    if (typeof value !== "number") return;
    let start = 0;
    const step = Math.max(1, value / 24);
    const t = setInterval(() => {
      start += step;
      if (start >= value) {
        setDisplay(value);
        clearInterval(t);
      } else {
        setDisplay(Math.floor(start));
      }
    }, 25);
    return () => clearInterval(t);
  }, [value]);

  const content = (
    <>
      <p className="text-white/40 font-body text-xs uppercase tracking-wider mb-1">
        {label}
      </p>
      <p className="font-display text-3xl text-gvc-gold">
        {typeof value === "number" ? display.toLocaleString() : valueText ?? "—"}
      </p>
    </>
  );

  if (inline) {
    return <div className="flex flex-col justify-center">{content}</div>;
  }

  return (
    <div className="rounded-2xl bg-gvc-dark border border-white/[0.08] p-5 flex flex-col justify-center">
      {content}
    </div>
  );
}
