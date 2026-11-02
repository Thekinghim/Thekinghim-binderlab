"use client";

import { useState } from "react";
import { CommandPalette, useCommandPaletteHotkey } from "@/components/ui/command-palette";

/** Endast för lab-routen: verifierar den globala genvägen. */
export function HotkeyCheck() {
  const [open, setOpen] = useState(false);
  useCommandPaletteHotkey(setOpen);
  return (
    <CommandPalette
      open={open}
      onOpenChange={setOpen}
      placeholder="Genvägstest"
      groups={[
        { label: "Test", items: [{ id: "a", label: "Genväg fungerar", onSelect: () => {} }] },
      ]}
    />
  );
}
