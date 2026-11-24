import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  hexToBigInt,
  http,
  isAddressEqual,
  isHex,
  parseUnits,
  recoverTypedDataAddress,
  sliceHex,
  zeroAddress,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import {
  SERVE_MARGIN_SECONDS,
  TAB_HEADERS,
  TUSD8_DECIMALS,
  tabsAbi,
  voucherTypedData,
  type MeterEntry,
  type PaymentErrorCode,
  type PaymentRequired,
} from "@aevum-kit/aevum";
import { defaultNetwork } from "@/lib/env";
import { explain } from "@/lib/errors";
import { isLocal, isUint, loadKey, usable } from "@/lib/rails";

/**
 * The merchant side of a tab: checks each call's voucher, keeps the latest one, and redeems it on-chain.
 * Runs on the default network only (the first of NEXT_PUBLIC_NETWORKS).
 */

export const PRICE = parseUnits(process.env.TAB_PRICE ?? "0.001", TUSD8_DECIMALS);
const STORE = process.env.MERCHANT_STORE ?? ".data/vouchers.json";
const WATCH_MS = 15_000;
// secp256k1n / 2. Above it a signature has a twin (r, n - s) that viem accepts but the contract's ECDSA rejects.
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

interface Voucher {
  cumulative: string;
  signature: Hex;
  calls: number;
  updatedAt: number;
  settleTx?: Hash;
  closeTx?: Hash;
  ended?: boolean;
}

// Next bundles instrumentation and each route separately, so plain module state would exist once per bundle.
// globalThis is shared by the whole process.
const g = globalThis as typeof globalThis & {
  __tabMerchant?: { store: Record<string, Voucher>; busy: Map<string, "settle" | "close">; watching: boolean };
};
function state() {
  return (g.__tabMerchant ??= { store: load(), busy: new Map(), watching: false });
}

// ponytail: one JSON file, one next start process; move to SQLite/Redis for >1 instance or serverless
function load(): Record<string, Voucher> {
  mkdirSync(dirname(STORE), { recursive: true });
  try {
    return JSON.parse(readFileSync(STORE, "utf8"));
  } catch (e) {
    // Anything but a missing file must stop the server: starting empty would overwrite every stored voucher.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}
function persist() {
  writeFileSync(`${STORE}.tmp`, JSON.stringify(state().store));
  renameSync(`${STORE}.tmp`, STORE);
}

const chainId = defaultNetwork.chain.id;
const keyOf = (id: Hex) => `${chainId}:${id.toLowerCase()}`;
const idOf = (key: string) => key.slice(key.indexOf(":") + 1) as Hex;
const client = createPublicClient({ chain: defaultNetwork.chain, transport: http() });

export function merchantAccount() {
  return usable(loadKey("MERCHANT_PRIVATE_KEY"), defaultNetwork);
}

/** Settle/close need MERCHANT_ADMIN_TOKEN, except on a local chain when it isn't set. */
export function adminRequired() {
  return Boolean(process.env.MERCHANT_ADMIN_TOKEN) || !isLocal(defaultNetwork);
}

let tokenOf: Promise<Address> | undefined;
export function merchantToken(): Promise<Address> | undefined {
  const tabs = defaultNetwork.tabs;
  if (!tabs) return undefined;
  tokenOf ??= client.readContract({ address: tabs, abi: tabsAbi, functionName: "token" });
  tokenOf.catch(() => (tokenOf = undefined));
  return tokenOf;
}

const now = () => Math.floor(Date.now() / 1000);

type Check =
  | { ok: true; cumulative: bigint; remaining: bigint }
  | { ok: false; status: number; body: PaymentRequired | { error: string } };

/** Decides whether to serve a paid call. Accepting a voucher stores it, so the merchant can redeem it later. */
export async function checkPayment(headers: Headers): Promise<Check> {
  const account = merchantAccount();
  const tabs = defaultNetwork.tabs;
  const token = merchantToken();
  if (!account || !tabs || !token) return { ok: false, status: 503, body: { error: "The merchant isn't configured." } };
  const payment: PaymentRequired["payment"] = {
    scheme: "tab",
    chainId,
    tabs,
    payee: account.address,
    token: await token,
    price: PRICE.toString(),
  };
  const deny = (code: PaymentErrorCode, error: string, tab?: PaymentRequired["tab"]): Check => ({
    ok: false,
    status: 402,
    body: { error, code, payment, ...(tab && { tab }) },
  });

  const id = headers.get(TAB_HEADERS.channel);
  const cum = headers.get(TAB_HEADERS.cumulative);
  const sig = headers.get(TAB_HEADERS.signature);
  const askPrice = `Each call costs ${payment.price} (base units). Send a voucher.`;
  if (!id && !cum && !sig) return deny("payment_required", askPrice);
  // A channel id alone asks where this tab stands, so a restarted agent can resync before it signs.
  const probe = cum === null && sig === null;
  if (!(id && isHex(id) && id.length === 66) || (!probe && !(isUint(cum) && sig && isHex(sig)))) {
    return { ok: false, status: 400, body: { error: "Malformed tab headers." } };
  }

  // ponytail: per-call channelOf read; add a 2s TTL cache if the public RPC rate-limits
  const ch = await client.readContract({ address: tabs, abi: tabsAbi, functionName: "channelOf", args: [id] });
  if (ch.payer === zeroAddress || !isAddressEqual(ch.payee, account.address)) {
    return deny("unknown_tab", "This merchant has no such tab.");
  }
  const key = keyOf(id);
  const lastOf = () => {
    const stored = BigInt(state().store[key]?.cumulative ?? 0);
    return stored > ch.claimed ? stored : ch.claimed;
  };
  const closing = () => state().busy.get(key) === "close" || Boolean(state().store[key]?.closeTx);
  const tabInfo = () => ({ id, cumulative: lastOf().toString(), deposit: ch.deposit.toString(), closesAt: Number(ch.closesAt) });

  if (ch.closesAt === 0n || Number(ch.closesAt) - now() <= SERVE_MARGIN_SECONDS || closing()) {
    return deny("tab_closing", "This tab is closed or about to close. Open a new one.", tabInfo());
  }
  if (probe) return deny("payment_required", askPrice, tabInfo());
  const cumulative = BigInt(cum!);
  if (!(await validSignature(sig!, ch.signer, id, cumulative, tabs))) {
    return deny("bad_signature", "The voucher isn't signed by this tab's agent key.", tabInfo());
  }

  // From here on, no await: re-read, compare and store in one step so two concurrent calls can't both be accepted.
  if (closing()) return deny("tab_closing", "This tab is closed or about to close. Open a new one.", tabInfo());
  const last = lastOf();
  if (cumulative > ch.deposit || last + PRICE > ch.deposit) {
    return deny("cap_reached", "This tab's deposit is used up.", tabInfo());
  }
  if (cumulative !== last + PRICE) {
    return deny("wrong_amount", "The voucher must be the last accepted total plus the price.", tabInfo());
  }
  const prev = state().store[key];
  state().store[key] = { ...prev, cumulative: cumulative.toString(), signature: sig!, calls: (prev?.calls ?? 0) + 1, updatedAt: Date.now() };
  persist();
  return { ok: true, cumulative, remaining: ch.deposit - cumulative };
}

async function validSignature(sig: Hex, signer: Address, id: Hex, cumulative: bigint, tabs: Address) {
  if (sig.length !== 132) return false;
  const v = hexToBigInt(sliceHex(sig, 64));
  if (v !== 27n && v !== 28n) return false;
  if (hexToBigInt(sliceHex(sig, 32, 64)) > HALF_N) return false;
  try {
    const recovered = await recoverTypedDataAddress({ ...voucherTypedData(chainId, tabs, id, cumulative), signature: sig });
    return isAddressEqual(recovered, signer);
  } catch {
    return false;
  }
}

/** What the merchant has metered off-chain. Never includes signatures. */
export function meter(ids?: Hex[]): MeterEntry[] {
  const store = state().store;
  const keys = ids ? ids.map(keyOf) : Object.keys(store).filter((k) => k.startsWith(`${chainId}:`));
  return keys
    .filter((k) => store[k])
    .map((k) => {
      const { cumulative, calls, updatedAt, settleTx, closeTx } = store[k];
      return { id: idOf(k), calls, cumulative, updatedAt, settleTx, closeTx };
    });
}

type Submit = { ok: true; hash: Hash } | { ok: false; status: number; error: string };

/** Redeem the latest voucher (settle), or redeem it and refund the rest to the owner (close). */
export async function submit(id: Hex, action: "settle" | "close"): Promise<Submit> {
  const account = merchantAccount();
  const tabs = defaultNetwork.tabs;
  if (!account || !tabs) return { ok: false, status: 503, error: "The merchant isn't configured." };
  const key = keyOf(id);
  const { store, busy } = state();
  if (busy.has(key)) return { ok: false, status: 409, error: "A transaction for this tab is already pending." };
  const entry = store[key];
  if (action === "settle" && !entry) return { ok: false, status: 404, error: "No voucher stored for this tab." };

  busy.set(key, action);
  let sent = false;
  try {
    const cumulative = BigInt(entry?.cumulative ?? 0);
    if (action === "settle") {
      const ch = await client.readContract({ address: tabs, abi: tabsAbi, functionName: "channelOf", args: [id] });
      if (cumulative <= ch.claimed) return { ok: false, status: 409, error: "Nothing unsettled on this tab." };
    }
    const call = {
      account,
      address: tabs,
      abi: tabsAbi,
      functionName: action,
      args: [id, cumulative, entry?.signature ?? "0x"],
    } as const;
    await client.simulateContract(call);
    const wallet = createWalletClient({ account, chain: defaultNetwork.chain, transport: http() });
    const hash = await wallet.writeContract({ ...call, type: "legacy" });
    sent = true;
    const field = action === "settle" ? "settleTx" : "closeTx";
    // Re-read: vouchers accepted during the awaits above must not be overwritten.
    store[key] = { ...(store[key] ?? { cumulative: "0", signature: "0x", calls: 0, updatedAt: Date.now() }), [field]: hash };
    persist();
    client
      .waitForTransactionReceipt({ hash })
      .then((r) => {
        if (r.status !== "success") throw new Error("reverted");
      })
      .catch((e) => {
        console.error(`[merchant] ${action} ${id} not confirmed`, e);
        const current = store[key];
        if (current?.[field] === hash) {
          delete current[field];
          persist();
        }
      })
      .finally(() => busy.delete(key));
    return { ok: true, hash };
  } catch (e) {
    if (e instanceof BaseError && /insufficient funds/i.test(e.message)) {
      console.error("[merchant] merchant is out of gas", account.address);
      return { ok: false, status: 503, error: "The merchant is out of gas." };
    }
    return { ok: false, status: 400, error: explain(e) };
  } finally {
    if (!sent) busy.delete(key);
  }
}

/**
 * Every 15s, redeem the latest voucher of any tab that is about to end (expiry or revoke),
 * so the merchant gets paid even if nobody presses Settle.
 */
export function startWatcher() {
  const s = state();
  if (s.watching || !merchantAccount() || !defaultNetwork.tabs) return;
  s.watching = true;
  console.log(`[merchant] watching tabs on ${defaultNetwork.label} as ${merchantAccount()!.address}`);
  let ticking = false;
  setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      // ponytail: one channelOf per open entry per tick; batch with multicall if the store grows large
      for (const [key, v] of Object.entries(s.store)) {
        if (v.closeTx || v.ended || !key.startsWith(`${chainId}:`) || s.busy.has(key)) continue;
        const id = idOf(key);
        try {
          const ch = await client.readContract({ address: defaultNetwork.tabs!, abi: tabsAbi, functionName: "channelOf", args: [id] });
          const left = Number(ch.closesAt) - now();
          if (ch.closesAt === 0n || left <= 0) {
            s.store[key].ended = true;
            persist();
            continue;
          }
          if (BigInt(v.cumulative) > ch.claimed && left > 0 && left < SERVE_MARGIN_SECONDS) {
            const r = await submit(id, "settle");
            console.log(`[merchant] auto-settle ${id}:`, r.ok ? r.hash : r.error);
          }
        } catch (e) {
          console.error(`[merchant] watcher ${id}`, e instanceof Error ? e.message : e);
        }
      }
    } finally {
      ticking = false;
    }
  }, WATCH_MS).unref();
}
