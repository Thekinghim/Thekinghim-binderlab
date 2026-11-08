"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";

import {
  CHECK_INTERVAL_MS,
  RESUME_AFTER_HIDDEN_MS,
  decideUpdate,
  readAttempt,
  settleAttempt,
  writeAttempt,
  type CheckTrigger,
} from "./app-version";
import {
  fetchLiveBuildId,
  loadedBuildId,
  refreshApp,
  rememberLoadedBuild,
  reportLiveBuild,
  sessionStore,
} from "./refresh-app";
import { hasUnsavedInput } from "./unsaved-input";

/** Telefonen (under lg) eller appen på hemskärmen. Datorn i webbläsaren berörs inte. */
function phoneOrInstalled(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return (
    window.matchMedia("(max-width: 1023.98px)").matches ||
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** Väntan före ett nytt försök när /api/version inte svarade. */
const RETRY_AFTER_MS = 3000;

/** Den kontroll som får göra mest: "resume" (kan ladda om) före "interval" före "load". */
function strongerTrigger(a: CheckTrigger | null, b: CheckTrigger): CheckTrigger {
  const rank: Record<CheckTrigger, number> = { load: 0, interval: 1, resume: 2 };
  return a !== null && rank[a] >= rank[b] ? a : b;
}

/** För felsökning och e2e: "ok" (senaste versionen) eller "ny" (en ny version finns). */
function markState(state: "ok" | "ny"): void {
  document.documentElement.dataset.appVersion = state;
}

/**
 * "Ny version av appen finns" (appens layout och Fyll på). Kontrollerar /api/version när
 * sidan laddas, när appen öppnas igen och var femte minut medan den syns. Finns en ny
 * version visas en ruta överst med Uppdatera. Appen laddar om av sig själv bara när den
 * öppnas igen efter en stund i bakgrunden och inget är ifyllt (se app-version.ts).
 */
export function AppUpdate({ buildId }: { buildId: string }) {
  const [live, setLive] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const checking = useRef(false);
  // En kontroll som kom medan en annan pågick: körs direkt efteråt, så att t.ex. "appen
  // öppnades igen" aldrig tappas för att en kontroll redan var på väg.
  const pending = useRef<CheckTrigger | null>(null);

  useEffect(() => {
    rememberLoadedBuild(buildId);
  }, [buildId]);

  const runCheck = useCallback(async (trigger: CheckTrigger) => {
    const current = loadedBuildId();
    let liveId = await fetchLiveBuildId();
    // Svarade servern inte (svag täckning, upptagen uppkoppling)? Ett nytt försök strax
    // efter, annars dröjer det till nästa kontroll. Utan nät: inget försök.
    if (!liveId && navigator.onLine !== false) {
      await new Promise((r) => setTimeout(r, RETRY_AFTER_MS));
      liveId = await fetchLiveBuildId();
    }
    if (!liveId) return;
    void reportLiveBuild(liveId);
    const storage = sessionStore();
    const read = readAttempt(storage);
    // Kom den nya versionen efter förra omladdningen? Då är försöket klart.
    const attempt = settleAttempt(read.attempt, current);
    if (attempt && attempt !== read.attempt) writeAttempt(storage, attempt);
    const decision = decideUpdate({
      current,
      live: liveId,
      trigger,
      unsaved: hasUnsavedInput(),
      attempt,
      now: Date.now(),
    });
    if (decision === "none") {
      setLive(null);
      markState("ok");
      return;
    }
    markState("ny");
    setLive(liveId);
    if (trigger === "resume") setDismissed(null);
    // Utan fungerande sessionStorage vet appen inte om den redan laddat om: bara rutan.
    if (decision === "auto" && read.usable) {
      setBusy(true);
      const res = await refreshApp({ from: current, to: liveId, auto: true });
      if (!res.ok) setBusy(false);
    }
  }, []);

  const check = useCallback(
    async (trigger: CheckTrigger) => {
      if (!phoneOrInstalled()) return;
      if (checking.current) {
        pending.current = strongerTrigger(pending.current, trigger);
        return;
      }
      checking.current = true;
      try {
        let next: CheckTrigger | null = trigger;
        while (next) {
          pending.current = null;
          await runCheck(next);
          next = pending.current;
        }
      } finally {
        checking.current = false;
        pending.current = null;
      }
    },
    [runCheck],
  );

  useEffect(() => {
    void check("load");
    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      const away = hiddenAt !== null && Date.now() - hiddenAt >= RESUME_AFTER_HIDDEN_MS;
      hiddenAt = null;
      void check(away ? "resume" : "interval");
    };
    // Ur bfcache (Safari visar den gamla sidan utan att ladda om).
    const onPageShow = (e: PageTransitionEvent) => void check(e.persisted ? "resume" : "interval");
    const onOnline = () => void check("interval");
    // Service workern hämtade en nyare sida efter att ha visat den sparade.
    const onWorkerMessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === "page-updated") void check("interval");
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);
    const sw = "serviceWorker" in navigator ? navigator.serviceWorker : null;
    sw?.addEventListener("message", onWorkerMessage);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void check("interval");
    }, CHECK_INTERVAL_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", onOnline);
      sw?.removeEventListener("message", onWorkerMessage);
      window.clearInterval(timer);
    };
  }, [check]);

  const update = async () => {
    if (busy) return;
    if (hasUnsavedInput() && !window.confirm("Det du har fyllt i sparas inte. Uppdatera ändå?")) {
      return;
    }
    setBusy(true);
    setOffline(false);
    const res = await refreshApp({ from: loadedBuildId(), to: live });
    if (!res.ok) {
      setBusy(false);
      setOffline(true);
    }
  };

  if (!live || dismissed === live) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] px-3 pt-[calc(8px+env(safe-area-inset-top))] lg:hidden">
      <div
        role="status"
        aria-label="Ny version av appen"
        className="pointer-events-auto mx-auto flex max-w-[560px] items-center gap-2 rounded-md border border-line-strong bg-surface py-1.5 pr-1 pl-3.5 shadow-[0_8px_24px_-8px_rgb(0_0_0/0.5)]"
        style={{ animation: "bl-enter var(--bl-dur-slow) var(--bl-ease)" }}
      >
        <p className="min-w-0 flex-1 text-base leading-5 text-fg">
          {offline ? "Ingen uppkoppling. Försök igen med nät." : "Ny version av appen finns"}
        </p>
        <button
          type="button"
          onClick={() => void update()}
          disabled={busy}
          className={cn(
            "inline-flex h-11 shrink-0 items-center rounded-sm border border-inverse bg-inverse px-3.5 text-md font-medium text-on-inverse transition-transform active:scale-95",
            busy && "opacity-70",
          )}
        >
          {busy ? "Uppdaterar…" : "Uppdatera"}
        </button>
        <button
          type="button"
          aria-label="Senare"
          onClick={() => setDismissed(live)}
          className="grid size-11 shrink-0 place-items-center rounded-sm text-subtle transition-colors hover:text-fg"
        >
          <Icon name="close" />
        </button>
      </div>
    </div>
  );
}
