// Copies the lite single-threaded Stockfish build into public/ so it's served as a static worker.
// Lite-single (~1.8 MB) needs no SharedArrayBuffer, so no COOP/COEP headers are required.
import { copyFileSync, mkdirSync } from "node:fs";

const src = "node_modules/stockfish";
const out = "public/stockfish";
mkdirSync(out, { recursive: true });
for (const f of ["stockfish-19-lite-single.js", "stockfish-19-lite-single.wasm"]) copyFileSync(`${src}/bin/${f}`, `${out}/${f}`);
copyFileSync(`${src}/Copying.txt`, `${out}/COPYING.txt`); // GPLv3; source: github.com/nmrugg/stockfish.js
