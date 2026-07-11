import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface McpHeartbeat {
  sessionId: string;
  serverVersion: string;
  transport: "stdio";
  tools: string[];
  at: string;
}

export interface McpToolExecution {
  id: string;
  sessionId: string;
  tool: string;
  inputSummary: Record<string, unknown>;
  outcome: "success" | "failure";
  resultSummary: string;
  durationMs: number;
  at: string;
}

interface PersistedRuntime {
  heartbeat: McpHeartbeat | null;
  logs: McpToolExecution[];
}

const MAX_LOGS = 100;
const FRESH_HEARTBEAT_MS = 2 * 60_000;

function validDate(value: string): boolean {
  return Number.isFinite(new Date(value).getTime());
}

export class McpRuntimeStore {
  private heartbeat: McpHeartbeat | null = null;
  private readonly logs: McpToolExecution[] = [];

  constructor(private readonly filePath?: string) {
    if (!filePath || !existsSync(filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as PersistedRuntime;
      if (parsed.heartbeat && validDate(parsed.heartbeat.at)) {
        this.heartbeat = parsed.heartbeat;
      }
      if (Array.isArray(parsed.logs)) {
        this.logs.push(...parsed.logs.slice(-MAX_LOGS));
      }
    } catch {
      // A corrupt audit cache must never prevent the evidence API from booting.
      this.heartbeat = null;
      this.logs.length = 0;
    }
  }

  recordHeartbeat(heartbeat: McpHeartbeat): void {
    this.heartbeat = structuredClone(heartbeat);
    this.persist();
  }

  recordExecution(execution: McpToolExecution): void {
    this.logs.push(structuredClone(execution));
    if (this.logs.length > MAX_LOGS) {
      this.logs.splice(0, this.logs.length - MAX_LOGS);
    }
    this.persist();
  }

  snapshot(now = new Date()): Record<string, unknown> {
    const heartbeatAgeMs = this.heartbeat
      ? Math.max(0, now.getTime() - new Date(this.heartbeat.at).getTime())
      : null;
    const runtimeConnected =
      heartbeatAgeMs !== null && heartbeatAgeMs <= FRESH_HEARTBEAT_MS;
    return {
      schema: "proofline.mcp-runtime.v1",
      implementationAvailable: true,
      runtimeConnected,
      health: this.heartbeat
        ? runtimeConnected
          ? "online"
          : "stale"
        : "never-seen",
      agentReady: runtimeConnected,
      heartbeatAgeMs,
      heartbeat: this.heartbeat ? structuredClone(this.heartbeat) : null,
      logs: [...this.logs].reverse().map((entry) => structuredClone(entry)),
      disclosure: runtimeConnected
        ? "Agent-ready is true because a real MCP stdio runtime heartbeat is fresh. Logs are emitted by actual tool handlers."
        : "The MCP implementation exists, but no fresh runtime heartbeat is connected. Agent-ready is false; no illustrative trace is presented as execution evidence.",
    };
  }

  private persist(): void {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(
        temporary,
        JSON.stringify({ heartbeat: this.heartbeat, logs: this.logs }, null, 2),
        { mode: 0o600 },
      );
      renameSync(temporary, this.filePath);
    } catch {
      // Runtime evidence persistence is best-effort; the API remains available
      // and still exposes the current in-memory health state.
    }
  }
}
