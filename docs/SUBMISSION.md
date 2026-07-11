# Hackathon submission

## Project

**Proofline**<br>
**Don’t trust the score. Re-run the proof.**

- Demo: [proofline.axiqo.xyz](https://proofline.axiqo.xyz)
- Source: [github.com/a252937166/proofline](https://github.com/a252937166/proofline)
- Network: Injective EVM testnet, `eip155:1439`
- Verified registry:
  [`0x380D75d068dec45D8145ef89B7A40a6201Ac1ef1`](https://testnet.blockscout.injective.network/address/0x380D75d068dec45D8145ef89B7A40a6201Ac1ef1?tab=contract)
- Immutable source: [`global-cup-final`](https://github.com/a252937166/proofline/releases/tag/global-cup-final)

## Short description

Proofline is a conflict-aware evidence and settlement layer for World Cup
applications and AI Agents. Its VARA engine compares independent source groups,
quarantines conflicting events, sells a portable verification packet through
x402, and anchors the evidence commitment on Injective EVM testnet.

## The product problem

AI Agents can read a score, but usually cannot explain why they were allowed to
act on it. One delayed provider, duplicated syndication feed, or silent
correction can trigger a false reward, public claim, or settlement.

Proofline separates “a provider reported this” from “an Agent may safely act.”
Every observation is normalized, attributed, hashed, and assigned to an
independence group. VARA selects a canonical event under a published policy;
any active material conflict overrides the numeric score and holds settlement.
Repeating one upstream source never adds quorum or voting weight.

The numeric `96.49/100` shown in the final replay is an **Evidence Score**, not
a probability that the sporting fact is true. It is a reproducible policy score
derived from reliability, independent quorum, agreement, freshness, and
conflict penalties.

## Judge experience

The default screen is the primary 2026 product case: France 2–0 Morocco, an
honest delayed result supported by separately hashed ESPN and FIFA source
snapshots. One click recomputes the evidence, recovers its Registry v3 anchor,
opens the x402 report, verifies the EIP-712 issuer, and performs a fresh
latest-revision read. A previously settled packet can run the same three-layer
check without a wallet.

The secondary 90-second conflict-control replay uses Wales 0–2 IR Iran from the
2022 World Cup. An explicitly synthetic provider fault changes Wayne
Hennessey's 86th-minute red card to yellow. Proofline stops at the exact field
mismatch and refuses settlement; official corroboration and a recorded
retraction later recover the decision without deleting the bad observation.
No live match is required to reproduce that failure. Scheduled fixtures keep
`score=null`; delayed, scheduled, and historical-replay modes are
machine-readable and never silently promoted to live.

## Why Injective is essential

1. The fully verified `MatchProofRegistry` stores append-only, revision-linked
   evidence commitments on Injective EVM testnet.
2. The premium packet costs `0.01` native Injective testnet USDC through the
   official `@injectivelabs/x402` middleware/client path.
3. The Proofline MCP lets an Agent assess readiness, purchase a packet under a
   hard spending policy, verify its issuer, and read the latest registry state.
4. The Agent Skill forbids settlement for contested, low-score, non-final, or
   stale on-chain evidence.

## Three-layer proof

The paid packet is useful outside Proofline because each layer is checked
separately:

1. **Integrity:** recompute normalized evidence, event hash, evidence root,
   settlement policy, and packet hash.
2. **Trusted issuer:** recover the EIP-712 signer and compare it with the
   configured trusted-issuer allowlist. A self-signed attacker packet is not
   trusted merely because its signature is valid.
3. **Latest commitment:** read the match-wide latest registry revision and
   match its event hash, evidence root, Evidence Score, and state. A later
   disputed or rejected revision makes an older proof stale for settlement.

The chain proves commitment, ordering, and freshness of the selected revision;
transparent provenance and deterministic verification establish evidence
quality. Proofline does not claim that a hash makes a sports fact true.

## Public execution evidence

| Operation | Evidence |
| --- | --- |
| Registry v3 deployment | [`0xdf71a0e7fce722bfdc39b58951f6548ef07b6d06cb101aa57bc51a5566979523`](https://testnet.blockscout.injective.network/tx/0xdf71a0e7fce722bfdc39b58951f6548ef07b6d06cb101aa57bc51a5566979523) |
| Anchorer role grant | [`0x58587a0d751248b714a6232cc75618762e02ff355aba00fa28d79216f252acb4`](https://testnet.blockscout.injective.network/tx/0x58587a0d751248b714a6232cc75618762e02ff355aba00fa28d79216f252acb4) |
| 2026 final-result anchor | [`0x24cd0ae9a40dbfdba14563f9f2932451624be63928667b629c4cadc86a507344`](https://testnet.blockscout.injective.network/tx/0x24cd0ae9a40dbfdba14563f9f2932451624be63928667b629c4cadc86a507344) |
| 2026 x402 `0.01` test-USDC settlement | [`0x29237a0a3d501ca62882042313fcbb730fd91d152967430b2600545a227b842e`](https://testnet.blockscout.injective.network/tx/0x29237a0a3d501ca62882042313fcbb730fd91d152967430b2600545a227b842e) |

The 2026 x402 settlement changed payer/payee balances from `19.99 → 19.98`
and `20.01 → 20.02` test USDC. Packet integrity, current issuer policy, and the
fresh registry read all passed. The complete no-wallet evidence bundle is
[data/evidence/featured-proof.json](../data/evidence/featured-proof.json).

## Agent and MCP evidence

Proofline ships ten domain MCP tools and a project Agent Skill. A separate,
reproducible capture exercised the official Injective MCP over stdio on testnet:
37 tools were listed, and `address_normalize`, `usdc_native_info`, plus the
product-relevant `account_balances` call returned
successful results. The server commit, inputs, outputs, durations, and network
are recorded in
[evidence/agent/official-injective-mcp.json](../evidence/agent/official-injective-mcp.json).
Proofline's own ten-tool server is captured separately in
[proofline-mcp-testnet.json](../evidence/agent/proofline-mcp-testnet.json),
including a successful fresh on-chain verification of registry revision `1`.

## Technical highlights

- React + TypeScript verification control room with a guided 90-second demo;
- Express evidence API, SSE replay, honest delayed/scheduled/replay modes;
- Unicode-stable canonical JSON, Keccak-256 event/packet hashing, and
  provenance-bound evidence roots;
- independent-group quorum, conflict quarantine, and an 82/100 settlement
  policy threshold;
- Solidity append-only registry with optimistic revision linking, pause and
  role controls, historical reads, latest-only settlement verification, fully
  immutable `Final`, and no concurrency-bypassing convenience writer;
- real `0.01` native test-USDC x402 settlement;
- EIP-712 issuer-signed portable packets with trusted-issuer enforcement;
- issuer key IDs, valid-time history, and policy-versioned key rotation;
- a second ProofPurchase EIP-712 authorization that explicitly binds the
  packet hash to payee, price, deadline, USDC nonce, and session;
- durable frozen-packet entitlements and exact-signature payment recovery;
- MCP server, runtime audit surface, Agent Skill, and hard spending caps;
- unit, API, MCP, real-EVM contract, browser, build, and smoke verification.

## Capability boundary

CCTP is **future work**. The intended funding route is Base Sepolia domain `6`
to Injective domain `29`, but this submission claims no CCTP burn, attestation,
mint, or destination balance-recheck transaction. Native Injective testnet USDC
and the x402 settlement linked above are real. No mainnet asset was used.
