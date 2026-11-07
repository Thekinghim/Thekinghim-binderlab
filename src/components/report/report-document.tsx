"use client";

import {
  Children,
  Fragment,
  createContext,
  isValidElement,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
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

import { FlowSliceContext } from "./report-flow";

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
 * ReportPage. En ReportPage som inte får plats på ett ark fortsätter på nya
 * ark (se ReportPage och report-flow.tsx); numreringen räknar alla ark.
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

/**
 * En ReportPages plats i dokumentet. En ReportPage kan bli flera ark (flöde), så numret är
 * dess första arks nummer.
 */
type PageSlot = {
  /** Barnets plats bland ReportDocuments barn. */
  index: number;
  /** Första arkets nummer (1-baserat). */
  first: number;
  total: number;
  visible: (sheet: number) => boolean;
};

/** Sidindelningen: varje ReportPage talar om hur många ark den blev och om den är klar. */
type Flow = {
  setSheets: (index: number, count: number) => void;
  setSettled: (index: number, settled: boolean) => void;
  /** Ändras när typsnitten har laddats: allt mäts om. */
  epoch: number;
};

/**
 * Var ett ark slutar och nästa börjar: före rad `row` i block `block` (rad 0: hela blocket
 * flyttas). Blocken är ReportPage-barnen i ordning.
 */
type Break = { readonly block: number; readonly row: number };

/** Färre rader än så står inte ensamma under en rubrik: hela blocket flyttas i stället. */
const MIN_ROWS = 2;

const MetaContext = createContext<ReportMeta | null>(null);
const PageContext = createContext<PageSlot | null>(null);
const FlowContext = createContext<Flow | null>(null);

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

const before = (a: Break, b: Break) => a.block < b.block || (a.block === b.block && a.row < b.row);
const same = (a: Break, b: Break) => a.block === b.block && a.row === b.row;

export function ReportDocument({
  children,
  tone = "mono",
  layout = "stack",
  visiblePages,
  className,
  ...meta
}: ReportDocumentProps) {
  const pages = flattenPages(children);
  // Antal ark per sida (barn), mätt i webbläsaren av ReportPage. Saknas: ett ark, som i
  // serverns HTML.
  const [sheets, setSheetsState] = useState<Readonly<Record<number, number>>>({});
  const [epoch, setEpoch] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const settled = useRef(new Map<number, boolean>());

  // data-paginated: typsnitten är laddade och varje ReportPage har mätt klart. PDF-utskriften
  // och testerna väntar på det.
  const update = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const done = epoch > 0 && [...settled.current.values()].every(Boolean);
    if (done) root.setAttribute("data-paginated", "");
    else root.removeAttribute("data-paginated");
  }, [epoch]);

  // Typsnitten ändrar radernas höjd: mät om när de har laddats.
  useEffect(() => {
    let alive = true;
    void document.fonts.ready.then(() => {
      if (alive) setEpoch((e) => e + 1);
    });
    return () => {
      alive = false;
    };
  }, []);

  const flow = useMemo<Flow>(
    () => ({
      epoch,
      setSheets: (index, count) =>
        setSheetsState((prev) => (prev[index] === count ? prev : { ...prev, [index]: count })),
      setSettled: (index, value) => {
        settled.current.set(index, value);
        update();
      },
    }),
    [epoch, update],
  );
  // Sidor utan ReportPage (eller som försvunnit) räknas inte.
  useLayoutEffect(() => {
    for (const key of [...settled.current.keys()]) {
      if (key >= pages.length) settled.current.delete(key);
    }
    update();
  });

  const counts = pages.map((_, i) => sheets[i] ?? 1);
  const total = counts.reduce((a, n) => a + n, 0);
  const firsts = counts.map((_, i) => 1 + counts.slice(0, i).reduce((a, n) => a + n, 0));

  return (
    <MetaContext value={meta}>
      <FlowContext value={flow}>
        <div
          ref={rootRef}
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
          {pages.map((page, i) => (
            <PageContext
              key={i}
              value={{
                index: i,
                first: firsts[i]!,
                total,
                visible: (n) => !visiblePages || visiblePages.includes(n),
              }}
            >
              {page}
            </PageContext>
          ))}
        </div>
      </FlowContext>
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

/**
 * Ett A4-ark: sidhuvud, brödyta och sidfot. Måste ligga i ReportDocument.
 *
 * Får innehållet inte plats fortsätter sidan på nya ark: webbläsaren mäter arket, och det
 * första barnet (block) som inte får plats flyttas till nästa ark. En tabell eller lista
 * (ReportTable, ReportList) i blocket delas i stället mellan två rader, med sektionens
 * rubrik upprepad ("forts.") och summaraden sist. Serverns HTML har ett ark per sida; den
 * slutliga indelningen finns när ReportDocument har satt data-paginated.
 */
export function ReportPage({ children, className }: ReportPageProps) {
  const slot = use(PageContext);
  const flow = use(FlowContext);
  if (!slot || !flow) throw new Error("<ReportPage> måste vara ett barn till <ReportDocument>.");
  const blocks = Children.toArray(children);
  const [breaks, setBreaks] = useState<readonly Break[]>([]);
  // Nytt innehåll eller nyss laddade typsnitt: mät om från början.
  const [seen, setSeen] = useState({ children, epoch: flow.epoch });
  if (seen.children !== children || seen.epoch !== flow.epoch) {
    setSeen({ children, epoch: flow.epoch });
    setBreaks([]);
  }
  const bodies = useRef<(HTMLElement | null)[]>([]);
  const starts: Break[] = [{ block: 0, row: 0 }, ...breaks];
  const { index } = slot;

  // Efter varje rendering: får alla ark plats? Annars en brytpunkt till (nästa rendering
  // mäter igen). Antalet ark går till ReportDocument för numreringen.
  useLayoutEffect(() => {
    const begins: Break[] = [{ block: 0, row: 0 }, ...breaks];
    for (let i = 0; i < begins.length; i++) {
      const body = bodies.current[i];
      const brk = body ? findBreak(body) : null;
      if (brk && before(begins[i]!, brk) && !breaks.some((b) => same(b, brk))) {
        flow.setSettled(index, false);
        setBreaks((prev) =>
          prev.some((b) => same(b, brk))
            ? prev
            : [...prev, brk].sort((x, y) => (before(x, y) ? -1 : 1)),
        );
        return;
      }
    }
    flow.setSheets(index, begins.length);
    flow.setSettled(index, flow.epoch > 0);
  }, [flow, index, breaks, seen]);
  useLayoutEffect(() => () => flow.setSettled(index, true), [flow, index]);

  return starts.map((start, i) => {
    const end = breaks[i] ?? null;
    const number = slot.first + i;
    if (!slot.visible(number)) return null;
    const last = end === null ? blocks.length - 1 : end.row > 0 ? end.block : end.block - 1;
    const shown: ReactNode[] = [];
    for (let j = start.block; j <= last; j++) {
      const block = blocks[j];
      const from = j === start.block ? start.row : 0;
      const to = end && j === end.block ? end.row : Infinity;
      // Ett block som ska stå längst ned (mt-auto) gör det även i sitt omslag.
      const bottom =
        isValidElement<{ className?: unknown }>(block) &&
        typeof block.props.className === "string" &&
        /(^|\s)mt-auto(\s|$)/.test(block.props.className);
      shown.push(
        <div
          key={isValidElement(block) && block.key != null ? block.key : j}
          data-flow-block={j}
          data-flow-from={from}
          data-flow-tail={bottom ? "" : undefined}
          className={cn("flex flex-col", bottom && "mt-auto")}
        >
          <FlowSliceContext value={{ from, to }}>{block}</FlowSliceContext>
        </div>,
      );
    }
    return (
      <Sheet
        key={`${start.block}-${start.row}`}
        position={{ number, total: slot.total }}
        className={className}
        bodyRef={(el) => {
          bodies.current[i] = el;
        }}
      >
        {shown}
      </Sheet>
    );
  });
}

/**
 * Var arkets innehåll ska brytas: före det första block som slutar nedanför brödytan, eller
 * mellan två av dess rader. null när allt får plats (eller inget går att flytta).
 */
function findBreak(body: HTMLElement): Break | null {
  const content = body.firstElementChild;
  if (!content) return null;
  const rect = body.getBoundingClientRect();
  // På skärmen är arket skalat (transform); offsetHeight är oskalad.
  const scale = body.offsetHeight > 0 ? rect.height / body.offsetHeight : 1;
  const padding = Number.parseFloat(getComputedStyle(body).paddingBottom) || 0;
  const limit = rect.bottom - padding * scale + 0.5;
  const blocks = Array.from(content.children).filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.dataset.flowBlock !== undefined,
  );
  for (const [i, el] of blocks.entries()) {
    if (el.getBoundingClientRect().bottom <= limit) continue;
    // En fotnot längst ned (mt-auto) står inte ensam på ett ark: blocket före följer med.
    if (el.dataset.flowTail !== undefined && i > 1) {
      return { block: Number(blocks[i - 1]!.dataset.flowBlock), row: 0 };
    }
    const block = Number(el.dataset.flowBlock);
    const from = Number(el.dataset.flowFrom ?? 0);
    const list = el.querySelector("[data-flow-rows]");
    const rows = list ? Array.from(list.children) : [];
    const over = rows.findIndex((r) => r.getBoundingClientRect().bottom > limit);
    // Alla rader får plats men inte det som står efter (summa, not): sista raden följer med.
    const fit = over >= 0 ? over : Math.max(0, rows.length - 1);
    if (fit >= MIN_ROWS || (i === 0 && fit > 0)) return { block, row: from + fit };
    if (i > 0) return { block, row: from };
    return null;
  }
  return null;
}

function Sheet({
  children,
  className,
  position,
  bodyRef,
}: {
  children: ReactNode;
  className?: string;
  position: PagePosition;
  bodyRef: (el: HTMLDivElement | null) => void;
}) {
  const meta = use(MetaContext)!;
  const [overflowRef, overflowPx] = useOverflow();
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      overflowRef.current = el;
      bodyRef(el);
    },
    [overflowRef, bodyRef],
  );

  return (
    <section
      className="bl-sheet"
      aria-label={`Sida ${position.number} av ${position.total}`}
      data-page={position.number}
      data-overflow={overflowPx > 0 ? overflowPx : undefined}
    >
      <div className="bl-page">
        <ReportHeader meta={meta} />
        <div ref={ref} className="bl-page-body pt-[9mm] pb-[6mm]">
          {/* Växer med innehållet; det som ändå inte får plats klipps och flaggas på skärmen. */}
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
  const ref = useRef<HTMLDivElement | null>(null);
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
