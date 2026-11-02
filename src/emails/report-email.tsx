/**
 * Rapportmejl till butik, bokhållare och delägare.
 *
 * Tabellayout, 600 px, alla stilar inline, inga klasser, ingen SVG och
 * inga bakgrundsbilder. Mejlet är alltid ljust (color-scheme: light only);
 * det tål att klienten inverterar det, eftersom allt bygger på en ljus
 * yta, mörk text och en enda signalfärg som behåller sin kulör.
 *
 * Användning:
 *   const { subject, html, text } = renderReportEmail(props);
 */

import type { CSSProperties, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  formatDate,
  formatDateTime,
  formatDay,
  formatInt,
  formatKronor,
  formatPercent,
  formatSek,
  formatTime,
} from "@/lib/format";
import { normalizePeriod } from "@/lib/period";
import {
  Button,
  EmailWordmark,
  Label,
  MsoClose,
  MsoOpen,
  SectionLabel,
  Table,
  finalizeMsoMarkers,
  mobile,
} from "./primitives";
import {
  DEFAULT_SENDER,
  buildIntro,
  buildPreheader,
  buildReason,
  buildSubject,
  changeGlyph,
  compareLabel,
  ctaLabel,
  dailyRange,
  displayUrl,
  eyebrow,
  fileCount,
  formatBytes,
  formatChange,
  formatKpiValue,
  formatLongDay,
  incidentLine,
  incidentsSummary,
  isImprovement,
  nextPeriodName,
  peakCaption,
  peakDay,
  periodTitle,
  renderReportText,
  rowColumns,
  rowsMeta,
  rowsTitle,
  unsubscribeHref,
  type DailyPoint,
  type EmailAttachment,
  type EmailKpi,
  type LedgerDetails,
  type OwnerDetails,
  type ReportEmailProps,
  type StoreDetails,
} from "./report-content";
import {
  EMAIL_COLOR as C,
  EMAIL_FONT as F,
  EMAIL_GUTTER,
  EMAIL_GUTTER_MOBILE,
  EMAIL_WIDTH,
  bodyStyle,
  css,
  labelStyle,
  tnum,
} from "./theme";

export type * from "./report-content";
export { buildPreheader, buildSubject, renderReportText } from "./report-content";

const LINE = `1px solid ${C.line}`;
const LINE_STRONG = `1px solid ${C.lineStrong}`;
const GUTTER = `${EMAIL_GUTTER}px`;

// ---------------------------------------------------------------------------
// Små delar
// ---------------------------------------------------------------------------

const p0: CSSProperties = { margin: 0 };

function Text({
  children,
  size = 14,
  color = C.muted,
  mono = false,
  style,
}: {
  children: ReactNode;
  size?: 11 | 12 | 13 | 14;
  color?: string;
  mono?: boolean;
  style?: CSSProperties;
}) {
  const lh = size <= 12 ? 18 : size === 13 ? 20 : 22;
  return (
    <p
      style={{
        ...p0,
        fontFamily: mono ? F.mono : F.sans,
        fontSize: `${size}px`,
        lineHeight: `${lh}px`,
        color,
        ...style,
      }}
    >
      {children}
    </p>
  );
}

/** Kvadratisk signalmarkör 8 × 8 px. Står alltid bredvid text som säger samma sak. */
function SignalMark() {
  return (
    <span
      style={{
        display: "inline-block",
        width: "8px",
        height: "8px",
        backgroundColor: C.signal,
        verticalAlign: "0px",
        marginRight: "8px",
      }}
    />
  );
}

function Glyph({ children }: { children: string }) {
  if (!children) return null;
  return (
    <span style={{ fontSize: "8px", lineHeight: "16px", verticalAlign: "1px", marginRight: "4px" }}>
      {children}
    </span>
  );
}

/** En innehållsrad i kortet med mejlets sidomarginal. */
function Row({ children, top = 40, bottom = 0 }: { children: ReactNode; top?: number; bottom?: number }) {
  return (
    <tr>
      <td {...mobile("gutter")} style={{ padding: `${top}px ${GUTTER} ${bottom}px` }}>
        {children}
      </td>
    </tr>
  );
}

function Preheader({ text }: { text: string }) {
  return (
    <div
      style={css({
        display: "none",
        maxHeight: "0",
        overflow: "hidden",
        msoHide: "all",
        fontSize: "1px",
        lineHeight: "1px",
        color: C.bg,
        opacity: 0,
      })}
    >
      {text}
      {/* Utfyllnad så att klienten inte fortsätter förhandstexten med brödtexten. */}
      {" ‌".repeat(90)}
    </div>
  );
}

const th: CSSProperties = {
  ...labelStyle,
  fontWeight: 400,
  padding: "0 0 8px 12px",
  borderBottom: LINE_STRONG,
  whiteSpace: "nowrap",
};

const numCell: CSSProperties = {
  ...tnum,
  fontFamily: F.sans,
  fontSize: "14px",
  lineHeight: "20px",
  color: C.fg,
  padding: "12px 0 12px 12px",
  borderBottom: LINE,
  whiteSpace: "nowrap",
};

// ---------------------------------------------------------------------------
// Block
// ---------------------------------------------------------------------------

function KpiGrid({ kpis, compare }: { kpis: EmailKpi[]; compare: string }) {
  const rows: EmailKpi[][] = [];
  for (let i = 0; i < kpis.length; i += 2) rows.push(kpis.slice(i, i + 2));
  return (
    <Table>
      {rows.map((pair, ri) => (
        <tr key={ri}>
          {pair.map((k, ci) => {
            const good = k.change ? isImprovement(k.change, k.lowerIsBetter) : false;
            return (
              <td
                key={k.label}
                valign="top"
                width={pair.length === 1 ? "100%" : "50%"}
                colSpan={pair.length === 1 ? 2 : undefined}
                style={{
                  width: pair.length === 1 ? "100%" : "50%",
                  padding: ci === 0 ? "18px 16px 20px 0" : "18px 0 20px 20px",
                  borderLeft: ci === 1 ? LINE : undefined,
                  borderBottom: LINE,
                }}
              >
                <Label>{k.label}</Label>
                <p
                  {...mobile("kpi")}
                  style={{
                    ...p0,
                    ...tnum,
                    marginTop: "6px",
                    fontFamily: F.sans,
                    fontSize: "26px",
                    lineHeight: "32px",
                    fontWeight: 500,
                    letterSpacing: "-0.5px",
                    color: C.fg,
                    whiteSpace: "nowrap",
                  }}
                >
                  {formatKpiValue(k)}
                </p>
                {k.change ? (
                  <Text size={12} color={C.subtle} style={{ ...tnum, marginTop: "6px" }}>
                    <span style={{ color: good ? C.fg : C.muted, whiteSpace: "nowrap" }}>
                      <Glyph>{changeGlyph(k.change)}</Glyph>
                      {formatChange(k.change)}
                    </span>{" "}
                    <span style={{ whiteSpace: "nowrap" }}>{compare}</span>
                  </Text>
                ) : null}
                {k.note ? (
                  <Text size={12} color={C.subtle} style={{ ...tnum, marginTop: "6px" }}>
                    {k.note}
                  </Text>
                ) : null}
                {k.alert ? (
                  <Text size={12} color={C.signalFg} style={{ marginTop: "6px" }}>
                    <SignalMark />
                    {k.alert}
                  </Text>
                ) : null}
              </td>
            );
          })}
        </tr>
      ))}
    </Table>
  );
}

/**
 * Stapelrad av tabellceller (Gmail visar inte SVG). Varje dag är en
 * cell med en inre cell vars höjd är värdet. Högsta dagen i signalfärg,
 * och bildtexten under säger vilken dag det är.
 */
function DailyBars({ daily }: { daily: DailyPoint[] }) {
  const H = 72;
  const max = Math.max(...daily.map((d) => d.value), 1);
  const peak = peakDay(daily);
  const colWidth = `${(100 / daily.length).toFixed(2)}%`;
  const first = daily[0];
  const mid = daily[Math.floor(daily.length / 2)];
  const last = daily[daily.length - 1];
  return (
    <>
      <div style={{ height: "20px", lineHeight: "20px", fontSize: "0" }}>{" "}</div>
      <Table>
        <tr>
          {daily.map((d, i) => {
            const h = Math.max(2, Math.round((d.value / max) * H));
            const color = i === peak ? C.signal : C.bar;
            return (
              <td
                key={i}
                valign="bottom"
                width={colWidth}
                height={H}
                style={{ width: colWidth, height: `${H}px`, padding: "0 1px" }}
              >
                <Table>
                  <tr>
                    <td
                      height={h}
                      {...{ bgcolor: color }}
                      style={css({
                        height: `${h}px`,
                        fontSize: "0",
                        lineHeight: "0",
                        msoLineHeightRule: "exactly",
                        backgroundColor: color,
                      })}
                    >
                      {" "}
                    </td>
                  </tr>
                </Table>
              </td>
            );
          })}
        </tr>
      </Table>
      <Table>
        <tr>
          {[first, mid, last].map((d, i) => (
            <td
              key={i}
              width="33%"
              align={i === 0 ? "left" : i === 1 ? "center" : "right"}
              style={{ paddingTop: "8px", borderTop: LINE_STRONG }}
            >
              <Label style={{ ...tnum, textTransform: "none", letterSpacing: "0" }}>
                {d ? formatDay(d.date) : ""}
              </Label>
            </td>
          ))}
        </tr>
      </Table>
      <Text size={13} color={C.muted} style={{ marginTop: "14px" }}>
        <SignalMark />
        {peakCaption(daily)}
      </Text>
    </>
  );
}

function MachineTable({ props }: { props: ReportEmailProps }) {
  const cols = rowColumns(props.recipientKind);
  const ranked = props.recipientKind === "delagare";
  return (
    <table
      width="100%"
      cellPadding={0}
      cellSpacing={0}
      border={0}
      style={{ borderCollapse: "collapse", marginTop: "16px" }}
    >
      <thead>
        <tr>
          <th
            scope="col"
            align="left"
            colSpan={ranked ? 2 : 1}
            style={{ ...th, paddingLeft: 0 }}
          >
            Automat
          </th>
          {cols.map((c) => (
            <th key={c.label} scope="col" align="right" style={th}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {props.rows.map((r, i) => (
          <tr key={r.id}>
            {ranked ? (
              <td
                valign="top"
                width={28}
                style={{
                  ...labelStyle,
                  ...tnum,
                  width: "20px",
                  padding: "14px 8px 12px 0",
                  borderBottom: LINE,
                }}
              >
                {String(i + 1).padStart(2, "0")}
              </td>
            ) : null}
            <th
              scope="row"
              align="left"
              style={{
                fontWeight: 400,
                textAlign: "left",
                verticalAlign: "top",
                padding: "12px 0",
                borderBottom: LINE,
              }}
            >
              <Text color={C.fg} size={14} style={{ lineHeight: "20px" }}>
                {r.name}
              </Text>
              <Text mono size={11} color={C.subtle} style={{ marginTop: "2px", lineHeight: "16px" }}>
                {r.id}
                {r.location ? ` · ${r.location}` : ""}
              </Text>
            </th>
            {cols.map((c) => (
              <td key={c.label} align="right" valign="top" style={numCell}>
                {c.glyph ? <Glyph>{c.glyph(r)}</Glyph> : null}
                {c.value(r)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Rad i en definitionstabell: mono-etikett till vänster, värde till höger. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <tr>
      <td
        valign="top"
        width={112}
        style={{ width: "112px", padding: "13px 12px 11px 0", borderBottom: LINE }}
      >
        <Label>{label}</Label>
      </td>
      <td valign="top" style={{ padding: "12px 0", borderBottom: LINE }}>
        {children}
      </td>
    </tr>
  );
}

function StoreBlock({ d }: { d: StoreDetails }) {
  return (
    <Table style={{ marginTop: "4px" }}>
      <Fact label="I drift">
        <Text color={C.fg} style={tnum}>
          {formatPercent(d.availability)} av öppettiden
        </Text>
      </Fact>
      <Fact label="Avbrott">
        <Text color={C.fg} style={tnum}>
          {incidentsSummary(d.incidents)}
        </Text>
        {d.incidents.map((i) => (
          <Text key={i.start.toISOString()} size={12} color={C.subtle} style={{ ...tnum, marginTop: "2px" }}>
            {incidentLine(i)}
          </Text>
        ))}
      </Fact>
      <Fact label="Mest besökt">
        <Text color={C.fg}>{d.busiest}</Text>
      </Fact>
      <Fact label="Påfyllningar">
        <Text color={C.fg} style={tnum}>
          {formatInt(d.refills.count)}, senast {formatLongDay(d.refills.last).toLocaleLowerCase("sv-SE")}
        </Text>
      </Fact>
      <Fact label="Nästa besök">
        <Text color={C.fg} style={tnum}>
          {formatLongDay(d.nextVisit)} kl. {formatTime(d.nextVisit)}
        </Text>
      </Fact>
      <Fact label="Kontakt">
        <Text color={C.fg}>
          {d.contact.name},{" "}
          <a
            href={`tel:${d.contact.phone.replace(/[^\d+]/g, "")}`}
            style={{ ...tnum, color: C.fg, textDecoration: "underline", whiteSpace: "nowrap" }}
          >
            {d.contact.phone}
          </a>
        </Text>
      </Fact>
    </Table>
  );
}

function LedgerBlock({ d }: { d: LedgerDetails }) {
  return (
    <table
      width="100%"
      cellPadding={0}
      cellSpacing={0}
      border={0}
      style={{ borderCollapse: "collapse", marginTop: "16px" }}
    >
      <thead>
        <tr>
          <th scope="col" align="left" style={{ ...th, paddingLeft: 0 }}>
            Konto
          </th>
          <th scope="col" align="left" style={th}>
            Benämning
          </th>
          <th scope="col" align="left" style={th}>
            Ver.
          </th>
          <th scope="col" align="right" style={th}>
            Belopp
          </th>
        </tr>
      </thead>
      <tbody>
        {d.entries.map((e) => (
          <tr key={`${e.account}-${e.verification}`}>
            <td
              valign="top"
              style={{ ...numCell, fontFamily: F.mono, fontSize: "12px", paddingLeft: 0, color: C.fg }}
            >
              {e.account}
            </td>
            <td
              valign="top"
              style={{ ...numCell, whiteSpace: "normal", color: C.fg }}
            >
              {e.text}
            </td>
            <td
              valign="top"
              style={{ ...numCell, fontFamily: F.mono, fontSize: "12px", color: C.subtle }}
            >
              {e.verification}
            </td>
            <td align="right" valign="top" style={numCell}>
              {formatKronor(e.amount)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Uppställning: text till vänster, belopp till höger, summarader med linje ovanför. */
function Statement({
  lines,
}: {
  lines: Array<{ label: string; value: string; total?: boolean; quiet?: boolean }>;
}) {
  return (
    <Table style={{ marginTop: "8px" }}>
      {lines.map((l) => {
        const cell: CSSProperties = {
          fontFamily: F.sans,
          fontSize: "14px",
          lineHeight: "20px",
          padding: l.total ? "10px 0 8px" : "7px 0",
          borderTop: l.total ? LINE_STRONG : undefined,
          color: l.quiet ? C.subtle : C.fg,
          fontWeight: l.total ? 600 : 400,
        };
        return (
          <tr key={l.label}>
            <td style={cell}>{l.label}</td>
            <td align="right" style={{ ...cell, ...tnum, whiteSpace: "nowrap", paddingLeft: "12px" }}>
              {l.value}
            </td>
          </tr>
        );
      })}
    </Table>
  );
}

function PlanList({ plan }: { plan: OwnerDetails["plan"] }) {
  return (
    <Table style={{ marginTop: "4px" }}>
      {plan.map((item, i) => (
        <tr key={item.title}>
          <td
            valign="top"
            width={28}
            style={{
              ...labelStyle,
              ...tnum,
              width: "20px",
              padding: "14px 8px 12px 0",
              borderBottom: LINE,
            }}
          >
            {String(i + 1).padStart(2, "0")}
          </td>
          <td valign="top" style={{ padding: "12px 0", borderBottom: LINE }}>
            <Text color={C.fg}>{item.title}</Text>
            {item.detail ? (
              <Text size={13} color={C.muted} style={{ marginTop: "2px" }}>
                {item.detail}
              </Text>
            ) : null}
          </td>
          <td align="right" valign="top" style={{ ...numCell, paddingTop: "13px" }}>
            {item.amount === undefined ? "" : formatSek(item.amount)}
          </td>
        </tr>
      ))}
    </Table>
  );
}

function Attachments({ items }: { items: EmailAttachment[] }) {
  return (
    <Table style={{ marginTop: "4px" }}>
      {items.map((a) => (
        <tr key={a.name}>
          <td valign="top" style={{ padding: "12px 0", borderBottom: LINE }}>
            <Text
              mono
              size={12}
              color={C.fg}
              style={{ wordBreak: "break-word", overflowWrap: "anywhere" }}
            >
              {a.name}
            </Text>
            {a.description ? (
              <Text size={13} color={C.muted} style={{ marginTop: "2px" }}>
                {a.description}
              </Text>
            ) : null}
          </td>
          <td
            align="right"
            valign="top"
            style={{ ...numCell, fontFamily: F.mono, fontSize: "12px", color: C.subtle, paddingTop: "12px" }}
          >
            {formatBytes(a.size)}
          </td>
        </tr>
      ))}
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Mejlet
// ---------------------------------------------------------------------------

export function ReportEmail(props: ReportEmailProps) {
  const sender = props.sender ?? DEFAULT_SENDER;
  const [kindLabel, scope] = eyebrow(props);
  const compare = compareLabel(props.period);
  const period = normalizePeriod(props.period);
  const meta = rowsMeta(props);

  // Sektionerna numreras i den ordning de visas, som på /design.
  let n = 0;
  const next = () => (n += 1);

  const sections: ReactNode[] = [];
  sections.push(
    <Row key="kpi">
      <SectionLabel index={next()}>Nyckeltal</SectionLabel>
      <KpiGrid kpis={props.kpis} compare={compare} />
    </Row>,
  );
  if (props.daily && props.daily.length > 1) {
    sections.push(
      <Row key="daily">
        <SectionLabel index={next()} meta={dailyRange(props.daily)}>
          {props.recipientKind === "butik" ? "Försäljning per dag" : "Intäkt per dag"}
        </SectionLabel>
        <DailyBars daily={props.daily} />
      </Row>,
    );
  }
  if (props.recipientKind === "bokforing") {
    sections.push(
      <Row key="ledger">
        <SectionLabel index={next()} meta={props.details.entries.length ? `${props.details.entries.length} rader` : undefined}>
          Sammanställning
        </SectionLabel>
        <LedgerBlock d={props.details} />
      </Row>,
    );
  }
  if (props.rows.length > 0) {
    sections.push(
      <Row key="rows">
        <SectionLabel index={next()} meta={meta}>
          {rowsTitle(props)}
        </SectionLabel>
        <MachineTable props={props} />
      </Row>,
    );
  }
  if (props.recipientKind === "butik") {
    sections.push(
      <Row key="store">
        <SectionLabel index={next()}>Drift och service</SectionLabel>
        <StoreBlock d={props.details} />
      </Row>,
    );
  }
  if (props.recipientKind === "delagare") {
    const d = props.details;
    sections.push(
      <Row key="result">
        <SectionLabel index={next()} meta="exkl. moms">
          Resultat
        </SectionLabel>
        <Statement
          lines={[
            ...d.result.map((r) => ({ label: r.label, value: formatSek(r.amount), total: r.total })),
            { label: "Marginal", value: formatPercent(d.margin), quiet: true },
          ]}
        />
      </Row>,
      <Row key="cash">
        <SectionLabel index={next()}>Kassaflöde</SectionLabel>
        <Statement
          lines={[
            {
              label: `Kassa ${formatDate(period.start, { year: "never" })}`,
              value: formatSek(d.cash.opening),
            },
            { label: "In", value: formatSek(d.cash.inflow) },
            { label: "Ut", value: formatSek(-Math.abs(d.cash.outflow)) },
            {
              label: `Kassa ${formatDate(period.end, { year: "never" })}`,
              value: formatSek(d.cash.closing),
              total: true,
            },
          ]}
        />
      </Row>,
      <Row key="plan">
        <SectionLabel index={next()}>Plan för {nextPeriodName(props.period)}</SectionLabel>
        <PlanList plan={d.plan} />
      </Row>,
    );
  }
  if (props.attachments && props.attachments.length > 0) {
    sections.push(
      <Row key="att">
        <SectionLabel index={next()} meta={fileCount(props.attachments.length)}>
          Bifogat
        </SectionLabel>
        <Attachments items={props.attachments} />
      </Row>,
    );
  }

  const unsubscribe = unsubscribeHref(props);
  const footerMeta = [
    props.generatedAt ? `Skapad ${formatDateTime(props.generatedAt, { year: "always" })}` : "",
    props.reportId ? `Rapport ${props.reportId}` : "",
  ].filter(Boolean);

  return (
    <div role="article" aria-roledescription="e-post" aria-label={buildSubject(props)} lang="sv">
      <Preheader text={buildPreheader(props)} />
      <table
        role="presentation"
        width="100%"
        cellPadding={0}
        cellSpacing={0}
        border={0}
        {...{ bgcolor: C.bg }}
        style={{ borderCollapse: "collapse", backgroundColor: C.bg }}
      >
        <tbody>
          <tr>
            <td align="center" {...mobile("outer")} style={{ padding: "32px 12px 40px" }}>
              <MsoOpen width={EMAIL_WIDTH} />
              <table
                role="presentation"
                width="100%"
                cellPadding={0}
                cellSpacing={0}
                border={0}
                style={{
                  borderCollapse: "separate",
                  width: "100%",
                  maxWidth: `${EMAIL_WIDTH}px`,
                  margin: "0 auto",
                }}
              >
                <tbody>
                  <tr>
                    <td>
                      {/* Kortet */}
                      <table
                        role="presentation"
                        width="100%"
                        cellPadding={0}
                        cellSpacing={0}
                        border={0}
                        {...{ bgcolor: C.surface }}
                        style={{
                          borderCollapse: "separate",
                          backgroundColor: C.surface,
                          border: LINE,
                          borderRadius: "6px",
                        }}
                      >
                        <tbody>
                          <tr>
                            <td
                              {...mobile("gutter")}
                              style={{ padding: `20px ${GUTTER}`, borderBottom: LINE }}
                            >
                              <Table>
                                <tr>
                                  <td valign="middle">
                                    <EmailWordmark />
                                  </td>
                                  {props.reportId ? (
                                    <td valign="middle" align="right">
                                      <Label style={tnum}>{props.reportId}</Label>
                                    </td>
                                  ) : null}
                                </tr>
                              </Table>
                            </td>
                          </tr>

                          <Row top={36}>
                            <p style={p0}>
                              <Label color={C.fg}>{kindLabel}</Label>
                              <Label color={C.faint}>{" / "}</Label>
                              <Label>{scope}</Label>
                            </p>
                            <h1
                              {...mobile("h1")}
                              style={{
                                margin: "12px 0 0",
                                fontFamily: F.sans,
                                fontSize: "26px",
                                lineHeight: "32px",
                                fontWeight: 500,
                                letterSpacing: "-0.6px",
                                color: C.fg,
                              }}
                            >
                              {periodTitle(props.period)}{" "}
                              <span style={{ color: C.subtle }}>{props.summary}</span>
                            </h1>
                            <Text color={C.fg} style={{ marginTop: "24px" }}>
                              Hej {props.recipientName},
                            </Text>
                            <Text style={{ marginTop: "4px" }}>{buildIntro(props)}</Text>
                          </Row>

                          {sections}

                          <Row top={40} bottom={36}>
                            <Button href={props.reportUrl}>{ctaLabel(props.recipientKind)}</Button>
                            <Text mono size={12} color={C.subtle} style={{ marginTop: "14px", wordBreak: "break-word", overflowWrap: "anywhere" }}>
                              <a href={props.reportUrl} style={{ color: C.subtle, textDecoration: "underline" }}>
                                {displayUrl(props.reportUrl)}
                              </a>
                            </Text>
                          </Row>
                        </tbody>
                      </table>
                    </td>
                  </tr>

                  {/* Sidfot */}
                  <tr>
                    <td
                      {...mobile("gutter")}
                      style={{ ...bodyStyle, padding: `24px ${GUTTER} 0` }}
                    >
                      <Text size={12} color={C.subtle}>
                        {sender.name} · {sender.address} ·{" "}
                        <a href={`mailto:${sender.email}`} style={{ color: C.subtle, textDecoration: "underline" }}>
                          {sender.email}
                        </a>
                      </Text>
                      <Text size={12} color={C.subtle} style={{ marginTop: "8px" }}>
                        {buildReason(props, sender)}{" "}
                        <a href={unsubscribe} style={{ color: C.fg, textDecoration: "underline" }}>
                          Avregistrera
                        </a>
                      </Text>
                      {footerMeta.length ? (
                        <Text mono size={11} color={C.subtle} style={{ ...tnum, marginTop: "12px" }}>
                          {footerMeta.join(" · ")}
                        </Text>
                      ) : null}
                    </td>
                  </tr>
                </tbody>
              </table>
              <MsoClose />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dokument
// ---------------------------------------------------------------------------

/**
 * Den enda <style> i mejlet: mobilanpassning för klienter som läser
 * media queries (Apple Mail, iOS, Outlook-apparna). Selektorerna är
 * attributselektorer eftersom mejlet saknar klasser. Utan blocket är
 * mejlet fortfarande läsbart i 320 px: allt är flytande upp till 600 px.
 */
const STYLE = [
  ":root{color-scheme:light only;supported-color-schemes:light only}",
  "table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}",
  "a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important}",
  "@media only screen and (max-width:620px){",
  "[data-m=outer]{padding:12px 8px 32px!important}",
  `[data-m=gutter]{padding-left:${EMAIL_GUTTER_MOBILE}px!important;padding-right:${EMAIL_GUTTER_MOBILE}px!important}`,
  "[data-m=h1]{font-size:22px!important;line-height:28px!important}",
  "[data-m=kpi]{font-size:22px!important;line-height:28px!important}",
  "}",
].join("");

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type RenderedEmail = {
  subject: string;
  /** Förhandstexten (dold i mejlet, visas i inkorgen efter ämnesraden) */
  preheader: string;
  html: string;
  text: string;
};

/** Ämnesrad, förhandstext, komplett HTML-dokument och text/plain-version. */
export function renderReportEmail(props: ReportEmailProps): RenderedEmail {
  const subject = buildSubject(props);
  const body = finalizeMsoMarkers(renderToStaticMarkup(<ReportEmail {...props} />));
  const html = [
    "<!doctype html>",
    '<html lang="sv" dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta http-equiv="X-UA-Compatible" content="IE=edge">',
    '<meta name="x-apple-disable-message-reformatting">',
    '<meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no">',
    '<meta name="color-scheme" content="light only">',
    '<meta name="supported-color-schemes" content="light only">',
    `<title>${escapeHtml(subject)}</title>`,
    "<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->",
    `<style>${STYLE}</style>`,
    "</head>",
    `<body style="margin:0;padding:0;width:100%;background-color:${C.bg};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">`,
    body,
    "</body>",
    "</html>",
  ].join("\n");
  return { subject, preheader: buildPreheader(props), html, text: renderReportText(props) };
}
