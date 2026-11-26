/**
 * Ekonomi → Bokföring: en rad per månad (nyast först) med status, nyckeltal och månadspaketet
 * (SIE 4 + PDF + Excel + kvitton) att skicka till Fortnox/Talenom. Ingen automatisk
 * bokföring. Överst: "VMB i bokföringen" (standard av). Under raden: kvitton och
 * VMB-uträkningen (när VMB är på). Sist: kontoplanen.
 */

import { PageIntro } from "@/components/v2/page-intro";
import { StateMessage } from "@/components/ui/state-message";
import { MobileFold } from "@/components/ui/mobile-fold";
import { MobileTopList } from "@/components/ui/mobile-top-list";
import { StatusTag, type Status } from "@/components/ui/status-tag";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { Viewer } from "@/server/data/core/loaders";
import { missingCostReason, netSales, PURCHASE_BASIS_LABEL } from "@/server/bokforing/month";
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

/** Vilken av appens två bokföringsfiler som bokhållaren importerar (samma i LAS-MIG.txt). */
export const IMPORT_THIS_TEXT =
  "Det här paketet är det bokhållaren ska importera. SIE-filen under Rapporter → Bokföringsunderlag är bara ett underlag: importera inte båda.";

import { bookkeepingTitle } from "../_lib/headline";
import { amountsAlike, capitalize, isoToDate, monthText, plural } from "../_lib/view";
import { OpenMoreOnHash } from "./open-more";
import {
  ArchiveReceiptButton,
  PlanForm,
  ReceiptDrop,
  SentToggle,
  VmbBookkeepingSwitch,
} from "./bokforing-controls";

/** Ankare som öppnar "Fler val" (#kontoplan är rutans id; kontraktet länkar till #bokforing). */
const MORE_HASHES = ["kontoplan", "bokforing"] as const;

const SECTION = "flex scroll-mt-28 flex-col gap-[14px] max-[900px]:gap-3";

/**
 * Kvitton laddas upp genom en server action. På Vercel tar plattformen inte emot förfrågningar
 * över 4,5 MB, så där gäller 4 MB tills uppladdningen går direkt till lagringen.
 */
const UPLOAD_MAX_BYTES = process.env.VERCEL ? 4 * 1024 * 1024 : MAX_RECEIPT_BYTES;

const TAG: Record<MonthStatus, Status> = { open: "neutral", closed: "warning", sent: "ok" };

const PRIMARY = "v2-btn act touch";

export async function BokforingSection({
  viewer,
  today,
  canEdit,
}: {
  viewer: Viewer;
  today: string;
  canEdit: boolean;
  /** Äldre val: sidans rubrik (h1) står nu i V2-sidhuvudet, avsnittet har alltid h2. */
  asPage?: boolean;
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
  // Månaderna står nyast först, men de skickas i ordning: den äldsta som inte är skickad är
  // nästa (VMB-underskottet förs vidare från månaden före).
  const next = todo.at(-1) ?? null;
  const nextMissing = next ? missingCostReason(next.book) : null;
  const planRows = PLAN_KEYS.map((k) => ({
    key: k,
    use: PROPOSED_PLAN[k].use,
    account: view.settings.plan[k],
    proposal: PROPOSED_PLAN[k].account,
    name: PROPOSED_PLAN[k].name,
  }));

  return (
    <section id="bokforing" aria-labelledby="bokforing-rubrik" className={SECTION}>
      <PageIntro
        id="bokforing-rubrik"
        as="h2"
        title={
          nextMissing
            ? `${capitalize(monthText(next!.month))} är inte klar.`
            : bookkeepingTitle(view.months, capitalize(monthText(next?.month ?? "")))
        }
        aside={
          nextMissing
            ? nextMissing
            : next
              ? todo.length > 1
                ? `${plural(todo.length, "månad", "månader")} kvar. Importera SIE-filen i Fortnox.`
                : "Importera SIE-filen i Fortnox."
              : undefined
        }
      >
        {/* Appen har två SIE-filer: den här är den som importeras. */}
        <p className="text-v2-sm text-v2-mute" data-which-sie>
          {IMPORT_THIS_TEXT}
        </p>
      </PageIntro>

      {/* Mobil: tre månader (alltid den att skicka härnäst), resten bakom "Alla N månader". */}
      <MobileTopList
        className="flex flex-col gap-[14px] max-[900px]:gap-3"
        ariaLabel="Månader"
        total={view.months.length}
        noun="månader"
      >
        {view.months.map((m, i) => (
          <MonthItem
            key={m.month}
            row={m}
            canEdit={canEdit}
            today={today}
            index={i}
            next={m.month === next?.month}
          />
        ))}
      </MobileTopList>

      <OpenMoreOnHash detailsId="kontoplan" hashes={MORE_HASHES} />
      {/* Sällan ändrat: VMB-valet och kontoplanen. Läget syns i raden även när den är stängd. */}
      <details id="kontoplan" suppressHydrationWarning className="group v2-card scroll-mt-28">
        <summary className="flex min-h-12 cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-[18px] py-2 text-v2-md font-[650] text-v2-ink hover:bg-v2-hover [&::-webkit-details-marker]:hidden">
          <span>Fler val</span>
          <span className="text-v2-sm font-[450] text-v2-mute">
            {view.settings.vmbEnabled ? "VMB på" : "VMB av"} · Kontoplan
          </span>
        </summary>
        <div className="flex flex-col gap-6 border-t border-v2-line px-[18px] py-4">
          <VmbBookkeepingSwitch on={view.settings.vmbEnabled} canEdit={canEdit} />
          <div className="flex flex-col gap-3">
            <p className="flex flex-wrap items-center justify-between gap-2 text-v2-sm font-[550] text-v2-ink">
              <span>Kontoplan</span>
              <span className="font-[450] text-v2-mute">Förslag enligt BAS</span>
            </p>
            <PlanForm
              rows={planRows}
              series={view.settings.series}
              orgNumber={view.settings.orgNumber}
              purchaseBasis={view.settings.purchaseBasis}
              openingCarryOre={view.settings.openingCarryOre}
              canEdit={canEdit}
            />
          </div>
        </div>
      </details>
    </section>
  );
}

function MonthItem({
  row,
  canEdit,
  today,
  index,
  next = false,
}: {
  row: MonthRow;
  canEdit: boolean;
  today: string;
  index: number;
  /** Månaden som rubriken säger ska skickas härnäst. */
  next?: boolean;
}) {
  const b = row.book;
  const figures: [string, number][] = [
    ["Försäljning", netSales(b)],
    ...(b.vmbEnabled ? ([["VMB-moms", b.vmb.vatOre]] as [string, number][]) : []),
    ["Inköp", b.purchasesOre],
    ["Butikernas andel", b.storeShareOre],
    ["Resultat", b.resultOre],
  ];
  // Samma form på alla siffror i raden (inte "30 000 kr" bredvid "81 645,20 kr").
  const shown = amountsAlike(figures.map(([, v]) => v));
  const resultShown = shown[shown.length - 1]!;
  const version = row.stored && row.stored.version > 1 ? ` · v${row.stored.version}` : "";
  // Räknat nu: saknas kostnader är månaden aldrig "klar", även om ett äldre sparat paket
  // sa det (nästa paket blir preliminärt tills kostnaderna finns).
  const missing = row.status === "open" ? null : missingCostReason(b);
  const final = row.stored?.status === "final" && !missing;
  const statusText =
    row.status === "sent" && row.sentAt
      ? `skickad ${formatDate(new Date(row.sentAt), { year: "auto", now: isoToDate(today) })}`
      : row.status === "closed" && (row.stored || missing)
        ? `${final ? "klar att ladda ner" : "preliminär"}${row.stored ? version : ""}`
        : STATUS_LABEL[row.status];
  const tag: Status = row.status === "closed" && final ? "ok" : TAG[row.status];
  // Mobil: månaden som ska skickas härnäst står först; den och de som är klara att skicka
  // har siffrorna öppna, de andra visar bara namn, läge och resultat tills man öppnar dem.
  // Bara den ena flyttas upp, så att resten står kvar i månadsordning (nyast först).
  const ready = next || (row.status === "closed" && final);
  const dl = (
    <dl
      className={cn(
        "grid flex-1 grid-cols-2 gap-x-4 gap-y-2",
        b.vmbEnabled ? "sm:grid-cols-5" : "sm:grid-cols-4",
      )}
    >
      {figures.map(([label], i) => (
        <div key={label} className="flex min-w-0 flex-col">
          <dt className="text-v2-xs text-v2-mute">{label}</dt>
          <dd className={cn("tnum text-v2-md text-v2-ink", label === "Resultat" && "font-[650]")}>
            {shown[i]}
          </dd>
        </div>
      ))}
    </dl>
  );
  return (
    <li
      className={cn("v2-card", next && "max-md:order-first")}
      data-keep={next ? "" : undefined}
      data-index={index}
    >
      <div className="flex flex-col gap-4 px-[18px] py-4 lg:flex-row lg:items-center lg:gap-6">
        <div className="flex min-w-40 items-center justify-between gap-3 lg:flex-col lg:items-start lg:gap-1">
          <h3 className="text-v2-md font-[650] text-v2-ink">{capitalize(monthText(row.month))}</h3>
          <StatusTag status={tag}>{statusText}</StatusTag>
        </div>
        {ready ? (
          dl
        ) : (
          <MobileFold summary="Resultat" meta={resultShown} className="flex-1">
            {dl}
          </MobileFold>
        )}
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          {row.status === "open" ? (
            <span className="text-v2-sm text-v2-mute">Pågår</span>
          ) : !row.hasVoucher && row.receipts.length === 0 ? (
            <span className="text-v2-sm text-v2-mute">Inget att bokföra</span>
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
      {missing ? (
        <div className="px-[18px] pb-3">
          <StateMessage
            compact
            kind="error"
            message="Kostnaderna är inte klara."
            detail={missing}
          />
        </div>
      ) : b.purchaseBasis === "cost_of_goods" && b.purchasesOre > 0 ? (
        <p className="px-[18px] pb-3 text-v2-xs text-v2-mute">
          {b.purchaseBasisAuto ? "Inga inköpsorder: inköp" : "Inköp"} = vad de sålda packen kostade.
        </p>
      ) : null}
      {row.changedSinceSent ? (
        <div className="px-[18px] pb-3">
          <StateMessage
            compact
            kind="error"
            message="Ändrad sedan den skickades."
            detail="Skicka det nya paketet eller bokför skillnaden."
          />
        </div>
      ) : null}
      <details className="border-t border-v2-line2">
        <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 px-[18px] text-v2-sm font-[550] text-v2-ink hover:bg-v2-hover max-md:min-h-11 [&::-webkit-details-marker]:hidden">
          <span>
            Kvitton · {row.receipts.length}
            {b.unpricedOrders > 0
              ? ` · ${plural(b.unpricedOrders, "order", "order")} utan inköpspris`
              : ""}
          </span>
          <span className="font-[450] text-v2-mute">
            {b.vmbEnabled ? "VMB-uträkning" : "Utan VMB"}
          </span>
        </summary>
        <div className="grid grid-cols-1 gap-6 border-t border-v2-line2 px-[18px] py-4 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-3">
            {row.receipts.length > 0 ? (
              <ul className="flex flex-col divide-y divide-v2-line2 text-v2-sm">
                {row.receipts.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 py-1.5">
                    <a
                      href={`/ekonomi/bokforing/kvitto/${r.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="min-w-0 truncate text-v2-ink underline-offset-2 hover:underline"
                    >
                      {r.fileName}
                    </a>
                    <span className="flex shrink-0 items-center gap-2 text-v2-mute">
                      <span className="tnum">{Math.max(1, Math.round(r.sizeBytes / 1024))} kB</span>
                      {canEdit ? <ArchiveReceiptButton id={r.id} /> : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-v2-sm text-v2-mute">Inga kvitton.</p>
            )}
            {canEdit ? <ReceiptDrop month={row.month} maxBytes={UPLOAD_MAX_BYTES} /> : null}
          </div>
          {b.vmbEnabled ? (
            <VmbSteps
              steps={[
                { label: "Försäljning inkl. moms", ore: b.salesInclVatOre },
                ...(b.refundsOre !== 0
                  ? [{ label: "− Återbetalningar till kunder", ore: b.refundsOre }]
                  : []),
                { label: `− ${PURCHASE_BASIS_LABEL[b.purchaseBasis]}`, ore: b.vmb.purchasesOre },
                ...(b.vmb.carryInOre > 0
                  ? [{ label: "− Underskott från förra månaden", ore: b.vmb.carryInOre }]
                  : []),
                { label: "= Marginal", ore: b.vmb.marginOre, strong: true },
                { label: "VMB-moms 20 % av positiv marginal", ore: b.vmb.vatOre, strong: true },
                ...(b.vmb.carryOutOre > 0
                  ? [{ label: "Underskott till nästa månad", ore: b.vmb.carryOutOre }]
                  : []),
              ]}
            />
          ) : (
            <p className="self-start text-v2-sm text-v2-mute">
              {row.status === "sent" ? "Skickad utan VMB." : "Utan VMB."}
            </p>
          )}
        </div>
      </details>
    </li>
  );
}

interface VmbStep {
  readonly label: string;
  readonly ore: number;
  readonly strong?: boolean;
}

/** VMB-uträkningen steg för steg, alla belopp i samma form (amountsAlike). */
function VmbSteps({ steps }: { steps: readonly VmbStep[] }) {
  const shown = amountsAlike(steps.map((st) => st.ore));
  return (
    <table className="w-full self-start text-v2-sm">
      <tbody>
        {steps.map((st, i) => (
          <tr
            key={st.label}
            className={cn("border-b border-v2-line2", st.strong && "font-[550] text-v2-ink")}
          >
            <td className="py-1.5 pr-3 text-v2-mute">{st.label}</td>
            <td className="tnum py-1.5 text-right text-v2-ink">{shown[i]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
