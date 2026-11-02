import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";

/**
 * Innehållet i en not-found.tsx inne i ett segment (okänt id): samma uppbyggnad som
 * appens 404 (`app/not-found.tsx`), med tvådelad rubrik som h1 och en åtgärd tillbaka.
 * Ramen (skal, marginaler) kommer från segmentets layout eller `className`.
 */
export function RouteNotFound({
  eyebrow,
  title,
  aside,
  code,
  message,
  action,
  className,
}: {
  /** T.ex. "Inkorg · 404". */
  eyebrow: string;
  /** "Ärendet finns inte." */
  title: string;
  /** Faktum om varför, t.ex. "Länken kan vara fel eller gammal." */
  aside: string;
  code: string;
  message: string;
  action: { label: string; href: string };
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="flex w-full max-w-2xl flex-col gap-8">
        <SectionHeader as="h1" size="xl" eyebrow={eyebrow} title={title} aside={aside} />
        <StateMessage
          kind="no-results"
          code={code}
          message={message}
          action={action}
          className="border-t border-line px-0! pt-8!"
        />
      </div>
    </div>
  );
}
