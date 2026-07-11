import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverEntry = path.resolve(
  process.env.INJECTIVE_MCP_SERVER ??
    "/tmp/proofline-injective-mcp/dist/mcp/server.js",
);
const publicAddress =
  process.env.PROOFLINE_MCP_EVIDENCE_ADDRESS ??
  "0x672044f1b95740e003D5E62671E6c1DE4Cc058b0";
const publicInjectiveAddress =
  process.env.PROOFLINE_MCP_EVIDENCE_INJ_ADDRESS ??
  "inj1vusyfude2aqwqq74ucn8rekpmexvqk9sajmcc5";

await access(serverEntry);

const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  ),
);
environment.INJECTIVE_NETWORK = "testnet";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: environment,
  stderr: "pipe",
});
const client = new Client({
  name: "proofline-evidence-client",
  version: "0.3.0",
});

await client.connect(transport);

try {
  const listed = await client.listTools();
  const calls = [];
  const requests: Array<{ tool: string; input: Record<string, unknown> }> = [
    { tool: "address_normalize", input: { address: publicAddress } },
    { tool: "usdc_native_info", input: {} },
    {
      tool: "account_balances",
      input: { address: publicInjectiveAddress },
    },
  ];

  for (const request of requests) {
    const startedAt = process.hrtime.bigint();
    try {
      const result = await client.callTool({
        name: request.tool,
        arguments: request.input,
      });
      calls.push({
        tool: request.tool,
        input: request.input,
        durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
        success: !result.isError,
        result,
      });
    } catch (error) {
      calls.push({
        tool: request.tool,
        input: request.input,
        durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const evidence = {
    schema: "proofline.agent-tool-evidence.v1",
    capturedAt: new Date().toISOString(),
    client: {
      name: "proofline-evidence-client",
      version: "0.3.0",
      transport: "stdio",
    },
    server: {
      name: "InjectiveLabs/mcp-server",
      repository: "https://github.com/InjectiveLabs/mcp-server",
      commit: process.env.INJECTIVE_MCP_COMMIT ?? "record-separately",
      network: "testnet",
      reportedToolCount: listed.tools.length,
    },
    calls,
    disclosure:
      "Read-only official Injective MCP calls. No private key, signature, or transaction is requested.",
  };
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (process.argv.includes("--write")) {
    const output = path.resolve("evidence/agent/official-injective-mcp.json");
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, serialized, { encoding: "utf8", mode: 0o644 });
  }
  process.stdout.write(serialized);
} finally {
  await client.close();
}
