# vibe-o-matic — wiring & ownership handoff

This doc is the **single source of truth for everything the GVC team needs to
own, rotate, or verify** to take vibe-o-matic into production custody.

> **Audience:** A GVC technical lead inheriting ops. Assumed comfortable with
> Vercel, GitHub, a browser wallet, and a terminal. Not assumed to know x402,
> Coinbase CDP, or the project's internal layout.

If you read nothing else, read the [**5-minute take-over summary**](#-5-minute-take-over-summary) and the [**handoff checklist**](#-handoff-checklist).

---

## 🗺️ System wiring diagram

How a single render flows end-to-end and what every box represents:

```
                       ┌────────────────────────────────┐
                       │   GVC user (web)               │
                       │   or AI agent (HTTP POST)      │
                       └───────────────┬────────────────┘
                                       │
                          ──── HTTP ───┘
                                       │
                                       ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │   Vercel deploy — vibe-o-matic.vercel.app                           │
   │   ─ Next.js 14 (App Router)                                         │
   │   ─ ENV VARS (set in Vercel Project Settings → Environment):        │
   │       OPENAI_API_KEY            (OpenAI account)                    │
   │       BFL_API_KEY               (Black Forest Labs account)         │
   │       CDP_API_KEY_ID            (Coinbase CDP account)              │
   │       CDP_API_KEY_SECRET        (   "   ""  )                       │
   │       VIBEIFY_BYPASS_PASSWORD   (your choice — unset = disabled)    │
   └─┬───────────────┬─────────────────────────────┬──────────────────┬──┘
     │               │                             │                  │
     │ vision         │ image render                │ x402 verify+settle│ replay-protected
     ▼ ~$0.0003       ▼ ~$0.045                     ▼ free (1k/mo CDP) ▼ on-chain check
   ┌──────────┐    ┌──────────┐                ┌──────────────┐    ┌─────────────┐
   │  OpenAI  │    │ BFL Flux │                │ Coinbase CDP │    │ Public Eth  │
   │ gpt-4o-  │    │ 2 [pro]  │                │ x402 facilit.│    │ RPC         │
   │  mini    │    │          │                │              │    │ (publicnode)│
   └──────────┘    └──────────┘                └──────┬───────┘    └─────────────┘
                                                      │ ↓
                                              EIP-3009 transferWithAuth on Base
                                                      │
                                                      ▼
              ┌──────────────────────────────────────────────────────────┐
              │   Treasury wallet: 0xc93c375b022f0e707d211090d904f3266ccfce22 │
              │   ─ Receives USDC on Base mainnet (x402 USDC rail)       │
              │   ─ Receives VIBESTR on Ethereum mainnet (when allowlist │
              │     add lands — currently pending GVC action)            │
              │   ─ Same address on both chains (EVM is chain-agnostic)  │
              │   GVC team: VERIFY YOU HOLD THE PRIVATE KEY              │
              └──────────────────────────────────────────────────────────┘
```

---

## ⏱️ 5-minute take-over summary

Three things must change hands. Everything else either follows automatically or is already in your control.

1. **The GitHub repo** (`economist5/vibe-o-matic`) → transfer ownership to GVC's org.
2. **The Vercel project** (currently in `economist5`'s personal Vercel account) → transfer to GVC's Vercel team.
3. **The five env vars** in Vercel Production → rotate to GVC-owned API keys (OpenAI, BFL, CDP) + set your own bypass password.

The **treasury wallet** (`0xc93c375b…cfce22`) must be verified GVC-controlled before accepting volume — see step 4 of the handoff checklist. The **VIBESTR allowlist add** is something only the VIBESTR contract owner can perform — no developer action required from the project side.

After those swaps, the production deploy is fully yours: every dollar of every render lands in your treasury, every API call is billed to your accounts, every secret lives in your env.

---

## 📋 Inventory: every external dependency

### Env vars (live in Vercel Production)

| Name | Read by | Authenticates against | Replaceable? | Notes |
|---|---|---|---|---|
| `OPENAI_API_KEY` | `lib/vibeify-render.ts` describer & agent picker | OpenAI account | Yes — provision new at https://platform.openai.com/api-keys, swap in Vercel | gpt-4o-mini calls only; ~$0.0003 per render |
| `BFL_API_KEY` | `lib/vibeify-flux.ts` | Black Forest Labs account at https://api.bfl.ai | Yes — provision new in BFL dashboard, swap in Vercel | Flux 2 [pro] calls; ~$0.045 per render |
| `CDP_API_KEY_ID` | `@coinbase/x402` SDK in `app/api/vibeify/x402/route.ts` | Coinbase CDP facilitator | Yes — see provisioning steps below | JWT-signed; 1,000 free txs/month |
| `CDP_API_KEY_SECRET` | Same | Same | Yes | Paired with above |
| `VIBEIFY_BYPASS_PASSWORD` | `app/api/vibeify/route.ts:130` | None (server-side string match) | Yes — pick any value, set in Vercel | UNSET → test mode entirely disabled (every bypass → 403) |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`) | `lib/free-render-counter.ts` (atomic counter) | Upstash Redis (Vercel Storage marketplace) | Auto-injected on store connect | Backs the 200-render community-free counter. Either naming scheme works. Free tier covers our volume. UNSET → community-free path returns 503; paid + test paths unaffected. |
| `BLOB_READ_WRITE_TOKEN` | `app/api/training-set/submit/route.ts` | Vercel Blob | Auto-injected on store connect | Training-dataset storage. Store configured PRIVATE (correct privacy posture). UNSET → contribution upload returns 503; render flow keeps working. |
| `VIBEIFY_ADMIN_TOKEN` | `app/api/admin/refill/route.ts` | None (server-side string match) | Yes — pick any random ≥32-char string | Gates the counter-refill endpoint. Used by whoever holds the keys to top up the community-free pool when the X-reload ping mechanic surfaces. UNSET → admin endpoint returns 503; counter still works but can only be edited via Vercel KV dashboard. |
| `VIBEIFY_OPEN_ACCESS` | `app/api/vibeify/route.ts` | None (server-side flag) | Yes — set to `1` to open, unset / `0` to close | Time-bound public-promo escape hatch. When `"1"`, test-mode bypass works without password — anyone can render free. UI auto-adapts (banner + dropped password input). Flip via Vercel env vars + redeploy. Used for GVC Day weekend + similar events. |

### Wallets

| Address | Receives | Who controls | Where it's hardcoded |
|---|---|---|---|
| `0xc93c375b022f0e707d211090d904f3266ccfce22` | USDC on Base + VIBESTR on Ethereum | **GVC team must confirm key custody** | `lib/payment-config.ts:39` (VIBESTR split) + `:84` (USDC recipient) |
| `0x000000000000000000000000000000000000dEaD` | — (defined but unused) | Burn — N/A | `lib/payment-config.ts:24-25` (`BURN_ADDRESS`, reserved for future split) |

### Contracts & networks (read-only references — do NOT change)

| What | Address / value | Chain |
|---|---|---|
| VIBESTR ERC-20 | `0xd0cC2b0eFb168bFe1f94a948D8df70FA10257196` | Ethereum mainnet (1) |
| USDC ERC-20 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Base mainnet (8453) |
| Coinbase CDP x402 facilitator | `https://api.cdp.coinbase.com/platform/v2/x402` | — (off-chain service) |
| Public Ethereum RPC | `https://ethereum-rpc.publicnode.com` | Used by `lib/wallet.ts` for VIBESTR balance reads + payment verification |
| BFL Flux endpoint | `https://api.bfl.ai/v1/flux-2-pro` | — |
| ERC-8257 ToolRegistry | `0x265BB2DBFC0A8165C9A1941Eb1372F349baD2cf1` | Base mainnet (8453) — our `toolId` is **39**, owned by the treasury wallet |

### On-chain assets owned by the project

| What | Address / id | Owner / controller |
|---|---|---|
| ERC-8257 tool listing | `toolId 39` on registry `0x265BB2…2cf1` | Treasury wallet `0xc93c375b…cfce22` (as on-chain `creator`) — can `updateToolMetadata`, `setAccessPredicate`, `deregisterTool` |
| Vibeify access predicate | `0xd8C7646AEEA84a6908D5fc310AEE72DE69FA003A` (Base) | Stateless permissive contract — no admin functions; can be swapped via the registry's `setAccessPredicate(39, newAddr)` from the treasury |

Listing-maintenance procedures (how to update the manifest, swap predicates, deregister) live in [`FUTURE.md`](./FUTURE.md#-erc-8257-tool-registry-listing--shipped-toolid-39).

### Storage services (Vercel-managed)

| What | Vercel Storage product | What's stored | Access |
|---|---|---|---|
| Community-free counter | Upstash Redis (via Vercel marketplace) | One integer key (`vibeify:free-renders:remaining`) + one counter for refills | Read-write via `KV_REST_API_TOKEN`. Free tier covers our volume. Recreate by clicking through Vercel → Storage → Upstash → Redis → connect to project. |
| Training-set contributions | Vercel Blob (private) | Per-wallet folders under `training-set/images/{wallet}/` (PNGs) + `training-set/manifests/{wallet}.json` (metadata). See [`FEEDBACK-V1.md`](./FEEDBACK-V1.md) for shape. | Private store; reads need `BLOB_READ_WRITE_TOKEN` via the SDK OR Vercel dashboard authenticated access. Public URLs do not work. |

### Counter refill (admin procedure)

When the public ping mechanic surfaces ("Hey @economist refill?"), top up the counter with one of two modes:

```bash
# Mode A — add N to the current counter (atomic INCRBY) + bump refillCount.
# The normal "top-up" action. Cap per call: 10,000.
curl -X POST "https://vibe-o-matic.vercel.app/api/admin/refill?n=200&token=<VIBEIFY_ADMIN_TOKEN>"
# → {"ok":true,"operation":"add","added":200,"remaining":<new>,"refillCount":<incremented>}

# Mode B — override the counter to EXACTLY N (atomic SET), does NOT touch refillCount.
# Use for: correcting a double-refill mistake, dialing up/down to an exact number
# for a marketing moment, or seeding from scratch. Cap: 100,000.
curl -X POST "https://vibe-o-matic.vercel.app/api/admin/refill?set=200&token=<VIBEIFY_ADMIN_TOKEN>"
# → {"ok":true,"operation":"set","remaining":200,"refillCount":<unchanged>}
```

If both `?n=` and `?set=` are present, `?set=` wins (it's the more deliberate action).

### Training-dataset access (project-owner procedure)

Three ways to read the contributed training set:

1. **Vercel dashboard** — Storage → Blob → browse. Click into any blob to view (PNGs render; JSON manifests open as text).
2. **Vercel CLI** — `vercel blob list --prefix=training-set/` (requires being logged into the project)
3. **Bulk-export script** (planned, not yet shipped — see [`LORA-PIPELINE.md`](./LORA-PIPELINE.md) for the design): `npm run export-training-set --since 2026-05-01 --thumbs-up-only` to bundle into the format Replicate/fal.ai's LoRA trainer expects.

### Hosting & code

| What | Where | Owner today | To transfer |
|---|---|---|---|
| Live deploy | https://vibe-o-matic.vercel.app | Vercel project owned by `economist5` | Vercel → Project Settings → Advanced → Transfer Project. Or fork-and-redeploy under GVC's Vercel team. |
| Source | https://github.com/economist5/vibe-o-matic (branch `main`) | `economist5` | GitHub → Repository Settings → Transfer ownership. |
| Dev secrets | `.env.local` (gitignored, dev machine only) | Dev machine | Not transferred. GVC creates fresh `.env.local` from their own API keys per `.env.example`. |

### Other API accounts (one-off / dev-only)

| Account | Used by | Required for production? |
|---|---|---|
| Google AI Studio (`GOOGLE_API_KEY`) | `scripts/generate-body-ref.mjs` (regenerating body reference image) | **No** — dev-only utility, run once per ref refresh |

---

## 🔁 Handoff checklist

Do these in order. Each step's success is the precondition for the next.

### 1. GitHub repo transfer
- Current owner (`economist5`) → GitHub repo settings → "Transfer ownership"
- Target: a GVC GitHub org (create one if needed)
- After transfer: clone fresh, verify `main` builds (`npm install && npm run build`)
- Update the `origin` remote on any working copies that need it

### 2. Vercel project transfer (or fork-and-redeploy)
**Option A — Direct transfer** (requires GVC Vercel team on Pro+ plan):
- Vercel dashboard → vibe-o-matic project → Settings → Advanced → Transfer Project → pick GVC team

**Option B — Fork-and-redeploy** (works on any Vercel plan, cleaner cutover):
- GVC creates a new Vercel project from the now-GVC-owned GitHub repo
- Set all 5 env vars (see step 3 below) BEFORE first deploy
- After GVC deploy is verified working, point DNS / share new URL, retire old deploy

Either way, after the move the production URL should serve a `GET /api/vibeify/x402` discovery response with `network: "base"` and the correct `payTo` (treasury) address.

### 3. Provision GVC-owned API keys (and swap in Vercel)

For each row below: provision a new key in GVC's account, then update the Vercel Production env var. Trigger a redeploy after the last swap.

#### 3a. OpenAI
- https://platform.openai.com → create or use GVC's org → API Keys → Create
- Scope: `gpt-4o-mini` is all that's needed (or "All" for simplicity)
- Set as `OPENAI_API_KEY` in Vercel
- Estimated spend: ~$0.0003 per render call — negligible

#### 3b. Black Forest Labs
- https://api.bfl.ai → sign up under GVC org → API Keys → Create
- Set as `BFL_API_KEY` in Vercel
- Estimated spend: ~$0.045 per render — the heaviest cost line

#### 3c. Coinbase CDP (the x402 facilitator)
- https://portal.cdp.coinbase.com → create GVC project → API Keys → Create API Key
- Pick the **x402** scope (or "All scopes" if it's a single-app key)
- **Important:** the Key Secret is shown ONCE — copy it before closing the dialog
- Set as `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` in Vercel
- Estimated cost: free tier covers 1,000 transactions/month

#### 3d. Test-mode bypass password (your choice)
- Pick any string you want as the bypass password
- Set as `VIBEIFY_BYPASS_PASSWORD` in Vercel
- Or: leave UNSET to fully disable test mode in production

### 4. Treasury wallet verification

The same address `0xc93c375b022f0e707d211090d904f3266ccfce22` receives both:
- **USDC** on Base mainnet (every x402 paid render)
- **VIBESTR** on Ethereum mainnet (every VIBESTR paid render, once allowlist add lands)

**Before accepting volume:** confirm the GVC team holds the private key for this address. Test by signing a benign message from MetaMask connected to that address. If you don't hold the key, **stop and rotate** — update `SPLIT_RECIPIENTS[0].address` in `lib/payment-config.ts:36-40` AND `USDC_RECIPIENT` at `:84` to a GVC-controlled wallet, commit, redeploy.

### 5. VIBESTR allowlist add (one-time on-chain)

VIBESTR's `_transfer` enforces a private recipient allowlist. Add the treasury address to it so the VIBESTR rail can go live:

```
Contract:  0xd0cC2b0eFb168bFe1f94a948D8df70FA10257196 (Ethereum mainnet)
Add to allowlist:  0xc93c375b022f0e707d211090d904f3266ccfce22
```

Verification script and re-enable instructions live in [`LAUNCH.md`](./LAUNCH.md#-pending-vibestr-allowlist-add). After confirmation, two-line edit in `app/page.tsx` flips the UI from "SOON" to active.

### 6. Update repo URL in source

The UI surfaces a "View source" / clone-instructions snippet to agent developers. Two places to update after step 1:

- `app/page.tsx` (in `AgentEndpointCard`): the `repoBase` constant
- `X402.md`: the `git clone …` line in the Quickstart section

Both currently point at `https://github.com/economist5/vibe-o-matic` (the original author's account). Update both to the new GVC-owned URL once the GitHub transfer in step 1 completes.

---

## 🔒 "Don't change these" — code-level constants

These are public on-chain identifiers, not secrets. Leave them alone unless you're intentionally changing the protocol:

- `VIBESTR_ADDRESS` (`lib/payment-config.ts:13`) — VIBESTR ERC-20 mainnet address
- `USDC` mainnet contract (`lib/wallet.ts:200`) — Circle's Base USDC
- `X402_FACILITATOR_URL` (`lib/payment-config.ts:95`) — CDP's mainnet facilitator
- `RPC_URL` (`lib/payment-config.ts:70`) — public Ethereum RPC (replace with an owned RPC if you want stricter SLAs, but the default works)
- USDC chain config (`USDC_NETWORK` / `USDC_CHAIN_ID` / `USDC_NETWORK_CAIP`, `lib/payment-config.ts:79-81`)

The only intentional change you should ever make to `lib/payment-config.ts` is the treasury address (in two places — see step 4 above) or the price (`TOTAL_VIBESTR` / `USDC_PRICE_DOLLARS`).

---

## ✅ Post-handoff verification

After all swaps land, run these in order:

```bash
# 1. Homepage + discovery should both 200
curl -fsS -o /dev/null -w "homepage:    %{http_code}\n" https://vibe-o-matic.vercel.app/
curl -fsS https://vibe-o-matic.vercel.app/api/vibeify/x402
```

Expected discovery body:
```json
{"network":"base","price":"$0.69","payTo":"0xc93c375b022f0e707d211090d904f3266ccfce22","facilitator":"https://api.cdp.coinbase.com/platform/v2/x402"}
```

```bash
# 2. Treasury USDC balance on Base mainnet — should reflect your control
node --input-type=module -e "
import { createPublicClient, http, formatUnits, parseAbi } from 'viem';
import { base } from 'viem/chains';
const c = createPublicClient({ chain: base, transport: http() });
const bal = await c.readContract({
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
  functionName: 'balanceOf',
  args: ['0xc93c375b022f0e707d211090d904f3266ccfce22'],
});
console.log('Treasury USDC on Base:', formatUnits(bal, 6));
"
```

3. **End-to-end paid render** — use `scripts/test-x402-agent.mjs` from a Base mainnet wallet funded with ~$1 USDC:
   ```bash
   node scripts/test-x402-agent.mjs --help
   AGENT_PRIVATE_KEY=0x... node scripts/test-x402-agent.mjs ./agent-photo.jpg "test render"
   ```
   Expected outcome: PNG saved to disk + tx hash on Basescan + treasury USDC balance grew by $0.69.

4. **Vercel logs** — `vercel logs --since 1h` should show clean `[vibeify-x402]` settlement traces for any test calls; no auth or config errors.

If all four pass, ownership transfer is complete.

---

## 📚 Related docs

- [`LAUNCH.md`](./LAUNCH.md) — live-ops reference (smoke tests, rollback procedures, env var ladder)
- [`X402.md`](./X402.md) — external-facing agent endpoint contract
- [`FUTURE.md`](./FUTURE.md) — roadmap (LoRA integration is the headline)
- [`SUBMISSION.md`](./SUBMISSION.md) — hackathon submission narrative

---

*This doc is the contract between the developer and the GVC team. Keep it
fresh whenever a dependency moves, a key rotates, or the treasury address
changes. Anyone inheriting vibe-o-matic from here on should be able to use
this as their single take-over reference.*
