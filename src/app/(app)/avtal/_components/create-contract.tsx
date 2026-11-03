"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { contractHtml, type ContractParty } from "@/reports/contract-pdf";

import { FormError } from "../../ekonomi/_components/bits";
import { createContract, setContractStatus } from "../actions";
import {
  checkTerms,
  DEFAULT_TERMS,
  previewHtml,
  termsPayload,
  type TermsDraft,
} from "../_lib/terms";
import { SignOnSite } from "./sign-on-site";
import { TermsFields } from "./terms-fields";

export interface CreateContractOption {
  readonly value: string;
  readonly label: string;
  /** Startdagen som skriver om butikens felaktiga villkor (andel av försäljningen). */
  readonly suggestedFrom?: string | null;
  /** Butikens uppgifter i kontraktet (förhandsvisningen). */
  readonly party?: ContractParty;
}

const STEPS = ["Butik", "Villkor", "Se kontraktet", "Klart"] as const;

type TermsError = { message: string; field: "share" | "rent" | "special" };

/**
 * Skapa kontrakt i ett flöde: butik → villkor (snabbval) → se kontraktet (PDF:en som
 * förhandsvisning) → klart (ladda ner, signera på plats eller markera som signerat).
 * Kontraktet, villkoren och PDF:en sparas på servern i steg 3.
 */
export function CreateContract({
  options,
  operator,
  today,
  initialTarget,
  autoOpen = false,
  orgNumberMissing,
  firstContract = false,
  variant = "primary",
  large = false,
  label = "Skapa kontrakt",
}: {
  options: readonly CreateContractOption[];
  operator: ContractParty;
  today: string;
  /** Förvald butik ("store:{id}" eller "lead:{id}"). */
  initialTarget?: string;
  autoOpen?: boolean;
  orgNumberMissing: boolean;
  /** Inget kontrakt från mallen finns ännu: påminn en gång om att låta någon läsa mallen. */
  firstContract?: boolean;
  variant?: "primary" | "secondary";
  /** Stor knapp (sidans huvudåtgärd). */
  large?: boolean;
  label?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const first = initialTarget && options.some((o) => o.value === initialTarget);
  const [open, setOpen] = useState(autoOpen && Boolean(first));
  const startOf = (value: string) => options.find((o) => o.value === value)?.suggestedFrom ?? today;
  const [step, setStep] = useState(0);
  const [target, setTarget] = useState(first ? initialTarget! : (options[0]?.value ?? ""));
  const [validFrom, setValidFrom] = useState(() => startOf(target));
  const [terms, setTerms] = useState<TermsDraft>(DEFAULT_TERMS);
  const [termsError, setTermsError] = useState<TermsError>();
  const [confirm, setConfirm] = useState<string>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<{ id: string; storeName: string; pdf: boolean } | null>(null);
  const [signed, setSigned] = useState(false);
  const [pending, startTransition] = useTransition();

  const option = options.find((o) => o.value === target);
  const checked = useMemo(() => checkTerms(terms), [terms]);
  const preview = useMemo(() => {
    if (step !== 2 || !checked.ok || !option) return "";
    return contractHtml({
      operator,
      store: option.party ?? { name: option.label },
      validFrom: validFrom || today,
      ...checked.terms,
      specialTerms: checked.specialTerms,
      reference: "UTKAST",
    });
  }, [step, checked, option, operator, validFrom, today]);

  const reset = () => {
    setStep(0);
    setConfirm(undefined);
    setError(undefined);
    setTermsError(undefined);
    setDone(null);
    setSigned(false);
  };

  const close = () => {
    setOpen(false);
    if (done) router.refresh();
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(undefined);
    if (step === 0) {
      if (!target) return setError("Välj en butik.");
      if (!validFrom) return setError("Ange startdag.");
      return setStep(1);
    }
    if (step === 1) {
      if (!checked.ok) return setTermsError({ message: checked.message, field: checked.field });
      setTermsError(undefined);
      return setStep(2);
    }
    startTransition(async () => {
      const res = await createContract({
        target,
        validFrom,
        confirmHistory: Boolean(confirm),
        terms: termsPayload(terms),
      });
      if (!res.ok) {
        if (res.needsConfirm) setConfirm(res.error);
        else setError(res.error);
        return;
      }
      setDone(res.data);
      setStep(3);
      toast({ title: `Klart! Kontrakt med ${res.data.storeName}.`, tone: "ok" });
    });
  };

  const markSigned = () =>
    startTransition(async () => {
      if (!done) return;
      const res = await setContractStatus({ id: done.id, status: "signed" });
      if (!res.ok) return setError(res.error);
      setSigned(true);
      toast({ title: "Signerat", tone: "ok" });
    });

  const big = "h-11 px-5 text-base";

  if (options.length === 0) {
    return (
      <Link
        href="/butiker/ny"
        className="inline-flex h-11 items-center gap-2 rounded-sm border border-inverse bg-inverse px-5 text-base font-medium text-on-inverse hover:bg-inverse-hover"
      >
        <span aria-hidden>+</span>
        Ny butik
      </Link>
    );
  }

  return (
    <>
      <Button
        variant={variant}
        iconLeft="plus"
        className={large ? big : undefined}
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <Modal open={open} onClose={close} eyebrow="Kontrakt" title="Skapa kontrakt">
        <ol aria-label="Steg" className="mb-6 grid grid-cols-4 gap-2">
          {STEPS.map((s, i) => (
            <li key={s} className="flex min-w-0 flex-col gap-1.5">
              <span className="h-1 overflow-hidden rounded-xs bg-line">
                <span
                  className="block h-full origin-left bg-fg transition-transform duration-500 ease-out"
                  style={{ transform: `scaleX(${i <= step ? 1 : 0})` }}
                />
              </span>
              <span
                aria-current={i === step ? "step" : undefined}
                className={cn("label truncate", i <= step ? "text-fg" : "text-subtle")}
              >
                {s}
              </span>
            </li>
          ))}
        </ol>

        {step === 3 && done ? (
          <div className="rise flex flex-col gap-6">
            <div className="flex items-center gap-4">
              <span className="grid size-12 shrink-0 place-items-center rounded-full bg-up text-bg">
                <Icon name="check" size={20} />
              </span>
              <div className="flex min-w-0 flex-col">
                <p className="text-lg font-medium text-fg">Klart! Kontrakt med {done.storeName}.</p>
                <p className="text-base text-muted">
                  {signed ? "Signerat." : checked.ok ? checked.plain : null}
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <a
                href={done.pdf ? `/avtal/${done.id}/fil` : `/avtal/${done.id}/mall`}
                target={done.pdf ? undefined : "_blank"}
                rel="noreferrer"
                className="inline-flex h-11 items-center justify-center gap-2 rounded-sm border border-line-strong bg-surface px-5 text-base font-medium text-fg hover:bg-hover"
              >
                <Icon name="download" size={16} />
                {done.pdf ? "Ladda ner PDF" : "Skriv ut"}
              </a>
              {!signed ? (
                <>
                  <SignOnSite contractId={done.id} storeName={done.storeName} large />
                  <Button variant="ghost" loading={pending} onClick={markSigned} className={big}>
                    Markera som signerat
                  </Button>
                </>
              ) : null}
            </div>
            <FormError message={error} />
            <div className="flex justify-end">
              <Button type="button" onClick={close}>
                Stäng
              </Button>
            </div>
          </div>
        ) : (
          <form key={step} onSubmit={submit} noValidate className="rise flex flex-col gap-5">
            {step === 0 ? (
              <>
                <Select
                  label="Butik"
                  value={target}
                  options={[...options]}
                  onChange={(e) => {
                    setTarget(e.target.value);
                    setValidFrom(startOf(e.target.value));
                    setConfirm(undefined);
                  }}
                />
                <Input
                  label="Gäller från"
                  type="date"
                  value={validFrom}
                  onChange={(e) => {
                    setValidFrom(e.target.value);
                    setConfirm(undefined);
                  }}
                />
                <Link
                  href="/butiker/ny"
                  className="meta w-fit rounded-xs text-subtle underline-offset-4 hover:text-fg hover:underline"
                >
                  Ny butik{" "}→
                </Link>
              </>
            ) : null}

            {step === 1 ? (
              <TermsFields
                value={terms}
                onChange={(t) => {
                  setTerms(t);
                  setTermsError(undefined);
                }}
                error={termsError}
              />
            ) : null}

            {step === 2 && checked.ok ? (
              <>
                <p className="text-lg font-medium text-fg">{checked.plain}</p>
                <iframe
                  title="Kontraktet"
                  srcDoc={previewHtml(preview)}
                  sandbox=""
                  className="bg-white h-[46dvh] w-full rounded-sm border border-line"
                />
                {orgNumberMissing ? (
                  <p className="meta text-subtle">
                    <Link
                      href="/ekonomi?vy=bokforing#bokforing"
                      className="underline underline-offset-2"
                    >
                      Lägg in organisationsnumret
                    </Link>
                  </p>
                ) : null}
                {firstContract ? (
                  <p className="meta text-subtle">Låt Talenom läsa mallen en gång.</p>
                ) : null}
                {confirm ? (
                  <p role="status" className="text-sm text-fg">
                    {confirm}
                  </p>
                ) : null}
              </>
            ) : null}

            <FormError message={error} />
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              {step > 0 ? (
                <Button type="button" onClick={() => setStep(step - 1)} disabled={pending}>
                  Tillbaka
                </Button>
              ) : (
                <Button type="button" onClick={close}>
                  Avbryt
                </Button>
              )}
              <Button type="submit" variant="primary" loading={pending} className="h-11 px-6">
                {step < 2 ? "Nästa" : confirm ? "Skapa ändå" : "Skapa kontrakt"}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
