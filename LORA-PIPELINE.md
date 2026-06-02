# vibe-o-matic — LoRA training pipeline

How the community-contributed training set ([FEEDBACK-V1.md](./FEEDBACK-V1.md))
gets turned into a vibe-o-matic-tuned LoRA over Flux 2 [pro] — and how
the resulting LoRA gets swapped back into the live render pipeline.

> **Status as of this doc:**
> - ✅ Dataset collection pipeline **live in production** (FEEDBACK-V1
>   Phase 1a/1b/1c shipped)
> - ⏳ Bulk-export script — **planned, not yet built**
> - ⏳ Training run — **planned, requires curated dataset of ~200-500
>   high-quality entries**
> - ⏳ Deployment swap — **planned, ~1 day of work once a LoRA exists**

The LoRA itself isn't urgent — it's a v2 quality upgrade. This doc
captures the concrete plan so whoever takes the next step (original
author, GVC team, or a community contributor) can execute without
re-deriving it from scratch.

---

## 🎯 Why a LoRA at all

Today, vibe-o-matic coerces a general-purpose image model (Flux 2 [pro])
into producing GVC-style figurines via:

- A ~200-line text prompt full of rules ("no nose", "facial hair
  replaces the mouth", "olive = warm beige not green")
- Seven reference images per call (1 body T-pose, 4 face refs, up to
  2 scene backgrounds)
- A vision-first describer that strips identity-preserving traits
  from a source photo before they reach the renderer

It works, but the model is always *fighting its priors*. Every "no
nose" line exists because Flux's defaults pull elsewhere. Stochastic
artifacts (phantom mouths inside beards, occasional nose regressions,
skin-tone drift) show up in ~10% of renders precisely because the
rules have to win on every single call.

A LoRA layer trained on GVC characters bakes those rules into the
model weights. The "no nose" default becomes the model's actual
default. The fight stops.

| Today | With a GVC LoRA |
|---|---|
| ~200-line prompt fighting model priors | ~10-line prompt; model already knows GVC |
| Stochastic phantom-mouth / nose / skin artifacts (~10%) | Target: < 2% |
| 7 reference images per call | Could drop to 1-2 (scene refs only) |
| Identity preserved via describer (kept) | Same |
| ~$0.045 per render | Slightly lower (fewer ref images uploaded) |
| ~30-40 s render | Slightly faster |

---

## 📦 What the dataset looks like today

When a community member uploads via FEEDBACK-V1 Phase 1c, Vercel Blob
accumulates per-wallet folders:

```
training-set/
  ├── images/
  │   └── {wallet}/
  │       ├── r_abc123.png          # rendered PNG, ~500 KB-1 MB
  │       └── r_xyz456.png
  └── manifests/
      └── {wallet}.json             # per-wallet metadata, append-only
```

Per-entry shape inside the manifest:

```json
{
  "id": "r_abc123",
  "ts": 1716966200,
  "sourceKind": "gvc-token",          // privacy floor — only NFT renders
  "sourceTokenId": 5618,              // number when loaded by token ID;
                                      // null when user tagged an upload as GVC (Phase 1d)
  "prompt": "...",                    // the full prompt sent to Flux
  "description": "",                  // empty for gvc-token path (no describer ran)
  "feedback": "up" | "down" | null,   // user verdict (👍/👎)
  "feedbackReason": "nose came back", // OPTIONAL 1-line reason (Phase 1d), ≤200 chars; undefined if user didn't provide one
  "uploadedAt": 1716968400,           // when the user clicked Upload (browser side)
  "imageUrl": "https://.../r_abc123.png",
  "serverUploadedAt": 1716968402
}
```

Quality signals to use during curation:

1. **User verdict (`feedback`).** The Phase 1c client only includes
   entries with non-null feedback in each upload batch, so the
   manifest already filters to "user actively rated this." Every entry
   is a deliberate verdict.
2. **Reason text (`feedbackReason`).** When present, this is the most
   valuable curation signal — users typed it specifically because
   something was good or off. Common patterns:
   - 👎 + "nose came back" → strong negative example, prioritize for
     the LoRA's "no nose" defense
   - 👍 + "perfect skin tone" → flag as gold for the LoRA's color
     calibration
   - 👍/👎 with no reason → background signal, used for verdict-only
     filtering
3. **Source token diversity (`sourceTokenId`).** Want broad GVC trait
   coverage — track which trait combinations are over- or under-
   represented in upvoted entries. `sourceTokenId: null` entries
   (Phase 1d user-tagged uploads) are still usable but lack the
   metadata cross-reference; weight them slightly lower in the
   curation pass.

**Privacy floor**: only `sourceKind === "gvc-token"` entries are
persisted. Photo uploads never leave the user's browser. GVC NFTs are
public on-chain art — using them as training material is privacy-clean.
Phase 1d added an opt-in "tag this upload as GVC" checkbox; users
voluntarily ticking it accept persistence of that render. Their `null`
`sourceTokenId` is the marker that this was opt-in rather than picker-
loaded.

---

## 🚀 End-to-end pipeline

Five steps to turn the live dataset into a deployed LoRA. Steps 1+2
are repeatable (export new data, curate, train again). Step 3+ is the
one-time deployment.

### Step 1 — Bulk-export from Vercel Blob (~1 hour to build)

Not yet built. The plan:

`scripts/export-training-set.mjs`:
- Reads `BLOB_READ_WRITE_TOKEN` from env
- Lists all blobs in `training-set/manifests/`
- For each manifest, downloads via SDK `get(key, { access: "private" })`
- Filters to `feedback === "up"` entries (positive examples)
- For each upvoted entry, downloads the corresponding PNG from
  `training-set/images/{wallet}/{id}.png`
- Outputs to `./training-data-{date}/`:

```
training-data-2026-06-15/
  ├── images/
  │   ├── 0xabc..._r_abc123.png         # flat file list, dedup-safe naming
  │   ├── 0xabc..._r_xyz456.png
  │   └── 0xdef..._r_qwe789.png
  ├── captions/
  │   ├── 0xabc..._r_abc123.txt         # one caption per image, Flux-LoRA format
  │   ├── 0xabc..._r_xyz456.txt
  │   └── 0xdef..._r_qwe789.txt
  └── MANIFEST.json                     # full metadata for traceability
```

Caption format: take the full prompt + an explicit trigger word at
the front:

```
vibetown_figurine, standing close together in a relaxed group, …
```

The trigger word lets us selectively activate the LoRA at inference
time. Default suggestion: `vibetown_figurine`.

Cost: free (read-only from Blob).

### Step 2 — Curate (manual, ~2-4 hours)

Walk through the exported images. Remove:
- Model failures that snuck past user 👍 (rare but possible)
- Near-duplicates (same source token + similar pose — LoRA training
  doesn't need redundancy)
- Anything that doesn't represent the GVC aesthetic well
- (Optional) Outputs the project owner doesn't want to anchor the
  LoRA's "default look" on

Target: **200-500 high-quality (image, caption) pairs** for a strong
LoRA. More isn't always better — Flux LoRAs often peak around 300-500
samples and overfit beyond that.

### Step 3 — Train (~30 min + $5-20 on Replicate / fal.ai)

Two viable hosts:

| Host | Pros | Cons | Recommended for |
|---|---|---|---|
| **Replicate** | `ostris/flux-dev-lora-trainer` is battle-tested, predictable | Slower (30-60 min), Replicate-specific API for hosting | Reproducible runs |
| **fal.ai** | `fal-ai/flux-lora-fast-training` is faster (~10 min), good UI | Less battle-tested for production LoRAs | Quick iteration |

Recommended hyperparameters (Flux LoRA defaults):

| Parameter | Value | Note |
|---|---|---|
| LoRA rank | 16 or 32 | Higher = more capacity but slower + larger file |
| Training steps | 1500-3000 | Tune by checkpoint quality |
| Learning rate | 1e-4 | Standard Flux LoRA LR |
| Caption dropout | 0.1 | Helps LoRA generalize across prompts |
| Trigger word | `vibetown_figurine` | Pick once, reuse forever |

Cost per training run: **$5-20** depending on platform + iterations.

Output: a `.safetensors` file (~150 MB) representing the LoRA weights.

### Step 4 — Deploy (~1 day)

Once we have a `.safetensors`:

**Option A — Host on BFL as a finetune_id** (simplest):
- BFL has a finetune-hosting endpoint
- Upload the `.safetensors`, get back a `finetune_id`
- Update `lib/vibeify-flux.ts` to call BFL's finetune endpoint instead
  of `/v1/flux-2-pro`, passing `finetune_id` + `finetune_strength`
  (typically 0.7-0.9)

**Option B — Host on Replicate / fal.ai** (more flexible):
- Trade-off: extra service dependency to maintain
- Pro: easier A/B testing (toggle endpoint URL)

Either way, also:
- Update `lib/vibeify-render.ts → buildVibetownPrompt` — most of the
  ~200-line prompt can be pruned. The LoRA does the heavy lifting.
- Update `lib/vibeify-references.ts` — face refs (`public/gvc-faces/`)
  can probably be retired entirely. Body T-pose + scene backgrounds
  may still help; A/B test to decide.

### Step 5 — A/B test (~half day + per-render compute)

Run the same source + prompt set through both pipelines:
- **Current**: 200-line prompt + 7 reference images
- **New**: LoRA + 10-line prompt + 1-2 reference images

Score on four axes:

| Axis | How to measure |
|---|---|
| **Visual fidelity** | Does the LoRA produce on-spec GVC characters? Spot-check by eye. |
| **Identity preservation** | When source is a user photo, does the describer-extracted identity carry through? Side-by-side compare. |
| **Stochastic artifact rate** | Run 50 identical prompts × multiple seeds; count phantom-mouth / nose / skin-drift instances. Target: drop from ~10% → < 2%. |
| **Latency + cost** | Time end-to-end render; sum input-image-uploaded MB. Target: noticeable improvement on both. |

If the LoRA wins on all four, ship it. If it regresses on identity
preservation (which is the most likely failure mode — LoRA might be
too aggressive), tune `finetune_strength` down and re-test.

---

## ⏱️ Estimated total effort

| Step | Effort | Cost |
|---|---|---|
| Bulk-export script | 1 hour | Free |
| Manual curation | 2-4 hours | Free |
| Training run | 30 min wait + click-through | $5-20 |
| Deploy + prune prompts | 1 day | Free |
| A/B test | Half day | Per-render compute × test set |
| **Total per iteration** | **~2-3 days** | **~$10-30** |

Multiple iterations likely (tune dataset, retrain). Budget 2-3
iterations to land a production-quality LoRA: $20-100 + a working
week of focused engineering time.

---

## 🔒 Privacy + ethics

- Every uploaded entry is `sourceKind === "gvc-token"` — public NFT
  art only. Photo-source renders never leave the user's browser.
- The Vercel Blob store is configured **PRIVATE** — only the project
  owner's authenticated SDK calls can read the dataset.
- Contributing wallets are recorded in the per-wallet manifest. If
  the resulting LoRA (or the dataset itself) is ever published, the
  GVC team should decide on attribution policy.
- The LoRA fine-tunes a base model (Flux 2 [pro]) that is itself
  trained on broader image data — the LoRA is a small, additive
  delta, not a from-scratch model.

---

## ❓ Open questions for the GVC team

- Should the trained LoRA weights be made public (HuggingFace, etc.)
  or kept internal to vibe-o-matic?
- Should contributing wallets be acknowledged in the LoRA's model
  card?
- Does GVC already have an in-house LoRA from another initiative? If
  yes, A/B against it to decide which to ship — having both options is
  fine, they're not mutually exclusive.
- Once a LoRA is live, should free community renders continue (as a
  way to keep collecting refinement data) or close out (since the
  dataset goal is met)?

---

## 📚 Related docs

- [`FEEDBACK-V1.md`](./FEEDBACK-V1.md) — the upstream community-side
  program that produces the dataset
- [`WIRING.md`](./WIRING.md) — Vercel Blob operational ownership for
  the dataset storage
- [`FUTURE.md`](./FUTURE.md) — broader post-hackathon roadmap; the
  LoRA pitch lives there too

---

*This doc is the execution plan. The dataset collection is already
running. When you (or whoever) decides the dataset is ripe, work
through Steps 1-5 in order. Each step has a clear input + output;
nothing here requires guessing what to do next.*
