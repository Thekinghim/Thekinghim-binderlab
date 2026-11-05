-- =============================================================================
-- Abonnemang: en arkiverad kundorganisation debiteras inte längre.
--
-- private.billing_machines räknade bara automatens egen arkivering och
-- active_to. En kund som arkiverar hela organisationen (ägaren kan göra det)
-- hade kvar sina automater och därmed MRR och fakturaunderlag. Nu slutar varje
-- automat senast dagen före organisationens arkivering (organisationens tidszon).
-- =============================================================================

create or replace function private.billing_machines(p_organization_id uuid)
returns table (organization_id uuid, machine_id uuid, active_from date, active_to date)
language sql stable security definer
set search_path = ''
as $$
  select x.organization_id, x.machine_id, x.active_from, x.active_to
  from (
    select m.organization_id, m.id as machine_id,
           coalesce(m.active_from, (m.created_at at time zone o.timezone)::date) as active_from,
           least(m.active_to,
                 ((m.archived_at at time zone o.timezone)::date - 1),
                 ((o.archived_at at time zone o.timezone)::date - 1)) as active_to
    from public.machines m
    join public.organizations o on o.id = m.organization_id
    where not m.is_example
      and (p_organization_id is null or m.organization_id = p_organization_id)
  ) x
  where x.active_to is null or x.active_to >= x.active_from
$$;

revoke all on function private.billing_machines(uuid) from public, anon;
