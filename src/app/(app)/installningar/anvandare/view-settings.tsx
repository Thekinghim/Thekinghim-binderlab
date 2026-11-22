"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { useToast } from "@/components/ui/toast";
import { useT } from "@/i18n/client";
import { LOCALES, LOCALE_NAME, type Locale } from "@/i18n/locale";

import { setInvitationOptions, setMemberLocale, setMemberViewMode } from "./actions";

type ViewMode = "full" | "simple";

/**
 * Enkel vy och språk för en medlem eller en obesvarad inbjudan (Inställningar → Användare).
 * Enkel vy ändrar inte rollen: en delägare behåller ägarrollen men ser bara Fyll på,
 * Försäljning och Mystery. Språket gäller hela appen för personen.
 */
export function ViewSettings({
  target,
  name,
  viewMode,
  locale,
}: {
  target: { kind: "member"; membershipId: string } | { kind: "invitation"; invitationId: string };
  /** Namnet i bekräftelsen ("Mikael ser nu bara den enkla vyn."). */
  name: string;
  viewMode: ViewMode;
  locale: Locale;
}) {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const id = useId();
  const [pending, start] = useTransition();
  const [simple, setSimple] = useState(viewMode === "simple");
  const [lang, setLang] = useState<Locale>(locale);

  const save = (next: { viewMode?: ViewMode; locale?: Locale }) =>
    start(async () => {
      const nextView = next.viewMode ?? (simple ? "simple" : "full");
      const nextLang = next.locale ?? lang;
      const res =
        target.kind === "invitation"
          ? await setInvitationOptions({
              invitationId: target.invitationId,
              viewMode: nextView,
              locale: nextLang,
            })
          : next.viewMode
            ? await setMemberViewMode({ membershipId: target.membershipId, viewMode: nextView })
            : await setMemberLocale({ membershipId: target.membershipId, locale: nextLang });
      if (!res.ok) {
        setSimple(viewMode === "simple");
        setLang(locale);
        toast({ title: t.team.notSaved, description: res.error, tone: "critical" });
        return;
      }
      toast({
        title: next.viewMode
          ? t.team.savedSimple(name, nextView === "simple")
          : t.team.savedLanguage(name),
        tone: "ok",
      });
      router.refresh();
    });

  return (
    <div className="col-span-2 flex flex-col gap-1 rounded-v2 bg-v2-hover px-3 py-1 sm:flex-row sm:items-center sm:justify-between md:col-span-4">
      <label htmlFor={`${id}-enkel`} className="flex min-h-11 cursor-pointer items-center gap-3">
        <input
          id={`${id}-enkel`}
          type="checkbox"
          role="switch"
          aria-checked={simple}
          checked={simple}
          disabled={pending}
          onChange={(e) => {
            setSimple(e.target.checked);
            save({ viewMode: e.target.checked ? "simple" : "full" });
          }}
          className="peer sr-only"
        />
        <span
          aria-hidden
          data-on={simple}
          className="st-switch peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2"
        >
          <span />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="text-v2-md font-[550] text-v2-ink">{t.team.simpleView}</span>
          <span className="text-v2-xs text-v2-mute">{t.team.simpleViewHint}</span>
        </span>
      </label>
      <label htmlFor={`${id}-sprak`} className="flex min-h-11 items-center gap-2">
        <span className="text-v2-sm text-v2-mute">{t.team.language}</span>
        <select
          id={`${id}-sprak`}
          value={lang}
          disabled={pending}
          onChange={(e) => {
            const l = e.target.value as Locale;
            setLang(l);
            save({ locale: l });
          }}
          className="v2-select w-auto"
        >
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {LOCALE_NAME[l]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
