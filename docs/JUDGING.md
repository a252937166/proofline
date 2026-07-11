# Judge guide

Proofline is designed to answer three questions before a sports product or AI
Agent acts:

1. What did each independent source report?
2. Is the current event safe under a reproducible evidence policy?
3. Can another machine verify the packet, its issuer, and the latest chain
   commitment?

## 15 seconds — inspect the thesis

Open [proofline.axiqo.xyz](https://proofline.axiqo.xyz). The first screen
separates the result shown to a user from the proof required for automated
settlement. Select a data mode and inspect its machine-readable disclosure:

- **2026 delayed:** France 2–0 Morocco, with ESPN and FIFA provenance;
- **2026 scheduled:** Norway–England and Argentina–Switzerland, with
  `score=null` and no invented live state;
- **2022 historical replay:** Wales 0–2 IR Iran, the deterministic conflict
  demonstration.

## 90 seconds — run the judge demo

1. Press **Run the 90-second verification demo**.
2. OpenFootball reports Wayne Hennessey's red card.
3. The explicitly synthetic provider-lag observation reports yellow. Proofline
   pauses on the exact `card` mismatch, marks the event `contested`, and holds
   settlement.
4. Press **Continue with provider correction**. FIFA corroborates red and the
   bad claim is retracted without deleting history.
5. Late goals and full-time status produce the final 0–2 event.
6. Inspect the Evidence Score. It is a deterministic policy score, **not a
   probability**. Only one representative from each independent source group
   contributes weight; duplicating one provider cannot manufacture quorum.
7. Press **Inspect x402 + chain proof** and verify all three layers:
   packet integrity, EIP-712 trusted issuer, and match-wide latest on-chain
   commitment.
8. Run the tamper check. A one-field mutation must fail integrity verification.

The replay is permanently labelled **Historical Replay · Not Live**, and the
injected yellow-card fault is permanently labelled synthetic.

## Public testnet evidence — no wallet required

| Check | Blockscout evidence |
| --- | --- |
| Fully verified `MatchProofRegistry` | [`0x959538bE97f6Fc3A09C823514acC176681155A7e`](https://testnet.blockscout.injective.network/address/0x959538bE97f6Fc3A09C823514acC176681155A7e) |
| Contract deployment | [`0x87bf72e57d0c6c2768a9fae0177209cfd06d3d3b2c29b12986b350352f9286fc`](https://testnet.blockscout.injective.network/tx/0x87bf72e57d0c6c2768a9fae0177209cfd06d3d3b2c29b12986b350352f9286fc) |
| Anchorer authorization | [`0x72704feff656f75de591da4ee624333294509b76beaba1b4925109096bd748b3`](https://testnet.blockscout.injective.network/tx/0x72704feff656f75de591da4ee624333294509b76beaba1b4925109096bd748b3) |
| Final-result anchor | [`0x455e933b149e8f291d41f5e5fc58fdca55fdb56c7cfd3a9e1b2f55d32f6c6038`](https://testnet.blockscout.injective.network/tx/0x455e933b149e8f291d41f5e5fc58fdca55fdb56c7cfd3a9e1b2f55d32f6c6038) |
| x402 `0.01` test-USDC settlement | [`0x79700fa00ff0d0c7a5821608f6221c7805b2feb3fe72133d526b491c41fe624a`](https://testnet.blockscout.injective.network/tx/0x79700fa00ff0d0c7a5821608f6221c7805b2feb3fe72133d526b491c41fe624a) |

The anchored replay commitment is revision `1`, event hash
`0x088bd2d1850c38ea45bc365549142d1cd240c8c72339a1c5c7d645d0fad6f10f`,
evidence root
`0x696dc277d6766b67d90774b5d8e0c021a7ba114f18c7110e70cba75b8e0d8d3b`,
and Evidence Score `96.49/100`. The complete sanitized run is
[machine-readable](../evidence/testnet/real-e2e-2026-07-11.json).

## Agent and MCP evidence

Proofline exposes ten domain MCP tools, including `get_match_events`,
`assess_settlement_readiness`, `purchase_match_proof`,
`verify_proof_packet`, and `verify_onchain_anchor`. The UI labels an Agent trace
as actual only when MCP runtime logs are present; otherwise it explicitly says
that the trace is illustrative.

The repository includes a real stdio execution capture from the official
Injective MCP pinned at commit
`f5af39367975872a85b5447cefc9a197f2e635ea`. It listed 37 tools and successfully
ran `address_normalize` and `usdc_native_info` on testnet. Inspect the sanitized
[MCP transcript](../evidence/agent/official-injective-mcp.json) or reproduce it
with `npm run evidence:injective-mcp`.

[Proofline's own MCP transcript](../evidence/agent/proofline-mcp-testnet.json)
records five successful real tool calls. Its final
`verify_onchain_anchor` call performed a fresh Injective EVM read and matched
the registry's latest revision `1` and evidence root.

## Important boundary

CCTP is **future work**, not a completed feature. The design targets Base
Sepolia domain `6` to Injective domain `29`, but Proofline claims no CCTP burn,
attestation, mint, or balance-recheck transaction. Native Injective testnet USDC
and the x402 payment above are real; no mainnet asset was used.

## Local verification

```bash
npm install
npm run check
npm run smoke
npm run dev
```

The web app opens at `http://localhost:5173`; the API listens on
`http://localhost:8787`.
