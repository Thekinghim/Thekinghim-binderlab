/**
 * Ekonomi → Bokföring: en rad per månad (nyast först) med status, nyckeltal och månadspaketet
 * (SIE 4 + PDF + Excel + kvitton) att skicka till Fortnox/Talenom. Ingen automatisk
 * bokföring. Överst: "VMB i bokföringen" (standard av). Under raden: kvitton och
 * VMB-uträkningen (när VMB är på). Sist: kontoplanen.
 */

import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag, type Status } from "@/components/ui/status-tag";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { Viewer } from "@/server/data/core/loaders";
import { netSales, PURCHASE_BASIS_LABEL } from "@/server/bokforing/month";
import { PLAN_KEYS, PROPOSED_PLAN } from "@/server/bokforing/plan";
import { MAX_RECEIPT_BYTES } from "@/server/bokforing/receipts";
import {
  BokforingError,
  loadBokforingFor,
  STATUS_LABEL,
  type BokforingView,
  type MonthRow,
  type MonthStatus,
} from "@/server/bokforing/service";

import { capitalize, isoToDate, kr, monthText, plural } from "../_lib/view";
import {
  ArchiveReceiptButton,
  PlanForm,
  ReceiptDrop,
  SentToggle,
  VmbBookkeepingSwitch,
} from "./bokforing-controls";

const SECTION = "rise flex scroll-mt-28 flex-col gap-8 pb-12 md:gap-10 md:pb-16";

/**
 * Kvitton laddas upp genom en server action. På Vercel tar plattformen inte emot förfrågningar
 * över 4,5 MB, så där gäller 4 MB tills uppladdningen går direkt till lagringen.
 */
const UPLOAD_MAX_BYTES = process.env.VERCEL ? 4 * 1024 * 1024 : MAX_RECEIPT_BYTES;

const TAG: Record<MonthStatus, Status> = { open: "neutral", closed: "warning", sent: "ok" };

const PRIMARY =
  "inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-sm border border-inverse bg-inverse px-3.5 text-base font-medium text-on-inverse transition-colors hover:border-inverse-hover hover:bg-inverse-hover";

export async function BokforingSection({
  viewer,
  today,
  canEdit,
}: {
  viewer: Viewer;
  today: string;
  canEdit: boolean;
}) {
  let view: BokforingView;
  try {
    view = await loadBokforingFor(viewer, today);
  } catch (error) {
    if (!(error instanceof BokforingError)) throw error;
    // T.ex. momssats skild från 0: gäller med och utan VMB, så VMB-knappen visas inte här.
    return (
      <section id="bokforing" className={SECTION}>
        <StateMessage kind="error" message={error.message} />
      </section>
    );
  }
  const todo = view.months.filter((m) => m.status === "closed");
  const next = todo[0] ?? null;
  const planRows = PLAN_KEYS.map((k) => ({
    key: k,
    use: PROPOSED_PLAN[k].use,
    account: view.settings.plan[k],
    proposal: PROPOSED_PLAN[k].account,
    name: PROPOSED_PLAN[k].name,
  }));

  return (
    <section
      id="bokforing"
      aria-labelledby="bokforing-rubrik"
      className={SECTION}
      style={{ "--i": 1 } as React.CSSProperties}
    >
      <SectionHeader
        id="bokforing-rubrik"
        size="md"
        title={
          next
            ? `${capitalize(monthText(next.month))} är klar att skicka.`
            : view.months.some((m) => m.status === "sent")
              ? "Allt är skickat."
              : "Inget att skicka ännu."
        }
        aside={
          todo.length > 1
            ? `${plural(todo.length, "månad", "månader")} är inte skickade. Importera SIE-filen i Fortnox: Bokföring → Importera SIE.`
            : "Ladda ner paketet och importera SIE-filen i Fortnox: Bokföring → Importera SIE."
        }
      />

      <VmbBookkeepingSwitch on={view.settings.vmbEnabled} canEdit={canEdit} />

      <ol className="flex flex-col gap-3" aria-label="Månader">
        {view.months.map((m) => (
          <MonthItem key={m.month} row={m} canEdit={canEdit} today={today} />
        ))}
      </ol>

      <details
        id="kontoplan"
        className="group scroll-mt-28 rounded-md border border-line bg-surface"
      >
        <summary className="label flex min-h-10 cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-4 py-2 text-muted hover:text-fg">
          <span>Kontoplan</span>
          <span className="text-subtle normal-case">
            Förslag enligt BAS · kontrolleras av Talenom
          </span>
        </summary>
        <div className="border-t border-line p-4">
          <PlanForm
            rows={planRows}
            series={view.settings.series}
            orgNumber={view.settings.orgNumber}
            purchaseBasis={view.settings.purchaseBasis}
            openingCarryOre={view.settings.openingCarryOre}
            canEdit={canEdit}
          />
        </div>
      </details>
    </section>
  );
}

function MonthItem({ row, canEdit, today }: { row: MonthRow; canEdit: boolean; today: string }) {
  const b = row.book;
  const figures: [string, number][] = [
    ["Försäljning", netSales(b)],
    ...(b.vmbEnabled ? ([["VMB-moms", b.vmb.vatOre]] as [string, number][]) : []),
    ["Inköp", b.purchasesOre],
    ["Butikernas andel", b.storeShareOre],
    ["Resultat", b.resultOre],
  ];
  const version = row.stored && row.stored.version > 1 ? ` · v${row.stored.version}` : "";
  const statusText =
    row.status === "sent" && row.sentAt
      ? `skickad ${formatDate(new Date(row.sentAt), { year: "auto", now: isoToDate(today) })}`
      : row.status === "closed" && row.stored
        ? `${row.stored.status === "final" ? "klar att ladda ner" : "preliminär"}${version}`
        : STATUS_LABEL[row.status];
  const tag: Status =
    row.status === "closed" && row.stored?.status === "final" ? "ok" : TAG[row.status];
  return (
    <li className="rounded-md border border-line bg-surface">
      <div className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:gap-6">
        <div className="flex min-w-40 items-center justify-between gap-3 lg:flex-col lg:items-start lg:gap-1">
          <h3 className="text-base font-medium text-fg">{capitalize(monthText(row.month))}</h3>
          <StatusTag status={tag}>{statusText}</StatusTag>
        </div>
        <dl
          className={cn(
            "grid flex-1 grid-cols-2 gap-x-4 gap-y-2",
            b.vmbEnabled ? "sm:grid-cols-5" : "sm:grid-cols-4",
          )}
        >
          {figures.map(([label, v]) => (
            <div key={label} className="flex min-w-0 flex-col">
              <dt className="label text-subtle">{label}</dt>
              <dd className={cn("tnum text-fg", label === "Resultat" && "font-medium")}>{kr(v)}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          {row.status === "open" ? (
            <span className="text-sm text-muted">Pågår</span>
          ) : !row.hasVoucher && row.receipts.length === 0 ? (
            <span className="text-sm text-muted">Inget att bokföra</span>
          ) : (
            <a href={`/ekonomi/bokforing/paket?manad=${row.month}`} download className={PRIMARY}>
              Ladda ner månadspaket
            </a>
          )}
          {canEdit && row.status !== "open" ? (
            <SentToggle month={row.month} sent={row.status === "sent"} />
          ) : null}
        </div>
      </div>
      {b.profitSplitUnpricedOrders > 0 && row.status !== "open" ? (
        <div className="px-4 pb-3">
          <StateMessage
            compact
            kind="error"
            message="Butikernas andel är inte färdigräknad."
            detail={`${plural(b.profitSplitUnpricedOrders, "order", "order")} saknar inköpspris. Lägg in priserna innan månaden skickas.`}
          />
        </div>
      ) : null}
      {row.changedSinceSent ? (
        <div className="px-4 pb-3">
          <StateMessage
            compact
            kind="error"
            message="Siffrorna har ändrats sedan månaden skickades."
            detail="Skicka det nya paketet eller bokför skillnaden."
          />
        </div>
      ) : null}
      <details className="border-t border-line">
        <summary className="label flex h-9 cursor-pointer list-none items-center justify-between px-4 text-muted hover:text-fg">
          <span>
            Kvitton · {row.receipts.length}
            {b.unpricedOrders > 0
              ? ` · ${plural(b.unpricedOrders, "order", "order")} utan inköpspris`
              : ""}
          </span>
          <span className="text-subtle normal-case">
            {b.vmbEnabled ? "VMB-uträkning" : "Utan VMB"}
          </span>
        </summary>
        <div className="grid grid-cols-1 gap-6 border-t border-line p-4 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-3">
            {row.receipts.length > 0 ? (
              <ul className="flex flex-col divide-y divide-line text-sm">
                {row.receipts.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 py-1.5">
                    <a
                      href={`/ekonomi/bokforing/kvitto/${r.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="min-w-0 truncate text-fg underline-offset-2 hover:underline"
                    >
                      {r.fileName}
                    </a>
                    <span className="flex shrink-0 items-center gap-2 text-subtle">
                      <span className="tnum">{Math.max(1, Math.round(r.sizeBytes / 1024))} kB</span>
                      {canEdit ? <ArchiveReceiptButton id={r.id} /> : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Inga kvitton.</p>
            )}
            {canEdit ? <ReceiptDrop month={row.month} maxBytes={UPLOAD_MAX_BYTES} /> : null}
          </div>
          {b.vmbEnabled ? (
            <table className="w-full self-start text-sm">
              <tbody>
                <Step label="Försäljning inkl. moms" ore={b.salesInclVatOre} />
                {b.refundsOre !== 0 ? (
                  <Step label="− Återbetalningar till kunder" ore={b.refundsOre} />
                ) : null}
                <Step
                  label={`− ${PURCHASE_BASIS_LABEL[b.purchaseBasis]}`}
                  ore={b.vmb.purchasesOre}
                />
                {b.vmb.carryInOre > 0 ? (
                  <Step label="− Underskott från förra månaden" ore={b.vmb.carryInOre} />
                ) : null}
                <Step label="= Marginal" ore={b.vmb.marginOre} strong />
                <Step label="VMB-moms 20 % av positiv marginal" ore={b.vmb.vatOre} strong />
                {b.vmb.carryOutOre > 0 ? (
                  <Step label="Underskott till nästa månad" ore={b.vmb.carryOutOre} />
                ) : null}
              </tbody>
            </table>
          ) : (
            <p className="self-start text-sm text-muted">
              {row.status === "sent"
                ? "Skickad utan VMB: ingen VMB-moms."
                : "VMB är av: ingen VMB-moms och inget underskott."}
            </p>
          )}
        </div>
      </details>
    </li>
  );
}

function Step({ label, ore, strong }: { label: string; ore: number; strong?: boolean }) {
  return (
    <tr className={cn("border-b border-line", strong && "font-medium text-fg")}>
      <td className="py-1 pr-3 text-muted">{label}</td>
      <td className="tnum py-1 text-right text-fg">{kr(ore)}</td>
    </tr>
  );
}
