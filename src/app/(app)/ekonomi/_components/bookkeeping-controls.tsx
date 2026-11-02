"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { formatInt } from "@/lib/format";

import { deliverVouchers } from "../actions";
import { monthText } from "../_lib/view";

/** Väljer bokföringsmånad (?manad=ÅÅÅÅ-MM). Övriga parametrar (period, filter) behålls. */
export function MonthPicker({ months, value }: { months: string[]; value: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  return (
    <Select
      label="Månad"
      value={value}
      aria-busy={pending || undefined}
      wrapperClassName="w-full sm:w-56"
      options={months.map((m) => ({ value: m, label: monthText(m) }))}
      onChange={(e) => {
        const next = new URLSearchParams(params.toString());
        next.set("manad", e.target.value);
        startTransition(() =>
          router.replace(`${pathname}?${next.toString()}#bokforing`, { scroll: false }),
        );
      }}
    />
  );
}

/** Skickar månadens verifikationer till bokföringsprogrammet (bara när ett är kopplat). */
export function DeliverButton({ month, label }: { month: string; label: string }) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await deliverVouchers({ month });
          toast(
            res.ok
              ? {
                  title: `${formatInt(res.data.count)} verifikationer skickade`,
                  description: `${monthText(month)} till ${label}.`,
                  tone: "ok",
                }
              : {
                  title: "Verifikationerna skickades inte",
                  description: res.error,
                  tone: "critical",
                },
          );
        })
      }
    >
      Skicka till {label}
    </Button>
  );
}
