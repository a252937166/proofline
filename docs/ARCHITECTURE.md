# Proofline architecture

Proofline is an evidence and settlement layer for World Cup applications and AI
agents. It separates **what a source reported** from **what the system is willing
to settle**.

```text
2026 delayed snapshot / scheduled fixtures / 2022 replay
                      |
                      v
         canonical event observations
                      |
                      v
 Evidence Score -> independence -> conflict quarantine
                      |
            +---------+----------+
            |                    |
            v                    v
  free match/event API     x402 proof report
            |                    |
            +---------+----------+
                      v
         MatchProofRegistry (Injective EVM)
                      |
            +---------+----------+
            v                    v
      Proofline MCP       official Injective MCP
            |             address / USDC / tx reads
            +---------+----------+
                      v
          proofline-match-verifier Skill
```

## Settlement gate

An event cannot open the settlement gate unless all of these are true:

1. The match is final for result-level claims.
2. At least two independent source groups agree.
3. Evidence Score is at or above 82/100.
4. No unresolved material conflict remains.
5. The canonical event hash is anchored, or a caller explicitly requests the
   pre-anchor verification stage.

The gate is intentionally stricter than the display layer: Proofline can show a
reported goal while refusing to let an Agent settle a reward from it.

Evidence Score is a deterministic policy score, not a probability. Candidate
selection and score inputs count one strongest representative per independent
source group, so duplicating one upstream provider cannot manufacture quorum.

## Portable proof boundary

The stable `evidenceRoot` commits the normalized observations, provenance,
policy/version hashes, canonical event, score inputs, and conflicts. It excludes
the later anchor receipt, payment metadata, and issuer signature, preventing a
circular hash dependency.

The delivery `packetHash` covers the complete portable packet. Its EIP-712
signature is accepted only from a configured trusted issuer. A verifier then
performs a fresh match-wide latest read against the Injective registry. Packet
integrity, issuer trust, and current on-chain commitment are reported as three
separate layers.

## Honest runtime modes

- **Historical replay** ships with attributed 2022 observations and explicit
  synthetic fault injection. It is never labelled live and is the default judge
  path.
- **Delayed** exposes the captured 2026 France 2–0 Morocco result with ESPN and
  FIFA provenance and explicit post-match wording.
- **Scheduled** exposes two 2026 fixtures with `score=null` and no invented
  event stream.
- **Live data** requires a successful authorized provider fetch with current
  provenance. Credential presence alone never activates live mode.
- **Demo chain** creates deterministic local receipts labelled `demo`.
- **Testnet chain** signs and publishes to Injective EVM testnet only when a
  registry address and private key are provided.
- **Demo x402** exposes the real 402 negotiation shape but labels its receipt as
  sandbox. **Testnet x402** mounts the official `@injectivelabs/x402` middleware.

These boundaries keep the public demo reproducible without claiming that a fake
payment or local receipt is on-chain.

The production testnet path has also been executed: registry deployment,
anchorer grant, final-result anchor, and a `0.01` test-USDC x402 settlement are
linked from [the judge guide](JUDGING.md). CCTP remains future work and is not in
the executed architecture path.
