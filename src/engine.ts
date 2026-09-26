// Minimal UCI client for Stockfish. Transport-agnostic: a Web Worker in the browser, a child
// process in Node (used by tests and, later, the game recorder).

export type Score = { cp: number } | { mate: number }; // from the side to move's point of view

export interface Line {
  multipv: number;
  depth: number;
  score: Score;
  uci: string; // first move of the principal variation
}

export interface Analysis {
  lines: Line[]; // sorted by multipv, best first
  bestmove: string | null;
}

export interface Transport {
  send(cmd: string): void;
  onLine(cb: (line: string) => void): void;
}

export interface AnalyzeOpts {
  multipv?: number;
  depth?: number;
  movetime?: number; // ms cap; whichever of depth/movetime is hit first ends the search
}

export class Engine {
  private listeners = new Set<(line: string) => void>();
  private queue: Promise<unknown>;

  constructor(private t: Transport) {
    t.onLine((raw) => {
      for (const line of raw.split("\n")) if (line) for (const l of [...this.listeners]) l(line.trim());
    });
    this.queue = this.handshake();
  }

  private until(pred: (line: string) => boolean, onLine?: (line: string) => void): Promise<string> {
    return new Promise((resolve) => {
      const l = (line: string) => {
        onLine?.(line);
        if (pred(line)) {
          this.listeners.delete(l);
          resolve(line);
        }
      };
      this.listeners.add(l);
    });
  }

  private async handshake() {
    const ok = this.until((l) => l === "uciok");
    this.t.send("uci");
    await ok;
    const ready = this.until((l) => l === "readyok");
    this.t.send("isready");
    await ready;
  }

  /** Analyses are serialized; callers can fire and forget. */
  analyze(fen: string, { multipv = 1, depth = 14, movetime = 2500 }: AnalyzeOpts = {}): Promise<Analysis> {
    const run = async (): Promise<Analysis> => {
      const byPv = new Map<number, Line>();
      this.t.send(`setoption name MultiPV value ${multipv}`);
      this.t.send(`position fen ${fen}`);
      const done = this.until(
        (l) => l.startsWith("bestmove"),
        (l) => {
          const line = parseInfo(l);
          if (line && (byPv.get(line.multipv)?.depth ?? -1) <= line.depth) byPv.set(line.multipv, line);
        },
      );
      this.t.send(`go depth ${depth} movetime ${movetime}`);
      const best = (await done).split(" ")[1];
      // Keep only lines from the deepest completed iteration so the multipv ranks are comparable.
      const maxDepth = Math.max(...[...byPv.values()].map((l) => l.depth));
      const lines = [...byPv.values()].filter((l) => l.depth >= maxDepth - 1).sort((a, b) => a.multipv - b.multipv);
      return { lines, bestmove: best && best !== "(none)" ? best : null };
    };
    const p = this.queue.then(run);
    this.queue = p.catch(() => {});
    return p;
  }
}

function parseInfo(l: string): Line | null {
  if (!l.startsWith("info ") || !l.includes(" pv ") || l.includes("bound")) return null;
  const t = l.split(" ");
  const at = (k: string) => t.indexOf(k);
  const s = at("score");
  if (s < 0) return null;
  const score: Score = t[s + 1] === "mate" ? { mate: Number(t[s + 2]) } : { cp: Number(t[s + 2]) };
  return {
    multipv: at("multipv") >= 0 ? Number(t[at("multipv") + 1]) : 1,
    depth: Number(t[at("depth") + 1]),
    score,
    uci: t[at("pv") + 1],
  };
}

export function workerTransport(url: string): Transport {
  const w = new Worker(url);
  return {
    send: (cmd) => w.postMessage(cmd),
    onLine: (cb) => {
      w.onmessage = (e) => cb(String(e.data));
    },
  };
}
