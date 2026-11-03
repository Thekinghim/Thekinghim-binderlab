"use client";

import { useCallback, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";

import { signContract } from "./actions";
import { SignaturePad, type SignaturePadHandle } from "./signature-pad";

/**
 * Signera i tre steg på mobilen: 1 läs avtalet, 2 skriv namn och rita signaturen,
 * 3 bekräfta. Knappen fungerar först när allt är ifyllt.
 */
export function SignForm({
  token,
  documentSha256,
  storeName,
}: {
  token: string;
  documentSha256: string;
  storeName: string;
}) {
  const pad = useRef<SignaturePadHandle>(null);
  const [name, setName] = useState("");
  const [hasInk, setHasInk] = useState(false);
  const [opened, setOpened] = useState(false);
  const [accept, setAccept] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ signerName: string; signedAt: string } | null>(null);
  const [pending, start] = useTransition();
  const onInk = useCallback((v: boolean) => setHasInk(v), []);

  const ready = name.trim().length >= 2 && hasInk && accept;

  if (done) {
    return <SignedReceipt token={token} signerName={done.signerName} signedAt={done.signedAt} />;
  }

  const submit = () => {
    setError(null);
    const png = pad.current?.toPng();
    if (!png) {
      setError("Rita din signatur.");
      return;
    }
    const form = new FormData();
    form.set("name", name);
    form.set("signature", png);
    form.set("document", documentSha256);
    form.set("accept", accept ? "1" : "0");
    start(async () => {
      const res = await signContract(token, form);
      if (res.ok) setDone({ signerName: res.signerName, signedAt: res.signedAt });
      else setError(res.error);
    });
  };

  return (
    <div className="flex flex-col gap-8">
      <Step n={1} title="Läs avtalet" done={opened}>
        <a
          href={`/signera/${token}/avtal`}
          target="_blank"
          rel="noreferrer noopener"
          onClick={() => setOpened(true)}
          className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-sm border border-line-strong bg-surface px-4 text-base font-medium text-fg hover:border-line-control hover:bg-hover"
        >
          <Icon name="report" />
          Öppna avtalet (PDF)
        </a>
      </Step>

      <Step n={2} title="Skriv namn och signera" done={name.trim().length >= 2 && hasInk}>
        <div className="flex flex-col gap-4">
          <Input
            label="Ditt namn"
            name="name"
            autoComplete="name"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-muted">Rita med fingret</span>
              <button
                type="button"
                className="rounded-xs text-sm text-fg underline-offset-4 hover:underline"
                onClick={() => pad.current?.clear()}
              >
                Rita om
              </button>
            </div>
            <SignaturePad ref={pad} onChange={onInk} label="Rityta för signaturen" />
          </div>
        </div>
      </Step>

      <Step n={3} title="Bekräfta" done={false}>
        <div className="flex flex-col gap-4">
          <label className="flex cursor-pointer items-start gap-3 text-base text-fg">
            <input
              type="checkbox"
              checked={accept}
              onChange={(e) => setAccept(e.target.checked)}
              className="mt-1 size-5 shrink-0 accent-current"
            />
            <span>Jag har läst avtalet och godkänner det för {storeName}.</span>
          </label>
          {error ? (
            <p role="alert" className="fade-in text-base text-signal-fg">
              {error}
            </p>
          ) : null}
          <Button
            variant="primary"
            className="h-12 w-full text-md"
            disabled={!ready}
            loading={pending}
            onClick={submit}
          >
            Signera avtalet
          </Button>
        </div>
      </Step>
    </div>
  );
}

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="rise flex flex-col gap-3" style={{ "--i": n } as React.CSSProperties}>
      <h2 className="flex items-center gap-3 text-md text-fg">
        <span
          aria-hidden
          className={`tnum inline-flex size-7 items-center justify-center rounded-full border text-sm transition-colors ${
            done ? "border-inverse bg-inverse text-on-inverse" : "border-line-strong text-muted"
          }`}
        >
          {done ? <Icon name="check" size={14} /> : n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Kvittot efter signeringen: bock, namn, tid och nedladdning. */
export function SignedReceipt({
  token,
  signerName,
  signedAt,
}: {
  token: string;
  signerName: string;
  signedAt: string;
}) {
  const when = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    dateStyle: "long",
    timeStyle: "short",
  }).format(new Date(signedAt));
  return (
    <div className="rise flex flex-col gap-6" role="status">
      <div className="flex items-center gap-4">
        <svg viewBox="0 0 48 48" className="size-14 shrink-0 text-fg" aria-hidden>
          <circle cx="24" cy="24" r="22" fill="none" stroke="currentColor" strokeWidth="2" />
          <path
            d="M14 25l7 7 13-15"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="draw"
            style={{ "--len": 40 } as React.CSSProperties}
          />
        </svg>
        <div>
          <p className="text-xl font-medium text-fg">Klart! Avtalet är signerat.</p>
          <p className="text-base text-muted">
            {signerName} · {when}
          </p>
        </div>
      </div>
      <a
        href={`/signera/${token}/signerad`}
        className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-sm border border-inverse bg-inverse px-4 text-base font-medium text-on-inverse hover:bg-inverse-hover"
      >
        <Icon name="download" />
        Ladda ner signerat avtal
      </a>
      <p className="text-sm text-muted">Spara filen. Länken fungerar i 30 dagar.</p>
    </div>
  );
}
