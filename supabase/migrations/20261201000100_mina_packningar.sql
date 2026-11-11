-- =============================================================================
-- Runda 2, T1-4: påfyllaren kan ångra sin egen packning.
--
-- Felet: påfyllaren får packa (pack_mystery) och ångra inom 30 minuter
-- (undo_mystery_packing), men får inte läsa mystery_packings (raderna har kostnad per pack,
-- som bara ägare, admin och läsare ser). Efter att rutan med Ångra försvunnit, eller sidan
-- laddats om, fanns alltså ingen knapp kvar.
--
-- public.my_recent_mystery_packings(org, titel): den inloggades EGNA packningar av titeln
-- från de senaste 30 minuterna (samma gräns som undo_mystery_packing), utan kostnad per
-- pack och utan belopp. För alla som får packa: ägare, admin och påfyllare. Andras
-- packningar och äldre packningar lämnas aldrig ut.
--
-- Additivt: en ny funktion.
-- =============================================================================

create function public.my_recent_mystery_packings(p_organization_id uuid, p_title_id uuid)
returns table (
  id uuid,
  packed_at timestamptz,
  batches integer,
  packs integer,
  location_name text,
  recipe_version integer,
  undone_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null
     or not private.has_role(p_organization_id, 'owner', 'admin', 'refiller') then
    raise exception using errcode = '42501',
      message = 'Bara ägare, admin och påfyllare kan se sina packningar.';
  end if;
  return query
    select p.id, p.packed_at, p.batches, p.packs, l.name, r.version, p.undone_at
    from public.mystery_packings p
    join public.stock_locations l
      on l.organization_id = p.organization_id and l.id = p.location_id
    join public.mystery_recipes r
      on r.organization_id = p.organization_id and r.id = p.recipe_id
    where p.organization_id = p_organization_id
      and p.title_id = p_title_id
      and p.packed_by = v_uid
      and p.packed_at >= now() - interval '30 minutes'
    order by p.packed_at desc
    limit 20;
end
$$;

comment on function public.my_recent_mystery_packings(uuid, uuid) is
  'Mystery packs: den inloggades egna packningar av titeln de senaste 30 minuterna, utan kostnad (för Ångra). Ägare, admin, påfyllare (42501 annars).';

revoke all on function public.my_recent_mystery_packings(uuid, uuid) from public, anon;
grant execute on function public.my_recent_mystery_packings(uuid, uuid) to authenticated;
