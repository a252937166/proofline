#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createPublicClient,
  defineChain,
  http,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";

import { ApiFailure, ProoflineApi, type ApiResponse } from "./api.js";
import {
  CIRCLE_USDC_ADDRESS_REFERENCE,
  cctpSourceNetworks,
} from "./cctp.js";
import {
  SpendPolicy,
  extractPaymentRequirements,
  formatUsdc,
  parseUsdc,
  publicRequirement,
} from "./policy.js";

const MCP_VERSION = "0.2.0";
const api = new ProoflineApi();
const policy = new SpendPolicy();
const server = new McpServer({ name: "proofline", version: MCP_VERSION });
const sourceNetworks = cctpSourceNetworks();
const registeredTools = [
  "list_matches",
  "get_match",
  "get_match_events",
  "verify_event",
  "assess_settlement_readiness",
  "quote_match_proof",
  "purchase_match_proof",
  "verify_proof_packet",
  "verify_onchain_anchor",
  "prepare_cctp_funding",
] as const;

// McpServer's schema-preserving generic is excellent for small servers, but
// repeatedly instantiating it together with viem's ABI generics makes tsc use
// excessive memory. Runtime validation remains Zod-backed; this narrow adapter
// keeps compile time predictable without weakening the exposed JSON schemas.
const registerTool = server.registerTool.bind(server) as unknown as (
  name: string,
  config: {
    description: string;
    inputSchema: Record<string, z.ZodTypeAny>;
  },
  handler: (input: any) => Promise<ReturnType<typeof output>>,
) => void;

function pathPart(value: string): string {
  return encodeURIComponent(value.trim());
}

function output(value: unknown, isError = false) {
  const json = JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
  return { content: [{ type: "text" as const, text: json }], ...(isError ? { isError: true } : {}) };
}

function summarizeInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      if (/signature|private|secret|token/i.test(key)) return [key, "[redacted]"];
      if (typeof value === "string") return [key, value.slice(0, 160)];
      if (typeof value === "boolean" || typeof value === "number") {
        return [key, value];
      }
      if (value === undefined || value === null) return [key, value ?? null];
      return [key, `[${Array.isArray(value) ? "array" : "object"}]`];
    }),
  );
}

function summarizeResult(value: unknown): string {
  try {
    return JSON.stringify(value, (key, item: unknown) => {
      if (/signature|private|secret|token/i.test(key)) return "[redacted]";
      return typeof item === "bigint" ? item.toString() : item;
    }).slice(0, 500);
  } catch {
    return "Result was not JSON serializable";
  }
}

async function recordRuntime(path: string, body: unknown): Promise<void> {
  const token = process.env.PROOFLINE_MCP_AUDIT_TOKEN;
  try {
    await api.postWithHeaders(
      path,
      body,
      token ? { "X-Proofline-MCP-Audit": token } : {},
      [401, 503],
    );
  } catch {
    // Runtime audit evidence is best-effort and never changes tool semantics.
  }
}

async function run(
  tool: string,
  input: Record<string, unknown>,
  action: () => Promise<unknown>,
) {
  const startedAt = Date.now();
  try {
    const value = await action();
    await recordRuntime("/mcp/runtime/logs", {
      id: randomUUID(),
      sessionId: api.sessionId,
      tool,
      inputSummary: summarizeInput(input),
      outcome: "success",
      resultSummary: summarizeResult(value),
      durationMs: Date.now() - startedAt,
      at: new Date().toISOString(),
    });
    return output(value);
  } catch (error) {
    const failure =
      error instanceof ApiFailure
        ? `HTTP ${error.response.status}`
        : error instanceof Error
          ? error.message
          : String(error);
    await recordRuntime("/mcp/runtime/logs", {
      id: randomUUID(),
      sessionId: api.sessionId,
      tool,
      inputSummary: summarizeInput(input),
      outcome: "failure",
      resultSummary: failure.slice(0, 500),
      durationMs: Date.now() - startedAt,
      at: new Date().toISOString(),
    });
    if (error instanceof ApiFailure) {
      return output(
        { error: error.message, status: error.response.status, response: error.response.data },
        true,
      );
    }
    return output({ error: error instanceof Error ? error.message : String(error) }, true);
  }
}

function query(values: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") params.set(name, value);
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function demoSignature(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const sandbox = (data as Record<string, unknown>).demoSandbox;
  if (!sandbox || typeof sandbox !== "object" || Array.isArray(sandbox)) return undefined;
  const signature = (sandbox as Record<string, unknown>).paymentSignature;
  return typeof signature === "string" && signature.length > 0 ? signature : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function quoteProof(matchId: string, eventId: string): Promise<ApiResponse> {
  return api.get(
    `/matches/${pathPart(matchId)}/proof${query({ eventId })}`,
    [402],
  );
}

registerTool(
  "list_matches",
  {
    description:
      "List Proofline matches. Read mode and disclosure before describing data as live or historical replay.",
    inputSchema: {
      mode: z
        .enum(["replay", "live", "delayed", "scheduled"])
        .optional()
        .describe("Optional honest data-mode filter"),
    },
  },
  ({ mode }) =>
    run(
      "list_matches",
      { mode },
      async () => (await api.get(`/matches${query({ mode })}`)).data,
    ),
);

registerTool(
  "get_match",
  {
    description: "Get match metadata, score, replay disclosure, events, and source provenance.",
    inputSchema: { match_id: z.string().min(1) },
  },
  ({ match_id }) =>
    run(
      "get_match",
      { match_id },
      async () => (await api.get(`/matches/${pathPart(match_id)}`)).data,
    ),
);

registerTool(
  "get_match_events",
  {
    description:
      "Get events for a match. The response machine-readably distinguishes live, delayed, scheduled, and historical-replay modes; never describe non-live data as live.",
    inputSchema: { match_id: z.string().min(1) },
  },
  ({ match_id }) =>
    run(
      "get_match_events",
      { match_id },
      async () => (await api.get(`/matches/${pathPart(match_id)}/events`)).data,
    ),
);

registerTool(
  "verify_event",
  {
    description:
      "Inspect observations, conflicts, confidence, anchor, and settlement decision for one event. This does not force a new verdict.",
    inputSchema: {
      match_id: z.string().min(1),
      event_id: z.string().min(1),
    },
  },
  ({ match_id, event_id }) =>
    run("verify_event", { match_id, event_id }, async () =>
      (await api.get(`/matches/${pathPart(match_id)}/events/${pathPart(event_id)}`)).data,
    ),
);

registerTool(
  "assess_settlement_readiness",
  {
    description:
      "Evaluate the final-match, verified-state, confidence, conflict, and matching-anchor gates without executing settlement.",
    inputSchema: {
      match_id: z.string().min(1),
      event_id: z.string().min(1).default("final-result"),
    },
  },
  ({ match_id, event_id }) =>
    run("assess_settlement_readiness", { match_id, event_id }, async () =>
      (
        await api.get(
          `/matches/${pathPart(match_id)}/decision${query({ eventId: event_id })}`,
        )
      ).data,
    ),
);

registerTool(
  "quote_match_proof",
  {
    description:
      "Fetch an x402 quote without paying. Returns the API's 402 disclosure and the MCP hard spending policy.",
    inputSchema: {
      match_id: z.string().min(1),
      event_id: z.string().min(1).default("final-result"),
    },
  },
  ({ match_id, event_id }) =>
    run("quote_match_proof", { match_id, event_id }, async () => {
      const response = await quoteProof(match_id, event_id);
      const requirements = extractPaymentRequirements(response);
      return {
        httpStatus: response.status,
        paymentRequirements: requirements.map(publicRequirement),
        policy: policy.snapshot(),
        response: response.data,
      };
    }),
);

registerTool(
  "purchase_match_proof",
  {
    description:
      "Retry a quoted proof request with PAYMENT-SIGNATURE. Enforces Injective testnet USDC, configured payee, 0.02 USDC/proof, and 0.10 USDC/session limits.",
    inputSchema: {
      match_id: z.string().min(1),
      event_id: z.string().min(1).default("final-result"),
      payment_signature: z
        .string()
        .min(1)
        .optional()
        .describe("Signed x402 v2 payload. Omit only for an explicitly labelled demoSandbox quote."),
      approved: z
        .boolean()
        .describe("Must be true only after the quote's amount, network, asset, and payee were reviewed."),
    },
  },
  ({ match_id, event_id, payment_signature, approved }) =>
    run(
      "purchase_match_proof",
      { match_id, event_id, payment_signature, approved },
      async () => {
      const quote = await quoteProof(match_id, event_id);
      if (quote.status !== 402) {
        return {
          paid: false,
          note: "The resource did not require payment.",
          report: quote.data,
          policy: policy.snapshot(),
        };
      }

      const requirements = extractPaymentRequirements(quote);
      const sandboxSignature = demoSignature(quote.data);
      const requirement = requirements.find((candidate) => {
        try {
          policy.validate(candidate, sandboxSignature !== undefined);
          return true;
        } catch {
          return false;
        }
      });
      if (!requirement) {
        const offered = requirements.map(publicRequirement);
        throw new Error(
          `No offered x402 requirement satisfies the MCP policy. Offered: ${JSON.stringify(offered)}`,
        );
      }

      const signature = payment_signature ?? sandboxSignature;
      if (!signature) {
        throw new Error("A wallet-provided PAYMENT-SIGNATURE is required for a non-sandbox x402 quote");
      }
      const ledger = policy.reserve(requirement, approved, sandboxSignature !== undefined);
      const report = await api.getWithHeaders(
        `/matches/${pathPart(match_id)}/proof${query({ eventId: event_id })}`,
        { "PAYMENT-SIGNATURE": signature },
      );
      const paymentResult = object(object(report.data)?.payment);
      const valueTransferred = paymentResult?.valueTransferred === true;

      return {
        paid: valueTransferred,
        sandbox: sandboxSignature !== undefined,
        paymentMode: sandboxSignature !== undefined ? "demo-sandbox" : "signed-x402",
        payment: publicRequirement(requirement),
        policy: ledger,
        report: report.data,
      };
      },
    ),
);

registerTool(
  "verify_proof_packet",
  {
    description:
      "Recompute the portable packet, confidence, conflicts, anchor match, and settlement invariants. This is packet verification, not a live chain read.",
    inputSchema: {
      packet: z.record(z.unknown()).describe("Proof packet returned by purchase_match_proof"),
    },
  },
  ({ packet }) =>
    run(
      "verify_proof_packet",
      { packet },
      async () => (await api.post("/proofs/verify", { packet })).data,
    ),
);

const registryReadAbi = [
  {
    type: "function",
    name: "REGISTRY_ID",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "verifyLatestSettlementProof",
    stateMutability: "view",
    inputs: [
      { name: "matchIdHash", type: "bytes32" },
      { name: "eventHash", type: "bytes32" },
    ],
    outputs: [
      { name: "valid", type: "bool" },
      { name: "state", type: "uint8" },
      { name: "confidenceBps", type: "uint16" },
      { name: "revision", type: "uint64" },
      { name: "decisionHash", type: "bytes32" },
      { name: "evidenceRoot", type: "bytes32" },
    ],
  },
] as const;

const EXPECTED_REGISTRY_ID = keccak256(
  stringToHex("proofline.match-proof-registry.v3"),
);

const proofStates = ["provisional", "verified", "disputed", "final", "rejected"] as const;

registerTool(
  "verify_onchain_anchor",
  {
    description:
      "Perform a fresh latest-settlement eth_call against the API-configured MatchProofRegistry on Injective EVM testnet and require the packet evidence root. Refuses demo receipts and arbitrary RPC or contract overrides.",
    inputSchema: {
      match_id: z.string().min(1),
      event_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      evidence_root: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    },
  },
  ({ match_id, event_hash, evidence_root }) =>
    run(
      "verify_onchain_anchor",
      { match_id, event_hash, evidence_root },
      async () => {
      const integrationResponse = await api.get("/integrations");
      const root = object(integrationResponse.data);
      const injective = object(root?.injective);
      if (!injective) throw new Error("Proofline API did not return Injective integration metadata");

      if (injective.mode !== "injective-testnet" || injective.simulated !== false) {
        return {
          valid: false,
          onchainRead: false,
          mode: injective.mode ?? "unknown",
          disclosure:
            "The API is using a demo receipt. Use verify_proof_packet for consistency checks; no on-chain claim can be made.",
        };
      }

      const chainId = injective.chainId;
      const network = injective.network;
      const rpcUrl = injective.publicRpcUrl;
      const registryAddress = injective.registryAddress;
      if (chainId !== 1439 || network !== "eip155:1439") {
        throw new Error("Refusing on-chain verification outside Injective EVM testnet 1439");
      }
      if (typeof rpcUrl !== "string" || !/^https?:\/\//.test(rpcUrl)) {
        throw new Error("API returned an invalid Injective testnet RPC URL");
      }
      const parsedRpc = new URL(rpcUrl);
      const loopbackRpc = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
        parsedRpc.hostname,
      );
      if (parsedRpc.protocol !== "https:" && !loopbackRpc) {
        throw new Error(
          "Injective registry verification requires HTTPS unless the RPC is loopback development infrastructure",
        );
      }
      if (typeof registryAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(registryAddress)) {
        throw new Error("API returned an invalid MatchProofRegistry address");
      }

      const chain = defineChain({
        id: 1439,
        name: "Injective EVM Testnet",
        nativeCurrency: { name: "Injective", symbol: "INJ", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
        testnet: true,
      });
      const client = createPublicClient({ chain, transport: http(rpcUrl) });
      const actualChainId = await client.getChainId();
      if (actualChainId !== 1439) {
        throw new Error(`Configured RPC returned chain ID ${actualChainId}, expected 1439`);
      }
      const [code, registryId] = await Promise.all([
        client.getCode({ address: registryAddress as Address }),
        client.readContract({
          address: registryAddress as Address,
          abi: registryReadAbi,
          functionName: "REGISTRY_ID",
        }),
      ]);
      if (!code || code === "0x") throw new Error("No contract code exists at the configured registry address");
      if (registryId !== EXPECTED_REGISTRY_ID) {
        throw new Error("Configured contract is not a Proofline MatchProofRegistry v3 instance");
      }

      const matchIdHash = keccak256(stringToHex(match_id.trim().toUpperCase()));
      const [valid, state, confidenceBps, revision, decisionHash, committedEvidenceRoot] = await client.readContract({
        address: registryAddress as Address,
        abi: registryReadAbi,
        functionName: "verifyLatestSettlementProof",
        args: [matchIdHash, event_hash as Hex],
      });
      const blockNumber = await client.getBlockNumber();
      const evidenceRootMatches =
        committedEvidenceRoot.toLowerCase() === evidence_root.toLowerCase();
      return {
        valid: valid && evidenceRootMatches,
        onchainRead: true,
        network: "eip155:1439",
        chainId: actualChainId,
        blockNumber: blockNumber.toString(),
        registryAddress,
        matchIdHash,
        eventHash: event_hash,
        expectedEvidenceRoot: evidence_root,
        latest: {
          state: proofStates[state] ?? `unknown-${state}`,
          confidenceBps,
          revision: revision.toString(),
          decisionHash,
          evidenceRoot: committedEvidenceRoot,
          evidenceRootMatches,
        },
        disclosure:
          "Fresh MatchProofRegistry eth_call. A matching commitment does not independently prove the sporting fact.",
      };
      },
    ),
);

registerTool(
  "prepare_cctp_funding",
  {
    description:
      "Prepare, but never execute, a CCTP test-USDC funding plan from Sepolia to Injective testnet. A human must approve immediately before burn.",
    inputSchema: {
      source_network: z.enum(["ethereum-sepolia", "base-sepolia"]),
      amount_usdc: z.string().describe("Positive test USDC amount with no more than 6 decimals"),
      destination_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      source_usdc_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
    },
  },
  ({ source_network, amount_usdc, destination_address, source_usdc_address }) =>
    run(
      "prepare_cctp_funding",
      {
        source_network,
        amount_usdc,
        destination_address,
        source_usdc_address,
      },
      async () => {
      const amount = parseUsdc(amount_usdc);
      if (amount <= 0n) throw new Error("CCTP funding amount must be positive");
      const remainingProofBudget = parseUsdc(policy.snapshot().sessionRemainingUsdc);
      if (amount > remainingProofBudget) {
        throw new Error(
          `CCTP funding plan exceeds the remaining ${formatUsdc(remainingProofBudget)} USDC proof-session budget`,
        );
      }
      const source = sourceNetworks[source_network as keyof typeof sourceNetworks];
      if (source_usdc_address && source_usdc_address.toLowerCase() !== source.usdc.toLowerCase()) {
        throw new Error(`Source asset is not configured test USDC for ${source_network}`);
      }
      const integrations = await api.get("/integrations");
      return {
        executable: false,
        approvalState: "HUMAN_APPROVAL_REQUIRED_BEFORE_BURN",
        source: {
          network: source.caip2,
          asset: source.usdc,
          amountUsdc: formatUsdc(amount),
        },
        destination: {
          network: "eip155:1439",
          address: destination_address,
          asset: policy.asset,
        },
        addressReference: CIRCLE_USDC_ADDRESS_REFERENCE,
        nextSteps: [
          "Confirm source-chain test USDC balance and gas.",
          "Show the exact burn amount, source token, destination address, and fees to the human.",
          "Obtain explicit approval immediately before the irreversible CCTP burn.",
          "Wait for Circle attestation and destination mint before attempting x402 payment.",
        ],
        integrations: integrations.data,
      };
      },
    ),
);

const sendHeartbeat = () =>
  recordRuntime("/mcp/runtime/heartbeat", {
    sessionId: api.sessionId,
    serverVersion: MCP_VERSION,
    transport: "stdio",
    tools: [...registeredTools],
    at: new Date().toISOString(),
  });
await sendHeartbeat();
setInterval(() => void sendHeartbeat(), 60_000).unref();
const transport = new StdioServerTransport();
await server.connect(transport);
