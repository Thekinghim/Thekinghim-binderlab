import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Card, CardBody } from "@/components/v2/card";
import { Notice } from "@/components/v2/notice";
import { V2Page } from "@/components/v2/shell/page";
import { Table } from "@/components/v2/table";
import { loadCategoriesPageFor } from "@/server/awish-catalog/categories";
import { OPERATOR_ROLES, requireRoute, requireViewer } from "@/server/data/core";

import { CategoryActions, NewCategory, SlotCategory } from "./_components/categories-ui";

export const metadata: Metadata = { title: "Kategorier" };
export const dynamic = "force-dynamic";

/**
 * Inköpspriser → Kategorier: kategorierna i Awish (flikarna på automatens skärm) och
 * kategori per fack. Ägare och admin; andra roller får 404. Demo ansluter aldrig.
 */
export default async function CategoriesPage() {
  const ctx = await requireRoute("inkopspriser");
  if (!(OPERATOR_ROLES as readonly string[]).includes(ctx.role)) notFound();
  const data = await loadCategoriesPageFor(await requireViewer());

  return (
    <V2Page title="Kategorier" sub="Kategorier syns som flikar på automatens skärm.">
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
            <Card title="Kategorier" count={data.categories.length} actions={<NewCategory />}>
              <Table
                caption="Kategorier i Awish"
                rows={data.categories}
                rowKey={(c) => c.id}
                empty="Inga kategorier än."
                columns={[
                  { key: "namn", header: "Namn", cell: (c) => c.title },
                  {
                    key: "x",
                    header: <span className="sr-only">Åtgärder</span>,
                    align: "right",
                    cell: (c) => <CategoryActions id={c.id} title={c.title} />,
                  },
                ]}
              />
            </Card>
          </div>
          <div className="v2-stack">
            <Card title="Kategori per fack">
              <CardBody>
                <SlotCategory
                  machines={data.machines.map((m) => ({
                    id: m.machineId,
                    label: m.code ? `${m.code} · ${m.name}` : m.name,
                  }))}
                  categories={data.categories.map((c) => ({ id: c.id, title: c.title }))}
                />
              </CardBody>
            </Card>
          </div>
        </div>
      )}
    </V2Page>
  );
}
