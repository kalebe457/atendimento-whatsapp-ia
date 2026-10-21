// B2: limites da chamada à Claude e inatividade pelo relógio local (momento em que a mensagem chegou),
// sem encerrar conversa com tarefa na fila. Servidor real + banco de testes (atendimento_teste).
// Chat de teste "meta:999:55009000009xx", wamids "teste-inat-...". Claude e Telegram simulados;
// Meta em modo somente log (a resposta não sai, então só a mensagem do cliente conta como atividade).
// Banco de TESTES (atendimento_teste) fixado antes de qualquer import de src/; atendimento é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
import { createHmac } from "node:crypto";

Object.assign(process.env, {
  PORT: "39884",
  META_APP_SECRET: "meta-secret-teste",
  META_ENVIO_ATIVO: "false",
  META_ACCESS_TOKEN: "meta-token-falso",
  META_PHONE_NUMBER_ID: "999",
  META_GRAPH_VERSION: "v26.0",
  TELEGRAM_BOT_TOKEN: "123456:TOKEN-FALSO",
  TELEGRAM_CHAT_ID: "-1009999999999",
  TELEGRAM_WEBHOOK_SECRET: "segredo-teste-inat",
  ANTHROPIC_API_KEY: "anthropic-falso",
});
const BASE = "http://127.0.0.1:39884";

// Relógio controlado: quarta 07/10/2026 10:00 em Belém (loja aberta).
const agoraReal = Date.now.bind(Date);
let desloc = Date.parse("2026-10-07T10:00:00-03:00") - agoraReal();
Date.now = () => agoraReal() + desloc;
const MIN = 60_000;

const fetchReal = globalThis.fetch;
const externas: string[] = [];
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = new URL(String(url));
  if (u.hostname === "127.0.0.1") return fetchReal(url, init);
  const m = /^\/bot[^/]+\/(\w+)$/.exec(u.pathname);
  if (u.hostname === "api.telegram.org" && m) {
    return { status: 200, json: async () => ({ ok: true, result: m[1] === "sendMessage" ? { message_id: 1 } : true }) } as any;
  }
  externas.push(u.hostname);
  throw new Error("rede externa bloqueada no teste");
};

// Claude simulado; "segurar" deixa a chamada pendente até ser liberada (IA respondendo).
const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
let segurar: Promise<void> | null = null;
let chamadasClaude = 0;
(Anthropic as any).Messages.prototype.parse = async function () {
  chamadasClaude++;
  if (segurar) await segurar;
  return { model: "stub", usage: { input_tokens: 0, output_tokens: 0 }, parsed_output: { resposta: "", status: "IA", quantidade_aplicavel: true,
    resumo: { nome: "Não informado", produto: "Não informado", quantidade: "Não informado", observacoes: "Não informado" } } };
};

const logs: string[] = [];
const out = console.log.bind(console);
for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => { logs.push(a.join(" ")); };

const webhook = await import(B + "/src/webhook.ts");
const ia = await import(B + "/src/iaClaude.ts");
const banco = await import(B + "/src/banco.ts");
await exigirBancoDeTeste(banco.consultar);
webhook.iniciarWebhook();
await new Promise((r) => setTimeout(r, 400));

let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; out(`${c ? "OK  " : "FAIL"} ${t}`); };
const espera = (ms = 500) => new Promise((r) => setTimeout(r, ms));
const chat = (tel: string) => `meta:999:${tel}`;
const aberta = (tel: string) => webhook.lerEstadoEspelhavel(chat(tel)) !== null;

let seq = 0;
// tsMeta: timestamp que a Meta informa (pode vir atrasado em relação à chegada).
async function mensagem(tel: string, texto: string, tsMeta = Date.now()) {
  const corpo = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: "999" },
    messages: [{ id: `teste-inat-${++seq}`, from: tel, timestamp: String(Math.floor(tsMeta / 1000)), type: "text", text: { body: texto } }] } }] }] });
  const sig = "sha256=" + createHmac("sha256", "meta-secret-teste").update(corpo).digest("hex");
  const r = await fetchReal(BASE + "/meta/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: corpo });
  await espera();
  return r.status;
}

const previos = Number((await banco.consultar("SELECT count(*) n FROM atendimentos WHERE chat_id LIKE 'meta:999:%'")).rows[0].n);
if (previos !== 0) { out(`ABORTADO: já existem ${previos} atendimentos de teste (meta:999:)`); process.exit(1); }

out("== Limites da Claude ==");
const limites = ia.configuracaoClienteClaude();
ok(limites.timeout === 40_000 && limites.maxRetries === 1, `cliente com timeout ${limites.timeout} ms e maxRetries ${limites.maxRetries} (padrão do SDK: 600000 e 2)`);

out("\n== Inatividade conta da CHEGADA, não do timestamp da Meta ==");
const TEL_A = "5500900000901";
// A Meta entrega com 15 min de atraso (ainda dentro dos 20 min, então é processada).
ok((await mensagem(TEL_A, "oi", Date.now() - 15 * MIN)) === 200 && aberta(TEL_A), "mensagem com timestamp 15 min atrasado abre o atendimento");
desloc += 6 * MIN; // 21 min depois do timestamp da Meta, 6 min depois da chegada
webhook.verificarInatividade();
ok(aberta(TEL_A), "6 min depois da chegada (21 min pelo timestamp da Meta): continua aberto");
desloc += 15 * MIN; // 21 min depois da chegada
webhook.verificarInatividade();
ok(!aberta(TEL_A) && logs.some((l) => /encerrado por inatividade/.test(l)), "21 min depois da chegada: encerrado por inatividade");

out("\n== Conversa com tarefa na fila não é encerrada ==");
const TEL_B = "5500900000902";
await mensagem(TEL_B, "oi");
ok(aberta(TEL_B), "atendimento aberto");
let liberar!: () => void;
segurar = new Promise<void>((r) => { liberar = r; });
const antes = chamadasClaude;
// Sem nome nem produto: com eles, a conversa parada iria ao vendedor em vez de encerrar.
await mensagem(TEL_B, "ok");
ok(chamadasClaude === antes + 1, "IA respondendo a 2ª mensagem (chamada pendente)");
desloc += 25 * MIN; // a IA "demorou": a atividade anterior já passou de 20 min
webhook.verificarInatividade();
ok(aberta(TEL_B), "25 min sem atividade, mas com a tarefa na fila: NÃO encerrada");
const encerradosAntes = logs.filter((l) => /encerrado por inatividade/.test(l)).length;
liberar(); segurar = null;
await espera();
ok(aberta(TEL_B) && logs.filter((l) => /encerrado por inatividade/.test(l)).length === encerradosAntes, "a tarefa termina e a conversa segue aberta");
desloc += 21 * MIN;
webhook.verificarInatividade();
ok(!aberta(TEL_B), "sem tarefa e 21 min depois da última chegada: encerrada");

ok(externas.length === 0, `nenhuma chamada de rede externa (${externas.length})`);

out("\n== Limpeza ==");
await espera(500);
const ev = (await banco.consultar("DELETE FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-inat-%'")).rowCount;
const { limparEspelhoDeTeste } = await import(B + "/tests/limpeza-espelho.mts");
const espelho = await limparEspelhoDeTeste(banco.consultar);
ok(espelho.restantes === 0, `apagados: ${ev} eventos, ${espelho.atendimentos} atendimentos, ${espelho.clientes} clientes; restantes = ${espelho.restantes}`);
await banco.encerrarBanco();

out(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
await new Promise((r) => setTimeout(r, 300));
process.exit(falhas ? 1 : 0);
