# Proofline MCP server

The stdio server exposes match evidence, settlement gates, x402 proof purchase,
proof-packet verification, and a non-executing CCTP preparation tool.

```bash
npm run build -w @proofline/mcp
PROOFLINE_API_BASE=http://127.0.0.1:8787/api \
PROOFLINE_ALLOWED_PAYEE=0x... \
npm run start -w @proofline/mcp
```

`purchase_match_proof` is fail-closed. It accepts only `eip155:1439`, the
configured Injective testnet USDC address, and the configured payee. Its hard
ceilings are 0.02 USDC per report and 0.10 USDC for the lifetime of the MCP
process; environment values can lower but cannot raise those ceilings.

The server never executes a CCTP burn. `prepare_cctp_funding` validates the
testnet path and returns an approval checklist for a separate wallet-capable
agent.
