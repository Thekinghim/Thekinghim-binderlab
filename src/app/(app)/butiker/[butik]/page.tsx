import type { Metadata } from "next";
import { AiPageLine } from "@/components/assistant/panel-context";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";

import { HashTab } from "@/components/ui/hash-tab";
import { Badge } from "@/components/v2/badge";
import { ButtonLink } from "@/components/v2/button";
import { Card, CardBody } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { Notice } from "@/components/v2/notice";
import { PAGE_BODY, PageIntro } from "@/components/v2/page-intro";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { SubNav } from "@/components/v2/sub-nav";
import { formatInt, MISSING, NBSP } from "@/lib/format";
import { StorePortalAccess } from "@/app/portal/_components/store-portal-access";

import { AddAgreementButton } from "../_components/agreement-dialogs";
import { AddRecipientButton } from "../_components/recipient-dialogs";
import { AgreementFormSelect } from "../_components/agreement-form-select";
import { PowerHoursSetting } from "../_components/power-hours";
import { ReportDetailsToggle } from "../_components/report-details-toggle";
import { StoreRevenueChart } from "../_components/charts";
import { AgreementsTable, MachinesTable, RecipientsTable } from "../_components/detail-tables";
import { StoreKpis } from "../_components/kpis";
import { StoreHero } from "../_components/store-hero";
import { ClosedMonthsBanner } from "../../_manad/closed-note";
import { StoreOwnerPicker } from "../_components/owner-dialogs";
import { StoreActions } from "../_components/store-dialogs";
import { Sub } from "../_components/sub";
import "../_components/store.css";
import "../_components/v2/shops-visual.css";
import { pickTab, ViewTabs } from "../../automater/_components/view-tabs";
import { loadStoreDetail, storeNameOf, type StoreDetailData } from "../_lib/data";
import { loadStoreBanner } from "../_lib/visual-data";
import { loadOwnersFor, type OwnerView } from "../_lib/owner-service";
import { currentViewer } from "../_lib/session";
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
  const [data, owners, banner] = await Promise.all([
    loadStoreDetail(decodeURIComponent(butik), sp),
    currentViewer().then((viewer) => loadOwnersFor(viewer)),
    // Visuellt: symbolen och de mest sålda packen (bara antal, ett fel ger en tom banner).
    loadStoreBanner(decodeURIComponent(butik), sp),
  ]);
  if (!data) notFound();
  // Butikens ägare (bolaget), och de aktiva ägarna att välja bland.
  const owner = owners.find((o) => o.stores.some((st) => st.id === data.store.id)) ?? null;
  const choices = owners
    .filter((o) => !o.archived || o.id === owner?.id)
    .map((o) => ({ id: o.id, legalName: o.legalName, orgNumber: o.orgNumber }));
  const { ctx, store, period, headline, current } = data;
  const days = `${formatInt(period.days)}${NBSP}d`;
  const comparison = period.comparisonLabel ? `Jämfört med ${period.comparisonLabel}` : undefined;
  const placed = data.machines.filter((m) => m.current);
  const tab = pickTab(TABS, sp.vy);
  // Inget avtal (i dag med automat, eller dagar i perioden): butiken räknas som 0 %.
  const noAgreement = data.issues.find((i) => AGREEMENT_ISSUES.has(i.id)) ?? null;
  const firstPlaced = placed.map((m) => m.from).sort()[0] ?? ctx.today;
  const agreementFrom =
    data.agreements.length === 0 ? firstPlaced : (data.agreementGap?.firstDay ?? ctx.today);
  // Luckan ligger före dagens avtal: det nya avtalet slutar där luckan slutar.
  const gapEnd = current && data.agreementGap ? (data.agreementGap.lastDay ?? null) : null;

  // Kontraktets läge (faktaraden under rubriken).
  const contractFact = store.archived ? (
    <Badge>Arkiverad</Badge>
  ) : data.contract === "signed" ? (
    <Badge tone="success" dot>
      Signerat
    </Badge>
  ) : (
    <Badge tone={placed.length > 0 ? "critical" : "neutral"} dot={placed.length > 0}>
      {data.contract === "unsigned" ? "Ej signerat" : "Saknas"}
    </Badge>
  );

  return (
    <V2Page
      title={store.name}
      date={headerDate(new Date(ctx.now), ctx.timeZone)}
      period
      sub={
        <nav aria-label="Brödsmulor">
          <Link
            href={`/butiker${data.query}`}
            className="inline-flex min-h-7 items-center gap-1.5 rounded-v2-sm font-[550] text-v2-ink hover:underline max-[900px]:min-h-11"
          >
            <span aria-hidden="true">←</span>
            Alla butiker
          </Link>
        </nav>
      }
    >
      <SubNav />
      <div className={PAGE_BODY}>
        <Suspense fallback={null}>
          <HashTab map={HASH_TO_TAB} defaultTab={TABS[0].value} />
        </Suspense>
        <StoreHero
          name={store.name}
          face={{ storeType: banner.face.storeType, city: banner.face.city ?? store.city }}
          sales={banner.sales}
          machines={placed.map((m) => ({ id: m.machineId, name: m.name, look: m.appearance }))}
          days={days}
        />
        <PageIntro
          title={headline.title}
          aside={headline.aside}
          facts={[
            { label: "Kontrakt", value: contractFact },
            { label: "Automater", value: formatInt(placed.length) },
            { label: "Modell", value: current ? MODEL_LABEL[current.model] : MISSING },
            {
              label: "Ägare",
              value: owner ? (
                <span data-store-owner>
                  {owner.legalName} <span className="tnum text-v2-mute">{owner.orgNumber}</span>
                </span>
              ) : (
                MISSING
              ),
            },
          ]}
          actions={
            ctx.canEdit ? (
              <StoreActions store={store} machines={placed.map((m) => m.code)} />
            ) : undefined
          }
        >
          {store.archived || store.isExample ? (
            <p className="text-v2-sm text-v2-mute">
              {store.archived ? "Butiken är arkiverad. Historiken finns kvar." : "Exempelbutik."}
            </p>
          ) : null}
          <AiPageLine metric="butikens resultat och andel" route="butiker" />
        </PageIntro>

        {noAgreement && !store.archived ? (
          <div data-no-agreement>
            <Notice
              tone="critical"
              title={
                noAgreement.id === "no-agreement" || data.agreementGap?.whole
                  ? NO_AGREEMENT_SHORT
                  : data.agreementGap!.short
              }
              action={
                ctx.canEdit ? (
                  <AddAgreementButton
                    storeId={store.id}
                    storeName={store.name}
                    defaultFrom={agreementFrom}
                    defaultTo={gapEnd}
                    className="max-sm:w-full"
                  />
                ) : undefined
              }
            >
              {noAgreement.text}
            </Notice>
          </div>
        ) : null}
        {!store.archived && data.contract !== "signed" ? (
          <Notice
            tone={placed.length > 0 ? "critical" : "info"}
            title={
              data.contract === "unsigned" ? "Kontraktet är inte signerat." : "Kontrakt saknas."
            }
            action={
              ctx.canEdit ? (
                <ButtonLink
                  href={contractAction(data.contract, store.id).href}
                  variant="act"
                  touch
                  className="max-sm:w-full"
                >
                  {contractAction(data.contract, store.id).label}
                </ButtonLink>
              ) : undefined
            }
          />
        ) : null}
        {/* Kontraktet står i rutan ovan; här resten. */}
        {data.issues.some((i) => !BANNER_ISSUES.has(i.id)) ? <Issues data={data} /> : null}

        <StoreKpis items={data.kpis} label={`Nyckeltal · ${days}`} comparison={comparison} />
        {/* Till butiken är det vi betalar; vinsten räknar inte order utan inköpspris. */}
        {data.unpricedNote ? (
          <p className="-mt-1 text-v2-sm text-v2-mute" data-unpriced-note>
            {data.unpricedNote}
          </p>
        ) : null}

        <div className="pt-1">
          <ViewTabs
            tabs={TABS}
            value={tab}
            basePath={`/butiker/${encodeURIComponent(butik)}`}
            query={data.query}
            label="Visa"
          />
        </div>

        <div key={tab} className="v2-enter v2-stack">
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
              <OwnerSection data={data} owner={owner} choices={choices} />
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
    </V2Page>
  );
}

// ---------------------------------------------------------------------------
// Sektioner
// ---------------------------------------------------------------------------

function Issues({ data }: { data: StoreDetailData }) {
  const issues = data.issues.filter((i) => !BANNER_ISSUES.has(i.id));
  return (
    <Card as="section" title="Att göra" count={issues.length}>
      <ul aria-label="Att göra för butiken" className="flex flex-col">
        {issues.map((i) => (
          <li
            key={i.id}
            className="flex items-start gap-2.5 border-t border-v2-line2 px-[18px] py-3 text-v2-md first:border-t-0"
          >
            <span
              aria-hidden="true"
              className={`v2-dot mt-[7px] shrink-0 ${i.level === "critical" ? "critical" : i.level === "warning" ? "warning" : ""}`}
            />
            <span className={i.level === "critical" ? "text-v2-ink" : "text-v2-mute"}>
              {i.level === "critical" ? <span className="sr-only">Kräver åtgärd: </span> : null}
              {i.text}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Rubriken i ett kort med en mening och en grå fortsättning (som PageIntro, 14 px). */
function CardLead({ title, aside, id }: { title: ReactNode; aside?: ReactNode; id?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <h3 id={id} className="text-v2-md font-[550] text-balance text-v2-ink">
        {title}
      </h3>
      {aside ? <p className="text-v2-sm text-v2-mute">{aside}</p> : null}
    </div>
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
    <Card as="section" title={`Intäkt per dag · ${days}`}>
      <CardBody className="flex flex-col gap-4">
        <CardLead
          id="forsaljning"
          title="Försäljning per dag."
          aside={
            total > 0 && peak
              ? `Snitt ${sek(mean * 100)} per dag ${data.period.span}, topp ${dayText(peak.date, data.ctx.today)} med ${sek(peak.value * 100)}.`
              : "Ingen försäljning i perioden."
          }
        />
        {total > 0 ? (
          <StoreRevenueChart
            name={data.store.name}
            daily={data.daily}
            compare={data.dailyCompare}
            compareName={data.period.comparisonLabel ? `Föreg. ${days}` : undefined}
          />
        ) : (
          <Empty
            title={sentence(`Inga order i ${data.store.name} ${data.period.rangeLabel}`)}
            action={
              data.machines.length === 0 && data.ctx.canEdit ? (
                <ButtonLink href="/automater" variant="act" touch>
                  Placera automat
                </ButtonLink>
              ) : undefined
            }
          />
        )}
      </CardBody>
    </Card>
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
    <>
      <Card
        as="section"
        title={`Ersättning · ${month.monthLabel} hittills`}
        actions={
          ctx.canEdit && !store.archived ? (
            <ButtonLink href={action.href} variant={action.primary ? "act" : "default"} touch>
              {action.label}
            </ButtonLink>
          ) : undefined
        }
      >
        <CardBody>
          <CardLead
            id="ersattning"
            title={data.compensation.title}
            aside={data.compensation.aside}
          />
        </CardBody>
      </Card>
      <div className="v2-cols">
        <div className="v2-stack">
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
          >
            <ClosedMonthsBanner className="mb-3" />
            {data.agreements.length > 0 ? (
              <AgreementsTable
                agreements={data.agreements}
                today={ctx.today}
                canEdit={ctx.canEdit && !store.archived}
                storeName={store.name}
              />
            ) : (
              <Empty title={`${store.name} har inga villkor.`} />
            )}
            <p className="mt-3 text-v2-sm">
              <Link
                href="/avtal"
                className="inline-flex min-h-7 items-center rounded-v2-sm font-[550] text-v2-ink hover:underline max-[900px]:min-h-11"
              >
                Kontrakt{NBSP}→
              </Link>
            </p>
          </Sub>
        </div>
        <div className="v2-stack">
          <Sub
            label={`Intjänat · ${formatInt(month.days)} av ${formatInt(month.daysInMonth)} d`}
            title={current ? sentence(current.termsLabel) : "Inga villkor i dag."}
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
        </div>
      </div>
    </>
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
      className={`flex items-baseline justify-between gap-4 py-2.5 text-v2-md ${strong ? "" : "border-b border-v2-line2"}`}
    >
      <dt className={strong ? "font-[550] text-v2-ink" : "text-v2-mute"}>
        {label}
        {meta ? <span className="ml-2 text-v2-sm text-v2-faint">{meta}</span> : null}
      </dt>
      <dd className={`tnum text-right text-v2-ink ${strong ? "font-[650]" : ""}`}>{value}</dd>
    </div>
  );
}

function MachinesSection({ data, days }: { data: StoreDetailData; days: string }) {
  const placed = data.machines.filter((m) => m.current);
  const top = [...placed].sort((a, b) => b.revenueOre - a.revenueOre)[0];
  return (
    <Card as="section" title={`Automater · ${days}`} count={placed.length}>
      <CardBody className="flex flex-col gap-4">
        <CardLead
          id="automater"
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
          <Empty
            title={`Ingen automat har stått i ${data.store.name}.`}
            action={
              data.ctx.canEdit ? (
                <ButtonLink href="/automater" touch>
                  Öppna Automater
                </ButtonLink>
              ) : undefined
            }
          />
        )}
      </CardBody>
    </Card>
  );
}

/** Butikens ägare (bolaget): namn och organisationsnummer, och valet av ägare. */
function OwnerSection({
  data,
  owner,
  choices,
}: {
  data: StoreDetailData;
  owner: OwnerView | null;
  choices: ReadonlyArray<{ id: string; legalName: string; orgNumber: string }>;
}) {
  const { store, ctx } = data;
  const others = owner ? owner.stores.filter((s) => s.id !== store.id && !s.archived) : [];
  return (
    <Card
      as="section"
      title="Ägare"
      link={{ href: "/butiker?vy=agare", label: "Alla butiksägare" }}
    >
      <CardBody className="flex flex-col gap-4">
        <CardLead
          id="agare"
          title={owner ? owner.legalName : "Ingen ägare angiven."}
          aside={
            owner
              ? `Org.nr ${owner.orgNumber.replace("-", "‑")}${others.length > 0 ? ` · äger också ${others.map((s) => s.name).join(", ")}` : ""}.`
              : "Bolaget som äger butiken. Samma ägare för flera butiker ger statistik för alla tillsammans."
          }
        />
        {ctx.canEdit && !store.archived ? (
          <StoreOwnerPicker
            key={owner?.id ?? "ingen"}
            storeId={store.id}
            storeName={store.name}
            ownerId={owner?.id ?? null}
            owners={choices}
          />
        ) : null}
      </CardBody>
    </Card>
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
    <>
      <div className="v2-cols">
        <div className="v2-stack">
          <Sub
            label="Rapportmottagare"
            meta={plural(recipients.length, "mottagare", "mottagare")}
            id="kontakt"
            title={
              active.length === 0
                ? "Ingen tar emot månadsrapporten."
                : `${plural(active.length, "mottagare", "mottagare")} får månadsrapporten.`
            }
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
                <Empty title={`Ingen mottagare för ${store.name}.`} />
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
              {/* Läsaren ser valet men kan inte ändra det (bara ägare och admin). */}
              <ReportDetailsToggle
                storeId={store.id}
                storeName={store.name}
                initial={store.reportDetails === true}
                canEdit={ctx.canEdit && !store.archived}
              />
              <AgreementFormSelect
                storeId={store.id}
                initial={store.agreementForm ?? null}
                signedContract={data.contract === "signed"}
                canEdit={ctx.canEdit && !store.archived}
              />
            </div>
          </Sub>
        </div>
        <div className="v2-stack">
          <Sub label="Kontaktuppgifter">
            <dl className="v2-kv">
              {contact.map((c) => (
                <div key={c.label}>
                  <dt>{c.label}</dt>
                  <dd className="min-w-0 break-words">
                    {c.value ? (
                      c.href ? (
                        <a
                          href={c.href}
                          className="rounded-v2-sm underline decoration-v2-line underline-offset-4 hover:decoration-v2-ink max-[900px]:inline-flex max-[900px]:min-h-11 max-[900px]:items-center"
                        >
                          {c.value}
                        </a>
                      ) : (
                        c.value
                      )
                    ) : (
                      <span className="text-v2-faint">{MISSING}</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            {/* Läsaren ser tiderna men kan inte ändra dem (bara ägare och admin). */}
            <div className="mt-4">
              <PowerHoursSetting
                storeId={store.id}
                storeName={store.name}
                initial={store.powerHours ?? null}
                canEdit={ctx.canEdit && !store.archived}
              />
            </div>
          </Sub>
        </div>
      </div>
    </>
  );
}
