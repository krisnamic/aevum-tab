"use client";

import { authorizationWindow, erc20Abi, receiveAuthorizationTypedData, tabsAbi, type MeterEntry } from "@aevum-kit/aevum";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { isAddress, parseUnits, toHex, type Address, type Hash, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { useAccount, useConfig, useReadContract } from "wagmi";
import { readContract, signTypedData, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { CheckIcon } from "@/components/Icons";
import { TabTimeline } from "@/components/TabTimeline";
import { getJson, Meter, StatusPill, tabStatus, TxLink, useChannels, useMerchant, useMeter, useOpenedTabs, type Channel } from "@/components/useTabs";
import { useToken } from "@/components/useToken";
import { explain } from "@/lib/errors";
import { amount, clock, short, tabLabel } from "@/lib/format";
import { useNetwork } from "@/lib/network";

type Phase = "idle" | "working" | "done" | "error";

const STEPS = [
  { title: "Sign the deposit", who: "EIP-3009 · your wallet signs, no gas. The signature only opens this exact tab." },
  { title: "Relayer opens the tab", who: "openWithAuthorization · the relayer pays gas" },
  { title: "Confirmed on Aevum", who: "The Opened event is your tab's receipt" },
];

const EXPIRIES = [
  { seconds: 3600, label: "1 hour" },
  { seconds: 86_400, label: "24 hours" },
  { seconds: 604_800, label: "7 days" },
];

const MIN_DEPOSIT = "0.01";
const MAX_DEPOSIT = "100";

export default function TabsPage() {
  const { net } = useNetwork();
  const appChain = net.chain;
  const tabsAddress = net.tabs;
  const config = useConfig();
  const { address, isConnected, chainId } = useAccount();
  const onChain = isConnected && chainId === appChain.id;
  const token = useToken();
  const merchant = useMerchant();
  const merchantHere = merchant.data?.enabled && merchant.data.chainId === appChain.id ? merchant.data : undefined;

  const relay = useQuery({
    queryKey: ["relay-status", appChain.id],
    queryFn: () => getJson<{ enabled: boolean }>(`/api/relay?chainId=${appChain.id}`),
  });

  const balance = useReadContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: appChain.id,
    query: { enabled: onChain && Boolean(token.address) },
  });

  const [agent, setAgent] = useState("");
  const [sessionKey, setSessionKey] = useState<Hex | null>(null);
  const [deposit, setDeposit] = useState("1.00");
  const [expiry, setExpiry] = useState(EXPIRIES[0]!.seconds);
  const [step, setStep] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ id: Hex; hash: Hash; key: Hex | null } | null>(null);

  const depositUnits = (() => {
    try {
      return parseUnits(deposit.trim() || "x", token.decimals);
    } catch {
      return undefined;
    }
  })();
  const depositError =
    depositUnits === undefined
      ? "Enter an amount like 1.00."
      : depositUnits < parseUnits(MIN_DEPOSIT, token.decimals) || depositUnits > parseUnits(MAX_DEPOSIT, token.decimals)
        ? `The deposit must be between ${MIN_DEPOSIT} and ${MAX_DEPOSIT} ${token.symbol}.`
        : null;
  const agentError = agent && !isAddress(agent.trim()) ? "That isn't a valid address (0x + 40 hex characters)." : null;
  const enoughBalance = balance.data === undefined || depositUnits === undefined || balance.data >= depositUnits;
  const busy = phase === "working";

  function generateKey() {
    const key = generatePrivateKey();
    setSessionKey(key);
    setAgent(privateKeyToAccount(key).address);
  }

  function reset() {
    setPhase("idle");
    setStep(0);
    setError(null);
    setOpened(null);
    setSessionKey(null);
    setAgent("");
  }

  async function openTab(e: FormEvent) {
    e.preventDefault();
    if (phase === "done") return reset();
    if (!address || !tabsAddress || !token.address || !merchantHere?.address || depositUnits === undefined) return;
    setError(null);
    setPhase("working");
    setStep(0);
    try {
      const payee = merchantHere.address;
      const signer = agent.trim() as Address;
      const closesAt = BigInt(Math.floor(Date.now() / 1000) + expiry);
      const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
      // The channel id is also the EIP-3009 nonce, so the signature can't open any other tab.
      const id = await readContract(config, {
        address: tabsAddress,
        abi: tabsAbi,
        functionName: "channelId",
        args: [address, payee, signer, depositUnits, closesAt, salt],
        chainId: appChain.id,
      });
      const { validAfter, validBefore } = authorizationWindow(600);
      const signature = await signTypedData(config, {
        account: address,
        ...receiveAuthorizationTypedData(appChain.id, token.address, { from: address, to: tabsAddress, value: depositUnits, validAfter, validBefore, nonce: id }),
      });
      setStep(1);
      const { hash } = await getJson<{ hash: Hash; id: Hex }>("/api/relay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chainId: appChain.id,
          payer: address,
          payee,
          signer,
          deposit: depositUnits.toString(),
          closesAt: closesAt.toString(),
          salt,
          validAfter: validAfter.toString(),
          validBefore: validBefore.toString(),
          signature,
        }),
      });
      setStep(2);
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: appChain.id });
      if (receipt.status !== "success") throw new Error("The transaction reverted on chain. Nothing was charged.");
      setOpened({ id, hash, key: sessionKey });
      setStep(3);
      setPhase("done");
      balance.refetch();
      tabs.refetch();
    } catch (err) {
      setError(explain(err));
      setPhase("error");
    }
  }

  const tabs = useOpenedTabs(address && tabsAddress ? { payer: address } : undefined);
  const ids = (tabs.data ?? []).map((l) => l.args.id!);
  const channels = useChannels(ids);
  const meter = useMeter(ids, Boolean(merchantHere));

  const blocker = !isConnected
    ? "Connect a wallet to open a tab"
    : !onChain
      ? "Switch network to open a tab"
      : !tabsAddress
        ? "Deploy TabChannels first"
        : !merchantHere
          ? "The merchant isn't available on this network"
          : relay.data && !relay.data.enabled
            ? "Gasless opening is off"
            : null;
  const cta =
    blocker ??
    (phase === "done"
      ? "Open another tab"
      : busy
        ? (["Check your wallet…", "Waiting for relayer…", "Confirming…"][step] ?? "Working…")
        : phase === "error"
          ? "Sign again"
          : `Sign & open a ${amount(depositUnits ?? 0n, token.decimals)} ${token.symbol} tab`);
  const ctaDisabled = Boolean(blocker) || busy || (phase !== "done" && (!agent || Boolean(agentError) || Boolean(depositError) || !enoughBalance));

  const envLines = opened
    ? [`TAB_ID=${opened.id}`, `TABS_ADDRESS=${tabsAddress}`, ...(opened.key ? [`AGENT_KEY=${opened.key}`] : [])].join("\n")
    : "";

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">Your agents · {net.label}</p>
          <h1>Open a tab for your agent</h1>
          <p className="lede">
            Lock a deposit, hand your agent a session key, and it pays per call without ever touching your wallet. The deposit is the
            hard cap; revoke any time.
          </p>
        </div>
      </div>

      {!tabsAddress ? (
        <div className="card empty">
          No TabChannels configured for {net.label}. Run <code>make deploy-{net.key}</code>, then set <code>NEXT_PUBLIC_TABS_{net.key.toUpperCase()}</code> in{" "}
          <code>web/.env.local</code>.
        </div>
      ) : (
        <div className="row">
          <form className="card stack" aria-label="New tab" style={{ flex: "1 1 340px" }} onSubmit={openTab}>
            <h2>New tab</h2>
            <div className="field-group">
              <label htmlFor="payee">Merchant</label>
              <input id="payee" className="field" readOnly value={merchantHere?.address ?? ""} placeholder={merchant.isLoading ? "Loading…" : "Not available"} />
              <p className="fine">
                {merchantHere
                  ? `Charges ${amount(BigInt(merchantHere.price), token.decimals)} ${token.symbol} per call.`
                  : merchant.error
                    ? `Couldn't reach the merchant: ${(merchant.error as Error).message}`
                    : merchant.data && !merchant.data.enabled
                      ? "The merchant isn't set up. Set MERCHANT_PRIVATE_KEY in web/.env.local and restart the app."
                      : merchant.data
                        ? "The merchant runs on another network. Switch networks in the header."
                        : ""}
              </p>
            </div>

            <div className="field-group">
              <label htmlFor="agent">Agent session key (address)</label>
              <div className="field-row">
                <input
                  id="agent"
                  className="field"
                  value={agent}
                  placeholder="0x…"
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={Boolean(agentError)}
                  aria-describedby="agent-help"
                  disabled={busy || phase === "done"}
                  onChange={(e) => {
                    setAgent(e.target.value);
                    setSessionKey(null);
                  }}
                />
                <button type="button" className="btn secondary" disabled={busy || phase === "done"} onClick={generateKey}>
                  Generate session key
                </button>
              </div>
              <p id="agent-help" className={agentError ? "field-error" : "fine"}>
                {agentError ??
                  (sessionKey
                    ? "New key made in this browser. You'll see it once, after the tab opens. It is never saved."
                    : "It can only sign for this one tab, up to the deposit.")}
              </p>
            </div>

            <div className="field-group">
              <label htmlFor="deposit">Deposit ({token.symbol})</label>
              <input
                id="deposit"
                className="field"
                inputMode="decimal"
                value={deposit}
                aria-invalid={Boolean(depositError)}
                aria-describedby="deposit-help"
                disabled={busy || phase === "done"}
                onChange={(e) => setDeposit(e.target.value)}
              />
              <p id="deposit-help" className={depositError ? "field-error" : "fine"}>
                {depositError ??
                  (merchantHere && depositUnits
                    ? `Enough for ${(depositUnits / BigInt(merchantHere.price)).toLocaleString("en-US")} calls. Whatever isn't used comes back to you.`
                    : "Whatever isn't used comes back to you.")}
              </p>
            </div>

            <fieldset className="field-group">
              <legend>Ends after</legend>
              <div className="segmented">
                {EXPIRIES.map((x) => (
                  <label key={x.seconds}>
                    <input type="radio" name="expiry" checked={expiry === x.seconds} disabled={busy || phase === "done"} onChange={() => setExpiry(x.seconds)} />
                    {x.label}
                  </label>
                ))}
              </div>
            </fieldset>

            <ol className="steps">
              {STEPS.map((s, i) => {
                const done = step > i;
                const active = busy && step === i;
                return (
                  <li key={s.title} className={`step ${done ? "done" : active ? "active" : ""}`}>
                    <div className="step-dot">{done ? <CheckIcon /> : i + 1}</div>
                    <div className="step-body">
                      <div className="step-top">
                        <span className="step-title">{s.title}</span>
                        <span className="step-state">{done ? "Done" : active ? "In progress…" : "Waiting"}</span>
                      </div>
                      <p className="step-who">{s.who}</p>
                    </div>
                  </li>
                );
              })}
            </ol>

            {!enoughBalance && phase !== "done" && (
              <div className="notice warn" role="status">
                <strong>Not enough {token.symbol}</strong>
                <span>
                  This tab needs {deposit} {token.symbol}. See the <Link href="/setup">Setup</Link> page for how to get test tokens.
                </span>
              </div>
            )}

            {relay.data && !relay.data.enabled && (
              <div className="notice warn" role="status">
                <strong>Gasless opening is off</strong>
                <span>Set RELAYER_PRIVATE_KEY in web/.env.local and restart the app.</span>
              </div>
            )}

            {error && (
              <div className="notice bad" role="alert">
                <strong>The tab didn&apos;t open</strong>
                <span>{error}</span>
              </div>
            )}

            {opened && (
              <div className="notice good" role="status">
                <strong>Tab {tabLabel(opened.id)} is open</strong>
                <span>
                  Transaction <TxLink hash={opened.hash} />
                </span>
                <span>Give your agent these lines (examples/.env). {opened.key ? "Copy the key now: it won't be shown again." : ""}</span>
                <pre className="code env-lines">{envLines}</pre>
                <CopyButton text={envLines} />
              </div>
            )}

            <button type="submit" className="btn big block" disabled={ctaDisabled}>
              {cta}
            </button>
            <p className="fine">The signature is valid for 10 minutes, for this exact deposit, merchant, session key and expiry.</p>
          </form>

          <section className="stack" aria-label="Your tabs" style={{ flex: "1.4 1 420px" }}>
            <div className="row-between">
              <h2>Your tabs</h2>
              {merchantHere && <span className="pill"><span className="dot" aria-hidden="true" />Live meter</span>}
            </div>
            {net.deployBlock === undefined && (
              <p className="fine">
                Only tabs from the last ~10,000 blocks are shown; set NEXT_PUBLIC_DEPLOY_BLOCK_{net.key.toUpperCase()} to see older ones.
              </p>
            )}
            {!address ? (
              <div className="card empty">Connect a wallet to see the tabs you opened.</div>
            ) : tabs.error ? (
              <div className="notice bad" role="alert">
                <strong>Couldn&apos;t read your tabs</strong>
                <span>{explain(tabs.error)}</span>
              </div>
            ) : !tabs.data ? (
              <div className="card" aria-live="polite">
                <div className="progress" role="progressbar" aria-label="Scanning blocks" aria-valuenow={tabs.progress} aria-valuemin={0} aria-valuemax={100}>
                  <span style={{ width: `${tabs.progress}%` }} />
                </div>
                <p className="fine" style={{ marginTop: 8 }}>Looking for your tabs, 1,000 blocks at a time… {tabs.progress}%</p>
              </div>
            ) : tabs.data.length === 0 ? (
              <div className="card empty">No tabs yet. Open one with the form.</div>
            ) : (
              tabs.data.map((l) => {
                const id = l.args.id!;
                return (
                  <OwnerTab
                    key={id}
                    id={id}
                    openedClosesAt={l.args.closesAt!}
                    signer={l.args.signer!}
                    openTx={l.transactionHash}
                    fromBlock={l.blockNumber}
                    channel={channels.get(id.toLowerCase())}
                    entry={meter.byId.get(id.toLowerCase())}
                    decimals={token.decimals}
                    symbol={token.symbol}
                  />
                );
              })
            )}
          </section>
        </div>
      )}
    </main>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn small secondary"
      onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true), () => setCopied(false))}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function OwnerTab(props: {
  id: Hex;
  openedClosesAt: bigint;
  signer: Address;
  openTx: Hash;
  fromBlock: bigint;
  channel?: Channel;
  entry?: MeterEntry;
  decimals: number;
  symbol: string;
}) {
  const { id, channel, entry } = props;
  const { net } = useNetwork();
  const config = useConfig();
  const { address } = useAccount();
  const [busy, setBusy] = useState<"revoke" | "reclaim" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<{ action: string; hash: Hash } | null>(null);
  const [history, setHistory] = useState(false);
  const status = channel ? tabStatus(channel, props.openedClosesAt) : undefined;

  async function run(action: "revoke" | "reclaim") {
    if (!address || !net.tabs) return;
    setBusy(action);
    setError(null);
    setTx(null);
    try {
      const { request } = await simulateContract(config, { account: address, address: net.tabs, abi: tabsAbi, functionName: action, args: [id], chainId: net.chain.id });
      const hash = await writeContract(config, request);
      setTx({ action: action === "revoke" ? "Revoke sent" : "Reclaim sent", hash });
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: net.chain.id });
      if (receipt.status !== "success") throw new Error("The transaction reverted on chain. Nothing changed.");
      setTx({ action: action === "revoke" ? "Revoked" : "Reclaimed", hash });
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="card stack tab-card" aria-label={`Tab ${tabLabel(id)}`}>
      <div className="row-between">
        <h3 className="mono">{tabLabel(id)}</h3>
        {channel && status ? <StatusPill status={status} closesAt={channel.closesAt} /> : <span className="fine">Reading…</span>}
      </div>

      {channel && <Meter channel={channel} entry={entry} decimals={props.decimals} symbol={props.symbol} />}

      <dl className="kv">
        <dt>Merchant</dt>
        <dd>{channel ? short(channel.payee) : "—"}</dd>
        <dt>Session key</dt>
        <dd>{short(props.signer)}</dd>
        <dt>{status === "closed" ? "Was set to end" : "Ends"}</dt>
        <dd>{clock(channel && channel.closesAt !== 0n ? channel.closesAt : props.openedClosesAt)}</dd>
        <dt>Opened in</dt>
        <dd>
          <TxLink hash={props.openTx} />
        </dd>
      </dl>

      {error && (
        <div className="notice bad" role="alert">
          <strong>That didn&apos;t go through</strong>
          <span>{error}</span>
        </div>
      )}
      {tx && (
        <div className="notice good" role="status">
          <span>
            {tx.action} · <TxLink hash={tx.hash} />
          </span>
        </div>
      )}

      <div className="actions">
        {status === "open" && (
          <button type="button" className="btn danger" disabled={Boolean(busy)} onClick={() => run("revoke")}>
            {busy === "revoke" ? "Revoking…" : "Revoke"}
          </button>
        )}
        {status === "ended" && (
          <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => run("reclaim")}>
            {busy === "reclaim" ? "Reclaiming…" : "Reclaim the rest"}
          </button>
        )}
        <button type="button" className="btn ghost small" aria-expanded={history} onClick={() => setHistory(!history)}>
          {history ? "Hide history" : "History"}
        </button>
      </div>
      {status === "open" && (
        <p className="fine">
          Revoke stops your agent&apos;s next call at once. The merchant gets 15 minutes to redeem what it already served, then you
          reclaim the rest. Both are wallet transactions and need a little tQDAY for gas.
        </p>
      )}
      {history && <TabTimeline id={id} fromBlock={props.fromBlock} />}
    </article>
  );
}
