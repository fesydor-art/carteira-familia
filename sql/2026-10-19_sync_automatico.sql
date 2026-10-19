-- Atualização automática dos bancos: 3x por dia (6h, 12h e 18h de Brasília), para todos da família.
-- O agendador (pg_cron) chama a função "pluggy" com a ação "cron" e um token que só o servidor conhece.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- configuração privada: RLS ligado e sem políticas = só o servidor (service role) lê
create table if not exists public.app_config (k text primary key, v text not null);
alter table public.app_config enable row level security;
insert into public.app_config (k, v)
values ('cron_token', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
on conflict (k) do nothing;

-- (re)cria o agendamento — horários em UTC: 9h, 15h e 21h = 6h, 12h e 18h em Brasília
select cron.unschedule(jobid) from cron.job where jobname = 'sync-bancos';
select cron.schedule('sync-bancos', '0 9,15,21 * * *', $job$
  select net.http_post(
    url := 'https://wzfdhbbdevuvfzowvthg.supabase.co/functions/v1/pluggy',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- chave pública (anon) do app: só para passar pela porta da função; quem autoriza é o x-cron-token
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind6ZmRoYmJkZXZ1dmZ6b3d2dGhnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5Nzk5NjcsImV4cCI6MjEwNzU1NTk2N30.6eVQkm6H0HXgn4htu2PkJGYGNMLnSKY6JJt6ik_dElw',
      'x-cron-token', (select v from public.app_config where k = 'cron_token')
    ),
    body := '{"acao":"cron"}'::jsonb,
    timeout_milliseconds := 150000
  );
$job$);
