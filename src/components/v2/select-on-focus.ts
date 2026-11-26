/**
 * Markera hela talet i ett fält när det får fokus, så att nästa siffra ersätter det.
 * select() direkt i onFocus räcker inte på iPhone (Safari flyttar markören efteråt), så
 * markeringen görs en bildruta senare. Samma knep som Stepper.
 */
export function selectAllSoon(el: HTMLInputElement): void {
  requestAnimationFrame(() => {
    if (document.activeElement !== el) return;
    try {
      el.setSelectionRange(0, el.value.length);
    } catch {
      // Fälttyper utan markering (number): välj allt på det gamla sättet.
      el.select();
    }
  });
}
