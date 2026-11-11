"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { StateMessage } from "@/components/ui/state-message";
import { useToast } from "@/components/ui/toast";

import { approveReport, createReport, markReportShared } from "../actions";

/** Det som behövs för att skapa rapporten om den inte finns (samma val som sidan visar). */
export interface ShareTarget {
  readonly type: "butik" | "bokforing" | "delagare";
  readonly month: string;
  readonly storeId: string | null;
  readonly from: string | null;
  readonly to: string | null;
}

type Step = "idle" | "working" | "ready" | "ask" | "saving";

const NO_SERVER = "Ingen kontakt med servern. Försök igen.";

async function fetchPdf(reportId: string): Promise<File | null> {
  try {
    const res = await fetch(`/rapport/${reportId}/fil/pdf`, { credentials: "same-origin" });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("application/pdf")) {
      return null;
    }
    const name =
      /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "rapport.pdf";
    return new File([await res.blob()], name, { type: "application/pdf" });
  } catch {
    return null;
  }
}

function canShareFile(file: File): boolean {
  try {
    return (
      typeof navigator.share === "function" && navigator.canShare?.({ files: [file] }) === true
    );
  } catch {
    return false;
  }
}

/**
 * Dela-läget (ingen e-post): en knapp, "Dela". Första trycket gör rapporten klar (skapar
 * den om den saknas och godkänner den, då skapas PDF:en) och öppnar sedan telefonens
 * dela-meny med PDF:en. Går PDF:en inte att dela här delas länken till butiksportalen,
 * eller så laddas PDF:en ned. Efteråt frågar vi "Skickade du den?": Ja sparar att månaden
 * är klar (markReportShared). Inget skickas av appen själv.
 */
export function ShareFlow({
  target,
  reportId: initialId,
  approved: initiallyApproved,
  shared,
  sharedText,
  title,
  portal,
}: {
  target: ShareTarget;
  /** Senaste versionen för valet, om den finns och går att godkänna eller dela. */
  reportId: string | null;
  approved: boolean;
  /** Redan markerad som skickad. */
  shared: boolean;
  /** "Skickad 3 nov. 14:02." när den är markerad. */
  sharedText: string | null;
  /** Rubriken i dela-menyn, t.ex. "Butiksrapport oktober 2026, Sega gubben". */
  title: string;
  /** Butiken har en inloggning till butiksportalen: då kan länken dit delas. */
  portal: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Det som gjorts i den här vyn gäller tills sidan laddat om och säger samma sak.
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [approvedHere, setApprovedHere] = useState(false);
  const reportId = createdId ?? initialId;
  const approved = approvedHere || initiallyApproved;
  const [file, setFile] = useState<File | null>(null);
  const loaded = useRef<string | null>(null);

  // PDF:en hämtas i förväg: dela-menyn måste öppnas direkt i trycket (Safari).
  useEffect(() => {
    if (!approved || !reportId || loaded.current === reportId) return;
    loaded.current = reportId;
    let alive = true;
    void fetchPdf(reportId).then((f) => {
      if (alive) setFile(f);
    });
    return () => {
      alive = false;
    };
  }, [approved, reportId]);

  /** Skapar och godkänner vid behov. Returnerar id och PDF:en, eller null vid fel. */
  const prepare = useCallback(async (): Promise<{ id: string; pdf: File | null } | null> => {
    let id = reportId;
    if (!id) {
      const created = await createReport({
        type: target.type,
        month: target.month,
        storeId: target.storeId,
        from: target.from,
        to: target.to,
      }).catch(() => ({ ok: false as const, error: NO_SERVER }));
      if (!created.ok) {
        setError(created.error);
        return null;
      }
      id = created.data.id;
      setCreatedId(id);
    }
    if (!approved) {
      const ok = await approveReport({ reportId: id }).catch(() => ({
        ok: false as const,
        error: NO_SERVER,
      }));
      if (!ok.ok) {
        setError(ok.error);
        return null;
      }
      setApprovedHere(true);
    }
    const pdf = file ?? (await fetchPdf(id));
    loaded.current = id;
    setFile(pdf);
    return { id, pdf };
  }, [approved, file, reportId, target]);

  /** Öppnar dela-menyn. true = delat eller nedladdat, false = avbrutet, null = kräver nytt tryck. */
  const open = useCallback(
    async (id: string, pdf: File | null): Promise<boolean | null> => {
      const link = portal ? `${window.location.origin}/portal/rapporter/${id}` : null;
      try {
        if (pdf && canShareFile(pdf)) {
          await navigator.share({ files: [pdf], title });
          return true;
        }
        if (link && typeof navigator.share === "function") {
          await navigator.share({ title, url: link });
          return true;
        }
      } catch (e) {
        const name = e instanceof DOMException ? e.name : "";
        if (name === "AbortError") return false;
        if (name === "NotAllowedError") return null;
        // Annat fel i dela-menyn: ladda ned i stället.
      }
      // Ingen dela-meny (t.ex. dator): PDF:en laddas ned, eller öppnas för utskrift.
      // En länk i stället för en sidnavigering: adressen är en fil, inte en sida i appen.
      const a = document.createElement("a");
      a.href = `/rapport/${id}/fil/pdf`;
      a.rel = "noopener";
      document.body.append(a);
      a.click();
      a.remove();
      return true;
    },
    [portal, title],
  );

  const share = () => {
    setError(null);
    setNote(null);
    // Redan klar och PDF:en hämtad: dela direkt i trycket.
    if (approved && reportId && step !== "working") {
      void open(reportId, file).then((done) => {
        if (done === null) setNote("Dela-menyn öppnades inte. Tryck Dela igen.");
        else if (done) setStep("ask");
      });
      return;
    }
    setStep("working");
    void (async () => {
      const ready = await prepare();
      if (!ready) return setStep("idle");
      router.refresh();
      const done = await open(ready.id, ready.pdf);
      if (done === null) {
        // Trycket hann gå ut medan rapporten gjordes klar: nästa tryck delar direkt.
        setNote("Rapporten är klar. Tryck Dela en gång till.");
        setStep("ready");
      } else setStep(done ? "ask" : "ready");
    })();
  };

  const confirm = () => {
    if (!reportId) return;
    setStep("saving");
    setError(null);
    void markReportShared({ reportId })
      .catch(() => ({ ok: false as const, error: NO_SERVER }))
      .then((r) => {
        if (!r.ok) {
          setError(r.error);
          setStep("ask");
          return;
        }
        toast({ title: "Sparat", description: "Rapporten räknas som skickad.", tone: "ok" });
        setStep("idle");
        router.refresh();
      });
  };

  const asking = step === "ask" || step === "saving";

  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-line bg-surface p-4 md:p-5"
      data-share-flow={shared ? "shared" : asking ? "ask" : "share"}
    >
      {asking ? (
        <>
          <p className="text-lg font-medium text-fg">Skickade du den?</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              className="min-h-11 max-md:grow"
              iconLeft="check"
              loading={step === "saving"}
              onClick={confirm}
            >
              Ja, skickad
            </Button>
            <Button
              variant="secondary"
              className="min-h-11 max-md:grow"
              disabled={step === "saving"}
              onClick={() => setStep("ready")}
            >
              Inte än
            </Button>
          </div>
        </>
      ) : (
        <>
          {shared && sharedText ? <p className="text-base text-muted">{sharedText}</p> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant={shared ? "secondary" : "primary"}
              className="min-h-11 max-md:w-full"
              iconLeft="external"
              loading={step === "working"}
              onClick={share}
            >
              {step === "working" ? "Gör rapporten klar…" : shared ? "Dela igen" : "Dela"}
            </Button>
            {!shared && approved && reportId ? (
              <button
                type="button"
                className="min-h-11 text-base text-muted underline-offset-4 hover:text-fg hover:underline max-md:w-full"
                onClick={() => setStep("ask")}
              >
                Jag har redan skickat den
              </button>
            ) : null}
          </div>
          {note ? (
            <p role="status" className="text-sm text-fg">
              {note}
            </p>
          ) : !approved ? (
            <p className="text-sm text-muted">
              Läs förhandsvisningen nedan först. Rapporten godkänns när du delar den.
            </p>
          ) : null}
        </>
      )}
      {error ? <StateMessage kind="error" compact message={error} className="px-0" /> : null}
    </div>
  );
}
