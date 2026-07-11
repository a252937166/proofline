# Injective integration

Validated on Injective testnet on 11 July 2026.

## Network identifiers

| Surface | Injective testnet value |
| --- | --- |
| EVM chain ID | `1439` (`0x59f`) |
| x402 CAIP-2 | `eip155:1439` |
| Native Cosmos chain | `injective-888` |
| Circle CCTP domain | `29` |
| JSON-RPC | `https://k8s.testnet.json-rpc.injective.network/` |
| Blockscout | `https://testnet.blockscout.injective.network/` |
| Native USDC | `0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d` |

The EVM chain ID, CAIP-2 identifier, Cosmos chain ID, and CCTP domain are
different namespaces and must never be substituted for one another.

## Verified registry deployment

[`MatchProofRegistry`](https://testnet.blockscout.injective.network/address/0x959538bE97f6Fc3A09C823514acC176681155A7e)
is deployed at `0x959538bE97f6Fc3A09C823514acC176681155A7e`. Blockscout reports the source
as **fully verified** with Solidity `v0.8.35+commit.47b9dedd`, optimizer `200`,
EVM version `paris`, and deployed code hash
`0xb18ca7e2ae1827086a33b6c57212d6fcac64dc76eba4e6e822377273d9de4858`.

| Operation | Transaction |
| --- | --- |
| Deployment | [`0x87bf72e57d0c6c2768a9fae0177209cfd06d3d3b2c29b12986b350352f9286fc`](https://testnet.blockscout.injective.network/tx/0x87bf72e57d0c6c2768a9fae0177209cfd06d3d3b2c29b12986b350352f9286fc) |
| Grant dedicated anchorer | [`0x72704feff656f75de591da4ee624333294509b76beaba1b4925109096bd748b3`](https://testnet.blockscout.injective.network/tx/0x72704feff656f75de591da4ee624333294509b76beaba1b4925109096bd748b3) |
| Anchor replay final result | [`0x455e933b149e8f291d41f5e5fc58fdca55fdb56c7cfd3a9e1b2f55d32f6c6038`](https://testnet.blockscout.injective.network/tx/0x455e933b149e8f291d41f5e5fc58fdca55fdb56c7cfd3a9e1b2f55d32f6c6038) |

The anchor is match revision `1` for `WC-2022-WAL-IRN/final-result`. It commits:

```text
eventHash     0x088bd2d1850c38ea45bc365549142d1cd240c8c72339a1c5c7d645d0fad6f10f
evidenceRoot  0x696dc277d6766b67d90774b5d8e0c021a7ba114f18c7110e70cba75b8e0d8d3b
evidenceScore 9649 basis points = 96.49/100
```

`evidenceScore` is a deterministic policy score, not a probability. The
Solidity field remains named `confidenceBps` for schema compatibility.

## Registry safety properties

- Revisions are append-only and linked by `previousDecisionHash`.
- `appendRevision` accepts the expected previous hash, preventing concurrent
  writers from silently overwriting one another.
- Historical verification is explicitly separate from settlement
  verification.
- `verifyLatestSettlementProof` checks only the match-wide latest revision. A
  later `Disputed` or `Rejected` state invalidates an older result for
  settlement.
- A `Final` decision cannot roll back to a non-final state.
- Anchors store the compact `evidenceRoot`, not the complete sports payload or
  a circular hash containing their own transaction receipt.
- Owner, anchorer, pause, and two-step ownership controls are on chain.

The registry proves a commitment and revision order. It does not independently
prove that the underlying sporting event is true.

## Native USDC and real x402 settlement

Proofline pins `@injectivelabs/x402@0.0.1`. The payer signs an EIP-3009
authorization; the inline facilitator submits the native testnet USDC transfer
and pays INJ gas. The protected verification report costs `10000` atomic units,
or `0.01` USDC.

The complete path was executed successfully:

- transaction:
  [`0x79700fa00ff0d0c7a5821608f6221c7805b2feb3fe72133d526b491c41fe624a`](https://testnet.blockscout.injective.network/tx/0x79700fa00ff0d0c7a5821608f6221c7805b2feb3fe72133d526b491c41fe624a);
- payer: `0x672044f1b95740e003D5E62671E6c1DE4Cc058b0`, balance
  `20.00 → 19.99` test USDC;
- payee/facilitator: `0x4595f5a3372F1ca653329140146081d309Ac2bf2`,
  balance `20.00 → 20.01` test USDC;
- receipt status: success (`0x1`).

The server builds and freezes the report before settlement. Its client checks
origin, redirect, chain, token, payee, price, quote identity, and packet hash
before signing. If the signed payment does not reach a final receipt inside the
bounded window, the API returns `payment-uncertain` and instructs the caller to
check Explorer/nonce state instead of paying again automatically.

Injective may expose canonical block/state before the public EVM receipt index.
Proofline therefore confirms anchors with a bounded combination of latest
registry state, canonical RPC block, and the official Blockscout transaction
API. The x402 facilitator uses a token-protected local RPC adapter for the same
receipt-indexing gap; it is not exposed as a public relay.

## Portable proof verification

The x402 response is an issuer-signed portable packet, not merely a payment
receipt. It is accepted only when all three layers pass:

1. recomputed packet/event/evidence integrity;
2. recovered EIP-712 signer matches a configured trusted issuer;
3. fresh `verifyLatestSettlementProof` data matches `eventHash`,
   `evidenceRoot`, Evidence Score, and valid state.

The real run passed all three. See the sanitized
[end-to-end evidence](../evidence/testnet/real-e2e-2026-07-11.json).

## MCP execution evidence

Proofline ships a domain MCP for match evidence, settlement readiness, x402
purchase, packet verification, and registry reads. The official Injective MCP
can complement it with address, balance, token, and network operations.

A reproducible stdio capture pinned the official server at commit
`f5af39367975872a85b5447cefc9a197f2e635ea`, listed 37 tools, and successfully
called `address_normalize` and `usdc_native_info` on testnet. The sanitized
inputs and outputs are committed in
[evidence/agent/official-injective-mcp.json](../evidence/agent/official-injective-mcp.json).

## CCTP status: future work

The intended route is Base Sepolia domain `6` to Injective domain `29`.

| Contract | Address |
| --- | --- |
| Base Sepolia USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Injective USDC | `0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d` |
| Injective `TokenMessengerV2` | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| Injective `MessageTransmitterV2` | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |

This release validates only the intended testnet route and approval boundary.
It does **not** execute approve, `depositForBurn`, sandbox Iris attestation
polling, `receiveMessage`, mint, or destination balance recheck. No CCTP
transaction is claimed. Any future implementation must use
`https://iris-api-sandbox.circle.com` for testnet attestations.

## Primary references

- [Injective EVM network information](https://docs.injective.network/developers-evm/network-information)
- [Injective x402 documentation](https://docs.injective.network/developers-ai/x402)
- [Injective native USDC](https://docs.injective.network/developers-defi/usdc-stablecoin)
- [Injective CCTP tutorial](https://docs.injective.network/developers-defi/usdc-cctp-tutorial)
- [Official Injective MCP server](https://github.com/InjectiveLabs/mcp-server)
- [Official Injective Agent Skills](https://github.com/InjectiveLabs/agent-skills)
