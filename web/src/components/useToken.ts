"use client";

import { erc20Abi, tabsAbi, TUSD8_ADDRESS } from "@aevum-kit/aevum";
import type { Address } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { useNetwork } from "@/lib/network";

/**
 * The payment token. Read from TabChannels.token() when TabChannels is configured (works for the
 * local MockUSD8 too); otherwise tUSD8 on Aevum.
 */
export function useToken() {
  const { net } = useNetwork();
  const appChain = net.chain;
  const tabsAddress = net.tabs;
  const fromTabs = useReadContract({
    address: tabsAddress,
    abi: tabsAbi,
    functionName: "token",
    chainId: appChain.id,
    query: { enabled: Boolean(tabsAddress) },
  });
  const address: Address | undefined = fromTabs.data ?? (net.key === "local" ? undefined : TUSD8_ADDRESS);
  const meta = useReadContracts({
    contracts: address
      ? [
          { address, abi: erc20Abi, functionName: "decimals", chainId: appChain.id },
          { address, abi: erc20Abi, functionName: "symbol", chainId: appChain.id },
        ]
      : [],
    query: { enabled: Boolean(address) },

  });
  const decimals = (meta.data?.[0]?.result as number | undefined) ?? 6;
  const symbol = (meta.data?.[1]?.result as string | undefined) ?? "tUSD8";
  return { address, decimals, symbol, isLoading: fromTabs.isLoading || meta.isLoading };
}
