# Jev vs Jev

Two copies of TypeSafe's Jev (a "System One" classifier — no text, no search, just a probability
distribution over typed options) play chess against each other. Every move is one API call: the
position goes in as `state`, every legal move goes in as an option of a single `choice` question,
and Jev returns a probability for each. The page visualizes that distribution — the interesting
part is what the model *considered*, not just what it played.

Deploys to **chess.victorarowo.com**. Ends with a blog post on victorarowo.com.

## How a move works

TypeSafe's own signups are paused, so Jev is called through **Vercel AI Gateway**'s evaluation API
(`AI_GATEWAY_API_KEY` locally; the Vercel project's OIDC token in production).

```
POST https://ai-gateway.vercel.sh/v1/evaluate
{
  "model": "typesafe-ai/jev",
  "state": "<FEN, ASCII board, move history, side to move, persona>",
  "questions": {
    "move": {
      "type": "choice",
      "instructions": "<persona: which move should White play?>",
      "criteria": { "g1f3": "Knight g1→f3 (Nf3)", "e2e4": "Pawn e2→e4 (e4)", ... }
    }
  }
}
→ answers.move.probabilities = { "g1f3": 0.41, "e2e4": 0.33, ... },
  usage, providerMetadata.gateway.cost
```

The gateway doesn't return TypeSafe's `confidence`, so the app computes it as 1 − normalized entropy
of the distribution. Upstream 429/503s are retried with backoff on the server, then with a visible
countdown on the client.

- Options are keyed by UCI (alphanumeric; the docs don't say which characters keys allow). Max legal
  moves in any chess position is 218; Jev allows 255 options.
- The move is **sampled** from the distribution with a temperature (argmax loops into repetitions).
- chess.js adjudicates mate/stalemate/draws; hard cap at 200 plies.

## Architecture

- Vite + TypeScript (vanilla), chess.js for rules, chessground for the board.
- `api/move.ts` — Vercel function proxying to AI Gateway. Keeps the key server-side,
  rate-limits per IP. The same handler is mounted into the Vite dev server locally.
- `MOCK=1` (or no key) → the server fabricates plausible distributions so the UI works offline.
  Mock games are always labeled as such and never recorded as real.

## Phases

1. **Prototype.** ✅ Live calls, board with top-3 arrows, probability panel, move list, play/pause/step.
   Question to answer: is it fun to watch?
2. **Referee + polish.** ✅ Stockfish 19 lite (WASM worker) grades each move Lichess-style (best /
   good / inaccuracy / mistake / blunder), eval bar, advantage graph, per-side accuracy, Stockfish's
   move on the board and in the bars. Still to do: editable personas.
3. **Portfolio mode** — record games to JSON, replay by default (instant, free, reliable); a
   rate-limited "play live" button. Deploy to chess.victorarowo.com.
4. **Blog post** — written from JOURNAL.md.

## Design

Matches victorarowo.com: ground `#0c1a16`, paper `#ebe6d8`, engrave `#c9ad72`, line `#24403a`,
muted `#93a69d`; Newsreader for display, Hanken Grotesk for text.
