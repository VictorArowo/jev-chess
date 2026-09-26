import { handle } from "../server/jev.js";

// Vercel function. On Vercel the project's OIDC token authenticates with AI Gateway automatically;
// AI_GATEWAY_API_KEY overrides it (and is what local dev uses).
export async function POST(req: Request): Promise<Response> {
  return handle(req, process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
}
