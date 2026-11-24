/**
 * Opens a tab for an AI agent, gaslessly: the OWNER only signs, the web app's relayer pays the gas.
 * Prints the three lines the agent needs.
 *
 *   pnpm example open-tab                       # 1 tUSD8, 24 hours, fresh session key
 *   DEPOSIT=5 HOURS=2 pnpm example open-tab
 */
import { pathToFileURL } from "node:url";
import { formatUnits, isAddressEqual, parseUnits, toHex, type Address, type Hash, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  aevumTestnet,
  authorizationWindow,
  receiveAuthorizationTypedData,
  tabsAbi,
  TUSD8_DECIMALS,
  txUrl,
  type MerchantInfo,
} from "@aevum-kit/aevum";
import { connect, required, requiredAddress, requiredKey } from "./env";

export const apiUrl = () => (process.env.API_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "");

export async function merchantInfo(): Promise<MerchantInfo> {
  const res = await fetch(`${apiUrl()}/api/merchant`);
  if (!res.ok) throw new Error(`GET /api/merchant: HTTP ${res.status}. Is the web app running (pnpm dev)?`);
  return res.json();
}

/** Signs the deposit as `owner` and has the relayer open the tab. Returns once it's mined. */
export async function openTab(o: {
  owner: PrivateKeyAccount;
  signer: Address;
  deposit: bigint;
  seconds: number;
}): Promise<{ id: Hex; hash: Hash; closesAt: bigint }> {
  const { client, chain } = await connect();
  const tabs = requiredAddress("TABS_ADDRESS");
  const merchant = await merchantInfo();
  if (!merchant.enabled || !merchant.address) throw new Error("The web app's merchant isn't configured (MERCHANT_PRIVATE_KEY, NEXT_PUBLIC_TABS_*).");
  if (merchant.chainId !== chain.id || !merchant.tabs || !isAddressEqual(merchant.tabs, tabs)) {
    throw new Error(`The web app runs on chain ${merchant.chainId} with ${merchant.tabs}; RPC_URL / TABS_ADDRESS point elsewhere.`);
  }

  const closesAt = BigInt(Math.floor(Date.now() / 1000) + o.seconds);
  const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const args = [o.owner.address, merchant.address, o.signer, o.deposit, closesAt, salt] as const;
  const id = await client.readContract({ address: tabs, abi: tabsAbi, functionName: "channelId", args });
  const token = await client.readContract({ address: tabs, abi: tabsAbi, functionName: "token" });
  const { validAfter, validBefore } = authorizationWindow(600);
  const signature = await o.owner.signTypedData(
    receiveAuthorizationTypedData(chain.id, token, { from: o.owner.address, to: tabs, value: o.deposit, validAfter, validBefore, nonce: id }),
  );

  const res = await fetch(`${apiUrl()}/api/relay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chainId: chain.id,
      payer: o.owner.address,
      payee: merchant.address,
      signer: o.signer,
      deposit: o.deposit.toString(),
      closesAt: closesAt.toString(),
      salt,
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      signature,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Relay refused: ${body.error}`);
  if (body.id !== id) throw new Error(`Relay opened ${body.id}, expected ${id}`);
  const receipt = await client.waitForTransactionReceipt({ hash: body.hash });
  if (receipt.status !== "success") throw new Error(`Open transaction reverted: ${body.hash}`);
  return { id, hash: body.hash, closesAt };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { chain } = await connect();
  const owner = privateKeyToAccount(requiredKey("OWNER_KEY"));
  required("TABS_ADDRESS");
  const agentKey = generatePrivateKey();
  const agent = privateKeyToAccount(agentKey);
  const deposit = parseUnits(process.env.DEPOSIT ?? "1", TUSD8_DECIMALS);
  const hours = Number(process.env.HOURS ?? 24);

  const { id, hash, closesAt } = await openTab({ owner, signer: agent.address, deposit, seconds: hours * 3600 });
  console.log(`Opened tab ${id}`);
  console.log(`  owner ${owner.address}, deposit ${formatUnits(deposit, TUSD8_DECIMALS)} tUSD8, ends ${new Date(Number(closesAt) * 1000).toISOString()}`);
  console.log(`  ${chain.id === aevumTestnet.id ? txUrl(hash) : `tx ${hash}`}`);
  console.log("\nGive the agent these lines (examples/.env). The key can only spend from this tab:\n");
  console.log(`TAB_ID=${id}`);
  console.log(`TABS_ADDRESS=${process.env.TABS_ADDRESS}`);
  console.log(`AGENT_KEY=${agentKey}`);
}
