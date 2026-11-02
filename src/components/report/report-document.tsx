"use client";

import {
  Children,
  Fragment,
  createContext,
  isValidElement,
  use,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Wordmark } from "@/components/brand/wordmark";
import { DEFAULT_TIME_ZONE, wallClockIn } from "@/components/shell/period-state";
import { cn } from "@/lib/cn";
import { formatDate, formatInt, formatPeriod, formatTime } from "@/lib/format";
import type { Period } from "@/lib/period";

/**
 * Sidsystem för rapporter. Varje ReportPage är ett A4-ark (210 × 297 mm)
 * med sidhuvud och sidfot som komponenten ritar själv, så att utskrift
 * och PDF blir identiska i alla webbläsare.
 *
 *   <ReportDocument title=… recipient=… period=… generatedAt=…>
 *     <ReportPage>…</ReportPage>
 *     <ReportPage>…</ReportPage>
 *   </ReportDocument>
 *
 * Varje barn till ReportDocument räknas som en sida (arrayer och fragment
 * plattas ut). Ett barn kan vara en egen komponent som renderar en
 * ReportPage; numreringen följer barnets plats. Det som inte får plats
 * på ett ark klipps i utskrift och flaggas på skärmen.
 */

export type ReportMeta = {
  /** "Månadsrapport oktober 2026" */
  title: string;
  /** "Westfield Arninge, Centrumledningen". Står i sidhuvud och konfidentialitetsrad. */
  recipient: string;
  /**
   * Avsändaren, operatören som rapporten kommer från ("Nordljus Automater AB"). Står först
   * i sidhuvudet och i sidfoten, så att mottagaren ser vem rapporten är från.
   */
  sender?: string;
  /** Rapportperioden, inklusive slutdag. */
  period: Period;
  generatedAt: Date;
  /**
   * Tidszonen som "Genererad …" skrivs i (organisationens, standard Europe/Stockholm).
   * Samma klockslag på servern (UTC på Vercel), i webbläsaren och i PDF:en.
   */
  timeZone?: string;
  /** Ersätter "Konfidentiellt · för {mottagare}" i sidfoten. */
  confidentiality?: string;
};

export type ReportTone = "mono" | "signal";
export type ReportLayout = "stack" | "spread";

type ReportDocumentProps = ReportMeta & {
  children: ReactNode;
  /**
   * mono (standard): svartvitt, signalen blir #111. För utskrift.
   * signal: signalfärgen behålls, för PDF som läses på skärm.
   */
  tone?: ReportTone;
  /**
   * stack (standard): arken under varandra, skalas ned till skärmbredd.
   * Det enda läget som styr utskrift (A4, sidbrytning).
   * spread: arken i ett rutnät, för förhandsvisningar.
   */
  layout?: ReportLayout;
  /** Visa bara dessa sidor (1-baserat). Numreringen räknar ändå alla. */
  visiblePages?: ReadonlyArray<number>;
  className?: string;
};

type PagePosition = { number: number; total: number };

const MetaContext = createContext<ReportMeta | null>(null);
const PageContext = createContext<PagePosition | null>(null);

/** Plattar ut arrayer och fragment till en lista av sidor. */
function flattenPages(children: ReactNode): ReactNode[] {
  const out: ReactNode[] = [];
  Children.toArray(children).forEach((child) => {
    if (isValidElement(child) && child.type === Fragment) {
      out.push(...flattenPages((child as ReactElement<{ children?: ReactNode }>).props.children));
    } else {
      out.push(child);
    }
  });
  return out;
}

export function ReportDocument({
  children,
  tone = "mono",
  layout = "stack",
  visiblePages,
  className,
  ...meta
}: ReportDocumentProps) {
  const pages = flattenPages(children);
  const total = pages.length;
  return (
    <MetaContext value={meta}>
      <div
        data-theme="print"
        data-tone={tone}
        data-layout={layout}
        className={cn(
          "bl-report",
          layout === "stack"
            ? "flex flex-col items-center gap-6 md:gap-8"
            : "grid items-start gap-4 sm:grid-cols-2 md:gap-6",
          className,
        )}
      >
        {pages.map((page, i) =>
          visiblePages && !visiblePages.includes(i + 1) ? null : (
            <PageContext key={i} value={{ number: i + 1, total }}>
              {page}
            </PageContext>
          ),
        )}
      </div>
    </MetaContext>
  );
}

/** Läser rapportens metadata, t.ex. för en egen titelrad. Kastar utanför ReportDocument. */
export function useReportMeta(): ReportMeta {
  const meta = use(MetaContext);
  if (!meta) throw new Error("useReportMeta måste användas inuti <ReportDocument>.");
  return meta;
}

type ReportPageProps = {
  children: ReactNode;
  className?: string;
};

/** Ett A4-ark: sidhuvud, brödyta och sidfot. Måste ligga i ReportDocument. */
export function ReportPage({ children, className }: ReportPageProps) {
  const meta = use(MetaContext);
  const position = use(PageContext);
  if (!meta || !position) {
    throw new Error("<ReportPage> måste vara ett barn till <ReportDocument>.");
  }
  const [bodyRef, overflowPx] = useOverflow();

  return (
    <section
      className="bl-sheet"
      aria-label={`Sida ${position.number} av ${position.total}`}
      data-page={position.number}
      data-overflow={overflowPx > 0 ? overflowPx : undefined}
    >
      <div className="bl-page">
        <ReportHeader meta={meta} />
        <div ref={bodyRef} className="bl-page-body pt-[9mm] pb-[6mm]">
          {/* Växer med innehållet; när det blir högre än brödytan klipps det och flaggas. */}
          <div className={cn("flex flex-[1_0_auto] flex-col", className)}>{children}</div>
        </div>
        <ReportFooter meta={meta} position={position} />
        {overflowPx > 0 ? <OverflowFlag px={overflowPx} /> : null}
      </div>
    </section>
  );
}

/**
 * Mäter hur många px brödytans innehåll sticker ut nedåt. Observerar
 * innehållsbehållaren, som växer med allt som ligger i den.
 */
function useOverflow() {
  const ref = useRef<HTMLDivElement>(null);
  const [px, setPx] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    const content = el?.firstElementChild;
    if (!el || !content) return;
    // ResizeObserver rapporterar direkt vid observe, så första mätningen sker där.
    const ro = new ResizeObserver(() => {
      setPx(Math.max(0, Math.ceil(el.scrollHeight - el.clientHeight)));
    });
    ro.observe(el);
    ro.observe(content);
    return () => ro.disconnect();
  }, []);
  return [ref, px] as const;
}

function OverflowFlag({ px }: { px: number }) {
  return (
    <p
      data-print="hide"
      role="alert"
      className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-inverse px-[18mm] py-2 font-mono text-[11px] leading-4 text-on-inverse"
    >
      <span
        aria-hidden
        className="size-2 shrink-0 bg-on-inverse outline outline-offset-2 outline-on-inverse"
      />
      Innehållet är {formatInt(px)} px för högt för arket. Flytta ett block till nästa sida.
    </p>
  );
}

function ReportHeader({ meta }: { meta: ReportMeta }) {
  return (
    <header className="flex items-end justify-between gap-[8mm] border-b border-line-strong pb-[3.5mm]">
      {meta.sender ? (
        // Avsändaren (operatören) är det mottagaren ska se; verktyget står litet under.
        <div className="flex max-w-[70mm] min-w-0 shrink-0 flex-col gap-[1.5mm]">
          <span className="text-[15px] leading-[19px] font-semibold text-balance text-fg">
            {meta.sender}
          </span>
          <Wordmark size="sm" mono className="text-subtle" />
        </div>
      ) : (
        <Wordmark size="lg" mono className="shrink-0" />
      )}
      <dl className="flex min-w-0 items-end gap-[6mm] text-[10.5px] leading-[14px]">
        <HeaderItem label="Rapport">{meta.title}</HeaderItem>
        <HeaderItem label="Mottagare">{meta.recipient}</HeaderItem>
        <HeaderItem label="Period" mono>
          {formatPeriod(meta.period)}
        </HeaderItem>
      </dl>
    </header>
  );
}

function HeaderItem({
  label,
  children,
  mono,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-[1mm]">
      <dt className="label text-[8.5px] leading-[10px] text-subtle">{label}</dt>
      <dd className={cn("text-fg", mono && "tnum font-mono whitespace-nowrap")}>{children}</dd>
    </div>
  );
}

function ReportFooter({ meta, position }: { meta: ReportMeta; position: PagePosition }) {
  const wall = wallClockIn(meta.generatedAt, meta.timeZone ?? DEFAULT_TIME_ZONE);
  const generated = `${formatDate(wall)} ${formatTime(wall)}`;
  return (
    <footer className="tnum grid grid-cols-[1fr_auto_1fr] items-baseline gap-[6mm] border-t border-line pt-[2.5mm] font-mono text-[8.5px] leading-[12px] tracking-[0.02em] text-subtle">
      <span>Genererad {generated}</span>
      <span className="text-center">
        {meta.confidentiality ??
          `Konfidentiellt · ${meta.sender ? `från ${meta.sender} ` : ""}för ${meta.recipient}`}
      </span>
      <span className="text-right text-fg">
        Sida {position.number} av {position.total}
      </span>
    </footer>
  );
}
