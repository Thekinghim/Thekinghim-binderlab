"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select, swedishValidity } from "@/components/ui/field";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag } from "@/components/ui/status-tag";
import { useToast } from "@/components/ui/toast";
import type { RecipientRow } from "@/server/reports/service";

import { createRecipient, setRecipientActive } from "../actions";

const KIND_LABEL: Record<RecipientRow["kind"], string> = {
  store: "Butik",
  accountant: "Bokhållare",
  partner: "Delägare",
};

/**
 * Mottagarna av rapporterna: butikernas kontaktpersoner, bokhållaren och delägaren.
 * En pausad mottagare får inga utskick och räknas inte i Att göra.
 */
export function RecipientsPanel({
  recipients,
  stores,
  canEdit,
  expected,
}: {
  recipients: readonly RecipientRow[];
  stores: readonly { id: string; name: string }[];
  canEdit: boolean;
  expected: { id: string; delivered: boolean }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; email?: string }>({});
  const [kind, setKind] = useState<RecipientRow["kind"]>("store");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [storeId, setStoreId] = useState(stores[0]?.id ?? "");
  const storeName = new Map(stores.map((s) => [s.id, s.name]));
  const delivered = new Map(expected.map((e) => [e.id, e.delivered]));

  function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = e.currentTarget;
    const nameEl = form.elements.namedItem("name") as HTMLInputElement | null;
    const emailEl = form.elements.namedItem("email") as HTMLInputElement | null;
    const next = {
      name: nameEl && !nameEl.checkValidity() ? swedishValidity(nameEl) : undefined,
      email: emailEl && !emailEl.checkValidity() ? swedishValidity(emailEl) : undefined,
    };
    setFieldErrors(next);
    if (next.name || next.email) {
      (next.name ? nameEl : emailEl)?.focus();
      return;
    }
    start(async () => {
      const result = await createRecipient({
        name,
        email,
        kind,
        storeId: kind === "store" ? storeId : null,
      });
      if (!result.ok) return setError(result.error);
      setName("");
      setEmail("");
      toast({ title: "Mottagare tillagd", meta: email, tone: "ok" });
      router.refresh();
    });
  }

  function toggle(r: RecipientRow) {
    setError(null);
    setBusyId(r.id);
    start(async () => {
      const result = await setRecipientActive({ recipientId: r.id, active: !r.active });
      setBusyId(null);
      if (!result.ok) return setError(result.error);
      router.refresh();
    });
  }

  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-8 lg:grid-cols-12">
      <div className="min-w-0 lg:col-span-7">
        {recipients.length === 0 ? (
          <StateMessage kind="empty" compact message="Inga mottagare ännu." />
        ) : (
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {recipients.map((r) => (
              <li
                key={r.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-3"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-base text-fg">
                    {r.name}
                    <span className="text-muted">
                      {" · "}
                      {KIND_LABEL[r.kind]}
                      {r.storeId ? `, ${storeName.get(r.storeId) ?? "okänd butik"}` : ""}
                    </span>
                  </span>
                  <span className="meta truncate text-subtle">{r.email}</span>
                </span>
                <span className="flex items-center gap-2">
                  {!r.active ? (
                    <StatusTag status="offline">Pausad</StatusTag>
                  ) : delivered.get(r.id) ? (
                    <StatusTag status="ok">Fått månadens</StatusTag>
                  ) : delivered.has(r.id) ? (
                    <StatusTag status="warning">Väntar</StatusTag>
                  ) : null}
                  {canEdit ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={pending && busyId === r.id}
                      onClick={() => toggle(r)}
                    >
                      {r.active ? "Pausa" : "Aktivera"}
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {canEdit ? (
        <form onSubmit={add} noValidate className="flex min-w-0 flex-col gap-4 lg:col-span-5">
          <h3 className="label text-muted">Ny mottagare</h3>
          <Select
            label="Typ"
            value={kind}
            onChange={(e) => setKind(e.target.value as RecipientRow["kind"])}
            options={[
              { value: "store", label: "Butik" },
              { value: "accountant", label: "Bokhållare" },
              { value: "partner", label: "Delägare" },
            ]}
          />
          {kind === "store" ? (
            <Select
              label="Butik"
              value={storeId}
              onChange={(e) => setStoreId(e.target.value)}
              options={stores.map((s) => ({ value: s.id, label: s.name }))}
            />
          ) : null}
          <Input
            label="Namn"
            name="name"
            error={fieldErrors.name}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            required
            maxLength={200}
          />
          <Input
            label="E-post"
            type="email"
            name="email"
            error={fieldErrors.email}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
            maxLength={320}
          />
          <div>
            <Button
              type="submit"
              variant="secondary"
              loading={pending && busyId === null}
              iconLeft="plus"
            >
              Lägg till
            </Button>
          </div>
          {error ? <StateMessage kind="error" compact message={error} className="px-0" /> : null}
        </form>
      ) : null}
    </div>
  );
}
