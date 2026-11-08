"use client";

import Link from "next/link";
import { useId, useRef, useState, useTransition, type CSSProperties, type FormEvent } from "react";

import { FormError } from "@/app/logga-in/form-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Modal } from "@/components/ui/modal";
import { SectionHeader } from "@/components/ui/section-header";
import { StatusTag } from "@/components/ui/status-tag";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { formatInt, NBSP } from "@/lib/format";

import type { PersonOption } from "@/analytics/team";

import { PersonPicker } from "../../_team/person-picker";
import { dismissTodo, mergeTitles, registerRefill, undoDismissTodo } from "../actions";
import type {
  DismissedView,
  GroupView,
  LinkActionView,
  MergeActionView,
  RefillActionView,
  TodoView,
} from "../_lib/model";

/** Länk som ser ut som en knapp (sekundär eller ghost, liten). */
const linkButton =
  "inline-flex h-7 items-center justify-center gap-2 rounded-sm border px-2.5 text-sm font-medium whitespace-nowrap transition-colors duration-fast ease-instrument";
const linkVariant = {
  secondary: "border-line-strong bg-surface text-fg hover:border-line-control hover:bg-hover",
  ghost: "border-transparent text-muted hover:bg-hover hover:text-fg",
} as const;

function ActionLink({
  action,
  variant = "secondary",
}: {
  action: LinkActionView;
  variant?: keyof typeof linkVariant;
}) {
  return (
    <Link href={action.href} className={cn(linkButton, linkVariant[variant])}>
      <span>{action.label}</span>
      <Icon name="chevronRight" className="-mr-0.5 shrink-0" />
    </Link>
  );
}

function rowId(key: string): string {
  return `punkt-${key.replace(/[^a-zA-Z0-9-]/g, "-")}`;
}

/** En avbockning gäller punkten med just det fingerprintet (samma regel som på servern). */
function hideId(item: Pick<TodoView, "key" | "fingerprint">): string {
  return `${item.key}\u0000${item.fingerprint}`;
}

/**
 * Grupprubriken på mobil: mindre, och den grå delen på en egen, mindre rad.
 * Från md som förut.
 */
const MOBILE_GROUP_HEADER =
  "max-md:[&_h2]:text-lg max-md:[&_h2>span+span]:block max-md:[&_h2>span+span]:text-base";

/** Notisen med "Ångra" står kvar så här länge (och så länge den har fokus eller hovras). */
const UNDO_TOAST_MS = 15_000;

/**
 * Listan i Att göra: en sektion per brådskenivå, punkterna i den ordning reglerna
 * sorterat dem. Bocka av döljer punkten direkt (med "Ångra" i notisen och i listan
 * "Avbockade"); fokus flyttas till nästa punkt så att tangentbordet inte tappar platsen.
 */
export function TodoBoard({
  groups,
  dismissed,
  canDismiss,
  people = [],
}: {
  groups: GroupView[];
  dismissed: DismissedView[];
  canDismiss: boolean;
  /** Valen för "Vem" (Jag, Delägaren, Båda). Tom = inget val visas. */
  people?: readonly PersonOption[];
}) {
  const toast = useToast();
  /** Avbockade i den här vyn innan servern hunnit räkna om (nyckel + fingerprint). */
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  /** Punkter avbockade här, för listan "Avbockade" tills servern skickat sin. */
  const [local, setLocal] = useState<readonly TodoView[]>([]);
  /** Nycklar som ångrats här, tills servern skickat en ny lista. */
  const [undone, setUndone] = useState<ReadonlySet<string>>(new Set());
  const [, startTransition] = useTransition();
  /** Mobil: gruppen "Senare" är hopfälld tills man öppnar den. */
  const [laterOpen, setLaterOpen] = useState(false);
  const all = groups.flatMap((g) => g.items);
  const isHidden = (t: TodoView) => hidden.has(hideId(t));

  const focusAfter = (key: string) => {
    const visible = all.filter((t) => !isHidden(t));
    const i = visible.findIndex((t) => t.key === key);
    const next = visible[i + 1] ?? visible[i - 1];
    requestAnimationFrame(() => {
      const el = next ? document.getElementById(rowId(next.key)) : document.getElementById("main");
      if (el && !next && !el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
      el?.focus();
    });
  };

  const unhide = (key: string) => {
    setHidden((prev) => new Set([...prev].filter((id) => !id.startsWith(`${key}\u0000`))));
    setLocal((prev) => prev.filter((t) => t.key !== key));
  };

  const undo = (key: string, title: string) => {
    startTransition(async () => {
      const result = await undoDismissTodo({ key });
      if (!result.ok) {
        toast({ title: "Kunde inte ångra", description: result.error, tone: "critical" });
        return;
      }
      unhide(key);
      setUndone((prev) => new Set(prev).add(key));
      toast({
        title: "Ångrad",
        description: title,
        tone: "ok",
      });
    });
  };

  const dismiss = (item: TodoView) => {
    focusAfter(item.key);
    setHidden((prev) => new Set(prev).add(hideId(item)));
    setLocal((prev) => [item, ...prev.filter((t) => t.key !== item.key)]);
    setUndone((prev) => {
      const next = new Set(prev);
      next.delete(item.key);
      return next;
    });
    startTransition(async () => {
      const result = await dismissTodo({ key: item.key, fingerprint: item.fingerprint });
      if (!result.ok) {
        unhide(item.key);
        toast({
          title: "Punkten kunde inte bockas av",
          description: result.error,
          tone: "critical",
        });
        return;
      }
      toast({
        title: "Klar",
        description: item.title,
        tone: "ok",
        duration: UNDO_TOAST_MS,
        action: { label: "Ångra", onClick: () => undo(item.key, item.title) },
      });
    });
  };

  // Avbockade: serverns lista plus det som bockats av här, utan det som ångrats här.
  const serverKeys = new Set(dismissed.map((d) => d.key));
  const dismissedList: DismissedView[] = [
    ...local
      .filter((t) => !serverKeys.has(t.key))
      .map((t) => ({
        key: t.key,
        eyebrow: t.eyebrow,
        title: t.title,
        meta: "Klar nyss av dig.",
      })),
    ...dismissed,
  ].filter((d) => !undone.has(d.key));

  return (
    <div className="flex flex-col">
      {groups.map((g) => {
        const items = g.items.filter((t) => !isHidden(t));
        if (items.length === 0) return null;
        return (
          <section
            key={g.level}
            aria-labelledby={`${g.id}-rubrik`}
            className="scroll-mt-28 border-t border-line pt-8 pb-10 max-md:pt-5 max-md:pb-6 md:pt-10"
          >
            <SectionHeader
              id={`${g.id}-rubrik`}
              title={g.title}
              aside={g.aside}
              className={MOBILE_GROUP_HEADER}
            />
            {g.level === "later" ? (
              <button
                type="button"
                aria-expanded={laterOpen}
                onClick={() => setLaterOpen((v) => !v)}
                className="label mt-3 flex min-h-11 w-full items-center justify-between border-y border-line text-muted md:hidden"
              >
                <span>
                  {laterOpen ? "Dölj" : "Visa"} · {formatInt(items.length)}
                </span>
                <Icon
                  name="chevronRight"
                  size={12}
                  className={cn("transition-transform duration-fast", laterOpen && "rotate-90")}
                />
              </button>
            ) : null}
            <ol
              className={cn(
                "mt-6 flex flex-col max-md:mt-3 md:mt-8",
                g.level === "later" && !laterOpen && "max-md:hidden",
              )}
            >
              {items.map((item, i) => (
                <TodoRow
                  key={item.key}
                  index={i}
                  item={item}
                  canDismiss={canDismiss}
                  onDismiss={() => dismiss(item)}
                  people={people}
                />
              ))}
            </ol>
          </section>
        );
      })}
      {dismissedList.length > 0 ? (
        <DismissedList items={dismissedList} onUndo={(d) => undo(d.key, d.title)} />
      ) : null}
    </div>
  );
}

/** "Visa avbockade (n)": punkter som bockats av de senaste två veckorna, med Ångra. */
function DismissedList({
  items,
  onUndo,
}: {
  items: DismissedView[];
  onUndo: (item: DismissedView) => void;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <section aria-labelledby={`${listId}-rubrik`} className="border-t border-line pt-6 pb-4">
      <h2 id={`${listId}-rubrik`} className="sr-only">
        Klara punkter
      </h2>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className={cn(linkButton, linkVariant.ghost, "-ml-2.5")}
      >
        <Icon
          name="chevronRight"
          size={12}
          className={cn("shrink-0 transition-transform duration-fast", open && "rotate-90")}
        />
        <span>
          {open ? "Dölj klara" : "Visa klara"} ({formatInt(items.length)})
        </span>
      </button>
      <div id={listId} hidden={!open} className="mt-4">
        <ul className="flex flex-col">
          {items.map((d) => (
            <li
              key={d.key}
              className="flex flex-col gap-3 border-t border-line py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-8"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="label text-subtle">{d.eyebrow}</span>
                <span className="text-base text-fg">{d.title}</span>
                <span className="text-sm text-muted">{d.meta}</span>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onUndo(d)}
                aria-label={`Ångra klar: ${d.title}`}
                className="self-start"
              >
                Ångra
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function TodoRow({
  item,
  index,
  canDismiss,
  onDismiss,
  people,
}: {
  item: TodoView;
  /** Plats i gruppen: raderna glider in i tur och ordning. */
  index: number;
  canDismiss: boolean;
  onDismiss: () => void;
  people: readonly PersonOption[];
}) {
  const titleId = useId();
  // Mobil: rubrik och en huvudåtgärd på raden; talen, länken, Vem och (när det finns en
  // annan huvudåtgärd) Klar fälls ut med "Mer". Från md visas allt som förut.
  const [more, setMore] = useState(false);
  const fold = more ? "" : "max-md:hidden";
  const hasPrimary = item.action != null;
  return (
    <li
      id={rowId(item.key)}
      tabIndex={-1}
      aria-labelledby={titleId}
      style={{ "--i": Math.min(index, 8) + 2 } as CSSProperties}
      className="rise grid min-w-0 grid-cols-1 gap-x-8 gap-y-4 border-t border-line py-5 outline-offset-2 first:border-t-0 max-md:gap-x-3 max-md:gap-y-2 max-md:py-3 lg:grid-cols-12"
    >
      <div className="flex min-w-0 flex-col gap-2 max-md:row-start-1 max-md:gap-1 lg:col-span-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StatusTag status={item.status}>{item.statusText}</StatusTag>
          <span className="label text-subtle">{item.eyebrow}</span>
        </div>
        <h3 id={titleId} className="text-md font-medium text-balance hyphens-none text-fg">
          {item.title}
        </h3>
        <details className="group max-w-2xl" onToggle={(e) => setMore(e.currentTarget.open)}>
          <summary className="meta inline-flex cursor-pointer list-none items-center gap-1 rounded-xs text-subtle hover:text-fg max-md:-my-1.5 max-md:min-h-11 max-md:pr-4 [&::-webkit-details-marker]:hidden">
            <Icon
              name="chevronRight"
              size={12}
              className="shrink-0 transition-transform duration-fast group-open:rotate-90"
            />
            <span className="md:hidden">Mer</span>
            <span className="max-md:hidden">Varför</span>
            <span className="sr-only">{`: ${item.title}`}</span>
          </summary>
          <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
            {item.detail ? <p className="text-sm text-muted">{item.detail}</p> : null}
            <p className="text-sm text-subtle">{item.rule}</p>
            {item.evidence.length > 0 ? (
              <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
                {item.evidence.map((f) => (
                  <div
                    key={f.label}
                    className="flex items-baseline justify-between gap-4 border-b border-line py-1.5"
                  >
                    <dt className="text-sm text-muted">{f.label}</dt>
                    <dd className="tnum text-sm text-fg">{f.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        </details>
      </div>

      {item.figures.length > 0 ? (
        <dl
          className={cn(
            "flex min-w-0 flex-wrap gap-x-6 gap-y-2 lg:col-span-3 lg:flex-col lg:gap-y-1.5",
            fold,
          )}
        >
          {item.figures.map((f) => (
            <div
              key={f.label}
              className="flex min-w-0 flex-col gap-0.5 lg:flex-row lg:items-baseline lg:justify-between lg:gap-4"
            >
              <dt className="label text-subtle">{f.label}</dt>
              <dd className="tnum text-base text-fg">{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="hidden lg:col-span-3 lg:block" />
      )}

      <div className="flex flex-wrap items-start gap-2 max-md:contents lg:col-span-3 lg:flex-col lg:items-end">
        {hasPrimary ? (
          <div className="max-md:row-start-2 md:contents max-md:[&>a]:h-11 max-md:[&>a]:w-full max-md:[&>button]:h-11 max-md:[&>button]:w-full">
            {item.action?.kind === "register-refill" ? (
              <RefillDialog action={item.action} />
            ) : item.action?.kind === "merge-titles" ? (
              <MergeDialog action={item.action} />
            ) : item.action?.kind === "link" ? (
              <ActionLink action={item.action} />
            ) : null}
          </div>
        ) : null}
        <div
          className={cn(
            "flex flex-wrap items-center gap-2 max-md:justify-start lg:justify-end max-md:[&_button]:min-h-11",
            hasPrimary && fold,
          )}
        >
          {item.link ? (
            <span className={cn("md:contents max-md:[&>a]:h-11", fold)}>
              <ActionLink action={item.link} variant="ghost" />
            </span>
          ) : null}
          {people.length > 0 ? (
            <span className={cn("md:contents", fold)}>
              <PersonPicker
                target={{ kind: "todo", key: item.key }}
                value={item.assignee}
                options={
                  people.some((p) => p.value === item.assignee)
                    ? people
                    : [...people, { value: item.assignee, label: "Delägaren" }]
                }
                label="Vem"
                editable={canDismiss}
              />
            </span>
          ) : null}
          {canDismiss ? (
            <Button
              size="sm"
              variant="secondary"
              iconLeft="check"
              onClick={onDismiss}
              aria-label={`Klar: ${item.title}`}
            >
              Klar
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Registrera påfyllning
// ---------------------------------------------------------------------------

function RefillDialog({ action }: { action: RefillActionView }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [quantity, setQuantity] = useState(String(action.suggested));
  const hasWarehouse = action.warehouseOnHand !== null;
  const [fromWarehouse, setFromWarehouse] = useState(
    hasWarehouse && (action.warehouseOnHand ?? 0) > 0,
  );
  const [quantityError, setQuantityError] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const formId = useId();
  const warehouseId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const close = () => {
    setOpen(false);
    setQuantityError(undefined);
    setError(undefined);
  };

  /** Varje öppning börjar från dagens förslag (det kan ha ändrats sedan sist). */
  const openDialog = () => {
    setQuantity(String(action.suggested));
    setFromWarehouse(hasWarehouse && (action.warehouseOnHand ?? 0) > 0);
    setQuantityError(undefined);
    setError(undefined);
    setOpen(true);
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const n = Number(quantity.trim());
    if (!Number.isInteger(n) || n < 1 || n > 10_000) {
      setQuantityError("Ange antal pack som ett heltal mellan 1 och 10 000.");
      inputRef.current?.focus();
      return;
    }
    if (fromWarehouse && action.warehouseOnHand !== null && n > action.warehouseOnHand) {
      setQuantityError(
        `Vårt lager har bara ${formatInt(action.warehouseOnHand)}${NBSP}pack. Minska antalet eller bocka ur vårt lager.`,
      );
      inputRef.current?.focus();
      return;
    }
    setQuantityError(undefined);
    setError(undefined);
    startTransition(async () => {
      const result = await registerRefill({
        machineId: action.machineId,
        titleId: action.titleId,
        quantity: n,
        fromWarehouse,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast({
        title: `Klart! ${formatInt(n)}${NBSP}pack påfyllda`,
        description: `${action.titleName} i ${action.machineName}.`,
        tone: "ok",
      });
      close();
    });
  };

  const after = Number.isInteger(Number(quantity)) ? action.onHand + Number(quantity) : null;
  const capped =
    action.unitsInWindow !== null && action.suggested < action.unitsInWindow - action.onHand;

  return (
    <>
      <Button size="sm" variant="secondary" iconLeft="plus" onClick={openDialog}>
        {action.label}
      </Button>
      <Modal
        open={open}
        onClose={close}
        size="sm"
        eyebrow={action.machineCode ? `Påfyllning / ${action.machineCode}` : "Påfyllning"}
        title={`Fyll på ${action.titleName}`}
        description={`${action.machineName}. ${formatInt(action.onHand)}${NBSP}pack i automaten nu.`}
      >
        <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-5">
          <Input
            ref={inputRef}
            label="Antal pack"
            type="number"
            inputMode="numeric"
            min={1}
            max={10_000}
            step={1}
            suffix="pack"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            error={quantityError}
            hint={
              action.unitsInWindow !== null && action.windowDays !== null
                ? `Sålt ${formatInt(action.windowDays)}${NBSP}d: ${formatInt(action.unitsInWindow)}${NBSP}pack.${capped ? " Mer finns inte i lagret." : ""}${after !== null && after > 0 ? ` Efter: ${formatInt(after)}${NBSP}pack.` : ""}`
                : undefined
            }
            required
            autoFocus
          />
          <label
            htmlFor={warehouseId}
            className={cn(
              "flex items-start gap-3 rounded-sm border border-line-control px-3 py-2.5",
              hasWarehouse ? "cursor-pointer hover:bg-hover" : "cursor-not-allowed border-dashed",
            )}
          >
            <input
              id={warehouseId}
              type="checkbox"
              checked={fromWarehouse}
              disabled={!hasWarehouse}
              onChange={(e) => setFromWarehouse(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-[var(--bl-fg)]"
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-base text-fg">Ta packen från vårt lager</span>
              <span className="text-sm text-muted">
                {hasWarehouse
                  ? `${formatInt(action.warehouseOnHand ?? 0)}${NBSP}pack kvar hemma.`
                  : "Inget eget lager."}
              </span>
            </span>
          </label>
          <FormError message={error} />
          <div className="flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:justify-end">
            <Button type="button" onClick={close}>
              Avbryt
            </Button>
            <Button type="submit" variant="primary" loading={pending}>
              Spara
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Slå ihop titlar
// ---------------------------------------------------------------------------

function MergeDialog({ action }: { action: MergeActionView }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [keep, setKeep] = useState<"into" | "from">("into");
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const name = useId();

  const kept = keep === "into" ? action.into : action.from;
  const merged = keep === "into" ? action.from : action.into;

  const close = () => {
    setOpen(false);
    setError(undefined);
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(undefined);
    startTransition(async () => {
      const result = await mergeTitles({ fromTitleId: merged.id, intoTitleId: kept.id });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const moved = result.data?.moved ?? 0;
      toast({
        title: "Titlarna är sammanslagna",
        description: `${formatInt(moved)}${NBSP}order flyttades från "${merged.name}" till "${kept.name}".`,
        tone: "ok",
      });
      close();
    });
  };

  const options = [
    { value: "into" as const, title: action.into },
    { value: "from" as const, title: action.from },
  ];

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Slå ihop
      </Button>
      <Modal
        open={open}
        onClose={close}
        size="md"
        eyebrow="Datakvalitet / Titlar"
        title="Slå ihop två titlar"
        description="Välj namnet som ska gälla. Ordrarna flyttas dit och den andra titeln arkiveras."
      >
        <form onSubmit={submit} className="flex flex-col gap-5">
          <fieldset className="flex min-w-0 flex-col gap-1.5">
            <legend className="label mb-1.5 text-muted">Behåll</legend>
            <div className="flex flex-col rounded-sm border border-line-control">
              {options.map((o) => {
                const checked = keep === o.value;
                return (
                  <label
                    key={o.value}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 border-t border-line px-3 py-2.5 transition-colors first:border-t-0",
                      checked ? "bg-hover" : "hover:bg-hover",
                    )}
                  >
                    <input
                      type="radio"
                      name={name}
                      value={o.value}
                      checked={checked}
                      onChange={() => setKeep(o.value)}
                      className="mt-0.5 size-4 shrink-0 accent-[var(--bl-fg)]"
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-base break-words text-fg">{o.title.name}</span>
                      {o.title.orders !== null ? (
                        <span className="tnum text-sm text-muted">
                          {formatInt(o.title.orders)}
                          {NBSP}order
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <ul className="flex flex-col gap-1.5 text-sm text-muted">
            <li>
              Ordrarna för &quot;{merged.name}&quot; kopplas till &quot;{kept.name}&quot;. Lagret
              flyttas med.
            </li>
            <li>
              Originaldatan behålls: namnet som det stod i ordern och alla alias ändras inte, och
              ändringen loggas.
            </li>
            <li>&quot;{merged.name}&quot; arkiveras och föreslås inte igen.</li>
          </ul>
          <FormError message={error} />
          <div className="flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:justify-end">
            <Button type="button" onClick={close}>
              Avbryt
            </Button>
            <Button type="submit" variant="primary" loading={pending}>
              Slå ihop
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
