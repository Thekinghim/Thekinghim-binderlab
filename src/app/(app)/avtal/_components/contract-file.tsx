"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

import { uploadContractFile } from "../actions";

/** Bifoga (eller byt) avtalsfilen. Filtypen kontrolleras på servern mot innehållet. */
export function ContractFileUpload({
  contractId,
  hasFile,
}: {
  contractId: string;
  hasFile: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();

  const upload = (file: File) => {
    const form = new FormData();
    form.set("contractId", contractId);
    form.set("file", file);
    startTransition(async () => {
      const res = await uploadContractFile(form);
      if (!res.ok) {
        setError(res.error);
        toast({ title: "Filen sparades inte", description: res.error, tone: "critical" });
        return;
      }
      setError(undefined);
      toast({ title: "Avtalsfilen bifogad", description: res.data.fileName, tone: "ok" });
      router.refresh();
    });
  };

  return (
    <span className="inline-flex flex-col gap-1">
      <input
        ref={input}
        id={id}
        type="file"
        className="sr-only"
        tabIndex={-1}
        accept=".pdf,.png,.jpg,.jpeg,.docx,application/pdf,image/png,image/jpeg"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) upload(file);
          e.target.value = "";
        }}
      />
      <Button size="sm" variant="ghost" loading={pending} onClick={() => input.current?.click()}>
        {hasFile ? "Byt fil" : "Bifoga fil"}
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-signal-fg">
          {error}
        </span>
      ) : null}
    </span>
  );
}
