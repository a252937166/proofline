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

[`MatchProofRegistry` v3](https://testnet.blockscout.injective.network/address/0x380D75d068dec45D8145ef89B7A40a6201Ac1ef1?tab=contract)
is deployed at `0x380D75d068dec45D8145ef89B7A40a6201Ac1ef1`. Blockscout reports the source
as **fully verified** with Solidity `v0.8.35+commit.47b9dedd`, optimizer `200`,
EVM version `paris`, and deployed code hash
`0xb0a638a47be17775add74f872bc024e3c4389bd1487d3fd01a021377828cf0d4`.

| Operation | Transaction |
| --- | --- |
| Deployment | [`0xdf71a0e7fce722bfdc39b58951f6548ef07b6d06cb101aa57bc51a5566979523`](https://testnet.blockscout.injective.network/tx/0xdf71a0e7fce722bfdc39b58951f6548ef07b6d06cb101aa57bc51a5566979523) |
| Grant dedicated anchorer | [`0x58587a0d751248b714a6232cc75618762e02ff355aba00fa28d79216f252acb4`](https://testnet.blockscout.injective.network/tx/0x58587a0d751248b714a6232cc75618762e02ff355aba00fa28d79216f252acb4) |
| Anchor 2026 final result | [`0x24cd0ae9a40dbfdba14563f9f2932451624be63928667b629c4cadc86a507344`](https://testnet.blockscout.injective.network/tx/0x24cd0ae9a40dbfdba14563f9f2932451624be63928667b629c4cadc86a507344) |

The anchor is match revision `1` for `WC-2026-M97-FRA-MAR/final-result`. It commits:

```text
eventHash     0x8837f43f315336c660ec19791c4a374e7eacdd7ff9d66c546247bbeb89035b30
evidenceRoot  0xe048362103ce6c4f07d95e1a0ebdd81b7b9b9332943d4af978cdde71b62661b3
evidenceScore 9825 basis points = 98.25/100
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
- `appendRevision` is the only write entry point; every writer must declare
  `expectedPreviousDecisionHash`.
- A `Final` decision is fully immutable, including against a second `Final`.
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
  [`0x29237a0a3d501ca62882042313fcbb730fd91d152967430b2600545a227b842e`](https://testnet.blockscout.injective.network/tx/0x29237a0a3d501ca62882042313fcbb730fd91d152967430b2600545a227b842e);
- payer: `0x672044f1b95740e003D5E62671E6c1DE4Cc058b0`, balance
  `19.99 → 19.98` test USDC;
- payee/facilitator: `0x4595f5a3372F1ca653329140146081d309Ac2bf2`,
  balance `20.01 → 20.02` test USDC;
- receipt status: success (`0x1`).

The server builds and atomically persists the full frozen report before
settlement. Its client checks
origin, redirect, chain, token, payee, price, quote identity, and packet hash
before signing. If the signed payment does not reach a final receipt inside the
bounded window, the API returns `payment-uncertain` and instructs the caller to
check Explorer/nonce state instead of paying again automatically. A second
`ProofPurchase` EIP-712 signature explicitly binds the packet hash, payer,
payee, amount, deadline, EIP-3009 nonce, and session. OKX receives the USDC
authorization and ProofPurchase from two explicit page clicks, preventing the
second confirmation from remaining hidden in the extension. In-flight recovery
accepts only the exact original `PAYMENT-SIGNATURE`, retained in browser memory.
After settlement, `/api/proofs/recover` uses only a non-spendable browser
capability and never calls the facilitator or repeats payment.

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
[no-wallet end-to-end evidence](../data/evidence/featured-proof.json).

## MCP execution evidence

Proofline ships a domain MCP for match evidence, settlement readiness, x402
purchase, packet verification, and registry reads. The official Injective MCP
can complement it with address, balance, token, and network operations.

A reproducible stdio capture pinned the official server at commit
`f5af39367975872a85b5447cefc9a197f2e635ea`, listed 37 tools, and successfully
called `address_normalize`, `usdc_native_info`, and `account_balances` on
testnet. The last call reports the payer's real native INJ and USDC balance. The sanitized
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
