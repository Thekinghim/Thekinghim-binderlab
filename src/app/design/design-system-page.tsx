"use client";

import { useSearchParams } from "next/navigation";
import { Fragment, Suspense, useMemo, type ReactNode } from "react";
import { SYMBOL_PARTS } from "@/components/brand/wordmark";
import { AppShell } from "@/components/shell/app-shell";
import { parsePeriod, parseScope } from "@/components/shell/period-state";
import { RECIPIENT_KINDS } from "@/emails/report-content";
import { EXAMPLE_PAGE_COUNT } from "@/app/rapport/exempel/example-report";
import { NBSP, formatDate, formatInt } from "@/lib/format";
import { buildModel } from "./model";
import {
  FIRST_DAY,
  REF_NOW,
  SYNCED_AT,
  machines,
  organization,
  shellMachines,
  shellStores,
  todos,
} from "./sample-data";
import { BrandSection } from "./sections/brand";
import { CHART_COUNT, ChartsSection } from "./sections/charts";
import { COMMAND_COUNT, CommandSection } from "./sections/command";
import { ControlsSection, iconNames } from "./sections/controls";
import { EmailSection } from "./sections/email";
import { FORMAT_RULE_COUNT, FormatSection } from "./sections/format";
import { ColorSection, MeasureSection, TypeSection } from "./sections/foundations";
import { MetricsSection } from "./sections/metrics";
import { PrintSection } from "./sections/print";
import { STATE_COUNT, StatesSection } from "./sections/states";
import { colorTokenCount, durations, typeScale } from "./token-specimens";
import type { ThemeTokens } from "./tokens";

type Counts = { components: number };

export function DesignSystemPage({ tokens, counts }: { tokens: ThemeTokens; counts: Counts }) {
  return (
    <AppShell
      activeHref="/design"
      crumbs={[organization.name, "Designsystem"]}
      role="owner"
      user={{ name: "Wilhelm Lindqvist", email: "wilhelm@binderlab.se" }}
      organizations={[
        { id: organization.id, name: organization.name, detail: `${machines.length} automater` },
      ]}
      activeOrganizationId={organization.id}
      todoCount={todos.length}
      syncedAt={SYNCED_AT}
      syncState="ok"
      stores={shellStores}
      machines={shellMachines}
      earliest={FIRST_DAY}
    >
      <div className="mx-auto w-full max-w-[1280px] px-4 md:px-8">
        <Suspense fallback={<div className="min-h-dvh" />}>
          <Specimen tokens={tokens} counts={counts} />
        </Suspense>
      </div>
    </AppShell>
  );
}

type IndexEntry = { id: string; name: string; count: string };

function Specimen({ tokens, counts }: { tokens: ThemeTokens; counts: Counts }) {
  const sp = useSearchParams();
  const model = useMemo(() => {
    const period = parsePeriod(sp, { now: REF_NOW, earliest: FIRST_DAY });
    const fallback = { start: FIRST_DAY, end: period.today };
    return buildModel(period, parseScope(sp), fallback);
  }, [sp]);

  // Ordning för en genomgång: siffrorna först (nyckeltal, diagram, tillstånd,
  // rapport och mejl), sedan grunderna och sist ordmärket.
  const sections: Array<IndexEntry & { render: (i: number) => ReactNode }> = [
    {
      id: "nyckeltal",
      name: "Nyckeltal och tabeller",
      count: `${formatInt(model.t.orders)} ordrar`,
      render: (i) => <MetricsSection index={i} model={model} />,
    },
    {
      id: "diagram",
      name: "Diagram",
      count: `${CHART_COUNT} diagram`,
      render: (i) => <ChartsSection index={i} model={model} />,
    },
    {
      id: "tillstand",
      name: "Tillstånd",
      count: `${STATE_COUNT} lägen`,
      render: (i) => <StatesSection index={i} model={model} />,
    },
    {
      id: "utskrift",
      name: "Utskrift",
      count: `${EXAMPLE_PAGE_COUNT} sidor A4`,
      render: (i) => <PrintSection index={i} />,
    },
    {
      id: "e-post",
      name: "E-post",
      count: `${RECIPIENT_KINDS.length} mottagare`,
      render: (i) => <EmailSection index={i} />,
    },
    {
      id: "farg",
      name: "Färg och lägen",
      count: `${colorTokenCount} tokens`,
      render: (i) => <ColorSection index={i} tokens={tokens} />,
    },
    {
      id: "typografi",
      name: "Typografi",
      count: `${typeScale("").length} steg`,
      render: (i) => <TypeSection index={i} model={model} />,
    },
    {
      id: "matt",
      name: "Mått och rörelse",
      count: `${durations.length} tider`,
      render: (i) => <MeasureSection index={i} model={model} />,
    },
    {
      id: "kontroller",
      name: "Kontroller",
      count: `${iconNames.length} ikoner`,
      render: (i) => <ControlsSection index={i} />,
    },
    {
      id: "kommandopalett",
      name: "Kommandopalett",
      count: `${COMMAND_COUNT} kommandon`,
      render: (i) => <CommandSection index={i} />,
    },
    {
      id: "formatering",
      name: "Formatering",
      count: `${FORMAT_RULE_COUNT} regler`,
      render: (i) => <FormatSection index={i} />,
    },
    {
      id: "varumarke",
      name: "Ordmärke",
      count: `${Object.keys(SYMBOL_PARTS).length} delar`,
      render: (i) => <BrandSection index={i} />,
    },
  ];

  return (
    <>
      <Intro entries={sections} />
      {sections.map((s, i) => (
        <div key={s.id}>{s.render(i + 1)}</div>
      ))}
      <Colophon counts={counts} />
    </>
  );
}

/**
 * Inledningen: vad sidan är och ett innehållsindex i mono. Inga principer i
 * rutor; räknarna kommer ur samma data och tokens som sektionerna.
 */
function Intro({ entries }: { entries: ReadonlyArray<IndexEntry> }) {
  return (
    <header className="grid grid-cols-1 gap-x-8 gap-y-12 pt-12 pb-16 md:pt-16 lg:grid-cols-12 lg:pb-20">
      <div className="flex min-w-0 flex-col gap-5 lg:col-span-7">
        <p className="label text-subtle">
          Designsystem · uppdaterad {formatDate(REF_NOW, { year: "always" })}
        </p>
        <h1 className="text-3xl font-medium text-balance hyphens-none md:text-display">
          Binderlab designsystem. {/* Den grå delen bryts bara mellan leden, aldrig inuti ett. */}
          <span className="text-subtle">
            {["1 signalfärg,", "2 typsnitt,", "3 radier."].map((t, i) => (
              <Fragment key={t}>
                {i > 0 ? " " : null}
                <span className="whitespace-nowrap">{t.replace(" ", NBSP)}</span>
              </Fragment>
            ))}
          </span>
        </h1>
        <p className="max-w-xl text-md text-muted">
          Tokens, komponenter och diagram för kontrollpanelen och rapporterna.
        </p>
      </div>
      <nav aria-label="Innehåll" className="min-w-0 lg:col-span-5 lg:pt-1">
        <ol className="border-t border-line">
          {entries.map((e, i) => (
            <li key={e.id} className="border-b border-line">
              <a
                href={`#${e.id}`}
                className="group flex h-9 items-center gap-3 rounded-xs font-mono text-xs text-muted transition-colors hover:text-fg"
              >
                <span className="tnum w-5 shrink-0 text-subtle">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="shrink-0 text-fg">{e.name}</span>
                <span
                  aria-hidden
                  className="mx-1 h-px min-w-4 flex-1 border-b border-dotted border-line-strong"
                />
                <span className="tnum shrink-0 text-right">{e.count}</span>
              </a>
            </li>
          ))}
        </ol>
      </nav>
    </header>
  );
}

function Colophon({ counts }: { counts: Counts }) {
  const parts = [
    "Binderlab",
    "Designsystem",
    `uppdaterad ${formatDate(REF_NOW, { year: "always" })}`,
    `${colorTokenCount}${NBSP}färgtokens`,
    `${counts.components}${NBSP}komponenter`,
    `${CHART_COUNT}${NBSP}diagram`,
  ];
  return (
    <footer className="border-t border-line py-8">
      <p className="meta tnum text-subtle">{parts.join(" · ")}</p>
    </footer>
  );
}
