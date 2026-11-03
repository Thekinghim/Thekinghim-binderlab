"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import type { ContractStatus } from "@/server/contracts/plan";

import { setContractStatus } from "../actions";
import { ContractFileUpload } from "./contract-file";

/**
 * Nästa steg för ett avtal från mallen: utkast → "Markera skickat"; skickat → ladda upp
 * den signerade kopian (eller "Signerat utan fil"); signerat → inget.
 */
export function ContractNextStep({
  contractId,
  status,
  hasFile,
}: {
  contractId: string;
  status: ContractStatus;
  hasFile: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  const set = (next: ContractStatus, title: string) =>
    startTransition(async () => {
      const res = await setContractStatus({ id: contractId, status: next });
      if (!res.ok) {
        toast({ title: "Statusen ändrades inte", description: res.error, tone: "critical" });
        return;
      }
      toast({ title, tone: "ok" });
      router.refresh();
    });

  if (status === "signed") return null;
  if (status === "draft") {
    return (
      <Button
        size="sm"
        variant="secondary"
        loading={pending}
        onClick={() => set("sent", "Skickat")}
      >
        Markera skickat
      </Button>
    );
  }
  return (
    <>
      <ContractFileUpload contractId={contractId} hasFile={hasFile} signed />
      <Button
        size="sm"
        variant="ghost"
        loading={pending}
        onClick={() => set("signed", "Avtalet signerat")}
      >
        Signerat utan fil
      </Button>
    </>
  );
}
