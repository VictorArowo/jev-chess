import type { Chess } from "chess.js";
import type { Candidate, MoveResponse } from "../server/jev";
import type { Verdict } from "./referee";

// The game format shared by the page and the recorder (scripts/record.ts).

export interface Ply {
  fenBefore: string;
  san: string;
  uci: string;
  rank: number; // 1 = Jev's top choice
  temperature: number; // what the move was sampled at
  candidates: Candidate[];
  confidence: number;
  latencyMs: number;
  costUsd?: number;
  model: string;
  forced?: boolean; // the only legal move; Jev wasn't asked
  verdict?: Verdict; // Stockfish's grade; live games fill it in asynchronously
}

export interface Persona {
  name: string;
  persona: string;
}
export type Personas = { w: Persona; b: Persona };

export interface RecordedGame {
  id: string;
  title: string;
  recordedAt: string;
  model: string;
  temperature: number;
  personas: Personas;
  result: string;
  plies: Ply[];
}

export type GameSummary = Omit<RecordedGame, "plies" | "personas"> & { plyCount: number };

export const DEFAULT_PERSONAS: Personas = {
  w: { name: "White Jev", persona: "Aggressive attacker. Seeks the initiative, open lines and threats against the enemy king." },
  b: { name: "Black Jev", persona: "Solid positional player. Prefers sound development, healthy pawn structure and long-term advantages." },
};

export const MAX_PLIES = 200;

export function sample(cands: Candidate[], temperature: number): number {
  if (temperature <= 0.01) return 0;
  const w = cands.map((c) => Math.pow(c.p, 1 / temperature));
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < w.length; i++) if ((r -= w[i]) <= 0) return i;
  return 0;
}

export function toPly(fenBefore: string, r: MoveResponse, idx: number, temperature: number): Ply {
  const pick = r.candidates[idx];
  return {
    fenBefore,
    san: pick.san,
    uci: pick.uci,
    rank: idx + 1,
    temperature,
    candidates: r.candidates,
    confidence: r.confidence,
    latencyMs: r.latencyMs,
    costUsd: r.costUsd,
    model: r.model,
    ...(r.forced && { forced: true }),
  };
}

export function isOver(chess: Chess, plies: number): boolean {
  return chess.isGameOver() || plies >= MAX_PLIES;
}

export function resultText(chess: Chess, plies: number): string {
  if (chess.isCheckmate()) return `Checkmate. ${chess.turn() === "w" ? "Black" : "White"} Jev wins.`;
  if (chess.isStalemate()) return "Draw by stalemate.";
  if (chess.isThreefoldRepetition()) return "Draw by threefold repetition.";
  if (chess.isInsufficientMaterial()) return "Draw by insufficient material.";
  if (chess.isDraw()) return "Draw by the fifty-move rule.";
  if (plies >= MAX_PLIES) return `Stopped at ${MAX_PLIES} plies.`;
  return "";
}
