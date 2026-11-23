import type { FaultKind } from "@/server/portal/faults";

/** Korta namn på rutorna (hela namnet, FAULT_LABEL, står i listan över anmälningar). */
export const FAULT_SHORT: Record<FaultKind, string> = {
  store_payment: "Betalningen",
  store_stuck: "Pack fastnade",
  store_empty: "Tomt",
  store_screen: "Skärm eller ström",
  store_damage: "Skadad",
  store_other: "Annat",
};

const PATHS: Record<FaultKind, string> = {
  // Kort med magnetremsa
  store_payment: "M3 6.5h18v11H3zM3 10h18M6.5 14.5h4",
  // Lucka med ett pack som sitter fast
  store_stuck: "M5 3.5h14v17H5zM5 14h14M9.5 14V6.5h5V14M11 9h2",
  // Streckad tom ruta
  store_empty:
    "M6 4h2.5M11 4h2M15.5 4H18v2.5M20 9.5v2M20 14v2.5M18 20h-2.5M13 20h-2M8.5 20H6v-2.5M4 14.5v-2M4 9.5V7",
  // Ström
  store_screen: "M12 3v8M7.2 6.3a7 7 0 1 0 9.6 0",
  // Spricka i glaset
  store_damage: "M4 4h16v16H4zM10 4l2.5 5.5-3 3.5 3 3-1.5 4M12.5 9.5L20 8M9.5 13L4 14",
  // Pratbubbla
  store_other: "M4 5.5h16v10H10l-4 3.5v-3.5H4zM8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01",
};

export function FaultIcon({ kind, size = 24 }: { kind: FaultKind; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden focusable="false">
      <path
        d={PATHS[kind]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
