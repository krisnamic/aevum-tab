import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { isHex, type Hex } from "viem";
import { defaultNetwork } from "@/lib/env";
import { adminRequired, meter, submit } from "@/lib/merchant";
import { clientIp, fail, limited } from "@/lib/rails";

export const runtime = "nodejs";

const digest = (s: string) => createHash("sha256").update(s).digest();
const tokenOk = (given: string | null, token: string) => given !== null && timingSafeEqual(digest(given), digest(token));

const isId = (v: unknown): v is Hex => typeof v === "string" && isHex(v) && v.length === 66;

/** GET /api/merchant/tabs[?ids=0xa,0xb]: what the merchant metered off-chain for these tabs (default: all). */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("ids");
  const ids = raw ? raw.split(",").map((s) => s.trim()) : undefined;
  if (ids && (ids.length > 100 || !ids.every(isId))) return fail("ids must be up to 100 comma-separated tab ids.");
  return NextResponse.json({ chainId: defaultNetwork.chain.id, tabs: meter(ids) });
}

/** POST /api/merchant/tabs { id, action: "settle" | "close" }: redeem the latest voucher on-chain. */
export async function POST(req: Request) {
  const token = process.env.MERCHANT_ADMIN_TOKEN;
  if (adminRequired() && (!token || !tokenOk(req.headers.get("x-admin-token"), token))) {
    if (limited(`admin:${clientIp(req)}`, 10)) return fail("Too many requests. Wait a minute.", 429);
    return fail(token ? "Wrong admin token." : "Set MERCHANT_ADMIN_TOKEN on the server to settle from here.", 401);
  }
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail("Invalid JSON.");
  }
  const { id, action } = body;
  if (!isId(id) || (action !== "settle" && action !== "close")) return fail('Send { id, action: "settle" | "close" }.');
  const r = await submit(id, action);
  return r.ok ? NextResponse.json({ hash: r.hash }) : fail(r.error, r.status);
}
