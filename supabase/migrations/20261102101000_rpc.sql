-- =============================================================================
-- RPC:er. Alla är security definer med search_path = '' och kontrollerar
-- behörigheten (has_role) som första steg. EXECUTE bara för authenticated.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- create_organization(name, slug) → organization_id
-- Skapar organisationen, ägarmedlemskapet, inställningarna, centrallagret och
-- ägarens profil i en transaktion.
-- -----------------------------------------------------------------------------
create function public.create_organization(p_name text, p_slug text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_claims jsonb := coalesce(auth.jwt(), '{}'::jsonb);
  v_org uuid;
  v_display_name text;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'Inloggning krävs.';
  end if;

  insert into public.organizations (name, slug)
  values (btrim(p_name), lower(btrim(p_slug)))
  returning id into v_org;

  insert into public.memberships (organization_id, user_id, role)
  values (v_org, v_uid, 'owner');

  insert into public.organization_settings (organization_id) values (v_org);

  insert into public.stock_locations (organization_id, kind, name, is_central)
  values (v_org, 'warehouse', 'Centrallager', true);

  v_display_name := coalesce(
    nullif(btrim(v_claims -> 'user_metadata' ->> 'full_name'), ''),
    nullif(split_part(coalesce(v_claims ->> 'email', ''), '@', 1), ''),
    'Ägare'
  );
  insert into public.profiles (organization_id, user_id, display_name)
  values (v_org, v_uid, v_display_name);

  return v_org;
end
$$;

-- -----------------------------------------------------------------------------
-- create_invitation(org, email, role) → token i klartext (visas EN gång)
-- Bara sha256-hashen sparas. Tidigare obesvarade inbjudningar till samma
-- adress löper ut.
-- -----------------------------------------------------------------------------
create function public.create_invitation(
  p_organization_id uuid,
  p_email text,
  p_role public.member_role,
  p_valid_days integer default 7
)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_token text;
  v_email text := lower(btrim(p_email));
begin
  if not private.has_role(p_organization_id, 'owner', 'admin') then
    raise exception using errcode = '42501', message = 'Bara ägare och admin kan bjuda in.';
  end if;
  if p_role = 'owner' and not private.has_role(p_organization_id, 'owner') then
    raise exception using errcode = '42501', message = 'Bara en ägare kan bjuda in en ägare.';
  end if;
  if p_role is null then
    raise exception using errcode = '22023', message = 'Roll saknas.';
  end if;
  if p_valid_days is null or p_valid_days not between 1 and 30 then
    raise exception using errcode = '22023', message = 'En inbjudan gäller 1–30 dagar.';
  end if;
  if exists (
    select 1
    from public.memberships m
    join auth.users u on u.id = m.user_id
    where m.organization_id = p_organization_id and u.email = v_email::extensions.citext
  ) then
    raise exception using errcode = 'BL014', message = 'Personen är redan medlem.';
  end if;

  update public.invitations i
  set expires_at = now()
  where i.organization_id = p_organization_id
    and i.email = v_email::extensions.citext
    and i.accepted_at is null
    and i.expires_at > now();

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.invitations (organization_id, email, role, token_hash, expires_at, invited_by)
  values (
    p_organization_id,
    v_email,
    p_role,
    encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
    now() + make_interval(days => p_valid_days),
    auth.uid()
  );

  return v_token;
end
$$;

-- -----------------------------------------------------------------------------
-- accept_invitation(token) → organization_id
-- Atomisk: låser inbjudan, kontrollerar e-post (mot JWT), giltighet och att
-- den inte använts, och skapar medlemskap och profil.
-- -----------------------------------------------------------------------------
create function public.accept_invitation(p_token text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_claims jsonb := coalesce(auth.jwt(), '{}'::jsonb);
  v_invitation public.invitations;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'Inloggning krävs.';
  end if;

  select * into v_invitation
  from public.invitations i
  where i.token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
  for update;

  if not found then
    raise exception using errcode = 'BL010', message = 'Inbjudan finns inte.';
  end if;
  if v_invitation.accepted_at is not null then
    raise exception using errcode = 'BL011', message = 'Inbjudan har redan använts.';
  end if;
  if v_invitation.expires_at <= now() then
    raise exception using errcode = 'BL012', message = 'Inbjudan har gått ut.';
  end if;
  if coalesce(v_claims ->> 'email', '')::extensions.citext <> v_invitation.email then
    raise exception using
      errcode = 'BL013',
      message = 'Inbjudan gäller en annan e-postadress.';
  end if;
  if exists (
    select 1 from public.memberships m
    where m.organization_id = v_invitation.organization_id and m.user_id = v_uid
  ) then
    raise exception using errcode = 'BL014', message = 'Du är redan medlem.';
  end if;

  insert into public.memberships (organization_id, user_id, role)
  values (v_invitation.organization_id, v_uid, v_invitation.role);

  update public.invitations
  set accepted_at = now(), accepted_by = v_uid
  where id = v_invitation.id;

  insert into public.profiles (organization_id, user_id, display_name)
  values (
    v_invitation.organization_id,
    v_uid,
    coalesce(
      nullif(btrim(v_claims -> 'user_metadata' ->> 'full_name'), ''),
      nullif(split_part(v_invitation.email::text, '@', 1), ''),
      'Medlem'
    )
  )
  on conflict (organization_id, user_id) do nothing;

  return v_invitation.organization_id;
end
$$;

-- -----------------------------------------------------------------------------
-- close_period(org, month, snapshot) → period_closes.id
-- Ägare och admin. Bara passerade månader. Databasen sparar en egen
-- sammanfattning (antal, intäkt, inköp och prisets täckning); appens
-- beräkning kan skickas med i p_snapshot och sparas under nyckeln "app".
-- -----------------------------------------------------------------------------
create function public.close_period(
  p_organization_id uuid,
  p_month date,
  p_snapshot jsonb default null
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_current_month date;
  v_summary jsonb;
  v_id uuid;
begin
  if not private.has_role(p_organization_id, 'owner', 'admin') then
    raise exception using errcode = '42501', message = 'Bara ägare och admin kan stänga en månad.';
  end if;
  if p_month is null or p_month <> date_trunc('month', p_month)::date then
    raise exception using errcode = '22023', message = 'Ange månadens första dag.';
  end if;
  if p_snapshot is not null and jsonb_typeof(p_snapshot) <> 'object' then
    raise exception using errcode = '22023', message = 'Ögonblicksbilden ska vara ett objekt.';
  end if;

  select o.timezone into v_tz
  from public.organizations o
  where o.id = p_organization_id
  for update;
  v_current_month := date_trunc('month', (now() at time zone v_tz))::date;
  if p_month >= v_current_month then
    raise exception using errcode = '22023', message = 'Bara passerade månader kan stängas.';
  end if;
  if private.is_closed_day(p_organization_id, p_month) then
    raise exception using errcode = 'BL015', message = 'Månaden är redan stängd.';
  end if;

  select jsonb_build_object(
    'month', p_month,
    'order_count', count(*),
    'revenue_ore', coalesce(sum(o.amount_ore), 0),
    'orders_without_title', count(*) filter (where o.title_id is null),
    'orders_without_price', count(*) filter (where c.unit_cost_ore is null),
    'revenue_without_price_ore', coalesce(sum(o.amount_ore) filter (where c.unit_cost_ore is null), 0),
    'cost_of_goods_ore', coalesce(sum(c.unit_cost_ore), 0)
  )
  into v_summary
  from public.orders o
  left join lateral (
    select pp.unit_cost_ore
    from public.purchase_prices pp
    where pp.organization_id = o.organization_id
      and pp.title_id = o.title_id
      and pp.valid_from <= o.business_date
    order by pp.valid_from desc
    limit 1
  ) c on true
  where o.organization_id = p_organization_id
    and o.business_date >= p_month
    and o.business_date < (p_month + interval '1 month')::date;

  insert into public.period_closes (organization_id, month, closed_at, closed_by, snapshot)
  values (
    p_organization_id,
    p_month,
    now(),
    auth.uid(),
    jsonb_build_object('database', v_summary)
      || case when p_snapshot is null then '{}'::jsonb else jsonb_build_object('app', p_snapshot) end
  )
  returning id into v_id;

  return v_id;
end
$$;

-- -----------------------------------------------------------------------------
-- reopen_period(org, month). Bara ägare. Loggas i audit_log (via triggern).
-- -----------------------------------------------------------------------------
create function public.reopen_period(p_organization_id uuid, p_month date)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not private.has_role(p_organization_id, 'owner') then
    raise exception using errcode = '42501', message = 'Bara ägaren kan öppna en stängd månad.';
  end if;
  select pc.id into v_id
  from public.period_closes pc
  where pc.organization_id = p_organization_id
    and pc.month = p_month
    and pc.reopened_at is null
  for update;
  if v_id is null then
    raise exception using errcode = 'BL016', message = 'Månaden är inte stängd.';
  end if;
  update public.period_closes
  set reopened_at = now(), reopened_by = auth.uid()
  where id = v_id;
end
$$;

-- -----------------------------------------------------------------------------
-- merge_titles(org, from, into) → antal flyttade order
-- Varken alias eller orders.raw_title skrivs om. orders.title_id flyttas (varje
-- ändring loggas i audit_log), försäljningshändelserna följer med via triggern,
-- och övrigt lager för den gamla titeln flyttas med kompenserande
-- 'adjustment'-händelser så att totalsaldot per lagerplats är oförändrat.
-- Den gamla titeln får merged_into_id och arkiveras.
-- -----------------------------------------------------------------------------
create function public.merge_titles(
  p_organization_id uuid,
  p_from_title_id uuid,
  p_into_title_id uuid
)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_from public.titles;
  v_into public.titles;
  v_moved integer;
  v_loc record;
  v_before jsonb;
  v_from_before integer;
  v_into_before integer;
begin
  if not private.has_role(p_organization_id, 'owner', 'admin') then
    raise exception using errcode = '42501', message = 'Bara ägare och admin kan slå ihop titlar.';
  end if;
  if p_from_title_id is null or p_into_title_id is null or p_from_title_id = p_into_title_id then
    raise exception using errcode = '22023', message = 'Välj två olika titlar.';
  end if;

  select * into v_from from public.titles t
  where t.organization_id = p_organization_id and t.id = p_from_title_id
  for update;
  select * into v_into from public.titles t
  where t.organization_id = p_organization_id and t.id = p_into_title_id
  for update;
  if v_from.id is null or v_into.id is null then
    raise exception using errcode = '22023', message = 'Titeln finns inte i organisationen.';
  end if;
  if v_from.merged_into_id is not null then
    raise exception using errcode = '22023', message = 'Titeln är redan sammanslagen.';
  end if;
  if v_into.merged_into_id is not null then
    raise exception using errcode = '22023', message = 'Det går inte att slå ihop till en sammanslagen titel.';
  end if;

  -- Saldo per lagerplats före flytten (för båda titlarna).
  select coalesce(
    jsonb_object_agg(sl.location_id::text || '/' || sl.title_id::text, sl.quantity),
    '{}'::jsonb
  )
  into v_before
  from public.stock_levels sl
  where sl.organization_id = p_organization_id
    and sl.title_id in (p_from_title_id, p_into_title_id);

  update public.orders o
  set title_id = p_into_title_id
  where o.organization_id = p_organization_id and o.title_id = p_from_title_id;
  get diagnostics v_moved = row_count;

  -- Kompenserande händelser: den gamla titeln töms, den nya får summan av
  -- båda titlarnas saldo före sammanslagningen.
  for v_loc in
    select
      sl.location_id,
      coalesce(sum(sl.quantity) filter (where sl.title_id = p_from_title_id), 0)::integer as from_after,
      coalesce(sum(sl.quantity) filter (where sl.title_id = p_into_title_id), 0)::integer as into_after
    from public.stock_levels sl
    where sl.organization_id = p_organization_id
      and sl.title_id in (p_from_title_id, p_into_title_id)
    group by sl.location_id
  loop
    v_from_before := coalesce(
      (v_before ->> (v_loc.location_id::text || '/' || p_from_title_id::text))::integer, 0
    );
    v_into_before := coalesce(
      (v_before ->> (v_loc.location_id::text || '/' || p_into_title_id::text))::integer, 0
    );
    if v_loc.from_after <> 0 then
      insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, note)
      values (p_organization_id, v_loc.location_id, p_from_title_id, 'adjustment',
              -v_loc.from_after, 'Sammanslagning av titel');
    end if;
    if v_from_before + v_into_before - v_loc.into_after <> 0 then
      insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, note)
      values (p_organization_id, v_loc.location_id, p_into_title_id, 'adjustment',
              v_from_before + v_into_before - v_loc.into_after, 'Sammanslagning av titel');
    end if;
  end loop;

  -- Titlar som tidigare slagits ihop med den gamla pekar vidare.
  update public.titles t
  set merged_into_id = p_into_title_id
  where t.organization_id = p_organization_id and t.merged_into_id = p_from_title_id;

  update public.titles t
  set merged_into_id = p_into_title_id, archived_at = coalesce(t.archived_at, now())
  where t.organization_id = p_organization_id and t.id = p_from_title_id;

  return v_moved;
end
$$;

-- -----------------------------------------------------------------------------
-- Rättigheter: bara authenticated får köra RPC:erna.
-- -----------------------------------------------------------------------------
revoke all on function public.create_organization(text, text) from public, anon;
revoke all on function public.create_invitation(uuid, text, public.member_role, integer) from public, anon;
revoke all on function public.accept_invitation(text) from public, anon;
revoke all on function public.close_period(uuid, date, jsonb) from public, anon;
revoke all on function public.reopen_period(uuid, date) from public, anon;
revoke all on function public.merge_titles(uuid, uuid, uuid) from public, anon;

grant execute on function public.create_organization(text, text) to authenticated;
grant execute on function public.create_invitation(uuid, text, public.member_role, integer) to authenticated;
grant execute on function public.accept_invitation(text) to authenticated;
grant execute on function public.close_period(uuid, date, jsonb) to authenticated;
grant execute on function public.reopen_period(uuid, date) to authenticated;
grant execute on function public.merge_titles(uuid, uuid, uuid) to authenticated;
