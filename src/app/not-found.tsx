import type { Metadata } from "next";
import Link from "next/link";

import { Wordmark } from "@/components/brand/wordmark";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";

export const metadata: Metadata = { title: "Sidan finns inte" };

/**
 * Adresser som ingen sida svarar på (och notFound() utan egen not-found.tsx längre ner).
 * Utan den här filen visar Next sin engelska standardsida. Samma enkla ram som
 * `app/error.tsx`: ordmärket och meddelandet, inget skal (sidan kan nås utan inloggning).
 */
export default function NotFound() {
  return (
    <div className="min-h-dvh overflow-x-clip bg-bg">
      <div className="mx-auto flex min-h-dvh w-full max-w-[1280px] flex-col px-4 md:px-8">
        <header className="flex h-16 items-center">
          <Link href="/" className="rounded-xs" aria-label="Binderlab, till startsidan">
            <Wordmark size="md" />
          </Link>
        </header>
        <main id="main" className="flex flex-1 flex-col gap-8 pt-16 pb-16 md:pt-32">
          <div className="flex w-full max-w-2xl flex-col gap-8 md:ml-16">
            <SectionHeader
              as="h1"
              size="xl"
              eyebrow="404"
              title="Sidan finns inte."
              aside="Adressen kan vara fel eller gammal."
            />
            <StateMessage
              kind="no-results"
              code="Ingen sida"
              message="Ingen sida i Binderlab har den här adressen."
              action={{ label: "Till Hem", href: "/" }}
              className="border-t border-line px-0! pt-8!"
            />
          </div>
        </main>
      </div>
    </div>
  );
}
