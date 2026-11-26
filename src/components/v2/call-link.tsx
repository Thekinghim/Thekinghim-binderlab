"use client";

import { useSyncExternalStore } from "react";

import { cn } from "@/lib/cn";

import { isAppleMobile, mapsDirUrl, mapsSearchUrl, telHref, type MapsProvider } from "./links";

const noSubscribe = () => () => {};

/**
 * Kartappen på den här enheten: Apple på iPhone och iPad, annars Google. Servern (och första
 * ritningen) säger Google, så att sidan inte ritas om olika; länken byts direkt efteråt.
 */
function useMapsProvider(): MapsProvider {
  return useSyncExternalStore(
    noSubscribe,
    () => (isAppleMobile(navigator) ? "apple" : "google"),
    () => "google",
  );
}

const linkClass = "v2-btn";

/** "Ring Anna" (tel:). Inget ritas utan telefonnummer. */
export function CallLink({
  phone,
  name,
  className,
  size,
}: {
  phone: string | null | undefined;
  name?: string | null;
  className?: string;
  /** "touch": 44 px hög på telefon (Rutt, där man trycker med tummen). */
  size?: "sm" | "lg" | "touch";
}) {
  const href = telHref(phone);
  if (!href) return null;
  const first = name?.trim().split(/\s+/)[0];
  return (
    <a href={href} className={cn(linkClass, size, className)}>
      {first ? `Ring ${first}` : "Ring"}
    </a>
  );
}

/** "Kör dit" (en plats i kartan: Apple Kartor på iPhone, annars Google Maps i ny flik). Inget ritas utan adress eller koordinater. */
export function MapsLink({
  address,
  city,
  lat,
  lng,
  label = "Kör dit",
  className,
  size,
}: {
  address?: string | null;
  city?: string | null;
  lat?: number | null;
  lng?: number | null;
  label?: string;
  className?: string;
  /** "touch": 44 px hög på telefon (Rutt, där man trycker med tummen). */
  size?: "sm" | "lg" | "touch";
}) {
  const href = mapsSearchUrl({ address, city, lat, lng }, useMapsProvider());
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(linkClass, size, className)}
    >
      {label}
    </a>
  );
}

/** "Öppna hela rutten i Maps". */
export function RouteMapsLink({
  stops,
  origin,
  label = "Öppna hela rutten i Maps",
  className,
  size,
}: {
  stops: readonly string[];
  origin?: string | null;
  label?: string;
  className?: string;
  /** "touch": 44 px hög på telefon. */
  size?: "sm" | "lg" | "touch";
}) {
  const href = mapsDirUrl(stops, origin, useMapsProvider());
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(linkClass, size, className)}
    >
      {label}
    </a>
  );
}
