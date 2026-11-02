-- =============================================================================
-- Drift: sales_data_until ger också automatens senaste order (last_order_at).
--
-- Maskinhälsan läser försäljningen ur lagrets försäljningshändelser, och en order vars titel
-- inte matchats ger ingen sådan händelse. Automaten har ändå sålt: tystnaden räknas från
-- den senaste ordern, oavsett titel. Bara tidpunkten, inget belopp och ingen titel.
-- Returtypen ändras, så funktionerna tas bort och skapas om (inga beroenden).
-- =============================================================================

drop function public.sales_data_until(uuid, timestamptz);
drop function private.sales_data_until_rows(uuid, timestamptz);

create function private.sales_data_until_rows(p_organization_id uuid, p_at timestamptz)
returns table (
  machine_id uuid,
  data_source_id uuid,
  source_name text,
  manual boolean,
  data_until timestamptz,
  synced_at timestamptz,
  last_order_at timestamptz
)
language sql stable security definer
set search_path = ''
as $$
  with src as (
    select d.id, d.name, d.provider,
           (d.provider = 'awish_csv') as manual,
           greatest(
             d.last_synced_at,
             (select max(i.finished_at) from public.imports i
              where i.organization_id = d.organization_id and i.data_source_id = d.id
                and i.status = 'succeeded' and i.finished_at <= p_at)
           ) as synced_at,
           (select max(o.ordered_at) from public.orders o
            where o.organization_id = d.organization_id and o.data_source_id = d.id
              and o.ordered_at <= p_at and o.ordered_at > p_at - interval '70 days') as last_order_at
    from public.data_sources d
    where d.organization_id = p_organization_id and d.archived_at is null
  ),
  cov as (
    select src.*,
           case when src.manual then src.last_order_at
                else least(greatest(src.synced_at, src.last_order_at), p_at) end as until_at
    from src
  ),
  latest as (
    select distinct on (o.machine_id) o.machine_id, o.data_source_id, o.ordered_at
    from public.orders o
    where o.organization_id = p_organization_id and o.machine_id is not null
      and o.ordered_at <= p_at and o.ordered_at > p_at - interval '70 days'
    order by o.machine_id, o.ordered_at desc
  ),
  fallback as (
    select * from cov where cov.until_at is not null order by cov.until_at desc limit 1
  )
  select m.id,
         coalesce(c.id, f.id),
         coalesce(c.name, f.name),
         coalesce(c.manual, f.manual),
         coalesce(c.until_at, f.until_at),
         coalesce(c.synced_at, f.synced_at),
         l.ordered_at
  from public.machines m
  left join latest l on l.machine_id = m.id
  left join cov c on c.id = l.data_source_id
  left join fallback f on c.id is null
  where m.organization_id = p_organization_id and m.archived_at is null
    and ((select auth.uid()) is null
         or private.has_role(p_organization_id, 'owner', 'admin', 'viewer', 'refiller'))
$$;
revoke all on function private.sales_data_until_rows(uuid, timestamptz) from public;
grant execute on function private.sales_data_until_rows(uuid, timestamptz) to authenticated;

-- Kör med anroparens rättigheter så att current_user är den riktiga rollen: klienter måste
-- ha en roll i organisationen (inte butiken), systemrollen (larmjobbet) får alltid.
create function public.sales_data_until(p_organization_id uuid, p_at timestamptz default null)
returns table (
  machine_id uuid,
  data_source_id uuid,
  source_name text,
  manual boolean,
  data_until timestamptz,
  synced_at timestamptz,
  last_order_at timestamptz
)
language plpgsql stable
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated')
     and not private.has_role(p_organization_id, 'owner', 'admin', 'viewer', 'refiller') then
    raise exception using errcode = '42501',
      message = 'Du har inte behörighet till organisationens driftdata.';
  end if;
  return query
    select * from private.sales_data_until_rows(p_organization_id, coalesce(p_at, now()));
end
$$;
revoke all on function public.sales_data_until(uuid, timestamptz) from public, anon;
grant execute on function public.sales_data_until(uuid, timestamptz) to authenticated;
