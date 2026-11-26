"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";

import { Sheet } from "@/components/v2/sheet";
import { usePhone } from "@/components/v2/use-media";

/**
 * Prisredigeraren: på dator som förut under tabellen; på telefon ett ark nerifrån när en
 * titel valts (hyllans "+ Sätt pris" eller en rad), som stängs tillbaka till listan.
 * Innehållet renderas bara en gång (antingen här eller i arket), så fältens id är unika.
 * På telefon utan vald titel visas ingen redigerare (CSS döljer den även före hydreringen).
 */
/** Sant inne i telefonens ark: där fälls det som inte behövs för att sätta pris ihop. */
const InSheet = createContext(false);

/**
 * Stänger telefonens ark tillbaka till listan (null utanför arket, på dator). Formuläret anropar
 * den efter en lyckad sparning: annars stod arket kvar med ett tomt fält, och nästa tryck på
 * Spara gav "Ange inköpspriset".
 */
const CloseEditor = createContext<(() => void) | null>(null);

export function useCloseEditor(): (() => void) | null {
  return useContext(CloseEditor);
}

/**
 * Det som inte behövs för att sätta ett pris (Awish-länkarna, Egen produkt, historiken). På
 * dator som förut; i arket hopfällt under formuläret, så att arket blir packen, fälten och
 * Spara.
 */
export function SheetMore({ summary, children }: { summary: string; children: ReactNode }) {
  const inSheet = useContext(InSheet);
  if (!inSheet) return <>{children}</>;
  return (
    <details className="ip-more">
      <summary>{summary}</summary>
      <div className="ip-more-b">{children}</div>
    </details>
  );
}

export function EditorFrame({
  open,
  closeHref,
  title,
  description,
  head,
  children,
}: {
  open: boolean;
  closeHref: string;
  title: string;
  description?: string;
  head?: ReactNode;
  children: ReactNode;
}) {
  const phone = usePhone();
  const router = useRouter();
  const body = useRef<HTMLDivElement>(null);
  const sheetOpen = phone && open;
  // Arket öppnas alltid överst: länkar hit bär "#titel", som annars rullar arket förbi
  // packbilden. Ankaret behövs bara på dator (där redigeraren ligger under listan).
  useEffect(() => {
    if (!sheetOpen) return;
    if (window.location.hash) {
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname + window.location.search,
      );
    }
    const frame = window.requestAnimationFrame(() => {
      let el: HTMLElement | null = body.current;
      while (el) {
        el.scrollTop = 0;
        if (el.classList.contains("v2-sheet")) break;
        el = el.parentElement;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [sheetOpen]);
  if (!phone) return <div className="ip-inline">{children}</div>;
  if (!open) return null;
  // Servern har redan läst om sidans data (server action): listan under är färsk.
  const close = () => router.replace(closeHref, { scroll: false });
  return (
    <Sheet
      open
      onOpenChange={(o) => {
        if (!o) close();
      }}
      title={title}
      description={description}
    >
      <div className="ip-sheet" ref={body}>
        <InSheet.Provider value={true}>
          <CloseEditor.Provider value={close}>
            {head}
            {children}
          </CloseEditor.Provider>
        </InSheet.Provider>
      </div>
    </Sheet>
  );
}
