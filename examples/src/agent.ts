/**
 * An AI agent that pays per API call from its tab. Only its session key (AGENT_KEY) is here:
 * it can spend up to the tab's deposit, to one merchant, until the tab ends or the owner revokes it.
 *
 *   pnpm example agent "Brief me on BTC and QDAY"     # Claude decides what to fetch (needs ANTHROPIC_API_KEY)
 *   pnpm example agent --calls 200                     # no LLM: 200 paid calls, then a summary
 */
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { formatUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createTabFetch, TUSD8_DECIMALS } from "@aevum-kit/aevum";
import { connect, required, requiredAddress, requiredKey } from "./env";
import { apiUrl } from "./open-tab";

const { values, positionals } = parseArgs({ options: { calls: { type: "string" } }, allowPositionals: true });
const { chain } = await connect();
const channelId = required("TAB_ID") as Hex;
const tab = createTabFetch({
  account: privateKeyToAccount(requiredKey("AGENT_KEY")),
  chainId: chain.id,
  tabs: requiredAddress("TABS_ADDRESS"),
  channelId,
});

async function getMarketData(symbol: string): Promise<{ ok: boolean; text: string }> {
  try {
    const res = await tab.fetch(`${apiUrl()}/api/market?symbol=${encodeURIComponent(symbol)}`);
    const body = await res.json().catch(() => null);
    if (!body) return { ok: false, text: `HTTP ${res.status}: the response wasn't JSON` };
    return { ok: res.ok, text: res.ok ? JSON.stringify(body) : `HTTP ${res.status} ${body.code ?? ""}: ${body.error}` };
  } catch (e) {
    return { ok: false, text: `Request failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function positiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    console.error(`${name} must be a positive integer, got "${raw}".`);
    process.exit(1);
  }
  return n;
}

const tUSD8 = (v: bigint) => `${formatUnits(v, TUSD8_DECIMALS)} tUSD8`;

if (values.calls !== undefined) {
  const n = positiveInt("--calls", values.calls);
  const symbols = ["BTC", "ETH", "QDAY", "SOL"];
  let ok = 0;
  const started = Date.now();
  for (let i = 0; i < n; i++) {
    const r = await getMarketData(symbols[i % symbols.length]);
    if (!r.ok) {
      console.log(`call ${i + 1}: ${r.text}`);
      break;
    }
    ok++;
    if (ok % 50 === 0) console.log(`${ok} calls, ${tUSD8(tab.state().cumulative)} owed so far`);
  }
  const ms = (Date.now() - started) / Math.max(ok, 1);
  const { cumulative, price = 0n } = tab.state();
  console.log(`\n${ok}/${n} calls ok, paid ${tUSD8(BigInt(ok) * price)}, ${ms.toFixed(1)} ms/call`);
  console.log(`final cumulative ${tUSD8(cumulative)} on tab ${channelId}`);
  console.log("on-chain txs: open only; settle when you close");
} else {
  const anthropic = new Anthropic({ apiKey: required("ANTHROPIC_API_KEY") });
  const model = process.env.AGENT_MODEL ?? "claude-sonnet-5-5";
  const maxTurns = positiveInt("MAX_TURNS", process.env.MAX_TURNS ?? "20");
  const task =
    positionals.join(" ") ||
    "Write a short market brief on BTC, ETH and QDAY. Use get_market_data once per symbol; each call costs money from a limited budget.";
  const tools: Anthropic.Tool[] = [
    {
      name: "get_market_data",
      description: "Price, 24h change and headlines for one symbol. Each call is paid from your budget.",
      input_schema: { type: "object", properties: { symbol: { type: "string", description: "e.g. BTC" } }, required: ["symbol"] },
    },
  ];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];

  for (let turn = 0; turn < maxTurns; turn++) {
    const msg = await anthropic.messages.create({ model, max_tokens: 2048, tools, messages });
    messages.push({ role: "assistant", content: msg.content });
    for (const block of msg.content) if (block.type === "text") console.log(block.text);
    const uses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!uses.length) break;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of uses) {
      const { symbol } = use.input as { symbol: string };
      const r = await getMarketData(String(symbol));
      console.log(`→ get_market_data(${symbol}): ${r.ok ? "200" : r.text}`);
      results.push({ type: "tool_result", tool_use_id: use.id, content: r.text, is_error: !r.ok });
    }
    messages.push({ role: "user", content: results });
  }
  const { calls, cumulative } = tab.state();
  console.log(`\n${calls} paid calls, ${tUSD8(cumulative)} owed on tab ${channelId}`);
}
