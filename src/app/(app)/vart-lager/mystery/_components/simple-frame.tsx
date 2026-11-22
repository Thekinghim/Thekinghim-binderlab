import type { ReactNode } from "react";

/** Enkel vy: rubrik och rad i V2-storlek, utan V2Page (skalet har redan sitt huvud). */
export function SimpleFrame({
  headline,
  aside,
  children,
}: {
  headline: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-4 px-3 pt-3 pb-8 md:px-6 md:pt-6">
      <header className="flex flex-col gap-0.5 px-0.5">
        <h1 className="text-v2-xl font-[650] text-v2-ink">{headline}</h1>
        {aside ? <p className="text-v2-md text-v2-mute">{aside}</p> : null}
      </header>
      {children}
    </div>
  );
}
