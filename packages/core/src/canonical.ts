import { keccak256, stringToHex } from "viem";

import type { CanonicalEvent, EventPayload } from "./types.js";

function clean(value: string | undefined): string | null {
  if (value === undefined) return null;
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function integer(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value)) throw new Error("Event time must be finite");
  return Math.max(0, Math.trunc(value));
}

export function canonicalEventJson(payload: EventPayload): string {
  const value = {
    schema: "proofline.event.v1",
    matchId: clean(payload.matchId),
    eventType: payload.eventType,
    minute: integer(payload.minute),
    stoppage: integer(payload.stoppage),
    period: clean(payload.period),
    team: clean(payload.team),
    player: clean(payload.player),
    relatedPlayer: clean(payload.relatedPlayer),
    card: payload.card ?? null,
    score: payload.score
      ? {
          home: integer(payload.score.home),
          away: integer(payload.score.away),
          homePenalties: integer(payload.score.homePenalties),
          awayPenalties: integer(payload.score.awayPenalties),
        }
      : null,
    occurredAt: new Date(payload.occurredAt).toISOString(),
  };

  return JSON.stringify(value);
}

export function canonicalizeEvent(payload: EventPayload): CanonicalEvent {
  const canonicalJson = canonicalEventJson(payload);
  return {
    ...payload,
    matchId: payload.matchId.trim().toUpperCase(),
    minute: Math.max(0, Math.trunc(payload.minute)),
    canonicalJson,
    eventHash: keccak256(stringToHex(canonicalJson)),
  };
}

export function differingFields(left: EventPayload, right: EventPayload): string[] {
  const fields: Array<keyof EventPayload> = [
    "matchId",
    "eventType",
    "minute",
    "stoppage",
    "period",
    "team",
    "player",
    "relatedPlayer",
    "card",
    "score",
    "occurredAt",
  ];

  return fields.filter((field) => {
    const leftValue = left[field];
    const rightValue = right[field];
    return JSON.stringify(leftValue ?? null) !== JSON.stringify(rightValue ?? null);
  });
}
