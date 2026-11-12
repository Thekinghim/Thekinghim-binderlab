/**
 * Punkterna som kopplar Att göra till resten av panelen: avtal (påminnelse 90 dagar före
 * sista uppsägningsdag, @/analytics/contracts), rapportutkast att granska, larm som kräver
 * åtgärd och prioritering efter förlorad försäljning. "Nu" är 2 nov. 2026 11:00.
 */

import { describe, expect, it } from "vitest";

import { lowStockAlerts } from "@/analytics/alerts";
import { contractReminders } from "@/analytics/contracts";
import {
  applyDismissals,
  computeTodos,
  LOST_REVENUE_FIGURE,
  prioritizeByLostSales,
  type AlertRef,
  type ReportDraftRef,
  type TodoItem,
} from "./index";
import { daily, input, machine, NOW, title } from "./test-helpers";

const keys = (todos: TodoItem[]) => todos.map((t) => t.key);
const fig = (t: TodoItem, key: string) => t.evidence.figures.find((f) => f.key === key)?.value;

describe("avtal i Att göra", () => {
  // Sista uppsägningsdag = slut − 3 mån. = 31 jan. 2027 − 3 mån. = 31 okt. 2026 → passerad
  // för c-late; c-due slutar 28 feb. 2027 → sista dag 30 nov. 2026, 28 dagar kvar.
  const contracts = [
    { id: "c-due", storeId: "s1", validFrom: "2026-01-01", validTo: "2027-02-28", noticeMonths: 3 },
    { id: "c-far", storeId: "s1", validFrom: "2026-01-01", validTo: "2028-12-31", noticeMonths: 3 },
    { id: "c-open", storeId: "s1", validFrom: "2026-01-01", validTo: null, noticeMonths: 3 },
  ];

  it("tar upp avtal vars påminnelse har kommit, med samma nyckel som Avtal", () => {
    const todos = computeTodos(input({ contracts }), NOW);
    const items = todos.filter((t) => t.kind === "contract");
    expect(keys(items)).toEqual(["contract:c-due:2027-02-28"]);
    const [c] = items;
    expect(c!.level).toBe("soon"); // 28 dagar kvar: ≤ 30 → soon
    expect(c!.daysLeft).toBe(28);
    expect(c!.link).toBe("/avtal#avtal-c-due");
    expect(c!.action?.kind).toBe("open-contract");
    expect(c!.evidence.storeIds).toEqual(["s1"]);
    // Samma påminnelse som sidan Avtal visar (contractReminders).
    const avtal = contractReminders({ contracts, asOf: "2026-11-02", stores: [] });
    expect(avtal.due.map((r) => r.key)).toEqual(["contract:c-due:2027-02-28"]);
    expect(c!.fingerprint).toBe(avtal.due[0]!.fingerprint);
  });

  it("90 dagar före sista uppsägningsdag kommer punkten, dagen före inte", () => {
    // Slut 31 maj 2027, 3 mån. → sista dag 28 feb. 2027; påminnelse 30 nov. 2026.
    const c = [
      { id: "c", storeId: "s1", validFrom: "2026-01-01", validTo: "2027-05-31", noticeMonths: 3 },
    ];
    expect(
      computeTodos(input({ contracts: c }), "2026-11-29T10:00:00Z").some(
        (t) => t.kind === "contract",
      ),
    ).toBe(false);
    const on = computeTodos(input({ contracts: c }), "2026-11-30T10:00:00Z").find(
      (t) => t.kind === "contract",
    );
    expect(on?.level).toBe("later");
    expect(on?.daysLeft).toBe(90);
  });

  it("nivån skärps närmare sista dagen och ett felaktigt avtal döljer inte de andra", () => {
    const near = [
      { id: "c1", storeId: "s1", validFrom: "2026-01-01", validTo: "2027-02-05", noticeMonths: 3 },
      { id: "bad", storeId: "s1", validFrom: "2027-01-01", validTo: "2026-01-01" },
    ];
    const todos = computeTodos(input({ contracts: near }), NOW).filter(
      (t) => t.kind === "contract",
    );
    expect(keys(todos)).toEqual(["contract:c1:2027-02-05"]);
    expect(todos[0]!.level).toBe("now"); // sista dag 5 nov., 3 dagar kvar
  });
});

describe("rapportutkast att granska", () => {
  const draft = (
    id: string,
    kind: ReportDraftRef["reportKind"],
    storeId: string | null,
    generatedAt = "2026-11-01T05:17:00Z",
  ): ReportDraftRef => ({
    id,
    reportKind: kind,
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    storeId,
    generatedAt,
  });

  it("samlar månadens utkast till en punkt med sista dag som utskicket", () => {
    const drafts = [
      draft("r1", "store_statement", "s1"),
      draft("r2", "store_statement", "s2"),
      draft("r3", "accountant_statement", null),
    ];
    const todos = computeTodos(
      input({
        reportDrafts: drafts,
        stores: [
          { id: "s1", name: "ICA Nära" },
          { id: "s2", name: "Pressbyrån" },
        ],
      }),
      NOW,
    );
    const review = todos.filter((t) => t.kind === "report-review");
    expect(keys(review)).toEqual(["report-review:2026-10"]);
    const r = review[0]!;
    expect(r.title).toBe("Granska 3 rapportutkast för oktober");
    expect(r.detail).toContain("2 butiksrapporter och bokföringsunderlag väntar på godkännande");
    expect(r.detail).toContain("ICA Nära och Pressbyrån");
    expect(r.daysLeft).toBe(28); // sista dag 30 nov.
    expect(r.level).toBe("later");
    // Länken pekar ut det första utkastet (butiksrapporten för s1), annars visar Rapporter
    // butiksrapporten för första butiken, som kanske inte har något utkast.
    expect(r.link).toBe("/rapporter?typ=butik&manad=2026-10&butiken=s1#granska");
    expect(fig(r, "drafts")).toBe(3);
  });

  it("ett nytt utkast tar upp en avbockad punkt igen", () => {
    const one = computeTodos(input({ reportDrafts: [draft("r1", "owner_statement", null)] }), NOW);
    const item = one.find((t) => t.kind === "report-review")!;
    expect(item.title).toBe("Granska rapportutkastet för oktober");
    expect(item.link).toBe("/rapporter?typ=delagare&manad=2026-10#granska");
    const dismissed = [{ key: item.key, fingerprint: item.fingerprint }];
    expect(applyDismissals(one, dismissed).some((t) => t.kind === "report-review")).toBe(false);
    const two = computeTodos(
      input({
        reportDrafts: [
          draft("r1", "owner_statement", null),
          draft("r2", "accountant_statement", null, "2026-11-02T08:00:00Z"),
        ],
      }),
      NOW,
    );
    expect(applyDismissals(two, dismissed).some((t) => t.kind === "report-review")).toBe(true);
  });

  it("utkast för en äldre månad är försenade (nu)", () => {
    const old: ReportDraftRef = {
      ...draft("r9", "store_statement", "s1"),
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
    };
    const t = computeTodos(input({ reportDrafts: [old] }), NOW).find(
      (x) => x.kind === "report-review",
    )!;
    expect(t.level).toBe("now");
    expect(t.daysLeft).toBe(-2); // sista dag 31 okt.
    expect(t.detail).toContain("Skulle ha skickats senast 31\u00a0okt.");
    expect(t.detail).not.toMatch(/\.\./);
  });
});

describe("larm som kräver åtgärd", () => {
  const alert = (p: Partial<AlertRef> & { id: string; kind: string }): AlertRef => ({
    key: `machine:${p.machineId ?? "m1"}`,
    severity: "critical",
    machineId: "m1",
    titleId: null,
    title: "BL-001 har slutat sälja",
    detail: "Ingen försäljning på 9 timmar mot väntat 4 order.",
    openedAt: "2026-11-02T07:00:00Z",
    acknowledged: false,
    ...p,
  });

  it("öppna, okvitterade larm om automater och importer; nivå efter allvar", () => {
    const todos = computeTodos(
      input({
        machines: [machine("m1", "Automat 1"), machine("m2", "Automat 2")],
        alerts: [
          alert({ id: "a1", kind: "machine_suspected_fault" }),
          alert({
            id: "a2",
            kind: "import_failed",
            key: "import:ds1",
            machineId: null,
            severity: "warning",
            title: "Importen misslyckades",
          }),
          alert({ id: "a3", kind: "low_stock", key: "low_stock:m1:t1" }),
          alert({
            id: "a4",
            kind: "machine_offline",
            key: "machine:m2",
            machineId: "m2",
            acknowledged: true,
          }),
          alert({ id: "a5", kind: "day_anomaly", key: "day:2026-11-01", machineId: null }),
          alert({
            id: "a6",
            kind: "machine_fault",
            key: "machine:m3",
            machineId: "m3",
            severity: "info",
          }),
        ],
      }),
      NOW,
    );
    const alerts = todos.filter((t) => t.kind === "alert");
    expect(keys(alerts)).toEqual(["alert:machine:m1", "alert:import:ds1"]);
    expect(alerts[0]!.level).toBe("now");
    expect(alerts[0]!.link).toBe("/drift/automat/m1");
    expect(fig(alerts[0]!, "openHours")).toBe(3);
    expect(alerts[1]!.level).toBe("soon");
    expect(alerts[1]!.link).toBe("/datakallor");
  });

  it("larm om Fortnox länkar till Datakällor → Fortnox (dit bara ägare och admin når)", () => {
    const todos = computeTodos(
      input({
        machines: [machine("m1", "Automat 1")],
        alerts: [
          alert({
            id: "f1",
            kind: "job_failed",
            key: "fortnox:atgard",
            machineId: null,
            severity: "warning",
            title: "Fortnox: 1 verifikat är stoppat",
            detail: "Perioden är låst i Fortnox till och med 2026-10-31.",
          }),
          alert({
            id: "f2",
            kind: "job_failed",
            key: "fortnox:koppling",
            machineId: null,
            title: "Fortnox behöver kopplas igen",
          }),
        ],
      }),
      NOW,
    );
    const alerts = todos.filter((t) => t.kind === "alert");
    expect(keys(alerts).sort()).toEqual(["alert:fortnox:atgard", "alert:fortnox:koppling"]);
    for (const a of alerts) {
      expect(a.link).toBe("/datakallor/fortnox");
      expect(a.action?.label).toBe("Öppna Fortnox");
    }
  });

  it("en automat som redan står som tyst automat får ingen larmpunkt till", () => {
    // m1 sålde senast för fem dagar sedan: stale-machine-punkten finns.
    const orders = daily("t1", "m1", "2026-10-20", 9, 2);
    const todos = computeTodos(
      input({
        titles: [title("t1", "Black Bolt")],
        orders,
        alerts: [alert({ id: "a1", kind: "machine_offline" })],
      }),
      NOW,
    );
    expect(todos.some((t) => t.key === "stale-machine:m1")).toBe(true);
    expect(todos.some((t) => t.kind === "alert")).toBe(false);
  });

  it("ett larm som skärps tar upp en avbockad punkt igen", () => {
    const warn = computeTodos(
      input({
        alerts: [alert({ id: "a1", kind: "machine_suspected_fault", severity: "warning" })],
      }),
      NOW,
    );
    const item = warn.find((t) => t.kind === "alert")!;
    const dismissed = [{ key: item.key, fingerprint: item.fingerprint }];
    const crit = computeTodos(
      input({ alerts: [alert({ id: "a1", kind: "machine_suspected_fault" })] }),
      NOW,
    );
    expect(applyDismissals(crit, dismissed).some((t) => t.kind === "alert")).toBe(true);
  });
});

describe("prioritering efter förlorad försäljning", () => {
  // Två titlar i m1 som båda är slut (nivå now) med samma takt och belopp: utan förlorad
  // försäljning avgör nyckeln; med den går titeln som kostat mest först.
  const scenario = input({
    titles: [title("t1", "Black Bolt"), title("t2", "White Flair")],
    orders: [...daily("t1", "m1", "2026-10-19", 14, 2), ...daily("t2", "m1", "2026-10-19", 14, 2)],
    stock: [
      { machineId: "m1", titleId: "t1", onHand: 0 },
      { machineId: "m1", titleId: "t2", onHand: 0 },
    ],
  });

  it("går först inom samma nivå, utan att ändra nivå eller kronor i risk", () => {
    const base = computeTodos(scenario, NOW).filter((t) => t.kind === "refill");
    expect(keys(base)).toEqual(["refill:m1:t1", "refill:m1:t2"]);
    const ranked = prioritizeByLostSales(base, [
      { key: "refill:m1:t2", lostRevenueOre: 49_000 },
      { key: "refill:m9:t9", lostRevenueOre: 1_000_000 },
    ]);
    expect(keys(ranked)).toEqual(["refill:m1:t2", "refill:m1:t1"]);
    const t2 = ranked[0]!;
    const before = base.find((t) => t.key === "refill:m1:t2")!;
    expect(t2.level).toBe(before.level);
    expect(t2.atStakeOre).toBe(before.atStakeOre);
    expect(t2.urgency - before.urgency).toBe(49_000);
    expect(fig(t2, LOST_REVENUE_FIGURE)).toBe(49_000);
    expect(t2.fingerprint).toBe(before.fingerprint); // avbockningen gäller fortfarande
  });

  it("nivån väger tyngre än förlorad intäkt, och tomt underlag ändrar inget", () => {
    const soon = computeTodos(
      input({
        titles: [title("t1", "Black Bolt"), title("t2", "White Flair")],
        orders: [
          ...daily("t1", "m1", "2026-10-19", 14, 2),
          ...daily("t2", "m1", "2026-10-19", 14, 2),
        ],
        stock: [
          { machineId: "m1", titleId: "t1", onHand: 0 },
          { machineId: "m1", titleId: "t2", onHand: 4 },
        ],
      }),
      NOW,
    ).filter((t) => t.kind === "refill");
    const ranked = prioritizeByLostSales(soon, [
      { key: "refill:m1:t2", lostRevenueOre: 900_000_000 },
    ]);
    expect(ranked.map((t) => t.level)).toEqual(["now", "soon"]);
    expect(prioritizeByLostSales(soon, [])).toEqual(soon);
    expect(prioritizeByLostSales(soon, [{ key: "refill:m1:t1", lostRevenueOre: -5 }])).toEqual(
      soon,
    );
  });
});

describe("Drift-larmet 'Titel nära slut' och påfyllningspunkten i Att göra", () => {
  it("räknar samma takt (14 hela dagar t.o.m. i går) och samma slutdatum", () => {
    // 23 pack på 14 dagar plus 5 i dag: dagens försäljning ska inte räknas i någon av dem.
    const orders = [
      ...daily("t1", "m1", "2026-10-19", 9, 2),
      ...daily("t1", "m1", "2026-10-28", 5, 1),
      ...daily("t1", "m1", "2026-11-02", 1, 5),
    ];
    const stock = [{ machineId: "m1", titleId: "t1", onHand: 3 }];
    const titles = [title("t1", "30th Celebration")];
    const machines = [machine("m1", "Automat 3")];
    const todo = computeTodos(input({ orders, stock, titles, machines }), NOW).find(
      (t) => t.kind === "refill",
    )!;
    const [alert] = lowStockAlerts({ orders, stock, machines, titles }, NOW);
    expect(alert).toBeDefined();
    expect(alert!.evidence.period).toEqual(todo.evidence.period);
    expect(alert!.evidence.period).toEqual({ start: "2026-10-19", end: "2026-11-01" });
    expect(fig(todo, "unitsInWindow")).toBe(23);
    expect(alert!.evidence.figures.find((f) => f.key === "unitsInWindow")?.value).toBe(23);
    // Samma slutdatum i båda texterna.
    const end = alert!.evidence.dates[0]!;
    const [, mm, dd] = end.split("-");
    const months = [
      "jan.",
      "feb.",
      "mars",
      "apr.",
      "maj",
      "juni",
      "juli",
      "aug.",
      "sep.",
      "okt.",
      "nov.",
      "dec.",
    ];
    const dayText = `${Number(dd)} ${months[Number(mm) - 1]}`;
    // Runda 2 (T4-3): Att göra säger dagen i ord ("Tar slut i morgon – fyll på i dag"),
    // larmet datumet. Båda kommer från sellOut(): 3 nov. är i morgon (i dag är 2 nov.).
    expect(end).toBe("2026-11-03");
    expect(todo.detail).toContain("Tar slut i morgon – fyll på i dag.");
    expect(alert!.detail.replace(/ /g, " ")).toContain(dayText);
  });
});
