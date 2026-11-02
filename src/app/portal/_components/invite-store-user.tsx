"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { inviteStoreUser } from "@/server/portal/actions";

/**
 * Bjud in butiken till butiksportalen. Visas i StorePortalAccess
 * (store-portal-access.tsx) i butikens vy under /butiker (ägare och admin).
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
  const router = useRouter();
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
          if (res.ok) router.refresh();
          setState(
            res.ok
              ? { ok: true, message: `Inbjudan till butiksportalen är skickad till ${email}.` }
              : { ok: false, message: res.error },
          );
        });
      }}
    >
      <div className="flex flex-col items-start gap-3">
        <Input
          label="E-post till butiken"
          type="email"
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={state && !state.ok ? state.message : undefined}
          hint={`${storeName} ser bara sin egen försäljning, ersättning och sina rapporter.`}
          wrapperClassName="w-full"
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
