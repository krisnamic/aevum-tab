import { NextResponse } from "next/server";
import type { MerchantInfo } from "@aevum-kit/aevum";
import { defaultNetwork } from "@/lib/env";
import { adminRequired, merchantAccount, merchantToken, PRICE } from "@/lib/merchant";

export const runtime = "nodejs";

/** GET /api/merchant: who gets paid, on which contract, and what a call costs. */
export async function GET() {
  const account = merchantAccount();
  const tabs = defaultNetwork.tabs ?? null;
  const token = await merchantToken()?.catch(() => undefined);
  const info: MerchantInfo = {
    enabled: Boolean(account && tabs && token),
    address: account?.address ?? null,
    chainId: defaultNetwork.chain.id,
    tabs,
    token: token ?? null,
    price: PRICE.toString(),
    adminRequired: adminRequired(),
  };
  return NextResponse.json(info);
}
