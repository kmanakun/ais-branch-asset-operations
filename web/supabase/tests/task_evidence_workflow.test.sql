begin;
\ir google_signin_fixture.fixture
create extension if not exists pgtap with schema extensions;
select no_plan();

select ok(not has_function_privilege('anon', 'public.ais_task_evidence_list(uuid)', 'EXECUTE'), 'anonymous callers cannot list task evidence');
select ok(not has_function_privilege('anon', 'public.ais_task_evidence_reserve_for_outcome(uuid,text,integer,text,boolean,text)', 'EXECUTE'), 'anonymous callers cannot reserve task evidence');
select ok(not has_function_privilege('authenticated', 'public.ais_task_evidence_reserve(uuid,text,integer,text,boolean)', 'EXECUTE'), 'authenticated callers cannot bypass outcome-bound reservations');
select ok(not has_function_privilege('anon', 'public.ais_task_evidence_finalize(uuid,text)', 'EXECUTE'), 'anonymous callers cannot finalize task evidence');
select ok(not has_function_privilege('anon', 'public.ais_task_evidence_cancel_pending(uuid,text)', 'EXECUTE'), 'anonymous callers cannot cancel task evidence');
select ok(has_function_privilege('authenticated', 'public.ais_task_evidence_list(uuid)', 'EXECUTE'), 'authenticated users can reach the guarded evidence list');
select ok(has_function_privilege('authenticated', 'public.ais_task_evidence_reserve_for_outcome(uuid,text,integer,text,boolean,text)', 'EXECUTE'), 'authenticated users can reach the guarded outcome-bound evidence reservation');
select ok(has_function_privilege('authenticated', 'public.ais_task_evidence_finalize(uuid,text)', 'EXECUTE'), 'authenticated users can reach the guarded evidence finalizer');
select ok(has_function_privilege('authenticated', 'public.ais_task_evidence_cancel_pending(uuid,text)', 'EXECUTE'), 'authenticated users can reach the guarded evidence cancellation');

select pg_temp.create_test_google_user('fc810000-0000-4000-8000-000000000001','evidence-tech-a@test.invalid','field_technician','Evidence Tech A');
select pg_temp.create_test_google_user('fc810000-0000-4000-8000-000000000002','evidence-tech-b@test.invalid','field_technician','Evidence Tech B');
select pg_temp.create_test_google_user('fc810000-0000-4000-8000-000000000003','evidence-admin@test.invalid','admin','Evidence Admin');
select pg_temp.create_test_google_user('fc810000-0000-4000-8000-000000000004','evidence-inactive@test.invalid','field_technician','Inactive Evidence Tech');
select pg_temp.create_test_google_user('fc810000-0000-4000-8000-000000000006','evidence-reviewer@test.invalid','admin','Evidence Reviewer');

insert into app_private.user_access(user_id, role, display_name, is_active) values
  ('fc810000-0000-4000-8000-000000000001', 'field_technician', 'Evidence Tech A', true),
  ('fc810000-0000-4000-8000-000000000002', 'field_technician', 'Evidence Tech B', true),
  ('fc810000-0000-4000-8000-000000000003', 'admin', 'Evidence Admin', true),
  ('fc810000-0000-4000-8000-000000000006', 'admin', 'Evidence Reviewer', true),
  ('fc810000-0000-4000-8000-000000000004', 'field_technician', 'Inactive Evidence Tech', false)
on conflict (user_id) do update set role=excluded.role,display_name=excluded.display_name,is_active=excluded.is_active;

insert into app_private.teams(id, team_name) values
  ('fc810000-0000-4000-8000-000000000010', 'Evidence Team A'),
  ('fc810000-0000-4000-8000-000000000011', 'Evidence Team B');
insert into app_private.branches(id, location_code, loc_bld) values
  ('fc810000-0000-4000-8000-000000000020', 'EVIDENCE-A', 'Evidence Branch A'),
  ('fc810000-0000-4000-8000-000000000021', 'EVIDENCE-B', 'Evidence Branch B'),
  ('fc810000-0000-4000-8000-000000000022', 'EVIDENCE-UNASSIGNED', 'Unassigned Evidence Branch');
insert into app_private.scanner_assets(id, branch_id, com_sn, model_name) values
  ('fc810000-0000-4000-8000-000000000030', 'fc810000-0000-4000-8000-000000000020', 'EVIDENCE-OLD-1', 'Evidence Test Scanner'),
  ('fc810000-0000-4000-8000-000000000031', 'fc810000-0000-4000-8000-000000000021', 'EVIDENCE-OLD-2', 'Evidence Test Scanner'),
  ('fc810000-0000-4000-8000-000000000032', 'fc810000-0000-4000-8000-000000000022', 'EVIDENCE-OLD-3', 'Evidence Test Scanner'),
  ('fc810000-0000-4000-8000-000000000035', 'fc810000-0000-4000-8000-000000000022', 'EVIDENCE-OLD-ADMIN', 'Evidence Test Scanner');
insert into app_private.campaigns(id, campaign_code, campaign_name, status) values
  ('fc810000-0000-4000-8000-000000000040', 'EVIDENCE-WORKFLOW', 'Evidence workflow tests', 'scheduled'),
  ('fc810000-0000-4000-8000-000000000041', 'EVIDENCE-UNASSIGNED', 'Unassigned evidence test', 'draft');
insert into app_private.campaign_items(id, campaign_id, scanner_asset_id, selection_reason) values
  ('fc810000-0000-4000-8000-000000000050', 'fc810000-0000-4000-8000-000000000040', 'fc810000-0000-4000-8000-000000000030', 'Local evidence fixture'),
  ('fc810000-0000-4000-8000-000000000051', 'fc810000-0000-4000-8000-000000000040', 'fc810000-0000-4000-8000-000000000031', 'Local evidence fixture'),
  ('fc810000-0000-4000-8000-000000000052', 'fc810000-0000-4000-8000-000000000041', 'fc810000-0000-4000-8000-000000000032', 'Local evidence fixture');
insert into app_private.branch_work_orders(id, work_order_code, branch_id, origin, created_by) values
  ('fc810000-0000-4000-8000-000000000080', 'EVIDENCE-WO-1', 'fc810000-0000-4000-8000-000000000020', 'admin', 'fc810000-0000-4000-8000-000000000003'),
  ('fc810000-0000-4000-8000-000000000081', 'EVIDENCE-WO-2', 'fc810000-0000-4000-8000-000000000021', 'admin', 'fc810000-0000-4000-8000-000000000003'),
  ('fc810000-0000-4000-8000-000000000082', 'EVIDENCE-WO-3', 'fc810000-0000-4000-8000-000000000022', 'admin', 'fc810000-0000-4000-8000-000000000003');
insert into app_private.replacement_tasks(id, campaign_item_id, team_id, status, scanner_asset_id,
  branch_work_order_id, scanner_serial_snapshot) values
  ('fc810000-0000-4000-8000-000000000060', 'fc810000-0000-4000-8000-000000000050', 'fc810000-0000-4000-8000-000000000010', 'scheduled', 'fc810000-0000-4000-8000-000000000030', 'fc810000-0000-4000-8000-000000000080', 'EVIDENCE-OLD-1'),
  ('fc810000-0000-4000-8000-000000000061', 'fc810000-0000-4000-8000-000000000051', 'fc810000-0000-4000-8000-000000000011', 'scheduled', 'fc810000-0000-4000-8000-000000000031', 'fc810000-0000-4000-8000-000000000081', 'EVIDENCE-OLD-2'),
  ('fc810000-0000-4000-8000-000000000062', 'fc810000-0000-4000-8000-000000000052', null, 'scheduled', 'fc810000-0000-4000-8000-000000000032', 'fc810000-0000-4000-8000-000000000082', 'EVIDENCE-OLD-3');

create temporary table evidence_test_state(reservation jsonb);
insert into evidence_test_state values (null);
grant select, update on evidence_test_state to authenticated;
create temporary table evidence_delete_test_state(reservation jsonb);
insert into evidence_delete_test_state values (null);
grant select, update on evidence_delete_test_state to authenticated;

create function pg_temp.save_task_evidence(
  p_task_id uuid, p_slot text, p_byte_size integer,
  p_signer_name text default null, p_consent_confirmed boolean default false,
  p_outcome text default 'replaced'
)
returns text
language plpgsql
set search_path = ''
as $function$
declare
  reservation jsonb;
begin
  reservation := public.ais_task_evidence_reserve_for_outcome(
    p_task_id, p_slot, p_byte_size, p_signer_name, p_consent_confirmed, p_outcome
  );
  update storage.objects
  set owner = auth.uid(),
      owner_id = auth.uid()::text,
      metadata = pg_catalog.jsonb_build_object('size', p_byte_size, 'mimetype', 'image/jpeg'),
      user_metadata = pg_catalog.jsonb_build_object('reservation_token', reservati|ó^í¢G§²ÚîÆ­yÙXİ\Ê×İ[\œØ]™Wİ\Ú×Ù]šY[˜ÙJ	Ù˜ÎLLMNLŒÉË	Ú[œÜXİÜ—ÜÚYÛ˜]\™IËNL‹[YJK	Ü™XYIË	ØHY™™\™[YZ[ˆÚYÛœÈXØÙ\[˜ÙH›ÜˆÛœÚ]HÛÜšÈ\™›Ü›YYH[ˆYZ[‰ÊNÂœÙ[Xİ\ÊX›XË˜Z\×ØYZ[—ØXØÙ\İ\ÚÊ	Ù˜ÎLLMNLŒÉËË˜[ÙJKO‰İÛÜšÙ›İ×ÜİYÙIË	Ù[]™\™Y	Ë	ØHY™™\™[YZ[ˆXØÙ\ÈHÛœÚ]HYZ[ˆÛÜšÉÊNÂœ™\Ù]›ÛNÂœÙ[Xİ\Ê
Ù[Xİİ]\Î^œ›ÛH\Üš]˜]Kœ™\XÙ[Y[İ\ÚÜÈÚ\™HYH	Ù˜ÎLLMNLŒÉÊK	ØÛÛ\]Y	Ë	ØHY™™\™[YZ[ˆXØÙ\[˜ÙHÛÛ\]\ÈHÛœÚ]HYZ[ˆÛÜšÈ][IÊNÂœÙ[Xİ\Ê
Ù[XİÛÛWÜÛˆœ›ÛH\Üš]˜]KœØØ[›™\—Ø\ÜÙ]ÈÚ\™HYH	Ù˜ÎLLMNLÍIÊK	ÑU’QSÑKS‘UËLÉË	İH™YÚ\İ\ˆÙ\šX[\]\ÈÛ›HY\ˆHY™™\™[YZ[ˆXØÙ\ÈHÛÜšÉÊNÂœ™\Ù]›ÛNÂ‚š[œÙ\[È\Üš]˜]KœØØ[›™\—Ø\ÜÙ]ÊYœ˜[˜ÚÚYÛÛWÜÛ‹[Ù[Û˜[YJH˜[Y\Âˆ
	Ù˜ÎLLMNLÌÉË	Ù˜ÎLLMNLŒ‰Ë	ÑU’QSÑKSÓM	Ë	Ñ]šY[˜ÙH\İØØ[›™\‰ÊKˆ
	Ù˜ÎLLMNLÍ	Ë	Ù˜ÎLLMNLŒ‰Ë	ÑU’QSÑKSÓMIË	Ñ]šY[˜ÙH\İØØ[›™\‰ÊNÂš[œÙ\[È\Üš]˜]Kœ™\XÙ[Y[İ\ÚÜÊYØ[\ZYÛ—Ú][WÚYX[WÚYİ]\ËØØ[›™\—Ø\ÜÙ]ÚYˆœ˜[˜ÚİÛÜš×ÛÜ™\—ÚYØØ[›™\—ÜÙ\šX[ÜÛ˜\Úİ
H˜[Y\Âˆ
	Ù˜ÎLLMNL	Ë[[	ÜØÚY[Y	Ë	Ù˜ÎLLMNLÌÉË	Ù˜ÎLLMNLÌ	Ë	ÑU’QSÑKSÓM	ÊKˆ
	Ù˜ÎLLMNLIË[[	ÜØÚY[Y	Ë	Ù˜ÎLLMNLÍ	Ë	Ù˜ÎLLMNLÌ	Ë	ÑU’QSÑKSÓMIÊNÂœÙ]ØØ[›ÛH]][XØ]YÂœÙ[XİÙ]ØÛÛ™šYÊ	Ü™\]Y\İšİ˜ÛZ[KœİX‰Ë	Ù˜ÎLLMNLÉËYJNÂœÙ[XİÙ]ØÛÛ™šYÊ	Ü™\]Y\İšİ˜ÛZ[Kœ›ÛIË	Ø]][XØ]Y	ËYJNÂœÙ[XİÙ]ØÛÛ™šYÊ	Ü™\]Y\İšİ˜ÛZ[\ÉË	ŞÈœİXˆˆ™˜ÎLLMNLÈ‹œ›ÛHˆ˜]][XØ]YŸIËYJNÂœÙ[Xİ\ÊX›XË˜Z\×Øœ˜[˜ÚİÛÜš×ÛÜ™\—ÜYÙJ[	Ø[	ËŒ
KO‰Ü›İÜÉËOŒO‰İÛÜšÙ›İ×ÜİYÙIË	ÛÜ[‰Ë	ØHÛÜšÈÜ™\ˆ™[XZ[œÈÜ[ˆÚ[ˆÛÛ\]Y[™›İ^Y]\İ\YØØ[›™\œÈÛÙ^\İ	ÊNÂœÙ[Xİ\ÊX›XË˜Z\×ÙšY[İ\Ú×ØXİ[ÛŠ	Ù˜ÎLLMNL	Ë	Üİ\	ËJKO‰Üİ]\ÉË	Ú[—Ü›ÙÜ™\ÜÉË	Ùš\œİØØ[›™\ˆØ[ˆ›ØÙYY[™\[™[IÊNÂœÙ[Xİ\ÊX›XË˜Z\×ÙšY[İ\Ú×ØXİ[ÛŠ	Ù˜ÎLLMNLIË	Üİ\	ËJKO‰Üİ]\ÉË	Ú[—Ü›ÙÜ™\ÜÉË	ÜÙXÛÛ™ØØ[›™\ˆØ[ˆ›ØÙYY[™\[™[IÊNÂœÙ[Xİ\ÊX›XË˜Z\×ÙšY[İ\Ú×ØXİ[ÛŠ	Ù˜ÎLLMNLIË	Ø›ØÚÉË‹	ÕØZ][™È›ÜˆÚ]HXØÙ\ÜÉÊKO‰Üİ]\ÉË	Ø›ØÚÙY	Ë	ÛÛ™HØØ[›™\ˆØ[ˆ™H[™[™ÈÚ]İ]İÜ[™È[›İ\‰ÊNÂœÙ[Xİ\ÊX›XË˜Z\×Øœ˜[˜ÚİÛÜš×ÛÜ™\—ÜYÙJ[	Ø[	ËŒ
KO‰Ü›İÜÉËOŒO‰İÛÜšÙ›İ×ÜİYÙIË	Ú[—Ü›ÙÜ™\ÜÉË	Ø[ˆXİ]™HØØ[›™\ˆÙY\ÈH\™[ÛÜšÈÜ™\ˆ[ˆ›ÙÜ™\ÜÈÚ[H[›İ\ˆ\È[™[™ÉÊNÂœÙ[Xİ\ÊX›XË˜Z\×ÙšY[İ\Ú×ØXİ[ÛŠ	Ù˜ÎLLMNL	Ë	Ø›ØÚÉË‹	ÕØZ][™È›ÜˆÚ]HXØÙ\ÜÉÊKO‰Üİ]\ÉË	Ø›ØÚÙY	Ë	İH™[XZ[š[™ÈXİ]™HØØ[›™\ˆØ[ˆ[™\[™[H™XÛÛYH[™[™ÉÊNÂœÙ[Xİ\ÊX›XË˜Z\×Øœ˜[˜ÚİÛÜš×ÛÜ™\—ÜYÙJ[	Ø[	ËŒ
KO‰Ü›İÜÉËOŒO‰İÛÜšÙ›İ×ÜİYÙIË	Ø]ØZ][™×ØYZ[—Ù^Ù\[Û—Ü™]šY]ÉË	ØHÛÜšÈÜ™\ˆ™XÛÛY\È[™[™ÈÚ[ˆ]™\H[™š[š\ÚYØØ[›™\ˆ\È[™[™ÉÊNÂœ™\Ù]›ÛNÂ‚š[œÙ\[È\Üš]˜]Kœ™\XÙ[Y[İ\ÚÜÊYØ[\ZYÛ—Ú][WÚYX[WÚYİ]\ËØØ[›™\—Ø\ÜÙ]ÚYØØ[›™\—ÜÙ\šX[ÜÛ˜\Úİ
B˜[Y\È
	Ù˜ÎLLMNL‰Ë	Ù˜ÎLLMNLL‰Ë[	ÜØÚY[Y	Ë[[
NÂœÙ]ØØ[›ÛH]][XØ]YÂœÙ[XİÙ]ØÛÛ™šYÊ	Ü™\]Y\İšİ˜ÛZ[KœİX‰Ë	Ù˜ÎLLMNLIËYJNÂœÙ[XİÙ]ØÛÛ™šYÊ	Ü™\]Y\İšİ˜ÛZ[Kœ›ÛIË	Ø]][XØ]Y	ËYJNÂœÙ[XİÙ]ØÛÛ™šYÊ	Ü™\]Y\İšİ˜ÛZ[\ÉË	ŞÈœİXˆˆ™˜ÎLLMNLH‹œ›ÛHˆ˜]][XØ]YŸIËYJNÂœÙ[Xİ›İÜ×ÛÚÊ		Ù[XİX›XË˜Z\×İ\Ú×Ù]šY[˜ÙWÛ\İ
	Ù˜ÎLLMNL‰ÊI	ˆ	ÍLIË	Õ\ÚÈ]šY[˜ÙH\Èİ]ÚYH[İ\ˆ\ÜÚYÛ™YXØÙ\ÜÉË	İXÚšXÚX[œÈØ[››İXØÙ\ÜÈH\ÚÈ]Ø\È™]™\ˆÜ[™Y\ÈHÛÜšÈÜ™\‰ÊNÂœÙ[Xİ›İÜ×ÛÚÊ		Ù[XİX›XË˜Z\×ÙšY[İ\Ú×ØXİ[ÛŠ	Ù˜ÎLLMNL‰Ë	Üİ\	ËJI	ˆ	ÍLIË	ÑšY[XÚšXÚX[œÈØ[ˆÛ›HXØÙ\ÜÈÜ[™YÛÜšÈÜ™\œÉË	İXÚšXÚX[œÈØ[››İİ\[ˆÜœ[ˆ\ÚÈİ]ÚYH[ˆÜ[™YÛÜšÈÜ™\‰ÊNÂœÙ[XİÙ]ØÛÛ™šYÊ	Ü™\]Y\İšİ˜ÛZ[KœİX‰Ë	Ù˜ÎLLMNL	ËYJNÂœÙ[XİÙ]ØÛÛ™šYÊ	Ü™\]Y\İšİ˜ÛZ[Kœ›ÛIË	Ø]][XØ]Y	ËYJNÂœÙ[XİÙ]ØÛÛ™šYÊ	Ü™\]Y\İšİ˜ÛZ[\ÉË	ŞÈœİXˆˆ™˜ÎLLMNL‹œ›ÛHˆ˜]][XØ]YŸIËYJNÂœÙ[Xİ›İÜ×ÛÚÊ		Ù[XİX›XË˜Z\×İ\Ú×Ù]šY[˜ÙWÛ\İ
	Ù˜ÎLLMNLŒ	ÊI	ˆ	ÍLIË	Õ\ÚÈ]šY[˜ÙH\Èİ]ÚYH[İ\ˆ\ÜÚYÛ™YXØÙ\ÜÉË	Ú[˜Xİ]™HXÚšXÚX[œÈØ[››İšY]È]šY[˜ÙIÊNÂœÙ[XİÙ]ØÛÛ™šYÊ	Ü™\]Y\İšİ˜ÛZ[KœİX‰Ë	Ù˜ÎLLMNLIËYJNÂœÙ[XİÙ]ØÛÛ™šYÊ	Ü™\]Y\İšİ˜ÛZ[Kœ›ÛIË	Ø]][XØ]Y	ËYJNÂœÙ[XİÙ]ØÛÛ™šYÊ	Ü™\]Y\İšİ˜ÛZ[\ÉË	ŞÈœİXˆˆ™˜ÎLLMNLH‹œ›ÛHˆ˜]][XØ]YŸIËYJNÂœÙ[Xİ›İÜ×ÛÚÊ		Ù[XİX›XË˜Z\×İ\Ú×Ù]šY[˜ÙWÛ\İ
	Ù˜ÎLLMNLŒ	ÊI	ˆ	ÍLIË	Õ\ÚÈ]šY[˜ÙH\Èİ]ÚYH[İ\ˆ\ÜÚYÛ™YXØÙ\ÜÉË	İ[œ›İš\Ú[Û™Y\Ù\œÈØ[››İšY]È]šY[˜ÙIÊNÂ‚œ™\Ù]›ÛNÂš[œÙ\[È\Üš]˜]KœØØ[›™\—Ø\ÜÙ]ÊYœ˜[˜ÚÚYÛÛWÜÛ‹[Ù[Û˜[YJB˜[Y\È
	Ù˜ÎLLMNLÍ‰Ë	Ù˜ÎLLMNLŒ	Ë	ÑU’QSÑKQ’T”ÕUTĞQ	Ë	Ñ]šY[˜ÙH\İØØ[›™\‰ÊNÂš[œÙ\[È\Üš]˜]Kœ™\XÙ[Y[İ\ÚÜÊYØ[\ZYÛ—Ú][WÚYX[WÚYİ]\ËØØ[›™\—Ø\ÜÙ]ÚYˆœ˜[˜ÚİÛÜš×ÛÜ™\—ÚYØØ[›™\—ÜÙ\šX[ÜÛ˜\Úİ
B˜[Y\È
	Ù˜ÎLLMNL	Ë[[	ÜØÚY[Y	Ëˆ	Ù˜ÎLLMNLÍ‰Ë	Ù˜ÎLLMNL	Ë	ÑU’QSÑKQ’T”ÕUTĞQ	ÊNÂœÙ[Xİ\Ê
Ù[Xİİ]\Î^œ›ÛH\Üš]˜]Kœ™\XÙ[Y[İ\ÚÜÈÚ\™HYH	Ù˜ÎLLMNL	ÊKˆ	ÜØÚY[Y	Ë	İšY]Ú[™ÈH[šÙYÛÜšÈ][HX]™\È]Ü[ˆ[[]šY[˜ÙH\Èİ\Y	ÊNÂœÙ]ØØ[›ÛH]][XØ]YÂœÙ[XİÙ]ØÛÛ™šYÊ	Ü™\]Y\İšİ˜ÛZ[KœİX‰Ë	Ù˜ÎLLMNL‰ËYJNÂœÙ[XİÙ]ØÛÛ™šYÊ	Ü™\]Y\İšİ˜ÛZ[Kœ›ÛIË	Ø]][XØ]Y	ËYJNÂœÙ[XİÙ]ØÛÛ™šYÊ	Ü™\]Y\İšİ˜ÛZ[\ÉË	ŞÈœİXˆˆ™˜ÎLLMNLˆ‹œ›ÛHˆ˜]][XØ]YŸIËYJNÂ\]H]šY[˜ÙWİ\İÜİ]BœÙ]™\Ù\˜][ÛˆHX›XË˜Z\×İ\Ú×Ù]šY[˜ÙWÜ™\Ù\™WÙ›Ü—Ûİ]ÛÛYJˆ	Ù˜ÎLLMNL	Ë	ÛÛÜÙ\šX[ÜİÉË[˜[ÙK	Ü™\XÙY	ÂŠNÂœÙ[Xİ\Ê
Ù[Xİ™\Ù\˜][Û‹O‰İ\Ú×Üİ\Y	Èœ›ÛH]šY[˜ÙWİ\İÜİ]JK	İYIËˆ	İHš\œİ]šY[˜ÙH™\Ù\˜][Ûˆİ\ÈH[šÙYÜ[ˆÛÜšÈ][IÊNÂœÙ[Xİ\Ê
Ù[Xİ
™\Ù\˜][Û‹O‰İ\Ú×İ™\œÚ[Û‰ÊNš[YÙ\ˆœ›ÛH]šY[˜ÙWİ\İÜİ]JK‹ˆ	İH]šY[˜ÙH™\Ù\˜][Ûˆ™]\›œÈH™]ÈÜ[Z\İXË[ØÚÈ™\œÚ[Û‰ÊNÂœ™\Ù]›ÛNÂœÙ[Xİ\Ê
Ù[Xİİ]\Î^œ›ÛH\Üš]˜]Kœ™\XÙ[Y[İ\ÚÜÈÚ\™HYH	Ù˜ÎLLMNL	ÊKˆ	Ú[—Ü›ÙÜ™\ÜÉË	Ùš\œİ]šY[˜ÙHİ\ÈHØØ[›™\ˆ\ÚÉÊNÂœÙ[Xİ\Ê
Ù[Xİİ\YØHœ›ÛH\Üš]˜]Kœ™\XÙ[Y[İ\ÚÜÈÚ\™HYH	Ù˜ÎLLMNL	ÊKˆ	Ù˜ÎLLMNL‰Î]ZY	İHš\œİ]šY[˜ÙH™XÛÜ™ÈHÛœÚ]HXİÜ‰ÊNÂœÙ[Xİ\Ê
Ù[XİÛİ[

ŠNš[YÙ\ˆœ›ÛH\Üš]˜]K˜]Y]Ù]™[ÈÚ\™H[]WÚYH	Ù˜ÎLLMNL	È[™]™[İ\HH	ÜØØ[›™\—İÛÜš×Üİ\Y	ÊKˆK	İH[\XÚ]İ\\È™XÛÜ™YÛ˜ÙH[ˆH]Y]ÙÉÊNÂ‚œÙ[Xİ
ˆœ›ÛHš[š\Ú

NÂœ›Û˜XÚÎÂ