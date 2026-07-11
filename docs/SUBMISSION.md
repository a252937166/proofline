# Hackathon submission draft

## Project name

**Proofline**

## Tagline

**Don’t trust the score. Re-run the proof.**

## Short description

Proofline is a conflict-aware evidence and settlement layer for World Cup
applications and AI agents. Its VARA engine compares independent sports
sources, quarantines conflicting events, produces a portable x402 proof packet,
and anchors the canonical decision hash on Injective EVM testnet.

## Long description

AI agents can read a score, but they usually cannot explain why they were
allowed to act on it. One delayed or duplicated data provider can cause a false
reward, public claim, or settlement.

Proofline separates reported events from settlement-safe evidence. Every source
observation is normalized and attributed to an independence group. VARA selects
a canonical event with a transparent confidence breakdown, but any active
material conflict overrides the number and holds settlement. A portable proof
packet lets another machine recompute the event hash, confidence, conflicts,
anchor match, and final gate.

The judge demo replays Wales vs IR Iran from the 2022 World Cup using attributed
historical facts. An explicitly synthetic provider fault changes an 86th-minute
red card to yellow. The UI visibly quarantines the event and refuses settlement;
after authoritative corroboration and a recorded retraction, the verifier
recovers. At full time the result is hashed, can be committed through an
append-only Injective EVM registry, is exposed to AI agents through MCP, and is
offered as a premium x402 resource in native testnet USDC. If an Agent lacks
USDC, the plan-only funding route prepares a Base Sepolia → Injective CCTP
safety check; this build does not claim burn, attestation, or mint execution.

Replay, sandbox payment, and demo receipts are machine-labelled and never
presented as live data or real value transfer.

## Why it can win

- **Memorable failure demo:** the product visibly refuses to automate when a
  source lies, then recovers without erasing history.
- **Injective is in the causal path:** registry anchoring, x402 USDC purchase,
  MCP verification, Agent policy, and CCTP funding form one product loop.
- **AI-native safety:** deterministic gates and spend limits constrain the
  Agent outside its narrative.
- **Reproducible judging:** no live fixture, wallet, or sports API is needed to
  understand and test the core differentiator.
- **Honest proof boundary:** an on-chain hash proves commitment, while source
  provenance and reproducible verification establish evidence quality.

## Technical highlights

- React + TypeScript match-verification control room
- Express replay/evidence API and SSE stream
- Unicode-stable canonical JSON and Keccak-256 event/packet hashes
- source-family quorum, active-conflict quarantine, and 82% settlement threshold
- Solidity append-only, revision-linked `MatchProofRegistry`
- official `@injectivelabs/x402` testnet middleware path plus labelled sandbox
- native Injective testnet USDC and CCTP V2 funding plan
- MCP server with hard per-proof/session spending caps
- project Agent Skill with truth, settlement, payment, and CCTP policies

## Demo chapters

1. **The problem — a score is not a proof** (0:00–0:20)
2. **One replay, three source states** (0:20–1:10)
3. **Conflict quarantine** (1:10–1:45)
4. **Recovery, final result, and Injective anchor** (1:45–2:25)
5. **Agent quote, x402 packet, and tamper check** (2:25–3:15)
6. **CCTP funding and architecture** (3:15–3:40)

Target video length: **3:30–4:00**.

## Submission evidence checklist

- [ ] Public GitHub repository
- [ ] Hosted web URL
- [ ] Hosted API health URL
- [ ] Demo video with the six chapters above
- [ ] Injective EVM testnet registry address
- [ ] Registry deployment transaction
- [ ] One real proof-anchor transaction
- [ ] One real x402 test-USDC settlement receipt
- [ ] CCTP burn and mint links, if completed
- [ ] README quick-start run from a clean checkout
- [ ] Secrets removed and wallets confirmed testnet-only

Do not mark an explorer, x402, or CCTP item complete with a sandbox receipt.
