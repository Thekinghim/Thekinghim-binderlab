import { ButtonLink } from "@/components/v2/button";
import { cn } from "@/lib/cn";

/**
 * Innehållet i en not-found.tsx inne i ett segment (okänt id), i V2: ett vitt kort med
 * rubriken som h1, varför i en grå rad, meddelandet och en knapp tillbaka. data-v2-page
 * döljer skalets gamla huvud; data-ui ger V2:s färger även utanför skalet (/rapport/…).
 * Ramen (marginaler) kommer från segmentets layout eller `className`.
 */
export function RouteNotFound({
  title,
  aside,
  message,
  action,
  className,
}: {
  /** Äldre: "Inkorg · 404". Visas inte (ingen etikett ovanför rubriken i V2). */
  eyebrow: string;
  /** "Ärendet finns inte." */
  title: string;
  /** Faktum om varför, t.ex. "Länken kan vara fel eller gammal." */
  aside: string;
  /** Äldre kod ("Ingen automat"). Visas inte. */
  code: string;
  message: string;
  action: { label: string; href: string };
  className?: string;
}) {
  return (
    <div data-ui="v2" data-v2-page className={cn("bg-v2-bg", className)}>
      <div className="v2-card w-full max-w-xl">
        <div className="v2-card-body flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-v2-xl font-[650] text-v2-ink">{title}</h1>
            <p className="text-v2-md text-v2-mute">{aside}</p>
          </div>
          <p className="text-v2-md text-v2-ink">{message}</p>
          <div>
            <ButtonLink href={action.href} variant="act" touch>
              {action.label}
            </ButtonLink>
          </div>
        </div>
      </div>
    </div>
  );
}
