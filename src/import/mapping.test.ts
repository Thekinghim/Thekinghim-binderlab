import { describe, expect, it } from "vitest";

import { MappingError } from "./errors";
import { autoMap, isPaidValue, normalizeHeader, resolveColumns } from "./mapping";

const AWISH = [
  "ID",
  "Date",
  "Name",
  "Order No.",
  "Order Machine",
  "Payment Method",
  "Order Amount",
  "Is Paid",
  "Payment Time",
  "Actions",
];

describe("normalizeHeader", () => {
  it.each([
    ["Order No.", "orderno"],
    ["  ORDER   no ", "orderno"],
    ["order_no", "orderno"],
    ["Is-Paid", "ispaid"],
    ["Betalsätt", "betalsätt"],
  ])("%j → %j", (input, expected) => {
    expect(normalizeHeader(input)).toBe(expected);
  });
});

describe("autoMap", () => {
  it("känner igen Awish orderlista", () => {
    expect(autoMap(AWISH)).toEqual({
      externalId: "Order No.",
      title: "Name",
      machine: "Order Machine",
      amount: "Order Amount",
      isPaid: "Is Paid",
      paidAt: "Payment Time",
      paymentMethod: "Payment Method",
      rowId: "ID",
      orderDate: "Date",
    });
  });

  it("är okänslig för skiftläge, mellanslag och skiljetecken", () => {
    const m = autoMap([
      "order no",
      "NAME",
      "order_machine",
      "ORDER-AMOUNT",
      "is paid",
      "PaymentTime",
    ]);
    expect(m.externalId).toBe("order no");
    expect(m.title).toBe("NAME");
    expect(m.machine).toBe("order_machine");
    expect(m.amount).toBe("ORDER-AMOUNT");
    expect(m.isPaid).toBe("is paid");
    expect(m.paidAt).toBe("PaymentTime");
  });

  it("känner igen svenska rubriker", () => {
    const m = autoMap([
      "Ordernummer",
      "Produkt",
      "Automat",
      "Belopp",
      "Betald",
      "Betaltid",
      "Betalmetod",
      "Datum",
    ]);
    expect(m).toMatchObject({
      externalId: "Ordernummer",
      title: "Produkt",
      machine: "Automat",
      amount: "Belopp",
      isPaid: "Betald",
      paidAt: "Betaltid",
      paymentMethod: "Betalmetod",
      orderDate: "Datum",
    });
  });

  it("föredrar Order Amount framför Amount och använder varje rubrik en gång", () => {
    const m = autoMap(["Amount", "Order Amount"]);
    expect(m.amount).toBe("Order Amount");
  });
});

describe("resolveColumns", () => {
  it("saknade obligatoriska fält ger MappingError med lista", () => {
    try {
      resolveColumns(["Name", "Order No."]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MappingError);
      expect((error as MappingError).missing).toEqual(["machine", "amount", "isPaid", "paidAt"]);
      expect((error as MappingError).message).toContain("Automat");
    }
  });

  it("överstyrning vinner och flyttar rubriken från ett annat fält", () => {
    const headers = [
      "Kvitto",
      "Name",
      "Order Machine",
      "Order Amount",
      "Is Paid",
      "Payment Time",
      "Date",
    ];
    const { columns, source } = resolveColumns(headers, {
      override: { externalId: "kvitto", paidAt: "Date" },
    });
    expect(columns.externalId).toBe("Kvitto");
    expect(columns.paidAt).toBe("Date");
    expect(columns.orderDate).toBeNull();
    expect(source.externalId).toBe("override");
    expect(source.title).toBe("auto");
  });

  it("överstyrning till en rubrik som inte finns ger MappingError", () => {
    expect(() => resolveColumns(AWISH, { override: { title: "Produktnamn" } })).toThrow(
      MappingError,
    );
  });

  it("null tar bort ett valfritt fält; ett obligatoriskt kan inte tas bort", () => {
    expect(
      resolveColumns(AWISH, { override: { paymentMethod: null } }).columns.paymentMethod,
    ).toBeNull();
    expect(() => resolveColumns(AWISH, { override: { amount: null } })).toThrow(MappingError);
  });

  it("sparad mappning används bara om alla dess rubriker finns", () => {
    const headers = ["Kvitto", "Name", "Order Machine", "Order Amount", "Is Paid", "Payment Time"];
    expect(resolveColumns(headers, { saved: { externalId: "Kvitto" } }).source.externalId).toBe(
      "saved",
    );
    expect(() => resolveColumns(headers, { saved: { externalId: "Finns inte" } })).toThrow(
      MappingError,
    );
  });
});

describe("isPaidValue", () => {
  it.each(["Paid Success", "paid success", " PAID  SUCCESS ", "Betald", "Paid"])(
    "%j är betald",
    (v) => {
      expect(isPaidValue(v)).toBe(true);
    },
  );
  it.each(["Unpaid", "Paid Failed", "Refunded", "", null, "Pending"])("%j är inte betald", (v) => {
    expect(isPaidValue(v)).toBe(false);
  });
});
