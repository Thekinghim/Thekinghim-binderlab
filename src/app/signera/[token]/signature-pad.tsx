"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

export interface SignaturePadHandle {
  /** PNG som data-URL, eller null om inget är ritat. */
  toPng(): string | null;
  clear(): void;
}

/**
 * Ritytan för signaturen: finger, penna eller mus (pointer events). Svart bläck på vitt,
 * samma i båda färgtemana, så att signaturen ser likadan ut på signaturbladet.
 */
export const SignaturePad = forwardRef<
  SignaturePadHandle,
  { onChange: (hasInk: boolean) => void; label: string }
>(function SignaturePad({ onChange, label }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const ink = useRef(0);
  const [hasInk, setHasInk] = useState(false);

  const setup = useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = c.getBoundingClientRect();
    c.width = Math.max(1, Math.round(rect.width * dpr));
    c.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = "#111";
    ink.current = 0;
    setHasInk(false);
    onChange(false);
  }, [onChange]);

  useEffect(() => {
    setup();
    // Att vrida telefonen ändrar ytan; då börjar man om (hellre än en förvrängd signatur).
    let width = canvas.current?.getBoundingClientRect().width ?? 0;
    const onResize = () => {
      const w = canvas.current?.getBoundingClientRect().width ?? 0;
      if (Math.abs(w - width) > 1) {
        width = w;
        setup();
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [setup]);

  useImperativeHandle(ref, () => ({
    toPng: () =>
      ink.current > 40 && canvas.current ? canvas.current.toDataURL("image/png") : null,
    clear: setup,
  }));

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  return (
    <canvas
      ref={canvas}
      role="img"
      aria-label={label}
      data-has-ink={hasInk ? "1" : "0"}
      className="block h-44 w-full cursor-crosshair touch-none rounded-sm border border-line-strong"
      // Alltid vitt papper, även i mörkt tema (färgskalan har ingen vit).
      style={{ backgroundColor: "#fff" }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drawing.current = true;
        last.current = point(e);
        const ctx = e.currentTarget.getContext("2d");
        if (ctx && last.current) {
          ctx.beginPath();
          ctx.arc(last.current.x, last.current.y, 1.2, 0, Math.PI * 2);
          ctx.fillStyle = "#111";
          ctx.fill();
        }
      }}
      onPointerMove={(e) => {
        if (!drawing.current || !last.current) return;
        const ctx = e.currentTarget.getContext("2d");
        if (!ctx) return;
        const p = point(e);
        ctx.beginPath();
        ctx.moveTo(last.current.x, last.current.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ink.current += Math.hypot(p.x - last.current.x, p.y - last.current.y);
        last.current = p;
        // Ett streck på minst några centimeter räknas som en signatur.
        if (ink.current > 40 && !hasInk) {
          setHasInk(true);
          onChange(true);
        }
      }}
      onPointerUp={() => {
        drawing.current = false;
        last.current = null;
      }}
      onPointerCancel={() => {
        drawing.current = false;
        last.current = null;
      }}
    />
  );
});
