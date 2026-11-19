/**
 * Vilka av personens valda kanaler som faktiskt når fram (Notiser). En vald kanal som inte
 * fungerar får aldrig stå som om den gällde: e-post kräver att Binderlab kan skicka e-post,
 * push kräver en påslagen enhet, sms en leverantör och ett nummer. Ren modul.
 */

export type ReachChannel = "push" | "email" | "sms";

const NAME: Record<ReachChannel, string> = { push: "push", email: "e-post", sms: "sms" };

export interface ChannelReach {
  /** Valda kanaler som når fram. */
  readonly working: ReachChannel[];
  /** Valda kanaler som inte når fram, med anledningen. */
  readonly broken: { channel: ReachChannel; reason: string }[];
}

export function channelReach(input: {
  readonly channels: readonly string[];
  readonly devices: number;
  readonly hasPhone: boolean;
  readonly works: { readonly email: boolean; readonly push: boolean; readonly sms: boolean };
}): ChannelReach {
  const working: ReachChannel[] = [];
  const broken: ChannelReach["broken"] = [];
  for (const c of ["push", "email", "sms"] as const) {
    if (!input.channels.includes(c)) continue;
    const reason =
      c === "email"
        ? input.works.email
          ? null
          : "E-post är inte påslagen"
        : c === "push"
          ? !input.works.push
            ? "Push är inte påslaget"
            : input.devices === 0
              ? "Ingen telefon har notiser påslagna"
              : null
          : !input.works.sms
            ? "Sms är inte påslaget"
            : input.hasPhone
              ? null
              : "Telefonnummer saknas";
    if (reason) broken.push({ channel: c, reason });
    else working.push(c);
  }
  return { working, broken };
}

/**
 * Raden under rubriken: "Via push, tyst 22:00–07:00. E-post är inte påslagen." eller, när
 * inget når fram, bara anledningarna och vad man gör.
 */
export function reachAside(reach: ChannelReach, quiet: string | null): string {
  const reasons = reach.broken.map((b) => `${b.reason}.`).join(" ");
  if (reach.working.length === 0) {
    return `${reasons} Slå på notiser på din telefon här nedanför.`.trim();
  }
  const via = `Via ${reach.working.map((c) => NAME[c]).join(" och ")}${quiet ? `, tyst ${quiet}` : ""}.`;
  return reasons ? `${via} ${reasons}` : via;
}
