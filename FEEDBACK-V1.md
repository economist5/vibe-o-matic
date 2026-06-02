# vibe-o-matic — community testing + LoRA feedback program (v1 spec)

Operational plan for opening the human UI free to the GVC community in
exchange for opt-in feedback data that becomes a LoRA training set.

> **Status: ✅ All three phases shipped + live in production.**
> - Phase 1a (eligibility + counter + X-reload): commit `52ea6d8`
> - Phase 1b (feedback widget + browser-local training set): commit `bce436c`
> - Phase 1c (voluntary contribution upload to Vercel Blob): commit `333cf06`
> - Phase 1d (post-launch tweaks from early testers): commit `1647814`
>   — tag-as-GVC checkbox on uploads, "Freeform" scene chip, optional
>   1-line feedback reason
>
> Operational state captured in [`LAUNCH.md`](./LAUNCH.md) (env vars +
> smoke tests) and [`WIRING.md`](./WIRING.md) (storage handoff). The
> downstream LoRA-training pipeline lives in [`LORA-PIPELINE.md`](./LORA-PIPELINE.md).

This doc captures the v1 design + design decisions that motivated the
shipped behaviour. Each phase below is annotated with the commit it
landed in. Future spec changes start by editing the relevant section
here, then propagating to the implementation.

---

## 🎯 Goal

Two things at once:

1. **Open the human UI free** to verified GVC community members so the
   render flow gets exercised at scale by people who actually love the
   GVC aesthetic — generating organic feedback, viral X moments, and
   community engagement.
2. **Capture a training set** for fine-tuning a vibe-o-matic-specific
   LoRA over Flux 2 [pro], orthogonal to the GVC-team-provided-LoRA
   pitch in FUTURE.md. Two paths to "production-quality renders," not
   one.

End state: a labeled set of `{rendered image, full prompt, 👍/👎}`
tuples — enough to fine-tune a Flux LoRA that closes the 10% stochastic-
artifact gap measured in SUBMISSION.md.

---

## 🚪 Eligibility

A wallet qualifies for free renders if **either** condition holds:

| Condition | Source of truth | Address |
|---|---|---|
| Holds ≥ 1 GVC NFT | `balanceOf(wallet)` on ERC-721 | `0xB8Ea78fcaCEf50d41375E44E6814ebbA36Bb33c4` (Ethereum mainnet) |
| Holds ≥ 69,000 VIBESTR | `balanceOf(wallet)` on ERC-20 (18 decimals) | `0xd0cC2b0eFb168bFe1f94a948D8df70FA10257196` (Ethereum mainnet) |

Both reads run server-side via a public Ethereum RPC. Result cached for
5 minutes per wallet to avoid hammering the RPC on every render.

**UI surface**: when a qualifying wallet connects, a "Community member ✓"
pill appears in the header next to the existing balance card, with a
sub-label like `"via 3 GVC tokens"` or `"via 72,401 VIBESTR"` so the
user knows which condition triggered.

---

## 🎟️ The 200-render counter

A single atomic counter, public, visible on the homepage near the
Vibe-ify CTA: `"178 / 200 free community renders left"`.

- **Storage**: Vercel KV key `vibeify:free-renders:remaining`, initialized
  to 200. Atomic `DECR` on every successful free render.
- **Public read endpoint**: `GET /api/free-renders/remaining` returns
  `{ remaining, refillCount }` for the UI pill.
- **Exhaustion behavior**: when `remaining ≤ 0`, the free path closes.
  The UI surface flips to:
    - Disable the "free render" toggle
    - Show the X-reload button (see next section)
    - The $0.69 USDC paid flow remains available — eligible community
      members can still pay if they want.
- **Refill mechanism**: `POST /api/admin/refill` gated by the
  `VIBEIFY_ADMIN_TOKEN` env var. Two modes:
    - `?n=N` → adds N to the counter (atomic `INCRBY`) + bumps `refillCount`. The normal refill action.
    - `?set=N` → overrides the counter to exactly N (atomic `SET`) without touching `refillCount`. For corrections (e.g. a double-refill mistake) or marketing dial-ups to an exact number.
  Used by the original author manually when they decide to top up or correct.
- **Per-wallet quota**: NONE. A single GVC holder could theoretically
  consume all 200 if they wanted to. The 200 total is the bound.

---

## 🐦 X-reload viral loop

When `remaining ≤ 20` OR `remaining = 0`, surface a button on the home
page near the counter:

  **🐦 Ping @economist on X for a reload**

Click opens an X compose intent with editable pre-filled text:

  > "Hey @economist — the @GoodVibesClub vibe-o-matic free tier is on
  > **[N]** / 200 renders. Reload incoming? 🙏
  > https://vibe-o-matic.vercel.app"

Net mechanic: counter ticks down publicly → community pings on X
→ original author manually refills via the admin endpoint → counter
resets → cycle repeats. Each cycle is a viral moment for the project.

---

## 👍 / 👎 feedback widget

After every successful render (regardless of source kind or payment
path), two micro-buttons appear under the result:

  `[👍 Good render]   [👎 Off-spec]`

- **Choice is sticky** — once clicked, the buttons swap to a confirmed
  state showing the rating; can be changed by clicking again
- **Optional 1-line reason** — once a verdict is set, a small text
  input surfaces below the buttons. Users can optionally type a
  short reason ("nose came back", "perfect skin tone", "scene too
  busy") — trimmed + capped at 200 chars in the UI, mirrored by
  server-side validation on upload. Used downstream as a quality
  signal during dataset curation (see LORA-PIPELINE.md). Added in
  Phase 1d after early testers asked for a way to surface *why* a
  render fell flat.
- **Stored in browser `localStorage`** under key
  `vibe-o-matic:training-set` (NEVER auto-sent to a server)

---

## 💾 What gets persisted, and where

**Privacy floor: only `sourceKind === "gvc-token"` renders are persisted
to the training set.** Photo-source renders show the feedback widget for
UX symmetry, but their data never enters local storage or the upload
path. NFT art is public on-chain; user photos contain identity.

### Tag-as-GVC (Phase 1d — opt-in upload bypass)

After Phase 1c shipped, early testers asked for a way to contribute
renders made from uploaded images they *know* depict a GVC token (e.g.
a screenshot of one). Per privacy floor, those would otherwise stay
strictly browser-local.

Phase 1d added a **"This is a GVC NFT" checkbox** in the upload panel
when the source is a user upload. Mechanics:

- For sources loaded via the GVC token ID picker: checkbox is
  pre-checked + disabled (sourceKind is unambiguously `"gvc-token"`,
  `sourceTokenId` known).
- For user uploads: checkbox is unchecked by default, user-controlled.
  Checking it sets `sourceKind = "gvc-token"` with
  `sourceTokenId = null` on the resulting entry — voluntary opt-in to
  the training-set persistence + upload path.

The privacy floor still holds (only sourceKind === "gvc-token" entries
persist) — Phase 1d just adds a user-driven on-ramp for "I know this
*is* GVC, please count it." A photo of a person remains photo-source
no matter what; the user just doesn't have any reason to tick the box.

### Per-render localStorage entry

```ts
{
  id: "r_abc123",
  ts: 1716966200,
  sourceKind: "gvc-token",         // only kind that ever lands here
  sourceTokenId: 5618 | null,      // number when loaded by token ID;
                                   // null when user tagged an upload as GVC
  prompt: "...",                   // full Flux prompt
  description: "",                 // empty for gvc-token path (no describer)
  outputImage: "data:image/...",   // the rendered PNG as data URL
  feedback: "up" | "down" | null,  // user verdict
  feedbackReason?: string,         // optional 1-line reason, ≤200 chars
  uploadedAt: number | null,       // unix ms when POSTed to server; null = not yet
}
```

Browser `localStorage` is the source of truth for everything until the
user voluntarily uploads. They can rate at their leisure; nothing leaks
to a server until they click submit. The `uploadedAt` field lets the
ContributionsPanel show "X new entries to upload" so users don't waste
bandwidth re-uploading already-contributed data.

### Voluntary contribution endpoint

When the user has rated 3+ renders, a "📁 Your contributions" panel
appears with their thumbnail strip plus a button:

  **📤 Upload `[N]` renders for LoRA training**

Click → `POST /api/training-set/submit` with the localStorage payload
in the request body. **No wallet signature prompt** (per the v1 spec —
keep contribution friction minimal). Server validates that:
- All entries have `sourceKind === "gvc-token"`
- Payload is well-formed
- No malicious image bytes (basic mime sniffing)

Then writes to Vercel Blob:

```
training-set/
  ├── manifests/
  │   └── {wallet}.json           # accumulates with every upload from this wallet
  └── images/
      └── {wallet}/
          ├── r_abc123.png
          └── r_xyz456.png
```

Per-wallet manifest accumulates over time (each new submission appends
to the existing manifest if any). Image blobs are content-addressed by
the render ID so dedup is free.

### Access for the project owner

- **Vercel Dashboard**: Storage → Blob → browse / download any blob
- **CLI**: `vercel blob list --prefix=training-set/`
- **Bulk export script** (Phase 3 territory): `npm run export-training-set --since 2026-06-01` → bundles all blobs into `./training-data-{date}/`, ready to feed into Replicate / fal.ai LoRA trainer

Storage is **private** by default — only the project's Blob read token
can list/download. Random users cannot scrape the dataset.

---

## 🧩 Test-mode coexistence

Three independent free-render unlock paths:

| Path | Unlock | Bound | UI surface |
|---|---|---|---|
| 🔑 Test mode | Server-validated password | None | Existing test-mode card (right column) |
| 💎 Community member | GVC NFT ≥1 OR VIBESTR ≥69,000 | 200-render counter | New "Community member ✓" pill in header |
| 💵 USDC paid | Anyone with $0.69 USDC | None | Existing Vibe-ify CTA |

They compose — a connected community member with the test-mode password
falls through to test mode first (no counter decrement). The counter
only decrements when the community-member path is actively used.

---

## 📅 Phased implementation

Each phase ships as a single approval-gated commit + push. Vercel
deploys, we verify, move on.

### Phase 1a — Eligibility + counter ✅ shipped (commit `52ea6d8`)
- Add `getGvcNftBalance()` to `lib/wallet.ts` (mirror of `getVibestrBalance`)
- Add `lib/community-eligibility.ts` with cache + dual-condition check
- Set up Vercel KV (one-time dashboard config + env vars)
- Endpoints: `GET /api/free-renders/remaining`, `POST /api/admin/refill`
- UI: community-member pill in header, public counter near CTA, X-reload
  button at threshold
- Server: bypass x402 step when `isMember && remaining > 0`; decrement
  counter on success

### Phase 1b — Feedback widget + localStorage ✅ shipped (commit `bce436c`)
- 👍/👎 buttons under each render
- localStorage persistence layer with the schema above
- "Your contributions" panel surface
- All UI; no server changes

### Phase 1c — Voluntary contribution endpoint ✅ shipped (commit `333cf06`)
- `POST /api/training-set/submit` (no wallet sig)
- Vercel Blob writes (manifest + images), `access: "private"`
- Per-entry upload loop (avoids Vercel's 4.5 MB body cap) — partial
  success accounting in the response
- Toast confirmation on successful upload
- One end-to-end smoke test before announcing the program

### Phase 1d — Post-launch tweaks from early testers ✅ shipped (commit `1647814`)
Three small but meaningful adds after the first 24h of community use:
- **Tag-as-GVC checkbox** in the upload panel — opt-in path for users
  contributing renders made from images they confirm depict GVC tokens
  (sets `sourceTokenId = null`, but `sourceKind = "gvc-token"`)
- **"✍️ Freeform" chip** in the scene panel — clears the scene + scene
  bg images so the user can write any scene description in free text
  (a "no preset" escape hatch)
- **Optional 1-line feedback reason** — text input that surfaces after
  👍/👎 verdict is set; trimmed + capped at 200 chars; surfaces as a
  caption-quality signal during LoRA curation

Plus a fix backlog from Phase 1c testing (commits `9c97453`, `41c93cb`,
`114661c`):
- React-state-as-source-of-truth pattern in `lib/training-set-local.ts`
  (fixed the ratings-don't-stick-after-the-first bug under localStorage
  quota pressure)
- Per-entry upload (no more 413) + ContributionsPanel relocated above
  the Agent API panel
- Blob `access: "private"` (matches store config)

### Phase 2+ (future, not in this spec)
- Bulk export script
- Admin UI for browsing/curating the training set
- LoRA training itself (off-platform, runs on Replicate/fal.ai)
- A/B benchmarking the trained LoRA vs current pipeline

---

## 💰 Cost estimate (Phase 1)

Per free render (vibe-o-matic's side): ~$0.046 (OpenAI + Flux).

200 renders × $0.046 = **~$9.20 per refill cycle**.

Vercel KV (free tier covers 30k commands/day; we'd use ~400 commands per
200-render cycle — utterly negligible).

Vercel Blob (free tier 1 GB / 10 GB bandwidth; 200 renders × ~500 KB =
~100 MB; we use 10% of the free tier per cycle).

Net cost per cycle: ~$10 of subsidized renders. Manageable for community
testing.

---

## ⚠️ Risks / things to monitor

- **Counter race conditions** — Vercel KV `INCR`/`DECR` are atomic; the
  serial DECR happens AFTER the render succeeds. Worst case: render
  succeeds but counter write fails → user got a free render off-budget.
  Acceptable at this scale.
- **Spoofed contribution uploads** — without wallet signing, anyone
  could POST garbage to the contribution endpoint. Mitigations: payload
  validation + rate-limiting by IP + the privacy floor (only
  gvc-token-source data accepted means even a flood of garbage uploads
  with wrong sourceKind get rejected at validation).
- **Photo-source feedback widget creates confusion** — user might wonder
  why their thumbs-up didn't enable upload. Solve with clear copy on
  the contribution panel: "Only GVC token renders are kept; photo
  renders remain in your browser only."
- **Community member could whale the counter** — a single qualifying
  wallet could in principle eat all 200. v1 accepts this; if it becomes
  a real issue, add per-wallet caps in a follow-up.

---

*This doc is the contract for the community-testing program. Update it
when any of the eligibility / counter / storage rules change.*
