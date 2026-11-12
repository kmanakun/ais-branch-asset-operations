-- Deny inactive or unprovisioned Auth accounts explicitly (NULL role).
do $$
declare signature regprocedure; definition text;
begin
  foreach signature in array array['public.ais_import_stage(text,jsonb)'::regprocedure,'public.ais_import_commit(uuid)'::regprocedure]
  loop
    definition := pg_get_functiondef(signature);
    definition := replace(definition,
      'if actor is null or actor_role not in',
      'if actor is null or actor_role is null or actor_role not in');
    execute definition;
  end loop;
end
$$;

create or replace function public.ais_create_campaign(
  p_code text, p_name text, p_asset_ids uuid[], p_reason text,
  p_start_on date default null, p_end_on date default null
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare actor uuid := auth.uid(); actor_role app_private.app_role; campaign_id uuid; selected_count integer;
begin
  select role into actor_role from app_private.user_access where user_id=actor and is_active;
  if actor is null or actor_role is null or actor_role not in ('admin','planner') then
    raise exception 'Planner access required' using errcode='42501';
  end if;
  if p_code is null or btrim(p_code) !~ '^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$'
    or p_name is null or char_length(btrim(p_name)) not between 3 and 200
    or p_reason is null or char_length(btrim(p_reason)) not between 1 and 1000 then
    raise exception 'Invalid campaign code, name or selection reason' using errcode='22023';
  end if;
  if p_end_on < p_start_on then
    raise exception 'End date must not precede start date' using errcode='22023';
  end if;
  selected_count := cardinality(p_asset_ids);
  if selected_count is null or selected_count not between 1 and 500
    or (select count(distinct id) from unnest(p_asset_ids) id) <> selected_count then
    raise exception 'Select between 1 and 500 distinct assets' using errcode='22023';
  end if;
  -- Lock in UUID order so concurrent selections cannot claim the same scanner.
  perform id from app_private.scanner_assets where id=any(p_asset_ids) order by id for update;
  if (select count(*) from app_private.scanner_assets where id=any(p_asset_ids)) <> selected_count then
    raise exception 'One or more selected assets do not exist' using errcode='22023';
  end if;
  if exists(select 1 from app_private.campaign_items ci join app_private.campaigns c on c.id=ci.campaign_id
    where ci.scanner_asset_id=any(p_asset_ids) and c.status not in ('completed','cancelled')) then
    raise exception 'A selected asset already belongs to an active campaign' using errcode='23505';
  end if;
  insert into app_private.campaigns(campaign_code,campaign_name,status,start_on,end_on,created_by)
  values(upper(btrim(p_code)),btrim(p_name),'selection',p_start_on,p_end_on,actor)
  returning id into campaign_id;
  insert into app_private.campaign_items(campaign_id,scanner_asset_id,selection_reason,created_by)
  select campaign_id,id,btrim(p_reason),actor from unnest(p_asset_ids) id;
  insert into app_private.audit_events(actor_id,event_type,entity_type,entity_id,summary)
  values(actor,'campaign_created','campaign',campaign_id,jsonb_build_object('code',upper(btrim(p_code)),'selected_assets',selected_count));
  return jsonb_build_object('id',campaign_id,'campaign_code',upper(btrim(p_code)),'selected_assets',selected_count);
end
$$;
revoke all on function public.ais_create_campaign(text,text,uuid[],text,date,date) from public,anon;
grant execute on function public.ais_create_campaign(text,text,uuid[],text,date,date) to authenticated;
comment on function public.ais_create_campaign(text,text,uuid[],text,date,date) is
  'Active Admin/Planner only; manual asset selection with reason, ordered asset row locks, atomic creation and audit; no eligibility inferred from source year.';

create or replace function public.ais_list_campaigns(p_search text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  result jsonb;
begin
  select ua.role into actor_role from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role is null then
    raise exception 'Application access required' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(row_data order by campaign_code), '[]'::jsonb) into result
  from (
    select jsonb_build_object(
      'id', c.id,
      'branches', count(distinct s.branch_id),
      'total_assets', count(distinct ci.id),
      'campaign_code', c.campaign_code,
      'campaign_name', c.campaign_name,
      'status', c.status::text,
      'start_on', c.start_on,
      'end_on', c.end_on,
      'total_tasks', count(rt.id),
      'done_tasks', count(rt.id) filter (where rt.status in ('completed', 'cancelled'))
    ) as row_data, c.campaign_code
    from app_private.campaigns c
    left join app_private.campaign_items ci on ci.campaign_id = c.id
    left join app_private.scanner_assets s on s.id = ci.scanner_asset_id
    left join app_private.replacement_tasks rt on rt.campaign_item_id = ci.id
    where (coalesce(trim(p_search), '') = '' or c.campaign_code ilike '%' || left(trim(p_search), 100) || '%' or c.campaign_name ilike '%' || left(trim(p_search), 100) || '%')
      and (actor_role <> 'field_technician' or exists (
        select 1 from app_private.campaign_items ci2
        join app_private.replacement_tasks rt2 on rt2.campaign_item_id = ci2.id
        join app_private.user_team_memberships utm on utm.team_id = rt2.team_id and utm.user_id = actor
        where ci2.campaign_id = c.id
      ))
    group by c.id
  ) campaigns;
  return result;
end
$$;

