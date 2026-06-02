# vibe-o-matic — launch state & operations

Operational reference for the **live production deploy**. Originally written
as a pre-launch flip checklist (testnet → mainnet); rewritten in commit
`a513329` once the mainnet flip shipped.

---

## ✅ Current production state

| Component | State | Network | Notes |
|---|---|---|---|
| **Live URL** | ✅ shipping | – | https://vibe-o-matic.vercel.app |
| **Source** | ✅ public | – | https://github.com/economist5/vibe-o-matic (branch `main`) |
| **Web UI USDC rail** | ✅ live | Base mainnet (8453) | Default rail. $0.69 USDC per render. Settles via [Coinbase CDP x402 facilitator](https://api.cdp.coinbase.com/platform/v2/x402). |
| **Web UI VIBESTR rail** | ⏳ pending | Ethereum mainnet (1) | Shown as `SOON` pill. Awaiting GVC team adding our treasury to VIBESTR's recipient allowlist. |
| **x402 agent endpoint** | ✅ live | Base mainnet (8453) | `POST /api/vibeify/x402` — machine-callable, identical USDC settlement. |
| **Test-mode bypass** | 🔒 password-gated | – | Server validates `VIBEIFY_BYPASS_PASSWORD` env var; unset → every bypass request returns 403 (test mode fully disabled). |
| **Ownership handoff** | 📋 see [WIRING.md](./WIRING.md) | – | Per-dependency take-over checklist (env vars, wallets, hosting, accounts). |

### Treasury / payment addresses

| Rail | Recipient | Contract |
|---|---|---|
| USDC | `0xc93c375b022f0e707d211090d904f3266ccfce22` (Base mainnet) | USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| VIBESTR | `0xc93c375b022f0e707d211090d904f3266ccfce22` (Ethereum mainnet) | VIBESTR `0xd0cC2b0eFb168bFe1f94a948D8df70FA10257196` |

EVM addresses are network-agnostic; the same `0xc93c375b…cfce22` receives on both
chains. **Verify control of that wallet on Base mainnet before pointing volume at
it** — funds sent to an uncontrolled address are unrecoverable.

---

## ⏳ Pending: VIBESTR allowlist add

VIBESTR's `_transfer` enforces a private internal recipient allowlist. Transfers
to allowlisted addresses succeed; any other recipient reverts with
`InsufficientAllowance` (`0x2f352531`) regardless of sender balance. The GVC
team has been asked to add `0xc93c375b022f0e707d211090d904f3266ccfce22` to the
list.

### How to verify the allowlist add landed

```bash
node --input-type=module -e "
import { createPublicClient, http, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';
const c = createPublicClient({ chain: mainnet, transport: http('https://ethereum-rpc.publicnode.com') });
try {
  await c.simulateContract({
    address: '0xd0cC2b0eFb168bFe1f94a948D8df70FA10257196',
    abi: parseAbi(['function transfer(address,uint256) returns (bool)']),
    functionName: 'transfer',
    args: ['0xc93c375b022f0e707d211090d904f3266ccfce22', 99n * 10n ** 18n],
    account: '0xac1e7beae9fcf9b4f294cd534cd0b1ae1ef44793',
  });
  console.log('✓ Allowlist is LIVE — re-enable VIBESTR rail in the UI');
} catch (e) {
  console.log('✗ Still gated — allowlist add has not landed yet');
}
"
```

### How to re-enable the VIBESTR rail in the UI once it lands

Two small edits in `app/page.tsx`:

1. Find the disabled VIBESTR `<button>` in the rail-toggle block (search for `SOON` text)
2. Replace its `onClick` (currently shows the "coming soon" toast) with `() => setPaymentRail("vibestr")`
3. Remove the `cursor-not-allowed` class and the `<span>SOON</span>` pill, copy the styling pattern from the USDC button (active gold when selected, hover-light otherwise)

That's the whole change. The server-side route, the `payVibestrSplit` helper,
and the `verifyPayment` function are already production-ready and wait for
nothing.

---

## 🔑 Required production env vars (Vercel)

| Var | Production value | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | (set) | gpt-4o-mini describer + x402 agent picker |
| `BFL_API_KEY` | (set) | Flux 2 [pro] image generation |
| `CDP_API_KEY_ID` | (set) | Coinbase CDP API key id — required for the x402 USDC facilitator to verify/settle on Base mainnet |
| `CDP_API_KEY_SECRET` | (set) | Coinbase CDP API key secret — paired with the id above |
| `VIBEIFY_BYPASS_PASSWORD` | **required for test mode** | Server-validated password for free-render bypass. If unset, every bypass request returns 403 (test mode is fully disabled). Password lives ONLY in this env var — never in source. Rotate at will. |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`) | (auto-injected by Vercel) | Upstash Redis (via the Vercel Storage marketplace). Backs the 200-render community-free counter. Auto-injected when the Upstash Redis store is connected to the project. Either env-var naming scheme is detected. If absent, the community-free path returns 503 ("not yet available"); paid + test paths unaffected. |
| `BLOB_READ_WRITE_TOKEN` | (auto-injected by Vercel) | Vercel Blob storage token. Backs the voluntary training-set contribution endpoint. Auto-injected when the Blob store is connected. If absent, `/api/training-set/submit` returns 503; the rest of the program (counter, eligibility, render) keeps working. Store is configured PRIVATE — only authenticated SDK calls can read the dataset. |
| `VIBEIFY_ADMIN_TOKEN` | **required for the X-reload loop** | Server-validated secret for `POST /api/admin/refill?token=…` (two modes: `?n=N` adds, `?set=N` overrides to exact value — see [WIRING.md](./WIRING.md#counter-refill-admin-procedure)). Used by the project owner (or whoever holds the key post-handoff) to top up the community-free counter after the public ping mechanic surfaces on X. Pick any random ≥32-char string; rotate by changing in Vercel and redeploying. If unset, the admin endpoint returns 503; counter stays at whatever it is + has to be edited in the dashboard manually. |

### How to provision the CDP keys

1. Sign up / log in at https://portal.cdp.coinbase.com/
2. Create a project (or use the default)
3. Navigate to **API Keys** → **Create API Key**
4. Pick the **x402** scope (or all scopes if it's a single-app key)
5. Download / copy both the **Key ID** and **Key Secret** (the secret is only shown once)
6. Add both to Vercel Production env vars

The CDP facilitator gives you 1,000 free transactions per month — plenty
of headroom for the hackathon and well beyond.

No private keys for any wallet live in env. The server never holds a
wallet — Coinbase's facilitator handles all on-chain interactions for
the USDC rail using JWTs signed with the CDP keys above; the VIBESTR
route only verifies user-signed transactions on Ethereum mainnet via a
public RPC.

### How to provision Vercel KV (Upstash Redis) + Blob

The community-feedback program (FEEDBACK-V1.md) needs both. Both are
in Vercel's Storage marketplace.

**Upstash Redis (counter):**
1. Vercel dashboard → vibe-o-matic project → **Storage** → **Upstash** (the row with the chevron)
2. Pick the **Redis** product
3. Free tier (10k commands/day; we use ~400/cycle)
4. Connect to project → vibe-o-matic
5. Auto-injects `KV_REST_API_URL` + `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` + token; the route reads whichever)
6. Seed the counter once: `curl -X POST "https://vibe-o-matic.vercel.app/api/admin/refill?set=200&token=<VIBEIFY_ADMIN_TOKEN>"` (use `?set=N` for the initial seed — atomic SET, doesn't bump refillCount. Subsequent top-ups use `?n=N`.)

**Vercel Blob (training dataset):**
1. Vercel dashboard → vibe-o-matic project → **Storage** → **Blob** → **Create**
2. Name: `vibeify-training-set` (or whatever)
3. Access: **PRIVATE** (correct privacy posture — dataset should not be publicly enumerable)
4. Connect to project → vibe-o-matic
5. Auto-injects `BLOB_READ_WRITE_TOKEN`
6. Trigger a redeploy (Vercel doesn't auto-redeploy on storage connect)

Verify both: `curl https://vibe-o-matic.vercel.app/api/free-renders/remaining` should return `{available: true, remaining: N, refillCount: M}`. Browse the dataset via Vercel dashboard → Storage → Blob → browse for `training-set/`.

---

## 🩺 Production health checks

### Quick smoke test (no payment required)

```bash
# Homepage + x402 discovery should both 200
curl -fsS -o /dev/null -w "homepage:    %{http_code}\n" https://vibe-o-matic.vercel.app/
curl -fsS -w "\n" https://vibe-o-matic.vercel.app/api/vibeify/x402 | head -c 200

# Community-feedback program endpoints
curl -fsS https://vibe-o-matic.vercel.app/api/free-renders/remaining
# → {"available":true,"remaining":<n>,"refillCount":<m>}
# (or {"available":false} if Upstash Redis isn't provisioned/connected)

curl -fsS "https://vibe-o-matic.vercel.app/api/community/eligibility?wallet=0x16d4f4eEB5c9C944A2359342D5E586B23051E3cd"
# → known holder; should return isMember:true, qualifier:"gvc-nft"
```

Expected discovery body:
```json
{"network":"base","price":"$0.69","payTo":"0xc93c375b022f0e707d211090d904f3266ccfce22","facilitator":"https://api.cdp.coinbase.com/platform/v2/x402"}
```

If `network` returns anything other than `"base"`, the deploy is serving stale
code — redeploy from Vercel dashboard.

### Treasury balance check (Base mainnet USDC)

```bash
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

Growth in that number over time = renders are settling correctly.

### Server logs (Vercel)

`vercel logs --since 1h` (or the dashboard). The route logs:
- `[vibeify] start size=… mime=… bufferBytes=…` per request
- `[vibeify] describer ok (N chars)` after gpt-4o-mini succeeds
- `[vibeify] Flux render failed …` on render errors (with reason)
- `[vibeify-x402] 402: …` on x402 verification / settlement failures (with reason)

---

## 🆘 Rollback procedures

### Generic: Vercel-side revert (safest)

If the latest deploy is broken, instant rollback:
1. Vercel dashboard → vibe-o-matic project → Deployments
2. Find the last known-good deploy → ⋯ menu → **Promote to Production**

No git changes needed. Fastest path out of a bad deploy.

### Mainnet → Sepolia (if the USDC rail itself has problems)

If you need to take the USDC rail off real money temporarily (e.g.
facilitator outage, suspected wallet compromise), revert these constants:

```ts
// lib/payment-config.ts
export const USDC_NETWORK      = "base-sepolia" as const;
export const USDC_CHAIN_ID     = 84532;
export const USDC_NETWORK_CAIP = "eip155:84532" as const;

// lib/wallet.ts
const USDC_BASE = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const; // Sepolia
const basePublicClient = createPublicClient({ chain: baseSepolia, transport: http() });
//                                                   ^^^^^^^^^^^^
// (also `import { baseSepolia } from "viem/chains"`)
//
// scripts/test-x402-agent.mjs: same baseSepolia swap.
```

After this, all USDC payments target testnet — the live production app continues
to function, but no real money moves. Communicate the temporary state externally
since callers' real-USDC wallets will be on the wrong network.

### Why users are never half-charged

`/api/vibeify/x402` does `verify → render → settle` in that order. If render
fails (502), `settle` is never called — caller's USDC stays in their wallet. If
settlement fails after a successful render, the response carries 402 + an
error — caller sees a failure and is not charged. The system is **atomic
across rollbacks**: there's no state where someone paid but didn't get a
render, or got a render but didn't pay.

---

## 📋 Post-launch verification (done at flip time, kept for reference)

The mainnet flip shipped in `a513329`. The verification at that time:

- [x] `USDC_NETWORK` = `"base"` in `lib/payment-config.ts`
- [x] `USDC_CHAIN_ID` = `8453`
- [x] `USDC_NETWORK_CAIP` = `"eip155:8453"`
- [x] USDC contract = mainnet `0x833589fCD…2913` in `lib/wallet.ts`
- [x] `ensureBase`, `getUsdcBalanceBase` (renamed from Sepolia counterparts)
- [x] `scripts/test-x402-agent.mjs` imports `base` from `viem/chains`
- [x] `VIBEIFY_BYPASS_PASSWORD` (formerly `VIBEIFY_ALLOW_BYPASS`) set in Vercel Production (or intentionally unset to fully disable test mode)
- [x] `OPENAI_API_KEY` + `BFL_API_KEY` + `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET` all set in Vercel Production
- [x] `npm run build` clean locally
- [x] `GET /api/vibeify/x402` returns `network: "base"` from the deployed URL
- [x] Homepage returns 200
- [ ] First real $0.69 USDC paid render end-to-end on the live URL → tx hash on Basescan
- [ ] First VIBESTR paid render (blocked on allowlist add)

---

## 📌 Known follow-ups (not blockers)

- **VIBESTR allowlist add** — see "Pending" section above. The one-line code re-enable will land the moment GVC confirms.
- **In-memory tx-hash replay protection** — `USED_TX_HASHES` Set in `app/api/vibeify/route.ts` resets on every Vercel cold start, meaning a redeploy can re-unlock previously-spent VIBESTR tx hashes. Out-of-scope while VIBESTR is gated on the allowlist anyway; revisit when the rail goes live (move to KV or sign nonces).
- **Treasury address duplicated across the codebase** — `lib/payment-config.ts` (×2), `LAUNCH.md` (×many), `WIRING.md`. If GVC rotates the address, every reference needs updating. Worth a small refactor that exports a single `TREASURY_ADDRESS` re-used everywhere.
- **Next.js security patch** — `next@14.2.15` has an advisory; safe to bump to the latest 14.x patch release any time post-hackathon.
- **x402 v1 → v2 migration** — current packages are deprecated v1. Works fine against the facilitator today; v2 requires Next 16 and is a non-trivial migration. Filed in `FUTURE.md`.
- **npm deprecation warnings** — `uuid@9`, `@metamask/sdk@0.33.1`, etc. Noisy but functional.

---

*Keep this doc fresh when the production topology changes — network, addresses,
env vars, or operational procedures. Anyone running ops on vibe-o-matic should
be able to use this as their single reference.*
