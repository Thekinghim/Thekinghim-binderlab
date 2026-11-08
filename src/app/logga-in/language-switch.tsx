"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { useLocale } from "@/i18n/client";
import { LOCALE_NAME } from "@/i18n/locale";
import { setMyLocale } from "@/server/actions/locale";

/**
 * "English" / "Svenska" uppe till höger på sidorna utan inloggning: byter språk (kakan;
 * inloggad även profilen) och läser om sidan.
 */
export function LanguageSwitch() {
  const locale = useLocale();
  const other = locale === "sv" ? "en" : "sv";
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      lang={other}
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await setMyLocale(other).catch(() => null);
          if (res?.ok) router.refresh();
        })
      }
      className="inline-flex min-h-11 items-center rounded-sm px-2 text-sm text-muted hover:text-fg disabled:text-disabled"
    >
      {LOCALE_NAME[other]}
    </button>
  );
}
