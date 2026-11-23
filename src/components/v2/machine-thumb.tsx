import { cn } from "@/lib/cn";

/**
 * Automatens bild. Tills vidare en neutral platshållare (en enkel automat i grått); den riktiga
 * bilden (ägarens foton av maskinerna) byts in här, så att alla sidor får den på en gång.
 * Därför tar komponenten redan emot `machineId` och `model` fast platshållaren inte använder dem.
 *
 * Dekor: automatens namn står alltid bredvid, så bilden är aria-hidden.
 * Storlekar (höjd): xs 26 (listrader), sm 40, md 64 (kort), lg 96 (butikskortets huvud).
 * CSS: src/styles/v2.css, blocket "Automatbild".
 */
export type MachineThumbSize = "xs" | "sm" | "md" | "lg";

export function MachineThumb({
  size = "sm",
  className,
}: {
  machineId?: string | null;
  model?: string | null;
  size?: MachineThumbSize;
  className?: string;
}) {
  return (
    <span aria-hidden="true" className={cn("v2-mthumb", size, className)}>
      <svg viewBox="0 0 52 86" focusable="false">
        <rect className="body" x="1" y="1" width="50" height="84" rx="6" />
        <rect className="glass" x="6" y="7" width="29" height="58" rx="2.5" />
        <path className="shelf" d="M6 21.5h29M6 36h29M6 50.5h29" />
        <rect className="panel" x="39" y="9" width="7" height="9" rx="1.5" />
        <path className="keys" d="M40 23h5M40 27h5M40 31h5" />
        <rect className="slot" x="8" y="71" width="25" height="7" rx="1.5" />
      </svg>
    </span>
  );
}
