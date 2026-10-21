// Aviso ao cliente quando o vendedor assume + mensagem pronta no link wa.me da DM.
// Servidor real + banco de testes (atendimento_teste). Chats "meta:999:55009000018xx", wamids "teste-assumiu-...",
// vendedores 9900000006xx. Meta, Telegram e Claude simulados; rede externa bloqueada.
// Banco de TESTES (atendimento_teste) fixado antes de qualquer import de src/; atendimento é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
import { createHmac } from "node:crypto";

Object.assign(process.env, {
  PORT: "39889",
  META_APP_SECRET: "meta-secret-teste",
  META_ENVIO_ATIVO: "true",
  META_ACCESS_TOKEN: "meta-token-falso",
  META_PHONE_NUMBER_ID: "999",
  META_GRAPH_VERSION: "v26.0",
  TELEGRAM_BOT_TOKEN: "123456:TOKEN-FALSO",
  TELEGRAM_CHAT_ID: "-1009999999999",
  TELEGRAM_WEBHOOK_SECRET: "segredo-teste-assumiu",
  TELEGRAM_RESUMO_TTL_HORAS: "72",
  ANTHROPIC_API_KEY: "anthropic-falso",
});
const BASE = "http://127.0.0.1:39889";
const GRUPO = -1009999999999;

// Relógio controlado: quarta 07/10/2026 10:00 em Belém (loja aberta).
const agoraReal = Date.now.bind(Date);
let desloc = Date.parse("2026-10-07T10:00:00-03:00") - agoraReal();
Date.now = () => agoraReal() + desloc;

// ---- Graph API simulada: guarda o texto por destinatário; graphAceita = false recusa (erro permanente) ----
const graph: { to: string; texto: string }[] = [];
let graphAceita = true;
let resp = 0;
// ---- Bot API simulada ----
type Chamada = { metodo: string; corpo: any; msgId?: number };
const telegram: Chamada[] = [];
let msgId = 8000;
const externas: string[] = [];
const fetchReal = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = new URL(String(url));
  if (u.hostname === "127.0.0.1") return fetchReal(url, init);
  if (u.hostname === "graph.facebook.com") {
    const corpo = JSON.parse(init.body);
    graph.push({ to: corpo.to, texto: corpo.text?.body ?? "" });
    if (!graphAceita) {
      return new Response(JSON.stringify({ error: { code: 131047, message: "recusado (simulado)" } }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.teste-assumiu-resp-${++resp}` }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  const m = /^\/bot[^/]+\/(\w+)$/.exec(u.pathname);
  if (u.hostname === "api.telegram.org" && m) {
    const corpo = JSON.parse(init.body);
    const r = (o: any) => ({ status: o.ok ? 200 : 400, json: async () => o });
    if (m[1] === "getChatMember") { telegram.push({ metodo: m[1], corpo }); return r({ ok: true, result: { status: "member" } }); }
    if (m[1] === "sendMessage") { const id = msgId++; telegram.push({ metodo: m[1], corpo, msgId: id }); return r({ ok: true, result: { message_id: id, chat: { id: Number(corpo.chat_id) } } }); }
    telegram.push({ metodo: m[1]!, corpo });
    return r({ ok: true, result: true });
  }
  externas.push(u.hostname);
  throw new Error("rede externa bloqueada no teste");
};

// Claude simulado: devolve o resumo de "saidaClaude" (todos os campos preenchidos = triagem concluída numa mensagem).
const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
const VAZIO = { nome: "Não informado", produto: "Não informado", quantidade: "Não informado", observacoes: "Não informado" };
let saidaClaude: Record<string, string> = VAZIO;
(Anthropic as any).Messages.prototype.parse = async function () {
  return { model: "stub", usage: { input_tokens: 0, output_tokens: 0 }, parsed_output: { resposta: "", status: "IA", quantidade_aplicavel: true, resumo: saidaClaude } };
};

const logs: string[] = [];
const out = console.log.bind(console);
for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => { logs.push(a.join(" ")); };

const webhook = await import(B + "/src/webhook.ts");
const T = await import(B + "/src/telegramBot.ts");
const banco = await import(B + "/src/banco.ts");
await exigirBancoDeTeste(banco.consultar);
await webhook.iniciarWebhook();

let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; out(`${c ? "OK  " : "FAIL"} ${t}`); };
const espera = (ms = 600) => new Promise((r) => setTimeout(r, ms));
const chat = (tel: string) => `meta:999:${tel}`;
const TEL = (n: number) => `55009000018${String(n).padStart(2, "0")}`;

const previos = Number((await banco.consultar("SELECT count(*) n FROM atendimentos WHERE chat_id LIKE 'meta:999:%'")).rows[0].n);
if (previos !== 0) { out(`ABORTADO: já existem ${previos} atendimentos de teste (meta:999:)`); process.exit(1); }

let seq = 0;
async function mensagem(tel: string, texto: string) {
  const corpo = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: "999" },
    messages: [{ id: `teste-assumiu-${++seq}`, from: tel, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: texto } }] } }] }] });
  const sig = "sha256=" + createHmac("sha256", "meta-secret-teste").update(corpo).digest("hex");
  await fetchReal(BASE + "/meta/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: corpo });
  await espera();
}
let upd = 1;
const tg = async (u: unknown) => { await fetchReal(BASE + "/telegram/webhook", { method: "POST",
  headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "segredo-teste-assumiu" }, body: JSON.stringify(u) }); await espera(); };
const V1 = { id: 990_000_000_601, first_name: "Carlos", last_name: "Teste" };
const V2 = { id: 990_000_000_602, first_name: "Marta", last_name: "Teste" };
const start = (v: typeof V1) => tg({ update_id: upd++, message: { message_id: 1, chat: { id: v.id, type: "private" }, from: v, text: "/start" } });
const clique = (v: typeof V1, codigo: string, msg: number) =>
  tg({ update_id: upd++, callback_query: { id: `cb-assumiu-${upd}`, from: v, data: `assumir:${codigo}`, message: { message_id: msg, chat: { id: GRUPO, type: "supergroup" } } } });
const codigoDe = (tel: string) => webhook.lerEstadoEspelhavel(chat(tel))?.codigo ?? "";
const resumoDo = (codigo: string) => telegram.find((c) => c.metodo === "sendMessage" && c.corpo.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === `assumir:${codigo}`);
const avisosPara = (tel: string) => graph.filter((g) => g.to === tel && g.texto.startsWith("Pronto"));
const dmDe = (v: typeof V1, codigo: string) => telegram.filter((c) => c.metodo === "sendMessage" && c.corpo.chat_id === v.id && String(c.corpo.text).startsWith("🔒")).at(-1);
const linkDe = (dm: Chamada | undefined) => String(dm?.corpo.reply_markup?.inline_keyboard?.[0]?.[0]?.url ?? "");
const textoDoLink = (url: string) => (url.includes("?text=") ? new URL(url).searchParams.get("text") : null);
const marcaNoBanco = async (codigo: string) => (await banco.consultar("SELECT aviso_assuncao_em FROM atendimentos WHERE codigo = $1", [codigo])).rows[0]?.aviso_assuncao_em ?? null;
const vendedorNoBanco = async (codigo: string) => (await banco.consultar(
  "SELECT v.telegram_user_id::text u FROM atendimentos a JOIN vendedores v ON v.id = a.vendedor_id WHERE a.codigo = $1", [codigo])).rows[0]?.u ?? null;

// Atendimento até o resumo no grupo; devolve código e message_id do resumo.
async function ateOResumo(tel: string, saida: Record<string, string>, texto = "pedido completo") {
  saidaClaude = saida;
  await mensagem(tel, texto);
  saidaClaude = VAZIO;
  const codigo = codigoDe(tel);
  return { codigo, msg: resumoDo(codigo)?.msgId ?? -1 };
}
const COMPLETO = { nome: "Cliente Teste", produto: "Cimento CP-II", quantidade: "10 sacos", observacoes: "Nenhuma observação adicional." };
const ABERTA = (cliente: string, vendedor: string) => `Pronto, ${cliente}! ${vendedor}, da nossa equipe de vendas, já está com o seu pedido e vai te chamar pelo WhatsApp em instantes.`;

await start(V1); await start(V2);

out("== Loja aberta: aviso ao cliente e link com mensagem pronta ==");
const A = await ateOResumo(TEL(1), COMPLETO);
ok(A.msg > 0, "resumo publicado no grupo");
await clique(V1, A.codigo, A.msg);
ok(JSON.stringify(avisosPara(TEL(1)).map((g) => g.texto)) === JSON.stringify([ABERTA("Cliente Teste", "Carlos")]), "UM aviso ao cliente com o nome dele e o primeiro nome do vendedor");
const urlA = linkDe(dmDe(V1, A.codigo));
ok(urlA.startsWith(`https://wa.me/${TEL(1)}?text=`) &&
   textoDoLink(urlA) === "Olá, Cliente Teste! Aqui é Carlos, da loja Exemplo Materiais de Construção. Vi seu pedido de Cimento CP-II (10 sacos). Vamos fazer seu orçamento?",
  "link da DM com a mensagem pronta (nome, vendedor e pedido)");
ok(!/[ ?,&#]/.test(urlA.split("?text=")[1] ?? " "), "texto do link codificado (sem espaço, ?, vírgula, & ou # crus)");
ok((await marcaNoBanco(A.codigo)) !== null, "aviso marcado no banco (aviso_assuncao_em)");

out("\n== Uma vez só: ASSUMIR repetido, outro vendedor e reinício ==");
await clique(V1, A.codigo, A.msg);
await clique(V2, A.codigo, A.msg);
ok(avisosPara(TEL(1)).length === 1, "clique repetido do vencedor e clique de outro vendedor: nenhum aviso novo");
webhook.redefinirEstadoWebhookParaTestes();
const rec = await webhook.recuperarNaPartida();
if (rec.ok) await T.reenviarPendenciasRecuperadas(rec.resumosNaoPublicados);
await espera(300);
await clique(V1, A.codigo, A.msg);
ok(rec.ok && avisosPara(TEL(1)).length === 1 && logs.some((l) => l.includes(`aviso de assunção de ${A.codigo} já enviado antes; não repetido`)),
  "depois do reinício, ASSUMIR de novo: o banco já tem a marca, nenhum aviso novo");

out("\n== Dois vendedores ao mesmo tempo ==");
const C = await ateOResumo(TEL(2), COMPLETO);
await Promise.all([clique(V1, C.codigo, C.msg), clique(V2, C.codigo, C.msg)]);
ok(avisosPara(TEL(2)).length === 1, "um aviso só");

out("\n== Loja fechada ==");
const D = await ateOResumo(TEL(3), COMPLETO);
desloc += 9.5 * 60 * 60_000; // 19:30 em Belém
await clique(V2, D.codigo, D.msg);
desloc -= 9.5 * 60 * 60_000;
ok(JSON.stringify(avisosPara(TEL(3)).map((g) => g.texto)) ===
   JSON.stringify(["Pronto, Cliente Teste! Marta, da nossa equipe de vendas, já está com o seu pedido e vai te chamar no próximo horário de atendimento."]),
  "assumiu fora do horário: \"no próximo horário de atendimento\"");

out("\n== Sem nome e sem produto ==");
const E = await ateOResumo(TEL(4), VAZIO, "quero falar com um vendedor");
await clique(V1, E.codigo, E.msg);
ok(JSON.stringify(avisosPara(TEL(4)).map((g) => g.texto)) === JSON.stringify(["Pronto! Carlos, da nossa equipe de vendas, já está com o seu pedido e vai te chamar pelo WhatsApp em instantes."]),
  "sem nome: \"Pronto!\"");
ok(textoDoLink(linkDe(dmDe(V1, E.codigo))) === "Olá! Aqui é Carlos, da loja Exemplo Materiais de Construção. Vi que você entrou em contato com a loja. Vamos fazer seu orçamento?",
  "link sem nome e sem produto: \"Olá!\" e \"Vi que você entrou em contato com a loja.\"");

out("\n== Pedido longo no link ==");
const LONGO = "Cimento CP-II marca boa ".repeat(15).trim();
const F = await ateOResumo(TEL(5), { ...COMPLETO, produto: LONGO });
await clique(V1, F.codigo, F.msg);
const textoF = textoDoLink(linkDe(dmDe(V1, F.codigo))) ?? "";
const trechoF = textoF.split("Vi seu pedido de ")[1]?.split(" Vamos fazer")[0] ?? "";
ok(trechoF.endsWith("...") && Array.from(trechoF).length <= 150 && LONGO.startsWith(trechoF.slice(0, -3)),
  `pedido cortado em ${Array.from(trechoF).length} caracteres com "..."`);

out("\n== Falha no envio do aviso ==");
const G = await ateOResumo(TEL(6), COMPLETO);
graphAceita = false;
await clique(V2, G.codigo, G.msg);
graphAceita = true;
ok(avisosPara(TEL(6)).length === 1 && (await vendedorNoBanco(G.codigo)) === String(V2.id) && !!dmDe(V2, G.codigo) &&
   telegram.some((c) => c.metodo === "editMessageText" && c.corpo.message_id === G.msg),
  "aviso recusado pela Meta: a assunção continua (banco, DM e grupo editado)");
ok(logs.some((l) => l.includes(`aviso de assunção de ${G.codigo} NÃO entregue ao cliente`)) && logs.some((l) => l.includes("[Alerta] falha de envio registrada")),
  "falha logada e contada no alerta geral de envio");
await clique(V2, G.codigo, G.msg);
ok(avisosPara(TEL(6)).length === 1, "ASSUMIR de novo: não tenta outra vez (uma tentativa por atendimento)");

out("\n== META_ENVIO_ATIVO=false ==");
const H = await ateOResumo(TEL(7), COMPLETO);
process.env.META_ENVIO_ATIVO = "false";
await clique(V1, H.codigo, H.msg);
process.env.META_ENVIO_ATIVO = "true";
ok(avisosPara(TEL(7)).length === 0 && logs.some((l) => l.includes(`aviso de assunção de ${H.codigo} não enviado (META_ENVIO_ATIVO=false)`)) && (await marcaNoBanco(H.codigo)) !== null,
  "somente log: nada sai para a Meta; marcado como feito");

out("\n== Textos e link (unidade) ==");
ok(T.gerarLinkWhatsApp("5500900001899", "Olá & #1?") === "https://wa.me/5500900001899?text=Ol%C3%A1%20%26%20%231%3F", "encode: acento, &, # e ? codificados");
ok(T.gerarLinkWhatsApp("5500900001899") === "https://wa.me/5500900001899", "sem texto: link de antes");
ok(T.textoAvisoAssuncao("Ana", "@usuario", true) === "Pronto, Ana! Um vendedor da loja já está com o seu pedido e vai te chamar pelo WhatsApp em instantes.",
  "vendedor sem nome de verdade (só @usuário): \"Um vendedor da loja\"");
ok(T.textoMensagemWaMe({ nome: "Ana", produto: "Areia", quantidade: "Não informado" }, "Carlos Teste") ===
   "Olá, Ana! Aqui é Carlos, da loja Exemplo Materiais de Construção. Vi seu pedido de Areia. Vamos fazer seu orçamento?", "sem quantidade: só o produto");

out("\n== Textos sem artigo nem gênero (vendedor e vendedora) ==");
ok(T.textoAvisoAssuncao("Rosa", "Lena Teste", true) === "Pronto, Rosa! Lena, da nossa equipe de vendas, já está com o seu pedido e vai te chamar pelo WhatsApp em instantes.",
  "vendedora, com nome do cliente: sem \"O vendedor\"");
ok(T.textoAvisoAssuncao(null, "Vitor", true) === "Pronto! Vitor, da nossa equipe de vendas, já está com o seu pedido e vai te chamar pelo WhatsApp em instantes.",
  "vendedor, sem nome do cliente");
ok(T.textoAvisoAssuncao("Não informado", "Lena", false) === "Pronto! Lena, da nossa equipe de vendas, já está com o seu pedido e vai te chamar no próximo horário de atendimento.",
  "loja fechada, sem nome do cliente");
ok(T.textoAvisoAssuncao(null, null, true) === "Pronto! Um vendedor da loja já está com o seu pedido e vai te chamar pelo WhatsApp em instantes.",
  "sem nome do vendedor: \"Um vendedor da loja\"");
const waLena = T.textoMensagemWaMe({ nome: "Rosa", produto: "Cimento", quantidade: "10 sacos" }, "Lena");
ok(waLena === "Olá, Rosa! Aqui é Lena, da loja Exemplo Materiais de Construção. Vi seu pedido de Cimento (10 sacos). Vamos fazer seu orçamento?" && !waLena.includes("loja loja"),
  "wa.me com vendedora: \"Aqui é Lena, da loja Exemplo...\" (sem artigo; \"loja\" uma vez)");
ok(T.textoMensagemWaMe({ nome: "Não informado", produto: "Não informado", quantidade: "Não informado" }, "Vitor") ===
   "Olá! Aqui é Vitor, da loja Exemplo Materiais de Construção. Vi que você entrou em contato com a loja. Vamos fazer seu orçamento?", "wa.me com vendedor, sem nome do cliente");
ok(T.textoMensagemWaMe({ nome: "Rosa", produto: "Areia", quantidade: "Não informado" }, null) ===
   "Olá, Rosa! Aqui é da loja Exemplo Materiais de Construção. Vi seu pedido de Areia. Vamos fazer seu orçamento?", "wa.me sem nome do vendedor: \"Aqui é da loja ...\"");
const urlLena = T.gerarLinkWhatsApp("5500900001899", waLena) ?? "";
ok(urlLena.startsWith("https://wa.me/5500900001899?text=") && new URL(urlLena).searchParams.get("text") === waLena && urlLena.includes("Aqui%20%C3%A9%20Lena%2C%20da%20loja"),
  "link wa.me com o texto novo codificado corretamente");

out("\n== Nome do vendedor: limpeza para o cliente ==");
const exemplos: [string, string | null][] = [
  ["Paulo 🔥", "Paulo"], ["Paulo🔥", "Paulo"], ["🔥 Paulo", "Paulo"], ["🔥🔥", null], ["João-Pedro", "João-Pedro"], ["Ana Luísa", "Ana"],
  ["❤️Paulo", "Paulo"], ["D'Ávila Souza", "D'Ávila"], ["-- Zé --", "Zé"], ["@paulo", null], ["Vendedor", null],
];
for (const [bruto, esperado] of exemplos) ok(T.primeiroNomeVendedor(bruto) === esperado, `${JSON.stringify(bruto)} → ${esperado === null ? "sem nome" : esperado}`);
ok(T.textoAvisoAssuncao("Ana", "🔥🔥", true) === "Pronto, Ana! Um vendedor da loja já está com o seu pedido e vai te chamar pelo WhatsApp em instantes.",
  "nome sem letra: \"Um vendedor da loja\" no aviso");
ok(T.textoMensagemWaMe({ nome: "Ana", produto: "Areia", quantidade: "1 m³" }, "🔥🔥") ===
   "Olá, Ana! Aqui é da loja Exemplo Materiais de Construção. Vi seu pedido de Areia (1 m³). Vamos fazer seu orçamento?", "nome sem letra: link sem o nome do vendedor");

out("\n== Troca de nome no Telegram ==");
const nomeNoBanco = async (id: number) => (await banco.consultar("SELECT nome FROM vendedores WHERE telegram_user_id = $1", [id])).rows[0]?.nome;
// Mudou para "Paulo 🔥" e clica em ASSUMIR (sem novo /start).
const V1b = { ...V1, first_name: "Paulo 🔥", last_name: "" };
const I = await ateOResumo(TEL(8), COMPLETO);
await clique(V1b, I.codigo, I.msg);
ok(JSON.stringify(avisosPara(TEL(8)).map((g) => g.texto)) === JSON.stringify([ABERTA("Cliente Teste", "Paulo")]), "ASSUMIR com o nome novo: o aviso já usa \"Paulo\" (sem o emoji)");
ok((textoDoLink(linkDe(dmDe(V1, I.codigo))) ?? "").startsWith("Olá, Cliente Teste! Aqui é Paulo, da loja Exemplo"), "e o link da DM também");
ok((await nomeNoBanco(V1.id)) === "Paulo 🔥", "nome novo gravado no banco (como veio do Telegram)");
// Mudou para "Bruno Teste" e só mandou um comando no privado; o próximo aviso usa o nome novo.
const V1c = { ...V1, first_name: "Bruno", last_name: "Teste" };
await tg({ update_id: upd++, message: { message_id: 1, chat: { id: V1.id, type: "private" }, from: V1c, text: "/fechamentos" } });
ok((await nomeNoBanco(V1.id)) === "Bruno Teste", "comando no privado: nome atualizado no banco");
const J = await ateOResumo(TEL(9), COMPLETO);
await clique(V1c, J.codigo, J.msg);
ok(JSON.stringify(avisosPara(TEL(9)).map((g) => g.texto)) === JSON.stringify([ABERTA("Cliente Teste", "Bruno")]), "aviso seguinte com o nome atualizado pelo comando");
ok(logs.some((l) => /nome do vendedor 9900\*\*\*\*0601 atualizado/.test(l)), "log da atualização só com o user_id mascarado");

out("\n== Logs ==");
ok(!logs.some((l) => ["Pronto", "Olá", "Cliente Teste", "Cimento", "orçamento", "wa.me", "Paulo", "Bruno", "Carlos", "Marta"].some((t) => l.includes(t))), "nenhum log com o texto do aviso, do link ou dados do cliente");
ok(externas.length === 0, `nenhuma chamada de rede externa (${externas.length})`);

out("\n== Limpeza ==");
await espera(500);
const ev = (await banco.consultar("DELETE FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-assumiu-%'")).rowCount;
const { limparEspelhoDeTeste, limparVendedoresDeTeste } = await import(B + "/tests/limpeza-espelho.mts");
const espelho = await limparEspelhoDeTeste(banco.consultar);
await limparVendedoresDeTeste(banco.consultar, [V1.id, V2.id], new Date(0));
const sobraV = Number((await banco.consultar("SELECT count(*) n FROM vendedores WHERE telegram_user_id = ANY($1::bigint[])", [[V1.id, V2.id]])).rows[0].n);
ok(espelho.restantes === 0 && sobraV === 0, `apagados: ${ev} eventos, ${espelho.atendimentos} atendimentos, ${espelho.clientes} clientes; restantes = ${espelho.restantes + sobraV}`);
await banco.encerrarBanco();

out(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
await new Promise((r) => setTimeout(r, 300));
process.exit(falhas ? 1 : 0);
