"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, type DragEvent } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { Panel } from "@/components/ui/frame";
import { Icon } from "@/components/ui/icon";
import { StateMessage } from "@/components/ui/state-message";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { formatInt, formatPercent, NBSP } from "@/lib/format";

import {
  commitUpload,
  discardUpload,
  previewUpload,
  startUpload,
  updateDataSource,
  uploadChunk,
} from "../actions";
import { CHUNK_BYTES, MAX_UPLOAD_BYTES } from "../_lib/constants";
import { formatBytes } from "../_lib/display";
import type { MappingNeeded, PreviewResult, SourceView } from "../_lib/types";
import { MappingEditor, type MappingDraft } from "./mapping-editor";
import { PreviewView } from "./preview-view";

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; fileName: string; size: number; sent: number }
  | { kind: "working"; label: string; detail?: string; startedAt: number }
  | { kind: "mapping"; needed: MappingNeeded }
  | { kind: "preview"; result: PreviewResult }
  | { kind: "done"; result: PreviewResult };

/** Antal omförsök per bit vid nätverksfel. */
const RETRIES = 3;

export function UploadPanel({
  sources,
  timeZone,
}: {
  sources: readonly SourceView[];
  timeZone: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  /**
   * Varje uppladdning (och varje Avbryt) får ett nytt nummer. Ett svar från servern
   * som kommer tillbaka efter att användaren avbrutit hör till ett gammalt nummer och
   * får inte ändra panelen.
   */
  const run = useRef(0);
  const uploadIdRef = useRef<string | null>(null);
  /** Källans tidszon före "Byt och förhandsvisa", för att återställa den vid Avbryt. */
  const zoneBefore = useRef<{ sourceId: string; zone: string } | null>(null);
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? "");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [uploadId, setUploadIdState] = useState<string | null>(null);
  const setUploadId = (id: string | null) => {
    uploadIdRef.current = id;
    setUploadIdState(id);
  };
  const [override, setOverride] = useState<MappingDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const preview = useCallback(
    async (id: string, mapping: MappingDraft | null, fileLabel?: string) => {
      const mine = run.current;
      setPhase({
        kind: "working",
        label: "Tolkar filen",
        detail: fileLabel
          ? `${fileLabel} · kontrollerar ordernummer mot det som redan är importerat`
          : "Kontrollerar ordernummer mot det som redan är importerat",
        startedAt: Date.now(),
      });
      const result = await previewUpload({
        uploadId: id,
        dataSourceId: sourceId,
        mapping: mapping ?? undefined,
      });
      if (run.current !== mine) return;
      if (!result.ok) {
        setError(result.error);
        setPhase({ kind: "idle" });
        return;
      }
      if (result.data.kind === "mapping") {
        setPhase({ kind: "mapping", needed: result.data.needed });
      } else {
        setPhase({ kind: "preview", result: result.data.result });
      }
    },
    [sourceId],
  );

  const reset = (discard: boolean) => {
    run.current += 1;
    const id = uploadIdRef.current;
    if (discard && id) void discardUpload({ uploadId: id });
    const before = zoneBefore.current;
    zoneBefore.current = null;
    if (discard && before) {
      // Tidszonen byttes bara för att förhandsvisa: återställ den när importen avbryts.
      void updateDataSource({ id: before.sourceId, sourceTimezone: before.zone }).then((r) => {
        if (r.ok) router.refresh();
      });
    }
    setUploadId(null);
    setOverride(null);
    setError(null);
    setPhase({ kind: "idle" });
    if (inputRef.current) inputRef.current.value = "";
  };

  const upload = async (file: File) => {
    setError(null);
    setOverride(null);
    if (file.size === 0) {
      setError("Filen är tom.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`Filen är ${formatBytes(file.size)}. Högst 50 MB går att ladda upp.`);
      return;
    }
    run.current += 1;
    const mine = run.current;
    const stale = () => run.current !== mine;
    setPhase({ kind: "uploading", fileName: file.name, size: file.size, sent: 0 });
    const started = await startUpload({ fileName: file.name, size: file.size });
    if (stale()) {
      if (started.ok) void discardUpload({ uploadId: started.data.uploadId });
      return;
    }
    if (!started.ok) {
      setError(started.error);
      setPhase({ kind: "idle" });
      return;
    }
    const id = started.data.uploadId;
    setUploadId(id);
    let index = 0;
    for (let offset = 0; offset < file.size; offset += CHUNK_BYTES, index += 1) {
      if (stale()) return;
      const form = new FormData();
      form.set("uploadId", id);
      form.set("index", String(index));
      form.set("chunk", file.slice(offset, offset + CHUNK_BYTES), "chunk");
      let attempt = 0;
      for (;;) {
        try {
          const result = await uploadChunk(form);
          if (stale()) return;
          if (!result.ok) {
            setError(result.error);
            setPhase({ kind: "idle" });
            return;
          }
          setPhase({
            kind: "uploading",
            fileName: file.name,
            size: file.size,
            sent: result.data.received,
          });
          break;
        } catch {
          if (stale()) return;
          attempt += 1;
          if (attempt > RETRIES) {
            setError("Uppladdningen avbröts (nätverksfel). Försök igen.");
            setPhase({ kind: "idle" });
            return;
          }
        }
      }
    }
    if (stale()) return;
    await preview(id, null, file.name);
  };

  const confirm = async (result: PreviewResult) => {
    if (!uploadId) return;
    const mine = run.current;
    setPhase({
      kind: "working",
      label:
        result.summary.new > 0
          ? `Importerar ${formatInt(result.summary.new)} nya order`
          : "Sparar importen i loggen",
      detail: "Allt sparas i en transaktion. Avbryts något sparas ingenting.",
      startedAt: Date.now(),
    });
    const committed = await commitUpload({
      uploadId,
      dataSourceId: result.dataSource.id,
      mapping: override ?? undefined,
      sha256: result.file.sha256,
      sourceTimezone: result.dataSource.sourceTimezone,
      saveMapping: override !== null,
    });
    if (run.current !== mine) return;
    if (!committed.ok) {
      setError(committed.error);
      setPhase({ kind: "preview", result });
      return;
    }
    setUploadId(null);
    zoneBefore.current = null;
    setPhase({ kind: "done", result: committed.data });
    const added = committed.data.summary.new;
    toast({
      title:
        added > 0 ? `${formatInt(added)} nya order importerade` : "Importen är sparad i loggen",
      description:
        added > 0
          ? "Hem, Lönsamhet och Att göra är uppdaterade."
          : `Inga nya order: ${formatInt(committed.data.summary.duplicate)} fanns redan.`,
      tone: "ok",
    });
    router.refresh();
  };

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void upload(file);
  };

  if (sources.length === 0) {
    return (
      <StateMessage
        kind="not-configured"
        message="Lägg till en datakälla först."
        detail="Uppladdningen hamnar alltid i en datakälla, så att samma ordernummer känns igen nästa gång."
        compact
      />
    );
  }

  const source = sources.find((s) => s.id === sourceId) ?? sources[0];

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <StateMessage
          kind="error"
          message={error}
          action={
            phase.kind === "preview" && uploadId
              ? {
                  label: "Förhandsvisa igen",
                  onClick: () => {
                    setError(null);
                    void preview(uploadId, override);
                  },
                }
              : { label: "Välj en annan fil", onClick: () => reset(true) }
          }
          className="rounded-md border border-line bg-surface"
        />
      ) : null}

      {phase.kind === "idle" ? (
        <div className="flex flex-col gap-4">
          {sources.length > 1 ? (
            <Select
              label="Datakälla"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              options={sources.map((s) => ({ value: s.id, label: s.name }))}
              wrapperClassName="max-w-sm"
            />
          ) : null}
          <label
            htmlFor={inputId}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed bg-surface px-4 py-12 text-center transition-[border-color,background-color] duration-fast ease-instrument has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus",
              dragging
                ? "border-fg bg-hover"
                : "border-line-strong hover:border-line-control hover:bg-hover",
            )}
          >
            <Icon name="download" size={20} className="rotate-180 text-muted" />
            <span className="text-base font-medium text-fg">
              {source?.provider === "manual_csv"
                ? "Välj försäljningsfilen (CSV)"
                : "Välj orderlistan (CSV)"}
            </span>
            <span className="text-sm text-muted">
              eller dra den hit · högst 50 MB · {source?.name ?? ""} i{" "}
              {source?.sourceTimezone ?? ""}
            </span>
            <input
              ref={inputRef}
              id={inputId}
              type="file"
              accept=".csv,text/csv,text/plain,.txt"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />
          </label>
        </div>
      ) : null}

      {phase.kind === "uploading" ? (
        <Panel className="flex flex-col gap-3">
          <Progress
            label={`Laddar upp ${phase.fileName}`}
            value={phase.sent}
            max={phase.size}
            detail={`${formatBytes(phase.sent)} av ${formatBytes(phase.size)}`}
          />
          <div>
            <Button size="sm" variant="ghost" onClick={() => reset(true)}>
              Avbryt
            </Button>
          </div>
        </Panel>
      ) : null}

      {phase.kind === "working" ? (
        <Panel className="flex flex-col gap-3" aria-busy>
          <Progress label={phase.label} detail={phase.detail} startedAt={phase.startedAt} />
        </Panel>
      ) : null}

      {phase.kind === "mapping" ? (
        <Panel className="flex flex-col gap-4">
          <StateMessage
            kind="error"
            code="Kolumner"
            message={phase.needed.message}
            detail={`${phase.needed.fileName} · ${phase.needed.mapping.headers.length} kolumner hittades.`}
            compact
          />
          <MappingEditor
            mapping={phase.needed.mapping}
            missing={phase.needed.missing}
            open
            onApply={(draft) => {
              setOverride(draft);
              if (uploadId) void preview(uploadId, draft);
            }}
            onCancel={() => reset(true)}
          />
        </Panel>
      ) : null}

      {phase.kind === "preview" ? (
        <PreviewView
          result={phase.result}
          timeZone={timeZone}
          onConfirm={() => void confirm(phase.result)}
          onCancel={() => reset(true)}
          onRemap={(draft) => {
            setOverride(draft);
            if (uploadId) void preview(uploadId, draft);
          }}
          onZoneChanged={(previous) => {
            zoneBefore.current ??= { sourceId: phase.result.dataSource.id, zone: previous };
            router.refresh();
            if (uploadId) void preview(uploadId, override);
          }}
          originalZone={zoneBefore.current?.zone ?? null}
        />
      ) : null}

      {phase.kind === "done" ? (
        <PreviewView
          result={phase.result}
          timeZone={timeZone}
          footer={
            <div className="flex flex-wrap gap-2">
              {phase.result.importId ? (
                <Link
                  href={`/datakallor/importer/${phase.result.importId}`}
                  className="inline-flex h-9 items-center rounded-sm border border-line-strong bg-surface px-3.5 text-base font-medium text-fg hover:border-line-control hover:bg-hover"
                >
                  Visa importen
                </Link>
              ) : null}
              <Button variant="primary" onClick={() => reset(false)}>
                Ladda upp en fil till
              </Button>
            </div>
          }
        />
      ) : null}
    </div>
  );
}

/** Sekunder sedan `startedAt`, uppdaterat varje sekund (null utan starttid). */
function useElapsed(startedAt: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  if (startedAt === undefined) return null;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** "12 s" · "1 min 5 s" */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${formatInt(seconds)}${NBSP}s`;
  return `${formatInt(Math.floor(seconds / 60))}${NBSP}min ${formatInt(seconds % 60)}${NBSP}s`;
}

/**
 * Förlopp: bestämt (värde och max) eller pågående (utan värde, med förfluten tid).
 * Stapeln skalas med transform (scaleX), aldrig med bredd.
 */
function Progress({
  label,
  value,
  max,
  detail,
  startedAt,
}: {
  label: string;
  value?: number;
  max?: number;
  detail?: string;
  startedAt?: number;
}) {
  const determinate = value !== undefined && max !== undefined && max > 0;
  const share = determinate ? Math.min(1, value / max) : 0;
  const elapsed = useElapsed(determinate ? undefined : startedAt);
  return (
    <div className="flex flex-col gap-2" role="status" aria-live="polite">
      <div className="flex items-baseline justify-between gap-4">
        <span className="truncate text-base font-medium text-fg">{label}</span>
        {determinate ? (
          <span className="tnum shrink-0 text-sm text-muted">{formatPercent(share, 0)}</span>
        ) : elapsed !== null ? (
          <span className="tnum shrink-0 text-sm text-muted" aria-hidden>
            {formatElapsed(elapsed)}
          </span>
        ) : null}
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={determinate ? 0 : undefined}
        aria-valuemax={determinate ? 100 : undefined}
        aria-valuenow={determinate ? Math.round(share * 100) : undefined}
        aria-valuetext={
          determinate ? undefined : elapsed !== null ? `Pågår, ${formatElapsed(elapsed)}` : "Pågår"
        }
        className="relative h-1 w-full overflow-hidden bg-line"
      >
        {determinate ? (
          <div
            className="absolute inset-0 origin-left bg-fg transition-transform duration-fast ease-instrument"
            style={{ transform: `scaleX(${share})` }}
          />
        ) : (
          <div className="absolute inset-0 animate-pulse-soft bg-muted" />
        )}
      </div>
      {detail ? <span className="tnum text-sm text-muted">{detail}</span> : null}
    </div>
  );
}
