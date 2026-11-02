"use client";

import { DataTable, type Column } from "@/components/ui/data-table";
import { Panel } from "@/components/ui/frame";
import { SectionHeader } from "@/components/ui/section-header";
import { StatusTag } from "@/components/ui/status-tag";
import { formatDateTime, formatInt, formatKronor, formatPercent } from "@/lib/format";
import { seeded } from "@/lib/random";

// ---------------------------------------------------------------------------
// Exempeldata: 50 000 köp, 1 nov. 2025 – 31 okt. 2026, deterministisk seed
// ---------------------------------------------------------------------------

type Tx = {
  id: string;
  time: number;
  machine: string;
  product: string;
  qty: number;
  amount: number;
  payment: "Kort" | "Mobil";
  refunded: boolean;
};

const COUNT = 50_000;
/** Fast referenstid så att året skrivs ut likadant på server och klient. */
const NOW = new Date(2026, 10, 2, 9, 30);
const START = new Date(2025, 10, 1).getTime();
const DAYS = 365;
const DAY = 86_400_000;

const PRODUCTS = [
  { name: "Pokémon SV8 Booster", price: 69, weight: 22 },
  { name: "Pokémon SV8.5 Booster", price: 79, weight: 16 },
  { name: "One Piece OP-09 Booster", price: 59, weight: 15 },
  { name: "Lorcana Kap. 7 Booster", price: 65, weight: 11 },
  { name: "MTG Foundations Play Booster", price: 75, weight: 12 },
  { name: "MTG Duskmourn Collector", price: 299, weight: 3 },
  { name: "Yu-Gi-Oh! Rage of the Abyss", price: 49, weight: 8 },
  { name: "Dragon Ball FW Booster", price: 55, weight: 5 },
  { name: "Pokémon SV8 Sleeved Booster", price: 75, weight: 8 },
] as const;

/** Relativ efterfrågan per automat BL-001 … BL-014 (köpcentrum drar mer än kontor). */
const MACHINE_WEIGHTS = [14, 9, 7, 11, 6, 8, 16, 5, 7, 4, 10, 6, 3, 8];
/** Timmar 08–22, tyngdpunkt eftermiddag och kväll. */
const HOUR_WEIGHTS = [1, 2, 4, 6, 7, 7, 8, 10, 12, 13, 12, 10, 7, 4, 2];

function picker<T>(items: ReadonlyArray<T>, weights: ReadonlyArray<number>) {
  const total = weights.reduce((a, b) => a + b, 0);
  const cum: number[] = [];
  let acc = 0;
  for (const w of weights) cum.push((acc += w / total));
  return (r: number): T => {
    let i = 0;
    while (i < cum.length - 1 && r > (cum[i] as number)) i++;
    return items[i] as T;
  };
}

function generate(): Tx[] {
  const rnd = seeded(2026);
  const machine = picker(
    MACHINE_WEIGHTS.map((_, i) => `BL-${String(i + 1).padStart(3, "0")}`),
    MACHINE_WEIGHTS,
  );
  const product = picker(
    PRODUCTS,
    PRODUCTS.map((p) => p.weight),
  );
  const hour = picker(
    HOUR_WEIGHTS.map((_, i) => i + 8),
    HOUR_WEIGHTS,
  );
  const out: Tx[] = new Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    // Jämnt fördelad dag, men helger och tiden kring jul väger tyngre.
    let day = Math.floor(rnd() * DAYS);
    const dow = new Date(START + day * DAY).getDay();
    if ((dow === 1 || dow === 2) && rnd() < 0.35) day = Math.min(DAYS - 1, day + 4);
    if (rnd() < 0.06) day = 50 + Math.floor(rnd() * 6); // 21–26 dec.
    const d = new Date(START + day * DAY);
    d.setHours(hour(rnd()), Math.floor(rnd() * 60), Math.floor(rnd() * 60));
    const p = product(rnd());
    const r = rnd();
    const qty = p.price > 200 ? 1 : r < 0.74 ? 1 : r < 0.93 ? 2 : r < 0.98 ? 3 : 4;
    out[i] = {
      id: "",
      time: d.getTime(),
      machine: machine(rnd()),
      product: p.name,
      qty,
      amount: p.price * qty,
      payment: rnd() < 0.71 ? "Kort" : "Mobil",
      refunded: rnd() < 0.0085,
    };
  }
  out.sort((a, b) => a.time - b.time);
  out.forEach((t, i) => (t.id = `T-${String(i + 1).padStart(6, "0")}`));
  return out;
}

const TX = generate();

const facts = (() => {
  let gross = 0;
  let net = 0;
  let packs = 0;
  let refunds = 0;
  const byMachine = new Map<string, number>();
  for (const t of TX) {
    gross += t.amount;
    if (t.refunded) refunds++;
    else {
      net += t.amount;
      packs += t.qty;
      byMachine.set(t.machine, (byMachine.get(t.machine) ?? 0) + t.amount);
    }
  }
  const [topMachine, topRevenue] = [...byMachine].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  return {
    gross,
    net,
    packs,
    refundShare: refunds / TX.length,
    topMachine,
    topShare: net ? topRevenue / net : 0,
  };
})();

const columns: Column<Tx>[] = [
  {
    key: "time",
    header: "Tid",
    width: 172,
    hideable: false,
    sortValue: (t) => t.time,
    render: (t) => (
      <span className="tnum font-mono text-sm">
        {formatDateTime(new Date(t.time), { now: NOW })}
      </span>
    ),
    csv: (t) => new Date(t.time),
    footer: "Netto",
  },
  {
    key: "id",
    header: "Transaktion",
    width: 132,
    defaultHidden: true,
    sortValue: (t) => t.id,
    render: (t) => <span className="tnum font-mono text-sm text-muted">{t.id}</span>,
  },
  {
    key: "machine",
    header: "Automat",
    width: 96,
    sortValue: (t) => t.machine,
    render: (t) => <span className="tnum font-mono text-sm">{t.machine}</span>,
  },
  {
    key: "product",
    header: "Produkt",
    sortValue: (t) => t.product,
    render: (t) => t.product,
  },
  {
    key: "qty",
    header: "Antal",
    width: 92,
    numeric: true,
    sortValue: (t) => t.qty,
    render: (t) => formatInt(t.qty),
    footer: formatInt(facts.packs),
  },
  {
    key: "amount",
    header: "Belopp",
    width: 156,
    numeric: true,
    sortValue: (t) => t.amount,
    render: (t) => formatKronor(t.amount),
    footer: formatKronor(facts.net),
  },
  {
    key: "payment",
    header: "Betalsätt",
    width: 116,
    sortValue: (t) => t.payment,
    render: (t) => <span className="text-muted">{t.payment}</span>,
  },
  {
    key: "status",
    header: "Status",
    width: 136,
    sortValue: (t) => (t.refunded ? "Återbetald" : "Genomförd"),
    render: (t) =>
      t.refunded ? (
        <StatusTag status="warning">Återbetald</StatusTag>
      ) : (
        <StatusTag status="ok">Genomförd</StatusTag>
      ),
  },
];

/** Hårt bindestreck så att "BL-007" inte bryts över två rader. */
const noBreak = (s: string) => s.replace(/-/g, "\u2011");

const ROW_H = 36;
const HEIGHT = 560;
const OVERSCAN = 8;
const IN_DOM = Math.ceil(HEIGHT / ROW_H) + OVERSCAN * 2;

const specs: Array<[string, string]> = [
  ["Rader i DOM", `≈ ${IN_DOM} av ${formatInt(COUNT)}`],
  ["Radhöjd", `${ROW_H} px tät · 44 px normal`],
  ["Sortering", "Skift+klick lägger till nyckel"],
  ["CSV", "Semikolon · decimalkomma · BOM"],
];

export function GridSection({ index }: { index: number }) {
  return (
    <section
      id="datatabell"
      aria-labelledby="datatabell-title"
      className="border-t border-line py-16 md:py-20"
    >
      <SectionHeader
        id="datatabell-title"
        index={index}
        eyebrow="Datatabell · 50 000 rader"
        title={`${formatInt(COUNT)} köp på ett år gav ${formatKronor(facts.net, { decimals: 0 })} netto.`}
        aside={`${noBreak(facts.topMachine)} står för ${formatPercent(facts.topShare)} av intäkten och ${formatPercent(facts.refundShare)} av köpen återbetalades.`}
      />

      <Panel className="mt-10" padded={false}>
        <div className="px-4 pt-4 pb-1 md:px-5 md:pt-5">
          <DataTable
            caption="Köp per transaktion med tid, automat, produkt, antal, belopp, betalsätt och status"
            columns={columns}
            rows={TX}
            rowKey={(t) => t.id}
            defaultSort={{ key: "time", dir: "desc" }}
            dense
            maxHeight={HEIGHT}
            overscan={OVERSCAN}
            toolbar
            columnPicker
            exportFileName="binderlab-kop-nov-2025-okt-2026"
            showTiming
          />
        </div>
      </Panel>

      <dl className="mt-3 grid grid-cols-1 gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
        {specs.map(([term, value]) => (
          <div key={term} className="flex flex-col gap-1.5 bg-surface px-4 py-3 md:px-5">
            <dt className="label text-subtle">{term}</dt>
            <dd className="tnum font-mono text-sm text-fg">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
