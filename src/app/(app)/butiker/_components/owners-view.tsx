import Link from "next/link";
import type { CSSProperties } from "react";

import { StateMessage } from "@/components/ui/state-message";
import { StatusTag } from "@/components/ui/status-tag";
import { PAGE_BODY, PageIntro } from "@/components/v2/page-intro";
import { MISSING } from "@/lib/format";
import type { Viewer } from "@/server/data/core/loaders";

import { loadOwnersFor, type OwnerView } from "../_lib/owner-service";
import { AddOwnerButton, OwnerActions } from "./owner-dialogs";

const rise = (i: number) => ({ "--i": i }) as CSSProperties;

/** "1 butik", "3 butiker". */
function storesText(n: number): string {
  return n === 1 ? "1 butik" : `${n} butiker`;
}

/** Postadressen på en rad: "Testgatan 1, 441 30 Testby". */
function addressText(o: OwnerView): string | null {
  const place = [o.postalCode, o.city].filter(Boolean).join(" ");
  const parts = [o.streetAddress, place].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(", ") : null;
}

/** Bolagets uppgifter som rader (etikett och värde). */
function facts(o: OwnerView): Array<{ label: string; value: string | null; href?: string }> {
  return [
    { label: "Organisationsnummer", value: o.orgNumber },
    { label: "Momsreg.nr", value: o.vatNumber },
    { label: "F-skatt", value: o.fTax ? "Ja" : "Nej" },
    { label: "Adress", value: addressText(o) },
    { label: "Kontaktperson", value: o.contactName },
    { label: "E-post", value: o.email, href: o.email ? `mailto:${o.email}` : undefined },
    {
      label: "Telefon",
      value: o.phone,
      href: o.phone ? `tel:${o.phone.replace(/[^+0-9]/g, "")}` : undefined,
    },
    {
      label: "Fakturor till",
      value: o.invoiceEmail,
      href: o.invoiceEmail ? `mailto:${o.invoiceEmail}` : undefined,
    },
    { label: "Bankgiro", value: o.bankgiro },
  ];
}

function OwnerCard({ owner, canEdit, i }: { owner: OwnerView; canEdit: boolean; i: number }) {
  const active = owner.stores.filter((s) => !s.archived);
  return (
    <li
      className="v2-card flex min-w-0 flex-col gap-4 p-[18px] max-[900px]:p-4"
      style={rise(i)}
      data-owner={owner.legalName}
    >
      <div className="flex min-w-0 items-start justify-between gap-3 max-md:relative max-md:pr-10">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-v2-lg font-[650] [overflow-wrap:anywhere] text-v2-ink">
            {owner.legalName}
          </h2>
          <p className="tnum text-v2-sm text-v2-mute">
            {owner.orgNumber} · {storesText(active.length)}
            {owner.archived ? (
              <>
                {" "}
                <StatusTag status="offline">Arkiverad</StatusTag>
              </>
            ) : null}
          </p>
        </div>
        {canEdit ? (
          <div className="max-md:absolute max-md:-top-1 max-md:-right-1">
            <OwnerActions owner={owner} />
          </div>
        ) : null}
      </div>
      <div>
        <p className="text-v2-xs font-[550] text-v2-mute">Butiker</p>
        {owner.stores.length === 0 ? (
          <p className="mt-1 text-v2-md text-v2-mute">
            Inga butiker än. Välj ägaren på butikens sida.
          </p>
        ) : (
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {owner.stores.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/butiker/${s.id}`}
                  className="rounded-xs text-v2-md text-v2-ink underline decoration-v2-line underline-offset-4 hover:decoration-v2-ink max-md:tap"
                >
                  {s.name}
                </Link>
                {s.archived ? <span className="text-sm text-subtle"> (arkiverad)</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <dl className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
        {facts(owner).map((f) => (
          <div
            key={f.label}
            className="flex min-w-0 items-baseline justify-between gap-4 border-b border-v2-line2 py-2 text-v2-md"
          >
            <dt className="shrink-0 text-v2-mute">{f.label}</dt>
            <dd className="min-w-0 text-right break-words text-v2-ink">
              {f.value ? (
                f.href ? (
                  <a href={f.href} className="rounded-xs hover:underline max-md:tap">
                    {f.value}
                  </a>
                ) : (
                  f.value
                )
              ) : (
                <span className="text-v2-faint">{MISSING}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {owner.note ? <p className="text-v2-sm text-v2-mute">{owner.note}</p> : null}
    </li>
  );
}

/**
 * Butiker → Butiksägare (?vy=agare): bolagen som äger butikerna, med deras uppgifter och
 * butiker. Ägare och admin lägger till, ändrar och arkiverar; läsaren ser samma sak.
 * En ägare med flera butiker blir ett val i filtret (statistik för alla butikerna).
 */
export async function OwnersView({ viewer, canEdit }: { viewer: Viewer; canEdit: boolean }) {
  const owners = await loadOwnersFor(viewer);
  const active = owners.filter((o) => !o.archived);
  const archived = owners.filter((o) => o.archived);
  const multi = active.filter((o) => o.stores.filter((s) => !s.archived).length > 1).length;
  return (
    <div className={PAGE_BODY}>
      <PageIntro
        title={
          active.length === 0
            ? "Inga butiksägare än."
            : active.length === 1
              ? "1 butiksägare."
              : `${active.length} butiksägare.`
        }
        aside={
          multi > 0
            ? `${multi === 1 ? "1 ägare har" : `${multi} ägare har`} flera butiker och kan väljas i filtret.`
            : "En ägare med flera butiker kan väljas i filtret, för statistik på alla butikerna."
        }
        actions={canEdit ? <AddOwnerButton /> : undefined}
      />
      {active.length === 0 ? (
        <StateMessage
          className="v2-card"
          kind="empty"
          code="0 ägare"
          message="Lägg till bolaget som äger butiken."
          detail="Organisationsnummer, moms, F-skatt och fakturaadress samlas här. Välj sedan ägaren på butikens sida."
        />
      ) : (
        <ul className="v2-stack">
          {active.map((o, i) => (
            <OwnerCard key={o.id} owner={o} canEdit={canEdit} i={i + 1} />
          ))}
        </ul>
      )}
      {archived.length > 0 ? (
        <details className="group">
          <summary className="flex min-h-11 cursor-pointer items-center text-v2-md font-[550] text-v2-mute hover:text-v2-ink">
            Arkiverade<span className="font-normal"> · {archived.length}</span>
          </summary>
          <ul className="v2-stack mt-2">
            {archived.map((o, i) => (
              <OwnerCard key={o.id} owner={o} canEdit={canEdit} i={i} />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
