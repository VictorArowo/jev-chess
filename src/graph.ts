import type { Grade } from "./referee";

// Advantage graph: White's winning chance after every ply, 50% = level. One series, so no legend;
// the panel title names it. Graded errors get a status-colored marker plus their glyph in the tooltip.

export interface GraphPoint {
  whitePct: number | null; // null = not analyzed yet (the line breaks there)
  grade?: Grade;
  label: string; // tooltip text
}

interface Opts {
  active: number | null; // point index to mark
  onSelect: (point: number) => void;
}

const PAD = { top: 10, right: 6, bottom: 10, left: 6 };
const MIN_SPAN = 24; // plies; keeps early games from stretching edge to edge
const FLAGGED: Grade[] = ["inaccuracy", "mistake", "blunder"];

export function renderGraph(el: HTMLElement, points: GraphPoint[], opts: Opts) {
  const W = el.clientWidth || 340;
  const H = el.clientHeight || 88;
  const span = Math.max(MIN_SPAN, points.length - 1);
  const x = (i: number) => PAD.left + (i / span) * (W - PAD.left - PAD.right);
  const y = (pct: number) => PAD.top + (1 - pct / 100) * (H - PAD.top - PAD.bottom);
  const mid = y(50);

  // Contiguous runs of analyzed points become separate line/area segments.
  const runs: [number, number][][] = [];
  let cur: [number, number][] = [];
  points.forEach((p, i) => {
    if (p.whitePct === null) {
      if (cur.length) runs.push(cur);
      cur = [];
    } else cur.push([x(i), y(p.whitePct)]);
  });
  if (cur.length) runs.push(cur);

  const line = (r: [number, number][]) => r.map(([a, b], i) => `${i ? "L" : "M"}${a.toFixed(1)},${b.toFixed(1)}`).join("");
  const area = (r: [number, number][]) => `${line(r)}L${r.at(-1)![0].toFixed(1)},${mid}L${r[0][0].toFixed(1)},${mid}Z`;
  const markers = points
    .map((p, i) => (p.grade && FLAGGED.includes(p.grade) && p.whitePct !== null ? `<circle class="mk ${p.grade}" cx="${x(i)}" cy="${y(p.whitePct)}" r="4.5"/>` : ""))
    .join("");
  const active = opts.active !== null && opts.active < points.length ? `<line class="now" x1="${x(opts.active)}" x2="${x(opts.active)}" y1="${PAD.top}" y2="${H - PAD.bottom}"/>` : "";
  const colW = (W - PAD.left - PAD.right) / span;
  const hits = points.map((_, i) => `<rect data-i="${i}" x="${x(i) - colW / 2}" y="0" width="${colW}" height="${H}"/>`).join("");

  el.innerHTML = `
    <svg width="${W}" height="${H}" role="img" aria-label="White's winning chances after each move">
      <line class="midline" x1="${PAD.left}" x2="${W - PAD.right}" y1="${mid}" y2="${mid}"/>
      <text class="axis" x="${PAD.left + 2}" y="${PAD.top + 9}">White</text>
      <text class="axis" x="${PAD.left + 2}" y="${H - PAD.bottom - 3}">Black</text>
      ${runs.map((r) => `<path class="area" d="${area(r)}"/><path class="line" d="${line(r)}"/>`).join("")}
      ${active}
      <line class="cross" y1="${PAD.top}" y2="${H - PAD.bottom}" visibility="hidden"/>
      ${markers}
      <g class="hits">${hits}</g>
    </svg>
    <div class="tip" hidden></div>`;

  const svg = el.querySelector("svg")!;
  const tip = el.querySelector<HTMLElement>(".tip")!;
  const cross = el.querySelector<SVGLineElement>(".cross")!;
  svg.addEventListener("mousemove", (e) => {
    const r = (e.target as Element).closest("rect");
    if (!r) return;
    const i = Number(r.getAttribute("data-i"));
    const p = points[i];
    cross.setAttribute("x1", String(x(i)));
    cross.setAttribute("x2", String(x(i)));
    cross.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.textContent = p.label;
    const left = Math.min(Math.max(x(i) - tip.offsetWidth / 2, 0), W - tip.offsetWidth);
    tip.style.left = `${left}px`;
    tip.style.top = `${p.whitePct !== null && y(p.whitePct) < H / 2 ? H - 4 : -tip.offsetHeight - 4}px`;
  });
  svg.addEventListener("mouseleave", () => {
    tip.hidden = true;
    cross.setAttribute("visibility", "hidden");
  });
  svg.addEventListener("click", (e) => {
    const r = (e.target as Element).closest("rect");
    if (r) opts.onSelect(Number(r.getAttribute("data-i")));
  });
}
