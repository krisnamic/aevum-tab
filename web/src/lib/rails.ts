import { NextResponse } from "next/server";
import { isHex, type Hex } from "viem";
import { nonceManager, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { aevumFork, isAnvilAccount, localAnvil } from "@aevum-kit/aevum";
import { defaultNetwork, networkByChainId, type Network } from "@/lib/env";

/**
 * Shared guards for the server routes that spend YOUR gas or serve paid data.
 *
 * The limits below live in this process's memory. That's fine for `next start` on one server.
 * On serverless (Vercel, Netlify…) every instance has its own copy and loses it on a cold start:
 * move them to a shared store (Redis, Upstash, your database) before you rely on them.
 */

const LOCAL_CHAINS = new Set<number>([localAnvil.id, aevumFork.id]);

// One account per key for the whole process, so viem's nonce manager can hand out nonces to
// concurrent requests without two transactions colliding. On globalThis because Next gives each
// route bundle its own copy of this module.
const g = globalThis as typeof globalThis & { __tabAccounts?: Map<string, PrivateKeyAccount | null> };
const accounts = (g.__tabAccounts ??= new Map());
export function loadKey(envName: string): PrivateKeyAccount | undefined {
  if (!accounts.has(envName)) {
    const raw = process.env[envName]?.trim();
    const key = (raw?.startsWith("0x") ? raw : `0x${raw ?? ""}`) as Hex;
    accounts.set(envName, raw && isHex(key) && key.length === 66 ? privateKeyToAccount(key, { nonceManager }) : null);
  }
  return accounts.get(envName) ?? undefined;
}

/** anvil's default keys are public. On a real network, bots would empty that wallet in seconds. */
export function usable(account: PrivateKeyAccount | undefined, net: Network): PrivateKeyAccount | undefined {
  if (!account) return undefined;
  if (isAnvilAccount(account.address) && !LOCAL_CHAINS.has(net.chain.id)) return undefined;
  return account;
}

export const isLocal = (net: Network) => LOCAL_CHAINS.has(net.chain.id);

const hits = new Map<string, number[]>();
/** `record: false` only checks whether the bucket is already full. */
export function limited(bucket: string, max: number, record = true): boolean {
  const now = Date.now();
  const recent = (hits.get(bucket) ?? []).filter((t) => now - t < 60_000);
  if (!record) return recent.length >= max;
  recent.push(now);
  hits.set(bucket, recent);
  if (hits.size > 10_000) {
    for (const [k, times] of hits) if (times.every((t) => now - t >= 60_000)) hits.delete(k);
  }
  return recent.length > max;
}

/**
 * The caller's IP. Clients can write any X-Forwarded-For they like, so never trust its first entry.
 * Set TRUSTED_IP_HEADER to the header your host sets itself (Vercel: x-vercel-forwarded-for,
 * Cloudflare: cf-connecting-ip). Otherwise this takes the entry your own proxy appended last.
 */
export function clientIp(req: Request): string {
  const trusted = process.env.TRUSTED_IP_HEADER?.trim().toLowerCase();
  if (trusted) return req.headers.get(trusted)?.split(",")[0]?.trim() || "unknown";
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",").at(-1)?.trim() || "unknown";
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

export const isUint = (v: unknown): v is string => typeof v === "string" && /^\d{1,78}$/.test(v);
export const fail = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** The configured network a request is for. No chainId means the default network. */
export function networkFor(chainId: unknown): Network | undefined {
  if (chainId === undefined || chainId === null || chainId === "") return defaultNetwork;
  return networkByChainId(Number(chainId));
}
