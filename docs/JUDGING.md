# Judge guide

Proofline is designed to answer three questions before a sports product or AI
Agent acts:

1. What did each independent source report?
2. Is the current event safe under a reproducible evidence policy?
3. Can another machine verify the packet, its issuer, and the latest chain
   commitment?

## 15 seconds — inspect the thesis

Open the [Real wallet test](https://proofline.axiqo.xyz/?case=WC-2026-M97-FRA-MAR&experience=wallet).
The first screen separates the result shown to a user from the proof required
for automated settlement. These direct links keep each judge path reproducible:

| Experience | Direct link | Payment boundary |
| --- | --- | --- |
| Real wallet test | [France–Morocco wallet path](https://proofline.axiqo.xyz/?case=WC-2026-M97-FRA-MAR&experience=wallet) | `0.01` test USDC; two signatures; one payment |
| No-wallet audit | [France–Morocco published packet](https://proofline.axiqo.xyz/?case=WC-2026-M97-FRA-MAR&experience=audit) | No new wallet request or payment |
| Conflict replay | [Wales–IR Iran control case](https://proofline.axiqo.xyz/?case=WC-2022-WAL-IRN&experience=replay) | Disclosed replay; no payment required |

The catalog also distinguishes each machine-readable data mode:

- **2026 delayed:** France 2–0 Morocco, with ESPN and FIFA provenance;
- **2026 scheduled:** Norway–England and Argentina–Switzerland, with
  `score=null` and no invented live state;
- **2022 historical replay:** Wales 0–2 IR Iran, the deterministic conflict
  demonstration.

## 90 seconds — run the judge demo

The real payment path is **Wallet → Review → Sign → Verify**. No stage
silently signs, pays, or advances into the next stage.

1. On the default France–Morocco case, inspect ESPN and FIFA converging as two
   separately hashed source lanes beside the one active judge task.
2. Keep **Real wallet test** selected. Press **Connect test wallet**, choose any
   compatible EIP-6963/EIP-1193 provider, and confirm the selected account is on
   Injective EVM Testnet. If its balance is below `0.01`, press **Get 0.02 test
   USDC**: the rate-limited judge dispenser shows its Blockscout receipt and
   refreshes preflight automatically. When preflight is ready, press **Continue
   to proof review**; this closes the wallet sheet and returns to the review
   action without signing or paying.
3. Press **Review 0.01 test USDC proof**. Before signing, verify the exact
   amount, network and payee plus the explicit policy: two signatures, one
   payment, and zero wallet-broadcast transactions.
4. Signature `1/2` authorizes one EIP-3009 transfer and remains in memory; no
   payment is sent yet. Signature `2/2` binds the exact proof, payer and browser
   session and does not authorize another transfer. Only then is the single
   `PAYMENT-SIGNATURE` submitted.
5. Confirm the Payment Receipt identifies the payer, payee, amount, balance
   change, and Blockscout transaction. Then confirm all three returned layers
   pass: packet integrity, EIP-712 trusted issuer, and latest Registry v3
   commitment.
6. Switch to **No-wallet audit** to recompute the published sample without a
   new payment or wallet request.
7. Switch to **Conflict replay**, then press **Watch conflict quarantine** to
   enter the deterministic control case.
8. Press **Run the 90-second verification demo**.
9. OpenFootball reports Wayne Hennessey's red card.
10. The explicitly synthetic provider-lag observation reports yellow. Proofline
   pauses on the exact `card` mismatch, marks the event `contested`, and holds
   settlement.
11. Press **Continue with provider correction**. FIFA corroborates red and the
   bad claim is retracted without deleting history.
12. Late goals and full-time status produce the final 0–2 event.
13. Inspect the Evidence Score. It is a deterministic policy score, **not a
   probability**. Only one representative from each independent source group
   contributes weight; duplicating one provider cannot manufacture quorum.
14. Press **Inspect x402 + chain proof** and verify all three layers:
   packet integrity, EIP-712 trusted issuer, and match-wide latest on-chain
   commitment. If the drawer is opened before the final frame, press
   **Prepare replay + testnet anchor** first. That preflight advances only the
   disclosed evidence tape and server-funded idempotent testnet anchor; it does
   not open a wallet or request USDC. The wallet remains a separate action
   after the unsigned HTTP 402 terms are visible.
15. Run the tamper check. A one-field mutation must fail integrity verification.

The replay is permanently labelled **Historical Replay · Not Live**, and the
injected yellow-card fault is permanently labelled synthetic.

## Public testnet evidence — no wallet required

| Check | Blockscout evidence |
| --- | --- |
| Fully verified `MatchProofRegistry` v3 | [`0x380D75d068dec45D8145ef89B7A40a6201Ac1ef1`](https://testnet.blockscout.injective.network/address/0x380D75d068dec45D8145ef89B7A40a6201Ac1ef1?tab=contract) |
| Contract deployment | [`0xdf71a0e7fce722bfdc39b58951f6548ef07b6d06cb101aa57bc51a5566979523`](https://testnet.blockscout.injective.network/tx/0xdf71a0e7fce722bfdc39b58951f6548ef07b6d06cb101aa57bc51a5566979523) |
| Anchorer authorization | [`0x58587a0d751248b714a6232cc75618762e02ff355aba00fa28d79216f252acb4`](https://testnet.blockscout.injective.network/tx/0x58587a0d751248b714a6232cc75618762e02ff355aba00fa28d79216f252acb4) |
| 2026 final-result anchor | [`0x24cd0ae9a40dbfdba14563f9f2932451624be63928667b629c4cadc86a507344`](https://testnet.blockscout.injective.network/tx/0x24cd0ae9a40dbfdba14563f9f2932451624be63928667b629c4cadc86a507344) |
| 2026 x402 `0.01` test-USDC settlement | [`0x29237a0a3d501ca62882042313fcbb730fd91d152967430b2600545a227b842e`](https://testnet.blockscout.injective.network/tx/0x29237a0a3d501ca62882042313fcbb730fd91d152967430b2600545a227b842e) |

The anchored 2026 commitment is revision `1`, event hash
`0x8837f43f315336c660ec19791c4a374e7eacdd7ff9d66c546247bbeb89035b30`,
evidence root
`0xe048362103ce6c4f07d95e1a0ebdd81b7b9b9332943d4af978cdde71b62661b3`,
and Evidence Score `98.25/100`. The full no-wallet packet is
[machine-readable](../data/evidence/featured-proof.json).

## Agent and MCP evidence

Proofline exposes ten domain MCP tools, including `get_match_events`,
`assess_settlement_readiness`, `purchase_match_proof`,
`verify_proof_packet`, and `verify_onchain_anchor`. The UI labels an Agent trace
as actual only when MCP runtime logs are present; otherwise it explicitly says
that the trace is illustrative.

The repository includes a real stdio execution capture from the official
Injective MCP pinned at commit
`f5af39367975872a85b5447cefc9a197f2e635ea`. It listed 37 tools and successfully
ran `address_normalize`, `usdc_native_info`, and `account_balances` on testnet.
The balance call returned the payer's post-purchase `19.98` test USDC. Inspect the sanitized
[MCP transcript](../evidence/agent/official-injective-mcp.json) or reproduce it
with `npm run evidence:injective-mcp`.

[Proofline's own MCP transcript](../evidence/agent/proofline-mcp-testnet.json)
records five successful real tool calls. Its final
`verify_onchain_anchor` call performed a fresh Injective EVM read and matched
the registry's latest revision `1` and evidence root.

## Important boundary

CCTP is **future work**, not a completed feature. The design targets Base
Sepolia domain `6` to Injective domain `29`, but Proofline claims no CCTP burn,
attestation, mint, or balance-recheck transaction. Native Injective testnet USDC
and the x402 payment above are real; no mainnet asset was used.

## Release identity check

The final judge source is the immutable
[`global-cup-final-v2`](https://github.com/a252937166/proofline/releases/tag/global-cup-final-v2)
release. Before accepting the build as frozen, verify all four conditions:

1. The release tag resolves to the submitted source revision.
2. The [Proofline CI workflow](https://github.com/a252937166/proofline/actions/workflows/ci.yml)
   passes `npm run check` and `npm audit --audit-level=high` for that revision.
3. The live [`release.json`](https://proofline.axiqo.xyz/release.json) and Footer
   resolve to the same source and identify the `global-cup-final-v2` release.
4. The GitHub Release publishes matching API/Web archives and SHA-256 manifests.

This is a final-freeze checklist. It does not substitute a placeholder commit,
CI result, or checksum for evidence that has not yet been produced.

## Local verification

```bash
npm install
npm run check
npm run smoke
npm run dev
```

The web app opens at `http://localhost:5173`; the API listens on
`http://localhost:8787`.
