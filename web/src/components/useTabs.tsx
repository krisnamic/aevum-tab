"use client";

import { getLogsChunked, tabsAbi, txUrl, type MerchantInfo, type MeterEntry } from "@aevum-kit/aevum";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { getAbiItem, type Address, type GetLogsReturnType, type Hash, type Hex, type PublicClient } from "viem";
import { usePublicClient, useReadContracts } from "wagmi";
import { useNetwork } from "@/lib/network";
import { amount, clock, short } from "@/lib/format";

export type TabStatus = "open" | "revoked" | "ended" | "closed";

export interface Channel {
  payer: Address;
  closesAt: bigint;
  payee: Address;
  signer: Address;
  deposit: bigint;
  claimed: bigint;
}

export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !body) throw new Error(body?.error ?? `The app server didn't answer (HTTP ${res.status}). Is it running?`);
  return body;
}

/** `openedClosesAt` is the expiry the owner chose; a smaller on-chain closesAt means it was revoked. */
export function tabStatus(c: Channel, openedClosesAt: bigint | undefined, now = Math.floor(Date.now() / 1000)): TabStatus {
  if (c.closesAt === 0n) return "closed";
  if (now >= Number(c.closesAt)) return "ended";
  if (openedClosesAt !== undefined && c.closesAt < openedClosesAt) return "revoked";
  return "open";
}

export function useMerchant() {
  return useQuery({ queryKey: ["merchant"], queryFn: () => getJson<MerchantInfo>("/api/merchant"), staleTime: 60_000 });
}

/** The merchant's off-chain meter. `ids` null = every tab it has seen. */
export function useMeter(ids: Hex[] | null, enabled: boolean) {
  const query = useQuery({
    queryKey: ["meter", ids?.join(",") ?? "all"],
    queryFn: () => getJson<{ chainId: number; tabs: MeterEntry[] }>(`/api/merchant/tabs${ids ? `?ids=${ids.join(",")}` : ""}`),
    enabled: enabled && (ids === null || ids.length > 0),
    refetchInterval: 2_000,
    refetchIntervalInBackground: false,
  });
  const byId = new Map((query.data?.tabs ?? []).map((t) => [t.id.toLowerCase(), t]));
  return { ...query, byId };
}

/** Opened events matching `filter`, newest first. Scans once from the deploy block, then only new blocks every 15s. */
export function useOpenedTabs(filter: { payer: Address } | { payee: Address } | undefined) {
  const { net } = useNetwork();
  const client = usePublicClient({ chainId: net.chain.id }) as PublicClient | undefined;
  const [progress, setProgress] = useState(0);
  const key = `${net.chain.id}:${net.tabs}:${JSON.stringify(filter)}`;
  const event = getAbiItem({ abi: tabsAbi, name: "Opened" });
  const scanned = useRef<{ key: string; head: bigint; logs: GetLogsReturnType<typeof event> } | null>(null);

  const query = useQuery({
    queryKey: ["opened", key],
    enabled: Boolean(client && net.tabs && filter),
    refetchInterval: 15_000,
    queryFn: async () => {
      const head = await client!.getBlockNumber();
      const prev = scanned.current?.key === key ? scanned.current : null;
      const from = prev ? prev.head + 1n : (net.deployBlock ?? (head > 10_000n ? head - 10_000n : 0n));
      const fresh =
        from > head
          ? []
          : await getLogsChunked(client!, {
              address: net.tabs!,
              event,
              args: filter,
              fromBlock: from,
              toBlock: head,
              onProgress: prev ? undefined : (done, total) => setProgress(total ? Number((done * 100n) / total) : 100),
            });
      const logs = [...fresh].reverse().concat(prev?.logs ?? []);
      scanned.current = { key, head, logs };
      return logs;
    },
  });
  return { ...query, progress };
}

export function useChannels(ids: Hex[]) {
  const { net } = useNetwork();
  const reads = useReadContracts({
    contracts: ids.map((id) => ({ address: net.tabs!, abi: tabsAbi, functionName: "channelOf" as const, args: [id] as const, chainId: net.chain.id })),
    query: { enabled: Boolean(net.tabs) && ids.length > 0, refetchInterval: 5_000 },
  });
  return new Map(ids.map((id, i) => [id.toLowerCase(), reads.data?.[i]?.result as Channel | undefined]));
}

export function TxLink({ hash }: { hash: Hash }) {
  const { net } = useNetwork();
  const text = short(hash, 10, 8);
  return net.hasExplorer ? (
    <a className="mono" href={txUrl(hash)} target="_blank" rel="noreferrer" title={hash}>
      {text}
      <span className="sr-only"> (opens the explorer)</span>
    </a>
  ) : (
    <span className="mono" title={hash}>
      {text}
    </span>
  );
}

export function StatusPill({ status, closesAt }: { status: TabStatus; closesAt: bigint }) {
  const label = {
    open: "Open",
    revoked: `Revoked · merchant can redeem until ${clock(closesAt)}`,
    ended: "Ended · reclaim the rest",
    closed: "Closed",
  }[status];
  return <span className={`status-pill ${status}`}>{label}</span>;
}

/** The live meter: what the agent has used (signed off-chain) against what has settled on-chain and the deposit. */
export function Meter({ channel, entry, decimals, symbol }: { channel: Channel; entry?: MeterEntry; decimals: number; symbol: string }) {
  const signed = entry ? BigInt(entry.cumulative) : 0n;
  const used = signed > channel.claimed ? signed : channel.claimed;
  const pct = (v: bigint) => (channel.deposit ? Number((v * 10_000n) / channel.deposit) / 100 : 0);
  return (
    <div className="meter">
      <dl className="meter-stats">
        <div>
          <dt>Calls served</dt>
          <dd>{entry ? entry.calls.toLocaleString("en-US") : "—"}</dd>
        </div>
        <div>
          <dt>Used (signed off-chain)</dt>
          <dd>{amount(used, decimals)}</dd>
        </div>
        <div>
          <dt>Settled on-chain</dt>
          <dd className="good">{amount(channel.claimed, decimals)}</dd>
        </div>
        <div>
          <dt>Deposit ({symbol})</dt>
          <dd>{amount(channel.deposit, decimals)}</dd>
        </div>
      </dl>
      <div className="meter-bar" aria-hidden="true">
        <span className="settled" style={{ width: `${pct(channel.claimed)}%` }} />
        <span className="owed" style={{ width: `${pct(used - channel.claimed)}%` }} />
      </div>
      <p className="fine">
        {entry ? `${entry.calls.toLocaleString("en-US")} calls · ` : ""}
        {amount(used, decimals)} of {amount(channel.deposit, decimals)} {symbol} used · {amount(channel.claimed, decimals)} settled on-chain
        {entry ? "" : " · no live meter from the merchant"}
      </p>
    </div>
  );
}
