# Proofline demo video script

Target: 1920×1080, 2:50–3:20, English narration, burned-in English
subtitles. Every scene retains a top-left chapter chip and top-right label:
`PROOFLINE · VARA · INJECTIVE`.

## n1 · The referee for machine decisions

**Picture:** branded title card, then the hosted control room at the pre-match
state. Move the synthetic cursor to “Run replay”.

**Narration:**

> A score is easy to read, but dangerous to settle. Proofline is a
> conflict-aware evidence layer for World Cup products and AI agents. Its VARA
> engine does not ask an AI model to guess what is true. It records attributed
> observations, groups related providers, recomputes an Evidence Score, and allows
> automation only when deterministic evidence rules pass. Today we will replay
> Wales versus Iran and watch the system refuse a bad source in real time.

## n2 · One bad feed must stop automation

**Picture:** run the replay to frame 4. Hold on the red conflict rail, 56.7/100
Evidence Score, exact `card` field mismatch, and Agent trace `HOLD` state.

**Narration:**

> OpenFootball reports Wayne Hennessey’s eighty-sixth-minute red card. A clearly
> labelled synthetic lag feed then reports yellow. Even though one source still
> has a strong reputation, an active material conflict overrides the score.
> The Evidence Score falls to fifty-six point seven out of one hundred. This is
> a deterministic policy score, not a probability. The settlement rail moves
> backward, and the Agent returns HOLD. Proofline preserves both claims and the
> exact mismatched field. It never hides disagreement behind one opaque number.

## n3 · Why Injective is in the causal path

**Picture:** architecture card showing sources → canonical event →
`MatchProofRegistry` → x402 report → MCP/Agent. Add a bottom note: “Without the
registry: a server can rewrite history. Without conflict policy: an Agent can
settle a lie.”

**Narration:**

> This is why Injective is not a decorative blockchain button. Once independent
> evidence agrees, Proofline canonicalizes the event with Unicode-stable JSON
> and Keccak two-fifty-six. The append-only MatchProofRegistry commits the match,
> event hash, evidence root, score, observation time, and revision on Injective
> EVM testnet. The contract enforces anchorer roles, minimum verified score,
> future-time guards, pause controls, match-wide revisions, and two-step
> ownership transfer. The chain proves commitment and ordering; provenance and
> reproducible verification establish evidence quality.

## n4 · Recovery, final result, and public proof

**Picture:** resume replay. Show official corroboration, retraction, late goals,
full time, 96.49/100, then the fully verified registry and the real final-result
anchor transaction in Blockscout.

**Narration:**

> The official source corroborates the red card and the faulty observation is
> retracted without erasing history. The replay continues through both late
> goals and full time. Two independent source families now agree, the Evidence
> Score reaches ninety-six point four nine, and the final evidence root is anchored.
> This Blockscout page is the real Injective testnet transaction, not a generated
> screenshot or simulated hash. A fresh verifier checks the registry identity,
> match-wide latest revision, event hash, evidence root, score, and state before
> accepting the commitment.

## n5 · x402 evidence for humans and agents

**Picture:** open the proof drawer, show the initial HTTP 402 terms, then complete
the paid test-USDC request. Cut to an MCP/Agent trace card listing tools and
spend limits.

**Narration:**

> Basic match data stays free. The complete evidence packet is a premium x402
> resource priced at zero point zero one test USDC on Injective. Before signing,
> the client checks the network, canonical USDC contract, merchant, exact amount,
> origin, and a hard spending ceiling. The quote freezes the packet identity, so
> advancing the replay cannot swap evidence after approval. MCP tools expose the
> same match, conflict, packet, and registry checks to Claude, Cursor, or another
> agent. The Agent Skill forbids final conclusions before full time, refuses
> unresolved conflicts, and never treats a demo receipt as an on-chain read.

## n6 · Re-run the proof

**Picture:** closing card with hosted demo, GitHub, contract, anchor transaction,
and video-safe QR codes. Keep all content above y=905.

**Narration:**

> Proofline turns a reported score into a decision that another machine can audit.
> The hosted replay works without a live match, while the public repository,
> contract, transaction, and packet make every important claim inspectable. The
> CCTP route is explicitly future work; we do not claim
> a burn or mint that did not happen. Proofline: do not trust the score. Re-run
> the proof.

## Public evidence to show when recording

- Hosted demo: `https://proofline.axiqo.xyz`
- GitHub: `https://github.com/a252937166/proofline`
- Contract: `https://testnet.blockscout.injective.network/address/0x959538bE97f6Fc3A09C823514acC176681155A7e`
- Anchor transaction: `https://testnet.blockscout.injective.network/tx/0x455e933b149e8f291d41f5e5fc58fdca55fdb56c7cfd3a9e1b2f55d32f6c6038`
- x402 settlement: `https://testnet.blockscout.injective.network/tx/0x79700fa00ff0d0c7a5821608f6221c7805b2feb3fe72133d526b491c41fe624a`
