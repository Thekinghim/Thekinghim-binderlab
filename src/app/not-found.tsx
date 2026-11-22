import type { Metadata } from "next";
import Link from "next/link";

import { ButtonLink } from "@/components/v2/button";
import { V2Logo } from "@/components/v2/shell/nav-icon";

import "./logga-in/auth.css";

export const metadata: Metadata = { title: "Sidan finns inte" };

/**
 * Adresser som ingen sida svarar på (och notFound() utan egen not-found.tsx längre ner).
 * Utan den här filen visar Next sin engelska standardsida. V2 som sidorna utan inloggning:
 * loggan överst och ett vitt kort mitt på den grå ytan, i Google Sans. Inget skal (sidan kan
 * nås utan inloggning). Hem skickar vidare: butikens användare till portalen, andra till
 * inloggningen.
 */
export default function NotFound() {
  return (
    <div lang="sv" data-ui="v2" className="v2-auth">
      <header className="v2-auth-top">
        <Link href="/" className="v2-auth-brand" aria-label="Binderlab, till startsidan">
          <V2Logo size={28} />
          Binderlab
        </Link>
      </header>
      <main id="main" className="v2-auth-main">
        <div className="v2-card v2-auth-card v2-enter">
          <div className="v2-card-body">
            <div className="v2-auth-hd">
              <h1>Sidan finns inte</h1>
              <p>Adressen kan vara fel eller gammal.</p>
            </div>
            <p className="text-v2-md text-v2-mute">Ingen sida i Binderlab har den här adressen.</p>
            <div className="mt-5 flex flex-wrap gap-2">
              <ButtonLink href="/" variant="act" touch>
                Till Hem
              </ButtonLink>
            </div>
          </div>
        </div>
      </main>
      <footer className="v2-auth-foot" />
    </div>
  );
}
