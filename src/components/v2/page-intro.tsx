import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

import { V2PageSkeleton } from "./skeleton";

/**
 * Sidans sammanfattning direkt under V2-sidhuvudet (V2Page har rubriken som h1): läget i en
 * mening som h2, 14 px halvfet, med en grå fortsättning på samma rad, nyckelfakta (Period,
 * Filter …) som en grå rad och knappar till höger. Samma ton som sidhuvudets rad under rubriken
 * på Hem och Pengar: ingen affischrubrik och ingen etikett ovanför ("eyebrow").
 *
 *   <V2Page title="Lönsamhet" date={…} period filters>
 *     <SubNav />
 *     <div className={PAGE_BODY}>
 *       <PageIntro title="Vår vinst 16 358 kr på 29 dagar." aside="I den här takten: ca 17 000 kr."
 *         facts={[{ label: "Period", value: "24 okt. – 22 nov." }]} actions={<ButtonLink …/>} />
 */
export function PageIntro({
  title,
  aside,
  facts,
  actions,
  warning = false,
  id,
  as: Tag = "h2",
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
  /** h2 (standard, under V2Page:s h1) eller h1 på en sida utan V2Page. */
  as?: "h1" | "h2";
  className?: string;
  /** Mer under rubriken (t.ex. en notis). */
  children?: ReactNode;
}) {
  return (
    <header className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-0.5">
          <Tag
            id={id}
            className="text-v2-md leading-5 font-[550] text-pretty [overflow-wrap:anywhere] text-v2-ink"
          >
            {title}
            {aside ? (
              <>
                {" "}
                <span
                  className={cn(
                    "font-normal text-v2-mute",
                    warning && "font-[550] text-v2-warn-text",
                  )}
                >
                  {aside}
                </span>
              </>
            ) : null}
          </Tag>
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
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}

/**
 * Sidkroppen i V2Page (som står för luften runt sidan): kort under varandra med 14 px
 * mellanrum (12 px på telefon).
 */
export const PAGE_BODY = "flex w-full min-w-0 flex-col gap-[14px] max-[900px]:gap-3";

/**
 * loading.tsx för en sida i V2Page: sidhuvudet, sammanfattningen och korten (huvudspalt och,
 * med `side`, högerspalt), utan att något hoppar när sidan kommer.
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
  return <V2PageSkeleton label={label} sub main={main} side={side} />;
}
