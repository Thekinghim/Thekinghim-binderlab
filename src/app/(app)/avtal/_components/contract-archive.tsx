"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";

import { DialogButtons } from "../../ekonomi/_components/bits";
import { archiveContract } from "../actions";

/**
 * Arkivera ett avtal (t.ex. ett felregistrerat) eller återställ ett arkiverat. Ett arkiverat
 * avtal ger inga påminnelser och räknas inte i översikten. Det raderas aldrig; ändringen loggas.
 */
export function ContractArchive({
  id,
  label,
  archived,
}: {
  id: string;
  label: string;
  archived: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const run = () =>
    startTransition(async () => {
      const res = await archiveContract({ id, archived: !archived });
      if (!res.ok) {
        toast({
          title: archived ? "Avtalet återställdes inte" : "Avtalet arkiverades inte",
          description: res.error,
          tone: "critical",
        });
        return;
      }
      toast({
        title: archived ? "Avtalet återställt" : "Avtalet arkiverat",
        description: label,
        tone: "ok",
      });
      setOpen(false);
      router.refresh();
    });

  if (archived) {
    return (
      <Button size="sm" variant="ghost" loading={pending} onClick={run}>
        Återställ
      </Button>
    );
  }
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Arkivera
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        eyebrow="Avtal"
        title="Arkivera avtalet"
        description={`${label}. Inga fler påminnelser. Kan återställas.`}
      >
        <DialogButtons>
          <Button type="button" onClick={() => setOpen(false)}>
            Avbryt
          </Button>
          <Button type="button" variant="primary" loading={pending} onClick={run}>
            Arkivera
          </Button>
        </DialogButtons>
      </Modal>
    </>
  );
}
