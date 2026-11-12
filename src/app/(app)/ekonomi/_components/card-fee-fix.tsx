"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

import { applyStatementCardFee } from "../actions";
import { cardFeeHelp } from "../_lib/nayax";
import { FormError } from "./bits";

/**
 * "Nayax tar 4,0 % i kortavgift. Appen räknar med 0 %." med knappen "Ändra till 4,0 %".
 * Visas bara när rapportens kortavgift skiljer sig från inställningen; ändringen görs först
 * när ägaren trycker (satsen räknas på servern ur den sparade rapporten).
 */
export function CardFeeFix({
  payoutId,
  statementBp,
  settingBp,
}: {
  payoutId: string;
  statementBp: number | null;
  settingBp: number;
}) {
  const router = useRouter();
  const [done, setDone] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const help = cardFeeHelp(statementBp, settingBp);
  if (done) {
    return (
      <p role="status" className="text-sm text-fg">
        {done}
      </p>
    );
  }
  if (!help) return null;
  return (
    <div data-card-fee-fix className="flex flex-col gap-2">
      <p className="text-sm text-fg">{help.text}</p>
      <Button
        type="button"
        variant="secondary"
        className="min-h-11 self-start"
        loading={pending}
        onClick={() => {
          setError(undefined);
          startTransition(async () => {
            const res = await applyStatementCardFee({ payoutId }).catch(() => ({
              ok: false as const,
              error: "Ingen kontakt med servern. Försök igen.",
            }));
            if (!res.ok) {
              setError(res.error);
              return;
            }
            setDone(help.done);
            router.refresh();
          });
        }}
      >
        {help.button}
      </Button>
      <FormError message={error} />
    </div>
  );
}
