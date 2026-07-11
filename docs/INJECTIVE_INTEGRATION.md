# Injective integration notes

Validated against official sources on 10 July 2026.

## Identifiers

| Surface | Injective testnet value |
| --- | --- |
| EVM chain ID | `1439` (`0x59f`) |
| x402 CAIP-2 | `eip155:1439` |
| Native Cosmos chain | `injective-888` |
| Circle CCTP domain | `29` |
| JSON-RPC | `https://k8s.testnet.json-rpc.injective.network/` |
| Blockscout | `https://testnet.blockscout.injective.network/` |

These identifiers are different namespaces and must never be substituted for
one another.

## Native USDC and x402

- Native testnet USDC: `0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d`.
- It supports EIP-3009, which lets the payer sign an authorization while the
  facilitator submits the transaction and pays INJ gas.
- Proofline pins `@injectivelabs/x402@0.0.1` because the package is early and the
  middleware/client boundary may change.
- The protected report costs `10000` atomic units (`0.01 USDC`).
- The live server uses a self-hosted inline facilitator. No public hosted
  facilitator is assumed.
- Agent and facilitator/payee are distinct wallets. The Agent wallet carries a
  small, policy-capped test USDC balance; the facilitator needs test INJ.

The report is computed before settlement. Proofline never charges a request and
then discovers that its evidence packet cannot be generated.

## CCTP V2 testnet

Recommended judge path: Base Sepolia (domain `6`) to Injective (domain `29`).

| Contract | Address |
| --- | --- |
| Base Sepolia USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Injective USDC | `0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d` |
| Injective `TokenMessengerV2` | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| Injective `MessageTransmitterV2` | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |

Testnet attestation must use `https://iris-api-sandbox.circle.com`, not the
production Iris host. The funding state is resumable from a burn transaction:

```text
check balance -> approve -> burn -> poll sandbox attestation -> mint on
Injective -> recheck balance -> resume x402 request
```

The current build exposes this as a **plan-only** safety path. It validates the
intended testnet route and approval boundary, but it does not implement approve,
`depositForBurn`, Iris polling, `receiveMessage`, mint, or balance recheck. It
never fabricates burn, attestation, or mint transactions.

## Complementary MCP servers

Proofline ships a domain MCP for match evidence, settlement readiness, report
quotes, packet verification, and registry reads. The official Injective MCP can
run beside it for balances, native USDC metadata, wallet operations, and CCTP
minting.

At the researched official commit, the Injective MCP used the production Circle
Iris host in its CCTP status path, returned no testnet source chains, and did not
offer a burn tool. Proofline therefore owns registry reads and a guarded funding
plan; executable sandbox burn, attestation polling, and mint remain clearly
listed deployment work. Documentation does not claim that either MCP currently
completes the whole CCTP journey.

## Primary references

- https://docs.injective.network/developers-evm/network-information
- https://docs.injective.network/developers-ai/x402
- https://docs.injective.network/developers-defi/usdc-stablecoin
- https://docs.injective.network/developers-defi/usdc-cctp-tutorial
- https://github.com/InjectiveLabs/mcp-server
- https://github.com/InjectiveLabs/agent-skills
