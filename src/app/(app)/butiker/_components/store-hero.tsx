import type { CSSProperties } from "react";

import { MachineThumb } from "@/components/v2/machine-thumb";
import { PackFan } from "@/components/v2/pack-visuals";
import { PackImage } from "@/components/v2/pack-image";
import { StoreFace } from "@/components/v2/store-face";
import { storeFace } from "@/components/v2/visual-math";
import { formatInt } from "@/lib/format";

import type { FaceProps } from "../_lib/visual-data";
import type { StoreSales } from "../_lib/visual-model";

/** Automater i bannern; fler blir "+N". */
const MAX_MACHINES = 3;

/**
 * Butikens huvud (visuellt/06, En butik): en banner i stadens färg med butikens fyra mest sålda
 * pack som en solfjäder och automaterna som står där, symbolen, namnet och de mest sålda packen
 * med antal. Bara antal pack, inga belopp (beloppen står i nyckeltalen under).
 */
export function StoreHero({
  name,
  face,
  sales,
  machines,
  days,
}: {
  name: string;
  face: FaceProps;
  sales: StoreSales | null;
  machines: readonly { readonly id: string; readonly name: string }[];
  /** "30 d". */
  days: string;
}) {
  const tone = storeFace({ name, storeType: face.storeType, city: face.city });
  const top = sales?.top ?? [];
  const max = Math.max(1, ...top.map((t) => t.count));
  const sum = top.reduce((n, t) => n + t.count, 0);
  // Automat 01 före Automat 02 (namnen har löpnummer: sortera som tal).
  const shown = [...machines]
    .sort((a, b) => a.name.localeCompare(b.name, "sv", { numeric: true }))
    .slice(0, MAX_MACHINES);
  return (
    <section
      className="v2-card bt6-hero"
      aria-label={`${name}: mest sålda pack och automater`}
      style={{ "--sf-bg": tone.bg, "--sf-fg": tone.fg } as CSSProperties}
    >
      <div className="bt6-hero-main">
        <div className="bt6-banner" aria-hidden="true">
          <PackFan titles={top.map((t) => t.title)} size="m" className="fan" />
          {shown.length > 0 ? (
            <span className="mach">
              {shown.map((m) => (
                <span key={m.id} className="m">
                  <MachineThumb machineId={m.id} size="md" />
                  <span className="lb">{m.name}</span>
                </span>
              ))}
              {machines.length > MAX_MACHINES ? (
                <span className="plus">+{machines.length - MAX_MACHINES}</span>
              ) : null}
            </span>
          ) : null}
        </div>
        <div className="bt6-head">
          <StoreFace name={name} storeType={face.storeType} city={face.city} size="lg" />
          <div className="min-w-0">
            <h2>{name}</h2>
            <p>
              {face.city ? (
                <span className="cityc">
                  <i aria-hidden="true" />
                  {face.city}
                </span>
              ) : null}
              {face.city ? " · " : null}
              {machines.length === 1 ? "1 automat" : `${formatInt(machines.length)} automater`}
            </p>
          </div>
        </div>
      </div>
      <div className="bt6-hero-side">
        {top.length > 0 ? (
          <div className="bt6-top">
            <div className="k">
              <b>Mest sålda här · {days}</b>
              <span>
                {formatInt(sum)} av {formatInt(sales?.sold ?? 0)} pack
              </span>
            </div>
            <ol>
              {top.map((t, i) => (
                <li key={t.title} style={{ "--i": i } as CSSProperties}>
                  <PackImage title={t.title} size="xs" className="pk" />
                  <span className="t">{t.title}</span>
                  <span className="bar" aria-hidden="true">
                    <i style={{ "--w": t.count / max } as CSSProperties} />
                  </span>
                  <span className="n tnum">{formatInt(t.count)}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <p className="bt6-hero-none">Inga sålda pack {days}.</p>
        )}
      </div>
    </section>
  );
}
