import type { Metadata } from "next";
import Link from "next/link";

import { StatusTag } from "@/components/ui/status-tag";
import { Card, CardBody } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { noticeState, noticeTypesFor } from "@/server/alerts/notices";
import { FIELD_KINDS, KIND_LABEL, ALERT_KINDS } from "@/server/alerts/subscriptions";
import { WeeklySwitch } from "@/components/weekly/weekly-switch";
import { requireRoute } from "@/server/data/core";
import { withUserDb } from "@/server/session";
import { loadSalePushPref } from "@/server/sales-push/prefs";
import { loadWeeklyPref } from "@/server/weekly/prefs";

import { DriftFrame } from "../_components/drift-frame";
import { channelReach, reachAside } from "../_lib/channel-reach";
import { formatWhen, plural } from "../_lib/display";
import { loadAlertSettings } from "../_lib/load";
import { NoticesCard } from "./notices-card";
import { PushDevices, type DeviceRow } from "./push-devices";
import { SaleCard } from "./sale-card";
import { SettingsForm, type KindOption } from "./settings-form";

export const metadata: Metadata = { title: "Notiser" };

const KIND_HINT: Record<string, string> = {
  machine_offline: "Ovanligt lång tystnad.",
  machine_fault: "Felkod från automaten.",
  machine_suspected_fault: "Osannolik tystnad.",
  low_stock: "Räcker högst 2 dagar.",
  import_failed: "Import misslyckad.",
  day_anomaly: "Gårdagen avvek minst 30 %.",
  machine_discovered: "Awish har en automat utan butik.",
  self_check: "Daglig kontroll hittade fel.",
};

const DELIVERY_STATUS: Record<
  string,
  { status: "ok" | "warning" | "neutral" | "offline"; label: string }
> = {
  pending: { status: "neutral", label: "Väntar" },
  sent: { status: "ok", label: "Skickat" },
  partial: { status: "warning", label: "Delvis" },
  failed: { status: "warning", label: "Misslyckades" },
  skipped: { status: "offline", label: "Ej skickat" },
};

function shortAgent(ua: string | null): string {
  if (!ua) return "Okänd webbläsare";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Webbläsare";
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} på ${os}` : browser;
}

/**
 * Notiser (Drift → Notiser): inställningarna för larmen för den inloggade. Själva larmen står
 * på Status (/drift#larm-sektion). Här: vilka larm, för vilka automater, vilka tider och vilka
 * kanaler; push-enheter; senaste utskicken. Varje användare ställer in sina egna.
 */
export default async function AlertSettingsPage() {
  const ctx = await requireRoute("drift");
  const settings = await loadAlertSettings(ctx);
  const now = new Date(ctx.now);
  const sub = settings.subscription;
  const allowed = ctx.role === "refiller" ? FIELD_KINDS : ALERT_KINDS;
  const kinds: KindOption[] = allowed.map((k) => ({
    value: k,
    label: KIND_LABEL[k],
    hint: KIND_HINT[k] ?? "",
  }));
  const ch = settings.channels;
  const channelOptions = [
    {
      value: "push" as const,
      label: "Push",
      hint: !ch.push.configured
        ? "Inte påslaget än."
        : ch.push.kind === "outbox"
          ? "Lokalt läge: skrivs till disk, skickas inte."
          : `${plural(settings.devices.filter((d) => !d.disabledAt).length, "enhet", "enheter")} påslagna.`,
    },
    {
      value: "email" as const,
      label: "E-post",
      hint: !ch.email.canSend
        ? "Inte påslagen. Binderlab kan inte skicka e-post än."
        : ch.email.kind === "outbox"
          ? `Lokalt läge till ${ctx.user.email}.`
          : `Till ${ctx.user.email}.`,
    },
    {
      value: "sms" as const,
      label: "Sms",
      hint: ch.sms.configured
        ? "Lokalt läge: skrivs till disk, skickas inte."
        : "Ingen sms-leverantör vald.",
    },
  ];
  const activeKinds = sub.kinds === null ? allowed.length : sub.kinds.length;
  // Kanalerna som faktiskt når personen: push kräver en påslagen enhet, e-post en leverantör.
  const reach = channelReach({
    channels: sub.channels,
    devices: settings.devices.filter((d) => !d.disabledAt).length,
    hasPhone: sub.phone !== null,
    works: { email: ch.email.canSend, push: ch.push.configured, sms: ch.sms.configured },
  });
  const devices: DeviceRow[] = settings.devices.map((d) => ({
    id: d.id,
    endpoint: d.endpoint,
    label: shortAgent(d.userAgent),
    detail: d.disabledAt
      ? `Avstängd ${formatWhen(d.disabledAt, ctx.timeZone, now)}: push-tjänsten känner inte igen enheten.`
      : d.lastSuccessAt
        ? `Senaste push ${formatWhen(d.lastSuccessAt, ctx.timeZone, now)} · ${d.endpointHost}`
        : `Påslagen ${formatWhen(d.createdAt, ctx.timeZone, now)} · ${d.endpointHost}`,
    disabled: d.disabledAt !== null,
  }));

  // Notiser i mobilen: bara när push fungerar i miljön (annars syns inget om push).
  const pushReady = ch.push.configured && ch.push.publicKey !== null;
  const notices = noticeState(settings.saved ? sub : null, ctx.role);
  // Veckosammanfattningen (måndagens notis): bara ägare och admin får den.
  const weekly = ctx.canEdit
    ? await withUserDb((tx) => loadWeeklyPref(tx, ctx.organization.id, ctx.user.id))
    : null;

  // Notis vid varje försäljning: alla roller (påfyllaren utan belopp), var och en sin knapp.
  const sale = pushReady
    ? await withUserDb((tx) => loadSalePushPref(tx, ctx.organization.id, ctx.user.id))
    : null;

  const activeDevices = settings.devices.filter((d) => !d.disabledAt).length;

  return (
    <DriftFrame
      ctx={ctx}
      sub={
        <>
          <b>
            {!settings.saved
              ? "Du får inga notiser om larm ännu."
              : !sub.active
                ? "Notiserna är avstängda för dig."
                : reach.working.length === 0
                  ? "Du får inga larm utanför appen just nu."
                  : `Du får ${plural(activeKinds, "typ av larm", "typer av larm")}${sub.machineIds === null ? " för alla automater" : ` för ${plural(sub.machineIds.length, "automat", "automater")}`}.`}
          </b>
          {!settings.saved ? (
            <span>Slå på för att få veta när något händer.</span>
          ) : sub.active ? (
            <span>
              {reachAside(reach, sub.quietStart ? `${sub.quietStart}–${sub.quietEnd}` : null)}
            </span>
          ) : null}
        </>
      }
    >
      {pushReady || weekly ? (
        <div className="v2-cols">
          {pushReady ? (
            <NoticesCard
              publicKey={ch.push.publicKey}
              initialOn={notices.on}
              initialTypes={notices.types}
              types={noticeTypesFor(ctx.role).map((t) => ({ value: t.value, label: t.label }))}
              endpoints={settings.devices.filter((d) => !d.disabledAt).map((d) => d.endpoint)}
            />
          ) : (
            <div />
          )}
          <div className="v2-stack">
            {sale ? (
              <SaleCard
                initial={{
                  on: sale.on,
                  quiet: sale.quiet,
                  publicKey: ch.push.publicKey,
                  endpoints: sale.endpoints,
                  economy: ctx.canSeeEconomy,
                }}
              />
            ) : null}
            {pushReady && weekly ? (
              <section aria-label="Veckosammanfattning" className="v2-card">
                <div className="v2-card-body flex flex-col gap-3">
                  <WeeklySwitch
                    // Delad komponent: rubriken i kortets storlek (14 px halvfet).
                    className="[&_#vecka-knapp]:text-v2-md [&_#vecka-knapp]:font-[650]"
                    initial={{
                      on: weekly.on,
                      publicKey: ch.push.publicKey,
                      endpoints: weekly.endpoints,
                    }}
                  />
                  <Link href="/veckan" className="ops-link w-fit">
                    Visa förra veckan →
                  </Link>
                </div>
              </section>
            ) : null}
          </div>
        </div>
      ) : null}

      <details className="ops-more group" open={!pushReady}>
        <summary>Fler val</summary>
        <div className="v2-cols mt-3">
          <Card
            title={
              <span id="installningar" className="contents">
                Dina larm
              </span>
            }
            actions={<span className="text-v2-xs text-v2-mute">Gäller bara dig</span>}
          >
            <CardBody>
              <SettingsForm
                // Ny rad (t.ex. efter Notiser på/av) ger formuläret nya startvärden.
                key={JSON.stringify(sub)}
                initial={sub}
                kinds={kinds}
                machines={settings.machines.map((m) => ({
                  id: m.id,
                  label: `${m.code} ${m.name}`,
                }))}
                channels={channelOptions}
              />
            </CardBody>
          </Card>

          <div className="v2-stack">
            {pushReady ? (
              <Card title={`${plural(activeDevices, "enhet", "enheter")} med push`}>
                <CardBody>
                  <PushDevices
                    publicKey={ch.push.publicKey}
                    pushConfigured={ch.push.configured}
                    emailWorks={ch.email.canSend}
                    devices={devices}
                  />
                </CardBody>
              </Card>
            ) : null}

            <Card
              title={
                settings.deliveries.length === 0
                  ? "Inga larm skickade till dig"
                  : "Senaste utskicken"
              }
              count={settings.deliveries.length > 0 ? settings.deliveries.length : null}
            >
              {settings.deliveries.length > 0 ? (
                <ul className="ops-list">
                  {settings.deliveries.map((d) => (
                    <li key={d.id} className="flex flex-col gap-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-v2-sm font-[550] text-v2-ink">{d.subject}</span>
                        <StatusTag status={DELIVERY_STATUS[d.status]?.status ?? "neutral"}>
                          {DELIVERY_STATUS[d.status]?.label ?? d.status}
                        </StatusTag>
                      </div>
                      <span className="tnum text-v2-xs text-v2-mute">
                        {`${formatWhen(d.sendAt, ctx.timeZone, now)} · ${plural(d.items, "larm", "larm")}`}
                      </span>
                      {d.results.length > 0 ? (
                        <span className="text-v2-xs text-v2-mute">
                          {d.results
                            .map(
                              (r) =>
                                `${r.channel === "push" ? "Push" : r.channel === "email" ? "E-post" : r.channel === "sms" ? "Sms" : r.channel}: ${r.detail}`,
                            )
                            .join(" · ")}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty title="Inget skickat än.">Larm som går till dig visas här.</Empty>
              )}
            </Card>
          </div>
        </div>
      </details>
    </DriftFrame>
  );
}
