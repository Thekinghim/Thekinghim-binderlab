import Link from "next/link";
import type { ReactNode } from "react";
import {
  EXAMPLE_PAGE_COUNT,
  ExampleReport,
  RevenueChart,
} from "@/app/rapport/exempel/example-report";
import { ReportMark } from "@/components/report/report-blocks";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { SpecSection } from "./section";

const EXAMPLE_HREF = "/rapport/exempel";

/** Varje värde är en lista; varje del står på egen rad i den smala kolumnen. */
const spec: Array<[string, string[]]> = [
  ["Format", ["A4 · 210 × 297 mm"]],
  ["Marginal", ["18 mm sidor", "16 mm topp och botten"]],
  ["Sidhuvud", ["Ordmärke, rapport,", "mottagare, period"]],
  ["Sidfot", ["Genereringstid,", "konfidentialitet,", "Sida x av y"]],
  ["Tema", ['data-theme="print"', "signal = #111"]],
  ["Text", ["Geist 12 px (9 pt)", "Mono 8,5–9,5 px"]],
  ["Brytning", ["En ReportPage per ark", "break-after: page"]],
];

/** Liten provbit av varje kodning. Ritas inuti PaperChip, alltså i rapportens tema. */
function Sample({ kind }: { kind: Encoding["kind"] }) {
  const common = { width: 56, height: 20, viewBox: "0 0 56 20", "aria-hidden": true } as const;
  switch (kind) {
    case "current":
      return (
        <svg {...common}>
          <path
            d="M2 14L18 8L34 11L54 5"
            fill="none"
            strokeWidth={1.5}
            style={{ stroke: "var(--bl-data-1)" }}
          />
          {[
            [18, 8],
            [34, 11],
          ].map(([x = 0, y = 0]) => (
            <rect
              key={x}
              x={x - 2}
              y={y - 2}
              width={4}
              height={4}
              strokeWidth={1}
              style={{ fill: "var(--bl-bg)", stroke: "var(--bl-data-1)" }}
            />
          ))}
        </svg>
      );
    case "compare":
      return (
        <svg {...common}>
          <path
            d="M2 12L18 14L34 9L54 11"
            fill="none"
            strokeWidth={1}
            strokeDasharray="4 3"
            style={{ stroke: "var(--bl-data-3)" }}
          />
        </svg>
      );
    case "point":
      return (
        <svg {...common}>
          <path
            d="M2 17L22 14L28 7L36 15L54 16"
            fill="none"
            strokeWidth={1.5}
            style={{ stroke: "var(--bl-data-1)" }}
          />
          <rect
            x={22.5}
            y={1.5}
            width={11}
            height={11}
            fill="none"
            strokeWidth={1}
            style={{ stroke: "var(--bl-signal)" }}
          />
          <rect x={25} y={4} width={6} height={6} style={{ fill: "var(--bl-signal)" }} />
        </svg>
      );
    case "bar":
      return (
        <svg {...common}>
          {[6, 18, 30, 42].map((x, i) => (
            <rect
              key={x}
              x={x + 0.5}
              y={i === 2 ? 2.5 : 9.5 - i}
              width={8}
              height={i === 2 ? 17 : 10 + i}
              strokeWidth={1}
              style={{
                fill: i === 2 ? "var(--bl-signal)" : "var(--bl-data-5)",
                stroke: i === 2 ? "var(--bl-signal)" : "var(--bl-data-3)",
              }}
            />
          ))}
        </svg>
      );
    case "incident":
      return (
        <svg {...common}>
          <rect
            x={0.5}
            y={10.5}
            width={55}
            height={8}
            fill="none"
            strokeWidth={1}
            style={{ stroke: "var(--bl-line-strong)" }}
          />
          <rect x={30} y={10} width={7} height={9} style={{ fill: "var(--bl-signal)" }} />
          <rect
            x={27.5}
            y={0.5}
            width={9}
            height={8}
            strokeWidth={1}
            style={{ fill: "var(--bl-bg)", stroke: "var(--bl-fg)" }}
          />
          <text
            x={32}
            y={6.8}
            textAnchor="middle"
            style={{ fontFamily: "var(--bl-font-mono)", fontSize: 7, fill: "var(--bl-fg)" }}
          >
            3
          </text>
        </svg>
      );
    case "row":
      return (
        <span className="flex h-5 w-14 items-center gap-1.5" aria-hidden>
          <ReportMark />
          <span className="h-px flex-1 bg-fg" />
        </span>
      );
  }
}

type Encoding = {
  kind: "current" | "compare" | "point" | "bar" | "incident" | "row";
  name: string;
  form: string;
};

const encodings: Encoding[] = [
  {
    kind: "current",
    name: "Aktuell period",
    form: "Heldragen 1,5 px · ihålig kvadrat · namn vid linjens slut",
  },
  { kind: "compare", name: "Jämförelseperiod", form: "Streckad 1 px (4/3) · ingen markör" },
  { kind: "point", name: "Markerad datapunkt", form: "Fylld kvadrat 6 px + ring 12 px" },
  {
    kind: "bar",
    name: "Markerad stapel",
    form: "Fylld mot ljusgrå staplar med kant · värde ovanför",
  },
  {
    kind: "incident",
    name: "Avvikelse",
    form: "Fyllt block · numrerad ruta, samma nummer i tabellen",
  },
  {
    kind: "row",
    name: "Markerad tabellrad",
    form: "Kvadrat med ring i vänstermarginalen · halvfet rad",
  },
];

function ProofLabel({ label, meta }: { label: string; meta: string }) {
  return (
    <p className="flex items-baseline justify-between gap-3">
      <span className="label text-muted">{label}</span>
      <Code>{meta}</Code>
    </p>
  );
}

/** Kod och attribut i mono, utan versaler. */
function Code({ children }: { children: ReactNode }) {
  return <code className="meta text-subtle">{children}</code>;
}

function Paper({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-theme="print"
      data-tone="signal"
      className={cn("rounded-sm border border-line px-3 pt-4 pb-3 sm:px-5 sm:pt-5", className)}
    >
      {children}
    </div>
  );
}

export function PrintSection({ index }: { index: number }) {
  return (
    <SpecSection
      id="utskrift"
      index={index}
      eyebrow="Utskrift"
      title={`${EXAMPLE_PAGE_COUNT} A4-ark med fast sidhuvud och sidfot.`}
      aside="Varje markering bärs av form och klarar svartvit laser."
      tiles
    >
      <figure className="bl-desk m-0 rounded-md border border-line p-3 sm:p-5 md:p-6 lg:col-span-9">
        <ExampleReport headingLevel={3} layout="spread" visiblePages={[1, 2]} />
        <figcaption className="mt-3 hidden gap-4 sm:grid sm:grid-cols-2 md:gap-6">
          <span className="label text-subtle">
            <span className="text-fg">Sida 1</span> · Sammanfattning
          </span>
          <span className="label text-subtle">
            <span className="text-fg">Sida 2</span> · Sortiment
          </span>
        </figcaption>
      </figure>

      <div className="flex flex-col rounded-md border border-line bg-surface lg:col-span-3">
        <p className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-3 md:px-5">
          <span className="label text-muted">Specifikation</span>
          <Code>&lt;ReportDocument&gt;</Code>
        </p>
        <dl className="flex flex-col px-4 md:px-5">
          {spec.map(([k, v]) => (
            <div
              key={k}
              className="grid grid-cols-[84px_1fr] gap-3 border-b border-line py-2.5 last:border-b-0"
            >
              <dt className="label text-subtle">{k}</dt>
              <dd className="tnum flex flex-col font-mono text-xs text-fg">
                {v.map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
        <div className="mt-auto flex flex-col gap-3 border-t border-line p-4 md:p-5">
          <p className="text-sm text-muted">
            Sidan sätter A4 och 0 mm marginal själv. Välj Spara som PDF i utskriftsdialogen.
          </p>
          <Link
            href={EXAMPLE_HREF}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-sm border border-inverse bg-inverse px-3.5 text-base font-medium whitespace-nowrap text-on-inverse transition-[background-color,border-color] duration-[120ms] ease-instrument hover:border-inverse-hover hover:bg-inverse-hover"
          >
            Öppna exempelrapport
            <Icon name="arrowUpRight" className="-mr-0.5" />
          </Link>
        </div>
      </div>

      <figure className="m-0 flex flex-col gap-3 lg:col-span-6">
        <ProofLabel label="PDF på skärm" meta='data-tone="signal"' />
        <Paper>
          <RevenueChart />
        </Paper>
      </figure>
      <figure className="m-0 flex flex-col gap-3 lg:col-span-6">
        <ProofLabel label="Samma diagram i gråskala" meta="filter: grayscale(1)" />
        <Paper className="grayscale">
          <RevenueChart />
        </Paper>
      </figure>

      <div className="overflow-hidden rounded-md border border-line lg:col-span-12">
        <p className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-3 md:px-5">
          <span className="label text-muted">Kodning utan färg</span>
          <Code>--bl-signal: #111</Code>
        </p>
        <ul className="-mb-px grid sm:grid-cols-2 lg:grid-cols-3">
          {encodings.map((e) => (
            <EncodingRow key={e.kind} encoding={e} />
          ))}
        </ul>
      </div>
    </SpecSection>
  );
}

/**
 * Ett litet pappersprov i data-theme="print" utan data-tone, så att
 * signalen är #111 och data-5 ljusgrå oavsett appens läge.
 */
function PaperChip({ children }: { children: ReactNode }) {
  return (
    <span
      data-theme="print"
      className="flex shrink-0 items-center rounded-xs border border-line bg-bg px-2 py-1.5"
    >
      {children}
    </span>
  );
}

function EncodingRow({ encoding }: { encoding: Encoding }) {
  return (
    <li className="flex items-start gap-4 border-b border-line px-4 py-4 md:px-5">
      <PaperChip>
        <Sample kind={encoding.kind} />
      </PaperChip>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-base text-fg">{encoding.name}</span>
        <span className="font-mono text-xs text-subtle">{encoding.form}</span>
      </span>
    </li>
  );
}
