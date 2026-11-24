import type { Metadata } from "next";
import { aevumTestnet, links, TUSD8_ADDRESS } from "@aevum-kit/aevum";
import { GitHubIcon } from "@/components/Icons";
import { repoUrl } from "@/lib/env";

export const metadata: Metadata = { title: "Docs" };

const sections = [
  { id: "how", label: "How a tab works" },
  { id: "demo", label: "Demo in 5 minutes" },
  { id: "http", label: "The 402 flow" },
  { id: "safety", label: "What the agent can't do" },
  { id: "merchant", label: "Getting paid" },
  { id: "run", label: "Run it yourself" },
  { id: "network", label: "Network details" },
];

function Code({ children }: { children: string }) {
  return (
    <pre className="code">
      <code>{children.trim()}</code>
    </pre>
  );
}

export default function DocsPage() {
  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">Docs</p>
          <h1>Pay-per-call tabs for AI agents</h1>
          <p className="lede">
            You lock a deposit once. Your agent pays for every API call with a signed voucher, no gas and no wallet popups. The merchant
            settles on Aevum when it likes. Thousands of calls, two transactions.
          </p>
        </div>
        <a className="btn secondary" href={repoUrl} target="_blank" rel="noreferrer">
          <GitHubIcon />
          View the code on GitHub
        </a>
      </div>

      <div className="docs">
        <nav className="docs-toc" aria-label="On this page">
          <p className="docs-toc-title">On this page</p>
          {sections.map((s) => (
            <a key={s.id} href={`#${s.id}`}>
              {s.label}
            </a>
          ))}
        </nav>

        <article className="docs-body">
          <section id="how">
            <h2>How a tab works</h2>
            <ol>
              <li>
                <strong>Open.</strong> You sign one EIP-3009 authorization in your wallet. A relayer submits{" "}
                <code>TabChannels.openWithAuthorization</code>, which moves your tUSD8 deposit into the contract. You pay no gas.
              </li>
              <li>
                <strong>Spend.</strong> Your agent holds a session key. For each call it signs a voucher: &quot;this tab owes the merchant
                X in total&quot;. The merchant checks it and serves the call. Nothing goes on chain.
              </li>
              <li>
                <strong>Settle.</strong> The merchant redeems its latest voucher with <code>settle</code> or <code>close</code>. One
                transaction pays for every call since the last one.
              </li>
              <li>
                <strong>End.</strong> <code>close</code> refunds the rest to you at once. If the merchant never closes, you{" "}
                <code>reclaim</code> after the tab ends.
              </li>
            </ol>
            <p>
              The Tabs page shows each tab&apos;s live meter: calls served, how much the agent has used (signed off-chain), how much is
              settled on-chain, and the deposit.
            </p>
          </section>

          <section id="demo">
            <h2>Demo in 5 minutes</h2>
            <ol>
              <li>
                On <a href="/">Setup</a>, connect a wallet and get tUSD8 plus a little tQDAY (Revoke and Reclaim are normal transactions).
              </li>
              <li>
                On <a href="/tabs">Tabs</a>, press <em>Generate session key</em>, keep the 1.00 tUSD8 deposit, pick 1 hour and sign.
              </li>
              <li>Copy the three lines it shows into <code>examples/.env</code>.</li>
              <li>
                Run the agent: <code>pnpm --filter examples agent --calls 300</code> for a fast loop without an LLM, or{" "}
                <code>pnpm --filter examples agent</code> to let Claude decide what to buy.
              </li>
              <li>Watch the meter climb on the Tabs and Merchant pages. Settled on-chain stays at 0 until the merchant settles.</li>
              <li>
                Press <strong>Revoke</strong>. The agent&apos;s next call is refused. The merchant settles what it served, and you reclaim
                the rest when the tab ends.
              </li>
            </ol>
          </section>

          <section id="http">
            <h2>The 402 flow</h2>
            <p>
              The paid endpoint is <code>GET /api/market?symbol=BTC</code>. Call it without payment and it answers{" "}
              <code>402 Payment Required</code> with the price and the contract to pay through:
            </p>
            <Code>{`
curl -i "http://localhost:3000/api/market?symbol=BTC"

HTTP/1.1 402 Payment Required
{ "error": "…", "code": "payment_required",
  "payment": { "scheme": "tab", "chainId": 44005, "tabs": "0xTabChannels", "payee": "0xMerchant",
               "token": "0xtUSD8", "price": "1000" } }
`}</Code>
            <p>
              To pay, send three headers. <code>x-tab-cumulative</code> is the running total in base units (6 decimals): the last
              accepted total plus one price. The signature is the session key&apos;s EIP-712 <code>Voucher(bytes32 channelId, uint256
              cumulative)</code> on the domain <code>Tab</code> / <code>1</code> / chain id / TabChannels.
            </p>
            <Code>{`
curl -i "http://localhost:3000/api/market?symbol=BTC" \\
  -H "x-tab-channel: 0xYourTabId" \\
  -H "x-tab-cumulative: 1000" \\
  -H "x-tab-signature: 0xVoucherSignature"

HTTP/1.1 200 OK
x-tab-cumulative: 1000
x-tab-remaining: 999000
{ "symbol": "BTC", "price": …, "change24h": …, "asOf": …, "headlines": [ … ] }
`}</Code>
            <div className="table-wrap">
              <table className="data docs-table wide">
                <thead>
                  <tr>
                    <th>402 code</th>
                    <th>What it means</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td><code>payment_required</code></td><td>No payment headers. Sign a voucher and call again.</td></tr>
                  <tr><td><code>wrong_amount</code></td><td>The total isn&apos;t last accepted + price. The body has the last accepted total so the client can resync.</td></tr>
                  <tr><td><code>bad_signature</code></td><td>Not signed by this tab&apos;s session key (or a malformed / high-s signature).</td></tr>
                  <tr><td><code>cap_reached</code></td><td>The deposit is used up. Open a new tab.</td></tr>
                  <tr><td><code>tab_closing</code></td><td>The tab ends soon, was revoked, or is closed. The merchant stops serving 16 minutes before the end.</td></tr>
                  <tr><td><code>unknown_tab</code></td><td>No such tab, or it pays a different merchant or chain.</td></tr>
                </tbody>
              </table>
            </div>
            <p>
              In TypeScript, <code>createTabFetch</code> from <code>@aevum-kit/aevum</code> does all of this: it signs, resyncs on{" "}
              <code>wrong_amount</code>, retries network errors with the same voucher, and refuses a 402 that names another contract or
              chain.
            </p>
          </section>

          <section id="safety">
            <h2>What the agent can&apos;t do</h2>
            <p>Least privilege is built into the contract, not promised by the app:</p>
            <ul>
              <li>
                <strong>Spend more than the deposit.</strong> The deposit is the hard cap. A voucher above it pays out the deposit and no
                more.
              </li>
              <li>
                <strong>Pay anyone else.</strong> The session key signs for one tab id, which fixes the merchant, amount and expiry you
                signed. Money only ever goes to that merchant or back to you.
              </li>
              <li>
                <strong>Run forever.</strong> Every tab has an expiry (1 hour to 7 days here). After it, you reclaim what&apos;s left.
              </li>
              <li>
                <strong>Keep going after you revoke.</strong> Revoke cuts the tab to 15 minutes, so the merchant refuses the next call and
                has just enough time to redeem calls it already served.
              </li>
              <li>
                <strong>Touch your wallet.</strong> The session key holds no funds and can&apos;t sign anything your wallet would accept.
                The key is generated in your browser and never stored.
              </li>
            </ul>
            <p>
              Agents read untrusted text. The demo&apos;s <code>QDAY</code> headlines include a prompt injection asking the agent to call
              1,000 more times. The cap holds no matter what the model decides.
            </p>
          </section>

          <section id="merchant">
            <h2>Getting paid</h2>
            <p>
              The merchant keeps the latest voucher per tab in <code>web/.data/vouchers.json</code>. A watcher checks every tab every 15
              seconds and settles automatically before the merchant stops serving. On the Merchant page you can settle or close any tab
              yourself; set <code>MERCHANT_ADMIN_TOKEN</code> to protect those buttons.
            </p>
            <p>
              Vouchers are cumulative, so only the newest one matters. Settling twice never pays twice, and a lost voucher only loses
              the calls after the last settle.
            </p>
          </section>

          <section id="run">
            <h2>Run it yourself</h2>
            <Code>{`
pnpm install
make deploy-aevum          # or deploy-fork / deploy-local; prints TabChannels and the deploy block
cp web/.env.example web/.env.local
# set NEXT_PUBLIC_TABS_AEVUM, NEXT_PUBLIC_DEPLOY_BLOCK_AEVUM,
#     RELAYER_PRIVATE_KEY, MERCHANT_PRIVATE_KEY (and MERCHANT_ADMIN_TOKEN)
pnpm --filter web build && pnpm --filter web start
`}</Code>
            <p>
              The merchant needs one long-running <code>next start</code> process: it keeps vouchers on disk and runs the settle watcher.
              Serverless hosting won&apos;t keep either. The relayer and merchant wallets need tQDAY for gas.
            </p>
            <Code>{`
pnpm --filter examples open-tab          # open a tab from the command line
pnpm --filter examples agent --calls 300 # pay for 300 calls, no LLM
pnpm --filter examples agent             # let Claude use the paid tool
pnpm --filter examples e2e               # full check against a fork
`}</Code>
          </section>

          <section id="network">
            <h2>Network details</h2>
            <div className="table-wrap">
              <table className="data docs-table">
                <tbody>
                  <tr><th scope="row">Network</th><td>QDay Aevum testnet, chain id 44005</td></tr>
                  <tr><th scope="row">RPC</th><td><code>{aevumTestnet.rpcUrls.default.http[0]}</code></td></tr>
                  <tr><th scope="row">Explorer</th><td><a href={links.explorer} target="_blank" rel="noreferrer">{links.explorer.replace("https://", "")}</a></td></tr>
                  <tr><th scope="row">tUSD8</th><td><code className="wrap">{TUSD8_ADDRESS}</code> · 6 decimals · supports EIP-3009</td></tr>
                  <tr><th scope="row">Test tokens</th><td><a href={links.faucetWeb} target="_blank" rel="noreferrer">Web faucet</a>, or <code>/faucet</code> in the QDay Discord</td></tr>
                </tbody>
              </table>
            </div>
            <ul>
              <li><code>eth_getLogs</code> serves at most 1,000 blocks per call, so the app reads events in chunks.</li>
              <li>No WebSocket RPC: the app polls over HTTPS.</li>
              <li>Contracts compile with <code>evm_version = &quot;shanghai&quot;</code>.</li>
            </ul>
          </section>
        </article>
      </div>
    </main>
  );
}
