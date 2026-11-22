import { Icon } from "@/components/ui/icon";

/** Felrad i ett formulär: ikon och text (inte bara färg), läses upp direkt. */
export function FormError({ message }: { message?: string }) {
  return (
    <p role="alert" className="v2-auth-err">
      {message ? (
        <>
          <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
          <span>{message}</span>
        </>
      ) : null}
    </p>
  );
}
