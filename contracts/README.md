# MatchProofRegistry

`MatchProofRegistry` is Proofline's append-only Injective EVM commitment layer.
Each match has one-indexed revisions. Every revision contains the previous
decision hash, so corrections and disputes remain auditable instead of replacing
history.

The contract deliberately stores compact commitments rather than licensed match
payloads. A matching transaction proves that Proofline committed a hash at a
particular time; source provenance and confidence are still required to judge
the sporting fact.

## Build and deploy

From the `proofline` directory:

```bash
npm run deploy:contract
```

The deploy script refuses any RPC whose chain ID is not Injective EVM testnet
`1439` and compiles automatically. The deployer initially receives owner,
anchorer, and pauser roles. If `.env` contains a distinct
`ANCHOR_PRIVATE_KEY`, deployment grants that account the anchorer role and
records the grant transaction. Only after both receipts succeed, the script
atomically fills `PROOF_REGISTRY_ADDRESS` in the gitignored `.env` and restores
its permissions to `0600`; it intentionally does not change `CHAIN_MODE`.

Use `npm run testnet:preflight` after deployment and follow
[`docs/TESTNET_RUNBOOK.md`](../docs/TESTNET_RUNBOOK.md) for the guarded anchor
and official x402 Agent flow.

Every write must carry `evidenceRoot`: the immutable evidence-envelope hash that
excludes the later anchor receipt, transaction hash, and issuer signature. Empty
commitments are rejected, and the value is included in the immutable decision
hash and anchor event. The delivery packet is assembled after anchoring and its
separate `packetHash` is issuer-signed and verified off-chain; it is deliberately
not stored here, avoiding a circular packet-hash/transaction-hash dependency.

`appendRevision` is the settlement-grade write path. It requires the caller to
provide the current `previousDecisionHash`, so two concurrent writers cannot both
win. `anchorProof` is a convenience method for a `Verified` revision and links the
current latest hash automatically. Verified/final revisions require at least
8,200 bps evidence score and observations more than five minutes in the future
are rejected. A `Final` decision cannot roll back into Provisional, Verified,
Disputed, or Rejected.

There are deliberately two verification views:

- `verifyHistoricalProof(matchIdHash, revision, eventHash)` verifies one explicit,
  immutable revision for audit purposes. It makes no claim that the result is
  still current.
- `verifyLatestSettlementProof(matchIdHash, eventHash)` evaluates only the
  match-wide latest revision. A correction, Disputed, or Rejected revision thus
  invalidates every older result for settlement.

`verifyProof` remains as a deprecated compatibility alias for
`verifyLatestSettlementProof`; it no longer has the unsafe v1 per-event semantics.
Ownership transfer is two-step and rotates the default admin roles on accept.

## Behavior tests

`npm run test:contract` deploys the compiled bytecode to a fresh in-process
Hardhat EVM and tests superseded proofs, Disputed/Rejected invalidation, Final
rollback protection, optimistic concurrency, pause/role rotation, historical vs
latest queries, and commitment/confidence/time guards. The lightweight compile
and ABI checks run alongside those deployment tests.
