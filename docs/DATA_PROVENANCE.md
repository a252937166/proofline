# Data provenance and licensing

Proofline does not sell or redistribute a sports provider's raw feed. The paid
resource is the verification work: normalized facts, source references, content
hashes, conflicts, Evidence Score inputs, and an Injective attestation. Evidence
Score is a reproducible policy score, not a probability that a fact is true;
only independent source groups contribute voting weight.

## Historical replay

The judge replay uses a normalized factual subset of **Wales 0–2 IR Iran** from
25 November 2022.

- OpenFootball `worldcup.more`, fixed commit
  `092f6b7a97b1b2cea4b2fe2b7706894a8866878b`, is CC0-1.0.
- FIFA's match review is referenced as an independent official report. Its page
  is linked; no article text, images, branding assets, or raw page payloads are
  copied into this repository.
- The replay always exposes `Historical Replay · Not Live` in both the UI and
  response headers.
- The injected yellow-card observation is synthetic fault injection. Its source
  label, URL, and note all state that it is not a historical claim.

## 2026 delayed result snapshot

`WC-2026-M97-FRA-MAR` is a captured, post-match snapshot of **France 2–0
Morocco**, Match 97 on 9 July 2026. It is always returned with
`dataMode=delayed`, `captureMethod=delayed-snapshot`, and **Not Live** wording.

- ESPN's public FIFA World Cup scoreboard JSON returned event `760510`,
  `STATUS_FULL_TIME`, and the 2–0 competitors. The repository retains the
  minimal result excerpt used by the adapter, not the complete response.
- FIFA's official fixtures/results page independently states “Match 97 –
  France 2-0 Morocco - Boston Stadium.” The repository retains only this
  minimal factual excerpt and its source URL.
- Each observation exposes provider, independent source group,
  canonical `sourceSnapshotHash`, `receivedAt`, `eventOccurredAt`, event-time
  basis, adapter version, policy-config hash, and verifier-version hash.
  `rawPayloadHash` remains only as a deprecated packet-v1 compatibility alias.

Every catalog snapshot also exposes `capturedAt`, `ageSeconds`,
`freshnessStatus` (`fresh`, `stale`, `archived`, or `superseded`), and
`supersededBy`. `isFresh` is the canonical boolean; `isCurrent` is retained as
a deprecated compatibility alias. Once a scheduled kickoff has passed without
an active provider, the snapshot becomes `archived` rather than masquerading
as the current match state.

## 2026 scheduled fixtures

`WC-2026-M99-NOR-ENG` and `WC-2026-M100-ARG-SUI` are official FIFA schedule
snapshots for 11 July 2026. They have `dataMode=scheduled`, `score=null`, and no
events. A scheduled kickoff is not silently promoted to live when no current
provider is active.

## Provider credentials and live mode

`API_FOOTBALL_KEY` / `API_FOOTBALL_TOKEN` and `FOOTBALL_DATA_TOKEN` are
credential-presence indicators only. The integration endpoint reports
`credential-present-unverified`; it does not mark either provider as an active
feed. A deployment may enable `dataMode=live` only after a successful,
authorized fetch with current provenance. No route in this release claims live
provider data.

Provider keys remain server-side. Full provider payloads are not committed. A
deployment must review its provider plan and display rights before turning a
public live feed on. Proofline stores the smallest normalized facts needed for
verification plus a source-snapshot hash, not a resale copy of upstream data.

## Trust statement

An Injective transaction proves that a particular event/evidence hash was
committed at a point in time. It does **not** make the sporting fact true. Truth
quality comes from transparent provenance, independent corroboration, conflict
handling, and the reproducible verifier.
