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
import { PROVIDER_LABELS, SOURCE_TIMEZONES } from "../_lib/constants";
import { formatWhen } from "../_lib/display";
import { STALE_HOURS } from "../_lib/headline";
import type { SourceView } from "../_lib/types";

function syncStatus(source: SourceView, now: Date): { status: Status; text: string } {
  if (source.archived) return { status: "offline", text: "Arkiverad" };
  if (source.status === "error") return { status: "critical", text: "Fel" };
  if (source.status === "paused") return { status: "offline", text: "Pausad" };
  if (!source.lastSyncedAt) return { status: "neutral", text: "Ingen import" };
  const age = now.getTime() - new Date(source.lastSyncedAt).getTime();
  return age > STALE_HOURS * 3_600_000
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
  const [editing, setEditing] = useState<SourceView | null>(null);
  const [creating, setCreating] = useState(false);
  const nowDate = new Date(now);

  return (
    <div className="flex flex-col gap-4">
      {sources.length === 0 ? (
        <StateMessage
          kind="not-configured"
          message="Ingen datakälla ännu."
          detail="Lägg till Awish-orderlistan. Därefter laddar du upp CSV-filen här på sidan."
          action={
            <Button variant="primary" iconLeft="plus" onClick={() => setCreating(true)}>
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
                  <Fact label="Synkad" className="md:col-span-2">
                    <span className="tnum">
                      {s.lastSyncedAt ? formatWhen(s.lastSyncedAt, timeZone, nowDate) : "Aldrig"}
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
                        onClick={() => setEditing(s)}
                        aria-label={`Ändra ${s.name}`}
                      >
                        Ändra
                      </Button>
                    ) : null}
                  </div>
                  {s.lastImport ? (
                    <p className="col-span-2 border-t border-line pt-3 text-sm text-muted md:col-span-12">
                      Senaste import {formatWhen(s.lastImport.finishedAt ?? s.lastImport.createdAt, timeZone, nowDate)}
                      {s.lastImport.fileName ? <> · <span className="text-fg">{s.lastImport.fileName}</span></> : null}
                      {" · "}
                      <span className="tnum">
                        {formatInt(s.lastImport.rowsNew)} nya, {formatInt(s.lastImport.rowsDuplicate)}{" "}
                        dubbletter
                        {s.lastImport.rowsConflict > 0
                          ? `, ${formatInt(s.lastImport.rowsConflict)} konflikter`
                          : ""}
                        {s.lastImport.rowsError > 0 ? `, ${formatInt(s.lastImport.rowsError)} fel` : ""}
                      </span>
                      {s.unmapped > 0 ? (
                        <>
                          {" · "}
                          <a href="#okanda-automater" className="text-fg underline underline-offset-4">
                            {formatInt(s.unmapped)} okända automater
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
          <Button size="sm" iconLeft="plus" onClick={() => setCreating(true)}>
            Lägg till datakälla
          </Button>
        </div>
      ) : null}

      <SourceDialog
        key={editing?.id ?? (creating ? "new" : "closed")}
        open={creating || editing !== null}
        source={editing}
        onClose={() => {
          setEditing(null);
          setCreating(false);
        }}
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
  const [name, setName] = useState(source?.name ?? "Awish orderlista");
  const [zone, setZone] = useState(source?.sourceTimezone ?? "Asia/Shanghai");
  const [error, setError] = useState<string | null>(null);
  const zoneChanged = source !== null && zone !== source.sourceTimezone;

  const submit = () =>
    startTransition(async () => {
      setError(null);
      const result = source
        ? await updateDataSource({ id: source.id, name, sourceTimezone: zone })
        : await createDataSource({ name, sourceTimezone: zone });
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
      title={source ? source.name : "Lägg till Awish-orderlistan"}
      description={
        source
          ? "Namn och tidszonen som Awish skriver tiderna i."
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
          hint="Awish visar Payment Time i Shanghai-tid tills det kontrollerats. Förhandsvisningen visar första orderns tid i svensk tid så att du kan jämföra."
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
