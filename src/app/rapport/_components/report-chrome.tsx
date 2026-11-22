import Link from "next/link";
import type { ReactNode } from "react";

import { V2PrintButton } from "./v2-print-button";
import "./report-chrome.css";

/**
 * Ytan runt en rapport i appen (V2): ljust grått skrivbord, en vit verktygsrad med vägen
 * tillbaka, var man är och knapparna (filer, Skriv ut). Bara på skärmen: verktygsraden har
 * data-print="hide" och CSS:en gäller @media screen, så utskriften och PDF:en (samma sida i
 * headless Chromium, print-media) ser ut som förut. Arket (ReportDocument) ändras inte.
 */
export function ReportChrome({
  back,
  crumb,
  actions,
  children,
}: {
  /** Vägen tillbaka, t.ex. { href: "/rapporter?…", label: "Rapporter" }. */
  back: { href: string; label: string };
  /** Var man är ("Butiksrapport · Bio Fyren"). */
  crumb: ReactNode;
  /** Knappar till höger; Skriv ut läggs till sist om `print` inte är false. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="bl-desk rp-chrome min-h-dvh">
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
