import { sql } from "drizzle-orm";

import { ButtonLink } from "@/components/v2/button";
import { getServiceDb } from "@/db/client";
import { safeErrorForLog } from "@/server/errors";

/** "Styr" på automatens sida, bara när automaten är kopplad till Awish API. */
export async function StyrLink({
  orgId,
  machineId,
  code,
}: {
  orgId: string;
  machineId: string;
  code: string;
}) {
  let linked = false;
  try {
    const rows = await getServiceDb().execute(
      sql`select 1 from public.source_machines sm
          join public.data_sources ds
            on ds.organization_id = sm.organization_id and ds.id = sm.data_source_id
          where sm.organization_id = ${orgId}::uuid and sm.machine_id = ${machineId}::uuid
            and ds.provider = 'awish_grpc' and ds.archived_at is null
            and sm.external_id ~ '^[0-9]{1,20}$'
          limit 1`,
    );
    linked = Array.from(rows).length > 0;
  } catch (error) {
    console.error("[styr-länk]", safeErrorForLog(error));
  }
  if (!linked) return null;
  return (
    <ButtonLink href={`/automater/${encodeURIComponent(code.toLowerCase())}/styr`} touch>
      Styr
    </ButtonLink>
  );
}
