import { handle } from "../server/jev.js";

// Vercel function. On Vercel, the project's OIDC token authenticates with AI Gateway. It arrives as
// the x-vercel-oidc-token request header (the env var is only set in builds and `vercel env pull`).
// AI_GATEWAY_API_KEY overrides it if set.
export async function POST(req: Request): Promise<Response> {
  const credential = process.env.AI_GATEWAY_API_KEY || req.headers.get("x-vercel-oidc-token") || process.env.VERCEL_OIDC_TOKEN;
  // Never serve mock distributions in production: a fabricated game must not pass for Jev.
  if (!credential) return Response.json({ error: "Jev isn't configured on this deployment." }, { status: 503 });
  return handle(req, credential);
}
