# Proofline trust model

## Claims the system keeps separate

Proofline deliberately separates four claims that sports products often
collapse:

1. **Observation:** a named source reported a normalized fact at a recorded
   time.
2. **Verification:** VARA selected a canonical event under a published policy
   and exposed every input, conflict, and source-independence group.
3. **Attestation:** a configured trusted issuer signed the delivery packet with
   EIP-712.
4. **Commitment:** an event hash, evidence root, Evidence Score, time, and state
   were appended to a particular Injective EVM registry revision.

No single claim substitutes for another. A valid chain transaction does not
turn a bad source into truth; a valid signature from an unknown signer is not a
trusted Proofline packet; and a historically valid anchor may be stale after a
later correction.

## Evidence Score is not probability

The primary 2026 score displayed as `98.25/100` is a deterministic policy
score, **not** a 98.25% probability that a result is true. It combines configured source
reliability, independent quorum, agreement, freshness, and conflict penalties.
Those weights are inspectable governance inputs.

Only one strongest observation from each `independenceGroup` can contribute to
candidate weight, quorum, agreement, or reliability. Replaying the same
provider payload under 100 adapter names adds no voting weight. Any active
incompatible claim makes the state `contested` regardless of the numeric score.

## Three verification layers

A premium packet is accepted only when all three layers pass:

### 1. Deterministic integrity

The verifier rebuilds normalized event JSON, `eventHash`, observation
provenance leaves, `evidenceRoot`, Evidence Score breakdown, conflicts,
settlement gate, and `packetHash`. A one-field mutation fails this layer.

### 2. Trusted issuer signature

The verifier recovers the EIP-712 signer over `packetHash`, `evidenceRoot`,
`matchIdHash`, and `eventHash`, then compares it with the configured expected or
trusted issuer set. Cryptographic validity alone is insufficient: an attacker
who signs a self-created packet remains untrusted.

Packets also carry an address-derived `issuerKeyId`, `issuedAt`, and
`proofline.issuer-policy.v1`. The verifier can trust retired keys only inside
an explicit `validFrom`/`revokedAt` history, so rotation does not break old
reports or silently trust future signatures from a retired key.
The current issuer is also bounded by `PROOFLINE_ISSUER_VALID_FROM`; recovering
its address is insufficient for packets allegedly issued before that instant.

### 3. Latest on-chain commitment

The verifier performs a fresh read against the fully verified registry
[`0x380D75d068dec45D8145ef89B7A40a6201Ac1ef1`](https://testnet.blockscout.injective.network/address/0x380D75d068dec45D8145ef89B7A40a6201Ac1ef1?tab=contract).
It checks the registry identity and match-wide latest revision, then matches the
event hash, evidence root, Evidence Score, and settlement-valid state. A later
`Disputed` or `Rejected` revision invalidates an older proof for settlement even
though the historical revision remains auditable.

The executed packet passed all three layers; its sanitized evidence is
[committed in the repository](../data/evidence/featured-proof.json).

## Safety invariants

- A single independence group can never produce a `verified` decision.
- Any active material conflict moves the event to `contested` and holds
  settlement.
- Result settlement requires a finished match, verified state, Evidence Score
  at or above `82/100`, no active conflict, and a matching latest anchor.
- `delayed`, `scheduled`, and `historical-replay` are machine-readable modes,
  not visual disclaimers alone. Scheduled fixtures have `score=null`; the 2022
  replay and 2026 delayed snapshot are never described as live.
- Every x402 quote freezes a packet identity. Replay progress cannot swap the
  evidence after review and before payment.
- Live x402 refuses demo commitments: both the active anchor runtime and the
  frozen receipt must be `injective-testnet`. Demo receipts are payable only
  through the explicitly labelled sandbox path.
- The full frozen packet and entitlement are atomically persisted. A process
  restart cannot regenerate a different signed packet after settlement.
- An independent ProofPurchase signature binds the packet hash to the x402
  payer, payee, price, deadline, USDC nonce, and session. A same-price USDC
  authorization cannot be relabelled as another report.
- Payment metadata is excluded from the sports `evidenceRoot`, avoiding a
  circular dependency between evidence, anchor transaction, and receipt.
- A paid retry must return the frozen signed packet. If settlement status is
  uncertain, neither the API nor Agent client retries payment automatically.
- Recovery only replays the exact original payment header from browser memory;
  the server stores its hash, never the replayable authorization itself.
- Registry v3 removes the auto-latest convenience writer and makes `Final`
  fully immutable.
- Private keys, provider tokens, signatures used for payment, and raw licensed
  payloads never enter browser state, committed evidence, or MCP logs.
- Demo receipts are machine-labelled and never pass the public-chain layer.

## Data-mode trust

| Mode | What may be claimed |
| --- | --- |
| `delayed` | A captured post-match 2026 result with source URLs, hashes, and capture metadata; not live |
| `scheduled` | Official 2026 fixture metadata with no score or invented events |
| `historical-replay` | Attributed 2022 facts plus explicitly synthetic fault injection; deterministic and not live |
| `live` | Only after an authorized provider fetch succeeds and current provenance is attached; no packaged route currently claims this |

## Operator and issuer trust

Proofline operators choose source allowlists, independence groups, reliability
weights, threshold, and trusted issuer addresses. These are governance inputs,
not mathematical truth. They are versioned into the evidence envelope through
policy and verifier hashes. A future decentralized source registry can reduce
operator trust, but hiding these choices behind an opaque “confidence” number
would make the system less auditable.

The issuer attests that the packet came from a trusted Proofline deployment; it
does not replace source corroboration. Production fails closed if no explicit
issuer key and trusted address are configured.

## Failure behavior

| Failure | Product behavior |
| --- | --- |
| Sports provider unavailable | Keep replay/delayed data available with its true mode; do not claim live |
| Only one source group responds | Show `observed`; hold settlement |
| Sources disagree | Show `contested`, exact fields, and source groups; hold settlement |
| Registry/RPC unavailable | Preserve a pre-anchor packet; do not invent a transaction or pass the chain layer |
| Later chain correction exists | Historical proof remains inspectable; latest-only settlement verification fails the stale packet |
| x402 receipt is delayed | Return `payment-uncertain`; require Explorer/nonce recovery before any retry |
| Paid response is malformed | Preserve the successful payment receipt; do not pay again automatically |
| Packet field changes | Deterministic integrity verification fails |
| Signature is self-valid but signer is unknown | Trusted-issuer verification fails |
| CCTP requested | Report future-work status; do not claim a bridge transaction |

## Spending policy

The Agent Skill permits only Injective EVM testnet native USDC, the configured
merchant, at most `0.02 USDC` per proof and `0.10 USDC` per session. Origin,
redirect, network, asset, recipient, quote identity, packet hash, and price are
checked before signing. These controls are enforced in code outside the LLM's
narration.

CCTP is future work. No approve, burn, attestation, mint, or destination
balance-recheck transaction is claimed in this release.
