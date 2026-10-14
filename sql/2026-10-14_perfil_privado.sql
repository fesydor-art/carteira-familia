-- Perfis privados: um perfil marcado como privado (ex.: IPTV) só aparece para quem criou.
-- Tudo que estiver nesse perfil (contas, cartões, lançamentos, rendas, gastos fixos) fica invisível para os outros membros.

alter table public.grupos add column if not exists privado boolean not null default false;
alter table public.grupos add column if not exists dono_id uuid references auth.users(id) on delete set null;

create or replace function public.pode_ver_grupo(gid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select gid is null or not exists (
    select 1 from public.grupos g where g.id = gid and g.privado and g.dono_id is distinct from auth.uid()
  )
$$;
revoke execute on function public.pode_ver_grupo(uuid) from anon, public;
grant execute on function public.pode_ver_grupo(uuid) to authenticated;

drop policy if exists "familia_all" on public.grupos;
drop policy if exists "grupos_ver" on public.grupos;
drop policy if exists "grupos_criar" on public.grupos;
drop policy if exists "grupos_editar" on public.grupos;
drop policy if exists "grupos_apagar" on public.grupos;
create policy "grupos_ver" on public.grupos for select to authenticated
  using (familia_id in (select public.minhas_familias()) and (not privado or dono_id = auth.uid()));
create policy "grupos_criar" on public.grupos for insert to authenticated
  with check (familia_id in (select public.minhas_familias()) and (not privado or dono_id = auth.uid()));
create policy "grupos_editar" on public.grupos for update to authenticated
  using (familia_id in (select public.minhas_familias()) and (not privado or dono_id = auth.uid()))
  with check (familia_id in (select public.minhas_familias()) and (not privado or dono_id = auth.uid()));
create policy "grupos_apagar" on public.grupos for delete to authenticated
  using (familia_id in (select public.minhas_familias()) and (not privado or dono_id = auth.uid()));

do $$ declare t text; begin
  foreach t in array array['contas','cartoes','lancamentos','rendas','despesas_fixas'] loop
    execute format('drop policy if exists "familia_all" on public.%I', t);
    execute format('create policy "familia_all" on public.%I for all to authenticated
      using (familia_id in (select public.minhas_familias()) and public.pode_ver_grupo(grupo_id))
      with check (familia_id in (select public.minhas_familias()) and public.pode_ver_grupo(grupo_id))', t);
  end loop;
end $$;
