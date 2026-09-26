// Plays full Jev vs Jev games through the real API, grades every move with Stockfish, and writes
// them to public/games/ for the page to replay.
//
//   npm run record -- --games 3 --temp 0.5
//   npm run record -- --resume 2026-09-26-20-36-22     continue an interrupted game
//
// Progress is saved after every ply. An unfinished game isn't listed in the index, and --resume
// picks it up where it stopped, at the temperature it was started with.

import { Chess } from "chess.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pickMove, UpstreamBusy, type MoveResponse } from "../server/jev";
import { DEFAULT_PERSONAS, isOver, resultText, sample, toPly, type GameSummary, type RecordedGame } from "../src/game";
import { judge, GRADE_INFO } from "../src/referee";
import { nodeEngine } from "./node-engine";

const { values } = parseArgs({
  options: {
    games: { type: "string", default: "1" },
    temp: { type: "string", default: "0.5" },
    resume: { type: "string", multiple: true, default: [] },
  },
});
const OUT = "public/games";
// Recording is unattended, so be far more patient with a busy upstream than the page is.
const BUSY_WAITS_S = [5, 10, 20, 30, 60, 60, 120, 120, 300, 300, 600];

const key = process.env.AI_GATEWAY_API_KEY;
if (!key) {
  console.error("AI_GATEWAY_API_KEY missing (put it in .env.local). Refusing to record mock games.");
  process.exit(1);
}

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
const round = (p: number) => Math.round(p * 1e4) / 1e4;

async function decide(chess: Chess, persona: string): Promise<MoveResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await pickMove({ fen: chess.fen(), history: chess.history(), persona }, key);
    } catch (e) {
      if (!(e instanceof UpstreamBusy) || attempt >= BUSY_WAITS_S.length) throw e;
      process.stdout.write(`  (${e.message}; waiting ${BUSY_WAITS_S[attempt]}s)\n`);
      await sleep(BUSY_WAITS_S[attempt]);
    }
  }
}

function loadGames(): RecordedGame[] {
  return readdirSync(OUT)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .map((f) => JSON.parse(readFileSync(`${OUT}/${f}`, "utf8")) as RecordedGame);
}

function writeIndex() {
  // Numbered in order of recording; only finished games are listed.
  const index: GameSummary[] = loadGames()
    .filter((g) => g.result)
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
    .map(({ plies, personas, ...g }) => ({ ...g, plyCount: plies.length }));
  writeFileSync(`${OUT}/index.json`, JSON.stringify(index, null, 2) + "\n");
}

function title(n: number, result: string, plies: number): string {
  const moves = Math.ceil(plies / 2);
  const short = result.replace(/\.$/, "").replace("Checkmate. ", "").replace(" Jev wins", " wins by checkmate");
  return `Game ${n}: ${short} (${moves} moves)`;
}

function newGame(temperature: number): RecordedGame {
  const recordedAt = new Date().toISOString();
  const id = recordedAt.slice(0, 19).replace(/[:T]/g, "-");
  return { id, title: "", recordedAt, model: "", temperature, personas: DEFAULT_PERSONAS, result: "", plies: [] };
}

async function play(game: RecordedGame, engine: ReturnType<typeof nodeEngine>["engine"]) {
  const chess = new Chess();
  for (const p of game.plies) chess.move(p.san);
  console.log(`\n== ${game.id}, T ${game.temperature}${game.plies.length ? `, resuming at ply ${game.plies.length + 1}` : ""} ==`);

  while (!isOver(chess, game.plies.length)) {
    const fenBefore = chess.fen();
    const r = await decide(chess, game.personas[chess.turn()].persona);
    const ply = toPly(fenBefore, r, sample(r.candidates, game.temperature), game.temperature);
    ply.candidates = ply.candidates.map((c) => ({ ...c, p: round(c.p) }));
    ply.verdict = await judge(engine, fenBefore, ply.uci, ply.candidates);
    game.plies.push(ply);
    chess.move(ply.san);
    if (!r.forced) game.model = r.model;

    const i = game.plies.length - 1;
    const g = GRADE_INFO[ply.verdict.grade];
    console.log(
      `${i % 2 ? "   ..." : `${i / 2 + 1}.`.padEnd(6)} ${(ply.san + g.glyph).padEnd(9)} ` +
        (r.forced ? "forced" : `#${String(ply.rank).padEnd(3)} p=${ply.candidates[ply.rank - 1].p.toFixed(2)}  SF ${ply.verdict.bestSan.padEnd(6)} (Jev #${ply.verdict.jevRankOfBest})  ${r.latencyMs}ms`),
    );
    writeFileSync(`${OUT}/${game.id}.json`, JSON.stringify(game));
  }

  game.result = resultText(chess, game.plies.length);
  const n = loadGames().filter((g) => g.result && g.id !== game.id).length + 1;
  game.title = title(n, game.result, game.plies.length);
  writeFileSync(`${OUT}/${game.id}.json`, JSON.stringify(game));
  writeIndex();
  const cost = game.plies.reduce((a, p) => a + (p.costUsd ?? 0), 0);
  console.log(`-> ${game.title} · T ${game.temperature} · $${cost.toFixed(4)}`);
}

mkdirSync(OUT, { recursive: true });
const { engine, quit } = nodeEngine();

// Resumed games are validated up front; fresh games get their id (a timestamp) when they start.
const resumed = values.resume.map((id) => {
  const f = `${OUT}/${id}.json`;
  if (!existsSync(f)) throw new Error(`no such game: ${f}`);
  const g = JSON.parse(readFileSync(f, "utf8")) as RecordedGame;
  if (g.result) throw new Error(`${id} already finished: ${g.result}`);
  return g;
});
const jobs: (() => RecordedGame)[] = resumed.length
  ? resumed.map((g) => () => g)
  : Array.from({ length: Number(values.games) }, () => () => newGame(Number(values.temp)));

for (const job of jobs) await play(job(), engine);

quit();
