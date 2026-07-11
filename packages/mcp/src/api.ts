import { randomUUID } from "node:crypto";

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  data: unknown;
}

export class ApiFailure extends Error {
  readonly response: ApiResponse;

  constructor(message: string, response: ApiResponse) {
    super(message);
    this.name = "ApiFailure";
    this.response = response;
  }
}

function safeHeaders(headers: Headers): Record<string, string> {
  const hidden = /^(authorization|cookie|set-cookie|payment-signature|x-payment)$/i;
  return Object.fromEntries([...headers.entries()].filter(([name]) => !hidden.test(name)));
}

async function responseData(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export class ProoflineApi {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly sessionId: string;

  constructor(
    baseUrl = process.env.PROOFLINE_API_BASE ?? "http://127.0.0.1:8787/api",
    timeoutMs = Number(process.env.PROOFLINE_MCP_TIMEOUT_MS ?? "10000"),
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    const parsedBaseUrl = new URL(this.baseUrl);
    const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
      parsedBaseUrl.hostname,
    );
    if (parsedBaseUrl.protocol !== "https:" && !loopback) {
      throw new Error(
        "PROOFLINE_API_BASE must use HTTPS unless it targets a loopback development host",
      );
    }
    this.sessionId =
      process.env.PROOFLINE_SESSION_ID ??
      `mcp_${randomUUID().replace(/-/g, "")}`;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 250 || timeoutMs > 60_000) {
      throw new Error("PROOFLINE_MCP_TIMEOUT_MS must be between 250 and 60000");
    }
    this.timeoutMs = timeoutMs;
  }

  async get(pathname: string, allowedStatuses: readonly number[] = []): Promise<ApiResponse> {
    return this.request(pathname, { method: "GET" }, allowedStatuses);
  }

  async post(
    pathname: string,
    body: unknown,
    allowedStatuses: readonly number[] = [],
  ): Promise<ApiResponse> {
    return this.request(
      pathname,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      allowedStatuses,
    );
  }

  async getWithHeaders(
    pathname: string,
    headers: Record<string, string>,
    allowedStatuses: readonly number[] = [],
  ): Promise<ApiResponse> {
    return this.request(pathname, { method: "GET", headers }, allowedStatuses);
  }

  private async request(
    pathname: string,
    init: RequestInit,
    allowedStatuses: readonly number[],
  ): Promise<ApiResponse> {
    const url = new URL(`${this.baseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers = new Headers(init.headers);
      headers.set("accept", "application/json");
      headers.set("user-agent", "proofline-mcp/0.1.0");
      headers.set("x-proofline-session", this.sessionId);
      const response = await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
        redirect: "error",
      });
      const result: ApiResponse = {
        status: response.status,
        headers: safeHeaders(response.headers),
        data: await responseData(response),
      };

      if (!response.ok && !allowedStatuses.includes(response.status)) {
        throw new ApiFailure(`Proofline API returned HTTP ${response.status}`, result);
      }
      return result;
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Proofline API timed out after ${this.timeoutMs} ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
