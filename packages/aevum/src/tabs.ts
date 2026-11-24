import { parseAbi, type Address, type Hash, type Hex, type LocalAccount } from "viem";

/** ABI of contracts/src/TabChannels.sol. */
export const tabsAbi = parseAbi([
  "function token() view returns (address)",
  "function REVOKE_GRACE() view returns (uint64)",
  "function channelId(address payer, address payee, address signer, uint256 deposit, uint64 closesAt, bytes32 salt) view returns (bytes32)",
  "function open(address payee, address signer, uint128 deposit, uint64 closesAt, bytes32 salt) returns (bytes32 id)",
  "function openWithAuthorization(address payer, address payee, address signer, uint128 deposit, uint64 closesAt, bytes32 salt, uint256 validAfter, uint256 validBefore, uint8 v, bytes32 r, bytes32 s) returns (bytes32 id)",
  "function settle(bytes32 id, uint256 cumulative, bytes signature)",
  "function close(bytes32 id, uint256 cumulative, bytes signature)",
  "function revoke(bytes32 id)",
  "function reclaim(bytes32 id)",
  "function voucherDigest(bytes32 id, uint256 cumulative) view returns (bytes32)",
  "function channelOf(bytes32 id) view returns ((address payer, uint64 closesAt, address payee, address signer, uint128 deposit, uint128 claimed))",
  "event Opened(bytes32 indexed id, address indexed payer, address indexed payee, address signer, uint256 deposit, uint64 closesAt)",
  "event Settled(bytes32 indexed id, uint256 cumulative, uint256 paid)",
  "event Revoked(bytes32 indexed id, uint64 closesAt)",
  "event Closed(bytes32 indexed id, uint256 refunded)",
  "error ZeroAddress()",
  "error ZeroAmount()",
  "error BadExpiry()",
  "error ChannelExists()",
  "error NotOpen()",
  "error ChannelExpired()",
  "error ChannelStillOpen()",
  "error NotPayer()",
  "error NotPayee()",
  "error BadVoucher()",
  "error InvalidSignature()",
]);

/** TabChannels.REVOKE_GRACE: after a revoke the merchant has this long to redeem its latest voucher. */
export const REVOKE_GRACE_SECONDS = 900;
/** A merchant serves a call only while the tab has more than this left, so a revoke stops service at once. */
export const SERVE_MARGIN_SECONDS = REVOKE_GRACE_SECONDS + 60;

export const TAB_HEADERS = {
  channel: "x-tab-channel",
  cumulative: "x-tab-cumulative",
  signature: "x-tab-signature",
} as const;

/** Typed data the session key signs: "I owe `cumulative` in total on this tab". */
export function voucherTypedData(chainId: number, tabs: Address, channelId: Hex, cumulative: bigint) {
  return {
    domain: { name: "Tab", version: "1", chainId, verifyingContract: tabs },
    types: {
      Voucher: [
        { name: "channelId", type: "bytes32" },
        { name: "cumulative", type: "uint256" },
      ],
    },
    primaryType: "Voucher",
    message: { channelId, cumulative },
  } as const;
}

export type PaymentErrorCode = "payment_required" | "wrong_amount" | "bad_signature" | "cap_reached" | "tab_closing" | "unknown_tab";

/** Body of a 402 from a tab-metered endpoint. Amounts are decimal strings in token base units. */
export interface PaymentRequired {
  error: string;
  code: PaymentErrorCode;
  payment: { scheme: "tab"; chainId: number; tabs: Address; payee: Address; token: Address; price: string };
  tab?: { id: Hex; cumulative: string; deposit: string; closesAt: number };
}

export interface MerchantInfo {
  enabled: boolean;
  address: Address | null;
  chainId: number;
  tabs: Address | null;
  token: Address | null;
  price: string;
  adminRequired: boolean;
}

export interface MeterEntry {
  id: Hex;
  calls: number;
  cumulative: string;
  updatedAt: number;
  settleTx?: Hash;
  closeTx?: Hash;
}

/**
 * `fetch` that pays for each call with a voucher from `account` (the tab's session key).
 * Calls run one at a time: each voucher is the previous total plus the price.
 * The price and the starting total come from the merchant's 402, so a restarted agent resyncs itself.
 */
export function createTabFetch(o: {
  account: LocalAccount;
  chainId: number;
  tabs: Address;
  channelId: Hex;
  retries?: number;
  fetch?: typeof fetch;
}) {
  const doFetch = o.fetch ?? fetch;
  const retries = o.retries ?? 3;
  let cumulative = 0n;
  let calls = 0;
  let price: bigint | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  async function send(url: string | URL, init: RequestInit | undefined, amount: bigint | undefined) {
    const headers = new Headers(init?.headers);
    headers.set(TAB_HEADERS.channel, o.channelId);
    if (amount !== undefined) {
      const signature = await o.account.signTypedData(voucherTypedData(o.chainId, o.tabs, o.channelId, amount));
      headers.set(TAB_HEADERS.cumulative, amount.toString());
      headers.set(TAB_HEADERS.signature, signature);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await doFetch(url, { ...init, headers });
        if (res.status < 500 || attempt >= retries) return res;
      } catch (e) {
        if (attempt >= retries) throw e;
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }

  async function call(url: string | URL, init?: RequestInit) {
    // ponytail: a lost 200 makes the retry pay one extra call; idempotent replays would let anyone re-read for free
    let amount = price === undefined ? undefined : cumulative + price;
    let res = await send(url, init, amount);
    if (res.status === 402) {
      const body = (await res.clone().json().catch(() => null)) as PaymentRequired | null;
      if (body?.payment) {
        if (body.payment.chainId !== o.chainId || body.payment.tabs.toLowerCase() !== o.tabs.toLowerCase()) {
          throw new Error("Merchant asked for a different contract or chain");
        }
        if (body.code === "payment_required" || body.code === "wrong_amount") {
          if (body.tab) cumulative = BigInt(body.tab.cumulative);
          price = BigInt(body.payment.price);
          amount = cumulative + price;
          res = await send(url, init, amount);
        }
      }
    }
    if (res.ok && amount !== undefined) {
      cumulative = BigInt(res.headers.get(TAB_HEADERS.cumulative) ?? amount);
      calls++;
    }
    return res;
  }

  return {
    fetch(url: string | URL, init?: RequestInit): Promise<Response> {
      const next = queue.then(() => call(url, init));
      queue = next.catch(() => undefined);
      return next;
    },
    state() {
      return { cumulative, calls, price };
    },
  };
}
