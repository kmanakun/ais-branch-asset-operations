-- Move daily operations to a Scanner-first register while keeping all historical
-- records and the existing evidence / independent Admin acceptance workflow.

alter table app_private.branch_work_orders
  drop constraint if exists branch_work_orders_origin_check;
alter table app_private.branch_work_orders
  add constraint branch_work_orders_origin_check
  check (origin in ('admin', 'legacy', 'scanner_detail'));

create table app_private.scanner_discovery_reports (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references app_private.branches(id) on delete restrict,
  serial_number text not null check (length(btrim(serial_number)) between 1 and 100),
  observed_model text check (observed_model is null or length(btrim(observed_model)) <= 160),
  notes text check (notes is null or length(btrim(notes)) <= 1000),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'duplicate')),
  reported_by uuid not null references auth.users(id) on delete restrict,
  reviewed_by uuid references auth.users(id) on delete set null,
  review_note text check (review_note is null or length(btrim(review_note)) <= 1000),
  created_asset_id uuid references app_private.scanner_assets(id) on delete set null,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  check ((status = 'pending' and reviewed_by is null and reviewed_at is null)
    or (status <> 'pending' and reviewed_by is not null and reviewed_at is not null))
);

alter table app_private.scanner_discovery_reports enable row level security;
create policy scanner_discovery_reports_deny_browser
  on app_private.scanner_discovery_reports for all to anon, authenticated
  using (false) with check (false);
revoke all on table app_private.scanner_discovery_reports from public, anon, authenticated;
create index scanner_discovery_reports_branch_created_idx
  on app_private.scanner_discovery_reports (branch_id, created_at desc);
create index scanner_discovery_reports_pending_created_idx
  on app_private.scanner_discovery_reports (created_at, id) where status = 'pending';
create unique index scanner_discovery_reports_pending_serial_uidx
  on app_private.scanner_discovery_reports (lower(btrim(serial_number))) where status = 'pending';

create or replace function public.ais_dashboard_province_summary()
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
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role not in ('admin', 'field_technician') then
    raise exception 'Active application access required' using errcode = '42501';
  end if;

  with scanner_state as (
    select s.id as asset_id, s.branch_id,
      case
        when latest.workflow_stage in ('delivered', 'exception_resolved', 'legacy_completed') then 'complete'
        when latest.task_status in ('scheduled', 'in_progress', 'blocked') then 'on_process'
        else 'open'
      end as state
    from app_private.scanner_assets s
    left join lateral (
      select rt.status::text as task_status,
        app_private.task_workflow_stage(rt.status, rt.technician_confirmed_at,
          rt.closeout_submitted_at, rt.admin_accepted_at, fv.outcome) as workflow_stage
      from app_private.replacement_tasks rt
      left join app_private.campaign_items ci on ci.id = rt.campaign_item_id
      left join lateral (
        select v.outcome
        from app_private.field_visits v
        where v.task_id = rt.id
        order by v.performed_at desc nulls last, v.created_at desc, v.id desc
        limit 1
      ) fv on true
      where coalesce(rt.scanner_asset_id, ci.scanner_asset_id) = s.id
      order by case when rt.status in ('scheduled', 'in_progress', 'blocked') then 0 else 1 end,
        rt.created_at desc, rt.id desc
      limit 1
    ) latest on true
  ), branch_state as (
    select b.id as branch_id,
      coalesce(nullif(btrim(b.province), ''), 'à¹„à¸¡à¹ˆà¸£à¸°à¸šà¸¸à¸ˆà¸±à¸‡à¸«à¸§à¸±à¸”') as province,
      count(ss.asset_id)::integer as scanners_total,
      count(ss.asset_id) filter (where ss.state = 'open')::integer as scanners_open,
      count(ss.asset_id) filter (where ss.state = 'on_process')::integer as scanners_on_process,
      count(ss.asset_id) filter (where ss.state = 'complete')::integer as scanners_complete
    from app_private.branches b
    left join scanner_state ss on ss.branch_id = b.id
    group by b.id, coalesce(nullif(btrim(b.province), ''), 'à¹„à¸¡à¹ˆà¸£à¸°à¸šà¸¸à¸ˆà¸±à¸‡à¸«à¸§à¸±à¸”')
  ), province_state as (
    select bs.province,
      count(*)::integer as branches_total,
      count(*) filter (where bs.scanners_total > 0 and bs.scanners_complete = bs.scanners_total)::integer as branches_complete,
      (count(*) - count(*) filter (where bs.scanners_total > 0 and bs.scanners_complete = bs.scanners_total))::integer as branches_remaining,
      sum(bs.scanners_total)::integer as scanners_total,
      sum(bs.scanners_open)::integer as scanners_open,
      sum(bs.scanners_on_process)::integer as scanners_on_process,
      sum(bs.scanners_complete)::integer as scanners_complete
    from branch_state bs
    group by bs.province
  )
  select jsonb_build_object(
    'totals', jsonb_build_object(
      'branches_total', coalesce(sum(ps.branches_total), 0),
      'branches_complete', coalesce(sum(ps.branches_complete), 0),
      'branches_remaining', coalesce(sum(ps.branches_remaining), 0),
      'scanners_total', coalesce(sum(ps.scanners_total), 0),
      'scanners_open', coalesce(sum(ps.scanners_open), 0),
      'scanners_on_process', coalesce(sum(ps.scanners_on_process), 0),
      'scanners_complete', coalesce(sum(ps.scanners_complete), 0)
    ),
    'provinces', coalesce(jsonb_agg(jsonb_build_object(
      'province', ps.province,
      'branches_total', ps.branches_total,
      'branches_complete', ps.branches_complete,
      'branches_remaining', ps.branches_remaining,
      'scanners_total', ps.scanners_total,
      'scanners_open', ps.scanners_open,
      'scanners_on_process', ps.scanners_on_process,
      'scanners_complete', ps.scanners_complete
    ) order by ps.province), '[]'::jsonb)
  ) into result
  from province_state ps;
  return result;
end
$$;
revoke all on function public.ais_dashboard_province_summary() from public, anon;
grant execute on function public.ais_dashboard_province_summary() to authenticated;

create or replace function public.ais_start_scanner_replacement(
  p_scanner_asset_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  branch_id uuid;
  branch_code text;
  scanner_serial text;
  scanner_model text;
  order_id uuid;
  order_origin text;
  order_code text;
  task_id uuid;
  task_version integer;
  existing_actor uuid;
  existing_scanner uuid;
  existing_status text;
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role not in ('admin', 'field_technician') then
    raise exception 'Active Admin or Field Technician access required' using errcode = '42501';
  end if;
  if p_scanner_asset_id is null or p_request_id is null then
    raise exception 'Scanner and request id are required' using errcodxçİ­¢G§²ÚîÆ­yÛ˜ŠBˆ[È™\İ[Ü›İÜÂˆœ›ÛH
ˆÙ[XİšYš\Ú]œ\™›Ü›YYØ]\ÈÛÜÜ\™›Ü›YYØ]\]YØ]\ÈÛÜİ\]YØ]ˆœÛÛ˜—ØZ[ÛØš™Xİ
ˆ	ÚY	ËšY	Ø\ÜÙ]ÚY	ËËšY	Øœ˜[˜ÚÛ˜[YIËÛØ[\ØÙJ[YŠ‹›Ø×Ø›	ÉÊK‹›ØØ][Û—ØÛÙJKˆ	ÛØØ][Û—ØÛÙIË‹›ØØ][Û—ØÛÙK	Ü›İš[˜ÙIË‹œ›İš[˜ÙKˆ	ÜØØ[›™\—Û[Ù[	ËÛØ[\ØÙJ[YŠË›[Ù[Û˜[YK	ÉÊK[YŠËš×Û˜[YK	ÉÊK	ÉÊKˆ	ØÛÛWÜÛ‰ËË˜ÛÛWÜÛ‹	İÛÜš×ÛÜ™\—ØÛÙIËÛËÛÜš×ÛÜ™\—ØÛÙKˆ	İX[WÛ˜[YIËX[WÛ˜[YK	İX[WØXİ]™IËÛØ[\ØÙJš\×ØXİ]™K˜[ÙJKˆ	ÜØÚY[YÙ›Ü‰ËœØÚY[YÙ›Ü‹	ØÜ™X]YØ]	Ë˜Ü™X]YØ]ˆ	Üİ\YØ]	Ëœİ\YØ]	Üİ\YØIËœİ\YØKˆ	ØÛÜÙ[İ]ÜİX›Z]YØ]	Ë˜ÛÜÙ[İ]ÜİX›Z]YØ]ˆ	ØÛÜÙ[İ]ÜİX›Z]YØIË˜ÛÜÙ[İ]ÜİX›Z]YØKˆ	ØYZ[—ØXØÙ\YØ]	Ë˜YZ[—ØXØÙ\YØ]ˆ	ØYZ[—ØXØÙ\YØIË˜YZ[—ØXØÙ\YØKˆ	İ\Ú×Üİ]\ÉËœİ]\Î^ˆ	İÛÜšÙ›İ×ÜİYÙIË\Üš]˜]K\Ú×İÛÜšÙ›İ×ÜİYÙJœİ]\ËXÚšXÚX[—ØÛÛ™š\›YYØ]ˆ˜ÛÜÙ[İ]ÜİX›Z]YØ]˜YZ[—ØXØÙ\YØ]š\Ú]›İ]ÛÛYJKˆ	İÛÜšÙ›İ×Ûİ]ÛÛYIËš\Ú]›İ]ÛÛYK	ÛØœÙ\™YÜÙ\šX[	Ëš\Ú]›ØœÙ\™YÜÙ\šX[ˆ	ÛØœÙ\™YÛ[Ù[	Ëš\Ú]›ØœÙ\™YÛ[Ù[	Ù^Ù\[Û—Ü™X\ÛÛ‰Ëš\Ú]™^Ù\[Û—Ü™X\ÛÛ‹ˆ	İ™\œÚ[Û‰Ë™\œÚ[Û‹	Ø›ØÚÙYÜ™X\ÛÛ‰Ë˜›ØÚÙYÜ™X\ÛÛ‹ˆ	Û™]×ÜÙ\šX[	Ëš\Ú]›™]×ÜÙ\šX[	ÛÛÜÙ\šX[ÜÛ˜\Úİ	Ëš\Ú]›ÛÜÙ\šX[ÜÛ˜\Úİˆ	Ú[œİ[Ü™\İ[	Ëš\Ú]š[œİ[Ü™\İ[	ÛÛÜØØ[›™\—Üİ]\ÉËš\Ú]›ÛÜØØ[›™\—Üİ]\Ëˆ	ÛÛÜØØ[›™\—Û›İIËš\Ú]›ÛÜØØ[›™\—Û›İK	Ü\™›Ü›YYØWÛ˜[YIËš\Ú]œ\™›Ü›Y\—Û˜[YKˆ	Ü\™›Ü›YYØ]	Ëš\Ú]œ\™›Ü›YYØ]	ØØ[—ØYZ[—ØXØÙ\	ËˆXİÜ—Ü›ÛHH	ØYZ[‰È[™˜ÛÜÙ[İ]ÜİX›Z]YØ]\È›İ[ˆ[™˜YZ[—ØXØÙ\YØ]\È[[™XİÜˆ\È\İ[˜İœ›ÛH˜ÛÜÙ[İ]ÜİX›Z]YØBˆ[™XİÜˆ\È\İ[˜İœ›ÛHš\Ú]œ\™›Ü›YYØBˆ
H\È›İ×Ù]Bˆœ›ÛH\Üš]˜]Kœ™\XÙ[Y[İ\ÚÜÈˆY›Ú[ˆ\Üš]˜]K˜Ø[\ZYÛ—Ú][\ÈÚHÛˆÚKšYH˜Ø[\ZYÛ—Ú][WÚYˆ›Ú[ˆ\Üš]˜]KœØØ[›™\—Ø\ÜÙ]ÈÈÛˆËšYHÛØ[\ØÙJœØØ[›™\—Ø\ÜÙ]ÚYÚKœØØ[›™\—Ø\ÜÙ]ÚY
Bˆ›Ú[ˆ\Üš]˜]K˜œ˜[˜Ú\ÈˆÛˆ‹šYHË˜œ˜[˜ÚÚYˆY›Ú[ˆ\Üš]˜]K˜œ˜[˜ÚİÛÜš×ÛÜ™\œÈÛÈÛˆÛËšYH˜œ˜[˜ÚİÛÜš×ÛÜ™\—ÚYˆY›Ú[ˆ\Üš]˜]KX[\ÈÛˆšYHX[WÚYˆY›Ú[ˆ]\˜[
ˆÙ[Xİ‹›ÛÜÙ\šX[ÜÛ˜\Úİ‹›™]×ÜÙ\šX[‹š[œİ[Ü™\İ[ˆ‹›ÛÜØØ[›™\—Üİ]\Î^\ÈÛÜØØ[›™\—Üİ]\Ë‹›ÛÜØØ[›™\—Û›İKˆ‹›İ]ÛÛYK‹›ØœÙ\™YÜÙ\šX[‹›ØœÙ\™YÛ[Ù[‹™^Ù\[Û—Ü™X\ÛÛ‹‹œ\™›Ü›YYØ]ˆXK™\Ü^WÛ˜[YH\È\™›Ü›Y\—Û˜[YK‹œ\™›Ü›YYØBˆœ›ÛH\Üš]˜]K™šY[İš\Ú]È‚ˆY›Ú[ˆ\Üš]˜]K\Ù\—ØXØÙ\ÜÈXHÛˆXK\Ù\—ÚYH‹œ\™›Ü›YYØBˆÚ\™H‹\Ú×ÚYHšYˆÜ™\ˆH‹œ\™›Ü›YYØ]\ØË‹˜Ü™X]YØ]\ØË‹šY\ØÈ[Z]Bˆ
Hš\Ú]ÛˆYBˆÚ\™HÛØ[\ØÙJœØØ[›™\—Ø\ÜÙ]ÚYÚKœØØ[›™\—Ø\ÜÙ]ÚY
HHØ\ÜÙ]ÚYˆ[™
İ\Ú×ÚY\È[ÜˆšYHİ\Ú×ÚY
BˆÜ™\ˆHš\Ú]œ\™›Ü›YYØ]\ØÈ[È\İ\]YØ]\ØËšY\ØÂˆ[Z]Û[Z]Ù™œÙ]ÛÙ™œÙ]ˆ
H\İÜNÂˆ™]\›ˆœÛÛ˜—ØZ[ÛØš™Xİ
	Ø\ÜÙ]ÚY	ËØ\ÜÙ]ÚY	İİ[	Ëİ[Ü›İÜË	Ü›İÜÉË™\İ[Ü›İÜÊNÂ™[™‰	Âœ™]›ÚÙH[Ûˆ[˜İ[ÛˆX›XË˜Z\×ÜØØ[›™\—İÛÜš×Ú\İÜJ]ZY]ZY[YÙ\‹[YÙ\ŠHœ›ÛHX›XË[›ÛÂ™Ü˜[^Xİ]HÛˆ[˜İ[ÛˆX›XË˜Z\×ÜØØ[›™\—İÛÜš×Ú\İÜJ]ZY]ZY[YÙ\‹[YÙ\ŠHÈ]][XØ]YÂ‚˜Ü™X]HÜˆ™\XÙH[˜İ[ÛˆX›XË˜Z\×ÜØØ[›™\—ÜYÙJˆÜÙX\˜Ú^Y˜][[ˆÛ[Z][YÙ\ˆY˜][LˆÛÙ™œÙ][YÙ\ˆY˜][ŠBœ™]\›œÈœÛÛ˜‚›[™İXYÙHÜÜ[œİX›BœÙXİ\š]HYš[™\‚œÙ]ÙX\˜ÚÜ]H	ÉÂ˜\È		™XÛ\™BˆXİÜˆ]ZYH]]ZY

NÂˆXİÜ—Ü›ÛH\Üš]˜]K˜\Ü›ÛNÂˆÙX\˜Úİ\›H^H[YŠš[JÜÙX\˜Ú
K	ÉÊNÂˆ™\İ[œÛÛ˜Â˜™YÚ[‚ˆÙ[XİXKœ›ÛH[ÈXİÜ—Ü›ÛHœ›ÛH\Üš]˜]K\Ù\—ØXØÙ\ÜÈXBˆÚ\™HXK\Ù\—ÚYHXİÜˆ[™XKš\×ØXİ]™NÂˆYˆXİÜˆ\È[ÜˆXİÜ—Ü›ÛH\È[[‚ˆ˜Z\ÙH^Ù\[Ûˆ	Ğ\XØ][ÛˆXØÙ\ÜÈ™\]Z\™Y	È\Ú[™È\œ˜ÛÙHH	ÍLIÎÂˆ[™YÂˆYˆÛ[Z]\È[ÜˆÛ[Z]›İ™]ÙY[ˆH[™ŒÜˆÛÙ™œÙ]\È[ÜˆÛÙ™œÙ]ˆÜˆ[™İ
ÛØ[\ØÙJÙX\˜Úİ\›K	ÉÊJHˆL[‚ˆ˜Z\ÙH^Ù\[Ûˆ	Ò[˜[YØØ[›™\ˆÙX\˜ÚÜˆYÚ[˜][Ûˆ™\]Y\İ	È\Ú[™È\œ˜ÛÙHH	ÌŒŒŒÉÎÂˆ[™YÂˆÚ]š[\™Y\ÈX]\šX[^™Y
ˆÙ[XİËšY‹šY\Èœ˜[˜ÚÚY‹›ØØ][Û—ØÛÙK‹›Ø×Ø›\Èœ˜[˜ÚÛ˜[YK‹œ›İš[˜ÙKˆÛØ[\ØÙJ[YŠË›[Ù[Û˜[YK	ÉÊK[YŠËš×Û˜[YK	ÉÊK	ÉÊH\È[Ù[Û˜[YKË˜œ˜[™ˆØ\ÙHÚ[ˆXİÜ—Ü›ÛHH	İšY]Ù\‰È[ˆ	ø (¸ (¸ (¸ (¸ (¸ (‰ÈšYÚ
Ë˜ÛÛWÜÛ‹
H[ÙHË˜ÛÛWÜÛˆ[™\ÈÛÛWÜÛ‹ˆË˜ÛÛWŞYX\œË]\İÛÜš×ÛÜ™\—ØÛÙH\ÈØ[\ZYÛ‹]\İÛÜšÙ›İ×ÜİYÙH\Èİ]\Âˆœ›ÛH\Üš]˜]KœØØ[›™\—Ø\ÜÙ]ÈÂˆ›Ú[ˆ\Üš]˜]K˜œ˜[˜Ú\ÈˆÛˆ‹šYHË˜œ˜[˜ÚÚYˆY›Ú[ˆ]\˜[
ˆÙ[XİÛØ[\ØÙJÛËÛÜš×ÛÜ™\—ØÛÙKË˜Ø[\ZYÛ—ØÛÙJH\ÈÛÜš×ÛÜ™\—ØÛÙKˆ\Üš]˜]K\Ú×İÛÜšÙ›İ×ÜİYÙJœİ]\ËXÚšXÚX[—ØÛÛ™š\›YYØ]ˆ˜ÛÜÙ[İ]ÜİX›Z]YØ]˜YZ[—ØXØÙ\YØ]‹›İ]ÛÛYJH\ÈÛÜšÙ›İ×ÜİYÙBˆœ›ÛH\Üš]˜]Kœ™\XÙ[Y[İ\ÚÜÈˆY›Ú[ˆ\Üš]˜]K˜Ø[\ZYÛ—Ú][\ÈÚHÛˆÚKšYH˜Ø[\ZYÛ—Ú][WÚYˆY›Ú[ˆ\Üš]˜]K˜œ˜[˜ÚİÛÜš×ÛÜ™\œÈÛÈÛˆÛËšYH˜œ˜[˜ÚİÛÜš×ÛÜ™\—ÚYˆY›Ú[ˆ\Üš]˜]K˜Ø[\ZYÛœÈÈÛˆËšYHÚK˜Ø[\ZYÛ—ÚYˆY›Ú[ˆ]\˜[
ˆÙ[Xİ‹›İ]ÛÛYHœ›ÛH\Üš]˜]K™šY[İš\Ú]ÈˆÚ\™H‹\Ú×ÚYHšYˆÜ™\ˆH‹œ\™›Ü›YYØ]\ØÈ[È\İ‹˜Ü™X]YØ]\ØË‹šY\ØÈ[Z]Bˆ
HˆÛˆYBˆÚ\™HÛØ[\ØÙJœØØ[›™\—Ø\ÜÙ]ÚYÚKœØØ[›™\—Ø\ÜÙ]ÚY
HHËšYˆÜ™\ˆHØ\ÙHÚ[ˆœİ]\È[ˆ
	ÜØÚY[Y	Ë	Ú[—Ü›ÙÜ™\ÜÉË	Ø›ØÚÙY	ÊH[ˆ[ÙHH[™ˆ˜Ü™X]YØ]\ØËšY\ØÈ[Z]Bˆ
H]\İÛˆYBˆÚ\™HÙX\˜Úİ\›H\È[ˆÜˆ‹›ØØ][Û—ØÛÙH[ZÙH	ÉIÈÙX\˜Úİ\›H	ÉIÂˆÜˆÛØ[\ØÙJ‹›Ø×Ø›	ÉÊH[ZÙH	ÉIÈÙX\˜Úİ\›H	ÉIÂˆÜˆÛØ[\ØÙJ‹œ›İš[˜ÙK	ÉÊH[ZÙH	ÉIÈÙX\˜Úİ\›H	ÉIÂˆÜˆÛØ[\ØÙJË›[Ù[Û˜[YK	ÉÊH[ZÙH	ÉIÈÙX\˜Úİ\›H	ÉIÂˆÜˆÛØ[\ØÙJËš×Û˜[YK	ÉÊH[ZÙH	ÉIÈÙX\˜Úİ\›H	ÉIÂˆÜˆ
XİÜ—Ü›ÛHˆ	İšY]Ù\‰È[™Ë˜ÛÛWÜÛˆ[ZÙH	ÉIÈÙX\˜Úİ\›H	ÉIÊBˆ
KYÙH\È
ˆÙ[Xİ
ˆœ›ÛHš[\™YÜ™\ˆHİÙ\ŠÛØ[\ØÙJ›İš[˜ÙK	ÉÊJKØØ][Û—ØÛÙKœ˜[˜ÚÛ˜[YK[Ù[Û˜[YKYˆ[Z]Û[Z]Ù™œÙ]ÛÙ™œÙ]ˆ
BˆÙ[XİœÛÛ˜—ØZ[ÛØš™Xİ
ˆ	İİ[	Ë
Ù[XİÛİ[

ŠHœ›ÛHš[\™Y
Kˆ	Ü›İÜÉËÛØ[\ØÙJ
Ù[XİœÛÛ˜—ØYÙÊ×ÚœÛÛ˜ŠYÙJHÜ™\ˆHİÙ\ŠÛØ[\ØÙJ›İš[˜ÙK	ÉÊJKØØ][Û—ØÛÙKœ˜[˜ÚÛ˜[YK[Ù[Û˜[YKY
Hœ›ÛHYÙJK	Ö×IÎšœÛÛ˜ŠBˆ
H[È™\İ[Âˆ™]\›ˆ™\İ[Â™[™‰	Âœ™]›ÚÙH[Ûˆ[˜İ[ÛˆX›XË˜Z\×ÜØØ[›™\—ÜYÙJ^[YÙ\‹[YÙ\ŠHœ›ÛHX›XË[›ÛÂ™Ü˜[^Xİ]HÛˆ[˜İ[ÛˆX›XË˜Z\×ÜØØ[›™\—ÜYÙJ^[YÙ\‹[YÙ\ŠHÈ]][XØ]YÂ‚˜ÛÛ[Y[ÛˆX›H\Üš]˜]KœØØ[›™\—Ù\ØÛİ™\WÜ™\ÜÈ\Âˆ	ĞYZ[‹\™]šY]ÙY™\ÜÈ›ÜˆØØ[›™\ˆ[š]È›İ[™ÛœÚ]H]›İ™\Ù[[ˆH™YÚ\İ\™Yœ˜[˜Ú[™[ÜK‰ÎÂ˜ÛÛ[Y[Ûˆ[˜İ[ÛˆX›XË˜Z\×Üİ\ÜØØ[›™\—Ü™\XÙ[Y[
]ZY]ZY
H\Âˆ	Ôİ\ÈÛ™H™YÚ\İ\™YØØ[›™\ˆ™\XÙ[Y[\™XİHœ›ÛH]È]Z[ÈYÙK]ÛZXØ[HÜ™X][™ÈH[\›˜[ÛÜšÈ™XÛÜ™[™™XÛÜ™[™ÈH[š]X][™È\Ù\‹‰ÎÂ˜ÛÛ[Y[Ûˆ[˜İ[ÛˆX›XË˜Z\×Ù\Ú›Ø\™Ü›İš[˜ÙWÜİ[[X\J
H\Âˆ	Ô™]\›œÈ›İš[˜ÙHİ[È›Üˆœ˜[˜Ú\È[™ØØ[›™\ˆ™\XÙ[Y[›ÙÜ™\ÜÈÈXİ]™HYZ[ˆ[™šY[XÚšXÚX[ˆ\Ù\œË‰ÎÂ