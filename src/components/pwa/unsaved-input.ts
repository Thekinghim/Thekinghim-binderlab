"use client";

import { useEffect, useId } from "react";

/**
 * Är något ifyllt men inte sparat? Då laddar appen aldrig om av sig själv för en ny version
 * (bara rutan "Ny version av appen finns" visas), och Uppdatera frågar först.
 *
 * Sidor med egna, styrda fält (som antalen i Fyll på) anmäler sig med useUnsavedInput.
 * Dessutom räknas ett fält som någon skriver i just nu, en öppen dialog och vanliga
 * formulärfält (ej styrda av React) vars värde ändrats.
 */

const holders = new Set<string>();

/** Anmäl (eller ta bort) osparad inmatning under en nyckel. */
export function setUnsavedInput(key: string, active: boolean): void {
  if (active) holders.add(key);
  else holders.delete(key);
}

/** Medan `active` är sant räknas sidan som ifylld men inte sparad. */
export function useUnsavedInput(active: boolean): void {
  const key = useId();
  useEffect(() => {
    setUnsavedInput(key, active);
    return () => setUnsavedInput(key, false);
  }, [key, active]);
}

/** Det som behövs av ett fält för att avgöra om någon skriver i det. */
export interface FieldLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
}

const NOT_TYPING = new Set([
  "button",
  "submit",
  "reset",
  "checkbox",
  "radio",
  "range",
  "color",
  "file",
  "image",
  "hidden",
]);

/** Skriver någon i fältet (ett textfält, en textruta eller en lista med fokus)? */
export function isTypingIn(el: FieldLike | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.disabled || el.readOnly) return false;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !NOT_TYPING.has((el.type ?? "text").toLowerCase());
  return false;
}

/** Det som behövs av ett formulärfält för att se om värdet ändrats. */
export interface FormFieldLike extends FieldLike {
  value?: string;
  defaultValue?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  multiple?: boolean;
  selectedIndex?: number;
  options?: ArrayLike<{ defaultSelected: boolean }>;
}

/** Ett vanligt formulärfält (ej styrt av React) vars värde har ändrats. */
export function changedField(el: FormFieldLike): boolean {
  const tag = (el.tagName ?? "").toUpperCase();
  if (el.disabled) return false;
  if (tag === "INPUT") {
    const type = (el.type ?? "text").toLowerCase();
    if (type === "checkbox" || type === "radio") return el.checked !== el.defaultChecked;
    if (NOT_TYPING.has(type) || el.readOnly) return false;
    return el.value !== el.defaultValue;
  }
  if (tag === "TEXTAREA") return !el.readOnly && el.value !== el.defaultValue;
  if (tag === "SELECT") {
    if (el.multiple || !el.options) return false;
    // Utan förvalt alternativ visar listan det första.
    const preset = Array.from(el.options).findIndex((o) => o.defaultSelected);
    return el.selectedIndex !== (preset === -1 ? 0 : preset);
  }
  return false;
}

/** Finns osparad inmatning på sidan just nu? */
export function hasUnsavedInput(doc: Document | undefined = globalThis.document): boolean {
  if (holders.size > 0) return true;
  if (!doc) return false;
  if (isTypingIn(doc.activeElement as FieldLike | null)) return true;
  if (doc.querySelector("dialog[open]")) return true;
  for (const el of Array.from(doc.querySelectorAll("form input, form textarea, form select"))) {
    if (changedField(el as unknown as FormFieldLike)) return true;
  }
  return false;
}
