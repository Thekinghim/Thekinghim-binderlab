import type { Metadata } from "next";
import Link from "next/link";

import { AppRefreshButton } from "@/components/pwa/app-refresh-button";
import { wallClockIn } from "@/components/shell/period-state";
import { MobileFold } from "@/components/ui/mobile-fold";
import { Badge } from "@/components/v2/badge";
import { Card, CardBody } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { V2Page } from "@/components/v2/shell/page";
import { SubNav } from "@/components/v2/sub-nav";
import { Table } from "@/components/v2/table";
import { DEFAULT_VAT_LIMIT_ORE, settingsCheckHeadline, vatAckValid } from "@/analytics/self-check";
import { EN_DASH, NBSP, formatDate, formatInt } from "@/lib/format";
import { operatorGaps, operatorParty } from "@/server/contracts/operator";
import { requireRoute } from "@/server/data/core";
import { fiscalYearAround } from "@/server/self-check/queries";
import { listCustomerDemosFor } from "@/server/demo/customer-demos";
import { listDataExportsFor } from "@/server/export/service";
import { loadPayoutSettingsFor } from "@/server/payouts/service";
import { requireUser } from "@/server/session";

import { CompanyForm } from "./_components/company-form";
import { CustomerDemos, type CustomerDemoRow } from "./_components/customer-demos";
import { ExportDataButton } from "./_components/export-data";
import { FoldCard } from "./_components/fold-card";
import { OwnerSharesForm } from "./_components/owner-shares-form";
import { PartnerForm } from "./_components/partner-form";
import { SettingsForm } from "./_components/settings-form";
import { SettingsNotices, VatAcknowledgedLine } from "./_components/settings-notices";
import { SettingsLog } from "./_components/settings-log";
import { SubscriptionSection } from "./_components/subscription-section";
import "./_components/settings.css";
import { loadSettingsIssuesFor, loadSettingsPageFor } from "./_lib/data";
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

// Demo för kunder byggs i steg av server actions på den här sidan (högst ca 90 s per steg).
export const maxDuration = 300;

function dayDate(date: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12);
}

function SubLabel({ children }: { children: string }) {
  return <h3 className="st-h3">{children}</h3>;
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
  const payoutViewer = { user, organization: { ...ctx.organization, role: ctx.role } };
  const [data, issues, exports, payoutSettings] = await Promise.all([
    loadSettingsPageFor(user, ctx.organization.id),
    // Varningarna får aldrig stoppa sidan: utan dem visas inställningarna som förut.
    loadSettingsIssuesFor(user, ctx.organization.id, ctx.today).catch(() => null),
    isOwnerRole
      ? listDataExportsFor({ user, organization: { ...ctx.organization, role: ctx.role } }).catch(
          () => [],
        )
      : Promise.resolve([]),
    // Partneravtalet (Pengar → Utbetalningar). Fel stoppar inte sidan.
    loadPayoutSettingsFor(payoutViewer).catch(() => null),
  ]);

  const tz = ctx.timeZone;
  const today = ctx.today;
  const nowLocal = wallClockIn(new Date(ctx.now), tz);
  const day = (d: string) => formatDate(dayDate(d), { year: "auto", now: dayDate(today) });
  const when = (iso: string) =>
    formatDate(wallClockIn(new Date(iso), tz), { year: "auto", now: nowLocal });

  const settings = data.settings ?? {
    cardFeeBp: 0,
    vatRateBp: 0,
    fiscalYearStartMonth: 1,
    vatLimitOre: DEFAULT_VAT_LIMIT_ORE,
    vatOkAt: null,
  };
  const headline = settingsHeadline(settings);
  // Rubriken: det som behöver kollas, annars "Allt är inställt." (null = gick inte att läsa).
  const check = issues ? settingsCheckHeadline(issues) : null;
  const log = settingsLog(data.events, data.actorNames, day);
  const settingsChanges = log.filter((e) => e.subject === "Avgifter och moms");
  const lastSettingsChange = settingsChanges[0];
  const groups = shareGroups(data.shares, today);
  const currentGroup = groups.find((g) => g.current) ?? groups.find((g) => !g.future);
  const isOwner = data.role === "owner";
  const company = data.company;
  // Demo för kunder: bara ägaren i en riktig organisation (null annars, sektionen syns inte).
  const demoList = isOwner ? await listCustomerDemosFor(user, ctx.organization.id) : null;
  const customerDemos: CustomerDemoRow[] | null = demoList?.ok
    ? (demoList.data ?? []).map((d) => ({
        id: d.id,
        customerEmail: d.customerEmail,
        status: d.status,
        step: d.step,
        steps: d.steps,
        createdLabel: when(d.createdAt),
        accepted: d.accepted,
      }))
    : null;
  const companyGaps = operatorGaps(operatorParty(ctx.organization.name, company));

  const subParts = [
    headline.title.replace(/\.$/, ""),
    `räkenskapsår ${fiscalYearLabel(settings.fiscalYearStartMonth)}`,
    lastSettingsChange
      ? `ändrat ${when(lastSettingsChange.occurredAt).replace(/\.$/, "")} av ${lastSettingsChange.actor}`
      : null,
  ].filter(Boolean);

  return (
    <V2Page
      title="Inställningar"
      sub={
        <>
          {check?.ok ? <b>{check.title} </b> : null}
          {subParts.join(" · ")}.
        </>
      }
    >
      <SubNav />
      <div className="v2-stack">
        {issues && issues.length > 0 ? (
          <SettingsNotices notices={issues.map((i) => ({ kind: i.kind, text: i.text }))} />
        ) : null}

        <div className="v2-cols">
          <div className="v2-stack">
            <Card
              id="kortavgift"
              className="scroll-mt-24"
              title="Avgifter och moms"
              actions={
                <span className="lk tnum max-md:hidden">
                  Kortavgift {formatBp(settings.cardFeeBp)} · moms {formatBp(settings.vatRateBp)}
                </span>
              }
            >
              <span id="moms" className="sr-only" aria-hidden />
              <CardBody className="flex flex-col gap-4">
                {/* Mobil: formuläret är hopfällt med nuvarande värden på raden. */}
                <MobileFold
                  summary="Ändra"
                  meta={`Kortavgift ${formatBp(settings.cardFeeBp)} · moms ${formatBp(settings.vatRateBp)}`}
                >
                  <SettingsForm
                    key={`${settings.cardFeeBp}-${settings.vatRateBp}-${settings.fiscalYearStartMonth}-${settings.vatLimitOre}`}
                    cardFeeBp={settings.cardFeeBp}
                    vatRateBp={settings.vatRateBp}
                    fiscalYearStartMonth={settings.fiscalYearStartMonth}
                    vatLimitOre={settings.vatLimitOre}
                    cardFeeDefaultFrom={data.cardFeeDefaultFrom}
                    cardFeeRates={data.settings?.cardFeeRates ?? []}
                    today={ctx.today}
                  />
                </MobileFold>
                {vatAckValid(
                  settings.vatOkAt,
                  fiscalYearAround(ctx.today, settings.fiscalYearStartMonth).start,
                ) && settings.vatRateBp === 0 ? (
                  <VatAcknowledgedLine since={when(settings.vatOkAt!)} />
                ) : null}
              </CardBody>
            </Card>

            <Card
              id="foretaget"
              className="scroll-mt-24"
              title={companyGaps.length === 0 ? "Företaget" : "Företaget saknar uppgifter"}
            >
              <CardBody className="flex flex-col gap-4">
                <p className="st-p">
                  {companyGaps.length === 0
                    ? "Står i kontrakten och i butiksrapporten."
                    : `Tomt i kontrakten: ${companyGaps.join(", ")}.`}
                </p>
                <MobileFold
                  summary="Ändra"
                  meta={
                    companyGaps.length === 0
                      ? "Allt ifyllt"
                      : `${formatInt(companyGaps.length)} saknas`
                  }
                >
                  <CompanyForm
                    organizationName={ctx.organization.name}
                    initial={{
                      companyName: company.companyName ?? "",
                      orgNumber: company.orgNumber ?? "",
                      companyAddress: company.companyAddress ?? "",
                      contactName: company.contactName ?? "",
                      contactEmail: company.contactEmail ?? "",
                      contactPhone: company.contactPhone ?? "",
                      vatNumber: data.reportBasis.vatNumber ?? "",
                      reportVatMode: data.reportBasis.reportVatMode,
                      reportVmb: data.reportBasis.reportVmb,
                      reportOwnsMachines: data.reportBasis.reportOwnsMachines,
                    }}
                  />
                </MobileFold>
              </CardBody>
            </Card>

            {payoutSettings ? (
              <Card
                id="partneravtal"
                className="scroll-mt-24"
                title="Partneravtal"
                actions={
                  payoutSettings.agreements[0] ? (
                    <span className="lk">
                      {payoutSettings.agreements[0].partnerName} ·{" "}
                      {payoutSettings.agreements[0].profitShareBp / 100} %
                    </span>
                  ) : undefined
                }
              >
                <CardBody className="flex flex-col gap-4">
                  <p className="st-p">
                    Hur pengarna från Nayax delas under Pengar → Utbetalningar: partnern får
                    tillbaka inköpet och en andel av vinsten, resten är ditt.
                  </p>
                  <MobileFold
                    summary="Visa och ändra"
                    meta={payoutSettings.agreements[0]?.partnerName ?? "Inget avtal"}
                  >
                    <PartnerForm
                      agreements={payoutSettings.agreements}
                      vatReserveMode={payoutSettings.vatReserveMode}
                      reminderDays={payoutSettings.reminderDays}
                      payoutsFrom={payoutSettings.payoutsFrom}
                      refundsPaidVia={payoutSettings.refundsPaidVia}
                      today={ctx.today}
                    />
                  </MobileFold>
                </CardBody>
              </Card>
            ) : null}

            <Card
              id="agarandelar"
              className="scroll-mt-24"
              title="Ägarandelar"
              actions={
                currentGroup ? (
                  <span className="lk">Sedan {day(currentGroup.validFrom).replace(/\.$/, "")}</span>
                ) : undefined
              }
            >
              <CardBody className="flex flex-col gap-4">
                <p className="st-p">
                  <b>{currentGroup ? shareSummary(currentGroup) : "Inga ägarandelar inlagda."}</b>
                </p>
                <MobileFold summary="Visa och ändra" meta={formatInt(groups.length)}>
                  <div className="grid grid-cols-1 gap-x-8 gap-y-6 lg:grid-cols-2">
                    <div className="flex min-w-0 flex-col gap-3">
                      <SubLabel>Fördelningar</SubLabel>
                      {groups.length === 0 ? (
                        <p className="st-p">
                          Inga ägarandelar.{isOwner ? null : " Ägaren lägger in dem."}
                        </p>
                      ) : (
                        <ol className="flex flex-col gap-2">
                          {groups.map((g) => (
                            <li
                              key={g.validFrom}
                              className="flex flex-col gap-2 rounded-v2 border border-v2-line2 px-3 py-2.5"
                            >
                              <p className="flex flex-wrap items-center gap-2 text-v2-sm text-v2-mute tabular-nums">
                                <span>
                                  {day(g.validFrom)}
                                  {NBSP}
                                  {EN_DASH}
                                  {g.validTo ? `${NBSP}${day(g.validTo)}` : " tills vidare"}
                                </span>
                                {g.current ? <Badge tone="success">Gäller nu</Badge> : null}
                                {g.future ? <Badge tone="info">Kommande</Badge> : null}
                              </p>
                              <ul className="flex flex-col gap-1 text-v2-md">
                                {g.shares.map((s) => (
                                  <li
                                    key={s.id}
                                    className="flex items-baseline justify-between gap-4"
                                  >
                                    <span className="text-v2-ink">{s.holderName}</span>
                                    <span className="text-v2-ink tabular-nums">
                                      {formatBp(s.shareBp)}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                    <div className="flex min-w-0 flex-col gap-3">
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
                              (a, b) =>
                                Number(b.userId === ctx.user.id) - Number(a.userId === ctx.user.id),
                            )}
                          today={today}
                        />
                      ) : (
                        <p className="st-p">Bara ägaren ändrar ägarandelarna.</p>
                      )}
                    </div>
                  </div>
                </MobileFold>
              </CardBody>
            </Card>

            {customerDemos ? (
              <Card
                id="demo"
                className="scroll-mt-24"
                title="Demo för kunder"
                actions={
                  <span className="lk">
                    {customerDemos.length === 0
                      ? "Panelen utan era siffror"
                      : `${formatInt(customerDemos.length)} st`}
                  </span>
                }
              >
                <CardBody>
                  <MobileFold summary="Visa" meta={formatInt(customerDemos.length)}>
                    <CustomerDemos demos={customerDemos} />
                  </MobileFold>
                </CardBody>
              </Card>
            ) : null}
          </div>

          <div className="v2-stack">
            <Card title="Fler inställningar">
              <nav aria-label="Fler inställningar" className="flex flex-col">
                {[
                  {
                    href: "/installningar/anvandare",
                    label: "Användare",
                    sub: "Bjud in, byt roll, enkel vy",
                  },
                  { href: "/installningar/konto", label: "Mitt konto", sub: "Lösenord" },
                  {
                    href: "/installningar/kontroll",
                    label: "Kontroll",
                    sub: "Stämmer siffrorna?",
                  },
                ].map((l) => (
                  <Link key={l.href} href={l.href} className="st-link">
                    <span className="min-w-0">
                      {l.label}
                      <small>{l.sub}</small>
                    </span>
                    <span aria-hidden className="arr">
                      →
                    </span>
                  </Link>
                ))}
              </nav>
            </Card>

            <SubscriptionSection user={user} organizationId={ctx.organization.id} today={today} />

            <Card
              id="din-data"
              className="scroll-mt-24"
              title="Din data"
              actions={
                <span className="lk">
                  {exports[0]
                    ? `Senast ${when(exports[0].createdAt).replace(/\.$/, "")}`
                    : "Allt i en ZIP-fil"}
                </span>
              }
            >
              <CardBody className="flex flex-col gap-3">
                <p className="st-p">
                  Order, automater, butiker, titlar, priser, lager och avräkningar som CSV-filer.
                  Öppnas i Excel. Högst 3 gånger per timme.
                  {exports[0]?.createdBy ? ` Senast av ${exports[0].createdBy}.` : null}
                </p>
                {isOwnerRole ? (
                  <ExportDataButton />
                ) : (
                  <p className="st-p">Bara ägaren kan exportera all data.</p>
                )}
              </CardBody>
            </Card>

            <Card id="appen" className="scroll-mt-24" title="Appen">
              <CardBody className="flex flex-col gap-3">
                <p className="st-p">
                  Ser något gammalt ut? Hämtar senaste versionen och laddar om sidan. Fungerar även
                  för appen på hemskärmen.
                </p>
                <div>
                  <AppRefreshButton />
                </div>
              </CardBody>
            </Card>
          </div>
        </div>

        <FoldCard id="konton" title="Konton" aside={`${formatInt(data.accounts.length)} st`}>
          <Table
            caption="Bokföringskonton"
            rows={data.accounts}
            rowKey={(a) => a.id}
            empty="Inga bokföringskonton är inlagda."
            columns={[
              { key: "konto", header: "Konto", width: "96px", cell: (a) => a.basAccount },
              {
                key: "anv",
                header: "Används för",
                cell: (a) => (
                  <>
                    {accountUse(a.key)}
                    <span className="block text-v2-xs text-v2-mute md:hidden">{a.name}</span>
                  </>
                ),
              },
              {
                key: "bas",
                header: "Namn i BAS",
                hideOnPhone: true,
                cell: (a) => <span className="text-v2-mute">{a.name}</span>,
              },
            ]}
          />
        </FoldCard>

        <FoldCard id="andringslogg" title="Ändringslogg" aside={logAside(log, when)}>
          {log.length === 0 ? (
            <Empty title="Inga ändringar ännu." />
          ) : (
            <SettingsLog entries={log} timeZone={tz} now={ctx.now} />
          )}
        </FoldCard>
      </div>
    </V2Page>
  );
}
