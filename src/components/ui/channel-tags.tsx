import { channelText } from "@/analytics/visits/fill";
import { cn } from "@/lib/cn";

/** Facken som små monospace-etiketter ("A3–A5", "B1"). Inget utan fack. */
export function ChannelTags({
  channels,
  className,
}: {
  channels: readonly string[];
  className?: string;
}) {
  const text = channelText(channels);
  if (text === "") return null;
  return (
    <span className={cn("inline-flex flex-wrap gap-1", className)} aria-label={`Fack ${text}`}>
      {text.split(" ").map((part) => (
        <span
          key={part}
          className="meta rounded-xs border border-line px-1 leading-4 text-muted"
          aria-hidden
        >
          {part}
        </span>
      ))}
    </span>
  );
}
