"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { inviteStoreUser } from "@/server/portal/actions";

/**
 * Bjud in butiken till butiksportalen. Avsedd för /butiker (ägare och admin),
 * t.ex. i butikens detaljvy:
 *
 *   import { InviteStoreUser } from "@/app/portal/_components/invite-store-user";
 *   <InviteStoreUser storeId={store.id} storeName={store.name} defaultEmail={store.email} />
 *
 * Server action inviteStoreUser kontrollerar rollen (requireRole owner/admin) och
 * create_store_invitation i databasen kontrollerar den igen och att butiken hör
 * till organisationen. Mottagaren får en länk till /inbjudan/[token] och hamnar
 * sedan i /portal med rollen store, kopplad till just den här butiken.
 */
export function InviteStoreUser({
  storeId,
  storeName,
  defaultEmail,
}: {
  storeId: string;
  storeName: string;
  defaultEmail?: string | null;
}) {
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const res = await inviteStoreUser({ storeId, email });
          setState(
            res.ok
              ? { ok: true, message: `Inbjudan till butiksportalen är skickad till ${email}.` }
              : { ok: false, message: res.error },
          );
        });
      }}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Input
          label="E-post till butiken"
          type="email"
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={state && !state.ok ? state.message : undefined}
          hint={`${storeName} ser bara sin egen försäljning, ersättning och sina rapporter.`}
          wrapperClassName="flex-1"
          required
        />
        <Button type="submit" loading={pending}>
          Bjud in till portalen
        </Button>
      </div>
      <p role="status" aria-live="polite" className="text-sm text-fg">
        {state?.ok ? state.message : null}
      </p>
    </form>
  );
}
