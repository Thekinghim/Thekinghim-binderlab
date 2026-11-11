-- =============================================================================
-- Runda 2, T1-3: en misslyckad sändning till Awish sparas, syns och försöks igen.
--
-- I dag försvinner felet i en toast: påfyllningen ligger i Binderlab men Awish har kvar
-- det gamla antalet, och nästa läsning av facken (var femte minut) skriver tillbaka det
-- gamla antalet som en inventering. Påfyllningen är då borta ur saldot.
--
-- 1. automation_log får två nya sorter bredvid 'awish_push':
--    - 'awish_push_failed':  sändningen för automaten gick inte fram (en rad när felet
--                            uppstår; fler försök som också misslyckas ger ingen ny rad),
--    - 'awish_push_cleared': en automat som väntade är klar igen (ett nytt försök gick
--                            fram, eller det fanns inget kvar att skicka).
--    En automat VÄNTAR när dess senaste rad av de tre sorterna är 'awish_push_failed'.
--    Sidan Värde och dagliga kontrollen räknar bara 'awish_push' och ändras inte: en
--    misslyckad sändning ger ingen sparad tid.
-- 2. public.awish_push_pending(org): automaterna som väntar, för Fyll på (raden "Awish
--    fick inte antalen för BL-003" med Försök igen). Ägare, admin och påfyllare (loggen
--    själv läser bara ägare och admin). Bara automatens id och tidpunkten, inga belopp.
--
-- Additivt: en bredare kontroll på en kolumn och en ny funktion.
-- =============================================================================

alter table public.automation_log drop constraint automation_log_kind_check;
alter table public.automation_log add constraint automation_log_kind_check
  check (kind in ('awish_push', 'awish_push_failed', 'awish_push_cleared'));

comment on table public.automation_log is
  'Arbete som Binderlab gjort automatiskt (awish_push) och sändningar till Awish som inte gick fram (awish_push_failed, awish_push_cleared). Skrivs av servern, append-only.';

-- Senaste utfallet per automat (för att hitta de som väntar).
create index automation_log_machine_outcome_idx
  on public.automation_log (organization_id, machine_id, occurred_at desc, created_at desc)
  where machine_id is not null;

create function public.awish_push_pending(p_organization_id uuid)
returns table (machine_id uuid, failed_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null
     or not private.has_role(p_organization_id, 'owner', 'admin', 'refiller') then
    raise exception using errcode = '42501', message = 'Du har inte behörighet till det här.';
  end if;
  return query
    select l.machine_id, l.occurred_at
    from (
      select distinct on (a.machine_id) a.machine_id, a.kind, a.occurred_at
      from public.automation_log a
      where a.organization_id = p_organization_id
        and a.machine_id is not null
        and a.kind in ('awish_push', 'awish_push_failed', 'awish_push_cleared')
      order by a.machine_id, a.occurred_at desc, a.created_at desc, a.id desc
    ) l
    join public.machines m
      on m.organization_id = p_organization_id and m.id = l.machine_id
    where l.kind = 'awish_push_failed' and m.archived_at is null;
end
$$;

comment on function public.awish_push_pending(uuid) is
  'Automater vars senaste sändning till Awish inte gick fram (Fyll på: "Försök igen"). Ägare, admin, påfyllare (42501 annars).';

revoke all on function public.awish_push_pending(uuid) from public, anon;
grant execute on function public.awish_push_pending(uuid) to authenticated;
