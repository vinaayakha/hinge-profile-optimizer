import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "../src/mcp.js";
import * as oauth from "../src/oauth.js";

function originOf(req: Request): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

// vercel.json rewrites every path to this function with the original path in ?__path=.
function pathOf(req: Request): string {
  const url = new URL(req.url);
  const rewritten = url.searchParams.get("__path");
  const path = rewritten !== null ? `/${rewritten}` : url.pathname;
  return path.replace(/\/+$/, "") || "/";
}

async function handleMcp(req: Request, origin: string): Promise<Response> {
  const auth = await oauth.verifyBearer(req);
  if (!auth) return oauth.unauthorized(origin);
  // Stateless: a fresh server + transport per request, which suits serverless.
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = createServer();
  await server.connect(transport);
  const response = await transport.handleRequest(req, {
    authInfo: { token: "", clientId: auth.clientId, scopes: auth.scope.split(" ") },
  });
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(oauth.corsHeaders())) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

async function handle(req: Request): Promise<Response> {
  const origin = originOf(req);
  const path = pathOf(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: oauth.corsHeaders() });

  try {
    if (path.startsWith("/.well-known/oauth-protected-resource")) return oauth.protectedResourceMetadata(origin);
    if (path.startsWith("/.well-known/oauth-authorization-server") || path.startsWith("/.well-known/openid-configuration")) {
      return oauth.authorizationServerMetadata(origin);
    }
    if (path === "/register" && req.method === "POST") return await oauth.register(req);
    if (path === "/authorize") return await oauth.authorize(req);
    if (path === "/token" && req.method === "POST") return await oauth.tokenEndpoint(req);
    if (path === "/mcp") return await handleMcp(req, origin);
    if (path === "/") {
      return oauth.json({ name: "hinge-profile-optimizer MCP", mcp: `${origin}/mcp` });
    }
    return oauth.json({ error: "not_found" }, 404);
  } catch (error) {
    console.error(error);
    return oauth.json({ error: "server_error" }, 500);
  }
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export const OPTIONS = handle;
