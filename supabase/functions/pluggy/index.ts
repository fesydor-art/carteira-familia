// Edge Function "pluggy": ponte segura entre o app e a API da Pluggy (Open Finance / MeuPluggy).
// Ações (POST JSON): {acao:"token"} | {acao:"salvar_item", itemId} | {acao:"sync"} | {acao:"remover", itemId} | {acao:"cron"} (agendado, header x-cron-token)
// Autenticação: ações de usuário exigem login (auth.getUser); "cron" exige o token guardado em public.app_config
// Segredos necessários: PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const PLUGGY = "https://api.pluggy.ai";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

let cache = { k: "", t: 0 };
async function apiKey(): Promise<string> {
  if (cache.k && Date.now() - cache.t < 90 * 60e3) return cache.k;
  const clientId = Deno.env.get("PLUGGY_CLIENT_ID"), clientSecret = Deno.env.get("PLUGGY_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Faltam os segredos PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET no Supabase.");
  const r = await fetch(PLUGGY + "/auth", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: clientId.trim(), clientSecret: clientSecret.trim() }),
  });
  if (!r.ok) throw new Error(`Pluggy recusou o login (${r.status}). Confira o Client ID e o Client Secret.`);
  const j = await r.json();
  cache = { k: j.apiKey, t: Date.now() };
  return j.apiKey;
}
async function pg(path: string, init: RequestInit = {}) {
  const r = await fetch(PLUGGY + path, {
    ...init, headers: { "X-API-KEY": await apiKey(), "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`Pluggy ${path.split("?")[0]}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function todas(path: string) {
  const out: any[] = [];
  for (let page = 1; page < 50; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const j = await pg(`${path}${sep}pageSize=500&page=${page}`);
    out.push(...(j.results || []));
    if (!j.totalPages || page >= j.totalPages) break;
  }
  return out;
}

// transações: GET /v2/transactions com paginação por cursor (o /transactions antigo foi desligado - 410)
async function transacoesV2(accountId: string, dateFrom: string, dateTo: string) {
  const out: any[] = [];
  let after: string | null = null;
  for (let i = 0; i < 200; i++) {
    const q = new URLSearchParams({ accountId, dateFrom, dateTo });
    if (after) q.set("after", after);
    const j = await pg(`/v2/transactions?${q.toString()}`);
    out.push(...(j.results || []));
    if (!j.next) break;
    after = new URL(j.next, PLUGGY).searchParams.get("after");
    if (!after) break;
  }
  return out;
}

const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
const dia = (d?: string) => (d ? Number(String(d).slice(8, 10)) || null : null);
const BANDEIRAS = ["visa", "mastercard", "elo", "amex", "hipercard"];
const bandeira = (b?: string) => {
  const n = norm(b || "");
  if (n.includes("master")) return "mastercard";
  if (n.includes("american") || n.includes("amex")) return "amex";
  return BANDEIRAS.find((x) => n.includes(x)) || "outra";
};
// categoria Pluggy -> nome de categoria do app
const CAT: [RegExp, string][] = [
  [/food|restaurant|delivery|aliment|restaurante/i, "Alimentação"],
  [/groceries|supermarket|mercado|supermercado/i, "Mercado"],
  [/transport|fuel|gas station|uber|taxi|parking|combust|transporte|automotive/i, "Transporte"],
  [/health|pharmac|drugstore|saude|farmacia|medical/i, "Saúde"],
  [/leisure|entertainment|travel|streaming|lazer|viagem/i, "Lazer"],
  [/education|educa/i, "Educação"],
  [/housing|rent|utilities|electricity|water|internet|telecom|moradia|aluguel/i, "Contas fixas"],
  [/salary|income|wage|salario|renda/i, "Salário"],
  [/investment|interest|yield|rendimento|investimento/i, "Rendimentos"],
  [/shopping|clothing|electronics|compras/i, "Compras"],
];

async function syncItem(sb: any, fid: string, uid: string, itemId: string) {
  const it = await pg(`/items/${itemId}`);
  const contas = await todas(`/accounts?itemId=${itemId}`);
  let banco: string = it.connector?.name || "Banco";
  if (/meu\s*pluggy/i.test(banco)) {
    const nomeConta = contas.find((a: any) => a.bankData?.transferNumber || a.name)?.name || "";
    banco = it.connector?.institutionName || it.metadata?.institutionName || nomeConta || "Banco (MeuPluggy)";
  }

  // instituição (casa pelo nome; cria se não existir)
  const { data: insts } = await sb.from("instituicoes").select("id,nome").eq("familia_id", fid);
  const nb = norm(banco);
  let inst = (insts || []).find((i: any) => nb.includes(norm(i.nome)) || norm(i.nome).includes(nb.split(" ")[0]));
  if (!inst) {
    const cor = it.connector?.primaryColor ? "#" + String(it.connector.primaryColor).replace("#", "") : "#334155";
    const r = await sb.from("instituicoes").insert({ familia_id: fid, nome: banco, cor1: cor, cor2: "#0f172a" }).select("id,nome").single();
    if (r.error) throw new Error(r.error.message);
    inst = r.data;
  }
  const { data: gr } = await sb.from("grupos").select("id,nome").eq("familia_id", fid);
  const casal = (gr || []).find((g: any) => /casal/i.test(g.nome))?.id || null;
  const { data: cats } = await sb.from("categorias").select("id,nome").eq("familia_id", fid);
  const catId = (pc?: string) => {
    if (!pc) return null;
    const nome = CAT.find(([re]) => re.test(pc))?.[1];
    return nome ? (cats || []).find((c: any) => c.nome === nome)?.id || null : null;
  };

  let nContas = 0, nCartoes = 0, nInv = 0, nTx = 0;
  let grpBanco: string | null = null; // perfil escolhido para a conta do banco (ex.: IPTV) — investimentos novos seguem ele
  const desde = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  const ate = new Date(Date.now() + 400 * 864e5).toISOString().slice(0, 10); // inclui parcelas futuras

  for (const a of contas) {
    const nome = a.marketingName || a.name || "Conta";
    const final4 = String(a.number || "").replace(/\D/g, "").slice(-4) || null;
    let refCol = "conta_id", refId: string | null = null, grpConta: string | null = casal;
    if (a.type === "CREDIT") {
      const cd = a.creditData || {};
      const row: any = {
        familia_id: fid, titular_id: uid, instituicao_id: inst.id, nome, bandeira: bandeira(cd.brand),
        final4: final4 && final4.length === 4 ? final4 : null,
        limite_total: Number(cd.creditLimit || 0), limite_disponivel: cd.availableCreditLimit ?? null,
        fatura_atual: Math.max(0, Number(a.balance || 0)),
        dia_fechamento: dia(cd.balanceCloseDate), dia_vencimento: dia(cd.balanceDueDate),
        origem: "pluggy", pluggy_account_id: a.id, ativo: true, atualizado_em: new Date().toISOString(),
      };
      // alguns bancos (ex.: Nubank) não mandam as datas: não apaga o dia que o usuário digitou
      if (row.dia_fechamento == null) delete row.dia_fechamento;
      if (row.dia_vencimento == null) delete row.dia_vencimento;
      const ex = await sb.from("cartoes").select("id,grupo_id").eq("pluggy_account_id", a.id).maybeSingle();
      if (!ex.data) row.grupo_id = casal; else grpConta = ex.data.grupo_id;
      const r = await sb.from("cartoes").upsert(row, { onConflict: "pluggy_account_id" }).select("id").single();
      if (r.error) throw new Error("cartão: " + r.error.message);
      refCol = "cartao_id"; refId = r.data.id; nCartoes++;
    } else {
      const row: any = {
        familia_id: fid, titular_id: uid, instituicao_id: inst.id, nome,
        tipo: a.subtype === "SAVINGS_ACCOUNT" ? "poupanca" : "corrente",
        saldo_api: Number(a.balance || 0), origem: "pluggy", pluggy_account_id: a.id, ativo: true,
        atualizado_em: new Date().toISOString(),
      };
      const ex = await sb.from("contas").select("id,grupo_id").eq("pluggy_account_id", a.id).maybeSingle();
      if (!ex.data) row.grupo_id = casal; else { grpConta = ex.data.grupo_id; if (grpConta && grpConta !== casal) grpBanco = grpConta; }
      const r = await sb.from("contas").upsert(row, { onConflict: "pluggy_account_id" }).select("id").single();
      if (r.error) throw new Error("conta: " + r.error.message);
      refId = r.data.id; nContas++;
    }

    // transações (novas entram; as já importadas não são sobrescritas, para manter suas edições)
    const txs = await transacoesV2(a.id, desde, ate);
    const rows = txs.map((t: any) => {
      const amt = Number(t.amount || 0);
      // conta: positivo = entrada | cartão: positivo = compra
      const tipo = a.type === "CREDIT"
        ? (amt >= 0 ? "despesa" : "receita")
        : (t.type === "CREDIT" ? "receita" : t.type === "DEBIT" ? "despesa" : (amt >= 0 ? "receita" : "despesa"));
      const m = t.creditCardMetadata || {};
      const pn = m.installmentNumber ?? t.installmentNumber ?? null, pt = m.totalInstallments ?? t.totalInstallments ?? null;
      const r: any = {
        familia_id: fid, user_id: uid, tipo, valor: Math.abs(amt) || 0.01,
        descricao: (t.description || t.descriptionRaw || "Transação").slice(0, 140) + (pt > 1 ? ` (${pn}/${pt})` : ""),
        data: String(t.date).slice(0, 10), origem: "pluggy", pluggy_transaction_id: t.id,
        categoria_id: catId(t.category), grupo_id: grpConta,   // lançamento herda o perfil da conta/cartão (ex.: IPTV)
        [refCol]: refId,
      };
      if (pt > 1) { r.parcela_num = pn; r.parcela_total = pt; }
      return r;
    }).filter((r: any) => r.valor > 0);
    for (let i = 0; i < rows.length; i += 500) {
      const r = await sb.from("lancamentos").upsert(rows.slice(i, i + 500), { onConflict: "pluggy_transaction_id", ignoreDuplicates: true });
      if (r.error) throw new Error("lançamentos: " + r.error.message);
    }
    nTx += rows.length;
  }

  // investimentos
  try {
    const invs = await todas(`/investments?itemId=${itemId}`);
    for (const v of invs) {
      const row: any = {
        familia_id: fid, titular_id: uid, instituicao_id: inst.id, nome: v.name || "Investimento",
        tipo: "investimento", saldo_api: Number(v.balance ?? v.amount ?? 0), origem: "pluggy",
        pluggy_account_id: "inv:" + v.id, ativo: Number(v.balance ?? v.amount ?? 0) > 0, atualizado_em: new Date().toISOString(),
      };
      const ex = await sb.from("contas").select("id").eq("pluggy_account_id", row.pluggy_account_id).maybeSingle();
      if (!ex.data) row.grupo_id = grpBanco || (gr || []).find((g: any) => /invest/i.test(g.nome))?.id || casal;
      const r = await sb.from("contas").upsert(row, { onConflict: "pluggy_account_id" });
      if (!r.error) nInv++;
    }
  } catch (_) { /* nem todo banco libera investimentos */ }

  // empréstimos e financiamentos -> gastos fixos (valor da parcela, dia e parcelas restantes)
  let nEmp = 0;
  try {
    const loans = await todas(`/loans?itemId=${itemId}`);
    const contasFixas = (cats || []).find((c: any) => c.nome === "Contas fixas")?.id || null;
    for (const L of loans) {
      const ins = L.installments || {};
      const rest = ins.dueInstallments ?? ((ins.totalNumberOfInstallments != null && ins.paidInstallments != null) ? ins.totalNumberOfInstallments - ins.paidInstallments : null);
      const pagos = (L.payments?.releases || []).filter((p: any) => p.paidAmount)
        .sort((a: any, b: any) => String(b.paidDate || "").localeCompare(String(a.paidDate || "")));
      const saldo = L.payments?.contractOutstandingBalance ?? null;
      const parcela = pagos[0]?.paidAmount ?? ((saldo && rest) ? saldo / rest : null);
      if (!parcela || (rest !== null && rest <= 0)) continue;
      const row: any = {
        familia_id: fid, titular_id: uid,
        descricao: `${L.productName || L.type || "Empréstimo"} · ${banco}`.slice(0, 120),
        valor: Math.round(Number(parcela) * 100) / 100,
        dia: dia(L.firstInstallmentDueDate) || dia(pagos[0]?.paidDate) || 10,
        parcelas_restantes: rest, origem: "pluggy", pluggy_loan_id: L.id, saldo_devedor: saldo, ativo: true,
        criado_em: new Date().toISOString(), // as parcelas restantes contam a partir deste mês
      };
      const ex = await sb.from("despesas_fixas").select("id").eq("pluggy_loan_id", L.id).maybeSingle();
      if (!ex.data) { row.grupo_id = casal; row.categoria_id = contasFixas; }
      const r = await sb.from("despesas_fixas").upsert(row, { onConflict: "pluggy_loan_id" });
      if (!r.error) nEmp++;
    }
  } catch (_) { /* nem todo banco libera empréstimos */ }

  await sb.from("conexoes_pluggy").update({
    banco, status: it.status || "UPDATED", ultima_sync: new Date().toISOString(),
    consentimento_expira_em: it.consentExpiresAt ? String(it.consentExpiresAt).slice(0, 10) : null,
  }).eq("pluggy_item_id", itemId);

  return { banco, contas: nContas, cartoes: nCartoes, investimentos: nInv, emprestimos: nEmp, transacoes: nTx };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));

    // atualização automática (agendada no banco com pg_cron): sincroniza as conexões de todos, com a chave de serviço
    if (body.acao === "cron") {
      const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const tok = req.headers.get("x-cron-token") || "";
      const { data: cfg } = await admin.from("app_config").select("v").eq("k", "cron_token").maybeSingle();
      if (!cfg?.v || !tok || tok !== cfg.v) return json({ error: "não autorizado" }, 401);
      const { data: cx } = await admin.from("conexoes_pluggy").select("*");
      const resultados = [];
      for (const c of cx || []) {
        try { resultados.push(await syncItem(admin, c.familia_id, c.user_id, c.pluggy_item_id)); }
        catch (e) { resultados.push({ banco: c.banco, erro: String((e as Error).message || e) }); }
      }
      return json({ ok: true, resultados });
    }

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return json({ error: "Faça login de novo." }, 401);
    const { data: mem } = await sb.from("membros").select("familia_id").eq("user_id", user.id).limit(1).maybeSingle();
    if (!mem) return json({ error: "Usuário sem família." }, 400);
    const fid = mem.familia_id;

    if (body.acao === "token") {
      const t = await pg("/connect_token", {
        method: "POST",
        body: JSON.stringify({ options: { clientUserId: user.id } }),
      });
      return json({ token: t.accessToken });
    }
    if (body.acao === "salvar_item") {
      if (!body.itemId) return json({ error: "itemId ausente" }, 400);
      const it = await pg(`/items/${body.itemId}`);
      const up = await sb.from("conexoes_pluggy").upsert({
        familia_id: fid, user_id: user.id, banco: it.connector?.name || "Banco", pluggy_item_id: it.id, status: it.status || "ativo",
      }, { onConflict: "pluggy_item_id" });
      if (up.error) throw new Error(up.error.message);
      return json({ resultados: [await syncItem(sb, fid, user.id, it.id)] });
    }
    if (body.acao === "sync") {
      // cada pessoa sincroniza só as próprias conexões (respeita perfis privados)
      const { data: cx } = await sb.from("conexoes_pluggy").select("*").eq("familia_id", fid).eq("user_id", user.id);
      const resultados = [];
      for (const c of cx || []) {
        try { resultados.push(await syncItem(sb, fid, c.user_id, c.pluggy_item_id)); }
        catch (e) { resultados.push({ banco: c.banco, erro: String((e as Error).message || e) }); }
      }
      return json({ resultados });
    }
    if (body.acao === "remover") {
      await sb.from("conexoes_pluggy").delete().eq("pluggy_item_id", body.itemId).eq("familia_id", fid);
      try { await pg(`/items/${body.itemId}`, { method: "DELETE" }); } catch (_) { /* ok */ }
      return json({ ok: true });
    }
    return json({ error: "Ação inválida" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
