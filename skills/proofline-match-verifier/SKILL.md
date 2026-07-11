---
name: proofline-match-verifier
description: Verify football match events and result readiness with Proofline evidence, signed x402 proof packets, and the latest Injective testnet settlement commitment. Use when an agent must check a score, event, final result, paid proof, or settlement gate without confusing scheduled, delayed, replay, and live data or historical and latest chain proofs.
---

# Proofline Match Verifier

Use the Proofline MCP tools to produce an evidence-backed conclusion. Preserve
the API's exact match/event identifiers, disclosure, source links, evidence score,
conflicts, hashes, and transaction links.

## Non-negotiable truth labels

1. Read `mode` and `disclosure` before describing any match data.
2. Say **Historical Replay · Not Live** for replay data. A replay can exercise
   the real verifier and contract path, but it is never a current match feed.
3. Say **Scheduled · No Events Yet** for a future fixture, and **Delayed
   Snapshot · Not Live** for a captured provider result. Do not infer a live
   feed from the tournament year.
4. Say **Live** only when the API explicitly reports live mode and current
   provider provenance. Do not infer live status from a clock animation, recent
   timestamp, or a match status.
5. Identify synthetic fault-injection observations as synthetic. They test
   conflict handling and are not historical claims.
6. An Injective transaction proves that a hash was committed at a time. It does
   not make the underlying score or event true. Truth quality comes from source
   provenance, independent agreement, and conflict handling.
7. A demo receipt or sandbox x402 signature is not a token transfer or public
   chain transaction. Carry its demo disclosure into the answer.

## Verification workflow

Use the Proofline MCP for match evidence and policy decisions. Use the official
`InjectiveLabs/mcp-server` for Injective address, native USDC, balance, CCTP
status, or raw EVM operations. Record the actual tool name, redacted input
summary, success/failure, duration, and result hash for every call; a UI-derived
illustration is never an execution log.

Follow these steps in order:

1. Call `list_matches`, then `get_match` for the chosen match.
2. Call `get_match_events`; retain its machine-readable `dataMode`, timestamps,
   provider payload hashes, adapter version, and disclosure.
3. Select the exact event ID. Call `verify_event` and inspect all active
   observations, independence groups, conflicts, evidence-score breakdown, and
   canonical event hash.
4. Call `assess_settlement_readiness` before any result-level conclusion.
5. If free evidence is sufficient, stop. Do not buy a report just because a
   paid tool exists.
6. If a complete signed proof packet is necessary and paid access is authorized,
   call `quote_match_proof`. Check the payment policy below before calling
   `purchase_match_proof`.
7. Pass the purchased packet to `verify_proof_packet`. Require three separate
   results: packet integrity, EIP-712 issuer signature, and on-chain commitment.
   A self-consistent packet without a valid configured issuer is not trusted.
8. If the packet claims a real testnet anchor, call `verify_onchain_anchor` with
   its match ID, event hash, and evidence root. Compare the fresh chain result,
   chain ID, registry address, **match-wide latest revision**, decision state,
   and packet receipt. Settlement must use `verifyLatestSettlementProof`; a
   successful `verifyHistoricalProof` only proves that an older revision once
   existed. Never treat a transaction URL or packet recomputation alone as a
   live chain read.
9. Return one of: `VERIFIED FOR DISPLAY`, `READY FOR SETTLEMENT`, `HELD`, or
   `INCONCLUSIVE`, followed by concise reasons and evidence links.

## Settlement gate

Return `READY FOR SETTLEMENT` only when every condition is satisfied:

- match status is `finished`;
- verification state is `verified`;
- evidence score meets the response threshold (normally at least 82.0 / 100);
- at least two independent source groups agree;
- there is no unresolved material conflict;
- the latest confirmed Injective match revision commits the same canonical
  event hash and evidence root;
- the latest chain decision is usable (`verified` or `final`), not
  `provisional`, `disputed`, or `rejected`.

If any condition fails, return `HELD` and name each failed gate. A reported goal
may be `VERIFIED FOR DISPLAY` before the match is final, but it cannot support a
final-result settlement. Never generate a final-result conclusion while the
match is scheduled or live.

If sources conflict, do not choose the most convenient source, average mutually
exclusive scores, or let an anchor override the conflict. Return `HELD` or
`INCONCLUSIVE` until a correction/retraction is evidenced and the verifier no
longer reports an active material conflict.

## x402 payment policy

Always quote before purchase. The project MCP enforces these hard ceilings, and
this Skill must enforce them independently:

- maximum per proof: **0.02 USDC**;
- maximum cumulative spend in one agent/MCP session: **0.10 USDC**;
- network: **Injective EVM testnet only**, CAIP-2 `eip155:1439`;
- asset: the configured Injective testnet USDC contract only;
- payee: the operator-configured Proofline payee must exactly match the quote.

Keep a session spend ledger. Do not split one purchase into smaller calls to
evade a limit. Reject an unconfigured or mismatched payee, a different asset,
an unknown network alias, a mainnet quote, a zero/negative price, or a price
above either remaining limit. Never send a payment signature to a URL other than
the configured Proofline API origin and never repeat it in the final answer or
logs.

Set `approved=true` only after the quote has been reviewed and the user has
authorized paid proof acquisition in the current task. The explicit
`demoSandbox.paymentSignature` may exercise the negotiation flow, but report
`sandbox: true` and do not count it as evidence of a real USDC transfer.

If the payment authorization was created but the API or Facilitator response is
ambiguous, return `PAYMENT_UNCERTAIN`. Do not sign again. Query the transaction,
Facilitator receipt, authorization nonce, and recoverable delivery state before
retrying or claiming the packet was purchased.

## CCTP future capability

This build does not claim a completed CCTP bridge. `prepare_cctp_funding` is a
future-capability plan and must not appear in the core verification verdict.
Use it only when a paid proof is actually needed and the Injective testnet
wallet lacks test USDC. It prepares a plan; it does not bridge.

Allow only configured test USDC from Ethereum Sepolia or Base Sepolia to
Injective EVM testnet. Verify source network, source USDC contract, amount,
destination address, destination network, and expected fees. Present the exact
burn transaction to the human and obtain explicit approval **immediately before
the irreversible CCTP burn**. Earlier general approval is not enough. After the
burn, wait for Circle attestation and destination mint confirmation before
claiming funds arrived or attempting x402 payment. Never reuse a CCTP message or
attestation.

## Response format

Keep the result auditable and compact:

```text
Verdict: HELD
Mode: Historical Replay · Not Live
Match/event: <match ID> / <event ID>
Evidence score: <score / 100> / threshold <score / 100>
Sources: <independent agreeing sources; conflicts if any>
Packet: integrity <valid/invalid>, issuer <valid/invalid>, evidence root <hash>
Latest anchor: <confirmed/demo/missing>, <match revision>, <transaction link if real>
Settlement gates: <passed and failed conditions>
Payment: <none, sandbox, or amount/network/asset/payee with signature redacted>
Reason: <plain-language conclusion>
```

Do not hide uncertainty behind a single evidence score. Include the failed
gate or conflicting field that determines the verdict.
