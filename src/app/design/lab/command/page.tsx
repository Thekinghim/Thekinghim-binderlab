import { CommandSection } from "../../sections/command";
import { HotkeyCheck } from "./hotkey-check";

export default function Page() {
  return (
    <div className="mx-auto max-w-[1280px] px-4 md:px-8">
      <CommandSection index={14} />
      <HotkeyCheck />
    </div>
  );
}
