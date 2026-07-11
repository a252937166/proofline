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

`anchorDecision` includes an optimistic-concurrency check on the previous hash.
`anchorProof` is the API convenience method: it appends a `Verified` revision and
links the current latest hash automatically. Verified/final revisions require at
least 8,200 bps confidence and reject observations more than five minutes in the
future. `verifyProof` follows the latest revision for the requested event hash,
so anchoring another event in the same match does not invalidate earlier proofs.
Ownership transfer is two-step and rotates the default admin roles on accept.
