-- Foto real do cartão: imagem reduzida (~30 KB) guardada no próprio cartão.
-- Fica protegida pelas mesmas regras (RLS) do cartão: só a família vê. Nada vai para bucket público.

alter table public.cartoes add column if not exists foto text;
alter table public.cartoes drop constraint if exists cartoes_foto_tam;
alter table public.cartoes add constraint cartoes_foto_tam
  check (foto is null or (foto like 'data:image/%' and length(foto) < 400000));

-- view continua com security_invoker (respeita o RLS de quem consulta); só ganha a coluna foto no fim
create or replace view public.v_cartoes with (security_invoker = true) as
 SELECT c.id,
    c.familia_id,
    c.titular_id,
    c.instituicao_id,
    c.nome,
    c.bandeira,
    c.final4,
    c.limite_total,
    c.limite_disponivel,
    c.fatura_atual,
    c.dia_fechamento,
    c.dia_vencimento,
    c.cor1,
    c.cor2,
    c.origem,
    c.pluggy_account_id,
    c.ativo,
    c.atualizado_em,
    c.grupo_id,
    i.nome AS instituicao,
    COALESCE(c.cor1, i.cor1) AS cor_a,
    COALESCE(c.cor2, i.cor2) AS cor_b,
    m.nome AS titular,
    COALESCE(c.limite_disponivel, c.limite_total - c.fatura_atual - COALESCE(( SELECT sum(l.valor) AS sum
           FROM lancamentos l
          WHERE l.cartao_id = c.id AND l.tipo = 'despesa'::text AND l.data > CURRENT_DATE AND l.origem = 'manual'::text), 0::numeric)) AS disponivel,
    c.foto
   FROM cartoes c
     LEFT JOIN instituicoes i ON i.id = c.instituicao_id
     LEFT JOIN membros m ON m.user_id = c.titular_id AND m.familia_id = c.familia_id;
