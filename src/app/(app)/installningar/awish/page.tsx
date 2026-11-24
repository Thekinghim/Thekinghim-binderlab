import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Badge } from "@/components/v2/badge";
import { Card, CardBody } from "@/components/v2/card";
import { KeyValues } from "@/components/v2/key-values";
import { Notice } from "@/components/v2/notice";
import { V2Page } from "@/components/v2/shell/page";
import { SubNav } from "@/components/v2/sub-nav";
import { currencyLabel } from "@/server/awish-catalog/currencies";
import { loadAwishAccountFor } from "@/server/awish-catalog/merchant";
import { OPERATOR_ROLES, requireRoute, requireViewer } from "@/server/data/core";

import "../_components/settings.css";
import { TimezoneButton } from "./_components/timezone-button";

export const metadata: Metadata = { title: "Awish-kontot" };

/** "2027-04-18 23:48:54" → "18 apr. 2027" (bara datumet, som Awish skickar det). */
function dayOf(raw: string | null): string {
  if (!raw) return "Okänt";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!m) return raw;
  const months = [
    "jan.",
    "feb.",
    "mars",
    "apr.",
    "maj",
    "juni",
    "juli",
    "aug.",
    "sep.",
    "okt.",
    "nov.",
    "dec.",
  ];
  return `${Number(m[3])} ${months[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/**
 * Inställningar → Awish: Awish-kontot som Awish ser det (läses direkt, sparas inte). Ägare
 * och admin; andra roller får 404. En demo visar en ruta och ansluter aldrig.
 */
export default async function AwishAccountPage() {
  const ctx = await requireRoute("installningar");
  if (!(OPERATOR_ROLES as readonly string[]).includes(ctx.role)) notFound();
  const data = await loadAwishAccountFor(await requireViewer());

  return (
    <V2Page title="Awish-kontot" sub="Läses direkt från Awish.">
      <SubNav />
      {data.status === "demo" ? (
        <Notice tone="info" title="Demo">
          {data.message}
        </Notice>
      ) : data.status === "error" ? (
        <Notice tone="critical" title="Awish gick inte att läsa.">
          {data.message}
        </Notice>
      ) : (
        <div className="v2-cols">
          <div className="v2-stack">
            <Card title="Kontot">
              <CardBody>
                <KeyValues
                  items={[
                    { label: "Namn", value: data.merchant.title || "Utan namn" },
                    { label: "Giltig till", value: dayOf(data.merchant.expiredAt) },
                    {
                      label: "Moms i Awish",
                      value:
                        data.merchant.taxEnabled === null
                          ? "Okänt"
                          : data.merchant.taxEnabled
                            ? "På"
                            : "Av",
                    },
                  ]}
                />
              </CardBody>
            </Card>

            <Card
              title="Tidszon"
              actions={
                data.timezoneMatches ? (
                  <Badge tone="success">Stämmer</Badge>
                ) : (
                  <Badge tone="warning">Fel tidszon</Badge>
                )
              }
            >
              <CardBody className="flex flex-col gap-3">
                <p className="st-p">
                  Awish räknar tid i <b>{data.merchant.timezone ?? "okänd tidszon"}</b>.
                  {data.timezoneMatches
                    ? " Samma som Binderlab."
                    : ` Binderlab räknar i ${data.wantedTimezone}. Strömscheman och rapporter i Awish följer kontots tidszon.`}
                </p>
                {data.timezoneMatches ? null : <TimezoneButton wanted={data.wantedTimezone} />}
              </CardBody>
            </Card>
          </div>

          <div className="v2-stack">
            <Card title="Valutor" count={data.currencies.length}>
              <CardBody>
                {data.currencies.length === 0 ? (
                  <p className="st-p">Inga valutor i Awish.</p>
                ) : (
                  <p className="st-p">{data.currencies.map(currencyLabel).join(", ")}</p>
                )}
              </CardBody>
            </Card>

            <Card title="IP-lista">
              <CardBody className="flex flex-col gap-2">
                {data.merchant.whitelistIp ? (
                  <>
                    <p className="st-p break-words">
                      <code>{data.merchant.whitelistIp}</code>
                    </p>
                    <p className="st-p">
                      Awish svarar bara dessa adresser. Binderlab kör hos Vercel med skiftande
                      adresser, så en lista kan stoppa synken.
                    </p>
                  </>
                ) : (
                  <p className="st-p">Ingen lista. Awish svarar alla adresser.</p>
                )}
              </CardBody>
            </Card>
          </div>
        </div>
      )}
    </V2Page>
  );
}
