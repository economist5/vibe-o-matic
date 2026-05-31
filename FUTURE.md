# vibe-o-matic — future additions

Items intentionally **out of scope** for the hackathon build, captured here as the roadmap for what vibe-o-matic could become with GVC team resources behind it.

Stewardship of the project transfers to the GVC team post-hackathon (see [`WIRING.md`](./WIRING.md) for the per-dependency handoff guide). The items below describe directions the project could take — actual implementation, hosting decisions, and prioritization are GVC's call. The original author is happy to consult on any of these items but is not the implementer once the keys change hands.

---

## 🎯 Headline opportunity: GVC LoRA integration

**The biggest single-step quality upgrade available to this project is replacing reference-image-driven style guidance with a Low-Rank Adaptation (LoRA) model trained directly on GVC characters.**

> **Update (post-shipping):** the dataset collection pipeline that
> feeds a LoRA training run is now LIVE. See [`FEEDBACK-V1.md`](./FEEDBACK-V1.md)
> (community-side: holders render free + rate + voluntarily upload) and
> [`LORA-PIPELINE.md`](./LORA-PIPELINE.md) (training-side: how the
> collected data turns into a deployable LoRA). Two paths to a
> production LoRA now exist — (a) GVC team provides a LoRA they
> already have; (b) self-train one from the community-contributed
> dataset. Both are documented; pick whichever lands first.

### Why this matters

The hackathon build coerces a general-purpose image model (Flux.2 [PRO]) into producing GVC-style figurines through a heavily engineered, ~200-line text prompt and seven reference images per call. It works — but the model is always *fighting its priors* to render the canonical Vibetown look:

- No nose, no eyebrows
- One simple curved mouth (or zero, replaced by beard mass)
- Matte vinyl 3D figurine proportions
- Specific palette and material language

Every guardrail in the current prompt exists because the base model's defaults pull elsewhere. The prompt does extensive rule-stating ("FACE STRUCTURE OVERRIDES SCENE AESTHETIC", "OLIVE = WARM HUMAN TONE, NEVER GREEN", "the facial hair REPLACES the mouth entirely", etc.) precisely because those rules have to win against the model's learned defaults on every single render.

A LoRA trained on the GVC character set **bakes those defaults into the model weights**, eliminating the fight.

### What it unlocks

| Today (reference-image pipeline) | With a GVC LoRA |
|---|---|
| Style is *suggested* by ref images on every call → stochastic | Style is *baked into weights* → consistent across seeds |
| ~80% of the prompt is rules fighting model priors | The model *learns* GVC defaults — most rules become superfluous |
| Saturated face refs occasionally leak skin color | No face refs needed → leak vector removed |
| Bearded-character mouth artifacts recur with seed variance | LoRA learns the canonical bearded structure once |
| Up to 9 reference images per call | Drop to 1–2 (scene only) → faster + cheaper |
| Prompt is ~200 lines | Could shrink to ~10–15 lines |

The identity pipeline (gpt-4o-mini describing the uploaded photo) still runs — **the LoRA provides style, the describer provides identity**. They're complementary.

### Integration approach (GVC-led)

If GVC chooses to pursue a LoRA upgrade, the technical path is short. Integration, hosting, and rollout decisions belong to the GVC team — the shape of the work, for reference:

1. **Source the LoRA.** Either a BFL-hosted finetune (`finetune_id`, simplest path — no extra hosting to own) or a `.safetensors` file self-hosted on Replicate / FAL / RunPod (more flexibility, more infrastructure ownership).
2. **Swap the renderer call.** `lib/vibeify-flux.ts` currently calls `/v1/flux-2-pro`. Point it at the relevant finetune endpoint instead, passing `finetune_id` and `finetune_strength` (typically 0.7–0.9).
3. **Prune the prompt.** Most of `buildVibetownPrompt` in `lib/vibeify-render.ts` becomes redundant once the model knows GVC at the weights level. Keep scene + action + mood + subject description; drop the no-nose / facial-hair / skin-tone guardrails.
4. **Retire face references.** `public/gvc-faces/` is no longer needed as renderer input.
5. **A/B test** with-LoRA vs current pipeline on the same prompts to validate the lift before fully cutting over.

### Due diligence checklist (pre-integration)

Items the GVC team should confirm or decide before kicking off the integration work:

- [ ] **Base model alignment.** Which base is the LoRA trained on (Flux.1 [dev], Flux.1 [pro], Flux.2)? LoRAs do not cross base models — if the LoRA targets a different base than our current Flux 2 [pro] pipeline, either retrain to align or commit to that base's rendering pipeline for the rest of the stack.
- [ ] **Artifact format.** BFL-hosted `finetune_id` vs raw `.safetensors`? Each has different hosting + cost implications. Pick before sourcing.
- [ ] **Trigger word.** Most LoRAs expect a specific phrase (e.g. `gvccharacter`, `vibetown_figurine`) in the prompt to activate the style. Confirm what the trained word is so the prompt template can include it.
- [ ] **Recommended strength range.** Under-strength means the pipeline still fights priors; over-strength can over-saturate. Confirm the trainer's recommended `finetune_strength` band.
- [ ] **Cost delta.** Compare cost-per-call with the LoRA endpoint vs the current Flux 2 [pro] flat rate. Finetune endpoints sometimes price differently — confirm budget impact.
- [ ] **A/B benchmark set.** Is there a curated set of GVC-style outputs against which to evaluate the LoRA's lift? If not, assemble ~50 reference renders before cutover.
- [ ] **Face reference fallback.** Decide whether `public/gvc-faces/` stays in the repo as a fallback (in case the LoRA endpoint is briefly unavailable) or is retired entirely.
- [ ] **Billing ownership.** Which GVC account holds the BFL or self-host bill once the LoRA is live? Coordinate with the WIRING.md key-rotation step.
- [ ] **Rollout plan.** Big-bang cutover, fractional A/B rollout, or canary at a single rail (e.g. agent endpoint first)?

---

## ⏳ VIBESTR rail activation

The second human-side payment rail is built end-to-end and gated entirely on a single on-chain action: **a whitelisted VIBESTR recipient address being put in place** for the contract's `_transfer` allowlist. While the allowlist add is pending, the web UI shows VIBESTR as a `SOON` pill next to the active USDC option, and humans pay via USDC.

### What's already production-ready

- `payVibestrSplit` builds the multi-transfer payment client-side
- `verifyPayment` validates the on-chain receipts server-side
- The wallet pill in the header displays a live VIBESTR balance regardless of which chain the user's wallet is currently on
- Server-side replay protection on tx hashes (in-memory today; move to KV before high volume — see [`LAUNCH.md`](./LAUNCH.md))

### What's needed to flip it live

1. A whitelisted VIBESTR recipient address is added to the contract's `_transfer` allowlist by a VIBESTR contract owner
2. A two-line edit in `app/page.tsx` removes the `SOON` pill and re-wires the click handler

That's it — no further code changes required. Verification script + exact re-enable steps live in [`LAUNCH.md`](./LAUNCH.md#-pending-vibestr-allowlist-add).

### Why this lives in the future doc

The hackathon build ships humans a working rail (USDC) and demonstrates the VIBESTR pipeline end-to-end via the test-mode bypass. The native-coin rail goes live the moment a whitelisted recipient is in place — entirely outside the hackathon scope, but a one-action distance from production.

---

## 🔗 ERC-8257 tool registry listing — ✅ shipped (toolId 39)

[**ERC-8257**](https://www.8257.ai/) ([ProjectOpenSea](https://github.com/ProjectOpenSea)) is OpenSea's onchain registry for AI agent tools — a discovery layer specifically designed to complement x402. Their own positioning calls it *"`403` to x402's `402`."*

vibe-o-matic is now **listed in the registry as toolId 39** on Base mainnet. The original author registered during the hackathon, with the treasury wallet recorded as the on-chain `creator` so post-handoff GVC controls all metadata updates, predicate swaps, and (if ever needed) deregistration via the same wallet that already receives x402 settlements.

### Listing facts (verify any time on Basescan)

| Field | Value |
|---|---|
| Registry contract | `0x265BB2DBFC0A8165C9A1941Eb1372F349baD2cf1` (Base mainnet) |
| `toolId` | `39` |
| `creator` | `0xc93c375b022f0e707d211090d904f3266ccfce22` (treasury) |
| `metadataURI` | `https://vibe-o-matic.vercel.app/.well-known/ai-tool/vibeify.json` |
| `manifestHash` | `0x61fe50ead3f814c1422aff796dac13c6c08c35545f65c2b331650848f1124826` |
| `accessPredicate` | `0xd8C7646AEEA84a6908D5fc310AEE72DE69FA003A` (permissive — defers gating to HTTP/x402 layer) |
| Registration tx | `0xf31230cb851c0071a323341890050450d69badc77d48c5b2697e90d299ee5147` |

Tool manifest source of truth: [`lib/erc8257-manifest.ts`](./lib/erc8257-manifest.ts). Hash compute + simulation script: [`scripts/erc8257-hash.mjs`](./scripts/erc8257-hash.mjs). Predicate contract source: [`contracts/VibeifyAccessPredicate.sol`](./contracts/VibeifyAccessPredicate.sol).

### Listing maintenance (GVC team, post-handoff)

Anything the `creator` (treasury wallet) can do on the registry contract:

**Update the manifest** (e.g. price change, new tags, new tool name):

1. Edit `lib/erc8257-manifest.ts` in the repo
2. Re-run `node scripts/erc8257-hash.mjs` — prints the new `keccak256(JCS(manifest))`
3. Push to deploy the new served bytes at the well-known URL
4. From the treasury wallet, call `updateToolMetadata(39, newURI, newHash)` on `0x265BB2DBFC0A8165C9A1941Eb1372F349baD2cf1`. URI is the same well-known URL; `newHash` is the value printed by the script.

**Swap the access predicate** (e.g. add NFT-holder gating later):

1. Deploy a new `IAccessPredicate` implementation on Base
2. From the treasury wallet, call `setAccessPredicate(39, newPredicateAddress)` on the registry

**Deregister entirely** (irreversible — tool ID can never be re-registered with the same creator):

- From the treasury wallet, call `deregisterTool(39)`

### Why this listing matters narratively

The narrative connection is unusually clean:

- vibe-o-matic ships an **OpenSea brand cameo** in the Neon Street scene
- vibe-o-matic runs **on Base** with x402 USDC settlement
- vibe-o-matic is **callable by autonomous AI agents**
- vibe-o-matic is **listed in OpenSea's own onchain agent tool registry**

Same parent ecosystem, same chain, same audience. The project is a real working example of "x402-payable + ERC-8257-discoverable" — the canonical pattern these two protocols were designed to enable together.

### Possible follow-ups (not blocking)

- [ ] Add a `--submit` mode to `scripts/erc8257-hash.mjs` that takes a key (via existing credential conventions from `test-x402-agent.mjs`) and signs the registry update directly — for now, updates are submitted via Basescan's Write Contract UI.
- [ ] Harden the predicate: replace the permissive `hasAccess() → true` with one that verifies an x402 payment receipt on-chain, eliminating the HTTP-layer re-check. Adds latency (~100-200ms RPC) so likely not worth it until per-call volume warrants it.
- [ ] Deduplicate the manifest definition (currently inlined in both `lib/erc8257-manifest.ts` and `scripts/erc8257-hash.mjs`) — the hash parity check catches drift but a single source of truth would be cleaner.

---

## 📋 Other future additions

### Prompt-machine integration
Pull a broader catalog of scene/action/mood combinations from the GVC prompt-machine into the preset library. The current catalog is 6 scenes / 7 actions / 8 moods = 336 server-side picker combinations (× 3 aspect ratios = 1,008). A prompt-machine sync could 10× that without changing the agent contract.

### Agent SDK / language clients
The current agent integration surface is two things: a documented HTTP shape (`X402.md`) and one example Node CLI (`scripts/test-x402-agent.mjs`). Both are great for technical agents, but a per-language SDK (Python, Go, TypeScript) with `agentMode` as a single function call would lower the barrier further. The Node script already shows the canonical flow (discovery → balance preflight → EIP-3009 sign → 402-then-retry → image save) — porting it to two or three languages is straightforward.

### Multi-character composition
Today the pipeline handles one uploaded photo with potentially multiple subjects. A future version could let users upload multiple separate photos and compose them into a single Vibetown scene (e.g. two friends from two different photos, vibe-ified together).

### Animated outputs
Once a still render is locked, a follow-up call could animate it (subtle idle motion, scene weather, neon flicker) using a video-capable model.

### On-chain provenance
Mint each successful render on-chain as a token (ERC-20 or ERC-1155) tied to the source description + prompt as metadata — turning each pull into a recorded artifact. Choice of standard, contract, and minting venue would be GVC's call.

### Asset pack expansion
Partner-branded scene packs (like the OpenSea neon sign added during the hackathon) for other GVC partners — each scene becoming a recognizable cross-brand moment.

---

*This roadmap is what vibe-o-matic becomes with the resources of GVC fully behind it. The hackathon build is the proof of concept; the LoRA pipeline is the production-grade version.*
