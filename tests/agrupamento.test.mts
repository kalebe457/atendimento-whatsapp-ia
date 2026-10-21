// Agrupamento de mensagens seguidas do mesmo cliente (um turno só), descarte da resposta quando chegam
// mensagens novas durante a chamada da IA, validação das etapas e mensagens pendentes no reinício.
// Servidor real (local, credenciais falsas) + banco de testes. Meta, Telegram e Claude simulados.
// Chats "meta:999:<telefone fictício 55009000022xx>", wamids "teste-agrup-...".
// Banco de TESTES (atendimento_teste) fixado antes de qualquer import de src/; atendimento é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
import { createHmac } from "node:crypto";

// Agrupamento ligado com janelas curtas (produção: 4 s / 12 s).
process.env.AGRUPAMENTO_JANELA_MS = "1200";
process.env.AGRUPAMENTO_MAXIMO_MS = "2500";
Object.assign(process.env, {
  PORT: "39891",
  META_APP_SECRET: "meta-secret-teste",
  META_ENVIO_ATIVO: "true",
  META_ACCESS_TOKEN: "meta-token-falso",
  META_PHONE_NUMBER_ID: "999",
  META_GRAPH_VERSION: "v26.0",
  TELEGRAM_BOT_TOKEN: "123456:TOKEN-FALSO",
  TELEGRAM_CHAT_ID: "-1009999999999",
  TELEGRAM_WEBHOOK_SECRET: "segredo-teste-agrup",
  ANTHROPIC_API_KEY: "anthropic-falso",
});
const BASE = "http://127.0.0.1:39891";
const GRUPO = "-1009999999999";

// Relógio: quarta 07/10/2026 10:00 em Belém (loja aberta), andando no tempo real.
const agoraReal = Date.now.bind(Date);
let desloc = Date.parse("2026-10-07T10:00:00-03:00") - agoraReal();
Date.now = () => agoraReal() + desloc;

const enviados: { to: string; texto: string }[] = [];
let resp = 0;
const telegram: { metodo: string; corpo: any }[] = [];
const externas: string[] = [];
const fetchReal = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = new URL(String(url));
  if (u.hostname === "127.0.0.1") return fetchReal(url, init);
  if (u.hostname === "graph.facebook.com") {
    const corpo = JSON.parse(init.body);
    enviados.push({ to: corpo.to, texto: corpo.text?.body ?? "" });
    return new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.teste-agrup-resp-${++resp}` }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  const m = /^\/bot[^/]+\/(\w+)$/.exec(u.pathname);
  if (u.hostname === "api.telegram.org" && m) {
    telegram.push({ metodo: m[1]!, corpo: JSON.parse(init.body) });
    return { status: 200, json: async () => ({ ok: true, result: m[1] === "sendMessage" ? { message_id: 1 } : true }) } as any;
  }
  externas.push(u.hostname);
  throw new Error("rede externa bloqueada no teste");
};

// Claude simulado, com o comportamento que gerou o bug real: "quero fazer um orçamento" vira observação
// e "quantidade não se aplica" sem produto. Os campos saem do texto do turno.
const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
const turnosClaude: string[] = [];
let segurar: Promise<void> | null = null;
(Anthropic as any).Messages.prototype.parse = async function (params: any) {
  const contexto = String(params.messages.at(-1).content);
  const turno = (contexto.split("Mensagem atual do cliente:\n")[1] ?? "").split("\n\nAproveite")[0] ?? "";
  turnosClaude.push(turno);
  if (segurar) await segurar;
  const t = turno.toLowerCase();
  const resumo = { nome: "Não informado", produto: "Não informado", quantidade: "Não informado", observacoes: "Não informado" };
  if (t.includes("paulo santos")) resumo.nome = "Paulo Santos";
  if (t.includes("sou o joão")) resumo.nome = "João";
  if (t.includes("sou a ana")) resumo.nome = "Ana";
  if (t.includes("orçamento")) resumo.observacoes = "Cliente quer fazer um orçamento.";
  if (t.includes("cimento")) resumo.produto = "cimento";
  if (t.includes("10 sacos")) resumo.quantidade = "10 sacos";
  return { model: "stub", usage: { input_tokens: 0, output_tokens: 0 }, parsed_output: { resposta: "", status: "IA",
    quantidade_aplicavel: resumo.produto !== "Não informado", produto_generico: false, pergunta_itens: "", varios_itens: false, resumo } };
};

const logs: string[] = [];
const out = console.log.bind(console);
for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => { logs.push(a.join(" ")); };

const webhook = await import(B + "/src/webhook.ts");
const banco = await import(B + "/src/banco.ts");
await exigirBancoDeTeste(banco.consultar);
const { MENSAGEM_LOJA_FECHADA } = await import(B + "/src/horarioFuncionamento.ts");
await webhook.iniciarWebhook();

let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; out(`${c ? "OK  " : "FAIL"} ${t}`); };
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TEL = (n: number) => `55009000022${String(n).padStart(2, "0")}`;
const chat = (tel: string) => `meta:999:${tel}`;
const APRESENTACAO = "Olá! Seja bem-vindo(a) à loja Exemplo Materiais de Construção! Sou a assistente virtual e vou dar início ao seu atendimento.";
const NOME = "Para começarmos, qual é o seu nome?";
const PRODUTO = "Qual produto ou material você está procurando? Pode ser também a marca ou o modelo.";
const QTD = "Qual quantidade você precisa? Se ainda não souber, sem problema.";
const OBS = 'Quer acrescentar alguma observação para o vendedor? Se não, é só responder "não" que já te encaminho.';

const previos = Number((await banco.consultar("SELECT count(*) n FROM atendimentos WHERE chat_id LIKE 'meta:999:%'")).rows[0].n);
if (previos !== 0) { out(`ABORTADO: já existem ${previos} atendimentos de teste (meta:999:)`); process.exit(1); }

let seq = 0;
async function postar(tel: string, texto: string, wamid = `teste-agrup-${++seq}`) {
  const corpo = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: "999" },
    messages: [{ id: wamid, from: tel, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: texto } }] } }] }] });
  const sig = "sha256=" + createHmac("sha256", "meta-secret-teste").update(corpo).digest("hex");
  const r = await fetchReal(BASE + "/meta/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: corpo });
  return { status: r.status, wamid };
}
const recebeu = (tel: string) => enviados.filter((e) => e.to === tel).map((e) => e.texto);
// Uma mensagem e a espera da janela + processamento.
const responder = async (tel: string, texto: string) => { await postar(tel, texto); await espera(1800); };
const pendencia = async (wamid: string) => (await banco.consultar("SELECT evento IS NOT NULL AS tem_evento, processado_em FROM eventos_processados WHERE mensagem_externa_id = $1", [wamid])).rows[0];

out("== O caso do bug: \"Oi\" + \"quero fazer um orçamento\" + nome ==");
const c0 = turnosClaude.length;
await postar(TEL(1), "Oi");
await espera(1000);
await postar(TEL(1), "quero fazer um orçamento");
await espera(1800);
ok(JSON.stringify(recebeu(TEL(1))) === JSON.stringify([`${APRESENTACAO}\n\n${NOME}`]), "uma resposta só: apresentação + pergunta do nome");
ok(turnosClaude.length === c0 + 1 && turnosClaude.at(-1) === "Oi\nquero fazer um orçamento", "as duas mensagens foram um turno só para a IA (em ordem, uma por linha)");
await responder(TEL(1), "Paulo Santos");
const e1 = webhook.lerEstadoEspelhavel(chat(TEL(1)));
ok(recebeu(TEL(1)).at(-1) === `Certo, Paulo! ${PRODUTO}`, "depois do nome: \"Certo, Paulo!\" e a pergunta do produto (o pedido de orçamento não virou produto)");
ok(e1?.resumo.nome === "Paulo Santos" && e1?.resumo.produto === "Não informado" && e1?.resumo.observacoes === "Não informado",
  `nome certo, produto vazio, observação sem "quer fazer um orçamento" (${JSON.stringify(e1?.resumo)})`);
await responder(TEL(1), "cimento");
ok(recebeu(TEL(1)).at(-1) === QTD, "produto → pergunta a quantidade");
await responder(TEL(1), "10 sacos");
ok(recebeu(TEL(1)).at(-1) === OBS, "quantidade → pergunta as observações");
const g0 = telegram.length;
await responder(TEL(1), "não");
const resumo1 = telegram.slice(g0).find((c) => c.metodo === "sendMessage" && String(c.corpo.chat_id) === GRUPO)?.corpo.text ?? "";
ok(/Nome: Paulo Santos/.test(resumo1) && /Itens:\n• cimento: 10 sacos/.test(resumo1) && /Observações: Nenhuma observação adicional\./.test(resumo1),
  "resumo no grupo: nome certo, produto, quantidade e observações");

out("\n== 3 mensagens com 1 s de intervalo ==");
const c1 = turnosClaude.length;
await postar(TEL(2), "oi"); await espera(1000);
await postar(TEL(2), "sou o João"); await espera(1000);
await postar(TEL(2), "preciso de cimento"); await espera(1800);
ok(JSON.stringify(recebeu(TEL(2))) === JSON.stringify([`${APRESENTACAO}\n\nCerto, João! ${QTD}`]) && turnosClaude.length === c1 + 1,
  "uma resposta só, já na quantidade (nome e produto aproveitados do mesmo turno)");

out("\n== Mensagem chegando durante a chamada da IA ==");
let liberar!: () => void;
segurar = new Promise<void>((r) => { liberar = r; });
await postar(TEL(3), "oi");
await espera(1500); // o lote fechou e a IA está respondendo (presa)
await postar(TEL(3), "sou a Ana");
await espera(1600); // o segundo lote fechou enquanto a IA ainda respondia o primeiro
liberar(); segurar = null;
await espera(800);
ok(JSON.stringify(recebeu(TEL(3))) === JSON.stringify([`${APRESENTACAO}\n\nCerto, Ana! ${PRODUTO}`]),
  "a resposta do 1º lote foi descartada; uma resposta só, com o contexto novo (já pede o produto)");
ok(logs.some((l) => /resposta descartada \(mensagens novas do cliente\)/.test(l)), "descarte logado");

out("\n== Janela máxima ==");
const c2 = turnosClaude.length;
for (let i = 0; i < 5; i++) { await postar(TEL(4), `mensagem ${i}`); await espera(1000); }
await espera(1500);
ok(turnosClaude.length === c2 + 2 && turnosClaude[c2]!.split("\n").length === 3 && turnosClaude[c2 + 1]!.split("\n").length === 2,
  `mensagens sem parar: o lote fecha no máximo (2,5 s) → 3 + 2 mensagens (${turnosClaude.slice(c2).map((t) => t.split("\n").length).join(" + ")})`);

out("\n== Mesmo wamid duas vezes (reentrega da Meta) ==");
await postar(TEL(5), "oi", "teste-agrup-dup-1");
const dup = await postar(TEL(5), "oi", "teste-agrup-dup-1");
await espera(1800);
ok(dup.status === 200 && recebeu(TEL(5)).length === 1 && !turnosClaude.at(-1)!.includes("oi\noi"), "duplicada ignorada: uma resposta, sem repetir o texto");

out("\n== Reinício com lote pendente ==");
process.env.AGRUPAMENTO_JANELA_MS = "3000";
const p = await postar(TEL(6), "oi");
await espera(300);
const antes = await pendencia(p.wamid);
webhook.redefinirEstadoWebhookParaTestes(); // o processo "caiu" com a mensagem esperando o lote
await espera(3300);
ok(antes?.tem_evento === true && antes?.processado_em === null && recebeu(TEL(6)).length === 0, "mensagem guardada como pendente; caiu sem resposta");
await webhook.recuperarNaPartida();
const devolvidas = await webhook.reprocessarMensagensPendentes();
process.env.AGRUPAMENTO_JANELA_MS = "1200";
await espera(3600);
ok(devolvidas === 1 && JSON.stringify(recebeu(TEL(6))) === JSON.stringify([`${APRESENTACAO}\n\n${NOME}`]), "recuperação: a mensagem pendente é processada e respondida uma vez");
const depois = await pendencia(p.wamid);
ok(depois?.tem_evento === false && depois?.processado_em !== null, "depois de processada: conteúdo apagado e processado_em gravado");
const reentrega = await postar(TEL(6), "oi", p.wamid);
await espera(1800);
ok(reentrega.status === 200 && recebeu(TEL(6)).length === 1, "reentrega da Meta depois do reinício: duplicada, sem nova resposta");
ok((await webhook.reprocessarMensagensPendentes()) === 0, "nada mais pendente");

out("\n== Fora do horário ==");
desloc = Date.parse("2026-10-07T22:00:00-03:00") - agoraReal();
await postar(TEL(7), "oi"); await espera(300);
await postar(TEL(7), "tem cimento?"); await espera(300);
await postar(TEL(7), "alô"); await espera(1800);
ok(JSON.stringify(recebeu(TEL(7))) === JSON.stringify([MENSAGEM_LOJA_FECHADA]), "três mensagens seguidas: um aviso de loja fechada só");
desloc = Date.parse("2026-10-07T10:30:00-03:00") - agoraReal();

out("\n== Logs ==");
ok(!logs.some((l) => ["Paulo", "orçamento", "cimento", "sou a Ana"].some((t) => l.includes(t))), "nenhum log com texto do cliente");
ok(externas.length === 0, `nenhuma chamada de rede externa (${externas.length})`);

out("\n== Limpeza ==");
await espera(500);
const ev = (await banco.consultar("DELETE FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-agrup-%'")).rowCount;
const { limparEspelhoDeTeste } = await import(B + "/tests/limpeza-espelho.mts");
const espelho = await limparEspelhoDeTeste(banco.consultar);
ok(espelho.restantes === 0, `apagados: ${ev} eventos, ${espelho.atendimentos} atendimentos, ${espelho.clientes} clientes; restantes = ${espelho.restantes}`);
await banco.encerrarBanco();

out(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
await new Promise((r) => setTimeout(r, 300));
process.exit(falhas ? 1 : 0);
