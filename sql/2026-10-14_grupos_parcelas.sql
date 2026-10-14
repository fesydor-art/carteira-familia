-- 1) Grupo em contas e cartões
alter table public.contas  add column if not exists grupo_id uuid references public.grupos(id) on delete set null;
alter table public.cartoes add column if not exists grupo_id uuid references public.grupos(id) on delete set null;

-- 2) Parcelas nos lançamentos
alter table public.lancamentos add column if not exists compra_id uuid;
alter table public.lancamentos add column if not exists parcela_num int;
alter table public.lancamentos add column if not exists parcela_total int;
create index if not exists lancamentos_compra_idx on public.lancamentos(compra_id);

-- 3) Views: saldo só conta lançamentos até hoje (parcelas futuras não descontam antes da hora)
drop view if exists public.v_contas;
drop view if exists public.v_cartoes;
create view public.v_contas with (security_invoker = true) as
select c.*,
  i.nome as instituicao, i.cor1 as inst_cor1, i.cor2 as inst_cor2,
  m.nome as titular,
  case when c.origem = 'pluggy' and c.saldo_api is not null then c.saldo_api
       else c.saldo_inicial + coalesce((select sum(case when l.tipo='receita' then l.valor else -l.valor end)
                                         from public.lancamentos l where l.conta_id = c.id and l.data <= current_date),0)
  end as saldo
from public.contas c
left join public.instituicoes i on i.id = c.instituicao_id
left join public.membros m on m.user_id = c.titular_id and m.familia_id = c.familia_id;

create view public.v_cartoes with (security_invoker = true) as
select c.*,
  i.nome as instituicao,
  coalesce(c.cor1, i.cor1) as cor_a, coalesce(c.cor2, i.cor2) as cor_b,
  m.nome as titular,
  coalesce(c.limite_disponivel, c.limite_total - c.fatura_atual
    - coalesce((select sum(l.valor) from public.lancamentos l
                where l.cartao_id = c.id and l.tipo = 'despesa' and l.data > current_date and l.origem = 'manual'),0)) as disponivel
from public.cartoes c
left join public.instituicoes i on i.id = c.instituicao_id
left join public.membros m on m.user_id = c.titular_id and m.familia_id = c.familia_id;

-- 4) Qualquer membro da família pode editar o nome dos usuários
drop policy if exists "membros_update_self" on public.membros;
drop policy if exists "membros_update_familia" on public.membros;
create policy "membros_update_familia" on public.membros for update to authenticated
  using (familia_id in (select public.minhas_familias()))
  with check (familia_id in (select public.minhas_familias()));

-- 5) Grupos padrão das novas famílias: Pessoal, Casal, Aluguéis, Investimentos
create or replace function public.criar_familia(p_nome_familia text, p_meu_nome text)
returns uuid language plpgsql security definer set search_path = public as $$
declare fid uuid;
begin
  if auth.uid() is null then raise exception 'não autenticado'; end if;
  insert into familias(nome) values (p_nome_familia) returning id into fid;
  insert into membros(familia_id,user_id,nome) values (fid, auth.uid(), p_meu_nome);
  insert into grupos(familia_id,nome,icone,cor) values
    (fid,'Casal','heart','#ec4899'),
    (fid,'Aluguéis','building-2','#f59e0b'),(fid,'Investimentos','trending-up','#10b981');
  insert into categorias(familia_id,nome,icone) values
    (fid,'Alimentação','utensils'),(fid,'Mercado','shopping-cart'),(fid,'Transporte','car'),(fid,'Moradia','house'),
    (fid,'Saúde','pill'),(fid,'Lazer','party-popper'),(fid,'Educação','graduation-cap'),(fid,'Contas fixas','lightbulb'),
    (fid,'Aluguel recebido','key-round'),(fid,'Salário','briefcase'),(fid,'Rendimentos','chart-line'),(fid,'Compras','shopping-bag'),(fid,'Outros','tag');
  insert into instituicoes(familia_id,nome,cor1,cor2) values
    (fid,'Nubank','#8a05be','#4a0072'),(fid,'C6 Bank','#2b2b2b','#000000'),
    (fid,'Bradesco','#cc092f','#7a0019'),(fid,'Banco do Brasil','#f7d117','#1c3f94'),
    (fid,'Caixa','#0070af','#f39200'),(fid,'Banco BV','#1a3d8f','#00a3e0'),
    (fid,'Havan','#0b3d91','#e30613'),(fid,'Dinheiro','#15803d','#064e3b');
  return fid;
end $$;

-- 6) Perfil: nome completo e foto
alter table public.membros add column if not exists nome_completo text;
alter table public.membros add column if not exists avatar_url text;

insert into storage.buckets (id, name, public) values ('avatars','avatars', true) on conflict (id) do nothing;
drop policy if exists "avatars_ler" on storage.objects;
drop policy if exists "avatars_enviar" on storage.objects;
drop policy if exists "avatars_atualizar" on storage.objects;
drop policy if exists "avatars_apagar" on storage.objects;
create policy "avatars_ler" on storage.objects for select using (bucket_id = 'avatars');
create policy "avatars_enviar" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatars_atualizar" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatars_apagar" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- 7) Ícones: troca emojis antigos por ícones e ajusta os grupos padrão
update public.grupos set nome = 'Casal', icone = 'heart', cor = '#ec4899' where nome = 'Casa';
update public.grupos set nome = 'Aluguéis', icone = 'building-2' where nome = 'Imóveis alugados';
update public.grupos set icone = case icone when '👤' then 'user' when '🏠' then 'house' when '🏘️' then 'building-2'
  when '📈' then 'trending-up' when '💑' then 'heart' when '📁' then 'folder' else icone end;
update public.categorias set icone = case icone when '🍔' then 'utensils' when '🛒' then 'shopping-cart' when '🚗' then 'car'
  when '🏠' then 'house' when '💊' then 'pill' when '🎉' then 'party-popper' when '📚' then 'graduation-cap' when '💡' then 'lightbulb'
  when '🔑' then 'key-round' when '💼' then 'briefcase' when '💹' then 'chart-line' when '🛍️' then 'shopping-bag' when '🏷️' then 'tag' else icone end;
alter table public.grupos alter column icone set default 'folder';
alter table public.categorias alter column icone set default 'tag';

-- 8) Remove o perfil "Pessoal" (o filtro por pessoa já faz esse papel) e move o que estava nele para "Casal"
do $$ declare f record; casal uuid; pes uuid; begin
  for f in select id from public.familias loop
    select id into casal from public.grupos where familia_id=f.id and nome='Casal' limit 1;
    select id into pes   from public.grupos where familia_id=f.id and nome='Pessoal' limit 1;
    if casal is not null and pes is not null then
      update public.rendas         set grupo_id=casal where grupo_id=pes;
      update public.despesas_fixas set grupo_id=casal where grupo_id=pes;
      update public.lancamentos    set grupo_id=casal where grupo_id=pes;
      update public.contas         set grupo_id=casal where grupo_id=pes;
      update public.cartoes        set grupo_id=casal where grupo_id=pes;
      delete from public.grupos where id=pes;
    end if;
  end loop;
end $$;
