import { isIP } from "node:net";

import type { Address, Hex } from "viem";

export const INJECTIVE_TESTNET_CHAIN_ID = 1_439;
export const INJECTIVE_TESTNET_NETWORK = "eip155:1439";
export const INJECTIVE_TESTNET_RPC_URL =
  "https://k8s.testnet.json-rpc.injective.network/";
export const INJECTIVE_TESTNET_EXPLORER_URL =
  "https://testnet.blockscout.injective.network";
export const INJECTIVE_TESTNET_EXPLORER_API_URL =
  "https://testnet.blockscout-api.injective.network/api";
export const INJECTIVE_TESTNET_USDC =
  "0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d" as Address;
export const X402_PRICE_ATOMIC = "10000";
export const X402_PRICE_DISPLAY = "0.01 USDC";

export type AnchorRuntimeConfig =
  | { mode: "demo" }
  | {
      mode: "injective-testnet";
      rpcUrl: string;
      privateKey: Hex;
      registryAddress: Address;
      chainId: number;
      explorerUrl: string;
      explorerApiUrl: string;
    };

export type X402RuntimeConfig =
  | { mode: "demo-sandbox" }
  | {
      mode: "live";
      configured: boolean;
      payTo?: Address;
      facilitatorPrivateKey?: Hex;
      facilitatorUrl?: string;
      facilitatorRpcUrl?: string;
      rpcProxyToken?: string;
      ledgerFile?: string;
      rpcUrl: string;
      publicApiUrl?: string;
    };

export interface RuntimeConfig {
  host: string;
  port: number;
  replayIntervalMs: number;
  apiFootballToken?: string;
  footballDataToken?: string;
  anchor: AnchorRuntimeConfig;
  x402: X402RuntimeConfig;
}

function isAddress(value: string | undefined): value is Address {
  return Boolean(value && /^0x[0-9a-fA-F]{40}$/.test(value));
}

function isPrivateKey(value: string | undefined): value is Hex {
  return Boolean(value && /^0x[0-9a-fA-F]{64}$/.test(value));
}

function optionalString(value: string | undefined): string | undefined {
  const clean = value?.trim();
  return clean ? clean : undefined;
}

function listenHost(value: string | undefined): string {
  const host = optionalString(value) ?? "0.0.0.0";
  if (host !== "localhost" && isIP(host) === 0) {
    throw new Error("HOST must be an IPv4/IPv6 address or localhost");
  }
  return host;
}

function listenPort(value: string | undefined): number {
  const port = Number(value ?? "8787");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

function assertSecureOrLoopbackUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
    parsed.hostname,
  );
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  if (parsed.protocol !== "https:" && !loopback) {
    throw new Error(`${label} must use HTTPS unless it targets loopback`);
  }
  return value;
}

function assertPublicEndpointUrl(value: string, label: string): string {
  assertSecureOrLoopbackUrl(value, label);
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      `${label} is browser-visible and must not contain credentials, query parameters, or a fragment`,
    );
  }
  return value;
}

export function readRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  if (
    optionalString(env.X402_NETWORK) &&
    optionalString(env.X402_NETWORK) !== INJECTIVE_TESTNET_NETWORK
  ) {
    throw new Error(`X402_NETWORK must be ${INJECTIVE_TESTNET_NETWORK}`);
  }
  if (
    optionalString(env.X402_USDC_ADDRESS) &&
    optionalString(env.X402_USDC_ADDRESS)?.toLowerCase() !==
      INJECTIVE_TESTNET_USDC.toLowerCase()
  ) {
    throw new Error("X402_USDC_ADDRESS must be canonical Injective testnet USDC");
  }
  if (
    optionalString(env.X402_PRICE) &&
    optionalString(env.X402_PRICE) !== X402_PRICE_ATOMIC
  ) {
    throw new Error(`X402_PRICE must be ${X402_PRICE_ATOMIC} atomic USDC`);
  }
  const anchorMode = (
    env.INJECTIVE_ANCHOR_MODE ?? env.CHAIN_MODE
  )?.toLowerCase();
  const anchorPrivateKey =
    optionalString(env.INJECTIVE_PRIVATE_KEY) ??
    optionalString(env.ANCHOR_PRIVATE_KEY);
  const registryAddress =
    optionalString(env.PROOF_REGISTRY_ADDRESS) ??
    optionalString(env.INJECTIVE_REGISTRY_ADDRESS);
  const rpcUrl =
    optionalString(env.INJECTIVE_RPC_URL) ??
    optionalString(env.INJECTIVE_TESTNET_RPC) ??
    INJECTIVE_TESTNET_RPC_URL;
  assertSecureOrLoopbackUrl(rpcUrl, "Injective RPC URL");
  const explorerUrl =
    optionalString(env.PUBLIC_INJECTIVE_EXPLORER_URL) ??
    INJECTIVE_TESTNET_EXPLORER_URL;
  assertPublicEndpointUrl(explorerUrl, "PUBLIC_INJECTIVE_EXPLORER_URL");
  const explorerApiUrl =
    optionalString(env.PUBLIC_INJECTIVE_EXPLORER_API_URL) ??
    INJECTIVE_TESTNET_EXPLORER_API_URL;
  assertPublicEndpointUrl(
    explorerApiUrl,
    "PUBLIC_INJECTIVE_EXPLORER_API_URL",
  );
  const chainId = Number(
    env.INJECTIVE_CHAIN_ID ??
      env.INJECTIVE_TESTNET_CHAIN_ID ??
      INJECTIVE_TESTNET_CHAIN_ID,
  );
  if (!Number.isSafeInteger(chainId) || chainId !== INJECTIVE_TESTNET_CHAIN_ID) {
    throw new Error(
      `Proofline is testnet-only: INJECTIVE_TESTNET_CHAIN_ID must be ${INJECTIVE_TESTNET_CHAIN_ID}.`,
    );
  }

  const anchor: AnchorRuntimeConfig =
    (anchorMode === "testnet" || anchorMode === "injective-testnet") &&
    isPrivateKey(anchorPrivateKey) &&
    isAddress(registryAddress)
      ? {
          mode: "injective-testnet",
          rpcUrl,
          privateKey: anchorPrivateKey,
          registryAddress,
          chainId,
          explorerUrl,
          explorerApiUrl,
        }
      : { mode: "demo" };

  const x402Mode = env.X402_MODE?.toLowerCase();
  const facilitatorPrivateKey = optionalString(
    env.X402_FACILITATOR_PRIVATE_KEY,
  );
  const payTo = optionalString(env.X402_PAY_TO);
  const facilitatorUrl = optionalString(env.X402_FACILITATOR_URL);
  const rpcProxyToken = optionalString(env.X402_RPC_PROXY_TOKEN);
  const ledgerFile = optionalString(env.PROOFLINE_X402_LEDGER_FILE);
  if (ledgerFile && (ledgerFile.includes("\0") || ledgerFile.length > 4_096)) {
    throw new Error("PROOFLINE_X402_LEDGER_FILE must be a valid filesystem path");
  }
  if (
    rpcProxyToken &&
    !/^[A-Za-z0-9_-]{32,128}$/.test(rpcProxyToken)
  ) {
    throw new Error(
      "X402_RPC_PROXY_TOKEN must be 32-128 letters, digits, underscores, or hyphens",
    );
  }
  const configuredFacilitatorRpcUrl = optionalString(
    env.X402_FACILITATOR_RPC_URL,
  );
  if (configuredFacilitatorRpcUrl) {
    assertSecureOrLoopbackUrl(
      configuredFacilitatorRpcUrl,
      "X402_FACILITATOR_RPC_URL",
    );
  }
  const facilitatorRpcUrl =
    configuredFacilitatorRpcUrl ??
    (rpcProxyToken
      ? `http://127.0.0.1:${listenPort(env.PORT)}/api/internal/evm-rpc/${rpcProxyToken}`
      : undefined);
  const publicApiUrl = optionalString(env.PUBLIC_API_URL);
  if (facilitatorUrl) {
    assertSecureOrLoopbackUrl(facilitatorUrl, "X402_FACILITATOR_URL");
  }
  if (publicApiUrl) assertPublicEndpointUrl(publicApiUrl, "PUBLIC_API_URL");

  let x402: X402RuntimeConfig;
  if (x402Mode === "live" || x402Mode === "injective-testnet") {
    x402 = {
      mode: "live",
      configured:
        isAddress(payTo) &&
        (Boolean(facilitatorUrl) ||
          (isPrivateKey(facilitatorPrivateKey) &&
            (env.NODE_ENV !== "production" || Boolean(rpcProxyToken)))),
      ...(isPrivateKey(facilitatorPrivateKey)
        ? { facilitatorPrivateKey }
        : {}),
      ...(isAddress(payTo) ? { payTo } : {}),
      ...(facilitatorUrl ? { facilitatorUrl } : {}),
      ...(facilitatorRpcUrl ? { facilitatorRpcUrl } : {}),
      ...(rpcProxyToken ? { rpcProxyToken } : {}),
      ...(ledgerFile ? { ledgerFile } : {}),
      ...(publicApiUrl ? { publicApiUrl } : {}),
      rpcUrl,
    };
  } else {
    x402 = { mode: "demo-sandbox" };
  }

  const apiFootballToken =
    optionalString(env.API_FOOTBALL_TOKEN) ??
    optionalString(env.API_FOOTBALL_KEY);
  const footballDataToken = optionalString(env.FOOTBALL_DATA_TOKEN);

  return {
    host: listenHost(env.HOST),
    port: listenPort(env.PORT),
    replayIntervalMs: 650,
    ...(apiFootballToken ? { apiFootballToken } : {}),
    ...(footballDataToken ? { footballDataToken } : {}),
    anchor,
    x402,
  };
}
