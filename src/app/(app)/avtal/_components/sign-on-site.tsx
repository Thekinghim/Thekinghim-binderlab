"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { QrCode } from "@/components/ui/qr-code";
import { useToast } from "@/components/ui/toast";

import { createSigningLink } from "../actions";

/**
 * Signera på plats: skapar en engångslänk till kontraktets PDF och visar den som stor QR-kod.
 * Butiksägaren skannar med sin mobil, läser, skriver namn och ritar sin signatur. En ny
 * länk ersätter den förra; länken visas bara här.
 */
export function SignOnSite({
  contractId,
  storeName,
  large = false,
}: {
  contractId: string;
  storeName: string;
  /** Stor knapp (sista steget i Skapa kontrakt). */
  large?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const create = () =>
    start(async () => {
      setError(null);
      const res = await createSigningLink(contractId);
      if (res.ok) {
        setLink(res.data);
        setOpen(true);
      } else {
        setError(res.error);
        setOpen(true);
      }
    });

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
    <>
      <Button
        size={large ? "md" : "sm"}
        variant="primary"
        loading={pending}
        onClick={create}
        className={large ? "h-11 px-5 text-base" : undefined}
      >
        Signera på plats
      </Button>
      <Modal
        open={open}
        onClose={close}
        size="sm"
        eyebrow="KONTRAKT / SIGNERA"
        title={error ? "Länken skapades inte" : `Signera med ${storeName}`}
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
                className="inline-flex h-9 items-center rounded-sm border border-inverse bg-inverse px-3.5 text-base font-medium text-on-inverse hover:bg-inverse-hover"
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
          <p className="text-base text-signal-fg">{error}</p>
        )}
      </Modal>
    </>
  );
}
