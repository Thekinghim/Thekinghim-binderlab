"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/v2/button";
import { Sheet } from "@/components/v2/sheet";
import { toastV2 } from "@/components/v2/toast";
import { formatInt } from "@/lib/format";

import { correctProductSwap } from "../actions";

/**
 * "Det var ett produktbyte" på en svinnrad (ägare och admin). Frågar i ett ark först: packen
 * flyttas tillbaka till lagret strax före räkningen, så att svinnet försvinner.
 */
export function SwapButton({
  machineId,
  titleId,
  titleName,
  missing,
}: {
  machineId: string;
  titleId: string;
  titleName: string;
  missing: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        setOpen(o);
        setError(null);
      }}
      title="Det var ett produktbyte?"
      description={`${formatInt(missing)} pack ${titleName} togs ut när facket fick en annan vara.`}
      trigger={
        <button
          type="button"
          className="text-v2-sm text-v2-mute underline underline-offset-4 hover:text-v2-ink"
        >
          Det var ett produktbyte
        </button>
      }
      footer={
        <>
          <Button onClick={() => setOpen(false)} disabled={busy}>
            Avbryt
          </Button>
          <Button
            variant="act"
            pending={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              const res = await correctProductSwap({ machineId, titleId, quantity: missing }).catch(
                () => ({ ok: false as const, error: "Ingen kontakt. Försök igen." }),
              );
              setBusy(false);
              if (!res.ok) {
                setError(res.error);
                return;
              }
              setOpen(false);
              toastV2(`${formatInt(missing)} pack tillbaka i lagret`, {
                detail: `${titleName} räknas inte längre som svinn.`,
              });
              router.refresh();
            }}
          >
            Ja, flytta tillbaka
          </Button>
        </>
      }
    >
      <p className="text-v2-md text-v2-mute">
        Packen flyttas tillbaka till automatens lager (Fylls på från) med tiden strax före
        räkningen. Inget ändras i Awish.
      </p>
      {error ? (
        <p role="alert" className="mt-3 text-v2-sm text-v2-crit-text">
          {error}
        </p>
      ) : null}
    </Sheet>
  );
}
