# vibe-o-matic

> *Vibe-ify any image into a tiny, cinematic Vibetown vinyl figurine — payable in VIBESTR or USDC, callable by humans or autonomous AI agents.*

**Hackathon submission for the Good Vibes Club community.**

---

## The 30-second pitch

vibe-o-matic turns any photo into a Good Vibes Club / Vibetown vinyl figurine render in ~40 seconds. We built two surfaces for two distinct audiences:

- **GVC humans** open the web UI, connect a wallet, and pick a rail: **$0.69 USDC on Base** (live today, default, one gasless signature) or **99 VIBESTR on Ethereum** (shown as `SOON` — flips once a whitelisted VIBESTR recipient is in place).
- **Autonomous AI agents** hit `POST /api/vibeify/x402` with an image + free-text intent. Our server-side agent picks the scene/action/mood/size, runs the render, and settles a $0.69 USDC payment on Base — all in one HTTP round-trip. No API key, no signup, no human in the loop.
  - **Built on Base for agent throughput.** ~2-second blocks and sub-cent gas — an agent can transact thousands of times a day without fees eating the margin.
  - **Native micropayment economics.** EIP-3009 USDC + a hosted x402 facilitator makes the protocol work at single-digit-cent unit costs, where traditional payment rails (card, ACH, even L1 ERC-20 transfers) would be uneconomic.
  - **The web UI uses the same x402 primitive.** One off-chain signature replaces *approve → transfer → poll-receipt*, so humans get the same gasless flow agents do. One rail, two audiences.

It's a working answer to two questions GVC cares about:

1. **How do we make Vibetown art accessible to every holder, every fan, every brand partner — at scale?** Render-on-demand from any input image, with native GVC style preservation.
2. **How do AI agents pay for and consume web services in 2026?** vibe-o-matic is one of the early production-grade x402 endpoints with native agentic interface support. Discoverable resources, machine-payable, no API keys.

---

## Why we're proud of this

1. **It's actually shipping**, not just a demo video. The x402 USDC rail is live on **Base mainnet** for both the web UI (humans) and the agent endpoint, settling real $0.69 USDC payments on-chain per render. The VIBESTR rail is wired and waiting on a whitelisted VIBESTR recipient being put in place.
2. **The agentic x402 flow is the kind of integration we expect more services to offer in the coming year.** We're not "an API behind Stripe" — we're a service that an autonomous AI agent can discover, agree to a price with, pay for, and consume in one HTTP round-trip. It's the pattern web services will adopt to charge per-call without an API-key economy.
3. **The OpenSea integration runs both visual and onchain.** Brand-correct neon signage with exact hex codes baked into the Neon Street scene, AND vibe-o-matic is now an active listing in **OpenSea's own ERC-8257 agent tool registry** (toolId 39 on Base mainnet). Visual cameo + onchain registry presence + x402 payment rail — three layers of OpenSea-ecosystem alignment.

4. **The community-feedback program is live, not promised.** GVC holders (≥1 NFT OR ≥69,000 VIBESTR) render for free, rate outputs 👍/👎, and one-click upload their rated set to a private Vercel Blob dataset. Every contributed render becomes a positive training example for a future self-trained vibe-o-matic LoRA. The pipeline ships end-to-end TODAY: eligibility, counter, X-reload viral loop, feedback widget, browser-local persistence, voluntary upload, server-side validation. Full spec in [`FEEDBACK-V1.md`](./FEEDBACK-V1.md); downstream training plan in [`LORA-PIPELINE.md`](./LORA-PIPELINE.md).
5. **The future is honestly costed and scoped.** We're not handwaving — [`FUTURE.md`](./FUTURE.md) is a proof-of-concept roadmap with concrete integration steps, due-diligence checklist, and what changes per file.
6. **Built with Claude Code**. Every line of code in this repo was paired between a human and Claude. The development log itself is a demonstration of human + AI agent collaboration — the same pattern we're enabling for *consumers* of vibe-o-matic.

---

## What's technically interesting

### 🤖 First-class agentic interface (the headline feature)
The `/api/vibeify/x402` endpoint accepts two modes:
- **Explicit**: caller provides scene/action/mood/size
- **Agent mode**: caller sends just `agentMode=1` + optional intent; server-side gpt-4o-mini picks the params from the curated catalog

The agent ALWAYS picks from a curated allowlist (never free-form scene text), keeping the renderer's MP budget and prompt structure predictable. If the picker returns an unknown id, we gracefully fall back to sensible defaults — caller paid USDC, deserves *some* render. The current catalog: 6 scenes, 7 actions, 8 moods, 3 aspect ratios — **1,008 combinations** the picker can resolve a free-text intent to.

This is the difference between "an API that happens to charge money" and "a service designed for autonomous AI agents from day one."

### 🧠 Two identity paths — vision-first for photos, reference-first for GVC tokens
**Photo path (default).** Source photo pixels **never reach the image generator**. We use gpt-4o-mini vision to convert the photo into a structured text description (hair, facial hair, clothing, fine details — but never face geometry), then pass *only* that text to Flux 2 [pro] along with our GVC face-structure reference set. Identity preserved (clothing, accessories, hair, beard); face anatomy comes from canonical GVC templates, not the source photo.

**GVC-token path.** When the source is itself a GVC NFT (the user loaded one by token ID), we **skip the describer entirely** and inject the NFT as a Flux reference image instead. Translating a yellow-bodied Robot GVC through a "warm beige human skin" describer would lose the canonical identity; using the NFT's own pixels as the reference preserves body color, character type (Robot / Default / Alien / etc.), hair, and accessories at the pixel level. Same render contract, two pipelines — the server picks the right one based on a `sourceKind` form field. Right tool for the right input.

### 🎨 Multi-reference Flux 2 pipeline
Each render sends 7 reference images to Flux: 1 body T-pose template, 4 curated face references (showing different expressions + bearded vs clean-shaven structure), and up to 2 scene-specific backgrounds. The model has visual exemplars of what a GVC character looks like — not just text rules.

### 💸 Two surfaces, two rails — pragmatic today, native-coin ready

| Audience | Surface | Rail today | Rail roadmap |
|---|---|---|---|
| **GVC humans** | The web UI (vibe-o-matic.vercel.app) | $0.69 USDC on Base — live, default, one gasless EIP-3009 signature | 99 VIBESTR on Ethereum — `SOON` pill flips once a whitelisted VIBESTR recipient is implemented |
| **Autonomous AI agents** | `POST /api/vibeify/x402` | $0.69 USDC on Base — live via Coinbase CDP facilitator | Stays USDC-only — see *why* below |

The architecture is deliberate, not accidental:

- **The web UI ships with USDC because we can ship it today.** Real users render real images right now, paying real on-chain stablecoin into the project's recipient address, with the full economy flowing — no IOUs, no demo-mode disclaimers, no "coming soon" gating the entire experience.
- **VIBESTR is one allowlist call away.** Every line of the VIBESTR rail is production-ready: `payVibestrSplit`, `verifyPayment`, the wallet pill's live VIBESTR balance, and a two-line UI re-enable. Details and re-enable steps live in [`FUTURE.md`](./FUTURE.md#-vibestr-rail-activation) and [`LAUNCH.md`](./LAUNCH.md#-pending-vibestr-allowlist-add).
- **The agent endpoint stays USDC-only on purpose.** x402's facilitator network speaks EIP-3009 + USDC because that's the stablecoin every facilitator can verify and settle across chains. VIBESTR isn't in that compatibility set — and even if it were, autonomous agents don't (and shouldn't have to) hold every niche community token to pay for services. Agents pay protocol currency, that's the universal interface. The full agent contract is documented in [`X402.md`](./X402.md).

**End state:** humans default to VIBESTR (creating buying pressure on the GVC-native token with every render), humans who want frictionless onboarding still have USDC, and agents pay USDC because that's what protocol currency looks like. Nothing is mutually exclusive.

### 🎯 OpenSea brand integration (visual cameo + on-chain listing)
The Neon Street scene includes a custom-built neon OpenSea logo as one of the storefront signs, using OpenSea's exact brand hex codes from their style guide (Sea Blue #2081E2, Marina Blue #15B2E5, Aqua #2BCDE4, Fog #E5E8EB). Every render at that scene puts the OpenSea mark in the background — a small visual nod to a community-defining marketplace.

The connection runs deeper than visual cameo, too. **vibe-o-matic is now listed in OpenSea's own onchain agent tool registry — [ERC-8257](https://www.8257.ai/) toolId 39 on Base mainnet.** OpenSea's positioning for the registry is literally "`403` to x402's `402`" — an onchain discovery layer purpose-built to pair with x402-payable services like ours. Tool manifest verified at [`https://vibe-o-matic.vercel.app/.well-known/ai-tool/vibeify.json`](https://vibe-o-matic.vercel.app/.well-known/ai-tool/vibeify.json), `keccak256(JCS(manifest))` committed on-chain, payout recipient = the same treasury that receives x402 USDC settlements today. Listing-maintenance details and the full integration sketch live in [`FUTURE.md`](./FUTURE.md#-erc-8257-tool-registry-listing).

---

## How each surface works

### Surface 1 — The web UI (the human path)
A judge or GVC holder can:
1. Open the app
2. Upload a photo *or* load any GVC token by ID (try `5618`) — the server picks the right pipeline for each source type (see *Two identity paths* above)
3. Pick a scene from the curated catalog (Tropical Beach, Château de GODL, Neon Street with OpenSea signage, Rooftop Sunset, Lagoon Pier, Coastal Drive)
4. Pick an action emoji (🤝 Friendship, 🎉 Celebrate, 🤳 Selfie, 🧘 Zen, 💃 Dance, 🏍️ Motorcycle, 🚁 Helicopter) and a mood (😊 Joyful, 😎 Chill, 🔥 Hyped, 🌙 Dreamy, 💪 Heroic, 🕶️ Noir, 🎈 Playful, 📼 Retro)
5. Choose orientation (square / portrait / landscape)
6. Choose a payment rail — **$0.69 USDC** on Base (live default; one gasless EIP-3009 signature) or **99 VIBESTR** on Ethereum (shown as a `SOON` pill — see [`FUTURE.md`](./FUTURE.md#-vibestr-rail-activation) for activation details)
7. Click **Vibeify** → sign once in your wallet → ~40s later, a Vibetown render of themselves

The wallet pill in the header shows BOTH balances live (VIBESTR on Ethereum + USDC on Base) regardless of which chain the wallet is currently on — each balance is read via a public RPC for that chain, so the user always sees what they can spend on either rail.

### Surface 2 — The x402 agent endpoint (the autonomous AI path)
External AI agents hit `POST /api/vibeify/x402` with two body params: an image and a free-text intent. Our server-side picker reads the photo + intent and chooses scene/action/mood/size from the curated catalog. The render proceeds, the agent's picks come back in the response (with reasoning), and a $0.69 USDC payment settles on Base — all in one HTTP round-trip with the EIP-3009 signature in the `X-PAYMENT` header.

#### Why it's actually agent-friendly (not just "an API")

1. **Self-describing endpoint.** `GET /api/vibeify/x402` is a discovery call: any agent that already speaks x402 receives the price, recipient address, network, and facilitator URL in one curl. No SDK, no docs lookup, no vibe-o-matic-specific code.
2. **Caller doesn't need to learn our catalog.** Send `agentMode=1` + an optional one-line intent. Our server-side gpt-4o-mini picker resolves the intent into one of **1,008 valid combinations** (6 scenes × 7 actions × 8 moods × 3 ratios). Free text in, render out.
3. **Pay in the protocol's currency, not ours.** USDC via EIP-3009 — no API key, no signup, no rate-limit dashboard, no Stripe account. The agent's wallet IS the credential.
4. **Transparent agent picks.** Response includes `agentPicks` with the chosen ids AND the picker's reasoning, so callers can build feedback loops on what works.
5. **Atomic billing.** The server runs `verify → render → settle` in that order — if rendering fails, settlement never fires, so a caller is never half-charged. Documented at the protocol level in [`X402.md`](./X402.md), enforced at the route level.

#### Integration surface in one screenshot of code

```ts
import { wrapFetchWithPayment } from "x402-fetch";
const fetchWithPay = wrapFetchWithPayment(fetch, walletClient);

const form = new FormData();
form.set("image", imageBlob);
form.set("agentMode", "1");
form.set("intent", "noir detective vibe at midnight");

const res = await fetchWithPay("/api/vibeify/x402", { method: "POST", body: form });
const { image, agentPicks } = await res.json();
// image is data:image/png;base64,...
// agentPicks = { sceneId, actionId, moodId, size, reasoning }
```

That's the whole integration. Any language that can sign EIP-712 typed data and POST a multipart form can call this — the repo also ships a self-contained Node CLI (`scripts/test-x402-agent.mjs --help`) as a reference implementation, but it's an example, not the contract. The contract is the HTTP shape in [`X402.md`](./X402.md).

**This is the future of how AI agents pay for services on the web** — no API key, no signup, no human in the loop.

### Output quality (both surfaces)
Across N renders of the same input, we see ~90% "on-spec, judge-ready" outputs. The remaining ~10% have stochastic artifacts (occasional phantom mouth inside a beard, occasional nose regression, occasional skin-tone drift) that no amount of prompt engineering will fully eliminate against Flux's strong priors. **This is exactly the gap a GVC-trained LoRA would close** — see the next section.

---

## The future: GVC LoRA partnership (the production upgrade)

The hackathon build is a proof of concept. The production-grade version is a single architectural change: **swap our hand-tuned 200-line prompt for a LoRA trained on the GVC character set**.

### Why it matters

Today, our pipeline coerces a general-purpose image model (Flux 2 [pro]) into producing GVC-style output through extensive prompt engineering. Every "no nose" / "bearded characters have no mouth" / "olive skin is warm beige" rule exists because the base model's defaults pull elsewhere. The model is always *fighting its priors* to render canonical Vibetown.

A LoRA trained on GVC characters **bakes those defaults into the model weights**, eliminating the fight. What this unlocks:

| Today (reference-image pipeline) | With a GVC LoRA |
|---|---|
| ~200-line prompt fighting model priors | ~10-line prompt; model already knows GVC |
| Stochastic phantom-mouth / nose / skin-tone artifacts | Disappear at the weights level |
| 7 reference images per call | Could drop to 1–2 (scene only) |
| Identity preserved via describer (kept) | Same |
| ~$0.045 per render | Lower (fewer ref images uploaded) |

Full roadmap, integration plan, and compatibility questions live in [`FUTURE.md`](./FUTURE.md).

---

## Try it (live demo)

| | |
|---|---|
| **Live URL** | https://vibe-o-matic.vercel.app |
| **Sample GVC token to render** | `5618` |
| **x402 endpoint (machine-callable)** | `POST /api/vibeify/x402` |
| **x402 discovery (GET)** | `GET /api/vibeify/x402` → returns price + facilitator URL |
| **Full agent contract docs** | [`X402.md`](./X402.md) |
| **Source code** | https://github.com/economist5/vibe-o-matic |
| **Ownership handoff guide** | [`WIRING.md`](./WIRING.md) — per-dependency take-over checklist for the GVC team |
| **Test wallet (for judges to fund)** | (none required — judges can use their own; password-gated test-mode toggle available in UI) |

---

## The numbers

### Cost per render

| Component | Cost |
|---|---|
| gpt-4o-mini vision describer | ~$0.0001 |
| gpt-4o-mini agent picker (if agent mode) | ~$0.0002 |
| Flux 2 [pro] generation | ~$0.045 |
| **Total compute** | **~$0.046** |
| Charged to caller (USDC) | $0.69 |
| **Margin per call** | **~$0.64** |

### Latency

| Stage | Time |
|---|---|
| Discovery 402 | ~50ms |
| EIP-3009 sign (client-side) | ~1s (in wallet) |
| Facilitator verify | ~2s |
| Describer | ~3s |
| Flux render (submit + poll) | ~30–40s |
| Facilitator settle | ~2s |
| **Total end-to-end** | **~35–55s** |

---

## Tech stack

- **Frontend**: Next.js 14 App Router, React, TypeScript, Tailwind, Framer Motion
- **Image generation**: Black Forest Labs FLUX.2 [pro] (multi-reference editing)
- **Vision**: OpenAI gpt-4o-mini (describer + agent picker)
- **Blockchain**: viem (wallet + chain interactions)
- **Payments**: x402 (USDC on Base) + custom VIBESTR ERC-20 verification on Ethereum mainnet
- **Hosting**: Vercel

---

## Repo guide for judges who want to dive in

| File | What's inside |
|---|---|
| `app/page.tsx` | Web UI — three input panels, two payment rails, debug panel |
| `app/api/vibeify/route.ts` | VIBESTR rail entry point (verifies on-chain payment, delegates render) |
| `app/api/vibeify/x402/route.ts` | x402/USDC rail entry point (supports agent mode) |
| `lib/vibeify-render.ts` | Shared describe → prompt → Flux render pipeline |
| `lib/vibeify-agent.ts` | Server-side preset picker (gpt-4o-mini vision + JSON mode) |
| `lib/vibeify-describe.ts` | gpt-4o-mini vision describer (no source pixels reach Flux) |
| `lib/vibeify-flux.ts` | Flux 2 [pro] async submit + poll client |
| `lib/vibeify-references.ts` | Loads body + face + scene reference images |
| `lib/presets.ts` | SCENE / ACTION / MOOD catalogs (shared between UI and agent) |
| `lib/payment-config.ts` | VIBESTR + USDC pricing, splits, network config |
| `lib/wallet.ts` | Wallet + x402-fetch wrapper |
| `X402.md` | Full external-facing x402 API contract |
| `FUTURE.md` | LoRA roadmap + VIBESTR rail activation + post-hackathon plans |
| `LAUNCH.md` | Live-ops reference (env vars, smoke tests, rollback procedures) |
| `WIRING.md` | Ownership handoff to GVC — every external dependency, who needs to own it, take-over steps |

---

*Made for the Good Vibes Club community by economist · [@economist](https://x.com/economist) · e@conomist.net*
