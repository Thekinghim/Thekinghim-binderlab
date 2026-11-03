-- =============================================================================
-- Tillväxt C: digital signering av avtal på plats.
--
-- contract_signing_links  En signeringslänk till ett avtal: hash av token (själva token
--                         visas en gång för ägaren och sparas aldrig), hash av PDF:en som
--                         ska signeras, giltig till, använd, ersatt. Mallavtal sparar
--                         också HTML:en som PDF:en skrevs ut från (snapshot_html), så att
--                         den signerade PDF:en kan skrivas ut med samma text.
-- contract_signatures     Signaturen: namn, ritad signatur (PNG), tid, IP, webbläsare och
--                         hash av PDF:en som visades. Den signerade PDF:en (avtalet plus
--                         signaturblad) sparas i bucketen 'contracts' och knyts till raden en
--                         gång.
--
-- Flödet:
--   1. Ägare eller admin skapar länken (public.create_contract_signing_link, som
--      användaren). Avtalet måste ha en PDF; en ny länk ersätter tidigare öppna länkar och
--      avtalet blir skickat.
--   2. Butiksägaren öppnar /signera/{token} utan inloggning. Servern slår upp token med
--      private.contract_signing_lookup och signerar med private.contract_signing_sign.
--      UNDANTAG från regeln att användarförfrågningar går via RLS: här finns ingen
--      användare. Token (32 slumpbyte) är beviset, precis som för inbjudningar. Funktionerna
--      ligger i private och kan inte köras av någon klientroll, bara av servern
--      (databasägaren). De kontrollerar allt i en transaktion med radlås: token, att länken
--      inte är använd, ersatt eller utgången, att avtalet finns och att PDF:en är samma som
--      när länken skapades och som butiksägaren läste.
--   3. Den signerade PDF:en knyts till signaturen med private.contract_signing_attach
--      (bara en gång, sökvägen {org}/{avtal}/{sha256}.pdf).
--
-- Behörighet: ägare, admin och läsare läser länkar och signaturer. Ingen klientroll skriver;
-- inget raderas.
-- =============================================================================

create table public.contract_signing_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  contract_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  document_sha256 text not null check (document_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot_html text check (snapshot_html is null or octet_length(snapshot_html) <= 500000),
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, contract_id)
    references public.contracts (organization_id, id) on delete restrict
);

create index contract_signing_links_contract_idx
  on public.contract_signing_links (organization_id, contract_id, created_at desc);

create table public.contract_signatures (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  contract_id uuid not null,
  link_id uuid not null,
  signer_name text not null check (char_length(btrim(signer_name)) between 2 and 100),
  -- Den ritade signaturen som PNG (kontrolleras: PNG-signaturen och högst 300 kB).
  signature_png bytea not null
    check (octet_length(signature_png) between 67 and 300000
           and substring(signature_png from 1 for 8) = '\x89504e470d0a1a0a'::bytea),
  document_sha256 text not null check (document_sha256 ~ '^[0-9a-f]{64}$'),
  signed_at timestamptz not null default now(),
  ip text check (ip is null or char_length(ip) <= 64),
  user_agent text check (user_agent is null or char_length(user_agent) <= 500),
  signed_file_path text check (signed_file_path is null or char_length(signed_file_path) <= 300),
  signed_file_sha256 text check (signed_file_sha256 is null or signed_file_sha256 ~ '^[0-9a-f]{64}$'),
  signed_file_bytes bigint check (signed_file_bytes is null or signed_file_bytes between 1 and 20971520),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  -- En signatur per länk.
  unique (organization_id, link_id),
  check ((signed_file_path is null) = (signed_file_sha256 is null)
         and (signed_file_path is null) = (signed_file_bytes is null)),
  foreign key (organization_id, contract_id)
    references public.contracts (organization_id, id) on delete restrict,
  foreign key (organization_id, link_id)
    references public.contract_signing_links (organization_id, id) on delete restrict
);

create index contract_signatures_contract_idx
  on public.contract_signatures (organization_id, contract_id, signed_at desc);

alter table public.contract_signing_links alter column organization_id set statistics 0;
alter table public.contract_signatures alter column organization_id set statistics 0;

-- Signaturen ändras aldrig. Bara den signerade PDF:en kan knytas till den, en gång.
create function private.contract_signatures_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.contract_id, new.link_id, new.signer_name, new.signature_png, new.document_sha256,
      new.signed_at, new.ip, new.user_agent)
     is distinct from
     (old.contract_id, old.link_id, old.signer_name, old.signature_png, old.document_sha256,
      old.signed_at, old.ip, old.user_agent) then
    raise exception using errcode = 'BL075', message = 'En signatur kan inte ändras.';
  end if;
  if old.signed_file_path is not null
     and (new.signed_file_path, new.signed_file_sha256, new.signed_file_bytes)
         is distinct from (old.signed_file_path, old.signed_file_sha256, old.signed_file_bytes) then
    raise exception using errcode = 'BL075', message = 'Den signerade PDF:en är redan sparad.';
  end if;
  return new;
end
$$;

create trigger t10_guard before update on public.contract_signatures
  for each row execute function private.contract_signatures_guard();

do $$
declare
  v_table text;
begin
  foreach v_table in array array['contract_signing_links', 'contract_signatures']
  loop
    execute format('create trigger t00_forbid_org_change before update on public.%I
      for each row execute function private.forbid_org_change()', v_table);
    execute format('create trigger t20_stamp_insert before insert on public.%I
      for each row execute function private.stamp_insert()', v_table);
    execute format('create trigger t20_stamp_update before update on public.%I
      for each row execute function private.stamp_update()', v_table);
    execute format('create trigger t99_forbid_delete before delete on public.%I
      for each row execute function private.forbid_delete()', v_table);
  end loop;
end
$$;

-- Ändringarna loggas, utan token-hashen, HTML:en och signaturbilden (stora och onödiga i loggen).
create trigger t90_audit after insert or update or delete on public.contract_signing_links
  for each row execute function private.audit('token_hash', 'snapshot_html');
create trigger t90_audit after insert or update or delete on public.contract_signatures
  for each row execute function private.audit('signature_png');

-- -----------------------------------------------------------------------------
-- Rättigheter och RLS
-- -----------------------------------------------------------------------------
alter table public.contract_signing_links enable row level security;
alter table public.contract_signatures enable row level security;

revoke all on table public.contract_signing_links from anon, authenticated, service_role;
revoke all on table public.contract_signatures from anon, authenticated, service_role;

grant select on table public.contract_signing_links to authenticated;
grant select on table public.contract_signatures to authenticated;
-- Servernyckeln (service_role) som övriga tabeller; appen skriver via RPC:n och databasägaren.
grant select, insert, update on table public.contract_signing_links to service_role;
grant select, insert, update on table public.contract_signatures to service_role;

create policy contract_signing_links_select on public.contract_signing_links
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy contract_signatures_select on public.contract_signatures
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));

-- -----------------------------------------------------------------------------
-- create_contract_signing_link: ägare och admin, som användaren.
-- Returnerar länkens id. Token skapas och visas av servern; bara hashen kommer hit.
-- -----------------------------------------------------------------------------
create function public.create_contract_signing_link(
  p_organization_id uuid,
  p_contract_id uuid,
  p_token_hash text,
  p_document_sha256 text,
  p_snapshot_html text,
  p_valid_days integer
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_contract public.contracts;
  v_id uuid;
begin
  if (select auth.uid()) is null
     or not private.has_role(p_organization_id, 'owner', 'admin') then
    raise exception using errcode = '42501', message = 'Du har inte behörighet till det här.';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_document_sha256 is null or p_document_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'BL074', message = 'Ogiltig länk.';
  end if;
  if p_valid_days is null or p_valid_days not between 1 and 30 then
    raise exception using errcode = 'BL074', message = 'Länken kan gälla 1–30 dagar.';
  end if;

  select * into v_contract
  from public.contracts c
  where c.organization_id = p_organization_id and c.id = p_contract_id
  for update;
  if not found or v_contract.archived_at is not null or v_contract.terminated_on is not null then
    raise exception using errcode = 'BL070', message = 'Avtalet finns inte.';
  end if;
  if v_contract.signed_at is not null then
    raise exception using errcode = 'BL071', message = 'Avtalet är redan signerat.';
  end if;
  if v_contract.file_content_type is distinct from 'application/pdf'
     or v_contract.file_sha256 is distinct from p_document_sha256 then
    raise exception using errcode = 'BL073', message = 'Avtalet behöver en PDF först.';
  end if;

  -- En ny länk ersätter de öppna: bara den senaste fungerar.
  update public.contract_signing_links
     set revoked_at = now()
   where organization_id = p_organization_id and contract_id = p_contract_id
     and used_at is null and revoked_at is null;

  insert into public.contract_signing_links
    (organization_id, contract_id, token_hash, document_sha256, snapshot_html, expires_at)
  values
    (p_organization_id, p_contract_id, p_token_hash, p_document_sha256, p_snapshot_html,
     now() + make_interval(days => p_valid_days))
  returning id into v_id;

  update public.contracts
     set sent_at = coalesce(sent_at, now())
   where organization_id = p_organization_id and id = p_contract_id;

  return v_id;
end
$$;

revoke all on function public.create_contract_signing_link(uuid, uuid, text, text, text, integer)
  from public, anon;
grant execute on function public.create_contract_signing_link(uuid, uuid, text, text, text, integer)
  to authenticated;

-- -----------------------------------------------------------------------------
-- private.contract_signing_lookup(token): vad sidan /signera/{token} får visa.
-- Bara servern (databasägaren). Status:
--   valid    länken kan användas (uppgifterna för sidan)
--   signed   redan signerad med länken, de senaste 30 dagarna (kvittot och nedladdningen)
--   used     redan signerad, för länge sedan
--   expired  gått ut
--   changed  avtalets PDF har bytts sedan länken skapades
--   missing  okänd, ersatt, eller avtalet arkiverat/uppsagt (avslöjar inget)
-- -----------------------------------------------------------------------------
create function private.contract_signing_lookup(p_token text)
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  v_link public.contract_signing_links;
  v_contract public.contracts;
  v_sig public.contract_signatures;
  v_org public.organizations;
  v_store public.stores;
  v_status text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'missing');
  end if;
  select * into v_link from public.contract_signing_links l
  where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found or v_link.revoked_at is not null then
    return jsonb_build_object('status', 'missing');
  end if;
  select * into v_contract from public.contracts c
  where c.organization_id = v_link.organization_id and c.id = v_link.contract_id;
  select * into v_org from public.organizations o where o.id = v_link.organization_id;
  if v_contract.id is null or v_org.archived_at is not null then
    return jsonb_build_object('status', 'missing');
  end if;

  if v_link.used_at is not null then
    select * into v_sig from public.contract_signatures s
    where s.organization_id = v_link.organization_id and s.link_id = v_link.id;
    v_status := case when v_sig.signed_at > now() - interval '30 days' then 'signed' else 'used' end;
  elsif v_contract.archived_at is not null or v_contract.terminated_on is not null then
    return jsonb_build_object('status', 'missing');
  elsif v_link.expires_at <= now() then
    v_status := 'expired';
  elsif v_contract.signed_at is not null then
    v_status := 'used';
  elsif v_contract.file_sha256 is distinct from v_link.document_sha256
        or v_contract.file_content_type is distinct from 'application/pdf' then
    v_status := 'changed';
  else
    v_status := 'valid';
  end if;
  if v_status in ('used', 'expired', 'changed') then
    return jsonb_build_object('status', v_status, 'organization_name', v_org.name);
  end if;

  select * into v_store from public.stores st
  where st.organization_id = v_contract.organization_id and st.id = v_contract.store_id;

  return jsonb_build_object(
    'status', v_status,
    'organization_id', v_link.organization_id,
    'contract_id', v_contract.id,
    'link_id', v_link.id,
    'organization_name', v_org.name,
    'store_name', v_store.name,
    'contract_title', coalesce(v_contract.title, 'Avtal'),
    'valid_from', v_contract.valid_from,
    'terms', v_contract.terms,
    'expires_at', v_link.expires_at,
    'document_sha256', v_link.document_sha256,
    'document_path', case when v_status = 'valid' then v_contract.storage_path end,
    'document_name', v_contract.file_name,
    'has_snapshot', v_link.snapshot_html is not null,
    'signature_id', v_sig.id,
    'signer_name', v_sig.signer_name,
    'signed_at', v_sig.signed_at,
    'signed_file_path', v_sig.signed_file_path
  );
end
$$;

-- -----------------------------------------------------------------------------
-- private.contract_signing_sign: signerar med länken, en gång. Bara servern.
-- Fel: BL070 okänd/ersatt, BL071 redan använd, BL072 utgången, BL073 PDF:en har ändrats
-- (eller är inte den som visades), BL074 ogiltiga uppgifter.
-- -----------------------------------------------------------------------------
create function private.contract_signing_sign(
  p_token text,
  p_document_sha256 text,
  p_signer_name text,
  p_signature_png bytea,
  p_ip text,
  p_user_agent text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_link public.contract_signing_links;
  v_contract public.contracts;
  v_name text := regexp_replace(btrim(coalesce(p_signer_name, '')), '\s+', ' ', 'g');
  v_sig_id uuid;
  v_signed_at timestamptz;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'BL070', message = 'Länken känns inte igen.';
  end if;
  select * into v_link from public.contract_signing_links l
  where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
  for update;
  if not found or v_link.revoked_at is not null then
    raise exception using errcode = 'BL070', message = 'Länken känns inte igen.';
  end if;
  if v_link.used_at is not null then
    raise exception using errcode = 'BL071', message = 'Avtalet är redan signerat med den här länken.';
  end if;
  if v_link.expires_at <= now() then
    raise exception using errcode = 'BL072', message = 'Länken har gått ut.';
  end if;

  select * into v_contract from public.contracts c
  where c.organization_id = v_link.organization_id and c.id = v_link.contract_id
  for update;
  if not found or v_contract.archived_at is not null or v_contract.terminated_on is not null
     or exists (select 1 from public.organizations o
                where o.id = v_link.organization_id and o.archived_at is not null) then
    raise exception using errcode = 'BL070', message = 'Länken känns inte igen.';
  end if;
  if v_contract.signed_at is not null then
    raise exception using errcode = 'BL071', message = 'Avtalet är redan signerat.';
  end if;
  if v_contract.file_sha256 is distinct from v_link.document_sha256
     or p_document_sha256 is distinct from v_link.document_sha256 then
    raise exception using errcode = 'BL073', message = 'Avtalet har ändrats. Be om en ny länk.';
  end if;
  if char_length(v_name) not between 2 and 100 then
    raise exception using errcode = 'BL074', message = 'Skriv ditt namn.';
  end if;
  if p_signature_png is null or octet_length(p_signature_png) not between 67 and 300000
     or substring(p_signature_png from 1 for 8) <> '\x89504e470d0a1a0a'::bytea then
    raise exception using errcode = 'BL074', message = 'Rita din signatur.';
  end if;

  insert into public.contract_signatures
    (organization_id, contract_id, link_id, signer_name, signature_png, document_sha256,
     ip, user_agent)
  values
    (v_link.organization_id, v_link.contract_id, v_link.id, v_name, p_signature_png,
     v_link.document_sha256, left(nullif(btrim(p_ip), ''), 64), left(nullif(btrim(p_user_agent), ''), 500))
  returning id, signed_at into v_sig_id, v_signed_at;

  update public.contract_signing_links set used_at = v_signed_at
   where organization_id = v_link.organization_id and id = v_link.id;
  -- Övriga öppna länkar till avtalet slutar gälla.
  update public.contract_signing_links set revoked_at = v_signed_at
   where organization_id = v_link.organization_id and contract_id = v_link.contract_id
     and id <> v_link.id and used_at is null and revoked_at is null;
  update public.contracts
     set signed_at = v_signed_at, sent_at = coalesce(sent_at, v_signed_at)
   where organization_id = v_link.organization_id and id = v_link.contract_id;

  return jsonb_build_object(
    'signature_id', v_sig_id,
    'organization_id', v_link.organization_id,
    'contract_id', v_link.contract_id,
    'signed_at', v_signed_at,
    'signer_name', v_name
  );
end
$$;

-- -----------------------------------------------------------------------------
-- private.contract_signing_attach: knyter den signerade PDF:en till signaturen, en gång.
-- Bara servern. Sökvägen måste vara {org}/{avtal}/{sha256}.pdf.
-- -----------------------------------------------------------------------------
create function private.contract_signing_attach(
  p_signature_id uuid,
  p_storage_path text,
  p_sha256 text,
  p_size_bytes bigint
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_sig public.contract_signatures;
begin
  select * into v_sig from public.contract_signatures s where s.id = p_signature_id for update;
  if not found then
    raise exception using errcode = 'BL070', message = 'Signaturen finns inte.';
  end if;
  if v_sig.signed_file_path is not null then
    return false;
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
     or p_storage_path is distinct from
        v_sig.organization_id::text || '/' || v_sig.contract_id::text || '/' || p_sha256 || '.pdf' then
    raise exception using errcode = 'BL074', message = 'Ogiltig sökväg för den signerade PDF:en.';
  end if;
  update public.contract_signatures
     set signed_file_path = p_storage_path, signed_file_sha256 = p_sha256,
         signed_file_bytes = p_size_bytes
   where id = v_sig.id;
  return true;
end
$$;

revoke all on function private.contract_signing_lookup(text) from public, anon, authenticated, service_role;
revoke all on function private.contract_signing_sign(text, text, text, bytea, text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.contract_signing_attach(uuid, text, text, bigint)
  from public, anon, authenticated, service_role;
revoke all on function private.contract_signatures_guard() from public, anon;
