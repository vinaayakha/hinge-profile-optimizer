import { BrowserFetchTransport, Email2FAError, HingeClient, type HingeStorage } from "hinge-ts";
import { getJson, redis, setJson } from "./redis.js";

const SESSION_KEY = "session.json";
const PENDING_2FA_KEY = "hinge:pending_2fa";
// hinge-ts defaults to 9.91.0, which Hinge has retired; track the shipping iOS app (override via env).
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
    .settings({ hingeAppVersion: HINGE_APP_VERSION })
    .storage(new RedisStorage())
    .transport(new BrowserFetchTransport())
    .build();
  await client.persistence.loadSession(SESSION_KEY);
  if (phoneNumber) client.phoneNumber = phoneNumber;
  return client;
}

export async function loginStart(phoneNumber: string): Promise<string> {
  const client = await buildClient(phoneNumber);
  await client.auth.initiateSms();
  await client.persistence.saveSession(SESSION_KEY);
  await redis().del(PENDING_2FA_KEY);
  return `SMS code sent to ${phoneNumber}. Call hinge_login_verify with the code.`;
}

export async function loginVerify(otp: string): Promise<string> {
  const client = await buildClient();
  try {
    await client.auth.submitOtp(otp);
  } catch (error) {
    if (error instanceof Email2FAError) {
      await setJson(PENDING_2FA_KEY, { caseId: error.caseId }, 30 * 60);
      await client.persistence.saveSession(SESSION_KEY);
      return `Hinge wants an email code (sent to ${error.email || "your account email"}). Call hinge_login_email with it.`;
    }
    throw error;
  }
  await client.persistence.saveSession(SESSION_KEY);
  return "Logged in to Hinge.";
}

export async function loginEmail(code: string): Promise<string> {
  const pending = await getJson<{ caseId: string }>(PENDING_2FA_KEY);
  if (!pending) throw new Error("No pending email verification. Start again with hinge_login_start.");
  const client = await buildClient();
  await client.auth.submitEmailCode(pending.caseId, code);
  await client.persistence.saveSession(SESSION_KEY);
  await redis().del(PENDING_2FA_KEY);
  return "Logged in to Hinge.";
}

export async function status(): Promise<{ loggedIn: boolean; expires?: string; phoneNumber?: string }> {
  const client = await buildClient();
  const auth = client.hingeAuth;
  const expires = auth?.expires;
  const valid = !!auth?.token && (!expires || Date.parse(expires) > Date.now());
  return { loggedIn: valid, expires, phoneNumber: valid ? client.phoneNumber : undefined };
}

export async function logout(): Promise<void> {
  await redis().del(`hinge:file:${SESSION_KEY}`, PENDING_2FA_KEY);
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
