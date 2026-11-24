/**
 * End-to-end check of a tab against the running web app. Needs `make fork`, `make deploy-fork`,
 * OWNER_KEY with tUSD8 and a little tQDAY (`make deal TO=…`), and `pnpm dev`.
 *
 *   pnpm example e2e
 */
import {
  createWalletClient,
  erc20Abi,
  http,
  numberToHex,
  parseSignature,
  serializeSignature,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createTabFetch, TAB_HEADERS, tabsAbi, voucherTypedData, type PaymentRequired } from "@aevum-kit/aevum";
import { connect, requiredAddress, requiredKey } from "./env";
import { apiUrl, merchantInfo, openTab } from "./open-tab";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const { client, chain, rpcUrl } = await connect();
const tabs = requiredAddress("TABS_ADDRESS");
const owner = privateKeyToAccount(requiredKey("OWNER_KEY"));
const agent = privateKeyToAccount(generatePrivateKey());
const merchant = await merchantInfo();
const price = BigInt(merchant.price);
const market = `${apiUrl()}/api/market?symbol=BTC`;
let step = 0;

function check(cond: boolean, what: string, detail?: unknown): asserts cond {
  if (!cond) {
    console.error(`✗ ${what}`, detail ?? "");
    process.exit(1);
  }
  console.log(`✓ ${what}`);
}

async function voucher(id: Hex, cumulative: bigint, signer: PrivateKeyAccount = agent) {
  return signer.signTypedData(voucherTypedData(chain.id, tabs, id, cumulative));
}

async function rawCall(id: Hex, cumulative: bigint, signature: Hex) {
  const res = await fetch(market, {
    headers: { [TAB_HEADERS.channel]: id, [TAB_HEADERS.cumulative]: cumulative.toString(), [TAB_HEADERS.signature]: signature },
  });
  return { status: res.status, body: (await res.json()) as PaymentRequired };
}

console.log(`${++step}. open tab 1 through the relayer (deposit = 10 calls)`);
const tab1 = await openTab({ owner, signer: agent.address, deposit: 10n * price, seconds: 2 * 3600 });
check((await client.readContract({ address: tabs, abi: tabsAbi, functionName: "channelOf", args: [tab1.id] })).deposit === 10n * price, `tab ${tab1.id} is open`);

const tf = createTabFetch({ account: agent, chainId: chain.id, tabs, channelId: tab1.id });

console.log(`${++step}. five paid calls`);
for (let i = 1; i <= 5; i++) {
  const res = await tf.fetch(market);
  check(res.status === 200, `call ${i} → 200 (cumulative ${res.headers.get(TAB_HEADERS.cumulative)})`, await res.text());
}
const last = tf.state().cumulative;
check(last === 5n * price, "client cumulative = 5 × price");

console.log(`${++step}. voucher that skips a call`);
let r = await rawCall(tab1.id, last + 2n * price, await voucher(tab1.id, last + 2n * price));
check(r.status === 402 && r.body.code === "wrong_amount" && r.body.tab?.cumulative === last.toString(), "402 wrong_amount with resync point", r.body);

console.log(`${++step}. voucher signed by the wrong key`);
r = await rawCall(tab1.id, last + price, await voucher(tab1.id, last + price, privateKeyToAccount(generatePrivateKey())));
check(r.status === 402 && r.body.code === "bad_signature", "402 bad_signature", r.body);

console.log(`${++step}. high-s twin of a valid voucher`);
const { r: sigR, s: sigS, yParity } = parseSignature(await voucher(tab1.id, last + price));
const twin = serializeSignature({ r: sigR, s: numberToHex(N - BigInt(sigS), { size: 32 }), yParity: 1 - (yParity ?? 0) });
r = await rawCall(tab1.id, last + price, twin);
check(r.status === 402 && r.body.code === "bad_signature", "402 bad_signature", r.body);

console.log(`${++step}. calls 6-10 succeed, call 11 hits the cap`);
for (let i = 6; i <= 10; i++) {
  const res = await tf.fetch(market);
  check(res.status === 200, `call ${i} → 200 (remaining ${res.headers.get("x-tab-remaining")})`, await res.text());
}
const capped = await tf.fetch(market);
const cappedBody = (await capped.json()) as PaymentRequired;
check(capped.status === 402 && cappedBody.code === "cap_reached", "call 11 → 402 cap_reached", cappedBody);

console.log(`${++step}. owner revokes tab 2, the agent is cut off at once`);
const agent2 = privateKeyToAccount(generatePrivateKey());
const tab2 = await openTab({ owner, signer: agent2.address, deposit: 10n * price, seconds: 2 * 3600 });
const ownerWallet = createWalletClient({ account: owner, chain, transport: http(rpcUrl) });
const revokeTx = await ownerWallet.writeContract({ address: tabs, abi: tabsAbi, functionName: "revoke", args: [tab2.id], type: "legacy" });
check((await client.waitForTransactionReceipt({ hash: revokeTx })).status === "success", `revoke ${revokeTx}`);
const tf2 = createTabFetch({ account: agent2, chainId: chain.id, tabs, channelId: tab2.id });
const revoked = await tf2.fetch(market);
const revokedBody = (await revoked.json()) as PaymentRequired;
check(revoked.status === 402 && revokedBody.code === "tab_closing", "next call → 402 tab_closing", revokedBody);

console.log(`${++step}. merchant closes tab 1: one transaction collects all 10 calls`);
const token = await client.readContract({ address: tabs, abi: tabsAbi, functionName: "token" });
const before = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [merchant.address!] });
const adminToken = process.env.MERCHANT_ADMIN_TOKEN?.trim();
const res = await fetch(`${apiUrl()}/api/merchant/tabs`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(adminToken && { "x-admin-token": adminToken }) },
  body: JSON.stringify({ id: tab1.id, action: "close" }),
});
const closeBody = await res.json();
check(res.status === 200, `POST close → ${closeBody.hash}`, closeBody);
check((await client.waitForTransactionReceipt({ hash: closeBody.hash })).status === "success", "close mined");
const after = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [merchant.address!] });
check(after - before === 10n * price, `merchant received ${after - before} (= 10 × price)`);
const closed = await client.readContract({ address: tabs, abi: tabsAbi, functionName: "channelOf", args: [tab1.id] });
check(closed.closesAt === 0n && closed.claimed === 10n * price, "tab 1 closed on-chain, claimed = 10 × price");

console.log("\nAll checks passed.");
