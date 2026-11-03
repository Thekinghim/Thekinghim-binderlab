"use client";

/**
 * Valen för scenarierna. Valen ligger i URL:en (?lik= &inkop= … &titel= &andring= …), så att
 * ett scenario går att länka till och sidan räknar på servern. Skalets period och filter
 * följer med.
 */

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";

type Option = { value: string; label: string };

function useScenarioSubmit(keys: readonly string[], anchor: string) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const submit = (values: Record<string, string>) => {
    const q = new URLSearchParams(sp.toString());
    for (const k of keys) {
      const v = (values[k] ?? "").trim();
      if (v) q.set(k, v);
      else q.delete(k);
    }
    start(() => router.push(`${pathname}?${q.toString()}#${anchor}`, { scroll: false }));
  };
  return { pending, submit };
}

export function NewMachineForm({
  stores,
  initial,
  errors,
  placeholders,
}: {
  stores: Option[];
  initial: { lik: string; inkop: string; installation: string; provision: string; hyra: string };
  errors: Record<string, string>;
  placeholders: { inkop: string; installation: string };
}) {
  const [v, setV] = useState(initial);
  const { pending, submit } = useScenarioSubmit(
    ["lik", "inkop", "installation", "provision", "hyra"],
    "ny-automat",
  );
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) =>
    setV((p) => ({ ...p, [k]: e.target.value }));
  return (
    <form
      noValidate
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        submit(v);
      }}
      className="grid grid-cols-1 items-end gap-4 sm:grid-cols-2 lg:grid-cols-6"
      aria-label="Scenario: ny automat"
    >
      <Select
        label="Ny plats"
        wrapperClassName="sm:col-span-2"
        value={v.lik}
        onChange={set("lik")}
        options={stores}
      />
      <Input
        label="Automat"
        suffix="kr"
        inputMode="decimal"
        className="tnum text-right"
        placeholder={placeholders.inkop}
        value={v.inkop}
        onChange={set("inkop")}
        error={errors.inkop}
      />
      <Input
        label="Installation"
        suffix="kr"
        inputMode="decimal"
        className="tnum text-right"
        placeholder={placeholders.installation}
        value={v.installation}
        onChange={set("installation")}
        error={errors.installation}
      />
      <Input
        label="Provision"
        suffix="%"
        inputMode="decimal"
        className="tnum text-right"
        placeholder="som platserna"
        value={v.provision}
        onChange={set("provision")}
        error={errors.provision}
      />
      <Input
        label="Hyra per månad"
        suffix="kr"
        inputMode="decimal"
        className="tnum text-right"
        placeholder="som platserna"
        value={v.hyra}
        onChange={set("hyra")}
        error={errors.hyra}
      />
      <div className="flex gap-2 sm:col-span-2 lg:col-span-6">
        <Button type="submit" variant="secondary" loading={pending}>
          Räkna
        </Button>
      </div>
    </form>
  );
}

export function PriceChangeForm({
  titles,
  initial,
  errors,
}: {
  titles: Option[];
  initial: { titel: string; andring: string; elasticitet: string };
  errors: Record<string, string>;
}) {
  const [v, setV] = useState(initial);
  const { pending, submit } = useScenarioSubmit(["titel", "andring", "elasticitet"], "prisandring");
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) =>
    setV((p) => ({ ...p, [k]: e.target.value }));
  return (
    <form
      noValidate
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        submit(v);
      }}
      className="grid grid-cols-1 items-end gap-4 sm:grid-cols-2 lg:grid-cols-6"
      aria-label="Scenario: prisändring"
    >
      <Select
        label="Titel"
        wrapperClassName="sm:col-span-2 lg:col-span-3"
        value={v.titel}
        onChange={set("titel")}
        options={titles}
      />
      <Input
        label="Ändring per pack"
        suffix="kr"
        inputMode="text"
        className="tnum text-right"
        hint="Negativt för sänkning, t.ex. −5."
        value={v.andring}
        onChange={set("andring")}
        error={errors.andring}
      />
      <Input
        label="Elasticitet"
        inputMode="text"
        className="tnum text-right"
        hint="0 = lika många pack. −1,5 = 1,5 % färre pack per % dyrare."
        value={v.elasticitet}
        onChange={set("elasticitet")}
        error={errors.elasticitet}
      />
      <div className="flex items-end">
        <Button type="submit" variant="secondary" loading={pending}>
          Räkna
        </Button>
      </div>
    </form>
  );
}
