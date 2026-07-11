import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";

export const ROOT_ENV_PATH = fileURLToPath(
  new URL("../../../.env", import.meta.url),
);

export function loadEnvironment(
  path = ROOT_ENV_PATH,
  processEnv: Record<string, string | undefined> = process.env,
): { path: string; loaded: boolean } {
  const result = loadDotenv({
    path,
    processEnv,
    override: false,
    quiet: true,
  });
  return { path, loaded: !result.error };
}
