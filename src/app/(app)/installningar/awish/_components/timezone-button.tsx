"use client";

import { Button } from "@/components/ui/button";

import { applyTimezone, previewTimezone } from "../actions";
import { PreviewDialog, usePreviewFlow } from "./preview-dialog";

/** "Byt till Europe/Stockholm": förhandsvisning, bekräftelse, sedan UpdateMerchant. */
export function TimezoneButton({ wanted }: { wanted: string }) {
  const flow = usePreviewFlow({
    preview: () => previewTimezone(),
    apply: (p) => applyTimezone(p),
  });
  return (
    <>
      <div>
        <Button
          variant="secondary"
          loading={flow.pending && !flow.preview}
          onClick={() => flow.open({})}
        >
          Byt till {wanted}
        </Button>
      </div>
      <PreviewDialog flow={flow} title="Byt tidszon i Awish?" confirmLabel="Byt tidszon" />
    </>
  );
}
