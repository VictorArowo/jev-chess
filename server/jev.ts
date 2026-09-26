import { Chess, type Move } from "chess.js";

// The server builds the Jev question itself from the position, so the public
// endpoint can only ever be used to pick chess moves — never as a general proxy.

export type Side = "w" | "b";

export interface MoveRequest {
  fen: string;
  history: string[]; // SAN moves from the start position
  persona?: string;
}

export interface Candidate {
  uci: string;
  san: string;
  p: number;
}

export interface MoveResponse {
  model: string;
  mock: boolean;
  candidates: Candidate[]; // sorted, most likely first; covers every legal move
  confidence: number; // 1 − normalized entropy of the distribution
  usage?: { inputTokens: number; outputTokens: number };
  costUsd?: number;
  latencyMs: number;
}

const API_URL = "https://ai-gateway.vercel.sh/v1/evaluate";
const MAX_PERSONA = 280;
const PIECE: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export class BadRequest extends Error {}
export class UpstreamBusy extends Error {}

export function uci(m: Move): string {
  return m.from + m.to + (m.promotion ?? "");
}

function describe(m: Move): string {
  if (m.isKingsideCastle()) return `${m.san}: castle kingside`;
  if (m.isQueensideCastle()) return `${m.san}: castle queenside`;
  let s = `${m.san}: ${PIECE[m.piece]} ${m.from} to ${m.to}`;
  if (m.captured) s += `, captures ${PIECE[m.captured]}`;
  if (m.promotion) s += `, promotes to ${PIECE[m.promotion]}`;
  if (m.san.endsWith("#")) s += ", checkmate";
  else if (m.san.endsWith("+")) s += ", check";
  return s;
}

function ascii(chess: Chess): string {
  return chess
    .board()
    .map((row, i) => `${8 - i} ` + row.map((sq) => (sq ? (sq.color === "w" ? sq.type.toUpperCase() : sq.type) : ".")).join(" "))
    .concat("  a b c d e f g h")
    .join("\n");
}

function movetext(history: string[]): string {
  if (!history.length) return "(none, this is the starting position)";
  return history.map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san)).join(" ");
}

function parse(body: MoveRequest): { chess: Chess; moves: Move[]; persona: string } {
  if (!body || typeof body.fen !== "string" || !Array.isArray(body.history)) throw new BadRequest("fen and history required");
  if (body.history.length > 400) throw new BadRequest("game too long");
  const chess = new Chess();
  try {
    chess.load(body.fen);
  } catch {
    throw new BadRequest("invalid fen");
  }
  const moves = chess.moves({ verbose: true });
  if (!moves.length) throw new BadRequest("game is over");
  const persona = typeof body.persona === "string" ? body.persona.slice(0, MAX_PERSONA).trim() : "";
  return { chess, moves, persona };
}

export function buildJevRequest(chess: Chess, moves: Move[], history: string[], persona: string) {
  const side = chess.turn() === "w" ? "White" : "Black";
  const state = [
    `Chess game. You are playing ${side}. It is ${side}'s move.`,
    persona && `Your playing style: ${persona}`,
    `Moves so far: ${movetext(history)}`,
    `Position (FEN): ${chess.fen()}`,
    `Board (uppercase = White, lowercase = Black, rank 8 at top):\n${ascii(chess)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    model: "typesafe-ai/jev",
    state,
    questions: {
      move: {
        type: "choice",
        instructions: `Which move should ${side} play? Choose the strongest move in this position.`,
        criteria: Object.fromEntries(moves.map((m) => [uci(m), describe(m)])),
      },
    },
  };
}

interface JevChoice {
  type: "choice";
  choice: string;
  confidence?: number; // native TypeSafe API only; the gateway's /v1/evaluate omits it
  probabilities: Record<string, number>;
}

interface JevResult {
  model: string;
  answer: JevChoice;
  usage?: MoveResponse["usage"];
  costUsd?: number;
}

// Jev via Vercel AI Gateway (TypeSafe's own signups are paused). Same request shape as TypeSafe's
// /v1/systemone; the response carries camelCase usage plus the gateway's per-call cost.
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const BACKOFF_MS = [700, 1800, 4000];

async function callJev(apiKey: string, payload: unknown): Promise<JevResult> {
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok || !RETRY_STATUS.has(res.status) || attempt >= BACKOFF_MS.length) break;
    console.warn(`[api] gateway ${res.status}, retrying in ${BACKOFF_MS[attempt]} ms`);
    await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
  }
  if (!res.ok) {
    const text = await res.text();
    let message = text.slice(0, 200);
    try {
      message = JSON.parse(text).error?.message ?? message;
    } catch {}
    const E = RETRY_STATUS.has(res.status) ? UpstreamBusy : Error;
    throw new E(`Jev is unavailable (gateway ${res.status}): ${message}`);
  }
  const json = (await res.json()) as {
    model: string;
    answers: { move: JevChoice };
    usage?: { inputTokens: number; outputTokens: number };
    providerMetadata?: { gateway?: { cost?: string } };
  };
  const cost = Number(json.providerMetadata?.gateway?.cost);
  return { model: json.model, answer: json.answers.move, usage: json.usage, costUsd: Number.isFinite(cost) ? cost : undefined };
}

// Offline stand-in so the UI can be built without a key. Crude heuristics, softmaxed.
// Never mistaken for the real thing: responses carry mock: true and the UI labels them.
function mockJev(chess: Chess, moves: Move[]): JevResult {
  const center = new Set(["d4", "e4", "d5", "e5", "c4", "f4", "c5", "f5"]);
  const ply = chess.moveNumber();
  const scores = moves.map((m) => {
    let s = Math.random() * 1.5;
    if (m.captured) s += VALUE[m.captured] - (chess.isAttacked(m.to, chess.turn() === "w" ? "b" : "w") ? VALUE[m.piece] * 0.8 : 0);
    if (m.san.includes("+")) s += 0.8;
    if (m.san.includes("#")) s += 20;
    if (m.promotion) s += VALUE[m.promotion];
    if (center.has(m.to)) s += 0.7;
    if (m.isKingsideCastle() || m.isQueensideCastle()) s += 1.5;
    if (ply < 12 && (m.piece === "n" || m.piece === "b") && "18".includes(m.from[1])) s += 1;
    if (ply < 12 && (m.piece === "k" || m.piece === "q")) s -= 1.2;
    return s * 1.4;
  });
  const max = Math.max(...scores);
  const exp = scores.map((s) => Math.exp(s - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  const probabilities = Object.fromEntries(moves.map((m, i) => [uci(m), exp[i] / sum]));
  const best = moves[scores.indexOf(max)];
  return { model: "mock", answer: { type: "choice", choice: uci(best), confidence: concentration(Object.values(probabilities)), probabilities } };
}

// 1 − normalized entropy: 1 = all mass on one move, 0 = uniform.
function concentration(ps: number[]): number {
  if (ps.length < 2) return 1;
  const h = -ps.reduce((a, p) => a + (p > 0 ? p * Math.log(p) : 0), 0);
  return 1 - h / Math.log(ps.length);
}

export async function pickMove(body: MoveRequest, apiKey: string | undefined): Promise<MoveResponse> {
  const { chess, moves, persona } = parse(body);
  const started = Date.now();
  const mock = !apiKey;
  const result = mock ? mockJev(chess, moves) : await callJev(apiKey, buildJevRequest(chess, moves, body.history, persona));

  const probs = result.answer.probabilities ?? {};
  const candidates = moves
    .map((m) => ({ uci: uci(m), san: m.san, p: Math.max(0, Number(probs[uci(m)]) || 0) }))
    .sort((a, b) => b.p - a.p);
  const total = candidates.reduce((a, c) => a + c.p, 0);
  if (total > 0) for (const c of candidates) c.p /= total;
  else for (const c of candidates) c.p = 1 / candidates.length;

  return {
    model: result.model,
    mock,
    candidates,
    confidence: result.answer.confidence ?? concentration(candidates.map((c) => c.p)),
    usage: result.usage,
    costUsd: result.costUsd,
    latencyMs: Date.now() - started,
  };
}

// Best-effort per-IP limiter. In-memory, so on serverless it's per-instance; fine as a first line.
const hits = new Map<string, number[]>();
export function rateLimited(ip: string, limit = 40, windowMs = 60_000): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > limit;
}

export async function handle(req: Request, apiKey: string | undefined): Promise<Response> {
  if (req.method !== "POST") return Response.json({ error: "POST only" }, { status: 405 });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "local";
  if (rateLimited(ip)) return Response.json({ error: "Slow down — too many moves per minute." }, { status: 429 });
  try {
    return Response.json(await pickMove((await req.json()) as MoveRequest, apiKey));
  } catch (e) {
    if (e instanceof BadRequest) return Response.json({ error: e.message }, { status: 400 });
    if (e instanceof UpstreamBusy) return Response.json({ error: e.message, retryable: true }, { status: 503 });
    console.error(e);
    return Response.json({ error: e instanceof Error ? e.message : "upstream error" }, { status: 502 });
  }
}
