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
| Synthetic feed says yellow | `contested` | Pull confidence rail back; show `card` conflict |
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
count. Confidence exposes five basis-point components:

- source reliability;
- independent-source quorum;
- observation agreement;
- evidence freshness;
- active-conflict penalty.

The state machine is stricter than the number: fewer than two independent
groups remains `observed`, and any material active conflict is `contested` even
if one candidate has more votes.

## Portable proof packet

The paid resource is not a licensed raw feed. It is the verification work:

- attributed normalized observations and retractions;
- selected canonical JSON and event hash;
- confidence inputs, threshold, and reasons;
- current settlement decision;
- Injective receipt when configured;
- algorithm/schema versions;
- a stable packet hash.

An independent verifier rebuilds the canonical event, confidence, conflict set,
settlement gate, and packet hash. A one-field mutation fails verification.

## Injective-native product loop

1. `MatchProofRegistry` appends compact decision commitments and links every
   revision to its predecessor.
2. An x402 resource prices the premium packet in native Injective testnet USDC.
3. The Agent Skill checks evidence readiness and spend policy before signing.
4. If the Agent has insufficient USDC, the current plan-only CCTP tool validates
   a Base Sepolia → Injective route and stops at the pre-burn approval boundary.
   Executable burn, attestation, mint, and balance recheck remain deployment work.
5. The Proofline MCP returns the packet and verifies the separate registry
   anchor; the official Injective MCP can complement it with wallet operations.

## MVP and stretch boundary

### Complete, reproducible MVP

- attributed historical replay with explicit synthetic fault;
- canonical event and packet hashing;
- source independence, conflict quarantine, and settlement gate;
- web control room, free API, 402 sandbox journey, and packet verifier;
- deployable Injective EVM registry;
- domain MCP server and Agent Skill;
- testnet-ready x402, anchoring, and CCTP configuration boundaries.

### Deployment work requiring external credentials or funds

- attach paid live-sports provider keys;
- deploy and publish the registry address;
- fund the dedicated testnet anchorer/facilitator/Agent wallets;
- record a real x402 settlement and CCTP bridge journey;
- publish the web/API and demo video.

These are intentionally reported as configuration-dependent—not simulated as
successful transactions in the local judge path.

## Success metrics

- A judge understands the conflict-to-quarantine thesis within 60 seconds.
- A fresh checkout completes the replay without live sports or wallet uptime.
- The same event packet validates through API and MCP.
- A one-field tamper produces a visible failed check.
- No low-confidence, contested, non-final, or unanchored result can return an
  allowed settlement decision.
- Every paid or chain-related response declares whether value was transferred
  and whether the receipt is demo or testnet.
