export type PcSystemKey = "core" | "pro" | "ultra";

export type PcSystem = {
  key: PcSystemKey;
  name: string;
  price: string;
  href: string;
  lede: string;
  specs: string[];
};

export const PC_SYSTEMS: Record<PcSystemKey, PcSystem> = {
  core: {
    key: "core",
    name: "Xyrra Core System 32GB",
    price: "$1,299.00",
    href: "/xyrra-pc/core-system-32gb/",
    lede: "The entry point for local AI — fast, efficient, and built for everyday models on your desk.",
    specs: [
      "Intel Raptor Lake i5-13500H up to 4.7GHz · 12 cores, 16 threads",
      "Intel® Iris® Xe Graphics eligible up to 1.45 GHz",
      "32GB 2×LPDDR4 3200MHz",
      "1TB storage",
    ],
  },
  pro: {
    key: "pro",
    name: "Xyrra Pro System 64GB",
    price: "$2,359.00",
    href: "/xyrra-pc/pro-system-64gb/",
    lede: "More memory and AI acceleration for heavier local workloads and multi-model setups.",
    specs: [
      "AMD Ryzen™ AI 7 H 350",
      "AMD Radeon™ 780M/860M",
      "64GB (32GB×2) DDR5 5600MHz",
      "1TB SSD",
    ],
  },
  ultra: {
    key: "ultra",
    name: "Xyrra Ultra System 128GB",
    price: "$5,149.00",
    href: "/xyrra-pc/ultra-system-128gb/",
    lede: "Maximum on-device capacity for the largest models, deepest context, and serious local AI.",
    specs: [
      "AMD Ryzen™ AI Max+ 395 · 5.1 GHz (16C/32T)",
      "AMD Radeon 8060S Graphics 40CUs",
      "LPDDR5X 8000MT/s 128GB",
      "2TB SSD",
    ],
  },
};

export function isPcSystemKey(value: string | null | undefined): value is PcSystemKey {
  return value === "core" || value === "pro" || value === "ultra";
}

export function pcSystemFromKey(value: string | null | undefined): PcSystem | null {
  const key = (value ?? "").trim().toLowerCase();
  return isPcSystemKey(key) ? PC_SYSTEMS[key] : null;
}

export function pcSystemFromSearch(
  search: URLSearchParams = new URLSearchParams(window.location.search),
): PcSystem | null {
  return pcSystemFromKey(search.get("system"));
}
