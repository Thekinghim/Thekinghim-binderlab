import type { ReactNode } from "react";

import type { BriefArt } from "@/analytics/brief";

/**
 * Bilderna i Dagens brief: enkla linjeteckningar (en per sorts kort), i V2:s bläck med en
 * mjuk tonfärg bakom (--brief-soft) och en accent (--brief-accent). Ritade för hand, inga
 * figurer eller varumärken.
 */

const S = {
  stroke: "var(--v2-ink)",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function Frame({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 160 112" width="160" height="112" aria-hidden="true" focusable="false">
      <ellipse cx="80" cy="98" rx="54" ry="6" fill="var(--brief-soft)" />
      {/* Ingen fyllning som standard: bara former med egen fill fylls. */}
      <g fill="none">{children}</g>
    </svg>
  );
}

/** Automat med ett pack på väg in. */
function Refill() {
  return (
    <Frame>
      <rect x="48" y="14" width="52" height="82" rx="6" fill="var(--v2-panel)" {...S} />
      <rect x="55" y="22" width="30" height="46" rx="3" fill="var(--brief-soft)" {...S} />
      <path d="M55 38h30M55 53h30" {...S} />
      <rect x="89" y="24" width="5" height="12" rx="2" {...S} />
      <rect x="58" y="76" width="24" height="10" rx="2" {...S} />
      <g transform="rotate(-12 122 44)">
        <rect x="110" y="26" width="24" height="34" rx="3" fill="var(--brief-accent)" {...S} />
        <path d="M110 34h24" {...S} />
      </g>
      <path d="M118 68c-6 6-14 8-22 6" {...S} strokeDasharray="3 5" />
    </Frame>
  );
}

/** Liten bil på en väg med en kartnål. */
function Route() {
  return (
    <Frame>
      <path d="M14 92c22-10 38-6 58-14s38-22 74-18" {...S} strokeDasharray="2 6" />
      <path
        d="M118 18c-9 0-15 6.5-15 14.5 0 10.5 15 23.5 15 23.5s15-13 15-23.5C133 24.5 127 18 118 18z"
        fill="var(--brief-soft)"
        {...S}
      />
      <circle cx="118" cy="32" r="5" fill="var(--brief-accent)" {...S} />
      <path d="M26 82V58h40v24M66 64h16l10 10v8H66" fill="var(--v2-panel)" {...S} />
      <path d="M70 66h10l6 6H70z" fill="var(--brief-soft)" {...S} />
      <circle cx="38" cy="84" r="7" fill="var(--v2-panel)" {...S} />
      <circle cx="80" cy="84" r="7" fill="var(--v2-panel)" {...S} />
      <path d="M32 66h14" {...S} />
    </Frame>
  );
}

/** Sedel och mynt. */
function Money() {
  return (
    <Frame>
      <rect x="26" y="28" width="82" height="48" rx="6" fill="var(--v2-panel)" {...S} />
      <rect x="34" y="20" width="82" height="48" rx="6" fill="var(--brief-soft)" {...S} />
      <circle cx="75" cy="44" r="11" fill="var(--v2-panel)" {...S} />
      <path
        d="M75 38v12M71.5 41.5c0-1.5 1.5-2.5 3.5-2.5s3.5 1 3.5 2.5-1.5 2-3.5 2.5-3.5 1-3.5 2.5 1.5 2.5 3.5 2.5 3.5-1 3.5-2.5"
        {...S}
        strokeWidth={1.6}
      />
      <path d="M42 30v4M108 54v4" {...S} />
      <ellipse cx="122" cy="86" rx="14" ry="5" fill="var(--brief-accent)" {...S} />
      <path d="M108 86v-8M136 86v-8" {...S} />
      <ellipse cx="122" cy="78" rx="14" ry="5" fill="var(--brief-accent)" {...S} />
    </Frame>
  );
}

/** Prislapp med snöre. */
function Price() {
  return (
    <Frame>
      <path d="M44 22c-6-6-16-4-18 4s4 14 12 12" {...S} />
      <path
        d="M50 30l40-6 36 36a6 6 0 0 1 0 8.5L96 98a6 6 0 0 1-8.5 0L51.5 62z"
        fill="var(--brief-soft)"
        {...S}
      />
      <circle cx="64" cy="40" r="5" fill="var(--v2-panel)" {...S} />
      <path d="M78 64l18-18M84 72l14-14" {...S} />
      <circle cx="122" cy="26" r="9" fill="var(--brief-accent)" {...S} />
      <path d="M122 21v6M122 31v.01" {...S} />
    </Frame>
  );
}

/** Automat med en varningstriangel. */
function Alert() {
  return (
    <Frame>
      <rect x="34" y="16" width="52" height="80" rx="6" fill="var(--v2-panel)" {...S} />
      <rect x="41" y="24" width="30" height="44" rx="3" fill="var(--v2-bg)" {...S} />
      <path d="M46 36l20 20M66 36 46 56" {...S} strokeWidth={1.6} />
      <rect x="44" y="76" width="24" height="10" rx="2" {...S} />
      <path d="M112 34l26 46H86z" fill="var(--brief-soft)" {...S} />
      <path d="M112 50v14M112 71v.01" {...S} strokeWidth={2.4} stroke="var(--brief-accent)" />
    </Frame>
  );
}

/** Staplar med en kurva uppåt. */
function Chart() {
  return (
    <Frame>
      <path d="M28 90h104" {...S} />
      <rect x="38" y="62" width="16" height="28" rx="3" fill="var(--v2-panel)" {...S} />
      <rect x="62" y="50" width="16" height="40" rx="3" fill="var(--v2-panel)" {...S} />
      <rect x="86" y="56" width="16" height="34" rx="3" fill="var(--v2-panel)" {...S} />
      <rect x="110" y="34" width="16" height="56" rx="3" fill="var(--brief-soft)" {...S} />
      <path d="M36 46c14-4 22-14 34-14s20 10 32 6 14-16 24-20" {...S} />
      <circle cx="126" cy="18" r="5" fill="var(--brief-accent)" {...S} />
    </Frame>
  );
}

/** Bock i en cirkel med små gnistor. */
function Done() {
  return (
    <Frame>
      <circle cx="80" cy="52" r="32" fill="var(--brief-soft)" {...S} />
      <path d="M66 52l10 10 20-22" {...S} strokeWidth={3} stroke="var(--brief-accent)" />
      <path d="M30 30l4 4M34 30l-4 4M128 70l4 4M132 70l-4 4" {...S} />
      <circle cx="126" cy="26" r="3" {...S} />
      <circle cx="36" cy="78" r="2.5" {...S} />
    </Frame>
  );
}

const ART: Record<BriefArt, () => ReactNode> = {
  refill: Refill,
  route: Route,
  money: Money,
  price: Price,
  alert: Alert,
  chart: Chart,
  done: Done,
};

export function BriefArtwork({ art }: { art: BriefArt }) {
  const Art = ART[art];
  return <Art />;
}
