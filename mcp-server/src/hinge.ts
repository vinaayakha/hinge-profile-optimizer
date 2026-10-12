import { BrowserFetchTransport, Email2FAError, HingeClient, HingeError, type HingeStorage } from "hinge-ts";
import { getJson, redis, setJson } from "./redis.js";

const SESSION_KEY = "session.json";
const PENDING_2FA_KEY = "hinge:pending_2fa";
const SMS_COOLDOWN_KEY = "hinge:sms_cooldown";
const LAST_SMS_KEY = "hinge:last_sms_request";
// Explicit compatibility setting; do not assume this matches the current shipping app.
const HINGE_APP_VERSION = process.env.HINGE_APP_VERSION ?? "10.7.0";

// hinge-ts persists its session through a file-like storage interface; back it with Redis.
class RedisStorage implements HingeStorage {
  private key = (k: string) => `hinge:file:${k}`;
  async exists(k: string) {
    return (await redis().exists(this.key(k))) === 1;
  }
  async readText(k: string) {
    return (await redis().get<string>(this.key(k))) ?? undefined;
  }
  async writeText(k: string, value: string) {
    await redis().set(this.key(k), value);
  }
  async remove(k: string) {
    await redis().del(this.key(k));
  }
}

async function buildClient(phoneNumber?: string): Promise<HingeClient> {
  // The builder insists on a phone number; loadSession then restores the saved one and device ids.
  const client = HingeClient.builder()
    .phoneNumber(phoneNumber ?? "+10000000000")
    .settings({
      hingeAppVersion: HINGE_APP_VERSION,
      ...(process.env.HINGE_BUILD_NUMBER ? { hingeBuildNumber: process.env.HINGE_BUILD_NUMBER } : {}),
    })
    .storage(new RedisStorage())
    .transport(new BrowserFetchTransport({
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        const response = await fetch(input, { ...init, signal: AbortSignal.timeout(20_000) });
        // The SDK discards initiateSms's body and accepts any 2xx payload at verification.
        // Check auth responses here, without exposing phone numbers, codes or tokens.
        if (path.startsWith("/auth/") || path === "/identity/install") {
          const raw = await response.clone().text();
          let body: unknown;
          try { body = raw.trim() ? JSON.parse(raw) : undefined; } catch { body = raw; }
          const record = body && typeof body === "object" ? body as Record<string, unknown> : undefined;
          const rejected = !!(record?.error || record?.errors || record?.success === false);
          const unexpected = !!raw.trim() && (!record || Array.isArray(body));
          if (path === "/auth/sms/v2/initiate") {
            await setJson(LAST_SMS_KEY, {
              requestedAt: new Date().toISOString(),
              httpStatus: response.status,
              responseBody: !raw.trim() ? "empty" : typeof body === "string" ? "non_json" : "json",
              outcome: !response.ok || rejected || unexpected ? "rejected" : "delivery_unconfirmed",
              deliveryConfirmed: false,
            }, 24 * 60 * 60);
            if (response.status === 429) {
              const header = response.headers.get("retry-after");
              const seconds = header && /^\d+$/.test(header) ? Number(header) : Math.ceil((Date.parse(header ?? "") - Date.now()) / 1000);
              await redis().set(SMS_COOLDOWN_KEY, "1", { ex: Number.isFinite(seconds) ? Math.min(86400, Math.max(60, seconds)) : 60 });
            }
          }
          // Preserve the SDK's 412 -> Email2FAError conversion, including its private case id.
          if (response.status === 412 && path === "/auth/sms/v2") return response;
          if (!response.ok || rejected || unexpected) {
            const advice = response.status === 429 ? " Hinge rate-limited this request; wait before trying again."
              : response.status === 401 || response.status === 403 ? " Hinge rejected this request; check login in the official Hinge app."
              : " Check login in the official Hinge app before retrying.";
            throw new HingeError("auth", `Hinge ${path} returned HTTP ${response.status}${rejected ? " with an error payload" : unexpected ? " with an unexpected body" : ""}.${advice}`, { status: response.status });
          }
          // Other Hinge clients receive the auth token directly; hinge-ts expects a wrapper.
          if (path === "/auth/sms/v2" && typeof record?.token === "string") {
            return Response.json({ hingeAuthToken: record }, { status: response.status });
          }
        }
        return response;
      },
    }))
    .build();
  await client.persistence.loadSession(SESSION_KEY);
  if (phoneNumber && client.phoneNumber !== phoneNumber) {
    // A different account must not inherit the previous account's auth or device state.
    client.phoneNumber = phoneNumber;
    client.deviceId = crypto.randomUUID();
    client.installId = crypto.randomUUID();
    client.sessionId = crypto.randomUUID();
    client.installed = false;
    client.hingeAuth = undefined;
    client.sendbirdAuth = undefined;
    client.sendbirdSessionKey = undefined;
  }
  return client;
}

export async function loginStart(phoneNumber: string, sendSms = true): Promise<unknown> {
  if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) throw new Error("Use E.164 format, including + and the country code.");
  // Atomic across serverless requests and both chat apps. Keep the cooldown after failures.
  if (sendSms) {
    const acquired = await redis().set(SMS_COOLDOWN_KEY, "1", { nx: true, ex: 60 });
    if (!acquired) {
      const remaining = await redis().ttl(SMS_COOLDOWN_KEY);
      throw new Error(`An SMS was already requested recently. Wait ${Math.max(1, remaining)} seconds. Do not retry automatically.`);
    }
  }
  const client = await buildClient(phoneNumber);
  if (client.hingeAuth?.token && (!client.hingeAuth.expires || Date.parse(client.hingeAuth.expires) > Date.now())) throw new Error("A Hinge session is already stored. Use hinge_status, or hinge_logout before starting another login.");
  client.hingeAuth = undefined;
  client.sendbirdAuth = undefined;
  client.sendbirdSessionKey = undefined;
  await redis().del(PENDING_2FA_KEY);
  if (sendSms) await redis().del(LAST_SMS_KEY);
  // Persist before sending: even a timeout must not lose the device used for the request.
  await client.persistence.saveSession(SESSION_KEY);
  if (!sendSms) {
    if (!client.installed) {
      await client.raw.hinge("POST", "/identity/install", { installId: client.installId });
      client.installed = true;
      await client.persistence.saveSession(SESSION_KEY);
    }
    return {
      outcome: "awaiting_app_code", smsRequested: false,
      phoneNumber: `ending in ${phoneNumber.slice(-4)}`,
      message: "Server login prepared without requesting an SMS. Request a login code in the official Hinge app for this same phone number, then submit it with hinge_login_verify. This workaround is reported in hinge-ts issue #5 but is not guaranteed; login is complete only when Hinge returns an authentication token.",
    };
  }
  try {
    await client.auth.initiateSms();
  } catch (error) {
    if (!(await getJson(LAST_SMS_KEY))) {
      await setJson(LAST_SMS_KEY, {
        requestedAt: new Date().toISOString(), outcome: "request_failed", deliveryConfirmed: false,
      }, 24 * 60 * 60);
    }
    throw error;
  } finally {
    await client.persistence.saveSession(SESSION_KEY);
  }
  return {
    ...(await getJson<Record<string, unknown>>(LAST_SMS_KEY)),
    phoneNumber: `ending in ${phoneNumber.slice(-4)}`,
    message: "Hinge accepted the SMS request, but delivery is unconfirmed. This is not proof that a code was sent or delivered. If a code arrives, call hinge_login_verify. If none arrives, check whether login works in the official Hinge app; do not automatically resend.",
  };
}

export async function loginVerify(otp: string): Promise<string> {
  if (!/^\d{4,10}$/.test(otp)) throw new Error("The SMS code must contain only digits.");
  const saved = await getJson<{ phoneNumber?: string }>(`hinge:file:${SESSION_KEY}`);
  if (!saved?.phoneNumber) throw new Error("No pending SMS login. Call hinge_login_start first.");
  const client = await buildClient();
  // A failed verification must never reuse a token from an earlier login.
  client.hingeAuth = undefined;
  try {
    const tokens = await client.auth.submitOtp(otp);
    if (!tokens?.hingeAuthToken?.token) throw new Error("Hinge returned no authentication token. Login is not complete; check login in the official Hinge app.");
  } catch (error) {
    if (error instanceof Email2FAError) {
      if (!error.caseId) throw new Error("Hinge requested email verification without a case id. Login is not complete.");
      await setJson(PENDING_2FA_KEY, { caseId: error.caseId }, 30 * 60);
      await client.persistence.saveSession(SESSION_KEY);
      return `Hinge wants an email code (sent to ${error.email || "your account email"}). Call hinge_login_email with it.`;
    }
    throw error;
  }
  await client.persistence.saveSession(SESSION_KEY);
  await redis().del(PENDING_2FA_KEY);
  return "Logged in to Hinge.";
}

export async function loginEmail(code: string): Promise<string> {
  if (!/^\d{4,10}$/.test(code)) throw new Error("The email code must contain only digits.");
  const pending = await getJson<{ caseId: string }>(PENDING_2FA_KEY);
  if (!pending) throw new Error("No pending email verification. Start again with hinge_login_start.");
  const client = await buildClient();
  await client.auth.submitEmailCode(pending.caseId, code);
  if (!client.hingeAuth?.token) throw new Error("Hinge returned no authentication token. Email verification is not complete.");
  await client.persistence.saveSession(SESSION_KEY);
  await redis().del(PENDING_2FA_KEY);
  return "Logged in to Hinge.";
}

export async function status() {
  const client = await buildClient();
  const auth = client.hingeAuth;
  const expires = auth?.expires;
  const valid = !!auth?.token && (!expires || Date.parse(expires) > Date.now());
  return {
    loggedIn: valid, expires, phoneNumber: valid ? client.phoneNumber : undefined,
    lastSmsRequest: await getJson<Record<string, unknown>>(LAST_SMS_KEY),
    smsRetryAfterSeconds: Math.max(0, await redis().ttl(SMS_COOLDOWN_KEY)),
  };
}

export async function logout(): Promise<void> {
  await redis().del(`hinge:file:${SESSION_KEY}`, PENDING_2FA_KEY, LAST_SMS_KEY);
}

// Runs fn with a logged-in client and persists any session changes afterwards.
export async function withHinge<T>(fn: (client: HingeClient) => Promise<T>): Promise<T> {
  const client = await buildClient();
  if (!client.hingeAuth?.token) throw new Error("Not logged in to Hinge. Call hinge_login_start first.");
  try {
    return await fn(client);
  } finally {
    await client.persistence.saveSession(SESSION_KEY).catch(() => undefined);
  }
}
