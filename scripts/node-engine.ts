// Node transport for the Stockfish build: runs the same lite-single engine as a child process.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Engine } from "../src/engine";

export function nodeEngine(): { engine: Engine; quit: () => void } {
  const p = spawn(process.execPath, ["node_modules/stockfish/bin/stockfish-19-lite-single.js"], { stdio: ["pipe", "pipe", "inherit"] });
  const rl = createInterface({ input: p.stdout });
  const engine = new Engine({ send: (c) => p.stdin.write(c + "\n"), onLine: (cb) => rl.on("line", cb) });
  return { engine, quit: () => p.kill() };
}
