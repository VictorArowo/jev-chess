// Aggregate numbers over recorded games, for JOURNAL.md and the blog post.
//   npm run stats            finished games only
//   npm run stats -- --all   include games still being recorded

import { readFileSync, readdirSync } from "node:fs";
import type { Ply, RecordedGame } from "../src/game";

const all = process.argv.includes("--all");
const games = readdirSync("public/games")
  .filter((f) => f.endsWith(".json") && f !== "index.json")
  .map((f) => JSON.parse(readFileSync(`public/games/${f}`, "utf8")) as RecordedGame)
  .filter((g) => all || g.result);
const plies = games.flatMap((g) => g.plies).filter((p): p is Ply & { verdict: NonNullable<Ply["verdict"]> } => !!p.verdict);
if (!plies.length) {
  console.log("No graded plies yet.");
  process.exit(0);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
const share = (xs: Ply[], pred: (p: (typeof plies)[number]) => boolean) => (xs.length ? (xs as typeof plies).filter(pred).length / xs.length : NaN);

console.log(`${games.length} game(s), ${plies.length} graded plies`);
for (const g of games) console.log(`  ${g.title || g.id + " (in progress)"}: ${g.plies.length} plies, T ${g.temperature}`);

const cost = games.flatMap((g) => g.plies).reduce((a, p) => a + (p.costUsd ?? 0), 0);
console.log(`\nJev cost: $${cost.toFixed(4)} total, $${(cost / plies.length).toFixed(6)} per move`);

console.log("\n-- Jev vs Stockfish --");
console.log(`Jev's top pick = Stockfish's best:   ${pct(share(plies, (p) => p.verdict.jevRankOfBest === 1))}`);
console.log(`Stockfish's best in Jev's top 3:     ${pct(share(plies, (p) => p.verdict.jevRankOfBest >= 1 && p.verdict.jevRankOfBest <= 3))}`);
console.log(`Jev's probability on Stockfish's best: median ${pct(median(plies.map((p) => p.verdict.jevPOfBest)))}, mean ${pct(mean(plies.map((p) => p.verdict.jevPOfBest)))}`);
console.log(`Median rank of Stockfish's best in Jev's list: ${median(plies.map((p) => p.verdict.jevRankOfBest || p.candidates.length))} (of ~${mean(plies.map((p) => p.candidates.length)).toFixed(0)} legal)`);

console.log("\n-- By phase --");
for (const [label, lo, hi] of [["plies 1-10", 0, 10], ["plies 11-30", 10, 30], ["plies 31+", 30, Infinity]] as const) {
  const xs = games.flatMap((g) => g.plies.slice(lo, hi)).filter((p) => p.verdict) as typeof plies;
  if (!xs.length) continue;
  console.log(
    `${label.padEnd(12)} n=${String(xs.length).padEnd(4)} top-pick p ${pct(mean(xs.map((p) => p.candidates[0].p))).padStart(4)} · ` +
      `top pick = SF ${pct(share(xs, (p) => p.verdict.jevRankOfBest === 1)).padStart(4)} · accuracy ${mean(xs.map((p) => p.verdict.accuracy)).toFixed(0)}%`,
  );
}

console.log("\n-- Calibration: does Jev know when it knows? --");
for (const [lo, hi] of [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 1.01]]) {
  const xs = plies.filter((p) => p.candidates[0].p >= lo && p.candidates[0].p < hi);
  if (!xs.length) continue;
  console.log(`top-pick p ${pct(lo).padStart(4)}-${pct(Math.min(hi, 1)).padEnd(4)} n=${String(xs.length).padEnd(4)} top pick = SF best ${pct(share(xs, (p) => p.verdict.jevRankOfBest === 1))}`);
}

console.log("\n-- Grades (moves actually played) --");
for (const side of ["White", "Black"]) {
  const xs = games.flatMap((g) => g.plies.filter((_, i) => (i % 2 === 0) === (side === "White"))).filter((p) => p.verdict) as typeof plies;
  const count = (gr: string) => xs.filter((p) => p.verdict.grade === gr).length;
  console.log(
    `${side.padEnd(6)} accuracy ${mean(xs.map((p) => p.verdict.accuracy)).toFixed(0)}% · best ${count("best")} · good ${count("good")} · ` +
      `?! ${count("inaccuracy")} · ? ${count("mistake")} · ?? ${count("blunder")}  (n=${xs.length})`,
  );
}
console.log(`Played Jev's top pick: ${pct(share(plies, (p) => p.rank === 1))}`);

console.log("\n-- What catches Jev's eye --");
for (const [label, test] of [["checks", (san: string) => san.includes("+") || san.includes("#")], ["captures", (san: string) => san.includes("x")]] as const) {
  const xs = plies.filter((p) => p.candidates.some((c) => test(c.san)));
  const mass = mean(xs.map((p) => p.candidates.filter((c) => test(c.san)).reduce((a, c) => a + c.p, 0)));
  const base = mean(xs.map((p) => p.candidates.filter((c) => test(c.san)).length / p.candidates.length));
  console.log(`${label.padEnd(9)} ${pct(base).padStart(4)} of legal moves, ${pct(mass).padStart(4)} of Jev's probability  (${(mass / base).toFixed(1)}×, n=${xs.length})`);
}
