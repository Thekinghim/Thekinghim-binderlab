import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Panel } from "@/components/ui/frame";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { StatusGlyph, StatusTag } from "@/components/ui/status-tag";
import { formatInt, MISSING, NBSP } from "@/lib/format";
import { StorePortalAccess } from "@/app/portal/_components/store-portal-access";

import { AddRecipientButton } from "../_components/recipient-dialogs";
import { NewAgreementButton } from "../_components/agreement-dialogs";
import { StoreRevenueChart } from "../_components/charts";
import { AgreementsTable, MachinesTable, RecipientsTable } from "../_components/detail-tables";
import { StoreKpis } from "../_components/kpis";
import { StoreActions } from "../_components/store-dialogs";
import { Sub } from "../_components/sub";
import { loadStoreDetail, storeNameOf, type StoreDetailData } from "../_lib/data";
import {
  dayText,
  earliestNewAgreementDay,
  kronor,
  MODEL_LABEL,
  placeText,
  plural,
  sek,
  sentence,
} from "../_lib/model";

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
  const data = await loadStoreDetail(decodeURIComponent(butik), await searchParams);
  if (!data) notFound();
  const { ctx, store, period, headline, current } = data;
  const days = `${formatInt(period.days)}${NBSP}d`;
  const comparison = period.comparisonLabel ? `Jämfört med ${period.comparisonLabel}` : undefined;
  const placed = data.machines.filter((m) => m.current);

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-6 pb-16 md:gap-16 md:px-8 md:pt-10">
      <div className="flex flex-col gap-6">
        <nav aria-label="Brödsmulor">
          <Link
            href={`/butiker${data.query}`}
            className="meta inline-flex items-center gap-1.5 rounded-xs text-subtle hover:text-fg"
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
                ? "Exempelbutik. Den visas som exempel i listor och rapporter."
                : undefined
          }
          meta={[
            {
              label: "Status",
              value: store.archived ? (
                <StatusTag status="offline">Arkiverad</StatusTag>
              ) : current ? (
                <StatusTag status="ok">Avtal gäller</StatusTag>
              ) : (
                <StatusTag status={placed.length > 0 ? "critical" : "neutral"}>
                  Inget avtal
                </StatusTag>
              ),
            },
            ...(store.isExample
              ? [{ label: "Typ", value: <StatusTag status="neutral">Exempel</StatusTag> }]
              : []),
            { label: "Period", value: period.rangeLabel },
            { label: "Automater", value: formatInt(placed.length) },
            { label: "Modell", value: current ? MODEL_LABEL[current.model] : MISSING },
          ]}
          actions={
            ctx.canEdit ? (
              <StoreActions store={store} machines={placed.map((m) => m.code)} />
            ) : undefined
          }
        />
        {data.issues.length > 0 ? <Issues data={data} /> : null}
      </div>

      <div className="flex flex-col gap-3">
        <StoreKpis items={data.kpis} label={`Nyckeltal · ${days}`} comparison={comparison} />
        <p className="max-w-[72ch] text-sm text-muted">
          {sentence(
            `Till butiken är provision på alla order och hyra för hela perioden ${period.rangeLabel}`,
          )}{" "}
          Vinsten gäller order med inköpspris, som på Lönsamhet.
        </p>
      </div>

      <SalesSection data={data} days={days} />
      <CompensationSection data={data} />
      <MachinesSection data={data} days={days} />
      <ContactSection data={data} />
      {/* Butiksportalen (fas 10): vem i butiken som har tillgång. Bara ägare och admin. */}
      {ctx.canEdit && !store.archived ? (
        <StorePortalAccess
          index={5}
          storeId={store.id}
          storeName={store.name}
          defaultEmail={store.email}
          timeZone={ctx.timeZone}
        />
      ) : null}
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
        {data.issues.map((i) => (
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
        index={1}
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
          detail={
            data.machines.length === 0
              ? "Ingen automat har stått i butiken. Placera en automat under Automater."
              : "Välj en längre period i periodraden."
          }
        />
      )}
    </section>
  );
}

function CompensationSection({ data }: { data: StoreDetailData }) {
  const { month, current, ctx, store } = data;
  return (
    <section aria-labelledby="ersattning" className="flex flex-col gap-8 border-t border-line pt-8">
      <SectionHeader
        id="ersattning"
        index={2}
        eyebrow={`Ersättning · ${month.monthLabel} hittills`}
        title={data.compensation.title}
        aside={data.compensation.aside}
        actions={
          ctx.canEdit && !store.archived ? (
            <NewAgreementButton
              storeId={store.id}
              storeName={store.name}
              today={ctx.today}
              current={current}
              minFrom={earliestNewAgreementDay(data.agreements)}
            />
          ) : undefined
        }
      />
      <div className="grid grid-cols-1 gap-x-8 gap-y-12 lg:grid-cols-12">
        <Sub
          index="02.1"
          label={`Intjänat · ${formatInt(month.days)} av ${formatInt(month.daysInMonth)} d`}
          title={current ? sentence(current.termsLabel) : "Inget avtal gäller i dag."}
          className="lg:col-span-5"
        >
          <dl className="flex flex-col">
            <Line
              label="Intäkt"
              value={kronor(month.revenueOre)}
              meta={plural(month.orders, "pack", "pack")}
            />
            <Line label="Provision" value={kronor(month.commissionOre)} />
            <Line
              label="Hyra"
              value={kronor(month.rentOre)}
              meta={month.rentOre > 0 ? `${formatInt(month.days)}${NBSP}d` : undefined}
            />
            <Line label="Totalt till butiken" value={kronor(month.totalOre)} strong />
          </dl>
        </Sub>
        <Sub
          index="02.2"
          label="Avtalshistorik"
          meta={plural(data.agreements.length, "avtal", "avtal")}
          title={
            data.agreements.length === 0
              ? "Inga avtal registrerade."
              : current
                ? sentence(`Gällande avtal från ${dayText(current.validFrom, ctx.today)}`)
                : sentence(`Senaste avtalet ${data.agreements[0]!.periodLabel}`)
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
              message={`${store.name} har inget avtal.`}
              detail={
                ctx.canEdit
                  ? "Lägg in provision, hyra eller båda med Nytt avtal."
                  : "Ägare och admin lägger in avtal."
              }
            />
          )}
          <p className="mt-4 text-sm text-muted">
            <Link href="/avtal" className="rounded-xs hover:text-fg">
              Avtalsfiler och uppsägningstider under Avtal{NBSP}→
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
        index={3}
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
          detail={
            data.ctx.canEdit
              ? "Automater placeras i butiker på automatens sida."
              : "Ägare och admin placerar automater."
          }
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
        index={4}
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
        <Sub index="04.1" label="Kontaktuppgifter" className="lg:col-span-4">
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
                      <a href={c.href} className="rounded-xs hover:underline">
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
          index="04.2"
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
              <StateMessage
                kind="empty"
                compact
                message={`Ingen mottagare för ${store.name}.`}
                detail="Månadsrapporten skickas till butikens mottagare när den godkänts under Rapporter."
              />
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
