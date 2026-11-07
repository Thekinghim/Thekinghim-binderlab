"use client";

import {
  Children,
  createContext,
  isValidElement,
  use,
  type ReactElement,
  type ReactNode,
} from "react";

/**
 * Flöde mellan ark: en ReportPage vars innehåll inte får plats delas av ReportDocument i
 * flera ark (se report-document.tsx). Ett block (ett barn till ReportPage) flyttas helt till
 * nästa ark, eller delas mellan två rader om det innehåller rader (FlowRows: tabellrader
 * eller en lista). Delen som ett ark visar av ett block står i FlowSliceContext.
 *
 * Komponenterna här tar bara färdiga element (inga funktioner) som props, så att de går att
 * använda från Server Components.
 */

/** Raderna [from, to) av blockets FlowRows. `to` är Infinity för blockets sista del. */
export type FlowSlice = { readonly from: number; readonly to: number };

export const FlowSliceContext = createContext<FlowSlice | null>(null);

/** Satt inuti en ReportSection: sektionens rubrik visar fortsättningen, inte tabellen. */
const SectionContext = createContext(false);

type FlowRowsProps =
  | {
      kind: "table";
      className?: string;
      /** Text för skärmläsare (caption). */
      caption: string;
      colgroup: ReactNode;
      /** Rubrikraden; `headContinued` på ark där tabellen fortsätter. */
      head: ReactNode;
      headContinued: ReactNode;
      rows: ReadonlyArray<ReactNode>;
      /** Summaraden, bara i tabellens sista del. */
      foot?: ReactNode;
      /** Tabellen fortsätter från ett tidigare ark (manuell delning med splitRows). */
      continued?: boolean;
    }
  | {
      kind: "list";
      className?: string;
      rows: ReadonlyArray<ReactNode>;
    };

/**
 * Rader som kan delas mellan ark. Utan FlowSliceContext (utanför ReportDocument, eller i ett
 * block som får plats) visas alla rader.
 */
export function FlowRows(props: FlowRowsProps) {
  const slice = use(FlowSliceContext);
  const inSection = use(SectionContext);
  const from = slice?.from ?? 0;
  const to = Math.min(slice?.to ?? Infinity, props.rows.length);
  const rows = props.rows.slice(from, to);
  const last = to >= props.rows.length;
  if (props.kind === "list") {
    return (
      <ol data-flow-rows="" className={props.className}>
        {rows}
      </ol>
    );
  }
  // I en sektion står fortsättningen i sektionens rubrik; annars i tabellens rubrikrad.
  const continued = props.continued || (from > 0 && !inSection);
  return (
    <table className={props.className}>
      <caption className="sr-only">
        {props.caption}
        {continued || from > 0 ? " (fortsättning)" : ""}
      </caption>
      {props.colgroup}
      <thead>{continued ? props.headContinued : props.head}</thead>
      <tbody data-flow-rows="">{rows}</tbody>
      {last && props.foot ? <tfoot>{props.foot}</tfoot> : null}
    </table>
  );
}

/** Markerar en komponent som renderar FlowRows (för FlowSection, utan RSC). */
export type FlowRowsComponent = { readonly flowRows?: true };

/**
 * Är barnet rader som kan delas? Från en Server Component är typen en klientreferens (ofta
 * lat laddad, inte FlowRows själv), så FlowRows känns igen på sina props.
 */
function isRows(node: ReactNode): boolean {
  if (!isValidElement<Record<string, unknown>>(node)) return false;
  const type = node.type as unknown;
  const props = node.props;
  return (
    type === FlowRows ||
    ((props.kind === "table" || props.kind === "list") && Array.isArray(props.rows)) ||
    (typeof type === "function" && (type as FlowRowsComponent).flowRows === true)
  );
}

/**
 * Sektionens innehåll när den delas: rubriken (eller `continuedHeader` på följande ark),
 * det som står före raderna bara i första delen och det som står efter bara i sista.
 */
export function FlowSection({
  header,
  continuedHeader,
  children,
}: {
  header: ReactNode;
  continuedHeader: ReactNode;
  children?: ReactNode;
}) {
  const slice = use(FlowSliceContext);
  const items = Children.toArray(children);
  const at = items.findIndex(isRows);
  const first = (slice?.from ?? 0) === 0;
  const last = (slice?.to ?? Infinity) === Infinity;
  if (at < 0) {
    // Raderna ligger djupare: allt visas, rubriken som fortsättning på följande ark.
    return (
      <SectionContext value={true}>
        {first ? header : continuedHeader}
        {items}
      </SectionContext>
    );
  }
  return (
    <SectionContext value={true}>
      {first ? header : continuedHeader}
      {first ? items.slice(0, at) : null}
      {items[at] as ReactElement}
      {last ? items.slice(at + 1) : null}
    </SectionContext>
  );
}
