import type { Metadata } from "next";
import Link from "next/link";
import { Suspense, type CSSProperties } from "react";

import { StatusTag, type Status } from "@/components/ui/status-tag";
import { formatInt, formatSek } from "@/lib/format";
import { businessDateOf } from "@/import/zoned";
import { CAMPAIGN_STATE_LABEL, type CampaignState } from "@/server/campaigns/model";
import {
  loadCampaignPageFor,
  loadCampaignStatsFor,
  type CampaignView,
} from "@/server/campaigns/service";
import { requireRoute, requireViewer } from "@/server/data/core";
import type { Viewer } from "@/server/data/core/loaders";
import { REASON_LABEL, shareText } from "@/server/free-packs/model";
import { loadFreePackPageFor } from "@/server/free-packs/service";

import { pickView } from "../rapporter/_components/view-tabs";

import { BigNumber } from "./_components/big-number";
import { CampaignActions, CampaignComposer } from "./_components/campaigns";
import { FreePackGiver, ShowCodesButton } from "./_components/free-packs";
import { addDaysIso, dayLabel } from "./_lib/display";

export const metadata: Metadata = { title: "Kampanjer" };

type SearchParams = Record<string, string | string[] | undefined>;

const VIEWS = ["kampanjer", "gratis-pack"] as const;
const rise = (i: number) => ({ "--i": i }) as CSSProperties;
const kr = (ore: number) => formatSek(ore / 100);

const STATE_TONE: Record<CampaignState, Status> = {
  live: "ok",
  partial: "warning",
  scheduled: "neutral",
  failed: "critical",
  ended: "neutral",
  stopped: "neutral",
};

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Kampanjer (Automater → Kampanjer och Gratis-pack). Överst en stor siffra, under det vad
 * som ska göras: förslag, kampanjerna som visas och de senaste gratis-packen. Ägare, admin
 * och läsare ser; bara ägare och admin skapar och stänger av.
 */
export default async function KampanjerPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const [ctx, sp] = await Promise.all([requireRoute("kampanjer"), searchParams]);
  const viewer = await requireViewer();
  const view = pickView(sp.vy, VIEWS);
  return (
    <div className="mx-auto flex w-full max-w-[960px] flex-col gap-10 px-4 pt-8 pb-16 md:px-8 md:pt-12">
      {view === "kampanjer" ? (
        <CampaignsView
          viewer={viewer}
          canEdit={ctx.canEdit}
          today={ctx.today}
          timeZone={ctx.timeZone}
        />
      ) : (
        <FreePacksView
          viewer={viewer}
          today={ctx.today}
          initialMachineId={one(sp.automat) ?? null}
          initialReason={one(sp.skal) ?? null}
        />
      )}
    </div>
  );
}

function NotConnected() {
  return (
    <p className="rounded-md border border-line-strong bg-raised px-4 py-3 text-base">
      Koppla Awish först.{" "}
      <Link href="/datakallor" className="underline underline-offset-4">
        Datakällor →
      </Link>
    </p>
  );
}

async function CampaignsView({
  viewer,
  canEdit,
  today,
  timeZone,
}: {
  viewer: Viewer;
  canEdit: boolean;
  today: string;
  timeZone: string;
}) {
  const data = await loadCampaignPageFor(viewer);
  const live = data.current.filter((c) => c.state === "live" || c.state === "partial");
  const liveMachines = new Set(
    live.flatMap((c) => c.machines.filter((m) => m.status === "shown").map((m) => m.machineId)),
  );
  const lastDay = (c: CampaignView) =>
    businessDateOf(new Date(new Date(c.endsAt).getTime() - 1000), timeZone);
  const firstDay = (c: CampaignView) => businessDateOf(new Date(c.startsAt), timeZone);

  return (
    <>
      <header className="rise flex flex-col gap-4" style={rise(0)}>
        <p className="label text-subtle">Kampanjer på skärmen</p>
        <h1 className="text-3xl font-medium md:text-4xl">
          {live.length === 0 ? (
            "Ingen kampanj visas nu."
          ) : (
            <>
              <BigNumber value={live.length} id="kampanjer-live" />{" "}
              {live.length === 1 ? "kampanj visas" : "kampanjer visas"} nu.
            </>
          )}
        </h1>
        <p className="text-base text-muted">
          {data.linked.length === 0
            ? "Ingen automat är kopplad till Awish."
            : `På ${formatInt(liveMachines.size)} av ${formatInt(data.linked.length)} automater.`}
        </p>
        {!data.connected ? <NotConnected /> : null}
        <div className="flex flex-col items-start gap-3">
          <CampaignComposer
            machines={data.linked.map((m) => ({
              machineId: m.machineId,
              code: m.code,
              name: m.name,
            }))}
            suggestions={data.suggestions.map((s) => ({
              titleId: s.titleId,
              text: s.text,
              titleName: s.titleName,
              machineIds: s.machineIds,
              sinceLabel: dayLabel(s.since, today),
            }))}
            library={data.library}
            today={today}
            canEdit={canEdit && data.connected && data.linked.length > 0}
          />
        </div>
      </header>

      {data.current.length > 0 ? (
        <section aria-labelledby="nu-h" className="rise flex flex-col gap-3" style={rise(1)}>
          <h2 id="nu-h" className="label text-subtle">
            Nu och planerade
          </h2>
          <ul className="flex flex-col gap-3">
            {data.current.map((c, i) => (
              <CampaignCard
                key={c.id}
                c={c}
                i={i}
                canEdit={canEdit}
                when={
                  c.state === "scheduled" && firstDay(c) > today
                    ? `Från ${dayLabel(firstDay(c), today)} t.o.m. ${dayLabel(lastDay(c), today)}`
                    : `T.o.m. ${dayLabel(lastDay(c), today)}`
                }
                stats={
                  <Suspense fallback={null}>
                    <CampaignStats viewer={viewer} id={c.id} />
                  </Suspense>
                }
              />
            ))}
          </ul>
        </section>
      ) : null}

      {data.past.length > 0 ? (
        <details className="rise group" style={rise(2)}>
          <summary className="label cursor-pointer text-subtle">
            Tidigare ({formatInt(data.past.length)})
          </summary>
          <ul className="mt-3 flex flex-col gap-3">
            {data.past.map((c, i) => (
              <CampaignCard
                key={c.id}
                c={c}
                i={i}
                canEdit={false}
                when={`${dayLabel(firstDay(c), today)} – ${dayLabel(lastDay(c), today)}`}
              />
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

async function CampaignStats({ viewer, id }: { viewer: Viewer; id: string }) {
  const stats = await loadCampaignStatsFor(viewer).catch(() => ({}) as Record<string, null>);
  const s = stats[id];
  if (!s) return null;
  return (
    <span className="tnum text-sm text-muted">
      {formatInt(s.views)} visningar · {formatInt(s.hits)} tryck
    </span>
  );
}

function CampaignCard({
  c,
  i,
  canEdit,
  when,
  stats,
}: {
  c: CampaignView;
  i: number;
  canEdit: boolean;
  when: string;
  stats?: React.ReactNode;
}) {
  const failed = c.machines.filter((m) => m.status === "failed");
  const active = c.state !== "ended" && c.state !== "stopped";
  return (
    <li
      className="rise flex flex-col gap-3 rounded-md border border-line-strong bg-raised p-3 sm:flex-row sm:items-center"
      style={rise(i)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/kampanjer/bild/${c.id}`}
        alt=""
        className="h-28 w-full shrink-0 rounded-sm bg-bg object-cover sm:h-20 sm:w-32"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base font-medium">{c.title}</span>
          <StatusTag status={STATE_TONE[c.state]}>{CAMPAIGN_STATE_LABEL[c.state]}</StatusTag>
        </div>
        <span className="text-sm text-muted">
          {when} · {c.machines.map((m) => m.code).join(", ")}
        </span>
        {failed.length > 0 && active ? (
          <span className="text-sm text-signal-fg">
            Kom inte fram: {failed.map((m) => m.code).join(", ")}
            {failed[0]?.error ? ` (${failed[0].error})` : ""}
          </span>
        ) : null}
        {stats}
      </div>
      {canEdit && active ? (
        <CampaignActions
          id={c.id}
          title={c.title}
          canStop
          canRetry={failed.length > 0 && c.state !== "scheduled"}
        />
      ) : null}
    </li>
  );
}

async function FreePacksView({
  viewer,
  today,
  initialMachineId,
  initialReason,
}: {
  viewer: Viewer;
  today: string;
  initialMachineId: string | null;
  initialReason: string | null;
}) {
  const data = await loadFreePackPageFor(viewer);
  const reason = ["compensation", "giveaway", "staff", "other"].includes(initialReason ?? "")
    ? (initialReason as "compensation")
    : null;
  const month = new Date(`${today}T12:00:00Z`).toLocaleDateString("sv-SE", {
    month: "long",
    timeZone: "UTC",
  });
  return (
    <>
      <header className="rise flex flex-col gap-4" style={rise(0)}>
        <p className="label text-subtle">Gratis-pack</p>
        <h1 className="text-3xl font-medium md:text-4xl">
          <BigNumber value={data.month.packs} id="gratis-pack-manad" />{" "}
          {data.month.packs === 1 ? "pack" : "pack"} bortgivna i {month}.
        </h1>
        <p className="text-base text-muted">
          {kr(data.month.costOre)} till inköpspris
          {data.month.unpriced > 0 ? ` · ${formatInt(data.month.unpriced)} utan pris` : ""}.
        </p>
        {!data.connected ? <NotConnected /> : null}
        {data.canCreate && data.connected ? (
          <div>
            <FreePackGiver
              machines={data.linked.map((m) => ({
                machineId: m.machineId,
                code: m.code,
                name: m.name,
              }))}
              today={today}
              initialMachineId={initialMachineId}
              initialReason={reason}
            />
          </div>
        ) : null}
      </header>

      {data.batches.length > 0 ? (
        <section aria-labelledby="senaste-h" className="rise flex flex-col gap-3" style={rise(1)}>
          <h2 id="senaste-h" className="label text-subtle">
            Senaste
          </h2>
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line-strong bg-raised">
            {data.batches.map((b) => (
              <li
                key={b.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="text-base font-medium">
                    {b.quantity} × {b.goodName}
                  </span>
                  <span className="text-sm text-muted">
                    {dayLabel(b.day, today)} · {b.machine.code} · {REASON_LABEL[b.reason]}
                    {b.recipient ? ` · till ${b.recipient}` : ""}
                    {b.createdBy ? ` · ${b.createdBy}` : ""}
                  </span>
                  {b.status === "failed" ? (
                    <span className="text-sm text-signal-fg">Misslyckades: {b.error}</span>
                  ) : b.error ? (
                    <span className="text-sm text-muted">{b.error}</span>
                  ) : null}
                </div>
                <div className="flex items-center gap-3">
                  <span className="tnum text-sm text-muted">
                    {b.status !== "created"
                      ? "–"
                      : b.costOre === null
                        ? "Inget pris"
                        : kr(b.costOre)}
                  </span>
                  {b.codes.length > 0 ? (
                    <ShowCodesButton
                      codes={b.codes}
                      message={shareText({
                        codes: b.codes,
                        goodName: b.goodName,
                        place: b.machine.name,
                        expiresOn: addDaysIso(b.expiresAt.slice(0, 10), -1),
                      })}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="text-base text-muted">Inga gratis-pack än.</p>
      )}
    </>
  );
}
