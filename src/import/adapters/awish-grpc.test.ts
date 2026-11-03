import { describe, expect, it } from "vitest";

import {
  isPaidOrder,
  latestInstantOf,
  mapAwishOrders,
  parseAwishAmount,
  paymentMethodOf,
  statusKind,
  type AwishGrpcOrder,
} from "./awish-grpc";

function order(id: number, over: Partial<AwishGrpcOrder> = {}): AwishGrpcOrder {
  return {
    id: String(id),
    date: "2026-11-02",
    tradeId: `DS-${id}`,
    title: "30th Celebration",
    amount: "170.00",
    payTime: "2026-11-02 00:17:00",
    status: "PAY_SUCCESS",
    isFree: false,
    taxTotal: null,
    pickupCodeId: null,
    paymentId: "5",
    machineId: "2",
    records: [],
    totalCashAmount: null,
    changeCashAmount: null,
    ...over,
  };
}

describe("parseAwishAmount", () => {
  it("tolkar decimaltext exakt till öre", () => {
    expect(parseAwishAmount("4.00")).toEqual({ ok: true, ore: 400 });
    expect(parseAwishAmount("0.5")).toEqual({ ok: true, ore: 50 });
    expect(parseAwishAmount("189.99")).toEqual({ ok: true, ore: 18999 });
    expect(parseAwishAmount(" 0.01 ")).toEqual({ ok: true, ore: 1 });
  });

  it("tolkar heltal som kronor och lämnar en anmärkning", () => {
    const r = parseAwishAmount("170");
    expect(r).toMatchObject({ ok: true, ore: 17000 });
    expect(r.ok && r.note).toMatch(/saknar decimaler/);
  });

  it("nekar tusentalsavgränsare, negativa, tre decimaler och tomt", () => {
    for (const bad of ["1,234.00", "1 234.00", "-4.00", "4.001", "", "abc", "4,00", "1e3"]) {
      expect(parseAwishAmount(bad).ok, bad).toBe(false);
    }
    expect(parseAwishAmount(null).ok).toBe(false);
    expect(parseAwishAmount("999999999.00").ok).toBe(false);
  });
});

describe("status och betalmetod", () => {
  it("bara PAY_SUCCESS utan is_free är betald", () => {
    expect(statusKind("PAY_SUCCESS")).toBe("paid");
    for (const s of ["PAY_REFUNDED", "PAY_REFUNDING", "PAY_REFUND"]) {
      expect(statusKind(s)).toBe("refund");
    }
    for (const s of [
      "PAY_NOTPAY",
      "PAY_CLOSED",
      "PAY_REVOKED",
      "PAY_PAYING",
      "PAY_FAILED",
      "PAY_TIMEOUT",
    ]) {
      expect(statusKind(s)).toBe("unpaid");
    }
    expect(statusKind("PAY_TEST")).toBe("test");
    expect(statusKind("PAY_PICK_UP_CODE")).toBe("pickup");
    expect(statusKind("NÅGOT_NYTT")).toBe("unknown");
    expect(isPaidOrder({ status: "PAY_SUCCESS", isFree: false })).toBe(true);
    expect(isPaidOrder({ status: "PAY_SUCCESS", isFree: true })).toBe(false);
    expect(isPaidOrder({ status: "PAY_REFUNDED", isFree: false })).toBe(false);
  });

  it("payment_id blir samma ord som CSV-exporten", () => {
    expect(paymentMethodOf("1")).toBe("WeChat Pay");
    expect(paymentMethodOf("5")).toBe("Card");
    expect(paymentMethodOf("0")).toBeNull();
    expect(paymentMethodOf("99")).toBeNull();
  });
});

describe("mapAwishOrders", () => {
  const machines = [{ id: "2", name: "BL-001 Centrum", machineNo: "163271xx" }];

  it("order 42780-kontrollen: Shanghai-tid 2026-11-02 00:17 → 2026-11-01 16:17 UTC", () => {
    const r = mapAwishOrders({ orders: [order(42780)], machines, sourceTimezone: "Asia/Shanghai" });
    expect(r.errors).toEqual([]);
    const row = r.rows[0]!;
    expect(row.paidAtUtc.toISOString()).toBe("2026-11-01T16:17:00.000Z");
    expect(row).toMatchObject({
      externalId: "42780",
      rawTitle: "30th Celebration",
      sourceMachineId: "2",
      sourceMachineName: "BL-001 Centrum",
      paymentMethod: "Card",
      amountOre: 17000,
      isPaid: true,
      sourceRowNumber: 1,
    });
    expect(row.raw).toMatchObject({ id: "42780", amount: "170.00", status: "PAY_SUCCESS" });
    expect(Object.values(row.raw).every((v) => typeof v === "string")).toBe(true);
    expect(r.machines).toEqual([
      { externalId: "2", externalName: "BL-001 Centrum", externalDeviceNo: "163271xx" },
    ]);
  });

  it("samma tid i Europe/Stockholm ger en annan UTC-tid", () => {
    const r = mapAwishOrders({
      orders: [order(1)],
      machines,
      sourceTimezone: "Europe/Stockholm",
    });
    expect(r.rows[0]?.paidAtUtc.toISOString()).toBe("2026-11-01T23:17:00.000Z");
  });

  it("reservnamn för titel och automat", () => {
    const r = mapAwishOrders({
      orders: [order(1, { title: null, machineId: "77" }), order(2, { machineId: "0" })],
      machines,
      sourceTimezone: "UTC",
    });
    expect(r.rows[0]).toMatchObject({
      rawTitle: "Okänd produkt",
      sourceMachineName: "Automat 77",
      sourceMachineId: "77",
    });
    expect(r.rows[1]).toMatchObject({ sourceMachineName: "Okänd automat" });
    expect(r.rows[1]?.sourceMachineId).toBeUndefined();
  });

  it("återbetalda, gratis och test är ej betalda med en anmärkning", () => {
    const r = mapAwishOrders({
      orders: [
        order(1, { status: "PAY_REFUNDED" }),
        order(2, { isFree: true, amount: "0.00" }),
        order(3, { status: "PAY_TEST" }),
      ],
      machines,
      sourceTimezone: "UTC",
    });
    expect(r.rows.map((x) => x.isPaid)).toEqual([false, false, false]);
    expect(r.rows[0]?.notes?.join(" ")).toMatch(/återbetald/);
    expect(r.rows[1]?.notes?.join(" ")).toMatch(/Gratisorder/);
  });

  it("felrader: trasigt belopp (betald) och obetald utan betaltid", () => {
    const r = mapAwishOrders({
      orders: [order(1, { amount: "1,234.00" }), order(2, { status: "PAY_NOTPAY", payTime: null })],
      machines,
      sourceTimezone: "UTC",
    });
    expect(r.rows).toEqual([]);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toMatchObject({ externalId: "1", isPaid: true, sourceRowNumber: 1 });
    expect(r.errors[1]).toMatchObject({ externalId: "2", isPaid: false });
  });

  it("sommartid: en tid som finns två gånger får en anmärkning", () => {
    const r = mapAwishOrders({
      orders: [order(1, { payTime: "2026-10-25 02:30:00" })],
      machines,
      sourceTimezone: "Europe/Stockholm",
    });
    expect(r.rows[0]?.notes?.join(" ")).toMatch(/två gånger/);
  });
});

describe("latestInstantOf", () => {
  it("pay_time i källans zon, annars slutet av date", () => {
    expect(latestInstantOf(order(1), "Asia/Shanghai")?.toISOString()).toBe(
      "2026-11-01T16:17:00.000Z",
    );
    expect(
      latestInstantOf({ payTime: null, date: "2026-11-02" }, "Asia/Shanghai")?.toISOString(),
    ).toBe("2026-11-02T15:59:59.000Z");
    expect(latestInstantOf({ payTime: null, date: "" }, "UTC")).toBeNull();
  });
});
