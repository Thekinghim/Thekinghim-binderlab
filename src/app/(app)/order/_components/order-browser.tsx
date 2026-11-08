"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";

import { Input, Select } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { formatKronor } from "@/lib/format";

import { getOrderDetail, setTestPurchase } from "../actions";
import { formatAt } from "../_lib/headline";
import { cleanQuery, withOrderParams, type OrderParamsPatch, type OrderSort } from "../_lib/params";
import type { OrderDetail, OrderRefs, OrderRow, OrderTotals, TitleOption } from "../_lib/types";
import {
  OrderDetailError,
  OrderDetailSkeleton,
  OrderDetailView,
  OrderNotFound,
} from "./order-detail";
import { OrderList } from "./order-list";

export interface OrderBrowserProps {
  /** Listans query (period, filter, sökning, sortering) som servern laddade raderna med. */
  readonly query: string;
  /** Samma query med perioden låst till datum, för påfyllningen. */
  readonly pageQuery: string;
  readonly rows: readonly OrderRow[];
  readonly nextOffset: number | null;
  readonly totals: OrderTotals;
  readonly refs: OrderRefs;
  readonly titleOptions: readonly TitleOption[];
  readonly q: string;
  readonly titleId: string | null;
  readonly sort: OrderSort;
  readonly timeZone: string;
  /** Förfrågans tidpunkt (ISO), så att server och klient formaterar likadant. */
  readonly now: string;
  readonly canOpenImport: boolean;
  /** Ägare och admin: "Markera som testköp" / "Ångra testköp" i detaljvyn. */
  readonly canMarkTestPurchase: boolean;
  /** Ordern i ?order= (laddad på servern), om någon. */
  readonly initialOrderId: string | null;
  readonly initialDetail: OrderDetail | null;
  /** Visas i stället för tabellen när inget matchar. */
  readonly empty: ReactNode | null;
}

type DetailState =
  | { readonly status: "closed" }
  | {
      readonly status: "loading" | "ready" | "missing" | "error";
      readonly id: string;
      readonly row: OrderRow | null;
      readonly detail: OrderDetail | null;
      readonly message?: string;
    };

const SEARCH_DELAY_MS = 300;

/**
 * Efter att detaljvyn stängts: fokus till orderns knapp i listan om den syns, annars
 * till sidans rubrik (t.ex. när ordern öppnades via länk och inte finns bland raderna).
 */
function restoreFocus(orderId: string, frames = 0): void {
  requestAnimationFrame(() => {
    // Vänta tills dialogen faktiskt stängts (den lämnar själv tillbaka fokus först).
    if (document.querySelector("dialog[open]") && frames < 30) {
      restoreFocus(orderId, frames + 1);
      return;
    }
    const button = document.querySelector<HTMLElement>(
      `[data-order-button="${CSS.escape(orderId)}"]`,
    );
    if (button) {
      button.focus();
      return;
    }
    // Fokus som ligger kvar i den stängda dialogen (eller på body) räknas som tappat.
    const active = document.activeElement;
    const lost = !active || active === document.body || active.closest("dialog:not([open])");
    if (!lost) return;
    const h1 = document.querySelector<HTMLElement>("h1");
    if (h1) {
      if (!h1.hasAttribute("tabindex")) h1.setAttribute("tabindex", "-1");
      h1.focus();
    }
  });
}

/** Sätter eller tar bort ?order= utan att ladda om sidan (ingen serverförfrågan). */
function replaceOrderParam(orderId: string | null): void {
  if (typeof window === "undefined") return;
  const next = withOrderParams(new URLSearchParams(window.location.search), { orderId });
  const q = next.toString();
  window.history.replaceState(window.history.state, "", q ? `?${q}` : window.location.pathname);
}

export function OrderBrowser(props: OrderBrowserProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const now = useMemo(() => new Date(props.now), [props.now]);

  const navigate = useCallback(
    (patch: OrderParamsPatch) => {
      const next = withOrderParams(searchParams, { ...patch, orderId: null });
      const q = next.toString();
      startTransition(() => {
        router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
      });
    },
    [router, pathname, searchParams],
  );

  // --- Detaljvyn ------------------------------------------------------------
  const cache = useRef(new Map<string, OrderDetail | null>());
  const [detail, setDetail] = useState<DetailState>(() =>
    props.initialOrderId
      ? {
          status: props.initialDetail ? "ready" : "missing",
          id: props.initialOrderId,
          row: null,
          detail: props.initialDetail,
        }
      : { status: "closed" },
  );

  const fetchDetail = useCallback(async (id: string, row: OrderRow | null) => {
    setDetail({ status: "loading", id, row, detail: null });
    let res: Awaited<ReturnType<typeof getOrderDetail>>;
    try {
      res = await getOrderDetail(id);
    } catch {
      res = { ok: false, message: "Ordern gick inte att hämta. Kontrollera anslutningen." };
    }
    if (!res.ok) {
      setDetail({ status: "error", id, row, detail: null, message: res.message });
      return;
    }
    cache.current.set(id, res.data);
    setDetail((cur) =>
      cur.status !== "closed" && cur.id === id
        ? { status: res.data ? "ready" : "missing", id, row, detail: res.data }
        : cur,
    );
  }, []);

  // --- Testköp ---------------------------------------------------------------
  // Markeringar gjorda här (order-id → testköp): listans rader laddas inte om.
  const [changed, setChanged] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [testSave, setTestSave] = useState<{ saving: boolean; error: string | null }>({
    saving: false,
    error: null,
  });

  const changeTestPurchase = useCallback(
    async (id: string, test: boolean) => {
      setTestSave({ saving: true, error: null });
      let res: Awaited<ReturnType<typeof setTestPurchase>>;
      try {
        res = await setTestPurchase(id, test);
      } catch {
        res = { ok: false, message: "Det gick inte att spara. Kontrollera anslutningen." };
      }
      if (!res.ok) {
        setTestSave({ saving: false, error: res.message });
        return;
      }
      const at = res.data.testPurchaseAt;
      setChanged((cur) => new Map(cur).set(id, at !== null));
      setDetail((cur) =>
        cur.status === "ready" && cur.id === id && cur.detail
          ? { ...cur, detail: { ...cur.detail, testPurchase: at ? { at, by: null } : null } }
          : cur,
      );
      setTestSave({ saving: false, error: null });
      cache.current.delete(id);
      // Rubrikens antal och summa räknas om på servern.
      startTransition(() => router.refresh());
      // Namnet på den som markerade kommer från servern (audit_log).
      if (at) {
        const fresh = await getOrderDetail(id).catch(() => null);
        if (fresh?.ok && fresh.data) {
          const data = fresh.data;
          cache.current.set(id, data);
          setDetail((cur) =>
            cur.status === "ready" && cur.id === id ? { ...cur, detail: data } : cur,
          );
        }
      }
    },
    [router],
  );

  const openOrder = useCallback(
    (row: OrderRow) => {
      setTestSave({ saving: false, error: null });
      replaceOrderParam(row.id);
      const cached = cache.current.get(row.id);
      if (cached !== undefined) {
        setDetail({ status: cached ? "ready" : "missing", id: row.id, row, detail: cached });
        return;
      }
      void fetchDetail(row.id, row);
    },
    [fetchDetail],
  );

  const openId = detail.status === "closed" ? null : detail.id;
  const closeOrder = useCallback(() => {
    replaceOrderParam(null);
    setDetail({ status: "closed" });
    if (openId) restoreFocus(openId);
  }, [openId]);

  const titleName = useMemo(
    () => new Map(props.refs.titles.map((t) => [t.id, t.name])),
    [props.refs],
  );
  const machineCode = useMemo(
    () => new Map(props.refs.machines.map((m) => [m.id, m.code])),
    [props.refs],
  );
  const storeName = useMemo(
    () => new Map(props.refs.stores.map((s) => [s.id, s.name])),
    [props.refs],
  );

  let modalTitle = "Order.";
  let modalEyebrow = "Order";
  let modalDescription: string | undefined;
  if (detail.status !== "closed") {
    const d = detail.detail;
    const r = detail.row;
    const externalId = d?.externalId ?? r?.externalId;
    if (externalId) modalEyebrow = `Order / ${externalId}`;
    const name = d
      ? (d.title?.name ?? d.rawTitle)
      : r
        ? ((r.titleId ? titleName.get(r.titleId) : null) ?? r.rawTitle ?? null)
        : null;
    const amount = d?.amountOre ?? r?.amountOre;
    if (name && amount !== undefined) modalTitle = `${name}, ${formatKronor(amount / 100)}.`;
    else if (name) modalTitle = `${name}.`;
    const orderedAt = d?.orderedAt ?? r?.orderedAt;
    const machine = d
      ? (d.machine?.code ?? null)
      : r?.machineId
        ? machineCode.get(r.machineId)
        : null;
    const store = d
      ? (d.store?.name ?? null)
      : r?.storeId
        ? (storeName.get(r.storeId) ?? null)
        : null;
    if (orderedAt) {
      modalDescription = `${formatAt(orderedAt, props.timeZone, now)}${
        machine ? ` i ${machine}${store ? `, ${store}` : ""}` : ""
      }.`;
    }
  }

  return (
    <div className="flex flex-col gap-6 max-md:gap-4">
      <OrderFilters
        q={props.q}
        titleId={props.titleId}
        titleOptions={props.titleOptions}
        onChange={navigate}
        pending={pending}
      />

      {props.empty ? (
        props.empty
      ) : (
        <OrderList
          key={props.query}
          query={props.pageQuery}
          rows={props.rows}
          nextOffset={props.nextOffset}
          totals={props.totals}
          refs={props.refs}
          sort={props.sort}
          timeZone={props.timeZone}
          now={now}
          pending={pending}
          onOpen={openOrder}
          onServerSort={(sort) => navigate({ sort })}
          changed={changed}
        />
      )}

      <Modal
        open={detail.status !== "closed"}
        onClose={closeOrder}
        eyebrow={modalEyebrow}
        title={modalTitle}
        description={modalDescription}
      >
        {detail.status === "loading" ? <OrderDetailSkeleton /> : null}
        {detail.status === "error" ? (
          <OrderDetailError
            message={detail.message ?? "Ordern gick inte att hämta."}
            onRetry={() => void fetchDetail(detail.id, detail.row)}
          />
        ) : null}
        {detail.status === "missing" ? <OrderNotFound /> : null}
        {detail.status === "ready" && detail.detail ? (
          <OrderDetailView
            detail={detail.detail}
            timeZone={props.timeZone}
            canOpenImport={props.canOpenImport}
            testPurchase={
              props.canMarkTestPurchase
                ? {
                    saving: testSave.saving,
                    error: testSave.error,
                    onChange: (test) => void changeTestPurchase(detail.id, test),
                  }
                : null
            }
          />
        ) : null}
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

function OrderFilters({
  q,
  titleId,
  titleOptions,
  onChange,
  pending,
}: {
  q: string;
  titleId: string | null;
  titleOptions: readonly TitleOption[];
  onChange: (patch: OrderParamsPatch) => void;
  pending: boolean;
}) {
  const [text, setText] = useState(q);
  const sent = useRef(q);

  // Sökningen skickas när man slutat skriva en stund (eller trycker Enter).
  useEffect(() => {
    const clean = cleanQuery(text);
    if (clean === sent.current) return;
    const t = setTimeout(() => {
      sent.current = clean;
      onChange({ q: clean });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [text, onChange]);

  // Ändrades sökningen utifrån (Rensa, bakåt i historiken) följer fältet med.
  useEffect(() => {
    if (q !== sent.current) {
      sent.current = q;
      setText(q);
    }
  }, [q]);

  const options = useMemo(
    () => [
      { value: "", label: "Alla titlar" },
      ...titleOptions.map((t) => ({
        value: t.id,
        label: t.archived ? `${t.name} (arkiverad)` : t.name,
      })),
    ],
    [titleOptions],
  );
  const active = q !== "" || titleId !== null;

  return (
    <form
      role="search"
      aria-label="Filtrera order"
      aria-busy={pending || undefined}
      // Mobil: sök och titel på en rad, etiketterna bara för skärmläsare, fälten 44 px.
      className="fade-in grid grid-cols-1 gap-3 max-md:gap-2 max-sm:grid-cols-[minmax(0,1fr)_minmax(0,8.5rem)] sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_auto] sm:items-end max-md:[&_input]:h-11 max-md:[&_label]:sr-only max-md:[&_select]:h-11"
      onSubmit={(e) => {
        e.preventDefault();
        const clean = cleanQuery(text);
        sent.current = clean;
        onChange({ q: clean });
      }}
    >
      <Input
        label="Sök"
        type="search"
        icon="search"
        name="q"
        value={text}
        autoComplete="off"
        spellCheck={false}
        placeholder="Sök order"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && text) {
            e.preventDefault();
            setText("");
          }
        }}
      />
      <Select
        label="Titel"
        name="titel"
        value={titleId ?? ""}
        options={options}
        onChange={(e) => onChange({ titleId: e.target.value || null })}
      />
      {active ? (
        <div className="flex max-sm:col-span-2">
          <Button
            type="button"
            variant="ghost"
            iconLeft="close"
            onClick={() => {
              sent.current = "";
              setText("");
              onChange({ q: "", titleId: null });
            }}
          >
            Rensa
          </Button>
        </div>
      ) : null}
    </form>
  );
}
