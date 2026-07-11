import { keccak256, stringToHex } from "viem";

import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  INJECTIVE_TESTNET_NETWORK,
  INJECTIVE_TESTNET_USDC,
  X402_PRICE_ATOMIC,
  type X402RuntimeConfig,
} from "./config.js";
import {
  parseX402PaymentIdentity,
  X402SettlementLedger,
  type X402PaymentIdentity,
} from "./x402-ledger.js";

const DEMO_PAY_TO = "0x0000000000000000000000000000000000000000";
const DEMO_DISCLOSURE =
  "DEMO X402 SANDBOX · no EIP-3009 signature is created, no USDC is transferred, and no transaction is submitted.";

export interface PaymentResult {
  mode: "demo-sandbox" | "live";
  simulated: boolean;
  valueTransferred: boolean;
  receiptId?: string;
  transactionHash?: string;
  payer?: string;
  cached?: boolean;
  alreadyPaid?: boolean;
  disclosure: string;
}

function base64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function resourceUrl(req: Request, publicApiUrl?: string): string {
  if (publicApiUrl) {
    const base = publicApiUrl.replace(/\/$/, "");
    const apiIndex = req.originalUrl.indexOf("/api/");
    return `${base}${apiIndex >= 0 ? req.originalUrl.slice(apiIndex + 4) : req.originalUrl}`;
  }
  return `${req.protocol}://${req.get("host")}${req.originalUrl}`;
}

function proofQuoteId(res: Response): string {
  const value = res.locals.proofQuoteId;
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("Proof packet quote ID was not prepared before x402 negotiation");
  }
  return value;
}

function demoToken(req: Request, quoteId: string): string {
  return `demo.${keccak256(
    stringToHex(
      `proofline.demo.x402.v2:${req.method}:${req.originalUrl}:${quoteId}`,
    ),
  ).slice(2, 18)}.${quoteId.slice(2)}`;
}

function demoPaymentRequired(
  req: Request,
  quoteId: string,
  error?: string,
) {
  const token = demoToken(req, quoteId);
  const body = {
    error: "payment_required",
    code: "PROOFLINE_X402_PAYMENT_REQUIRED",
    x402Version: 2,
    mode: "demo-sandbox",
    simulated: true,
    proofPacketHash: quoteId,
    disclosure: DEMO_DISCLOSURE,
    ...(error ? { message: error } : {}),
    resource: {
      url: resourceUrl(req),
      description: "Portable multi-source match verification packet",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: INJECTIVE_TESTNET_NETWORK,
        asset: INJECTIVE_TESTNET_USDC,
        amount: X402_PRICE_ATOMIC,
        payTo: DEMO_PAY_TO,
        maxTimeoutSeconds: 60,
        extra: {
          name: "USDC",
          version: "2",
          assetTransferMethod: "eip3009",
          simulated: true,
          prooflineQuoteId: quoteId,
        },
      },
    ],
    demoSandbox: {
      paymentSignature: token,
      header: "PAYMENT-SIGNATURE",
      format: "demo-token-not-eip3009",
      valueTransferred: false,
      instructions:
        "Retry this exact URL with the displayed PAYMENT-SIGNATURE token. This exercises the 402 control flow only and cannot move funds.",
    },
  };
  return body;
}

function demoMiddleware(): RequestHandler {
  return (req, res, next) => {
    const quoteId = proofQuoteId(res);
    const supplied =
      req.get("PAYMENT-SIGNATURE") ?? req.get("X-PAYMENT") ?? undefined;
    const required = demoPaymentRequired(
      req,
      quoteId,
      supplied ? "The supplied demo sandbox token is invalid." : undefined,
    );
    const encoded = base64(required);

    if (supplied !== required.demoSandbox.paymentSignature) {
      res.set("PAYMENT-REQUIRED", encoded);
      res.set("X-PAYMENT-REQUIRED", encoded);
      res.status(402).json(required);
      return;
    }

    const receiptId = `demo-x402-${keccak256(
      stringToHex(`proofline.demo.x402.receipt.v1:${req.originalUrl}`),
    ).slice(2, 18)}`;
    const payment: PaymentResult = {
      mode: "demo-sandbox",
      simulated: true,
      valueTransferred: false,
      receiptId,
      disclosure: DEMO_DISCLOSURE,
    };
    res.locals.payment = payment;
    const response = {
      success: true,
      simulated: true,
      valueTransferred: false,
      receiptId,
      network: INJECTIVE_TESTNET_NETWORK,
      disclosure: DEMO_DISCLOSURE,
    };
    const responseHeader = base64(response);
    res.set("PAYMENT-RESPONSE", responseHeader);
    res.set("X-PAYMENT-RESPONSE", responseHeader);
    next();
  };
}

function augmentOfficialQuote(body: unknown, quoteId: string): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const source = body as Record<string, unknown>;
  if (!Array.isArray(source.accepts)) return body;

  return {
    ...source,
    extensions: {
      ...(source.extensions && typeof source.extensions === "object"
        ? (source.extensions as Record<string, unknown>)
        : {}),
      proofline: { packetHash: quoteId, frozen: true },
    },
    accepts: source.accepts.map((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return candidate;
      }
      const requirement = candidate as Record<string, unknown>;
      return {
        ...requirement,
        extra: {
          ...(requirement.extra && typeof requirement.extra === "object"
            ? (requirement.extra as Record<string, unknown>)
            : {}),
          prooflineQuoteId: quoteId,
        },
      };
    }),
  };
}

type OfficialMiddlewareModule = {
  injectivePaymentMiddleware: (
    routes: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => RequestHandler;
};

function liveMiddleware(
  config: Extract<X402RuntimeConfig, { mode: "live" }>,
  ledger: X402SettlementLedger,
): RequestHandler {
  if (
    !config.configured ||
    !config.payTo
  ) {
    return (_req, res) => {
      res.status(503).json({
        error: "x402_live_misconfigured",
        message:
          "X402_MODE=injective-testnet requires X402_PAY_TO plus either X402_FACILITATOR_URL or an inline facilitator key. Production inline settlement also requires X402_RPC_PROXY_TOKEN. The API fails closed and will not fake payment success.",
      });
    };
  }

  let resolved: Promise<RequestHandler> | undefined;
  const load = () => {
    resolved ??= (async () => {
      const moduleSpecifier = "@injectivelabs/x402/middleware";
      const module = (await import(moduleSpecifier)) as OfficialMiddlewareModule;
      return module.injectivePaymentMiddleware(
        {
          "GET /api/matches/:matchId/proof": {
            description: "Portable multi-source match verification packet",
            mimeType: "application/json",
            accepts: [
              {
                network: INJECTIVE_TESTNET_NETWORK,
                asset: INJECTIVE_TESTNET_USDC,
                amount: X402_PRICE_ATOMIC,
                payTo: config.payTo,
                maxTimeoutSeconds: 60,
              },
            ],
          },
        },
        {
          ...(config.publicApiUrl ? { baseUrl: config.publicApiUrl } : {}),
          ...(config.facilitatorPrivateKey
            ? {
                facilitator: {
                  privateKey: config.facilitatorPrivateKey,
                  rpcUrl: config.facilitatorRpcUrl ?? config.rpcUrl,
                  allowedAssets: [INJECTIVE_TESTNET_USDC.toLowerCase()],
                  minPaymentPerAsset: {
                    [INJECTIVE_TESTNET_USDC.toLowerCase()]: "1000",
                  },
                },
              }
            : {}),
          ...(config.facilitatorUrl
            ? { facilitatorUrl: config.facilitatorUrl }
            : {}),
          settlementPolicy: "before",
        },
      );
    })();
    return resolved;
  };

  return async (req: Request, res: Response, next: NextFunction) => {
    const quoteId = proofQuoteId(res);
    const supplied =
      req.get("PAYMENT-SIGNATURE") ?? req.get("X-PAYMENT") ?? undefined;
    const sessionId = req.get("X-Proofline-Session")?.trim() || "default";
    let identity: X402PaymentIdentity | undefined;
    let settlementStarted = false;
    let officialStarted = false;

    if (supplied) {
      identity = parseX402PaymentIdentity(supplied, sessionId);
      if (!identity || identity.packetHash !== quoteId.toLowerCase()) {
        res.status(409).json({
          error: "payment_identity_invalid",
          message:
            "PAYMENT-SIGNATURE must bind payer, nonce, and this frozen proof packet. No facilitator call was made.",
        });
        return;
      }
      let decision;
      try {
        decision = ledger.begin(identity);
      } catch {
        res.status(503).json({
          error: "payment-ledger-unavailable",
          message:
            "The server could not durably reserve this payment authorization. No facilitator call was made; do not retry until storage is healthy.",
        });
        return;
      }
      if (decision.status === "pending") {
        res.status(409).json({
          error: "payment-pending",
          paymentState: "pending-uncertain",
          conflict: decision.conflict,
          packetHash: identity.packetHash,
          message:
            "This proof payment or EIP-3009 nonce is already in flight. No facilitator call was made; verify chain state before retrying.",
        });
        return;
      }
      if (decision.status === "settled") {
        if (decision.conflict === "nonce") {
          res.status(409).json({
            error: "payment-nonce-already-settled",
            paymentState: "settled",
            message:
              "This EIP-3009 nonce belongs to a different settled proof purchase. No facilitator call was made.",
          });
          return;
        }
        const record = decision.record;
        const payment: PaymentResult = {
          mode: "live",
          simulated: false,
          valueTransferred: false,
          cached: true,
          alreadyPaid: true,
          ...(record.transactionHash
            ? { transactionHash: record.transactionHash }
            : {}),
          payer: record.payer,
          disclosure:
            "Already paid: Proofline served the frozen packet from its settlement ledger without calling the facilitator or transferring USDC again.",
        };
        res.locals.payment = payment;
        const cachedReceipt = base64({
          success: true,
          cached: true,
          alreadyPaid: true,
          transaction: record.transactionHash,
          network: record.network,
          amount: record.amount,
          payer: record.payer,
          proofline: { packetHash: record.packetHash },
        });
        res.set("PAYMENT-RESPONSE", cachedReceipt);
        res.set("X-PAYMENT-RESPONSE", cachedReceipt);
        next();
        return;
      }
      settlementStarted = decision.status === "started";
    }

    let timedOut = false;
    const clearSettlementTimer = () => clearTimeout(settlementTimer);
    const settlementTimer = setTimeout(() => {
      if (res.headersSent) return;
      timedOut = true;
      res.status(503).json({
        error: "payment-uncertain",
        message:
          "The signed payment did not reach a final receipt within 55 seconds. Do not pay again yet; query the facilitator or transaction nonce before recovery.",
        recovery: [
          "Check PAYMENT-RESPONSE and the payer nonce.",
          "Query the official Injective Explorer transaction API.",
          "Retry only after proving the previous authorization was not settled.",
        ],
      });
    }, 55_000);
    res.once("finish", clearSettlementTimer);
    res.once("close", clearSettlementTimer);
    try {
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (res.statusCode !== 402) return originalJson(body);
        const paymentFailure =
          body && typeof body === "object" && !Array.isArray(body)
            ? (body as Record<string, unknown>).error
            : undefined;
        const reason = typeof paymentFailure === "string" ? paymentFailure : "";
        const explicitlyUncertain =
          reason === "payment_settlement_failed" ||
          reason.includes("nonce_already_used") ||
          reason.includes("nonce_check_failed");
        if (identity && settlementStarted && !explicitlyUncertain) {
          try {
            // Official verification rejected before its settle step. Only this
            // explicit pre-settlement outcome is safe to release for a fresh try.
            ledger.releaseUnsettled(identity);
            settlementStarted = false;
          } catch {
            res.removeHeader("PAYMENT-REQUIRED");
            res.removeHeader("X-PAYMENT-REQUIRED");
            res.status(503);
            return originalJson({
              error: "payment-ledger-unavailable",
              paymentState: "pending-uncertain",
              message:
                "Payment verification failed, but the durable pending record could not be cleared. Do not retry until chain and ledger state are reconciled.",
            });
          }
        }
        const augmented = augmentOfficialQuote(body, quoteId);
        const encoded = base64(augmented);
        res.set("PAYMENT-REQUIRED", encoded);
        res.set("X-PAYMENT-REQUIRED", encoded);
        return originalJson(augmented);
      }) as typeof res.json;
      const middleware = await load();
      officialStarted = true;
      await middleware(req, res, () => {
        const paymentMeta = (
          req as Request & {
            x402?: {
              payer?: string;
              txHash?: string;
            };
          }
        ).x402;
        if (identity && settlementStarted) {
          const transactionHash = paymentMeta?.txHash;
          if (
            typeof transactionHash !== "string" ||
            !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)
          ) {
            clearSettlementTimer();
            if (!timedOut && !res.headersSent) {
              res.status(503).json({
                error: "payment-uncertain",
                paymentState: "pending-uncertain",
                message:
                  "The facilitator reported success without a valid transaction hash. The authorization remains locked; do not pay again.",
              });
            }
            return;
          }
          try {
            ledger.markSettled(
              identity,
              transactionHash as `0x${string}`,
            );
            settlementStarted = false;
          } catch {
            clearSettlementTimer();
            if (!timedOut && !res.headersSent) {
              res.status(503).json({
                error: "payment-ledger-unavailable",
                paymentState: "settled-or-pending-uncertain",
                transactionHash,
                message:
                  "The payment may be settled, but its durable receipt could not be committed. Do not pay again; retrying this request in the same process is safe-cached.",
              });
            }
            return;
          }
        }
        if (timedOut || res.headersSent) return;
        const payment: PaymentResult = {
          mode: "live",
          simulated: false,
          valueTransferred: true,
          ...(paymentMeta?.txHash
            ? { transactionHash: paymentMeta.txHash }
            : {}),
          ...(paymentMeta?.payer ? { payer: paymentMeta.payer } : {}),
          disclosure:
            "Official @injectivelabs/x402 Injective testnet settlement. PAYMENT-RESPONSE is the payment receipt; an anchor transaction, when present, is a separate transaction.",
        };
        res.locals.payment = payment;
        next();
      });
    } catch (error) {
      clearSettlementTimer();
      if (timedOut || res.headersSent) return;
      // Dynamic import failure occurs before the official middleware starts and
      // is safe to release. Any error after invocation remains pending because
      // the settlement boundary may have been crossed.
      if (identity && settlementStarted && !officialStarted) {
        try {
          ledger.releaseUnsettled(identity);
        } catch {
          // The pending record intentionally remains fail closed.
        }
      }
      next(
        new Error(
          `Unable to load official @injectivelabs/x402 middleware: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  };
}

export function createX402Middleware(
  config: X402RuntimeConfig,
  ledger?: X402SettlementLedger,
): RequestHandler {
  return config.mode === "live"
    ? liveMiddleware(
        config,
        ledger ?? new X402SettlementLedger(config.ledgerFile),
      )
    : demoMiddleware();
}
