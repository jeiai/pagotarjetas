-- Run once in the SQL Editor of a dedicated Supabase project.
-- Re-running this script preserves all existing application data.
begin;

create table if not exists public.tarjetas_state (
  id integer primary key check (id = 1),
  revision bigint not null default 0 check (revision >= 0),
  document jsonb not null
);

alter table public.tarjetas_state enable row level security;
revoke all on public.tarjetas_state from public, anon, authenticated;
grant select, update on public.tarjetas_state to service_role;

insert into public.tarjetas_state (id, document)
values (1, '{"users":[],"sessions":{},"cards":[],"statements":[],"passwordResets":[]}'::jsonb)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tarjetas-documentos', 'tarjetas-documentos', false, 12582912,
        array['image/png', 'image/jpeg', 'application/pdf'])
on conflict (id) do nothing;

-- The app authenticates users itself and proxies downloads from its server.
-- Do not add anon/authenticated policies or make this bucket public.
commit;
