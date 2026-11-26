"use client";

import { approxKr } from "@/analytics/forecast/common";
import Link from "next/link";

import { cn } from "@/lib/cn";
import { useState, useTransition } from "react";

import type { HemAction } from "@/analytics/home-v2";
import { Badge } from "@/components/v2/badge";
import { Button, ButtonLink } from "@/components/v2/button";
import { CallLink } from "@/components/v2/call-link";
import { telHref } from "@/components/v2/links";
import { toastUndo, toastV2 } from "@/components/v2/toast";
import { usePhone } from "@/components/v2/use-media";
import { formatInt, NBSP } from "@/lib/format";

import { changeRoute, undoRouteChange } from "../../rutt/actions";

/** Så många rader innan "Visa alla" (prototypen: 6 på dator, 3 på telefon). */
const MAX_DESKTOP = 6;
const MAX_PHONE = 3;

/** Priser i hela kronor. */
const krExact = (ore: number) => `${formatInt(Math.round(ore / 100))}${NBSP}kr`;

function LossText({ ore }: { ore: number | undefined }) {
  if (ore === undefined) return null;
  return (
    <>
      {" "}
      · tappar <b>{approxKr(ore)}</b> vinst/dag
    </>
  );
}

function sinceText(iso: string | null, nowMs: number): string {
  if (!iso) return "nyss";
  const min = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60_000));
  if (min < 60) return `${min}${NBSP}min sedan`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}${NBSP}h ${min % 60}${NBSP}min sedan`;
  return `${formatInt(Math.floor(h / 24))}${NBSP}dagar sedan`;
}

/**
 * Kräver åtgärd (V2): en lista, störst förlorad vinst per dag först (för påfyllaren efter
 * brådska, utan kronor). Märket säger vad det gäller; knapparna gör det direkt: Fyll på,
 * Ring butiken, Lägg i rutten (med Ångra) och Ändra pris.
 */
export function ActionsList({
  rows,
  nowIso,
  canRoute,
  inRoute,
}: {
  rows: readonly HemAction[];
  nowIso: string;
  /** Rollen får ändra rutten (ägare, admin, påfyllare). */
  canRoute: boolean;
  /** Automater som redan är med i dagens rutt. */
  inRoute: readonly string[];
}) {
  const phone = usePhone();
  const [all, setAll] = useState(false);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [pending, start] = useTransition();
  const max = phone ? MAX_PHONE : MAX_DESKTOP;
  const shown = all ? rows : rows.slice(0, max);
  const nowMs = Date.parse(nowIso);
  const routeSet = new Set([...inRoute, ...added]);

  const add = (r: HemAction) => {
    if (!r.machineId) return;
    const id = r.machineId;
    start(async () => {
      const res = await changeRoute(id, "add");
      if (!res.ok) {
        toastV2(res.error, { tone: "critical" });
        return;
      }
      setAdded((s) => new Set(s).add(id));
      toastUndo(`${r.title} ligger i rutten`, "Rutten för i dag är ändrad.", () => {
        const changeId = res.data?.id;
        const replaced = res.data?.replaced ?? null;
        setAdded((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        });
        if (changeId) void undoRouteChange(changeId, replaced);
      });
    });
  };

  if (rows.length === 0) {
    return (
      <div className="aempty">
        <b>Inget kräver åtgärd.</b>
        <span>Alla automater är fyllda och online.</span>
      </div>
    );
  }

  return (
    <>
      <div>
        {shown.map((r) => {
          const hasCall = telHref(r.phone) !== null;
          return (
            <div
              className={cn("arow", r.kind === "offline" && "off wide")}
              key={r.key}
              data-hem-action={r.kind}
            >
              {r.kind === "offline" ? (
                // Offline: en rad som i mocken, märket direkt efter namnet och resten under.
                <div className="an">
                  <span className="anh">
                    <b title={r.title}>{r.title}</b>
                    <Badge tone={r.tone} dot>
                      {r.badge}
                    </Badge>
                  </span>
                  <small>
                    {r.sub ? `${r.sub} · ` : ""}senast hörd {sinceText(r.offlineSince, nowMs)}
                    <LossText ore={r.lossOre} />
                  </small>
                </div>
              ) : (
                <>
                  <div className="an">
                    <b title={r.title}>{r.title}</b>
                    {r.sub ? <small>{r.sub}</small> : null}
                    {r.price ? (
                      <small>
                        Säljs för {krExact(r.price.salePriceOre)}, inköp{" "}
                        {krExact(r.price.unitCostOre)}
                      </small>
                    ) : null}
                  </div>
                  <div className="ai">
                    <div className="flex items-center gap-3">
                      <Badge tone={r.tone} dot>
                        {r.badge}
                      </Badge>
                      {r.fillBp !== null ? (
                        <span
                          className="afill"
                          aria-label={`${Math.round(r.fillBp / 100)} % fylld`}
                        >
                          <span className="track">
                            <i
                              className={r.kind === "tom" ? "c" : "o"}
                              style={{
                                transform: `scaleX(${Math.min(1, Math.max(0, r.fillBp / 10_000))})`,
                              }}
                            />
                          </span>
                          <span className={`pct ${r.kind === "tom" ? "text-v2-crit-text" : "o"}`}>
                            {Math.round(r.fillBp / 100)}
                            {NBSP}%
                          </span>
                        </span>
                      ) : null}
                    </div>
                    <small>
                      {r.kind === "pris" && r.price ? (
                        r.price.suggestedPriceOre !== null ? (
                          <>
                            Höj till <b>{krExact(r.price.suggestedPriceOre)}</b>: nu{" "}
                            {krExact(r.price.profitOre)} per pack efter avgifter
                          </>
                        ) : (
                          <>Priset täcker inte inköp och avgifter</>
                        )
                      ) : (
                        <>
                          {r.kind === "tom"
                            ? "Tom"
                            : r.kind === "startklar"
                              ? "Ny automat"
                              : r.badge}
                          {r.packs !== null ? (
                            <>
                              {" "}
                              · ta med{" "}
                              <b>
                                {formatInt(r.packs)}
                                {NBSP}pack
                              </b>
                            </>
                          ) : null}
                        </>
                      )}
                      <LossText ore={r.lossOre} />
                    </small>
                  </div>
                </>
              )}
              <div className="ago">
                {r.kind === "offline" ? (
                  <>
                    {/* På telefon bara en knapp (den första som finns): Ring, annars Lägg i
                      rutten, annars Visa. De andra döljs i hem.css (.sec). */}
                    <CallLink phone={r.phone} name={r.contactName} size="sm" />
                    {canRoute && r.machineId ? (
                      routeSet.has(r.machineId) ? (
                        <span
                          className={cn("v2-btn sm plain", hasCall && "sec")}
                          aria-disabled="true"
                        >
                          I rutten
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="plain"
                          className={cn(hasCall && "sec")}
                          pending={pending}
                          onClick={() => add(r)}
                        >
                          Lägg i rutten
                        </Button>
                      )
                    ) : null}
                    {r.code ? (
                      <ButtonLink
                        prefetch={false}
                        size="sm"
                        variant="plain"
                        className={cn((hasCall || (canRoute && r.machineId)) && "sec")}
                        href={`/automater?valj=${encodeURIComponent(r.code)}`}
                      >
                        Visa
                      </ButtonLink>
                    ) : null}
                  </>
                ) : r.kind === "pris" ? (
                  <ButtonLink prefetch={false} size="sm" href="/lonsamhet#prisrad">
                    Ändra pris
                  </ButtonLink>
                ) : canRoute && r.machineId ? (
                  <ButtonLink prefetch={false} size="sm" href={`/fyll-pa/${r.machineId}?fran=hem`}>
                    Fyll på
                  </ButtonLink>
                ) : r.code ? (
                  <ButtonLink
                    prefetch={false}
                    size="sm"
                    variant="plain"
                    href={`/automater?valj=${encodeURIComponent(r.code)}`}
                  >
                    Visa
                  </ButtonLink>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {rows.length > max ? (
        <button
          type="button"
          className="lk amore text-left"
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
        >
          {all ? "Visa färre" : `Visa alla ${formatInt(rows.length)}`}
        </button>
      ) : null}
    </>
  );
}

export function CalmLine({
  running,
  powerOff,
  powerWindow,
  total,
}: {
  running: number;
  powerOff: number;
  powerWindow: string | null;
  total: number;
}) {
  return (
    <Link prefetch={false} className="calm" href="/automater">
      <span>
        <span className="dot g" aria-hidden="true" />
        {formatInt(running)} i drift
      </span>
      {powerOff > 0 ? (
        <>
          <i aria-hidden="true">·</i>
          <span>
            <span className="dot x" aria-hidden="true" />
            {formatInt(powerOff)} ström av
            {powerWindow ? <small>(på igen {powerWindow.split("–")[1]})</small> : null}
          </span>
        </>
      ) : null}
      {/* Pricken före länken göms (hem.css): länken står längst till höger eller på egen rad. */}
      <i className="sep-all" aria-hidden="true">
        ·
      </i>
      <span className="all">Alla {formatInt(total)} automater →</span>
    </Link>
  );
}
