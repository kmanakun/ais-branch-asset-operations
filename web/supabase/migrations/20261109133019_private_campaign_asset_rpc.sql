-- Keep the privileged implementation in the intentionally non-exposed schema.
alter function public.ais_campaign_asset_page(uuid, integer, integer)
  set schema app_private;

revoke all on function app_private.ais_campaign_asset_page(uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function app_private.ais_campaign_asset_page(uuid, integer, integer)
  to authenticated;

-- The public API endpoint runs as the caller and delegates only to the guarded
-- helper above, avoiding a SECURITY DEFINER endpoint in an exposed schema.
create function public.ais_campaign_asset_page(
  p_campaign_id uuid,
  p_limit integer default 25,
  p_offset integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select app_private.ais_campaign_asset_page(p_campaign_id, p_limit, p_offset);
$$;

revoke all on function public.ais_campaign_asset_page(uuid, integer, integer)
  from public, anon;
grant execute on function public.ais_campaign_asset_page(uuid, integer, integer)
  to authenticated;

comment on function public.ais_campaign_asset_page(uuid, integer, integer) is
  'Authenticated caller-context RPC for paginated campaign serials; implementation resides in the non-exposed app_private schema.';
