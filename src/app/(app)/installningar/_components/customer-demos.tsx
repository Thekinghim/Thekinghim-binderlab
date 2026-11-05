"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { FormError } from "@/app/logga-in/form-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { StatusTag } from "@/components/ui/status-tag";
import { useToast } from "@/components/ui/toast";

import {
  continueCustomerDemo,
  createCustomerDemo,
  deleteCustomerDemo,
  resendCustomerDemoInvite,
  resetCustomerDemo,
} from "../_actions/demo";

export interface CustomerDemoRow {
  readonly id: string;
  readonly customerEmail: string;
  readonly status: "creating" | "ready" | "failed";
  readonly step: number;
  readonly steps: number;
  readonly createdLabel: string;
  readonly accepted: boolean;
}

interface Busy {
  id: string;
  label: string;
  step: number;
  steps: number;
}

/**
 * Demo för kunder: kundens e-post → en egen demo med påhittad data, och kunden bjuds in
 * som ägare. Demon byggs i steg; sidan anropar servern tills den är klar och visar hur
 * långt den kommit. Avbröts det (sidan stängdes) fortsätter Fortsätt där det slutade. Bara ägaren i en riktig organisation ser det här.
 */
export function CustomerDemos({ demos }: { demos: readonly CustomerDemoRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<Busy | null>(null);
  const [pending, startTransition] = useTransition();

  const build = async (id: string, label: string) => {
    setBusy({ id, label, step: 0, steps: 0 });
    for (let round = 0; round < 40; round++) {
      const r = await continueCustomerDemo({ demoId: id });
      if (!r.ok) {
        setBusy(null);
        setError(r.error);
        router.refresh();
        return;
      }
      const p = r.data;
      setBusy({ id, label, step: p?.step ?? 0, steps: p?.steps ?? 0 });
      if (p?.status === "ready") {
        setBusy(null);
        toast({
          title: "Demon är klar",
          description:
            p.emailSent === false
              ? "Mejlet gick inte iväg. Tryck på Bjud in igen."
              : p.emailSent
                ? "Kunden har fått en inbjudan."
                : "Kunden är kvar i demon.",
          tone: p.emailSent === false ? "critical" : "ok",
        });
        router.refresh();
        return;
      }
    }
    setBusy(null);
    router.refresh();
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(undefined);
    startTransition(async () => {
      const r = await createCustomerDemo({ email });
      if (!r.ok || !r.data) {
        setError(r.ok ? "Något gick fel." : r.error);
        return;
      }
      const label = email.trim();
      setEmail("");
      await build(r.data.id, label);
    });
  };

  const run = (fn: () => Promise<void>) => {
    setError(undefined);
    startTransition(fn);
  };

  const invite = (d: CustomerDemoRow) =>
    run(async () => {
      const r = await resendCustomerDemoInvite({ demoId: d.id });
      if (!r.ok) return setError(r.error);
      toast({
        title: r.data?.emailSent ? "Ny inbjudan skickad" : "Mejlet gick inte iväg",
        description: d.customerEmail,
        tone: r.data?.emailSent ? "ok" : "critical",
      });
      router.refresh();
    });

  const reset = (d: CustomerDemoRow) => {
    if (
      !window.confirm(`Återställa demon för ${d.customerEmail}? Allt kunden ändrat försvinner.`)
    ) {
      return;
    }
    run(async () => {
      const r = await resetCustomerDemo({ demoId: d.id });
      if (!r.ok) return setError(r.error);
      await build(d.id, d.customerEmail);
    });
  };

  const remove = (d: CustomerDemoRow) => {
    if (!window.confirm(`Ta bort demon för ${d.customerEmail}? Kunden kommer inte in längre.`)) {
      return;
    }
    run(async () => {
      const r = await deleteCustomerDemo({ demoId: d.id });
      if (!r.ok) return setError(r.error);
      toast({ title: "Demon borttagen", description: d.customerEmail, tone: "neutral" });
      router.refresh();
    });
  };

  const locked = pending || busy !== null;

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={submit}
        noValidate
        aria-label="Ny demo"
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
      >
        <Input
          label="Kundens e-post"
          name="customerEmail"
          type="email"
          inputMode="email"
          autoComplete="off"
          placeholder="kund@foretag.dk"
          value={email}
          wrapperClassName="sm:flex-1 sm:max-w-md"
          onChange={(e) => {
            setEmail(e.target.value);
            setError(undefined);
          }}
        />
        <Button type="submit" variant="primary" loading={pending && !busy} disabled={locked}>
          Skapa demo och bjud in
        </Button>
      </form>
      <p className="text-sm text-muted">
        Kunden får en egen påhittad organisation och blir ägare där. Inget från er syns, och inget
        skickas ut från demon.
      </p>
      {busy ? (
        <p role="status" aria-live="polite" className="tnum text-base text-fg">
          Skapar demo för {busy.label} …{" "}
          {busy.steps > 0 ? `${busy.step} av ${busy.steps} steg` : "kontona först"}
        </p>
      ) : null}
      <FormError message={error} />

      {demos.length > 0 ? (
        <ul className="flex flex-col" aria-label="Demos">
          {demos.map((d) => (
            <li
              key={d.id}
              className="flex flex-col gap-3 border-t border-line py-3 last:border-b md:flex-row md:items-center md:justify-between"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-fg">{d.customerEmail}</span>
                <span className="meta text-muted">Skapad {d.createdLabel}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {d.status === "failed" ? (
                  <StatusTag status="critical">Misslyckades</StatusTag>
                ) : d.status === "creating" ? (
                  <StatusTag status="warning">Skapas</StatusTag>
                ) : d.accepted ? (
                  <StatusTag status="ok">Kunden är med</StatusTag>
                ) : (
                  <StatusTag status="neutral">Inbjuden</StatusTag>
                )}
                {d.status === "creating" ? (
                  <Button
                    size="sm"
                    disabled={locked}
                    onClick={() => run(() => build(d.id, d.customerEmail))}
                  >
                    Fortsätt
                  </Button>
                ) : null}
                {d.status === "ready" && !d.accepted ? (
                  <Button size="sm" disabled={locked} onClick={() => invite(d)}>
                    Bjud in igen
                  </Button>
                ) : null}
                <Button size="sm" disabled={locked} onClick={() => reset(d)}>
                  Återställ
                </Button>
                <Button size="sm" variant="danger" disabled={locked} onClick={() => remove(d)}>
                  Ta bort
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
