/**
 * Senaste inköpet av en annan automat: det som förifylls i "Ny investering" när en ny
 * automats kostnad läggs in (Startklar). Senast = senaste datumet; lika datum: sist i
 * listan. Null när ingen annan automat har ett inköp. Ren.
 */
export function lastPurchase<
  T extends { kind: string; machineId: string; amountOre: number; investedOn: string },
>(investments: ReadonlyArray<T>, exceptMachineId: string | null): T | null {
  let best: T | null = null;
  for (const i of investments) {
    if (i.kind !== "purchase" || i.machineId === exceptMachineId || i.amountOre <= 0) continue;
    if (best === null || i.investedOn >= best.investedOn) best = i;
  }
  return best;
}
