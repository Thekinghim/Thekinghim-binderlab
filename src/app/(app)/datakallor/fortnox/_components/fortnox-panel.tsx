"use client";

/**
 * Knapparna och inställningarna för Fortnox: koppla, startmånad, serie, konton, vilka sorters
 * verifikat som skickas, torrkörning/skarpt läge, "Kör nu" och "Koppla från".
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Panel } from "@/components/ui/frame";
import { useToast } from "@/components/ui/toast";

import {
  disconnectFortnox,
  requestFortnoxReversal,
  runFortnoxNow,
  saveFortnoxSettings,
  setFortnoxLive,
  startFortnoxConnect,
} from "../actions";

const FAILED = "Det gick inte att nå servern. Försök igen.";

/** "Koppla Fortnox": hämtar adressen hos Fortnox och går dit. */
export function ConnectButton({ label, disabled }: { label: string; disabled?: boolean }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      variant="primary"
      loading={pending}
      disabled={disabled}
      onClick={() =>
        start(async () => {
          const r = await startFortnoxConnect().catch(() => ({
            ok: false as const,
            error: FAILED,
          }));
          if (!r.ok) {
            toast({ title: "Inte kopplat", description: r.error, tone: "critical" });
            return;
          }
          window.location.assign(r.data.url);
        })
      }
    >
      {label}
    </Button>
  );
}

export interface SettingsValues {
  startMonth: string;
  series: string;
  accounts: Record<string, string>;
  kinds: Record<string, boolean>;
}

export interface AccountField {
  key: string;
  use: string;
  name: string;
  proposal: string | null;
}

export interface KindField {
  key: string;
  label: string;
  help: string;
}

export function SettingsForm({
  initial,
  accounts,
  kinds,
  startLocked,
}: {
  initial: SettingsValues;
  accounts: readonly AccountField[];
  kinds: readonly KindField[];
  /** Verifikat har skickats: startmånaden går inte att ändra. */
  startLocked: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [values, setValues] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  const save = () =>
    start(async () => {
      setError(null);
      const r = await saveFortnoxSettings({
        startMonth: values.startMonth,
        series: values.series,
        mapping: {
          accounts: values.accounts,
          kinds: values.kinds,
        } as Parameters<typeof saveFortnoxSettings>[0]["mapping"],
      }).catch(() => ({ ok: false as const, error: FAILED }));
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast({ title: "Sparat", tone: "ok" });
      router.refresh();
    });

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Input
          label="Bokför från och med"
          name="startMonth"
          type="month"
          required
          disabled={startLocked}
          value={values.startMonth}
          hint={
            startLocked
              ? "Kan inte ändras när verifikat har skickats."
              : "Välj första månaden som INTE redan är bokförd. Utbetalningar och betalningar till butiker för tidigare månader bokförs inte härifrån."
          }
          onChange={(e) => setValues((v) => ({ ...v, startMonth: e.target.value }))}
        />
        <Input
          label="Verifikationsserie i Fortnox"
          name="series"
          required
          maxLength={6}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          value={values.series}
          hint="Serien måste finnas i Fortnox. A är Fortnox vanliga serie."
          onChange={(e) => setValues((v) => ({ ...v, series: e.target.value.toUpperCase() }))}
        />
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="label mb-2 text-subtle">Det här skickas</legend>
        {kinds.map((k) => (
          <label key={k.key} className="flex min-h-11 cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              name={`kind-${k.key}`}
              className="mt-1 size-5 shrink-0 accent-[var(--bl-fg)]"
              checked={values.kinds[k.key] ?? false}
              onChange={(e) =>
                setValues((v) => ({ ...v, kinds: { ...v.kinds, [k.key]: e.target.checked } }))
              }
            />
            <span className="flex min-w-0 flex-col">
              <span className="text-base text-fg">{k.label}</span>
              <span className="text-sm text-muted">{k.help}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <details className="group">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm text-muted hover:text-fg">
          Konton (förslag enligt BAS, fråga redovisningsbyrån)
        </summary>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          {accounts.map((a) => (
            <Input
              key={a.key}
              label={a.use}
              name={`account-${a.key}`}
              inputMode="numeric"
              pattern="[1-8][0-9]{3}"
              maxLength={4}
              autoComplete="off"
              value={values.accounts[a.key] ?? ""}
              placeholder={a.proposal ?? "Inget valt"}
              hint={
                a.proposal
                  ? `Förslag ${a.proposal} ${a.name}`
                  : "Inget förslag. Välj bara om det behövs."
              }
              onChange={(e) =>
                setValues((v) => ({ ...v, accounts: { ...v.accounts, [a.key]: e.target.value } }))
              }
            />
          ))}
        </div>
        <p className="mt-3 text-sm text-muted">
          Övriga konton (försäljning, kortavgift, butikernas andel) ändras under Ekonomi → Bokföring
          → Kontoplan.
        </p>
      </details>

      {error ? (
        <p role="alert" className="text-sm text-signal-fg">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" variant="secondary" loading={pending}>
          Spara
        </Button>
      </div>
    </form>
  );
}

/** Torrkörning ↔ skarpt läge. Att slå på kräver ett andra tryck. */
export function LiveSwitch({ live, canGoLive }: { live: boolean; canGoLive: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState(false);

  const set = (next: boolean) =>
    start(async () => {
      const r = await setFortnoxLive({ live: next }).catch(() => ({
        ok: false as const,
        error: FAILED,
      }));
      setConfirm(false);
      if (!r.ok) {
        toast({ title: "Inte ändrat", description: r.error, tone: "critical" });
        return;
      }
      toast({
        title: next ? "Fortnox är på" : "Tillbaka i torrkörning",
        description: next ? "Verifikaten skickas i natt, eller nu med Kör nu." : undefined,
        tone: "ok",
      });
      router.refresh();
    });

  if (live) {
    return (
      <Button type="button" variant="secondary" loading={pending} onClick={() => set(false)}>
        Pausa (torrkörning)
      </Button>
    );
  }
  if (!confirm) {
    return (
      <Button
        type="button"
        variant="primary"
        disabled={!canGoLive}
        onClick={() => setConfirm(true)}
      >
        Slå på Fortnox
      </Button>
    );
  }
  return (
    <Panel className="flex flex-col gap-3">
      <p className="text-base text-fg">
        Nu börjar verifikaten i listan skickas till Fortnox på riktigt. Ett skickat verifikat tas
        inte bort, det kan bara rättas med ett nytt.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="primary" loading={pending} onClick={() => set(true)}>
          Ja, slå på
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={() => setConfirm(false)}>
          Avbryt
        </Button>
      </div>
    </Panel>
  );
}

export function RunNowButton({ live }: { live: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          type="button"
          variant="secondary"
          loading={pending}
          onClick={() =>
            start(async () => {
              const r = await runFortnoxNow().catch(() => ({ ok: false as const, error: FAILED }));
              setMessage(r.ok ? r.data.message : r.error);
              router.refresh();
            })
          }
        >
          {live ? "Kör nu" : "Räkna om"}
        </Button>
      </div>
      {message ? (
        <p role="status" className="text-sm text-muted">
          {message}
        </p>
      ) : null}
    </div>
  );
}

export function DisconnectButton() {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState(false);
  if (!confirm) {
    return (
      <Button type="button" variant="ghost" onClick={() => setConfirm(true)}>
        Koppla från Fortnox
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="danger"
        loading={pending}
        onClick={() =>
          start(async () => {
            const r = await disconnectFortnox().catch(() => ({
              ok: false as const,
              error: FAILED,
            }));
            setConfirm(false);
            if (!r.ok) {
              toast({ title: "Inte frånkopplat", description: r.error, tone: "critical" });
              return;
            }
            toast({ title: "Fortnox är frånkopplat", tone: "ok" });
            router.refresh();
          })
        }
      >
        Ja, koppla från
      </Button>
      <Button type="button" variant="ghost" disabled={pending} onClick={() => setConfirm(false)}>
        Avbryt
      </Button>
    </div>
  );
}

/** "Rätta": ber om ett nytt verifikat som vänder det gamla. Kräver ett andra tryck. */
export function ReverseButton({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState(false);
  if (!confirm) {
    return (
      <Button type="button" size="sm" variant="secondary" onClick={() => setConfirm(true)}>
        Rätta
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="primary"
        loading={pending}
        onClick={() =>
          start(async () => {
            const r = await requestFortnoxReversal({ id }).catch(() => ({
              ok: false as const,
              error: FAILED,
            }));
            setConfirm(false);
            if (!r.ok) {
              toast({ title: "Inte rättat", description: r.error, tone: "critical" });
              return;
            }
            toast({
              title: "Rättelsen är beställd",
              description: "Ett nytt verifikat vänder det gamla i natt.",
              tone: "ok",
            });
            router.refresh();
          })
        }
      >
        Ja, vänd verifikatet
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => setConfirm(false)}
      >
        Avbryt
      </Button>
    </div>
  );
}
