-- =============================================================================
-- Sök: private.search_orders, kommandopalettens ordersökning (GET /sok).
--
-- Varför en funktion: organization_id har ingen planerarstatistik (statistics 0, se
-- 20261102160000_hardening_org_statistics.sql). Under RLS står organisationen två gånger
-- i frågan (policyns "= any (array(...))" och sökningens "= $org"), och planeraren
-- multiplicerar standardgissningarna till ~5 rader. Den väljer då ett btree-index på
-- organization_id och läser ALLA organisationens order (~100 ms med 100 000 order)
-- i stället för trigramindexen (20261102165000_sok_search_indexes.sql, ~2 ms).
-- Funktionen kör frågan med ett enda organisationsvillkor, och då väljer planeraren
-- trigramindexet för ovanliga sökord och orders_ordered_at_idx för vanliga.
-- Uppmätt i test/db/sok-search.test.ts.
--
-- Behörighet: security definer med search_path = ''. Första steget är has_role: bara
-- ägare, admin och läsare (samma roller som policyn orders_select). Påfyllaren och
-- butiken stoppas (42501). Bara EXECUTE för authenticated. Sökorden blir literaler via
-- format(%L) och id-listorna kastas till uuid[], så inget från anroparen blir SQL.
--
-- p_terms: [{"pattern": "%asc%", "title_ids": [uuid…], "machine_ids": [uuid…]}, …],
-- 1–6 ord. Varje ord måste träffa ordernummer, originaltitel, titel eller automat.
-- p_exact: ordernummer som ska träffas exakt (visas först), eller null.
-- =============================================================================

create function private.search_orders(
  p_organization_id uuid,
  p_terms jsonb,
  p_exact text,
  p_limit integer
)
returns table (
  id uuid,
  external_id text,
  ordered_at timestamptz,
  amount_ore bigint,
  raw_title text,
  title_id uuid,
  machine_id uuid,
  exact boolean
)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_where text := 'o.organization_id = $1';
  v_term jsonb;
  v_pattern text;
  v_titles uuid[];
  v_machines uuid[];
begin
  if not private.has_role(p_organization_id, 'owner', 'admin', 'viewer') then
    raise exception using errcode = '42501', message = 'Bara ägare, admin och läsare ser order.';
  end if;
  if p_limit is null or p_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'Antalet träffar ska vara 1–50.';
  end if;
  if p_terms is null or jsonb_typeof(p_terms) <> 'array'
     or jsonb_array_length(p_terms) not between 1 and 6 then
    raise exception using errcode = '22023', message = 'Ange 1–6 sökord.';
  end if;

  if p_exact is not null then
    return query
      select o.id, o.external_id, o.ordered_at, o.amount_ore, o.raw_title, o.title_id,
             o.machine_id, true
      from public.orders o
      where o.organization_id = p_organization_id and o.external_id = p_exact
      order by o.ordered_at desc, o.id desc
      limit 3;
  end if;

  for v_term in select t from jsonb_array_elements(p_terms) as e(t) loop
    v_pattern := v_term ->> 'pattern';
    if v_pattern is null or char_length(v_pattern) not between 1 and 300 then
      raise exception using errcode = '22023', message = 'Ogiltigt sökord.';
    end if;
    v_titles := array(
      select jsonb_array_elements_text(coalesce(v_term -> 'title_ids', '[]'::jsonb))
    )::uuid[];
    v_machines := array(
      select jsonb_array_elements_text(coalesce(v_term -> 'machine_ids', '[]'::jsonb))
    )::uuid[];
    v_where := v_where
      || format(' and (o.external_id ilike %L or o.raw_title ilike %L', v_pattern, v_pattern);
    if cardinality(v_titles) > 0 then
      v_where := v_where || format(' or o.title_id = any (%L::uuid[])', v_titles);
    end if;
    if cardinality(v_machines) > 0 then
      v_where := v_where || format(' or o.machine_id = any (%L::uuid[])', v_machines);
    end if;
    v_where := v_where || ')';
  end loop;

  return query execute
    'select o.id, o.external_id, o.ordered_at, o.amount_ore, o.raw_title, o.title_id,
            o.machine_id, false
     from public.orders o
     where ' || v_where || '
     order by o.ordered_at desc, o.id desc
     limit $2'
    using p_organization_id, p_limit;
end
$$;

revoke all on function private.search_orders(uuid, jsonb, text, integer) from public, anon;
grant execute on function private.search_orders(uuid, jsonb, text, integer) to authenticated;
