import type { Metadata } from "next";

import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag } from "@/components/ui/status-tag";
import { payoutDueDate, STATE_LABEL } from "@/server/settlements/model";
import { requirePortalContext } from "@/server/portal/session";
import { loadPortalMoney, type PortalContract } from "@/server/portal/settlements";

import { dateText, kr, monthText } from "../_components/text";

export const metadata: Metadata = { title: "Avräkning" };

const link = "text-sm text-muted underline-offset-4 hover:text-fg hover:underline";

function contractStatus(c: PortalContract): string {
  if (c.terminatedOn) return `Uppsagt, slutar ${dateText(c.terminatedOn)}`;
  if (c.signedAt) {
    const who = c.signerName ? ` av ${c.signerName}` : "";
    return `Signerat ${dateText(c.signedAt.slice(0, 10))}${who}`;
  }
  return "Inte signerat än";
}

/**
 * Butikens pengar: avräkningen per månad (belopp, betald eller inte, PDF) och avtalet.
 * Allt via portal_settlements och portal_contracts (bara den egna butiken).
 */
export default async function PortalMoneyPage() {
  const ctx = await requirePortalContext();
  const { settlements, contracts } = await loadPortalMoney(ctx);
  const unpaid = settlements.filter((s) => s.state === "unpaid");
  const toCome = unpaid.reduce((n, s) => n + s.amountOre, 0);
  const latest = settlements[0];

  return (
    <div className="flex flex-col gap-10 py-10 md:py-12">
      <SectionHeader
        as="h1"
        index={1}
        eyebrow="Avräkning"
        size="xl"
        title={
          unpaid.length > 0
            ? `${kr(toCome)} på väg till er.`
            : latest
              ? "Allt är utbetalt."
              : "Ingen avräkning än."
        }
        aside={
          unpaid.length > 0
            ? `Betalas senast ${dateText(payoutDueDate(unpaid[unpaid.length - 1]!.month))}.`
            : latest
              ? `Senaste: ${monthText(latest.month)}.`
              : "Första avräkningen kommer den 1:a nästa månad."
        }
      />

      {settlements.length === 0 ? (
        <StateMessage
          kind="empty"
          message="Ingen avräkning än."
          detail="Översikten visar er andel löpande."
          action={{ label: "Till översikten", href: "/portal" }}
        />
      ) : (
        <ul className="flex flex-col border-t border-line-strong" aria-label="Avräkningar">
          {settlements.map((s, i) => (
            <li
              key={s.id}
              className="rise flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line py-4"
              style={{ "--i": Math.min(i, 8) } as React.CSSProperties}
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-md text-fg">{monthText(s.month)}</span>
                <span className="meta text-subtle">
                  {s.state === "paid" && s.paidOn
                    ? `Betald ${dateText(s.paidOn)}`
                    : s.state === "unpaid"
                      ? `Senast ${dateText(payoutDueDate(s.month))}`
                      : (s.statement?.modelText ?? "")}
                </span>
              </div>
              <div className="flex items-center gap-4">
                <span className="tnum text-lg text-fg">{kr(Math.abs(s.amountOre))}</span>
                <StatusTag status={s.state === "unpaid" || s.state === "owed" ? "warning" : "ok"}>
                  {s.state === "owed" ? "Ni betalar" : STATE_LABEL[s.state]}
                </StatusTag>
                <a href={`/portal/avrakning/${s.id}`} className={link} download>
                  PDF
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}

      <section aria-labelledby="ert-avtal" className="flex flex-col gap-4">
        <h2 id="ert-avtal" className="label text-subtle">
          Ert avtal
        </h2>
        {contracts.length === 0 ? (
          <p className="text-base text-muted">Inget avtal finns här än.</p>
        ) : (
          <ul className="flex flex-col border-t border-line">
            {contracts.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line py-3"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-fg">{c.title ?? "Placeringsavtal"}</span>
                  <span className="meta text-subtle">
                    Från {dateText(c.validFrom)} · {contractStatus(c)}
                  </span>
                </div>
                {c.hasFile ? (
                  <a href={`/portal/avtal/${c.id}`} className={link} download>
                    Ladda ner
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
