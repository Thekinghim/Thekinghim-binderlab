import type { ReactNode } from "react";

import { V2Logo } from "@/components/v2/shell/nav-icon";
import { LocaleProvider } from "@/i18n/client";
import type { Locale } from "@/i18n/locale";
import { cn } from "@/lib/cn";

import { LanguageSwitch } from "./language-switch";
import { SystemStatus } from "./system-status";

import "./auth.css";

/** Rubriken utan avslutande punkt (V2: rubriker är namn, inte meningar). */
export function headingText(text: string): string {
  return text.replace(/\.\s*$/, "");
}

/**
 * Ramen för sidorna utan inloggning (/logga-in, /logga-in/bekrafta, /logga-in/nytt-losenord,
 * /inbjudan/[token]) i V2: loggan överst, ett vitt kort mitt på den grå ytan med rubrik, en grå
 * rad under och formuläret, och systemstatus som en liten rad längst ner. Bara ljust läge.
 */
export function AuthFrame({
  title,
  aside,
  children,
  systemStatus = true,
  locale,
  wide = false,
}: {
  /** Kortets rubrik. */
  title: string;
  /** Raden under rubriken: ett faktum. */
  aside?: ReactNode;
  children: ReactNode;
  /**
   * Systemstatus (databasens svarstid, miljö, inloggningssätt) i sidfoten. Av för sidor som
   * visas för andra än personalen, t.ex. en butiks inbjudan.
   */
  systemStatus?: boolean;
  /**
   * Sidans språk (kakan eller webbläsaren, se @/i18n/request). Anges det visas också
   * språkknappen; utan är sidan på svenska (ännu inte översatt).
   */
  locale?: Locale;
  /** Bredare kort (560 px), t.ex. för en inbjudan med uppgifter. */
  wide?: boolean;
}) {
  return (
    <LocaleProvider locale={locale ?? "sv"}>
      <div lang={locale ?? "sv"} data-ui="v2" className="v2-auth">
        <header className="v2-auth-top">
          <a href="/logga-in" className="v2-auth-brand">
            <V2Logo size={28} />
            Binderlab
          </a>
          {locale ? <LanguageSwitch /> : null}
        </header>

        <main id="main" className="v2-auth-main">
          <div className={cn("v2-card v2-auth-card v2-enter", wide && "wide")}>
            <div className="v2-card-body">
              <div className="v2-auth-hd">
                <h1>{headingText(title)}</h1>
                {aside ? <p>{aside}</p> : null}
              </div>
              {children}
            </div>
          </div>
        </main>

        <footer className="v2-auth-foot">
          {systemStatus ? <SystemStatus locale={locale ?? "sv"} /> : null}
        </footer>
      </div>
    </LocaleProvider>
  );
}
