# Proofline architecture

Proofline is an evidence and settlement layer for World Cup applications and AI
agents. It separates **what a source reported** from **what the system is willing
to settle**.

```text
API-Football / archived replay / football-data.org
                      |
                      v
         canonical event observations
                      |
                      v
 evidence graph -> confidence -> conflict quarantine
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
            |            wallet / CCTP / tx checks
            +---------+----------+
                      v
          proofline-match-verifier Skill
```

## Settlement gate

An event cannot open the settlement gate unless all of these are true:

1. The match is final for result-level claims.
2. At least two independent source groups agree.
3. Confidence is at or above 82%.
4. No unresolved material conflict remains.
5. The canonical event hash is anchored, or a caller explicitly requests the
   pre-anchor verification stage.

The gate is intentionally stricter than the display layer: Proofline can show a
reported goal while refusing to let an Agent settle a reward from it.

## Honest runtime modes

- **Replay** ships with attributed historical observations. It is never labelled
  live and is the default judge path.
- **Live data** activates only when the optional server-side provider tokens are
  configured. The packaged judge path remains the attributed historical replay.
- **Demo chain** creates deterministic local receipts labelled `demo`.
- **Testnet chain** signs and publishes to Injective EVM testnet only when a
  registry address and private key are provided.
- **Demo x402** exposes the real 402 negotiation shape but labels its receipt as
  sandbox. **Live x402** mounts the official `@injectivelabs/x402` middleware.

These boundaries keep the public demo reproducible without claiming that a fake
payment or local receipt is on-chain.
