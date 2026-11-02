"use client";

import { useMemo, useState } from "react";
import { domains, layout, tables, type Table } from "./schema";

const BOX_W = 236;
const HEAD = 30;
const ROW = 19;
const PAD_B = 8;
const GAP = 16;
const DOMAIN_LABEL = 30;
const DOMAIN_GAP = 40;
const COL_GAP = 92;
const MARGIN = 24;

type Box = { t: Table; x: number; y: number; h: number; col: number };
type Edge = { from: string; to: string; d: string; key: string };

function boxHeight(t: Table) {
  return HEAD + t.cols.length * ROW + PAD_B;
}

function useGeometry() {
  return useMemo(() => {
    const boxes = new Map<string, Box>();
    const domainLabels: Array<{ x: number; y: number; label: string; index: string }> = [];
    let maxY = 0;
    layout.forEach((stack, col) => {
      const x = MARGIN + col * (BOX_W + COL_GAP);
      let y = MARGIN;
      stack.forEach((dk, si) => {
        if (si > 0) y += DOMAIN_GAP - GAP;
        const d = domains[dk];
        domainLabels.push({ x, y, label: d.label, index: d.index });
        y += DOMAIN_LABEL;
        tables
          .filter((t) => t.domain === dk)
          .forEach((t) => {
            const h = boxHeight(t);
            boxes.set(t.name, { t, x, y, h, col });
            y += h + GAP;
          });
      });
      maxY = Math.max(maxY, y);
    });
    const width = MARGIN * 2 + layout.length * BOX_W + (layout.length - 1) * COL_GAP;
    const height = maxY + MARGIN;

    // Kanter: från FK-raden till målrutans rubrik, ortogonalt via mellanrummet.
    const edges: Edge[] = [];
    const laneCount = new Map<string, number>();
    const nextLane = (k: string) => {
      const n = laneCount.get(k) ?? 0;
      laneCount.set(k, n + 1);
      return n;
    };
    boxes.forEach((src) => {
      src.t.cols.forEach((c, ci) => {
        if (!c.ref) return;
        const dst = boxes.get(c.ref);
        if (!dst) return;
        const sy = src.y + HEAD + ci * ROW + ROW / 2;
        const ty = dst.y + HEAD / 2;
        let d: string;
        if (dst === src) {
          const x0 = src.x + BOX_W;
          d = `M${x0},${sy} H${x0 + 14} V${ty} H${x0}`;
        } else if (dst.col === src.col) {
          const lane = nextLane(`same-${src.col}`);
          const x0 = src.x + BOX_W;
          const gx = x0 + 12 + (lane % 6) * 7;
          d = `M${x0},${sy} H${gx} V${ty} H${x0}`;
        } else if (dst.col > src.col) {
          const lane = nextLane(`gap-${src.col}`);
          const x0 = src.x + BOX_W;
          const gx = x0 + 18 + (lane % 8) * 7;
          d = `M${x0},${sy} H${gx} V${ty} H${dst.x}`;
        } else {
          const lane = nextLane(`gap-${src.col - 1}-l`);
          const x0 = src.x;
          const gx = x0 - 18 - (lane % 8) * 7;
          d = `M${x0},${sy} H${gx} V${ty} H${dst.x + BOX_W}`;
        }
        edges.push({ from: src.t.name, to: dst.t.name, d, key: `${src.t.name}.${c.n}` });
      });
    });
    return { boxes: [...boxes.values()], edges, width, height, domainLabels };
  }, []);
}

export function ErDiagram() {
  const g = useGeometry();
  const [active, setActive] = useState<string | null>(null);

  const related = useMemo(() => {
    if (!active) return null;
    const s = new Set<string>([active]);
    g.edges.forEach((e) => {
      if (e.from === active) s.add(e.to);
      if (e.to === active) s.add(e.from);
    });
    return s;
  }, [active, g.edges]);

  return (
    <div className="relative w-full overflow-x-auto" tabIndex={-1}>
      <svg
        width={g.width}
        height={g.height}
        viewBox={`0 0 ${g.width} ${g.height}`}
        role="group"
        aria-label={`ER-diagram med ${g.boxes.length} tabeller. Fokusera en tabell för att markera dess relationer.`}
        className="block"
        style={{ fontFamily: "var(--bl-font-mono)" }}
      >
        {/* Domänrubriker */}
        {g.domainLabels.map((d) => (
          <g key={d.label}>
            <text
              x={d.x}
              y={d.y + 14}
              style={{ fontSize: 10.5, letterSpacing: "0.08em", fill: "var(--bl-fg)" }}
            >
              {d.index}
            </text>
            <text
              x={d.x + 22}
              y={d.y + 14}
              style={{ fontSize: 10.5, letterSpacing: "0.08em", fill: "var(--bl-fg-subtle)" }}
            >
              {d.label.toUpperCase()}
            </text>
            <line
              x1={d.x}
              x2={d.x + BOX_W}
              y1={d.y + 22}
              y2={d.y + 22}
              style={{ stroke: "var(--bl-line)" }}
            />
          </g>
        ))}

        {/* Relationer */}
        <g fill="none">
          {g.edges.map((e) => {
            const on = active && (e.from === active || e.to === active);
            return (
              <path
                key={e.key}
                d={e.d}
                strokeWidth={on ? 1.25 : 1}
                style={{
                  stroke: on ? "var(--bl-fg)" : "var(--bl-line-control)",
                  opacity: active ? (on ? 1 : 0.12) : 0.55,
                  transition: "opacity 150ms var(--bl-ease)",
                }}
              />
            );
          })}
          {/* Målmarkör: liten fyrkant där relationen landar */}
          {g.edges.map((e) => {
            const on = active && (e.from === active || e.to === active);
            const m = /H([\d.]+)$/.exec(e.d);
            const v = /V([\d.]+) H[\d.]+$/.exec(e.d);
            if (!m || !v) return null;
            const x = Number(m[1]);
            const y = Number(v[1]);
            return (
              <rect
                key={`${e.key}-m`}
                x={x - 2}
                y={y - 2}
                width={4}
                height={4}
                style={{
                  fill: on ? "var(--bl-fg)" : "var(--bl-line-control)",
                  opacity: active ? (on ? 1 : 0.12) : 0.8,
                }}
              />
            );
          })}
        </g>

        {/* Tabeller */}
        {g.boxes.map((b) => {
          const dim = related && !related.has(b.t.name);
          const isActive = active === b.t.name;
          const refs = b.t.cols.filter((c) => c.ref).map((c) => c.ref);
          return (
            <g
              key={b.t.name}
              transform={`translate(${b.x},${b.y})`}
              tabIndex={0}
              role="button"
              aria-label={`${b.t.name}, ${b.t.cols.length} kolumner${refs.length ? `, refererar ${[...new Set(refs)].join(", ")}` : ""}. ${
                b.t.access === "refiller"
                  ? "Synlig för påfyllare."
                  : "Endast ägare, admin och läsare."
              }`}
              onPointerEnter={() => setActive(b.t.name)}
              onPointerLeave={() => setActive(null)}
              onFocus={() => setActive(b.t.name)}
              onBlur={() => setActive(null)}
              className="outline-none [&:focus-visible>rect:first-child]:[stroke:var(--bl-focus)] [&:focus-visible>rect:first-child]:[stroke-width:2]"
              style={{
                opacity: dim ? 0.35 : 1,
                transition: "opacity 150ms var(--bl-ease)",
                cursor: "default",
              }}
            >
              <rect
                x={0.5}
                y={0.5}
                width={BOX_W - 1}
                height={b.h - 1}
                rx={4}
                strokeDasharray={b.t.view ? "3 2" : undefined}
                style={{
                  fill: "var(--bl-surface)",
                  stroke: isActive
                    ? "var(--bl-fg)"
                    : b.t.later
                      ? "var(--bl-line)"
                      : "var(--bl-line-strong)",
                }}
              />
              <path d={`M0.5,${HEAD} H${BOX_W - 0.5}`} style={{ stroke: "var(--bl-line)" }} />
              {/* Åtkomst: fylld = påfyllare ser, ihålig = endast ägare/admin/läsare */}
              {b.t.access === "refiller" ? (
                <rect
                  x={10}
                  y={HEAD / 2 - 3.5}
                  width={7}
                  height={7}
                  style={{ fill: "var(--bl-fg)" }}
                />
              ) : (
                <rect
                  x={10.5}
                  y={HEAD / 2 - 3}
                  width={6}
                  height={6}
                  fill="none"
                  style={{ stroke: "var(--bl-fg-subtle)" }}
                />
              )}
              <text
                x={24}
                y={HEAD / 2 + 4}
                style={{
                  fontSize: 11.5,
                  fill: b.t.later ? "var(--bl-fg-muted)" : "var(--bl-fg)",
                  fontWeight: 500,
                }}
              >
                {b.t.name}
              </text>
              <TableTags t={b.t} />
              {b.t.cols.map((c, i) => {
                const y = HEAD + i * ROW + ROW / 2 + 4;
                return (
                  <g key={c.n}>
                    <text
                      x={10}
                      y={y}
                      style={{
                        fontSize: 9,
                        letterSpacing: "0.04em",
                        fill: c.k === "pk" ? "var(--bl-fg)" : "var(--bl-fg-subtle)",
                      }}
                    >
                      {c.k === "pk" ? "PK" : c.k === "fk" ? "FK" : c.k === "uk" ? "UQ" : ""}
                    </text>
                    <text
                      x={30}
                      y={y}
                      style={{
                        fontSize: 10.5,
                        fill: c.k === "pk" || c.k === "fk" ? "var(--bl-fg)" : "var(--bl-fg-muted)",
                      }}
                    >
                      {c.n}
                    </text>
                    <text
                      x={BOX_W - 10}
                      y={y}
                      textAnchor="end"
                      style={{ fontSize: 10, fill: "var(--bl-fg-subtle)" }}
                    >
                      {c.t}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function TableTags({ t }: { t: Table }) {
  const tags = [
    t.view && "VY",
    t.appendOnly && "APPEND",
    t.isNew && "NY",
    t.later && t.later.toUpperCase(),
  ].filter(Boolean) as string[];
  // Placera etiketterna från höger kant och inåt.
  const placed: Array<{ tag: string; x: number; w: number }> = [];
  for (const tag of [...tags].reverse()) {
    const w = tag.length * 6.2 + 8;
    const right = placed.length ? placed[placed.length - 1]!.x - 4 : BOX_W - 8;
    placed.push({ tag, x: right - w, w });
  }
  return (
    <>
      {placed.map(({ tag, x: tx, w }) => {
        return (
          <g key={tag}>
            <rect
              x={tx + 0.5}
              y={8.5}
              width={w}
              height={13}
              rx={2}
              fill="none"
              style={{ stroke: tag === "NY" ? "var(--bl-fg)" : "var(--bl-line-control)" }}
            />
            <text
              x={tx + w / 2 + 0.5}
              y={18}
              textAnchor="middle"
              style={{
                fontSize: 8.5,
                letterSpacing: "0.06em",
                fill: tag === "NY" ? "var(--bl-fg)" : "var(--bl-fg-subtle)",
              }}
            >
              {tag}
            </text>
          </g>
        );
      })}
    </>
  );
}
