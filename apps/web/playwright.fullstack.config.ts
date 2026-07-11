import { defineConfig } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const webRoot = fileURLToPath(new URL(".", import.meta.url));
const testIssuerPrivateKey = `0x${randomBytes(32).toString("hex")}`;
const chainMode =
  process.env.PROOFLINE_FULLSTACK_TESTNET === "1"
    ? "injective-testnet"
    : "demo";
const loopbackNoProxy = ["127.0.0.1", "localhost", process.env.NO_PROXY]
  .filter(Boolean)
  .join(",");

// Playwright's web-server readiness probe inherits the shell proxy. Explicitly
// bypass it so a corporate proxy cannot swallow loopback health checks.
process.env.NO_PROXY = loopbackNoProxy;
process.env.no_proxy = loopbackNoProxy;

export default defineConfig({
  testDir: "./fullstack",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4174",
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command:
        `NODE_ENV=test HOST=127.0.0.1 PORT=8791 CHAIN_MODE=${chainMode} X402_MODE=demo PROOFLINE_PROOF_ENTITLEMENT_FILE= PROOFLINE_ISSUER_PRIVATE_KEY=${testIssuerPrivateKey} ./node_modules/.bin/tsx apps/api/src/index.ts`,
      cwd: repositoryRoot,
      url: "http://127.0.0.1:8791/api/health",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command:
        "VITE_API_PROXY_TARGET=http://127.0.0.1:8791 ../../node_modules/.bin/vite --host 127.0.0.1 --port 4174",
      cwd: webRoot,
      url: "http://127.0.0.1:4174",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
