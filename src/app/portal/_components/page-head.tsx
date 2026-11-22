import type { ReactNode } from "react";

/**
 * Portalsidans ram i V2 (som V2Page i appen, utan appens verktyg): rubrik 20 px med en grå
 * tillägg (t.ex. månaden), en rad under med läget i klartext och sidans kort under varandra.
 */
export function PortalPage({
  title,
  date,
  sub,
  actions,
  children,
  id,
}: {
  title: ReactNode;
  /** Grå text efter rubriken, t.ex. "oktober 2026". */
  date?: ReactNode;
  /** Raden under rubriken. */
  sub?: ReactNode;
  /** Knappar eller val till höger om rubriken (under den på telefon). */
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <div className="v2-enter">
      <div className="pt-top">
        <h1 id={id}>
          {title}
          {date ? <span className="date">{date}</span> : null}
        </h1>
        {actions ? <div className="acts">{actions}</div> : null}
      </div>
      {sub ? <p className="pt-sub">{sub}</p> : null}
      <div className="pt-body">{children}</div>
    </div>
  );
}

/** Raden överst i ett kort: det viktiga i fetstil, resten grått. */
export function Lead({ strong, rest }: { strong: ReactNode; rest?: ReactNode }) {
  return (
    <p className="pt-lead">
      <b>{strong}</b>
      {rest ? <> {rest}</> : null}
    </p>
  );
}
