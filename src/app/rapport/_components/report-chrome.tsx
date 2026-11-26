import Link from "next/link";
import type { ReactNode } from "react";

import { V2PrintButton } from "./v2-print-button";
import "./report-chrome.css";

/**
 * Ytan runt en rapport i appen (V2): ljust grått skrivbord, en vit verktygsrad med vägen
 * tillbaka, var man är och knapparna (filer, Skriv ut). Bara på skärmen: verktygsraden har
 * data-print="hide" och CSS:en gäller @media screen. Arket (ReportDocument) har V2:s typ
 * (Google Sans, inga monospace-etiketter, print.css) på skärmen, i utskriften och i PDF:en.
 */
export function ReportChrome({
  back,
  crumb,
  actions,
  reflow = false,
  children,
}: {
  /** Vägen tillbaka, t.ex. { href: "/rapporter?…", label: "Rapporter" }. */
  back: { href: string; label: string };
  /** Var man är ("Butiksrapport · Bio Fyren"). */
  crumb: ReactNode;
  /** Knappar till höger; Skriv ut läggs till sist om `print` inte är false. */
  actions?: ReactNode;
  /**
   * Under 600 px: arket flödar i skärmens bredd i stället för att krympas till ett A4 i
   * frimärksstorlek. Bara där utskriften inte erbjuds på telefonen (arken mäts för skärmen,
   * och en utskrift därifrån skulle klippas); servern skriver PDF:en med print-media.
   */
  reflow?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="bl-desk rp-chrome min-h-dvh" data-reflow={reflow ? "" : undefined}>
      <div data-print="hide" className="rp-chrome-bar">
        <div className="rp-chrome-in">
          <nav aria-label="Sökväg" className="rp-crumb">
            <Link href={back.href} className="v2-btn quiet back">
              <span aria-hidden="true">←</span>
              {back.label}
            </Link>
            <span className="here">{crumb}</span>
          </nav>
          <div className="rp-acts">{actions ?? <V2PrintButton />}</div>
        </div>
      </div>
      <main className="rp-chrome-main">{children}</main>
    </div>
  );
}
