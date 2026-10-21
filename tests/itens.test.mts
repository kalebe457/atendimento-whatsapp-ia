// Itens do pedido por linha ("• produto: quantidade"), quantidade de item novo depois da etapa da
// quantidade, aviso de estoque/preço/prazo, "Certo, {nome}!" e limpeza das mensagens pendentes antigas.
// Servidor real (local, credenciais falsas) + banco de testes. Meta, Telegram e Claude simulados; Telegram
// chamado direto em processarUpdateTelegram. Chats "meta:999:55009000023xx", wamids "teste-itens-...",
// vendedor 990000001001.
// Banco de TESTES (atendimento_teste) fixado antes de qualquer import de src/; atendimento é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
import { createHmac } from "node:crypto";

process.env.AGRUPAMENTO_JANELA_MS = "1200";
process.env.AGRUPAMENTO_MAXIMO_MS = "2500";
Object.assign(process.env, {
  PORT: "39892",
  META_APP_SECRET: "meta-secret-teste",
  META_ENVIO_ATIVO: "true",
  META_ACCESS_TOKEN: "meta-token-falso",
  META_PHONE_NUMBER_ID: "999",
  META_GRAPH_VERSION: "v26.0",
  TELEGRAM_BOT_TOKEN: "123456:TOKEN-FALSO",
  TELEGRAM_CHAT_ID: "-1009999999999",
  TELEGRAM_WEBHOOK_SECRET: "segredo-teste-itens",
  ANTHROPIC_API_KEY: "anthropic-falso",
});
const BASE = "http://127.0.0.1:39892";
const GRUPO = -1009999999999;

const agoraReal = Date.now.bind(Date);
const desloc = Date.parse("2026-10-07T10:00:00-03:00") - agoraReal();
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
    return new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.teste-itens-resp-${++resp}` }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  const m = /^\/bot[^/]+\/(\w+)$/.exec(u.pathname);
  if (u.hostname === "api.telegram.org" && m) {
    const corpo = JSON.parse(init.body);
    telegram.push({ metodo: m[1]!, corpo });
    const r = (o: any) => ({ status: 200, json: async () => o });
    if (m[1] === "getChatMember") return r({ ok: true, result: { status: "member" } });
    if (m[1] === "sendMessage") return r({ ok: true, result: { message_id: 1, chat: { id: Number(corpo.chat_id) } } });
    return r({ ok: true, result: true });
  }
  externas.push(u.hostname);
  throw new Error("rede externa bloqueada no teste");
};

// Claude simulado com estado (uma conversa por vez): monta a lista de itens a partir do texto do turno.
const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
type It = { produto: string; quantidade: string };
let itensSim: It[] = [];
let nomeSim = "Não informado";
(Anthropic as any).Messages.prototype.parse = async function (params: any) {
  const contexto = String(params.messages.at(-1).content);
  const t = ((contexto.split("Mensagem atual do cliente:\n")[1] ?? "").split("\n\nAproveite")[0] ?? "").toLowerCase();
  if (t.includes("paulo santos")) nomeSim = "Paulo Santos";
  if (t.includes("10kg de cimento e areia")) itensSim = [{ produto: "cimento", quantidade: "10 kg" }, { produto: "areia", quantidade: "" }];
  else if (t.includes("caixa d'água de 500 litros")) itensSim = [...itensSim, { produto: "caixa d'água de 500 litros", quantidade: "" }];
  else if (t.includes("cimento") && itensSim.length === 0) itensSim = [{ produto: "cimento", quantidade: "" }];
  return { model: "stub", usage: { input_tokens: 0, output_tokens: 0 }, parsed_output: { resposta: "", status: "IA",
    quantidade_aplicavel: true, produto_generico: false, pergunta_itens: "", varios_itens: itensSim.length > 1, itens: itensSim,
    resumo: { nome: nomeSim, produto: "Não informado", quantidade: "Não informado", observacoes: "Não informado" } } };
};

const logs: string[] = [];
const out = console.log.bind(console);
for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => { logs.push(a.join(" ")); };

const webhook = await import(B + "/src/webhook.ts");
const T = await import(B + "/src/telegramBot.ts");
const ia = await import(B + "/src/iaClaude.ts");
const itens = await import(B + "/src/itensPedido.ts");
const banco = await import(B + "/src/banco.ts");
await exigirBancoDeTeste(banco.consultar);
const V = await import(B + "/scripts/ver-atendimentos.mts");
const { executarRetencao } = await import(B + "/src/retencao.ts");
await webhook.iniciarWebhook();

let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; out(`${c ? "OK  " : "FAIL"} ${t}`); };
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TEL = (n: number) => `55009000023${String(n).padStart(2, "0")}`;
const chat = (tel: string) => `meta:999:${tel}`;
const APRESENTACAO = "Olá! Seja bem-vindo(a) à loja Exemplo Materiais de Construção! Sou a assistente virtual e vou dar início ao seu atendimento.";
const NOME = "Para começarmos, qual é o seu nome?";
const QTD = "Qual quantidade você precisa? Se ainda não souber, sem problema.";
const OBS = 'Quer acrescentar alguma observação para o vendedor? Se não, é só responder "não" que já te encaminho.';

const previos = Number((await banco.consultar("SELECT count(*) n FROM atendimentos WHERE chat_id LIKE 'meta:999:%'")).rows[0].n);
if (previos !== 0) { out(`ABORTADO: já existem ${previos} atendimentos de teste (meta:999:)`); process.exit(1); }

let seq = 0;
async function postar(tel: string, texto: string) {
  const corpo = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: "999" },
    messages: [{ id: `teste-itens-${++seq}`, from: tel, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: texto } }] } }] }] });
  const sig = "sha256=" + createHmac("sha256", "meta-secret-teste").update(corpo).digest("hex");
  await fetchReal(BASE + "/meta/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: corpo });
}
const recebeu = (tel: string) => enviados.filter((e) => e.to === tel).map((e) => e.texto);
const responder = async (tel: string, texto: string) => { await postar(tel, texto); await espera(1800); return recebeu(tel).at(-1); };

out("== O caso real ==");
await postar(TEL(1), "oi"); await espera(300);
await postar(TEL(1), "quero um orçamento"); await espera(300);
await postar(TEL(1), "tem?"); await espera(300);
await postar(TEL(1), "cimento"); await espera(1800);
ok(JSON.stringify(recebeu(TEL(1))) === JSON.stringify([`${APRESENTACAO}\n\n${ia.AVISO_PERGUNTA_COMERCIAL}\n\n${NOME}`]),
  "uma resposta: apresentação + \"o vendedor confirma estoque, preço e prazo\" + pergunta do nome");
ok((await responder(TEL(1), "Paulo Santos")) === `Certo, Paulo! ${QTD}`, "nome → \"Certo, Paulo!\" e a quantidade (o cimento ficou guardado)");
ok((await responder(TEL(1), "10kg de cimento e areia")) === OBS, "quantidade → observações (sem repetir o \"Certo\")");
ok((await responder(TEL(1), "também quero uma caixa d'água de 500 litros")) === "Qual a quantidade de caixa d'água de 500 litros? Se ainda não souber, sem problema.",
  "item novo nas observações: UMA pergunta da quantidade só dele");
const g0 = telegram.length;
await responder(TEL(1), "não sei");
const resumo = telegram.slice(g0).find((c) => c.metodo === "sendMessage" && String(c.corpo.chat_id) === String(GRUPO))?.corpo.text ?? "";
ok(resumo.includes("Nome: Paulo Santos\n") && resumo.includes("Itens:\n• cimento: 10 kg\n• areia: a confirmar\n• caixa d'água de 500 litros: a confirmar\nObservações: Não informado"),
  `resumo no grupo com os 3 itens no formato novo: ${JSON.stringify(resumo.split("\n").slice(4).join(" / "))}`);
ok(!/Produto:|Quantidade:/.test(resumo), "sem as linhas antigas Produto/Quantidade");

out("\n== DM do ASSUMIR, link wa.me e ver-atendimentos ==");
const VEND = { id: 990_000_001_001, first_name: "Vito", last_name: "Teste" };
await T.processarUpdateTelegram({ update_id: 1, message: { message_id: 1, chat: { id: VEND.id, type: "private" }, from: VEND, text: "/start" } });
const codigo = webhook.lerEstadoEspelhavel(chat(TEL(1)))?.codigo ?? "";
await T.processarUpdateTelegram({ update_id: 2, callback_query: { id: "cb-itens-1", from: VEND, data: `assumir:${codigo}`, message: { message_id: 1, chat: { id: GRUPO, type: "supergroup" } } } });
const dm = telegram.filter((c) => c.metodo === "sendMessage" && c.corpo.chat_id === VEND.id && String(c.corpo.text).startsWith("🔒")).at(-1);
ok(!!dm && String(dm.corpo.text).includes("Itens:\n• cimento: 10 kg\n• areia: a confirmar\n• caixa d'água de 500 litros: a confirmar"), "DM do vendedor com os itens por linha");
const texto = new URL(String(dm?.corpo.reply_markup?.inline_keyboard?.[0]?.[0]?.url)).searchParams.get("text") ?? "";
ok(texto.includes("Vi seu pedido de cimento (10 kg), areia e caixa d'água de 500 litros."), `link wa.me com o pedido em uma frase: ${JSON.stringify(texto)}`);
const leitura = await V.conectarSomenteLeitura();
const conversa = (await V.executar((sql: string, p?: unknown[]) => leitura.query(sql, p), [codigo])).linhas.join("\n");
await leitura.end();
ok(conversa.includes("Itens:\n• cimento: 10 kg\n• areia: a confirmar\n• caixa d'água de 500 litros: a confirmar"), "ver-atendimentos mostra os itens por linha");

out("\n== Formato dos itens (unidade) ==");
ok(JSON.stringify(itens.linhasDeItens("Cimento", "10 sacos")) === JSON.stringify(["Itens:", "• Cimento: 10 sacos"]), "item único: uma linha, mesmo formato");
ok(JSON.stringify(itens.linhasDeItens("caixa d'água de 500 litros", "Não informado")) === JSON.stringify(["Itens:", "• caixa d'água de 500 litros: a confirmar"]),
  "característica no nome do produto; sem quantidade: \"a confirmar\"");
ok(JSON.stringify(itens.linhasDeItens("Não informado", "Não informado")) === JSON.stringify(["Itens: Não informado"]), "sem produto: \"Itens: Não informado\"");
ok(itens.pedidoEmTexto("cimento\nareia", "10 kg\na confirmar") === "cimento (10 kg) e areia", "pedido em texto para o link");
ok(JSON.stringify(itens.camposDosItens([{ produto: "a", quantidade: null }, { produto: "b", quantidade: null }])) === JSON.stringify({ produto: "a\nb", quantidade: "Não informado" }),
  "nenhuma quantidade: \"Não informado\" (a etapa da quantidade continua a ser perguntada)");

out("\n== Estoque, preço e prazo; \"Certo\" só uma vez (IA direto) ==");
itensSim = []; nomeSim = "Não informado";
const conv = new ia.IAClaude("ATD-00000C0001");
const cli = { telefone: "5500900002399", status: "IA" as const, resumo: { nome: "Não informado", telefone: "5500900002399", produto: "Não informado", quantidade: "Não informado", observacoes: "Não informado" } };
const fala = async (msg: string) => { const r = await conv.responder(msg, cli); cli.resumo = r.resumo; return r.resposta; };
await fala("oi");
nomeSim = "Ana";
ok((await fala("Ana. Quanto custa o cimento?")) === `Certo, Ana! ${ia.AVISO_PERGUNTA_COMERCIAL}\n\n${QTD}`,
  "\"quanto custa?\": aviso em uma frase e a triagem segue (com o \"Certo\" do nome)");
itensSim = [{ produto: "areia", quantidade: "" }];
ok((await fala("areia, entrega hoje?")) === `${ia.AVISO_PERGUNTA_COMERCIAL}\n\n${QTD}`, "\"entrega hoje?\": aviso; sem repetir o \"Certo\"");
ok(!(await fala("não tem observação, 2 m³")).includes(ia.AVISO_PERGUNTA_COMERCIAL), "\"não tem ...\" sem pergunta: sem aviso");

out("\n== Retenção: pendentes com mais de 24 h ==");
await banco.consultar(`INSERT INTO eventos_processados (canal, mensagem_externa_id, evento, recebido_em) VALUES
  ('META', 'teste-itens-ret-velho', '{"data":{"chatId":"meta:999:5500900002398"}}', now() - interval '25 hours'),
  ('META', 'teste-itens-ret-novo', '{"data":{"chatId":"meta:999:5500900002398"}}', now() - interval '1 hour')`);
const ret = await executarRetencao();
const linhas = (await banco.consultar("SELECT mensagem_externa_id, evento IS NOT NULL AS tem FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-itens-ret-%' ORDER BY 1")).rows;
ok((ret?.pendentes ?? 0) >= 1 && linhas.find((l: any) => l.mensagem_externa_id === "teste-itens-ret-velho")?.tem === false && linhas.find((l: any) => l.mensagem_externa_id === "teste-itens-ret-novo")?.tem === true,
  "conteúdo da pendente de 25 h apagado; a de 1 h fica");
ok(logs.some((l) => /eventos pendentes limpos: \d+/.test(l)) && !logs.some((l) => l.includes("5500900002398")), "log só com a contagem");

out("\n== Logs ==");
ok(!logs.some((l) => ["Paulo", "caixa d", "cimento", "areia"].some((t) => l.includes(t))), "nenhum log com dado do cliente");
ok(externas.length === 0, `nenhuma chamada de rede externa (${externas.length})`);

out("\n== Limpeza ==");
await espera(500);
const ev = (await banco.consultar("DELETE FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-itens-%'")).rowCount;
const { limparEspelhoDeTeste, limparVendedoresDeTeste } = await import(B + "/tests/limpeza-espelho.mts");
const espelho = await limparEspelhoDeTeste(banco.consultar);
await limparVendedoresDeTeste(banco.consultar, [VEND.id], new Date(0));
ok(espelho.restantes === 0, `apagados: ${ev} eventos, ${espelho.atendimentos} atendimentos, ${espelho.clientes} clientes; restantes = ${espelho.restantes}`);
await banco.encerrarBanco();

out(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
await new Promise((r) => setTimeout(r, 300));
process.exit(falhas ? 1 : 0);
