import { useMemo, useState } from "react";

import { PREVIOUSLY_VERIFIED_SAMPLE } from "../data/verifiedSample";
import { api } from "../lib/api";
import type {
  CatalogMatchDetail,
  EventObservation,
  MatchCatalogEntry,
  MatchCatalogResponse,
  VerifyAnchorResponse,
} from "../types";

type AuditState = "idle" | "running" | "passed" | "held";

function shortHash(value: string | undefined, start = 12, end = 10): string {
  if (!value) return "Awaiting source detail";
  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

function formatKickoff(value: string | null, fallback: string): string {
  if (!value) return fallback;
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

function formatRetrieved(value: string): string {
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

function sourceSnapshotHash(observation: EventObservation): string | undefined {
  return observation.provenance?.sourceSnapshotHash ?? observation.provenance?.rawPayloadHash;
}

function observationScore(observation: EventObservation): string {
  const score = observation.payload.score;
  return score ? `${score.home}–${score.away}` : "No score";
}

function evidenceEvent(detail: CatalogMatchDetail | null) {
  return detail?.events.find((event) => event.eventId === "final-result") ?? detail?.events[0];
}

function PreviouslyVerifiedSample() {
  const sample = PREVIOUSLY_VERIFIED_SAMPLE;
  const [freshCheck, setFreshCheck] = useState<
    "idle" | "running" | "passed" | "failed"
  >("idle");
  const [freshMessage, setFreshMessage] = useState(
    "Run a fresh packet, issuer, and latest Registry v3 check without a wallet.",
  );
  const verifyPublishedSample = async () => {
    setFreshCheck("running");
    setFreshMessage("Loading the published packet and reading the latest registry revision…");
    try {
      const published = await api.getFeaturedProofSample();
      const report = await api.verifyProof(published.packet);
      const passed =
        published.paymentExecutedByThisRequest === false &&
        report.valid &&
        report.integrity?.valid === true &&
        report.signature?.valid === true &&
        report.onchain.checked &&
        report.onchain.valid;
      setFreshCheck(passed ? "passed" : "failed");
      setFreshMessage(
        passed
          ? "Fresh check passed: packet integrity, trusted issuer, and latest Registry v3 commitment all match. No payment was executed."
          : "The public sample did not clear every fresh verification layer. No payment was executed.",
      );
    } catch (cause) {
      setFreshCheck("failed");
      setFreshMessage(
        `Fresh verification was unavailable. No payment was executed. ${cause instanceof Error ? cause.message : ""}`,
      );
    }
  };
  return (
    <section className="previous-sample" aria-labelledby="previous-sample-heading" data-testid="previously-verified-sample">
      <div className="sample-kicker">
        <span>Previously verified sample</span>
        <strong>No wallet required</strong>
      </div>
      <h2 id="previous-sample-heading">Audit a completed proof path.</h2>
      <p>
        This exact 2026 packet passed all three verification layers and a real
        0.01 test-USDC x402 settlement on 11 Jul 2026. Opening it does not
        connect a wallet, create a signature, or execute another payment.
      </p>

      <div className="sample-match">
        <small>{sample.network}</small>
        <strong>{sample.label}</strong>
        <span>{sample.proof.evidenceScore}</span>
      </div>

      <ol className="sample-layers" aria-label="Previously verified proof layers">
        {sample.proof.layers.map((layer, index) => (
          <li key={layer.id}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <p><strong>{layer.label}</strong><small>{layer.detail}</small></p>
            <i>PASS</i>
          </li>
        ))}
      </ol>

      <div className="sample-fresh-check" data-state={freshCheck} role="status">
        <p>{freshMessage}</p>
        <button
          type="button"
          onClick={() => void verifyPublishedSample()}
          disabled={freshCheck === "running"}
          data-testid="verify-published-sample"
        >
          {freshCheck === "running"
            ? "Reading Registry v3…"
            : freshCheck === "passed"
              ? "Fresh verification passed"
              : "Run fresh no-wallet verification"}
        </button>
      </div>

      <details className="sample-technical">
        <summary>Inspect published identifiers</summary>
        <dl>
          <div><dt>Evidence root</dt><dd><code title={sample.proof.evidenceRoot}>{shortHash(sample.proof.evidenceRoot)}</code></dd></div>
          <div><dt>Packet hash</dt><dd><code title={sample.proof.packetHash}>{shortHash(sample.proof.packetHash)}</code></dd></div>
          <div><dt>Trusted issuer</dt><dd><code title={sample.proof.issuerAddress}>{shortHash(sample.proof.issuerAddress, 9, 7)}</code></dd></div>
        </dl>
      </details>

      <nav className="sample-links" aria-label="No-wallet audit links">
        <a href={sample.registry.url} target="_blank" rel="noreferrer">Verified contract ↗</a>
        <a href={sample.anchor.url} target="_blank" rel="noreferrer">Anchor transaction ↗</a>
        <a href={sample.x402.url} target="_blank" rel="noreferrer">x402 receipt ↗</a>
        <a href={sample.auditJsonUrl} target="_blank" rel="noreferrer">Raw audit JSON ↗</a>
      </nav>
    </section>
  );
}

function SourceLane({ observation, index, freshnessBps, freshnessStatus, ageSeconds }: {
  observation: EventObservation;
  index: number;
  freshnessBps: number | undefined;
  freshnessStatus: string | undefined;
  ageSeconds: number | undefined;
}) {
  const hash = sourceSnapshotHash(observation);
  const freshness = freshnessStatus ?? "frozen-at-retrieval";
  const age = ageSeconds === undefined
    ? "Snapshot age was not supplied by this API version."
    : `Snapshot age ${Math.max(0, Math.round(ageSeconds / 3600))}h at request time.`;
  return (
    <article className="source-lane" data-source-group={observation.source.independenceGroup}>
      <div className="source-lane-head">
        <span>Lane {String(index + 1).padStart(2, "0")}</span>
        <strong>{observation.source.independenceGroup}</strong>
        <i aria-hidden="true" />
      </div>
      <h3>{observation.source.label}</h3>
      <a href={observation.source.url} target="_blank" rel="noreferrer" aria-label={`Open ${observation.source.label} source`}>
        Open attributed source ↗
      </a>
      <dl>
        <div><dt>Reported result</dt><dd>{observationScore(observation)}</dd></div>
        <div><dt>Retrieved at</dt><dd>{formatRetrieved(observation.receivedAt)}</dd></div>
        <div><dt>sourceSnapshotHash</dt><dd><code title={hash}>{shortHash(hash)}</code></dd></div>
        <div><dt>Freshness</dt><dd><span className="freshness-chip" data-freshness={freshness}>{freshness.replaceAll("-", " ")}</span><small>{age} Policy score was frozen at capture: {freshnessBps === undefined ? "not supplied" : `${(freshnessBps / 100).toFixed(0)}/100`}.</small></dd></div>
      </dl>
    </article>
  );
}

export function MatchCatalogBar({ catalog, selectedId, detail, onSelect }: {
  catalog: MatchCatalogResponse | null;
  selectedId: string;
  detail: CatalogMatchDetail | null;
  onSelect: (id: string) => void;
}) {
  if (!catalog?.matches.length) return null;
  const selected = catalog.matches.find((entry) => entry.id === selectedId) ?? catalog.matches[0]!;
  const sourceGroups = new Set(
    evidenceEvent(detail)?.observations.map((observation) => observation.source.independenceGroup) ?? [],
  ).size;
  return (
    <section className="match-catalog-bar" aria-label="2026 and replay match selector">
      <div className="catalog-selector">
        <label htmlFor="match-catalog">Evidence case</label>
        <select id="match-catalog" value={selected.id} onChange={(event) => onSelect(event.target.value)} data-testid="match-selector">
          {catalog.matches.map((entry) => <option key={entry.id} value={entry.id}>{entry.season} · {entry.label} · {entry.dataMode}</option>)}
        </select>
      </div>
      <div className="catalog-mode" data-mode={selected.dataMode}>
        <span>{selected.dataMode.replaceAll("-", " ")}</span>
        <p>{selected.disclosure}</p>
        {selected.freshnessStatus && <em className="freshness-chip" data-freshness={selected.freshnessStatus}>{selected.freshnessStatus.replaceAll("-", " ")}</em>}
      </div>
      <div className="catalog-source">
        <span>{sourceGroups > 0 ? `${sourceGroups} independent source groups` : "Source snapshot"}</span>
        <a href={selected.source.url} target="_blank" rel="noreferrer">{selected.source.label} ↗</a>
      </div>
    </section>
  );
}

export function CatalogMatchView({ match, detail, loading, detailError, onVerifyAnchor, onOpenProof, onOpenReplay }: {
  match: MatchCatalogEntry;
  detail: CatalogMatchDetail | null;
  loading: boolean;
  detailError: string | null;
  onVerifyAnchor: () => Promise<VerifyAnchorResponse>;
  onOpenProof: () => void;
  onOpenReplay: () => void;
}) {
  const [auditState, setAuditState] = useState<AuditState>("idle");
  const [anchorResult, setAnchorResult] = useState<VerifyAnchorResponse | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const hasScore = match.score !== null;
  const event = evidenceEvent(detail);
  const activeObservations = useMemo(
    () => event?.observations.filter((observation) => !observation.retracted) ?? [],
    [event],
  );
  const groups = new Set(activeObservations.map((observation) => observation.source.independenceGroup));
  const hashesAttached = activeObservations.length > 0 && activeObservations.every((observation) => Boolean(sourceSnapshotHash(observation)));
  const scoresAgree = activeObservations.length > 1 && new Set(activeObservations.map(observationScore)).size === 1;
  const policyVerified = event?.verification?.state === "verified";
  const auditPassed = groups.size >= 2 && hashesAttached && scoresAgree && policyVerified;

  const verifyResult = async () => {
    if (loading) return;
    setAuditError(null);
    setAuditState("running");
    if (!auditPassed) {
      window.setTimeout(() => setAuditState("held"), 380);
      return;
    }
    try {
      const result = await onVerifyAnchor();
      setAnchorResult(result);
      setAuditState("passed");
    } catch (cause) {
      setAuditError(cause instanceof Error ? cause.message : "The verified result could not be anchored.");
      setAuditState("held");
    }
  };

  return (
    <main className="catalog-match-view is-audit-led" data-testid="catalog-match-view">
      <section className="catalog-result-card">
        <div className="case-file-line"><span>CASE / M97</span><strong>Previously played · independently reviewable</strong></div>
        <p className="eyebrow">2026 result desk · delayed evidence</p>
        <h1>Verify the result,<br />not the refresh icon.</h1>
        <p className="catalog-thesis">This match is finished. Proofline checks whether two independent source groups reported the same final score and attached auditable snapshots.</p>

        <div className="catalog-status"><span>{match.dataMode.toUpperCase()}</span>{match.status === "finished" ? "FULL TIME" : "SCHEDULED"}</div>
        <div className="catalog-score" aria-label={`${match.homeTeam} ${match.score?.home ?? 0}, ${match.awayTeam} ${match.score?.away ?? 0}`}>
          <span>{match.homeTeam}</span><strong>{hasScore ? match.score!.home : "—"}</strong><i>:</i><strong>{hasScore ? match.score!.away : "—"}</strong><span>{match.awayTeam}</span>
        </div>
        <p className="catalog-fixture-meta">{formatKickoff(match.scheduledAt, match.scheduledDate)} · {match.venue}</p>

        <div className="catalog-actions">
          <button type="button" className="verify-2026-button" onClick={() => void verifyResult()} disabled={!hasScore || loading || auditState === "running"} data-testid="verify-2026-result">
            <span>{auditState === "running" ? "Verifying & anchoring…" : auditState === "passed" ? "2026 evidence anchored" : "Verify this 2026 result"}</span>
            <i aria-hidden="true">→</i>
          </button>
          <button type="button" className="replay-secondary-button" onClick={onOpenReplay} data-testid="run-conflict-replay">Run conflict replay</button>
        </div>

        <div className={`catalog-audit-result audit-${auditState}`} role="status" aria-live="polite" data-testid="catalog-audit-result">
          <span aria-hidden="true" />
          <div>
            <strong>{auditState === "passed" ? "Independent evidence anchored" : auditState === "held" ? "Evidence audit held" : auditState === "running" ? "Comparing source lanes" : "No-wallet audit ready"}</strong>
            <p>{auditState === "passed" ? `${groups.size} independent groups agree on ${observationScore(activeObservations[0]!)}. The API returned a matching ${anchorResult?.anchor.receipt.mode ?? "Injective"} commitment; x402 proof quote is now available.` : auditState === "held" ? auditError ?? "The API response did not satisfy every independent-source check. No verification claim was made." : auditState === "running" ? "Comparing attributed snapshots and preparing the matching Injective commitment." : "Checks source-group independence, score agreement, snapshot hashes, and policy state. It does not sign or spend."}</p>
            {auditState === "passed" && <div className="audit-anchor-result"><code title={anchorResult?.evidenceRoot}>{shortHash(anchorResult?.evidenceRoot)}</code>{anchorResult?.anchor.receipt.explorerUrl && <a href={anchorResult.anchor.receipt.explorerUrl} target="_blank" rel="noreferrer">Open anchor ↗</a>}<button type="button" onClick={onOpenProof} data-testid="open-2026-proof">Request 2026 proof quote →</button></div>}
          </div>
        </div>
      </section>

      <section className="catalog-trust-card" aria-labelledby="source-lanes-heading">
        <div className="source-grid-heading">
          <div><p className="eyebrow light">VAR source convergence</p><h2 id="source-lanes-heading">Two lanes. One result.</h2></div>
          <span>{groups.size || "—"}/2 groups</span>
        </div>
        <p className="source-grid-disclosure">ESPN and FIFA are counted once each. Repeating either feed cannot add voting weight.</p>

        {loading ? (
          <div className="source-lanes-loading" role="status"><span /><p>Retrieving attributed source snapshots…</p></div>
        ) : detailError ? (
          <div className="source-lanes-error" role="alert"><strong>Source detail unavailable</strong><p>{detailError}</p></div>
        ) : activeObservations.length ? (
          <div className={`source-lanes ${auditState === "running" ? "is-scanning" : ""} ${auditState === "passed" ? "is-converged" : ""}`}>
            {activeObservations.map((observation, index) => (
              <SourceLane key={observation.id} observation={observation} index={index} freshnessBps={event?.verification?.breakdown.freshnessBps} freshnessStatus={match.freshnessStatus} ageSeconds={match.ageSeconds} />
            ))}
            <div className="source-convergence" aria-label="Independent sources converge on the same result">
              <i aria-hidden="true" /><span>{scoresAgree ? "RESULTS MATCH" : "AWAITING MATCH"}</span><strong>{scoresAgree ? observationScore(activeObservations[0]!) : "—"}</strong>
            </div>
          </div>
        ) : (
          <div className="source-lanes-error"><strong>No result evidence</strong><p>This case has no final observations to compare.</p></div>
        )}
      </section>

      <PreviouslyVerifiedSample />
    </main>
  );
}
