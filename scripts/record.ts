// Plays full Jev vs Jev games through the real API, grades every move with Stockfish, and writes
// them to public/games/ for the page to replay.
//
//   npm run record -- --games 3 --temp 0.5
//
// Progress is saved after every ply, so an interrupted game can be inspected (it just won't be
// listed in the index until it finishes).

import { Chess } from "chess.js";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pickMove, UpstreamBusy, type MoveResponse } from "../server/jev";
import { DEFAULT_PERSONAS, isOver, resultText, sample, toPly, type GameSummary, type Ply, type RecordedGame } from "../src/game";
import { judge, GRADE_INFO } from "../src/referee";
import { nodeEngine } from "./node-engine";

const { values } = parseArgs({
  options: { games: { type: "string", default: "1" }, temp: { type: "string", default: "0.5" } },
});
const GAMES = Number(values.games);
const TEMP = Number(values.temp);
const OUT = "public/games";
const BUSY_WAITS_S = [5, 10, 20, 30, 60, 60, 120, 120];

const key = process.env.AI_GATEWAY_API_KEY;
if (!key) {
  console.error("AI_GATEWAY_API_KEY missing (put it in .env.local). Refusing to record mock games.");
  process.exit(1);
}

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

async function decide(chess: Chess, persona: string): Promise<MoveResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await pickMove({ fen: chess.fen(), history: chess.history(), persona }, key);
    } catch (e) {
      if (!(e instanceof UpstreamBusy) || attempt >= BUSY_WAITS_S.length) throw e;
      process.stdout.write(`  (busy, waiting ${BUSY_WAITS_S[attempt]}s)\n`);
      await sleep(BUSY_WAITS_S[attempt]);
    }
  }
}

const round = (p: number) => Math.round(p * 1e4) / 1e4;

function title(n: number, result: string, plies: number): string {
  const moves = Math.ceil(plies / 2);
  const short = result.replace(/\.$/, "").replace("Checkmate. ", "").replace(" Jev wins", " wins by checkmate");
  return `Game ${n}: ${short} (${moves} moves)`;
}

function writeIndex() {
  const games = readdirSync(OUT)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .map((f) => JSON.parse(readFileSync(`${OUT}/${f}`, "utf8")) as RecordedGame)
    .filter((g) => g.result)
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  const index: GameSummary[] = games.map(({ plies, personas, ...g }) => ({ ...g, plyCount: plies.length }));
  writeFileSync(`${OUT}/index.json`, JSON.stringify(index, null, 2) + "\n");
  return index.length;
}

mkdirSync(OUT, { recursive: true });
const { engine, quit } = nodeEngine();

for (let g = 0; g < GAMES; g++) {
  const n = writeIndex() + 1;
  const recordedAt = new Date().toISOString();
  const id = recordedAt.slice(0, 19).replace(/[:T]/g, "-");
  const chess = new Chess();
  const plies: Ply[] = [];
  const game: RecordedGame = { id, title: "", recordedAt, model: "", temperature: TEMP, personas: DEFAULT_PERSONAS, result: "", plies };
  console.log(`\n== Game ${n} (${id}), T ${TEMP} ==`);

  while (!isOver(chess, plies.length)) {
    const fenBefore = chess.fen();
    const r = await decide(chess, DEFAULT_PERSONAS[chess.turn()].persona);
    const ply = toPly(fenBefore, r, sample(r.candidates, TEMP), TEMP);
    ply.candidates = ply.candidates.map((c) => ({ ...c, p: round(c.p) }));
    ply.verdict = await judge(engine, fenBefore, ply.uci, ply.candidates);
    plies.push(ply);
    chess.move(ply.san);
    if (!r.forced) game.model = r.model;

    const i = plies.length - 1;
    const g_ = GRADE_INFO[ply.verdict.grade];
    console.log(
      `${i % 2 ? "   ..." : `${i / 2 + 1}.`.padEnd(6)} ${(ply.san + g_.glyph).padEnd(9)} #${String(ply.rank).padEnd(3)} ` +
        `p=${ply.candidates[ply.rank - 1].p.toFixed(2)}  SF ${ply.verdict.bestSan.padEnd(6)} (Jev #${ply.verdict.jevRankOfBest})  ${r.latencyMs}ms`,
    );
    writeFileSync(`${OUT}/${id}.json`, JSON.stringify(game));
  }

  game.result = resultText(chess, plies.length);
  game.title = title(n, game.result, plies.length);
  writeFileSync(`${OUT}/${id}.json`, JSON.stringify(game));
  writeIndex();
  const cost = plies.reduce((a, p) => a + (p.costUsd ?? 0), 0);
  console.log(`-> ${game.title} · $${cost.toFixed(4)}`);
}

quit();
