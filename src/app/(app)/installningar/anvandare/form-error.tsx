import { Icon } from "@/components/ui/icon";

/** Felrad i ett formulär: ikon och text (inte bara färg), läses upp direkt. */
export function FormError({ message }: { message?: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 text-sm text-signal-fg empty:hidden">
      {message ? (
        <>
          <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
          <span>{message}</span>
        </>
      ) : null}
    </p>
  );
}
