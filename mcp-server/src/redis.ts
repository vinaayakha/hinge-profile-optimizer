import { Redis } from "@upstash/redis";

let client: Redis | undefined;

// Vercel's Upstash integration exposes KV_REST_API_*; a direct Upstash setup uses UPSTASH_REDIS_REST_*.
export function redis(): Redis {
  if (!client) {
    const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) throw new Error("Redis is not configured: set KV_REST_API_URL and KV_REST_API_TOKEN");
    client = new Redis({ url, token, automaticDeserialization: false });
  }
  return client;
}

export async function getJson<T>(key: string): Promise<T | undefined> {
  const raw = await redis().get<string>(key);
  return raw ? (JSON.parse(raw) as T) : undefined;
}

export async function setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  const raw = JSON.stringify(value);
  if (ttlSeconds) await redis().set(key, raw, { ex: ttlSeconds });
  else await redis().set(key, raw);
}
