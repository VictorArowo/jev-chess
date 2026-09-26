import { Chess } from "chess.js";
import type { Engine, Score } from "./engine";
import type { Candidate } from "../server/jev";

// Grades a move the way Lichess does: by how much winning chance it gave away.
// Winning chances live in [-1, 1]; thresholds 0.1 / 0.2 / 0.3 mark inaccuracy / mistake / blunder.

export type Grade = "best" | "good" | "inaccuracy" | "mistake" | "blunder";

export const GRADE_INFO: Record<Grade, { label: string; glyph: string }> = {
  best: { label: "Best", glyph: "" },
  good: { label: "Good", glyph: "" },
  inaccuracy: { label: "Inaccuracy", glyph: "?!" },
  mistake: { label: "Mistake", glyph: "?" },
  blunder: { label: "Blunder", glyph: "??" },
};

export interface Verdict {
  grade: Grade;
  bestUci: string;
  bestSan: string;
  sfTop: string[]; // Stockfish's top moves (UCI), best first
  evalBefore: Score; // White's point of view
  evalAfter: Score; // White's point of view, after the move Jev played
  winLoss: number; // winning-chance drop for the mover, 0..2
  accuracy: number; // Lichess-style per-move accuracy, 0..100
  jevRankOfBest: number; // where Stockfish's move sat in Jev's distribution (1 = top)
  jevPOfBest: number;
}

export const DEPTH = 14;

export function toCp(s: Score): number {
  if ("cp" in s) return s.cp;
  if (s.mate === 0) return -10_000; // side to move is mated
  return s.mate > 0 ? 10_000 - s.mate : -10_000 - s.mate;
}

const negate = (s: Score): Score => ("cp" in s ? { cp: -s.cp } : { mate: -s.mate });

export function winChance(s: Score): number {
  const cp = Math.max(-1000, Math.min(1000, toCp(s)));
  return 2 / (1 + Math.exp(-0.00368208 * cp)) - 1;
}

export const winPct = (s: Score) => 50 + 50 * winChance(s);

function gradeFor(loss: number, isBest: boolean): Grade {
  if (isBest) return "best";
  if (loss >= 0.3) return "blunder";
  if (loss >= 0.2) return "mistake";
  if (loss >= 0.1) return "inaccuracy";
  return "good";
}

export async function judge(engine: Engine, fenBefore: string, playedUci: string, candidates: Candidate[]): Promise<Verdict> {
  const pos = new Chess(fenBefore);
  const white = pos.turn() === "w";
  const before = await engine.analyze(fenBefore, { multipv: 3, depth: DEPTH });
  const best = before.lines[0];
  if (!best) throw new Error("no analysis");

  let played: Score; // mover's point of view
  const known = before.lines.find((l) => l.uci === playedUci);
  const after = new Chess(fenBefore);
  after.move({ from: playedUci.slice(0, 2), to: playedUci.slice(2, 4), promotion: playedUci[4] });
  if (known) played = known.score;
  else if (after.isCheckmate()) played = { mate: 1 };
  else if (after.isDraw()) played = { cp: 0 };
  else {
    const reply = await engine.analyze(after.fen(), { multipv: 1, depth: DEPTH - 1 });
    played = negate(reply.lines[0]?.score ?? { cp: 0 });
  }

  const loss = Math.max(0, winChance(best.score) - winChance(played));
  const pctDrop = 50 * loss; // same quantity in win-% points, for the accuracy curve
  const accuracy = Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * pctDrop) - 3.1669));
  const rank = candidates.findIndex((c) => c.uci === best.uci);
  const pov = (s: Score) => (white ? s : negate(s));

  return {
    grade: gradeFor(loss, playedUci === best.uci),
    bestUci: best.uci,
    bestSan: pos.move({ from: best.uci.slice(0, 2), to: best.uci.slice(2, 4), promotion: best.uci[4] }).san,
    sfTop: before.lines.map((l) => l.uci),
    evalBefore: pov(best.score),
    evalAfter: pov(played),
    winLoss: loss,
    accuracy,
    jevRankOfBest: rank + 1,
    jevPOfBest: rank >= 0 ? candidates[rank].p : 0,
  };
}

export function formatEval(s: Score): string {
  if ("mate" in s) return s.mate === 0 ? "#" : `${s.mate > 0 ? "" : "−"}M${Math.abs(s.mate)}`;
  const v = s.cp / 100;
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}`;
}
