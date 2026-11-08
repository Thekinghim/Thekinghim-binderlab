"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { IconName } from "@/components/ui/icon";
import { matchFields, TIER, type FieldMatch } from "@/lib/fuzzy";
import type { CarryMode, SearchHit, SearchKind } from "@/server/search/types";

import { CommandDialog, type PaletteRow, type PaletteSection } from "./command-dialog";
import { machineLabel, withCarried } from "./command-links";
import { useCopyView } from "./copy-view";
import {
  isInternalHref,
  purgeForeignRecent,
  pushRecent,
  readRecent,
  recentKey,
  writeRecent,
  type RecentEntry,
} from "./command-recent";
import { remoteData, searchKey, usePickList, useRemoteSearch } from "./command-search";
import {
  activeRouteId,
  homeHref,
  routeById,
  routesForRole,
  sectionsForRole,
  subTabHref,
  type Role,
  type RouteId,
} from "./nav";
import type { ShellMachine, ShellStore } from "./period-bar";
import { PERIOD_PARAM, type PeriodKey } from "./period-state";
import { setTheme, useTheme } from "./theme-toggle";
import { usePeriod, useScope } from "./use-period";

/**
 * Appens kommandopalett (⌘K / Ctrl K): sökning på servern i order, titlar, automater
 * och butiker (GET /sok, rollfiltrerad), åtgärder, navigation till rollens sidor och
 * perioder. Senaste valen sparas lokalt per organisation, användare och roll.
 *
 * Åtgärder med steg: "Registrera påfyllning" (välj automat, välj titel → Lager med
 * registreringsdialogen öppen) och "Lägg in inköpspris" (välj titel → Inköpspriser).
 */

type Step =
  | { kind: "refill-machine"; title?: { id: string; name: string } }
  | { kind: "refill-title"; machine: ShellMachine }
  | { kind: "price-title" };

type Command = {
  id: string;
  group: "actions" | "navigate" | "period" | "filter";
  label: string;
  icon: IconName;
  keywords?: string[];
  /** Visas bara när man söker (t.ex. ett filter per butik). */
  searchOnly?: boolean;
  opensStep?: boolean;
  run: () => void;
};

const GROUP_LABEL: Record<Command["group"], string> = {
  actions: "Åtgärder",
  navigate: "Navigera",
  period: "Period",
  filter: "Filter",
};

const KIND_ICON: Record<SearchKind, IconName> = {
  order: "sales",
  title: "inventory",
  machine: "machine",
  store: "columns",
};

const OPERATORS: readonly Role[] = ["owner", "admin"];
const REFILLERS: readonly Role[] = ["owner", "admin", "refiller"];

const PERIOD_LABEL: Partial<Record<PeriodKey, string>> = {
  idag: "Visa i dag",
  "7d": "Visa senaste 7 dagarna",
  "30d": "Visa senaste 30 dagarna",
  manad: "Visa denna månad",
  allt: "Visa hela historiken",
};

function strong(m: FieldMatch | null): boolean {
  return !!m && m.tier >= TIER.wordStart;
}

function indicesFor(m: FieldMatch | null, field: "label" | "hint") {
  return m && m.field === field ? m.indices : null;
}

export function CommandMenu({
  open,
  onOpenChange,
  role,
  organizationId,
  userEmail,
  stores,
  machines,
  onSignOut,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role: Role;
  organizationId: string;
  userEmail: string;
  stores: ShellStore[];
  machines: ShellMachine[];
  onSignOut: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { key: periodKey, setPeriod } = usePeriod();
  const { butik, automat, setScope } = useScope();
  const theme = useTheme();
  const copyView = useCopyView();

  const [query, setQuery] = useState("");
  const [step, setStep] = useState<Step | null>(null);
  // Ny session vid varje öppning och organisationsbyte: tömmer sökminnet.
  const [session, setSession] = useState(0);
  const resetToken = `${organizationId}:${session}`;

  const storageKey = recentKey({ organizationId, user: userEmail, role });
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  // Andra användares sparade val (och egna för en annan roll) tas bort direkt, även
  // om paletten aldrig öppnas: localStorage kan läsas av den som sitter vid datorn.
  useEffect(() => {
    if (organizationId) purgeForeignRecent({ organizationId, user: userEmail, role });
  }, [organizationId, userEmail, role]);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => setRecent(readRecent(storageKey)), 0);
    return () => clearTimeout(t);
  }, [open, storageKey]);

  const routeId = activeRouteId(pathname);
  const hasContext = routeId ? routeById(routeId).context !== false : false;

  const remote = useRemoteSearch(query, open && step === null, resetToken);
  const pickRequest = useMemo(
    () =>
      step?.kind === "refill-title"
        ? { list: "pafyllning" as const, machineId: step.machine.id }
        : step?.kind === "price-title"
          ? { list: "inkopspris" as const }
          : null,
    [step],
  );
  const picks = usePickList(open ? pickRequest : null, resetToken);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setQuery("");
        setStep(null);
        setSession((s) => s + 1);
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const remember = useCallback(
    (entry: RecentEntry) => {
      const next = pushRecent(readRecent(storageKey), entry);
      writeRecent(storageKey, next);
      setRecent(next);
    },
    [storageKey],
  );

  /** Stänger först (fokus återställs) och går sedan till länken. */
  const go = useCallback(
    (href: string, carry: CarryMode) => {
      handleOpenChange(false);
      router.push(withCarried(href, carry, searchParams));
    },
    [handleOpenChange, router, searchParams],
  );

  const enterStep = useCallback((next: Step | null) => {
    setStep(next);
    setQuery("");
  }, []);

  // ------------------------------------------------------------------ kommandon
  const commands = useMemo<Command[]>(() => {
    const out: Command[] = [];
    const can = (roles: readonly Role[]) => roles.includes(role);
    const routeAllowed = (id: RouteId) => routeById(id).roles.includes(role);

    if (can(REFILLERS)) {
      out.push({
        id: "action-refill",
        group: "actions",
        label: "Registrera påfyllning",
        icon: "inventory",
        keywords: ["påfyllning", "fyll på", "lager", "besök", "pack"],
        opensStep: true,
        run: () => enterStep({ kind: "refill-machine" }),
      });
    }
    if (can(OPERATORS) && routeAllowed("datakallor")) {
      out.push({
        id: "action-import",
        group: "actions",
        label: "Importera CSV",
        icon: "download",
        keywords: ["import", "awish", "orderlista", "ladda upp", "datakällor"],
        run: () => go("/datakallor", "none"),
      });
    }
    if (can(OPERATORS) && routeAllowed("rapporter")) {
      out.push({
        id: "action-report",
        group: "actions",
        label: "Skapa rapport",
        icon: "report",
        keywords: ["rapport", "månadsrapport", "utskick", "pdf"],
        run: () => go("/rapporter#ny-rapport", "none"),
      });
    }
    if (can(OPERATORS) && routeAllowed("inkopspriser")) {
      out.push({
        id: "action-price",
        group: "actions",
        label: "Lägg in inköpspris",
        icon: "plus",
        keywords: ["inköpspris", "pris", "kostnad", "inköp"],
        opensStep: true,
        run: () => enterStep({ kind: "price-title" }),
      });
    }
    if (routeAllowed("drift")) {
      out.push({
        id: "action-notices",
        group: "actions",
        label: "Notiser i mobilen",
        icon: "alert",
        keywords: ["notiser", "push", "larm", "mobil", "iphone", "telefon"],
        run: () => go("/drift/larm", "none"),
      });
    }
    if (can(OPERATORS) && routeAllowed("installningar")) {
      out.push({
        id: "action-invite",
        group: "actions",
        label: "Bjud in användare",
        icon: "plus",
        keywords: ["inbjudan", "användare", "delägare", "roll", "behörighet"],
        run: () => go("/installningar/anvandare", "none"),
      });
    }
    if (hasContext) {
      out.push({
        id: "action-copy-view",
        group: "actions",
        label: "Kopiera länk till vyn",
        icon: "external",
        keywords: ["kopiera", "länk", "dela", "url", "vy"],
        run: () => {
          handleOpenChange(false);
          void copyView();
        },
      });
    }
    out.push({
      id: "action-theme",
      group: "actions",
      label: theme === "dark" ? "Byt till ljust läge" : "Byt till mörkt läge",
      icon: theme === "dark" ? "sun" : "moon",
      keywords: ["tema", "läge", "mörkt", "ljust"],
      run: () => {
        handleOpenChange(false);
        setTheme(theme === "dark" ? "light" : "dark");
      },
    });
    if (hasContext && (butik || automat)) {
      out.push({
        id: "action-scope-clear",
        group: "actions",
        label: "Rensa filter på butik och automat",
        icon: "filter",
        keywords: ["filter", "alla"],
        run: () => {
          handleOpenChange(false);
          setScope({ butik: null, automat: null });
        },
      });
    }
    out.push({
      id: "action-logout",
      group: "actions",
      label: "Logga ut",
      icon: "logout",
      run: () => {
        handleOpenChange(false);
        onSignOut();
      },
    });

    for (const r of routesForRole(role)) {
      out.push({
        id: `nav-${r.id}`,
        group: "navigate",
        label: r.label,
        icon: r.icon,
        keywords: [r.lead].filter((k): k is string => !!k),
        run: () => go(r.href, r.context === false ? "none" : "all"),
      });
    }

    // Underflikar som är en vy på en sida (Bokföring på Ekonomi) är egna mål i paletten.
    for (const section of sectionsForRole(role)) {
      for (const t of section.tabs) {
        if (!t.view) continue;
        const r = routeById(t.route);
        out.push({
          id: `nav-${t.key}`,
          group: "navigate",
          label: t.label,
          icon: r.icon,
          keywords: [section.label, r.label],
          run: () => go(subTabHref(t), r.context === false ? "none" : "all"),
        });
      }
    }

    for (const [key, label] of Object.entries(PERIOD_LABEL) as [PeriodKey, string][]) {
      if (key === periodKey && hasContext) continue;
      out.push({
        id: `period-${key}`,
        group: "period",
        label,
        icon: "calendar",
        keywords: ["period", "datum", "tid", "dagar"],
        run: () => {
          if (hasContext) {
            handleOpenChange(false);
            setPeriod({ key: key as Exclude<PeriodKey, "eget"> });
          } else {
            go(`${homeHref(role)}?${PERIOD_PARAM}=${key}`, "none");
          }
        },
      });
    }

    // Butiksfilter (bara där sidan har period och filter, och inte för påfyllaren).
    if (hasContext && role !== "refiller") {
      for (const st of stores) {
        out.push({
          id: `filter-${st.id}`,
          group: "filter",
          label: butik === st.id ? `${st.name} (filtrerad)` : `Filtrera på ${st.name}`,
          icon: "filter",
          keywords: [st.name, st.city, "butik", "filter"].filter((k): k is string => !!k),
          searchOnly: true,
          run: () => {
            handleOpenChange(false);
            setScope({ butik: st.id, automat: null });
          },
        });
      }
    }
    return out;
  }, [
    role,
    theme,
    hasContext,
    butik,
    automat,
    periodKey,
    stores,
    enterStep,
    go,
    handleOpenChange,
    setScope,
    setPeriod,
    onSignOut,
    copyView,
  ]);

  const commandById = useMemo(() => new Map(commands.map((c) => [c.id, c])), [commands]);

  // ------------------------------------------------------------------ rader
  const q = searchKey(query);

  const commandRow = useCallback(
    (c: Command, m: FieldMatch | null): PaletteRow => ({
      id: c.id,
      label: c.label,
      labelIndices: indicesFor(m, "label"),
      icon: c.icon,
      opensStep: c.opensStep,
      onSelect: () => {
        remember({ type: "command", id: c.id });
        c.run();
      },
    }),
    [remember],
  );

  const hitRow = useCallback(
    (hit: SearchHit): PaletteRow => {
      const m = q ? matchFields(q, { label: hit.label, hint: hit.code }) : null;
      return {
        id: hit.id,
        label: hit.label,
        labelIndices: indicesFor(m, "label"),
        code: hit.code,
        codeIndices: indicesFor(m, "hint"),
        meta: hit.meta,
        icon: KIND_ICON[hit.kind],
        opensStep: hit.step !== undefined,
        onSelect: () => {
          if (hit.step === "refill-machine") {
            enterStep({ kind: "refill-machine", title: { id: hit.entityId, name: hit.label } });
            return;
          }
          if (!hit.href) return;
          remember({
            type: "link",
            id: hit.id,
            label: hit.label,
            code: hit.code,
            meta: hit.meta,
            href: hit.href,
            carry: hit.carry,
          });
          go(hit.href, hit.carry);
        },
      };
    },
    [q, enterStep, remember, go],
  );

  const sections = useMemo<PaletteSection[]>(() => {
    // Steg: välj automat eller titel.
    if (step?.kind === "refill-machine") {
      const rows = machines
        .map((m) => {
          const store = stores.find((s) => s.id === m.storeId);
          const label = machineLabel(m);
          const match = q
            ? matchFields(q, { label, hint: store?.name, keywords: [store?.city ?? ""] })
            : null;
          return { m, store, label, match };
        })
        .filter((r) => !q || r.match)
        .sort((a, b) => (q ? (b.match?.score ?? 0) - (a.match?.score ?? 0) : 0))
        .map(({ m, store, label, match }): PaletteRow => ({
          id: `pick-machine-${m.id}`,
          label,
          labelIndices: indicesFor(match, "label"),
          meta: store ? [store.name] : [],
          icon: "machine",
          opensStep: !step.title,
          onSelect: () => {
            if (step.title) {
              go(
                `/lager?${new URLSearchParams({ automat: m.id, titel: step.title.id })}`,
                "period",
              );
            } else {
              enterStep({ kind: "refill-title", machine: m });
            }
          },
        }));
      return [{ id: "machines", label: "Välj automat", rows }];
    }
    if (step) {
      const data = remoteData(picks);
      return (data?.groups ?? []).map((g, gi) => ({
        id: `pick-${gi}`,
        label: g.label,
        count: q ? undefined : g.items.length,
        rows: g.items
          .map((item) => ({
            item,
            match: q ? matchFields(q, { label: item.label, keywords: item.keywords }) : null,
          }))
          .filter((r) => !q || r.match)
          .map(({ item, match }): PaletteRow => ({
            id: `pick-${gi}-${item.id}`,
            label: item.label,
            labelIndices: indicesFor(match, "label"),
            meta: item.meta,
            icon: "inventory",
            onSelect: () => {
              if (step.kind === "refill-title") {
                go(
                  `/lager?${new URLSearchParams({ automat: step.machine.id, titel: item.id })}`,
                  "period",
                );
              } else {
                go(`/inkopspriser?titel=${encodeURIComponent(item.id)}`, "all");
              }
            },
          })),
      }));
    }

    // Ingen söktext: senaste, åtgärder, sidor och perioder.
    if (!q) {
      const recentRows: PaletteRow[] = [];
      for (const e of recent) {
        if (e.type === "command") {
          const c = commandById.get(e.id);
          if (c && !c.searchOnly) recentRows.push({ ...commandRow(c, null), id: `recent-${c.id}` });
        } else if (isInternalHref(e.href)) {
          const kind = e.id.split(":")[0] as SearchKind;
          recentRows.push({
            id: `recent-${e.id}`,
            label: e.label,
            code: e.code,
            meta: e.meta,
            icon: KIND_ICON[kind] ?? "search",
            onSelect: () => {
              remember(e);
              go(e.href, e.carry);
            },
          });
        }
      }
      const byGroup = (group: Command["group"]) =>
        commands.filter((c) => c.group === group && !c.searchOnly).map((c) => commandRow(c, null));
      return [
        { id: "recent", label: "Senaste", rows: recentRows },
        { id: "actions", label: GROUP_LABEL.actions, rows: byGroup("actions") },
        { id: "navigate", label: GROUP_LABEL.navigate, rows: byGroup("navigate") },
        { id: "period", label: GROUP_LABEL.period, rows: byGroup("period") },
      ];
    }

    // Söktext: lokala träffar och serverns grupper.
    const local = (["actions", "navigate", "period", "filter"] as const)
      .map((group) => {
        const matched = commands
          .filter((c) => c.group === group)
          .map((c) => ({ c, m: matchFields(q, c) }))
          // Ett filter per butik ger brus som delsekvens ("asc" i "Spelbutiken Centrum").
          .filter(
            (r): r is { c: Command; m: FieldMatch } =>
              r.m !== null && (!r.c.searchOnly || r.m.tier >= TIER.substring),
          )
          .sort((a, b) => b.m.score - a.m.score);
        return {
          section: {
            id: group,
            label: GROUP_LABEL[group],
            rows: matched.map((r) => commandRow(r.c, r.m)),
          },
          strong: matched.some((r) => strong(r.m)),
          best: matched[0]?.m.score ?? -Infinity,
        };
      })
      .filter((g) => g.section.rows.length > 0)
      .sort((a, b) => b.best - a.best);

    const data = remoteData(remote);
    // Föregående svar visas medan nästa laddas, men bara om det gällde början av frågan.
    const usable =
      data && (data.query === q || (remote.status === "loading" && q.startsWith(data.query)))
        ? data
        : null;
    const server: PaletteSection[] = (usable?.groups ?? []).map((g) => ({
      id: `remote-${g.kind}`,
      label: g.label,
      rows: [
        ...g.hits.map(hitRow),
        ...(g.more
          ? [
              {
                id: `more-${g.kind}`,
                label: g.more.label,
                icon: "arrowUpRight" as const,
                onSelect: () => go(g.more!.href, "none"),
              },
            ]
          : []),
      ],
    }));

    return [
      ...local.filter((g) => g.strong).map((g) => g.section),
      ...server,
      ...local.filter((g) => !g.strong).map((g) => g.section),
    ];
  }, [
    step,
    q,
    machines,
    stores,
    picks,
    recent,
    commands,
    commandById,
    commandRow,
    hitRow,
    remote,
    remember,
    go,
    enterStep,
  ]);

  // ------------------------------------------------------------------ status
  const rowCount = sections.reduce((n, s) => n + s.rows.length, 0);
  const loading = step ? picks.status === "loading" : remote.status === "loading";
  const failed = step
    ? picks.status === "error"
      ? picks.message
      : null
    : remote.status === "error"
      ? remote.message
      : null;
  const status = loading
    ? "Söker …"
    : failed
      ? failed
      : q || step
        ? `${rowCount} ${rowCount === 1 ? "träff" : "träffar"}`
        : `${rowCount} kommandon`;

  const placeholder =
    step?.kind === "refill-machine"
      ? "Välj automat"
      : step
        ? "Välj titel"
        : // Kort, så att texten inte klipps på en iPhone SE (åtgärderna står i listan under).
          role === "refiller"
          ? "Sök titel, automat eller butik"
          : "Sök order, titel, automat, butik";

  const stepInfo = step
    ? {
        label:
          step.kind === "refill-machine"
            ? step.title
              ? `Påfyllning · ${step.title.name}`
              : "Registrera påfyllning"
            : step.kind === "refill-title"
              ? `Påfyllning · ${machineLabel(step.machine)}`
              : "Lägg in inköpspris",
        onBack: () => enterStep(step.kind === "refill-title" ? { kind: "refill-machine" } : null),
      }
    : null;

  const waiting = loading || (!step && q !== "" && remote.status === "idle");
  const empty =
    rowCount === 0 && !waiting ? (
      <div className="flex flex-col gap-2">
        <p className="font-mono text-sm break-words text-muted">
          <span className="tnum text-fg">0</span> träffar
          {q ? ` för ”${q}”` : ""}
        </p>
        {failed ? <p className="text-sm text-muted">{failed}</p> : null}
        {!step && !failed ? (
          <p className="text-sm text-muted">
            {role === "refiller"
              ? "Sökningen gäller titlar, automater, butiker, sidor och åtgärder."
              : "Sökningen gäller ordernummer, titlar, automater, butiker, sidor och åtgärder."}
          </p>
        ) : null}
      </div>
    ) : null;

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      query={query}
      onQueryChange={setQuery}
      sections={sections}
      placeholder={placeholder}
      step={stepInfo}
      status={status}
      busy={loading}
      empty={empty}
    />
  );
}
