import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverEntry = path.resolve("packages/mcp/dist/index.js");
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  ),
);
environment.PROOFLINE_API_BASE =
  process.env.PROOFLINE_API_BASE ?? "http://127.0.0.1:8787/api";
environment.PROOFLINE_SESSION_ID =
  process.env.PROOFLINE_SESSION_ID ?? "proofline-testnet-judge";

const apiBase = environment.PROOFLINE_API_BASE.replace(/\/$/, "");
const anchorResponse = await fetch(
  `${apiBase}/matches/WC-2026-M97-FRA-MAR/verify-anchor?eventId=final-result`,
  { method: "POST" },
);
if (!anchorResponse.ok) {
  throw new Error(
    `Could not hydrate the 2026 testnet anchor before MCP capture (${anchorResponse.status})`,
  );
}
const anchorPreparation = (await anchorResponse.json()) as unknown;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: environment,
  stderr: "pipe",
});
const client = new Client({
  name: "proofline-judge-evidence-client",
  version: "1.1.0",
});
await client.connect(transport);

function parseResult(value: unknown): unknown {
  const content =
    value && typeof value === "object" && "content" in value
      ? (value as { content?: Array<{ type?: string; text?: string }> }).content
      : undefined;
  const text = content?.find((entry) => entry.type === "text")?.text;
  if (!text) return value;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

const requests = [
  { name: "list_matches", arguments: { mode: "delayed" } },
  {
    name: "get_match_events",
    arguments: { match_id: "WC-2026-M97-FRA-MAR" },
  },
  {
    name: "verify_event",
    arguments: {
      match_id: "WC-2026-M97-FRA-MAR",
      event_id: "final-result",
    },
  },
  {
    name: "assess_settlement_readiness",
    arguments: {
      match_id: "WC-2026-M97-FRA-MAR",
      event_id: "final-result",
    },
  },
  {
    name: "verify_onchain_anchor",
    arguments: {
      match_id: "WC-2026-M97-FRA-MAR",
      event_hash:
        "0x8837f43f315336c660ec19791c4a374e7eacdd7ff9d66c546247bbeb89035b30",
      evidence_root:
        "0xe048362103ce6c4f07d95e1a0ebdd81b7b9b9332943d4af978cdde71b62661b3",
    },
  },
] as const;

try {
  const tools = await client.listTools();
  const calls = [];
  for (const request of requests) {
    const startedAt = process.hrtime.bigint();
    const result = await client.callTool(request);
    calls.push({
      tool: request.name,
      input: request.arguments,
      durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
      success: !result.isError,
      result: parseResult(result),
    });
  }
  const evidence = {
    schema: "proofline.mcp-execution-evidence.v2",
    capturedAt: new Date().toISOString(),
    client: {
      name: "proofline-judge-evidence-client",
      version: "1.1.0",
      transport: "stdio",
    },
    server: {
      name: "proofline",
      version: "0.2.0",
      reportedToolCount: tools.tools.length,
      sessionId: environment.PROOFLINE_SESSION_ID,
    },
    anchorPreparation,
    calls,
    disclosure:
      "Captured from the built Proofline MCP stdio server against the real local testnet API. The final tool performed a fresh Registry v3 eth_call. No private key, payment signature, or audit token is included.",
  };
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (process.argv.includes("--write")) {
    const output = path.resolve("evidence/agent/proofline-mcp-testnet.json");
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, serialized, { encoding: "utf8", mode: 0o644 });
  }
  process.stdout.write(serialized);
} finally {
  await client.close();
}
