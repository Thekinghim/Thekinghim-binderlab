"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { removeStoreUser, revokeStoreInvitation } from "@/server/portal/actions";

/**
 * Ta bort en butiksanvändare eller återkalla en väntande inbjudan, med
 * bekräftelse. Server actions kontrollerar rollen (owner/admin) och att raden
 * är en butiksanvändare för just den här butiken.
 */
export function RemoveStoreAccess({
  storeId,
  storeName,
  target,
}: {
  storeId: string;
  storeName: string;
  target:
    { kind: "user"; id: string; email: string } | { kind: "invitation"; id: string; email: string };
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const isUser = target.kind === "user";
  const verb = isUser ? "Ta bort" : "Återkalla";

  const confirm = () =>
    startTransition(async () => {
      const res = isUser
        ? await removeStoreUser({ storeId, membershipId: target.id })
        : await revokeStoreInvitation({ storeId, invitationId: target.id });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      toast({
        title: isUser ? "Tillgången är borttagen" : "Inbjudan är återkallad",
        tone: "ok",
        meta: target.email,
      });
      router.refresh();
    });

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        aria-label={`${verb} ${target.email}`}
      >
        {verb}
      </Button>
      <Modal
        open={open}
        onClose={() => (pending ? undefined : setOpen(false))}
        eyebrow="Butiker / Butiksportal"
        title={isUser ? `Ta bort ${target.email}?` : `Återkalla inbjudan till ${target.email}?`}
        description={
          isUser
            ? `${target.email} kan inte längre logga in i butiksportalen för ${storeName}. Tidigare felanmälningar finns kvar i Inkorgen.`
            : `Länken i mejlet slutar fungera. Du kan bjuda in igen när som helst.`
        }
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              Avbryt
            </Button>
            <Button variant="danger-confirm" loading={pending} onClick={confirm}>
              {verb}
            </Button>
          </>
        }
      >
        {error ? (
          <p role="alert" className="text-sm text-signal-fg">
            {error}
          </p>
        ) : null}
      </Modal>
    </>
  );
}
