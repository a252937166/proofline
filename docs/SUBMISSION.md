# Hackathon submission

## Project

**Proofline**<br>
**Don’t trust the score. Re-run the proof.**

- Demo: [proofline.axiqo.xyz](https://proofline.axiqo.xyz)
- Source: [github.com/a252937166/proofline](https://github.com/a252937166/proofline)
- Network: Injective EVM testnet, `eip155:1439`
- Verified registry:
  [`0x959538bE97f6Fc3A09C823514acC176681155A7e`](https://testnet.blockscout.injective.network/address/0x959538bE97f6Fc3A09C823514acC176681155A7e)

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

The 90-second demo replays Wales 0–2 IR Iran from the 2022 World Cup using
attributed historical facts. An explicitly synthetic provider fault changes
Wayne Hennessey's 86th-minute red card to yellow. Proofline stops at the exact
field mismatch and refuses settlement. After official corroboration and a
recorded retraction, it recovers without deleting the bad observation. At full
time the final result becomes eligible for an Injective commitment and an x402
verification report.

No live match is required to reproduce this failure. Separately, the product
exposes an honest 2026 delayed result snapshot—France 2–0 Morocco, supported by
ESPN and FIFA provenance—and 2026 scheduled fixtures with `score=null`. Delayed,
scheduled, and historical-replay modes are machine-readable and never silently
promoted to live.

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
| Registry deployment | [`0x87bf72e57d0c6c2768a9fae0177209cfd06d3d3b2c29b12986b350352f9286fc`](https://testnet.blockscout.injective.network/tx/0x87bf72e57d0c6c2768a9fae0177209cfd06d3d3b2c29b12986b350352f9286fc) |
| Anchorer role grant | [`0x72704feff656f75de591da4ee624333294509b76beaba1b4925109096bd748b3`](https://testnet.blockscout.injective.network/tx/0x72704feff656f75de591da4ee624333294509b76beaba1b4925109096bd748b3) |
| Final-result anchor | [`0x455e933b149e8f291d41f5e5fc58fdca55fdb56c7cfd3a9e1b2f55d32f6c6038`](https://testnet.blockscout.injective.network/tx/0x455e933b149e8f291d41f5e5fc58fdca55fdb56c7cfd3a9e1b2f55d32f6c6038) |
| x402 `0.01` test-USDC settlement | [`0x79700fa00ff0d0c7a5821608f6221c7805b2feb3fe72133d526b491c41fe624a`](https://testnet.blockscout.injective.network/tx/0x79700fa00ff0d0c7a5821608f6221c7805b2feb3fe72133d526b491c41fe624a) |

The x402 settlement changed payer/payee balances from `20.00 → 19.99` and
`20.00 → 20.01` test USDC. The packet passed all three proof layers. The
sanitized evidence bundle is
[evidence/testnet/real-e2e-2026-07-11.json](../evidence/testnet/real-e2e-2026-07-11.json).

## Agent and MCP evidence

Proofline ships ten domain MCP tools and a project Agent Skill. A separate,
reproducible capture exercised the official Injective MCP over stdio on testnet:
37 tools were listed, and `address_normalize` plus `usdc_native_info` returned
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
  role controls, historical reads, and latest-only settlement verification;
- real `0.01` native test-USDC x402 settlement;
- EIP-712 issuer-signed portable packets with trusted-issuer enforcement;
- MCP server, runtime audit surface, Agent Skill, and hard spending caps;
- unit, API, MCP, real-EVM contract, browser, build, and smoke verification.

## Capability boundary

CCTP is **future work**. The intended funding route is Base Sepolia domain `6`
to Injective domain `29`, but this submission claims no CCTP burn, attestation,
mint, or destination balance-recheck transaction. Native Injective testnet USDC
and the x402 settlement linked above are real. No mainnet asset was used.
