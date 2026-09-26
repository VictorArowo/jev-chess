# Journal

Raw material for the blog post. Log what surprised us, numbers, screenshots, dead ends.

## 2026-09-26 — Idea

- Jev (TypeSafe AI, early access since 2026-09-15) returns typed answers with probabilities instead
  of text. A `choice` question takes up to 255 options; chess never has more than 218 legal moves,
  so the entire legal move list fits in a single question.
- Framing: a chess engine *searches*. An LLM *talks itself* into a move. Jev does neither — it's
  pure pattern recognition, a single glance at the board. What does System 1 chess look like?
- Decision: sample moves from the distribution rather than taking argmax, to avoid repetition loops.
  (Worth testing: how often does argmax actually loop?)
- Open questions to answer with data:
  - Does it know the rules' spirit (development, king safety) or just shuffle?
  - How confident is it in the opening vs. the middlegame?
  - Do persona instructions ("aggressive" vs "solid") measurably shift the distribution?
  - How often is Stockfish's best move inside Jev's top 3?

## 2026-09-26 — Phase 1 prototype (mock data)

- Each option is keyed by UCI (`g1f3`) and described in plain words: "Nf3: knight g1 to f3".
  Descriptions add *rules-level* facts only: captures X, promotes, check, checkmate. No tactical
  hints (hanging pieces, threats). That would be doing Jev's thinking for it.
  - Caveat worth mentioning in the post: flagging "checkmate" is technically a 1-ply lookahead that
    Jev gets for free. A human sees it too, and SAN carries `#` anyway.
- The server builds the question from the FEN itself (it recomputes the legal moves), so the public
  endpoint can't be used as a free general-purpose Jev proxy.
- State sent per move is ~1.4 KB (FEN + ASCII board + movetext + persona). 1. e4 e5 2. Nf3 Nc6
  has 27 legal moves.
- UI rhythm: the arrows appear on the position Jev was looking at, stay ~0.9 s, then the move plays.
  Rewinding shows every past decision the same way.
- The mock distribution is flat, so T=1 sampling plays #20-something picks. How peaked the *real*
  distribution is will decide the default temperature.

## 2026-09-26: Switched to Vercel AI Gateway, first real game

- TypeSafe paused signups, so Jev goes through Vercel AI Gateway: `POST ai-gateway.vercel.sh/v1/evaluate`
  with `model: "typesafe-ai/jev"`. Same `state`/`questions` shape. Differences: no `confidence` field
  (we compute 1 − normalized entropy instead), camelCase usage, and a per-call `cost`.
- **Capacity is the real constraint.** In ~31 successful calls the gateway returned 24× 429 ("upstream
  provider is currently experiencing high demand") and 8× 503. Server retries (0.7/1.8/4 s) plus
  client countdown retries (5-30 s) got through all of them. Effective pace was ~5-10 s per move.
  This settles the plan: recorded games are the default on the portfolio page, and live play is opt-in.
- Latency when it does answer: ~2.7 s average. Not the "200× faster" feel yet, probably queueing.
- **Cost: $0.0014 for 31 plies**, about $0.00004-0.00006 per move (~940 input tokens). A 100-ply game
  is about half a cent.
- Probabilities are quantized to whole percents (0.83, 0.06, 0.01). Many legal moves get exactly 0.
  On average ~15 of ~22 legal moves got non-zero mass.

### First game (aggressive White vs solid Black, temperature 1.0)

`1. e4 e5 2. Qh5 Nf6 3. Bc4 g6 4. Bxf7+ Kxf7 5. Qf3 Kg7 6. Qh5 gxh5 7. Nf3 Kf7 8. Nxe5+ Ke7
9. Nc6+ Nxc6 10. d4 Nxe4 11. O-O Nd6 12. Re1+ Kf6 13. Re6+ Kxe6 14. d5+ Kxd5 15. c4+ Kxc4 16. Nc3`

- Opening move from the start position: e4 83%, f4 6%, d4 5%. The aggressive persona gave f4
  (King's Gambit territory) second place.
- 2. Qh5: the "aggressive" persona reached for the beginner's queen attack right away.
- 6. Qh5?? gxh5: White dropped its queen to a pawn. It was Jev's #2 choice (top pick only 49%).
- Then Black's king **walked up the board** capturing things: Kxe6, Kxd5, Kxc4. Jev loves checks
  and captures. At move 16 its top three were all checks (b3+ 22%, Na3+ 21%, Nd2+ 21%).
- Pattern: it sees *move types* (check, capture, develop) far better than consequences (hanging
  pieces, recaptures). That's System 1 in a sentence. The Stockfish referee should make it measurable.
- Stats: top pick averaged 38% probability; at T=1 only 52% of moves played were Jev's #1 (worst: #18,
  3. Bc4). Default temperature is now **0.5** so games read as "what Jev believes" rather than dice.

## 2026-09-26: Phase 2, the Stockfish referee

- Engine: Stockfish.js 19 **lite single-threaded** (1.8 MB WASM, GPLv3) in a Web Worker. No
  SharedArrayBuffer, so no COOP/COEP headers. The full engine is 99 MB, which is absurd for a
  portfolio page. The same build runs as a child process in Node (`scripts/node-engine.ts`), so the
  game recorder can grade offline.
- Grading follows Lichess: per move, the drop in winning chances (`2/(1+e^(-0.00368·cp)) − 1`, in
  [−1, 1]). A drop of ≥0.1 is an inaccuracy, ≥0.2 a mistake, ≥0.3 a blunder. Per-move accuracy uses
  Lichess's `103.17·e^(−0.04354·Δwin%) − 3.17`. Depth 14, MultiPV 3. If Jev's move is in Stockfish's
  top 3 we reuse that score, otherwise we search the resulting position. **~200 ms per move**, so
  grading finishes inside the 0.9 s arrow dwell.
- Caveat for the post: in a position that's already lost, winning chances saturate, so a queen
  blunder can grade as only a "mistake" (6. Qh5 gxh5 at −5.0). That's standard Lichess behavior.

### What the referee found in game 1 (re-graded)

- **2...Nf6 attacked White's queen on h5. White ignored it (3. Bc4??, −8.9) and Black didn't take
  it (3...g6??).** Both sides missed a free queen on consecutive moves. This is the clearest
  "System 1" moment so far: Jev sees *move types* (develop, check, capture) but not threats.

### Game 2 (T 0.5): mate in 5

`1. e4 e5 2. Nf3 Nf6 3. Nxe5 Nxe4 4. Qf3 d5?? 5. Qxf7#`

- Moves 1-3 were all Jev's top choice and all matched Stockfish (e4 at 90%).
- Once the position left the main line, the distributions went flat. At 4. Qf3 the top pick was
  only 20%, and Stockfish's Qe2 sat at #13 (2%). At 4...d5?? the top was 12% and Stockfish's Ng5
  was #20 (2%). Even at T 0.5, flat distributions meant Jev's #4 and #5 moves got played.
- Jev found **Qxf7# at 89%**. Asterisk: the move's description says "checkmate" (and SAN has `#`),
  so that's a 1-ply hint it gets for free.
- Where Stockfish's best move sat in Jev's ranking: 1, 1, 1, 2, 1, 5, 13, 20, 1. Theory positions are
  fine, anything novel is not. **Needs a bigger sample; compute it over the recorded games.**

### Bug hunt: sampling

- One game played picks with a 0.09% chance at "T 0.5". The sampler tested fine (20k draws matched
  the expected frequencies). The likely cause is the browser restoring the slider's old value (1.0)
  on reload. The slider is now `autocomplete="off"`, and every ply records the temperature it was
  sampled at, which the UI shows ("its #5 choice at T 0.5").

## 2026-09-26: Phase 3, recording, replays and scrubbing

- `npm run record` plays full games through the real API and grades every move with the same
  Stockfish build running in Node. Games are saved ply by ply to `public/games/`.
  Recording pace is ~2.5 plies/min because the upstream keeps throttling. `latencyMs` in recorded
  games *includes* the gateway retries (the 8 s entries are retries, not Jev thinking).
- The page now defaults to **Recorded games**: instant, free, reliable. **Play live** is the opt-in.
- Timeline scrubber under the board (plus ← → Home End):
  - Live: reviewing stays put while the game keeps going. End jumps back.
  - Replay: behaves like a video. Scrubbing while playing moves the playhead. Paused, it shows
    that decision with its arrows, and Play restarts from there.
- Early numbers from the first 39 plies (in progress, **don't quote yet**):
  - Calibration looks real. When Jev's top pick has < 20% it's never Stockfish's move, at 40-60%
    it is 55% of the time, and above 60% it is 80%. Jev seems to *know when it knows*.
  - Checks are 4% of legal moves but get 37% of Jev's probability (9×). Captures get 3.6×.
  - Stockfish's best is in Jev's top 3 in 67% of positions.

## 2026-09-26: Game 1 recorded; layout pass

- **Recorded game 1: 130 plies, draw by threefold repetition, $0.0061.** Even *with* sampling at
  T 0.5 the game ended in a repetition, in a king-and-pawn-ish ending where Jev's distribution was
  sharp enough that the top pick kept winning the draw. Argmax (T 0) would presumably loop sooner.
  Worth recording one T 0 and one T 1 game to compare.
- Why the default is T 0.5: at T 1 in the first live game only 52% of moves were Jev's top pick and
  some were #18-#22 picks. Jev's top pick averages ~38%, so the long tail gets sampled constantly and
  games read as dice rolls. T 0.5 squares the probabilities, which favors Jev's real preferences but
  still breaks ties. T 0 is "pure Jev" but risks repetition loops.
- UI: desktop is now one screen, and every transient message has reserved space (0 px layout shift,
  measured). The Considered panel always shows a fixed number of rows.

## 2026-09-26: Final dataset (5 games, 556 Jev moves)

Games: three at T 0.5 (a threefold draw in 65, Black mates in 15, and an insufficient-material draw
in 96), one at T 0 (Black mates in 20), one at T 1 (insufficient-material draw in 85). Total Jev cost
**$0.028**, about $0.00005 per move. Forced moves (one legal move) are excluded from every number.

**These are the numbers to quote** (`npm run stats`):

- **Jev knows when it knows.** Bucketed by Jev's probability on its own top pick, the chance that
  pick is Stockfish's best move is 11% (under 20%, n=109), 24% (20-40%, n=285), 47% (40-60%,
  n=111) and **76% (over 60%, n=51)**. Its confidence is meaningful even when its chess isn't.
- Jev's top pick = Stockfish's best in **31%** of positions. Stockfish's best is in Jev's top 3 in
  **57%**. Median rank of Stockfish's move in Jev's list: 3rd of ~16 legal moves.
- Strongest in the opening: 44% agreement with Stockfish in plies 1-10, 36% in 11-30, 28% after.
  The top pick's probability falls from 49% to 32%, so it gets less sure *and* less right.
- **Checks: 11% of legal moves, 47% of Jev's probability (4.1×). Captures: 13% of moves, 51% of
  probability (3.8×).** It sees move *types*, not consequences.
- Blunders: 50 in 556 moves (29 by White, 21 by Black), about one every 11 moves.
- Temperature: T 0 played the top pick 100% of the time and **did not loop**; it got mated in 20.
  T 0.5 played it 52% of the time (8.0 blunders per 100 moves), T 1 35% (10.8 per 100). The
  "argmax loops" worry from day one didn't happen; the repetition draw came at T 0.5.
- Caveat: Lichess-style accuracy (86-88%) flatters Jev, because in lopsided endgames nearly every
  move keeps the (lost) balance. Don't headline it. Use blunder rate and agreement with Stockfish.
- Operations: the recorder saw 500+ gateway retries (429/503) plus dropped connections. Early access
  is the real bottleneck, not cost or speed.
