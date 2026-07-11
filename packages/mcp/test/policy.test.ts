import { afterEach, describe, expect, it } from "vitest";

import { type ApiResponse } from "../src/api.js";
import { CCTP_SOURCE_DEFAULTS, cctpSourceNetworks } from "../src/cctp.js";
import {
  SpendPolicy,
  extractPaymentRequirements,
  formatUsdc,
  parseUsdc,
} from "../src/policy.js";

const savedEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnvironment };
});

describe("CCTP source configuration", () => {
  it("uses Circle's Base Sepolia test USDC address", () => {
    expect(CCTP_SOURCE_DEFAULTS["base-sepolia"].usdc).toBe(
      "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    );
    expect(cctpSourceNetworks({})["base-sepolia"].usdc).toBe(
      CCTP_SOURCE_DEFAULTS["base-sepolia"].usdc,
    );
  });
});

describe("x402 policy", () => {
  it("parses the API's standard 402 requirement and permits only the explicit sandbox payee", () => {
    const response: ApiResponse = {
      status: 402,
      headers: {},
      data: {
        mode: "demo-sandbox",
        accepts: [
          {
            scheme: "exact",
            network: "eip155:1439",
            asset: "0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d",
            amount: "10000",
            payTo: "0x0000000000000000000000000000000000000000",
          },
        ],
      },
    };
    const [requirement] = extractPaymentRequirements(response);
    expect(requirement).toBeDefined();
    const policy = new SpendPolicy();
    expect(() => policy.validate(requirement!, true)).not.toThrow();
    expect(() =>
      policy.validate({ ...requirement!, scheme: "upto" }, true),
    ).toThrow(/scheme is not exact/);
    expect(() => policy.validate(requirement!, false)).toThrow(/PAYEE|payee/i);
    expect(policy.reserve(requirement!, true, true).sessionSpentUsdc).toBe("0");
  });

  it("keeps exact six-decimal USDC accounting", () => {
    expect(parseUsdc("0.02")).toBe(20_000n);
    expect(formatUsdc(parseUsdc("0.100000"))).toBe("0.1");
    expect(() => parseUsdc("0.0000001")).toThrow();
  });
});
