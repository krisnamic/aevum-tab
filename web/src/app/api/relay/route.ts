import { NextResponse } from "next/server";
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  isAddressEqual,
  isHex,
  parseSignature,
  parseUnits,
  zeroAddress,
  type Hex,
} from "viem";
import { tabsAbi, TUSD8_DECIMALS } from "@aevum-kit/aevum";
import { defaultNetwork } from "@/lib/env";
import { explain } from "@/lib/errors";
import { merchantAccount } from "@/lib/merchant";
import { clientIp, fail, isUint, limited, loadKey, networkFor, usable } from "@/lib/rails";

/**
 * The relayer behind gasless tab opening. The owner only signs; this route submits
 * TabChannels.openWithAuthorization and pays the gas from RELAYER_PRIVATE_KEY.
 *
 * Anyone on the internet can call this route, and every transaction it sends costs YOUR gas.
 * The rails, in the order they run:
 *  1. Only YOUR TabChannels, only openWithAuthorization, only tabs that pay YOUR merchant.
 *  2. Deposit between 0.01 and 100 tUSD8, tab length between 1 hour and 30 days.
 *  3. Not already open, and not already being submitted.
 *  4. Simulated first, so a bad or expired signature costs nothing.
 *  5. Rate limits per IP and per payer, and a daily cap on transactions.
 * The limits live in this process's memory (see lib/rails.ts).
 */
export const runtime = "nodejs";

const MAX_WINDOW_SECONDS = 3600n;
const MIN_TAB_SECONDS = 3600n;
// The app computes closesAt before the wallet prompt, so a "1 hour" tab arrives a little under an hour out.
const CLOCK_SLACK_SECONDS = 300n;
const MAX_TAB_SECONDS = 30n * 86400n;
const MIN_DEPOSIT = parseUnits("0.01", TUSD8_DECIMALS);
const MAX_DEPOSIT = parseUnits("100", TUSD8_DECIMALS);
const PER_IP_PER_MINUTE = 10;
const PER_PAYER_PER_MINUTE = 3;
const DAILY_TX_LIMIT = Number(process.env.RELAYER_DAILY_TX_LIMIT ?? 500);
const IN_FLIGHT_MS = 120_000;
const isDev = process.env.NODE_ENV !== "production";

let day = "";
let sentToday = 0;
function overDailyLimit(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    sentToday = 0;
  }
  return sentToday >= DAILY_TX_LIMIT;
}

const inFlight = new Map<string, number>();
function claimInFlight(key: string): boolean {
  const now = Date.now();
  for (const [k, t] of inFlight) if (now - t > IN_FLIGHT_MS) inFlight.delete(k);
  if (inFlight.has(key)) return false;
  inFlight.set(key, now);
  return true;
}

const isBytes32 = (v: unknown): v is Hex => typeof v === "string" && isHex(v) && v.length === 66;

/** GET /api/relay?chainId=… tells the app whether gasless opening is available on that network. */
export async function GET(req: Request) {
  const net = networkFor(new URL(req.url).searchParams.get("chainId"));
  const account = net ? usable(loadKey("RELAYER_PRIVATE_KEY"), net) : undefined;
  return NextResponse.json({ enabled: Boolean(account && net?.tabs), relayer: account?.address ?? null });
}

export async function POST(req: Request) {
  if (limited(`ip:${clientIp(req)}`, PER_IP_PER_MINUTE)) return fail("Too many requests. Wait a minute.", 429);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail("Invalid JSON.");
  }

  const net = networkFor(body.chainId);
  if (!net) return fail("This network isn't enabled in the app.");
  if (net.chain.id !== defaultNetwork.chain.id) return fail(`Gasless opening only works on ${defaultNetwork.label}, where the merchant runs.`);
  const account = usable(loadKey("RELAYER_PRIVATE_KEY"), net);
  const merchant = merchantAccount();
  const tabs = net.tabs;
  if (!account || !merchant || !tabs) {
    // Which settings are missing is useful while you build, and nobody else's business once deployed.
    return fail(
      isDev
        ? `Gasless opening is off on ${net.label}. Set RELAYER_PRIVATE_KEY and MERCHANT_PRIVATE_KEY (not anvil keys, except on local chains) and NEXT_PUBLIC_TABS_${net.key.toUpperCase()} in web/.env.local.`
        : "Gasless opening isn't available right now.",
      503,
    );
  }

  const { payer, payee, signer, deposit, closesAt, salt, validAfter, validBefore, signature } = body;
  if (
    !(typeof payer === "string" && isAddress(payer)) ||
    !(typeof payee === "string" && isAddress(payee)) ||
    !(typeof signer === "string" && isAddress(signer)) ||
    !isUint(deposit) || !isUint(closesAt) || !isUint(validAfter) || !isUint(validBefore) ||
    !isBytes32(salt) ||
    !(typeof signature === "string" && isHex(signature))
  ) {
    return fail("Malformed request.");
  }
  if (!isAddressEqual(payee, merchant.address)) return fail("This relayer only opens tabs to its own merchant.");
  if (BigInt(deposit) < MIN_DEPOSIT || BigInt(deposit) > MAX_DEPOSIT) return fail("Deposit must be between 0.01 and 100 tUSD8.");
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(closesAt) < now + MIN_TAB_SECONDS - CLOCK_SLACK_SECONDS || BigInt(closesAt) > now + MAX_TAB_SECONDS) {
    return fail("The tab must last between 1 hour and 30 days.");
  }
  if (BigInt(validBefore) > now + MAX_WINDOW_SECONDS) return fail("Signature window is too long (max 1 hour).");
  if (limited(`payer:${payer.toLowerCase()}`, PER_PAYER_PER_MINUTE)) return fail("Too many tabs from this address. Wait a minute.", 429);

  let v: bigint | undefined, r: Hex, s: Hex, yParity: number | undefined;
  try {
    ({ v, r, s, yParity } = parseSignature(signature));
  } catch {
    return fail("Invalid signature.");
  }
  const vNum = v !== undefined ? Number(v) : 27 + (yParity ?? 0);

  const transport = http();
  const client = createPublicClient({ chain: net.chain, transport });
  const wallet = createWalletClient({ account, chain: net.chain, transport });

  let flightKey: string | undefined;
  try {
    const id = await client.readContract({
      address: tabs,
      abi: tabsAbi,
      functionName: "channelId",
      args: [payer, payee, signer, BigInt(deposit), BigInt(closesAt), salt],
    });
    flightKey = `${net.chain.id}:${id}`;
    if (!claimInFlight(flightKey)) return fail("This tab is already being opened.", 409);
    const channel = await client.readContract({ address: tabs, abi: tabsAbi, functionName: "channelOf", args: [id] });
    if (channel.payer !== zeroAddress) {
      inFlight.delete(flightKey);
      return fail("This tab is already open.", 409);
    }
    if (overDailyLimit()) {
      inFlight.delete(flightKey);
      return fail("The relayer reached its daily limit. Try again tomorrow.", 503);
    }

    const call = {
      account,
      address: tabs,
      abi: tabsAbi,
      functionName: "openWithAuthorization",
      args: [payer, payee, signer, BigInt(deposit), BigInt(closesAt), salt, BigInt(validAfter), BigInt(validBefore), vNum, r, s],
    } as const;
    await client.simulateContract(call);
    const hash = await wallet.writeContract({ ...call, type: "legacy" });
    sentToday++;
    return NextResponse.json({ hash, id });
  } catch (e) {
    if (flightKey) inFlight.delete(flightKey);
    // Out of gas here means the RELAYER is out of gas, not the owner.
    if (e instanceof BaseError && /insufficient funds/i.test(e.message)) {
      console.error("[relay] relayer is out of gas", account.address);
      return fail("The relayer is out of gas. Try again later.", 503);
    }
    return fail(explain(e));
  }
}
