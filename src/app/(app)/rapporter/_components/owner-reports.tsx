"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { StateMessage } from "@/components/ui/state-message";
import { useToast } from "@/components/ui/toast";

import { createOwnerReports } from "../owner-actions";

/** En butiksägare med de butiker som kan få en rapport för perioden. */
export type OwnerReportChoice = {
  id: string;
  name: string;
  stores: ReadonlyArray<{ id: string; name: string }>;
};

/**
 * "Alla butiker hos en ägare": skapar en vanlig butiksrapport (utkast) per butik i ett svep,
 * med samma månad eller eget datum och samma hälsning som formuläret bredvid.
 */
export function OwnerReports({
  owners,
  month,
  range,
  greeting,
  disabled,
}: {
  owners: readonly OwnerReportChoice[];
  month: string;
  range: { start: string; end: string } | null;
  greeting: string;
  /** Datumet är ändrat men inte visat än (som "Skapa utkast"). */
  disabled: boolean;
}) {
  const [ownerId, setOwnerId] = useState(owners[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const owner = owners.find((o) => o.id === ownerId) ?? null;
  if (owners.length === 0) return null;
  const create = () =>
    startTransition(async () => {
      setError(null);
      const r = await createOwnerReports({
        ownerId,
        month: range ? range.start.slice(0, 7) : month,
        from: range?.start ?? null,
        to: range?.end ?? null,
        greeting,
        storeIds: owner?.stores.map((s) => s.id) ?? [],
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast({ title: r.data.title, description: r.data.description, tone: "ok" });
      router.refresh();
    });
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4" data-owner-reports>
      <Select
        label="En rapport per butik hos ägaren"
        value={ownerId}
        onChange={(e) => setOwnerId(e.target.value)}
        options={owners.map((o) => ({
          value: o.id,
          label: `${o.name} (${o.stores.length} butiker)`,
        }))}
      />
      {owner ? (
        <p className="text-sm text-muted">{owner.stores.map((s) => s.name).join(", ")}.</p>
      ) : null}
      <div>
        <Button
          variant="secondary"
          onClick={create}
          loading={pending}
          disabled={disabled || !owner}
          iconLeft="plus"
        >
          {owner ? `Skapa ${owner.stores.length} utkast` : "Skapa utkast"}
        </Button>
      </div>
      {error ? <StateMessage kind="error" compact message={error} className="px-0" /> : null}
    </div>
  );
}
