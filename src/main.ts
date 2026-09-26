import { Chess } from "chess.js";
import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { DrawBrushes, DrawShape } from "chessground/draw";
import type { Key } from "chessground/types";
import "chessground/assets/chessground.base.css";
import "chessground/assets/chessground.cburnett.css";
import "./style.css";
import type { MoveResponse } from "../server/jev";
import { Engine, workerTransport, type Score } from "./engine";
import { judge, formatEval, winPct, GRADE_INFO } from "./referee";
import { renderGraph, type GraphPoint } from "./graph";
import { DEFAULT_PERSONAS, isOver, resultText, sample, toPly, type GameSummary, type Personas, type Ply, type RecordedGame } from "./game";

// Two sources feed one game loop: live Jev calls, or a recorded game replayed like a video.
type Mode = "replay" | "live";

// Move rows in the Considered panel, plus a "+N others" row. CSS owns the number (--bar-rows) so
// short screens can show fewer rows without the panel's height ever depending on content.
const barSlots = () => (Number(getComputedStyle(document.documentElement).getPropertyValue("--bar-rows")) || 8) - 1;
const DWELL_MS = 900; // how long the arrows stay up before the move is played
const REPLAY_THINK_MS = 700; // stand-in for Jev's latency when replaying
const BUSY_WAITS_S = [5, 10, 20, 30, 30];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let mode: Mode = "replay";
let library: GameSummary[] = [];
let replay: RecordedGame | null = null;
let personas: Personas = DEFAULT_PERSONAS;

let game = new Chess();
let plies: Ply[] = [];
let view: number | null = null; // decision being reviewed; null = follow the game
let playing = false;
let thinking = false;
let gameId = 0; // bumped whenever the game is replaced, so stale async work drops itself

const cg: Api = Chessground($("board"), {
  viewOnly: true,
  coordinates: true,
  animation: { duration: 250 },
  drawable: {
    enabled: false,
    brushes: {
      jev: { key: "jev", color: "#c9ad72", opacity: 0.9, lineWidth: 10 },
      played: { key: "played", color: "#ebe6d8", opacity: 0.95, lineWidth: 10 },
      sf: { key: "sf", color: "#0ca30c", opacity: 0.9, lineWidth: 9 },
    } as unknown as DrawBrushes, // deep-merged into the defaults at runtime
  },
});

// ---------- referee (live games only; recorded games carry their verdicts) ----------

let engine: Engine | null | undefined;

function getEngine(): Engine | null {
  if (engine === undefined) {
    try {
      engine = new Engine(workerTransport("/stockfish/stockfish-19-lite-single.js"));
    } catch (e) {
      console.warn("Stockfish unavailable", e);
      engine = null;
    }
  }
  return engine;
}

function referee(ply: Ply, id: number) {
  const e = getEngine();
  if (!e) return;
  judge(e, ply.fenBefore, ply.uci, ply.candidates)
    .then((v) => {
      if (id !== gameId) return;
      ply.verdict = v;
      render();
    })
    .catch((err) => console.warn("referee failed", err));
}

// ---------- move sources ----------

class Busy extends Error {}

async function fetchDecision(): Promise<MoveResponse> {
  const res = await fetch("/api/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fen: game.fen(), history: game.history(), persona: personas[game.turn()].persona }),
  });
  const data = await res.json();
  if (res.ok) return data as MoveResponse;
  throw new (data.retryable ? Busy : Error)(data.error ?? `HTTP ${res.status}`);
}

// Jev's early-access capacity is spotty: when the gateway says it's busy, wait it out visibly.
async function liveDecision(id: number): Promise<Ply | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetchDecision();
      $("mock").hidden = !r.mock;
      const temperature = Number(($("temp") as HTMLInputElement).value);
      return toPly(game.fen(), r, sample(r.candidates, temperature), temperature);
    } catch (e) {
      if (!(e instanceof Busy) || attempt >= BUSY_WAITS_S.length) throw e;
      for (let s = BUSY_WAITS_S[attempt]; s > 0; s--) {
        if (id !== gameId) return null;
        setStatus(`Jev is busy (high demand upstream). Retrying in ${s}s…`);
        await wait(1000);
      }
      setStatus("");
    }
  }
}

async function replayDecision(): Promise<Ply | null> {
  const at = plies.length;
  await wait(REPLAY_THINK_MS);
  const rec = replay?.plies[at];
  return rec && plies.length === at ? structuredClone(rec) : null;
}

// ---------- game loop ----------

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const total = () => (mode === "replay" ? replay?.plies.length ?? 0 : plies.length);
const finished = () => (mode === "replay" ? !!replay && plies.length >= replay.plies.length : isOver(game, plies.length));
const endText = () => (mode === "replay" ? replay?.result ?? "" : resultText(game, plies.length));

async function think(): Promise<void> {
  if (thinking || finished()) return;
  const id = gameId;
  const at = plies.length;
  thinking = true;
  render();
  let ply: Ply | null;
  try {
    ply = mode === "live" ? await liveDecision(id) : await replayDecision();
  } catch (e) {
    thinking = false;
    playing = false;
    setStatus(`Couldn't get a move: ${e instanceof Error ? e.message : e}`, true);
    render();
    return;
  }
  thinking = false;
  if (id !== gameId) return;
  if (ply && plies.length === at) {
    plies.push(ply);
    if (!ply.verdict) referee(ply, id);
    render(); // arrows over the position Jev was looking at
    await wait(DWELL_MS);
    if (id !== gameId) return;
    if (game.fen() === ply.fenBefore) game.move(ply.san); // a seek may already have applied it
  }
  if (finished()) playing = false;
  render();
  if (playing) think();
}

// A decision whose arrows are still dwelling hasn't been played on the board yet; apply it.
function settle() {
  const last = plies.at(-1);
  if (last && game.fen() === last.fenBefore) game.move(last.san);
}

// Replay only: make the first k recorded plies part of the game, moving the playhead either way.
function playheadTo(k: number) {
  if (!replay) return;
  if (k < plies.length) {
    gameId++;
    thinking = false;
    plies = plies.slice(0, k);
    game = new Chess();
    for (const p of plies) game.move(p.san);
    return;
  }
  settle();
  while (plies.length < k) {
    const rec = structuredClone(replay.plies[plies.length]);
    plies.push(rec);
    game.move(rec.san);
  }
}

// Scrubber position k: decision k (the board Jev saw before move k), or the current position at the end.
function seek(k: number) {
  const n = total();
  k = Math.max(0, Math.min(n, k));
  if (mode === "live") view = k >= plies.length ? null : k;
  else if (playing) {
    // A playing replay behaves like a video: seeking moves the playhead and playback continues.
    playheadTo(k);
    view = null;
    render();
    think();
    return;
  } else if (k >= n) {
    playheadTo(n);
    view = null;
  } else {
    // Paused: show decision k with its arrows, revealing the recording up to it if needed.
    if (k >= plies.length) playheadTo(k + 1);
    view = k;
  }
  render();
}

// ---------- modes ----------

function resetGame() {
  gameId++;
  game = new Chess();
  plies = [];
  view = null;
  playing = thinking = false;
  setStatus("");
}

async function loadReplay(id: string, autoplay: boolean) {
  resetGame();
  replay = null;
  render();
  try {
    replay = (await (await fetch(`/games/${id}.json`)).json()) as RecordedGame;
  } catch {
    setStatus("Couldn't load that game.", true);
    return;
  }
  personas = replay.personas;
  const when = new Date(replay.recordedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const info = `${(replay.result || "Unfinished.").replace(/\.$/, "")} · T ${replay.temperature.toFixed(1)} · ${when}`;
  $("replay-info").textContent = info;
  $("replay-info").title = info;
  playing = autoplay;
  render();
  if (playing) think();
}

function setMode(m: Mode) {
  mode = m;
  document.body.dataset.mode = m;
  $("tab-replay").setAttribute("aria-selected", String(m === "replay"));
  $("tab-live").setAttribute("aria-selected", String(m === "live"));
  $("reset").textContent = m === "replay" ? "Restart" : "New game";
  $("mock").hidden = true;
  if (m === "replay" && library.length) loadReplay(($("game-select") as HTMLSelectElement).value, false);
  else {
    replay = null;
    personas = DEFAULT_PERSONAS;
    resetGame();
    render();
  }
}

async function init() {
  try {
    library = ((await (await fetch("/games/index.json")).json()) as GameSummary[]).reverse(); // newest first
  } catch {
    library = [];
  }
  const select = $("game-select") as HTMLSelectElement;
  select.innerHTML = library.map((g) => `<option value="${g.id}">${g.title}</option>`).join("");
  if (!library.length) {
    ($("tab-replay") as HTMLButtonElement).disabled = true;
    setMode("live");
    return;
  }
  mode = "replay";
  setMode("replay");
  loadReplay(select.value, true);
}

// ---------- rendering ----------

function render() {
  const live = view === null;
  // A decision is drawn on the position Jev was looking at. Following the game, that's only while
  // the arrows dwell before the move is played; the panel keeps showing the latest decision.
  const last = plies.length - 1;
  const onBoard = live ? (last >= 0 && game.fen() === plies[last].fenBefore ? last : null) : view;
  const shown = live ? (last >= 0 ? last : null) : view;
  const ply = onBoard === null ? null : plies[onBoard];

  const fen = ply ? ply.fenBefore : game.fen();
  const prev = ply ? plies[onBoard! - 1] : plies.at(-1);
  const pos = new Chess(fen);
  cg.set({
    fen,
    turnColor: pos.turn() === "w" ? "white" : "black",
    lastMove: prev ? [prev.uci.slice(0, 2) as Key, prev.uci.slice(2, 4) as Key] : undefined,
    check: pos.inCheck(),
    highlight: { lastMove: true, check: true, custom: ply ? heat(ply) : new Map() },
  });
  cg.setAutoShapes(ply ? arrows(ply) : []);
  renderEvalBar(ply ? ply.verdict?.evalBefore : plies.length ? plies.at(-1)!.verdict?.evalAfter : undefined, !!plies.length);

  renderPlayers(pos.turn());
  renderBars(shown === null ? null : plies[shown], shown);
  $("bars").classList.toggle("stale", live && thinking);
  renderMoves(shown);
  renderAdvantage(shown);
  renderScrub();

  $("play").textContent = playing ? "Pause" : "Play";
  // A finished replay can still be played again from any earlier point.
  const canPlay = mode === "replay" ? !!replay && (!finished() || !live) : !finished();
  ($("play") as HTMLButtonElement).disabled = !canPlay;
  ($("step") as HTMLButtonElement).disabled = playing || thinking || finished();
  if (!live) setStatus(`Reviewing ${moveLabel(view!)}.${playing ? " The game keeps going; press End to catch up." : ""}`);
  else if (finished()) setStatus(endText());
  else if (mode === "live" && !thinking && !playing && !plies.length) setStatus("Press Play to start a live game.");
  else if (!document.querySelector(".status.error") && !thinking) setStatus("");
}

function renderScrub() {
  const n = total();
  const k = view ?? plies.length;
  const range = $("scrub") as HTMLInputElement;
  range.max = String(n);
  range.value = String(k);
  range.disabled = n === 0;
  range.style.setProperty("--fill", n ? `${(k / n) * 100}%` : "0%");
  ($("first") as HTMLButtonElement).disabled = k === 0;
  ($("prev") as HTMLButtonElement).disabled = k === 0;
  ($("next") as HTMLButtonElement).disabled = k >= n;
  ($("last") as HTMLButtonElement).disabled = k >= n;
  $("scrub-label").textContent =
    k < plies.length ? moveLabel(k) : !plies.length ? "Start" : finished() ? "Final" : mode === "live" ? "Live" : "Now";
}

function arrows(ply: Ply): DrawShape[] {
  const top = ply.candidates.slice(0, 3);
  const played = ply.candidates.find((c) => c.uci === ply.uci)!;
  const list = top.includes(played) ? top : [...top, played];
  const v = ply.verdict;
  const sf: DrawShape[] =
    v && !list.some((c) => c.uci === v.bestUci)
      ? [{ orig: v.bestUci.slice(0, 2) as Key, dest: v.bestUci.slice(2, 4) as Key, brush: "sf", label: { text: "SF", fill: "#0ca30c" } }]
      : [];
  return sf.concat(
    list.map((c) => ({
      orig: c.uci.slice(0, 2) as Key,
      dest: c.uci.slice(2, 4) as Key,
      brush: c.uci === ply.uci ? "played" : "jev",
      modifiers: { lineWidth: Math.round(6 + 14 * Math.sqrt(c.p)) },
      label: { text: pct(c.p, 0), fill: c.uci === ply.uci ? "#ebe6d8" : "#c9ad72" },
    })),
  );
}

// Destination-square heatmap: summed probability of every move landing there.
function heat(ply: Ply): Map<Key, string> {
  const mass = new Map<Key, number>();
  for (const c of ply.candidates) {
    const k = c.uci.slice(2, 4) as Key;
    mass.set(k, (mass.get(k) ?? 0) + c.p);
  }
  const out = new Map<Key, string>();
  for (const [k, p] of mass) {
    const level = p > 0.5 ? 4 : p > 0.25 ? 3 : p > 0.1 ? 2 : p > 0.03 ? 1 : 0;
    if (level) out.set(k, `heat-${level}`);
  }
  return out;
}

function renderEvalBar(score: Score | undefined, started: boolean) {
  const bar = $("evalbar");
  bar.classList.toggle("pending", !score);
  if (!score) {
    if (!started) {
      bar.style.setProperty("--white", "50%");
      $("eval-label").textContent = "";
    }
    return; // keep the previous value while Stockfish catches up
  }
  const w = winPct(score);
  bar.style.setProperty("--white", `${w}%`);
  const label = $("eval-label");
  label.textContent = formatEval(score);
  label.classList.toggle("black", w < 50);
  bar.setAttribute("aria-label", `Stockfish evaluation ${formatEval(score)}`);
}

function renderPlayers(turn: "w" | "b") {
  for (const side of ["w", "b"] as const) {
    const mine = plies.filter((_, i) => (i % 2 === 0) === (side === "w"));
    const avg = mine.length ? mine.reduce((a, p) => a + p.candidates[p.rank - 1].p, 0) / mine.length : null;
    const graded = mine.filter((p) => p.verdict);
    const acc = graded.length ? graded.reduce((a, p) => a + p.verdict!.accuracy, 0) / graded.length : null;
    const blunders = graded.filter((p) => p.verdict!.grade === "blunder").length;
    const active = !finished() && view === null && game.turn() === side && thinking;
    $(`player-${side}`).innerHTML = `
      <span class="swatch ${side}"></span>
      <div class="who">
        <strong>${personas[side].name}</strong>
        <span title="${personas[side].persona}">${personas[side].persona}</span>
      </div>
      <div class="pstat">${
        active
          ? '<span class="dots">thinking</span>'
          : avg === null
            ? ""
            : `${acc === null ? "" : `accuracy <b>${acc.toFixed(0)}%</b>`}<span>belief ${pct(avg)}${blunders ? ` · ${blunders} blunder${blunders > 1 ? "s" : ""}` : ""}</span>`
      }</div>`;
    $(`player-${side}`).classList.toggle("to-move", turn === side && !finished());
  }
}

function renderBars(ply: Ply | null, idx: number | null) {
  const bars = $("bars");
  const blank = '<li class="blank"><span class="san"></span><span class="track"></span><span class="p"></span></li>';
  if (!ply) {
    $("decision-meta").textContent = thinking ? "Jev is looking at the board…" : "every legal move, with Jev's probability";
    bars.innerHTML = blank.repeat(barSlots() + 1);
    $("verdict").textContent = "";
    $("stats").textContent = "";
    return;
  }
  const BAR_SLOTS = barSlots();
  const n = ply.candidates.length;
  $("decision-meta").textContent = thinking && view === null ? "Jev is looking at the board…" : `${moveLabel(idx!)} · ${n} legal moves`;

  // Always BAR_SLOTS rows: the played move and Stockfish's move take the place of lower-ranked
  // rows rather than adding new ones, so the panel never changes height.
  const v = ply.verdict;
  const must = [ply.uci, v?.bestUci].filter((u, i, a): u is string => !!u && a.indexOf(u) === i);
  const required = ply.candidates.filter((c) => must.includes(c.uci));
  const rows = ply.candidates
    .filter((c) => !must.includes(c.uci))
    .slice(0, BAR_SLOTS - required.length)
    .concat(required)
    .sort((a, b) => b.p - a.p);
  const max = ply.candidates[0].p || 1;
  const rest = ply.candidates.filter((c) => !rows.includes(c));
  bars.innerHTML =
    rows
      .map(
        (c) => `<li class="${c.uci === ply.uci ? "played" : ""}">
          <span class="san">${c.san}${v?.bestUci === c.uci ? '<i class="sf-tag" title="Stockfish\'s best move">SF</i>' : ""}</span>
          <span class="track"><span class="fill" style="width:${(c.p / max) * 100}%"></span></span>
          <span class="p">${pct(c.p)}</span>
        </li>`,
      )
      .join("") +
    blank.repeat(BAR_SLOTS - rows.length) +
    (rest.length
      ? `<li class="rest"><span class="san">+${rest.length} others</span><span class="track"></span><span class="p">${pct(rest.reduce((a, c) => a + c.p, 0))}</span></li>`
      : blank);
  $("verdict").innerHTML = verdictLine(ply);
  const stats = [
    ply.rank === 1 ? "Jev's top pick" : `Jev's #${ply.rank} pick`,
    `T ${ply.temperature.toFixed(1)}`,
    `confidence ${ply.confidence.toFixed(2)}`,
    `${(ply.latencyMs / 1000).toFixed(1)} s`,
    ply.costUsd !== undefined && usd(ply.costUsd),
  ]
    .filter(Boolean)
    .join(" · ");
  $("stats").textContent = stats;
  $("stats").title = stats;
}

function verdictLine(ply: Ply): string {
  const v = ply.verdict;
  if (!v) return mode === "live" && getEngine() ? '<span class="muted">Stockfish is checking this move…</span>' : "";
  const g = GRADE_INFO[v.grade];
  const drop = 50 * v.winLoss;
  const head = `<i class="dot ${v.grade}"></i><b>${g.label}${g.glyph ? " " + g.glyph : ""}</b>`;
  if (v.grade === "best") return `${head} · matches Stockfish's top move`;
  const jev = v.jevRankOfBest ? `Jev gave it ${pct(v.jevPOfBest)}, its #${v.jevRankOfBest}` : "";
  return `${head} · ${drop >= 1 ? `gave up ${drop.toFixed(0)}% win chance` : "keeps the balance"} · Stockfish preferred <b>${v.bestSan}</b>${jev ? ` (${jev})` : ""}`;
}

function renderAdvantage(active: number | null) {
  const first = plies[0]?.verdict?.evalBefore;
  const points: GraphPoint[] = [{ whitePct: first ? winPct(first) : plies.length ? null : 50, label: "Start" }];
  plies.forEach((p, i) => {
    const v = p.verdict;
    const g = v && GRADE_INFO[v.grade];
    points.push({
      whitePct: v ? winPct(v.evalAfter) : null,
      grade: v?.grade,
      label: `${moveLabel(i)} · ${v ? `${formatEval(v.evalAfter)} · ${g!.label}${g!.glyph ? " " + g!.glyph : ""}` : "analyzing…"}`,
    });
  });
  renderGraph($("graph"), points, {
    active: active === null ? null : active + 1,
    onSelect: (pt) => pt > 0 && seek(pt - 1),
  });
}

function renderMoves(active: number | null) {
  const rows: string[] = [];
  for (let i = 0; i < plies.length; i += 2) {
    const cell = (j: number) =>
      plies[j]
        ? `<button data-ply="${j}" class="${j === active ? "active" : ""}">${plies[j].san}${nag(plies[j])}${plies[j].rank > 1 ? `<sup>#${plies[j].rank}</sup>` : ""}</button>`
        : "<span></span>";
    rows.push(`<li><span class="num">${i / 2 + 1}.</span>${cell(i)}${cell(i + 1)}</li>`);
  }
  const spent = plies.reduce((a, p) => a + (p.costUsd ?? 0), 0);
  $("moves-meta").textContent = spent ? `White's chances per Stockfish · Jev cost ${usd(spent)}` : "White's chances per Stockfish";
  const el = $("moves");
  el.innerHTML = rows.join("");
  // Scroll the list itself, never the page.
  const btn = el.querySelector<HTMLElement>(".active");
  if (btn) {
    const row = btn.parentElement!;
    if (row.offsetTop < el.scrollTop || row.offsetTop + row.offsetHeight > el.scrollTop + el.clientHeight)
      el.scrollTop = row.offsetTop - el.clientHeight / 2;
  } else el.scrollTop = el.scrollHeight;
}

function nag(p: Ply): string {
  const g = p.verdict && GRADE_INFO[p.verdict.grade];
  return g?.glyph ? `<span class="nag"><i class="dot ${p.verdict!.grade}"></i>${g.glyph}</span>` : "";
}

const moveLabel = (i: number) => `${Math.floor(i / 2) + 1}${i % 2 === 0 ? "." : "…"} ${plies[i].san}`;
const usd = (n: number) => `$${n < 0.01 ? n.toFixed(5) : n.toFixed(3)}`;
const pct = (p: number, digits = 1) => (p >= 0.995 ? "100" : (p * 100).toFixed(p < 0.1 && digits ? digits : 0)) + "%";

function setStatus(text: string, error = false) {
  const el = $("status");
  el.textContent = text;
  el.title = text; // the line is clamped to one row; hover shows all of it
  el.classList.toggle("error", error);
}

// ---------- controls ----------

$("play").addEventListener("click", () => {
  playing = !playing;
  if (playing) {
    // Replays play from wherever you've scrubbed to, like a video. Live games can't branch,
    // so they jump back to the present.
    if (mode === "replay" && view !== null) playheadTo(view);
    view = null;
  }
  setStatus("");
  render();
  if (playing) think();
});
$("step").addEventListener("click", () => {
  view = null;
  setStatus("");
  think();
});
$("reset").addEventListener("click", () => {
  if (mode === "replay" && replay) loadReplay(replay.id, true);
  else {
    resetGame();
    render();
  }
});
$("tab-replay").addEventListener("click", () => mode !== "replay" && setMode("replay"));
$("tab-live").addEventListener("click", () => mode !== "live" && setMode("live"));
$("game-select").addEventListener("change", (e) => loadReplay((e.target as HTMLSelectElement).value, true));
$("temp").addEventListener("input", (e) => {
  $("temp-out").textContent = Number((e.target as HTMLInputElement).value).toFixed(1);
});
$("scrub").addEventListener("input", (e) => seek(Number((e.target as HTMLInputElement).value)));
$("first").addEventListener("click", () => seek(0));
$("prev").addEventListener("click", () => seek((view ?? plies.length) - 1));
$("next").addEventListener("click", () => seek((view ?? plies.length) + 1));
$("last").addEventListener("click", () => seek(total()));
$("moves").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (b) seek(Number(b.dataset.ply));
});
document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey) return;
  const cur = view ?? plies.length;
  if (e.key === "ArrowLeft") seek(cur - 1);
  else if (e.key === "ArrowRight") seek(cur + 1);
  else if (e.key === "Home") seek(0);
  else if (e.key === "End") seek(total());
  else if (e.key === " " && !(e.target instanceof HTMLButtonElement)) $("play").click();
  else return;
  e.preventDefault();
});

new ResizeObserver(() => renderAdvantage(view ?? (plies.length ? plies.length - 1 : null))).observe($("graph"));
matchMedia("(max-height: 819px)").addEventListener("change", () => render());
render();
init();

// Dev-only hook for pulling raw decisions out of the page (analysis for JOURNAL.md).
if (import.meta.env.DEV) Object.assign(window, { __plies: () => plies });
