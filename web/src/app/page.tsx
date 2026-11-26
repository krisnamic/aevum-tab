import { addressUrl, txUrl } from "@aevum-kit/aevum";
import Link from "next/link";
import { repoUrl } from "@/lib/env";
import { short } from "@/lib/format";

// The 500-call run on Aevum testnet that the README records.
const RUN = {
  open: "0x99237f3adc3c0c09ac713172bc8f5dfb4747575e8042c36511c1e17993b47b66",
  close: "0x00f575fe6e0fa2dbede5a6382e556c1f2e5f4e225b6f68363713dfb22e516fe6",
};
const TABS = "0xB43717cf69b03BBfBbbdf47eC3c830aBd20E9aC0";

const CONTROLS = [
  ["Spend cap", "The deposit. The contract never pays out more, whatever the agent signs."],
  ["One merchant, one key", "The session key signs vouchers for one tab only. It can't move funds anywhere else."],
  ["Expiry", "Every tab ends at a time you pick. Unused deposit comes back to you."],
  ["Revoke", "One click stops the agent's next call. The merchant gets 15 minutes to redeem what it already served."],
  ["Gasless open", "You sign an EIP-3009 authorization. A relayer pays the gas and can't change what you signed."],
  ["Audit trail", "Opened, Settled, Revoked and Closed events on Aevum, plus the merchant's live meter."],
];

export default function Home() {
  return (
    <main className="shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Pay-per-call channels for AI agents · tUSD8 on Aevum</p>
          <h1>
            Run a <em>tab</em> for your agent.
          </h1>
          <p className="lede">
            Lock a deposit, hand your agent a session key, and it pays for each API call with a signed voucher. The merchant
            collects on-chain in one transaction, whenever it likes.
          </p>
          <div className="actions">
            <Link className="btn big" href="/tabs">
              Open a tab
            </Link>
            <Link className="btn secondary" href="/merchant">
              Merchant view
            </Link>
          </div>
        </div>

        <figure className="receipt" style={{ margin: 0 }}>
          <div className="receipt-head">
            <span>Aevum testnet</span>
            <span>Deposit 1.00</span>
          </div>
          <ol>
            <li>
              <span>Open</span>
              <a href={txUrl(RUN.open)} target="_blank" rel="noreferrer">
                {short(RUN.open, 8, 4)}
              </a>
              <span className="fine">Owner signs, relayer pays gas</span>
            </li>
            <li className="offchain">
              <span>500 API calls</span>
              <span>0.50 tUSD8</span>
              <span className="fine">500 vouchers, off-chain, no block wait</span>
            </li>
            <li>
              <span>Close</span>
              <a href={txUrl(RUN.close)} target="_blank" rel="noreferrer">
                {short(RUN.close, 8, 4)}
              </a>
              <span className="fine">0.50 to the merchant, 0.50 back to the owner</span>
            </li>
          </ol>
          <figcaption className="receipt-total">
            <span>On-chain transactions</span>
            <strong>2</strong>
          </figcaption>
        </figure>
      </section>

      <section className="stack" aria-labelledby="how">
        <h2 id="how" className="section-title">
          How a tab works
        </h2>
        <div className="how">
          <div>
            <span className="n">01 · Owner</span>
            <h3>Lock a deposit</h3>
            <p>Pick a merchant, a deposit and an expiry, and sign once. No gas: the relayer submits it.</p>
          </div>
          <div>
            <span className="n">02 · Agent</span>
            <h3>Pay per call</h3>
            <p>Each request carries a voucher for the running total, signed by the agent&apos;s session key. The merchant checks it in milliseconds.</p>
          </div>
          <div>
            <span className="n">03 · Merchant</span>
            <h3>Settle once</h3>
            <p>The latest voucher redeems everything owed. Closing the tab refunds the rest to the owner in the same transaction.</p>
          </div>
        </div>
      </section>

      <section className="stack" aria-labelledby="controls">
        <h2 id="controls" className="section-title">
          What the agent can&apos;t do
        </h2>
        <dl className="controls">
          {CONTROLS.map(([t, d]) => (
            <div key={t}>
              <dt>{t}</dt>
              <dd>{d}</dd>
            </div>
          ))}
        </dl>
      </section>

      <footer className="foot">
        <span>
          TabChannels{" "}
          <a className="mono" href={addressUrl(TABS)} target="_blank" rel="noreferrer">
            {short(TABS)}
          </a>{" "}
          · Aevum testnet, chain 44005
        </span>
        <span>
          <a href={repoUrl} target="_blank" rel="noreferrer">
            Source on GitHub
          </a>{" "}
          · <Link href="/docs">Docs</Link> · <Link href="/setup">Setup</Link>
        </span>
      </footer>
    </main>
  );
}
