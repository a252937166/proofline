import { fileURLToPath } from "node:url";

import { generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { readRuntimeConfig } from "../src/config.js";
import { loadEnvironment } from "../src/env.js";

describe("root environment loading", () => {
  it("loads a dotenv file into an isolated target and understands repository aliases", () => {
    const target: Record<string, string | undefined> = {};
    const fixturePath = fileURLToPath(
      new URL("./fixtures/root.env", import.meta.url),
    );

    expect(loadEnvironment(fixturePath, target)).toEqual({
      path: fixturePath,
      loaded: true,
    });
    const config = readRuntimeConfig(target);
    expect(config.apiFootballToken).toBe("fixture-api-football-key");
    expect(config.anchor).toMatchObject({
      mode: "injective-testnet",
      rpcUrl: "https://example.invalid/injective-rpc",
      registryAddress: "0x1111111111111111111111111111111111111111",
    });
    expect(config.x402).toMatchObject({
      mode: "live",
      configured: false,
    });
  });

  it("refuses an RPC chain identifier outside Injective EVM testnet", () => {
    expect(() =>
      readRuntimeConfig({ INJECTIVE_TESTNET_CHAIN_ID: "1776" }),
    ).toThrow("INJECTIVE_TESTNET_CHAIN_ID must be 1439");
  });

  it("supports an explicit loopback production listener and validates the port", () => {
    expect(readRuntimeConfig({ HOST: "127.0.0.1", PORT: "4035" })).toMatchObject({
      host: "127.0.0.1",
      port: 4035,
    });
    expect(() => readRuntimeConfig({ HOST: "proofline.example" })).toThrow(
      "HOST must be an IPv4/IPv6 address or localhost",
    );
    expect(() => readRuntimeConfig({ PORT: "70000" })).toThrow(
      "PORT must be an integer between 1 and 65535",
    );
  });

  it("keeps the deploy script's documented registry variable authoritative", () => {
    const config = readRuntimeConfig({
      CHAIN_MODE: "injective-testnet",
      ANCHOR_PRIVATE_KEY: generatePrivateKey(),
      PROOF_REGISTRY_ADDRESS: "0x1111111111111111111111111111111111111111",
      INJECTIVE_REGISTRY_ADDRESS: "0x2222222222222222222222222222222222222222",
    });
    expect(config.anchor).toMatchObject({
      mode: "injective-testnet",
      registryAddress: "0x1111111111111111111111111111111111111111",
    });
  });

  it("refuses x402 invariant overrides", () => {
    expect(() => readRuntimeConfig({ X402_PRICE: "999999" })).toThrow(
      "X402_PRICE must be 10000",
    );
    expect(() => readRuntimeConfig({ X402_NETWORK: "eip155:1776" })).toThrow(
      "X402_NETWORK must be eip155:1439",
    );
  });

  it("requires a protected receipt router for the production inline facilitator", () => {
    const privateKey = generatePrivateKey();
    const payTo = "0x1111111111111111111111111111111111111111";
    expect(
      readRuntimeConfig({
        NODE_ENV: "production",
        X402_MODE: "live",
        X402_PAY_TO: payTo,
        X402_FACILITATOR_PRIVATE_KEY: privateKey,
      }).x402,
    ).toMatchObject({ mode: "live", configured: false });
    expect(
      readRuntimeConfig({
        NODE_ENV: "production",
        PORT: "4035",
        X402_MODE: "live",
        X402_PAY_TO: payTo,
        X402_FACILITATOR_PRIVATE_KEY: privateKey,
        X402_RPC_PROXY_TOKEN: "a".repeat(32),
      }).x402,
    ).toMatchObject({
      mode: "live",
      configured: true,
      facilitatorRpcUrl: `http://127.0.0.1:4035/api/internal/evm-rpc/${"a".repeat(32)}`,
    });
  });

  it("accepts an optional crash-safe x402 ledger file", () => {
    expect(
      readRuntimeConfig({
        X402_MODE: "live",
        PROOFLINE_X402_LEDGER_FILE: "/tmp/proofline/x402-ledger.json",
      }).x402,
    ).toMatchObject({
      mode: "live",
      ledgerFile: "/tmp/proofline/x402-ledger.json",
    });
    expect(() =>
      readRuntimeConfig({
        PROOFLINE_X402_LEDGER_FILE: `bad\0path`,
      }),
    ).toThrow("PROOFLINE_X402_LEDGER_FILE");
  });

  it("requires HTTPS for remote trust endpoints and HTTP(S) on loopback", () => {
    expect(() =>
      readRuntimeConfig({ INJECTIVE_TESTNET_RPC: "http://rpc.example" }),
    ).toThrow("Injective RPC URL must use HTTPS");
    expect(() =>
      readRuntimeConfig({
        X402_MODE: "live",
        X402_FACILITATOR_URL: "http://facilitator.example/verify",
      }),
    ).toThrow("X402_FACILITATOR_URL must use HTTPS");
    expect(() =>
      readRuntimeConfig({ INJECTIVE_TESTNET_RPC: "ftp://127.0.0.1/rpc" }),
    ).toThrow("Injective RPC URL must use HTTP or HTTPS");
    expect(
      readRuntimeConfig({ INJECTIVE_TESTNET_RPC: "http://127.0.0.1:8545" })
        .anchor.mode,
    ).toBe("demo");
  });

  it("rejects secrets in browser-visible endpoint metadata", () => {
    expect(() =>
      readRuntimeConfig({
        PUBLIC_INJECTIVE_EXPLORER_URL:
          "https://user:secret@explorer.example/tx",
      }),
    ).toThrow("browser-visible");
    expect(() =>
      readRuntimeConfig({ PUBLIC_API_URL: "https://api.example/v1?key=secret" }),
    ).toThrow("browser-visible");
    expect(() =>
      readRuntimeConfig({
        PUBLIC_INJECTIVE_EXPLORER_API_URL:
          "https://explorer-api.example/api?key=secret",
      }),
    ).toThrow("browser-visible");
  });
});
