# Data provenance and licensing

Proofline does not sell or redistribute a sports provider's raw feed. The paid
resource is the verification work: normalized facts, source references, content
hashes, conflicts, confidence inputs, and an Injective attestation.

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

## Live adapters

The API exposes optional server-side adapters for:

- API-Football: World Cup 2026 uses `league=1&season=2026`.
- football-data.org: World Cup competition code `WC`.

Provider keys remain server-side. Raw provider payloads are not committed. A
deployment must review its provider plan and display rights before turning a
public live feed on. Proofline stores the smallest normalized facts needed for
verification plus a raw-content hash, not a resale copy of the upstream data.

## Trust statement

An Injective transaction proves that a particular event/evidence hash was
committed at a point in time. It does **not** make the sporting fact true. Truth
quality comes from transparent provenance, independent corroboration, conflict
handling, and the reproducible verifier.
