import { defineConfig, loadEnv, type Plugin } from "vite";
import { handle } from "./server/jev.js";

// Mounts the same handler Vercel runs at /api/move, so `npm run dev` is the whole stack.
function apiDev(apiKey: string | undefined): Plugin {
  return {
    name: "api-dev",
    configureServer(server) {
      server.middlewares.use("/api/move", async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const request = new Request("http://localhost/api/move", {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
        });
        const response = await handle(request, apiKey);
        res.statusCode = response.status;
        res.setHeader("Content-Type", "application/json");
        res.end(await response.text());
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const key = env.MOCK === "1" ? undefined : env.AI_GATEWAY_API_KEY || undefined;
  console.log(key ? "[api] using Jev via Vercel AI Gateway" : "[api] no AI_GATEWAY_API_KEY — serving MOCK distributions");
  return { plugins: [apiDev(key)] };
});
