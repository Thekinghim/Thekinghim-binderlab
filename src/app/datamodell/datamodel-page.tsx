"use client";

import { useState, type ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import type { Period } from "@/components/shell/topbar";
import { Panel } from "@/components/ui/frame";
import { SectionHeader } from "@/components/ui/section-header";
import { cn } from "@/lib/cn";
import { ErDiagram } from "./er-diagram";
import { domains, tables } from "./schema";

const decisions: Array<[string, string]> = [
  ["Moms", "Ingen. vat_rate_bp = 0, beräkningarna klarar moms om det ändras."],
  ["Provision", "Alltid på belopp exkl. moms. Hyra proportioneras per dag vid delmånad."],
  ["Kortavgift", "Inte med i beräkningarna nu. card_fee_bp = 0."],
  [
    "Källans tidszon",
    "Troligen Asia/Shanghai. Inställning per datakälla, verifieras mot order 42780.",
  ],
  [
    "Ändrade order",
    "Förekommer inte. Avvikande källrad loggas som konflikt, ordern ändras aldrig.",
  ],
  ["Pack per order", "Alltid 1. Varje order är ett pack."],
  ["Perioder", "Månadsstängning med ögonblicksbild. Bara ägaren kan öppna igen."],
  ["Användare", "Ägare + delägare (läsare) via inbjudan."],
];

const roles: Array<[string, string, string, string]> = [
  ["Ägare", "Allt", "Allt, inkl. roller, ägarandelar och att öppna stängd månad", "owner"],
  ["Admin", "Allt", "Allt utom ägarroll, ägarandelar och öppna stängd månad", "admin"],
  [
    "Påfyllare",
    "Tillåtlista: butiker, automater, titlar, lager",
    "Lagerhändelser i eget namn",
    "refiller",
  ],
  ["Läsare", "Allt utom medlemshantering", "Inget", "viewer"],
];

const sources: Array<[string, string, string]> = [
  [
    "awish_grpc",
    "Mål",
    "Schemalagd hämtning var femte minut via Awishs gRPC-API med app-ID. Kräver .proto, token-beräkning och TLS-uppgifter från Awish.",
  ],
  [
    "awish_csv",
    "Nu",
    "Uppladdning på Datakällor: förhandsvisning, kolumnmappning, dubblettkontroll, logg.",
  ],
  ["awish_web", "Reserv", "Serverhämtning av orderlistan. Bara om gRPC dröjer."],
  [
    "manual_csv",
    "Nu",
    "Annan automatplattform: försäljningen laddas upp som CSV (Datum, Automat, Produkt, Belopp).",
  ],
];

function Rows({ rows, cols }: { rows: ReactNode[][]; cols: string }) {
  return (
    <div className="flex flex-col">
      {rows.map((r, i) => (
        <div
          key={i}
          className={cn("grid gap-x-6 gap-y-1 border-b border-line py-3 last:border-b-0", cols)}
        >
          {r.map((c, j) => (
            <div key={j} className="min-w-0">
              {c}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function DataModelPage() {
  const [period, setPeriod] = useState<Period>("30d");
  const refillerCount = tables.filter((t) => t.access === "refiller").length;
  const newCount = tables.filter((t) => t.isNew).length;

  return (
    <AppShell
      activeHref="/datamodell"
      crumbs={["Binderlab", "Fas 2", "Datamodell"]}
      period={period}
      onPeriodChange={setPeriod}
    >
      <div className="mx-auto w-full max-w-[1440px] px-4 md:px-8">
        <section className="pt-12 pb-10 md:pt-16">
          <SectionHeader
            as="h1"
            index="F2"
            eyebrow="Datamodell v2 · för godkännande"
            title={`${tables.length} tabeller i ${Object.keys(domains).length} områden.`}
            aside={`Varje rad har en organisation, varje belopp är i öre, ${refillerCount} tabeller syns för påfyllare.`}
            description="Inga migreringar är skrivna. Fullständig specifikation med regler finns i docs/datamodell.md."
          />
          <dl className="label mt-8 flex flex-wrap gap-x-6 gap-y-2 text-subtle">
            <div className="flex items-center gap-2">
              <span aria-hidden className="size-2 bg-fg" />
              <dt>Påfyllare ser</dt>
            </div>
            <div className="flex items-center gap-2">
              <span aria-hidden className="size-2 border border-subtle" />
              <dt>Endast ägare, admin, läsare</dt>
            </div>
            <div className="flex items-center gap-2">
              <span aria-hidden className="rounded-xs border border-fg px-1 text-[9px] text-fg">
                NY
              </span>
              <dt>{newCount} nya i v2</dt>
            </div>
            <div className="flex items-center gap-2">
              <span aria-hidden className="rounded-xs border border-line-control px-1 text-[9px]">
                APPEND
              </span>
              <dt>Bara tillägg, aldrig ändring</dt>
            </div>
            <div className="flex items-center gap-2">
              <span aria-hidden className="h-2 w-4 border border-dashed border-line-control" />
              <dt>Vy</dt>
            </div>
            <div className="flex items-center gap-2">
              <dt>PK · FK · UQ</dt>
            </div>
          </dl>
        </section>
      </div>

      <div className="border-y border-line bg-bg">
        <div className="px-0 md:px-4">
          <ErDiagram />
        </div>
      </div>

      <div className="mx-auto w-full max-w-[1440px] px-4 md:px-8">
        <div className="grid gap-x-12 gap-y-16 py-16 lg:grid-cols-12">
          <section className="lg:col-span-7" aria-labelledby="beslut">
            <p id="beslut" className="label mb-3 text-subtle">
              01 / Beslut från dig
            </p>
            <Rows
              cols="sm:grid-cols-[160px_1fr]"
              rows={decisions.map(([k, v]) => [
                <span key="k" className="text-fg">
                  {k}
                </span>,
                <span key="v" className="text-muted">
                  {v}
                </span>,
              ])}
            />
          </section>

          <section className="lg:col-span-5" aria-labelledby="roller">
            <p id="roller" className="label mb-3 text-subtle">
              02 / Roller · kontroll i server och RLS
            </p>
            <Rows
              cols="grid-cols-[96px_1fr]"
              rows={roles.map(([r, read, write, key]) => [
                <span key="r" className="flex flex-col">
                  <span className="text-fg">{r}</span>
                  <span className="label tracking-normal text-subtle normal-case">{key}</span>
                </span>,
                <span
                  key="d"
                  className="flex flex-col gap-0.5 text-sm max-md:min-h-11 max-md:justify-center"
                >
                  <span className="text-muted">
                    <span className="label mr-2 text-subtle">Läser</span>
                    {read}
                  </span>
                  <span className="text-muted">
                    <span className="label mr-2 text-subtle">Skriver</span>
                    {write}
                  </span>
                </span>,
              ])}
            />
          </section>

          <section className="lg:col-span-7" aria-labelledby="awish">
            <p id="awish" className="label mb-3 text-subtle">
              03 / Awish som adapter · samma import efter adaptern
            </p>
            <Rows
              cols="sm:grid-cols-[120px_72px_1fr]"
              rows={sources.map(([k, s, d]) => [
                <span key="k" className="font-mono text-sm text-fg">
                  {k}
                </span>,
                <span key="s" className="label text-subtle">
                  {s}
                </span>,
                <span key="d" className="text-muted">
                  {d}
                </span>,
              ])}
            />
          </section>

          <section className="lg:col-span-5" aria-labelledby="oppet">
            <p id="oppet" className="label mb-3 text-subtle">
              04 / Öppna punkter · stoppar inte migreringarna
            </p>
            <Panel padded className="flex flex-col gap-3 text-muted">
              <p>
                <span className="label mr-2 text-fg">1</span>Awish gRPC-specifikation och
                token-beräkning. CSV används tills dess.
              </p>
              <p>
                <span className="label mr-2 text-fg">2</span>Källans tidszon: Asia/Shanghai
                verifieras mot order 42780 vid första riktiga importen.
              </p>
            </Panel>
          </section>
        </div>
      </div>
    </AppShell>
  );
}
