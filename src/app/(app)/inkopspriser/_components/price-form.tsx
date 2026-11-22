"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition, type FormEvent } from "react";

import { FormError } from "@/app/logga-in/form-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { isIsoDate } from "@/domain";
import { formatInt, formatKronor, formatPeriodShort, formatSignedKronor } from "@/lib/format";
import { useHydrated } from "@/lib/use-hydrated";

import {
  addPurchasePrice,
  correctPurchasePrice,
  previewPriceSplit,
  setCustomerPrice,
} from "../actions";
import {
  CUSTOMER_PRICE_TEXT,
  PRICE_MESSAGES,
  correctionText,
  correctionToast,
  dayDate,
  formatDayShort,
  kr,
  parseCustomerPriceInput,
  parsePriceInput,
  planCorrection,
  previewPrice,
  priceGap,
  priceGapText,
  priceInputText,
  sentence,
  splitPreviewText,
  type PricePreview,
  type SplitNumbers,
} from "../_lib/model";
import { isPriceDoubt } from "../_lib/price-check";

export interface PriceFormProps {
  titleId: string;
  titleName: string;
  prices: ReadonlyArray<{ unitCostOre: number; validFrom: string }>;
  orderDays: ReadonlyArray<{ date: string; orders: number }>;
  closedMonths: readonly string[];
  today: string;
  /** Fältets etikett (egen produkt: "Kostnad per pack (innehåll)"). */
  label?: string;
  /** Vårt pris som gäller i dag (öre), null = titeln saknar pris i dag. */
  currentCostOre?: number | null;
  /** Pris mot kund på perioden som gäller i dag (öre), null = inte angivet. */
  customerPriceOre?: number | null;
  /** Titelns kvar per order i tabellen (före andel, andel, vår del), null = ingen försäljning. */
  current?: SplitNumbers | null;
  /** Sidans searchParams (period och filter), för förhandsvisningen av kvar per order. */
  query?: string;
  /**
   * Butikens andel visas (vald butik eller "Visa butikernas andel"): andelens namn, t.ex.
   * "Butikens andel" eller "Butikernas andel". null = dold (standard).
   */
  showShare?: string | null;
}

/** "20–26 okt." / "27 okt." (året bara om det inte är i år). */
function span(first: string, last: string, today: string): string {
  return formatPeriodShort({ start: dayDate(first), end: dayDate(last) }, dayDate(today));
}

/** Vad ett pris från ett eget datum gör (bara under "Annat datum…"). */
function datedText(p: PricePreview, today: string): string {
  const until = p.validTo === null ? "tills vidare" : `t.o.m. ${formatDayShort(p.validTo, today)}`;
  if (p.affectedOrders === 0) return `${sentence(`Gäller ${until}`)} Inga sålda order påverkas.`;
  const days = p.firstDate ? span(p.firstDate, p.lastDate ?? p.firstDate, today) : "";
  return `${sentence(`Gäller ${until}`)} ${formatInt(p.affectedOrders)} order (${days}) får nytt inköp, totalt ${formatSignedKronor(kr(p.costDeltaOre))}.`;
}

function Choice({ title, sub }: { title: string; sub: string }) {
  return (
    // Radbrytningen sätts här: cn() slår bara ihop klassnamn, så en "whitespace-normal" på
    // knappen vinner inte över knappens egen "whitespace-nowrap" (texten gick då utanför
    // knappen i en smal spalt).
    <span className="flex flex-col items-start gap-0.5 text-left whitespace-normal">
      <span>{title}</span>
      <span className="text-xs font-normal opacity-75">{sub}</span>
    </span>
  );
}

const CHOICE_CLS = "h-auto min-h-14 justify-start px-4 py-2.5";

type Busy = "correct" | "today" | "dated" | "customer";

/**
 * Nytt inköpspris för en titel med två tydliga val: "Rätta priset" (gäller all försäljning
 * hittills, med förhandsvisning av vad vinsten ändras med) eller "Nytt inköpspris från
 * idag" (äldre försäljning behåller sitt pris). Ett eget datum finns under "Annat datum…".
 *
 * Pris mot kund (valfritt) sparas ihop med vårt pris, eller för sig med "Spara pris mot
 * kund" (då på perioden som gäller i dag). Vår vinst räknas på vårt pris; butikens andel vid
 * vinstdelning räknas på pris mot kund från CUSTOMER_PRICE_SHARE_FROM (profit-split.ts).
 */
export function PriceForm({
  titleId,
  titleName,
  prices,
  orderDays,
  closedMonths,
  today,
  label = "Vårt pris per pack",
  currentCostOre = null,
  customerPriceOre = null,
  current = null,
  query = "",
  showShare = null,
}: PriceFormProps) {
  const router = useRouter();
  const toast = useToast();
  const [amount, setAmount] = useState("");
  const [validFrom, setValidFrom] = useState(today);
  const [note, setNote] = useState("");
  const [amountError, setAmountError] = useState<string>();
  const [customer, setCustomer] = useState(() => priceInputText(customerPriceOre));
  const [customerError, setCustomerError] = useState<string>();
  /** Det sparade priset mot kund (följer det som sparas här, tills sidan lästs om). */
  const [savedCustomerOre, setSavedCustomerOre] = useState<number | null>(customerPriceOre);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<Busy | null>(null);
  const [otherDate, setOtherDate] = useState(false);
  // Servern vill ha ett extra tryck (priset ser fel ut): frågan och hur man sparar ändå.
  const [doubt, setDoubt] = useState<{ text: string; again: () => void } | null>(null);
  // Före hydreringen skulle knappen skicka formuläret som en vanlig sidladdning: priset
  // försvann utan fel. Knapparna är därför avstängda tills sidans skript har laddats.
  const ready = useHydrated();
  // Ett pris som skrevs innan skripten laddats finns bara i fältet, inte i state: det tas
  // med när formuläret hydrerats (annars sa knapparna "Ange inköpspriset" fast det stod där).
  const amountRef = useRef<HTMLInputElement>(null);
  const customerRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const typed = amountRef.current?.value ?? "";
    if (typed !== "") setAmount((current) => (current === "" ? typed : current));
    const start = priceInputText(customerPriceOre);
    const typedCustomer = customerRef.current?.value;
    if (typedCustomer !== undefined && typedCustomer !== start) {
      setCustomer((current) => (current === start ? typedCustomer : current));
    }
    // Bara vid hydreringen: fälten läses en gång.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const parsed = amount.trim() === "" ? null : parsePriceInput(amount);
  const ore = parsed && parsed.ok ? parsed.ore : null;

  // Pris mot kund: tomt fält = inget pris. Skillnaden räknas mot det skrivna priset, annars
  // mot vårt pris i dag.
  const customerParsed = parseCustomerPriceInput(customer);
  const customerOre = customerParsed.ok ? customerParsed.ore : null;
  const gap = priceGap(ore ?? currentCostOre, customerOre);
  const hasCurrentPrice = currentCostOre !== null;
  const customerChanged = customerParsed.ok && customerParsed.ore !== savedCustomerOre;

  const correction = useMemo(
    () =>
      ore === null
        ? null
        : planCorrection({ prices, orderDays, unitCostOre: ore, closedMonths, today }),
    [prices, orderDays, ore, closedMonths, today],
  );

  // Kvar per order med det nya priset: räknas på servern med samma titleEconomics som
  // tabellen (butikens vinstdelning beror på alla titlar i butiken). Bara när titeln sålt.
  const [split, setSplit] = useState<{ ore: number; numbers: SplitNumbers } | null>(null);
  const hasSales = current !== null && current.leftBeforeOre !== null;
  useEffect(() => {
    if (ore === null || !hasSales) return;
    let live = true;
    const timer = setTimeout(() => {
      previewPriceSplit({ titleId, unitCostOre: ore, query })
        .then((r) => {
          if (live && r.ok && r.data) setSplit({ ore, numbers: r.data });
        })
        .catch(() => {});
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [ore, titleId, query, hasSales]);
  const splitLines =
    split && split.ore === ore ? splitPreviewText(split.numbers, current, showShare) : [];

  const dateOk = isIsoDate(validFrom);
  const dated = useMemo(
    () =>
      ore === null || !dateOk
        ? null
        : previewPrice({ titleId, prices, orderDays, unitCostOre: ore, validFrom, closedMonths }),
    [titleId, prices, orderDays, ore, validFrom, closedMonths, dateOk],
  );
  const datedClosed =
    dated && dated.closedMonths.length > 0
      ? PRICE_MESSAGES.closedMonth(dated.closedMonths)
      : undefined;

  /** Läser beloppet; visar felet vid fältet och returnerar null om det inte går. */
  const readAmount = (): number | null => {
    const p = parsePriceInput(amount);
    if (!p.ok) {
      setAmountError(p.message);
      return null;
    }
    setAmountError(undefined);
    return p.ore;
  };

  /** Läser pris mot kund; visar felet vid fältet och returnerar undefined om det inte går. */
  const readCustomer = (): number | null | undefined => {
    const p = parseCustomerPriceInput(customer);
    if (!p.ok) {
      setCustomerError(p.message);
      return undefined;
    }
    setCustomerError(undefined);
    return p.ore;
  };

  const done = () => {
    setAmount("");
    setNote("");
    setValidFrom(today);
    setOtherDate(false);
    // Sidans siffror (Vad varje pack lämnar, kvar per order) läses om direkt; Hem och
    // Lönsamhet är redan omvaliderade av server action. Titeln läggs i adressen, så att
    // redigeraren stannar på den (annars valdes nästa titel som saknar pris).
    const params = new URLSearchParams(window.location.search);
    if (params.get("titel") === titleId) {
      router.refresh();
    } else {
      params.set("titel", titleId);
      router.replace(`${window.location.pathname}?${params.toString()}`, { scroll: false });
    }
  };

  const run = (kind: Busy, work: () => Promise<void>) => {
    setError(undefined);
    setDoubt(null);
    setBusy(kind);
    startTransition(async () => {
      try {
        await work();
      } finally {
        setBusy(null);
      }
    });
  };

  const correct = (confirmed = false) => {
    const unitCostOre = readAmount();
    const customerPrice = readCustomer();
    if (unitCostOre === null || customerPrice === undefined) return;
    if (!correction || correction.start === null) return;
    run("correct", async () => {
      const result = await correctPurchasePrice({
        titleId,
        unitCostOre,
        customerPriceOre: customerPrice,
        note: note.trim() || undefined,
        confirmed,
      });
      if (isPriceDoubt(result)) {
        setDoubt({ text: result.error, again: () => correct(true) });
        return;
      }
      if (!result.ok || !result.data) {
        setError(result.ok ? PRICE_MESSAGES.invalid : result.error);
        return;
      }
      toast({
        title: correctionToast(result.data, showShare),
        description: sentence(`${titleName}: ${formatKronor(kr(unitCostOre))} per pack`),
        tone: "ok",
      });
      setSavedCustomerOre(customerPrice);
      done();
    });
  };

  const saveFrom = (from: string, kind: "today" | "dated", confirmed = false) => {
    const unitCostOre = readAmount();
    const customerPrice = readCustomer();
    if (unitCostOre === null || customerPrice === undefined || !isIsoDate(from)) return;
    if (kind === "dated" && datedClosed) return;
    run(kind, async () => {
      const result = await addPurchasePrice({
        titleId,
        unitCostOre,
        customerPriceOre: customerPrice,
        validFrom: from,
        note: note.trim() || undefined,
        confirmed,
      });
      if (isPriceDoubt(result)) {
        setDoubt({ text: result.error, again: () => saveFrom(from, kind, true) });
        return;
      }
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast({
        title: "Nytt inköpspris sparat",
        description: sentence(
          `${titleName}: ${formatKronor(kr(unitCostOre))} från ${formatDayShort(from, today)}`,
        ),
        tone: "ok",
      });
      // Ett pris från ett senare datum gäller inte i dag: då är dagens pris mot kund orört.
      if (from <= today) setSavedCustomerOre(customerPrice);
      done();
    });
  };

  /** Bara pris mot kund, på perioden som gäller i dag. Vårt pris rörs inte. */
  const saveCustomer = () => {
    const customerPrice = readCustomer();
    if (customerPrice === undefined) return;
    run("customer", async () => {
      const result = await setCustomerPrice({ titleId, customerPriceOre: customerPrice });
      if (!result.ok) {
        setCustomerError(result.error);
        return;
      }
      setSavedCustomerOre(customerPrice);
      toast({
        title: customerPrice === null ? CUSTOMER_PRICE_TEXT.removed : CUSTOMER_PRICE_TEXT.saved,
        description:
          customerPrice === null
            ? sentence(titleName)
            : sentence(`${titleName}: ${formatKronor(kr(customerPrice))} per pack`),
        tone: "ok",
      });
      router.refresh();
    });
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!pending) correct();
  };

  const lines = [
    ...splitLines,
    ...(correction ? correctionText(correction, today, showShare) : []),
  ];
  const correctBlocked = correction !== null && correction.start === null;
  const otherBusy = (kind: Busy) => pending && busy !== kind;

  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-5"
      aria-label={`Nytt inköpspris för ${titleName}`}
    >
      <Input
        ref={amountRef}
        label={label}
        name="unitCost"
        inputMode="decimal"
        autoComplete="off"
        placeholder="0,00"
        suffix="kr"
        className="tnum text-right"
        value={amount}
        onChange={(e) => {
          setAmount(e.target.value);
          setAmountError(undefined);
          setError(undefined);
          setDoubt(null);
        }}
        onBlur={() => {
          if (amount.trim() !== "") {
            const p = parsePriceInput(amount);
            setAmountError(p.ok ? undefined : p.message);
          }
        }}
        error={amountError}
        required
      />

      <div className="flex flex-col gap-3">
        <Input
          ref={customerRef}
          label={CUSTOMER_PRICE_TEXT.field}
          name="customerPrice"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0,00"
          suffix="kr"
          className="tnum text-right"
          value={customer}
          onChange={(e) => {
            setCustomer(e.target.value);
            setCustomerError(undefined);
            setError(undefined);
          }}
          onBlur={() => {
            const p = parseCustomerPriceInput(customer);
            setCustomerError(p.ok ? undefined : p.message);
          }}
          error={customerError}
          hint={CUSTOMER_PRICE_TEXT.hint}
        />
        {gap ? (
          <p aria-live="polite" className="tnum text-sm text-fg">
            {CUSTOMER_PRICE_TEXT.gap} mot vårt pris: {priceGapText(gap)}
          </p>
        ) : null}
        {/* Bara pris mot kund: knappen finns när titeln har ett pris att lägga det på. */}
        {hasCurrentPrice ? (
          <div>
            <Button
              type="button"
              size="sm"
              className="max-md:min-h-11"
              loading={pending && busy === "customer"}
              disabled={!ready || !customerChanged || otherBusy("customer")}
              onClick={saveCustomer}
            >
              {CUSTOMER_PRICE_TEXT.save}
            </Button>
          </div>
        ) : null}
      </div>

      <div aria-live="polite" className="flex flex-col gap-1 text-sm text-fg empty:hidden">
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Button
          type="submit"
          variant="primary"
          className={CHOICE_CLS}
          loading={pending && busy === "correct"}
          disabled={!ready || correctBlocked || otherBusy("correct")}
        >
          <Choice title="Rätta priset" sub="Gäller all försäljning" />
        </Button>
        <Button
          type="button"
          className={CHOICE_CLS}
          loading={pending && busy === "today"}
          disabled={!ready || otherBusy("today")}
          onClick={() => saveFrom(today, "today")}
        >
          <Choice title="Nytt inköpspris från i dag" sub="Äldre försäljning behåller sitt pris" />
        </Button>
      </div>

      <FormError message={error} />
      {doubt ? (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-md border border-signal-line bg-signal-soft px-4 py-3"
        >
          <p className="flex items-start gap-2 text-sm text-fg">
            <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
            <span>{doubt.text}</span>
          </p>
          <div>
            <Button
              type="button"
              variant="primary"
              className="max-md:min-h-11"
              loading={pending}
              onClick={() => doubt.again()}
            >
              Ja, spara ändå
            </Button>
          </div>
        </div>
      ) : null}

      <Input
        label="Anteckning"
        name="note"
        maxLength={200}
        autoComplete="off"
        placeholder="Till exempel ny leverantör"
        hint="Valfri."
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      <div className="flex flex-col">
        {/* En knapp, inte <details>: före hydreringen gör ett klick ingenting (ett öppnat
            <details> gav fel vid hydreringen). */}
        <button
          type="button"
          aria-expanded={otherDate}
          aria-controls={`${titleId}-annat-datum`}
          disabled={!ready}
          onClick={() => setOtherDate((v) => !v)}
          className="meta inline-flex w-fit cursor-pointer items-center gap-1 rounded-xs text-subtle hover:text-fg max-md:min-h-11"
        >
          <Icon
            name="chevronRight"
            size={12}
            className={`shrink-0 transition-transform duration-fast ${otherDate ? "rotate-90" : ""}`}
          />
          Annat datum…
        </button>
        {otherDate ? (
          <div
            id={`${titleId}-annat-datum`}
            className="mt-3 flex flex-col gap-3 border-t border-line pt-3"
          >
            <Input
              label="Giltig från"
              name="validFrom"
              type="date"
              value={validFrom}
              onChange={(e) => {
                setValidFrom(e.target.value);
                setError(undefined);
              }}
              error={!dateOk ? "Ange ett datum." : datedClosed}
            />
            {dated && !datedClosed ? (
              <p className="text-sm text-muted">
                {dated.replaces
                  ? `${sentence(`Ersätter ${formatKronor(kr(dated.replaces.unitCostOre))} från ${formatDayShort(dated.replaces.validFrom, today)}`)} `
                  : ""}
                {datedText(dated, today)}
              </p>
            ) : null}
            <div>
              <Button
                type="button"
                size="sm"
                loading={pending && busy === "dated"}
                disabled={!ready || !dateOk || Boolean(datedClosed) || otherBusy("dated")}
                onClick={() => saveFrom(validFrom, "dated")}
              >
                Spara från {dateOk ? formatDayShort(validFrom, today) : "datumet"}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </form>
  );
}
