# Proofline visual system

## Subject, audience, and one job

Proofline is a match-verification control room for judges, sports applications,
and AI agents. The page has one job: make the path from a raw match observation
to a settlement-safe, on-chain proof understandable in under one minute.

## Design tokens

| Role | Token | Use |
| --- | --- | --- |
| Floodlight | `#F4F7F2` | Main field and paper-like match sheet |
| Night match | `#071A2B` | Header, proof report, high-contrast controls |
| Referee amber | `#F6B73C` | Active replay state and human attention |
| Broadcast cyan | `#35C4D8` | Verified sources and machine-readable links |
| Pitch teal | `#176B65` | Settlement-safe state |
| Dispute red | `#DC4C4C` | Conflicts and quarantine only |

- Display: **Barlow Condensed**, used for score, match state, and the product wordmark.
- Body: **DM Sans**, used for actions and explanation.
- Utility: **IBM Plex Mono**, used for hashes, timestamps, RPC, and tool traces.

## Layout concept

The desktop view behaves like one continuous match sheet instead of a grid of
unrelated cards. Rails and pitch markings encode the actual verification flow.

```text
+---------------------------------------------------------------+
| PROOFLINE   match clock / mode                 integrations    |
+----------------+-----------------------------+-----------------+
| match + replay | event under review          | evidence rail   |
| event timeline | ===== PROOFLINE ======>     | source A        |
|                | settlement gate             | source B        |
|                |                             | chain receipt   |
+----------------+-----------------------------+-----------------+
| agent trace: query -> compare -> pay -> anchor -> conclude     |
+---------------------------------------------------------------+
```

On small screens the same causal order becomes the vertical reading order:
match, event, evidence, settlement, agent trace.

## Signature element

The memorable element is the **Proofline** itself: a broadcast-style horizontal
line whose fill reflects confidence. Source observations arrive from opposite
sides. A conflict visibly pulls the line backward and quarantines settlement;
corroboration pushes it across the threshold and reveals the anchor receipt.

## Critique and revision

The first obvious direction was a black Web3 dashboard with neon green cards.
It was rejected because it could describe any chain analytics product and made
the sports evidence story secondary. The revised direction borrows from match
control rooms, referee signals, goal-line technology, and broadcast lower-thirds.
Dark color is reserved for the proof surface; most of the interface stays under
cool stadium light. Motion is concentrated in one replay/proof sequence, and
`prefers-reduced-motion` removes it without hiding state.
