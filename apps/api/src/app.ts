import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { timingSafeEqual } from "node:crypto";

import {
  decideSettlement,
  issuerKeyId,
  verifyProofPacket,
  type ProofPacket,
  type DataMode,
  type MatchCatalogEntry,
  type ReplayDataset,
  type TrustedIssuerHistoryEntry,
} from "@proofline/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import {
  createAnchorService,
  type AnchorService,
} from "./anchor.js";
import {
  readRuntimeConfig,
  INJECTIVE_TESTNET_EXPLORER_API_URL,
  type RuntimeConfig,
} from "./config.js";
import {
  loadDelayedSnapshot,
  loadFeaturedProofSample,
  loadReplayDataset,
  loadScheduledMatches,
  replayCatalogEntry,
  type DelayedSnapshot,
  type FeaturedProofSample,
} from "./data.js";
import { integrationStatus } from "./integrations.js";
import { ReplayEngine } from "./replay.js";
import {
  McpRuntimeStore,
  type McpHeartbeat,
  type McpToolExecution,
} from "./mcp-runtime.js";
import {
  createX402Middleware,
  type PaymentResult,
} from "./x402.js";
import { ProofEntitlementStore } from "./proof-entitlement-store.js";
import {
  buildProofSubjectPacket,
  createDelayedSnapshotProofSubject,
} from "./proof-subject.js";
import type { AnchorRecord } from "./api-types.js";

export interface ApiOptions {
  config?: RuntimeConfig;
  dataset?: ReplayDataset;
  anchorService?: AnchorService;
  env?: NodeJS.ProcessEnv;
  scheduledMatches?: MatchCatalogEntry[];
  delayedSnapshot?: DelayedSnapshot;
  featuredProofSample?: FeaturedProofSample;
}

export interface ApiRuntime {
  app: Express;
  engine: ReplayEngine;
  config: RuntimeConfig;
  dataset: ReplayDataset;
  anchorService: AnchorService;
  issuer: {
    address: `0x${string}`;
    keyId: `0x${string}`;
    persistent: boolean;
  };
  dispose(): void;
}

const PROOF_QUOTE_TTL_MS = 5 * 60 * 1_000;
const MAX_REPLAY_SESSIONS = 64;
const REPLAY_SESSION_TTL_MS = 60 * 60 * 1_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PAID_PROOF_WINDOW_MS = 60_000;
const PAID_PROOF_WINDOW_LIMIT = 12;

function requestSessionId(req: Request): string {
  const value = req.get("X-Proofline-Session")?.trim();
  return value && SESSION_ID_PATTERN.test(value) ? value : "default";
}

function validEventId(value: unknown): value is string {
  return typeof value === "string" && EVENT_ID_PATTERN.test(value);
}

function paymentQuoteId(req: Request): `0x${string}` | undefined {
  const header = req.get("PAYMENT-SIGNATURE") ?? req.get("X-PAYMENT");
  if (!header || header.length > 32_768) return undefined;

  const demo = /^demo\.[0-9a-fA-F]{16}\.([0-9a-fA-F]{64})$/.exec(header);
  if (demo?.[1]) return `0x${demo[1]}`;

  try {
    const payload = JSON.parse(
      Buffer.from(header, "base64").toString("utf8"),
    ) as {
      accepted?: { extra?: { prooflineQuoteId?: unknown } };
    };
    const value = payload.accepted?.extra?.prooflineQuoteId;
    return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)
      ? (value as `0x${string}`)
      : undefined;
  } catch {
    return undefined;
  }
}

function isProofPacket(value: unknown): value is ProofPacket {
  if (!value || typeof value !== "object") return false;
  const packet = value as Partial<ProofPacket>;
  return (
    packet.schema === "proofline.packet.v1" &&
    typeof packet.packetHash === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(packet.packetHash) &&
    typeof packet.evidenceRoot === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(packet.evidenceRoot) &&
    typeof packet.issuerAddress === "string" &&
    /^0x[0-9a-fA-F]{40}$/.test(packet.issuerAddress) &&
    typeof packet.issuerKeyId === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(packet.issuerKeyId) &&
    packet.issuerPolicyVersion === "proofline.issuer-policy.v1" &&
    typeof packet.issuedAt === "string" &&
    Number.isFinite(new Date(packet.issuedAt).getTime()) &&
    typeof packet.issuerSignature === "string" &&
    /^0x[0-9a-fA-F]{130}$/.test(packet.issuerSignature) &&
    packet.signatureScheme === "eip712" &&
    typeof packet.eventId === "string" &&
    Boolean(packet.match) &&
    Boolean(packet.verification) &&
    Array.isArray(packet.observations)
  );
}

function readTrustedIssuerHistory(
  value: string | undefined,
): TrustedIssuerHistoryEntry[] {
  if (!value?.trim()) return [];
  if (value.length > 32_768) {
    throw new Error("PROOFLINE_TRUSTED_ISSUER_HISTORY_JSON is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("PROOFLINE_TRUSTED_ISSUER_HISTORY_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length > 32) {
    throw new Error(
      "PROOFLINE_TRUSTED_ISSUER_HISTORY_JSON must be an array with at most 32 entries",
    );
  }
  const entries = parsed as Array<Partial<TrustedIssuerHistoryEntry>>;
  if (
    !entries.every(
      (entry) =>
        typeof entry.keyId === "string" &&
        /^0x[0-9a-fA-F]{64}$/.test(entry.keyId) &&
        typeof entry.address === "string" &&
        /^0x[0-9a-fA-F]{40}$/.test(entry.address) &&
        typeof entry.validFrom === "string" &&
        Number.isFinite(new Date(entry.validFrom).getTime()) &&
        (entry.revokedAt === undefined ||
          (typeof entry.revokedAt === "string" &&
            Number.isFinite(new Date(entry.revokedAt).getTime()) &&
            new Date(entry.revokedAt).getTime() >
              new Date(entry.validFrom).getTime())),
    )
  ) {
    throw new Error(
      "PROOFLINE_TRUSTED_ISSUER_HISTORY_JSON contains an invalid issuer policy entry",
    );
  }
  return structuredClone(entries) as TrustedIssuerHistoryEntry[];
}

function asyncHandler(
  handler: (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

export function createApi(options: ApiOptions = {}): ApiRuntime {
  const env = options.env ?? process.env;
  const config = options.config ?? readRuntimeConfig(env);
  const dataset = options.dataset ?? loadReplayDataset();
  const knownReplayEventIds = new Set<string>();
  for (const frame of dataset.frames) {
    if (frame.kind === "observe") knownReplayEventIds.add(frame.observation.eventId);
    if (frame.kind === "anchor") knownReplayEventIds.add(frame.eventId);
  }
  const scheduledMatches = options.scheduledMatches ?? loadScheduledMatches();
  const delayedSnapshot = options.delayedSnapshot ?? loadDelayedSnapshot();
  const featuredProofSample =
    options.featuredProofSample ?? loadFeaturedProofSample();
  if (!isProofPacket(featuredProofSample.packet)) {
    throw new Error("Featured proof sample does not contain a valid signed packet");
  }
  const anchorService =
    options.anchorService ?? createAnchorService(config.anchor);
  const configuredIssuerKey = env.PROOFLINE_ISSUER_PRIVATE_KEY?.trim();
  if (
    configuredIssuerKey &&
    !/^0x[0-9a-fA-F]{64}$/.test(configuredIssuerKey)
  ) {
    throw new Error(
      "The configured Proofline issuer private key must be a 32-byte 0x-prefixed hex value.",
    );
  }
  if (env.NODE_ENV === "production" && !configuredIssuerKey) {
    throw new Error(
      "PROOFLINE_ISSUER_PRIVATE_KEY is required in production; ephemeral issuers are not trusted for published evidence.",
    );
  }
  const issuerPersistent = Boolean(
    configuredIssuerKey && /^0x[0-9a-fA-F]{64}$/.test(configuredIssuerKey),
  );
  const issuerPrivateKey = (
    issuerPersistent ? configuredIssuerKey : generatePrivateKey()
  ) as Hex;
  const issuerAccount = privateKeyToAccount(issuerPrivateKey);
  const configuredIssuerValidFrom =
    env.PROOFLINE_ISSUER_VALID_FROM?.trim() ||
    "1970-01-01T00:00:00.000Z";
  if (!Number.isFinite(new Date(configuredIssuerValidFrom).getTime())) {
    throw new Error(
      "PROOFLINE_ISSUER_VALID_FROM must be a valid ISO timestamp",
    );
  }
  const issuer = {
    address: issuerAccount.address,
    keyId: issuerKeyId(issuerAccount.address),
    persistent: issuerPersistent,
    validFrom: new Date(configuredIssuerValidFrom).toISOString(),
  };
  const trustedIssuerHistory = readTrustedIssuerHistory(
    env.PROOFLINE_TRUSTED_ISSUER_HISTORY_JSON,
  );
  const engine = new ReplayEngine(
    dataset,
    anchorService,
    issuerPrivateKey,
    config.replayIntervalMs,
  );
  const replaySessions = new Map<
    string,
    { engine: ReplayEngine; touchedAt: number }
  >();
  const entitlementFile =
    config.x402.mode === "live"
      ? config.x402.entitlementFile
      : env.PROOFLINE_PROOF_ENTITLEMENT_FILE?.trim();
  if (
    env.NODE_ENV === "production" &&
    config.x402.mode === "live" &&
    !entitlementFile
  ) {
    throw new Error(
      "PROOFLINE_PROOF_ENTITLEMENT_FILE is required for durable production x402 delivery and recovery.",
    );
  }
  const proofEntitlements = new ProofEntitlementStore(entitlementFile);
  const replayFor = (req: Request): ReplayEngine => {
    const sessionId = requestSessionId(req);
    if (sessionId === "default") return engine;

    const now = Date.now();
    for (const [id, session] of replaySessions) {
      if (session.touchedAt + REPLAY_SESSION_TTL_MS <= now) {
        session.engine.dispose();
        replaySessions.delete(id);
      }
    }
    const current = replaySessions.get(sessionId);
    if (current) {
      current.touchedAt = now;
      return current.engine;
    }
    while (replaySessions.size >= MAX_REPLAY_SESSIONS) {
      const oldestId = replaySessions.keys().next().value as string | undefined;
      if (!oldestId) break;
      replaySessions.get(oldestId)?.engine.dispose();
      replaySessions.delete(oldestId);
    }
    const sessionEngine = new ReplayEngine(
      dataset,
      anchorService,
      issuerPrivateKey,
      config.replayIntervalMs,
    );
    replaySessions.set(sessionId, { engine: sessionEngine, touchedAt: now });
    return sessionEngine;
  };
  const dispose = () => {
    engine.dispose();
    for (const session of replaySessions.values()) session.engine.dispose();
    replaySessions.clear();
  };
  const app = express();
  const paidProofWindows = new Map<string, number[]>();
  const rpcProxyWindows = new Map<string, number[]>();
  const mcpRuntime = new McpRuntimeStore(env.PROOFLINE_MCP_AUDIT_FILE);
  const mcpAuditAuthorized = (req: Request): boolean => {
    const expected = env.PROOFLINE_MCP_AUDIT_TOKEN;
    if (!expected) return env.NODE_ENV !== "production";
    const actual = req.get("X-Proofline-MCP-Audit") ?? "";
    const left = Buffer.from(actual);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  };

  app.disable("x-powered-by");
  app.use(express.json({ limit: "512kb" }));
  app.use((req, res, next) => {
    const configuredOrigin = env.CORS_ORIGIN ?? env.WEB_ORIGIN;
    const corsOrigin =
      configuredOrigin ?? (env.NODE_ENV === "production" ? undefined : "*");
    if (corsOrigin) res.set("Access-Control-Allow-Origin", corsOrigin);
    res.vary("Origin");
    res.set(
      "Access-Control-Allow-Headers",
      "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT, X-Proofline-Session, X-Proofline-MCP-Audit",
    );
    res.set("Access-Control-Expose-Headers", [
      "PAYMENT-REQUIRED",
      "PAYMENT-RESPONSE",
      "X-PAYMENT-REQUIRED",
      "X-PAYMENT-RESPONSE",
      "X-Data-Mode",
    ].join(", "));
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.use((req, res, next) => {
    const session = req.get("X-Proofline-Session");
    if (session !== undefined && !SESSION_ID_PATTERN.test(session.trim())) {
      res.status(400).json({
        error: "invalid_session_id",
        message:
          "X-Proofline-Session must be 8-64 letters, digits, underscores, or hyphens.",
      });
      return;
    }
    next();
  });
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (req.path.startsWith("/replay") || req.path.startsWith("/replays")) {
      res.set("X-Data-Mode", "historical-replay");
      res.set("X-Proofline-Data-Mode", "historical-replay");
    }
    next();
  });

  app.post("/api/internal/evm-rpc/:token", asyncHandler(async (req, res) => {
    const requestHost = (req.get("host") ?? "").split(":")[0]?.toLowerCase();
    if (!requestHost || !["127.0.0.1", "localhost", "[::1]"].includes(requestHost)) {
      res.status(404).json({ error: "route_not_found" });
      return;
    }
    const expected =
      config.x402.mode === "live" ? config.x402.rpcProxyToken : undefined;
    const rawToken = req.params.token;
    const supplied = typeof rawToken === "string" ? rawToken : "";
    const expectedBytes = Buffer.from(expected ?? "");
    const suppliedBytes = Buffer.from(supplied);
    if (
      !expected ||
      expectedBytes.length !== suppliedBytes.length ||
      !timingSafeEqual(expectedBytes, suppliedBytes)
    ) {
      // The route is intentionally undiscoverable for unknown tokens.
      res.status(404).json({ error: "route_not_found" });
      return;
    }
    const now = Date.now();
    const rateKey = req.ip ?? "unknown";
    const recent = (rpcProxyWindows.get(rateKey) ?? []).filter(
      (at) => at + 60_000 > now,
    );
    if (recent.length >= 180) {
      res.status(429).json({ error: "rpc_proxy_rate_limited" });
      return;
    }
    recent.push(now);
    rpcProxyWindows.set(rateKey, recent);

    const body = req.body as
      | { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
      | undefined;
    const allowedMethods = new Set([
      "eth_blockNumber",
      "eth_call",
      "eth_chainId",
      "eth_estimateGas",
      "eth_feeHistory",
      "eth_gasPrice",
      "eth_getBalance",
      "eth_getBlockByNumber",
      "eth_getCode",
      "eth_getTransactionByHash",
      "eth_getTransactionCount",
      "eth_getTransactionReceipt",
      "eth_maxPriorityFeePerGas",
      "eth_sendRawTransaction",
    ]);
    if (
      !body ||
      Array.isArray(body) ||
      body.jsonrpc !== "2.0" ||
      typeof body.method !== "string" ||
      (body.params !== undefined && !Array.isArray(body.params))
    ) {
      res.status(400).json({
        jsonrpc: "2.0",
        id: body?.id ?? null,
        error: { code: -32600, message: "Invalid JSON-RPC request" },
      });
      return;
    }
    if (!allowedMethods.has(body.method)) {
      res.status(200).json({
        jsonrpc: "2.0",
        id: body.id ?? null,
        error: { code: -32601, message: "Method not found" },
      });
      return;
    }
    const explorerApiUrl =
      config.anchor.mode === "injective-testnet"
        ? config.anchor.explorerApiUrl
        : INJECTIVE_TESTNET_EXPLORER_API_URL;
    const upstream =
      body.method === "eth_getTransactionReceipt" ||
      body.method === "eth_getTransactionByHash"
        ? `${explorerApiUrl.replace(/\/$/, "")}/eth-rpc`
        : config.x402.mode === "live"
          ? config.x402.rpcUrl
          : null;
    if (!upstream) {
      res.status(503).json({ error: "rpc_proxy_not_configured" });
      return;
    }
    const response = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    const text = await response.text();
    res.status(response.ok ? 200 : 502);
    res.type("application/json").send(text);
  }));
  const setDataMode = (res: Response, mode: DataMode | "catalog") => {
    res.set("X-Data-Mode", mode);
    res.set("X-Proofline-Data-Mode", mode);
  };
  const scheduledById = new Map(
    scheduledMatches.map((match) => [match.id, match]),
  );
  const delayedSubject = createDelayedSnapshotProofSubject(delayedSnapshot);
  let delayedAnchor: AnchorRecord | null = null;
  let delayedAnchorPromise: Promise<AnchorRecord> | null = null;
  const ensureDelayedAnchor = async (): Promise<AnchorRecord> => {
    if (delayedAnchor) return structuredClone(delayedAnchor);
    delayedAnchorPromise ??= anchorService.anchor({
      matchId: delayedSubject.match.id,
      verification: delayedSubject.verification,
      evidenceRoot: delayedSubject.evidenceRoot,
      anchoredAt: new Date().toISOString(),
    });
    try {
      delayedAnchor = await delayedAnchorPromise;
      return structuredClone(delayedAnchor);
    } finally {
      delayedAnchorPromise = null;
    }
  };
  const delayedEvent = () => {
    const verification = structuredClone(delayedSubject.verification);
    return {
      eventId: delayedSnapshot.eventId,
      observations: structuredClone(delayedSnapshot.observations),
      verification,
      anchor: delayedAnchor ? structuredClone(delayedAnchor) : null,
      decision: decideSettlement(
        verification,
        delayedSnapshot.match.status,
        delayedAnchor?.receipt,
      ),
    };
  };

  app.get("/api/health", (_req, res) => {
    const snapshot = replayFor(_req).snapshot();
    res.json({
      status: "ok",
      service: "proofline-api",
      dataMode: "multi-mode-catalog",
      availableDataModes: ["delayed", "scheduled", "historical-replay"],
      liveProviderActive: false,
      mcp: mcpRuntime.snapshot(),
      replaySessionIsolation: true,
      replay: {
        cursor: snapshot.replay.cursor,
        totalFrames: snapshot.replay.totalFrames,
        running: snapshot.replay.running,
      },
    });
  });

  app.get("/api/integrations", (_req, res) => {
    res.json({
      ...integrationStatus(config, anchorService, env),
      issuer: {
        address: issuer.address,
        keyId: issuer.keyId,
        signatureScheme: "eip712",
        persistent: issuer.persistent,
        status: issuer.persistent ? "configured" : "ephemeral",
        environmentVariable: "PROOFLINE_ISSUER_PRIVATE_KEY",
        disclosure: issuer.persistent
          ? "Proof packets are signed by the configured persistent issuer."
          : "Proof packets are signed by an ephemeral process issuer. Configure PROOFLINE_ISSUER_PRIVATE_KEY before publishing durable evidence.",
        policyVersion: "proofline.issuer-policy.v1",
        validFrom: issuer.validFrom,
        validFromEnvironmentVariable: "PROOFLINE_ISSUER_VALID_FROM",
        trustedHistoryCount: trustedIssuerHistory.length,
        historyEnvironmentVariable:
          "PROOFLINE_TRUSTED_ISSUER_HISTORY_JSON",
      },
    });
  });

  app.get("/api/mcp/runtime", (_req, res) => {
    res.json(mcpRuntime.snapshot());
  });

  app.get("/api/proofs/samples/featured", (_req, res) => {
    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
    res.json({
      ...featuredProofSample,
      noWalletRequired: true,
      paymentExecutedByThisRequest: false,
      freshVerification: {
        method: "POST",
        href: "/api/proofs/verify",
        body: { packet: featuredProofSample.packet },
      },
    });
  });

  app.post("/api/mcp/runtime/heartbeat", (req, res) => {
    if (!mcpAuditAuthorized(req)) {
      res.status(env.PROOFLINE_MCP_AUDIT_TOKEN ? 401 : 503).json({
        error: env.PROOFLINE_MCP_AUDIT_TOKEN
          ? "mcp_audit_unauthorized"
          : "mcp_audit_not_configured",
      });
      return;
    }
    const body = (req.body ?? {}) as Partial<McpHeartbeat>;
    if (
      !SESSION_ID_PATTERN.test(body.sessionId ?? "") ||
      typeof body.serverVersion !== "string" ||
      body.transport !== "stdio" ||
      !Array.isArray(body.tools) ||
      !body.tools.every(
        (tool) =>
          typeof tool === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(tool),
      ) ||
      typeof body.at !== "string" ||
      !Number.isFinite(new Date(body.at).getTime())
    ) {
      res.status(400).json({ error: "invalid_mcp_heartbeat" });
      return;
    }
    mcpRuntime.recordHeartbeat(body as McpHeartbeat);
    res.status(202).json({ accepted: true });
  });

  app.post("/api/mcp/runtime/logs", (req, res) => {
    if (!mcpAuditAuthorized(req)) {
      res.status(env.PROOFLINE_MCP_AUDIT_TOKEN ? 401 : 503).json({
        error: env.PROOFLINE_MCP_AUDIT_TOKEN
          ? "mcp_audit_unauthorized"
          : "mcp_audit_not_configured",
      });
      return;
    }
    const body = (req.body ?? {}) as Partial<McpToolExecution>;
    if (
      typeof body.id !== "string" ||
      body.id.length < 8 ||
      body.id.length > 80 ||
      !SESSION_ID_PATTERN.test(body.sessionId ?? "") ||
      typeof body.tool !== "string" ||
      !/^[a-z][a-z0-9_]{1,63}$/.test(body.tool) ||
      !body.inputSummary ||
      typeof body.inputSummary !== "object" ||
      Array.isArray(body.inputSummary) ||
      Object.keys(body.inputSummary).length > 20 ||
      JSON.stringify(body.inputSummary).length > 2_000 ||
      !["success", "failure"].includes(body.outcome ?? "") ||
      typeof body.resultSummary !== "string" ||
      body.resultSummary.length > 500 ||
      typeof body.durationMs !== "number" ||
      !Number.isFinite(body.durationMs) ||
      body.durationMs < 0 ||
      body.durationMs > 60_000 ||
      typeof body.at !== "string" ||
      !Number.isFinite(new Date(body.at).getTime())
    ) {
      res.status(400).json({ error: "invalid_mcp_execution_log" });
      return;
    }
    mcpRuntime.recordExecution(body as McpToolExecution);
    res.status(202).json({ accepted: true });
  });

  app.get("/api/replays/wales-iran-2022", (_req, res) => {
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.json(dataset);
  });

  app.get("/api/matches", (req, res) => {
    setDataMode(res, "catalog");
    const replayMatch = replayCatalogEntry(replayFor(req).snapshot().match);
    const allMatches = [
      delayedSnapshot.match,
      ...scheduledMatches,
      replayMatch,
    ];
    const requestedMode =
      typeof req.query.mode === "string" ? req.query.mode : undefined;
    const normalizedMode =
      requestedMode === "replay" ? "historical-replay" : requestedMode;
    const matches = normalizedMode
      ? allMatches.filter((match) => match.dataMode === normalizedMode)
      : allMatches;
    res.json({
      schema: "proofline.match-catalog.v1",
      mode: "catalog",
      availableModes: ["delayed", "scheduled", "historical-replay"],
      liveProviderActive: false,
      disclosure:
        "No live provider is active. Every match carries a machine-readable dataMode and source snapshot.",
      matches,
    });
  });

  app.get("/api/matches/:matchId", (req, res) => {
    const snapshot = replayFor(req).snapshot();
    if (snapshot.match.id === req.params.matchId) {
      setDataMode(res, "historical-replay");
      res.json({
        mode: snapshot.mode,
        dataMode: "historical-replay",
        disclosure: snapshot.disclosure,
        match: snapshot.match,
        replay: snapshot.replay,
        events: snapshot.events,
      });
      return;
    }
    if (delayedSnapshot.match.id === req.params.matchId) {
      setDataMode(res, "delayed");
      res.json({
        mode: "delayed",
        dataMode: "delayed",
        disclosure: delayedSnapshot.match.disclosure,
        match: delayedSnapshot.match,
        replay: null,
        events: [delayedEvent()],
      });
      return;
    }
    const scheduled = scheduledById.get(req.params.matchId);
    if (scheduled) {
      setDataMode(res, "scheduled");
      res.json({
        mode: "scheduled",
        dataMode: "scheduled",
        disclosure: scheduled.disclosure,
        match: scheduled,
        replay: null,
        events: [],
      });
      return;
    }
    res.status(404).json({ error: "match_not_found" });
  });

  app.get("/api/matches/:matchId/events", (req, res) => {
    const replay = replayFor(req);
    if (replay.getMatch(req.params.matchId)) {
      setDataMode(res, "historical-replay");
      res.json({
        mode: "historical-replay",
        dataMode: "historical-replay",
        disclosure: dataset.match.replayDisclosure,
        matchId: req.params.matchId,
        events: replay.events(),
      });
      return;
    }
    if (delayedSnapshot.match.id === req.params.matchId) {
      setDataMode(res, "delayed");
      res.json({
        mode: "delayed",
        dataMode: "delayed",
        disclosure: delayedSnapshot.match.disclosure,
        matchId: req.params.matchId,
        events: [delayedEvent()],
      });
      return;
    }
    const scheduled = scheduledById.get(req.params.matchId);
    if (scheduled) {
      setDataMode(res, "scheduled");
      res.json({
        mode: "scheduled",
        dataMode: "scheduled",
        disclosure: scheduled.disclosure,
        matchId: req.params.matchId,
        events: [],
      });
      return;
    }
    res.status(404).json({ error: "match_not_found" });
  });

  app.get("/api/matches/:matchId/events/:eventId", (req, res) => {
    if (!validEventId(req.params.eventId)) {
      res.status(400).json({ error: "invalid_event_id" });
      return;
    }
    const replay = replayFor(req);
    if (replay.getMatch(req.params.matchId)) {
      const event = replay.event(req.params.eventId);
      if (!event) {
        res.status(404).json({ error: "event_not_found" });
        return;
      }
      setDataMode(res, "historical-replay");
      res.json({
        mode: "historical-replay",
        dataMode: "historical-replay",
        disclosure: dataset.match.replayDisclosure,
        matchId: req.params.matchId,
        ...event,
      });
      return;
    }
    if (
      delayedSnapshot.match.id === req.params.matchId &&
      delayedSnapshot.eventId === req.params.eventId
    ) {
      setDataMode(res, "delayed");
      res.json({
        mode: "delayed",
        dataMode: "delayed",
        disclosure: delayedSnapshot.match.disclosure,
        matchId: req.params.matchId,
        ...delayedEvent(),
      });
      return;
    }
    if (
      delayedSnapshot.match.id === req.params.matchId ||
      scheduledById.has(req.params.matchId)
    ) {
      res.status(404).json({ error: "event_not_found" });
      return;
    }
    res.status(404).json({ error: "match_not_found" });
  });

  app.get("/api/matches/:matchId/decision", (req, res) => {
    const replay = replayFor(req);
    const eventId =
      typeof req.query.eventId === "string"
        ? req.query.eventId
        : "final-result";
    if (!validEventId(eventId)) {
      res.status(400).json({ error: "invalid_event_id" });
      return;
    }
    if (replay.getMatch(req.params.matchId)) {
      const event = replay.decision(eventId);
      if (!event) {
        res.status(404).json({ error: "event_not_found" });
        return;
      }
      setDataMode(res, "historical-replay");
      res.json({
        mode: "historical-replay",
        dataMode: "historical-replay",
        disclosure: dataset.match.replayDisclosure,
        matchId: req.params.matchId,
        eventId,
        verification: event.verification,
        anchor: event.anchor,
        decision: event.decision,
      });
      return;
    }
    if (delayedSnapshot.match.id === req.params.matchId) {
      if (eventId !== delayedSnapshot.eventId) {
        res.status(404).json({ error: "event_not_found" });
        return;
      }
      const event = delayedEvent();
      setDataMode(res, "delayed");
      res.json({
        mode: "delayed",
        dataMode: "delayed",
        disclosure: delayedSnapshot.match.disclosure,
        matchId: req.params.matchId,
        eventId,
        verification: event.verification,
        anchor: null,
        decision: event.decision,
      });
      return;
    }
    const scheduled = scheduledById.get(req.params.matchId);
    if (scheduled) {
      setDataMode(res, "scheduled");
      res.json({
        mode: "scheduled",
        dataMode: "scheduled",
        disclosure: scheduled.disclosure,
        matchId: req.params.matchId,
        eventId,
        verification: null,
        anchor: null,
        decision: {
          allowed: false,
          state: "held",
          reasons: [
            "The match is scheduled and no live or final event has been observed.",
          ],
        },
      });
      return;
    }
    res.status(404).json({ error: "match_not_found" });
  });

  app.post(
    "/api/matches/:matchId/verify-anchor",
    asyncHandler(async (req, res) => {
      const eventId =
        typeof req.query.eventId === "string"
          ? req.query.eventId
          : delayedSnapshot.eventId;
      if (!validEventId(eventId)) {
        res.status(400).json({ error: "invalid_event_id" });
        return;
      }
      if (req.params.matchId !== delayedSnapshot.match.id) {
        res.status(404).json({ error: "match_not_found" });
        return;
      }
      if (eventId !== delayedSnapshot.eventId) {
        res.status(404).json({ error: "event_not_found" });
        return;
      }
      if (delayedSubject.verification.state !== "verified") {
        res.status(409).json({
          error: "evidence_not_verified",
          message:
            "The delayed result has not cleared the independent-source verification policy and cannot be anchored.",
        });
        return;
      }
      const anchor = await ensureDelayedAnchor();
      const event = delayedEvent();
      setDataMode(res, "delayed");
      res.json({
        schema: "proofline.verify-anchor.v1",
        mode: "delayed",
        dataMode: "delayed",
        matchId: delayedSnapshot.match.id,
        eventId,
        evidenceRoot: delayedSubject.evidenceRoot,
        verification: event.verification,
        anchor,
        decision: event.decision,
        dataSemantics: delayedSubject.dataSemantics,
        disclosure:
          "The sporting result was verified from the frozen ESPN and FIFA snapshots. Injective proves the commitment and revision order, not the source fact by itself.",
      });
    }),
  );

  app.get("/api/replay/state", (req, res) => {
    res.json(replayFor(req).snapshot());
  });

  app.post(
    "/api/replay/reset",
    asyncHandler(async (req, res) => {
      res.json(await replayFor(req).reset());
    }),
  );

  app.post(
    "/api/replay/step",
    asyncHandler(async (req, res) => {
      res.json(await replayFor(req).step());
    }),
  );

  app.post(
    "/api/replay/run",
    asyncHandler(async (req, res) => {
      res.status(202).json(await replayFor(req).run());
    }),
  );

  app.post(
    "/api/replay/pause",
    asyncHandler(async (req, res) => {
      res.json(await replayFor(req).pause());
    }),
  );

  app.get("/api/replay/stream", (req, res) => {
    const replay = replayFor(req);
    res.status(200);
    res.set({
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "Cache-Control": "no-cache, no-transform",
    });
    res.flushHeaders();

    const send = (event: string, value: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(value)}\n\n`);
    };
    send("snapshot", replay.snapshot());
    const unsubscribe = replay.subscribe((event, snapshot) => {
      send(event, snapshot);
    });
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);

    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
      res.end();
    });
  });

  const paidProofRateLimit: RequestHandler = (req, res, next) => {
    if (!req.get("PAYMENT-SIGNATURE") && !req.get("X-PAYMENT")) {
      next();
      return;
    }
    const now = Date.now();
    const key = `${req.ip ?? "unknown"}:${requestSessionId(req)}`;
    const recent = (paidProofWindows.get(key) ?? []).filter(
      (at) => at + PAID_PROOF_WINDOW_MS > now,
    );
    if (recent.length >= PAID_PROOF_WINDOW_LIMIT) {
      res.set("Retry-After", "60");
      res.status(429).json({
        error: "paid_proof_rate_limited",
        message: "Too many paid proof attempts for this IP and session.",
      });
      return;
    }
    recent.push(now);
    paidProofWindows.set(key, recent);
    next();
  };

  const prepareProof: RequestHandler = asyncHandler(async (req, res, next) => {
    const replay = replayFor(req);
    const sessionId = requestSessionId(req);
    const matchId = req.params["matchId"];
    const isReplayMatch =
      typeof matchId === "string" && Boolean(replay.getMatch(matchId));
    const isDelayedMatch = matchId === delayedSnapshot.match.id;
    if (typeof matchId !== "string" || (!isReplayMatch && !isDelayedMatch)) {
      res.status(404).json({ error: "match_not_found" });
      return;
    }
    const eventId =
      typeof req.query.eventId === "string"
        ? req.query.eventId
        : "final-result";
    if (!validEventId(eventId)) {
      res.status(400).json({ error: "invalid_event_id" });
      return;
    }
    const hasPayment = Boolean(
      req.get("PAYMENT-SIGNATURE") ?? req.get("X-PAYMENT"),
    );
    const livePaymentConfigured =
      config.x402.mode === "live" && config.x402.configured;
    const liveAnchorRuntimeReady =
      config.anchor.mode === "injective-testnet" &&
      anchorService.mode === "injective-testnet";

    if (hasPayment) {
      const quoteId = paymentQuoteId(req);
      const frozen = quoteId
        ? proofEntitlements.find(sessionId, quoteId)
        : undefined;
      const packet = frozen?.packet;
      const quoteExpired =
        frozen?.status === "quoted" &&
        Boolean(
          frozen.expiresAt && Date.parse(frozen.expiresAt) <= Date.now(),
        );
      if (
        !quoteId ||
        !frozen ||
        quoteExpired ||
        !isProofPacket(packet) ||
        packet.match.id !== matchId ||
        packet.eventId !== eventId
      ) {
        res.status(409).json({
          error: "proof_quote_missing_or_expired",
          message:
            "The payment is not bound to a durable frozen proof quote for this match and event. Request a fresh 402 before signing; no payment was processed.",
        });
        return;
      }
      if (
        livePaymentConfigured &&
        (!liveAnchorRuntimeReady || packet.anchor?.mode !== "injective-testnet")
      ) {
        res.status(409).json({
          error: "proof_quote_anchor_mode_invalid",
          message:
            "The frozen quote is not backed by an Injective testnet anchor. No payment was processed; request a new quote after the anchor runtime is repaired.",
        });
        return;
      }
      res.locals.packet = packet;
      res.locals.proofQuoteId = quoteId;
      res.locals.proofProvenance = isDelayedMatch
        ? {
            ...delayedSubject.dataSemantics,
            sourceNotice: delayedSubject.match.sourceNotice,
          }
        : {
            dataMode: "historical-replay",
            disclosure: dataset.match.replayDisclosure,
            sourceNotice: dataset.match.sourceNotice,
          };
      next();
      return;
    }

    if (livePaymentConfigured && !liveAnchorRuntimeReady) {
      res.status(503).json({
        error: "x402_live_requires_testnet_anchor",
        message:
          "Live x402 payment is disabled until Injective testnet anchoring is configured. Demo commitments can only use the sandbox payment mode.",
        paymentState: "not-requested",
      });
      return;
    }

    let packet: ProofPacket | null;
    if (isDelayedMatch) {
      if (eventId !== delayedSnapshot.eventId) {
        res.status(404).json({ error: "proof_event_not_found" });
        return;
      }
      if (!delayedAnchor) {
        res.status(409).json({
          error: "proof_anchor_required",
          message:
            "Verify and anchor this 2026 result before requesting its x402 proof quote.",
          action: {
            method: "POST",
            href: `/api/matches/${encodeURIComponent(matchId)}/verify-anchor?eventId=${encodeURIComponent(eventId)}`,
          },
        });
        return;
      }
      if (
        livePaymentConfigured &&
        delayedAnchor.receipt.mode !== "injective-testnet"
      ) {
        res.status(503).json({
          error: "x402_live_requires_testnet_anchor",
          message:
            "Live x402 payment requires an Injective testnet proof receipt. The current delayed proof is a demo commitment, so no quote was issued.",
          paymentState: "not-requested",
        });
        return;
      }
      packet = await buildProofSubjectPacket({
        subject: delayedSubject,
        issuerPrivateKey,
        anchor: delayedAnchor.receipt,
      });
      res.locals.proofProvenance = {
        ...delayedSubject.dataSemantics,
        sourceNotice: delayedSubject.match.sourceNotice,
      };
    } else {
      const replayState = replay.snapshot();
      const replayEvent = replayState.events.find(
        (candidate) => candidate.eventId === eventId,
      );
      const anchorFailure = replayState.errors.find(
        (failure) =>
          failure.frameId.toLowerCase().includes("anchor") ||
          failure.message.toLowerCase().includes("anchor"),
      );
      if (
        eventId === "final-result" &&
        !(
          replayState.replay.complete &&
          !replayState.replay.running &&
          !replayState.replay.processing &&
          replayEvent?.verification.state === "verified" &&
          replayEvent.anchor?.receipt.confirmed === true &&
          (!livePaymentConfigured ||
            replayEvent.anchor.receipt.mode === "injective-testnet") &&
          replayEvent.decision.allowed
        )
      ) {
        const needsReset = Boolean(
          anchorFailure ||
          (!replayState.replay.processing &&
            replayState.replay.complete &&
            replayEvent &&
            replayEvent.anchor?.receipt.confirmed !== true),
        );
        res.status(409).json({
          error: "proof_event_not_ready",
          reason: anchorFailure
            ? "final-anchor-failed"
            : replayEvent
              ? "final-anchor-pending"
              : "event-not-processed",
          message: anchorFailure
            ? `The final result cannot be quoted because its anchor failed: ${anchorFailure.message}`
            : replayEvent
              ? "The final result cannot be quoted until the replay is complete and its anchor is confirmed."
              : "The requested event belongs to this replay but has not been processed yet. Advance the replay before requesting its proof.",
          paymentState: "not-requested",
          progress: {
            cursor: replayState.replay.cursor,
            totalFrames: replayState.replay.totalFrames,
            running: replayState.replay.running,
            processing: replayState.replay.processing,
            complete: replayState.replay.complete,
          },
          action: {
            method: "POST",
            href: needsReset ? "/api/replay/reset" : "/api/replay/step",
            runHref: "/api/replay/run",
            pollHref: "/api/replay/state",
            anchorRequired: true,
          },
        });
        return;
      }
      packet = await replay.proofPacket(eventId);
      res.locals.proofProvenance = {
        dataMode: "historical-replay",
        disclosure: dataset.match.replayDisclosure,
        sourceNotice: dataset.match.sourceNotice,
      };
    }
    if (!packet) {
      if (knownReplayEventIds.has(eventId)) {
        const progress = replay.snapshot().replay;
        res.status(409).json({
          error: "proof_event_not_ready",
          message:
            "The requested event belongs to this replay but has not been processed yet. Advance the replay before requesting its proof.",
          paymentState: "not-requested",
          progress: {
            cursor: progress.cursor,
            totalFrames: progress.totalFrames,
            running: progress.running,
            processing: progress.processing,
            complete: progress.complete,
          },
          action: {
            method: "POST",
            href: "/api/replay/step",
            runHref: "/api/replay/run",
            pollHref: "/api/replay/state",
            anchorRequired: eventId === "final-result",
          },
        });
        return;
      }
      res.status(404).json({
        error: "proof_event_not_found",
        message:
          "The requested event does not exist in this replay.",
      });
      return;
    }
    const now = Date.now();
    proofEntitlements.freezeQuote({
      sessionId,
      packetHash: packet.packetHash,
      packet,
      quote: {
        schema: "proofline.prepared-quote.v1",
        matchId,
        eventId,
      },
      quotedAt: new Date(now),
      expiresAt: new Date(now + PROOF_QUOTE_TTL_MS),
    });
    res.locals.packet = packet;
    res.locals.proofQuoteId = packet.packetHash;
    next();
  });

  app.get(
    "/api/matches/:matchId/proof",
    paidProofRateLimit,
    prepareProof,
    createX402Middleware(config.x402, proofEntitlements),
    (_req, res) => {
      const packet = res.locals.packet as ProofPacket;
      const payment = res.locals.payment as PaymentResult;
      res.json({
        schema: "proofline.paid-proof.v1",
        packet,
        payment,
        quote: {
          packetHash: res.locals.proofQuoteId,
          frozen: true,
        },
        provenance: {
          ...(res.locals.proofProvenance as Record<string, unknown>),
          trustBoundary:
            "A matching anchor proves hash commitment at a time; source agreement and the verifier establish evidence quality.",
        },
      });
    },
  );

  app.post("/api/proofs/verify", asyncHandler(async (req, res) => {
    const candidate =
      req.body && typeof req.body === "object" && "packet" in req.body
        ? (req.body as { packet: unknown }).packet
        : req.body;
    if (!isProofPacket(candidate)) {
      res.status(400).json({
        valid: false,
        error: "invalid_proof_packet",
        message:
          "Expected a proofline.packet.v1 object, either directly or under the packet property.",
      });
      return;
    }

    try {
      const report = await verifyProofPacket(candidate, new Date(), {
        expectedIssuerAddress: issuer.address,
        expectedIssuerValidFrom: issuer.validFrom,
        trustedIssuerHistory,
      });
      let onchain: Record<string, unknown>;
      if (candidate.anchor?.mode !== "injective-testnet") {
        onchain = {
          checked: false,
          valid: false,
          mode: candidate.anchor?.mode ?? "none",
          reason:
            "Demo or missing receipts have no public registry transaction. Only packet/hash consistency was recomputed.",
        };
      } else if (anchorService.mode !== "injective-testnet") {
        onchain = {
          checked: false,
          valid: false,
          mode: "injective-testnet",
          reason:
            "The packet claims a testnet anchor, but this API instance is not configured with the trusted registry RPC/address.",
        };
      } else {
        try {
          onchain = await anchorService.verify({
            matchId: candidate.match.id,
            eventHash: candidate.verification.canonical.eventHash,
            evidenceRoot: candidate.evidenceRoot,
            verificationConfidenceBps: candidate.verification.confidenceBps,
            anchorConfidenceBps: candidate.anchor.confidenceBps,
            observedAt: candidate.verification.canonical.occurredAt,
            anchoredAt: candidate.anchor.anchoredAt,
            ...(candidate.anchor.txHash ? { txHash: candidate.anchor.txHash } : {}),
            ...(candidate.anchor.contractAddress
              ? { contractAddress: candidate.anchor.contractAddress }
              : {}),
            ...(candidate.anchor.blockNumber
              ? { blockNumber: candidate.anchor.blockNumber }
              : {}),
            ...(candidate.anchor.explorerUrl
              ? { explorerUrl: candidate.anchor.explorerUrl }
              : {}),
          });
        } catch (error) {
          onchain = {
            checked: false,
            valid: false,
            mode: "injective-testnet",
            reason:
              "Fresh registry verification was temporarily unavailable. No on-chain validity claim was made.",
          };
        }
      }
      res.status(report.valid ? 200 : 422).json({
        ...report,
        integrityOnly: false,
        onchain,
        verificationLayers: {
          integrity: report.integrity,
          issuerSignature: report.signature,
          onchain,
        },
        computed: {
          packetHash: report.recomputedPacketHash,
          canonicalEventHash: candidate.verification.canonical.eventHash,
        },
        disclosure:
          "Packet validity is deterministic integrity verification. For configured testnet packets, onchain is a separate fresh registry and transaction check; demo anchors remain consistency checks only.",
      });
    } catch (error) {
      res.status(422).json({
        valid: false,
        error: "invalid_proof_packet",
        message: "The proof packet could not be deterministically verified.",
      });
    }
  }));

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "route_not_found" });
  });

  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const production = env.NODE_ENV === "production";
      res.status(500).json({
        error: "internal_error",
        message: production
          ? "The request could not be completed."
          : error instanceof Error
            ? error.message
            : String(error),
      });
    },
  );

  return { app, engine, config, dataset, anchorService, issuer, dispose };
}

export function createApp(options: ApiOptions = {}): Express {
  return createApi(options).app;
}
