"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/v2/button";
import { Field, Input, Select } from "@/components/v2/field";
import { toastV2 } from "@/components/v2/toast";

import {
  removePartnerAgreement,
  savePartnerAgreement,
  savePayoutOptions,
} from "../../pengar/utbetalningar/actions";

export interface PartnerAgreementRow {
  readonly id: string;
  readonly partnerName: string;
  readonly reimburseCost: boolean;
  readonly profitShareBp: number;
  readonly validFrom: string;
}

/**
 * Partneravtalet (Inställningar): partnerns namn, om inköpet betalas tillbaka, andelen av
 * vinsten och dagen det gäller från. Ett nytt avtal från en dag ersätter det gamla från den
 * dagen; redan betalda utbetalningar ändras inte. Dessutom momsen att spara och påminnelsen.
 */
export function PartnerForm({
  agreements,
  vatReserveMode,
  reminderDays,
  today,
}: {
  agreements: readonly PartnerAgreementRow[];
  vatReserveMode: string;
  reminderDays: number;
  today: string;
}) {
  const router = useRouter();
  const current = agreements[0];
  const [name, setName] = useState(current?.partnerName ?? "");
  const [reimburse, setReimburse] = useState(current?.reimburseCost ?? true);
  const [share, setShare] = useState(
    String((current?.profitShareBp ?? 5000) / 100).replace(".", ","),
  );
  const [from, setFrom] = useState(current?.validFrom ?? today.slice(0, 8) + "01");
  const [mode, setMode] = useState(vatReserveMode);
  const [days, setDays] = useState(String(reminderDays));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      setError(null);
      const pct = Number(share.replace(",", "."));
      const res = await savePartnerAgreement({
        partnerName: name,
        reimburseCost: reimburse,
        profitSharePercent: pct,
        validFrom: from,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const opt = await savePayoutOptions({
        vatReserveMode: mode,
        reminderDays: Number(days) || 0,
      });
      if (!opt.ok) {
        setError(opt.error);
        return;
      }
      router.refresh();
      toastV2("Partneravtalet är sparat", { detail: "Obetalda utbetalningar räknas om." });
    });

  return (
    <div className="flex flex-col gap-4" data-testid="partner-form">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Partnerns namn">
          {(p) => (
            <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
          )}
        </Field>
        <Field label="Gäller från">
          {(p) => (
            <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          )}
        </Field>
        <Field
          label="Andel av vinsten"
          hint="Vinsten efter butikerna, inköpet, avgifterna och momsen."
        >
          {(p) => (
            <Input
              {...p}
              inputMode="decimal"
              suffix="%"
              value={share}
              onChange={(e) => setShare(e.target.value)}
            />
          )}
        </Field>
        <Field label="Får tillbaka inköpet">
          {(p) => (
            <Select
              {...p}
              value={reimburse ? "ja" : "nej"}
              onChange={(e) => setReimburse(e.target.value === "ja")}
            >
              <option value="ja">Ja, för varje sålt paket</option>
              <option value="nej">Nej</option>
            </Select>
          )}
        </Field>
        <Field label="Moms att spara">
          {(p) => (
            <Select {...p} value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="auto">Automatiskt (som bokföringen)</option>
              <option value="vmb">Moms på vinsten</option>
              <option value="standard">Moms på försäljningen</option>
              <option value="none">Ingen</option>
            </Select>
          )}
        </Field>
        <Field label="Påminn mig efter" hint="0 = ingen påminnelse.">
          {(p) => (
            <Input
              {...p}
              inputMode="numeric"
              suffix="dagar"
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          )}
        </Field>
      </div>
      {error ? (
        <p role="alert" className="text-[color:var(--v2-crit-text)]">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="act" size="lg" pending={pending} onClick={save}>
          Spara
        </Button>
        {current ? (
          <Button
            size="lg"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await removePartnerAgreement(current.id);
                if (!r.ok) setError(r.error);
                router.refresh();
              })
            }
          >
            Ta bort avtalet från {current.validFrom}
          </Button>
        ) : null}
      </div>
      {agreements.length > 1 ? (
        <p className="st-p">
          Tidigare:{" "}
          {agreements
            .slice(1)
            .map((a) => `${a.partnerName} ${a.profitShareBp / 100} % från ${a.validFrom}`)
            .join(" · ")}
        </p>
      ) : null}
    </div>
  );
}
