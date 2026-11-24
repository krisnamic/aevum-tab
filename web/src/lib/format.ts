import { formatUnits, type Hex } from "viem";

/** Short, human-friendly label for a bytes32 tab id. */
export function tabLabel(id: Hex): string {
  return `#${id.slice(2, 6).toUpperCase()}-${id.slice(-4).toUpperCase()}`;
}

export function short(value: string, head = 6, tail = 4): string {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

/** Token amount with at least two decimals: 1000000n -> "1.00", 312000n -> "0.312". */
export function amount(value: bigint, decimals = 6): string {
  const [whole, frac = ""] = formatUnits(value, decimals).split(".");
  return `${whole}.${frac.padEnd(2, "0")}`;
}

export function clock(seconds: number | bigint): string {
  return new Date(Number(seconds) * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
