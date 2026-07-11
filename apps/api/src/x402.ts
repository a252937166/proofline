import { keccak256, stringToHex } from "viem";

import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  INJECTIVE_TESTNET_NETWORK,
  INJECTIVE_TESTNET_USDC,
  X402_PRICE_ATOMIC,
  type X402RuntimeConfig,
} from "./config.js";

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
): RequestHandler {
  if (
    !config.configured ||
    !config.payTo
  ) {
    return (_req, res) => {
      res.status(503).json({
        error: "x402_live_misconfigured",
        message:
          "X402_MODE=injective-testnet requires X402_PAY_TO plus either X402_FACILITATOR_PRIVATE_KEY or X402_FACILITATOR_URL. The API fails closed and will not fake payment success.",
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
                  rpcUrl: config.rpcUrl,
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
    try {
      const quoteId = proofQuoteId(res);
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (res.statusCode !== 402) return originalJson(body);
        const augmented = augmentOfficialQuote(body, quoteId);
        const encoded = base64(augmented);
        res.set("PAYMENT-REQUIRED", encoded);
        res.set("X-PAYMENT-REQUIRED", encoded);
        return originalJson(augmented);
      }) as typeof res.json;
      const middleware = await load();
      await middleware(req, res, () => {
        const paymentMeta = (
          req as Request & {
            x402?: {
              payer?: string;
              txHash?: string;
            };
          }
        ).x402;
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

export function createX402Middleware(config: X402RuntimeConfig): RequestHandler {
  return config.mode === "live" ? liveMiddleware(config) : demoMiddleware();
}
