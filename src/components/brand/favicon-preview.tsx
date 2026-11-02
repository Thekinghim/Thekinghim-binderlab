"use client";

import { useEffect, useRef } from "react";

/**
 * Rastrerar en SVG till exakt `px` × `px` pixlar och visar resultatet
 * förstorat utan utjämning, så att man ser vad webbläsaren faktiskt
 * ritar i fliken.
 */
export function RasterPreview({
  src,
  px = 16,
  scale = 8,
  label,
}: {
  src: string;
  px?: number;
  scale?: number;
  label: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, px, px);
      ctx.drawImage(img, 0, 0, px, px);
    };
    img.src = src;
  }, [src, px]);

  return (
    <canvas
      ref={ref}
      width={px}
      height={px}
      role="img"
      aria-label={label}
      className="block"
      style={{ width: px * scale, height: px * scale, imageRendering: "pixelated" }}
    />
  );
}
