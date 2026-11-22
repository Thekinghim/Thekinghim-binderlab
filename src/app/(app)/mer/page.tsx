import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { routesForRole, v2NavForRole, type RouteId } from "@/components/shell/nav";
import { Card } from "@/components/v2/card";
import { ListRow } from "@/components/v2/list-row";
import { NavIcon } from "@/components/v2/shell/nav-icon";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { formatInt, NBSP } from "@/lib/format";
import { requireRoute } from "@/server/data/core";

import { loadMoreCounts } from "./_lib/data";
import { MoreAccount } from "./more-account";
import "../pengar/_components/money.css";

export const metadata: Metadata = { title: "Mer" };

/** Sidorna som redan står i menyn (sidomenyn och bottenraden), utom Butiker och Pengar. */
const IN_MENU: ReadonlySet<RouteId> = new Set(["hem", "automater", "rutt", "vart-lager", "mer"]);

/** Små ikoner för Driften (prototypens .mi), streck 1,7. Dekor. */
const ICON = {
  automat: "M6 2h12v20H6zM9 6h6M12 12v4M10 14h4",
  butik: "M4 5h16v14H4zM4 9h16",
  folk: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20a6 6 0 0 1 12 0M17 11a3 3 0 1 0 0-6M21 20a6 6 0 0 0-4-5.7",
  bil: "M3 6h11v10H3zM14 9h4l3 3v4h-7M6.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM17.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
  rutt: "M6 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 17V10a4 4 0 0 1 4-4h6",
  kugg: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12h2M3 12h2M12 3v2M12 19v2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4",
} as const;

function Icon({ d }: { d: string }) {
  return (
    <span className="mi" aria-hidden="true">
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={d} />
      </svg>
    </span>
  );
}

function Row({
  href,
  icon,
  title,
  sub,
  aside,
}: {
  href: string;
  icon?: ReactNode;
  title: string;
  sub?: string;
  aside?: ReactNode;
}) {
  return (
    <Link href={href} className="g4-mrow">
      {icon}
      <span className="mt">
        <b>{title}</b>
        {sub ? <small>{sub}</small> : null}
      </span>
      {aside !== undefined ? <span className="cnt">{aside}</span> : null}
      <span className="cnt" aria-hidden="true">
        ›
      </span>
    </Link>
  );
}

const n = (v: number | null, one: string, many: string) =>
  v === null ? undefined : `${formatInt(v)}${NBSP}${v === 1 ? one : many}`;

/**
 * Mer (/mer, G4): Driften (lägg till automat och butik, personal och roller, leverantörer,
 * dagens gräns för rutten, inställningar) med länkar till sidorna som redan gör det, Kopplingar
 * (Awish, bokföring, export), alla sidor rollen får se och kontot. På telefonen står Pengar och
 * Butiker överst (de finns inte i bottenraden). "Visa som påfyllare" byggs inte (byggplanen 2.9).
 */
export default async function MorePage() {
  const ctx = await requireRoute("mer");
  const counts = await loadMoreCounts(ctx);
  const allowed = new Set(routesForRole(ctx.role).map((r) => r.id));
  const top = v2NavForRole(ctx.role).filter((i) => i.id === "butiker" || i.id === "pengar");
  const pages = routesForRole(ctx.role).filter(
    (r) => !IN_MENU.has(r.id) && r.id !== "pengar" && r.id !== "butiker",
  );
  const sync = counts.sync;
  const time = (iso: string) =>
    new Intl.DateTimeFormat("sv-SE", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: ctx.timeZone,
    }).format(new Date(iso));
  const syncText = sync
    ? sync.state === "failed"
      ? "Senaste synken misslyckades"
      : sync.syncedAt
        ? `Köp och fack, var 5:e minut · senast ${time(sync.syncedAt)}`
        : "Ingen synk än"
    : "Ingen datakälla";
  const syncOk = sync !== null && (sync.state === "ok" || sync.state === "no-orders");

  return (
    <V2Page title="Mer" date={headerDate(new Date(ctx.now), ctx.timeZone)}>
      <div className="g4 g4-mer" data-testid="mer-v2">
        <div className="flex min-w-0 flex-col gap-3.5">
          {top.length > 0 ? (
            <Card className="pages-m">
              {top.map((i) => (
                <Row
                  key={i.id}
                  href={i.href}
                  icon={
                    <span className="mi" aria-hidden="true">
                      <NavIcon name={i.id} size={18} />
                    </span>
                  }
                  title={i.label}
                  sub={
                    i.id === "pengar"
                      ? "Resultat, att betala, vinst per automat"
                      : "Avtal, andelar och betalningar"
                  }
                />
              ))}
            </Card>
          ) : null}

          {ctx.canEdit ? (
            <Card title="Driften · det som gör att någon annan kan ta över">
              <Row
                href="/automater"
                icon={<Icon d={ICON.automat} />}
                title="Lägg till automat"
                sub="Serienummer, butik, fack och priser. Kopplas till Awish."
                aside={n(counts.machines, "automat", "automater")}
              />
              <Row
                href="/butiker/ny"
                icon={<Icon d={ICON.butik} />}
                title="Lägg till butik och avtal"
                sub="Adress, kontaktperson, telefon och hur stor andel butiken får."
                aside={n(counts.stores, "butik", "butiker")}
              />
              <Row
                href="/installningar/anvandare"
                icon={<Icon d={ICON.folk} />}
                title="Personal och roller"
                sub="Bjud in med e-post. Påfyllare ser inga pengar."
                aside={n(counts.people, "person", "personer")}
              />
              {allowed.has("prognos") ? (
                <Row
                  href="/prognos#leverantorer"
                  icon={<Icon d={ICON.bil} />}
                  title="Leverantörer och leveranstider"
                  sub="Styr när Vårt lager säger till att beställa."
                  aside={n(counts.suppliers, "leverantör", "leverantörer")}
                />
              ) : null}
              <Row
                href="/rutt"
                icon={<Icon d={ICON.rutt} />}
                title="Rutt: dagens gräns"
                sub="Hur många stopp och pack en dag får ha, och vilka dagar."
                aside={
                  counts.route
                    ? `${formatInt(counts.route.maxStops)} stopp · ${formatInt(counts.route.maxPacks)} pack`
                    : undefined
                }
              />
              <Row
                href="/installningar"
                icon={<Icon d={ICON.kugg} />}
                title="Inställningar"
                sub="Kortavgift, moms, företaget och kontot."
              />
            </Card>
          ) : null}

          <Card title="Alla sidor">
            {pages.map((r) => (
              <ListRow
                key={r.id}
                href={r.href}
                title={r.label}
                sub={r.lead}
                actions={<span aria-hidden="true">→</span>}
              />
            ))}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-3.5">
          {ctx.canSeeEconomy ? (
            <Card title="Kopplingar">
              {allowed.has("datakallor") ? (
                <Row
                  href="/datakallor"
                  title="Awish"
                  sub={syncText}
                  aside={
                    <span className="st">
                      <span className={syncOk ? "v2-dot" : "v2-dot critical"} aria-hidden="true" />
                      {syncOk ? "Ansluten" : sync ? "Fel" : "Ej ansluten"}
                    </span>
                  }
                />
              ) : (
                <div className="g4-mrow">
                  <span className="mt">
                    <b>Awish</b>
                    <small>{syncText}</small>
                  </span>
                  <span className="st">
                    <span className={syncOk ? "v2-dot" : "v2-dot critical"} aria-hidden="true" />
                    {syncOk ? "Ansluten" : sync ? "Fel" : "Ej ansluten"}
                  </span>
                </div>
              )}
              {allowed.has("ekonomi") ? (
                <Row
                  href="/ekonomi?vy=bokforing"
                  title="Bokföring"
                  sub="Månadens bokföringspaket."
                />
              ) : null}
              {allowed.has("pengar") ? (
                <Row
                  href="/pengar/export"
                  title="Exportera vinst per automat"
                  sub="12 månader, kr per dag i tjänst (CSV)"
                />
              ) : null}
            </Card>
          ) : null}
          <MoreAccount
            email={ctx.user.email}
            organizations={ctx.organizations.map((o) => ({ id: o.id, name: o.name }))}
            activeOrganizationId={ctx.organization.id}
          />
        </div>
      </div>
    </V2Page>
  );
}
