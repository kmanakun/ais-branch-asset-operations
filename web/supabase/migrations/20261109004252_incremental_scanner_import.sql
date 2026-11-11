-- Requires operational write role guard migration 20261108173705.
alter table app_private.import_batches
  add column import_mode text not null default 'bootstrap' check (import_mode in ('bootstrap', 'incremental')),
  add column result_counts jsonb;

-- Reuse the existing validated staging pipeline; only an existing serial is allowed
-- for incremental imports. No source rows are retained after a commit.
create function public.ais_incremental_import_stage(p_source_name text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb; batch uuid; v_issue_count integer; issues jsonb; actor_role app_private.app_role;
begin
  select role into actor_role from app_private.user_access where user_id=auth.uid() and is_active;
  if auth.uid() is null or actor_role is distinct from 'data_manager' then
    raise exception 'Data Manager access required' using errcode='42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'Import must contain between 1 and 5000 rows' using errcode='22023';
  end if;
  if jsonb_array_length(p_rows) not between 1 and 5000 or octet_length(p_rows::text) > 8388608 then
    raise exception 'Import payload is empty or exceeds limits' using errcode='22023';
  end if;
  if jsonb_typeof(p_rows) = 'array' then
    select coalesce(jsonb_agg(case when jsonb_typeof(item) = 'object' and item ? 'com_sn'
      then jsonb_set(item, '{com_sn}', coalesce(to_jsonb(regexp_replace(item->>'com_sn', '^[[:space:]]+|[[:space:]]+$', '', 'g')), 'null'::jsonb))
      else item end order by ordinality), '[]'::jsonb) into p_rows
    from jsonb_array_elements(p_rows) with ordinality as rows(item, ordinality);
  end if;
  result := public.ais_import_stage(p_source_name, p_rows);
  batch := (result->>'batch_id')::uuid;
  update app_private.import_batches set import_mode = 'incremental' where id = batch;
  delete from app_private.import_row_issues where batch_id = batch and issue_code = 'serial_exists';
  insert into app_private.import_row_issues(batch_id,row_number,field_name,issue_code,message)
  select batch,s.row_number,'branch','branch_not_found','à¹„à¸¡à¹ˆà¸à¸šà¸ªà¸²à¸‚à¸²à¹ƒà¸™à¸—à¸°à¹€à¸šà¸µà¸¢à¸™' from app_private.import_staging_rows s
  where s.batch_id=batch and s.normalized_data->>'location_code' is not null and s.normalized_data->>'loc_bld' is not null
    and not exists (select 1 from app_private.branches br where br.location_code=s.normalized_data->>'location_code'
      and lower(regexp_replace(btrim(br.loc_bld),'[[:space:]]+',' ','g'))=lower(regexp_replace(btrim(s.normalized_data->>'loc_bld'),'[[:space:]]+',' ','g')));
  insert into app_private.import_row_issues(batch_id,row_number,field_name,issue_code,message)
  select batch,s.row_number,'com_sn','ambiguous_serial','Serial à¸à¸³à¸à¸§à¸¡à¹ƒà¸™à¸—à¸°à¹€à¸šà¸µà¸¢à¸™' from app_private.import_staging_rows s
  join app_private.scanner_assets a on regexp_replace(a.com_sn, '^[[:space:]]+|[[:space:]]+$', '', 'g')=s.normalized_data->>'com_sn' where s.batch_id=batch
  group by s.row_number having count(*)>1;
  insert into app_private.import_row_issues(batch_id,row_number,field_name,issue_code,message)
  select batch,s.row_number,'branch','serial_branch_conflict','Serial à¸­à¸¢à¸¹à¹ˆà¸„à¸™à¸¥à¸°à¸ªà¸²à¸‚à¸²à¸à¸±à¸šà¸—à¸°à¹€à¸šà¸µà¸¢à¸™' from app_private.import_staging_rows s
  join app_private.scanner_assets a on regexp_replace(a.com_sn, '^[[:space:]]+|[[:space:]]+$', '', 'g')=s.normalized_data->>'com_sn'
  join app_private.branches br on br.id=a.branch_id where s.batch_id=batch and
    (br.location_code <> s.normalized_data->>'location_code' or
     lower(regexp_replace(btrim(br.loc_bld),'[[:space:]]+',' ','g')) <> lower(regexp_replace(btrim(s.normalized_data->>'loc_bld'),'[[:space:]]+',' ','g')));
  select count(*) into v_issue_count from app_private.import_row_issues where batch_id = batch;
  update app_private.import_batches b set issue_count = v_issue_count where id = batch;
  select coalesce(jsonb_agg(jsonb_build_object('row_number', i.row_number, 'field', i.field_name,
    'code', i.issue_code, 'message', i.message) order by i.row_number, i.field_name), '[]'::jsonb)
    into issues from (select * from app_private.import_row_issues where batch_id = batch order by row_number, field_name limit 100) i;
  return result || jsonb_build_object('issue_count', v_issue_count, 'issues_truncated', v_issue_count > 100, 'issues', issues);
end $$;

create function public.ais_incremental_import_commit(p_batch_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid(); actor_role app_private.app_role; b app_private.import_batches%rowtype;
  inserted_branches integer; inserted_assets integer; updated_assets integer; counts jsonb;
begin
  select role into actor_role from app_private.user_access where user_id = actor and is_active;
  if actor is null or actor_role is distinct from 'data_manager' then
    raise exception 'Data Manager access required' using errcode = '42501';
  end if;
  select * into b from app_private.import_batches where id = p_batch_id and uploaded_by = actor and import_mode = 'incremental' for update;
  if not found then raise exception 'Import batch is unavailable' using errcode = '22023'; end if;
  if b.status = 'committed' then
    return jsonb_build_object('batch_id', b.id, 'status', 'committed') || coalesce(b.result_counts, '{}'::jsonb);
  end if;
  if b.status <> 'staged' or b.expires_at <= now() then raise exception 'Import batch is unavailable or expired' using errcode = '22023'; end if;
  if exists(select 1 from app_private.import_row_issues where batch_id=b.id)
     or (select count(*) from app_private.import_staging_rows where batch_id=b.id) <> b.row_count then
    raise exception 'Resolve all import validation issues before commit' using errcode = '22023';
  end if;

  -- Serialize with concurrent direct or RPC writes until validation and write finish.
  lock table app_private.branches, app_private.scanner_assets in share row exclusive mode;
  if exists (
    select 1 from app_private.import_staging_rows s
    join app_private.scanner_assets a on regexp_replace(a.com_sn, '^[[:space:]]+|[[:space:]]+$', '', 'g') = s.normalized_data->>'com_sn'
    where s.batch_id=b.id group by s.id having count(*) > 1
  ) then raise exception 'Ambiguous serial in existing register' using errcode = '22023'; end if;
  if exists (
    select 1 from app_private.import_staging_rows s
    join app_private.scanner_assets a on regexp_replace(a.com_sn, '^[[:space:]]+|[[:space:]]+$', '', 'g') = s.normalized_data->>'com_sn'
    join app_private.branches br on br.id=a.branch_id
    where s.batch_id=b.id and (br.location_code <> s.normalized_data->>'location_code'
      or lower(regexp_replace(btrim(br.loc_bld), '[[:space:]]+', ' ', 'g')) <>
         lower(regexp_replace(btrim(s.normalized_data->>'loc_bld'), '[[:space:]]+', ' ', 'g')))
  ) then raise exception 'Serial belongs to a conflicting branch' using errcode = '22023'; end if;
  if exists (
    select 1 from app_private.import_staging_rows s where s.batch_id=b.id and not exists (
      select 1 from app_private.branches br where br.location_code=s.normalized_data->>'location_code' and
       lower(regexp_replace(btrim(br.loc_bld),'[[:space:]]+',' ','g'))=lower(regexp_replace(btrim(s.normalized_data->>'loc_byß«h‘éì¶»§q«^vRç66ææW%ö76WG26W@Ğ¢‡uöæÖSÖ6öÆW66R‡2ææ÷&ÖÆ—¦VEöFFÓãâv‡uöæÖRrÆæ‡uöæÖR’Â'&æCÖ6öÆW66R‡2ææ÷&ÖÆ—¦VEöFFÓãâv'&æBrÆæ'&æB’ÀĞ¢ÖöFVÅöæÖSÖ6öÆW66R‡2ææ÷&ÖÆ—¦VEöFFÓãâvÖöFVÅöæÖRrÆæÖöFVÅöæÖR’Â6öÕö–CÖ6öÆW66R‡2ææ÷&ÖÆ—¦VEöFFÓãâv6öÕö–BrÆæ6öÕö–B’ÀĞ¢ÖöFVÅö–CÖ6öÆW66R‡2ææ÷&ÖÆ—¦VEöFFÓãâvÖöFVÅö–BrÆæÖöFVÅö–B’Â6öÕ÷–V'3Ö6öÆW66R‡2ææ÷&ÖÆ—¦VEöFFÓãâv6öÕ÷–V'2rÆæ6öÕ÷–V'2’ÂWFFVEöCÖæ÷r‚Ğ¢g&öÒ÷&—fFRæ–×÷'E÷7Fv–æu÷&÷w22v†W&R2æ&F6…ö–CÖ"æ–BæB&VvW‡÷&WÆ6R†æ6öÕ÷6âÂuåµ³§76S¥ÕÒ·Åµ³§76S¥ÕÒ²BrÂrrÂvrr“×2ææ÷&ÖÆ—¦VEöFFÓãâv6öÕ÷6âs°Ğ¢vWBF–væ÷7F–72WFFVEö76WG2Ò&÷uö6÷VçC°Ğ¢–ç6W'B–çFò÷&—fFRç66ææW%ö76WG2†'&æ6…ö–BÆ‡uöæÖRÆ'&æBÆÖöFVÅöæÖRÆ6öÕö–BÆ6öÕ÷6âÆÖöFVÅö–BÆ6öÕ÷–V'2Ğ¢6VÆV7B'"æ–BÆBÓãâv‡uöæÖRrÆBÓãâv'&æBrÆBÓãâvÖöFVÅöæÖRrÆBÓãâv6öÕö–BrÆBÓãâv6öÕ÷6ârÆBÓãâvÖöFVÅö–BrÆBÓãâv6öÕ÷–V'2pĞ¢g&öÒ÷&—fFRæ–×÷'E÷7Fv–æu÷&÷w227&÷72¦ö–âÆFW&Â‡6VÆV7B2ææ÷&ÖÆ—¦VEöFFB’€Ğ¢¦ö–â÷&—fFRæ'&æ6†W2'"öâ'"æÆö6F–öåö6öFSÖBÓãâvÆö6F–öåö6öFRræ@Ğ¢Æ÷vW"‡&VvW‡÷&WÆ6R†'G&–Ò†'"æÆö5ö&ÆB’Âuµ³§76S¥ÕÒ²rÂrrÂvrr’“ÖÆ÷vW"‡&VvW‡÷&WÆ6R†'G&–Ò†BÓãâvÆö5ö&ÆBr’Âuµ³§76S¥ÕÒ²rÂrrÂvrr’Ğ¢v†W&R2æ&F6…ö–CÖ"æ–BæBæ÷BW†—7G2‡6VÆV7Bg&öÒ÷&—fFRç66ææW%ö76WG2v†W&R&VvW‡÷&WÆ6R†æ6öÕ÷6âÂuåµ³§76S¥ÕÒ·Åµ³§76S¥ÕÒ²BrÂrrÂvrr“ÖBÓãâv6öÕ÷6âr“°Ğ¢vWBF–væ÷7F–72–ç6W'FVEö76WG2Ò&÷uö6÷VçC°Ğ¢6÷VçG2£Ò§6öæ%ö'V–ÆEöö&¦V7B‚v'&æ6†W2rÆ–ç6W'FVEö'&æ6†W2Âv–ç6W'FVBrÆ–ç6W'FVEö76WG2ÂwWFFVBrÇWFFVEö76WG2“°Ğ¢WFFR÷&—fFRæ–×÷'Eö&F6†W26WB7FGW3Òv6öÖÖ—GFVBrÂ6öÖÖ—GFVEöCÖæ÷r‚’ÂW‡—&W5öCÖæ÷r‚’Â&W7VÇEö6÷VçG3Ö6÷VçG2v†W&R–CÖ"æ–C°Ğ¢–ç6W'B–çFò÷&—fFRæVF—EöWfVçG2†7F÷%ö–BÆWfVçE÷G—RÆVçF—G•÷G—RÆVçF—G•ö–BÇ7VÖÖ'’Ğ¢fÇVW2†7F÷"Âv–æ7&VÖVçFÅ÷66ææW%ö–×÷'Eö6öÖÖ—GFVBrÂv–×÷'Eö&F6‚rÆ"æ–BÆ6÷VçG2“°Ğ¢FVÆWFRg&öÒ÷&—fFRæ–×÷'E÷&÷uö—77VW2v†W&R&F6…ö–CÖ"æ–C°Ğ¢FVÆWFRg&öÒ÷&—fFRæ–×÷'E÷7Fv–æu÷&÷w2v†W&R&F6…ö–CÖ"æ–C°Ğ¢&WGW&â§6öæ%ö'V–ÆEöö&¦V7B‚v&F6…ö–BrÆ"æ–BÂw7FGW2rÂv6öÖÖ—GFVBr’ÇÂ6÷VçG3°Ğ¦VæBBC°Ğ Ğ¦7&VFRgVæ7F–öâV&Æ–2æ—5ö–×÷'Eö†—7F÷'’‡öÆ–Ö—B–çFVvW"FVfVÇBSĞ§&WGW&ç2§6öæ"ÆæwVvRÇw7Â7F&ÆR6V7W&—G’FVf–æW"6WB6V&6…÷F‚Òrr2B@Ğ¦FV6Æ&R7F÷"WV–B£ÒWF‚çV–B‚“²7F÷%÷&öÆR÷&—fFRæ÷&öÆS²&W7VÇB§6öæ#°Ğ¦&Vv–àĞ¢6VÆV7B&öÆR–çFò7F÷%÷&öÆRg&öÒ÷&—fFRçW6W%ö66W72v†W&RW6W%ö–CÖ7F÷"æB—5ö7F—fS°Ğ¢–b7F÷"—2çVÆÂ÷"7F÷%÷&öÆR—2F—7F–æ7Bg&öÒvFFöÖævW"rF†VàĞ¢&—6RW†6WF–öâtFFÖævW"66W72&WV—&VBrW6–ærW'&6öFRÒsC#Ss°Ğ¢VæB–c°Ğ¢6VÆV7B6öÆW66R†§6öæ%övr‡Fõö§6öæ"‡‚’÷&FW"'’‚æ7&VFVEöBFW62Â‚æ–BFW62’ÂuµÒs£¦§6öæ"’–çFò&W7VÇBg&öÒ€Ğ¢6VÆV7B–BÂ–×÷'EöÖöFRÂ7FGW2Â&÷uö6÷VçBÂ—77VUö6÷VçBÂ7&VFVEöBÂ6öÖÖ—GFVEöBÂ&W7VÇEö6÷VçG0Ğ¢g&öÒ÷&—fFRæ–×÷'Eö&F6†W2÷&FW"'’7&VFVEöBFW62Æ–BFW62Æ–Ö—Bw&VFW7BƒÆÆV7B†6öÆW66R‡öÆ–Ö—BÃS’Ã’Ğ¢’ƒ°Ğ¢&WGW&â&W7VÇC°Ğ¦VæBBC°Ğ§&Wfö¶RÆÂöâgVæ7F–öâV&Æ–2æ—5ö–æ7&VÖVçFÅö–×÷'E÷7FvR‡FW‡BÆ§6öæ"’g&öÒV&Æ–2Âæöã°Ğ§&Wfö¶RÆÂöâgVæ7F–öâV&Æ–2æ—5ö–æ7&VÖVçFÅö–×÷'Eö6öÖÖ—B‡WV–B’g&öÒV&Æ–2Âæöã°Ğ§&Wfö¶RÆÂöâgVæ7F–öâV&Æ–2æ—5ö–×÷'Eö†—7F÷'’†–çFVvW"’g&öÒV&Æ–2Âæöã°Ğ¦w&çBW†V7WFRöâgVæ7F–öâV&Æ–2æ—5ö–æ7&VÖVçFÅö–×÷'E÷7FvR‡FW‡BÆ§6öæ"’FòWF†VçF–6FVC°Ğ¦w&çBW†V7WFRöâgVæ7F–öâV&Æ–2æ—5ö–æ7&VÖVçFÅö–×÷'Eö6öÖÖ—B‡WV–B’FòWF†VçF–6FVC°Ğ¦w&çBW†V7WFRöâgVæ7F–öâV&Æ–2æ—5ö–×÷'Eö†—7F÷'’†–çFVvW"’FòWF†VçF–6FVC°Ğ Ğ¢ÒÒ&ö÷G7G&6öÖÖ—B×W7BæWfW"6öç7VÖRâ–æ7&VÖVçFÂ&F6‚àĞ¦7&VFR÷"&WÆ6RgVæ7F–öâV&Æ–2æ—5ö–×÷'Eö6öÖÖ—B‡ö&F6…ö–BWV–BĞ§&WGW&ç2§6öæ Ğ¦ÆæwVvRÇw7ÀĞ§6V7W&—G’FVf–æW Ğ§6WB6V&6…÷F‚ÒrpĞ¦2B@Ğ¦FV6Æ&PĞ¢7F÷"WV–B£ÒWF‚çV–B‚“°Ğ¢7F÷%÷&öÆR÷&—fFRæ÷&öÆS°Ğ¢eö&F6‚÷&—fFRæ–×÷'Eö&F6†W2W&÷wG—S°Ğ¢–ç6W'FVEö'&æ6†W2–çFVvW#°Ğ¢–ç6W'FVEö76WG2–çFVvW#°Ğ¦&Vv–àĞ¢6VÆV7BVç&öÆR–çFò7F÷%÷&öÆPĞ¢g&öÒ÷&—fFRçW6W%ö66W72VĞ¢v†W&RVçW6W%ö–BÒ7F÷"æBVæ—5ö7F—fS°Ğ¢–b7F÷"—2çVÆÂ÷"7F÷%÷&öÆR—2F—7F–æ7Bg&öÒvFFöÖævW"rF†VàĞ¢&—6RW†6WF–öâtFFÖævW"66W72&WV—&VBrW6–ærW'&6öFRÒsC#Ss°Ğ¢VæB–c°Ğ¢6VÆV7B¢–çFòeö&F6€Ğ¢g&öÒ÷&—fFRæ–×÷'Eö&F6†W2 Ğ¢v†W&R"æ–BÒö&F6…ö–BæB"çWÆöFVEö'’Ò7F÷ Ğ¢f÷"WFFS°Ğ¢–bæ÷Bf÷VæB÷"eö&F6‚æ–×÷'EöÖöFRÃâv&ö÷G7G&r÷"eö&F6‚ç7FGW2Ãâw7FvVBr÷"eö&F6‚æW‡—&W5öBÃÒæ÷r‚’F†VàĞ¢&—6RW†6WF–öât–×÷'B&F6‚—2Væf–Æ&ÆR÷"W‡—&VBrW6–ærW'&6öFRÒs###2s°Ğ¢VæB–c°Ğ¢–bW†—7G2‡6VÆV7Bg&öÒ÷&—fFRæ–×÷'E÷&÷uö—77VW2—77VRv†W&R—77VRæ&F6…ö–BÒeö&F6‚æ–B’F†VàĞ¢&—6RW†6WF–öâu&W6öÇfRÆÂ–×÷'BfÆ–FF–öâ—77VW2&Vf÷&R6öÖÖ—BrW6–ærW'&6öFRÒs###2s°Ğ¢VæB–c°Ğ¢–bW†—7G2‡6VÆV7Bg&öÒ÷&—fFRæ'&æ6†W2’÷"W†—7G2‡6VÆV7Bg&öÒ÷&—fFRç66ææW%ö76WG2’F†VàĞ¢&—6RW†6WF–öât–æ—F–Âv÷&¶&öö²–×÷'B—2ÆÆ÷vVBöæÇ’v†Vâ'&æ6‚æB66ææW"&Vv—7FW'2&RV×G’rW6–ærW'&6öFRÒsSSs°Ğ¢VæB–c°Ğ¢–b‡6VÆV7B6÷VçB‚¢’g&öÒ÷&—fFRæ–×÷'E÷7Fv–æu÷&÷w27FvVBv†W&R7FvVBæ&F6…ö–BÒeö&F6‚æ–B’Ãâeö&F6‚ç&÷uö6÷VçBF†VàĞ¢&—6RW†6WF–öâu7FvVB&÷r6÷VçBFöW2æ÷BÖF6‚F†R&F6‚rW6–ærW'&6öFRÒs###2s°Ğ¢VæB–c°Ğ Ğ¢–ç6W'B–çFò÷&—fFRæ'&æ6†W2€Ğ¢Æö6F–öåö6öFRÂ7V'5÷¦âÂÆö5ö&ÆBÂFG&W72Â&÷f–æ6RÂF—7G&–7BÀĞ¢7V&F—7G&–7BÂ÷7FÅö6öFRÂ&òÂ†–v…öÆWfVÅöÆö6F–öàĞ¢Ğ¢6VÆV7BF—7F–æ7Böâ€Ğ¢FFÓãâvÆö6F–öåö6öFRrÀĞ¢Æ÷vW"‡&VvW‡÷&WÆ6R†'G&–Ò†FFÓãâvÆö5ö&ÆBr’Âuµ³§76S¥ÕÒ²rÂrrÂvrr’Ğ¢Ğ¢FFÓãâvÆö6F–öåö6öFRrÂFFÓãâw7V'5÷¦ârÂFFÓãâvÆö5ö&ÆBrÂFFÓãâvFG&W72rÀĞ¢FFÓãâw&÷f–æ6RrÂFFÓãâvF—7G&–7BrÂFFÓãâw7V&F—7G&–7BrÂFFÓãâw÷7FÅö6öFRrÀĞ¢FFÓãâw&òrÂFFÓãâv†–v…öÆWfVÅöÆö6F–öâpĞ¢g&öÒ÷&—fFRæ–×÷'E÷7Fv–æu÷&÷w0Ğ¢7&÷72¦ö–âÆFW&Â‡6VÆV7Bæ÷&ÖÆ—¦VEöFF2FF’&÷uöFFĞ¢v†W&R÷&—fFRæ–×÷'E÷7Fv–æu÷&÷w2æ&F6…ö–BÒeö&F6‚æ–@Ğ¢÷&FW"'’FFÓãâvÆö6F–öåö6öFRrÂÆ÷vW"‡&VvW‡÷&WÆ6R†'G&–Ò†FFÓãâvÆö5ö&ÆBr’Âuµ³§76S¥ÕÒ²rÂrrÂvrr’’Â&÷uöçVÖ&W#°Ğ¢vWBF–væ÷7F–72–ç6W'FVEö'&æ6†W2Ò&÷uö6÷VçC°Ğ Ğ¢–ç6W'B–çFò÷&—fFRç66ææW%ö76WG2€Ğ¢'&æ6…ö–BÂ‡uöæÖRÂ'&æBÂÖöFVÅöæÖRÂ6öÕö–BÂ6öÕ÷6âÂÖöFVÅö–BÂ6öÕ÷–V'0Ğ¢Ğ¢6VÆV7B'&æ6‚æ–BÂFFÓãâv‡uöæÖRrÂFFÓãâv'&æBrÂFFÓãâvÖöFVÅöæÖRrÀĞ¢FFÓãâv6öÕö–BrÂFFÓãâv6öÕ÷6ârÂFFÓãâvÖöFVÅö–BrÂFFÓãâv6öÕ÷–V'2pĞ¢g&öÒ÷&—fFRæ–×÷'E÷7Fv–æu÷&÷w27FvV@Ğ¢7&÷72¦ö–âÆFW&Â‡6VÆV7B7FvVBææ÷&ÖÆ—¦VEöFF2FF’&÷uöFFĞ¢¦ö–â÷&—fFRæ'&æ6†W2'&æ6€Ğ¢öâ'&æ6‚æÆö6F–öåö6öFRÒFFÓãâvÆö6F–öåö6öFRpĞ¢æBÆ÷vW"‡&VvW‡÷&WÆ6R†'G&–Ò†'&æ6‚æÆö5ö&ÆB’Âuµ³§76S¥ÕÒ²rÂrrÂvrr’Ğ¢ÒÆ÷vW"‡&VvW‡÷&WÆ6R†'G&–Ò†FFÓãâvÆö5ö&ÆBr’Âuµ³§76S¥ÕÒ²rÂrrÂvrr’Ğ¢v†W&R7FvVBæ&F6…ö–BÒeö&F6‚æ–@Ğ¢÷&FW"'’7FvVBç&÷uöçVÖ&W#°Ğ¢vWBF–væ÷7F–72–ç6W'FVEö76WG2Ò&÷uö6÷VçC°Ğ Ğ¢WFFR÷&—fFRæ–×÷'Eö&F6†W0Ğ¢6WB7FGW2Òv6öÖÖ—GFVBrÂ6öÖÖ—GFVEöBÒæ÷r‚’ÂW‡—&W5öBÒæ÷r‚Ğ¢v†W&R–BÒeö&F6‚æ–C°Ğ¢–ç6W'B–çFò÷&—fFRæVF—EöWfVçG2†7F÷%ö–BÂWfVçE÷G—RÂVçF—G•÷G—RÂVçF—G•ö–BÂ7VÖÖ'’Ğ¢fÇVW2†7F÷"Âv'&æ6…÷66ææW%ö–×÷'Eö6öÖÖ—GFVBrÂv–×÷'Eö&F6‚rÂeö&F6‚æ–BÀĞ¢§6öæ%ö'V–ÆEöö&¦V7B‚v'&æ6†W2rÂ–ç6W'FVEö'&æ6†W2Âw66ææW'2rÂ–ç6W'FVEö76WG2Âw6÷W&6UöæÖRrÂeö&F6‚ç6÷W&6UöæÖR’“°Ğ¢FVÆWFRg&öÒ÷&—fFRæ–×÷'E÷&÷uö—77VW2v†W&R&F6…ö–BÒeö&F6‚æ–C°Ğ¢FVÆWFRg&öÒ÷&—fFRæ–×÷'E÷7Fv–æu÷&÷w2v†W&R&F6…ö–BÒeö&F6‚æ–C°Ğ¢&WGW&â§6öæ%ö'V–ÆEöö&¦V7B‚v&F6…ö–BrÂeö&F6‚æ–BÂw7FGW2rÂv6öÖÖ—GFVBrÀĞ¢v'&æ6†W2rÂ–ç6W'FVEö'&æ6†W2Âw66ææW'2rÂ–ç6W'FVEö76WG2“°Ğ¦Væ@Ğ¢BC°Ğ Ğ