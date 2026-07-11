# Proofline MCP server

The stdio server exposes match evidence, settlement gates, x402 proof purchase,
proof-packet verification, and a non-executing CCTP preparation tool.

```bash
npm run build -w @proofline/mcp
PROOFLINE_API_BASE=http://127.0.0.1:8787/api \
PROOFLINE_ALLOWED_PAYEE=0x... \
PROOFLINE_MCP_AUDIT_TOKEN=replace-with-shared-api-token \
npm run start -w @proofline/mcp
```

The event-feed tool is `get_match_events` (not `get_live_events`) because every
response can independently be `live`, `delayed`, `scheduled`, or
`historical-replay`. On start and once per minute, the process sends a heartbeat
to `/api/mcp/runtime`; every real handler execution appends a redacted tool,
input, outcome, duration, and result summary. Production API instances require
the same `PROOFLINE_MCP_AUDIT_TOKEN` and should set
`PROOFLINE_MCP_AUDIT_FILE` if that audit trail must survive restarts.

`purchase_match_proof` is fail-closed. It accepts only `eip155:1439`, the
configured Injective testnet USDC address, and the configured payee. Its hard
ceilings are 0.02 USDC per report and 0.10 USDC for the lifetime of the MCP
process; environment values can lower but cannot raise those ceilings.

The server never executes a CCTP burn. `prepare_cctp_funding` validates the
testnet path and returns an approval checklist for a separate wallet-capable
agent.
