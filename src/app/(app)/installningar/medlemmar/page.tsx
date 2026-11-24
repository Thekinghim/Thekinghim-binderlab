import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Badge, type BadgeTone } from "@/components/v2/badge";
import { ButtonLink } from "@/components/v2/button";
import { Card, CardBody } from "@/components/v2/card";
import { Notice } from "@/components/v2/notice";
import { V2Page } from "@/components/v2/shell/page";
import { SubNav } from "@/components/v2/sub-nav";
import { Table } from "@/components/v2/table";
import { loadMembersFor, memberStatusLabel } from "@/server/awish-catalog/members";
import { OPERATOR_ROLES, requireRoute, requireViewer } from "@/server/data/core";

import "../_components/settings.css";
import { MemberActions, NewMember } from "./_components/member-forms";

export const metadata: Metadata = { title: "Medlemmar" };
// Medlemsuppgifter läses direkt från Awish vid varje visning; inget sparas eller cachas.
export const dynamic = "force-dynamic";

const STATUS_TONE: Record<number, BadgeTone> = { 0: "neutral", 1: "success", 2: "warning" };

type SearchParams = Record<string, string | string[] | undefined>;

function pageNo(raw: string | string[] | undefined): number {
  const n = Number(typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : "1");
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/**
 * Inställningar → Medlemmar: Awish-kontots medlemmar, live och sidvis. Bara ägare och admin
 * (andra roller får 404, sidan syns inte i menyn för dem). En demo visar en ruta och
 * ansluter aldrig. Telefon och e-post visas som Awish maskar dem.
 */
export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await requireRoute("installningar");
  if (!(OPERATOR_ROLES as readonly string[]).includes(ctx.role)) notFound();
  const page = pageNo((await searchParams).sida);
  const data = await loadMembersFor(await requireViewer(), page);

  return (
    <V2Page
      title="Medlemmar"
      sub="Medlemsuppgifter sparas inte i Binderlab. De läses direkt från Awish."
    >
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
        <Card
          title="Medlemmar i Awish"
          count={data.page.total ?? data.page.items.length}
          actions={<NewMember />}
        >
          <Table
            caption="Medlemmar i Awish"
            rows={data.page.items}
            rowKey={(m) => m.id}
            empty="Inga medlemmar i Awish."
            columns={[
              {
                key: "namn",
                header: "Namn",
                cell: (m) => (
                  <>
                    <span className="font-[550]">{m.name || "Utan namn"}</span>
                    <span className="block text-v2-xs text-v2-mute">
                      {[m.telMasked, m.emailMasked].filter(Boolean).join(" · ")}
                    </span>
                  </>
                ),
              },
              { key: "nr", header: "Medlemsnr", hideOnPhone: true, cell: (m) => m.memberNo || "–" },
              {
                key: "status",
                header: "Status",
                cell: (m) => (
                  <Badge tone={STATUS_TONE[m.status] ?? "neutral"}>
                    {memberStatusLabel(m.status)}
                  </Badge>
                ),
              },
              { key: "saldo", header: "Saldo", align: "right", cell: (m) => m.totalBalance || "0" },
              {
                key: "reg",
                header: "Registrerad",
                hideOnPhone: true,
                cell: (m) => (m.registeredAt || "").slice(0, 10) || "–",
              },
              {
                key: "x",
                header: <span className="sr-only">Åtgärder</span>,
                align: "right",
                cell: (m) => (
                  <MemberActions
                    member={{
                      id: m.id,
                      name: m.name,
                      memberNo: m.memberNo,
                      status: m.status,
                      remark: m.remark,
                    }}
                  />
                ),
              },
            ]}
          />
          {page > 1 || data.page.hasMore || (data.page.lastPage ?? 1) > page ? (
            <CardBody className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-v2-sm text-v2-mute">Sida {page}</span>
              <div className="flex gap-2">
                {page > 1 ? (
                  <ButtonLink href={`/installningar/medlemmar?sida=${page - 1}`}>
                    Föregående
                  </ButtonLink>
                ) : null}
                {data.page.hasMore || (data.page.lastPage ?? 1) > page ? (
                  <ButtonLink href={`/installningar/medlemmar?sida=${page + 1}`}>Nästa</ButtonLink>
                ) : null}
              </div>
            </CardBody>
          ) : null}
        </Card>
      )}
    </V2Page>
  );
}
