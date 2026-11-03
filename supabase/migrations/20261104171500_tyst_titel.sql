-- =============================================================================
-- Tyst titel: påfyllaren ser och bockar av punkterna 'silent-title:<automat>:<titel>'
-- (en titel med pack i facket som slutat sälja, ofta ett fastnat fack), precis som
-- påfyllningar och tysta automater. Punkten räknas i appen (src/analytics/todos/
-- silent-title.ts); här vidgas bara nyckeltyperna som påfyllaren når i todo_dismissals.
-- `create or replace` behåller rättigheterna och policyerna som använder funktionen.
-- =============================================================================

create or replace function private.todo_key_is_stock(p_key text) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_key like 'refill:%' or p_key like 'stale-machine:%' or p_key like 'silent-title:%'
$$;
