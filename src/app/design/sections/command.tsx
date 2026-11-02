"use client";

import { useMemo, useState } from "react";
import { Kbd } from "@/components/shell/kbd";
import { routesForRole } from "@/components/shell/nav";
import { Button } from "@/components/ui/button";
import {
  CommandPalette,
  formatHotkey,
  useModifierKey,
  type CommandGroup,
} from "@/components/ui/command-palette";
import { fuzzyMatch, highlightSegments, TIER } from "@/lib/fuzzy";
import { NBSP } from "@/lib/format";
import { machines, stores, titles } from "../sample-data";
import { SpecSection, Sub } from "./section";

/** Paletten som skalet bygger för rollen Ägare, med verksamhetens butiker och automater. */
export function buildGroups(run: (label: string) => void): CommandGroup[] {
  const unpriced = titles.filter((t) => t.costOre === null);
  return [
    {
      label: "Navigera",
      items: routesForRole("owner").map((r) => ({
        id: `nav-${r.id}`,
        label: r.label,
        icon: r.icon,
        onSelect: () => run(r.label),
      })),
    },
    {
      label: "Butiker",
      items: stores.map((s) => ({
        id: `s-${s.id}`,
        label: `Filtrera på ${s.name}`,
        hint: `${s.city} · ${machines.filter((m) => m.storeId === s.id).length} automat`,
        icon: "filter" as const,
        keywords: [s.name, s.city, "butik", "filter"],
        onSelect: () => run(`Filtrera på ${s.name}`),
      })),
    },
    {
      label: "Automater",
      items: machines.map((m) => {
        const s = stores.find((x) => x.id === m.storeId);
        // Samma namn som i resten av panelen (id + butik); platsen i butiken som undertext.
        const label = `${m.code} ${s?.name ?? ""}`.trim();
        return {
          id: `m-${m.id}`,
          label,
          hint: m.name,
          icon: "machine" as const,
          keywords: [m.code, m.name, s?.name ?? "", s?.city ?? "", "automat"],
          onSelect: () => run(label),
        };
      }),
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
        ...unpriced.map((t) => ({
          id: `act-price-${t.id}`,
          label: `Lägg in inköpspris för ${t.name}`,
          icon: "margin" as const,
          keywords: ["inköp", "pris", t.name],
          onSelect: () => run(`Lägg in inköpspris för ${t.name}`),
        })),
        {
          id: "act-csv",
          label: "Exportera ordrar som CSV",
          icon: "download",
          keywords: ["ladda ner", "export", "awish"],
          shortcut: ["⇧", "E"],
          onSelect: () => run("Exportera ordrar som CSV"),
        },
        {
          id: "act-report-store",
          label: "Skapa rapport till butik",
          icon: "report",
          keywords: ["centrumledning", "hyra"],
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

/** Antal kommandon i paletten (för innehållsindexet). */
export const COMMAND_COUNT = buildGroups(() => {}).reduce((n, g) => n + g.items.length, 0);

const keys: Array<{ keys: string[]; action: string }> = [
  { keys: ["/"], action: "Öppna utanför textfält" },
  { keys: ["↑", "↓"], action: "Flytta, går runt i listan" },
  { keys: ["Home", "End"], action: "Första och sista träffen" },
  { keys: ["↵"], action: "Kör markerad rad" },
  { keys: ["Esc"], action: "Rensa fältet, andra gången stäng" },
];

const tiers: Array<{ tier: number; name: string; query: string; text: string }> = [
  { tier: TIER.prefix, name: "Prefix", query: "lön", text: "Lönsamhet" },
  { tier: TIER.wordStart, name: "Ordstart", query: "cent", text: "Väla Centrum" },
  { tier: TIER.substring, name: "Delsträng", query: "fyll", text: "Registrera påfyllning" },
  { tier: TIER.subsequence, name: "Subsekvens", query: "rpb", text: "Skapa rapport till butik" },
];

function TierRow({ tier, name, query, text }: (typeof tiers)[number]) {
  const m = fuzzyMatch(query, text);
  return (
    <li className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-3 gap-y-0.5 py-2.5">
      <span className="meta tnum text-fg">{tier}</span>
      <span className="text-sm text-muted">{name}</span>
      <span aria-hidden />
      <span className="meta flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 text-subtle">”{query}”</span>
        <span className="text-faint" aria-hidden>
          →
        </span>
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
  const n = String(index).padStart(2, "0");
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState<{ label: string; n: number } | null>(null);
  const mod = useModifierKey();
  const groups = useMemo(
    () => buildGroups((label) => setLast((prev) => ({ label, n: (prev?.n ?? 0) + 1 }))),
    [],
  );
  const hotkey = (formatHotkey(mod) || "⌘K").replace(" ", NBSP);

  return (
    <SpecSection
      id="kommandopalett"
      index={index}
      eyebrow="Kommandopalett"
      title={`${COMMAND_COUNT} kommandon bakom ${hotkey}.`}
      aside={`${groups.length} grupper, rangordnade på hur tidigt i ordet träffen sitter.`}
      actions={
        <Button
          iconLeft="search"
          kbd={formatHotkey(mod) || undefined}
          onClick={() => setOpen(true)}
        >
          Öppna paletten
        </Button>
      }
    >
      <Sub index={`${n}.1`} label="Paletten" meta="samma som i toppbaren" className="lg:col-span-7">
        <div className="flex min-w-0 flex-col gap-3">
          <CommandPalette inline groups={groups} listClassName="max-h-[520px]" />
          <p className="min-h-5 text-sm text-subtle" aria-live="polite">
            {last ? (
              <>
                Körde <span className="text-fg">{last.label}</span>
              </>
            ) : null}
          </p>
        </div>
      </Sub>

      <div className="flex min-w-0 flex-col gap-12 lg:col-span-5">
        <Sub index={`${n}.2`} label="Tangentbord" meta={`${keys.length + 1} kortkommandon`}>
          <dl className="divide-y divide-line">
            <div className="flex items-center justify-between gap-4 pb-2.5">
              <dt className="flex items-center gap-1 text-muted">
                <Kbd>{mod ?? "⌘"}</Kbd>
                <Kbd>K</Kbd>
              </dt>
              <dd className="text-right text-sm text-muted">Öppna och stäng</dd>
            </div>
            {keys.map((k) => (
              <div key={k.action} className="flex items-center justify-between gap-4 py-2.5">
                <dt className="flex items-center gap-1 text-muted">
                  {k.keys.map((key) => (
                    <Kbd key={key}>{key}</Kbd>
                  ))}
                </dt>
                <dd className="text-right text-sm text-muted">{k.action}</dd>
              </div>
            ))}
          </dl>
        </Sub>

        <Sub index={`${n}.3`} label="Rangordning" meta="4 nivåer">
          <ol className="divide-y divide-line">
            {tiers.map((t) => (
              <TierRow key={t.name} {...t} />
            ))}
          </ol>
          <p className="mt-3 text-sm text-muted">
            Å, ä och ö är egna bokstäver, så ”a” träffar inte ”å”. Ort och id söks som nyckelord.
          </p>
        </Sub>
      </div>

      <CommandPalette open={open} onOpenChange={setOpen} groups={groups} />
    </SpecSection>
  );
}
