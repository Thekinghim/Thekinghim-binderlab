import Link from "next/link";
import type { CSSProperties } from "react";

import { StatusTag } from "@/components/ui/status-tag";
import { formatSek } from "@/lib/format";
import type { Viewer } from "@/server/data/core/loaders";
import { payoutDueDate, STATE_LABEL } from "@/server/settlements/model";
import { loadSettlementPageFor, type SettlementRow } from "@/server/settlements/service";

import {
  CreateSettlementsButton,
  InviteStoreButton,
  MarkPaidButton,
  RecomputeButton,
  UndoPaidButton,
} from "./settlement-actions";
import { MoneyCount } from "./money-count";
import { settlementIdleHeadline } from "../_lib/settlement-headline";

const kr = (ore: number) => formatSek(ore / 100);
const rise = (i: number) => ({ "--i": i }) as CSSProperties;

const MONTHS = [
  "januari",
  "februari",
  "mars",
  "april",
  "maj",
  "juni",
  "juli",
  "augusti",
  "september",
  "oktober",
  "november",
  "december",
];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const dayLabel = (d: string) =>
  `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]!.slice(0, 3)}.`;

/**
 * Butiker → Butiksportal: överst summan att betala ut, sedan avräkningarna (betala med en
 * knapp) och butikernas tillgång till portalen (bjud in med en knapp).
 */
export async function SettlementsView({ viewer, today }: { viewer: Viewer; today: string }) {
  const page = await loadSettlementPageFor(viewer);
  // Obetalda har beloppet räknat nu. En som inte kan räknas (t.ex. saknat inköpspris)
  // räknas inte in i summan och kan inte betalas.
  const unpaid = page.rows.filter((r) => r.state === "unpaid" && !r.blocked);
  const blocked = page.rows.filter((r) => r.blocked);
  const toPay = unpaid.reduce((n, r) => n + r.amountOre, 0);
  const unpaidStores = new Set(unpaid.map((r) => r.storeId)).size;
  const firstDue = unpaid.length ? unpaid.map((r) => payoutDueDate(r.month)).sort()[0]! : null;
  const late = firstDue !== null && firstDue < today;
  const idle = settlementIdleHeadline({
    blocked: blocked.length,
    failed: page.failed.length,
    missing: page.missing.length,
    monthLabel: monthLabel(page.month),
  });
  const byMonth = new Map<string, SettlementRow[]>();
  for (const r of page.rows) {
    const list = byMonth.get(r.month);
    if (list) list.push(r);
    else byMonth.set(r.month, [r]);
  }

  return (
    <div className="mx-auto flex w-full max-w-[960px] flex-col gap-10 px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <header className="rise flex flex-col gap-3" style={rise(0)}>
        <p className="label text-subtle">Att betala till butikerna</p>
        <h1 className="text-3xl font-medium md:text-4xl">
          {unpaid.length === 0 ? idle.title : <MoneyCount ore={toPay} id="avrakning-att-betala" />}
        </h1>
        <p className={`text-base ${late ? "text-signal-fg" : "text-muted"}`}>
          {unpaid.length === 0
            ? idle.aside
            : `${unpaidStores === 1 ? "1 butik" : `${unpaidStores} butiker`} · ${late ? "försenad, skulle betalats" : "senast"} ${dayLabel(firstDue!)}`}
        </p>
      </header>

      {page.failed.length > 0 ? (
        <section className="rise flex flex-col gap-2" style={rise(1)} aria-label="Kan inte räknas">
          {page.failed.map((f) => (
            <p
              key={f.storeId}
              className="rounded-md border border-signal-line px-4 py-3 text-base text-fg"
            >
              {f.storeName}: kan inte räknas. {f.message}{" "}
              <Link href="/inkopspriser" className="underline underline-offset-4">
                Inköpspriser →
              </Link>
            </p>
          ))}
        </section>
      ) : null}

      {page.missing.length > 0 ? (
        <section
          className="rise flex flex-wrap items-center justify-between gap-3 rounded-md border border-line px-4 py-3"
          style={rise(1)}
          aria-label="Saknas"
        >
          <p className="text-base text-fg">
            {page.missing.length === 1
              ? `${page.missing[0]!.storeName}: ${monthLabel(page.month)} saknar avräkning.`
              : `${page.missing.length} butiker saknar avräkning för ${monthLabel(page.month)}.`}
          </p>
          {page.canEdit ? <CreateSettlementsButton count={page.missing.length} /> : null}
        </section>
      ) : null}

      <section className="rise flex flex-col gap-6" style={rise(2)} aria-label="Avräkningar">
        {page.rows.length === 0 ? (
          page.missing.length > 0 ? null : (
            <p className="text-base text-muted">Ingen avräkning än.</p>
          )
        ) : (
          [...byMonth.entries()].map(([month, rows]) => (
            <div key={month} className="flex flex-col gap-2" id={`avrakning-${month}`}>
              <h2 className="label text-subtle">{monthLabel(month)}</h2>
              <ul className="flex flex-col border-t border-line">
                {rows.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line py-3"
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-md text-fg">{r.storeName}</span>
                      <span className="meta truncate text-subtle">
                        {r.state === "paid" && r.paidOn
                          ? `Betald ${dayLabel(r.paidOn)}`
                          : (r.statement?.modelText ?? "")}
                      </span>
                      {r.blocked ? (
                        <span className="text-sm text-signal-fg">
                          Kan inte räknas: {r.blocked}{" "}
                          <Link href="/inkopspriser" className="underline underline-offset-4">
                            Inköpspriser →
                          </Link>
                        </span>
                      ) : !r.paidOn && r.storedAmountOre !== r.amountOre ? (
                        <span className="meta text-subtle">
                          Nytt belopp, var {kr(Math.abs(r.storedAmountOre))}
                        </span>
                      ) : null}
                      {r.statement && r.statement.steps.length > 0 ? (
                        <details className="group text-sm">
                          <summary className="cursor-pointer list-none text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
                            Så räknas det
                          </summary>
                          <dl className="fade-in mt-2 flex flex-col gap-1">
                            {r.statement.steps.map((s, i) => (
                              <div key={i} className="flex justify-between gap-4">
                                <dt className="min-w-0 text-muted">{s.label}</dt>
                                <dd className="tnum shrink-0 text-fg">{kr(s.amountOre)}</dd>
                              </div>
                            ))}
                          </dl>
                        </details>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="tnum text-lg text-fg">
                        {r.blocked ? "–" : kr(Math.abs(r.amountOre))}
                      </span>
                      <StatusTag
                        status={
                          r.blocked
                            ? "critical"
                            : r.state === "unpaid" || r.state === "owed"
                              ? "warning"
                              : "ok"
                        }
                      >
                        {r.blocked ? "Inte klar" : STATE_LABEL[r.state]}
                      </StatusTag>
                      <a
                        href={`/butiker/avrakning/${r.id}`}
                        className="text-sm text-muted underline-offset-4 hover:text-fg hover:underline"
                      >
                        PDF
                      </a>
                      {page.canEdit && !r.blocked && r.storedAmountOre !== r.amountOre ? (
                        <RecomputeButton id={r.id} />
                      ) : null}
                      {page.canEdit &&
                      !r.blocked &&
                      (r.state === "unpaid" || r.state === "owed") ? (
                        <>
                          <MarkPaidButton
                            id={r.id}
                            storeName={r.storeName}
                            amountOre={r.amountOre}
                            monthLabel={monthLabel(r.month)}
                            today={today}
                          />
                        </>
                      ) : null}
                      {page.canEdit && r.state === "paid" ? (
                        <UndoPaidButton id={r.id} storeName={r.storeName} />
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      {page.portal ? (
        <section className="rise flex flex-col gap-3" style={rise(3)} aria-labelledby="portal">
          <h2 id="portal" className="label text-subtle">
            Butiksportal
          </h2>
          <ul className="flex flex-col border-t border-line">
            {page.portal.map((p) => (
              <li
                key={p.storeId}
                className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line py-3"
              >
                <span className="min-w-0 truncate text-fg">{p.storeName}</span>
                <div className="flex items-center gap-3">
                  {p.users > 0 ? (
                    <StatusTag status="ok">Inne</StatusTag>
                  ) : p.pending > 0 ? (
                    <StatusTag status="neutral">Inbjuden</StatusTag>
                  ) : (
                    <StatusTag status="warning">Inte inbjuden</StatusTag>
                  )}
                  {p.users === 0 ? (
                    <InviteStoreButton
                      storeId={p.storeId}
                      storeName={p.storeName}
                      email={p.email}
                      again={p.pending > 0}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
