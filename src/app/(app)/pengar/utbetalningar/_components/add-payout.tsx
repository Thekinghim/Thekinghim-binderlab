"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ReactElement } from "react";

import { Button } from "@/components/v2/button";
import { Field, Input, Select, Textarea } from "@/components/v2/field";
import { Segmented } from "@/components/v2/segmented";
import { Sheet, SheetClose } from "@/components/v2/sheet";
import { toastV2 } from "@/components/v2/toast";

import { kr, krExact } from "../../_components/fmt";
import { oreToField, parseKr } from "../_lib/model";
import {
  applyColumnMapping,
  confirmDraft,
  discardDraft,
  expectedForPeriod,
  registerPayout,
  uploadPayoutReport,
} from "../actions";

type Mode = "upload" | "manual";

/** Det servern läste (UploadResult, serialiserat). */
type Extracted = {
  paidOn: string | null;
  amountOre: number | null;
  feesOre: number | null;
  grossOre: number | null;
  periodFrom: string | null;
  periodTo: string | null;
  aiFields?: readonly string[];
  confidence?: string;
};
type Upload =
  | {
      kind: "draft";
      draftId: string;
      extracted: Extracted;
      warnings: readonly { code: string; [k: string]: unknown }[];
      extractor: "deterministic" | "ai";
    }
  | {
      kind: "mapping";
      draftId: string;
      headers: readonly string[];
      samples: readonly (readonly string[])[];
      suggested: Record<string, string | null | undefined>;
    }
  | { kind: "imported"; message: string }
  | { kind: "manual"; message: string };

const FIELDS: readonly { key: string; label: string; need?: true }[] = [
  { key: "amount", label: "Belopp in", need: true },
  { key: "paid_on", label: "Dagen pengarna kom" },
  { key: "fees", label: "Avgift" },
  { key: "gross", label: "Försäljning före avgift" },
  { key: "period_from", label: "Period från" },
  { key: "period_to", label: "Period till" },
  { key: "transaction_id", label: "Köpets nummer" },
  { key: "transaction_date", label: "Köpdag" },
  { key: "device_serial", label: "Automat" },
];

function warningText(w: { code: string; [k: string]: unknown }): string | null {
  switch (w.code) {
    case "SUMS_MISMATCH":
      return `Siffrorna i rapporten går inte ihop (${kr(Math.abs(Number(w.diffOre)))} skiljer). Kontrollera beloppet.`;
    case "BAD_ROWS":
      return `${String(w.rows)} rader gick inte att läsa och är inte med.`;
    case "NO_AMOUNT":
      return "Vi hittade inget belopp. Skriv det själv.";
    case "MANY_PAYOUTS":
      return `Filen har ${String(w.rows)} utbetalningar. Vi tog den första; lägg in de andra för sig.`;
    case "TRUNCATED":
      return `Filen har ${String(w.rows)} köp; de första 2 000 sparas.`;
    case "UNMAPPED_DEVICE":
      return `Automaten ${String(w.serial)} i rapporten finns inte hos oss.`;
    default:
      return null;
  }
}

/**
 * "Lägg in utbetalning från Nayax": ladda upp rapporten (fil eller foto) eller skriv in
 * själv. Okända kolumner får ett kolumnsteg ("Kom ihåg för nästa fil"), och det AI läst
 * märks "Läst av AI, kontrollera". Inget sparas förrän "Stämmer, spara".
 */
export function AddPayout({
  today,
  trigger,
  defaultOpen = false,
}: {
  today: string;
  trigger: ReactElement;
  defaultOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const [mode, setMode] = useState<Mode>("upload");
  const [upload, setUpload] = useState<Upload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  // Formuläret (utkastet eller inskrivningen).
  const [paidOn, setPaidOn] = useState(today);
  const [amount, setAmount] = useState("");
  const [fees, setFees] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [remember, setRemember] = useState(true);
  const [expected, setExpected] = useState<{
    key: string;
    grossOre: number;
    feeOre: number;
    netOre: number;
  } | null>(null);

  const reset = () => {
    setMode("upload");
    setUpload(null);
    setError(null);
    setPaidOn(today);
    setAmount("");
    setFees("");
    setFrom("");
    setTo("");
    setNote("");
    setExpected(null);
  };

  const fill = (e: Extracted) => {
    setPaidOn(e.paidOn ?? today);
    setAmount(oreToField(e.amountOre));
    setFees(oreToField(e.feesOre));
    setFrom(e.periodFrom ?? "");
    setTo(e.periodTo ?? "");
  };

  // Jämförelsen med vår försäljning när perioden finns.
  useEffect(() => {
    if (!open || !from || !to || to < from) return;
    let alive = true;
    const key = `${from}|${to}`;
    void expectedForPeriod({ start: from, end: to }).then((r) => {
      if (alive) setExpected(r.ok ? { ...r.data, key } : null);
    });
    return () => {
      alive = false;
    };
  }, [open, from, to]);

  const onFile = (file: File) => {
    setError(null);
    start(async () => {
      const form = new FormData();
      form.set("file", file);
      const res = await uploadPayoutReport(form);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const data = res.data as Upload;
      if (data.kind === "imported") {
        setOpen(false);
        router.refresh();
        toastV2(data.message);
        return;
      }
      if (data.kind === "manual") {
        setMode("manual");
        setError(data.message);
        return;
      }
      if (data.kind === "mapping") {
        setMapping(
          Object.fromEntries(
            Object.entries(data.suggested).filter(
              (e): e is [string, string] => typeof e[1] === "string",
            ),
          ),
        );
      } else {
        fill(data.extracted);
      }
      setUpload(data);
    });
  };

  const applyMapping = () => {
    if (!upload || upload.kind !== "mapping") return;
    if (!mapping.amount) {
      setError("Välj vilken kolumn som är beloppet.");
      return;
    }
    setError(null);
    start(async () => {
      const res = await applyColumnMapping(upload.draftId, mapping, remember);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const data = res.data as Upload;
      if (data.kind === "draft") fill(data.extracted);
      setUpload(data);
    });
  };

  const save = () => {
    const amountOre = parseKr(amount);
    if (amountOre === null) {
      setError("Skriv beloppet som kom in.");
      return;
    }
    const feesOre = fees.trim() === "" ? null : parseKr(fees, true);
    if (fees.trim() !== "" && (feesOre === null || feesOre < 0)) {
      setError("Avgiften ska vara ett belopp.");
      return;
    }
    if ((from && !to) || (!from && to)) {
      setError("Välj både första och sista dagen, eller lämna perioden tom.");
      return;
    }
    const input = {
      paidOn,
      amountOre,
      feesOre,
      period: from && to ? { start: from, end: to } : null,
      note: note.trim() || null,
    };
    setError(null);
    start(async () => {
      const res =
        upload && upload.kind === "draft"
          ? await confirmDraft(upload.draftId, input)
          : await registerPayout(input);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      toastV2("Utbetalningen är sparad", {
        detail: res.data.note ?? "Här är vem som ska ha vad.",
      });
      router.push(`/pengar/utbetalningar/${res.data.payoutId}`);
      router.refresh();
    });
  };

  const draft = upload?.kind === "draft" ? upload : null;
  const ai = new Set(draft?.extractor === "ai" ? (draft.extracted.aiFields ?? []) : []);
  const aiMark = (k: string) => (ai.has(k) ? "Läst av AI, kontrollera" : undefined);
  const showForm = mode === "manual" || draft !== null;
  const amountOre = parseKr(amount);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (!next && upload && upload.kind !== "imported" && upload.kind !== "manual") {
          void discardDraft(upload.draftId);
        }
        if (next) reset();
        setOpen(next);
      }}
      trigger={trigger}
      title="Lägg in utbetalning från Nayax"
      description={
        upload?.kind === "mapping"
          ? "Vilken kolumn är vad? Välj en gång, så kommer vi ihåg filen."
          : draft
            ? "Kontrollera att det stämmer med rapporten."
            : "Ladda upp rapporten, eller skriv in dag och belopp."
      }
      dismissible={!pending}
      footer={
        <>
          <SheetClose asChild>
            <Button size="lg" disabled={pending}>
              Avbryt
            </Button>
          </SheetClose>
          {upload?.kind === "mapping" ? (
            <Button
              size="lg"
              variant="act"
              pending={pending}
              onClick={applyMapping}
              data-testid="mapping-next"
            >
              Läs filen
            </Button>
          ) : showForm ? (
            <Button
              size="lg"
              variant="act"
              pending={pending}
              onClick={save}
              data-testid="payout-save"
            >
              {draft ? "Stämmer, spara" : "Spara"}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="ut-form">
        {!upload ? (
          <Segmented
            ariaLabel="Hur vill du lägga in utbetalningen?"
            options={[
              { value: "upload", label: "Ladda upp rapport" },
              { value: "manual", label: "Skriv in själv" },
            ]}
            value={mode}
            onChange={(m) => {
              setMode(m);
              setError(null);
            }}
          />
        ) : null}

        {mode === "upload" && !upload ? (
          <label className="ut-drop" data-pending={pending || undefined}>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.txt,.xlsx,.pdf,image/*"
              className="sr-only"
              data-testid="payout-file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
                e.target.value = "";
              }}
            />
            <b>{pending ? "Läser rapporten…" : "Välj fil eller ta ett foto"}</b>
            <span>CSV, Excel, PDF eller en bild av rapporten. Högst 10 MB.</span>
          </label>
        ) : null}

        {upload?.kind === "mapping" ? (
          <div className="ut-map">
            {FIELDS.map((f) => (
              <Field key={f.key} label={f.label + (f.need ? "" : " (valfri)")}>
                {(p) => (
                  <Select
                    {...p}
                    value={mapping[f.key] ?? ""}
                    data-testid={`map-${f.key}`}
                    onChange={(e) =>
                      setMapping((m) => {
                        const next = { ...m };
                        if (e.target.value) next[f.key] = e.target.value;
                        else delete next[f.key];
                        return next;
                      })
                    }
                  >
                    <option value="">Finns inte</option>
                    {upload.headers.map((h, i) => (
                      <option key={`${h}-${i}`} value={h}>
                        {h}
                        {upload.samples[0]?.[i] ? ` (t.ex. ${upload.samples[0][i]})` : ""}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ))}
            <label className="ut-check">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              Kom ihåg för nästa fil
            </label>
          </div>
        ) : null}

        {showForm ? (
          <>
            {draft?.extractor === "ai" ? (
              <p className="ut-hint">
                AI har läst rapporten. Kontrollera fälten som är märkta innan du sparar.
              </p>
            ) : null}
            {draft
              ? draft.warnings.map((w, i) => {
                  const t = warningText(w);
                  return t ? (
                    <p key={i} className="ut-warn">
                      {t}
                    </p>
                  ) : null;
                })
              : null}
            <div className="ut-two">
              <Field label="Dagen pengarna kom" hint={aiMark("paidOn")}>
                {(p) => (
                  <Input
                    {...p}
                    type="date"
                    max={today}
                    value={paidOn}
                    onChange={(e) => setPaidOn(e.target.value)}
                    data-testid="payout-paid-on"
                  />
                )}
              </Field>
              <Field label="Belopp in" hint={aiMark("amountOre")}>
                {(p) => (
                  <Input
                    {...p}
                    inputMode="decimal"
                    suffix="kr"
                    value={amount}
                    placeholder="48 210"
                    onChange={(e) => setAmount(e.target.value)}
                    data-testid="payout-amount"
                  />
                )}
              </Field>
            </div>
            <Field label="Avgift till Nayax (valfri)" hint={aiMark("feesOre")}>
              {(p) => (
                <Input
                  {...p}
                  inputMode="decimal"
                  suffix="kr"
                  value={fees}
                  onChange={(e) => setFees(e.target.value)}
                />
              )}
            </Field>
            <div className="ut-two">
              <Field label="Försäljning från" hint={aiMark("periodFrom")}>
                {(p) => (
                  <Input
                    {...p}
                    type="date"
                    max={today}
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                )}
              </Field>
              <Field label="till" hint={aiMark("periodTo")}>
                {(p) => (
                  <Input
                    {...p}
                    type="date"
                    max={today}
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                  />
                )}
              </Field>
            </div>
            {!from && !to ? (
              <p className="ut-hint">Vet du inte vilka dagar? Lämna tomt, så räknar vi ut det.</p>
            ) : null}
            {expected && expected.key === `${from}|${to}` && amountOre !== null ? (
              <p
                className="ut-compare"
                data-ok={
                  Math.abs(amountOre - expected.netOre) <= Math.max(500, expected.netOre / 100) ||
                  undefined
                }
              >
                Vår försäljning för dagarna: {kr(expected.grossOre)} − avgift ≈{" "}
                {kr(expected.netOre)}.{" "}
                {Math.abs(amountOre - expected.netOre) <= Math.max(500, expected.netOre / 100)
                  ? "Stämmer."
                  : `Skiljer ${krExact(Math.abs(amountOre - expected.netOre))}.`}
              </p>
            ) : null}
            {mode === "manual" && !draft ? (
              <Field label="Anteckning (valfri)">
                {(p) => (
                  <Textarea
                    {...p}
                    rows={2}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                )}
              </Field>
            ) : null}
          </>
        ) : null}
        {error ? (
          <p role="alert" className="ut-err">
            {error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
