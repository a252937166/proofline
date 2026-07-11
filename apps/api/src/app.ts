import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";

import {
  verifyProofPacket,
  type ProofPacket,
  type ReplayDataset,
} from "@proofline/core";
import {
  createAnchorService,
  type AnchorService,
} from "./anchor.js";
import {
  readRuntimeConfig,
  type RuntimeConfig,
} from "./config.js";
import { loadReplayDataset } from "./data.js";
import { integrationStatus } from "./integrations.js";
import { ReplayEngine } from "./replay.js";
import {
  createX402Middleware,
  type PaymentResult,
} from "./x402.js";

export interface ApiOptions {
  config?: RuntimeConfig;
  dataset?: ReplayDataset;
  anchorService?: AnchorService;
  env?: NodeJS.ProcessEnv;
}

export interface ApiRuntime {
  app: Express;
  engine: ReplayEngine;
  config: RuntimeConfig;
  dataset: ReplayDataset;
  anchorService: AnchorService;
  dispose(): void;
}

interface FrozenProofQuote {
  sessionId: string;
  matchId: string;
  eventId: string;
  packet: ProofPacket;
  expiresAt: number;
}

const PROOF_QUOTE_TTL_MS = 5 * 60 * 1_000;
const MAX_FROZEN_PROOF_QUOTES = 256;
const MAX_REPLAY_SESSIONS = 64;
const REPLAY_SESSION_TTL_MS = 60 * 60 * 1_000;

function requestSessionId(req: Request): string {
  const value = req.get("X-Proofline-Session")?.trim();
  return value && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : "default";
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
    typeof packet.eventId === "string" &&
    Boolean(packet.match) &&
    Boolean(packet.verification) &&
    Array.isArray(packet.observations)
  );
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
  const anchorService =
    options.anchorService ?? createAnchorService(config.anchor);
  const engine = new ReplayEngine(
    dataset,
    anchorService,
    config.replayIntervalMs,
  );
  const replaySessions = new Map<
    string,
    { engine: ReplayEngine; touchedAt: number }
  >();
  const frozenProofQuotes = new Map<string, FrozenProofQuote>();
  const frozenQuoteKey = (sessionId: string, quoteId: `0x${string}`) =>
    `${sessionId}:${quoteId.toLowerCase()}`;
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
      config.replayIntervalMs,
    );
    replaySessions.set(sessionId, { engine: sessionEngine, touchedAt: now });
    return sessionEngine;
  };
  const dispose = () => {
    engine.dispose();
    for (const session of replaySessions.values()) session.engine.dispose();
    replaySessions.clear();
    frozenProofQuotes.clear();
  };
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "512kb" }));
  app.use((req, res, next) => {
    res.set(
      "Access-Control-Allow-Origin",
      env.CORS_ORIGIN ?? env.WEB_ORIGIN ?? "*",
    );
    res.set(
      "Access-Control-Allow-Headers",
      "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT, X-Proofline-Session",
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
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (
      req.path.startsWith("/matches") ||
      req.path.startsWith("/replay") ||
      req.path.startsWith("/replays")
    ) {
      res.set("X-Data-Mode", "historical-replay");
      res.set("X-Proofline-Data-Mode", "historical-replay");
    }
    next();
  });

  app.get("/api/health", (_req, res) => {
    const snapshot = replayFor(_req).snapshot();
    res.json({
      status: "ok",
      service: "proofline-api",
      dataMode: "historical-replay",
      replaySessionIsolation: true,
      replay: {
        cursor: snapshot.replay.cursor,
        totalFrames: snapshot.replay.totalFrames,
        running: snapshot.replay.running,
      },
    });
  });

  app.get("/api/integrations", (_req, res) => {
    res.json(integrationStatus(config, anchorService, env));
  });

  app.get("/api/replays/wales-iran-2022", (_req, res) => {
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.json(dataset);
  });

  app.get("/api/matches", (req, res) => {
    res.json({
      mode: "historical-replay",
      disclosure: dataset.match.replayDisclosure,
      matches: [replayFor(req).snapshot().match],
    });
  });

  app.get("/api/matches/:matchId", (req, res) => {
    const snapshot = replayFor(req).snapshot();
    if (snapshot.match.id !== req.params.matchId) {
      res.status(404).json({ error: "match_not_found" });
      return;
    }
    res.json({
      mode: snapshot.mode,
      disclosure: snapshot.disclosure,
      match: snapshot.match,
      replay: snapshot.replay,
      events: snapshot.events,
    });
  });

  app.get("/api/matches/:matchId/events", (req, res) => {
    const replay = replayFor(req);
    if (!replay.getMatch(req.params.matchId)) {
      res.status(404).json({ error: "match_not_found" });
      return;
    }
    res.json({
      mode: "historical-replay",
      disclosure: dataset.match.replayDisclosure,
      matchId: req.params.matchId,
      events: replay.events(),
    });
  });

  app.get("/api/matches/:matchId/events/:eventId", (req, res) => {
    const replay = replayFor(req);
    if (!replay.getMatch(req.params.matchId)) {
      res.status(404).json({ error: "match_not_found" });
      return;
    }
    const event = replay.event(req.params.eventId);
    if (!event) {
      res.status(404).json({ error: "event_not_found" });
      return;
    }
    res.json({
      mode: "historical-replay",
      disclosure: dataset.match.replayDisclosure,
      matchId: req.params.matchId,
      ...event,
    });
  });

  app.get("/api/matches/:matchId/decision", (req, res) => {
    const replay = replayFor(req);
    if (!replay.getMatch(req.params.matchId)) {
      res.status(404).json({ error: "match_not_found" });
      return;
    }
    const eventId =
      typeof req.query.eventId === "string"
        ? req.query.eventId
        : "final-result";
    const event = replay.decision(eventId);
    if (!event) {
      res.status(404).json({ error: "event_not_found" });
      return;
    }
    res.json({
      mode: "historical-replay",
      disclosure: dataset.match.replayDisclosure,
      matchId: req.params.matchId,
      eventId,
      verification: event.verification,
      anchor: event.anchor,
      decision: event.decision,
    });
  });

  app.get("/api/replay/state", (req, res) => {
    res.json(replayFor(req).snapshot());
  });

  app.post("/api/replay/reset", (req, res) => {
    res.json(replayFor(req).reset());
  });

  app.post(
    "/api/replay/step",
    asyncHandler(async (req, res) => {
      res.json(await replayFor(req).step());
    }),
  );

  app.post("/api/replay/run", (req, res) => {
    res.status(202).json(replayFor(req).run());
  });

  app.post("/api/replay/pause", (req, res) => {
    res.json(replayFor(req).pause());
  });

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

  const prepareProof: RequestHandler = (req, res, next) => {
    const replay = replayFor(req);
    const sessionId = requestSessionId(req);
    const matchId = req.params["matchId"];
    if (typeof matchId !== "string" || !replay.getMatch(matchId)) {
      res.status(404).json({ error: "match_not_found" });
      return;
    }
    const eventId =
      typeof req.query.eventId === "string"
        ? req.query.eventId
        : "final-result";
    const hasPayment = Boolean(
      req.get("PAYMENT-SIGNATURE") ?? req.get("X-PAYMENT"),
    );

    if (hasPayment) {
      const quoteId = paymentQuoteId(req);
      const quoteKey = quoteId ? frozenQuoteKey(sessionId, quoteId) : undefined;
      const frozen = quoteKey ? frozenProofQuotes.get(quoteKey) : undefined;
      if (
        !quoteId ||
        !frozen ||
        frozen.expiresAt <= Date.now() ||
        frozen.sessionId !== sessionId ||
        frozen.matchId !== matchId ||
        frozen.eventId !== eventId
      ) {
        if (quoteKey) frozenProofQuotes.delete(quoteKey);
        res.status(409).json({
          error: "proof_quote_missing_or_expired",
          message:
            "The payment is not bound to an active frozen proof quote. Request a fresh 402 before signing; no payment was processed.",
        });
        return;
      }
      res.locals.packet = frozen.packet;
      res.locals.proofQuoteId = quoteId;
      next();
      return;
    }

    const packet = replay.proofPacket(eventId);
    if (!packet) {
      res.status(404).json({
        error: "proof_event_not_found",
        message:
          "The event has not appeared in the replay yet. Step or run the replay before requesting its proof.",
      });
      return;
    }
    const now = Date.now();
    for (const [quoteId, frozen] of frozenProofQuotes) {
      if (frozen.expiresAt <= now) frozenProofQuotes.delete(quoteId);
    }
    while (frozenProofQuotes.size >= MAX_FROZEN_PROOF_QUOTES) {
      const oldest = frozenProofQuotes.keys().next().value as string | undefined;
      if (!oldest) break;
      frozenProofQuotes.delete(oldest);
    }
    frozenProofQuotes.set(frozenQuoteKey(sessionId, packet.packetHash), {
      sessionId,
      matchId,
      eventId,
      packet,
      expiresAt: now + PROOF_QUOTE_TTL_MS,
    });
    res.locals.packet = packet;
    res.locals.proofQuoteId = packet.packetHash;
    next();
  };

  app.get(
    "/api/matches/:matchId/proof",
    prepareProof,
    createX402Middleware(config.x402),
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
          dataMode: "historical-replay",
          disclosure: dataset.match.replayDisclosure,
          sourceNotice: dataset.match.sourceNotice,
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
      const report = verifyProofPacket(candidate);
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
            reason: `Fresh registry verification was unavailable: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
      }
      res.status(report.valid ? 200 : 422).json({
        ...report,
        integrityOnly: true,
        onchain,
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
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }));

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "route_not_found" });
  });

  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({
        error: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      });
    },
  );

  return { app, engine, config, dataset, anchorService, dispose };
}

export function createApp(options: ApiOptions = {}): Express {
  return createApi(options).app;
}
