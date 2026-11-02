import Link from "next/link";
import type { ReactNode } from "react";
import {
  EXAMPLE_PAGE_COUNT,
  ExampleReport,
  RevenueChart,
} from "@/app/rapport/exempel/example-report";
import { machine, totals as reportTotals } from "@/app/rapport/exempel/data";
import { ReportMark } from "@/components/report/report-blocks";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { formatSek } from "@/lib/format";
import { SpecSection, Sub } from "./section";

const EXAMPLE_HREF = "/rapport/exempel";

/** Arket i klartext. Storlekar i pt, som i tryck. */
const spec: Array<[string, string]> = [
  ["Format", "A4, 210 × 297 mm"],
  ["Marginal", "18 mm i sidled, 16 mm upptill och nedtill"],
  ["Sidhuvud", "Ordmärke, rapport, mottagare och period"],
  ["Sidfot", "Skapad, konfidentiell, sida x av y"],
  ["Färg", "Svartvitt. Det som kräver åtgärd trycks svart och bärs av formen."],
  ["Text", "Geist 9 pt, etiketter Geist Mono 6,5–7 pt"],
  ["Sidbrytning", "Varje sida på ett eget ark"],
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
            style={{ stroke: "var(--bl-fg)" }}
          />
          <rect x={25} y={4} width={6} height={6} style={{ fill: "var(--bl-fg)" }} />
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
                fill: i === 2 ? "var(--bl-fg)" : "var(--bl-data-5)",
                stroke: i === 2 ? "var(--bl-fg)" : "var(--bl-data-3)",
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
    form: "Heldragen linje, ihålig kvadrat, namn vid linjens slut",
  },
  { kind: "compare", name: "Jämförelseperiod", form: "Streckad tunnare linje utan markör" },
  { kind: "point", name: "Bästa dagen", form: "Fylld kvadrat med ring runt" },
  {
    kind: "bar",
    name: "Starkaste stapeln",
    form: "Fylld mot ljusgrå staplar med kant, värdet ovanför",
  },
  {
    kind: "incident",
    name: "Avvikelse",
    form: "Fyllt block och numrerad ruta, samma nummer i tabellen",
  },
  {
    kind: "row",
    name: "Markerad tabellrad",
    form: "Kvadrat med ring i marginalen och halvfet rad",
  },
];

function Paper({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-theme="print"
      className={cn("rounded-sm border border-line px-3 pt-4 pb-3 sm:px-5 sm:pt-5", className)}
    >
      {children}
    </div>
  );
}

export function PrintSection({ index }: { index: number }) {
  const n = String(index).padStart(2, "0");
  return (
    <SpecSection
      id="utskrift"
      index={index}
      eyebrow="Utskrift"
      title={`Månadsrapport till ${machine.placement.split(", ").pop() ?? ""}: ${formatSek(reportTotals.revenue)} i oktober.`}
      aside={`Sida 1 och 2 av ${EXAMPLE_PAGE_COUNT}. Varje markering bärs av form och klarar svartvit laser.`}
    >
      <figure className="bl-desk m-0 rounded-md p-3 sm:p-5 md:p-6 lg:col-span-9">
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

      <Sub index={`${n}.1`} label="Arket" className="lg:col-span-3">
        <dl className="flex flex-col">
          {spec.map(([k, v]) => (
            <div
              key={k}
              className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 border-b border-line py-2.5 last:border-b-0 lg:grid-cols-1 lg:gap-1"
            >
              <dt className="label text-subtle">{k}</dt>
              <dd className="text-sm text-fg">{v}</dd>
            </div>
          ))}
        </dl>
        <Link
          href={EXAMPLE_HREF}
          className="mt-6 inline-flex h-9 items-center justify-center gap-2 rounded-sm border border-inverse bg-inverse px-3.5 text-base font-medium whitespace-nowrap text-on-inverse transition-[background-color,border-color] duration-fast ease-instrument hover:border-inverse-hover hover:bg-inverse-hover"
        >
          Öppna exempelrapport
          <Icon name="arrowUpRight" className="-mr-0.5" />
        </Link>
      </Sub>

      <Sub
        index={`${n}.2`}
        label="Diagram 01 i gråskala"
        meta="som på svartvit laser"
        className="lg:col-span-6"
      >
        <Paper className="grayscale">
          <RevenueChart />
        </Paper>
      </Sub>

      <Sub
        index={`${n}.3`}
        label="Kodning utan färg"
        meta={`${encodings.length} former`}
        className="lg:col-span-6"
      >
        <ul className="grid sm:grid-cols-2 sm:gap-x-8">
          {encodings.map((e) => (
            <EncodingRow key={e.kind} encoding={e} />
          ))}
        </ul>
      </Sub>
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
    <li className="flex items-start gap-4 border-b border-line py-3">
      <PaperChip>
        <Sample kind={encoding.kind} />
      </PaperChip>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-base text-fg">{encoding.name}</span>
        <span className="text-sm text-subtle">{encoding.form}</span>
      </span>
    </li>
  );
}
