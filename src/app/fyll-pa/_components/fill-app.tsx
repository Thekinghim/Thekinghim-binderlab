"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
  type CSSProperties,
  type ReactNode,
} from "react";

import { newClientId, type QueuedRefill } from "@/components/pwa/refill-queue";
import { useUnsavedInput } from "@/components/pwa/unsaved-input";
import { useRefillQueue } from "@/components/pwa/use-refill-queue";
import { PlaceButtons } from "@/components/stock/place-buttons";
import { pickPlace } from "@/components/stock/place-text";
import { CountUp } from "@/components/ui/count-up";
import { FillBar as Bar } from "@/components/ui/fill-bar";
import { Icon } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { SimpleMenuButton, useSimpleShell } from "@/components/shell/simple-shell";
import { useFormat, useT } from "@/i18n/client";
import type { Messages } from "@/i18n/sv";
import { cn } from "@/lib/cn";
import { NBSP } from "@/lib/format";
import { rememberKey, useRemembered } from "@/lib/remembered";
import { useHydrated } from "@/lib/use-hydrated";

import { undoRefills, type AwishPushStatus } from "@/app/(app)/drift/actions";
import { Sheet } from "@/app/(app)/lager/_components/sheet";
import { registerCount } from "@/app/(app)/lager/actions";

import { refreshFill } from "../actions";
import { bringStore, useBring, useDone, type Done } from "../_lib/done-store";
import {
  applyAdjustments,
  chooseSource,
  fillHeadline,
  fullFastNote,
  fillAllQty,
  maxFill,
  mysteryNote,
  qtyAfterCount,
  needLabel,
  pairKey,
  splitRefill,
  toggleBring,
  type FillAdjustment,
  type FillMachine,
  type FillRow,
  type SourceChoice,
} from "../_lib/model";
import type { FillData } from "../_lib/data";
import {
  clockLabel,
  lastAwishRead,
  refreshNotice,
  type RefreshNotice,
  type RefreshOutcome,
} from "../_lib/refresh";
import { FILL_BASE, machineIdFrom, shownMachineId, type FillNav } from "../_lib/route";
import { useFreshData } from "../_lib/use-fresh-data";
import { BringScreen } from "./bring-list";

export interface FillAppProps {
  /** Köns ägare: organisation och användare (samma som /drift/pafyllning). */
  readonly scope: string;
  readonly data: FillData;
  /** Organisationens tidszon (klockslagen "Awish läst 14:50"). */
  readonly timeZone: string;
  /** När servern renderade datan (ISO). En äldre sida (sparad i telefonen) hämtas om. */
  readonly renderedAt: string;
  /**
   * Automaten som sidan renderades för (/fyll-pa/<id>), null = listan. Används under
   * hydreringen: en sparad /fyll-pa (service workern utan nät) får inte krocka med adressen.
   */
  readonly initialMachineId?: string | null;
}

const BASE = FILL_BASE;
/** En Awish-läsning yngre än så här pulserar. */
const FRESH_MS = 30 * 60_000;
/** Uppdatera väntar högst så här länge på servern (Awish har en egen, kortare gräns). */
const REFRESH_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

const rise = (i: number) => ({ "--i": Math.min(i, 12) }) as CSSProperties;

/** Beskedet om Awish efter Klar, på personens språk (svenska: serverns text). */
function awishText(t: Messages, status: AwishPushStatus): string {
  if (t.locale === "sv" || !status.kind)
    return t.locale === "sv" ? status.message : t.serverError(status.message);
  switch (status.kind) {
    case "sent":
      return t.fill.awishSent(status.slots ?? 0);
    case "alreadyRight":
      return t.fill.awishAlreadyRight;
    case "notLinked":
      return t.fill.awishNotLinked;
    case "partial":
      return t.fill.awishPartial(status.message);
    default:
      return t.fill.awishError;
  }
}

/** Prick för Awish-läsningen: pulserar när läsningen är färsk. */
function AwishDot({ live }: { live: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        live ? "live-dot bg-up text-up" : "bg-faint",
      )}
    />
  );
}

/**
 * Fyll på vid automaten: välj automat (störst behov först), justera antalet per titel med
 * stora knappar och tryck Klar. Påfyllningen läggs i kön (fungerar utan nät) och dras ur
 * lagret i "Från: Hemma ▾" (automatens "Fylls på från", annars det man valde sist) så
 * långt packen räcker; resten registreras utan uttag. Awish-synken ser sedan samma antal
 * som saldot och drar inget en gång till.
 */
export function FillApp({
  scope,
  data,
  timeZone,
  renderedAt,
  initialMachineId = null,
}: FillAppProps) {
  const router = useRouter();
  const toast = useToast();
  const t = useT();
  const fmt = useFormat();
  const simple = useSimpleShell();
  const pathname = usePathname();
  const hydrated = useHydrated();
  // Det senaste trycket (en automat, Automater, Klar) bestämmer skärmen direkt; adressen
  // byts samtidigt, men Next uppdaterar usePathname först när en pågående hämtning är klar.
  // Bakåt och framåt i webbläsaren följer adressen igen.
  const [nav, setNav] = useState<FillNav | null>(null);
  useEffect(() => {
    const followAddress = () => setNav(null);
    window.addEventListener("popstate", followAddress);
    return () => window.removeEventListener("popstate", followAddress);
  }, []);
  const selectedId = shownMachineId({ nav, hydrated, pathname, initialMachineId });
  const [mineOnly, setMineOnly] = useRemembered(rememberKey(scope, "fyll-mina"));
  // Bekräftelsen efter Klar ligger utanför useState (och i flikens sessionStorage), så att
  // den finns kvar om FillApp monteras om eller sidan laddas om. Själva felet (Next bytte
  // rutt och laddade om sidan när en påfyllning sparades) är rättat med en gemensam rutt för
  // /fyll-pa och /fyll-pa/<automat>, se src/lib/rewrites.ts.
  const [done, setDone] = useDone(scope);
  // Ta med-listan är öppen (utanför useState: överlever att sidan hämtas om).
  const [bring, setBring] = useBring(scope);
  const sources = data.sources;
  const [lastSource, setLastSource] = useRemembered(rememberKey(scope, "fyll-lager"));
  // Lager valt med "Från: … ▾" för en automat (gäller tills sidan laddas om).
  const [override, setOverride] = useState<Record<string, string>>({});
  const placeName = useCallback(
    (id: string | null) => sources.places.find((p) => p.id === id)?.name ?? t.common.homeFallback,
    [sources.places, t],
  );

  // Påfyllningar som sparats men som serverns siffror inte visar än (tills sidan räknats om).
  const [saved, setSaved] = useState<{ base: FillData; items: FillAdjustment[] }>({
    base: data,
    items: [],
  });
  const [counted, setCounted] = useState<{ base: FillData; map: Map<string, number> }>({
    base: data,
    map: new Map(),
  });

  const rememberSaved = useCallback(
    (items: readonly QueuedRefill[]) => {
      setSaved((prev) => ({
        base: data,
        items: [...(prev.base === data ? prev.items : []), ...items],
      }));
    },
    [data],
  );

  const onQueueSaved = useCallback(
    (items: readonly QueuedRefill[]) => {
      rememberSaved(items);
      toast({
        title: t.fill.savedFromQueue(items.reduce((n, i) => n + i.quantity, 0)),
        tone: "ok",
      });
    },
    [rememberSaved, toast, t],
  );
  const q = useRefillQueue(scope, {
    onBackgroundSaved: (items) => {
      onQueueSaved(items);
      router.refresh();
    },
  });

  // Awish-läsningen per automat ("Awish läst 14:50") och den senaste av alla.
  const syncLabels = useMemo(() => {
    const out: Record<string, string> = {};
    for (const m of data.machines) {
      if (m.syncedAt) out[m.id] = t.fill.awishRead(clockLabel(m.syncedAt, renderedAt, timeZone, t));
    }
    return out;
  }, [data.machines, renderedAt, timeZone, t]);
  const fresh = useMemo(() => {
    const out: Record<string, boolean> = {};
    const now = Date.parse(renderedAt);
    for (const m of data.machines) {
      if (m.syncedAt) out[m.id] = now - Date.parse(m.syncedAt) < FRESH_MS;
    }
    return out;
  }, [data.machines, renderedAt]);
  const lastRead = lastAwishRead(data.machines);

  // Hämta om: först kön (så att datan visar det som just skickats), sedan sidan.
  const [refreshing, startRefresh] = useTransition();
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState<RefreshNotice | null>(null);
  const { sync: syncQueue } = q;
  const reloadData = useCallback(async () => {
    try {
      const out = await syncQueue();
      if (out.saved.length > 0) onQueueSaved(out.saved);
    } catch {
      // Kön ligger kvar och skickas nästa gång.
    }
    startRefresh(() => router.refresh());
  }, [onQueueSaved, router, syncQueue]);
  // Appen öppnas igen (synlig, fokus, bfcache, nät tillbaka): hämta om, högst var 30:e s.
  useFreshData({ renderedAt, refresh: () => void reloadData() });

  /** Uppdatera: läs facken i Awish nu och hämta om datan. */
  const update = async () => {
    if (reading) return;
    setReading(true);
    let outcome: RefreshOutcome;
    try {
      const res = await withTimeout(refreshFill(), REFRESH_TIMEOUT_MS);
      outcome = res.ok ? { ok: true, ...res.data } : { ok: false, offline: false };
    } catch {
      outcome = { ok: false, offline: typeof navigator !== "undefined" && !navigator.onLine };
    }
    try {
      await reloadData();
    } finally {
      setNotice(refreshNotice(outcome, { now: new Date(), lastReadAt: lastRead, timeZone, t }));
      setReading(false);
    }
  };
  const busy = reading || refreshing;
  const refreshButton = <RefreshButton busy={busy} onClick={() => void update()} />;
  const noticeLine = notice ? <NoticeLine notice={notice} /> : null;

  const view = useMemo(() => {
    const pending = q.queue.filter((i) => i.status === "queued");
    const adj: FillAdjustment[] = [...pending, ...(saved.base === data ? saved.items : [])];
    const counts = counted.base === data ? counted.map : new Map<string, number>();
    // Föreslaget lager: automatens "Fylls på från", sedan senast valda, sedan standardlagret.
    const preferred = (id: string) => [
      sources.machineSource[id],
      lastSource,
      sources.defaultPlaceId,
    ];
    // Först med det föreslagna lagret (raderna och lagrens saldo efter kön), sedan väljs lagret
    // som har packen (chooseSource) och raderna räknas mot det.
    const first = applyAdjustments(data.machines, sources.stock, adj, counts, (id) =>
      pickPlace(sources.places, override[id], ...preferred(id)),
    );
    const choice: Record<string, SourceChoice> = {};
    for (const m of first.machines) {
      choice[m.id] = chooseSource({
        places: sources.places,
        stock: first.stock,
        rows: m.rows,
        explicit: override[m.id],
        preferred: preferred(m.id),
        t,
      });
    }
    const out = applyAdjustments(
      data.machines,
      sources.stock,
      adj,
      counts,
      (id) => choice[id]?.id ?? null,
    );
    return { ...out, choice };
  }, [counted, data, lastSource, override, q.queue, saved, sources, t]);
  const sourceOf = (machineId: string) => view.choice[machineId]?.id ?? null;

  const go = useCallback((href: string) => {
    setNav({ machineId: machineIdFrom(href) });
    window.history.pushState(null, "", href);
    window.scrollTo({ top: 0 });
  }, []);

  const selected = selectedId ? view.machines.find((m) => m.id === selectedId) : undefined;
  const rejected = q.queue.filter((i) => i.status === "rejected");
  const waiting = q.queue.length - rejected.length;

  if (selectedId && selected) {
    const source = sourceOf(selected.id);
    return (
      <MachineScreen
        key={`${selected.id}/${source ?? ""}`}
        machine={selected}
        places={sources.places.map((p) => ({
          id: p.id,
          name: p.name,
          count: Object.values(view.stock[p.id] ?? {}).reduce((n, v) => n + Math.max(0, v), 0),
        }))}
        sourceId={source}
        sourceReason={view.choice[selected.id]?.reason ?? null}
        onSource={(id) => setOverride((prev) => ({ ...prev, [selected.id]: id }))}
        syncLabel={syncLabels[selected.id]}
        fresh={fresh[selected.id] ?? false}
        online={q.online}
        headerActions={
          <div className="flex items-center gap-2">
            {refreshButton}
            <NetPill online={q.online} waiting={waiting} syncing={q.syncing} />
          </div>
        }
        notice={noticeLine}
        onBack={() => go(BASE)}
        onCounted={(titleId, value) => {
          setCounted((prev) => {
            const map = new Map(prev.base === data ? prev.map : []);
            map.set(pairKey(selected.id, titleId), value);
            return { base: data, map };
          });
          router.refresh();
        }}
        onDone={async (lines) => {
          const now = new Date().toISOString();
          const items: QueuedRefill[] = [];
          let packs = 0;
          // "Kvar hemma" = hela lagret man fyller från efter påfyllningen (samma tal som
          // "N pack hemma" överst), inte bara de påfyllda titlarna.
          let homeLeft = source
            ? Object.values(view.stock[source] ?? {}).reduce((n, v) => n + Math.max(0, v), 0)
            : 0;
          for (const { row, quantity } of lines) {
            const split = splitRefill(quantity, source ? row.home : 0);
            packs += quantity;
            homeLeft -= split.fromWarehouse;
            for (const [n, fromWarehouse] of [
              [split.fromWarehouse, true],
              [split.direct, false],
            ] as const) {
              if (n <= 0) continue;
              items.push({
                clientId: newClientId(),
                scope,
                machineId: selected.id,
                titleId: row.titleId,
                quantity: n,
                fromWarehouse,
                ...(fromWarehouse && source ? { fromLocationId: source } : {}),
                occurredAt: now,
                note: fromWarehouse ? "Fyll på" : "Fyll på (utan uttag ur vårt lager)",
                status: "queued",
                attempts: 0,
              });
            }
          }
          if (items.length === 0) {
            go(BASE);
            return;
          }
          const out = await q.enqueue(items);
          if (source) setLastSource(source);
          if (out.rejected.length > 0) {
            toast({
              title: t.fill.notSavedTitle,
              description: out.rejected[0]?.error
                ? t.serverError(out.rejected[0].error)
                : t.fill.seeList,
              tone: "critical",
            });
          } else if (out.offline && !q.persistent) {
            toast({
              title: t.fill.noConnection,
              description: t.fill.tryWithNet,
              tone: "critical",
            });
            return;
          } else {
            const rejectedIds = new Set(out.rejected.map((r) => r.clientId));
            setDone({
              packs,
              left: source ? t.fill.leftAt(Math.max(0, homeLeft), placeName(source)) : "",
              offline: out.offline,
              clientIds: items.map((i) => i.clientId).filter((id) => !rejectedIds.has(id)),
            });
          }
          if (out.saved.length > 0) rememberSaved(out.saved);
          if (out.awish && out.awish.state !== "sent") {
            // Gick det inte hela vägen till Awish: säg till så antalet kan skrivas där.
            toast({
              title: t.fill.sendToAwish,
              description: awishText(t, out.awish),
              tone: out.awish.state === "error" ? "critical" : "neutral",
            });
          } else if (out.awish?.state === "sent") {
            toast({ title: awishText(t, out.awish), tone: "ok" });
          }
          // Först tillbaka till listan (bekräftelsen syns direkt), sedan hämtas datan om för
          // den adressen.
          go(BASE);
          if (out.saved.length > 0) router.refresh();
        }}
      />
    );
  }

  const mine = data.hasOthers && mineOnly === "1";
  const shown = mine ? view.machines.filter((m) => m.mine) : view.machines;

  if (bring && shown.length > 0) {
    return (
      <BringScreen
        machines={shown}
        places={sources.places.map((p) => ({
          id: p.id,
          name: p.name,
          count: Object.values(view.stock[p.id] ?? {}).reduce((n, v) => n + Math.max(0, v), 0),
        }))}
        stock={view.stock}
        chosen={bring.chosen}
        onToggle={(id) => {
          // Läget läses när man trycker (inte ur renderingen): två snabba tryck räknas båda.
          const current = bringStore.read(scope);
          if (!current) return;
          setBring({ ...current, chosen: toggleBring(current.chosen, shown, id) });
        }}
        placeId={pickPlace(sources.places, bring.placeId, lastSource, sources.defaultPlaceId)}
        online={q.online}
        headerActions={
          <div className="flex items-center gap-2">
            {refreshButton}
            <NetPill online={q.online} waiting={waiting} syncing={q.syncing} />
          </div>
        }
        onBack={() => {
          setBring(null);
          window.scrollTo({ top: 0 });
        }}
        onPlace={(placeId) => {
          setBring({ ...(bringStore.read(scope) ?? bring), placeId });
          setLastSource(placeId);
        }}
      />
    );
  }
  const need = shown.filter((m) => m.needs).length;
  const waitingAwish = shown.some((m) => m.fillPct === null);
  const headline = fillHeadline(shown, t);
  const homeTotal = Object.values(view.stock).reduce(
    (n, place) => n + Object.values(place).reduce((m, v) => m + Math.max(0, v), 0),
    0,
  );
  const stockLabel =
    sources.places.length === 1 ? t.fill.stockAt(sources.places[0]!.name) : t.fill.stockAll;

  return (
    <div className="flex flex-col gap-6 px-4 pt-[calc(16px+env(safe-area-inset-top))] pb-[calc(32px+env(safe-area-inset-bottom))]">
      <header className="rise flex flex-col gap-3" style={rise(0)}>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          {simple ? (
            <SimpleMenuButton />
          ) : (
            <Link
              href="/drift"
              className="label inline-flex min-h-11 items-center gap-1 text-subtle hover:text-fg"
            >
              <Icon name="chevronLeft" />
              {t.fill.back}
            </Link>
          )}
          <div className="flex items-center gap-2">
            {refreshButton}
            <NetPill online={q.online} waiting={waiting} syncing={q.syncing} />
          </div>
        </div>
        <p className="label text-subtle">{t.fill.title}</p>
        <h1 className="text-3xl font-medium text-balance text-fg">
          {need > 0 ? (
            <>
              {t.fill.needPrefix}
              <CountUp id="behov" value={need} format={fmt.int} className="tnum" />
              {t.fill.needSuffix(need)}
            </>
          ) : (
            headline
          )}
        </h1>
        {data.hasWarehouse || waitingAwish || lastRead ? (
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-md text-muted">
            {data.hasWarehouse ? (
              <span>
                <CountUp id="hemma" value={homeTotal} format={fmt.int} className="tnum text-fg" />
                {`${NBSP}${stockLabel}`}
              </span>
            ) : null}
            {waitingAwish ? <span>{t.fill.waitingAwish}</span> : null}
            {lastRead ? (
              <span className="tnum">
                {t.fill.awishRead(clockLabel(lastRead, renderedAt, timeZone, t))}
              </span>
            ) : null}
          </p>
        ) : null}
        {noticeLine}
        {data.hasOthers ? (
          <MineSwitch mine={mine} onChange={(v) => setMineOnly(v ? "1" : null)} />
        ) : null}
      </header>

      {done ? (
        <DoneBanner
          done={done}
          onClose={() => setDone(null)}
          onUndo={async () => {
            const ids = new Set(done.clientIds);
            const queued = q.queue.filter((i) => ids.has(i.clientId));
            for (const i of queued) await q.remove(i.clientId);
            const queuedIds = new Set(queued.map((i) => i.clientId));
            const sent = done.clientIds.filter((id) => !queuedIds.has(id));
            if (sent.length > 0) {
              const res = await undoRefills(sent).catch(() => ({
                ok: false as const,
                error: t.common.offlineRetry,
              }));
              if (!res.ok) {
                toast({
                  title: t.fill.undoFailed,
                  description: t.serverError(res.error),
                  tone: "critical",
                });
                return;
              }
            }
            setSaved((prev) => ({
              base: prev.base,
              items: prev.items.filter(
                (i) => !("clientId" in i) || !ids.has((i as QueuedRefill).clientId),
              ),
            }));
            setDone(null);
            toast({ title: t.fill.undone(done.packs), tone: "neutral" });
            router.refresh();
          }}
        />
      ) : null}

      {rejected.length > 0 ? (
        <RejectedList
          items={rejected}
          names={view.machines}
          onRetryDirect={async (item) => {
            await q.remove(item.clientId);
            const out = await q.enqueue([
              {
                ...item,
                clientId: newClientId(),
                fromWarehouse: false,
                status: "queued",
                attempts: 0,
                error: undefined,
              },
            ]);
            if (out.saved.length > 0) {
              rememberSaved(out.saved);
              toast({ title: t.fill.savedDirect, tone: "ok" });
              router.refresh();
            }
          }}
          onRemove={(item) => void q.remove(item.clientId)}
        />
      ) : null}

      {shown.length === 0 && mine ? <p className="text-md text-muted">{t.fill.noneMine}</p> : null}

      {/* Ta med-listan: efter bekräftelsen och det som inte gick att spara, före automaterna. */}
      {shown.length > 0 ? (
        <button
          type="button"
          onClick={() => {
            setBring({ chosen: null, placeId: null });
            window.scrollTo({ top: 0 });
          }}
          className="rise flex min-h-12 w-full items-center justify-between gap-3 rounded-md border border-line-strong bg-surface px-4 text-left text-lg font-medium text-fg active:bg-hover"
          style={rise(1)}
        >
          <span className="inline-flex items-center gap-2">
            <Icon name="stock" size={18} />
            {t.fill.bringOpen}
          </span>
          <Icon name="chevronRight" size={16} className="text-subtle" />
        </button>
      ) : null}

      <ul className="flex flex-col gap-3" aria-label={t.fill.machines}>
        {shown.map((m, i) => (
          <li key={m.id} className="rise" style={rise(i + 1)}>
            <MachineCard
              machine={m}
              syncLabel={syncLabels[m.id]}
              fresh={fresh[m.id] ?? false}
              onOpen={() => {
                setDone(null);
                go(`${BASE}/${m.id}`);
              }}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Uppdatera: läser facken i Awish nu. Stor (44 px), ikon och text, snurrar medan den arbetar. */
function RefreshButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-busy={busy}
      className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line-strong bg-surface px-3 text-md font-medium text-fg active:bg-hover disabled:text-muted"
    >
      <Icon name="refresh" size={16} className={cn(busy && "motion-safe:animate-spin")} />
      {busy ? t.fill.refreshing : t.fill.refresh}
    </button>
  );
}

/** Raden efter Uppdatera: "Uppdaterat 14:52" eller ett lugnt fel. */
function NoticeLine({ notice }: { notice: RefreshNotice }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className={cn("text-sm", notice.tone === "ok" ? "text-subtle" : "text-signal-fg")}
    >
      {notice.text}
    </p>
  );
}

function NetPill({
  online,
  waiting,
  syncing,
}: {
  online: boolean;
  waiting: number;
  syncing: boolean;
}) {
  const t = useT();
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "label inline-flex min-h-8 items-center gap-2 rounded-full border px-3",
        online ? "border-line text-subtle" : "border-signal-line text-signal-fg",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-1.5 rounded-full bg-current",
          syncing && "live-dot",
          online && waiting === 0 && "text-muted",
        )}
      />
      {online
        ? waiting > 0
          ? t.fill.sending(waiting)
          : t.fill.online
        : waiting > 0
          ? t.fill.offlineQueued(waiting)
          : t.fill.offline}
    </span>
  );
}

/** Fyllnadsgraden som stapel (grön/gul/röd, växer fram). Utan kapacitet: ingen stapel. */
function FillBar({ pct, className }: { pct: number | null; className?: string }) {
  if (pct === null) return null;
  return <Bar bp={Math.max(0, Math.min(100, pct)) * 100} className={cn("h-2", className)} />;
}

/** "Alla / Mina": stora knappar, valet sparas i telefonen. */
function MineSwitch({ mine, onChange }: { mine: boolean; onChange: (mine: boolean) => void }) {
  const t = useT();
  const items = [
    { on: !mine, text: t.fill.all, value: false },
    { on: mine, text: t.fill.mine, value: true },
  ];
  return (
    <div
      role="radiogroup"
      aria-label={t.fill.showLabel}
      className="grid w-full max-w-72 grid-cols-2 gap-2"
    >
      {items.map((i) => (
        <button
          key={i.text}
          type="button"
          role="radio"
          aria-checked={i.on}
          onClick={() => onChange(i.value)}
          className={cn(
            "min-h-11 rounded-md border text-md font-medium transition-colors",
            i.on
              ? "border-inverse bg-inverse text-on-inverse"
              : "border-line-strong bg-surface text-muted active:bg-hover",
          )}
        >
          {i.text}
        </button>
      ))}
    </div>
  );
}

/** Bekräftelsen efter Klar: "Klart! 12 pack påfyllda" och Ångra (i stället för varningar). */
function DoneBanner({
  done,
  onUndo,
  onClose,
}: {
  done: Done;
  onUndo: () => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <section
      role="status"
      aria-live="polite"
      className="rise flex items-center gap-3 rounded-md border border-up-line bg-surface p-4"
    >
      <span
        aria-hidden
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-up text-bg"
      >
        <Icon name="check" size={22} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-lg font-medium text-fg">{t.fill.doneTitle(done.packs)}</span>
        <span className="text-sm text-muted">{done.offline ? t.fill.doneOffline : done.left}</span>
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onUndo();
          } finally {
            setBusy(false);
          }
        }}
        className="min-h-11 shrink-0 rounded-md border border-line-strong bg-raised px-4 text-md font-medium text-fg active:bg-hover disabled:text-disabled"
      >
        {busy ? t.common.undoing : t.common.undo}
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={t.common.close}
        className="-mr-2 flex size-11 shrink-0 items-center justify-center text-subtle hover:text-fg"
      >
        <Icon name="close" size={18} />
      </button>
    </section>
  );
}

function MachineCard({
  machine: m,
  syncLabel,
  fresh,
  onOpen,
}: {
  machine: FillMachine;
  syncLabel?: string;
  fresh: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  const label = needLabel(m, t);
  const urgent = m.emptySlots > 0 || m.empty > 0 || m.low > 0;
  return (
    <a
      href={`${BASE}/${m.id}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        onOpen();
      }}
      aria-label={t.fill.cardAria(m.place, label, m.fillPct)}
      className={cn(
        "lift flex min-h-24 flex-col gap-3 rounded-md border bg-surface p-4 active:scale-[0.99]",
        urgent ? "border-signal-line" : m.needs ? "border-line-strong" : "border-line",
      )}
    >
      <span className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-lg font-medium [overflow-wrap:anywhere] text-fg">{m.place}</span>
          <span className="inline-flex items-center gap-1.5 text-sm text-muted">
            {syncLabel ? <AwishDot live={fresh} /> : null}
            {m.code}
            {m.fillPct !== null && syncLabel ? ` · ${syncLabel}` : ""}
          </span>
        </span>
        {m.fillPct !== null ? (
          <span className="tnum shrink-0 text-2xl font-medium text-fg">
            {t.common.pct(m.fillPct)}
          </span>
        ) : null}
      </span>
      {label ? (
        <span
          className={cn(
            "text-md font-medium first-letter:uppercase",
            urgent ? "text-signal-fg" : label === t.fill.needFull ? "text-up" : "text-muted",
          )}
        >
          {label}
        </span>
      ) : null}
      <FillBar pct={m.fillPct} />
    </a>
  );
}

interface Line {
  readonly row: FillRow;
  readonly quantity: number;
}

function MachineScreen({
  machine: m,
  places,
  sourceId,
  sourceReason,
  onSource,
  syncLabel,
  fresh,
  online,
  headerActions,
  notice,
  onBack,
  onDone,
  onCounted,
}: {
  machine: FillMachine;
  /** Våra lager med antal pack (för "Från: Hemma ▾"). */
  places: readonly { id: string; name: string; count: number }[];
  /** Lagret packen tas från, null = inget eget lager. */
  sourceId: string | null;
  /** Varför ett annat lager än automatens är valt ("Kontoret saknar pack"), annars null. */
  sourceReason: string | null;
  onSource: (id: string) => void;
  syncLabel?: string;
  fresh: boolean;
  online: boolean;
  /** Uppdatera och uppkopplingen, till höger om Automater. */
  headerActions?: ReactNode;
  /** Raden efter Uppdatera. */
  notice?: ReactNode;
  onBack: () => void;
  onDone: (lines: Line[]) => Promise<void>;
  onCounted: (titleId: string, value: number) => void;
}) {
  const toast = useToast();
  const t = useT();
  const suggestedQty = () => Object.fromEntries(m.rows.map((r) => [r.titleId, r.suggested]));
  const [qty, setQty] = useState<Record<string, number>>(suggestedQty);
  // Ny data (Uppdatera, appen öppnad igen): nya förslag, så länge inget antal har ändrats.
  const suggestKey = m.rows.map((r) => `${r.titleId}:${r.suggested}`).join(",");
  const [seenKey, setSeenKey] = useState(suggestKey);
  const [touched, setTouched] = useState(false);
  if (suggestKey !== seenKey) {
    setSeenKey(suggestKey);
    if (!touched) setQty(suggestedQty());
  }
  const [busy, setBusy] = useState(false);
  const [counting, setCounting] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  // Klar sparar och skickar till Awish: fråga först, så att ett tryck av misstag (t.ex. när
  // man packar hemma) inte registrerar en påfyllning.
  const [confirming, setConfirming] = useState(false);
  // Ändrade antal som inte sparats: appen laddar inte om av sig själv för en ny version.
  useUnsavedInput(touched || busy || confirming || counting !== null);
  const finish = async () => {
    setBusy(true);
    try {
      await onDone(
        m.rows
          .map((row) => ({ row, quantity: qty[row.titleId] ?? 0 }))
          .filter((l) => l.quantity > 0),
      );
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  const sourceName = places.find((p) => p.id === sourceId)?.name ?? t.common.homeFallback;
  const total = m.rows.reduce((n, r) => n + (qty[r.titleId] ?? 0), 0);
  const after = useMemo(() => {
    let cap = 0;
    let known = 0;
    for (const r of m.rows) {
      if (r.capacity === null) continue;
      cap += r.capacity;
      known += Math.min(r.capacity, r.now + (qty[r.titleId] ?? 0));
    }
    return cap > 0 ? Math.round((known / cap) * 100) : null;
  }, [m.rows, qty]);

  const set = (titleId: string, value: number, max: number) => {
    setTouched(true);
    setQty((prev) => ({ ...prev, [titleId]: Math.max(0, Math.min(max, Math.trunc(value) || 0)) }));
  };

  // Det som behöver fyllas syns först; resten under "Fler titlar".
  const first = m.rows.filter(
    (r) => r.status !== null || r.emptySlots > 0 || r.suggested > 0 || fullFastNote(r, t) !== null,
  );
  const rest = m.rows.filter((r) => !first.includes(r));
  const renderRow = (r: FillRow, i: number) => (
    <li key={r.titleId} className="rise" style={rise(i + 2)}>
      <TitleRow
        row={r}
        sourceName={sourceName}
        value={qty[r.titleId] ?? 0}
        onChange={(v) => set(r.titleId, v, maxFill(r))}
        counting={counting === r.titleId}
        onCountToggle={() => setCounting((c) => (c === r.titleId ? null : r.titleId))}
        onCount={async (value) => {
          if (!online) {
            toast({
              title: t.fill.needsNet,
              description: t.fill.doneStillWorks,
              tone: "critical",
            });
            return;
          }
          const res = await registerCount({
            location: "machine",
            machineId: m.id,
            titleId: r.titleId,
            counted: value,
            note: "Räkna om (Fyll på)",
          }).catch(() => ({ ok: false as const, error: t.common.offline }));
          if (!res.ok) {
            toast({
              title: t.fill.countFailed,
              description: t.serverError(res.error),
              tone: "critical",
            });
            return;
          }
          setCounting(null);
          onCounted(r.titleId, value);
          const next = qtyAfterCount(r, value);
          if (next !== null) {
            set(r.titleId, next, maxFill({ ...r, now: value }));
          }
          toast({ title: t.fill.countSaved(value), tone: "ok" });
        }}
      />
    </li>
  );

  return (
    <div className="flex min-h-dvh flex-col">
      <div className="flex flex-1 flex-col gap-5 px-4 pt-[calc(12px+env(safe-area-inset-top))] pb-6">
        <header className="rise flex flex-col gap-3" style={rise(0)}>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <button
              type="button"
              onClick={onBack}
              className="label inline-flex min-h-11 items-center gap-1 text-subtle hover:text-fg"
            >
              <Icon name="chevronLeft" />
              {t.fill.machines}
            </button>
            {headerActions}
          </div>
          <div className="flex items-end justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <h1 className="text-2xl font-medium [overflow-wrap:anywhere] text-fg">{m.place}</h1>
              <p className="meta inline-flex items-center gap-1.5 text-subtle">
                {syncLabel ? <AwishDot live={fresh} /> : null}
                {m.code}
                {after === null ? t.fill.machineFillUnknown : syncLabel ? ` · ${syncLabel}` : ""}
              </p>
            </div>
            {after !== null ? (
              <p className="flex shrink-0 flex-col items-end">
                <span className="tnum text-2xl font-medium text-fg">{t.common.pct(after)}</span>
                <span className="label text-subtle">
                  {m.fillPct === null || m.fillPct === after
                    ? t.fill.filled
                    : t.fill.fromPct(m.fillPct)}
                </span>
              </p>
            ) : null}
          </div>
          <FillBar pct={after} className="h-2.5" />
          {notice}
        </header>

        <div className="rise flex flex-wrap items-center justify-between gap-3" style={rise(1)}>
          <p className="text-md text-muted">
            {t.fill.youFillPrefix}
            <span className="tnum text-fg">{t.common.packs(total)}</span>
          </p>
          {places.length > 1 ? (
            <button
              type="button"
              onClick={() => setChoosing(true)}
              aria-label={t.fill.fromAria(sourceName)}
              className="inline-flex min-h-11 items-center gap-1 rounded-full border border-line-strong bg-surface px-4 text-md text-fg active:bg-hover"
            >
              <span className="text-subtle">{t.fill.from}</span>
              <span className="font-medium">{t.common.placeName(sourceName)}</span>
              <Icon name="chevronDown" size={14} />
            </button>
          ) : null}
          {m.rows.some((r) => r.capacity !== null) ? (
            <button
              type="button"
              onClick={() => {
                setTouched(true);
                setQty(
                  Object.fromEntries(
                    m.rows.map((r) => [r.titleId, fillAllQty(r, qty[r.titleId] ?? 0)]),
                  ),
                );
              }}
              className="min-h-11 rounded-sm border border-line-strong bg-surface px-4 text-md font-medium text-fg active:bg-hover"
            >
              {t.fill.fillAll}
            </button>
          ) : null}
          {places.length > 1 && sourceReason ? (
            <p className="basis-full text-sm text-muted">{sourceReason}</p>
          ) : null}
        </div>

        {m.rows.length === 0 ? (
          <p className="text-md text-muted">{t.fill.noTitles}</p>
        ) : (
          <>
            <ul className="flex flex-col gap-3" aria-label={t.fill.titlesAria}>
              {first.map((r, i) => renderRow(r, i))}
            </ul>
            {rest.length > 0 ? (
              <details className="group flex flex-col gap-3" open={first.length === 0}>
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-md text-muted [&::-webkit-details-marker]:hidden">
                  <Icon
                    name="chevronDown"
                    size={14}
                    className="-rotate-90 transition-transform group-open:rotate-0"
                  />
                  {t.fill.moreTitles(rest.length)}
                </summary>
                <ul className="mt-3 flex flex-col gap-3" aria-label={t.fill.moreTitlesAria}>
                  {rest.map((r, i) => renderRow(r, i))}
                </ul>
              </details>
            ) : null}
          </>
        )}
      </div>

      <div className="sticky bottom-0 z-10 border-t border-line bg-bg/95 px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))] backdrop-blur">
        {confirming ? (
          <div className="flex flex-col gap-2" role="group" aria-label={t.fill.confirmQuestion}>
            <p className="text-md font-medium text-fg">{t.fill.confirmQuestion}</p>
            <p className="text-sm text-muted">{t.fill.confirmDetail(total)}</p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void finish()}
              className={cn(
                "flex h-14 w-full items-center justify-center gap-2 rounded-md border text-lg font-medium transition-colors",
                busy
                  ? "border-dashed border-line-strong text-disabled"
                  : "border-inverse bg-inverse text-on-inverse active:bg-inverse-hover",
              )}
            >
              <Icon name="check" size={20} />
              {busy ? t.common.saving : t.fill.confirmYes}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(false)}
              className="flex h-12 w-full items-center justify-center rounded-md border border-line-control text-md font-medium text-fg"
            >
              {t.fill.confirmNo}
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              if (total > 0) {
                setConfirming(true);
                return;
              }
              toast({ title: t.fill.nothingFilled, tone: "neutral" });
              await finish();
            }}
            className={cn(
              "flex h-14 w-full items-center justify-center gap-2 rounded-md border text-lg font-medium transition-colors",
              busy
                ? "border-dashed border-line-strong text-disabled"
                : "border-inverse bg-inverse text-on-inverse active:bg-inverse-hover",
            )}
          >
            <Icon name="check" size={20} />
            {busy ? t.common.saving : total > 0 ? t.fill.doneWith(total) : t.fill.done}
          </button>
        )}
      </div>
      <Sheet
        open={choosing}
        onClose={() => setChoosing(false)}
        title={t.fill.takeFrom}
        eyebrow={m.place}
        closeLabel={t.common.close}
      >
        <div className="px-5 pb-5">
          <PlaceButtons
            label={t.fill.takeFrom}
            places={places.map((p) => ({ ...p, name: t.common.placeName(p.name) }))}
            countText={t.common.packs}
            value={sourceId}
            onChange={(id) => {
              setChoosing(false);
              onSource(id);
            }}
          />
        </div>
      </Sheet>
    </div>
  );
}

function TitleRow({
  row: r,
  sourceName,
  value,
  onChange,
  counting,
  onCountToggle,
  onCount,
}: {
  row: FillRow;
  /** Lagret packen tas från ("Hemma"). */
  sourceName: string;
  value: number;
  onChange: (v: number) => void;
  counting: boolean;
  onCountToggle: () => void;
  onCount: (value: number) => Promise<void>;
}) {
  const t = useT();
  const [draft, setDraft] = useState(String(r.now));
  const [saving, setSaving] = useState(false);
  const inputId = `antal-${r.titleId}`;
  const short = value > Math.max(0, r.home);
  const fullNote = fullFastNote(r, t);
  const mystery = mysteryNote(r, value, t);
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-md border bg-surface p-4",
        r.status !== null || r.emptySlots > 0 ? "border-signal-line" : "border-line",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <label htmlFor={inputId} className="text-md font-medium [overflow-wrap:anywhere] text-fg">
            {r.name}
          </label>
          <span className={cn("text-sm", short ? "text-signal-fg" : "text-muted")}>
            {t.fill.stockLine(t.common.placeName(sourceName), r.home)}
            {short && r.home > 0 ? t.fill.withoutWithdrawalN(value - r.home) : ""}
            {short && r.home <= 0 ? t.fill.withoutWithdrawal : ""}
          </span>
        </div>
        <p className="flex shrink-0 flex-col items-end">
          <span className="tnum text-xl font-medium text-fg">
            {t.common.int(r.now)}
            <span className="text-subtle">
              {r.capacity === null ? "" : `/${t.common.int(r.capacity)}`}
            </span>
          </span>
          {r.status === "empty" ? (
            <span className="label text-signal-fg">{t.fill.statusEmpty}</span>
          ) : r.emptySlots > 0 ? (
            <span className="label text-signal-fg">{t.fill.needEmptySlots(r.emptySlots)}</span>
          ) : r.status === "low" ? (
            <span className="label text-signal-fg">{t.fill.statusLow}</span>
          ) : (
            <span className="text-sm text-muted">{t.fill.inMachine}</span>
          )}
        </p>
      </div>
      {fullNote ? (
        <p className="-mt-1 text-sm text-muted">{`${fullNote} · ${t.fill.fullFastTip}`}</p>
      ) : null}
      {mystery ? (
        <p className="-mt-1 text-sm text-muted" role="note">
          {mystery}
        </p>
      ) : null}

      <div className="grid grid-cols-[56px_1fr_56px] items-center gap-2">
        <button
          type="button"
          aria-label={t.fill.lessAria(r.name)}
          onClick={() => onChange(value - 1)}
          disabled={value <= 0}
          className="flex size-14 items-center justify-center rounded-md border border-line-strong bg-raised text-fg active:bg-hover disabled:border-dashed disabled:text-disabled"
        >
          <Icon name="minus" size={24} />
        </button>
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          pattern="[0-9]*"
          min={0}
          max={maxFill(r)}
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-describedby={`${inputId}-hint`}
          className="tnum h-14 w-full min-w-0 [appearance:textfield] rounded-md border border-line-control bg-bg text-center text-3xl font-medium text-fg [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          style={{ fontSize: 28 }}
        />
        <button
          type="button"
          aria-label={t.fill.moreAria(r.name)}
          onClick={() => onChange(value + 1)}
          disabled={value >= maxFill(r)}
          className="flex size-14 items-center justify-center rounded-md border border-line-strong bg-raised text-fg active:bg-hover disabled:border-dashed disabled:text-disabled"
        >
          <Icon name="plus" size={24} />
        </button>
      </div>
      <span id={`${inputId}-hint`} className="sr-only">
        {t.fill.hint(r.suggested, r.capacity === null ? null : Math.max(0, r.capacity - r.now))}
      </span>

      {counting ? (
        <form
          className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const n = Number(draft);
            if (!Number.isInteger(n) || n < 0 || n > 10000) return;
            setSaving(true);
            try {
              await onCount(n);
            } finally {
              setSaving(false);
            }
          }}
        >
          <label htmlFor={`${inputId}-raknat`} className="col-span-3 text-md text-muted">
            {t.fill.countLabel}
          </label>
          <input
            id={`${inputId}-raknat`}
            type="number"
            inputMode="numeric"
            pattern="[0-9]*"
            min={0}
            max={10000}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            className="tnum h-11 w-full min-w-0 rounded-sm border border-line-control bg-bg text-center text-fg"
            style={{ fontSize: 18 }}
          />
          <button
            type="submit"
            disabled={saving}
            className="h-11 rounded-sm border border-inverse bg-inverse px-4 text-md font-medium text-on-inverse disabled:opacity-60"
          >
            {saving ? t.common.saving : t.common.save}
          </button>
          <button
            type="button"
            onClick={onCountToggle}
            className="h-11 min-w-11 px-2 text-md text-subtle hover:text-fg"
          >
            {t.common.cancel}
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => {
            setDraft(String(r.now));
            onCountToggle();
          }}
          className="-my-1 min-h-11 self-start text-md text-subtle underline-offset-4 hover:text-fg hover:underline"
        >
          {t.fill.wrongCount}
        </button>
      )}
    </div>
  );
}

function RejectedList({
  items,
  names,
  onRetryDirect,
  onRemove,
}: {
  items: QueuedRefill[];
  names: readonly FillMachine[];
  onRetryDirect: (item: QueuedRefill) => Promise<void>;
  onRemove: (item: QueuedRefill) => void;
}) {
  const t = useT();
  const place = new Map(names.map((m) => [m.id, m.place]));
  const title = new Map(names.flatMap((m) => m.rows.map((r) => [r.titleId, r.name] as const)));
  return (
    <section
      aria-label={t.fill.rejectedTitle}
      className="flex flex-col gap-3 rounded-md border border-signal-line bg-signal-soft p-4"
    >
      <p className="label text-signal-fg">{t.fill.rejectedTitle}</p>
      <ul className="flex flex-col gap-3">
        {items.map((item) => (
          <li key={item.clientId} className="flex flex-col gap-2">
            <p className="text-md text-fg">
              {t.fill.rejectedLine(
                item.quantity,
                title.get(item.titleId) ?? t.fill.unknownTitle,
                place.get(item.machineId) ?? t.fill.unknownMachine,
              )}
            </p>
            {item.error ? <p className="text-sm text-muted">{t.serverError(item.error)}</p> : null}
            <div className="flex flex-wrap gap-2">
              {item.fromWarehouse ? (
                <button
                  type="button"
                  onClick={() => void onRetryDirect(item)}
                  className="min-h-11 rounded-sm border border-line-strong bg-surface px-3 text-md text-fg"
                >
                  {t.fill.saveDirect}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => onRemove(item)}
                className="min-h-11 px-3 text-md text-subtle hover:text-fg"
              >
                {t.common.remove}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
