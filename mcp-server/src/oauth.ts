// Minimal single-owner OAuth 2.1 authorization server (DCR + PKCE S256) for MCP clients.
// The only "user" is the owner, who proves identity with OWNER_PASSWORD on the consent page.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getJson, redis, setJson } from "./redis.js";

const CODE_TTL = 5 * 60;
const ACCESS_TTL = 24 * 60 * 60;
const REFRESH_TTL = 180 * 24 * 60 * 60;
const MAX_FAILED_LOGINS = 10;
const FAIL_WINDOW = 60 * 60;

type Client = { client_id: string; redirect_uris: string[]; client_name?: string; created_at: number };
type CodeRecord = { clientId: string; redirectUri: string; codeChallenge: string; scope: string; resource?: string };
type TokenRecord = { clientId: string; scope: string };

const token = () => randomBytes(32).toString("base64url");
const sha256 = (value: string) => createHash("sha256").update(value).digest("base64url");

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...corsHeaders(), ...headers },
  });
}

export function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id",
    "access-control-expose-headers": "www-authenticate, mcp-session-id",
  };
}

const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status);

export function protectedResourceMetadata(origin: string): Response {
  return json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
  });
}

export function authorizationServerMetadata(origin: string): Response {
  return json({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  });
}

function validRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== "string") return false;
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    // Allow https anywhere, plain http only for loopback (local MCP clients), and custom app schemes.
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    return !["javascript:", "data:", "file:", "vbscript:"].includes(u.protocol);
  } catch {
    return false;
  }
}

export async function register(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return oauthError("invalid_client_metadata", "body must be JSON");
  }
  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every(validRedirectUri)) {
    return oauthError("invalid_redirect_uri", "redirect_uris must be a non-empty list of valid URIs");
  }
  const client: Client = {
    client_id: token(),
    redirect_uris: redirectUris,
    client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 100) : undefined,
    created_at: Math.floor(Date.now() / 1000),
  };
  await setJson(`oauth:client:${client.client_id}`, client);
  return json(
    {
      client_id: client.client_id,
      client_id_issued_at: client.created_at,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    201
  );
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function consentPage(params: Record<string, string>, clientName: string, error?: string): Response {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize Hinge MCP</title>
<style>
:root{--bg:#f6f4f1;--card:#fff;--fg:#1d1b19;--muted:#6b6560;--accent:#8a3ffc;--err:#b3261e;--border:#e3ded8}
@media (prefers-color-scheme:dark){:root{--bg:#141312;--card:#1e1c1b;--fg:#f1eeea;--muted:#a59f99;--accent:#b38bff;--err:#ff8a80;--border:#34302d}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box}
form{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px;width:100%;max-width:380px;box-sizing:border-box}
h1{font-size:20px;margin:0 0 6px}p{color:var(--muted);margin:0 0 20px}
input[type=password]{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--fg);font-size:16px}
button{margin-top:14px;width:100%;padding:12px;border:0;border-radius:10px;background:var(--accent);color:#fff;font-size:16px;cursor:pointer}
.err{color:var(--err);margin:0 0 12px}
</style></head><body><form method="post" action="/authorize">
<h1>Authorize access</h1><p><strong>${escapeHtml(clientName)}</strong> wants to use your Hinge MCP server.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
${hidden}<input type="password" name="password" placeholder="Owner password" autocomplete="current-password" required autofocus>
<button type="submit">Allow</button></form></body></html>`;
  return new Response(html, {
    status: error ? 401 : 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
    },
  });
}

const AUTH_PARAMS = ["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "resource"];

async function readAuthParams(req: Request): Promise<{ params: Record<string, string>; password?: string }> {
  const source = req.method === "POST" ? new URLSearchParams(await req.text()) : new URL(req.url).searchParams;
  const params: Record<string, string> = {};
  for (const key of AUTH_PARAMS) {
    const value = source.get(key);
    if (value !== null) params[key] = value;
  }
  return { params, password: source.get("password") ?? undefined };
}

function passwordMatches(given: string): boolean {
  const expected = process.env.OWNER_PASSWORD;
  if (!expected) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function authorize(req: Request): Promise<Response> {
  const { params, password } = await readAuthParams(req);
  const client = params.client_id ? await getJson<Client>(`oauth:client:${params.client_id}`) : undefined;
  if (!client) return oauthError("invalid_client", "unknown client_id");
  const redirectUri = params.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined);
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return oauthError("invalid_request", "redirect_uri does not match a registered URI");
  }
  params.redirect_uri = redirectUri;

  // From here on errors go back to the client's redirect URI, per RFC 6749 §4.1.2.1.
  const redirectError = (error: string, description: string) => {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error);
    u.searchParams.set("error_description", description);
    if (params.state) u.searchParams.set("state", params.state);
    return Response.redirect(u.toString(), 302);
  };
  if (params.response_type !== "code") return redirectError("unsupported_response_type", "only code is supported");
  if (!params.code_challenge || params.code_challenge_method !== "S256") {
    return redirectError("invalid_request", "PKCE with S256 is required");
  }

  const clientName = client.client_name ?? "An MCP client";
  if (req.method !== "POST") return consentPage(params, clientName);

  const failKey = "oauth:failed_logins";
  const failures = Number((await redis().get<string>(failKey)) ?? 0);
  if (failures >= MAX_FAILED_LOGINS) return consentPage(params, clientName, "Too many failed attempts. Try again in an hour.");
  if (!password || !passwordMatches(password)) {
    const count = await redis().incr(failKey);
    if (count === 1) await redis().expire(failKey, FAIL_WINDOW);
    return consentPage(params, clientName, "Wrong password.");
  }

  const code = token();
  const record: CodeRecord = {
    clientId: client.client_id,
    redirectUri,
    codeChallenge: params.code_challenge,
    scope: params.scope ?? "mcp",
    resource: params.resource,
  };
  await setJson(`oauth:code:${sha256(code)}`, record, CODE_TTL);
  const u = new URL(redirectUri);
  u.searchParams.set("code", code);
  if (params.state) u.searchParams.set("state", params.state);
  return Response.redirect(u.toString(), 302);
}

async function issueTokens(clientId: string, scope: string): Promise<Response> {
  const accessToken = token();
  const refreshToken = token();
  const record: TokenRecord = { clientId, scope };
  await setJson(`oauth:at:${sha256(accessToken)}`, record, ACCESS_TTL);
  await setJson(`oauth:rt:${sha256(refreshToken)}`, record, REFRESH_TTL);
  return json({ access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refreshToken, scope });
}

export async function tokenEndpoint(req: Request): Promise<Response> {
  const contentType = req.headers.get("content-type") ?? "";
  const raw = await req.text();
  const form = contentType.includes("application/json")
    ? new URLSearchParams(Object.entries(JSON.parse(raw || "{}") as Record<string, string>))
    : new URLSearchParams(raw);
  const grantType = form.get("grant_type");
  const clientId = form.get("client_id");

  if (grantType === "authorization_code") {
    const code = form.get("code");
    const verifier = form.get("code_verifier");
    if (!code || !verifier) return oauthError("invalid_request", "code and code_verifier are required");
    const key = `oauth:code:${sha256(code)}`;
    // getdel makes the code single-use even under concurrent redemption.
    const raw = await redis().getdel<string>(key);
    const record = raw ? (JSON.parse(raw) as CodeRecord) : undefined;
    if (!record) return oauthError("invalid_grant", "code is invalid or expired");
    if (clientId && clientId !== record.clientId) return oauthError("invalid_grant", "client_id mismatch");
    if (form.get("redirect_uri") && form.get("redirect_uri") !== record.redirectUri) {
      return oauthError("invalid_grant", "redirect_uri mismatch");
    }
    if (sha256(verifier) !== record.codeChallenge) return oauthError("invalid_grant", "PKCE verification failed");
    return issueTokens(record.clientId, record.scope);
  }

  if (grantType === "refresh_token") {
    const refresh = form.get("refresh_token");
    if (!refresh) return oauthError("invalid_request", "refresh_token is required");
    const raw = await redis().getdel<string>(`oauth:rt:${sha256(refresh)}`);
    const record = raw ? (JSON.parse(raw) as TokenRecord) : undefined;
    if (!record) return oauthError("invalid_grant", "refresh_token is invalid or expired");
    if (clientId && clientId !== record.clientId) return oauthError("invalid_grant", "client_id mismatch");
    return issueTokens(record.clientId, record.scope);
  }

  return oauthError("unsupported_grant_type", "use authorization_code or refresh_token");
}

export async function verifyBearer(req: Request): Promise<TokenRecord | undefined> {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return undefined;
  return getJson<TokenRecord>(`oauth:at:${sha256(match[1].trim())}`);
}

export function unauthorized(origin: string): Response {
  return json({ error: "invalid_token", error_description: "missing or invalid access token" }, 401, {
    "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
  });
}
