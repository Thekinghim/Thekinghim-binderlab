import type { V2NavIcon } from "@/components/shell/nav";

/** Prototypens ikoner för menyn (20 px, streck 1,7). Dekor: texten står alltid bredvid. */
const PATHS: Record<V2NavIcon, string> = {
  hem: "M3 10.5 12 3l9 7.5V20H15v-6H9v6H3z",
  automater: "M6 2h12v20H6zM9 6h6M9 10h6M9 14h3",
  rutt: "M6 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 17V10a4 4 0 0 1 4-4h6M18 7v7a4 4 0 0 1-4 4H8",
  "vart-lager": "M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8",
  butiker: "M3 9l1.5-5h15L21 9M4 9v11h16V9M3 9h18",
  pengar: "M3 17l6-6 4 4 8-8M15 7h6v6",
  mer: "M5 12h.01M12 12h.01M19 12h.01",
  meny: "M4 7h16M4 12h16M4 17h16",
};

export function NavIcon({ name, size = 20 }: { name: V2NavIcon; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "mer" ? 2.6 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Binderlabs logga (vår egen blå, står kvar i V2). */
export function V2Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <rect width="100" height="100" rx="20" fill="#06080E" />
      <g transform="rotate(10 55 50)">
        <rect
          x="30"
          y="14"
          width="46"
          height="70"
          rx="6"
          fill="none"
          stroke="#0A95FF"
          strokeWidth="5"
        />
      </g>
      <path
        d="M22 22h34c14 0 22 7 22 17 0 6-3 10-8 13 7 2 11 8 11 15 0 11-9 19-24 19H22l6-10V33z"
        fill="#fff"
      />
      <path
        d="M50 86h7c15 0 24-8 24-19 0-7-4-13-11-15l-12 8c4 1 6 3 6 6 0 4-3 7-8 7h-2z"
        fill="#0A95FF"
      />
      <path
        d="M40 33h12c5 0 8 3 8 7s-3 7-8 7H40zM40 58h14c4 0 6 2 6 5s-2 5-6 5H40z"
        fill="#06080E"
      />
    </svg>
  );
}
