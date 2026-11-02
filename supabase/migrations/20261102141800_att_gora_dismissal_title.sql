-- =============================================================================
-- Att göra: punktens rubrik sparas med avbockningen (todo_dismissals.title).
--
-- Punkterna räknas fram och sparas inte, så en avbockad punkt syns inte längre
-- någonstans. För listan "Avbockade" på /att-gora sparas rubriken som den stod
-- när punkten bockades av (t.ex. "Fyll på 151 i Gallerian Väst"). Rubriken
-- kommer från servern (punkten i användarens aktuella lista), aldrig från
-- klienten, och innehåller inga belopp. Befintliga rader får null och visas med
-- en allmän text. RLS, triggar och loggning gäller som för övriga kolumner.
-- =============================================================================

alter table public.todo_dismissals
  add column title text
    check (title is null or char_length(title) between 1 and 300);

comment on column public.todo_dismissals.title is
  'Punktens rubrik när den bockades av (för listan Avbockade). Inga belopp.';
