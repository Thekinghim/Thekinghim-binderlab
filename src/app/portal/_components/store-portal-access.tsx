import { StateMessage } from "@/components/ui/state-message";
import { StatusTag } from "@/components/ui/status-tag";
import { formatInt } from "@/lib/format";
import { loadStorePortalAccessFor, type StorePortalAccess } from "@/server/portal/access";
import { AuthorizationError, getActiveOrganization, getSessionUser } from "@/server/session";

import { InviteStoreUser } from "./invite-store-user";
import { RemoveStoreAccess } from "./store-portal-access-actions";
import { dateTimeText } from "./text";

/**
 * Butiksportalen för en butik i /butiker/[butik]: vem i butiken som har
 * tillgång, väntande inbjudningar och inbjudan av en ny butiksanvändare.
 *
 * Bara för ägare och admin: sektionen läser själv behörigheten
 * (loadStorePortalAccessFor → requireRoleFor) och visas inte alls för andra.
 * Montera den i butikens vy:
 *
 *   <StorePortalAccess index={5} storeId={store.id} storeName={store.name}
 *     defaultEmail={store.email} timeZone={ctx.timeZone} />
 */
export async function StorePortalAccess({
  storeId,
  storeName,
  defaultEmail,
  timeZone,
}: {
  index?: number;
  storeId: string;
  storeName: string;
  defaultEmail?: string | null;
  timeZone: string;
}) {
  const user = await getSessionUser();
  const org = user ? await getActiveOrganization() : null;
  if (!user || !org) return null;
  let access: StorePortalAccess;
  try {
    access = await loadStorePortalAccessFor(user, org.id, storeId);
  } catch (error) {
    if (error instanceof AuthorizationError) return null;
    throw error;
  }
  const { users, invitations } = access;
  const now = new Date();

  return (
    <section aria-labelledby="butiksportal" className="v2-card">
      <div className="v2-card-hd">
        <h2>Butiksportal</h2>
      </div>
      <div className="v2-card-body flex flex-col gap-5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 id="butiksportal" className="text-v2-md font-[550] text-balance text-v2-ink">
            {users.length === 0
              ? `Ingen i ${storeName} har tillgång till portalen.`
              : `${formatInt(users.length)} ${users.length === 1 ? "person" : "personer"} i butiken har tillgång till portalen.`}
          </h3>
          <p className="text-v2-sm text-v2-mute">
            Butiken ser sin försäljning, ersättning och godkända rapporter. Aldrig inköpspriser,
            marginal eller andra butiker.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-x-6 gap-y-6 lg:grid-cols-12">
          <div className="flex flex-col gap-3 lg:col-span-7">
            <p className="text-v2-sm font-[550] text-v2-ink">
              Tillgång
              <span className="ml-2 font-[450] text-v2-mute">
                {formatInt(users.length)} {users.length === 1 ? "aktiv" : "aktiva"} ·{" "}
                {formatInt(invitations.length)} väntande
              </span>
            </p>
            {users.length === 0 && invitations.length === 0 ? (
              <StateMessage
                kind="empty"
                compact
                message="Ingen är inbjuden än."
                detail="Bjud in butikens kontaktperson. Den som tar emot inbjudan ser bara den här butiken."
              />
            ) : (
              <ul className="flex flex-col border-t border-v2-line2">
                {users.map((u) => (
                  <li
                    key={u.membershipId}
                    className="flex items-center justify-between gap-4 border-b border-v2-line2 py-2.5"
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-v2-md text-v2-ink">
                        {u.displayName ?? u.email}
                      </span>
                      <span className="truncate text-v2-sm text-v2-mute">
                        {u.displayName ? `${u.email} · ` : ""}sedan{" "}
                        {dateTimeText(u.since, timeZone, now)}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <StatusTag status="ok">Aktiv</StatusTag>
                      <RemoveStoreAccess
                        storeId={storeId}
                        storeName={storeName}
                        target={{ kind: "user", id: u.membershipId, email: u.email }}
                      />
                    </div>
                  </li>
                ))}
                {invitations.map((i) => (
                  <li
                    key={i.invitationId}
                    className="flex items-center justify-between gap-4 border-b border-v2-line2 py-2.5"
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-v2-md text-v2-ink">{i.email}</span>
                      <span className="truncate text-v2-sm text-v2-mute">
                        Inbjuden {dateTimeText(i.invitedAt, timeZone, now)} · gäller till{" "}
                        {dateTimeText(i.expiresAt, timeZone, now)}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <StatusTag status="neutral">Väntar</StatusTag>
                      <RemoveStoreAccess
                        storeId={storeId}
                        storeName={storeName}
                        target={{ kind: "invitation", id: i.invitationId, email: i.email }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-col gap-3 lg:col-span-5">
            <p className="text-v2-sm font-[550] text-v2-ink">Bjud in</p>
            <InviteStoreUser storeId={storeId} storeName={storeName} defaultEmail={defaultEmail} />
          </div>
        </div>
      </div>
    </section>
  );
}
