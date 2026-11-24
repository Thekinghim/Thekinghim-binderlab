import Link from "next/link";
import { redirect } from "next/navigation";

import { requireStaff } from "@/server/staff/session";
import { loadStaffFill } from "@/server/staff/fill";

import { StaffFill } from "./_components/staff-fill";

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Påfyllarens enda skärm. En automat: direkt dit. Flera: stora knappar, en per automat
 * (?automat=<id>). Allt läses genom staff_fill_data (databasen kontrollerar automaten).
 */
export default async function StaffFillPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const staff = await requireStaff();
  if (staff.mustChangePin) redirect("/pafyll/ny-pin");
  const params = await searchParams;
  const chosen = typeof params.automat === "string" ? params.automat : undefined;
  const machine =
    staff.machines.find((m) => m.machineId === chosen) ??
    (staff.machines.length === 1 ? staff.machines[0] : undefined);

  if (staff.machines.length === 0) {
    return (
      <div className="v2-card mt-4">
        <div className="v2-card-body">
          <h1 className="text-v2-lg font-semibold">Ingen automat att fylla på</h1>
          <p className="mt-2 text-v2-mute">Fråga den som gav dig kontot.</p>
        </div>
      </div>
    );
  }

  if (!machine) {
    return (
      <>
        <h1 className="mt-4 mb-3 text-v2-lg font-semibold">Vilken automat fyller du på?</h1>
        <ul className="flex flex-col gap-3">
          {staff.machines.map((m) => (
            <li key={m.machineId}>
              <Link
                href={`/pafyll?automat=${m.machineId}`}
                className="v2-card flex min-h-14 items-center justify-between px-4 py-3"
              >
                <span>
                  <b className="block">{m.storeName ?? m.name}</b>
                  <span className="text-v2-sm text-v2-mute">Automat {m.code}</span>
                </span>
                <span aria-hidden="true">→</span>
              </Link>
            </li>
          ))}
        </ul>
      </>
    );
  }

  const data = await loadStaffFill(staff.user, machine.organizationId, machine.machineId);
  return (
    <StaffFill
      key={machine.machineId}
      data={data}
      orgId={machine.organizationId}
      backHref={staff.machines.length > 1 ? "/pafyll" : null}
    />
  );
}
