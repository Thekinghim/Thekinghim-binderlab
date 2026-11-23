import type { Metadata } from "next";
import { Suspense } from "react";

import { Badge, type BadgeTone } from "@/components/v2/badge";
import { ButtonLink } from "@/components/v2/button";
import { Card, CardBody } from "@/components/v2/card";
import { Empty, emptyPacks } from "@/components/v2/empty";
import { Notice } from "@/components/v2/notice";
import { PAGE_BODY, PageIntro } from "@/components/v2/page-intro";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { SubNav } from "@/components/v2/sub-nav";
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
const kr = (ore: number) => formatSek(ore / 100);

const STATE_TONE: Record<CampaignState, BadgeTone> = {
  live: "success",
  partial: "warning",
  scheduled: "info",
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
    <V2Page
      title={view === "kampanjer" ? "Kampanjer" : "Gratis-pack"}
      date={headerDate(new Date(ctx.now), ctx.timeZone)}
    >
      <SubNav />
      <div className={PAGE_BODY}>
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
    </V2Page>
  );
}

function NotConnected() {
  return (
    <Notice
      tone="info"
      title="Koppla Awish först."
      action={
        <ButtonLink href="/datakallor" touch>
          Datakällor →
        </ButtonLink>
      }
    />
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
      <PageIntro
        title={
          live.length === 0 ? (
            "Ingen kampanj visas nu."
          ) : (
            <>
              <BigNumber value={live.length} id="kampanjer-live" />{" "}
              {live.length === 1 ? "kampanj visas" : "kampanjer visas"} nu.
            </>
          )
        }
        aside={
          data.linked.length === 0
            ? "Ingen automat är kopplad till Awish."
            : `På ${formatInt(liveMachines.size)} av ${formatInt(data.linked.length)} ${data.linked.length === 1 ? "automat" : "automater"}.`
        }
      />
      {!data.connected ? <NotConnected /> : null}
      {canEdit && data.connected && data.linked.length > 0 ? (
        <Card as="section" title="Kampanjer på skärmen">
          <CardBody className="flex flex-col items-start gap-3">
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
          </CardBody>
        </Card>
      ) : null}

      {data.current.length > 0 ? (
        <Card as="section" title="Nu och planerade" count={data.current.length}>
          <ul aria-label="Nu och planerade" className="flex flex-col">
            {data.current.map((c) => (
              <CampaignCard
                key={c.id}
                c={c}
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
        </Card>
      ) : null}

      {data.past.length > 0 ? (
        <details className="v2-card group">
          <summary className="v2-card-hd cursor-pointer list-none [&::-webkit-details-marker]:hidden">
            <h2>
              Tidigare<span aria-hidden="true">·</span>
              <span className="n">{formatInt(data.past.length)}</span>
            </h2>
            <span
              aria-hidden="true"
              className="text-v2-mute transition-transform duration-150 group-open:rotate-90"
            >
              ›
            </span>
          </summary>
          <ul className="flex flex-col">
            {data.past.map((c) => (
              <CampaignCard
                key={c.id}
                c={c}
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
    <span className="tnum text-v2-sm text-v2-mute">
      {formatInt(s.views)} visningar · {formatInt(s.hits)} tryck
    </span>
  );
}

function CampaignCard({
  c,
  canEdit,
  when,
  stats,
}: {
  c: CampaignView;
  canEdit: boolean;
  when: string;
  stats?: React.ReactNode;
}) {
  const failed = c.machines.filter((m) => m.status === "failed");
  const active = c.state !== "ended" && c.state !== "stopped";
  return (
    <li className="flex flex-col gap-3 border-t border-v2-line2 px-[18px] py-3 first:border-t-0 max-[900px]:px-4 sm:flex-row sm:items-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/kampanjer/bild/${c.id}`}
        alt=""
        className="h-28 w-full shrink-0 rounded-v2 border border-v2-line2 bg-v2-hover object-cover sm:h-16 sm:w-28"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-v2-md font-[550]">{c.title}</span>
          <Badge tone={STATE_TONE[c.state]}>{CAMPAIGN_STATE_LABEL[c.state]}</Badge>
        </div>
        <span className="text-v2-sm text-v2-mute">
          {when} · {c.machines.map((m) => m.code).join(", ")}
        </span>
        {failed.length > 0 && active ? (
          <span className="text-v2-sm text-v2-crit-text">
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
      <PageIntro
        title={
          <>
            <BigNumber value={data.month.packs} id="gratis-pack-manad" />{" "}
            {data.month.packs === 1 ? "pack" : "pack"} bortgivna i {month}.
          </>
        }
        aside={`${kr(data.month.costOre)} till inköpspris${data.month.unpriced > 0 ? ` · ${formatInt(data.month.unpriced)} utan pris` : ""}.`}
      />
      {!data.connected ? <NotConnected /> : null}
      {data.canCreate && data.connected ? (
        <Card as="section" title="Gratis-pack">
          <CardBody>
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
          </CardBody>
        </Card>
      ) : null}

      {data.batches.length > 0 ? (
        <Card as="section" title="Senaste" count={data.batches.length}>
          <ul aria-label="Senaste gratis-pack" className="flex flex-col divide-y divide-v2-line2">
            {data.batches.map((b) => (
              <li
                key={b.id}
                className="flex flex-wrap items-center justify-between gap-3 px-[18px] py-3 max-[900px]:px-4"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="text-v2-md font-[550]">
                    {b.quantity} × {b.goodName}
                  </span>
                  <span className="text-v2-sm text-v2-mute">
                    {dayLabel(b.day, today)} · {b.machine.code} · {REASON_LABEL[b.reason]}
                    {b.recipient ? ` · till ${b.recipient}` : ""}
                    {b.createdBy ? ` · ${b.createdBy}` : ""}
                  </span>
                  {b.status === "failed" ? (
                    <span className="text-v2-sm text-v2-crit-text">Misslyckades: {b.error}</span>
                  ) : b.error ? (
                    <span className="text-v2-sm text-v2-mute">{b.error}</span>
                  ) : null}
                </div>
                <div className="flex items-center gap-3">
                  <span className="tnum text-v2-sm text-v2-mute">
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
        </Card>
      ) : (
        <Card>
          <Empty packs={emptyPacks([])} title="Inga gratis-pack än" />
        </Card>
      )}
    </>
  );
}
