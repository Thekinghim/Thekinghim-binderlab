import { Wordmark } from "@/components/brand/wordmark";

import { StateMessage } from "./state-message";

/**
 * Visas i stället för inloggade sidor när servermiljön saknar inställningar
 * (t.ex. Supabase-nycklar i Vercel). Visar bara variabelnamn och regler,
 * aldrig värden.
 */
export function ConfigMissing({ issues }: { issues: readonly string[] }) {
  return (
    <main className="grid-field min-h-dvh px-4 py-16 md:px-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-10">
        <Wordmark size="md" />
        <div className="flex flex-col gap-3">
          <h1 className="text-2xl font-medium text-balance">
            Binderlab är inte konfigurerat än.{" "}
            <span className="text-subtle">{issues.length} inställningar saknas eller är fel.</span>
          </h1>
          <p className="text-base text-muted">
            Lägg in variablerna nedan i Vercel (Settings → Environment Variables) och driftsätt
            igen. Vilka värden som ska in står i docs/miljoer.md.
          </p>
        </div>
        <StateMessage
          kind="not-configured"
          message="Inloggning och data är avstängda tills miljön är komplett."
          action={{ label: "Visa designsystemet", href: "/design" }}
        />
        <ul className="flex flex-col border-t border-line">
          {issues.map((issue) => (
            <li key={issue} className="border-b border-line py-2.5 font-mono text-sm text-muted">
              {issue}
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
