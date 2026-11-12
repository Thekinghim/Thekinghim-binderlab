import type { Metadata } from "next";
import Link from "next/link";
import type { CSSProperties } from "react";

import { Panel } from "@/components/ui/frame";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { formatDateTime } from "@/lib/format";
import { currentViewer } from "@/server/accounting";
import { requireRoute } from "@/server/data/core";
import { isDemoFor } from "@/server/demo/guard";
import {
  FORTNOX_ACCOUNT_KEYS,
  FORTNOX_ACCOUNTS,
  FORTNOX_KIND_INFO,
  FORTNOX_KINDS,
} from "@/server/fortnox/mapping";
import { loadFortnoxFor } from "@/server/fortnox/service";

import { MerHead } from "@/app/(app)/installningar/_components/mer-head";

import {
  ConnectButton,
  DisconnectButton,
  LiveSwitch,
  ReverseButton,
  RunNowButton,
  SettingsForm,
} from "./_components/fortnox-panel";
import { VoucherList } from "./_components/voucher-list";
import { heldVouchers, nextVouchers, outboxVouchers } from "./_lib/view";

export const metadata: Metadata = { title: "Fortnox" };
/** "Kör nu" (server action på sidan) anropar Fortnox. */
export const maxDuration = 300;

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Datakällor → Fortnox: koppla Fortnox en gång, välj startmånad, se exakt vilka verifikat
 * som skulle skickas (torrkörning) och slå sedan på. Bara ägare och admin (requireRoute
 * skickar andra vidare; tjänsten läser rollen ur databasen och spärrar Enkel vy).
 */
export default async function FortnoxPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireRoute("datakallor");
  const sp = await searchParams;
  const viewer = await currentViewer();
  const [view, demo] = await Promise.all([
    loadFortnoxFor(viewer),
    isDemoFor(viewer.user, viewer.organization.id),
  ]);
  const wrap =
    "mx-auto flex w-full max-w-[960px] flex-col gap-10 px-4 pt-8 pb-16 max-md:gap-8 md:px-8 md:pt-12";
  if (!view || demo) {
    return (
      <div className={wrap}>
        <MerHead eyebrow="Datakällor · Fortnox" title="Fortnox." />
        <StateMessage
          kind="empty"
          message={
            demo
              ? "Fortnox är avstängt i demon."
              : "Bara ägare och administratörer kan hantera Fortnox."
          }
        />
      </div>
    );
  }
  const c = view.connection;
  const notice = first(sp.fel)
    ? { tone: "bad" as const, text: String(first(sp.fel)).slice(0, 200) }
    : first(sp.kopplad)
      ? {
          tone: "good" as const,
          text:
            first(sp.kopplad) === "igen"
              ? "Fortnox är kopplat igen."
              : "Fortnox är kopplat. Inget skickas förrän du slår på.",
        }
      : null;
  const next = nextVouchers(view);
  const held = heldVouchers(view);
  const outbox = outboxVouchers(view, (id) => <ReverseButton id={id} />);
  const anySent = view.outbox.some((r) => r.state === "sent" || r.state === "sending");

  return (
    <div className={wrap}>
      <MerHead
        eyebrow="Datakällor · Fortnox"
        title={view.line.text}
        tone={view.line.tone === "ok" ? "good" : view.line.tone === "warn" ? "bad" : undefined}
        line={
          c?.companyName
            ? `Kopplat till ${c.companyName}.`
            : c
              ? "Kopplat."
              : "Bokföringen skickas till Fortnox av sig själv när det är kopplat."
        }
      />

      {notice ? (
        <p
          role="status"
          data-fortnox-notice={notice.tone}
          className={
            notice.tone === "bad"
              ? "rounded-md border border-signal-line p-3 text-base text-signal-fg"
              : "rounded-md border border-line p-3 text-base text-fg"
          }
        >
          {notice.text}
        </p>
      ) : null}

      {!c ? (
        <section className="rise flex flex-col gap-5" style={{ "--i": 1 } as CSSProperties}>
          <SectionHeader title="Koppla." aside="Görs en gång." />
          <ol className="flex list-decimal flex-col gap-2 pl-5 text-base text-muted">
            <li>Tryck på Koppla Fortnox och logga in hos Fortnox som administratör.</li>
            <li>Godkänn att Binderlab får bokföra.</li>
            <li>Du kommer tillbaka hit. Inget skickas förrän du har sett listan och slagit på.</li>
          </ol>
          {view.configProblem ? (
            <p className="text-base text-signal-fg">{view.configProblem}</p>
          ) : null}
          <div>
            <ConnectButton label="Koppla Fortnox" disabled={Boolean(view.configProblem)} />
          </div>
        </section>
      ) : (
        <>
          {c.status === "needs_reconnect" ? (
            <section className="rise flex flex-col gap-4" style={{ "--i": 1 } as CSSProperties}>
              <SectionHeader
                title="Koppla igen."
                aside="Inget går förlorat och inget bokförs dubbelt."
              />
              <div>
                <ConnectButton label="Koppla Fortnox igen" disabled={Boolean(view.configProblem)} />
              </div>
            </section>
          ) : null}

          <section
            aria-labelledby="fortnox-lage"
            className="rise flex flex-col gap-5"
            style={{ "--i": 2 } as CSSProperties}
          >
            <SectionHeader
              id="fortnox-lage"
              title={c.live ? "Fortnox är på." : "Torrkörning."}
              aside={
                c.live
                  ? "Verifikaten skickas varje natt."
                  : "Inget skickas. Listan visar vad som skulle skickas."
              }
            />
            {view.lastRunAt ? (
              <p className="meta text-subtle">
                Senaste körning {formatDateTime(new Date(view.lastRunAt))}
                {view.lastError ? ` · ${view.lastError}` : ""}
              </p>
            ) : null}
            <div className="flex flex-wrap items-start gap-3">
              <LiveSwitch
                live={c.live}
                canGoLive={c.status === "connected" && Boolean(c.startMonth) && !view.configProblem}
              />
              <RunNowButton live={c.live} />
            </div>
          </section>

          <section
            aria-labelledby="fortnox-nasta"
            className="rise flex flex-col gap-5"
            style={{ "--i": 3 } as CSSProperties}
          >
            <SectionHeader
              id="fortnox-nasta"
              title={c.live ? "Skickas i natt." : "Det här skulle skickas."}
              aside={`${next.length} verifikat.`}
            />
            <VoucherList
              label="Verifikat som skickas härnäst"
              vouchers={next}
              empty={
                c.startMonth
                  ? "Inget att skicka just nu."
                  : "Välj först från vilken månad det ska bokföras (nedan)."
              }
            />
            {held.length > 0 ? (
              <>
                <h3 className="label text-subtle">Väntar på något</h3>
                <VoucherList label="Verifikat som väntar" vouchers={held} empty="" />
              </>
            ) : null}
          </section>

          <section
            aria-labelledby="fortnox-installningar"
            className="rise flex flex-col gap-5"
            style={{ "--i": 4 } as CSSProperties}
          >
            <SectionHeader id="fortnox-installningar" title="Inställningar." />
            <Panel>
              <SettingsForm
                startLocked={anySent}
                initial={{
                  startMonth: c.startMonth ?? view.suggestedStartMonth,
                  series: c.series,
                  accounts: Object.fromEntries(
                    FORTNOX_ACCOUNT_KEYS.map((k) => [k, c.mapping.accounts[k] ?? ""]),
                  ),
                  kinds: { ...c.mapping.kinds },
                }}
                accounts={FORTNOX_ACCOUNT_KEYS.map((k) => ({
                  key: k,
                  use: FORTNOX_ACCOUNTS[k].use,
                  name: FORTNOX_ACCOUNTS[k].name,
                  proposal: FORTNOX_ACCOUNTS[k].account,
                }))}
                kinds={FORTNOX_KINDS.map((k) => ({
                  key: k,
                  label: FORTNOX_KIND_INFO[k].label,
                  help: FORTNOX_KIND_INFO[k].help,
                }))}
              />
            </Panel>
          </section>

          <section
            aria-labelledby="fortnox-skickat"
            className="rise flex flex-col gap-5"
            style={{ "--i": 5 } as CSSProperties}
          >
            <SectionHeader
              id="fortnox-skickat"
              title="Skickat."
              aside={`${view.outbox.filter((r) => r.state === "sent").length} verifikat i Fortnox.`}
            />
            <VoucherList
              label="Verifikat i utkorgen"
              vouchers={outbox}
              empty="Inget är skickat än."
            />
          </section>

          <section className="flex flex-col gap-3">
            <DisconnectButton />
            <p className="text-sm text-muted">
              Listan över det som är skickat ligger kvar. Verifikat i Fortnox tas inte bort.
            </p>
          </section>
        </>
      )}

      <p className="text-sm text-muted">
        <Link
          href="/ekonomi?vy=bokforing"
          className="text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg max-md:tap"
        >
          Till Bokföring →
        </Link>
      </p>
    </div>
  );
}
