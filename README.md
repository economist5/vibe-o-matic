# vibe-o-matic

> *Vibe-ify any image into a tiny, cinematic Vibetown vinyl figurine — payable in VIBESTR or USDC, callable by humans or autonomous AI agents.*

Live deploy: **https://vibe-o-matic.vercel.app**

---

## Start here

This repo ships with seven docs, each scoped to one audience. Pick the one that matches what you're trying to do:

| You want to… | Read |
|---|---|
| Understand the project (judges, GVC community, prospective partners) | [**SUBMISSION.md**](./SUBMISSION.md) — the hackathon submission narrative |
| Integrate as an autonomous AI agent (call the x402 endpoint) | [**X402.md**](./X402.md) — full API contract + Quickstart CLI |
| Run / operate the production deploy (env vars, smoke tests, rollback) | [**LAUNCH.md**](./LAUNCH.md) — live-ops reference |
| Take over ownership of the project (GVC team handoff) | [**WIRING.md**](./WIRING.md) — per-dependency take-over checklist |
| Understand the post-hackathon roadmap (LoRA, VIBESTR rail activation) | [**FUTURE.md**](./FUTURE.md) — roadmap + due-diligence checklist |
| Understand the live community-feedback program (free renders + LoRA dataset) | [**FEEDBACK-V1.md**](./FEEDBACK-V1.md) — spec + operational state |
| Understand the planned LoRA training pipeline | [**LORA-PIPELINE.md**](./LORA-PIPELINE.md) — dataset → training → deployment |

---

## Quick demo

```bash
# x402 discovery — see the price, network, and facilitator
curl -s https://vibe-o-matic.vercel.app/api/vibeify/x402
```

```bash
# Render a Vibetown figurine via the agent CLI ($0.69 USDC, Base mainnet)
git clone https://github.com/economist5/vibe-o-matic
cd vibe-o-matic && npm install
node scripts/test-x402-agent.mjs --help
```

---

## Tech stack at a glance

- **Frontend:** Next.js 14 App Router · TypeScript · Tailwind · Framer Motion
- **Image generation:** Black Forest Labs FLUX.2 [pro]
- **Vision:** OpenAI gpt-4o-mini (describer + agent picker)
- **Payments:** x402 / USDC on Base (live) · VIBESTR on Ethereum (gated on contract allowlist)
- **Hosting:** Vercel

---

*Made for the Good Vibes Club community.*
