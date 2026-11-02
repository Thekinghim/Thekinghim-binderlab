"use client";

import { useMemo } from "react";
import { DataTable, type Column } from "@/components/ui/data-table";
import { toIsoDate } from "@/components/shell/period-state";
import { formatDateTime, formatInt, formatKronor } from "@/lib/format";
import type { Period as DateRange } from "@/lib/period";
import { REF_NOW, machines, orderDate, titles, type Order } from "../sample-data";

/** Hårt bindestreck så att "BL-002" inte bryts över två rader. */
const noBreak = (s: string) => s.replace(/-/g, "‑");

function orderColumns(total: number, count: number): Column<Order>[] {
  return [
    {
      key: "time",
      header: "Betaltid",
      width: 148,
      hideable: false,
      sortValue: (o) => o.day * 1440 + o.minute,
      render: (o) => <span className="tnum">{formatDateTime(orderDate(o), { now: REF_NOW })}</span>,
      csv: (o) => orderDate(o),
      footer: `${formatInt(count)} ordrar`,
    },
    {
      key: "no",
      header: "Order",
      width: 96,
      sortValue: (o) => o.no,
      render: (o) => <span className="meta tnum text-muted">{o.no}</span>,
      csv: (o) => o.no,
    },
    {
      key: "machine",
      header: "Automat",
      width: 96,
      sortValue: (o) => machines[o.machine]?.code ?? "",
      render: (o) => <span className="meta">{noBreak(machines[o.machine]?.code ?? "")}</span>,
      csv: (o) => machines[o.machine]?.code ?? "",
    },
    {
      key: "title",
      header: "Titel",
      width: 200,
      sortValue: (o) => titles[o.title]?.name ?? "",
      render: (o) => titles[o.title]?.name,
      csv: (o) => titles[o.title]?.name ?? "",
    },
    {
      key: "amount",
      header: "Belopp",
      width: 120,
      numeric: true,
      sortValue: (o) => o.amountOre,
      render: (o) => formatKronor(o.amountOre / 100),
      csv: (o) => o.amountOre / 100,
      footer: formatKronor(total / 100),
    },
    {
      key: "cost",
      header: "Inköp",
      width: 120,
      numeric: true,
      sortValue: (o) => titles[o.title]?.costOre ?? -1,
      render: (o) => {
        const c = titles[o.title]?.costOre;
        return c === null || c === undefined ? (
          <span className="text-subtle">saknas</span>
        ) : (
          formatKronor(c / 100)
        );
      },
      csv: (o) => {
        const c = titles[o.title]?.costOre;
        return c === null || c === undefined ? "" : c / 100;
      },
    },
    {
      key: "payment",
      header: "Betalsätt",
      width: 104,
      defaultHidden: true,
      sortValue: (o) => o.payment,
      render: (o) => <span className="text-muted">{o.payment}</span>,
      csv: (o) => o.payment,
    },
  ];
}

/**
 * Awish-ordrarna för perioden och filtret: en rad per order (= ett pack).
 * Virtualiseras över 200 rader; summaraden är samma intäkt som nyckeltalen.
 */
export function OrderTable({
  orders,
  range,
  total,
}: {
  orders: ReadonlyArray<Order>;
  range: DateRange;
  total: number;
}) {
  const columns = useMemo(() => orderColumns(total, orders.length), [total, orders.length]);
  return (
    <DataTable
      caption="Awish-ordrar med betaltid, ordernummer, automat, titel, belopp och inköpspris"
      columns={columns}
      rows={orders}
      rowKey={(o) => String(o.no)}
      defaultSort={{ key: "time", dir: "desc" }}
      dense
      maxHeight={440}
      toolbar
      columnPicker
      exportFileName={`awish-ordrar-${toIsoDate(range.start)}-${toIsoDate(range.end)}`}
      surface="bg"
    />
  );
}
