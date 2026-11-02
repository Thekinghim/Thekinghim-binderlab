import type { Metadata } from "next";
import Link from "next/link";

import { wallClockIn } from "@/components/shell/period-state";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { EN_DASH, NBSP, formatDate, formatInt } from "@/lib/format";
import { requireRoute } from "@/server/data/core";
import { requireUser } from "@/server/session";

import { OwnerSharesForm } from "./_components/owner-shares-form";
import { SettingsForm } from "./_components/settings-form";
import { SettingsLog } from "./_components/settings-log";
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

function SubLabel({ index, children }: { index: string; children: string }) {
  return (
    <h3 className="label flex items-center gap-2 text-subtle">
      <span className="tnum text-fg">{index}</span>
      <span aria-hidden className="text-faint">
        /
      </span>
      <span>{children}</span>
    </h3>
  );
}

/**
 * Inställningar: kortavgift, momssats och räkenskapsår, ägarandelar, bokföringskonton och
 * ändringsloggen. Ägare och admin (requireRoute skickar andra till sin startsida); bara
 * ägaren ändrar ägarandelarna. Data läses under RLS efter en rollkontroll mot databasen.
 */
export default async function SettingsPage() {
  const ctx = await requireRoute("installningar");
  const user = await requireUser();
  const data = await loadSettingsPageFor(user, ctx.organization.id);

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

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-8 pb-16 md:gap-16 md:px-8 md:pt-12">
      <SectionHeader
        as="h1"
        size="xl"
        eyebrow="Inställningar"
        title={headline.title}
        aside={headline.aside}
        meta={[
          { label: "Organisation", value: ctx.organization.name },
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
        className="grid grid-cols-1 gap-x-8 sm:grid-cols-2 lg:grid-cols-12"
      >
        {[
          {
            href: "/installningar/anvandare",
            label: "Användare",
            text: "Vem som har tillgång och med vilken roll. Bjud in delägare och påfyllare.",
          },
          {
            href: "/datakallor",
            label: "Datakällor",
            text: "Varifrån orderna kommer, import av Awish orderlista och koppling av automater.",
          },
        ].map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="group flex flex-col gap-1.5 border-t border-line py-4 lg:col-span-4"
          >
            <span className="flex items-center justify-between gap-3 text-md text-fg">
              {l.label}
              <span aria-hidden className="text-faint transition-colors group-hover:text-fg">
                →
              </span>
            </span>
            <span className="text-sm text-muted">{l.text}</span>
          </Link>
        ))}
      </nav>

      <section aria-labelledby="avgifter" className="flex flex-col gap-8">
        <SectionHeader
          id="avgifter"
          index={1}
          eyebrow="Avgifter och moms"
          title="Det som dras från varje order."
          aside={
            settings.vatRateBp === 0
              ? "Momsen är 0 eftersom bolaget inte är momsregistrerat."
              : `Moms ${formatBp(settings.vatRateBp)} räknas ur det betalda beloppet.`
          }
        />
        <div className="grid grid-cols-1 gap-x-8 gap-y-10 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <SettingsForm
              key={`${settings.cardFeeBp}-${settings.vatRateBp}-${settings.fiscalYearStartMonth}`}
              cardFeeBp={settings.cardFeeBp}
              vatRateBp={settings.vatRateBp}
              fiscalYearStartMonth={settings.fiscalYearStartMonth}
            />
          </div>
          <dl className="flex flex-col text-sm lg:col-span-5">
            {[
              [
                "Intäkt",
                "Betalt belopp minus moms. Med moms 0 är intäkten hela det betalda beloppet.",
              ],
              [
                "Kortavgift",
                "Räknas per order på beloppet inklusive moms och avrundas till hela öre.",
              ],
              ["Provision", "Räknas alltid på beloppet exklusive moms, enligt butikens avtal."],
            ].map(([term, text]) => (
              <div
                key={term}
                className="flex flex-col gap-1 border-t border-line py-3 last:border-b"
              >
                <dt className="label text-fg">{term}</dt>
                <dd className="text-muted">{text}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section aria-labelledby="agarandelar" className="flex flex-col gap-8">
        <SectionHeader
          id="agarandelar"
          index={2}
          eyebrow="Ägarandelar"
          title={currentGroup ? shareSummary(currentGroup) : "Inga ägarandelar inlagda."}
          aside={
            currentGroup
              ? `Gäller sedan ${day(currentGroup.validFrom)}. Vinsten fördelas efter andelarna i delägarrapporten.`
              : "Vinsten kan inte fördelas i delägarrapporten förrän andelarna finns."
          }
        />
        <div className="grid grid-cols-1 gap-x-8 gap-y-10 lg:grid-cols-12">
          <div className="flex min-w-0 flex-col gap-4 lg:col-span-7">
            <SubLabel index="02.1">Fördelningar</SubLabel>
            {groups.length === 0 ? (
              <StateMessage
                kind="empty"
                compact
                message="Inga ägarandelar är inlagda."
                detail={isOwner ? undefined : "Ägaren lägger in andelarna."}
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
            <SubLabel index="02.2">Ny fördelning</SubLabel>
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
              <StateMessage
                kind="denied"
                compact
                message="Bara ägaren ändrar ägarandelarna."
                detail="Admin kan se fördelningen men inte ändra den."
              />
            )}
          </div>
        </div>
      </section>

      <section aria-labelledby="konton" className="flex flex-col gap-8">
        <SectionHeader
          id="konton"
          index={3}
          eyebrow="Bokföringskonton"
          title={`${formatInt(data.accounts.length)} konton enligt BAS.`}
          aside="Används i bokföringsunderlaget och SIE-filen till revisorn."
        />
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
      </section>

      <section aria-labelledby="andringslogg" className="flex flex-col gap-8">
        <SectionHeader
          id="andringslogg"
          index={4}
          eyebrow="Ändringslogg"
          title="Vem ändrade vad."
          aside={logAside(log, when)}
        />
        {log.length === 0 ? (
          <StateMessage kind="empty" compact message="Inga ändringar av inställningarna ännu." />
        ) : (
          <SettingsLog entries={log} timeZone={tz} now={ctx.now} />
        )}
      </section>
    </div>
  );
}
