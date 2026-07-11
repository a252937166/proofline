import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { keccak256, stringToHex, type Hex } from "viem";

export const INJECTIVE_TESTNET_CHAIN_ID = 1_439;
export const INJECTIVE_TESTNET_NETWORK = "eip155:1439";
export const INJECTIVE_TESTNET_USDC =
  "0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d";
export const X402_PRICE_ATOMIC = 10_000n;
export const PROOFLINE_REGISTRY_ID_TEXT =
  "proofline.match-proof-registry.v3";
export const PROOFLINE_REGISTRY_ID = keccak256(
  stringToHex(PROOFLINE_REGISTRY_ID_TEXT),
);

export function isBytes32(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

export function assertMatchingEvidenceRoot(
  expected: unknown,
  actual: unknown,
): asserts expected is Hex {
  if (!isBytes32(expected) || expected === `0x${"0".repeat(64)}`) {
    throw new Error("The prepared evidenceRoot must be a non-zero bytes32 commitment");
  }
  if (!isBytes32(actual) || actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error("The on-chain evidenceRoot does not match the prepared evidence commitment");
  }
}

export const TESTNET_WRITE_ACK = {
  anchor: "I_UNDERSTAND_ONE_INJECTIVE_TESTNET_ANCHOR_WILL_BE_SENT",
  payment: "I_UNDERSTAND_0.01_TEST_USDC_WILL_BE_SETTLED",
} as const;

export type TestnetWriteAction = keyof typeof TESTNET_WRITE_ACK;

export function setEnvValue(
  content: string,
  key: string,
  value: string,
): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new Error(`Invalid dotenv key: ${key}`);
  }
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error(`Refusing a multiline dotenv value for ${key}`);
  }
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  return pattern.test(content)
    ? content.replace(pattern, line)
    : `${content.trimEnd()}\n${line}\n`;
}

export function updateEnvText(
  content: string,
  values: Readonly<Record<string, string>>,
): string {
  return Object.entries(values).reduce(
    (current, [key, value]) => setEnvValue(current, key, value),
    content,
  );
}

/**
 * Atomically updates a gitignored dotenv file without ever returning or
 * logging its contents. The final mode is always owner read/write only.
 */
export async function updateEnvFile(
  filePath: string,
  values: Readonly<Record<string, string>>,
): Promise<{ updatedKeys: string[] }> {
  const current = await readFile(filePath, "utf8");
  const updated = updateEnvText(current, values);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, updated, { encoding: "utf8", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return { updatedKeys: Object.keys(values) };
}

export function writeIsAuthorized(
  action: TestnetWriteAction,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): boolean {
  const requiredFlag = action === "anchor" ? "--broadcast" : "--pay";
  return (
    args.includes(requiredFlag) &&
    env.PROOFLINE_TESTNET_WRITE_ACK === TESTNET_WRITE_ACK[action]
  );
}

export function requireWriteAuthorization(
  action: TestnetWriteAction,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): void {
  if (writeIsAuthorized(action, args, env)) return;
  const flag = action === "anchor" ? "--broadcast" : "--pay";
  throw new Error(
    `Refusing the ${action} transaction. Pass ${flag} and set PROOFLINE_TESTNET_WRITE_ACK=${TESTNET_WRITE_ACK[action]} for this one command.`,
  );
}

export function prooflineSessionId(
  value = process.env.PROOFLINE_SESSION_ID,
): string {
  const sessionId = value?.trim() || "proofline-testnet-judge";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(sessionId)) {
    throw new Error(
      "PROOFLINE_SESSION_ID must contain 8-64 letters, digits, underscores, or hyphens",
    );
  }
  return sessionId;
}

export function assertAllowedApiOrigin(
  resource: URL,
  configuredOrigin = process.env.PROOFLINE_API_ORIGIN,
): void {
  const allowed = configuredOrigin?.trim()
    ? new URL(configuredOrigin).origin
    : "http://127.0.0.1:8787";
  if (resource.origin !== allowed) {
    throw new Error(
      `Refusing Proofline API origin ${resource.origin}; allowed origin is ${allowed}`,
    );
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
    resource.hostname,
  );
  if (resource.protocol !== "https:" && !(resource.protocol === "http:" && loopback)) {
    throw new Error("Proofline API must use HTTPS unless it is on loopback");
  }
}
