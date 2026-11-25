"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
import { formatInt, NBSP } from "@/lib/format";
import { rememberKey, useRemembered } from "@/lib/remembered";
import { useHydrated } from "@/lib/use-hydrated";

import { undoRefills, type AwishPushStatus } from "@/app/(app)/drift/actions";
import { Sheet } from "@/app/(app)/lager/_components/sheet";
import { registerCount } from "@/app/(app)/lager/actions";
import { packMystery } from "@/app/(app)/vart-lager/mystery/actions";

import { refreshFill, retryAwishPush } from "../actions";
import { saveFillReturn } from "@/lib/fill-return";

import { bringStore, useBring, useDone, type Done } from "../_lib/done-store";
import {
  applyAdjustments,
  chooseSource,
  fillHeadline,
  fullFastNote,
  fillAllQty,
  maxFill,
  mysteryNote,
  mysteryShortAtHome,
  afterPacking,
  packAsks,
  qtyAfterCount,
  needLabel,
  pairKey,
  splitRefill,
  toggleBring,
  withPacked,
  needsRestartReminder,
  type FillAdjustment,
  type FillMachine,
  type FillRecipe,
  type FillRow,
  type PackAsk,
  type SourceChoice,
} from "../_lib/model";
import type { FillData, FillStore } from "../_lib/data";
import {
  clockLabel,
  lastAwishRead,
  refreshNotice,
  type RefreshNotice,
  type RefreshOutcome,
} from "../_lib/refresh";
import { FILL_BASE, machineIdFrom, shownMachineId, type FillNav } from "../_lib/route";
import {
  initialSelection,
  inSlotOrder,
  shortAtHome,
  tapQty,
  tapTile,
  type MachineLink,
} from "../_lib/tiles";
import { useFreshData } from "../_lib/use-fresh-data";
import { bringStrip, listGroups, minutesAt, nextMachineId, receiptItems } from "../_lib/list";
import { BringScreen } from "./bring-list";
import {
  BringCard,
  DoneRow,
  FullFold,
  NeedCard,
  placeLine,
  ReceiptCard,
  ReceiptSheet,
  UnknownCard,
  type NextStop,
} from "./fill-list";
import { usePhone } from "@/components/v2/use-media";
import { ConfirmSheet, MachineTop, MysterySheet, SayCard, SlotSheet, SlotTile } from "./fill-v2";
import { Button } from "@/components/v2/button";
import { RollingNumber } from "@/components/v2/rolling-number";

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
  /**
   * V2: ruttläget (öppnat från Rutt, ?rutt=1): dagens stopp i körordning. Stegraden "Stopp 2 av
   * 5" ersätter automatväljaren, och efter Klar öppnas nästa stopp. null = vanligt läge.
   */
  readonly route?: { readonly ids: readonly string[] } | null;
  /**
   * V2: öppnad från Hem eller Automater (?fran=): efter Klar går appen tillbaka dit och sidan
   * visar notisen med Ångra (src/lib/fill-return.ts). Bara när allt sparades direkt och Awish
   * fick antalen; annars stannar bekräftelsen här. null = stanna i Fyll på.
   */
  readonly returnTo?: string | null;
  /** V2: automater som är offline eller har strömmen av just nu (märket i rubriken och listan). */
  readonly links?: Readonly<Record<string, MachineLink>>;
}

const BASE = FILL_BASE;
/** En Awish-läsning yngre än så här pulserar. */
const FRESH_MS = 30 * 60_000;
/** Appen försöker själv skicka till Awish igen högst så här ofta. */
const AUTO_RETRY_MS = 5 * 60_000;
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
    case "notSent":
      return t.fill.awishNotSent(
        (status.notSent ?? [])
          .map((l) =>
            l.reason === "mystery_not_empty"
              ? t.fill.awishNotSentMystery(l.left, l.titleName, l.machine)
              : t.fill.awishNotSentFull(l.left, l.titleName, l.machine),
          )
          .join("; "),
      );
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
  route = null,
  returnTo = null,
  links = {},
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
  // V2: kvittot som ark direkt efter Klar (bara i minnet: en omladdning visar raden i listan).
  const [receiptOpen, setReceiptOpen] = useState(false);
  const phone = usePhone();
  // "Allt fullt" utfällt.
  const [fullOpen, setFullOpen] = useState(false);
  // När automaten öppnades (minuterna på kvittot).
  const openedAt = useRef<{ id: string; at: number } | null>(null);
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

  // Packat här ("Ja, packa 1 omgång och fyll på") men inte i serverns siffror än.
  const [packed, setPacked] = useState<{ base: FillData; deltas: PackDelta[] }>({
    base: data,
    deltas: [],
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

  // Automater som väntar på Awish: serverns lista, plus det som hänt här sedan sidan
  // hämtades (en sändning som just misslyckades, eller ett försök som just gick fram).
  const [pushLocal, setPushLocal] = useState<{
    base: FillData;
    failed: readonly string[];
    cleared: readonly string[];
  }>({ base: data, failed: [], cleared: [] });
  const notePush = useCallback(
    (failed: readonly string[], cleared: readonly string[]) => {
      if (failed.length === 0 && cleared.length === 0) return;
      setPushLocal((prev) => {
        const same = prev.base === data;
        const gone = new Set(cleared);
        const bad = new Set(failed);
        return {
          base: data,
          failed: [...(same ? prev.failed.filter((id) => !gone.has(id)) : []), ...failed],
          cleared: [...(same ? prev.cleared.filter((id) => !bad.has(id)) : []), ...cleared],
        };
      });
    },
    [data],
  );
  const pendingPush = useMemo(() => {
    const out = new Set(Object.keys(data.awishPending));
    if (pushLocal.base === data) {
      for (const id of pushLocal.failed) out.add(id);
      for (const id of pushLocal.cleared) out.delete(id);
    }
    return out;
  }, [data, pushLocal]);

  /** Beskedet om Awish efter att påfyllningar sparats (Klar, eller kön i bakgrunden). */
  const reportAwish = useCallback(
    (awish: AwishPushStatus | undefined, machineIds: readonly string[] = []) => {
      if (!awish) return;
      if (awish.failedMachineIds?.length) notePush(awish.failedMachineIds, []);
      // Butiken stänger av strömmen på natten: skärmen visar nya antal först efter omstart.
      const restart = needsRestartReminder(awish, machineIds, data.restartAfterPush);
      if (awish.state !== "sent") {
        // Gick det inte hela vägen till Awish: säg till. Raden på automaten ligger kvar.
        toast({
          title: t.fill.sendToAwish,
          description: restart
            ? `${awishText(t, awish)} ${t.fill.restartScreen}`
            : awishText(t, awish),
          tone: awish.state === "error" ? "critical" : "neutral",
        });
      } else {
        toast({
          title: awishText(t, awish),
          ...(restart ? { description: t.fill.restartScreen } : {}),
          tone: "ok",
        });
      }
    },
    [notePush, toast, t, data.restartAfterPush],
  );

  const q = useRefillQueue(scope, {
    onBackgroundSaved: (items, awish) => {
      onQueueSaved(items);
      reportAwish(
        awish,
        items.map((i) => i.machineId),
      );
      router.refresh();
    },
  });

  const pendingRef = useRef(pendingPush);
  useEffect(() => {
    pendingRef.current = pendingPush;
  }, [pendingPush]);

  // "Försök igen": skicka antalen till Awish en gång till (en automat, eller alla som väntar).
  const [retrying, setRetrying] = useState<string | null>(null);
  const retryBusy = useRef(false);
  const retryPush = useCallback(
    async (machineId: string | null, quiet = false) => {
      if (retryBusy.current) return;
      retryBusy.current = true;
      if (!quiet) setRetrying(machineId ?? "alla");
      try {
        const res = await retryAwishPush(machineId ? { machineId } : {}).catch(() => ({
          ok: false as const,
          error: t.common.offlineRetry,
        }));
        if (!res.ok) {
          if (!quiet) {
            toast({
              title: t.r2.t1.fill.retryFailedTitle,
              description: t.serverError(res.error),
              tone: "critical",
            });
          }
          return;
        }
        const still = new Set(res.data.pending);
        const asked = machineId ? [machineId] : [...pendingRef.current];
        notePush(
          asked.filter((id) => still.has(id)),
          asked.filter((id) => !still.has(id)),
        );
        // Awish fick antalen nu (också vid ett försök i bakgrunden): butiken stänger av
        // strömmen på natten, så skärmen visar dem först efter en omstart.
        const restart = needsRestartReminder(
          res.data.awish,
          machineId ? [machineId] : null,
          data.restartAfterPush,
        );
        if (res.data.cleared) {
          const slots = res.data.awish?.kind === "sent" ? (res.data.awish.slots ?? 0) : 0;
          toast({
            title: slots > 0 ? t.r2.t1.fill.retrySent(slots) : t.r2.t1.fill.retryNothing,
            ...(restart ? { description: t.fill.restartScreen } : {}),
            tone: "ok",
          });
        } else if (restart) {
          // En del gick fram (raden på automaten visar vad som väntar): påminn om omstarten.
          const slots = res.data.awish?.slots ?? 0;
          toast({
            title: slots > 0 ? t.r2.t1.fill.retrySent(slots) : t.fill.sendToAwish,
            description: t.fill.restartScreen,
            tone: "neutral",
          });
        } else if (!quiet) {
          toast({
            title: t.r2.t1.fill.retryFailedTitle,
            description: t.r2.t1.fill.retryFailedHint,
            tone: "critical",
          });
        }
        if (res.data.cleared || !quiet) router.refresh();
      } finally {
        retryBusy.current = false;
        setRetrying(null);
      }
    },
    [notePush, router, toast, t, data.restartAfterPush],
  );
  // Appen försöker igen själv: strax efter att sidan öppnats och sedan var femte minut,
  // så länge någon automat väntar och det finns nät.
  const lastAutoRetry = useRef(0);
  const waitingPush = pendingPush.size;
  useEffect(() => {
    if (waitingPush === 0 || !q.online) return;
    const run = () => {
      if (Date.now() - lastAutoRetry.current < AUTO_RETRY_MS) return;
      lastAutoRetry.current = Date.now();
      void retryPush(null, true);
    };
    const first = window.setTimeout(run, 3_000);
    const timer = window.setInterval(run, 60_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [q.online, retryPush, waitingPush]);
  const pendingLine = (m: { id: string; code: string }) =>
    pendingPush.has(m.id) ? (
      <AwishPendingLine
        title={t.r2.t1.fill.awishPending(m.code)}
        busy={retrying === m.id || retrying === "alla"}
        disabled={!q.online}
        onRetry={() => void retryPush(m.id)}
      />
    ) : null;

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
      if (out.saved.length > 0) {
        onQueueSaved(out.saved);
        reportAwish(
          out.awish,
          out.saved.map((i) => i.machineId),
        );
      }
    } catch {
      // Kön ligger kvar och skickas nästa gång.
    }
    startRefresh(() => router.refresh());
  }, [onQueueSaved, reportAwish, router, syncQueue]);
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
  const refreshButton = simple ? (
    <RefreshButton busy={busy} onClick={() => void update()} />
  ) : (
    // V2: kompakt (ikonen på telefon, texten från 901 px).
    <Button
      className="refresh"
      onClick={() => void update()}
      disabled={busy}
      aria-busy={busy}
      aria-label={busy ? t.fill.refreshing : t.fill.refresh}
    >
      <Icon name="refresh" size={16} className={cn(busy && "motion-safe:animate-spin")} />
      <span className="lbl">{busy ? t.fill.refreshing : t.fill.refresh}</span>
    </Button>
  );
  const noticeLine = notice ? <NoticeLine notice={notice} /> : null;

  /** Ångra en påfyllning (bekräftelsen, eller Ångra i notisen i V2). */
  const undoDone = async (d: Done) => {
    const ids = new Set(d.clientIds);
    const queued = q.queue.filter((i) => ids.has(i.clientId));
    for (const i of queued) await q.remove(i.clientId);
    const queuedIds = new Set(queued.map((i) => i.clientId));
    const sent = d.clientIds.filter((id) => !queuedIds.has(id));
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
      items: prev.items.filter((i) => !("clientId" in i) || !ids.has((i as QueuedRefill).clientId)),
    }));
    setDone(null);
    toast({ title: t.fill.undone(d.packs), tone: "neutral" });
    router.refresh();
  };

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
    const stock = withPacked(sources.stock, packed.base === data ? packed.deltas : []);
    const first = applyAdjustments(data.machines, stock, adj, counts, (id) =>
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
    const out = applyAdjustments(data.machines, stock, adj, counts, (id) => choice[id]?.id ?? null);
    return { ...out, choice };
  }, [counted, data, lastSource, override, packed, q.queue, saved, sources, t]);
  const sourceOf = (machineId: string) => view.choice[machineId]?.id ?? null;

  const go = useCallback((href: string) => {
    // Ruttläget bär ?rutt=1: automaten läses ur sökvägen utan frågan.
    setNav({ machineId: machineIdFrom(href.split("?")[0]) });
    window.history.pushState(null, "", href);
    window.scrollTo({ top: 0 });
  }, []);

  const selected = selectedId ? view.machines.find((m) => m.id === selectedId) : undefined;
  useEffect(() => {
    if (selectedId && openedAt.current?.id !== selectedId) {
      openedAt.current = { id: selectedId, at: Date.now() };
    }
  }, [selectedId]);
  const looks = data.looks ?? {};
  const stores = data.stores ?? {};
  const nextStopOf = (id: string | null | undefined): NextStop | null => {
    const m = id ? view.machines.find((x) => x.id === id) : undefined;
    if (!m) return null;
    return {
      machine: m,
      store: stores[m.id] ?? null,
      look: looks[m.id] ?? null,
      link: links[m.id] ?? null,
    };
  };
  const clockOf = (iso: string | undefined): string | null => {
    if (!iso) return null;
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return null;
    try {
      return new Intl.DateTimeFormat("sv-SE", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone,
      }).format(d);
    } catch {
      return null;
    }
  };
  // Kvittot som ark (V2): på telefonen alltid, på datorn när en automat är öppen (listan har
  // kortet i högerspalten).
  const receiptSheet = (onMachine: boolean) =>
    !simple && done && (phone || onMachine) ? (
      <ReceiptSheet
        done={done}
        open={receiptOpen}
        next={nextStopOf(done.receipt?.nextId)}
        onClose={() => setReceiptOpen(false)}
        onUndo={async () => {
          setReceiptOpen(false);
          await undoDone(done);
        }}
        onOpenNext={() => {
          const id = done.receipt?.nextId;
          if (!id) return;
          setDone(null);
          go(`${BASE}/${id}${done.receipt?.onRoute ? routeSuffix : ""}`);
        }}
        onEndDay={
          route
            ? () => {
                setReceiptOpen(false);
                router.push("/rutt");
              }
            : undefined
        }
      />
    ) : null;
  const rejected = q.queue.filter((i) => i.status === "rejected");
  const waiting = q.queue.length - rejected.length;

  // Ruttläget (V2): dagens stopp som finns bland automaterna, i körordning.
  const stops = route ? route.ids.filter((id) => view.machines.some((m) => m.id === id)) : [];
  const stopIndex = selectedId ? stops.indexOf(selectedId) : -1;
  const routeSuffix = route ? "?rutt=1" : "";
  const goStop = (i: number) => {
    const id = stops[i];
    if (id) go(`${BASE}/${id}${routeSuffix}`);
  };

  if (selectedId && selected) {
    const source = sourceOf(selected.id);
    return (
      <>
        <MachineScreen
          key={`${selected.id}/${source ?? ""}`}
          v2={!simple}
          store={data.stores?.[selected.id] ?? null}
          machines={view.machines}
          onPick={(id) => go(`${BASE}/${id}`)}
          restartHint={(data.restartAfterPush ?? []).includes(selected.id)}
          link={links[selected.id] ?? null}
          route={
            stopIndex >= 0
              ? {
                  index: stopIndex,
                  total: stops.length,
                  ...(stopIndex > 0 ? { onPrev: () => goStop(stopIndex - 1) } : {}),
                  ...(stopIndex < stops.length - 1 ? { onNext: () => goStop(stopIndex + 1) } : {}),
                }
              : null
          }
          machine={selected}
          places={sources.places.map((p) => ({
            id: p.id,
            name: p.name,
            count: Object.values(view.stock[p.id] ?? {}).reduce((n, v) => n + Math.max(0, v), 0),
          }))}
          sourceId={source}
          sourceStock={source ? (view.stock[source] ?? {}) : null}
          recipes={data.recipes}
          onPacked={(deltas) =>
            setPacked((prev) => ({
              base: data,
              deltas: [...(prev.base === data ? prev.deltas : []), ...deltas],
            }))
          }
          sourceReason={view.choice[selected.id]?.reason ?? null}
          onSource={(id) => setOverride((prev) => ({ ...prev, [selected.id]: id }))}
          syncLabel={syncLabels[selected.id]}
          fresh={fresh[selected.id] ?? false}
          online={q.online}
          headerActions={
            <div className="flex items-center gap-2">
              {refreshButton}
              <NetPill online={q.online} waiting={waiting} syncing={q.syncing} v2={!simple} />
            </div>
          }
          notice={
            <>
              {noticeLine}
              {pendingLine(selected)}
            </>
          }
          onBack={() => (route ? router.push("/rutt") : go(BASE))}
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
              const routeNext = stopIndex >= 0 ? (stops[stopIndex + 1] ?? null) : null;
              const doneAt = Date.now();
              const d: Done = {
                packs,
                left: source ? t.fill.leftAt(Math.max(0, homeLeft), placeName(source)) : "",
                offline: out.offline,
                clientIds: items.map((i) => i.clientId).filter((id) => !rejectedIds.has(id)),
                restart: needsRestartReminder(out.awish, [selected.id], data.restartAfterPush),
                receipt: {
                  machineId: selected.id,
                  name: selected.name || selected.code,
                  place: placeLine(selected, data.stores?.[selected.id] ?? null),
                  items: receiptItems(lines),
                  minutes: minutesAt(
                    openedAt.current?.id === selected.id ? openedAt.current.at : null,
                    doneAt,
                  ),
                  at: new Date(doneAt).toISOString(),
                  nextId: nextMachineId({
                    justFilled: selected.id,
                    routeNext,
                    machines: view.machines,
                  }),
                  onRoute: routeNext !== null,
                },
              };
              // V2, öppnad från Hem/Automater: tillbaka dit när allt sparades och Awish fick
              // antalen (annars behövs beskedet här, t.ex. omstarten eller "Försök igen").
              const savedIds = new Set(out.saved.map((i) => i.clientId));
              if (
                returnTo &&
                !simple &&
                stopIndex < 0 &&
                !out.offline &&
                !d.restart &&
                (!out.awish || out.awish.state === "sent") &&
                items.every((i) => savedIds.has(i.clientId)) &&
                saveFillReturn({
                  title: t.fill.doneTitle(packs),
                  detail: `${selected.name}${d.left ? ` · ${d.left}` : ""}`,
                  packs,
                  clientIds: d.clientIds,
                })
              ) {
                rememberSaved(out.saved);
                router.push(returnTo);
                router.refresh();
                return;
              }
              setDone(d);
              // V2: kvittot som ark direkt (i ruttläget över nästa stopp, med "Kör dit"), med
              // Ångra. I listan står bekräftelsen sedan kvar som en rad (telefonen) eller ett kort
              // i högerspalten (datorn).
              // Bara när arket faktiskt visas: på datorn utan rutt står kvittot som kort i
              // listan, och ett kvarglömt "öppet" skulle annars visa det gamla kvittot igen
              // (t.ex. med Bakåt till automaten).
              const ahead = stopIndex >= 0 ? stops[stopIndex + 1] : undefined;
              if (!simple && (phone || ahead)) setReceiptOpen(true);
            }
            if (out.saved.length > 0) rememberSaved(out.saved);
            reportAwish(out.awish, [selected.id]);
            // Ruttläget: nästa stopp direkt; sista stoppet (eller vanligt läge) tillbaka till listan.
            // Bekräftelsen syns direkt, sedan hämtas datan om för den adressen.
            const nextStop = stopIndex >= 0 ? stops[stopIndex + 1] : undefined;
            go(nextStop ? `${BASE}/${nextStop}${routeSuffix}` : BASE);
            if (out.saved.length > 0) router.refresh();
          }}
        />
        {receiptSheet(true)}
      </>
    );
  }

  const mine = data.hasOthers && mineOnly === "1";
  const visible = mine ? view.machines.filter((m) => m.mine) : view.machines;
  // Automater som väntar på Awish ("Awish fick inte antalen …"): EN ruta överst på sidan, före
  // Ta med-listan och automaterna. Automaten är oftast full efter påfyllningen och ligger sist
  // i listan, så en rad under kortet hamnar under skärmkanten. Väntar flera (Awish nere, eller
  // inloggningen har gått ut) räcker ett Försök igen för alla.
  const waitingShown = visible.filter((m) => pendingPush.has(m.id));
  const shown = visible;

  // Ta med-listan följer alltid den vanliga ordningen.
  if (bring && visible.length > 0) {
    return (
      <BringScreen
        machines={visible}
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
          setBring({ ...current, chosen: toggleBring(current.chosen, visible, id) });
        }}
        placeId={pickPlace(sources.places, bring.placeId, lastSource, sources.defaultPlaceId)}
        online={q.online}
        headerActions={
          <div className="flex items-center gap-2">
            {refreshButton}
            <NetPill online={q.online} waiting={waiting} syncing={q.syncing} v2={!simple} />
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

  if (!simple) {
    const groups = listGroups(shown);
    const bring = bringStrip(groups.need);
    const ariaOf = (m: (typeof shown)[number]) =>
      t.fill.cardAria(m.place, needLabel(m, t), m.fillPct);
    const openMachine = (id: string) => {
      setDone(null);
      go(`${BASE}/${id}`);
    };
    const awishLine =
      waitingShown.length === 1 ? (
        pendingLine(waitingShown[0]!)
      ) : waitingShown.length > 1 ? (
        <AwishPendingLine
          title={t.r2.t1.fill.awishPendingMany(
            waitingShown
              .map((m) => m.code)
              .sort((a, b) => a.localeCompare(b, "sv", { numeric: true })),
          )}
          busy={retrying !== null}
          disabled={!q.online}
          onRetry={() => void retryPush(null)}
        />
      ) : null;
    return (
      <div className="v2-fill-app">
        <header className="top">
          <Link href="/" className="back" aria-label="Till Hem">
            <Icon name="chevronLeft" size={22} />
          </Link>
          <h1>
            {t.fill.title}
            {lastRead ? (
              <span className="crumb keep">
                {t.fill.awishRead(clockLabel(lastRead, renderedAt, timeZone, t))}
              </span>
            ) : null}
          </h1>
          <div className="tools">
            {refreshButton}
            <NetPill online={q.online} waiting={waiting} syncing={q.syncing} v2={!simple} />
          </div>
        </header>
        {noticeLine}
        <section className="pn say-list" aria-live="polite">
          <h2>
            {need > 0
              ? `${t.fill.needPrefix}${formatInt(need)}${t.fill.needSuffix(need)}`
              : headline}
          </h2>
          {data.hasWarehouse || waitingAwish ? (
            <p className="mt-2 text-v2-md text-v2-mute">
              {data.hasWarehouse ? `${formatInt(homeTotal)}${NBSP}${stockLabel}` : null}
              {data.hasWarehouse && waitingAwish ? " · " : null}
              {waitingAwish ? t.fill.waitingAwish : null}
            </p>
          ) : null}
          {data.hasOthers ? (
            <div className="mt-3">
              <MineSwitch mine={mine} onChange={(v) => setMineOnly(v ? "1" : null)} />
            </div>
          ) : null}
        </section>
        {awishLine}
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
        {shown.length === 0 && mine ? (
          <p className="text-v2-md text-v2-mute">{t.fill.noneMine}</p>
        ) : null}
        {shown.length > 0 ? (
          <div className="fl">
            <div className="fl-main">
              {done && !(phone && receiptOpen) ? (
                <DoneRow
                  done={done}
                  clock={clockOf(done.receipt?.at)}
                  status={phone}
                  onUndo={() => undoDone(done)}
                  onClose={() => setDone(null)}
                />
              ) : null}
              <ul className="fl-group" aria-label={t.fill.machines}>
                {groups.need.length > 0 ? (
                  <li>
                    <ul className="fl-list">
                      {groups.need.map((m, i) => (
                        <li key={m.id}>
                          <NeedCard
                            m={m}
                            store={stores[m.id] ?? null}
                            link={links[m.id] ?? null}
                            look={looks[m.id] ?? null}
                            href={`${BASE}/${m.id}`}
                            ariaLabel={ariaOf(m)}
                            next={i === 0}
                            onOpen={() => openMachine(m.id)}
                          />
                        </li>
                      ))}
                    </ul>
                  </li>
                ) : null}
                {groups.unknown.length > 0 ? (
                  <li>
                    <p className="fl-sec">Okänd nivå</p>
                    <ul className="fl-group">
                      {groups.unknown.map((m) => (
                        <li key={m.id}>
                          <UnknownCard
                            m={m}
                            store={stores[m.id] ?? null}
                            link={links[m.id] ?? null}
                            look={looks[m.id] ?? null}
                            href={`${BASE}/${m.id}`}
                            ariaLabel={ariaOf(m)}
                            onOpen={() => openMachine(m.id)}
                          />
                        </li>
                      ))}
                    </ul>
                  </li>
                ) : null}
                {groups.full.length > 0 ? (
                  <li>
                    <FullFold
                      machines={groups.full}
                      looks={looks}
                      links={links}
                      stores={stores}
                      // Inget att fylla alls: listan är redan utfälld.
                      open={fullOpen || (groups.need.length === 0 && groups.unknown.length === 0)}
                      onToggle={() => setFullOpen((o) => !o)}
                      hrefOf={(id) => `${BASE}/${id}`}
                      ariaOf={ariaOf}
                      onOpen={openMachine}
                    />
                  </li>
                ) : null}
              </ul>
            </div>
            <aside className="fl-side" aria-label="Ta med och nästa">
              {done && !phone ? (
                <ReceiptCard
                  done={done}
                  onClose={() => setDone(null)}
                  onUndo={() => undoDone(done)}
                />
              ) : null}
              {/* Nästa automat står redan först i listan (mörk ram): inget kort till om den. */}
              {bring.total > 0 ? (
                <BringCard
                  items={bring.items}
                  total={bring.total}
                  onOpen={() => {
                    setBring({ chosen: null, placeId: null });
                    window.scrollTo({ top: 0 });
                  }}
                />
              ) : null}
            </aside>
          </div>
        ) : null}
        {receiptSheet(false)}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 px-4 pt-[max(16px,env(safe-area-inset-top))] pb-[calc(32px+env(safe-area-inset-bottom))]">
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
            <NetPill online={q.online} waiting={waiting} syncing={q.syncing} v2={!simple} />
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
        <DoneBanner done={done} onClose={() => setDone(null)} onUndo={() => undoDone(done)} />
      ) : null}

      {waitingShown.length === 1 ? (
        pendingLine(waitingShown[0]!)
      ) : waitingShown.length > 1 ? (
        <AwishPendingLine
          title={t.r2.t1.fill.awishPendingMany(
            waitingShown
              .map((m) => m.code)
              .sort((a, b) => a.localeCompare(b, "sv", { numeric: true })),
          )}
          busy={retrying !== null}
          disabled={!q.online}
          onRetry={() => void retryPush(null)}
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

/**
 * Sändningen till Awish gick inte fram för automaten: raden ligger kvar tills den gått fram
 * ("Awish fick inte antalen för BL-003." med Försök igen). Påfyllningen är sparad i appen.
 */
function AwishPendingLine({
  title,
  busy,
  disabled,
  onRetry,
}: {
  /** "Awish fick inte antalen för BL-003." */
  title: string;
  busy: boolean;
  disabled: boolean;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md border border-signal-line bg-surface p-3"
    >
      <p className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        <span className="text-md font-medium text-signal-fg">{title}</span>
        <span className="text-sm text-muted">{t.r2.t1.fill.awishPendingHint}</span>
      </p>
      <button
        type="button"
        disabled={busy || disabled}
        aria-busy={busy}
        onClick={onRetry}
        className="min-h-11 shrink-0 rounded-md border border-line-strong bg-raised px-4 text-md font-medium text-fg active:bg-hover disabled:text-disabled"
      >
        {busy ? t.r2.t1.fill.retrying : t.r2.t1.fill.retry}
      </button>
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
  v2 = false,
}: {
  online: boolean;
  waiting: number;
  syncing: boolean;
  /** V2: vanlig text (inte versaler eller kodtypsnitt), V2-färger. */
  v2?: boolean;
}) {
  const t = useT();
  return (
    <span
      role="status"
      aria-live="polite"
      data-net={online ? (waiting > 0 ? "sending" : "online") : "offline"}
      className={
        v2
          ? cn("v2-net net", !online && "off", online && waiting === 0 && "calm")
          : cn(
              "net label inline-flex min-h-8 items-center gap-2 rounded-full border px-3",
              online ? "border-line text-subtle" : "border-signal-line text-signal-fg",
            )
      }
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-1.5 rounded-full bg-current",
          v2 && "dt",
          syncing && "live-dot",
          online && waiting === 0 && "text-muted",
        )}
      />
      {v2 ? (
        // V2 på telefonen: bara pricken när allt är som vanligt (har nät, inget i kön); texten
        // står kvar för skärmläsare. Utan nät eller med kö syns texten alltid.
        <span className={cn("tx", online && waiting === 0 && "quiet")}>
          {online
            ? waiting > 0
              ? t.fill.sending(waiting)
              : t.fill.online
            : waiting > 0
              ? t.fill.offlineQueued(waiting)
              : t.fill.offline}
        </span>
      ) : online ? (
        waiting > 0 ? (
          t.fill.sending(waiting)
        ) : (
          t.fill.online
        )
      ) : waiting > 0 ? (
        t.fill.offlineQueued(waiting)
      ) : (
        t.fill.offline
      )}
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
      className="rise flex flex-col gap-3 rounded-md border border-up-line bg-surface p-4"
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-up text-bg"
        >
          <Icon name="check" size={22} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-lg font-medium text-fg">{t.fill.doneTitle(done.packs)}</span>
          <span className="text-sm text-muted">
            {done.offline ? t.fill.doneOffline : done.left}
          </span>
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
      </div>
      {done.restart ? (
        // Butiken stänger av strömmen på natten: skärmen läser antalen när den startar.
        <p
          data-restart-reminder
          className="border-t border-line pt-3 text-md font-medium text-balance text-fg"
        >
          {t.fill.restartScreen}
        </p>
      ) : null}
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

/** En ändring i ett eget lager efter en packning här (delar ut, mystery packs in). */
interface PackDelta {
  readonly placeId: string;
  readonly titleId: string;
  readonly delta: number;
}

/** Frågorna "Packade du en omgång?" före Klar: en i taget, med svaren hittills. */
interface Asking {
  readonly asks: readonly PackAsk[];
  readonly index: number;
  readonly yes: readonly PackAsk[];
}

function MachineScreen({
  machine: m,
  places,
  sourceId,
  sourceStock,
  recipes,
  onPacked,
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
  v2 = false,
  store = null,
  machines = [],
  onPick,
  route = null,
  restartHint = false,
  link = null,
}: {
  /** V2: offline, eller strömmen av just nu (märket i rubriken). */
  link?: MachineLink | null;
  /** V2: butiken stänger av strömmen på natten (påminn om omstart vid bekräftelsen). */
  restartHint?: boolean;
  /** V2-utseendet (inte i Enkel vy). */
  v2?: boolean;
  /** V2: butiken vid automaten (adress, kontakt, strömtider). */
  store?: FillStore | null;
  /** V2: automaterna för "Byt automat". */
  machines?: readonly FillMachine[];
  onPick?: (id: string) => void;
  /** V2: ruttläget ("Stopp 2 av 5"). */
  route?: { index: number; total: number; onPrev?: () => void; onNext?: () => void } | null;
  machine: FillMachine;
  /** Våra lager med antal pack (för "Från: Hemma ▾"). */
  places: readonly { id: string; name: string; count: number }[];
  /** Lagret packen tas från, null = inget eget lager. */
  sourceId: string | null;
  /** Saldot per titel i lagret packen tas från (efter kön), null = inget eget lager. */
  sourceStock: Readonly<Record<string, number>> | null;
  /** Mystery packs: gällande innehåll per titel (för "Packade du en omgång?"). */
  recipes: Readonly<Record<string, FillRecipe>>;
  /** En packning gjordes här: lagrets saldo ändras direkt på skärmen. */
  onPacked: (deltas: PackDelta[]) => void;
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
  // Allt börjar på 0 (ägarens val A): inga förifyllda förslag. Ett tryck på en ruta (V2) eller
  // "Fyll facket" (Enkel vy) fyller facket; ny data (Uppdatera) ändrar inget som valts.
  const [qty, setQty] = useState<Record<string, number>>(initialSelection);
  const [touched, setTouched] = useState(false);
  // Arket för ett fack (V2): stegaren, Töm och "Fel antal i automaten?". Raden står kvar medan
  // arket stängs (animationen), därför öppet för sig.
  const [sheet, setSheet] = useState<{ titleId: string; open: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [counting, setCounting] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  // Klar sparar och skickar till Awish: fråga först, så att ett tryck av misstag (t.ex. när
  // man packar hemma) inte registrerar en påfyllning.
  const [confirming, setConfirming] = useState(false);
  // Mystery packs som fylls på fast de inte finns färdiga i lagret: "Packade du en omgång?".
  const [asking, setAsking] = useState<Asking | null>(null);
  const [packing, setPacking] = useState(false);
  // Klient-id per påbörjad packning (lager, titel, innehåll, omgångar) tills den gått fram.
  const packIds = useRef(new Map<string, string>());
  // Ändrade antal som inte sparats: appen laddar inte om av sig själv för en ny version.
  useUnsavedInput(touched || busy || confirming || asking !== null || counting !== null);
  const linesNow = (): Line[] =>
    m.rows.map((row) => ({ row, quantity: qty[row.titleId] ?? 0 })).filter((l) => l.quantity > 0);
  /** Sparar påfyllningen. `toPack`: omgångar som först packas i lagret (svaret Ja). */
  const finish = async (toPack: readonly PackAsk[] = []) => {
    setBusy(true);
    try {
      let lines = linesNow();
      if (toPack.length > 0 && sourceId) {
        setPacking(true);
        for (const ask of toPack) {
          // Samma id vid ett nytt försök: kom svaret aldrig fram (nätet dog) men packningen
          // sparades, packas det inte en gång till när man trycker Ja igen.
          const packKey = `${sourceId}:${ask.titleId}:${ask.recipeId}:${ask.batches}`;
          const clientId = packIds.current.get(packKey) ?? newClientId();
          packIds.current.set(packKey, clientId);
          const res = await packMystery({
            titleId: ask.titleId,
            placeId: sourceId,
            batches: ask.batches,
            recipeId: ask.recipeId,
            clientId,
          }).catch(() => ({ ok: false as const, error: t.common.offlineRetry }));
          if (!res.ok) {
            // Inget är påfyllt än: stanna här, så att man kan trycka Klar igen.
            toast({
              title: t.r2.t1.fill.packFailed,
              description: `${t.serverError(res.error)} ${t.r2.t1.fill.packFailedHint}`,
              tone: "critical",
            });
            return;
          }
          packIds.current.delete(packKey);
          onPacked([
            { placeId: sourceId, titleId: ask.titleId, delta: ask.packs },
            ...(recipes[ask.titleId]?.items ?? []).map((i) => ({
              placeId: sourceId,
              titleId: i.titleId,
              delta: -i.quantity * ask.batches,
            })),
          ]);
        }
        // De nypackade packen ligger nu i lagret: påfyllningen tar dem därifrån. Delarna som
        // gick åt finns inte längre: en titel som också fylls på lös får högst det som är kvar.
        const done = afterPacking(lines, recipes, toPack);
        lines = done.lines;
        if (done.cut.length > 0) {
          toast({
            title: t.r2.t1.fill.packCutTitle,
            description: done.cut
              .map((c) => t.r2.t1.fill.packCutDone(c.name, c.to, c.from))
              .join(" "),
            tone: "neutral",
            duration: 12_000,
          });
        }
      }
      setPacking(false);
      await onDone(lines);
    } finally {
      setBusy(false);
      setPacking(false);
      setConfirming(false);
      setAsking(null);
    }
  };
  const ask = asking ? asking.asks[asking.index] : undefined;
  const lastAsk = asking !== null && asking.index === asking.asks.length - 1;
  const answer = (yes: boolean) => {
    if (!asking || !ask) return;
    const next = yes ? [...asking.yes, ask] : asking.yes;
    if (lastAsk) void finish(next);
    else setAsking({ ...asking, index: asking.index + 1, yes: next });
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

  /** Klar: fråga om mystery-omgångar eller bekräfta; utan antal tillbaka till listan. */
  const onKlar = async () => {
    if (total > 0) {
      // Utan nät går det inte att packa: påfyllningen läggs i kön som vanligt.
      const asks = online ? packAsks(linesNow(), recipes, sourceStock) : [];
      if (asks.length > 0) setAsking({ asks, index: 0, yes: [] });
      else setConfirming(true);
      return;
    }
    toast({ title: t.fill.nothingFilled, tone: "neutral" });
    await finish();
  };
  const fillAll = () => {
    setTouched(true);
    setQty(Object.fromEntries(m.rows.map((r) => [r.titleId, fillAllQty(r, qty[r.titleId] ?? 0)])));
  };
  const onCount = async (r: FillRow, value: number) => {
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
    // Ett valt fack fylls till det som får plats efter räkningen; ett som inte är valt står
    // kvar på 0 (allt börjar på 0).
    const next = qtyAfterCount(r, value);
    if (next !== null && (qty[r.titleId] ?? 0) > 0) {
      set(r.titleId, next, maxFill({ ...r, now: value }));
    }
    toast({ title: t.fill.countSaved(value), tone: "ok" });
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
        hasSource={sourceId !== null}
        value={qty[r.titleId] ?? 0}
        onChange={(v) => set(r.titleId, v, maxFill(r))}
        fillQty={tapQty(r, sourceId !== null)}
        counting={counting === r.titleId}
        onCountToggle={() => setCounting((c) => (c === r.titleId ? null : r.titleId))}
        onCount={(value) => onCount(r, value)}
      />
    </li>
  );

  if (v2) {
    const sourceSheet = (
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
    );
    const hasSource = sourceId !== null;
    const tiles = inSlotOrder(m.rows, m.slots);
    const tap = (r: FillRow) => {
      const out = tapTile(qty, r, hasSource);
      if (out.selection !== qty) {
        setTouched(true);
        setQty({ ...out.selection });
      }
      if (out.sheet) setSheet({ titleId: r.titleId, open: true });
    };
    const sheetRow = sheet ? m.rows.find((r) => r.titleId === sheet.titleId) : undefined;
    const slotsSection = (
      <section className="slots" aria-label={t.fill.titlesAria}>
        <div className="tapline">
          <span>Tryck på ett fack för att fylla det</span>
          {m.rows.some((r) => r.capacity !== null) ? (
            <button type="button" className="fillall" onClick={fillAll}>
              Fyll alla
            </button>
          ) : null}
        </div>
        {places.length > 1 ? (
          <div className="srcline">
            <Button size="sm" onClick={() => setChoosing(true)}>
              {t.fill.from} {t.common.placeName(sourceName)}
            </Button>
            {sourceReason ? <span>{sourceReason}</span> : null}
          </div>
        ) : null}
        {m.rows.length === 0 ? (
          <p className="empty">{t.fill.noTitles}</p>
        ) : (
          <ul className="tiles">
            {tiles.map((r) => (
              <li key={r.titleId}>
                <SlotTile
                  row={r}
                  value={qty[r.titleId] ?? 0}
                  hasSource={hasSource}
                  onTap={() => tap(r)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    );
    return (
      <div className="v2-fill-app v2-fill-machine">
        <MachineTop
          m={m}
          store={store}
          machines={machines}
          onPick={(id) => onPick?.(id)}
          onBack={onBack}
          backLabel={t.fill.machines}
          route={route}
          syncLabel={syncLabel}
          link={link}
          tools={headerActions}
        />
        {notice}
        {/* Datorn: facken till vänster, sammanfattningen och Klar till höger. Telefonen: en
            kolumn (main2 och side2 är display: contents), Klar fäst nedtill. */}
        <div className="work">
          <div className="main2">{slotsSection}</div>
          <div className="side2">
            <SayCard m={m} total={total} after={after} source={null} />
            <div className="foot">
              <Button
                variant="act"
                size="lg"
                disabled={busy || total === 0}
                pending={busy}
                onClick={() => void onKlar()}
                aria-label={
                  busy ? t.common.saving : total > 0 ? t.fill.doneWith(total) : t.fill.done
                }
              >
                {busy ? (
                  t.common.saving
                ) : (
                  <span className="klar" aria-hidden="true">
                    {t.fill.done}
                    <span className="sep">·</span>
                    <RollingNumber value={total} unit="pack" />
                  </span>
                )}
              </Button>
            </div>
          </div>
        </div>
        {sheet && sheetRow ? (
          <SlotSheet
            row={sheetRow}
            open={sheet.open}
            onClose={() => {
              // "Fel antal i automaten?" stängs med arket (annars spärrar det appens uppdatering).
              setCounting((c) => (c === sheetRow.titleId ? null : c));
              setSheet((s) => (s ? { ...s, open: false } : s));
            }}
            value={qty[sheetRow.titleId] ?? 0}
            onChange={(v) => set(sheetRow.titleId, v, maxFill(sheetRow))}
            sourceName={sourceName}
            hasSource={hasSource}
            countSlot={
              <CountForm
                row={sheetRow}
                counting={counting === sheetRow.titleId}
                onToggle={() =>
                  setCounting((c) => (c === sheetRow.titleId ? null : sheetRow.titleId))
                }
                onCount={(value) => onCount(sheetRow, value)}
              />
            }
          />
        ) : null}
        <ConfirmSheet
          open={confirming}
          total={total}
          busy={busy}
          restart={restartHint}
          short={
            hasSource
              ? m.rows.reduce((n, r) => n + shortAtHome(r, qty[r.titleId] ?? 0, true), 0)
              : 0
          }
          onYes={() => void finish()}
          onClose={() => setConfirming(false)}
        />
        <MysterySheet
          ask={ask}
          last={lastAsk}
          busy={busy}
          packing={packing}
          sourceName={sourceName}
          cut={
            asking && ask
              ? afterPacking(linesNow(), recipes, [...asking.yes, ask]).cut.map((c) =>
                  t.r2.t1.fill.packAskCut(c.name, c.to, c.from),
                )
              : []
          }
          onAnswer={answer}
          onCancel={() => setAsking(null)}
        />
        {sourceSheet}
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <div className="flex flex-1 flex-col gap-5 px-4 pt-[max(12px,env(safe-area-inset-top))] pb-6">
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
              onClick={fillAll}
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
        {asking && ask ? (
          <div
            className="flex flex-col gap-2"
            role="group"
            aria-label={t.r2.t1.fill.packAskQuestion(ask.batches)}
          >
            <p className="text-md text-muted">
              {t.r2.t1.fill.packAskHave(ask.home, ask.name, sourceName)}
            </p>
            <p className="text-lg font-medium text-fg">
              {t.r2.t1.fill.packAskQuestion(ask.batches)}
            </p>
            <p className="text-sm text-muted">{t.r2.t1.fill.packAskDetail(sourceName)}</p>
            {/* Omgången tar delar som också står på listan: säg det före Ja. */}
            {afterPacking(linesNow(), recipes, [...asking.yes, ask]).cut.map((c) => (
              <p key={c.titleId} className="text-md font-medium text-signal-fg">
                {t.r2.t1.fill.packAskCut(c.name, c.to, c.from)}
              </p>
            ))}
            <button
              type="button"
              disabled={busy}
              onClick={() => answer(true)}
              className={cn(
                "flex min-h-14 w-full items-center justify-center gap-2 rounded-md border px-3 text-lg font-medium transition-colors",
                busy
                  ? "border-dashed border-line-strong text-disabled"
                  : "border-inverse bg-inverse text-on-inverse active:bg-inverse-hover",
              )}
            >
              <Icon name="check" size={20} />
              {busy
                ? packing
                  ? t.r2.t1.fill.packing
                  : t.common.saving
                : t.r2.t1.fill.packAskYes(ask.batches, lastAsk)}
            </button>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => answer(false)}
                className="flex min-h-12 w-full items-center justify-center rounded-md border border-line-control px-3 text-md font-medium text-fg disabled:text-disabled"
              >
                {t.r2.t1.fill.packAskNo(lastAsk)}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setAsking(null)}
                className="flex min-h-12 w-full items-center justify-center rounded-md px-3 text-md text-subtle hover:text-fg disabled:text-disabled"
              >
                {t.common.cancel}
              </button>
            </div>
          </div>
        ) : confirming ? (
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
            onClick={() => void onKlar()}
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
  hasSource,
  value,
  onChange,
  fillQty,
  counting,
  onCountToggle,
  onCount,
}: {
  row: FillRow;
  /** Lagret packen tas från ("Hemma"). */
  sourceName: string;
  /** Det finns ett eget lager att ta packen från. */
  hasSource: boolean;
  value: number;
  onChange: (v: number) => void;
  /** "Fyll facket": antalet ett tryck väljer (som en ruta i V2), 0 = knappen visas inte. */
  fillQty: number;
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
  // Tomt mystery-fack men ingen hel omgång färdig i lagret: säg det och erbjud en omgång.
  const shortBatch = hasSource && value === 0 ? mysteryShortAtHome(r) : null;
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
      {shortBatch !== null ? (
        <div className="-mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <p className="text-sm text-signal-fg" role="note">
            {t.r2.t1.fill.mysteryReady(Math.max(0, r.home), sourceName)}
          </p>
          <button
            type="button"
            onClick={() => onChange(shortBatch)}
            className="min-h-11 rounded-sm border border-line-strong bg-surface px-4 text-md font-medium text-fg active:bg-hover"
          >
            {t.r2.t1.fill.mysteryFillBatch(shortBatch)}
          </button>
        </div>
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
      {fillQty > 0 && value !== fillQty ? (
        <button
          type="button"
          onClick={() => onChange(fillQty)}
          aria-label={t.fill.fillSlotAria(r.name, fillQty)}
          className="-mt-1 flex min-h-12 w-full items-center justify-center rounded-md border border-line-strong bg-surface px-4 text-md font-medium text-fg active:bg-hover"
        >
          {t.fill.fillSlot(fillQty)}
        </button>
      ) : null}
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

/**
 * "Fel antal i automaten?" (V2): räkna om en titel i automaten. Samma inventering som förut
 * (registerCount via MachineScreen); formuläret öppnas under raden.
 */
function CountForm({
  row: r,
  counting,
  onToggle,
  onCount,
}: {
  row: FillRow;
  counting: boolean;
  onToggle: () => void;
  onCount: (value: number) => Promise<void>;
}) {
  const t = useT();
  const [draft, setDraft] = useState(String(r.now));
  const [saving, setSaving] = useState(false);
  const inputId = `raknat-${r.titleId}`;
  if (!counting) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(String(r.now));
          onToggle();
        }}
        className="min-h-11 text-left text-v2-sm whitespace-nowrap text-v2-mute underline-offset-4 hover:text-v2-ink hover:underline"
      >
        {t.fill.wrongCount}
      </button>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2"
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
      <label htmlFor={inputId} className="w-full text-v2-sm text-v2-mute">
        {t.fill.countLabel}
      </label>
      <input
        id={inputId}
        type="number"
        inputMode="numeric"
        pattern="[0-9]*"
        min={0}
        max={10000}
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        className="h-10 w-24 rounded-v2 border border-v2-line bg-v2-panel text-center"
      />
      <Button type="submit" variant="act" size="sm" pending={saving}>
        {saving ? t.common.saving : t.common.save}
      </Button>
      <Button size="sm" variant="quiet" onClick={onToggle}>
        {t.common.cancel}
      </Button>
    </form>
  );
}
