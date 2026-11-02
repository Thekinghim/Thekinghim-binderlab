"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  CommandPalette,
  formatHotkey,
  useModifierKey,
  type CommandGroup,
} from "@/components/ui/command-palette";
import { PanelHeader } from "@/components/ui/frame";
import { SectionHeader } from "@/components/ui/section-header";
import { fuzzyMatch, highlightSegments, TIER } from "@/lib/fuzzy";
import { cn } from "@/lib/cn";

type Machine = { id: string; site: string; city: string };

const machines: Machine[] = [
  { id: "BL-001", site: "Mall of Scandinavia", city: "Solna" },
  { id: "BL-002", site: "Täby Centrum", city: "Täby" },
  { id: "BL-003", site: "Nordstan", city: "Göteborg" },
  { id: "BL-004", site: "Emporia", city: "Malmö" },
  { id: "BL-005", site: "Kungens Kurva", city: "Huddinge" },
  { id: "BL-006", site: "Väla Centrum", city: "Helsingborg" },
  { id: "BL-007", site: "Gränby Centrum", city: "Uppsala" },
  { id: "BL-008", site: "Triangeln", city: "Malmö" },
  { id: "BL-009", site: "Skrapan", city: "Västerås" },
  { id: "BL-010", site: "Mobilia", city: "Malmö" },
];

function buildGroups(run: (label: string) => void): CommandGroup[] {
  const nav = (
    id: string,
    label: string,
    hint: string,
    icon: CommandGroup["items"][number]["icon"],
  ) => ({
    id,
    label,
    hint,
    icon,
    onSelect: () => run(label),
  });
  return [
    {
      label: "Navigering",
      items: [
        nav("nav-oversikt", "Översikt", "G Ö", "overview"),
        nav("nav-forsaljning", "Försäljning", "G F", "sales"),
        nav("nav-automater", "Automater", "G A", "machine"),
        nav("nav-lager", "Lager", "G L", "inventory"),
        nav("nav-marginal", "Marginal", "G M", "margin"),
        nav("nav-rapporter", "Rapporter", "G R", "report"),
        nav("nav-installningar", "Inställningar", "G I", "settings"),
      ],
    },
    {
      label: "Automater",
      items: machines.map((m) => ({
        id: m.id,
        label: m.site,
        hint: m.id,
        keywords: [m.city],
        icon: "machine" as const,
        onSelect: () => run(`${m.id} ${m.site}`),
      })),
    },
    {
      label: "Åtgärder",
      items: [
        {
          id: "act-refill",
          label: "Registrera påfyllning",
          icon: "plus",
          keywords: ["fyll på", "lager"],
          shortcut: ["P"],
          onSelect: () => run("Registrera påfyllning"),
        },
        {
          id: "act-csv",
          label: "Exportera CSV",
          icon: "download",
          keywords: ["ladda ner", "export"],
          shortcut: ["⇧", "E"],
          onSelect: () => run("Exportera CSV"),
        },
        {
          id: "act-theme",
          label: "Byt till ljust läge",
          icon: "sun",
          keywords: ["tema", "mörkt"],
          onSelect: () => run("Byt till ljust läge"),
        },
        {
          id: "act-report-store",
          label: "Skapa rapport till butik",
          icon: "report",
          keywords: ["hyresvärd", "centrum"],
          onSelect: () => run("Skapa rapport till butik"),
        },
        {
          id: "act-report-books",
          label: "Skapa rapport till bokhållare",
          icon: "report",
          keywords: ["bokföring", "moms"],
          onSelect: () => run("Skapa rapport till bokhållare"),
        },
        {
          id: "act-report-partner",
          label: "Skapa rapport till delägare",
          icon: "report",
          onSelect: () => run("Skapa rapport till delägare"),
        },
      ],
    },
  ];
}

const keys: Array<{ keys: string[]; action: string }> = [
  { keys: ["/"], action: "Öppna utanför textfält" },
  { keys: ["↑", "↓"], action: "Flytta, går runt i listan" },
  { keys: ["Home", "End"], action: "Första och sista träffen" },
  { keys: ["↵"], action: "Kör markerad rad" },
  { keys: ["esc"], action: "Stäng, fokus tillbaka" },
];

const tiers: Array<{ tier: number; name: string; query: string; text: string }> = [
  { tier: TIER.prefix, name: "Prefix", query: "för", text: "Försäljning" },
  { tier: TIER.wordStart, name: "Ordstart", query: "scan", text: "Mall of Scandinavia" },
  { tier: TIER.substring, name: "Delsträng", query: "fyll", text: "Registrera påfyllning" },
  { tier: TIER.subsequence, name: "Subsekvens", query: "rpb", text: "Skapa rapport till butik" },
];

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-xs border border-line-strong px-1 font-mono text-[11px] leading-none text-muted">
      {children}
    </kbd>
  );
}

function TierRow({ tier, name, query, text }: (typeof tiers)[number]) {
  const m = fuzzyMatch(query, text);
  return (
    <li className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-3 gap-y-0.5 py-2.5">
      <span className="tnum font-mono text-xs text-fg">{tier}</span>
      <span className="text-sm text-muted">{name}</span>
      <span aria-hidden />
      <span className="flex min-w-0 items-baseline gap-2 font-mono text-xs">
        <span className="shrink-0 text-subtle">”{query}”</span>
        <span className="text-faint">→</span>
        <span className="truncate font-sans text-sm">
          {highlightSegments(text, m?.indices ?? []).map((s, i) => (
            <span
              key={i}
              className={
                s.match
                  ? "text-fg underline decoration-line-control underline-offset-4"
                  : "text-subtle"
              }
            >
              {s.text}
            </span>
          ))}
        </span>
      </span>
    </li>
  );
}

export function CommandSection({ index }: { index: number }) {
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState<{ label: string; n: number } | null>(null);
  const mod = useModifierKey();
  const groups = useMemo(
    () => buildGroups((label) => setLast((prev) => ({ label, n: (prev?.n ?? 0) + 1 }))),
    [],
  );
  const total = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <section
      id="kommandopalett"
      aria-labelledby="kommandopalett-title"
      className="border-t border-line py-16 md:py-20"
    >
      <SectionHeader
        id="kommandopalett-title"
        index={index}
        eyebrow="Kommandopalett"
        title={`${total} kommandon bakom ${formatHotkey(mod) || "⌘K"}.`}
        aside="Sidor, automater och åtgärder nås utan mus, rangordnade på hur tidigt i ordet träffen sitter."
        actions={
          <Button
            iconLeft="search"
            kbd={formatHotkey(mod) || undefined}
            onClick={() => setOpen(true)}
          >
            Öppna paletten
          </Button>
        }
      />

      <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-10">
        <div className="flex min-w-0 flex-col gap-3">
          <CommandPalette inline groups={groups} />
          <p
            className="flex min-w-0 items-center gap-2 font-mono text-xs text-subtle"
            aria-live="polite"
          >
            <span className="label shrink-0">Senast körd</span>
            <span className={cn("truncate", last ? "text-fg" : "text-subtle")}>
              {last ? last.label : "ingen ännu"}
            </span>
            {last ? <span className="tnum shrink-0 text-subtle">#{last.n}</span> : null}
          </p>
        </div>

        <div className="flex min-w-0 flex-col gap-8">
          <div>
            <PanelHeader
              label="Tangentbord"
              meta={mod ?? ""}
              className="border-b border-line pb-2"
            />
            <dl className="divide-y divide-line">
              <div className="flex items-center justify-between gap-4 py-2.5">
                <dt className="flex items-center gap-1">
                  <Kbd>{mod ?? "⌘"}</Kbd>
                  <Kbd>K</Kbd>
                </dt>
                <dd className="text-right text-sm text-muted">Öppna och stäng</dd>
              </div>
              {keys.map((k) => (
                <div key={k.action} className="flex items-center justify-between gap-4 py-2.5">
                  <dt className="flex items-center gap-1">
                    {k.keys.map((key) => (
                      <Kbd key={key}>{key}</Kbd>
                    ))}
                  </dt>
                  <dd className="text-right text-sm text-muted">{k.action}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div>
            <PanelHeader
              label="Rangordning"
              meta="src/lib/fuzzy.ts"
              className="border-b border-line pb-2"
            />
            <ol className="divide-y divide-line">
              {tiers.map((t) => (
                <TierRow key={t.name} {...t} />
              ))}
            </ol>
            <p className="mt-3 text-sm text-muted">
              Skiftlägesokänslig. Å, ä och ö är egna bokstäver, så ”a” träffar inte ”å”. Ort och id
              söks som nyckelord.
            </p>
          </div>
        </div>
      </div>

      <div className="mt-12 grid gap-8 md:grid-cols-2">
        <figure className="flex min-w-0 flex-col gap-3">
          <figcaption className="label text-subtle">Träff i id · ”bl-00”</figcaption>
          <CommandPalette
            inline
            groups={groups}
            defaultQuery="bl-00"
            listClassName="max-h-[236px]"
          />
        </figure>
        <figure className="flex min-w-0 flex-col gap-3">
          <figcaption className="label text-subtle">Tomt resultat · ”kvitto”</figcaption>
          <CommandPalette inline groups={groups} defaultQuery="kvitto" />
        </figure>
      </div>

      <CommandPalette open={open} onOpenChange={setOpen} groups={groups} />
    </section>
  );
}
