"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useState, useTransition, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { QrCode } from "@/components/ui/qr-code";
import { useToast } from "@/components/ui/toast";

import { createSigningLink, moveContractStart } from "../actions";

/**
 * Signera på plats: skapar en engångslänk till kontraktets PDF och visar den som stor QR-kod.
 * Butiksägaren skannar med sin mobil, läser, skriver namn och ritar sin signatur. En ny
 * länk ersätter den förra; länken visas bara här.
 *
 * SignScope håller rutan och läget, SignButton är knapparna. Rutan ligger i SignScope och
 * inte i knappen: när "Ändra start till 14 okt." har sparat laddas kortet om och den knappen
 * försvinner, men rutan med QR-koden ska stå kvar.
 */

interface SignState {
  /** Vilken knapp som arbetar just nu. */
  readonly busy: "fix" | "sign" | null;
  /** Startdagen är ändrad i det här besöket: nästa tryck signerar bara. */
  readonly moved: boolean;
  run(kind: "fix" | "sign"): void;
}

const SignContext = createContext<SignState | null>(null);

export function SignScope({
  contractId,
  storeName,
  children,
}: {
  contractId: string;
  storeName: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState(false);
  // Felet gäller flytten av startdagen (inte länken).
  const [moveFailed, setMoveFailed] = useState(false);
  const [busy, setBusy] = useState<"fix" | "sign" | null>(null);
  const [, start] = useTransition();

  const run = (kind: "fix" | "sign") => {
    if (busy) return;
    setBusy(kind);
    start(async () => {
      try {
        setError(null);
        setMoveFailed(false);
        if (kind === "fix" && !moved) {
          const m = await moveContractStart({ contractId });
          if (!m.ok) {
            setMoveFailed(true);
            setError(m.error);
            setOpen(true);
            return;
          }
          setMoved(true);
          toast({ title: "Startdagen är ändrad", tone: "ok", meta: storeName });
          if (m.data.pdf === "stale") {
            setError(
              "Kontraktets PDF säger fortfarande den gamla dagen. Ladda upp en ny PDF innan ni signerar.",
            );
            setOpen(true);
            return;
          }
        }
        const res = await createSigningLink(contractId);
        if (res.ok) setLink(res.data);
        else setError(res.error);
        setOpen(true);
      } finally {
        setBusy(null);
      }
    });
  };

  const close = () => {
    setOpen(false);
    setLink(null);
    // Status och "Signerat" visas när sidan laddas om.
    router.refresh();
  };

  const until = link
    ? new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "long" }).format(
        new Date(link.expiresAt),
      )
    : "";

  return (
    <SignContext.Provider value={{ busy, moved, run }}>
      {children}
      <Modal
        open={open}
        onClose={close}
        size="sm"
        eyebrow="KONTRAKT / SIGNERA"
        title={
          error
            ? moveFailed
              ? "Startdagen ändrades inte"
              : "Länken skapades inte"
            : `Signera med ${storeName}`
        }
        footer={
          link ? (
            <div className="flex w-full flex-wrap justify-end gap-2">
              <Button
                variant="secondary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(link.url);
                    toast({ title: "Länken kopierad", tone: "ok" });
                  } catch {
                    toast({ title: "Kunde inte kopiera", tone: "critical" });
                  }
                }}
              >
                Kopiera länk
              </Button>
              <a
                href={link.url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex h-9 items-center rounded-sm border border-inverse bg-inverse px-3.5 text-base font-medium text-on-inverse hover:bg-inverse-hover max-md:min-h-11"
              >
                Öppna här
              </a>
            </div>
          ) : (
            <Button variant="secondary" onClick={close}>
              Stäng
            </Button>
          )
        }
      >
        {link ? (
          <div className="fade-in flex flex-col items-center gap-4">
            <QrCode
              value={link.url}
              label={`QR-kod för att signera kontraktet med ${storeName}`}
              className="w-full max-w-[280px]"
            />
            <p className="text-center text-base text-fg">Skanna med mobilen.</p>
            <p className="text-center text-sm text-muted">
              Gäller till {until}. Kan användas en gång.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {moved ? <p className="text-base text-fg">Startdagen är ändrad.</p> : null}
            <p className="text-base text-signal-fg">{error}</p>
          </div>
        )}
      </Modal>
    </SignContext.Provider>
  );
}

export function SignButton({
  large = false,
  fixStart,
  quiet = false,
}: {
  /** Stor knapp (sista steget i Skapa kontrakt). */
  large?: boolean;
  /**
   * "Ändra start till 14 okt.": knappen flyttar först kontraktets start (dagen räknas på
   * servern) och öppnar sedan signeringen. `label` är knappens text.
   */
  fixStart?: { readonly label: string };
  /** Sekundär knapp (när kortet har en viktigare knapp bredvid). */
  quiet?: boolean;
}) {
  const state = useContext(SignContext);
  if (!state) throw new Error("SignButton måste ligga i en SignScope.");
  const kind = fixStart ? "fix" : "sign";
  return (
    <Button
      size={large ? "md" : "sm"}
      variant={quiet ? "secondary" : "primary"}
      loading={state.busy === kind}
      disabled={state.busy !== null && state.busy !== kind}
      onClick={() => state.run(kind)}
      className={large ? "h-11 px-5 text-base" : undefined}
      data-fix-start={fixStart ? "" : undefined}
    >
      {fixStart && !state.moved ? fixStart.label : "Signera på plats"}
    </Button>
  );
}

/** En ensam knapp med egen ruta (sista steget i Skapa kontrakt). */
export function SignOnSite({
  contractId,
  storeName,
  large = false,
}: {
  contractId: string;
  storeName: string;
  large?: boolean;
}) {
  return (
    <SignScope contractId={contractId} storeName={storeName}>
      <SignButton large={large} />
    </SignScope>
  );
}
