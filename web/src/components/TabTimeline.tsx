"use client";

import { getLogsChunked, tabsAbi } from "@aevum-kit/aevum";
import { useQuery } from "@tanstack/react-query";
import { getAbiItem, type Hash, type Hex, type PublicClient } from "viem";
import { usePublicClient } from "wagmi";
import { useNetwork } from "@/lib/network";
import { amount, clock } from "@/lib/format";
import { TxLink } from "./useTabs";
import { useToken } from "./useToken";

interface Row {
  key: string;
  block: bigint;
  index: number;
  title: string;
  detail: string;
  hash: Hash;
}

/** Every on-chain event for one tab, oldest first. */
export function TabTimeline({ id, fromBlock }: { id: Hex; fromBlock?: bigint }) {
  const { net } = useNetwork();
  const client = usePublicClient({ chainId: net.chain.id }) as PublicClient | undefined;
  const token = useToken();
  const money = (v: bigint | undefined) => `${amount(v ?? 0n, token.decimals)} ${token.symbol}`;

  const rows = useQuery({
    queryKey: ["timeline", net.chain.id, id, fromBlock?.toString()],
    enabled: Boolean(client && net.tabs),
    refetchInterval: 15_000,
    queryFn: async () => {
      const head = await client!.getBlockNumber();
      const from = fromBlock ?? net.deployBlock ?? (head > 10_000n ? head - 10_000n : 0n);
      const range = { address: net.tabs!, args: { id }, fromBlock: from, toBlock: head };
      const [opened, settled, revoked, closed] = await Promise.all([
        getLogsChunked(client!, { ...range, event: getAbiItem({ abi: tabsAbi, name: "Opened" }) }),
        getLogsChunked(client!, { ...range, event: getAbiItem({ abi: tabsAbi, name: "Settled" }) }),
        getLogsChunked(client!, { ...range, event: getAbiItem({ abi: tabsAbi, name: "Revoked" }) }),
        getLogsChunked(client!, { ...range, event: getAbiItem({ abi: tabsAbi, name: "Closed" }) }),
      ]);
      const base = (l: { blockNumber: bigint; logIndex: number; transactionHash: Hash }) => ({
        key: `${l.transactionHash}-${l.logIndex}`,
        block: l.blockNumber,
        index: l.logIndex,
        hash: l.transactionHash,
      });
      const out: Row[] = [
        ...opened.map((l) => ({ ...base(l), title: "Opened", detail: `${money(l.args.deposit)} locked until ${clock(l.args.closesAt ?? 0n)}` })),
        ...settled.map((l) => ({ ...base(l), title: "Settled", detail: `Merchant paid ${money(l.args.paid)} (${money(l.args.cumulative)} in total)` })),
        ...revoked.map((l) => ({ ...base(l), title: "Revoked", detail: `Owner pulled the plug. The tab ends at ${clock(l.args.closesAt ?? 0n)}` })),
        ...closed.map((l) => ({ ...base(l), title: "Closed", detail: `${money(l.args.refunded)} refunded to the owner` })),
      ];
      return out.sort((a, b) => (a.block === b.block ? a.index - b.index : a.block < b.block ? -1 : 1));
    },
  });

  if (rows.error) return <p className="fine">Couldn&apos;t read this tab&apos;s history: {(rows.error as Error).message}</p>;
  if (!rows.data) return <p className="fine">Reading this tab&apos;s history, 1,000 blocks at a time…</p>;
  if (!rows.data.length) return <p className="fine">No on-chain events found for this tab yet.</p>;
  return (
    <ol className="timeline">
      {rows.data.map((r) => (
        <li key={r.key}>
          <div className="step-top">
            <span className="step-title">{r.title}</span>
            <span className="fine">block {r.block.toLocaleString("en-US")}</span>
          </div>
          <p className="step-who">{r.detail}</p>
          <TxLink hash={r.hash} />
        </li>
      ))}
    </ol>
  );
}
