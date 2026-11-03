import type { Metadata } from "next";

import { Panel, PanelSection } from "@/components/ui/frame";
import { SectionHeader } from "@/components/ui/section-header";
import { StatusTag } from "@/components/ui/status-tag";
import { formatInt } from "@/lib/format";
import { FIELD_KINDS, KIND_LABEL, ALERT_KINDS } from "@/server/alerts/subscriptions";
import { requireRoute } from "@/server/data/core";

import { formatWhen, plural } from "../_lib/display";
import { loadAlertSettings } from "../_lib/load";
import { PushDevices, type DeviceRow } from "./push-devices";
import { SettingsForm, type KindOption } from "./settings-form";

export const metadata: Metadata = { title: "Larminställningar" };

const KIND_HINT: Record<string, string> = {
  machine_offline: "Ovanligt lång tystnad.",
  machine_fault: "Felkod från automaten.",
  machine_suspected_fault: "Osannolik tystnad.",
  low_stock: "Räcker högst 2 dagar.",
  import_failed: "Import misslyckad.",
  day_anomaly: "Gårdagen avvek minst 30 %.",
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
 * Larminställningar för den inloggade: vilka larm, för vilka automater, vilka tider och vilka
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
        ? "Inte konfigurerad i den här miljön."
        : ch.push.kind === "outbox"
          ? "Lokalt läge: skrivs till disk, skickas inte."
          : `${plural(settings.devices.filter((d) => !d.disabledAt).length, "enhet", "enheter")} påslagna.`,
    },
    {
      value: "email" as const,
      label: "E-post",
      hint: !ch.email.configured
        ? "Inte konfigurerad i den här miljön."
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

  return (
    <div className="flex flex-col gap-10">
      <div className="rise" style={{ "--i": 0 } as React.CSSProperties}>
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow="Larminställningar"
          title={
            !settings.saved
              ? "Du får inga larm ännu."
              : !sub.active
                ? "Larmen är avstängda för dig."
                : `Du får ${plural(activeKinds, "typ av larm", "typer av larm")}${sub.machineIds === null ? " för alla automater" : ` för ${plural(sub.machineIds.length, "automat", "automater")}`}.`
          }
          aside={
            !settings.saved
              ? "Spara för att börja få larm."
              : `Via ${sub.channels.map((c) => (c === "push" ? "push" : c === "email" ? "e-post" : "sms")).join(" och ")}${sub.quietStart ? `, tyst ${sub.quietStart}–${sub.quietEnd}` : ""}.`
          }
        />
      </div>

      <div
        className="rise grid gap-12 lg:grid-cols-12 lg:gap-8"
        style={{ "--i": 1 } as React.CSSProperties}
      >
        <section aria-labelledby="installningar" className="flex flex-col gap-6 lg:col-span-7">
          <SectionHeader id="installningar" title="Dina larm." size="md" aside="Gäller bara dig." />
          <SettingsForm
            initial={sub}
            kinds={kinds}
            machines={settings.machines.map((m) => ({ id: m.id, label: `${m.code} ${m.name}` }))}
            channels={channelOptions}
          />
        </section>

        <div className="flex flex-col gap-12 lg:col-span-5">
          <section aria-labelledby="enheter" className="flex flex-col gap-6">
            <SectionHeader
              id="enheter"
              title={`${plural(settings.devices.filter((d) => !d.disabledAt).length, "enhet", "enheter")} med push.`}
              size="md"
            />
            <PushDevices
              publicKey={ch.push.publicKey}
              pushConfigured={ch.push.configured}
              devices={devices}
            />
          </section>

          <section aria-labelledby="utskick" className="flex flex-col gap-6">
            <SectionHeader
              id="utskick"
              title={
                settings.deliveries.length === 0
                  ? "Inga larm skickade till dig."
                  : `${plural(settings.deliveries.length, "utskick", "utskick")} senast.`
              }
              size="md"
            />
            {settings.deliveries.length > 0 ? (
              <Panel>
                <PanelSection label="Senaste" meta={formatInt(settings.deliveries.length)}>
                  <ul className="flex flex-col divide-y divide-line">
                    {settings.deliveries.map((d) => (
                      <li key={d.id} className="flex flex-col gap-1 py-3">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-sm text-fg">{d.subject}</span>
                          <StatusTag status={DELIVERY_STATUS[d.status]?.status ?? "neutral"}>
                            {DELIVERY_STATUS[d.status]?.label ?? d.status}
                          </StatusTag>
                        </div>
                        <span className="meta text-subtle">
                          {`${formatWhen(d.sendAt, ctx.timeZone, now)} · ${plural(d.items, "larm", "larm")}`}
                        </span>
                        {d.results.length > 0 ? (
                          <span className="text-xs text-muted">
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
                </PanelSection>
              </Panel>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}
