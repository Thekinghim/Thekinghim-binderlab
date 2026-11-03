"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { wallClockIn } from "@/components/shell/period-state";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { StateMessage } from "@/components/ui/state-message";
import { formatDateTime, formatInt, formatKronor, MISSING } from "@/lib/format";

import type { OrderDetail } from "../_lib/types";

const PROVIDER: Record<string, string> = {
  awish_csv: "Awish, CSV-fil",
  awish_grpc: "Awish, API",
  awish_web: "Awish, webbhämtning",
  awish_extension: "Awish, Chrome-tillägg",
};

/** Ord i providerns namn; står alla redan i datakällans namn upprepas providern inte. */
const PROVIDER_WORDS: Record<string, readonly string[]> = {
  awish_csv: ["awish", "csv"],
  awish_grpc: ["awish", "api"],
  awish_web: ["awish", "webb"],
  awish_extension: ["awish", "tillägg"],
};

/** Providern att visa efter datakällans namn, eller null när namnet redan säger den. */
export function providerNote(name: string, provider: string): string | null {
  const label = PROVIDER[provider] ?? provider;
  const words = PROVIDER_WORDS[provider];
  const lower = name.toLocaleLowerCase("sv-SE");
  if (words?.every((w) => lower.includes(w))) return null;
  if (lower === label.toLocaleLowerCase("sv-SE")) return null;
  return label;
}

const TRIGGER: Record<string, string> = {
  upload: "Uppladdad fil",
  schedule: "Schemalagd hämtning",
  webhook: "Webhook",
};

const PAYMENT: Record<string, string> = {
  card: "Kort",
  swish: "Swish",
  cash: "Kontant",
};

/** "1 nov. 2026 17:17" i organisationens tidszon. */
function at(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return MISSING;
  return formatDateTime(wallClockIn(d, timeZone), { year: "always" });
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 border-t border-line py-2 first:border-t-0 sm:grid-cols-[9rem_1fr] sm:gap-4">
      <dt className="label pt-0.5 text-subtle">{label}</dt>
      <dd className="min-w-0 text-base break-words text-fg">{children}</dd>
    </div>
  );
}

/** Underavsnitt i dialogen: etikett och en linje, tätare än PanelSection. */
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t border-line pt-4 not-first:mt-6 first:border-t-0 first:pt-0">
      <h3 className="label text-muted">{label}</h3>
      <dl className="flex flex-col">{children}</dl>
    </section>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted">{children}</span>;
}

/** Källans namn på automaten, och dess id om det skiljer sig från namnet. */
function SourceMachine({
  externalId,
  externalName,
  deviceNo,
}: {
  externalId: string;
  externalName: string | null;
  deviceNo: string | null;
}) {
  const name = externalName ?? externalId;
  const ids = [deviceNo, externalId].filter(
    (v, i, all): v is string => v !== null && v !== name && all.indexOf(v) === i,
  );
  return (
    <>
      {name}
      {ids.length ? (
        <Muted>
          {" · "}
          <span className="font-mono text-sm">{ids.join(" · ")}</span>
        </Muted>
      ) : null}
    </>
  );
}

/** Laddar: samma rader som innehållet, utan värden. */
export function OrderDetailSkeleton() {
  return (
    <div aria-busy="true" aria-label="Laddar ordern" className="flex flex-col gap-3">
      {[60, 40, 72, 52, 66, 48].map((w, i) => (
        <div key={i} className="flex items-center gap-4 py-1.5">
          <Skeleton className="h-2.5 w-24" />
          <span className="block h-3" style={{ width: `${w}%` }}>
            <Skeleton className="h-3 w-full" />
          </span>
        </div>
      ))}
    </div>
  );
}

export function OrderDetailError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <StateMessage
      kind="loading-failed"
      compact
      message={message}
      action={{ label: "Försök igen", onClick: onRetry }}
    />
  );
}

export function OrderNotFound() {
  return (
    <StateMessage
      kind="empty"
      compact
      code="0 träffar"
      message="Ordern finns inte i den här organisationen."
    />
  );
}

/** Orderns uppgifter: order, titel, automat och butik, källa och import. */
export function OrderDetailView({
  detail,
  timeZone,
  canOpenImport,
}: {
  detail: OrderDetail;
  timeZone: string;
  canOpenImport: boolean;
}) {
  const sameTitle =
    detail.title !== null &&
    detail.title.name.trim().toLowerCase() === detail.rawTitle.trim().toLowerCase();
  const imp = detail.import;
  const provider = providerNote(detail.dataSource.name, detail.dataSource.provider);

  return (
    <div className="flex flex-col">
      <Group label="Order">
        <Row label="Ordernummer">
          <span className="font-mono">{detail.externalId}</span>
        </Row>
        <Row label="Tid">
          <span className="tnum">{at(detail.orderedAt, timeZone)}</span>
        </Row>
        <Row label="Belopp">
          <span className="tnum">{formatKronor(detail.amountOre / 100)}</span>
        </Row>
        <Row label="Betalsätt">
          {detail.paymentMethod ? (
            (PAYMENT[detail.paymentMethod.toLowerCase()] ?? detail.paymentMethod)
          ) : (
            <Muted>Anges inte av källan</Muted>
          )}
        </Row>
      </Group>

      <Group label="Titel">
        <Row label="Tolkad titel">
          {detail.title ? (
            <>
              {detail.title.name}
              {detail.title.series ? <Muted> · {detail.title.series}</Muted> : null}
            </>
          ) : (
            <Muted>Ingen titel kopplad</Muted>
          )}
        </Row>
        <Row label="Originaltitel">
          <span className="font-mono text-sm">{detail.rawTitle}</span>
          {sameTitle ? null : detail.title ? (
            <span className="block pt-1 text-xs text-subtle">Originaltitel i Awish.</span>
          ) : null}
        </Row>
      </Group>

      <Group label="Automat och butik">
        <Row label="Automat">
          {detail.machine ? (
            <>
              <span className="font-mono">{detail.machine.code}</span>
              {detail.machine.name !== detail.machine.code ? (
                <Muted> · {detail.machine.name}</Muted>
              ) : null}
            </>
          ) : (
            <Muted>Inte kopplad till någon automat</Muted>
          )}
        </Row>
        <Row label="Butik">
          {detail.store ? detail.store.name : <Muted>Ingen placering den dagen</Muted>}
        </Row>
        <Row label="I källan">
          {detail.sourceMachine ? (
            <SourceMachine {...detail.sourceMachine} />
          ) : (
            <Muted>{MISSING}</Muted>
          )}
        </Row>
      </Group>

      <Group label="Källa">
        <Row label="Datakälla">
          {detail.dataSource.name}
          {provider ? (
            <Muted>
              {" · "}
              {provider}
            </Muted>
          ) : null}
        </Row>
        <Row label="Import">
          {imp ? (
            <span className="flex flex-col gap-1.5">
              <span>
                {imp.fileName ?? TRIGGER[imp.trigger] ?? imp.trigger}
                <Muted>
                  {" · "}
                  <span className="tnum">{at(imp.at, timeZone)}</span>
                </Muted>
              </span>
              {imp.rowNumber !== null ? (
                <span className="tnum text-sm text-muted">
                  Rad {formatInt(imp.rowNumber)} i filen
                </span>
              ) : null}
              {canOpenImport ? (
                <Link
                  href={`/datakallor/importer/${encodeURIComponent(imp.id)}`}
                  className="inline-flex w-fit items-center gap-1 rounded-xs text-sm text-fg underline decoration-line-control underline-offset-4 hover:decoration-fg"
                >
                  Öppna importen
                  <Icon name="arrowUpRight" size={12} />
                </Link>
              ) : null}
            </span>
          ) : (
            <Muted>Ingen import registrerad</Muted>
          )}
        </Row>
        <Row label="Sparad">
          <span className="tnum">{at(detail.createdAt, timeZone)}</span>
          {detail.lateInClosedPeriod ? (
            <span className="block pt-1 text-sm text-muted">
              Kom efter månadsstängning, ingår i nästa rapport.
            </span>
          ) : null}
        </Row>
      </Group>
    </div>
  );
}
