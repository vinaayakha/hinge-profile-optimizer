import assert from "node:assert/strict";
import { beforeEach, afterEach, mock, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as hinge from "../.test-build/src/hinge.js";
import { createServer } from "../.test-build/src/mcp.js";

process.env.KV_REST_API_URL = "https://redis.invalid";
process.env.KV_REST_API_TOKEN = "test-only";
const phone = "+15555550123";
const values = new Map();
const expiries = new Map();
let requests;
let respond;

beforeEach(() => {
  values.clear();
  expiries.clear();
  requests = [];
  respond = () => new Response(null, { status: 200 });
  mock.method(globalThis, "fetch", async (url, init) => {
    if (new URL(url).hostname === "redis.invalid") {
      const commands = JSON.parse(init.body);
      const pipeline = Array.isArray(commands[0]);
      const results = (pipeline ? commands : [commands]).map(([command, key, value, ...options]) => {
        let result;
        switch (command.toLowerCase()) {
          case "get": result = values.get(key) ?? null; break;
          case "exists": result = Number(values.has(key)); break;
          case "ttl": result = expiries.get(key) ?? -2; break;
          case "set": {
            const normalized = options.map(v => String(v).toLowerCase());
            if (normalized.includes("nx") && values.has(key)) { result = null; break; }
            values.set(key, value);
            const ex = normalized.indexOf("ex");
            if (ex >= 0) expiries.set(key, Number(options[ex + 1]));
            result = "OK";
            break;
          }
          case "del":
            for (const k of [key, value, ...options]) { values.delete(k); expiries.delete(k); }
            result = 1;
            break;
          default: throw new Error(`Unexpected Redis command ${command}`);
        }
        return { result: typeof result === "string" && result !== "OK" ? Buffer.from(result).toString("base64") : result };
      });
      return Response.json(pipeline ? results : results[0]);
    }
    assert.equal(new URL(url).hostname, "prod-api.hingeaws.net");
    const request = { path: new URL(url).pathname, body: JSON.parse(init.body), headers: init.headers };
    requests.push(request);
    return respond(request);
  });
});
afterEach(() => mock.restoreAll());

test("empty 200 is delivery unconfirmed, with stable device IDs across chat calls", async () => {
  const result = await hinge.loginStart(phone);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.responseBody, "empty");
  assert.equal(result.deliveryConfirmed, false);
  assert.equal(result.outcome, "delivery_unconfirmed");
  assert.ok(!JSON.stringify(result).includes(phone));
  const deviceId = requests[1].body.deviceId;
  assert.equal(requests[0].path, "/identity/install");
  const state = await hinge.status();
  assert.equal(state.loggedIn, false);
  assert.equal(state.smsRetryAfterSeconds, 60);
  assert.equal(state.lastSmsRequest.httpStatus, 200);
  respond = () => Response.json({ hingeAuthToken: { token: "test-token", expires: "2099-01-01T00:00:00Z" } });
  assert.equal(await hinge.loginVerify("123456"), "Logged in to Hinge.");
  assert.equal(requests[2].body.deviceId, deviceId);
  assert.equal(requests[2].body.phoneNumber, phone);
  assert.equal((await hinge.status()).loggedIn, true);
});

test("concurrent login requests send only one SMS and failed calls do not bypass cooldown", async () => {
  const results = await Promise.allSettled([hinge.loginStart(phone), hinge.loginStart(phone)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(requests.filter(r => r.path === "/auth/sms/v2/initiate").length, 1);
  await assert.rejects(hinge.loginStart(phone), /Do not retry automatically/);
});

for (const [name, response] of [
  ["2xx error body", () => Response.json({ error: "private upstream detail" })],
  ["HTML challenge", () => new Response("<html>challenge</html>")],
  ["HTTP 403", () => new Response("private upstream detail", { status: 403 })],
]) {
  test(`${name} cannot masquerade as a successful SMS request`, async () => {
    respond = req => req.path === "/identity/install" ? new Response(null) : response();
    await assert.rejects(hinge.loginStart(phone), error => {
      assert.ok(!error.message.includes("private upstream detail"));
      return /Hinge .*returned HTTP/.test(error.message);
    });
    assert.equal((await hinge.status()).lastSmsRequest.outcome, "rejected");
    await assert.rejects(hinge.loginStart(phone), /already requested/);
  });
}

test("rate limits preserve Retry-After", async () => {
  respond = req => req.path === "/identity/install" ? new Response(null)
    : new Response(null, { status: 429, headers: { "retry-after": "600" } });
  await assert.rejects(hinge.loginStart(phone), /rate-limited/);
  assert.equal((await hinge.status()).smsRetryAfterSeconds, 600);
});

test("verification without a pending login makes no upstream request", async () => {
  await assert.rejects(hinge.loginVerify("123456"), /No pending SMS login/);
  assert.equal(requests.length, 0);
});

test("2xx verification without a token never reports logged in", async () => {
  await hinge.loginStart(phone);
  respond = () => Response.json({});
  await assert.rejects(hinge.loginVerify("123456"), /no authentication token/);
  assert.equal((await hinge.status()).loggedIn, false);
});

test("direct Hinge auth token responses are accepted as well as SDK wrappers", async () => {
  await hinge.loginStart(phone);
  respond = () => Response.json({ token: "test-token", identityId: "test-user", expires: "2099-01-01T00:00:00Z" });
  assert.equal(await hinge.loginVerify("123456"), "Logged in to Hinge.");
  assert.equal((await hinge.status()).loggedIn, true);
});

test("official-app code flow prepares a device without requesting an SMS", async () => {
  const result = await hinge.loginStart(phone, false);
  assert.equal(result.smsRequested, false);
  assert.equal(result.outcome, "awaiting_app_code");
  assert.deepEqual(requests.map(r => r.path), ["/identity/install"]);
  assert.equal(values.has("hinge:sms_cooldown"), false);
  respond = () => Response.json({ token: "test-token", identityId: "test-user", expires: "2099-01-01T00:00:00Z" });
  assert.equal(await hinge.loginVerify("123456"), "Logged in to Hinge.");
  assert.equal(requests.filter(r => r.path === "/auth/sms/v2/initiate").length, 0);
});

test("email challenge still works and also requires a token", async () => {
  await hinge.loginStart(phone);
  respond = () => Response.json({ caseId: "test-case", email: "m***@example.com" }, { status: 412 });
  assert.match(await hinge.loginVerify("123456"), /email code/);
  respond = () => Response.json({});
  await assert.rejects(hinge.loginEmail("123456"), /no authentication token/);
  respond = () => Response.json({ token: "test-token", expires: "2099-01-01T00:00:00Z" });
  assert.equal(await hinge.loginEmail("123456"), "Logged in to Hinge.");
  assert.equal((await hinge.status()).loggedIn, true);
  assert.equal(values.has("hinge:pending_2fa"), false);
});

test("timeouts retain device identity and do not trigger another send", async () => {
  respond = req => {
    if (req.path === "/auth/sms/v2/initiate") throw new DOMException("Timed out", "TimeoutError");
    return new Response(null);
  };
  await assert.rejects(hinge.loginStart(phone), /Timed out/);
  const saved = JSON.parse(values.get("hinge:file:session.json"));
  assert.equal(saved.deviceId, requests[1].body.deviceId);
  assert.equal(saved.installed, true);
  assert.equal((await hinge.status()).lastSmsRequest.outcome, "request_failed");
  await assert.rejects(hinge.loginStart(phone), /already requested/);
});

test("MCP clients receive unconfirmed delivery and structured tool errors", async () => {
  const server = createServer();
  const client = new Client({ name: "test-chat-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "hinge_login_start", arguments: { phone_number: phone } });
    assert.equal(JSON.parse(result.content[0].text).deliveryConfirmed, false);
    const retry = await client.callTool({ name: "hinge_login_start", arguments: { phone_number: phone } });
    assert.equal(retry.isError, true);
    assert.match(retry.content[0].text, /Do not retry automatically/);
  } finally {
    await client.close();
    await server.close();
  }
});
