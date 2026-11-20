-- =============================================================================
-- Butikens ägare och avtalsform: bara ägare, admin och läsare läser dem.
--
-- stores.owner_id (20261219000000) och stores.agreement_form (20261218000100) är
-- nya kolumner på butikstabellen, som alla roller i organisationen läser (påfyllaren
-- behöver butikens namn och adress). Påfyllaren ska inte se vilka butiker som har
-- samma ägare eller vilka som bara har ett muntligt avtal: avtal och ägare är
-- ägarens, admins och läsarens (som contracts, store_agreements och store_owners).
--
-- RLS styr rader, inte kolumner. Därför:
-- 1. select på tabellen byts mot select på varje kolumn utom de två. Insert och
--    update är oförändrade (ägare och admin skriver dem, stores_update som förut).
-- 2. public.store_terms(organisation): butikernas ägare och avtalsform för ägare,
--    admin och läsare (inga rader för andra roller). Appen läser kolumnerna härifrån.
--    Utan inloggad användare (nattjobben, som postgres) läses alla butiker i
--    organisationen, som när jobben läser tabellen direkt.
--
-- En ny kolumn på stores behöver en egen "grant select (kolumn)" för att appen ska
-- kunna läsa den (annars nekas läsningen: felet syns direkt i testerna).
--
-- Den gamla koden läser inte de två kolumnerna och läser aldrig hela raden
-- (select * eller to_jsonb) under användarens roll, så den påverkas inte.
-- =============================================================================

revoke select on table public.stores from authenticated;

do $$
declare
  v_columns text;
begin
  select string_agg(format('%I', a.attname), ', ' order by a.attnum)
    into v_columns
    from pg_attribute a
   where a.attrelid = 'public.stores'::regclass
     and a.attnum > 0
     and not a.attisdropped
     and a.attname not in ('owner_id', 'agreement_form');
  execute format('grant select (%s) on table public.stores to authenticated', v_columns);
end;
$$;

create function public.store_terms(p_organization_id uuid)
returns table (store_id uuid, owner_id uuid, agreement_form text)
language sql stable security definer
set search_path = ''
as $$
  select st.id, st.owner_id, st.agreement_form
    from public.stores st
   where st.organization_id = p_organization_id
     and (
       p_organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer')))
       -- Nattjobben (ingen inloggad användare och inte rollen authenticated).
       or ((select auth.uid()) is null
           and coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'))
     )
$$;

comment on function public.store_terms(uuid) is
  'Butikernas ägare (owner_id) och avtalsform (agreement_form) för ägare, admin och läsare.';

revoke all on function public.store_terms(uuid) from public, anon;
grant execute on function public.store_terms(uuid) to authenticated;
