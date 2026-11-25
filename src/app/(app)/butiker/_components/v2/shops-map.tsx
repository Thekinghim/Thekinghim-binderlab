"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

import { StoreFace } from "@/components/v2/store-face";
import { cn } from "@/lib/cn";

import {
  CITY_POINTS,
  WATER,
  cityPoint,
  dotRadius,
  firstOfEachText,
  fitView,
  labelBox,
  placeLabels,
  placeLabelsAround,
  projector,
  smoothPath,
  spreadOffsets,
  zoomView,
  type LabelBox,
  type LabelSide,
  type LngLat,
  type MapView,
} from "../../_lib/map-model";

export interface MapStore {
  readonly id: string;
  readonly name: string;
  readonly city: string | null;
  readonly storeType: string | null;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly profitOre: number;
  readonly machines: number;
  readonly offline: boolean;
  /** "Kortkammaren · 11 506 kr" (etiketten över vald prick). */
  readonly tip: string;
}

export interface MapLead {
  readonly id: string;
  readonly name: string;
  readonly city: string | null;
}

interface Placed<T> {
  readonly item: T;
  readonly at: LngLat;
  readonly dx: number;
  readonly dy: number;
}

/**
 * Läget: egna koordinater, annars stadens mittpunkt. Allt på samma punkt (butiker och platser i
 * expansionen i samma stad) sprids ut i en liten ring så att inget hamnar under något annat.
 */
function place<T extends { city: string | null }>(
  items: readonly T[],
  own: (t: T) => LngLat | null,
  spread: number,
): Placed<T>[] {
  const groups = new Map<string, { at: LngLat; items: T[] }>();
  for (const t of items) {
    const at = own(t) ?? cityPoint(t.city);
    if (!at) continue;
    const key = `${at[0].toFixed(4)},${at[1].toFixed(4)}`;
    const g = groups.get(key);
    if (g) g.items.push(t);
    else groups.set(key, { at, items: [t] });
  }
  const out: Placed<T>[] = [];
  for (const g of groups.values()) {
    const offs = spreadOffsets(g.items.length, spread);
    g.items.forEach((item, i) => out.push({ item, at: g.at, dx: offs[i]![0], dy: offs[i]![1] }));
  }
  return out;
}

type Pin =
  | { readonly kind: "store"; readonly city: string | null; readonly store: MapStore }
  | { readonly kind: "lead"; readonly city: string | null; readonly lead: MapLead };

/** Ungefärlig textbredd (Google Sans, 12 px) för etiketternas krockkontroll. */
function textWidth(s: string, size = 12): number {
  return s.length * size * 0.56 + 4;
}

/**
 * Butikerna på en karta (visuellt/06): en prick per butik där den står, storleken efter vinsten
 * (bara för ägaren; andra ser lika stora prickar), offline röd, platserna i expansionen som
 * streckade ringar. Ingen karttjänst: en ren SVG med hav och sjöar som grova former. Tryck på en
 * prick väljer butiken och filtrerar listan.
 */
export function ShopsMap({
  stores,
  leads,
  selectedId,
  filterId,
  onPick,
  onClear,
  sizeByProfit,
  phone,
  legendProfit,
}: {
  stores: readonly MapStore[];
  leads: readonly MapLead[];
  selectedId: string | null;
  filterId: string | null;
  onPick: (id: string) => void;
  onClear: () => void;
  sizeByProfit: boolean;
  phone: boolean;
  /** "Vinst 30 d". */
  legendProfit: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setBox({ w: Math.round(r.width), h: Math.round(r.height) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const spread = phone ? 13 : 17;
  const placed = useMemo(
    () =>
      place<Pin>(
        [
          ...stores.map((st) => ({ kind: "store" as const, city: st.city, store: st })),
          ...leads.map((l) => ({ kind: "lead" as const, city: l.city, lead: l })),
        ],
        (p) =>
          p.kind === "store" && p.store.lat !== null && p.store.lng !== null
            ? [p.store.lng, p.store.lat]
            : null,
        spread,
      ),
    [stores, leads, spread],
  );
  const placedStores = placed.flatMap((p) =>
    p.item.kind === "store" ? [{ ...p, item: p.item.store }] : [],
  );
  const placedLeads = placed.flatMap((p) =>
    p.item.kind === "lead" ? [{ ...p, item: p.item.lead }] : [],
  );
  const missing = stores.length - placedStores.length;

  const w = box?.w ?? 600;
  const h = box?.h ?? 300;
  // Teckenförklaringen ligger nederst: prickarna ritas i rutan ovanför den.
  const hMap = Math.max(60, h - (phone ? 34 : 34));
  const base: MapView = useMemo(
    () =>
      fitView(
        placed.map((p) => p.at),
        w,
        hMap,
        phone ? 0.14 : 0.15,
      ),
    [placed, w, hMap, phone],
  );
  const sel = placedStores.find((p) => p.item.id === selectedId) ?? null;
  const view = zoom > 1 ? zoomView(base, zoom, sel?.at ?? null) : base;
  const proj = projector(view, w, hMap);
  const maxProfit = sizeByProfit ? Math.max(0, ...stores.map((s) => s.profitOre)) : 0;

  const dots = placedStores
    .map((p) => {
      const [x, y] = proj(p.at);
      const r = sizeByProfit ? dotRadius(p.item.profitOre, maxProfit, phone) : phone ? 8 : 10;
      return { ...p, x: x + p.dx, y: y + p.dy, r };
    })
    // Små först, så att stora prickar ligger överst.
    .sort((a, b) => a.r - b.r);
  const rings = placedLeads.map((p) => {
    const [x, y] = proj(p.at);
    return { ...p, x: x + p.dx, y: y + p.dy };
  });

  // Etiketter: vald först, sedan offline och efter storlek. Telefon: stadens namn (som i mocken).
  // På dator har vald butik redan den mörka rutan (tip): ingen vanlig etikett till.
  const labelOrder = [...dots]
    .filter((d) => phone || d.item.id !== selectedId)
    .sort(
      (a, b) =>
        Number(b.item.id === selectedId) - Number(a.item.id === selectedId) ||
        Number(b.item.offline) - Number(a.item.offline) ||
        b.r - a.r,
    );
  const labelText = (d: (typeof dots)[number]) => {
    const base2 = phone ? (d.item.city ?? d.item.name) : d.item.name;
    return d.item.offline && !phone ? `${base2} · offline` : base2;
  };
  const sidesFor = (d: (typeof dots)[number]): LabelSide[] =>
    d.item.offline ? ["left", "right", "below", "above"] : ["right", "left", "below", "above"];
  // Samma text två gånger ("Örebro" för två butiker där): bara den första får etikett.
  const firstLabel = firstOfEachText(labelOrder.map(labelText));
  const candidates = labelOrder.map((d, i) => {
    if (!firstLabel[i]) return [];
    const tw = textWidth(labelText(d));
    return sidesFor(d).map((side) => labelBox(d.x, d.y, d.r, tw, side));
  });
  const dotBoxes: LabelBox[] = [
    ...dots.map((d) => ({ x: d.x - d.r, y: d.y - d.r, w: d.r * 2, h: d.r * 2 })),
    ...rings.map((r) => ({ x: r.x - 9, y: r.y - 9, w: 18, h: 18 })),
  ];
  // Tipsrutan över vald prick upptar också plats.
  const tipBox: LabelBox[] =
    sel && !phone
      ? (() => {
          const d = dots.find((x) => x.item.id === selectedId)!;
          const tw = textWidth(d.item.tip, 13) + 20;
          return [{ x: d.x - tw / 2, y: d.y - d.r - 38, w: tw, h: 28 }];
        })()
      : [];
  const chosen = placeLabelsAround(
    candidates,
    [
      ...dotBoxes,
      ...tipBox,
      // Filterchipet uppe till vänster och teckenförklaringen nere till vänster.
      ...(phone
        ? []
        : [
            { x: 0, y: 0, w: 230, h: 44 },
            { x: 0, y: h - 46, w: 330, h: 46 },
          ]),
    ],
    { w, h: hMap },
  );
  const labelAt = (i: number) => candidates[i]![chosen.get(i)!]!;

  // Expansionens ringar får sin ort (lägre prioritet än butikerna: bara där det finns plats).
  const leadText = (r: (typeof rings)[number]) => r.item.city ?? r.item.name;
  // En ring i en ort där det redan finns en butik får ingen egen ortsetikett (två "Örebro").
  const storeCities = new Set(
    stores.map((s) => s.city?.trim().toLocaleLowerCase("sv-SE")).filter(Boolean),
  );
  const leadCandidates = rings.map((r) => {
    if (storeCities.has(leadText(r).trim().toLocaleLowerCase("sv-SE"))) return [];
    const tw = textWidth(leadText(r), 11);
    return (["right", "left", "below", "above"] as const).map((side) =>
      labelBox(r.x, r.y, 9, tw, side),
    );
  });
  const leadChosen = placeLabelsAround(
    leadCandidates,
    [
      ...dotBoxes,
      ...tipBox,
      ...[...chosen.keys()].map(labelAt),
      ...(phone
        ? []
        : [
            { x: 0, y: 0, w: 230, h: 44 },
            { x: 0, y: h - 46, w: 330, h: 46 },
          ]),
    ],
    { w, h: hMap },
  );
  const leadAt = (i: number) => leadCandidates[i]![leadChosen.get(i)!]!;

  // Orter utan butik i utsnittet: svaga namn som riktmärken (högst fyra).
  const refs = (() => {
    if (!box) return [];
    const used = new Set(
      [...stores.map((s) => s.city), ...leads.map((l) => l.city)]
        .filter(Boolean)
        .map((c) => c!.toLocaleLowerCase("sv-SE")),
    );
    return Object.entries(CITY_POINTS)
      .filter(([k]) => !used.has(k) && k !== "nödinge" && k !== "ale")
      .map(([k, at]) => {
        const [x, y] = proj(at);
        return { name: k.charAt(0).toLocaleUpperCase("sv-SE") + k.slice(1), x, y };
      })
      .filter((c) => c.x > 30 && c.x < w - 90 && c.y > 50 && c.y < hMap - 20);
  })();
  const refShown = placeLabels(
    refs.map((c) => ({ x: c.x + 5, y: c.y - 8, w: textWidth(c.name, 11), h: 14 })),
    [...dotBoxes, ...[...chosen.keys()].map(labelAt), ...[...leadChosen.keys()].map(leadAt)],
    { w, h: hMap },
  );
  const refList = refs.filter((_, i) => refShown.has(i)).slice(0, 4);

  const water = WATER.map((poly) => smoothPath(poly.map((p) => proj(p))));
  const filtered = filterId ? (stores.find((s) => s.id === filterId) ?? null) : null;

  const onKey = (e: KeyboardEvent, id: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onPick(id);
    }
  };

  return (
    <div
      ref={ref}
      className={cn("bt6-map", box && "ready")}
      role="group"
      aria-label={`Karta över butikerna: ${stores.length} butiker${leads.length ? `, ${leads.length} platser i expansionen` : ""}`}
    >
      <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden={false}>
        <defs>
          <pattern id="bt6-dots" width="12" height="12" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r=".8" fill="#e2e2df" />
          </pattern>
          <filter id="bt6-sh" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="1.5" stdDeviation="1.6" floodColor="#000" floodOpacity=".25" />
          </filter>
        </defs>
        <rect width={w} height={h} fill="url(#bt6-dots)" aria-hidden="true" />
        <g aria-hidden="true">
          {water.map((d, i) => (d ? <path key={i} d={d} className="water" /> : null))}
        </g>
        <g aria-hidden="true" className="refs">
          {refList.map((c) => (
            <g key={c.name}>
              <circle cx={c.x} cy={c.y} r={2.2} />
              <text x={c.x + 6} y={c.y + 4}>
                {c.name}
              </text>
            </g>
          ))}
        </g>
        <g aria-hidden="true">
          {rings.map((r, i) => (
            <circle
              key={r.item.id}
              className="lead"
              cx={r.x}
              cy={r.y}
              r={phone ? 7.5 : 8.5}
              style={{ "--i": i } as CSSProperties}
            >
              <title>{`${r.item.name}${r.item.city ? `, ${r.item.city}` : ""} (expansion)`}</title>
            </circle>
          ))}
        </g>
        <g>
          {dots.map((d, i) => {
            const on = d.item.id === selectedId;
            return (
              <g
                key={d.item.id}
                className={cn("dot", d.item.offline && "off", on && "on")}
                role="button"
                tabIndex={0}
                aria-label={`${d.item.tip}${d.item.offline ? ", offline" : ""}`}
                aria-pressed={on}
                onClick={() => onPick(d.item.id)}
                onKeyDown={(e) => onKey(e, d.item.id)}
                style={{ "--i": i, "--x": `${d.x}px`, "--y": `${d.y}px` } as CSSProperties}
              >
                {/* Större träffyta på telefon. */}
                <circle cx={d.x} cy={d.y} r={Math.max(d.r, 20)} className="hit" />
                {d.item.offline ? <circle cx={d.x} cy={d.y} r={d.r + 6} className="halo" /> : null}
                {on ? <circle cx={d.x} cy={d.y} r={d.r + 5} className="sel" /> : null}
                <circle cx={d.x} cy={d.y} r={d.r} className="fill" filter="url(#bt6-sh)" />
                {d.item.machines > 1 && d.r >= 11 ? (
                  <text x={d.x} y={d.y + 4} className="n">
                    {d.item.machines}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
        <g aria-hidden="true" className="labels leadlbls">
          {rings.map((r, i) => {
            if (!leadChosen.has(i)) return null;
            const b = leadAt(i);
            return (
              <text
                key={r.item.id}
                x={b.x + b.w / 2}
                y={b.y + 12}
                textAnchor="middle"
                className="lead"
              >
                {leadText(r)}
              </text>
            );
          })}
        </g>
        <g aria-hidden="true" className="labels">
          {labelOrder.map((d, i) => {
            if (!chosen.has(i)) return null;
            const b = labelAt(i);
            return (
              <text
                key={d.item.id}
                x={b.x + b.w / 2}
                y={b.y + 12}
                textAnchor="middle"
                className={cn(d.item.offline && "off", d.item.id === selectedId && "on")}
              >
                {labelText(d)}
              </text>
            );
          })}
        </g>
        {sel && !phone
          ? (() => {
              const d = dots.find((x) => x.item.id === selectedId)!;
              const tw = textWidth(d.item.tip, 13) + 20;
              const y = d.y - d.r - (d.item.id === selectedId ? 12 : 8);
              return (
                <g aria-hidden="true" className="tip" key={d.item.id}>
                  <rect x={d.x - tw / 2} y={y - 26} width={tw} height={26} rx={13} />
                  <text x={d.x} y={y - 8.5} textAnchor="middle">
                    {d.item.tip}
                  </text>
                </g>
              );
            })()
          : null}
      </svg>

      {!phone ? (
        <div className="bt6-mfilter">
          {filtered ? (
            <span className="chip">
              <StoreFace
                name={filtered.name}
                storeType={filtered.storeType}
                city={filtered.city}
                size="xs"
              />
              {filtered.name}
              <button
                type="button"
                onClick={onClear}
                aria-label={`Visa alla butiker, inte bara ${filtered.name}`}
              >
                <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true">
                  <path
                    d="M6 6l12 12M18 6L6 18"
                    stroke="currentColor"
                    strokeWidth="2.6"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </span>
          ) : null}
          <span className="chip ghost">
            {missing > 0
              ? `${missing} ${missing === 1 ? "butik" : "butiker"} utan plats`
              : "Tryck på en prick för att filtrera"}
          </span>
        </div>
      ) : filtered ? (
        <div className="bt6-mfilter">
          <span className="chip">
            {filtered.name}
            <button type="button" onClick={onClear} aria-label="Visa alla butiker">
              <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true">
                <path
                  d="M6 6l12 12M18 6L6 18"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </span>
        </div>
      ) : null}

      <div className="bt6-legend" aria-hidden="true">
        <span>
          {sizeByProfit ? (
            <>
              <i className="d" style={{ width: 8, height: 8 }} />
              <i className="d" style={{ width: 14, height: 14, marginLeft: -2 }} />
              {legendProfit}
            </>
          ) : (
            <>
              <i className="d" style={{ width: 11, height: 11 }} />
              Butik
            </>
          )}
        </span>
        <span>
          <i className="o" />
          Offline
        </span>
        {leads.length > 0 ? (
          <span>
            <i className="x" />
            Expansion
          </span>
        ) : null}
      </div>

      {!phone ? (
        <div className="bt6-zoom">
          <button
            type="button"
            aria-label="Zooma in"
            disabled={zoom >= 8}
            onClick={() => setZoom((z) => Math.min(8, z * 2))}
          >
            +
          </button>
          <button
            type="button"
            aria-label="Zooma ut"
            disabled={zoom <= 1}
            onClick={() => setZoom((z) => Math.max(1, z / 2))}
          >
            −
          </button>
        </div>
      ) : null}
    </div>
  );
}
