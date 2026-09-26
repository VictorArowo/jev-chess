# Jev vs Jev

Two copies of [Jev](https://docs.typesafe.ai/), TypeSafe's classifier model, play chess (called through
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway/modalities/evaluation)). Every move
is one `choice` question whose options are all the legal moves; the page shows the full probability
distribution. See [PLAN.md](PLAN.md) for the design and [JOURNAL.md](JOURNAL.md) for findings.

```bash
cp .env.example .env.local   # add AI_GATEWAY_API_KEY; without it the app serves labeled mock data
npm install
npm run dev
```

`api/move.ts` is the Vercel function used in production; `npm run dev` mounts the same handler.

## Recording games

The page defaults to replaying recorded games from `public/games/`. They load instantly, cost
nothing, and don't depend on Jev's early-access capacity.

```bash
npm run record -- --games 3 --temp 0.5   # plays full games via the real API, grades with Stockfish
npm run stats                            # aggregate numbers over finished games (--all includes partial)
```

The referee is Stockfish.js 19 lite single-threaded (GPLv3), copied into `public/stockfish/` on
`npm install`.
