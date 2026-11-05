"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Panel } from "@/components/ui/frame";
import { Modal } from "@/components/ui/modal";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag, type Status } from "@/components/ui/status-tag";
import { useToast } from "@/components/ui/toast";
import { formatInt } from "@/lib/format";

import { createDataSource, updateDataSource } from "../actions";
import { MANUAL_CSV_TEMPLATE, PROVIDER_LABELS, SOURCE_TIMEZONES } from "../_lib/constants";
import { formatWhen } from "../_lib/display";
import { isStale } from "../_lib/headline";
import type { SourceView } from "../_lib/types";

/** Status efter hur ny datan är (den senaste ordern), inte när någon senast laddade upp. */
function syncStatus(source: SourceView, now: Date): { status: Status; text: string } {
  if (source.archived) return { status: "offline", text: "Arkiverad" };
  if (source.status === "error") return { status: "critical", text: "Fel" };
  if (source.status === "paused") return { status: "offline", text: "Pausad" };
  if (!source.latestOrderAt) {
    return { status: "neutral", text: source.lastSyncedAt ? "Inga order" : "Ingen import" };
  }
  return isStale(source.latestOrderAt, now)
    ? { status: "warning", text: "Inaktuell" }
    : { status: "ok", text: "I fas" };
}

function timezoneOptions(current?: string) {
  const options: Array<{ value: string; label: string }> = SOURCE_TIMEZONES.map((z) => ({
    value: z.value,
    label: z.label,
  }));
  if (current && !options.some((o) => o.value === current)) {
    options.unshift({ value: current, label: current });
  }
  return options;
}

export function SourceList({
  sources,
  timeZone,
  now,
}: {
  sources: readonly SourceView[];
  timeZone: string;
  now: string;
}) {
  // Dialogen behåller sin nyckel när den stängs, så att <dialog> stängs på riktigt
  // (och lämnar tillbaka fokus till knappen) i stället för att avmonteras.
  const [dialog, setDialog] = useState<{
    key: number;
    open: boolean;
    source: SourceView | null;
  }>({ key: 0, open: false, source: null });
  const openDialog = (source: SourceView | null) =>
    setDialog((d) => ({ key: d.key + 1, open: true, source }));
  const nowDate = new Date(now);

  return (
    <div className="flex flex-col gap-4">
      {sources.length === 0 ? (
        <StateMessage
          kind="not-configured"
          message="Ingen datakälla ännu."
          detail="Lägg till Awish-orderlistan, eller försäljning från en annan automat. Därefter laddar du upp CSV-filen här på sidan."
          action={
            <Button variant="primary" iconLeft="plus" onClick={() => openDialog(null)}>
              Lägg till datakälla
            </Button>
          }
          className="rounded-md border border-line bg-surface"
        />
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Datakällor">
          {sources.map((s) => {
            const sync = syncStatus(s, nowDate);
            return (
              <li key={s.id}>
                <Panel className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-12">
                  <div className="col-span-2 flex min-w-0 flex-col gap-1 md:col-span-4">
                    <p className="truncate text-md font-medium text-fg">{s.name}</p>
                    <p className="label text-subtle">{PROVIDER_LABELS[s.provider] ?? s.provider}</p>
                  </div>
                  <Fact label="Status" className="md:col-span-2">
                    <StatusTag status={sync.status}>{sync.text}</StatusTag>
                  </Fact>
                  <Fact label="Data till" className="md:col-span-2">
                    <span className="tnum">
                      {s.latestOrderAt
                        ? formatWhen(s.latestOrderAt, timeZone, nowDate)
                        : "Inga order"}
                    </span>
                  </Fact>
                  <Fact label="Order" className="md:col-span-1">
                    <span className="tnum">{formatInt(s.orders)}</span>
                  </Fact>
                  <Fact label="Källans tid" className="md:col-span-2">
                    <span className="truncate">{s.sourceTimezone}</span>
                  </Fact>
                  <div className="col-span-2 flex items-start md:col-span-1 md:justify-end">
                    {!s.archived ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openDialog(s)}
                        aria-label={`Ändra ${s.name}`}
                      >
                        Ändra
                      </Button>
                    ) : null}
                  </div>
                  {s.lastImport ? (
                    <p className="col-span-2 border-t border-line pt-3 text-sm text-muted md:col-span-12">
                      Senaste import{" "}
                      {formatWhen(
                        s.lastImport.finishedAt ?? s.lastImport.createdAt,
                        timeZone,
                        nowDate,
                      )}
                      {s.lastImport.fileName ? (
                        <>
                          {" "}
                          · <span className="text-fg">{s.lastImport.fileName}</span>
                        </>
                      ) : null}
                      {" · "}
                      <span className="tnum">
                        {formatInt(s.lastImport.rowsNew)} nya,{" "}
                        {formatInt(s.lastImport.rowsDuplicate)} dubbletter
                        {s.lastImport.rowsConflict > 0
                          ? `, ${formatInt(s.lastImport.rowsConflict)} konflikter`
                          : ""}
                        {s.lastImport.rowsError > 0
                          ? `, ${formatInt(s.lastImport.rowsError)} fel`
                          : ""}
                      </span>
                      {s.unmapped > 0 ? (
                        <>
                          {" · "}
                          <a
                            href="#okanda-automater"
                            className="text-fg underline underline-offset-4"
                          >
                            {s.unmapped === 1
                              ? "1 okänd automat"
                              : `${formatInt(s.unmapped)} okända automater`}
                          </a>
                        </>
                      ) : null}
                    </p>
                  ) : null}
                </Panel>
              </li>
            );
          })}
        </ul>
      )}
      {sources.length > 0 ? (
        <div>
          <Button size="sm" iconLeft="plus" onClick={() => openDialog(null)}>
            Lägg till datakälla
          </Button>
        </div>
      ) : null}

      <SourceDialog
        key={dialog.key}
        open={dialog.open}
        source={dialog.source}
        onClose={() => setDialog((d) => ({ ...d, open: false }))}
      />
    </div>
  );
}

function Fact({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className ?? ""}`}>
      <span className="label text-subtle">{label}</span>
      <span className="flex min-w-0 text-base text-fg">{children}</span>
    </div>
  );
}

/** Ny datakälla eller ändring av namn och källans tidszon. */
function SourceDialog({
  open,
  source,
  onClose,
}: {
  open: boolean;
  source: SourceView | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [kind, setKind] = useState<"awish_csv" | "manual_csv">("awish_csv");
  const [name, setName] = useState(source?.name ?? "Awish orderlista");
  const [zone, setZone] = useState(source?.sourceTimezone ?? "Asia/Shanghai");
  const manual = source ? source.provider === "manual_csv" : kind === "manual_csv";
  const chooseKind = (next: "awish_csv" | "manual_csv") => {
    setKind(next);
    // Standardnamn och tidszon följer typen (Awish skriver Shanghai-tid, andra oftast svensk).
    setName(next === "manual_csv" ? "Försäljning, annan automat" : "Awish orderlista");
    setZone(next === "manual_csv" ? "Europe/Stockholm" : "Asia/Shanghai");
  };
  const [error, setError] = useState<string | null>(null);
  const zoneChanged = source !== null && zone !== source.sourceTimezone;

  const submit = () =>
    startTransition(async () => {
      setError(null);
      const result = source
        ? await updateDataSource({ id: source.id, name, sourceTimezone: zone })
        : await createDataSource({ name, sourceTimezone: zone, provider: kind });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast({
        title: source ? "Datakällan är sparad" : "Datakällan är skapad",
        description: source
          ? zoneChanged
            ? `Källans tid är nu ${zone}. Gäller nästa import; redan importerade order ändras inte.`
            : undefined
          : manual
            ? "Ladda upp försäljningen som CSV nedan."
            : "Ladda upp orderlistan från Awish nedan.",
        tone: "ok",
      });
      onClose();
      router.refresh();
    });

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow={source ? "Datakälla" : "Ny datakälla"}
      title={
        source ? source.name : manual ? "Lägg till annan automat" : "Lägg till Awish-orderlistan"
      }
      description={
        source
          ? manual
            ? "Namn och tidszonen som filens tider står i."
            : "Namn och tidszonen som Awish skriver tiderna i."
          : manual
            ? "Försäljning från en automat som inte är Awish, uppladdad som CSV."
            : "En CSV-källa för orderlistan som exporteras från Awish."
      }
      footer={
        <>
          <Button onClick={onClose}>Avbryt</Button>
          <Button variant="primary" loading={pending} onClick={submit}>
            {source ? "Spara" : "Lägg till"}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {source ? null : (
          <Select
            label="Automater"
            value={kind}
            options={[
              { value: "awish_csv", label: "Awish (orderlista)" },
              { value: "manual_csv", label: "Annat märke (CSV)" },
            ]}
            onChange={(e) => chooseKind(e.target.value as "awish_csv" | "manual_csv")}
          />
        )}
        {manual ? (
          <p className="text-sm text-muted">
            En rad per försäljning: Datum, Automat, Produkt, Belopp. Tid och Antal är valfria.{" "}
            <a
              className="text-fg underline underline-offset-4"
              href={`data:text/csv;charset=utf-8,${encodeURIComponent(`\ufeff${MANUAL_CSV_TEMPLATE}`)}`}
              download="binderlab-forsaljning-mall.csv"
            >
              Ladda ner mall
            </a>
          </p>
        ) : null}
        <Input
          label="Namn"
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Select
          label="Källans tidszon"
          value={zone}
          options={timezoneOptions(source?.sourceTimezone)}
          onChange={(e) => setZone(e.target.value)}
          hint={
            manual
              ? "Tidszonen som tiderna i filen står i. Förhandsvisningen visar första raden i svensk tid."
              : "Awish visar Payment Time i Shanghai-tid tills det kontrollerats. Förhandsvisningen visar första orderns tid i svensk tid så att du kan jämföra."
          }
        />
        {zoneChanged ? (
          <p className="text-sm text-muted">
            Order som redan är importerade ändras inte. Bara nästa import tolkas i {zone}.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-signal-fg">
            {error}
          </p>
        ) : null}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
