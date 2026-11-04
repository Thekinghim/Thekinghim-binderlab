/**
 * Visningsmodellen för Inställningar: procentsatser, ägarandelar, kontoplan och
 * ändringsloggen. Rena funktioner (testas i model.test.ts).
 */

import type { IsoDate } from "@/domain";
import { formatInt, formatMonth, formatPercent } from "@/lib/format";

/** Högsta kortavgift som tas emot (20 %): mer är ett skrivfel. */
export const MAX_FEE_BP = 2_000;
/** Högsta momssats (25 %, den högsta svenska satsen). */
export const MAX_VAT_BP = 2_500;

/** Tabellerna vars ändringar visas i loggen på sidan. */
export const AUDITED_TABLES = ["organization_settings", "owner_shares", "ledger_accounts"] as const;
export type AuditedTable = (typeof AUDITED_TABLES)[number];

export interface SettingsRow {
  readonly id: string;
  readonly vatRateBp: number;
  readonly cardFeeBp: number;
  readonly fiscalYearStartMonth: number;
  readonly updatedAt: string;
}

export interface OwnerShareRow {
  readonly id: string;
  readonly memberUserId: string | null;
  readonly holderName: string;
  readonly shareBp: number;
  readonly validFrom: IsoDate;
}

export interface LedgerAccountRow {
  readonly id: string;
  readonly key: string;
  readonly basAccount: string;
  readonly name: string;
}

export interface SettingsAuditEvent {
  readonly id: string;
  readonly table: AuditedTable;
  readonly rowId: string;
  readonly action: "insert" | "update" | "delete";
  readonly actorId: string | null;
  readonly occurredAt: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
}

export const SETTINGS_MESSAGES = {
  forbidden: "Bara ägare och admin kan ändra inställningarna.",
  ownerOnly: "Bara ägaren kan ändra ägarandelarna.",
  invalid: "Uppgifterna stämmer inte. Kontrollera procentsatserna och försök igen.",
  companyInvalid: "Uppgifterna är för långa. Korta ner dem och försök igen.",
  orgNumberInvalid: "Organisationsnummer skrivs NNNNNN-NNNN.",
  emailInvalid: "E-postadressen ser inte rätt ut.",
  sharesInvalid: "Varje ägare behöver ett namn och en andel över 0 %.",
  sharesDuplicate: "Samma namn står två gånger. Varje ägare ska stå en gång.",
  sharesDateTaken:
    "Det finns redan ägarandelar från det datumet. Välj ett annat datum för den nya fördelningen.",
  sharesSum(sumBp: number): string {
    return `Andelarna summerar till ${formatBp(sumBp)}, inte 100 %.`;
  },
} as const;

// ---------------------------------------------------------------------------
// Procent
// ---------------------------------------------------------------------------

/** 250 → "2,5 %", 0 → "0 %", 1 234 → "12,34 %". */
export function formatBp(bp: number): string {
  const digits = bp % 100 === 0 ? 0 : bp % 10 === 0 ? 1 : 2;
  return formatPercent(bp / 10_000, digits);
}

export type ParsedBp = { ok: true; bp: number } | { ok: false; message: string };

/** "2,5" / "2.5" / "2,5 %" / "0" → baspunkter. Högst två decimaler. */
export function parsePercentInput(input: string, maxBp: number): ParsedBp {
  const s = input.replace(/\s|%/g, "").replace(",", ".");
  if (s === "") return { ok: false, message: "Ange en procentsats, t.ex. 0 eller 2,5." };
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) {
    return { ok: false, message: "Skriv procent med högst två decimaler, t.ex. 2,5." };
  }
  const [whole = "0", frac = ""] = s.split(".");
  const bp = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (bp > maxBp) return { ok: false, message: `Högst ${formatBp(maxBp)}.` };
  return { ok: true, bp };
}

/** Procentsatsen som den skrivs i fältet: 250 → "2,5". */
export function bpToInput(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const frac = bp % 100;
  if (frac === 0) return String(whole);
  return `${whole},${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}

export const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => ({
  value: String(i + 1),
  label: formatMonth(new Date(2026, i, 1, 12), { year: "never" }),
}));

function monthLabel(month: number): string {
  return MONTH_OPTIONS[month - 1]?.label ?? String(month);
}

/** "januari–december" eller "juli–juni". */
export function fiscalYearLabel(startMonth: number): string {
  const end = ((startMonth + 10) % 12) + 1;
  return `${monthLabel(startMonth)}–${monthLabel(end)}`;
}

// ---------------------------------------------------------------------------
// Rubriker
// ---------------------------------------------------------------------------

export function settingsHeadline(settings: { cardFeeBp: number; vatRateBp: number }): {
  title: string;
  aside: string;
} {
  const fee = formatBp(settings.cardFeeBp);
  const vat = formatBp(settings.vatRateBp);
  return {
    title: `Kortavgift ${fee}, moms ${vat}.`,
    aside:
      settings.vatRateBp === 0 && settings.cardFeeBp === 0
        ? "Intäkten är hela det betalda beloppet."
        : settings.vatRateBp === 0
          ? `Kortavgiften dras från varje order, ingen moms.`
          : `Intäkten räknas exklusive ${vat} moms.`,
  };
}

// ---------------------------------------------------------------------------
// Ägarandelar
// ---------------------------------------------------------------------------

export interface ShareGroup {
  readonly validFrom: IsoDate;
  /** Sista dagen gruppen gällde (dagen före nästa), null = gäller fortfarande. */
  readonly validTo: IsoDate | null;
  readonly current: boolean;
  readonly future: boolean;
  readonly shares: readonly OwnerShareRow[];
}

function dayBefore(date: IsoDate): IsoDate {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d - 1));
  return t.toISOString().slice(0, 10);
}

/** Andelarna grupperade per giltig från, senaste först, med vilken grupp som gäller i dag. */
export function shareGroups(shares: readonly OwnerShareRow[], today: IsoDate): ShareGroup[] {
  const byDate = new Map<IsoDate, OwnerShareRow[]>();
  for (const s of shares) {
    const list = byDate.get(s.validFrom);
    if (list) list.push(s);
    else byDate.set(s.validFrom, [s]);
  }
  const dates = [...byDate.keys()].sort().reverse();
  return dates.map((validFrom, i) => {
    const newer = dates[i - 1];
    const validTo = newer ? dayBefore(newer) : null;
    return {
      validFrom,
      validTo,
      current: validFrom <= today && (validTo === null || validTo >= today),
      future: validFrom > today,
      shares: byDate
        .get(validFrom)!
        .slice()
        .sort((a, b) => b.shareBp - a.shareBp || a.holderName.localeCompare(b.holderName, "sv")),
    };
  });
}

/** "Anna 60 %, Bo 40 %." */
export function shareSummary(group: ShareGroup | undefined): string {
  if (!group) return "Inga ägarandelar inlagda.";
  return `${group.shares.map((s) => `${s.holderName} ${formatBp(s.shareBp)}`).join(", ")}.`;
}

// ---------------------------------------------------------------------------
// Kontoplan
// ---------------------------------------------------------------------------

export const ACCOUNT_USE: Record<string, string> = {
  sales: "Försäljning",
  cogs: "Inköp",
  card_fees: "Kortavgifter",
  store_commission: "Butiksprovision",
  rent: "Hyra",
  vat_out: "Utgående moms",
  settlement: "Fordran på kortinlösen",
  inventory: "Lager",
  equipment: "Automater",
  store_payable: "Skuld till butiker",
  depreciation: "Avskrivningar",
};

export function accountUse(key: string): string {
  return ACCOUNT_USE[key] ?? key;
}

// ---------------------------------------------------------------------------
// Ändringslogg
// ---------------------------------------------------------------------------

const FIELD_LABEL: Record<AuditedTable, Record<string, string>> = {
  organization_settings: {
    card_fee_bp: "Kortavgift",
    vat_rate_bp: "Momssats",
    fiscal_year_start_month: "Räkenskapsåret börjar",
    company_name: "Företagsnamn",
    org_number: "Organisationsnummer",
    company_address: "Adress",
    contact_name: "Kontaktperson",
    contact_email: "E-post",
    contact_phone: "Telefon",
  },
  owner_shares: {
    holder_name: "Ägare",
    share_bp: "Andel",
    valid_from: "Gäller från",
    member_user_id: "Användare",
  },
  ledger_accounts: {
    key: "Används för",
    bas_account: "Konto",
    name: "Namn",
  },
};

/** Företagsuppgifterna (kontraktet), loggas som "Företaget". */
const COMPANY_FIELDS: ReadonlySet<string> = new Set([
  "company_name",
  "org_number",
  "company_address",
  "contact_name",
  "contact_email",
  "contact_phone",
]);

export interface FieldChange {
  readonly label: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface SettingsLogEntry {
  readonly id: string;
  readonly occurredAt: string;
  readonly actor: string;
  /** "Inställningar", "Ägarandel: Anna", "Konto 3004". */
  readonly subject: string;
  readonly verb: "Lade till" | "Ändrade" | "Tog bort";
  readonly changes: readonly FieldChange[];
}

function fieldValue(
  table: AuditedTable,
  field: string,
  value: unknown,
  names: Readonly<Record<string, string>>,
  formatDay: (d: IsoDate) => string,
): string | null {
  if (value === null || value === undefined) return null;
  if (field.endsWith("_bp")) return formatBp(Number(value));
  if (field === "fiscal_year_start_month") return monthLabel(Number(value));
  if (field === "valid_from") return formatDay(String(value).slice(0, 10));
  if (field === "member_user_id") return names[String(value)] ?? "Borttagen användare";
  if (table === "ledger_accounts" && field === "key") return accountUse(String(value));
  return String(value);
}

function subjectOf(e: SettingsAuditEvent): string {
  const row = e.after ?? e.before ?? {};
  if (e.table === "organization_settings") {
    const before = e.before ?? {};
    const after = e.after ?? {};
    const changed = Object.keys(FIELD_LABEL.organization_settings).filter(
      (k) => e.action === "update" && String(before[k] ?? "") !== String(after[k] ?? ""),
    );
    return changed.length > 0 && changed.every((k) => COMPANY_FIELDS.has(k))
      ? "Företaget"
      : "Avgifter och moms";
  }
  if (e.table === "owner_shares") return `Ägarandel: ${String(row.holder_name ?? "")}`;
  return `Konto ${String(row.bas_account ?? "")}`.trim();
}

/**
 * Konton som lagts in samtidigt av samma person (t.ex. kontoplanen när organisationen
 * skapades) blir en rad med ett konto per rad i stället för tre fält per konto.
 */
function mergeAccountInserts(
  entries: SettingsLogEntry[],
  events: readonly SettingsAuditEvent[],
): SettingsLogEntry[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const out: SettingsLogEntry[] = [];
  for (const entry of entries) {
    const e = byId.get(entry.id)!;
    const prev = out[out.length - 1];
    const prevEvent = prev ? byId.get(prev.id.split("+")[0]!) : undefined;
    const row = e.after ?? {};
    const line: FieldChange = {
      label: `Konto ${String(row.bas_account ?? "")}`,
      before: null,
      after: accountUse(String(row.key ?? "")),
    };
    if (
      e.table === "ledger_accounts" &&
      e.action === "insert" &&
      prev &&
      prevEvent &&
      prevEvent.table === "ledger_accounts" &&
      prevEvent.action === "insert" &&
      prevEvent.occurredAt === e.occurredAt &&
      prevEvent.actorId === e.actorId
    ) {
      const first = !prev.subject.startsWith("Kontoplan");
      const prevRow = prevEvent.after ?? {};
      const lines = first
        ? [
            {
              label: `Konto ${String(prevRow.bas_account ?? "")}`,
              before: null,
              after: accountUse(String(prevRow.key ?? "")),
            },
          ]
        : [...prev.changes];
      lines.push(line);
      lines.sort((a, b) => a.label.localeCompare(b.label, "sv"));
      out[out.length - 1] = {
        ...prev,
        id: `${prev.id.split("+")[0]}+${e.id}`,
        subject: `Kontoplan, ${formatInt(lines.length)} konton`,
        changes: lines,
      };
      continue;
    }
    out.push(entry);
  }
  return out;
}

/** Loggen som rader med de fält som ändrades (före och efter), senaste först. */
export function settingsLog(
  events: readonly SettingsAuditEvent[],
  names: Readonly<Record<string, string>>,
  formatDay: (d: IsoDate) => string,
): SettingsLogEntry[] {
  const entries = events
    .slice()
    .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0))
    .map((e): SettingsLogEntry => {
      const labels = FIELD_LABEL[e.table];
      const changes: FieldChange[] = [];
      for (const [field, label] of Object.entries(labels)) {
        const b = e.before ? e.before[field] : undefined;
        const a = e.after ? e.after[field] : undefined;
        if (e.action === "update" && JSON.stringify(a) === JSON.stringify(b)) continue;
        if (e.action !== "update" && (e.action === "insert" ? a : b) == null) continue;
        changes.push({
          label,
          before: e.action === "insert" ? null : fieldValue(e.table, field, b, names, formatDay),
          after: e.action === "delete" ? null : fieldValue(e.table, field, a, names, formatDay),
        });
      }
      return {
        id: e.id,
        occurredAt: e.occurredAt,
        actor: e.actorId === null ? "Systemet" : (names[e.actorId] ?? "Borttagen användare"),
        subject: subjectOf(e),
        verb: e.action === "insert" ? "Lade till" : e.action === "update" ? "Ändrade" : "Tog bort",
        changes,
      };
    });
  return mergeAccountInserts(entries, events);
}

/** "12 ändringar, senast 2 nov. av Ägare." */
export function logAside(
  entries: readonly SettingsLogEntry[],
  formatWhen: (iso: string) => string,
): string {
  const last = entries[0];
  if (!last) return "Inga ändringar ännu.";
  return `${formatInt(entries.length)} ${entries.length === 1 ? "ändring" : "ändringar"}, senast ${formatWhen(last.occurredAt)} av ${last.actor}.`;
}

// ---------------------------------------------------------------------------
// Mitt konto: byte av lösenord
// ---------------------------------------------------------------------------

/** Samma som MIN_PASSWORD_LENGTH i src/server/auth/password.ts (som drar in node:crypto). */
export const PASSWORD_MIN_LENGTH = 12;

export interface PasswordFields {
  current: string;
  next: string;
  confirm: string;
}

/** Fel per fält före anropet. Servern kontrollerar allt igen. */
export function passwordFormErrors(
  f: PasswordFields,
): Partial<Record<keyof PasswordFields, string>> {
  const errors: Partial<Record<keyof PasswordFields, string>> = {};
  if (f.current === "") errors.current = "Fyll i nuvarande lösenord.";
  if (f.next === "") errors.next = "Fyll i nytt lösenord.";
  else if (f.next.length < PASSWORD_MIN_LENGTH)
    errors.next = `Minst ${PASSWORD_MIN_LENGTH} tecken.`;
  if (f.confirm === "") errors.confirm = "Fyll i nytt lösenord igen.";
  else if (f.next !== "" && f.confirm !== f.next) errors.confirm = "Lösenorden är inte lika.";
  return errors;
}
