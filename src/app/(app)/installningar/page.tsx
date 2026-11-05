import type { Metadata } from "next";
import Link from "next/link";

import { wallClockIn } from "@/components/shell/period-state";
import { MobileFold } from "@/components/ui/mobile-fold";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { EN_DASH, NBSP, formatDate, formatInt } from "@/lib/format";
import { operatorGaps, operatorParty } from "@/server/contracts/operator";
import { requireRoute } from "@/server/data/core";
import { listDataExportsFor } from "@/server/export/service";
import { requireUser } from "@/server/session";

import { CompanyForm } from "./_components/company-form";
import { ExportDataButton } from "./_components/export-data";
import { MerHead } from "./_components/mer-head";
import { OwnerSharesForm } from "./_components/owner-shares-form";
import { SettingsForm } from "./_components/settings-form";
import { SettingsLog } from "./_components/settings-log";
import { SubscriptionSection } from "./_components/subscription-section";
import { loadSettingsPageFor } from "./_lib/data";
import {
  accountUse,
  fiscalYearLabel,
  formatBp,
  logAside,
  settingsHeadline,
  settingsLog,
  shareGroups,
  shareSummary,
} from "./_lib/model";

export const metadata: Metadata = { title: "Inställningar" };

function dayDate(date: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12);
}

function SubLabel({ children }: { children: string }) {
  return <h3 className="label text-subtle">{children}</h3>;
}

/**
 * Inställningar: kortavgift, momssats och räkenskapsår, ägarandelar, bokföringskonton och
 * ändringsloggen. Ägare och admin (requireRoute skickar andra till sin startsida); bara
 * ägaren ändrar ägarandelarna. Data läses under RLS efter en rollkontroll mot databasen.
 */
export default async function SettingsPage() {
  const ctx = await requireRoute("installningar");
  const user = await requireUser();
  const isOwnerRole = ctx.role === "owner";
  const [data, exports] = await Promise.all([
    loadSettingsPageFor(user, ctx.organization.id),
    isOwnerRole
      ? listDataExportsFor({ user, organization: { ...ctx.organization, role: ctx.role } }).catch(
          () => [],
        )
      : Promise.resolve([]),
  ]);

  const tz = ctx.timeZone;
  const today = ctx.today;
  const nowLocal = wallClockIn(new Date(ctx.now), tz);
  const day = (d: string) => formatDate(dayDate(d), { year: "auto", now: dayDate(today) });
  const when = (iso: string) =>
    formatDate(wallClockIn(new Date(iso), tz), { year: "auto", now: nowLocal });

  const settings = data.settings ?? { cardFeeBp: 0, vatRateBp: 0, fiscalYearStartMonth: 1 };
  const headline = settingsHeadline(settings);
  const log = settingsLog(data.events, data.actorNames, day);
  const settingsChanges = log.filter((e) => e.subject === "Avgifter och moms");
  const lastSettingsChange = settingsChanges[0];
  const groups = shareGroups(data.shares, today);
  const currentGroup = groups.find((g) => g.current) ?? groups.find((g) => !g.future);
  const isOwner = data.role === "owner";
  const company = data.company;
  const companyGaps = operatorGaps(operatorParty(ctx.organization.name, company));

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-10 px-4 pt-8 pb-16 max-md:gap-6 md:gap-12 md:px-8 md:pt-12">
      <MerHead
        eyebrow="Inställningar"
        title={headline.title}
        // Mobil: räkenskapsåret står i formuläret, ändringarna i loggen.
        metaOnMobile={false}
        meta={[
          { label: "Räkenskapsår", value: fiscalYearLabel(settings.fiscalYearStartMonth) },
          {
            label: "Senast ändrat",
            value: lastSettingsChange
              ? `${when(lastSettingsChange.occurredAt)} · ${lastSettingsChange.actor}`
              : "Aldrig",
          },
        ]}
      />

      <nav
        aria-label="Fler inställningar"
        // Mobil: två rader i en lista i stället för knappar.
        className="rise flex flex-wrap gap-2 max-md:flex-col max-md:gap-0 max-md:border-t max-md:border-line"
        style={{ "--i": 1 } as React.CSSProperties}
      >
        {[
          {
            href: "/installningar/anvandare",
            label: "Användare",
          },
          {
            href: "/installningar/konto",
            label: "Mitt konto",
          },
        ].map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="lift group inline-flex h-9 items-center gap-3 rounded-sm border border-line-strong bg-surface px-3.5 text-base text-fg hover:bg-hover max-md:h-12 max-md:justify-between max-md:rounded-none max-md:border-x-0 max-md:border-t-0 max-md:border-line max-md:bg-transparent max-md:px-0"
          >
            {l.label}
            <span aria-hidden className="text-faint transition-colors group-hover:text-fg">
              →
            </span>
          </Link>
        ))}
      </nav>

      <section
        aria-labelledby="avgifter"
        className="rise flex flex-col gap-8 max-md:gap-3"
        style={{ "--i": 2 } as React.CSSProperties}
      >
        <SectionHeader id="avgifter" size="md" title="Avgifter och moms." />
        {/* Mobil: formulären är hopfällda med nuvarande värden på raden. */}
        <MobileFold
          summary="Ändra"
          meta={`Kortavgift ${formatBp(settings.cardFeeBp)} · moms ${formatBp(settings.vatRateBp)}`}
        >
          <div className="max-w-2xl">
            <SettingsForm
              key={`${settings.cardFeeBp}-${settings.vatRateBp}-${settings.fiscalYearStartMonth}`}
              cardFeeBp={settings.cardFeeBp}
              vatRateBp={settings.vatRateBp}
              fiscalYearStartMonth={settings.fiscalYearStartMonth}
            />
          </div>
        </MobileFold>
      </section>

      <section
        id="foretaget"
        aria-labelledby="foretaget-rubrik"
        className="rise flex scroll-mt-28 flex-col gap-8 max-md:gap-3"
        style={{ "--i": 3 } as React.CSSProperties}
      >
        <SectionHeader
          id="foretaget-rubrik"
          size="md"
          title={companyGaps.length === 0 ? "Företaget." : "Företaget saknar uppgifter."}
          aside={
            companyGaps.length === 0
              ? "Står i kontrakten."
              : `Tomt i kontrakten: ${companyGaps.join(", ")}.`
          }
        />
        <MobileFold
          summary="Ändra"
          meta={
            companyGaps.length === 0 ? "Allt ifyllt" : `${formatInt(companyGaps.length)} saknas`
          }
        >
          <div className="max-w-2xl">
            <CompanyForm
              organizationName={ctx.organization.name}
              initial={{
                companyName: company.companyName ?? "",
                orgNumber: company.orgNumber ?? "",
                companyAddress: company.companyAddress ?? "",
                contactName: company.contactName ?? "",
                contactEmail: company.contactEmail ?? "",
                contactPhone: company.contactPhone ?? "",
              }}
            />
          </div>
        </MobileFold>
      </section>

      <SubscriptionSection
        user={user}
        organizationId={ctx.organization.id}
        today={today}
        index={3}
      />

      <section
        aria-labelledby="agarandelar"
        className="rise flex flex-col gap-8 max-md:gap-3"
        style={{ "--i": 4 } as React.CSSProperties}
      >
        <SectionHeader
          id="agarandelar"
          size="md"
          title={currentGroup ? shareSummary(currentGroup) : "Inga ägarandelar inlagda."}
          aside={
            currentGroup ? `Sedan ${day(currentGroup.validFrom).replace(/\.$/, "")}.` : undefined
          }
        />
        <MobileFold summary="Visa och ändra" meta={formatInt(groups.length)}>
          <div className="grid grid-cols-1 gap-x-8 gap-y-10 lg:grid-cols-12">
            <div className="flex min-w-0 flex-col gap-4 lg:col-span-7">
              <SubLabel>Fördelningar</SubLabel>
              {groups.length === 0 ? (
                <StateMessage
                  kind="empty"
                  compact
                  message="Inga ägarandelar."
                  detail={isOwner ? undefined : "Ägaren lägger in dem."}
                />
              ) : (
                <ol className="flex flex-col">
                  {groups.map((g) => (
                    <li
                      key={g.validFrom}
                      className="flex flex-col gap-2 border-t border-line py-3 last:border-b"
                    >
                      <p className="meta tnum text-muted">
                        {day(g.validFrom)}
                        {NBSP}
                        {EN_DASH}
                        {g.validTo ? `${NBSP}${day(g.validTo)}` : " tills vidare"}
                        {g.current ? <span className="label ml-2 text-fg">Gäller nu</span> : null}
                        {g.future ? <span className="label ml-2 text-subtle">Kommande</span> : null}
                      </p>
                      <ul className="flex flex-col gap-1">
                        {g.shares.map((s) => (
                          <li key={s.id} className="flex items-baseline justify-between gap-4">
                            <span className="text-fg">{s.holderName}</span>
                            <span className="tnum text-fg">{formatBp(s.shareBp)}</span>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-4 lg:col-span-5">
              <SubLabel>Ny fördelning</SubLabel>
              {isOwner ? (
                <OwnerSharesForm
                  initial={(currentGroup?.shares ?? []).map((s) => ({
                    holderName: s.holderName,
                    shareBp: s.shareBp,
                    memberUserId: s.memberUserId,
                  }))}
                  members={data.members
                    .slice()
                    .sort(
                      (a, b) => Number(b.userId === ctx.user.id) - Number(a.userId === ctx.user.id),
                    )}
                  today={today}
                />
              ) : (
                <StateMessage kind="denied" compact message="Bara ägaren ändrar ägarandelarna." />
              )}
            </div>
          </div>
        </MobileFold>
      </section>

      <section
        id="din-data"
        aria-labelledby="din-data-rubrik"
        className="rise flex scroll-mt-28 flex-col gap-4 max-md:gap-3"
        style={{ "--i": 5 } as React.CSSProperties}
      >
        <SectionHeader
          id="din-data-rubrik"
          size="md"
          title="Din data."
          aside={
            exports[0]
              ? `Senast ${when(exports[0].createdAt)}${exports[0].createdBy ? ` · ${exports[0].createdBy}` : ""}.`
              : "Allt i en ZIP-fil."
          }
        />
        <p className="max-w-2xl text-sm text-muted">
          Order, automater, butiker, titlar, priser, lager och avräkningar som CSV-filer. Öppnas i
          Excel. Högst 3 gånger per timme.
        </p>
        {isOwnerRole ? (
          <ExportDataButton />
        ) : (
          <StateMessage kind="denied" compact message="Bara ägaren kan exportera all data." />
        )}
      </section>

      <details
        className="rise rounded-md border border-line bg-surface p-4 md:p-5"
        style={{ "--i": 6 } as React.CSSProperties}
      >
        <summary className="cursor-pointer list-none">
          <SectionHeader
            id="konton"
            size="md"
            title="Konton."
            aside={`${formatInt(data.accounts.length)} st.`}
          />
        </summary>
        <div className="mt-6">
          {data.accounts.length === 0 ? (
            <StateMessage kind="empty" compact message="Inga bokföringskonton är inlagda." />
          ) : (
            <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
              <table className="w-full border-collapse text-base">
                <caption className="sr-only">Bokföringskonton</caption>
                <thead>
                  <tr className="border-b border-line-strong">
                    <th scope="col" className="label h-9 pr-3 text-left font-normal text-subtle">
                      Konto
                    </th>
                    <th scope="col" className="label h-9 px-3 text-left font-normal text-subtle">
                      Används för
                    </th>
                    <th
                      scope="col"
                      className="label hidden h-9 px-3 text-left font-normal text-subtle md:table-cell"
                    >
                      Namn i BAS
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.accounts.map((a) => (
                    <tr key={a.id} className="border-b border-line">
                      <td className="tnum py-2.5 pr-3 text-fg">{a.basAccount}</td>
                      <td className="px-3 py-2.5 text-fg">
                        {accountUse(a.key)}
                        <span className="block text-sm text-subtle md:hidden">{a.name}</span>
                      </td>
                      <td className="hidden px-3 py-2.5 text-muted md:table-cell">{a.name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </details>

      <details
        className="rise rounded-md border border-line bg-surface p-4 md:p-5"
        style={{ "--i": 7 } as React.CSSProperties}
      >
        <summary className="cursor-pointer list-none">
          <SectionHeader
            id="andringslogg"
            size="md"
            title="Ändringslogg."
            aside={logAside(log, when)}
          />
        </summary>
        <div className="mt-6">
          {log.length === 0 ? (
            <StateMessage kind="empty" compact message="Inga ändringar ännu." />
          ) : (
            <SettingsLog entries={log} timeZone={tz} now={ctx.now} />
          )}
        </div>
      </details>
    </div>
  );
}
