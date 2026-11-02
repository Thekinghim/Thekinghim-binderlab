import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Byggblock för rapportsidor. Måtten är satta för A4 i 100 %:
 * brödtext 12 px (9 pt), tabeller 11 px, etiketter 8,5–9,5 px mono.
 * Inga ramar runt block; struktur ges av hårfina linjer och luft.
 */

/**
 * Markering som bärs av form: fylld kvadrat med ring. Signalfärg i
 * data-tone="signal", nästan svart annars. Används för markerade
 * tabellrader, nyckeltal och förklaringar.
 */
export function ReportMark({ className, label }: { className?: string; label?: string }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 11 11"
      className={cn("shrink-0", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <rect
        x="0.5"
        y="0.5"
        width="10"
        height="10"
        fill="none"
        style={{ stroke: "var(--bl-signal)" }}
      />
      <rect x="3" y="3" width="5" height="5" style={{ fill: "var(--bl-signal)" }} />
    </svg>
  );
}

// ---------------------------------------------------------------------------

type ReportTitleProps = {
  /** Mono-rad ovanför, t.ex. "BL-010 · Plan 1, entré Norr" */
  eyebrow: string;
  /** Påståendet, i fg: "56 707 kr i oktober." */
  title: string;
  /** Fortsättningen i grått: "Bästa månaden sedan installationen." */
  aside?: string;
  children?: ReactNode;
  /**
   * Rubriknivå. h1 när rapporten är egen sida; lägre när den bäddas in
   * under en annan rubrik, t.ex. h3 i en förhandsvisning på /design.
   */
  as?: "h1" | "h2" | "h3";
};

/** Rapportens rubrik, en gång på första sidan. */
export function ReportTitle({
  eyebrow,
  title,
  aside,
  children,
  as: Heading = "h1",
}: ReportTitleProps) {
  return (
    <div className="flex flex-col gap-[3mm]">
      <p className="label text-[9.5px] leading-[12px] text-subtle">{eyebrow}</p>
      <Heading className="max-w-[150mm] text-[30px] leading-[34px] font-medium tracking-[-0.025em] text-balance">
        <span className="text-fg">{title}</span>
        {aside ? <span className="text-subtle"> {aside}</span> : null}
      </Heading>
      {children ? (
        <div className="max-w-[140mm] text-[12px] leading-[17px] text-muted">{children}</div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

type ReportSectionProps = {
  /** 1 → "01" */
  index: number | string;
  eyebrow: string;
  title: string;
  aside?: string;
  children?: ReactNode;
  className?: string;
  /** Rubriknivå, ett steg under ReportTitle. Standard h2. */
  as?: "h2" | "h3" | "h4";
};

/** "01 / FÖRSÄLJNING" och en tvådelad rubrik i rapportstorlek. */
export function ReportSection({
  index,
  eyebrow,
  title,
  aside,
  children,
  className,
  as: Heading = "h2",
}: ReportSectionProps) {
  return (
    <section className={cn("flex flex-col gap-[4mm]", className)}>
      <header className="flex flex-col gap-[1.5mm]">
        <p className="label flex items-center gap-2 text-[9.5px] leading-[12px] text-subtle">
          <span className="tnum text-fg">
            {typeof index === "number" ? String(index).padStart(2, "0") : index}
          </span>
          <span aria-hidden className="text-faint">
            /
          </span>
          <span>{eyebrow}</span>
        </p>
        <Heading className="max-w-[160mm] text-[15px] leading-[20px] font-medium tracking-[-0.01em] text-balance">
          <span className="text-fg">{title}</span>
          {aside ? <span className="text-subtle"> {aside}</span> : null}
        </Heading>
      </header>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------

export type ReportKpi = {
  label: string;
  /** Färdigformaterat tal utan enhet: "56 707" */
  value: string;
  /** Enhet i mindre grad: "kr", "%", "pack" */
  unit?: string;
  /** "+27 %" */
  delta?: string;
  /** "mot sep." */
  context?: string;
  /** Kräver uppmärksamhet: visas med ReportMark och text. */
  flag?: string;
};

/** Nyckeltal på rad: stora siffror, tunna avdelare, ingen ram. */
export function ReportKpiRow({
  items,
  className,
}: {
  items: ReadonlyArray<ReportKpi>;
  className?: string;
}) {
  return (
    <dl
      className={cn("grid border-t border-line-strong", className)}
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
    >
      {items.map((k, i) => (
        <div
          key={k.label}
          className={cn(
            "flex min-w-0 flex-col gap-[1.5mm] pt-[3mm] pr-[4mm]",
            i > 0 && "border-l border-line pl-[4mm]",
          )}
        >
          <dt className="label text-[9px] leading-[12px] text-subtle">{k.label}</dt>
          <dd className="tnum flex items-baseline gap-[1.5mm] text-[26px] leading-[30px] font-medium tracking-[-0.02em] text-fg">
            {k.value}
            {k.unit ? (
              <span className="text-[13px] leading-[16px] font-normal tracking-normal text-subtle">
                {k.unit}
              </span>
            ) : null}
          </dd>
          {k.delta || k.context ? (
            <dd className="tnum font-mono text-[9.5px] leading-[12px] text-muted">
              {k.delta ? <span className="text-fg">{k.delta}</span> : null}
              {k.delta && k.context ? " " : null}
              {k.context}
            </dd>
          ) : null}
          {k.flag ? (
            <dd className="flex items-center gap-1.5 font-mono text-[9.5px] leading-[12px] text-signal-fg">
              <ReportMark />
              {k.flag}
            </dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------

export type ReportColumn<T> = {
  key: string;
  header: string;
  /** Högerställd, tabulär, mono. */
  numeric?: boolean;
  /** CSS-bredd, t.ex. "22mm" eller "30%". */
  width?: string;
  render: (row: T, index: number) => ReactNode;
  /** Värde i summaraden. */
  total?: ReactNode;
};

type ReportTableProps<T> = {
  columns: ReadonlyArray<ReportColumn<T>>;
  rows: ReadonlyArray<T>;
  rowKey: (row: T, index: number) => string;
  /** Beskriver tabellen för skärmläsare. */
  caption: string;
  /** Rader som markeras med ReportMark i vänstermarginalen och halvfet text. */
  isMarked?: (row: T) => boolean;
  /** Tabellen fortsätter från föregående ark (se splitRows). */
  continued?: boolean;
  className?: string;
};

/**
 * Tät tabell: hårfina linjer, inga zebrarader, högerställda tal och
 * summarad om någon kolumn har `total`. Rubrikraden upprepas om tabellen
 * bryts i ett vanligt utskriftsflöde; i ReportPage delas långa tabeller
 * med splitRows och `continued`.
 */
export function ReportTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  isMarked,
  continued,
  className,
}: ReportTableProps<T>) {
  const hasTotals = columns.some((c) => c.total !== undefined);
  const align = (c: ReportColumn<T>) => (c.numeric ? "text-right" : "text-left");
  const cell = "px-[2mm] first:pl-0 last:pr-0";
  return (
    <table
      className={cn(
        "w-full border-separate border-spacing-0 text-[11px] leading-[15px]",
        className,
      )}
    >
      <caption className="sr-only">
        {caption}
        {continued ? " (fortsättning)" : ""}
      </caption>
      <colgroup>
        {columns.map((c) => (
          <col key={c.key} style={c.width ? { width: c.width } : undefined} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {columns.map((c, i) => (
            <th
              key={c.key}
              scope="col"
              className={cn(
                "label border-b border-line-strong pb-[1.5mm] align-bottom text-[8.5px] leading-[11px] font-normal text-subtle",
                cell,
                align(c),
              )}
            >
              {c.header}
              {continued && i === 0 ? <span className="text-faint"> · forts.</span> : null}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => {
          const marked = isMarked?.(row) ?? false;
          return (
            <tr key={rowKey(row, ri)}>
              {columns.map((c, ci) => {
                const Tag = ci === 0 ? "th" : "td";
                return (
                  <Tag
                    key={c.key}
                    scope={ci === 0 ? "row" : undefined}
                    className={cn(
                      "border-b border-line py-[1.6mm] align-baseline",
                      marked ? "font-medium" : "font-normal",
                      cell,
                      align(c),
                      c.numeric ? "tnum font-mono text-[10.5px]" : "text-fg",
                      ci === 0 && "relative text-left",
                      hasTotals && ri === rows.length - 1 && "border-b-0",
                    )}
                  >
                    {ci === 0 && marked ? (
                      <ReportMark
                        className="absolute top-1/2 -left-[5mm] -translate-y-1/2"
                        label="Markerad"
                      />
                    ) : null}
                    {c.render(row, ri)}
                  </Tag>
                );
              })}
            </tr>
          );
        })}
      </tbody>
      {hasTotals ? (
        <tfoot>
          <tr>
            {columns.map((c, ci) => {
              const Tag = ci === 0 ? "th" : "td";
              return (
                <Tag
                  key={c.key}
                  scope={ci === 0 ? "row" : undefined}
                  className={cn(
                    "border-t border-line-strong py-[1.8mm] align-baseline font-medium",
                    cell,
                    align(c),
                    c.numeric ? "tnum font-mono text-[10.5px]" : "text-fg",
                  )}
                >
                  {c.total}
                </Tag>
              );
            })}
          </tr>
        </tfoot>
      ) : null}
    </table>
  );
}

/**
 * Delar rader i ark: första arket rymmer `first` rader (ofta färre, för att
 * rubriken tar plats), resten `perPage`. Rendera en ReportPage per del och
 * sätt `continued` på alla utom första.
 */
export function splitRows<T>(rows: ReadonlyArray<T>, perPage: number, first = perPage): T[][] {
  const per = Math.max(1, Math.floor(perPage));
  const head = Math.max(1, Math.floor(first));
  const out: T[][] = [rows.slice(0, head)];
  for (let i = head; i < rows.length; i += per) out.push(rows.slice(i, i + per));
  return out;
}

// ---------------------------------------------------------------------------

/** Fotnot eller källa i mono. `marker` för numrerade noter: "1". */
export function ReportNote({
  children,
  marker,
  className,
}: {
  children: ReactNode;
  marker?: string;
  className?: string;
}) {
  return (
    <p className={cn("font-mono text-[9px] leading-[13px] text-subtle", className)}>
      {marker ? <span className="mr-[1.5mm] text-fg">{marker}</span> : null}
      {children}
    </p>
  );
}

/** Etikett + innehåll i rapportens mono-stil, för kontaktblock och små faktarutor. */
export function ReportFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-[1.5mm]">
      <p className="label text-[8.5px] leading-[11px] text-subtle">{label}</p>
      <div className="text-[11px] leading-[15px] text-fg">{children}</div>
    </div>
  );
}
