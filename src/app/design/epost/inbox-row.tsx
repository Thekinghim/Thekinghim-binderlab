import { Symbol } from "@/components/brand/wordmark";
import type { ReportEmailProps } from "@/emails/report-content";
import { DEFAULT_SENDER } from "@/emails/report-content";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";

/**
 * Mejlet som det syns i inkorgen: avsändare, ämnesrad och förhandstext
 * (preheader) på en rad var. Kortas av som en e-postklient gör.
 */
export function InboxRow({
  props,
  subject,
  preheader,
  className,
}: {
  props: ReportEmailProps;
  subject: string;
  preheader: string;
  className?: string;
}) {
  const sender = props.sender ?? DEFAULT_SENDER;
  const attachments = props.attachments?.length ?? 0;
  return (
    <figure className={cn("m-0 flex min-w-0 flex-col gap-2", className)}>
      <figcaption className="label text-subtle">Inkorg</figcaption>
      <div className="flex min-w-0 gap-3 rounded-sm border border-line bg-surface px-4 py-3">
        <Symbol size={16} className="mt-0.5" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="flex min-w-0 items-baseline justify-between gap-3">
            <span className="truncate text-base font-medium text-fg">
              {sender.name.replace(/ AB$/, "")}
              <span className="font-normal text-subtle"> {sender.email}</span>
            </span>
            <span className="label tnum shrink-0 text-subtle">
              {props.generatedAt ? formatTime(props.generatedAt) : null}
            </span>
          </p>
          <p className="truncate text-base text-fg">{subject}</p>
          <p className="flex min-w-0 items-baseline justify-between gap-3">
            <span className="truncate text-sm text-muted">{preheader}</span>
            {attachments ? (
              <span className="label tnum shrink-0 text-subtle">
                {attachments === 1 ? "1 bilaga" : `${attachments} bilagor`}
              </span>
            ) : null}
          </p>
        </div>
      </div>
    </figure>
  );
}
