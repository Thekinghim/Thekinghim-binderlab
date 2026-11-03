/**
 * awish_grpc: order från Awish officiella gRPC-API (tjänsten provider.Provider,
 * se docs/awish-api.md). Själva anropen görs i src/server/awish (klient och
 * synk); här finns bara den rena tolkningen från Awish Order till `RawOrder`, så
 * att den kan testas utan nätverk. Allt efter adaptern är samma pipeline som för
 * en uppladdad CSV (pipeline.ts).
 *
 * Regler:
 * - externalId = Order.id (uint64 som text). Unikt per datakälla.
 * - Belopp: Order.amount är text i valutaenheter, t.ex. "4.00" (tabellen i
 *   dokumentationen säger "Int, unit cent", men alla exempel är decimaltext).
 *   Tolkas exakt med heltal: högst två decimaler, inga tusentalsavgränsare. Utan
 *   decimalpunkt ("170") tolkas det som kronor och raden får en anmärkning.
 * - Betald = status PAY_SUCCESS och inte is_free. Gratisorder (is_free),
 *   testorder (PAY_TEST), hämtkoder (PAY_PICK_UP_CODE), återbetalda
 *   (PAY_REFUND, PAY_REFUNDING, PAY_REFUNDED) och obetalda räknas som "ej
 *   betalda" och importeras inte. Binderlab har ingen återbetalning per order
 *   (återbetalningar förs på ärenden i Inkorg); en återbetald order som redan är
 *   importerad blir en konflikt i importloggen och ändras inte.
 * - Betaltid: pay_time ("YYYY-MM-DD HH:mm:ss") är lokal tid i datakällans
 *   tidszon (source_timezone).
 * - Betalmetod: payment_id → samma ord som CSV-exporten ("WeChat Pay", "Card" ...).
 */

import type {
  AdapterInput,
  FetchResult,
  RawMachine,
  RawOrder,
  RawRowError,
  SourceAdapter,
} from "../adapter";
import { normalizeText } from "../adapter";
import { ImportValidationError } from "../errors";
import { formatInZone, parseSourceDateTime, zonedToUtc } from "../zoned";

export const AWISH_GRPC_PARSER_VERSION = "awish_grpc/1";

/** Order från Awish, som klienten (src/server/awish/grpc-client.ts) lämnar den. */
export interface AwishGrpcOrder {
  id: string;
  date: string;
  tradeId: string | null;
  title: string | null;
  amount: string;
  payTime: string | null;
  status: string;
  isFree: boolean;
  taxTotal: string | null;
  pickupCodeId: string | null;
  paymentId: string;
  machineId: string;
  records: Array<{ productId: string; quantity: string; price: string }>;
  totalCashAmount: string | null;
  changeCashAmount: string | null;
}

export interface AwishGrpcMachine {
  id: string;
  name: string;
  machineNo: string;
}

/**
 * Hemligheten ska ligga i organisationens namnrymd i Vault
 * ("{organization_id}/namn"). Kontrolleras innan Vault läses, samma regel som
 * check-villkoret på data_sources.secret_ref.
 */
export function assertSecretRefInNamespace(
  organizationId: string,
  secretRef: string | null,
): string {
  if (!secretRef) {
    throw new ImportValidationError("Datakällan saknar hemlighet (secret_ref).");
  }
  const prefix = `${organizationId}/`;
  const name = secretRef.slice(prefix.length);
  if (!secretRef.startsWith(prefix) || !/^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,150}$/.test(name)) {
    throw new ImportValidationError("Hemligheten ligger inte i organisationens namnrymd.");
  }
  return secretRef;
}

// ---------------------------------------------------------------------------
// Belopp
// ---------------------------------------------------------------------------

export type GrpcAmount = { ok: true; ore: number; note?: string } | { ok: false; message: string };

/** Övre gräns per order (10 miljoner kr), samma som CSV-tolkningen. */
const MAX_ORE = 1_000_000_000;

/** "4.00" → 400, "0.5" → 50, "170" → 17000 (med anmärkning). Allt annat nekas. */
export function parseAwishAmount(input: string | null | undefined): GrpcAmount {
  const text = (input ?? "").trim();
  if (text === "") return { ok: false, message: "Belopp saknas." };
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) {
    return {
      ok: false,
      message: `Beloppet "${text.slice(0, 40)}" går inte att tolka (väntade t.ex. "170.00").`,
    };
  }
  const kronor = Number(m[1]);
  const decimals = m[2];
  const ore = kronor * 100 + (decimals === undefined ? 0 : Number(decimals.padEnd(2, "0")));
  if (!Number.isSafeInteger(ore) || ore > MAX_ORE) {
    return { ok: false, message: `Beloppet "${text}" är orimligt stort.` };
  }
  if (decimals === undefined) {
    return {
      ok: true,
      ore,
      note: `Beloppet "${text}" saknar decimaler och tolkades som ${text} kr (inte öre).`,
    };
  }
  return { ok: true, ore };
}

// ---------------------------------------------------------------------------
// Status och betalmetod
// ---------------------------------------------------------------------------

export type AwishStatusKind = "paid" | "refund" | "unpaid" | "test" | "pickup" | "unknown";

export function statusKind(status: string): AwishStatusKind {
  switch (status.trim().toUpperCase()) {
    case "PAY_SUCCESS":
      return "paid";
    case "PAY_REFUND":
    case "PAY_REFUNDING":
    case "PAY_REFUNDED":
      return "refund";
    case "PAY_NOTPAY":
    case "PAY_CLOSED":
    case "PAY_REVOKED":
    case "PAY_PAYING":
    case "PAY_FAILED":
    case "PAY_TIMEOUT":
      return "unpaid";
    case "PAY_TEST":
      return "test";
    case "PAY_PICK_UP_CODE":
      return "pickup";
    default:
      return "unknown";
  }
}

/** Betalda och importerbara: PAY_SUCCESS och inte gratis. */
export function isPaidOrder(order: Pick<AwishGrpcOrder, "status" | "isFree">): boolean {
  return statusKind(order.status) === "paid" && !order.isFree;
}

const PAYMENT_METHODS: Record<string, string> = {
  "1": "WeChat Pay",
  "2": "Alipay",
  "3": "Coin",
  "4": "Banknote",
  // Samma ord som CSV-exporten använder för kort.
  "5": "Card",
  "6": "Banknote & Coin",
  "7": "Online",
  "8": "Balance",
};

/** payment_id → betalmetod (null för 0 = okänd och okända värden). */
export function paymentMethodOf(paymentId: string): string | null {
  return PAYMENT_METHODS[paymentId.trim()] ?? null;
}

const STATUS_TEXT: Record<Exclude<AwishStatusKind, "paid">, string> = {
  refund: "återbetald",
  unpaid: "inte betald",
  test: "testorder",
  pickup: "hämtkod",
  unknown: "okänd status",
};

// ---------------------------------------------------------------------------
// Tid
// ---------------------------------------------------------------------------

/**
 * Orderns senaste möjliga tidpunkt i UTC: pay_time, annars slutet av `date` i
 * källans tidszon (en order med bara datum kan vara från sent den dagen). Används
 * för regeln om sena betalningar (läs alltid det senaste dygnet). null = okänd.
 */
export function latestInstantOf(
  order: Pick<AwishGrpcOrder, "payTime" | "date">,
  timeZone: string,
): Date | null {
  const pay = order.payTime ? parseSourceDateTime(order.payTime) : null;
  if (pay?.ok) return pay.kind === "absolute" ? pay.utc : zonedToUtc(pay.local, timeZone).utc;
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(order.date.trim());
  if (!d) return null;
  const end = zonedToUtc(
    {
      year: Number(d[1]),
      month: Number(d[2]),
      day: Number(d[3]),
      hour: 23,
      minute: 59,
      second: 59,
    },
    timeZone,
  );
  return end.utc;
}

// ---------------------------------------------------------------------------
// Order → RawOrder
// ---------------------------------------------------------------------------

export function rawOf(order: AwishGrpcOrder, machineName: string | null): Record<string, string> {
  return {
    id: order.id,
    date: order.date,
    trade_id: order.tradeId ?? "",
    title: order.title ?? "",
    amount: order.amount,
    pay_time: order.payTime ?? "",
    status: order.status,
    is_free: String(order.isFree),
    payment_id: order.paymentId,
    machine_id: order.machineId,
    machine_name: machineName ?? "",
    tax_total: order.taxTotal ?? "",
    pickup_code_id: order.pickupCodeId ?? "",
    total_cash_amount: order.totalCashAmount ?? "",
    change_cash_amount: order.changeCashAmount ?? "",
    order_records: JSON.stringify(order.records),
  };
}

export interface MapAwishOrdersInput {
  orders: readonly AwishGrpcOrder[];
  machines: readonly AwishGrpcMachine[];
  /** Datakällans tidszon (source_timezone): pay_time tolkas i den. */
  sourceTimezone: string;
}

/** Awish order → FetchResult för pipelinen. Radnummer = plats i hämtningen (från 1). */
export function mapAwishOrders(input: MapAwishOrdersInput): FetchResult {
  const tz = input.sourceTimezone;
  const names = new Map(input.machines.map((m) => [m.id, m.name.trim()]));
  const rows: RawOrder[] = [];
  const errors: RawRowError[] = [];

  input.orders.forEach((order, index) => {
    const sourceRowNumber = index + 1;
    const machineKnown = order.machineId !== "" && order.machineId !== "0";
    const knownName = machineKnown ? names.get(order.machineId) || null : null;
    const machineName = machineKnown
      ? (knownName ?? `Automat ${order.machineId}`)
      : "Okänd automat";
    const raw = rawOf(order, knownName);
    const kind = statusKind(order.status);
    const paid = isPaidOrder(order);
    const notes: string[] = [];
    const problems: string[] = [];

    const externalId = normalizeText(order.id).trim();
    if (!/^\d{1,30}$/.test(externalId)) problems.push(`Ogiltigt order-id "${order.id}".`);

    const amount = parseAwishAmount(order.amount);
    if (!amount.ok) problems.push(amount.message);
    else if (amount.note) notes.push(amount.note);

    let paidAtUtc: Date | null = null;
    const time = parseSourceDateTime(order.payTime);
    if (!time.ok) {
      problems.push(order.payTime ? time.message : "Betaltid (pay_time) saknas.");
    } else if (time.kind === "absolute") {
      paidAtUtc = time.utc;
    } else {
      const resolved = zonedToUtc(time.local, tz);
      paidAtUtc = resolved.utc;
      if (resolved.resolution === "ambiguous") {
        notes.push(
          `Tiden ${order.payTime} finns två gånger i ${tz} (sommartid slutar). ` +
            `Den tidigaste valdes: ${resolved.utc.toISOString()} UTC.`,
        );
      } else if (resolved.resolution === "gap") {
        notes.push(
          `Tiden ${order.payTime} finns inte i ${tz} (sommartid börjar). ` +
            `Den flyttades fram till ${formatInZone(resolved.utc, tz)}.`,
        );
      }
    }
    if (!paid) {
      notes.push(
        order.isFree && kind === "paid"
          ? "Gratisorder (is_free): räknas inte som försäljning."
          : `Status ${order.status} (${kind === "paid" ? "betald" : STATUS_TEXT[kind]}): importeras inte.`,
      );
    }

    if (problems.length > 0 || paidAtUtc === null || !amount.ok) {
      errors.push({
        sourceRowNumber,
        raw,
        message: problems.join(" "),
        externalId: externalId === "" ? undefined : externalId,
        isPaid: paid,
      });
      return;
    }

    rows.push({
      externalId,
      rawTitle: order.title?.trim() || "Okänd produkt",
      sourceMachineName: machineName,
      sourceMachineId: machineKnown ? order.machineId : undefined,
      paymentMethod: paymentMethodOf(order.paymentId),
      amountOre: amount.ore,
      paidAtUtc,
      isPaid: paid,
      sourceRowNumber,
      raw,
      notes: notes.length > 0 ? notes : undefined,
    });
  });

  const machines: RawMachine[] = input.machines.map((m) => ({
    externalId: m.id,
    externalName: m.name.trim() || null,
    externalDeviceNo: m.machineNo.trim() || null,
  }));

  return {
    rows,
    machines,
    errors,
    parserVersion: AWISH_GRPC_PARSER_VERSION,
    mapping: { version: 1, kind: "awish_grpc" },
  };
}

export interface AwishGrpcInput extends AdapterInput {
  orders: readonly AwishGrpcOrder[];
  machines: readonly AwishGrpcMachine[];
}

/** Adaptern: orderna har redan hämtats av synken (src/server/awish/sync.ts). */
export const awishGrpcAdapter: SourceAdapter<AwishGrpcInput> = {
  provider: "awish_grpc",
  async fetch(input) {
    return mapAwishOrders({
      orders: input.orders,
      machines: input.machines,
      sourceTimezone: input.context.sourceTimezone,
    });
  },
};
