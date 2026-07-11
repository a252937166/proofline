# Proofline product specification

## Thesis

Sports automation has a dangerous missing primitive: applications can fetch a
score, but they cannot explain why a machine was allowed to act on it. The
problem becomes acute when AI agents purchase data, settle rewards, publish
claims, or move funds without a human checking every provider.

Proofline is the missing **evidence-to-action boundary**. It does not pretend
that a chain transaction makes a score true. It makes the verification decision
portable, replayable, payable, and tamper-evident.

## Primary users

### Agent developer

Wants one tool call that answers “may I safely act on this result?” with a
machine-readable reason, a capped price, and evidence that can be independently
recomputed.

### Sports product operator

Wants to combine upstream providers without silently accepting duplicated
provenance, transient corrections, or a stale final score.

### Auditor or judge

Wants a short path from a visible event to its sources, exact conflicting
fields, algorithm inputs, packet hash, and Injective transaction.

## The winning interaction

The replay is deliberately a product test rather than a prerecorded animation.
Every click advances the same engine used by the API and MCP server.

| Stage | Evidence state | Product behavior |
| --- | --- | --- |
| One red-card report | `observed` | Display with “awaiting corroboration”; hold action |
| Synthetic feed says yellow | `contested` | Pull Evidence Score rail back; show `card` conflict |
| Official report says red | `contested` | Preserve all active claims; do not majority-hide conflict |
| Bad claim retracted | `verified` | Recover deterministically; keep correction history |
| Match reaches 0–2 full time | `verified` | Build final-result packet |
| Matching hash anchored | settlement `open` | Expose proof purchase and Agent conclusion |

The system never quietly deletes the bad observation. The packet includes the
retraction and the on-chain registry is append-only, so revision history remains
auditable.

## Verification model

Each observation contains a normalized event payload and an attributed source:

```json
{
  "eventId": "hennessey-red-86",
  "source": {
    "id": "fifa-match-review",
    "tier": "official",
    "reliabilityBps": 9800,
    "independenceGroup": "fifa"
  },
  "payload": {
    "matchId": "WC-2022-WAL-IRN",
    "eventType": "card",
    "minute": 86,
    "team": "Wales",
    "player": "Wayne Hennessey",
    "card": "red"
  }
}
```

VARA canonicalizes Unicode, whitespace, casing, optional fields, timestamps,
and score structure before Keccak-256 hashing. Candidate events are ranked by
the strongest source in each independent provenance group—not by raw provider
count. Repeating a provider does not increase ranking weight, quorum, agreement,
or reliability. Evidence Score exposes five basis-point components:

- source reliability;
- independent-source quorum;
- observation agreement;
- evidence freshness;
- active-conflict penalty.

Evidence Score is a deterministic policy score, not a probability that an
event is true. The state machine is stricter than the number: fewer than two independent
groups remains `observed`, and any material active conflict is `contested` even
if one candidate has more votes.

## Portable proof packet

The paid resource is not a licensed raw feed. It is the verification work:

- attributed normalized observations and retractions;
- selected canonical JSON and event hash;
- Evidence Score inputs, threshold, and reasons;
- current settlement decision;
- Injective receipt when configured;
- algorithm/schema versions;
- a stable packet hash.

An independent verifier rebuilds the canonical event, Evidence Score, conflict
set, settlement gate, evidence root, and packet hash. It then recovers the
EIP-712 signer and checks it against a trusted-issuer allowlist, followed by a
fresh latest-revision registry read. A one-field mutation fails integrity, an
unknown self-signer fails issuer trust, and a superseded revision fails the
on-chain layer.

## Injective-native product loop

1. The fully verified `MatchProofRegistry` appends compact decision commitments
   and links every revision to its predecessor. Settlement reads are match-wide
   latest-only so a later dispute invalidates stale proof.
2. An x402 resource prices the premium packet in native Injective testnet USDC.
3. The Agent Skill checks evidence readiness and spend policy before signing.
4. CCTP is future work. The design records the Base Sepolia → Injective route
   and approval boundary, but this release claims no burn, attestation, mint,
   or balance-recheck transaction.
5. The Proofline MCP returns the packet and verifies the separate registry
   anchor; the official Injective MCP can complement it with wallet operations.

## Delivered product boundary

### Complete and reproducible

- attributed historical replay with explicit synthetic fault;
- canonical event and packet hashing;
- source independence, conflict quarantine, and settlement gate;
- web control room, free API, 402 sandbox journey, and packet verifier;
- fully verified Injective EVM registry and real final-result anchor;
- real `0.01` native test-USDC x402 settlement;
- EIP-712 trusted-issuer proof layer and latest on-chain proof layer;
- domain MCP server and Agent Skill;
- official Injective MCP execution transcript;
- 2026 delayed and scheduled data alongside the 2022 replay.

### Explicitly outside the claim

- active paid-provider live sports feed;
- CCTP approve, burn, attestation, mint, and destination balance recheck;
- any mainnet asset or production-money settlement.

These surfaces are not simulated or described as successful transactions.

## Success metrics

- A judge understands the conflict-to-quarantine thesis within 60 seconds.
- A fresh checkout completes the replay without live sports or wallet uptime.
- The same event packet exposes separate integrity, trusted-issuer, and latest
  on-chain validation results through API and MCP.
- A one-field tamper produces a visible failed check.
- No low-score, contested, non-final, or unanchored result can return an
  allowed settlement decision.
- Every paid or chain-related response declares whether value was transferred
  and whether the receipt is demo or testnet.
