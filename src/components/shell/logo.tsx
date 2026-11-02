import { Symbol, Wordmark } from "@/components/brand/wordmark";

/** Binderlab-märket. Behålls för bakåtkompatibilitet; använd Wordmark/Symbol direkt i ny kod. */
export function Logo({ withWordmark = true }: { withWordmark?: boolean }) {
  return withWordmark ? <Wordmark size="sm" /> : <Symbol size={16} title="Binderlab" />;
}
