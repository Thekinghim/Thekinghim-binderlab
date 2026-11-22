import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

import { Skeleton, SkeletonCard } from "./skeleton";

/**
 * Sidans första rad på en gammal sida som behåller skalets huvud (sidnamnet, periodvalet,
 * Eget intervall och filtren Butik/Automat står redan där): läget i en mening som h1, 16 px
 * halvfet, med en grå fortsättning, nyckelfakta (Period, Filter …) som en grå rad och
 * knappar till höger. Ingen affischrubrik och ingen etikett ovanför ("eyebrow").
 *
 *   <PageIntro title="Vår vinst 16 358 kr på 29 dagar." aside="I den här takten: ca 17 000 kr."
 *     facts={[{ label: "Period", value: "24 okt. – 22 nov." }]} actions={<ButtonLink …/>} />
 *
 * Sidor utan skalets kontextrad kan i stället använda V2Page (rubrik + `sub`).
 */
export function PageIntro({
  title,
  aside,
  facts,
  actions,
  warning = false,
  id,
  as: Tag = "h1",
  className,
  children,
}: {
  title: ReactNode;
  /** Fortsättningen på meningen (grå). */
  aside?: ReactNode;
  /** Etikett och värde i en grå rad under rubriken. */
  facts?: ReadonlyArray<{ label: string; value: ReactNode }>;
  /** Knappar till höger (under på telefon). */
  actions?: ReactNode;
  /** Fortsättningen i varningsfärg (t.ex. en produkt ger mer än halva vinsten). */
  warning?: boolean;
  id?: string;
  /** h1 (standard) eller h2 när sidan redan har en h1. */
  as?: "h1" | "h2";
  className?: string;
  /** Mer under rubriken (t.ex. en notis). */
  children?: ReactNode;
}) {
  return (
    <header className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-0.5">
          <Tag
            id={id}
            className="text-v2-lg font-[550] text-balance [overflow-wrap:anywhere] text-v2-ink"
          >
            {title}
          </Tag>
          {aside ? (
            <p className={cn("text-v2-md text-v2-mute", warning && "font-[550] text-v2-warn-text")}>
              {aside}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {facts && facts.length > 0 ? (
        <dl className="tnum flex flex-wrap gap-x-4 gap-y-1 text-v2-sm text-v2-mute">
          {facts.map((f) => (
            <div key={f.label} className="flex gap-1.5">
              <dt>{f.label}</dt>
              <dd className="text-v2-ink">{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {children}
    </header>
  );
}

/**
 * Sidkroppen för en gammal sida i skalet: samma luft som V2Page (22 px, 12 px på telefon),
 * 14 px mellan korten (12 px på telefon), högst 1280 px bred.
 */
export const PAGE_BODY =
  "mx-auto flex w-full max-w-[1280px] min-w-0 flex-col gap-[14px] px-[22px] pt-3 pb-8 max-[900px]:gap-3 max-[900px]:px-3 max-[900px]:pt-2";

/**
 * loading.tsx för en gammal sida i skalet: rubrikraden och korten (huvudspalt och, med
 * `side`, högerspalt), utan att något hoppar när sidan kommer.
 */
export function PageSkeleton({
  label,
  main = [5, 8],
  side,
}: {
  /** "Laddar lönsamhet". */
  label: string;
  /** Rader per kort i huvudspalten. */
  main?: readonly number[];
  /** Rader per kort i högerspalten (utelämnat: en spalt). */
  side?: readonly number[];
}) {
  const cards = (rows: readonly number[]) => rows.map((r, i) => <SkeletonCard key={i} rows={r} />);
  return (
    <div aria-busy="true" aria-label={label} className={PAGE_BODY}>
      <div className="flex flex-col gap-2">
        <Skeleton width="min(100%, 420px)" height={18} />
        <Skeleton width="min(80%, 300px)" />
      </div>
      {side ? (
        <div className="v2-cols">
          <div className="v2-stack">{cards(main)}</div>
          <div className="v2-stack">{cards(side)}</div>
        </div>
      ) : (
        <div className="v2-stack">{cards(main)}</div>
      )}
    </div>
  );
}
