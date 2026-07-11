import type { MatchCatalogEntry, MatchCatalogResponse } from "../types";

function shortHash(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-10)}`;
}

function formatKickoff(value: string | null, fallback: string): string {
  if (!value) return fallback;
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function MatchCatalogBar({ catalog, selectedId, onSelect }: {
  catalog: MatchCatalogResponse | null;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  if (!catalog?.matches.length) return null;
  const selected = catalog.matches.find((entry) => entry.id === selectedId) ?? catalog.matches[0]!;
  return (
    <section className="match-catalog-bar" aria-label="2026 and replay match selector">
      <div className="catalog-selector">
        <label htmlFor="match-catalog">Evidence feed</label>
        <select id="match-catalog" value={selectedId} onChange={(event) => onSelect(event.target.value)} data-testid="match-selector">
          {catalog.matches.map((entry) => <option key={entry.id} value={entry.id}>{entry.season} · {entry.label} · {entry.dataMode}</option>)}
        </select>
      </div>
      <div className="catalog-mode" data-mode={selected.dataMode}><span>{selected.dataMode.replaceAll("-", " ")}</span><p>{selected.disclosure}</p></div>
      <div className="catalog-source"><span>Source snapshot</span><a href={selected.source.url} target="_blank" rel="noreferrer">{selected.source.label} ↗</a></div>
    </section>
  );
}

export function CatalogMatchView({ match, onOpenReplay }: { match: MatchCatalogEntry; onOpenReplay: () => void }) {
  const hasScore = match.score !== null;
  return (
    <main className="catalog-match-view" data-testid="catalog-match-view">
      <section className="catalog-result-card">
        <p className="eyebrow">Question 01 · What happened?</p>
        <div className="catalog-status"><span>{match.dataMode.toUpperCase()}</span>{match.status === "finished" ? "FULL TIME" : "SCHEDULED"}</div>
        <div className="catalog-score">
          <span>{match.homeTeam}</span><strong>{hasScore ? match.score!.home : "—"}</strong><i>:</i><strong>{hasScore ? match.score!.away : "—"}</strong><span>{match.awayTeam}</span>
        </div>
        <p>{formatKickoff(match.scheduledAt, match.scheduledDate)} · {match.venue}</p>
      </section>

      <section className="catalog-trust-card">
        <p className="eyebrow light">Question 02 · Do we believe it?</p>
        <h2>{hasScore ? "A recent result with inspectable provenance" : "An official fixture, not a live score"}</h2>
        <p>{match.disclosure}</p>
        <dl>
          <div><dt>Provider</dt><dd>{match.source.provider}</dd></div>
          <div><dt>Retrieved</dt><dd>{new Date(match.source.retrievedAt).toISOString()}</dd></div>
          <div><dt>Raw payload hash</dt><dd><code>{shortHash(match.source.rawPayloadHash)}</code></dd></div>
          <div><dt>Adapter</dt><dd><code>{match.source.adapterVersion}</code></dd></div>
        </dl>
        <a href={match.source.url} target="_blank" rel="noreferrer">Inspect attributed provider snapshot ↗</a>
      </section>

      <section className="catalog-gate-card">
        <p className="eyebrow">Question 03 · Can the Agent settle?</p>
        <span>HELD</span>
        <h2>{hasScore ? "Result observed, proof workflow not run" : "Match has not finished"}</h2>
        <p>{hasScore ? "A delayed score never auto-settles. Open the conflict replay to run corroboration, packet payment, and chain verification." : "Proofline refuses a final conclusion for scheduled matches without finished event evidence."}</p>
        <button type="button" onClick={onOpenReplay}>Open the historical conflict demo →</button>
      </section>
    </main>
  );
}
