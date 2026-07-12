import type { AnchorService } from "./anchor.js";
import {
  INJECTIVE_TESTNET_NETWORK,
  INJECTIVE_TESTNET_USDC,
  X402_PRICE_ATOMIC,
  X402_PRICE_DISPLAY,
  type RuntimeConfig,
} from "./config.js";
import type { TestUsdcDispenserPublicStatus } from "./test-usdc-dispenser.js";

function providerStatus(input: {
  id: string;
  configured: boolean;
  environmentVariable: string;
  providerLabel: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    configured: input.configured,
    status: input.configured
      ? "credential-present-unverified"
      : "not-configured",
    environmentVariable: input.environmentVariable,
    capability: "credential-presence-only",
    disclosure: input.configured
      ? `${input.providerLabel} credentials are present server-side but are not an active data feed. Provider authorization and a successful fetch must be verified before live mode can be enabled.`
      : `${input.providerLabel} is optional and disabled because no server-side token is configured.`,
  };
}

export function integrationStatus(
  config: RuntimeConfig,
  anchorService: AnchorService,
  testUsdcDispenser: TestUsdcDispenserPublicStatus,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const anchor = anchorService.status();
  const anchorRequestedButIncomplete =
    ["testnet", "injective-testnet"].includes(
      (env.INJECTIVE_ANCHOR_MODE ?? env.CHAIN_MODE ?? "").toLowerCase(),
    ) &&
    config.anchor.mode === "demo";
  const x402Live = config.x402.mode === "live";
  const testnetAnchorReadyForPayment =
    config.anchor.mode === "injective-testnet" &&
    anchor.mode === "injective-testnet" &&
    anchor.simulated === false;
  const x402Configured =
    config.x402.mode === "live"
      ? config.x402.configured && testnetAnchorReadyForPayment
      : true;

  return {
    schema: "proofline.integrations.v1",
    dataMode: {
      active: "multi-mode-catalog",
      available: ["delayed", "scheduled", "historical-replay"],
      liveProviderActive: false,
      disclosure:
        "2026 delayed/scheduled snapshots and a 2022 historical replay are available. No route claims live provider data.",
    },
    providers: {
      apiFootball: providerStatus({
        id: "api-football",
        configured: Boolean(config.apiFootballToken),
        environmentVariable: "API_FOOTBALL_KEY (or API_FOOTBALL_TOKEN)",
        providerLabel: "API-Football",
      }),
      footballData: providerStatus({
        id: "football-data",
        configured: Boolean(config.footballDataToken),
        environmentVariable: "FOOTBALL_DATA_TOKEN",
        providerLabel: "football-data.org",
      }),
    },
    injective: {
      ...anchor,
      ...(anchorRequestedButIncomplete
        ? {
            status: "misconfigured",
            disclosure:
              "Injective testnet anchoring was requested but the private key or registry address is missing/invalid. The API has safely stayed in labelled demo mode.",
          }
        : {}),
    },
    x402: {
      mode: x402Live ? "live" : "demo-sandbox",
      status: x402Live
        ? x402Configured
          ? "configured-unverified"
          : "misconfigured"
        : "ready",
      simulated: !x402Live,
      protocolVersion: 2,
      network: INJECTIVE_TESTNET_NETWORK,
      asset: {
        symbol: "USDC",
        address: INJECTIVE_TESTNET_USDC,
        decimals: 6,
      },
      priceAtomic: X402_PRICE_ATOMIC,
      priceDisplay: X402_PRICE_DISPLAY,
      payTo:
        config.x402.mode === "live" ? config.x402.payTo ?? null : null,
      paymentHeader: "PAYMENT-SIGNATURE",
      disclosure: x402Live
        ? x402Configured
          ? "Official @injectivelabs/x402 middleware is configured for real Injective testnet USDC settlement and loads on demand."
          : "Live x402 was requested, but its payee/facilitator or the required Injective testnet anchor runtime is incomplete. Requests fail closed; no demo proof can trigger a real payment."
        : "Demo sandbox negotiates HTTP 402 without signing, transferring USDC, or creating a transaction. The response is visibly marked simulated.",
    },
    testUsdcDispenser,
    cctp: {
      status: "plan-only",
      configured: false,
      executable: false,
      source: "Base Sepolia · domain 6",
      destination: "Injective EVM testnet · domain 29",
      irisBaseUrl:
        env.CIRCLE_IRIS_BASE_URL ?? "https://iris-api-sandbox.circle.com",
      disclosure:
        "PLAN ONLY · Proofline validates the intended testnet route and requires approval before burn, but this repository does not execute approve, depositForBurn, Iris polling, receiveMessage, mint, or balance recheck.",
    },
  };
}
