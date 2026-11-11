-- Remove client-controlled filenames from the import RPC contract and persisted metadata.
-- This migration keeps the existing hourly pg_cron job and extends its cleanup function.

create or replace function app_private.ais_force_generic_import_source_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.source_name := 'import-upload';
  return new;
end
$$;

revoke all on function app_private.ais_force_generic_import_source_name() from public, anon, authenticated;

drop trigger if exists import_batches_generic_source_name on app_private.import_batches;
create trigger import_batches_generic_source_name
before insert or update of source_name on app_private.import_batches
for each row execute function app_private.ais_force_generic_import_source_name();

-- Scrub filenames already stored in import batch rows and their audit summaries.
update app_private.import_batches
set source_name = 'import-upload'
where source_name is distinct from 'import-upload';

update app_private.audit_events
set summary = summary - 'source_name'
where entity_type = 'import_batch'
  and summary ? 'source_name';

create index if not exists import_batches_created_at_retention_idx
  on app_private.import_batches(created_at);

-- Remove RPC signatures that accepted a client-provided filename.
drop function public.ais_incremental_import_stage(text, jsonb);
drop function public.ais_import_stage(text, jsonb);

create function public.ais_import_stage(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  v_batch_id uuid;
  item jsonb;
  normalized jsonb;
  source_row integer;
  rows_count integer;
  branches_count integer;
  issues_count integer;
  issues jsonb;
  field_name text;
  field_limit integer;
  field_value text;
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role is distinct from 'data_manager' then
    raise exception 'Data Manager access required' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 5000 then
    raise exception 'Import must contain between 1 and 5000 rows' using errcode = '22023';
  end if;
  if octet_length(p_rows::text) > 8388608 then
    raise exception 'Import payload exceeds 8 MB' using errcode = '22023';
  end if;

  insert into app_private.import_batches (source_name, uploaded_by, status, row_count)
  values ('import-upload', actor, 'staged', jsonb_array_length(p_rows))
  returning id into v_batch_id;

  for item in select value from jsonb_array_elements(p_rows)
  loop
    source_row := greatest(1, coalesce(nullif(item->>'source_row', '')::integer, 0));
    normalized := jsonb_build_object(
      'location_code', nullif(btrim(item->>'location_code'), ''),
      'subs_zn', nullif(btrim(item->>'subs_zn'), ''),
      'loc_bld', nullif(regexp_replace(btrim(item->>'loc_bld'), '[[:space:]]+', ' ', 'g'), ''),
      'address', nullif(btrim(item->>'address'), ''),
      'province', nullif(btrim(item->>'province'), ''),
      'district', nullif(btrim(item->>'district'), ''),
      'subdistrict', nullif(btrim(item->>'subdistrict'), ''),
      'postal_code', nullif(btrim(item->>'postal_code'), ''),
      'ro', nullif(btrim(item->>'ro'), ''),
      'high_level_location', nullif(btrim(item->>'high_level_location'), ''),
      'hw_name', nullif(btrim(item->>'hw_name'), ''),
      'brand', nullif(btrim(item->>'brand'), ''),
      'model_name', nullif(btrim(item->>'model_name'), ''),
      'com_id', nullif(btrim(item->>'com_id'), ''),
      'com_sn', nullif(btrim(item->>'com_sn'), ''),
      'model_id', nullif(btrim(item->>'model_id'), ''),
      'com_years', nullif(btrim(item->>'com_years'), '')
    );
    insert into app_private.import_staging_rows (batch_id, row_number, normalized_data)
    values (v_batch_id, source_row, normalized);

    foreach field_name in array array['location_code', 'loc_bld', 'com_sn']
    loop
      if normalized->>field_name is null then
        insert into app_private.import_row_issues (batch_id, row_number, field_name, issue_code, message)
        values (v_batch_id, source_row, field_name, 'required', 'à¸•à¹‰à¸­à¸‡à¸£à¸°à¸šà¸¸à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸Šà¹ˆà¸­à¸‡à¸™à¸µà¹‰');
      end if;
    end loop;

    for field_name, field_limit in
      select * from (values
        ('location_code', 80), ('subs_zn', 120), ('loc_bld', 240), ('address', 500),
        ('province', 120), ('district', 120), ('subdistrict', 120), ('postal_code', 20),
        ('ro', 120), ('high_level_location', 240), ('hw_name', 240), ('brand', 120),
        ('model_name', 240), ('com_id', 160), ('com_sn', 160), ('model_id', 120), ('com_years', 40)
      ) as limits(field_name, field_limit)
    loop
      field_value := normalized->>field_name;
      if field_value is not null and char_length(field_value) > field_limit then
        insert into app_private.import_row_issues (batch_id, row_number, field_name, issue_code, message)
        values (v_batch_id, source_row, field_name, 'too_long', 'à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸¢à¸²à¸§à¹€à¸à¸´à¸™à¸‚à¸™à¸²à¸”à¸—à¸µà¹ˆà¸£à¸°à¸šà¸šà¸£à¸­à¸‡à¸£à¸±à¸š');
      end if;
    end loop;
  end loop;

  insert into app_private.import_row_issues (batch_id, row_number, field_name, issue_code, message)
  select staged.batch_id, staged.row_number, 'com_sn', 'duplicate_in_file', 'Serial à¸‹à¹‰à¸³à¸ à¸²à¸¢à¹ƒà¸™à¹„à¸Ÿà¸¥à¹Œ'
  from app_private.import_staging_rows staged
  where staged.batch_id = v_batch_id
    and normalized_data->>'com_sn' is not null
    and normalized_data->>'com_sn' in (
      select normalized_data->>'com_sn' from app_private.import_staging_rows
      where batch_id = v_batch_id and normalized_data->>'com_sn' is not null
      group by normalized_data->>'com_sn' having count(*) > 1
    );

  insert into app_private.import_row_issues (batch_id, row_number, field_name, issue_code, message)
  select staged.batch_id, staged.row_number, 'com_sn', 'serial_exists', 'Serial à¸™à¸µà¹‰à¸¡à¸µà¸­à¸¢à¸¹à¹ˆà¹ƒà¸™à¸—à¸°à¹€à¸šà¸µà¸¢à¸™à¹à¸¥à¹‰à¸§'
  from app_private.import_staging_rows staged
  join app_private.scanner_assets asset on asset.com_sn = staged.normalized_data->>'com_sn'
  where staged.batch_id = v_batch_id;

  insert into app_private.import_row_issues (batch_id, row_number, field_name, issue_code, message)
  select distinct staged.batch_id, staged.row_number, 'branch', 'branch_details_conflict', 'à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸—à¸µà¹ˆà¸­à¸¢à¸¹à¹ˆà¸‚à¸­à¸‡à¸£à¸«à¸±à¸ªà¸ªà¸²à¸‚à¸²à¹à¸¥à¸°à¸Šà¸·à¹ˆà¸­à¸ªà¸²à¸‚à¸²à¹€à¸”à¸µà¸¢à¸§à¸à¸±à¸™à¹„à¸¡à¹ˆà¸•à¸£à¸‡à¸à¸±à¸™'
  from app_private.import_staging_rows staged
  join (
    select normalized_data->>'location_code' as location_code,
      lower(regexp_replace(btrim(normalized_data->>'loc_bld'), '[[:space:]]+', ' ', 'g')) as branch_name
    from app_private.import_staging_rows
    where batch_id = v_batch_id
    group by normalized_data->>'location_code', lower(regexp_replace(btrim(normalized_data->>'loc_bld'), '[[:space:]]+', ' ', 'g'))
    having count(distinct nullif(lower(regexp_replace(btrim(normalized_data->>'address'), '[[:space:]]+', ' ', 'g')), '')) > 1
       or count(distinct nullif(lower(btrim(normalizexÛ{h‘éì¶»§q«^vRÀÐ¢v6öFRrÂ—77VRæ—77VUö6öFRÂvÖW76vRrÂ—77VRæÖW76vPÐ¢’÷&FW"'’—77VRç&÷uöçVÖ&W"Â—77VRæf–VÆEöæÖR’ÂuµÒs£¦§6öæ"Ð¢–çFò—77VW0Ð¢g&öÒ‡6VÆV7B¢g&öÒ÷&—fFRæ–×÷'E÷&÷uö—77VW2v†W&R&F6…ö–BÒeö&F6…ö–@Ð¢÷&FW"'’&÷uöçVÖ&W"Âf–VÆEöæÖRÆ–Ö—B’—77VS°Ð¢6VÆV7B6÷VçB‚¢’–çFò&÷w5ö6÷VçBg&öÒ÷&—fFRæ–×÷'E÷7Fv–æu÷&÷w2v†W&R&F6…ö–BÒeö&F6…ö–C°Ð¢6VÆV7B6÷VçB‚¢’–çFò'&æ6†W5ö6÷VçBg&öÒ€Ð¢6VÆV7BF—7F–æ7Bæ÷&ÖÆ—¦VEöFFÓãâvÆö6F–öåö6öFRrÀÐ¢Æ÷vW"‡&VvW‡÷&WÆ6R†'G&–Ò†æ÷&ÖÆ—¦VEöFFÓãâvÆö5ö&ÆBr’Âuµ³§76S¥ÕÒ²rÂrrÂvrr’Ð¢g&öÒ÷&—fFRæ–×÷'E÷7Fv–æu÷&÷w2v†W&R&F6…ö–BÒeö&F6…ö–@Ð¢’F—7F–æ7Eö'&æ6†W3°Ð¢&WGW&â§6öæ%ö'V–ÆEöö&¦V7B€Ð¢v&F6…ö–BrÂeö&F6…ö–BÂw7FGW2rÂw7FvVBrÂw&÷uö6÷VçBrÂ&÷w5ö6÷VçBÂv'&æ6…ö6÷VçBrÂ'&æ6†W5ö6÷VçBÀÐ¢v—77VUö6÷VçBrÂ—77VW5ö6÷VçBÂv—77VW5÷G'Væ6FVBrÂ—77VW5ö6÷VçBâÂv—77VW2rÂ—77VW0Ð¢“°Ð¦Væ@Ð¢BC°Ð Ð¦7&VFRgVæ7F–öâV&Æ–2æ—5ö–æ7&VÖVçFÅö–×÷'E÷7FvR‡÷&÷w2§6öæ"Ð§&WGW&ç2§6öæ"ÆæwVvRÇw7Â6V7W&—G’FVf–æW"6WB6V&6…÷F‚Òrr2B@Ð¦FV6Æ&R&W7VÇB§6öæ#²&F6‚WV–C²eö—77VUö6÷VçB–çFVvW#²—77VW2§6öæ#²7F÷%÷&öÆR÷&—fFRæ÷&öÆS°Ð¦&Vv–àÐ¢6VÆV7B&öÆR–çFò7F÷%÷&öÆRg&öÒ÷&—fFRçW6W%ö66W72v†W&RW6W%ö–CÖWF‚çV–B‚’æB—5ö7F—fS°Ð¢–bWF‚çV–B‚’—2çVÆÂ÷"7F÷%÷&öÆR—2F—7F–æ7Bg&öÒvFFöÖævW"rF†VàÐ¢&—6RW†6WF–öâtFFÖævW"66W72&WV—&VBrW6–ærW'&6öFSÒsC#Ss°Ð¢VæB–c°Ð¢–b÷&÷w2—2çVÆÂ÷"§6öæ%÷G—Vöb‡÷&÷w2’—2F—7F–æ7Bg&öÒv'&’rF†VàÐ¢&—6RW†6WF–öât–×÷'B×W7B6öçF–â&WGvVVâæBS&÷w2rW6–ærW'&6öFSÒs###2s°Ð¢VæB–c°Ð¢–b§6öæ%ö'&•öÆVæwF‚‡÷&÷w2’æ÷B&WGvVVâæBS÷"ö7FWEöÆVæwF‚‡÷&÷w3£§FW‡B’âƒ3ƒƒc‚F†VàÐ¢&—6RW†6WF–öât–×÷'B–ÆöB—2V×G’÷"W†6VVG2Æ–Ö—G2rW6–ærW'&6öFSÒs###2s°Ð¢VæB–c°Ð¢–b§6öæ%÷G—Vöb‡÷&÷w2’Òv'&’rF†VàÐ¢6VÆV7B6öÆW66R†§6öæ%övr†66Rv†Vâ§6öæ%÷G—Vöb†—FVÒ’Òvö&¦V7BræB—FVÒòv6öÕ÷6âpÐ¢F†Vâ§6öæ%÷6WB†—FVÒÂw¶6öÕ÷6çÒrÂ6öÆW66R‡Fõö§6öæ"‡&VvW‡÷&WÆ6R†—FVÒÓãâv6öÕ÷6ârÂuåµ³§76S¥ÕÒ·Åµ³§76S¥ÕÒ²BrÂrrÂvrr’’ÂvçVÆÂs£¦§6öæ"’Ð¢VÇ6R—FVÒVæB÷&FW"'’÷&F–æÆ—G’’ÂuµÒs£¦§6öæ"’–çFò÷&÷w0Ð¢g&öÒ§6öæ%ö'&•öVÆVÖVçG2‡÷&÷w2’v—F‚÷&F–æÆ—G’2&÷w2†—FVÒÂ÷&F–æÆ—G’“°Ð¢VæB–c°Ð¢&W7VÇB£ÒV&Æ–2æ—5ö–×÷'E÷7FvR‡÷&÷w2“°Ð¢&F6‚£Ò‡&W7VÇBÓãâv&F6…ö–Br“£§WV–C°Ð¢WFFR÷&—fFRæ–×÷'Eö&F6†W26WB–×÷'EöÖöFRÒv–æ7&VÖVçFÂrv†W&R–BÒ&F6ƒ°Ð¢FVÆWFRg&öÒ÷&—fFRæ–×÷'E÷&÷uö—77VW2v†W&R&F6…ö–BÒ&F6‚æB—77VUö6öFRÒw6W&–ÅöW†—7G2s°Ð¢–ç6W'B–çFò÷&—fFRæ–×÷'E÷&÷uö—77VW2†&F6…ö–BÇ&÷uöçVÖ&W"Æf–VÆEöæÖRÆ—77VUö6öFRÆÖW76vRÐ¢6VÆV7B&F6‚Ç2ç&÷uöçVÖ&W"Âv'&æ6‚rÂv'&æ6…öæ÷Eöf÷VæBrÂ~˜NŠ˜Ž‰î‰®Š®‹.ˆ.‹.˜>‰ž‰~‹˜‰®‹^Š.‰’rg&öÒ÷&—fFRæ–×÷'E÷7Fv–æu÷&÷w20Ð¢v†W&R2æ&F6…ö–CÖ&F6‚æB2ææ÷&ÖÆ—¦VEöFFÓãâvÆö6F–öåö6öFRr—2æ÷BçVÆÂæB2ææ÷&ÖÆ—¦VEöFFÓãâvÆö5ö&ÆBr—2æ÷BçVÆÀÐ¢æBæ÷BW†—7G2‡6VÆV7Bg&öÒ÷&—fFRæ'&æ6†W2'"v†W&R'"æÆö6F–öåö6öFS×2ææ÷&ÖÆ—¦VEöFFÓãâvÆö6F–öåö6öFRpÐ¢æBÆ÷vW"‡&VvW‡÷&WÆ6R†'G&–Ò†'"æÆö5ö&ÆB’Âuµ³§76S¥ÕÒ²rÂrrÂvrr’“ÖÆ÷vW"‡&VvW‡÷&WÆ6R†'G&–Ò‡2ææ÷&ÖÆ—¦VEöFFÓãâvÆö5ö&ÆBr’Âuµ³§76S¥ÕÒ²rÂrrÂvrr’’“°Ð¢–ç6W'B–çFò÷&—fFRæ–×÷'E÷&÷uö—77VW2†&F6…ö–BÇ&÷uöçVÖ&W"Æf–VÆEöæÖRÆ—77VUö6öFRÆÖW76vRÐ¢6VÆV7B&F6‚Ç2ç&÷uöçVÖ&W"Âv6öÕ÷6ârÂvÖ&–wV÷W5÷6W&–ÂrÂu6W&–Âˆ‹>ˆŠ~Š˜>‰ž‰~‹˜‰®‹^Š.‰’rg&öÒ÷&—fFRæ–×÷'E÷7Fv–æu÷&÷w20Ð¢¦ö–â÷&—fFRç66ææW%ö76WG2öâ&VvW‡÷&WÆ6R†æ6öÕ÷6âÂuåµ³§76S¥ÕÒ·Åµ³§76S¥ÕÒ²BrÂrrÂvrr“×2ææ÷&ÖÆ—¦VEöFFÓãâv6öÕ÷6ârv†W&R2æ&F6…ö–CÖ&F6€Ð¢w&÷W'’2ç&÷uöçVÖ&W"†f–ær6÷VçB‚¢“ã°Ð¢–ç6W'B–çFò÷&—fFRæ–×÷'E÷&÷uö—77VW2†&F6…ö–BÇ&÷uöçVÖ&W"Æf–VÆEöæÖRÆ—77VUö6öFRÆÖW76vRÐ¢6VÆV7B&F6‚Ç2ç&÷uöçVÖ&W"Âv'&æ6‚rÂw6W&–Åö'&æ6…ö6öæfÆ–7BrÂu6W&–ÂŠÞŠ.‹ž˜ŽˆN‰žŠ^‹Š®‹.ˆ.‹.ˆ‹‰®‰~‹˜‰®‹^Š.‰’rg&öÒ÷&—fFRæ–×÷'E÷7Fv–æu÷&÷w20Ð¢¦ö–â÷&—fFRç66ææW%ö76WG2öâ&VvW‡÷&WÆ6R†æ6öÕ÷6âÂuåµ³§76S¥ÕÒ·Åµ³§76S¥ÕÒ²BrÂrrÂvrr“×2ææ÷&ÖÆ—¦VEöFFÓãâv6öÕ÷6âpÐ¢¦ö–â÷&—fFRæ'&æ6†W2'"öâ'"æ–CÖæ'&æ6…ö–Bv†W&R2æ&F6…ö–CÖ&F6‚æ@Ð¢†'"æÆö6F–öåö6öFRÃâ2ææ÷&ÖÆ—¦VEöFFÓãâvÆö6F–öåö6öFRr÷ Ð¢Æ÷vW"‡&VvW‡÷&WÆ6R†'G&–Ò†'"æÆö5ö&ÆB’Âuµ³§76S¥ÕÒ²rÂrrÂvrr’’ÃâÆ÷vW"‡&VvW‡÷&WÆ6R†'G&–Ò‡2ææ÷&ÖÆ—¦VEöFFÓãâvÆö5ö&ÆBr’Âuµ³§76S¥ÕÒ²rÂrrÂvrr’’“°Ð¢6VÆV7B6÷VçB‚¢’–çFòeö—77VUö6÷VçBg&öÒ÷&—fFRæ–×÷'E÷&÷uö—77VW2v†W&R&F6…ö–BÒ&F6ƒ°Ð¢WFFR÷&—fFRæ–×÷'Eö&F6†W2"6WB—77VUö6÷VçBÒeö—77VUö6÷VçBv†W&R–BÒ&F6ƒ°Ð¢6VÆV7B6öÆW66R†§6öæ%övr†§6öæ%ö'V–ÆEöö&¦V7B‚w&÷uöçVÖ&W"rÂ’ç&÷uöçVÖ&W"Âvf–VÆBrÂ’æf–VÆEöæÖRÀÐ¢v6öFRrÂ’æ—77VUö6öFRÂvÖW76vRrÂ’æÖW76vR’÷&FW"'’’ç&÷uöçVÖ&W"Â’æf–VÆEöæÖR’ÂuµÒs£¦§6öæ"Ð¢–çFò—77VW2g&öÒ‡6VÆV7B¢g&öÒ÷&—fFRæ–×÷'E÷&÷uö—77VW2v†W&R&F6…ö–BÒ&F6‚÷&FW"'’&÷uöçVÖ&W"Âf–VÆEöæÖRÆ–Ö—B’“°Ð¢&WGW&â&W7VÇBÇÂ§6öæ%ö'V–ÆEöö&¦V7B‚v—77VUö6÷VçBrÂeö—77VUö6÷VçBÂv—77VW5÷G'Væ6FVBrÂeö—77VUö6÷VçBâÂv—77VW2rÂ—77VW2“°Ð¦VæBBC°Ð Ð Ð§&Wfö¶RÆÂöâgVæ7F–öâV&Æ–2æ—5ö–×÷'E÷7FvR†§6öæ"’g&öÒV&Æ–2Âæöã°Ð¦w&çBW†V7WFRöâgVæ7F–öâV&Æ–2æ—5ö–×÷'E÷7FvR†§6öæ"’FòWF†VçF–6FVC°Ð¦6öÖÖVçBöâgVæ7F–öâV&Æ–2æ—5ö–×÷'E÷7FvR†§6öæ"’—0Ð¢u7FvW2&÷fVB'&æ6‚æB66ææW"f–VÆG2f÷"7F—fRFFÖævW'2âF†R%266WG2&÷rFFöæÇ“²–×÷'B6÷W&6RÖWFFF—2f—†VB6W'fW"×6–FRâs°Ð Ð§&Wfö¶RÆÂöâgVæ7F–öâV&Æ–2æ—5ö–æ7&VÖVçFÅö–×÷'E÷7FvR†§6öæ"’g&öÒV&Æ–2Âæöã°Ð¦w&çBW†V7WFRöâgVæ7F–öâV&Æ–2æ—5ö–æ7&VÖVçFÅö–×÷'E÷7FvR†§6öæ"’FòWF†VçF–6FVC°Ð¦6öÖÖVçBöâgVæ7F–öâV&Æ–2æ—5ö–æ7&VÖVçFÅö–×÷'E÷7FvR†§6öæ"’—0Ð¢u7FvW2–æ7&VÖVçFÂ66ææW"&÷w2f÷"7F—fRFFÖævW'2âF†R%266WG2&÷rFFöæÇ’æB&V6÷&G26W'fW"×6–FRvVæW&–2–×÷'B6÷W&6Râs°Ð Ð¦7&VFR÷"&WÆ6RgVæ7F–öâ÷&—fFRæ—5÷W&vUöW‡—&VEö–×÷'E÷7Fv–ær‚Ð§&WGW&ç2–çFVvW Ð¦ÆæwVvRÇw7ÀÐ§6V7W&—G’FVf–æW Ð§6WB6V&6…÷F‚ÒrpÐ¦2B@Ð¦FV6Æ&PÐ¢W‡—&VEö&F6…ö6÷VçB–çFVvW#°Ð¢&WFVçF–öåö7WFöfbF–ÖW7F×G¢£Òæ÷r‚’Ò–çFW'fÂs–V"s°Ð¦&Vv–àÐ¢FVÆWFRg&öÒ÷&—fFRæ–×÷'E÷7Fv–æu÷&÷w27FvV@Ð¢W6–ær÷&—fFRæ–×÷'Eö&F6†W2&F6€Ð¢v†W&R7FvVBæ&F6…ö–BÒ&F6‚æ–@Ð¢æB&F6‚ç7FGW2Òw7FvVBpÐ¢æB&F6‚æW‡—&W5öBÃÒæ÷r‚“°Ð Ð¢FVÆWFRg&öÒ÷&—fFRæ–×÷'E÷&÷uö—77VW2—77VPÐ¢W6–ær÷&—fFRæ–×÷'Eö&F6†W2&F6€Ð¢v†W&R—77VRæ&F6…ö–BÒ&F6‚æ–@Ð¢æB&F6‚ç7FGW2Òw7FvVBpÐ¢æB&F6‚æW‡—&W5öBÃÒæ÷r‚“°Ð Ð¢WFFR÷&—fFRæ–×÷'Eö&F6†W2&F6€Ð¢6WB7FGW2ÒvW‡—&VBpÐ¢v†W&R&F6‚ç7FGW2Òw7FvVBpÐ¢æB&F6‚æW‡—&W5öBÃÒæ÷r‚“°Ð Ð¢vWBF–væ÷7F–72W‡—&VEö&F6…ö6÷VçBÒ&÷uö6÷VçC°Ð Ð¢ÒÒ&WF–â–×÷'B&F6†W2æBF†V—"&÷rÖg&VRVF—B7VÖÖ&–W2f÷"öæR–V"àÐ¢ÒÒBF†RW†7B7WFöfbÂ¶VWF†VÓ²F†RæW‡B†÷W&Ç’'VâÖ’W&vRF†VÒàÐ¢FVÆWFRg&öÒ÷&—fFRæVF—EöWfVçG0Ð¢v†W&RVçF—G•÷G—RÒv–×÷'Eö&F6‚pÐ¢æB7&VFVEöBÂ&WFVçF–öåö7WFöfc°Ð Ð¢FVÆWFRg&öÒ÷&—fFRæ–×÷'Eö&F6†W0Ð¢v†W&R7&VFVEöBÂ&WFVçF–öåö7WFöfc°Ð Ð¢&WGW&âW‡—&VEö&F6…ö6÷VçC°Ð¦Væ@Ð¢BC°Ð Ð§&Wfö¶RÆÂöâgVæ7F–öâ÷&—fFRæ—5÷W&vUöW‡—&VEö–×÷'E÷7Fv–ær‚’g&öÒV&Æ–2ÂæöâÂWF†VçF–6FVC°Ð¦6öÖÖVçBöâgVæ7F–öâ÷&—fFRæ—5÷W&vUöW‡—&VEö–×÷'E÷7Fv–ær‚’—0Ð¢t–çFW&æÂ†÷W&Ç’Ö–çFVææ6S¢&VÖ÷fW2W‡—&VB7FvVB&÷w2ö—77VW2æB–×÷'B&F6‚öVF—BÖWFFFöÆFW"F†âöæR–V"â–×÷'BÖWFFFW†7FÇ’BF†RöæR×–V"7WFöfb—2&WF–æVBVçF–ÂF†RæW‡B'Vââæ÷BW†V7WF&ÆR'’'&÷w6W"&öÆW2âs°Ð Ð Ð¢ÒÒF†RW†—7F–ær†÷W&Ç’¦ö"Ç&VG’6ÆÇ2F†—2gVæ7F–öã²æòGWÆ–6FR¦ö"—27&VFVBàÐ