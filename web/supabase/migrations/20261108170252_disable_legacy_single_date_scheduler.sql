revoke all on function public.ais_schedule_campaign(uuid, uuid, date)
from public, anon, authenticated;

comment on function public.ais_schedule_campaign(uuid, uuid, date) is
  'Legacy single-team scheduling is disabled for API roles. Active scheduling must use ais_schedule_campaign_by_branch so each selected branch receives its own reviewed team/date assignment.';
