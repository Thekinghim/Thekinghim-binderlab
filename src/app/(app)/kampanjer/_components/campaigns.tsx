"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Modal } from "@/components/ui/modal";
import { Segmented } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { formatInt } from "@/lib/format";

import { createCampaign, retryCampaign, stopCampaign } from "../actions";
import { addDaysIso, dayLabel } from "../_lib/display";

export interface MachineOption {
  machineId: string;
  code: string;
  name: string;
}

export interface SuggestionView {
  titleId: string;
  text: string;
  titleName: string;
  machineIds: string[];
  sinceLabel: string;
}

interface Prefill {
  title: string;
  titleId: string | null;
  machineIds: string[];
}

const MAX_TITLE = 60;
const MAX_BYTES = 3 * 1024 * 1024;
const TYPES = ["image/png", "image/jpeg", "image/webp"];

type EndChoice = "7" | "14" | "30" | "eget";

const machinesText = (n: number, all: number) =>
  n === all
    ? `alla ${formatInt(all)} automater`
    : `${formatInt(n)} ${n === 1 ? "automat" : "automater"}`;

/**
 * "Ny kampanj" och förslagen: samma dialog, ett förslag fyller i text och automater.
 * Dialogen har två steg: fyll i, sedan bekräfta (förhandsvisning). Inget skickas till
 * Awish före "Ja, visa".
 */
export function CampaignComposer({
  machines,
  suggestions,
  library,
  today,
  canEdit,
}: {
  machines: MachineOption[];
  suggestions: SuggestionView[];
  library: { campaignId: string; title: string }[];
  today: string;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [prefill, setPrefill] = useState<Prefill>({ title: "", titleId: null, machineIds: [] });

  const start = (p: Prefill) => {
    setPrefill(p);
    setOpen(true);
  };

  return (
    <>
      {canEdit ? (
        <Button
          variant="primary"
          iconLeft="plus"
          disabled={machines.length === 0}
          onClick={() => start({ title: "", titleId: null, machineIds: [] })}
        >
          Ny kampanj
        </Button>
      ) : null}
      {suggestions.length > 0 ? (
        <SuggestionList
          suggestions={suggestions}
          machines={machines}
          canEdit={canEdit}
          onPick={(s) => start({ title: s.text, titleId: s.titleId, machineIds: s.machineIds })}
        />
      ) : null}
      {open ? (
        <CampaignDialog
          key={`${prefill.title}|${prefill.machineIds.join(",")}`}
          machines={machines}
          library={library}
          today={today}
          prefill={prefill}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function SuggestionList({
  suggestions,
  machines,
  canEdit,
  onPick,
}: {
  suggestions: SuggestionView[];
  machines: MachineOption[];
  canEdit: boolean;
  onPick: (s: SuggestionView) => void;
}) {
  const code = (id: string) => machines.find((m) => m.machineId === id)?.code ?? "";
  // Mobil: första förslaget som en platt rad, resten bakom "Alla förslag".
  const [all, setAll] = useState(false);
  return (
    <>
      <ul aria-label="Förslag" className="flex w-full flex-col gap-2 max-md:gap-0">
        {suggestions.map((s, i) => (
          <li
            key={s.titleId}
            className={cn(
              "rise flex flex-wrap items-center justify-between gap-3 rounded-md border border-line-strong bg-raised px-4 py-3 max-md:flex-nowrap max-md:rounded-none max-md:border-x-0 max-md:border-t-0 max-md:border-line max-md:bg-transparent max-md:px-0 max-md:py-2",
              i >= MOBILE_SUGGESTIONS && !all && "max-md:hidden",
            )}
            style={{ "--i": i } as React.CSSProperties}
          >
            <div className="flex min-w-0 flex-col max-md:flex-1">
              <span className="label text-subtle">Förslag · ny titel</span>
              <span className="text-base font-medium">{s.text}</span>
              <span className="text-sm text-muted">
                {s.machineIds.map(code).join(", ")} · in {s.sinceLabel}
              </span>
            </div>
            {canEdit ? (
              <Button
                variant="secondary"
                iconLeft="plus"
                onClick={() => onPick(s)}
                aria-label={`Skapa kampanj: ${s.text}`}
                className="max-md:h-11 max-md:shrink-0"
              >
                <span className="md:hidden">Skapa</span>
                <span className="max-md:hidden">Skapa kampanj</span>
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {suggestions.length > MOBILE_SUGGESTIONS ? (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
          className="label flex min-h-11 w-full items-center justify-between border-b border-line text-muted hover:text-fg md:hidden"
        >
          <span>{all ? "Färre förslag" : `Alla förslag (${suggestions.length})`}</span>
          <Icon
            name="chevronRight"
            size={12}
            className={cn("transition-transform duration-fast", all && "rotate-90")}
          />
        </button>
      ) : null}
    </>
  );
}

/** Så många förslag syns på mobil innan "Alla förslag". */
const MOBILE_SUGGESTIONS = 1;

function CampaignDialog({
  machines,
  library,
  today,
  prefill,
  onClose,
}: {
  machines: MachineOption[];
  library: { campaignId: string; title: string }[];
  today: string;
  prefill: Prefill;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [step, setStep] = useState<"fill" | "confirm">("fill");
  const [title, setTitle] = useState(prefill.title);
  const [file, setFile] = useState<File | null>(null);
  const [reuse, setReuse] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [scope, setScope] = useState<"alla" | "valda">(
    prefill.machineIds.length > 0 && prefill.machineIds.length < machines.length ? "valda" : "alla",
  );
  const [chosen, setChosen] = useState<string[]>(prefill.machineIds);
  const [when, setWhen] = useState<"nu" | "senare">("nu");
  const [startsOn, setStartsOn] = useState(addDaysIso(today, 1));
  const [end, setEnd] = useState<EndChoice>("14");
  const [endsOn, setEndsOn] = useState(addDaysIso(today, 14));
  const [error, setError] = useState<string | null>(null);

  // Förhandsvisningens adress släpps när dialogen stängs.
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  const targets = scope === "alla" ? machines.map((m) => m.machineId) : chosen;
  const startDay = when === "nu" ? today : startsOn;
  const lastDay = end === "eget" ? endsOn : addDaysIso(startDay, Number(end) - 1);
  const imageSrc = reuse ? `/kampanjer/bild/${reuse}` : preview;

  const problem = useMemo(() => {
    if (!file && !reuse) return "Välj en bild.";
    if (title.trim() === "") return "Skriv en text.";
    if (targets.length === 0) return "Välj minst en automat.";
    if (lastDay < startDay) return "Slutet är före starten.";
    return null;
  }, [file, reuse, title, targets.length, lastDay, startDay]);

  const pickFile = (f: File | null) => {
    setError(null);
    if (!f) return;
    if (!TYPES.includes(f.type)) {
      setError("Bilden måste vara PNG, JPG eller WebP.");
      return;
    }
    if (f.size > MAX_BYTES) {
      setError("Bilden är för stor (högst 3 MB).");
      return;
    }
    setReuse(null);
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };

  const submit = () =>
    startTransition(async () => {
      const form = new FormData();
      form.set(
        "input",
        JSON.stringify({
          title: title.trim(),
          machineIds: scope === "alla" ? [] : chosen,
          startsOn: when === "nu" ? null : startsOn,
          endsOn: lastDay,
          titleId: prefill.titleId,
          reuseImageFrom: reuse,
        }),
      );
      if (file && !reuse) form.set("image", file);
      const r = await createCampaign(form);
      if (!r.ok) {
        setError(r.error);
        setStep("fill");
        return;
      }
      const d = r.data;
      if (d.scheduled) {
        toast({ title: `Klart! Visas från ${dayLabel(startDay, today)}.`, tone: "ok" });
      } else if (d.failed === 0) {
        toast({ title: `Klart! Visas på ${machinesText(d.shown, machines.length)}.`, tone: "ok" });
      } else {
        toast({
          title: `Visas på ${formatInt(d.shown)} av ${formatInt(d.machines)}.`,
          description: "Några kom inte fram. Tryck Försök igen.",
          tone: "critical",
        });
      }
      onClose();
      router.refresh();
    });

  const code = (id: string) => machines.find((m) => m.machineId === id)?.code ?? "";

  return (
    <Modal
      open
      onClose={pending ? () => {} : onClose}
      eyebrow="Kampanj på skärmen"
      title={step === "fill" ? "Ny kampanj" : "Visa på skärmen?"}
      footer={
        step === "fill" ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Avbryt
            </Button>
            <Button
              variant="primary"
              disabled={problem !== null}
              onClick={() => {
                setError(null);
                setStep("confirm");
              }}
            >
              Fortsätt
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" disabled={pending} onClick={() => setStep("fill")}>
              Tillbaka
            </Button>
            <Button variant="primary" loading={pending} onClick={submit}>
              Ja, visa
            </Button>
          </>
        )
      }
    >
      {step === "fill" ? (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <span className="label text-muted">Bild</span>
            <label
              className={cn(
                "relative flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-md border border-dashed border-line-control bg-bg text-center transition-colors hover:bg-hover",
                imageSrc && "border-solid",
              )}
            >
              {imageSrc ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={imageSrc} alt="" className="max-h-56 w-full object-contain" />
              ) : (
                <span className="px-4 py-6 text-base text-muted">
                  Tryck för att välja bild
                  <span className="block text-xs text-subtle">PNG, JPG eller WebP, högst 3 MB</span>
                </span>
              )}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                aria-label="Välj bild"
                onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              />
            </label>
            {library.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-subtle">Eller en tidigare bild:</span>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {library.map((l) => (
                    <button
                      key={l.campaignId}
                      type="button"
                      aria-label={`Använd bilden från ${l.title}`}
                      aria-pressed={reuse === l.campaignId}
                      onClick={() => {
                        setFile(null);
                        setPreview(null);
                        setReuse(l.campaignId);
                      }}
                      className={cn(
                        "h-14 w-20 shrink-0 overflow-hidden rounded-sm border bg-bg",
                        reuse === l.campaignId ? "border-fg ring-1 ring-fg" : "border-line-strong",
                      )}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/kampanjer/bild/${l.campaignId}`}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <Input
            label="Text"
            value={title}
            maxLength={MAX_TITLE}
            placeholder="Nytt: Surging Sparks"
            hint={`${title.length}/${MAX_TITLE}`}
            onChange={(e) => setTitle(e.target.value)}
          />

          <div className="flex flex-col gap-2">
            <span className="label text-muted">Var</span>
            <Segmented
              label="Var"
              value={scope}
              onChange={setScope}
              options={[
                { value: "alla", label: `Alla (${machines.length})` },
                { value: "valda", label: "Välj" },
              ]}
            />
            {scope === "valda" ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {machines.map((m) => {
                  const on = chosen.includes(m.machineId);
                  return (
                    <button
                      key={m.machineId}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setChosen((c) =>
                          on ? c.filter((x) => x !== m.machineId) : [...c, m.machineId],
                        )
                      }
                      className={cn(
                        "flex min-h-12 flex-col items-start justify-center rounded-sm border px-3 py-2 text-left transition-colors",
                        on ? "border-fg bg-hover" : "border-line-strong hover:bg-hover",
                      )}
                    >
                      <span className="text-sm font-medium">{m.code}</span>
                      <span className="truncate text-xs text-muted">{m.name}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <span className="label text-muted">Start</span>
              <Segmented
                label="Start"
                value={when}
                onChange={setWhen}
                options={[
                  { value: "nu", label: "Nu" },
                  { value: "senare", label: "Senare" },
                ]}
              />
              {when === "senare" ? (
                <Input
                  label="Från"
                  type="date"
                  min={addDaysIso(today, 1)}
                  value={startsOn}
                  onChange={(e) => setStartsOn(e.target.value)}
                />
              ) : null}
            </div>
            <div className="flex flex-col gap-2">
              <span className="label text-muted">Hur länge</span>
              <Segmented
                label="Hur länge"
                value={end}
                onChange={setEnd}
                options={[
                  { value: "7", label: "7 d" },
                  { value: "14", label: "14 d" },
                  { value: "30", label: "30 d" },
                  { value: "eget", label: "Datum" },
                ]}
              />
              {end === "eget" ? (
                <Input
                  label="Till och med"
                  type="date"
                  min={startDay}
                  max={addDaysIso(today, 90)}
                  value={endsOn}
                  onChange={(e) => setEndsOn(e.target.value)}
                />
              ) : null}
            </div>
          </div>
          {error ? <p className="text-sm text-signal-fg">{error}</p> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {imageSrc ? (
            <div className="overflow-hidden rounded-md border border-line-strong bg-bg">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imageSrc} alt="" className="max-h-64 w-full object-contain" />
            </div>
          ) : null}
          <p className="text-xl font-medium">{title.trim()}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
            <dt className="text-muted">Var</dt>
            <dd>
              {scope === "alla"
                ? machinesText(machines.length, machines.length)
                : chosen.map(code).join(", ")}
            </dd>
            <dt className="text-muted">När</dt>
            <dd>
              {when === "nu" ? "Från nu" : `Från ${dayLabel(startsOn, today)}`} till och med{" "}
              {dayLabel(lastDay, today)}
            </dd>
          </dl>
          {error ? <p className="text-sm text-signal-fg">{error}</p> : null}
        </div>
      )}
    </Modal>
  );
}

/** Stäng av och Försök igen på ett kampanjkort, med bekräftelse före avstängning. */
export function CampaignActions({
  id,
  title,
  canStop,
  canRetry,
}: {
  id: string;
  title: string;
  canStop: boolean;
  canRetry: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState(false);

  const stop = () =>
    start(async () => {
      const r = await stopCampaign(id);
      setConfirm(false);
      if (!r.ok) {
        toast({ title: "Inte avstängd", description: r.error, tone: "critical" });
        return;
      }
      if (r.data.failed > 0) {
        toast({
          title: `Avstängd på ${formatInt(r.data.stopped)}, inte på ${formatInt(r.data.failed)}.`,
          description: "Försök igen om en stund.",
          tone: "critical",
        });
      } else {
        toast({ title: "Klart! Kampanjen är avstängd.", tone: "ok" });
      }
      router.refresh();
    });

  const retry = () =>
    start(async () => {
      const r = await retryCampaign(id);
      if (!r.ok) {
        toast({ title: "Kom inte fram", description: r.error, tone: "critical" });
      } else if (r.data.failed > 0) {
        toast({ title: `${formatInt(r.data.failed)} kom inte fram igen.`, tone: "critical" });
      } else {
        toast({ title: "Klart! Visas nu.", tone: "ok" });
      }
      router.refresh();
    });

  return (
    <div className="flex flex-wrap gap-2">
      {canRetry ? (
        <Button variant="secondary" size="sm" loading={pending && !confirm} onClick={retry}>
          Försök igen
        </Button>
      ) : null}
      {canStop ? (
        <Button variant="danger" size="sm" disabled={pending} onClick={() => setConfirm(true)}>
          Stäng av
        </Button>
      ) : null}
      <Modal
        open={confirm}
        onClose={() => (pending ? undefined : setConfirm(false))}
        size="sm"
        title="Stäng av kampanjen?"
        description={`"${title}" försvinner från skärmen.`}
        footer={
          <>
            <Button variant="ghost" disabled={pending} onClick={() => setConfirm(false)}>
              Avbryt
            </Button>
            <Button variant="danger-confirm" loading={pending} onClick={stop}>
              Ja, stäng av
            </Button>
          </>
        }
      />
    </div>
  );
}
