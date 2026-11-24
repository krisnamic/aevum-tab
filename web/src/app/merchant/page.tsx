"use client";

import type { MeterEntry } from "@aevum-kit/aevum";
import { useEffect, useState } from "react";
import type { Hash, Hex } from "viem";
import { useConfig } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { TabTimeline } from "@/components/TabTimeline";
import { getJson, Meter, StatusPill, tabStatus, TxLink, useChannels, useMerchant, useMeter, useOpenedTabs, type Channel } from "@/components/useTabs";
import { useToken } from "@/components/useToken";
import { explain } from "@/lib/errors";
import { amount, short, tabLabel } from "@/lib/format";
import { useNetwork } from "@/lib/network";
import { networkByChainId } from "@/lib/env";

const TOKEN_KEY = "tab:admin-token";

export default function MerchantPage() {
  const { net } = useNetwork();
  const token = useToken();
  const merchant = useMerchant();
  const info = merchant.data;
  const here = info?.enabled && info.address && info.chainId === net.chain.id ? info : undefined;
  const [adminToken, setAdminToken] = useState("");

  useEffect(() => {
    try {
      setAdminToken(localStorage.getItem(TOKEN_KEY) ?? "");
    } catch {}
  }, []);

  const opened = useOpenedTabs(here ? { payee: here.address! } : undefined);
  const meter = useMeter(null, Boolean(here));
  const meterEntries = meter.data?.chainId === net.chain.id ? meter.data.tabs : [];
  const logs = new Map((opened.data ?? []).map((l) => [l.args.id!.toLowerCase(), l]));
  const ids = [...new Set([...(opened.data ?? []).map((l) => l.args.id!.toLowerCase()), ...meterEntries.map((e) => e.id.toLowerCase())])] as Hex[];
  const channels = useChannels(ids);

  let calls = 0;
  let unsettled = 0n;
  let settled = 0n;
  const now = Math.floor(Date.now() / 1000);
  for (const id of ids) {
    const c = channels.get(id);
    const e = meter.byId.get(id);
    calls += e?.calls ?? 0;
    settled += c?.claimed ?? 0n;
    if (c && e && c.closesAt !== 0n && now < Number(c.closesAt) && BigInt(e.cumulative) > c.claimed) unsettled += BigInt(e.cumulative) - c.claimed;
  }

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">Merchant · {net.label}</p>
          <h1>Paid calls, live</h1>
          <p className="lede">
            Every call your API served, the vouchers you hold off-chain, and what you have settled on-chain. Tabs settle on their own
            before they end; settle or close one yourself any time.
          </p>
        </div>
        {here && (
          <div className="score" aria-live="polite">
            <span className="score-num">{calls.toLocaleString("en-US")}</span>
            <span className="fine">
              calls · {amount(unsettled, token.decimals)} {token.symbol} to settle · {amount(settled, token.decimals)} settled
            </span>
          </div>
        )}
      </div>

      {merchant.error ? (
        <div className="notice bad" role="alert">
          <strong>Couldn&apos;t reach the merchant</strong>
          <span>{(merchant.error as Error).message}</span>
        </div>
      ) : !info ? (
        <div className="card empty">Loading the merchant…</div>
      ) : !info.enabled ? (
        <div className="notice warn" role="status">
          <strong>The merchant isn&apos;t set up</strong>
          <span>
            Set MERCHANT_PRIVATE_KEY (and TAB_PRICE if you like) in web/.env.local, deploy TabChannels, then restart the app.
          </span>
        </div>
      ) : !here ? (
        <div className="notice warn" role="status">
          <strong>The merchant runs on {networkByChainId(info.chainId)?.label ?? `chain ${info.chainId}`}</strong>
          <span>Switch networks in the header to see its tabs.</span>
        </div>
      ) : (
        <>
          <section className="card" aria-label="Merchant details">
            <dl className="kv">
              <dt>Merchant</dt>
              <dd>{here.address}</dd>
              <dt>Price</dt>
              <dd>
                {amount(BigInt(here.price), token.decimals)} {token.symbol} per call
              </dd>
              <dt>Endpoint</dt>
              <dd>GET /api/market?symbol=BTC</dd>
            </dl>
            {here.adminRequired && (
              <div className="field-group" style={{ marginTop: 16 }}>
                <label htmlFor="admin-token">Admin token (needed to settle or close)</label>
                <input
                  id="admin-token"
                  className="field"
                  type="password"
                  autoComplete="off"
                  value={adminToken}
                  onChange={(e) => {
                    setAdminToken(e.target.value);
                    try {
                      localStorage.setItem(TOKEN_KEY, e.target.value);
                    } catch {}
                  }}
                />
                <p className="fine">MERCHANT_ADMIN_TOKEN from web/.env.local. Saved in this browser only.</p>
              </div>
            )}
          </section>

          {meter.error && (
            <div className="notice bad" role="alert">
              <strong>The live meter isn&apos;t updating</strong>
              <span>{(meter.error as Error).message}</span>
            </div>
          )}

          <section className="tab-grid" aria-label="Tabs">
            {ids.length === 0 ? (
              <div className="card empty">
                {opened.data ? "No tabs yet. Open one on the Tabs page, then point an agent at /api/market." : `Looking for tabs… ${opened.progress}%`}
              </div>
            ) : (
              ids.map((id) => {
                const log = logs.get(id);
                return (
                  <MerchantTab
                    key={id}
                    id={log?.args.id ?? id}
                    channel={channels.get(id)}
                    entry={meter.byId.get(id)}
                    openedClosesAt={log?.args.closesAt}
                    fromBlock={log?.blockNumber}
                    adminToken={adminToken}
                    decimals={token.decimals}
                    symbol={token.symbol}
                    onDone={() => meter.refetch()}
                  />
                );
              })
            )}
          </section>
        </>
      )}
    </main>
  );
}

function MerchantTab(props: {
  id: Hex;
  channel?: Channel;
  entry?: MeterEntry;
  openedClosesAt?: bigint;
  fromBlock?: bigint;
  adminToken: string;
  decimals: number;
  symbol: string;
  onDone: () => void;
}) {
  const { id, channel, entry } = props;
  const { net } = useNetwork();
  const config = useConfig();
  const [busy, setBusy] = useState<"settle" | "close" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ label: string; hash: Hash } | null>(null);
  const [history, setHistory] = useState(false);
  const status = channel ? tabStatus(channel, props.openedClosesAt) : undefined;
  const live = status === "open" || status === "revoked";
  const unredeemed = channel && entry && BigInt(entry.cumulative) > channel.claimed ? BigInt(entry.cumulative) - channel.claimed : 0n;
  const owed = live ? unredeemed : 0n;

  async function act(action: "settle" | "close") {
    setBusy(action);
    setError(null);
    setSent(null);
    try {
      const { hash } = await getJson<{ hash: Hash }>("/api/merchant/tabs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-token": props.adminToken },
        body: JSON.stringify({ id, action }),
      });
      setSent({ label: action === "settle" ? "Settle sent" : "Close sent", hash });
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: net.chain.id });
      if (receipt.status !== "success") throw new Error("The transaction reverted on chain. Nothing changed.");
      setSent({ label: action === "settle" ? "Settled" : "Closed", hash });
      props.onDone();
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
        <dt>{status && !live ? "Expired, not redeemable" : "Not settled yet"}</dt>
        <dd>
          {amount(status && !live ? unredeemed : owed, props.decimals)} {props.symbol}
        </dd>
        <dt>Payer</dt>
        <dd>{channel ? short(channel.payer) : "—"}</dd>
        {entry?.settleTx && (
          <>
            <dt>Last settle</dt>
            <dd>
              <TxLink hash={entry.settleTx} />
            </dd>
          </>
        )}
        {entry?.closeTx && (
          <>
            <dt>Close</dt>
            <dd>
              <TxLink hash={entry.closeTx} />
            </dd>
          </>
        )}
      </dl>

      {error && (
        <div className="notice bad" role="alert">
          <strong>That didn&apos;t go through</strong>
          <span>{error}</span>
        </div>
      )}
      {sent && (
        <div className="notice good" role="status">
          <span>
            {sent.label} · <TxLink hash={sent.hash} />
          </span>
        </div>
      )}

      <div className="actions">
        {(status === "open" || status === "revoked") && (
          <button type="button" className="btn" disabled={Boolean(busy) || owed === 0n} onClick={() => act("settle")}>
            {busy === "settle" ? "Settling…" : `Settle ${amount(owed, props.decimals)}`}
          </button>
        )}
        {status && status !== "closed" && (
          <button type="button" className="btn secondary" disabled={Boolean(busy)} onClick={() => act("close")}>
            {busy === "close" ? "Closing…" : "Close & refund the rest"}
          </button>
        )}
        <button type="button" className="btn ghost small" aria-expanded={history} onClick={() => setHistory(!history)}>
          {history ? "Hide history" : "History"}
        </button>
      </div>
      {history && <TabTimeline id={id} fromBlock={props.fromBlock} />}
    </article>
  );
}
