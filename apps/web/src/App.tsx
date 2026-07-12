import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { JudgeDemo } from "./components/JudgeDemo";
import { CaseSelector } from "./components/CaseSelector";
import {
  CatalogMatchView,
  ConflictReplayEntry,
  NoWalletAudit,
} from "./components/MatchCatalog";
import { useReplay, type ReplayAction } from "./hooks/useReplay";
import { useWallet, type UseWalletResult } from "./hooks/useWallet";
import { api, ApiError, PROOFLINE_SESSION_ID } from "./lib/api";
import type { DiscoveredWalletProvider } from "./lib/eip6963";
import {
  completeBrowserPaymentSignature,
  createBrowserPaymentAuthorization,
  readX402Requirement,
  type BrowserPaymentAuthorization,
  type BrowserSigningStep,
  type X402Requirement,
} from "./lib/wallet";
import type {
  AnchorRecord,
  CatalogMatchDetail,
  DecisionResponse,
  EventPayload,
  EventRecord,
  IntegrationsResponse,
  McpRuntimeResponse,
  MatchCatalogResponse,
  PaymentQuote,
  ProofPacketResponse,
  ProofVerificationResponse,
  ReplaySnapshot,
  SettlementDecision,
  VerificationResult,
} from "./types";

type DrawerStatus =
  | "idle"
  | "preparing"
  | "quoting"
  | "quoted"
  | "signature-ready"
  | "authorizing"
  | "binding-ready"
  | "binding"
  | "settling"
  | "verifying"
  | "delivered-unverified"
  | "uncertain"
  | "recovering"
  | "paid"
  | "error";

type Experience = "wallet" | "audit" | "replay";
const EXPERIENCE_OPTIONS = [
  ["wallet", "Real wallet test"],
  ["audit", "No-wallet audit"],
  ["replay", "Conflict replay"],
] as const;

interface ProofTarget {
  matchId: string;
  eventId: string;
  replay: boolean;
}

interface DrawerOperation {
  epoch: number;
  targetKey: string;
  controller: AbortController;
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}

const TESTNET_EXPLORER = "https://testnet.blockscout.injective.network";
const CCTP_SOURCE = "Base Sepolia";
const CCTP_DESTINATION = "Injective EVM testnet";
const BUILD_COMMIT = (import.meta.env.VITE_BUILD_COMMIT as string | undefined)?.trim() || "local-worktree";
const RELEASE_ID = (import.meta.env.VITE_RELEASE_ID as string | undefined)?.trim() || `dev-${BUILD_COMMIT.slice(0, 10)}`;

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    play: <path d="m8 5 10 7-10 7V5Z" />,
    pause: <><path d="M8 5v14" /><path d="M16 5v14" /></>,
    step: <><path d="m6 5 9 7-9 7V5Z" /><path d="M18 5v14" /></>,
    reset: <><path d="M4 4v6h6" /><path d="M5.7 17.2A8 8 0 1 0 6 6L4 10" /></>,
    external: <><path d="M15 4h5v5" /><path d="m10 14 10-10" /><path d="M20 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h6" /></>,
    shield: <path d="M12 3 5 6v5c0 4.8 2.9 8.1 7 10 4.1-1.9 7-5.2 7-10V6l-7-3Z" />,
    check: <path d="m5 12 4 4L19 6" />,
    close: <><path d="m6 6 12 12" /><path d="M18 6 6 18" /></>,
    arrow: <><path d="M5 12h14" /><path d="m14 7 5 5-5 5" /></>,
    wallet: <><path d="M4 7h15a1 1 0 0 1 1 1v10H5a1 1 0 0 1-1-1V7Z" /><path d="M5 7V5a1 1 0 0 1 1-1h11v3" /><path d="M16 11h4v4h-4a2 2 0 0 1 0-4Z" /></>,
    agent: <><rect x="5" y="7" width="14" height="12" rx="2" /><path d="M9 12h.01" /><path d="M15 12h.01" /><path d="M9 16h6" /><path d="M12 7V4" /></>,
    receipt: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" /><path d="M9 8h6" /><path d="M9 12h6" /></>,
  };

  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

function truncate(value: string | undefined, start = 8, end = 6): string {
  if (!value) return "Not available";
  if (value.length <= start + end + 3) return value;
  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

function percent(bps: number | undefined): string {
  return `${((bps ?? 0) / 100).toFixed(1)}%`;
}

function evidenceScore(bps: number | undefined): string {
  return `${((bps ?? 0) / 100).toFixed(1)}/100`;
}

function minuteLabel(payload?: EventPayload): string {
  if (!payload) return "—";
  if (payload.eventType === "kickoff") return "00′";
  return `${payload.minute}${payload.stoppage ? `+${payload.stoppage}` : ""}′`;
}

function eventTitle(payload?: EventPayload): string {
  if (!payload) return "Waiting for an observation";
  switch (payload.eventType) {
    case "kickoff":
      return "Match kicked off";
    case "goal":
      return `${payload.player ?? payload.team ?? "Goal"} scores`;
    case "card":
      return `${payload.card === "red" ? "Red" : "Yellow"} card · ${payload.player ?? payload.team ?? "Player"}`;
    case "substitution":
      return `${payload.player ?? "Substitute"} replaces ${payload.relatedPlayer ?? "player"}`;
    case "match_end":
      return "Final result recorded";
    case "period_end":
      return "Period ended";
  }
}

function eventCode(payload?: EventPayload): string {
  if (!payload) return "WAIT";
  switch (payload.eventType) {
    case "kickoff": return "KO";
    case "goal": return "GOAL";
    case "card": return payload.card === "red" ? "RC" : "YC";
    case "substitution": return "SUB";
    case "match_end": return "FT";
    case "period_end": return "HT";
  }
}

function statusCopy(state?: VerificationResult["state"]): string {
  switch (state) {
    case "verified": return "Verified";
    case "contested": return "Conflict quarantined";
    case "insufficient": return "Below threshold";
    case "observed": return "Awaiting corroboration";
    default: return "No evidence yet";
  }
}

function verificationStatus(verification?: VerificationResult): string {
  if (verification?.conflicts.length) return "Conflict quarantined";
  return statusCopy(verification?.state);
}

function activePayload(record?: EventRecord): EventPayload | undefined {
  return record?.verification?.canonical ?? record?.observations.find((item) => !item.retracted)?.payload;
}

function fallbackDecision(
  snapshot: ReplaySnapshot,
  verification?: VerificationResult,
  anchor?: AnchorRecord | null,
): SettlementDecision {
  const reasons: string[] = [];
  if (snapshot.match.status !== "finished") reasons.push("The match is not final.");
  if (verification?.state !== "verified") {
    reasons.push(`The event is ${verification?.state ?? "not observed"}, not verified.`);
  }
  if (!anchor?.receipt.confirmed) reasons.push("No confirmed anchor matches this event hash.");
  return {
    allowed: reasons.length === 0,
    state: reasons.length === 0 ? "open" : "held",
    reasons: reasons.length ? reasons : ["Result is final, verified, and anchored."],
  };
}

function formatTestUsdc(balance: bigint | null): string {
  if (balance === null) return "Checking…";
  const whole = balance / 1_000_000n;
  const fraction = (balance % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} test USDC`;
}

function WalletProviderIcon({ provider, size = 28 }: {
  provider: DiscoveredWalletProvider | null;
  size?: number;
}) {
  return provider?.info.icon ? (
    <img
      className="wallet-provider-icon"
      src={provider.info.icon}
      alt=""
      width={size}
      height={size}
    />
  ) : (
    <span className="wallet-provider-fallback" style={{ width: size, height: size }} aria-hidden="true">
      <Icon name="wallet" size={Math.max(16, size - 10)} />
    </span>
  );
}

function WalletControl({ wallet, open, onOpen, onClose }: {
  wallet: UseWalletResult;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const connected = Boolean(wallet.account && wallet.selectedProvider);
  const walletName = wallet.selectedProvider?.info.name ?? "Compatible wallet";
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const focusableSelector = "button:not(:disabled), a[href], select:not(:disabled), [tabindex]:not([tabindex='-1'])";
    const frame = window.requestAnimationFrame(() => {
      dialog?.querySelector<HTMLElement>(focusableSelector)?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector));
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    document.body.classList.add("wallet-modal-open");
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.classList.remove("wallet-modal-open");
      triggerRef.current?.focus();
    };
  }, [onClose, open]);
  return (
    <div className="wallet-control">
      <button
        ref={triggerRef}
        type="button"
        className={`wallet-trigger ${connected ? "is-connected" : ""}`}
        onClick={onOpen}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={connected ? `Wallet ${walletName}, account ${truncate(wallet.account ?? undefined, 6, 4)}` : "Connect test wallet with any compatible injected EVM wallet"}
        data-testid="wallet-trigger"
      >
        <WalletProviderIcon provider={wallet.selectedProvider} size={30} />
        <span>
          <strong>{connected ? walletName : "Connect test wallet"}</strong>
          <small>{connected ? truncate(wallet.account ?? undefined, 6, 4) : "Compatible injected EVM wallet"}</small>
        </span>
      </button>

      {open && (
        <div className="wallet-dialog-layer" role="presentation">
          <button className="wallet-dialog-scrim" type="button" aria-label="Dismiss wallet dialog" onClick={onClose} />
          <section ref={dialogRef} className="wallet-dialog" role="dialog" aria-modal="true" aria-labelledby="wallet-dialog-title">
            <header>
              <div><p className="eyebrow">Testnet access</p><h2 id="wallet-dialog-title">{connected ? "Wallet preflight" : "Choose a wallet"}</h2></div>
              <button type="button" className="wallet-dialog-close" onClick={onClose} aria-label="Close wallet dialog"><Icon name="close" /></button>
            </header>

            {connected ? (
              <div className="wallet-account-sheet">
                <div className="wallet-account-identity">
                  <WalletProviderIcon provider={wallet.selectedProvider} size={42} />
                  <span><strong>{walletName}</strong><code>{wallet.account}</code></span>
                </div>
                <dl>
                  <div><dt>Network</dt><dd>{wallet.chainId === "0x59f" ? "Injective EVM Testnet" : wallet.chainId ?? "Unknown"}</dd></div>
                  <div><dt>Balance</dt><dd>{formatTestUsdc(wallet.usdcBalance)}</dd></div>
                  <div><dt>Payment mode</dt><dd>Signed authorization · no wallet broadcast</dd></div>
                </dl>
                {wallet.error && <p className="wallet-inline-error" role="alert">{wallet.error}</p>}
                <div className="wallet-dialog-actions">
                  {wallet.status === "wrong-network" && <button type="button" className="wallet-primary" onClick={() => void wallet.switchNetwork()}>Switch to Injective testnet</button>}
                  {wallet.status === "low-balance" && <button type="button" onClick={() => void wallet.watchAsset()}>Add test USDC token</button>}
                  <button type="button" onClick={() => void wallet.refresh()}>Refresh preflight</button>
                  <button type="button" onClick={() => {
                    if (!wallet.account) return;
                    void navigator.clipboard.writeText(wallet.account).then(() => setCopied(true)).catch(() => setCopied(false));
                  }}>{copied ? "Address copied" : "Copy account address"}</button>
                  <a href={`${TESTNET_EXPLORER}/address/${wallet.account}`} target="_blank" rel="noreferrer">Open explorer <Icon name="external" size={13} /></a>
                  <button type="button" className="wallet-disconnect" onClick={() => { setCopied(false); wallet.disconnect(); }}>Choose another wallet</button>
                </div>
              </div>
            ) : (
              <div className="wallet-provider-list">
                <p>Proofline discovers injected EIP‑1193 wallets through EIP‑6963. Choose the provider you want to use for this testnet run.</p>
                {wallet.providers.length ? wallet.providers.map((provider) => (
                  <button
                    type="button"
                    key={provider.id}
                    onClick={() => void wallet.connect(provider)}
                    disabled={wallet.status === "connecting"}
                    data-testid="wallet-provider-option"
                  >
                    <WalletProviderIcon provider={provider} size={38} />
                    <span><strong>{provider.info.name}</strong><small>{provider.source === "eip6963" ? "EIP‑6963 provider" : "Browser-injected provider"}</small></span>
                    <Icon name="arrow" />
                  </button>
                )) : (
                  <div className="wallet-empty-state" role="status">
                    <Icon name="wallet" size={28} />
                    <strong>No compatible injected wallet detected</strong>
                    <p>Install or enable an EVM wallet that supports EIP‑712 typed-data signing, then scan again.</p>
                    <button type="button" onClick={wallet.requestDiscovery}>Scan for wallets</button>
                  </div>
                )}
                {wallet.error && <p className="wallet-inline-error" role="alert">{wallet.error}</p>}
                <small className="wallet-trust-note">Provider names and icons are self-reported display metadata. Proofline never receives or stores a private key.</small>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function AppHeader({ integrations, mode = "replay", catalog, activeMatchId, onSelectMatch, matchSelectionDisabled = false, wallet, walletDialogOpen = false, onOpenWallet, onCloseWallet }: {
  integrations: IntegrationsResponse | null;
  mode?: string;
  catalog?: MatchCatalogResponse | null;
  activeMatchId?: string | null;
  onSelectMatch?: (id: string) => void;
  matchSelectionDisabled?: boolean;
  wallet?: UseWalletResult;
  walletDialogOpen?: boolean;
  onOpenWallet?: () => void;
  onCloseWallet?: () => void;
}) {
  const chain = !integrations
    ? { label: "checking", tone: "checking" }
    : integrations.injective.mode === "demo"
      ? { label: "demo", tone: "demo" }
      : integrations.injective.status === "ready" && !integrations.injective.simulated
        ? { label: "testnet", tone: "ready" }
        : { label: "configured", tone: "configured" };
  const x402 = !integrations
    ? { label: "checking", tone: "checking" }
    : integrations.x402.mode === "demo-sandbox"
      ? { label: "sandbox", tone: "demo" }
      : integrations.x402.status === "ready" && !integrations.x402.simulated
        ? { label: "live", tone: "ready" }
        : { label: "configured", tone: "configured" };

  return (
    <header className="topbar">
      <a href="#match-sheet" className="wordmark" aria-label="Proofline home">
        <img src="/favicon.svg" alt="" width="28" height="28" />
        <span>PROOF</span><i /><span>LINE</span>
      </a>
      {catalog?.matches.length && activeMatchId && onSelectMatch ? (
        <CaseSelector
          catalog={catalog}
          activeMatchId={activeMatchId}
          onSelect={onSelectMatch}
          disabled={matchSelectionDisabled}
        />
      ) : <div className="mode-lockup" aria-label="Data mode" data-mode={mode}><span className="mode-pulse" /><div><strong>Loading evidence</strong><small>Checking runtime state</small></div></div>}
      <div className="integration-strip" aria-label="Integration modes">
        <span><i className={chain.tone} />Injective {chain.label}</span>
        <span><i className={x402.tone} />x402 testnet {x402.label === "live" ? "ready" : x402.label}</span>
      </div>
      {wallet && onOpenWallet && onCloseWallet && <WalletControl wallet={wallet} open={walletDialogOpen} onOpen={onOpenWallet} onClose={onCloseWallet} />}
    </header>
  );
}

function LoadingScreen() {
  return (
    <div className="app-shell" aria-busy="true" aria-label="Loading Proofline replay">
      <AppHeader integrations={null} />
      <div className="loading-disclosure"><span /> Loading attributed replay evidence…</div>
      <main className="loading-sheet">
        <section><div className="skeleton tiny" /><div className="skeleton score" /><div className="skeleton row" /><div className="skeleton row short" /></section>
        <section><div className="skeleton tiny" /><div className="skeleton headline" /><div className="skeleton proof" /><div className="skeleton row" /></section>
        <section><div className="skeleton tiny" /><div className="skeleton source" /><div className="skeleton source" /><div className="skeleton source short" /></section>
      </main>
    </div>
  );
}

function ErrorScreen({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="app-shell">
      <AppHeader integrations={null} />
      <main className="error-stage">
        <div className="error-flag">Replay service offline</div>
        <p className="eyebrow">Connection check / localhost:8787</p>
        <h1>The evidence rail has no signal.</h1>
        <p>{message}</p>
        <p className="error-direction">Start the Proofline API, then retry. No cached state is presented as current evidence.</p>
        <button className="primary-button" type="button" onClick={retry}>Retry connection <Icon name="arrow" /></button>
      </main>
    </div>
  );
}

function ReplayControls({ snapshot, busy, onAction }: {
  snapshot: ReplaySnapshot;
  busy: ReplayAction | null;
  onAction: (action: ReplayAction) => void;
}) {
  const { replay } = snapshot;
  const progress = replay.totalFrames ? (replay.cursor / replay.totalFrames) * 100 : 0;

  return (
    <section className="replay-control" aria-labelledby="replay-heading">
      <div className="section-heading">
        <div><p className="eyebrow">Judge path</p><h2 id="replay-heading">Evidence replay</h2></div>
        <span className={`run-state ${replay.running ? "is-running" : ""}`}>{replay.running ? "Running" : replay.complete ? "Complete" : "Paused"}</span>
      </div>
      <div className="transport" role="group" aria-label="Replay controls">
        <button
          type="button"
          className="transport-button"
          onClick={() => onAction("reset")}
          disabled={Boolean(busy) || replay.cursor === 0}
          aria-label="Reset replay"
          title="Reset replay"
        ><Icon name="reset" /></button>
        <button
          type="button"
          className="transport-button"
          onClick={() => onAction("step")}
          disabled={Boolean(busy) || replay.running || replay.complete}
          aria-label="Advance one evidence frame"
          title="Step one frame"
        ><Icon name="step" /></button>
        <button
          type="button"
          className="run-button"
          onClick={() => onAction(replay.running ? "pause" : "run")}
          disabled={Boolean(busy) || (replay.complete && !replay.running)}
        >
          <Icon name={replay.running ? "pause" : "play"} />
          {busy === "run" || busy === "pause" ? "Working…" : replay.running ? "Pause replay" : "Run replay"}
        </button>
      </div>
      <div className="replay-progress" aria-label={`Replay frame ${replay.cursor} of ${replay.totalFrames}`}>
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className="frame-caption">
        <span>Frame {String(replay.cursor).padStart(2, "0")} / {String(replay.totalFrames).padStart(2, "0")}</span>
        <span>{replay.nextFrame ? `Next: ${replay.nextFrame.label}` : "Replay complete"}</span>
      </div>
    </section>
  );
}

function Scoreboard({ snapshot }: { snapshot: ReplaySnapshot }) {
  const { match } = snapshot;
  const final = match.status === "finished";
  return (
    <section className="scoreboard" aria-labelledby="match-heading">
      <div className="competition-line">
        <span>{match.competition} · {match.season}</span>
        <strong>{final ? "FT" : match.status === "live" ? "IN PLAY" : "PRE-MATCH"}</strong>
      </div>
      <h1 className="sr-only" id="match-heading">{match.label}</h1>
      <div className="score-row">
        <span className="team home-team">{match.homeTeam}</span>
        <span className="score-number">{match.score.home}</span>
        <span className="score-divider">—</span>
        <span className="score-number">{match.score.away}</span>
        <span className="team away-team">{match.awayTeam}</span>
      </div>
      <div className="match-meta">
        <span>{new Date(match.startedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" })}</span>
        <span>{match.venue}</span>
        <span>{snapshot.mode.includes("replay") ? "Playback clock" : "Match clock"}</span>
      </div>
    </section>
  );
}

function EventTimeline({ records, selectedId, onSelect }: {
  records: EventRecord[];
  selectedId: string | null;
  onSelect: (eventId: string) => void;
}) {
  return (
    <section className="timeline" aria-labelledby="timeline-heading">
      <div className="section-heading compact">
        <div><p className="eyebrow">Canonical feed</p><h2 id="timeline-heading">Match timeline</h2></div>
        <span>{records.length} events</span>
      </div>
      {records.length === 0 ? (
        <div className="empty-timeline"><span>00′</span><p>Advance the replay to ingest the first source observation.</p></div>
      ) : (
        <ol>
          {records.map((record, index) => {
            const payload = activePayload(record);
            const isSelected = record.eventId === selectedId;
            return (
              <li
                key={record.eventId}
                className={record.verification?.conflicts.length ? "has-conflict" : ""}
                style={{ "--event-index": index } as CSSProperties}
              >
                <button type="button" onClick={() => onSelect(record.eventId)} aria-pressed={isSelected}>
                  <span className="timeline-minute">{minuteLabel(payload)}</span>
                  <span className={`event-token event-${payload?.eventType ?? "empty"}`}>{eventCode(payload)}</span>
                  <span className="timeline-copy"><strong>{eventTitle(payload)}</strong><small>{verificationStatus(record.verification)}</small></span>
                  <span className={`state-dot state-${record.verification?.conflicts.length ? "contested" : record.verification?.state ?? "empty"}`} />
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function Proofline({ record }: { record: EventRecord | undefined }) {
  const verification = record?.verification;
  const payload = activePayload(record);
  const confidence = (verification?.confidenceBps ?? 0) / 100;
  const threshold = (verification?.thresholdBps ?? 8200) / 100;
  const contested = Boolean(verification?.conflicts.length);
  const cleared = !contested && verification?.state === "verified" && confidence >= threshold;
  const motionKey = `${record?.eventId ?? "empty"}-${verification?.state ?? "empty"}-${verification?.confidenceBps ?? 0}-${verification?.conflicts.length ?? 0}`;

  return (
    <section className={`proof-surface state-${contested ? "contested" : verification?.state ?? "empty"}`} aria-labelledby="proof-heading">
      <div className="proof-header">
        <div>
          <p className="eyebrow light">Event under review · {record?.eventId ?? "awaiting-frame"}</p>
          <h2 id="proof-heading" key={`title-${motionKey}`}><span>{minuteLabel(payload)}</span>{eventTitle(payload)}</h2>
        </div>
        <div className="confidence-number">
          <small>Evidence score</small>
          <strong key={`confidence-${motionKey}`}>{evidenceScore(verification?.confidenceBps)}</strong>
          <span>{verificationStatus(verification)}</span>
        </div>
      </div>

      <div className="proofline-wrap">
        <div className="proofline-labels"><span>Observed</span><span>Policy threshold {threshold.toFixed(0)}/100</span><span>Verified</span></div>
        <div
          key={`track-${motionKey}`}
          className={`proofline-track ${contested ? "is-contested" : ""} ${cleared ? "is-cleared" : ""}`}
          role="meter"
          aria-label="Event evidence score"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={confidence}
        >
          <span className="pitch-mark center" />
          <span className="threshold-mark" style={{ left: `${threshold}%` }} />
          <span className="proofline-fill" style={{ width: `${Math.min(100, confidence)}%` }}><i /></span>
          {record?.observations.map((observation, index) => {
            const conflict = verification?.conflicts.some((item) => item.observationId === observation.id);
            const left = Math.min(94, 16 + index * 17);
            return <span key={observation.id} className={`source-pip ${conflict ? "conflict" : ""} ${observation.retracted ? "retracted" : ""}`} style={{ left: `${left}%`, "--source-index": index } as CSSProperties} title={observation.source.label} />;
          })}
        </div>
        {contested && <div className="quarantine-sash" key={`quarantine-${motionKey}`}><span>VARA conflict quarantine</span><strong>Settlement pulled back</strong></div>}
      </div>

      <div className="proof-reason" key={`reason-${motionKey}`}>
        <Icon name={verification?.state === "verified" ? "check" : "shield"} />
        <p>{contested ? "A material source conflict is active. VARA quarantines settlement while independent corroboration is still missing." : verification?.reasons[0] ?? "No canonical event exists yet. Source observations stay separate until replay begins."}</p>
      </div>

      <details className="score-details">
        <summary>Why this score?</summary>
        <div className="breakdown" aria-label="Evidence score calculation">
          {([
            ["Source reliability", verification?.breakdown.reliabilityBps ?? 0],
            ["Independent quorum", verification?.breakdown.quorumBps ?? 0],
            ["Agreement", verification?.breakdown.agreementBps ?? 0],
            ["Freshness", verification?.breakdown.freshnessBps ?? 0],
          ] as const).map(([label, value]) => (
            <div key={label}><span>{label}</span><i><b style={{ width: `${value / 100}%` }} /></i><strong>{percent(value)}</strong></div>
          ))}
          <div className={verification?.breakdown.conflictPenaltyBps ? "penalty active" : "penalty"}>
            <span>Conflict penalty</span><i><b style={{ width: `${(verification?.breakdown.conflictPenaltyBps ?? 0) / 30}%` }} /></i><strong>−{percent(verification?.breakdown.conflictPenaltyBps)}</strong>
          </div>
        </div>

        {verification?.canonical.eventHash && (
          <div className="canonical-hash"><span>Canonical event hash</span><code>{verification.canonical.eventHash}</code></div>
        )}
      </details>
    </section>
  );
}

function SettlementGate({ decision, anchor, onchainVerified, openProof }: {
  decision: SettlementDecision;
  anchor: AnchorRecord | null | undefined;
  onchainVerified: boolean;
  openProof: () => void;
}) {
  const safeToSettle = decision.allowed && onchainVerified;
  const policyOnly = decision.allowed && !onchainVerified;
  return (
    <section className={`settlement-gate ${safeToSettle ? "is-open" : "is-held"}`} aria-labelledby="gate-heading" aria-live="polite">
      <div className="gate-signal"><span /><span /><span /></div>
      <div className="gate-copy">
        <p className="eyebrow">Question 03 · Can the Agent settle?</p>
        <h2 id="gate-heading">{safeToSettle ? "Safe to settle" : policyOnly ? "External proof pending" : "Settlement held"}</h2>
        <p>{safeToSettle ? "Evidence, paid packet, and a fresh Injective registry lookup all passed." : policyOnly ? "Evidence policy cleared, but the paid packet and fresh registry check are not complete." : decision.reasons[0]}</p>
      </div>
      <div className="gate-status"><span>{safeToSettle ? "OPEN" : policyOnly ? "PENDING" : "HELD"}</span><small>{onchainVerified ? "Registry verified" : anchor?.receipt.mode === "demo" ? "Demo commitment only" : anchor?.receipt.confirmed ? "Fresh lookup required" : "Anchor required"}</small></div>
      <button type="button" className="proof-button" onClick={openProof} data-testid="open-proof-drawer">Inspect x402 + chain proof <Icon name="arrow" /></button>
    </section>
  );
}

function EvidenceRail({ record }: { record: EventRecord | undefined }) {
  const verification = record?.verification;
  return (
    <section className="evidence-list" aria-labelledby="evidence-heading">
      <div className="section-heading compact">
        <div><p className="eyebrow">Source evidence</p><h2 id="evidence-heading">Independent signals</h2></div>
        <span>{record?.observations.length ?? 0} received</span>
      </div>
      {!record?.observations.length ? (
        <div className="empty-evidence"><span className="radar-ring" /><p>Source observations will land here with provenance intact.</p></div>
      ) : (
        <ol>
          {record.observations.map((observation, index) => {
            const conflict = verification?.conflicts.find((item) => item.observationId === observation.id);
            const agrees = verification?.agreeingObservationIds.includes(observation.id);
            return (
              <li key={observation.id} className={`${conflict ? "is-conflict" : ""} ${observation.retracted ? "is-retracted" : ""}`} style={{ "--source-index": index } as CSSProperties}>
                <div className="evidence-connector"><span /></div>
                <div className="source-topline">
                  <strong>{observation.source.label}</strong>
                  <span>{percent(observation.source.reliabilityBps)}</span>
                </div>
                <div className="source-status">
                  <span className={`source-state ${conflict ? "conflict" : observation.retracted ? "retracted" : agrees ? "agrees" : "pending"}`}>
                    {observation.retracted ? "Retracted" : conflict ? "Conflicts" : agrees ? "Corroborates" : "Observed"}
                  </span>
                  <span>{observation.source.tier}</span>
                </div>
                <p>{eventTitle(observation.payload)} · {minuteLabel(observation.payload)}</p>
                {conflict && <p className="conflict-fields">Mismatch: {conflict.fields.join(", ")}</p>}
                {observation.note && <p className="source-note">{observation.note}</p>}
                <a href={observation.source.url} target="_blank" rel="noreferrer">Inspect attributed source <Icon name="external" size={14} /></a>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function AnchorReceiptView({ anchor, verification, integrations }: {
  anchor: AnchorRecord | null | undefined;
  verification: VerificationResult | undefined;
  integrations: IntegrationsResponse | null;
}) {
  const receipt = anchor?.receipt;
  const chainMode = integrations?.injective.mode ?? "demo";
  return (
    <section className={`anchor-receipt ${receipt?.confirmed ? "has-receipt" : ""}`} aria-labelledby="anchor-heading">
      <div className="receipt-tear" />
      <div className="section-heading compact">
        <div><p className="eyebrow">Anchor receipt</p><h2 id="anchor-heading">Injective proof</h2></div>
        <Icon name="receipt" />
      </div>
      {receipt?.confirmed ? (
        <>
          <div className="receipt-status"><Icon name="check" /><div><strong>{receipt.mode === "demo" ? "Deterministic demo commitment created" : "Hash anchored on Injective"}</strong><span>{receipt.mode === "demo" ? "No blockchain transaction" : "Injective EVM testnet"}</span></div></div>
          <dl>
            <div><dt>Event hash</dt><dd><code>{truncate(receipt.eventHash, 10, 8)}</code></dd></div>
            <div><dt>Evidence score</dt><dd>{evidenceScore(receipt.confidenceBps)}</dd></div>
            <div><dt>Transaction</dt><dd><code>{receipt.mode === "demo" ? "None" : truncate(receipt.txHash)}</code></dd></div>
            <div><dt>Mode</dt><dd>{receipt.mode}</dd></div>
          </dl>
          {receipt.explorerUrl ? <a className="receipt-link" href={receipt.explorerUrl} target="_blank" rel="noreferrer">Open testnet explorer <Icon name="external" size={14} /></a> : <p className="receipt-disclosure">{anchor?.disclosure}</p>}
        </>
      ) : (
        <div className="await-anchor">
          <span><Icon name="shield" /></span>
          <strong>{verification?.state === "verified" ? "Ready when the final result clears" : "Waiting for verified final result"}</strong>
          <p>{chainMode === "demo" ? "Replay mode creates a deterministic commitment without claiming a chain transaction." : "The hash will be written to Injective EVM testnet."}</p>
        </div>
      )}
    </section>
  );
}

function FundingReadiness({ integrations }: { integrations: IntegrationsResponse | null }) {
  const cctp = integrations?.cctp;
  const executable = cctp?.executable === true;
  return (
    <section className="funding-rail" aria-labelledby="funding-heading">
      <div className="funding-title"><span><Icon name="wallet" /></span><div><p className="eyebrow">Future capability · not in judge path</p><h2 id="funding-heading">CCTP USDC top-up</h2></div></div>
      <div className="funding-route" aria-label={`${CCTP_SOURCE} to ${CCTP_DESTINATION}`}>
        <span><small>Source</small>{cctp?.source ?? CCTP_SOURCE}</span><i><Icon name="arrow" /></i><span><small>Domain 29</small>{cctp?.destination ?? CCTP_DESTINATION}</span>
      </div>
      <div className={`funding-state ${executable ? "ready" : "staged"}`}><span />{executable ? "Integration route configured" : "Future work · no burn or mint execution"}</div>
      <p>{cctp?.disclosure ?? "PLAN ONLY · CCTP is not executed by this build. The Agent can prepare and validate a route, then must stop before burn."}</p>
    </section>
  );
}

function AgentTrace({ snapshot, record, proof, decision, proofVerification, runtime }: {
  snapshot: ReplaySnapshot;
  record: EventRecord | undefined;
  proof: ProofPacketResponse | null;
  decision: SettlementDecision;
  proofVerification: ProofVerificationResponse | null;
  runtime: McpRuntimeResponse | null;
}) {
  const verification = record?.verification;
  const onchainAttempted = proofVerification?.onchain.checked === true;
  const onchainChecked =
    proofVerification?.onchain.checked === true &&
    proofVerification.onchain.valid === true;
  const anchorDetail = onchainChecked
    ? "Fresh registry lookup passed"
    : onchainAttempted
      ? "Registry mismatch · settlement held"
    : record?.anchor?.receipt.mode === "demo"
      ? "Demo receipt only · on-chain not checked"
      : record?.anchor?.receipt.confirmed
        ? "Anchor present · fresh registry lookup required"
        : "Anchor not available";
  const conclusionReady = decision.allowed && onchainChecked;
  const steps = [
    { tool: "list_matches", detail: "Locate recorded World Cup match", state: "done" },
    { tool: "get_match_events", detail: snapshot.replay.cursor ? `${snapshot.replay.cursor} replay frames ingested` : "Await first replay frame", state: snapshot.replay.cursor ? "done" : "wait" },
    { tool: "verify_event", detail: verification ? `${verificationStatus(verification)} · score ${evidenceScore(verification.confidenceBps)}` : "No event selected", state: verification?.conflicts.length || verification?.state === "contested" ? "held" : verification ? "done" : "wait" },
    { tool: "purchase_match_proof", detail: proof ? "x402 report received" : "Spend cap: 0.01 test USDC", state: proof ? "done" : "wait" },
    { tool: "verify_onchain_anchor", detail: anchorDetail, state: onchainChecked ? "done" : onchainAttempted ? "held" : "wait" },
    { tool: "return_evidence", detail: conclusionReady ? "Settlement-safe chain conclusion" : decision.allowed ? "Integrity cleared · chain conclusion withheld" : "Policy refuses final settlement", state: conclusionReady ? "done" : decision.allowed ? "wait" : "held" },
  ];
  const runtimeLogs = runtime?.logs ?? [];
  const hasRuntimeEvidence = runtimeLogs.length > 0;

  return (
    <section className="agent-trace" aria-labelledby="agent-heading">
      <div className="agent-prompt">
        <span><Icon name="agent" /></span>
        <div><p className="eyebrow light">{hasRuntimeEvidence ? "MCP runtime evidence · actual tool handlers" : "Illustrative Agent Policy Trace · not a runtime log"}</p><h2 id="agent-heading">“Is the final score safe to settle?”</h2></div>
        <div className={`runtime-health health-${runtime?.health ?? "never-seen"}`}><span />{runtime?.agentReady ? "AGENT-READY" : runtime?.health === "stale" ? "RUNTIME STALE" : "RUNTIME OFFLINE"}</div>
      </div>
      <ol>
        {hasRuntimeEvidence
          ? runtimeLogs.slice(0, 8).map((entry, index) => (
              <li key={entry.id} className={`trace-${entry.outcome === "success" ? "done" : "held"}`} style={{ "--trace-index": index } as CSSProperties}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <code>{entry.tool}</code>
                  <small><b>{JSON.stringify(entry.inputSummary)}</b>{entry.resultSummary} · {entry.durationMs}ms · {new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</small>
                </div>
                <i>{entry.outcome === "success" ? "PASS" : "FAIL"}</i>
              </li>
            ))
          : steps.map((step, index) => <li key={step.tool} className={`trace-${step.state}`} style={{ "--trace-index": index } as CSSProperties}><span>{String(index + 1).padStart(2, "0")}</span><div><code>{step.tool}</code><small>{step.detail}</small></div><i>{step.state === "done" ? "PASS" : step.state === "held" ? "HOLD" : "WAIT"}</i></li>)}
      </ol>
      <p className="runtime-disclosure">{runtime?.disclosure ?? "MCP runtime health is unavailable; this trace remains explicitly illustrative."}</p>
    </section>
  );
}

function VerificationLayers({ verification }: { verification: ProofVerificationResponse | null }) {
  const integrity = verification?.integrity?.valid;
  const signature = verification?.signature?.valid;
  const onchain = verification?.onchain;
  const statusClass = (value: boolean | undefined) => value === true ? "layer-pass" : value === false ? "layer-fail" : "layer-pending";
  return (
    <div className="verification-layers" aria-label="Independent proof verification layers">
      <div className={statusClass(integrity)}>
        <span>01 · Integrity</span>
        <strong>{integrity === true ? "PASS" : integrity === false ? "FAIL" : "PENDING"}</strong>
        <p>{integrity === true ? "Packet and evidence hashes recomputed." : integrity === false ? "Deterministic recomputation did not match." : "Packet has not been recomputed yet."}</p>
      </div>
      <div className={statusClass(signature)}>
        <span>02 · Issuer signature</span>
        <strong>{signature === true ? "PASS" : signature === false ? "FAIL" : "PENDING"}</strong>
        <p>{signature === true ? "EIP-712 signer is cryptographic and trusted." : signature === false ? verification?.signature?.detail ?? "Issuer signature did not validate." : "Issuer signature has not been checked yet."}</p>
      </div>
      <div className={onchain?.checked ? statusClass(onchain.valid) : "layer-pending"}>
        <span>03 · On-chain commitment</span>
        <strong>{onchain?.checked ? onchain.valid ? "PASS" : "FAIL" : "PENDING"}</strong>
        <p>{onchain?.checked ? onchain.reason : "Fresh Injective registry lookup has not run."}</p>
      </div>
    </div>
  );
}

function isFullyVerifiedProof(verification: ProofVerificationResponse | null): boolean {
  return Boolean(
    verification?.valid &&
    verification.integrity?.valid === true &&
    verification.signature?.valid === true &&
    verification.onchain.checked === true &&
    verification.onchain.valid === true,
  );
}

function ProofDrawer({ open, presentation = "overlay", matchId, eventId, replay, integrations, wallet, onOpenWallet, onPrepareProof, onClose, onProof, onVerification, onLockChange }: {
  open: boolean;
  presentation?: "overlay" | "embedded";
  matchId: string;
  eventId: string;
  replay: ReplaySnapshot | null;
  integrations: IntegrationsResponse | null;
  wallet: UseWalletResult;
  onOpenWallet: () => void;
  onPrepareProof: (eventId: string, signal?: AbortSignal) => Promise<void>;
  onClose: () => void;
  onProof: (proof: ProofPacketResponse | null) => void;
  onVerification: (verification: ProofVerificationResponse | null) => void;
  onLockChange?: (locked: boolean) => void;
}) {
  const [status, setStatus] = useState<DrawerStatus>("idle");
  const [quote, setQuote] = useState<PaymentQuote | null>(null);
  const [proof, setProof] = useState<ProofPacketResponse | null>(null);
  const [verification, setVerification] = useState<ProofVerificationResponse | null>(null);
  const [walletAccount, setWalletAccount] = useState<string | null>(null);
  const [paymentNonce, setPaymentNonce] = useState<string | null>(null);
  const [signingStep, setSigningStep] = useState<BrowserSigningStep | null>(null);
  const [tamperResult, setTamperResult] = useState<"idle" | "running" | "passed" | "failed" | "unavailable">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const bindingButton = useRef<HTMLButtonElement>(null);
  // A live PAYMENT-SIGNATURE is deliberately ephemeral: it exists only in this
  // mounted drawer and is replayed for recovery without storage or logging.
  const paymentSignatureRef = useRef<string | null>(null);
  // The first EIP-3009 signature is also memory-only. It is never submitted
  // until a second, explicit user gesture completes the ProofPurchase binding.
  const pendingAuthorizationRef = useRef<BrowserPaymentAuthorization | null>(null);
  const operationEpochRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const drawerActiveRef = useRef(open);
  const onVerificationRef = useRef(onVerification);
  const targetKey = `${matchId}:${eventId}`;
  const targetKeyRef = useRef(targetKey);
  const walletEpochRef = useRef(wallet.walletEpoch);
  drawerActiveRef.current = open;
  onVerificationRef.current = onVerification;
  targetKeyRef.current = targetKey;
  const closeLocked = [
    "authorizing",
    "binding-ready",
    "binding",
    "settling",
    "recovering",
    "uncertain",
  ].includes(status);
  const walletName = wallet.selectedProvider?.info.name ?? "your selected wallet";

  useEffect(() => {
    onLockChange?.(closeLocked);
    return () => onLockChange?.(false);
  }, [closeLocked, onLockChange]);

  useEffect(() => {
    if (!open || status !== "binding-ready") return;
    const frame = window.requestAnimationFrame(() => {
      bindingButton.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
      bindingButton.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, status]);

  const isCurrentOperation = (operation: DrawerOperation): boolean =>
    drawerActiveRef.current &&
    !operation.controller.signal.aborted &&
    operationEpochRef.current === operation.epoch &&
    targetKeyRef.current === operation.targetKey;

  const beginOperation = (): DrawerOperation => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const epoch = operationEpochRef.current + 1;
    operationEpochRef.current = epoch;
    return { epoch, targetKey, controller };
  };

  const handleClose = useCallback(() => {
    if (closeLocked) {
      setMessage(
        status === "uncertain"
          ? "Keep this panel open while the existing authorization is recovered or checked. Closing now would discard the only in-memory recovery handle."
          : status === "binding-ready"
            ? "Signature 1/2 is held in memory only. Complete Proof binding or use Discard authorization before closing. No payment has been submitted."
          : "A wallet or settlement request is in progress. Reject the wallet prompt or wait for its receipt before closing this panel.",
      );
      return;
    }
    drawerActiveRef.current = false;
    operationEpochRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    paymentSignatureRef.current = null;
    pendingAuthorizationRef.current = null;
    setStatus("idle");
    setQuote(null);
    setProof(null);
    setVerification(null);
    setWalletAccount(null);
    setPaymentNonce(null);
    setSigningStep(null);
    setTamperResult("idle");
    setMessage(null);
    onClose();
  }, [closeLocked, onClose, status]);

  useEffect(() => {
    if (!open || presentation !== "overlay") return;
    closeButton.current?.focus();
  }, [open, presentation]);

  useEffect(() => {
    if (!open || presentation !== "overlay") return;
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape") handleClose(); };
    document.addEventListener("keydown", listener);
    document.body.classList.add("drawer-open");
    return () => {
      document.removeEventListener("keydown", listener);
      document.body.classList.remove("drawer-open");
    };
  }, [handleClose, open, presentation]);

  useEffect(() => {
    if (!open || !closeLocked) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [closeLocked, open]);

  useEffect(() => {
    operationEpochRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    if (!open) return;
    setStatus("idle");
    setQuote(null);
    setProof(null);
    setVerification(null);
    onVerificationRef.current(null);
    setWalletAccount(null);
    setPaymentNonce(null);
    setSigningStep(null);
    paymentSignatureRef.current = null;
    pendingAuthorizationRef.current = null;
    setTamperResult("idle");
    setMessage(null);
  }, [eventId, matchId, open]);

  useEffect(() => {
    if (walletEpochRef.current === wallet.walletEpoch) return;
    walletEpochRef.current = wallet.walletEpoch;
    if (!["quoted", "signature-ready", "authorizing", "binding-ready", "binding"].includes(status)) return;
    operationEpochRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    pendingAuthorizationRef.current = null;
    paymentSignatureRef.current = null;
    setQuote(null);
    setSigningStep(null);
    setWalletAccount(null);
    setPaymentNonce(null);
    setStatus("idle");
    setMessage("The connected wallet, account, or network changed. The previous quote and in-memory authorization were discarded; no payment was submitted.");
  }, [status, wallet.walletEpoch]);

  const acceptDeliveredProof = async (
    result: ProofPacketResponse,
    operation: DrawerOperation,
    recovered = false,
  ) => {
    if (!isCurrentOperation(operation)) return;
    setProof(result);
    onProof(result);
    setStatus("verifying");
    try {
      const checked = await api.verifyProof(
        result.packet,
        operation.controller.signal,
      );
      if (!isCurrentOperation(operation)) return;
      setVerification(checked);
      onVerification(checked);
      const fullyVerified = isFullyVerifiedProof(checked);
      if (!fullyVerified) {
        setStatus("delivered-unverified");
        setMessage("Report delivered and payment will not be repeated. Settlement remains held because integrity, issuer, and a fresh Registry v3 lookup have not all passed.");
      } else {
        setStatus("paid");
      }
      if (fullyVerified && recovered) {
        setMessage(
          result.correction?.applied
            ? "Recovered the existing settled report and corrected its legacy replay timestamp. No wallet opened, no facilitator was called, and no payment was repeated."
            : "Recovered the existing settled report. No wallet opened, no facilitator was called, and no payment was repeated.",
        );
      }
    } catch (cause) {
      if (isAbortError(cause) || !isCurrentOperation(operation)) return;
      setStatus("delivered-unverified");
      setMessage(
        `Report delivered; payment will not be repeated. Packet verification can be retried safely. ${
          cause instanceof Error ? cause.message : ""
        }`,
      );
    }
  };

  const requestQuote = async (
    preparedOperation?: DrawerOperation,
    skipRecovery = false,
  ) => {
    const operation = preparedOperation ?? beginOperation();
    if (!isCurrentOperation(operation)) return;
    setStatus("quoting");
    setMessage(null);
    try {
      if (!skipRecovery) {
        const recovered = await api.recoverSettledProof(
          matchId,
          eventId,
          operation.controller.signal,
        );
        if (!isCurrentOperation(operation)) return;
        if (recovered) {
          setQuote(null);
          await acceptDeliveredProof(recovered, operation, true);
          return;
        }
      }
      const response = await api.getProofQuote(
        matchId,
        eventId,
        operation.controller.signal,
      );
      if (!isCurrentOperation(operation)) return;
      if (!("packet" in response)) {
        setQuote(response);
        setStatus("quoted");
      } else {
        await acceptDeliveredProof(response, operation);
      }
    } catch (cause) {
      if (isAbortError(cause) || !isCurrentOperation(operation)) return;
      if (
        cause instanceof ApiError &&
        cause.body &&
        typeof cause.body === "object" &&
        "paymentState" in cause.body &&
        cause.body.paymentState === "settled"
      ) {
        setStatus("error");
        setMessage(`An existing payment is settled but its report could not be recovered safely. Do not sign or pay again. ${cause.message}`);
        return;
      }
      if (
        cause instanceof ApiError &&
        cause.body &&
        typeof cause.body === "object" &&
        "error" in cause.body &&
        cause.body.error === "proof_event_not_ready"
      ) {
        setStatus("idle");
        setMessage("The replay state changed before the quote was frozen. Prepare the final proof again; no wallet was opened.");
        return;
      }
      setMessage(cause instanceof Error ? cause.message : "Could not negotiate the proof report.");
      setStatus("error");
    }
  };

  const prepareAndRequestQuote = async () => {
    const operation = beginOperation();
    setStatus("preparing");
    setMessage(null);
    try {
      const recovered = await api.recoverSettledProof(
        matchId,
        eventId,
        operation.controller.signal,
      );
      if (!isCurrentOperation(operation)) return;
      if (recovered) {
        setQuote(null);
        await acceptDeliveredProof(recovered, operation, true);
        return;
      }
      await onPrepareProof(eventId, operation.controller.signal);
      if (!isCurrentOperation(operation)) return;
      await requestQuote(operation, true);
    } catch (cause) {
      if (isAbortError(cause) || !isCurrentOperation(operation)) return;
      if (
        cause instanceof ApiError &&
        cause.body &&
        typeof cause.body === "object" &&
        "paymentState" in cause.body &&
        cause.body.paymentState === "settled"
      ) {
        setStatus("error");
        setMessage(`An existing payment is settled but its report could not be recovered safely. Do not sign or pay again. ${cause.message}`);
        return;
      }
      setStatus("idle");
      setMessage(
        `Evidence preparation stopped before payment. No wallet was opened. ${
          cause instanceof Error ? cause.message : "The replay could not reach a confirmed final proof."
        }`,
      );
    }
  };

  const deliverPayment = async (
    operation: DrawerOperation,
    paymentSignature: string,
    liveAuthorizationCreated: boolean,
  ) => {
    if (!isCurrentOperation(operation)) return;
    paymentSignatureRef.current = paymentSignature;
    setStatus("settling");
    setSigningStep(null);
    let result: ProofPacketResponse;
    try {
      result = await api.submitProofPayment(matchId, eventId, paymentSignature);
    } catch (cause) {
      if (isAbortError(cause) || !isCurrentOperation(operation)) return;
      if (cause instanceof ApiError && cause.status === 409) {
        const body = cause.body && typeof cause.body === "object"
          ? cause.body as Record<string, unknown>
          : null;
        const code = typeof body?.error === "string" ? body.error : "";
        const paymentState = typeof body?.paymentState === "string"
          ? body.paymentState
          : "";
        const definitelyNotSubmitted = new Set([
          "proof_quote_missing_or_expired",
          "proof_quote_anchor_mode_invalid",
          "payment_identity_invalid",
          "proof_purchase_binding_invalid",
          "frozen_proof_entitlement_missing",
        ]).has(code) && (
          paymentState === "" ||
          paymentState === "not-requested" ||
          paymentState === "not-submitted"
        );
        if (definitelyNotSubmitted) {
          paymentSignatureRef.current = null;
          pendingAuthorizationRef.current = null;
          setQuote(null);
          setStatus("idle");
          setMessage(`${cause.message} The server confirms no facilitator call was made; request a fresh quote before signing again.`);
          return;
        }
        // 409 also covers already-pending or already-settled authorizations.
        // Preserve the only in-memory recovery header and fail closed instead
        // of inviting a second nonce/payment.
        setStatus("uncertain");
        setMessage(`The server reported a conflicting payment state. Do not sign again. Recover this exact in-memory authorization or inspect its receipt. ${cause.message}`);
        return;
      }
      setMessage(
        liveAuthorizationCreated
          ? `Payment outcome is uncertain. Do not sign again until the wallet and facilitator receipt are checked. ${cause instanceof Error ? cause.message : ""}`
          : cause instanceof Error
            ? cause.message
            : "The proof payment could not finish.",
      );
      setStatus(liveAuthorizationCreated ? "uncertain" : "error");
      return;
    }

    paymentSignatureRef.current = null;
    pendingAuthorizationRef.current = null;
    await acceptDeliveredProof(result, operation);
  };

  const startPaymentAuthorization = async () => {
    if (!quote) return;
    if (quote.demoSignature) {
      const operation = beginOperation();
      setMessage(null);
      setSigningStep(null);
      await deliverPayment(operation, quote.demoSignature, false);
      return;
    }
    if (!wallet.selectedProvider || !wallet.account || wallet.status !== "ready") {
      setMessage("Connect a compatible wallet, switch to Injective EVM Testnet, and confirm at least 0.01 test USDC before signing.");
      onOpenWallet();
      return;
    }
    const operation = beginOperation();
    setMessage(null);
    setSigningStep(null);
    if (!integrations) {
      setStatus("error");
      setMessage("Integration policy is not loaded; payment signing is disabled.");
      return;
    }

    setStatus("authorizing");
    try {
      const authorization = await createBrowserPaymentAuthorization({
        provider: wallet.selectedProvider.provider,
        account: wallet.account,
        quote,
        sessionId: PROOFLINE_SESSION_ID,
        expectedAsset: integrations.x402.asset.address,
        expectedPayee: integrations.x402.payTo,
        maximumAmount: integrations.x402.priceAtomic,
        rpcUrl: integrations.injective.publicRpcUrl,
        explorerUrl: integrations.injective.explorerUrl,
        onSigningStep: (step) => {
          if (isCurrentOperation(operation)) setSigningStep(step);
        },
        isActive: () => isCurrentOperation(operation),
      });
      if (!isCurrentOperation(operation)) return;
      pendingAuthorizationRef.current = authorization;
      setWalletAccount(authorization.account);
      setPaymentNonce(authorization.nonce);
      setSigningStep(null);
      setStatus("binding-ready");
    } catch (cause) {
      if (isAbortError(cause) || !isCurrentOperation(operation)) return;
      setSigningStep(null);
      setStatus("quoted");
      setMessage(cause instanceof Error ? cause.message : "The USDC authorization was not signed.");
    }
  };

  const completeProofBinding = async () => {
    const pending = pendingAuthorizationRef.current;
    if (!pending) {
      setStatus("quoted");
      setMessage("The first authorization is no longer available. Start again from signature 1/2; no payment was submitted.");
      return;
    }
    if (!wallet.selectedProvider || !wallet.account) {
      setStatus("binding-ready");
      setMessage("The wallet connection changed after signature 1/2. Discard the in-memory authorization and review the payment again; no payment was submitted.");
      return;
    }
    const operation = beginOperation();
    setStatus("binding");
    setSigningStep(2);
    setMessage(null);
    try {
      // This function is called directly from the second button click so the
      // selected wallet receives a fresh browser user gesture for confirmation.
      const payment = await completeBrowserPaymentSignature({
        provider: wallet.selectedProvider.provider,
        account: wallet.account,
        authorization: pending,
        onSigningStep: (step) => {
          if (isCurrentOperation(operation)) setSigningStep(step);
        },
        isActive: () => isCurrentOperation(operation),
      });
      if (!isCurrentOperation(operation)) return;
      pendingAuthorizationRef.current = null;
      setWalletAccount(payment.account);
      setPaymentNonce(payment.nonce);
      await deliverPayment(operation, payment.header, true);
    } catch (cause) {
      if (isAbortError(cause) || !isCurrentOperation(operation)) return;
      setSigningStep(null);
      if (cause instanceof Error && cause.message.includes("expired")) {
        pendingAuthorizationRef.current = null;
        setStatus("quoted");
      } else {
        setStatus("binding-ready");
      }
      setMessage(
        `${cause instanceof Error ? cause.message : "The Proof binding was not signed."} No PAYMENT-SIGNATURE was submitted and no payment was attempted.`,
      );
    }
  };

  const discardPendingAuthorization = () => {
    operationEpochRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    pendingAuthorizationRef.current = null;
    paymentSignatureRef.current = null;
    setSigningStep(null);
    setWalletAccount(null);
    setPaymentNonce(null);
    setStatus("quoted");
    setMessage("The first authorization was discarded in memory. No payment request was sent.");
  };

  const retryVerification = async () => {
    if (!proof) return;
    const operation = beginOperation();
    setStatus("verifying");
    setMessage(null);
    try {
      const checked = await api.verifyProof(
        proof.packet,
        operation.controller.signal,
      );
      if (!isCurrentOperation(operation)) return;
      setVerification(checked);
      onVerification(checked);
      setStatus(isFullyVerifiedProof(checked) ? "paid" : "delivered-unverified");
    } catch (cause) {
      if (isAbortError(cause) || !isCurrentOperation(operation)) return;
      setStatus("delivered-unverified");
      setMessage(
        `Packet verification is still unavailable; no payment was repeated. ${
          cause instanceof Error ? cause.message : ""
        }`,
      );
    }
  };

  const recoverPayment = async () => {
    const existingSignature = paymentSignatureRef.current;
    if (!existingSignature) {
      setMessage("The in-memory authorization is no longer available. Check the payer and facilitator before requesting any fresh quote.");
      return;
    }
    const operation = beginOperation();
    setStatus("recovering");
    setMessage("Replaying the original in-memory PAYMENT-SIGNATURE. No wallet prompt, storage write, or new authorization is created.");
    try {
      const response = await api.submitProofPayment(matchId, eventId, existingSignature);
      paymentSignatureRef.current = null;
      if (!isCurrentOperation(operation)) return;
      await acceptDeliveredProof(response, operation, true);
    } catch (cause) {
      if (!isCurrentOperation(operation)) return;
      setStatus("uncertain");
      setMessage(`The original signature is still held only in memory, but recovery did not resolve the payment. Do not sign again. ${cause instanceof Error ? cause.message : ""}`);
    }
  };

  const runTamperControl = async () => {
    if (!proof) return;
    const operation = beginOperation();
    setTamperResult("running");
    const tampered = structuredClone(proof.packet);
    tampered.eventId = `${tampered.eventId}-tampered`;
    try {
      const checked = await api.verifyProof(
        tampered,
        operation.controller.signal,
      );
      if (!isCurrentOperation(operation)) return;
      setTamperResult(checked.valid ? "failed" : "passed");
    } catch (cause) {
      if (isAbortError(cause) || !isCurrentOperation(operation)) return;
      setTamperResult("unavailable");
      setMessage(`Tamper control was unavailable; no PASS is claimed. ${cause instanceof Error ? cause.message : "The verifier could not be reached."}`);
    }
  };

  if (!open) return null;
  const isSandbox = integrations?.x402.mode !== "live";
  const livePaymentUsable = Boolean(
    integrations?.x402.mode === "live" &&
    integrations.x402.status !== "misconfigured" &&
    !integrations.x402.simulated,
  );
  const testnetAnchorUsable = Boolean(
    integrations?.injective.mode === "injective-testnet" &&
    integrations.injective.status !== "misconfigured" &&
    !integrations.injective.simulated,
  );
  const replayTarget = replay?.match.id === matchId;
  const replayEvent = replayTarget
    ? replay.events.find((record) => record.eventId === eventId)
    : undefined;
  const anchorRequired = replayTarget && eventId === "final-result";
  const replayReady = !replayTarget || Boolean(
    replay.replay.complete &&
    !replay.replay.running &&
    !replay.replay.processing &&
    replayEvent &&
    (!anchorRequired || (
      replayEvent.anchor?.receipt.confirmed === true &&
      (integrations?.x402.mode !== "live" ||
        replayEvent.anchor.receipt.mode === "injective-testnet")
    )),
  );
  const paymentConfigurationReady = isSandbox || livePaymentUsable;
  const firstSignatureComplete = [
    "binding-ready",
    "binding",
    "settling",
    "verifying",
    "delivered-unverified",
    "uncertain",
    "recovering",
    "paid",
  ].includes(status);
  const secondSignatureComplete = [
    "settling",
    "verifying",
    "delivered-unverified",
    "uncertain",
    "recovering",
    "paid",
  ].includes(status);
  const showReplayPreflight = Boolean(
    replayTarget &&
    (status === "preparing" || (status === "idle" && !replayReady)),
  );
  const replayProgress = replayTarget && replay.replay.totalFrames
    ? Math.min(100, (replay.replay.cursor / replay.replay.totalFrames) * 100)
    : 0;
  const walletReady = wallet.status === "ready";
  const flowStage = ["settling", "verifying", "delivered-unverified", "uncertain", "recovering", "paid"].includes(status)
    ? 4
    : ["signature-ready", "authorizing", "binding-ready", "binding"].includes(status)
      ? 3
      : ["quoted"].includes(status)
        ? 2
        : 1;
  let quotedRequirement: X402Requirement | null = null;
  if (quote) {
    try {
      quotedRequirement = readX402Requirement(quote);
    } catch {
      quotedRequirement = null;
    }
  }
  const quotedPrice = quotedRequirement && /^\d+$/.test(quotedRequirement.amount)
    ? formatTestUsdc(BigInt(quotedRequirement.amount))
    : integrations?.x402.priceDisplay ?? "0.01 test USDC";

  return (
    <div className={presentation === "overlay" ? "drawer-layer" : "proof-workflow-embedded"}>
      {presentation === "overlay" && <button type="button" className="drawer-scrim" aria-label="Close proof report" onClick={handleClose} />}
      <aside className={`proof-drawer ${presentation === "embedded" ? "is-embedded" : ""}`} role={presentation === "overlay" ? "dialog" : "region"} aria-modal={presentation === "overlay" ? true : undefined} aria-labelledby="drawer-heading" data-drawer-status={status}>
        <header>
          <div><p className="eyebrow light">Judge task · paid proof</p><h2 id="drawer-heading">Pay once. Verify three ways.</h2></div>
          {presentation === "overlay" && <button ref={closeButton} type="button" className="drawer-close" onClick={handleClose} aria-label="Close proof report" data-close-locked={closeLocked}><Icon name="close" /></button>}
        </header>
        <div className="drawer-mode"><span>{isSandbox ? "SANDBOX" : livePaymentUsable ? "TESTNET ONLY" : "CONFIG REQUIRED"}</span><p>{isSandbox ? "Protocol-shaped negotiation. No value is transferred." : livePaymentUsable ? "0.01 test USDC · 2 signatures · 1 payment · 0 wallet-broadcast transactions" : "Live x402 is not ready. Proofline will fail closed before requesting a wallet signature."}</p></div>

        <section className="price-ticket">
          <span>Verification packet</span><strong>{integrations?.x402.priceDisplay ?? "0.01 USDC"}</strong><small>Spend policy cap · 10,000 atomic USDC</small>
        </section>

        <ol className="payment-flow payment-stage-rail" aria-label={`Payment stage ${flowStage} of 4`}>
          {(["Wallet", "Review", "Sign", "Verify"] as const).map((label, index) => {
            const step = index + 1;
            return <li key={label} className={flowStage === step ? "active" : flowStage > step ? "complete" : ""}><i>{step}</i><span><b>{label}</b><small>{["Preflight", "Inspect terms", "2 confirmations", "3 proof layers"][index]}</small></span></li>;
          })}
        </ol>

        {showReplayPreflight && replay && (
          <section className={`proof-preflight ${status === "preparing" ? "is-preparing" : ""}`} data-testid="proof-preflight" aria-live="polite">
            <div className="preflight-head"><span>VAR evidence tape</span><strong>FRAME {String(replay.replay.cursor).padStart(2, "0")} / {String(replay.replay.totalFrames).padStart(2, "0")}</strong></div>
            <div className="preflight-meter" aria-label={`Evidence preparation ${Math.round(replayProgress)} percent`}><span style={{ width: `${replayProgress}%` }} /></div>
            <div className="preflight-copy">
              <p className="eyebrow">Final proof gate</p>
              <h3>{status === "preparing" ? "Building the verified match tape" : "Evidence must reach the final frame"}</h3>
              <p>Proofline will process the disclosed replay, resolve the provider conflict, and {testnetAnchorUsable ? "confirm the idempotent Injective testnet anchor" : integrations?.injective.mode === "injective-testnet" ? "require a usable Injective testnet anchor configuration" : "create the disclosed deterministic demo commitment"} before requesting a frozen 402 quote.</p>
            </div>
            <ol className="preflight-stages">
              <li className={replay.replay.cursor >= 5 ? "done" : status === "preparing" ? "active" : ""}><i>01</i><span><b>Ingest</b><small>Source observations</small></span></li>
              <li className={replay.replay.cursor >= 6 ? "done" : replay.replay.cursor >= 4 ? "active" : ""}><i>02</i><span><b>Resolve</b><small>Conflict correction</small></span></li>
              <li className={replayEvent?.anchor?.receipt.confirmed ? "done" : replay.replay.cursor >= 14 ? "active" : ""}><i>03</i><span><b>Anchor</b><small>{testnetAnchorUsable ? "Injective testnet" : integrations?.injective.mode === "injective-testnet" ? "Configuration required" : "Demo commitment"}</small></span></li>
            </ol>
            <p className="preflight-safety"><Icon name="wallet" size={14} /> {testnetAnchorUsable ? "This step may submit the idempotent testnet anchor." : integrations?.injective.mode === "injective-testnet" ? "This step stops unless the testnet anchor configuration is usable." : "This step creates a demo commitment only."} It never opens your wallet or transfers USDC.</p>
            <button type="button" className="amber-button" onClick={() => void prepareAndRequestQuote()} disabled={status === "preparing"} data-testid="prepare-proof-report">{status === "preparing" ? `Preparing frame ${replay.replay.cursor}/${replay.replay.totalFrames}…` : testnetAnchorUsable ? "Prepare replay + testnet anchor" : integrations?.injective.mode === "injective-testnet" ? "Check anchor configuration" : "Prepare replay + demo commitment"}<Icon name="arrow" /></button>
          </section>
        )}
        {status === "idle" && replayReady && paymentConfigurationReady && isSandbox && (
          <section className="wallet-preflight-card sandbox-boundary">
            <p className="eyebrow">Local sandbox boundary</p>
            <h3>Real wallet test is not simulated</h3>
            <p>This runtime transfers no value and therefore does not ask a wallet to sign. Use <strong>No-wallet audit</strong> here, or open the production testnet deployment for the two-signature payment path.</p>
          </section>
        )}
        {status === "idle" && replayReady && paymentConfigurationReady && !isSandbox && !walletReady && (
          <section className="wallet-preflight-card" data-wallet-status={wallet.status}>
            <p className="eyebrow">Stage 1 · Wallet preflight</p>
            <h3>{wallet.account ? "Finish the testnet check" : "Connect a test wallet"}</h3>
            <p>{wallet.status === "wrong-network"
              ? "The selected wallet is connected to another network. Switch before Proofline requests any signature."
              : wallet.status === "low-balance"
                ? `This account has ${formatTestUsdc(wallet.usdcBalance)}. The proof costs 0.01 test USDC.`
                : "Choose any compatible injected EVM wallet that supports EIP‑712 typed-data signing."}</p>
            <button type="button" className="amber-button" onClick={onOpenWallet} data-testid="connect-wallet-action">
              {wallet.account ? "Open wallet preflight" : "Connect test wallet"}<Icon name="arrow" />
            </button>
            <small>No private key leaves your wallet. No transaction is broadcast by the wallet.</small>
          </section>
        )}
        {status === "idle" && replayReady && paymentConfigurationReady && !isSandbox && walletReady && <div className="drawer-action"><p><strong>{walletName}</strong> is ready on Injective EVM Testnet with {formatTestUsdc(wallet.usdcBalance)}. Freeze the proof and inspect the exact 402 terms before signing.</p><button type="button" className="amber-button" onClick={() => void prepareAndRequestQuote()} data-testid="request-proof-report">Review 0.01 test USDC proof <Icon name="arrow" /></button></div>}
        {status === "idle" && replayReady && !paymentConfigurationReady && <div className="drawer-error" role="alert">Live x402 is unavailable until both the facilitator and Injective testnet anchor runtime are configured. No wallet request can start.</div>}
        {(status === "preparing" && !showReplayPreflight) && <div className="drawer-loading"><span /><p>Checking the anchored result before payment…</p></div>}
        {status === "quoting" && <div className="drawer-loading"><span /><p>Freezing proof and negotiating x402 terms…</p></div>}

        {quote && (
          <section className="quote-sheet">
            <div className="quote-title"><span>HTTP</span><strong>402</strong><p>Payment Required</p></div>
            <div className="quote-human-summary">
              <strong>{quotedPrice}</strong>
              <span>{quotedRequirement?.network === "eip155:1439" ? "Injective EVM Testnet" : quotedRequirement?.network ?? "Network unavailable"}</span>
              <p>Two wallet confirmations produce one bound payment authorization. Your wallet broadcasts zero transactions.</p>
            </div>
            <details className="quote-technical-details">
              <summary>Advanced payment terms</summary>
              <dl>
                <div><dt>Network</dt><dd><code>{quotedRequirement?.network ?? "Invalid quote"}</code></dd></div>
                <div><dt>Asset</dt><dd><code>{truncate(quotedRequirement?.asset, 9, 7)}</code></dd></div>
                <div><dt>Amount</dt><dd>{quotedRequirement?.amount ?? "Invalid quote"}</dd></div>
                <div><dt>Pay to</dt><dd><code>{truncate(quotedRequirement?.payTo, 9, 7)}</code></dd></div>
                <div><dt>Header</dt><dd><code>PAYMENT-SIGNATURE</code></dd></div>
              </dl>
            </details>
            {!isSandbox && (
              <div className="signature-sequence" data-testid="signature-sequence">
                <span>2 signatures · 1 payment</span>
                <ol>
                  <li className={signingStep === 1 ? "active" : firstSignatureComplete ? "done" : ""}><i>01</i><p><b>USDC authorization</b><small>{firstSignatureComplete ? "Confirmed · held in memory" : "Authorizes the single 0.01 test USDC transfer."}</small></p></li>
                  <li className={signingStep === 2 ? "active" : secondSignatureComplete ? "done" : status === "binding-ready" ? "ready" : ""}><i>02</i><p><b>Proof binding</b><small>{secondSignatureComplete ? "Confirmed · report bound" : "Binds this report and session. It does not authorize another transfer."}</small></p></li>
                </ol>
              </div>
            )}
            {status === "quoted" && <button type="button" className="amber-button" onClick={() => isSandbox ? void startPaymentAuthorization() : setStatus("signature-ready")} data-testid="continue-to-signatures">{isSandbox ? "Run sandbox settlement" : "Continue to 2 wallet signatures"}<Icon name="arrow" /></button>}
            {(status === "signature-ready" || status === "authorizing") && <button type="button" className="amber-button" onClick={() => void startPaymentAuthorization()} disabled={status === "authorizing"} data-testid="submit-proof-payment">{status === "authorizing" ? `Waiting for ${walletName}…` : `Authorize 0.01 test USDC · signature 1/2`}<Icon name="arrow" /></button>}
          </section>
        )}

        {!isSandbox && (status === "binding-ready" || status === "binding") && (
          <section className={`proof-binding-handoff ${status === "binding" ? "is-waiting" : ""}`} data-testid="proof-binding-handoff" role="status">
            <div className="binding-latch" aria-hidden="true"><span>01</span><i /><span>02</span></div>
            <p className="eyebrow">Signature 1/2 confirmed · no payment sent</p>
            <h3>Bind this exact proof to this session</h3>
            <p id="proof-binding-explanation"><strong>{walletName}</strong> is selected. This fresh confirmation binds the report, payer and session; it cannot authorize another transfer.</p>
            <button ref={bindingButton} type="button" className="amber-button" onClick={() => void completeProofBinding()} disabled={status === "binding"} data-testid="submit-proof-binding" aria-describedby="proof-binding-explanation">{status === "binding" ? `Waiting for ${walletName}…` : `Open ${walletName} · signature 2/2`}<Icon name="arrow" /></button>
            <button type="button" className="binding-discard" onClick={discardPendingAuthorization} disabled={status === "binding"} data-testid="discard-payment-authorization">Discard authorization · submit nothing</button>
          </section>
        )}

        {(status === "settling" || status === "verifying") && (
          <div className="drawer-loading settlement-progress" role="status">
            <span />
            <p>{status === "settling" ? "Submitting the one bound authorization to the facilitator…" : "Payment settled. Verifying packet integrity, issuer, and Registry v3…"}</p>
          </div>
        )}

        {(status === "uncertain" || status === "recovering") && (
          <section className="payment-uncertain" role="alert" data-testid="payment-uncertain">
            <p className="eyebrow">Payment uncertain · do not sign again</p>
            <h3>A wallet signature exists, but report delivery was not confirmed.</h3>
            <p>The original <code>PAYMENT-SIGNATURE</code> remains in memory only. Recovery replays that exact header; it is never written to localStorage, rendered, or logged.</p>
            <dl>
              <div><dt>Payer</dt><dd><a href={`${integrations?.injective.explorerUrl ?? TESTNET_EXPLORER}/address/${walletAccount ?? ""}`} target="_blank" rel="noreferrer">{truncate(walletAccount ?? undefined, 9, 7)} <Icon name="external" size={12} /></a></dd></div>
              <div><dt>Facilitator / payee</dt><dd><a href={`${integrations?.injective.explorerUrl ?? TESTNET_EXPLORER}/address/${integrations?.x402.payTo ?? ""}`} target="_blank" rel="noreferrer">{truncate(integrations?.x402.payTo ?? undefined, 9, 7)} <Icon name="external" size={12} /></a></dd></div>
              <div><dt>Authorization nonce</dt><dd><code>{truncate(paymentNonce ?? undefined, 12, 10)}</code></dd></div>
            </dl>
            <button type="button" className="amber-button" onClick={() => void recoverPayment()} disabled={status === "recovering"} data-testid="recover-existing-payment">{status === "recovering" ? "Replaying existing signature…" : "Replay existing signature"} <Icon name="arrow" /></button>
          </section>
        )}

        {proof && (
          <section className="proof-packet">
            <div className="packet-seal"><Icon name="shield" /><span><strong>{isFullyVerifiedProof(verification) ? "SAFE TO SETTLE" : "Report delivered · settlement held"}</strong><small>{verification ? (isFullyVerifiedProof(verification) ? "Integrity + issuer + Registry v3 passed" : "All three independent layers have not passed") : "Running independent verification…"}</small></span></div>
            <dl>
              <div><dt>Schema</dt><dd>{proof.packet.schema}</dd></div>
              <div><dt>Packet hash</dt><dd><code>{truncate(proof.packet.packetHash, 12, 10)}</code></dd></div>
              {proof.packet.evidenceRoot && <div><dt>Evidence root</dt><dd><code>{truncate(proof.packet.evidenceRoot, 12, 10)}</code></dd></div>}
              {proof.packet.issuerAddress && <div><dt>Issuer</dt><dd><code>{truncate(proof.packet.issuerAddress, 9, 7)}</code></dd></div>}
              {proof.packet.issuerKeyId && <div><dt>Issuer key ID</dt><dd><code>{truncate(proof.packet.issuerKeyId, 12, 10)}</code></dd></div>}
              {proof.packet.issuerPolicyVersion && <div><dt>Issuer policy</dt><dd><code>{proof.packet.issuerPolicyVersion}</code></dd></div>}
              {proof.packet.issuedAt && <div><dt>Issued at</dt><dd>{new Date(proof.packet.issuedAt).toISOString()}</dd></div>}
              <div><dt>Evidence score</dt><dd>{evidenceScore(proof.packet.verification.confidenceBps)}</dd></div>
              <div><dt>Settlement</dt><dd>{proof.packet.settlement.allowed ? "Allowed" : "Held"}</dd></div>
              {walletAccount && <div><dt>Payer</dt><dd><code>{truncate(walletAccount, 9, 7)}</code></dd></div>}
              {proof.entitlement?.transactionHash && <div><dt>Payment receipt</dt><dd><a href={`${integrations?.injective.explorerUrl ?? TESTNET_EXPLORER}/tx/${proof.entitlement.transactionHash}`} target="_blank" rel="noreferrer">Open transaction <Icon name="external" size={12} /></a></dd></div>}
            </dl>
            <VerificationLayers verification={verification} />
            <div className="packet-checks">
              {([
                ["packet-hash", "Packet hash"],
                ["event-hash", "Canonical event"],
                ["conflicts", "Conflict recomputation"],
                ["anchor", "Anchor hash consistency"],
              ] as const).map(([id, label]) => {
                const check = verification?.checks.find((entry) => entry.id === id);
                return <span key={id} className={check?.passed ? "passed" : check ? "failed" : "pending"}><Icon name={check?.passed ? "check" : "shield"} /> {label}</span>;
              })}
              <span className={verification?.onchain.checked && verification.onchain.valid ? "passed onchain" : verification?.onchain.checked ? "failed onchain" : "not-checked onchain"}><Icon name={verification?.onchain.checked && verification.onchain.valid ? "check" : verification?.onchain.checked ? "close" : "shield"} />{verification?.onchain.checked && verification.onchain.valid ? "Registry lookup verified" : verification?.onchain.checked ? "Registry lookup did not match" : "On-chain not checked"}</span>
            </div>
            {!verification && <button type="button" className="packet-retry" onClick={() => void retryVerification()}>Retry packet verification <Icon name="arrow" /></button>}
            {verification && <button type="button" className={`packet-retry tamper-${tamperResult}`} onClick={() => void runTamperControl()} disabled={tamperResult === "running"} data-testid="tamper-control">{tamperResult === "idle" ? "Run tamper negative control" : tamperResult === "running" ? "Testing altered packet…" : tamperResult === "passed" ? "Tampered packet rejected · PASS" : tamperResult === "unavailable" ? "Tamper control unavailable · RETRY" : "Tampered packet accepted · FAIL"}<Icon name={tamperResult === "passed" ? "check" : "arrow"} /></button>}
          </section>
        )}

        {message && <div className={status === "binding-ready" || (status === "paid" && isFullyVerifiedProof(verification)) ? "drawer-notice" : "drawer-error"} role="alert">{message}</div>}
        <footer><Icon name="wallet" /><p>Proofline never embeds a payer private key. Live mode validates the quoted network, asset, payee and spend cap before requesting an EIP-3009 signature from the connected wallet.</p></footer>
      </aside>
    </div>
  );
}

export function App() {
  const {
    snapshot,
    integrations,
    catalog,
    mcpRuntime,
    error,
    busy,
    judgeDemo,
    load,
    act,
    startJudgeDemo,
    continueJudgeDemo,
    prepareReplayForProof,
  } = useReplay();
  const walletMinimum = useMemo(() => {
    try {
      return BigInt(integrations?.x402.priceAtomic ?? "10000");
    } catch {
      return 10_000n;
    }
  }, [integrations?.x402.priceAtomic]);
  const wallet = useWallet({
    assetAddress: integrations?.x402.asset.address ?? null,
    minimumUsdcBalance: walletMinimum,
    rpcUrl: integrations?.injective.publicRpcUrl ?? "https://k8s.testnet.json-rpc.injective.network/",
    explorerUrl: integrations?.injective.explorerUrl ?? TESTNET_EXPLORER,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URL(window.location.href).searchParams.get("case");
  });
  const [experience, setExperience] = useState<Experience>(() => {
    if (typeof window === "undefined") return "wallet";
    const value = new URL(window.location.href).searchParams.get("experience");
    return value === "audit" || value === "replay" ? value : "wallet";
  });
  const [walletDialogOpen, setWalletDialogOpen] = useState(false);
  const [paymentFlowLocked, setPaymentFlowLocked] = useState(false);
  const [catalogDetail, setCatalogDetail] = useState<CatalogMatchDetail | null>(null);
  const [catalogDetailLoading, setCatalogDetailLoading] = useState(false);
  const [catalogDetailError, setCatalogDetailError] = useState<string | null>(null);
  const [decisionResponse, setDecisionResponse] = useState<DecisionResponse | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTarget, setDrawerTarget] = useState<ProofTarget | null>(null);
  const [proof, setProof] = useState<ProofPacketResponse | null>(null);
  const [proofVerification, setProofVerification] = useState<ProofVerificationResponse | null>(null);
  const previousReplayCursor = useRef(-1);
  const closeProofDrawer = useCallback(() => setDrawerOpen(false), []);
  const openWalletDialog = useCallback(() => setWalletDialogOpen(true), []);
  const closeWalletDialog = useCallback(() => setWalletDialogOpen(false), []);

  const defaultCatalogMatchId = catalog?.matches.find((entry) => entry.dataMode === "delayed")?.id
    ?? catalog?.matches[0]?.id
    ?? snapshot?.match.id
    ?? null;
  const selectedMatchExists = catalog?.matches.some((entry) => entry.id === selectedMatchId) ?? false;
  const activeMatchId = selectedMatchExists ? selectedMatchId : defaultCatalogMatchId;
  const selectedCatalogMatch = useMemo(
    () => catalog?.matches.find((entry) => entry.id === activeMatchId),
    [activeMatchId, catalog],
  );

  useEffect(() => {
    if (!activeMatchId || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("case", activeMatchId);
    url.searchParams.set("experience", experience);
    window.history.replaceState({ case: activeMatchId, experience }, "", url);
  }, [activeMatchId, experience]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handlePopState = () => {
      const url = new URL(window.location.href);
      const requestedCase = url.searchParams.get("case");
      const requestedExperience = url.searchParams.get("experience");
      if (requestedCase) setSelectedMatchId(requestedCase);
      setExperience(requestedExperience === "audit" || requestedExperience === "replay" ? requestedExperience : "wallet");
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (!selectedCatalogMatch || selectedCatalogMatch.dataMode === "historical-replay") {
      setCatalogDetail(null);
      setCatalogDetailError(null);
      setCatalogDetailLoading(false);
      return;
    }
    let cancelled = false;
    setCatalogDetail(null);
    setCatalogDetailError(null);
    setCatalogDetailLoading(true);
    void api.getCatalogMatch(selectedCatalogMatch.id)
      .then((result) => { if (!cancelled) setCatalogDetail(result); })
      .catch((cause: unknown) => {
        if (!cancelled) setCatalogDetailError(cause instanceof Error ? cause.message : "Source detail did not load.");
      })
      .finally(() => { if (!cancelled) setCatalogDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selectedCatalogMatch]);

  useEffect(() => {
    if (!snapshot) return;
    const cursorChanged = previousReplayCursor.current !== snapshot.replay.cursor;
    previousReplayCursor.current = snapshot.replay.cursor;
    if (!snapshot.events.length) {
      setSelectedId(null);
      return;
    }
    if (
      cursorChanged ||
      !selectedId ||
      !snapshot.events.some((record) => record.eventId === selectedId)
    ) {
      setSelectedId(snapshot.events.at(-1)?.eventId ?? null);
      return;
    }
  }, [selectedId, snapshot]);

  const selected = useMemo(
    () => snapshot?.events.find((record) => record.eventId === selectedId) ?? snapshot?.events.at(-1),
    [selectedId, snapshot],
  );

  useEffect(() => {
    setProof(null);
    setProofVerification(null);
  }, [selected?.eventId]);

  useEffect(() => {
    if (!snapshot || !selected) {
      setDecisionResponse(null);
      return;
    }
    let cancelled = false;
    void api.getDecision(snapshot.match.id, selected.eventId)
      .then((result) => { if (!cancelled) setDecisionResponse(result); })
      .catch(() => { if (!cancelled) setDecisionResponse(null); });
    return () => { cancelled = true; };
  }, [selected, snapshot]);

  if (!snapshot && error) return <ErrorScreen message={error} retry={() => void load()} />;
  if (!snapshot) return <LoadingScreen />;

  const matchingDecision = decisionResponse?.eventId === selected?.eventId ? decisionResponse : null;
  const decision = matchingDecision
    ? matchingDecision.decision
    : fallbackDecision(snapshot, selected?.verification, selected?.anchor);
  const anchor = matchingDecision
    ? matchingDecision.anchor ?? selected?.anchor
    : selected?.anchor;
  const packetVerified = proofVerification?.valid === true;
  const onchainVerified =
    proofVerification?.onchain.checked === true && proofVerification.onchain.valid === true;
  const conflictActive = Boolean(selected?.verification?.conflicts.length);
  const showReplay = !selectedCatalogMatch || selectedCatalogMatch.dataMode === "historical-replay";
  const finalResultPending = Boolean(selectedCatalogMatch && selectedCatalogMatch.status !== "finished");
  const activeDataMode = selectedCatalogMatch?.dataMode ?? snapshot.mode;
  const proofMatchId = showReplay ? snapshot.match.id : selectedCatalogMatch.id;
  // The premium route is a settlement report, so it always binds the anchored
  // final result. Per-event evidence remains inspectable for free in the tape.
  const proofEventId = "final-result";
  const openProofDrawer = () => {
    setDrawerTarget({ matchId: proofMatchId, eventId: proofEventId, replay: showReplay });
    setDrawerOpen(true);
  };
  const activeDrawerTarget = drawerTarget ?? {
    matchId: proofMatchId,
    eventId: proofEventId,
    replay: showReplay,
  };
  const prepareTargetProof = async (eventId: string, signal?: AbortSignal): Promise<void> => {
    if (showReplay) {
      await prepareReplayForProof(eventId, signal);
      return;
    }
    if (signal?.aborted) throw new DOMException("Proof preparation canceled.", "AbortError");
    await api.verifyMatchAnchor(proofMatchId, eventId);
    if (signal?.aborted) throw new DOMException("Proof preparation canceled.", "AbortError");
  };
  const chooseExperience = (next: Experience) => {
    setExperience(next);
    setProof(null);
    setProofVerification(null);
  };
  const openConflictReplay = () => {
    const replayMatchId = catalog?.matches.find((entry) => entry.dataMode === "historical-replay")?.id ?? snapshot.match.id;
    setSelectedMatchId(replayMatchId);
    setExperience("replay");
  };
  const experienceTabs = (
    <div className="experience-tabs" role="tablist" aria-label="Judge experience">
      {EXPERIENCE_OPTIONS.map(([id, label], index) => (
        <button
          key={id}
          id={`experience-tab-${id}`}
          type="button"
          role="tab"
          aria-selected={experience === id}
          aria-controls={`experience-panel-${id}`}
          tabIndex={experience === id ? 0 : -1}
          onClick={() => chooseExperience(id)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const direction = event.key === "ArrowRight" ? 1 : -1;
            const nextIndex = (index + direction + EXPERIENCE_OPTIONS.length) % EXPERIENCE_OPTIONS.length;
            const next = EXPERIENCE_OPTIONS[nextIndex]![0];
            if (paymentFlowLocked && next !== experience) return;
            chooseExperience(next);
            window.requestAnimationFrame(() => document.getElementById(`experience-tab-${next}`)?.focus());
          }}
          disabled={paymentFlowLocked && experience !== id}
          data-testid={`experience-${id}`}
        >{label}</button>
      ))}
    </div>
  );
  const catalogActionPanel = selectedCatalogMatch ? (
    <section className="judge-experience-panel" data-experience={experience}>
      {experienceTabs}
      <div id={`experience-panel-${experience}`} role="tabpanel" aria-labelledby={`experience-tab-${experience}`}>
      {experience === "wallet" && selectedCatalogMatch.status !== "finished" ? (
        <section className="scheduled-proof-hold" role="status">
          <p className="eyebrow">Final-result policy</p>
          <h2>Proof opens after full time.</h2>
          <p>This fixture has no final score or settlement event. Proofline will not create a quote, request a wallet signature, or claim a result before the match ends and independent evidence converges.</p>
          <dl><div><dt>Match state</dt><dd>{selectedCatalogMatch.status}</dd></div><div><dt>Payment</dt><dd>Not available</dd></div><div><dt>Settlement</dt><dd>Held</dd></div></dl>
        </section>
      ) : experience === "wallet" ? (
        <ProofDrawer
          open
          presentation="embedded"
          matchId={selectedCatalogMatch.id}
          eventId={proofEventId}
          replay={null}
          integrations={integrations}
          wallet={wallet}
          onOpenWallet={openWalletDialog}
          onPrepareProof={prepareTargetProof}
          onClose={() => undefined}
          onProof={setProof}
          onVerification={setProofVerification}
          onLockChange={setPaymentFlowLocked}
        />
      ) : experience === "audit" ? <NoWalletAudit /> : <ConflictReplayEntry onOpenReplay={openConflictReplay} />}
      </div>
    </section>
  ) : null;

  return (
    <div className="app-shell">
      <AppHeader
        integrations={integrations}
        mode={activeDataMode}
        catalog={catalog}
        activeMatchId={activeMatchId}
        onSelectMatch={setSelectedMatchId}
        matchSelectionDisabled={paymentFlowLocked}
        wallet={wallet}
        walletDialogOpen={walletDialogOpen}
        onOpenWallet={openWalletDialog}
        onCloseWallet={closeWalletDialog}
      />
      <div className="task-brief-strip" role="status">
        <strong>{activeDataMode === "historical-replay" ? "HISTORICAL REPLAY · NOT LIVE" : finalResultPending ? "SCHEDULED · NO RESULT" : "TESTNET ONLY"}</strong>
        <span>{showReplay ? "Synthetic conflict is disclosed and no payment is required." : finalResultPending ? "Final proof and payment remain unavailable until independently verified full time." : "Connect → review 0.01 test USDC → sign twice → verify three proof layers."}</span>
        <small>{showReplay ? "All source timestamps and fault injection remain visible." : finalResultPending ? "0 signatures · 0 payments" : "2 signatures · 1 payment · 0 wallet-broadcast transactions"}</small>
      </div>
      {!showReplay && (
        <button
          type="button"
          className="mobile-next-action"
          onClick={() => {
            if (finalResultPending) {
              chooseExperience("audit");
              document.querySelector(".judge-workspace__action")?.scrollIntoView({ behavior: "smooth", block: "start" });
              return;
            }
            if (experience === "wallet" && integrations?.x402.mode !== "live") {
              chooseExperience("audit");
              document.querySelector(".judge-workspace__action")?.scrollIntoView({ behavior: "smooth", block: "start" });
              return;
            }
            if (experience === "wallet" && !wallet.account) {
              setWalletDialogOpen(true);
              return;
            }
            document.querySelector(".judge-workspace__action")?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
          data-testid="mobile-next-action"
        >
          <span>{finalResultPending ? "Inspect completed proof sample" : experience === "wallet" ? integrations?.x402.mode !== "live" ? "Open no-wallet audit" : wallet.account ? "Continue wallet proof" : "Connect test wallet" : experience === "audit" ? "Open no-wallet audit" : "Open conflict replay"}</span>
          <Icon name="arrow" />
        </button>
      )}

      {error && <div className="inline-error" role="alert"><span>Signal interruption</span>{error}<button type="button" onClick={() => void load()}>Reconnect</button></div>}
      {snapshot.errors.map((runtimeError) => {
        const anchorFailure = runtimeError.frameId.includes("anchor") || runtimeError.message.toLowerCase().includes("anchor");
        return (
          <div className="runtime-alert" role="alert" key={`${runtimeError.frameId}-${runtimeError.message}`}>
            <Icon name="shield" />
            <div>
              <strong>{anchorFailure ? "Chain anchor failed · settlement remains held" : "Replay frame failed · evidence not advanced"}</strong>
              <span>{runtimeError.frameId}: {runtimeError.message}</span>
            </div>
          </div>
        );
      })}

      {showReplay ? <><JudgeDemo
        state={judgeDemo}
        cursor={snapshot.replay.cursor}
        total={snapshot.replay.totalFrames}
        paymentVerified={packetVerified}
        chainVerified={onchainVerified}
        onStart={() => void startJudgeDemo()}
        onContinue={() => void continueJudgeDemo()}
        onInspectProof={openProofDrawer}
      />

      <main id="match-sheet" className="match-sheet is-revised">
        <section className="decision-board" aria-label="Three-question settlement summary">
          <article className="decision-question question-happened" data-question="what-happened">
            <div className="question-label"><span>01</span><p><strong>What happened?</strong><small>Recorded match state</small></p></div>
            <Scoreboard snapshot={snapshot} />
          </article>

          <article className="decision-question question-trust" data-question="evidence-trust">
            <div className="question-label inverse"><span>02</span><p><strong>Do we believe it?</strong><small>Deterministic evidence policy</small></p></div>
            <Proofline record={selected} />
          </article>

          <article className="decision-question question-settle" data-question="agent-settlement">
            <SettlementGate
              key={`${decision.allowed ? "gate-open" : "gate-held"}-${onchainVerified}`}
              decision={decision}
              anchor={anchor}
              onchainVerified={onchainVerified}
              openProof={openProofDrawer}
            />
          </article>
        </section>

        <section className="evidence-workbench" aria-labelledby="workbench-heading">
          <div className="workbench-heading"><p className="eyebrow">Evidence workbench</p><h2 id="workbench-heading">Open only the detail you need</h2></div>

          <details className="detail-panel" data-testid="replay-details">
            <summary><span>Replay controls & match timeline</span><small>Manual frame control · {snapshot.events.length} canonical events</small></summary>
            <div className="detail-grid replay-detail-grid">
              <ReplayControls snapshot={snapshot} busy={busy} onAction={(action) => void act(action)} />
              <EventTimeline records={snapshot.events} selectedId={selected?.eventId ?? null} onSelect={setSelectedId} />
            </div>
          </details>

          <details className={`detail-panel ${conflictActive ? "has-active-conflict" : ""}`} data-testid="source-details">
            <summary><span>Source evidence & mismatch fields</span><small>{conflictActive ? "Conflict active · settlement quarantined" : `${selected?.observations.length ?? 0} attributed observations`}</small></summary>
            <EvidenceRail record={selected} />
          </details>

          <details className="detail-panel" data-testid="chain-details">
            <summary><span>Injective commitment & x402 proof</span><small>{onchainVerified ? "Fresh registry lookup verified" : anchor?.receipt.mode === "demo" ? "Demo commitment · no chain transaction" : "External checks pending"}</small></summary>
            <div className="detail-grid infrastructure-detail-grid">
              <AnchorReceiptView anchor={anchor} verification={selected?.verification} integrations={integrations} />
              <div className="proof-entry-card"><Icon name="shield" /><h3>Verify the paid packet</h3><p>Negotiate HTTP 402, inspect exact terms, then independently recompute integrity and query the registry.</p><button type="button" className="amber-button" onClick={openProofDrawer}>Inspect x402 + chain proof <Icon name="arrow" /></button></div>
            </div>
          </details>

          <details className="detail-panel" data-testid="agent-details">
            <summary><span>Agent execution evidence</span><small>Illustrative until runtime health and logs are available</small></summary>
            <AgentTrace snapshot={snapshot} record={selected} proof={proof} decision={decision} proofVerification={proofVerification} runtime={mcpRuntime} />
          </details>

          <details className="detail-panel future-panel" data-testid="future-details">
            <summary><span>Future capability</span><small>CCTP deliberately outside the core judge path</small></summary>
            <FundingReadiness integrations={integrations} />
          </details>
        </section>
      </main></> : selectedCatalogMatch ? <CatalogMatchView match={selectedCatalogMatch} detail={catalogDetail} loading={catalogDetailLoading} detailError={catalogDetailError} actionPanel={catalogActionPanel} /> : null}

      <footer className="site-footer">
        <span>PROOFLINE / VARA ENGINE</span>
        <p>Display reported events. Settle only verified evidence.</p>
        <div className="build-stamp" aria-label={`Build commit ${BUILD_COMMIT}; release ${RELEASE_ID}`}>
          <code>commit {BUILD_COMMIT.slice(0, 12)}</code>
          <code>release {RELEASE_ID}</code>
        </div>
        <span className="footer-runtime">MCP runtime: {mcpRuntime?.agentReady ? "ready" : mcpRuntime?.health === "stale" ? "stale" : "not connected"}</span>
        <a href={integrations?.injective.explorerUrl ?? TESTNET_EXPLORER} target="_blank" rel="noreferrer">Injective testnet <Icon name="external" size={13} /></a>
      </footer>

      <div className="sr-only" aria-live="polite">
        Frame {snapshot.replay.cursor} of {snapshot.replay.totalFrames}. {snapshot.lastFrame?.label ?? "Replay reset."}
      </div>

      <ProofDrawer
        open={drawerOpen}
        matchId={activeDrawerTarget.matchId}
        eventId={activeDrawerTarget.eventId}
        replay={activeDrawerTarget.replay ? snapshot : null}
        integrations={integrations}
        wallet={wallet}
        onOpenWallet={openWalletDialog}
        onPrepareProof={prepareTargetProof}
        onClose={closeProofDrawer}
        onProof={setProof}
        onVerification={setProofVerification}
        onLockChange={setPaymentFlowLocked}
      />
    </div>
  );
}
