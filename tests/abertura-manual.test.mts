// Abertura manual temporária: /abrir_agora [minutos], /cancelar_abertura e /fechamentos.
// Servidor real (local, credenciais falsas) + banco de testes. Meta, Telegram e Claude simulados; rede externa
// bloqueada. Comandos do Telegram chamados direto em processarUpdateTelegram (nenhum webhook do Telegram).
// Chats "meta:999:<telefone fictício 55009000021xx>", wamids "teste-abert-...", admin/membro 9900000008xx.
// Banco de TESTES (atendimento_teste) fixado antes de qualquer import de src/; atendimento é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
import { createHmac } from "node:crypto";

Object.assign(process.env, {
  PORT: "39890",
  META_APP_SECRET: "meta-secret-teste",
  META_ENVIO_ATIVO: "true",
  META_ACCESS_TOKEN: "meta-token-falso",
  META_PHONE_NUMBER_ID: "999",
  META_GRAPH_VERSION: "v26.0",
  TELEGRAM_BOT_TOKEN: "123456:TOKEN-FALSO",
  TELEGRAM_CHAT_ID: "-1009999999999",
  TELEGRAM_WEBHOOK_SECRET: "segredo-teste-abert",
  TELEGRAM_RESUMO_TTL_HORAS: "72",
  ANTHROPIC_API_KEY: "anthropic-falso",
});
const BASE = "http://127.0.0.1:39890";
const GRUPO = -1009999999999;
const ADMIN = { id: 990_000_000_801, first_name: "Joana", last_name: "Teste" };
const MEMBRO = { id: 990_000_000_802, first_name: "Membro", last_name: "Teste" };

// Relógio controlado (Belém = UTC-3).
const agoraReal = Date.now.bind(Date);
let desloc = 0;
const relogio = (iso: string) => { desloc = Date.parse(iso) - agoraReal(); };
relogio("2026-10-07T21:00:00-03:00"); // quarta, 21:00: fora do horário
Date.now = () => agoraReal() + desloc;

// ---- Graph API e Bot API simuladas ----
const enviadosWhatsApp: { to: string; texto: string }[] = [];
let resp = 0;
const telegram: { metodo: string; corpo: any }[] = [];
const externas: string[] = [];
const fetchReal = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = new URL(String(url));
  if (u.hostname === "127.0.0.1") return fetchReal(url, init);
  if (u.hostname === "graph.facebook.com") {
    const corpo = JSON.parse(init.body);
    enviadosWhatsApp.push({ to: corpo.to, texto: corpo.text.body });
    return new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.teste-abert-resp-${++resp}` }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  const m = /^\/bot[^/]+\/(\w+)$/.exec(u.pathname);
  if (u.hostname === "api.telegram.org" && m) {
    const corpo = JSON.parse(init.body);
    telegram.push({ metodo: m[1]!, corpo });
    const r = (o: any) => ({ status: o.ok ? 200 : 400, json: async () => o });
    if (m[1] === "getChatMember") return r({ ok: true, result: { status: corpo.user_id === ADMIN.id ? "administrator" : "member" } });
    if (m[1] === "sendMessage") return r({ ok: true, result: { message_id: 1, chat: { id: Number(corpo.chat_id) } } });
    return r({ ok: true, result: true });
  }
  externas.push(u.hostname);
  throw new Error("rede externa bloqueada no teste");
};

const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
(Anthropic as any).Messages.prototype.parse = async function () {
  return { model: "stub", usage: { input_tokens: 0, output_tokens: 0 }, parsed_output: { resposta: "", status: "IA", quantidade_aplicavel: true,
    produto_generico: false, pergunta_itens: "", varios_itens: false,
    resumo: { nome: "Não informado", produto: "Não informado", quantidade: "Não informado", observacoes: "Não informado" } } };
};

const logs: string[] = [];
const out = console.log.bind(console);
for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => { logs.push(a.join(" ")); };

const webhook = await import(B + "/src/webhook.ts");
const T = await import(B + "/src/telegramBot.ts");
const banco = await import(B + "/src/banco.ts");
await exigirBancoDeTeste(banco.consultar);
const H = await import(B + "/src/horarioFuncionamento.ts");

let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; out(`${c ? "OK  " : "FAIL"} ${t}`); };
const espera = (ms = 600) => new Promise((r) => setTimeout(r, ms));
const TEL = (n: number) => `55009000021${String(n).padStart(2, "0")}`;

const previos = Number((await banco.consultar("SELECT (SELECT count(*) FROM atendimentos WHERE chat_id LIKE 'meta:999:%') + (SELECT count(*) FROM aberturas_manuais) + (SELECT count(*) FROM fechamentos) n")).rows[0].n);
if (previos !== 0) { out(`ABORTADO: já existem ${previos} registros de teste`); process.exit(1); }

await webhook.iniciarWebhook();

let seq = 0;
async function mensagem(tel: string, texto: string) {
  const corpo = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: "999" },
    messages: [{ id: `teste-abert-${++seq}`, from: tel, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: texto } }] } }] }] });
  const sig = "sha256=" + createHmac("sha256", "meta-secret-teste").update(corpo).digest("hex");
  await fetchReal(BASE + "/meta/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: corpo });
  await espera();
}
let upd = 1;
async function comando(v: typeof ADMIN, texto: string) {
  const antes = telegram.length;
  await T.processarUpdateTelegram({ update_id: upd++, message: { message_id: 1, chat: { id: v.id, type: "private" }, from: v, text: texto } });
  const novas = telegram.slice(antes).filter((c) => c.metodo === "sendMessage");
  return { resposta: novas.filter((c) => c.corpo.chat_id === v.id).at(-1)?.corpo.text as string | undefined, grupo: novas.filter((c) => c.corpo.chat_id === String(GRUPO) || c.corpo.chat_id === GRUPO).map((c) => String(c.corpo.text)) };
}
const recebeu = (tel: string) => enviadosWhatsApp.filter((e) => e.to === tel).map((e) => e.texto);
const linhasNoBanco = async () => (await banco.consultar("SELECT id, fim, cancelado_em FROM aberturas_manuais ORDER BY id")).rows;
const APRESENTACAO = "Olá! Seja bem-vindo(a) à loja Exemplo Materiais de Construção!";

out("== Permissão e argumentos ==");
const m1 = await comando(MEMBRO, "/abrir_agora");
ok(m1.resposta === "Esse comando é só para administradores do grupo." && !H.lojaAberta() && (await linhasNoBanco()).length === 0, "membro comum: recusado, loja continua fechada, nada gravado");
const USO = "Uso: /abrir_agora [minutos], de 5 a 720 (sem número: 60). Ex.: /abrir_agora 90";
for (const ruim of ["/abrir_agora 4", "/abrir_agora 721", "/abrir_agora abc", "/abrir_agora 0", "/abrir_agora -10"]) {
  ok((await comando(ADMIN, ruim)).resposta === USO && !H.lojaAberta(), `${ruim}: uso correto, nada aberto`);
}

out("\n== Limites 5 e 720 ==");
const l5 = await comando(ADMIN, "/abrir_agora 5");
ok(l5.resposta === "Loja aberta manualmente até 21:05 (America/Belem)." && H.lojaAberta(), "5 min: até 21:05");
const l720 = await comando(ADMIN, "/abrir_agora 720");
ok(l720.resposta === "Loja aberta manualmente até 09:00 de 08/10 (America/Belem)." , `720 min: até 09:00 do dia seguinte ("${l720.resposta}")`);
const linhas1 = await linhasNoBanco();
ok(linhas1.length === 2 && linhas1[0].cancelado_em !== null && linhas1[1].cancelado_em === null, "nova abertura cancela a anterior no banco");
await comando(ADMIN, "/cancelar_abertura");

out("\n== Padrão de 60 minutos: loja fora do horário fica aberta ==");
const p60 = await comando(ADMIN, "/abrir_agora");
ok(p60.resposta === "Loja aberta manualmente até 22:00 (America/Belem)." && JSON.stringify(p60.grupo) === JSON.stringify(["Loja aberta manualmente até 22:00 por Joana."]),
  "sem argumento: 60 min; resposta ao admin e aviso no grupo com o primeiro nome");
relogio("2026-10-07T21:10:00-03:00");
await mensagem(TEL(1), "oi");
ok(recebeu(TEL(1))[0]?.startsWith(APRESENTACAO) === true, "21:10 (fora do horário): o cliente entra na triagem normalmente");
const f1 = await comando(ADMIN, "/fechamentos");
ok(f1.resposta?.startsWith("Abertura manual ativa até 22:00 (America/Belem).\n\nNenhum fechamento marcado") === true, `/fechamentos mostra a abertura: ${JSON.stringify(f1.resposta)}`);

out("\n== Expiração ==");
relogio("2026-10-07T22:00:30-03:00");
ok(!H.lojaAberta(), "às 22:00 a loja já volta a fechar sozinha");
await mensagem(TEL(2), "oi");
ok(JSON.stringify(recebeu(TEL(2))) === JSON.stringify([H.MENSAGEM_LOJA_FECHADA]), "cliente novo recebe a mensagem de loja fechada");
const g0 = telegram.length;
await T.verificarFimAberturaManual();
await T.verificarFimAberturaManual();
const avisosFim = telegram.slice(g0).filter((c) => c.metodo === "sendMessage" && String(c.corpo.chat_id) === String(GRUPO)).map((c) => String(c.corpo.text));
ok(JSON.stringify(avisosFim) === JSON.stringify(["Abertura manual encerrada às 22:00. A loja volta ao horário normal."]), "aviso de fim no grupo, uma vez só");
ok((await comando(ADMIN, "/fechamentos")).resposta === "Nenhum fechamento marcado de hoje em diante.", "/fechamentos sem a abertura depois do fim");

out("\n== Cancelamento ==");
await comando(ADMIN, "/abrir_agora 30");
const c1 = await comando(ADMIN, "/cancelar_abertura");
ok(c1.resposta === "Abertura manual cancelada. A loja volta ao horário normal." && JSON.stringify(c1.grupo) === JSON.stringify(["Abertura manual cancelada por Joana. A loja volta ao horário normal."]) && !H.lojaAberta(),
  "cancelada na hora: resposta, aviso no grupo e loja fechada");
ok((await linhasNoBanco()).at(-1)?.cancelado_em !== null, "cancelado_em gravado no banco");
ok((await comando(ADMIN, "/cancelar_abertura")).resposta === "Não há abertura manual ativa.", "sem abertura ativa: avisa");
ok((await comando(MEMBRO, "/cancelar_abertura")).resposta === "Esse comando é só para administradores do grupo.", "membro comum não cancela");

out("\n== Prioridade sobre o fechamento manual do dia ==");
relogio("2026-10-08T10:00:00-03:00"); // quinta, dentro do horário
await comando(ADMIN, "/fechar");
ok(!H.lojaAberta(), "dia fechado manualmente: loja fechada");
await comando(ADMIN, "/abrir_agora 60");
ok(H.lojaAberta(), "abertura manual vence o fechamento do dia");
await mensagem(TEL(3), "oi");
ok(recebeu(TEL(3))[0]?.startsWith(APRESENTACAO) === true, "cliente entra na triagem (não recebe a mensagem de dia fechado)");
const f2 = await comando(ADMIN, "/fechamentos");
ok(f2.resposta?.startsWith("Abertura manual ativa até 11:00 (America/Belem).\n\nFechamentos marcados") === true, "/fechamentos mostra a abertura e o fechamento");
await comando(ADMIN, "/cancelar_abertura");
ok(!H.lojaAberta(), "cancelada: o fechamento do dia volta a valer");
await comando(ADMIN, "/abrir");

out("\n== Recuperação depois de reinício ==");
relogio("2026-10-08T20:00:00-03:00");
await comando(ADMIN, "/abrir_agora 120");
webhook.redefinirEstadoWebhookParaTestes();
ok(!H.lojaAberta(), "memória zerada (reinício): fechada antes de recuperar");
await webhook.recuperarNaPartida();
ok(H.lojaAberta() && logs.some((l) => l === "[Loja] abertura manual ativa recuperada até 22:00."), "recuperação: a abertura ainda válida volta (até 22:00)");
await comando(ADMIN, "/cancelar_abertura");
webhook.redefinirEstadoWebhookParaTestes();
await webhook.recuperarNaPartida();
ok(!H.lojaAberta(), "abertura cancelada não volta no reinício");
await comando(ADMIN, "/abrir_agora 10");
relogio("2026-10-08T20:30:00-03:00");
webhook.redefinirEstadoWebhookParaTestes();
await webhook.recuperarNaPartida();
ok(!H.lojaAberta(), "abertura vencida durante o reinício não volta");

out("\n== Banco fora na partida ==");
relogio("2026-10-08T20:40:00-03:00");
await comando(ADMIN, "/abrir_agora 60");
const pool = banco.obterPool();
const queryOriginal = pool.query.bind(pool);
(pool as any).query = () => Promise.reject(Object.assign(new Error("conexão recusada (simulada)"), { code: "ECONNREFUSED" }));
webhook.redefinirEstadoWebhookParaTestes();
await webhook.recuperarNaPartida();
await webhook.tentarCarregarAberturaManual();
const foraAberta = H.lojaAberta();
(pool as any).query = queryOriginal;
ok(!foraAberta && logs.some((l) => l.includes("[Loja] ATENÇÃO: abertura manual não carregada do banco (ECONNREFUSED)")), "banco fora: sobe sem a abertura e loga em destaque");
await webhook.tentarCarregarAberturaManual();
ok(H.lojaAberta(), "banco de volta: a nova tentativa recupera a abertura");
await comando(ADMIN, "/cancelar_abertura");

out("\n== Logs ==");
ok(!logs.some((l) => l.includes("Joana")) && logs.some((l) => /abertura manual por 60 min por admin 9900\*\*\*\*0801/.test(l)), "log sem o nome do admin (user_id mascarado)");
ok(externas.length === 0, `nenhuma chamada de rede externa (${externas.length})`);

out("\n== Limpeza ==");
await espera(500);
const ab = (await banco.consultar("DELETE FROM aberturas_manuais WHERE inicio >= '2026-10-07' AND inicio < '2026-10-09'")).rowCount;
const fe = (await banco.consultar("DELETE FROM fechamentos WHERE data = '2026-10-08'")).rowCount;
const ev = (await banco.consultar("DELETE FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-abert-%'")).rowCount;
const { limparEspelhoDeTeste } = await import(B + "/tests/limpeza-espelho.mts");
const espelho = await limparEspelhoDeTeste(banco.consultar);
const sobra = Number((await banco.consultar("SELECT (SELECT count(*) FROM aberturas_manuais) + (SELECT count(*) FROM fechamentos) n")).rows[0].n);
ok(espelho.restantes === 0 && sobra === 0, `apagados: ${ab} aberturas, ${fe} fechamento, ${ev} eventos, ${espelho.atendimentos} atendimentos; restantes = ${espelho.restantes + sobra}`);
await banco.encerrarBanco();

out(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
await new Promise((r) => setTimeout(r, 300));
process.exit(falhas ? 1 : 0);
