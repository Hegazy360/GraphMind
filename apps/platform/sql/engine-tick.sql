-- The Circuit engine's heartbeat on graphmind.ai: every minute, Supabase calls
-- the platform's internal tick so approval timeouts and sleeping runs advance
-- even when nobody is using the dashboard. Requests made by users already kick
-- the engine; this is the backstop.
--
-- Run ONCE as the `postgres` role: only it may use the cron and vault schemas.
-- The app's own role (graphmind_app, the one in Vercel's POSTGRES_URL) cannot,
-- by design, so use the pooler URI with user `postgres.<project-ref>`:
--   psql "postgresql://postgres.<project-ref>@<pooler-host>:5432/postgres?sslmode=require" -f apps/platform/sql/engine-tick.sql
-- and type the postgres password at the prompt. Safe to re-run: it replaces the job.
--
-- The bearer token is read from Supabase Vault (secret `cron_secret`) each time
-- the job runs, so it never appears in this file, in cron.job, or in logs.
-- It must equal the CRON_SECRET environment variable of the Vercel project.

do $$
begin
  if current_user <> 'postgres' then
    raise exception 'run this file as the postgres role (pooler user postgres.<project-ref>), not as %', current_user;
  end if;
end $$;

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'cron_secret') then
    raise exception 'Vault secret "cron_secret" is missing: add it under Integrations -> Vault first';
  end if;
end $$;

select cron.unschedule(jobid) from cron.job where jobname = 'graphmind-tick';

select cron.schedule(
  'graphmind-tick',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://graphmind.ai/api/internal/tick',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  )
  $$
);

-- Verify (shows the schedule, never the token):
--   select jobname, schedule, active from cron.job where jobname = 'graphmind-tick';
-- After a few minutes:
--   select status, return_message, start_time from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'graphmind-tick') order by start_time desc limit 5;
--   select status_code, created from net._http_response order by created desc limit 5;
