"use client";

/**
 * Suspense med ett eget felskydd per kort.
 *
 * Hem (och andra sidor med många kort) strömmar varje kort för sig. Bryts strömmen innan ett
 * kort hunnit komma (telefonen byter nät, appen läggs i bakgrunden, Safari: "TypeError: Load
 * failed") kastar React felet i just det kortet. Utan skydd tog det ner hela sidan
 * ("Sidan kunde inte laddas"). Nu stannar felet i kortet: ett nätfel hämtas om i tysthet
 * (router.refresh), och annars visas en liten rad med Försök igen. Resten av sidan står kvar.
 */

import { useRouter } from "next/navigation";
import { Component, Suspense, startTransition, type ReactNode } from "react";

import { isChunkLoadError, isTransientLoadError } from "@/lib/load-error";

/**
 * Bryts strömmen faller ofta många kort på en gång: ett gemensamt router.refresh för alla
 * kort som försöker inom samma ögonblick, i stället för ett per kort.
 */
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function refreshSoon(refresh: () => void) {
  if (refreshTimer !== null) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    startTransition(refresh);
  }, 50);
}

/**
 * En kodfil från ett äldre bygge finns inte kvar: ladda om sidan, men högst en gång per
 * 30 sekunder (sessionStorage), så att det aldrig blir en slinga.
 */
const RELOAD_KEY = "binderlab-kort-omladdning";
function reloadAllowed(): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? 0);
    const now = Date.now();
    if (Number.isFinite(last) && last <= now && now - last < 30_000) return false;
    window.sessionStorage.setItem(RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

/** Så många tysta omförsök per kort innan raden med Försök igen visas. */
const AUTO_RETRIES = 2;

type BoundaryProps = {
  children: ReactNode;
  /** Visas medan ett nytt försök hämtas (samma som Suspense-reserven). */
  fallback: ReactNode;
  /** null: kortet syns inte alls när det inte kan laddas (t.ex. en banner). */
  quiet: boolean;
  onRetry: () => void;
};

type BoundaryState = { error: unknown; retries: number; retrying: boolean };

class CardBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null, retries: 0, retrying: false };
  private timer: number | null = null;
  private listening = false;

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error, retrying: false };
  }

  /**
   * Ett nytt försök (router.refresh) ger nya barn från servern: då släpps felet. Felet släpps
   * inte förrän de har kommit, annars läser React den brutna strömmen igen och kastar igen.
   */
  override componentDidUpdate(prev: BoundaryProps) {
    if (this.state.error !== null && prev.children !== this.props.children) {
      this.clear();
      this.setState({ error: null, retrying: false });
      return;
    }
    this.afterCommit();
  }

  /**
   * Ett nytt försök planeras efter varje commit med fel (inte i componentDidCatch: React kan
   * kasta bort det första försöket att rita trädet och montera om gränsen).
   */
  override componentDidMount() {
    this.afterCommit();
  }

  private afterCommit() {
    if (this.state.error === null || this.state.retrying || this.timer !== null) return;
    if (!this.listening) {
      this.listening = true;
      window.addEventListener("online", this.onBack);
      document.addEventListener("visibilitychange", this.onBack);
    }
    if (isChunkLoadError(this.state.error) && reloadAllowed()) {
      window.location.reload();
      return;
    }
    if (isTransientLoadError(this.state.error) && this.state.retries < AUTO_RETRIES) {
      this.schedule(this.state.retries === 0 ? 400 : 2000);
    }
  }

  override componentWillUnmount() {
    this.clear();
  }

  private clear() {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    if (this.listening) {
      this.listening = false;
      window.removeEventListener("online", this.onBack);
      document.removeEventListener("visibilitychange", this.onBack);
    }
  }

  /** Nätet kom tillbaka eller appen visas igen: försök direkt. */
  private onBack = () => {
    if (this.state.error && document.visibilityState === "visible" && navigator.onLine !== false) {
      this.retry();
    }
  };

  private schedule(ms: number) {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (navigator.onLine === false) return; // väntar på "online"
      this.retry();
    }, ms);
  }

  retry = () => {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.setState((s) => ({ retries: s.retries + 1, retrying: true }));
    this.props.onRetry();
    // Kom inget nytt svar (nätet är fortfarande borta): raden med Försök igen igen.
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (this.state.error !== null) this.setState({ retrying: false });
    }, 8000);
  };

  override render() {
    if (this.state.error === null) {
      return <Suspense fallback={this.props.fallback}>{this.props.children}</Suspense>;
    }
    if (this.props.quiet) return null;
    if (this.state.retrying) return this.props.fallback;
    return (
      <div className="v2-card" role="status">
        <div className="flex items-center justify-between gap-3 px-[18px] py-4">
          <p className="text-v2-md text-v2-mute">Kortet kunde inte laddas.</p>
          <button type="button" className="v2-btn shrink-0" onClick={() => this.retry()}>
            Försök igen
          </button>
        </div>
      </div>
    );
  }
}

/**
 * Som `<Suspense>`, men ett fel i kortet stannar i kortet. `fallback={null}` betyder att
 * kortet inte syns alls när det inte kan laddas.
 */
export function SafeSuspense({ fallback, children }: { fallback: ReactNode; children: ReactNode }) {
  const router = useRouter();
  return (
    <CardBoundary
      quiet={fallback === null}
      fallback={fallback}
      onRetry={() => refreshSoon(router.refresh)}
    >
      {children}
    </CardBoundary>
  );
}
