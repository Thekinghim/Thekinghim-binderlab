import type { Metadata } from "next";
import { AiPageLine } from "@/components/assistant/panel-context";
import Link from "next/link";
import type React from "react";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { Panel } from "@/components/ui/frame";
import { HashTab } from "@/components/ui/hash-tab";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { StatusGlyph, StatusTag } from "@/components/ui/status-tag";
import { formatInt, MISSING, NBSP } from "@/lib/format";
import { StorePortalAccess } from "@/app/portal/_components/store-portal-access";

import { AddAgreementButton } from "../_components/agreement-dialogs";
import { AddRecipientButton } from "../_components/recipient-dialogs";
import { StoreRevenueChart } from "../_components/charts";
import { AgreementsTable, MachinesTable, RecipientsTable } from "../_components/detail-tables";
import { StoreKpis } from "../_components/kpis";
import { StoreActions } from "../_components/store-dialogs";
import { Sub } from "../_components/sub";
import { pickTab, ViewTabs } from "../../automater/_components/view-tabs";
import { loadStoreDetail, storeNameOf, type StoreDetailData } from "../_lib/data";
import {
  contractAction,
  dayText,
  kronor,
  MODEL_LABEL,
  NO_AGREEMENT_SHORT,
  placeText,
  plural,
  sek,
  sentence,
} from "../_lib/model";

const TABS = [
  { value: "oversikt", label: "Översikt" },
  { value: "avtal", label: "Villkor" },
  { value: "kontakt", label: "Kontakt och rapport" },
] as const;

/** Åtgärderna om avtalet (egen ruta med "Lägg in avtal"). */
const AGREEMENT_ISSUES: ReadonlySet<string> = new Set(["no-agreement", "agreement-gap"]);
/** Åtgärderna som har en egen ruta överst (kontraktet och avtalet), inte i listan. */
const BANNER_ISSUES: ReadonlySet<string> = new Set(["no-contract", ...AGREEMENT_ISSUES]);

/** Ankare → flik (t.ex. /butiker/<id>#ersattning från kom-igång-listan). */
const HASH_TO_TAB: Record<string, string> = { ersattning: "avtal" };

type Params = Promise<{ butik: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const name = await storeNameOf(decodeURIComponent((await params).butik));
  return { title: name ?? "Butik" };
}

/**
 * En butik: intäkt i perioden, ersättningsmodell med avtalshistorik och hittills
 * intjänad ersättning denna månad (storeCompensation i @/domain), automaterna som står
 * eller har stått där, kontaktuppgifter och rapportmottagare. Ägare och admin ändrar;
 * läsaren ser samma sak utan knappar.
 */
export default async function StorePage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { butik } = await params;
  const sp = await searchParams;
  const data = await loadStoreDetail(decodeURIComponent(butik), sp);
  if (!data) notFound();
  const { ctx, store, period, headline, current } = data;
  const days = `${formatInt(period.days)}${NBSP}d`;
  const comparison = period.comparisonLabel ? `Jämfört med ${period.comparisonLabel}` : undefined;
  const placed = data.machines.filter((m) => m.current);
  const tab = pickTab(TABS, sp.vy);
  const rise = (i: number) => ({ "--i": i }) as React.CSSProperties;
  // Inget avtal (i dag med automat, eller dagar i perioden): butiken räknas som 0 %.
  const noAgreement = data.issues.find((i) => AGREEMENT_ISSUES.has(i.id)) ?? null;
  const firstPlaced = placed.map((m) => m.from).sort()[0] ?? ctx.today;
  const agreementFrom =
    data.agreements.length === 0 ? firstPlaced : (data.agreementGap?.firstDay ?? ctx.today);
  // Luckan ligger före dagens avtal: det nya avtalet slutar där luckan slutar.
  const gapEnd = current && data.agreementGap ? (data.agreementGap.lastDay ?? null) : null;

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-6 pb-16 md:gap-16 md:px-8 md:pt-10">
      <Suspense fallback={null}>
        <HashTab map={HASH_TO_TAB} defaultTab={TABS[0].value} />
      </Suspense>
      <div className="rise flex flex-col gap-6">
        <nav aria-label="Brödsmulor">
          <Link
            href={`/butiker${data.query}`}
            className="meta inline-flex min-h-7 items-center gap-1.5 rounded-xs text-subtle hover:text-fg max-md:tap max-md:min-h-11"
          >
            <span aria-hidden className="text-faint">
              ←
            </span>
            Alla butiker
          </Link>
        </nav>
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow={`Butik / ${store.name}`}
          title={headline.title}
          aside={headline.aside}
          description={
            store.archived
              ? "Butiken är arkiverad. Historiken finns kvar."
              : store.isExample
                ? "Exempelbutik."
                : undefined
          }
          meta={[
            {
              label: "Kontrakt",
              value: store.archived ? (
                <StatusTag status="offline">Arkiverad</StatusTag>
              ) : data.contract === "signed" ? (
                <span className="label inline-flex h-6 items-center gap-1.5 text-up">
                  <span aria-hidden className="size-1.5 rounded-full bg-up" />
                  Signerat
                </span>
              ) : (
                <StatusTag
                  status={placed.length > 0 ? "critical" : "neutral"}
                  className={placed.length > 0 ? "text-signal-fg" : undefined}
                >
                  {data.contract === "unsigned" ? "Ej signerat" : "Saknas"}
                </StatusTag>
              ),
            },
            { label: "Automater", value: formatInt(placed.length) },
            { label: "Modell", value: current ? MODEL_LABEL[current.model] : MISSING },
          ]}
          actions={
            ctx.canEdit ? (
              <StoreActions store={store} machines={placed.map((m) => m.code)} />
            ) : undefined
          }
        />
        {noAgreement && !store.archived ? (
          <div
            className="flex flex-col gap-3 rounded-md border border-signal-line bg-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            data-no-agreement
          >
            <span className="flex flex-col gap-0.5">
              <span className="flex items-center gap-2 text-base font-medium text-fg">
                <span aria-hidden className="size-2 shrink-0 rounded-full bg-signal" />
                {noAgreement.id === "no-agreement" || data.agreementGap?.whole
                  ? NO_AGREEMENT_SHORT
                  : data.agreementGap!.short}
              </span>
              <span className="text-sm text-muted">{noAgreement.text}</span>
            </span>
            {ctx.canEdit ? (
              <AddAgreementButton
                storeId={store.id}
                storeName={store.name}
                defaultFrom={agreementFrom}
                defaultTo={gapEnd}
                className="max-sm:w-full"
              />
            ) : null}
          </div>
        ) : null}
        {!store.archived && data.contract !== "signed" ? (
          <div
            className={`flex flex-col gap-3 rounded-md border bg-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${placed.length > 0 ? "border-signal-line" : "border-line"}`}
          >
            <span className="flex items-center gap-2 text-base text-fg">
              <span
                aria-hidden
                className={`size-2 rounded-full ${placed.length > 0 ? "bg-signal" : "bg-line-strong"}`}
              />
              {data.contract === "unsigned" ? "Kontraktet är inte signerat." : "Kontrakt saknas."}
            </span>
            {ctx.canEdit ? (
              <Link
                href={contractAction(data.contract, store.id).href}
                className="inline-flex h-11 items-center justify-center rounded-sm border border-inverse bg-inverse px-5 text-base font-medium text-on-inverse hover:bg-inverse-hover"
              >
                {contractAction(data.contract, store.id).label}
              </Link>
            ) : null}
          </div>
        ) : null}
        <AiPageLine metric="butikens resultat och andel" route="butiker" className="mt-4" />
        {/* Kontraktet står i rutan ovan; här resten. */}
        {data.issues.some((i) => !BANNER_ISSUES.has(i.id)) ? <Issues data={data} /> : null}
      </div>

      <div className="rise flex flex-col gap-3" style={rise(1)}>
        <StoreKpis items={data.kpis} label={`Nyckeltal · ${days}`} comparison={comparison} />
        {/* Till butiken är det vi betalar; vinsten räknar inte order utan inköpspris. */}
        {data.unpricedNote ? (
          <p className="text-sm text-muted" data-unpriced-note>
            {data.unpricedNote}
          </p>
        ) : null}
      </div>

      <div className="rise -mb-6 md:-mb-10" style={rise(2)}>
        <ViewTabs
          tabs={TABS}
          value={tab}
          basePath={`/butiker/${encodeURIComponent(butik)}`}
          query={data.query}
          label="Visa"
        />
      </div>

      <div key={tab} className="fade-in flex flex-col gap-12 md:gap-16">
        {tab === "oversikt" ? (
          <>
            <SalesSection data={data} days={days} />
            <MachinesSection data={data} days={days} />
          </>
        ) : null}
        {tab === "avtal" ? <CompensationSection data={data} /> : null}
        {tab === "kontakt" ? (
          <>
            <ContactSection data={data} />
            {/* Butiksportalen (fas 10): vem i butiken som har tillgång. Bara ägare och admin. */}
            {ctx.canEdit && !store.archived ? (
              <StorePortalAccess
                storeId={store.id}
                storeName={store.name}
                defaultEmail={store.email}
                timeZone={ctx.timeZone}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sektioner
// ---------------------------------------------------------------------------

function Issues({ data }: { data: StoreDetailData }) {
  return (
    <section aria-label="Att göra för butiken" className="border-t border-line pt-4">
      <p className="label text-subtle">Att göra</p>
      <ul className="mt-3 flex flex-col gap-2">
        {data.issues
          .filter((i) => !BANNER_ISSUES.has(i.id))
          .map((i) => (
            <li key={i.id} className="flex items-start gap-3 text-base">
              <span className="mt-1.5 shrink-0">
                <StatusGlyph status={i.level} />
              </span>
              <span className={i.level === "critical" ? "text-fg" : "text-muted"}>
                {i.level === "critical" ? <span className="sr-only">Kräver åtgärd: </span> : null}
                {i.text}
              </span>
            </li>
          ))}
      </ul>
    </section>
  );
}

function SalesSection({ data, days }: { data: StoreDetailData; days: string }) {
  // data.daily är redan klippt till dagarna med data, så snittet räknas på dem.
  const total = data.daily.reduce((s, d) => s + d.value, 0);
  const mean = data.daily.length > 0 ? total / data.daily.length : 0;
  const peak = data.daily.reduce<(typeof data.daily)[number] | null>(
    (b, d) => (b === null || d.value > b.value ? d : b),
    null,
  );
  return (
    <section
      aria-labelledby="forsaljning"
      className="flex flex-col gap-8 border-t border-line pt-8"
    >
      <SectionHeader
        id="forsaljning"
        eyebrow={`Intäkt per dag · ${days}`}
        title="Försäljning per dag."
        aside={
          total > 0 && peak
            ? `Snitt ${sek(mean * 100)} per dag ${data.period.span}, topp ${dayText(peak.date, data.ctx.today)} med ${sek(peak.value * 100)}.`
            : "Ingen försäljning i perioden."
        }
      />
      {total > 0 ? (
        <Panel grid marks>
          <StoreRevenueChart
            name={data.store.name}
            daily={data.daily}
            compare={data.dailyCompare}
            compareName={data.period.comparisonLabel ? `Föreg. ${days}` : undefined}
          />
        </Panel>
      ) : (
        <StateMessage
          kind="empty"
          message={sentence(`Inga order i ${data.store.name} ${data.period.rangeLabel}`)}
          action={
            data.machines.length === 0 && data.ctx.canEdit
              ? { label: "Placera automat", href: "/automater" }
              : undefined
          }
        />
      )}
    </section>
  );
}

function CompensationSection({ data }: { data: StoreDetailData }) {
  const { month, current, ctx, store } = data;
  // Skapa kontrakt bara utan kontrakt: ett skickat kontrakt signeras, inte dubbleras.
  const action = contractAction(data.contract, store.id);
  // Hyran visas bara när butikens avtal har hyra (eller en hyra ändå räknats i månaden).
  const storeHasRent =
    month.rentOre !== 0 || data.agreements.some((a) => (a.monthlyRentOre ?? 0) > 0);
  return (
    <section aria-labelledby="ersattning" className="flex flex-col gap-8 border-t border-line pt-8">
      <SectionHeader
        id="ersattning"
        eyebrow={`Ersättning · ${month.monthLabel} hittills`}
        title={data.compensation.title}
        aside={data.compensation.aside}
        actions={
          ctx.canEdit && !store.archived ? (
            <Link
              href={action.href}
              className={
                action.primary
                  ? "inline-flex h-9 items-center gap-2 rounded-sm border border-inverse bg-inverse px-3.5 text-base font-medium text-on-inverse transition-colors duration-fast ease-instrument hover:bg-inverse-hover max-md:min-h-11"
                  : "inline-flex h-9 items-center gap-2 rounded-sm border border-line-strong bg-surface px-3.5 text-base font-medium text-fg transition-colors duration-fast ease-instrument hover:border-line-control hover:bg-hover max-md:min-h-11"
              }
            >
              {action.label}
            </Link>
          ) : undefined
        }
      />
      <div className="grid grid-cols-1 gap-x-8 gap-y-12 lg:grid-cols-12">
        <Sub
          label={`Intjänat · ${formatInt(month.days)} av ${formatInt(month.daysInMonth)} d`}
          title={current ? sentence(current.termsLabel) : "Inga villkor i dag."}
          className="lg:col-span-5"
        >
          <dl className="flex flex-col">
            <Line
              label="Intäkt"
              value={kronor(month.revenueOre)}
              meta={plural(month.orders, "pack", "pack")}
            />
            <Line
              label={current?.model === "split" ? "Andel av vinsten" : "Provision"}
              value={kronor(month.commissionOre)}
            />
            {storeHasRent ? (
              <Line
                label="Hyra"
                value={kronor(month.rentOre)}
                meta={month.rentOre > 0 ? `${formatInt(month.days)}${NBSP}d` : undefined}
              />
            ) : null}
            <Line label="Totalt till butiken" value={kronor(month.totalOre)} strong />
          </dl>
        </Sub>
        <Sub
          label="Historik"
          meta={plural(data.agreements.length, "villkor", "villkor")}
          title={
            data.agreements.length === 0
              ? "Inga villkor än."
              : current
                ? sentence(`Gäller från ${dayText(current.validFrom, ctx.today)}`)
                : sentence(`Senast ${data.agreements[0]!.periodLabel}`)
          }
          className="lg:col-span-7"
        >
          {data.agreements.length > 0 ? (
            <AgreementsTable
              agreements={data.agreements}
              today={ctx.today}
              canEdit={ctx.canEdit && !store.archived}
              storeName={store.name}
            />
          ) : (
            <StateMessage
              kind="not-configured"
              compact
              message={`${store.name} har inga villkor.`}
            />
          )}
          <p className="mt-4 text-sm text-muted">
            <Link href="/avtal" className="rounded-xs hover:text-fg max-md:tap">
              Kontrakt{NBSP}→
            </Link>
          </p>
        </Sub>
      </div>
    </section>
  );
}

function Line({
  label,
  value,
  meta,
  strong,
}: {
  label: string;
  value: string;
  meta?: string;
  strong?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-4 border-b border-line py-2.5 ${strong ? "border-b-0" : ""}`}
    >
      <dt className={strong ? "text-fg" : "text-muted"}>
        {label}
        {meta ? <span className="meta ml-2 text-subtle">{meta}</span> : null}
      </dt>
      <dd className={`tnum text-right ${strong ? "text-md font-medium text-fg" : "text-fg"}`}>
        {value}
      </dd>
    </div>
  );
}

function MachinesSection({ data, days }: { data: StoreDetailData; days: string }) {
  const placed = data.machines.filter((m) => m.current);
  const top = [...placed].sort((a, b) => b.revenueOre - a.revenueOre)[0];
  return (
    <section aria-labelledby="automater" className="flex flex-col gap-8 border-t border-line pt-8">
      <SectionHeader
        id="automater"
        eyebrow={`Automater · ${days}`}
        title={
          placed.length === 0
            ? "Ingen automat står i butiken."
            : `${plural(placed.length, "automat", "automater")} står i butiken.`
        }
        aside={
          top && top.revenueOre > 0 && placed.length > 1
            ? `${top.code} säljer mest, ${sek(top.revenueOre)}.`
            : data.machines.length > placed.length
              ? `${plural(data.machines.length - placed.length, "tidigare placering", "tidigare placeringar")}.`
              : undefined
        }
      />
      {data.machines.length > 0 ? (
        <MachinesTable
          machines={data.machines}
          today={data.ctx.today}
          caption={`Automater i ${data.store.name}, intäkt ${data.period.rangeLabel}`}
        />
      ) : (
        <StateMessage
          kind="empty"
          message={`Ingen automat har stått i ${data.store.name}.`}
          action={data.ctx.canEdit ? { label: "Öppna Automater", href: "/automater" } : undefined}
        />
      )}
    </section>
  );
}

function ContactSection({ data }: { data: StoreDetailData }) {
  const { store, ctx, recipients } = data;
  const active = recipients.filter((r) => r.active);
  const contact: Array<{ label: string; value: string | null; href?: string }> = [
    { label: "Kontaktperson", value: store.contactName },
    {
      label: "E-post",
      value: store.email,
      href: store.email ? `mailto:${store.email}` : undefined,
    },
    {
      label: "Telefon",
      value: store.phone,
      href: store.phone ? `tel:${store.phone.replace(/[^+0-9]/g, "")}` : undefined,
    },
    { label: "Adress", value: placeText(store.address, store.city) },
  ];
  const suggested =
    store.contactName && store.email && !recipients.some((r) => r.email === store.email)
      ? { name: store.contactName, email: store.email }
      : null;
  return (
    <section aria-labelledby="kontakt" className="flex flex-col gap-8 border-t border-line pt-8">
      <SectionHeader
        id="kontakt"
        eyebrow="Kontakt och rapport"
        title={
          active.length === 0
            ? "Ingen tar emot månadsrapporten."
            : `${plural(active.length, "mottagare", "mottagare")} får månadsrapporten.`
        }
        aside={
          store.contactName ? `Kontaktperson ${store.contactName}.` : "Ingen kontaktperson angiven."
        }
      />
      <div className="grid grid-cols-1 gap-x-8 gap-y-12 lg:grid-cols-12">
        <Sub label="Kontaktuppgifter" className="lg:col-span-4">
          <dl className="flex flex-col">
            {contact.map((c) => (
              <div
                key={c.label}
                className="flex items-baseline justify-between gap-4 border-b border-line py-2.5 last:border-b-0"
              >
                <dt className="shrink-0 text-muted">{c.label}</dt>
                <dd className="min-w-0 text-right break-words text-fg">
                  {c.value ? (
                    c.href ? (
                      <a
                        href={c.href}
                        className="rounded-xs hover:underline max-md:tap max-md:max-w-full max-md:justify-end max-md:underline max-md:decoration-line-strong max-md:underline-offset-4"
                      >
                        {c.value}
                      </a>
                    ) : (
                      c.value
                    )
                  ) : (
                    <span className="text-subtle">{MISSING}</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </Sub>
        <Sub
          label="Rapportmottagare"
          meta={plural(recipients.length, "mottagare", "mottagare")}
          className="lg:col-span-8"
        >
          <div className="flex flex-col gap-4">
            {recipients.length > 0 ? (
              <RecipientsTable
                recipients={recipients}
                timeZone={ctx.timeZone}
                now={ctx.now}
                canEdit={ctx.canEdit}
                caption={`Mottagare av månadsrapporten för ${store.name}`}
              />
            ) : (
              <StateMessage kind="empty" compact message={`Ingen mottagare för ${store.name}.`} />
            )}
            {ctx.canEdit && !store.archived ? (
              <div>
                <AddRecipientButton
                  storeId={store.id}
                  storeName={store.name}
                  defaults={suggested}
                />
              </div>
            ) : null}
          </div>
        </Sub>
      </div>
    </section>
  );
}
