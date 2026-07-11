# Proofline trust model

## What the system proves

Proofline separates three claims that sports products often collapse:

1. **Observation:** a named source reported a fact at a recorded time.
2. **Verification:** VARA deterministically selected a canonical event from the
   active observations and exposed every confidence input and conflict.
3. **Commitment:** a hash and confidence value were anchored to a particular
   Injective EVM transaction.

The commitment proves ordering and immutability. It does not turn a bad source
into truth. Users can reproduce the verification because the packet contains
source identities, normalized observations, algorithm version, conflicts, and
the canonical JSON hash.

## Safety invariants

- One upstream provenance family cannot impersonate multiple independent votes.
- A single source can never produce a `verified` decision.
- Any active incompatible claim moves the event to `contested`.
- Result settlement is held until the match is final, confidence is above the
  public threshold, conflicts are cleared, and the matching anchor is confirmed.
- Historical replay and injected chaos are machine-readable modes, not visual
  disclaimers alone.
- A paid retry returns the same packet identity; payment metadata is excluded
  from the sports-evidence core hash.
- Private keys, API tokens, and raw licensed payloads never enter the browser,
  repository, evidence packet, or MCP tool output.
- A credentialed Injective RPC remains server-only. `/api/integrations` exposes
  the fixed public testnet RPC used by wallets and MCP reads; remote RPC and
  x402 facilitator endpoints must use HTTPS.

## Operator trust

Proofline operators choose source allowlists, provenance families, and weights.
Those are governance inputs, not mathematical truth. They must be versioned and
published with the packet. A future decentralized source registry can reduce
this trust, but hiding the operator's judgment behind one opaque confidence
number would be worse than acknowledging it.

## Failure behavior

| Failure | Product behavior |
| --- | --- |
| Primary sports API unavailable | Keep replay available; mark live feed unavailable |
| Only one source responds | Show the event as observed; hold settlement |
| Sources disagree | Quarantine the decision and list the exact fields |
| Injective RPC unavailable | Produce a pre-anchor packet; never invent a transaction |
| x402 settlement unavailable | Return the real 402 quote or an unavailable state |
| CCTP requested | Stop at the labelled pre-burn plan; this build never claims a transfer |
| Packet field changes | Independent verifier returns a failed hash/check report |

## Spending policy

The Agent Skill allows only Injective EVM testnet native USDC, a configured
merchant, at most `0.02 USDC` per proof and `0.10 USDC` per session. If CCTP
execution is added later, the burn must require explicit wallet approval. These
controls live outside the LLM's narration and are enforced before signing.
