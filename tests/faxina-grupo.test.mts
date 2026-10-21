// Limpeza do grupo e mensagens sem conteúdo depois do encaminhamento: "ok"/"tá bom"/👍 e mídia sem legenda
// não geram resposta nem repasse; a legenda com conteúdo vai como texto; ao assumir, o lembrete sai do grupo
// e as mensagens repassadas ao grupo vão para o privado de quem assumiu (e saem do grupo); o resumo
// assumido sai do grupo 30 min depois; tudo também depois de um reinício (sql/009); falha do deleteMessage
// só gera aviso. Servidor real (local, credenciais falsas) + banco de testes. Meta, Telegram e Claude
// simulados; Telegram chamado direto em processarUpdateTelegram. Chats "meta:999:55009000028xx", wamids
// "teste-faxina-...", vendedor 990000001401.
// Banco de TESTES (atendimento_teste) fixado antes de qualquer import de src/; atendimento é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
import { createHmac } from "node:crypto";

Object.assign(process.env, {
  PORT: "39895",
  META_APP_SECRET: "meta-secret-teste",
  META_ENVIO_ATIVO: "true",
  META_ACCESS_TOKEN: "meta-token-falso",
  META_PHONE_NUMBER_ID: "999",
  META_GRAPH_VERSION: "v26.0",
  TELEGRAM_BOT_TOKEN: "123456:TOKEN-FALSO",
  TELEGRAM_CHAT_ID: "-1009999999999",
  TELEGRAM_WEBHOOK_SECRET: "segredo-teste-faxina",
  TELEGRAM_RESUMO_TTL_HORAS: "72",
  ANTHROPIC_API_KEY: "anthropic-falso",
});
const BASE = "http://127.0.0.1:39895";
const GRUPO = -1009999999999;
const MIN = 60_000;

// Relógio controlado: quarta 07/10/2026 09:00 em Belém (loja aberta).
const agoraReal = Date.now.bind(Date);
let desloc = Date.parse("2026-10-07T09:00:00-03:00") - agoraReal();
Date.now = () => agoraReal() + desloc;

const enviados: { to: string; texto: string }[] = [];
let resp = 0;
const telegram: { metodo: string; corpo: any; id?: number }[] = [];
let msgId = 12000;
let falharApagar = false;
const externas: string[] = [];
const fetchReal = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = new URL(String(url));
  if (u.hostname === "127.0.0.1") return fetchReal(url, init);
  if (u.hostname === "graph.facebook.com") {
    const corpo = JSON.parse(init.body);
    enviados.push({ to: corpo.to, texto: corpo.text?.body ?? "" });
    return new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.teste-faxina-resp-${++resp}` }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  const m = /^\/bot[^/]+\/(\w+)$/.exec(u.pathname);
  if (u.hostname === "api.telegram.org" && m) {
    const corpo = JSON.parse(init.body);
    const chamada: { metodo: string; corpo: any; id?: number } = { metodo: m[1]!, corpo };
    telegram.push(chamada);
    const r = (o: any) => ({ status: o.ok ? 200 : 400, json: async () => o });
    if (m[1] === "getChatMember") return r({ ok: true, result: { status: "member" } });
    if (m[1] === "deleteMessage" && falharApagar) return r({ ok: false, error_code: 400, description: "message can't be deleted (simulado)" });
    if (m[1] === "sendMessage") {
      chamada.id = ++msgId;
      return r({ ok: true, result: { message_id: chamada.id, chat: { id: Number(corpo.chat_id) } } });
    }
    return r({ ok: true, result: true });
  }
  externas.push(u.hostname);
  throw new Error("rede externa bloqueada no teste");
};

// Claude simulado: nome fictício quando a mensagem é um dos nomes.
const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
let chamadasClaude = 0;
(Anthropic as any).Messages.prototype.parse = async function (params: any) {
  chamadasClaude++;
  const contexto = String(params.messages.at(-1).content);
  const t = ((contexto.split("Mensagem atual do cliente:\n")[1] ?? "").split("\n\nAproveite")[0] ?? "").trim();
  const s: any = { nome: "Não informado", produto: "Não informado", quantidade: "Não informado", observacoes: "Não informado" };
  const extra: any = { pergunta_comercial: null, pedido_atendente: false, acompanhamento: false, itens: [] };
  if (/^(Marli|Alceu|Dina|Edu)$/.test(t)) { s.nome = t; extra.classificacao_resposta_nome = "nome_pessoa"; }
  return { model: "stub", usage: { input_tokens: 0, output_tokens: 0 }, parsed_output: { resposta: "", status: "IA",
    quantidade_aplicavel: true, produto_generico: false, pergunta_itens: "", varios_itens: false, resumo: s, ...extra } };
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
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TEL = (n: number) => `55009000028${String(n).padStart(2, "0")}`;
const chat = (tel: string) => `meta:999:${tel}`;
const JA = webhook.MENSAGEM_JA_ENCAMINHADO;

const previos = Number((await banco.consultar("SELECT count(*) n FROM atendimentos WHERE chat_id LIKE 'meta:999:%'")).rows[0].n);
if (previos !== 0) { out(`ABORTADO: já existem ${previos} atendimentos de teste (meta:999:)`); process.exit(1); }

type Item = { texto: string } | { tipo: "image" | "audio" | "video" | "sticker"; legenda?: string };
let seq = 0;
async function enviar(tel: string, item: Item) {
  const base = { id: `teste-faxina-${++seq}`, from: tel, timestamp: String(Math.floor(Date.now() / 1000)) };
  let mensagem: any;
  if ("texto" in item) mensagem = { ...base, type: "text", text: { body: item.texto } };
  else mensagem = { ...base, type: item.tipo, [item.tipo]: { id: `teste-faxina-midia-${seq}`, mime_type: "x/y", ...(item.legenda !== undefined ? { caption: item.legenda } : {}) } };
  const corpo = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: "999" }, messages: [mensagem] } }] }] });
  const sig = "sha256=" + createHmac("sha256", "meta-secret-teste").update(corpo).digest("hex");
  await fetchReal(BASE + "/meta/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: corpo });
  await espera(600);
}
const recebeu = (tel: string) => enviados.filter((e) => e.to === tel).map((e) => e.texto);
const falar = async (tel: string, item: Item | string) => { const antes = recebeu(tel).length; await enviar(tel, typeof item === "string" ? { texto: item } : item); return recebeu(tel).slice(antes); };
const doGrupo = () => telegram.filter((c) => c.metodo === "sendMessage" && String(c.corpo.chat_id) === String(GRUPO));
const resumoDe = (nome: string) => doGrupo().find((c) => String(c.corpo.text).includes(`Nome: ${nome}\n`));
const repassesNoGrupo = () => doGrupo().filter((c) => String(c.corpo.text).startsWith("📩"));
const apagados = () => telegram.filter((c) => c.metodo === "deleteMessage").map((c) => Number(c.corpo.message_id));
const linha = async (tel: string) => (await banco.consultar(
  "SELECT codigo, lembrete_message_id, repasses_grupo, resumo_apagado_em FROM atendimentos WHERE chat_id = $1 ORDER BY id DESC LIMIT 1", [chat(tel)])).rows[0];
const reiniciar = async () => { webhook.redefinirEstadoWebhookParaTestes(); await webhook.recuperarNaPartida(); };
const encaminhar = async (tel: string, nome: string) => { await falar(tel, "oi"); await falar(tel, nome); await falar(tel, "quero falar com um vendedor"); };
const VEND = { id: 990_000_001_401, first_name: "Vito", last_name: "Teste" };
await T.processarUpdateTelegram({ update_id: 1, message: { message_id: 1, chat: { id: VEND.id, type: "private" }, from: VEND, text: "/start" } });
let upd = 10;
const assumir = async (tel: string, nome: string) => {
  const cod = (await linha(tel)).codigo;
  await T.processarUpdateTelegram({ update_id: ++upd, callback_query: { id: `cb-faxina-${upd}`, from: VEND, data: `assumir:${cod}`, message: { message_id: resumoDe(nome)!.id, chat: { id: GRUPO, type: "supergroup" } } } });
};
const privadoDoVendedor = () => telegram.filter((c) => c.metodo === "sendMessage" && c.corpo.chat_id === VEND.id).map((c) => String(c.corpo.text));

out("== 1. Sem conteúdo depois do encaminhamento ==");
await encaminhar(TEL(1), "Marli");
ok(!!resumoDe("Marli"), "encaminhada (resumo publicado)");
const claude1 = chamadasClaude;
for (const msg of ["Ta bom", "Tá", "tá bom", "tabom", "ok", "Ok!", "beleza", "blz", "certo", "obrigada", "valeu", "👍", "🙏", "😊👍"]) {
  ok((await falar(TEL(1), msg)).length === 0, `"${msg}": nada ao cliente`);
}
ok(repassesNoGrupo().length === 0 && chamadasClaude === claude1, "nenhuma repassada ao grupo (nem a Claude chamada)");

out("\n== 2. Mídia depois do encaminhamento ==");
for (const tipo of ["image", "audio", "video", "sticker"] as const) {
  ok((await falar(TEL(1), { tipo })).length === 0, `${tipo} sem legenda: nada ao cliente`);
}
ok((await falar(TEL(1), { tipo: "image", legenda: "👍" })).length === 0, "imagem com legenda sem conteúdo (👍): nada");
ok(repassesNoGrupo().length === 0, "nenhuma mídia repassada ao grupo");
ok(JSON.stringify(await falar(TEL(1), { tipo: "image", legenda: "esse modelo aqui em 3 metros" })) === JSON.stringify([JA]), `imagem com legenda: a resposta única com o texto novo ("${JA}")`);
ok(repassesNoGrupo().length === 1 && repassesNoGrupo()[0]!.corpo.text === '📩 Marli escreveu: "esse modelo aqui em 3 metros"', "só a legenda é repassada, como texto");
ok((await falar(TEL(1), "preciso para sábado")).length === 0 && repassesNoGrupo().at(-1)?.corpo.text === '📩 Marli escreveu: "preciso para sábado"',
  "mensagem com conteúdo: repassada, sem repetir a resposta");
ok(JSON.stringify(await banco.consultar("SELECT 1")) !== "" && Array.isArray((await linha(TEL(1))).repasses_grupo) && (await linha(TEL(1))).repasses_grupo.length === 2,
  "banco: os 2 repasses do grupo guardados (sql/009)");

out("\n== 3. Ao assumir: lembrete apagado; repasses para o privado e apagados ==");
desloc += 20 * MIN + 5_000;
await T.verificarLembretesSemAssumir();
const lembrete = doGrupo().find((c) => String(c.corpo.text).startsWith("⚠️ Atendimento de Marli"));
ok(!!lembrete && Number((await linha(TEL(1))).lembrete_message_id) === lembrete.id, "lembrete de 20 min publicado e o message_id guardado");
const idsRepasses = repassesNoGrupo().map((c) => c.id!);
await assumir(TEL(1), "Marli");
await espera(300);
ok(apagados().includes(lembrete!.id!), "lembrete apagado assim que alguém assumiu");
ok(privadoDoVendedor().includes('📩 Antes de você assumir, Marli escreveu:\n"esse modelo aqui em 3 metros"\n"preciso para sábado"'),
  "as mensagens anteriores vão ao privado de quem assumiu, em ordem, numa mensagem só");
ok(idsRepasses.every((id) => apagados().includes(id)), "e saem do grupo");
const l1 = await linha(TEL(1));
ok(l1.lembrete_message_id === null && l1.repasses_grupo === null, "banco: lembrete e repasses limpos (o texto do cliente sai)");
ok(!apagados().includes(resumoDe("Marli")!.id!), "o resumo ainda não foi apagado");

out("\n== 4. Resumo assumido apagado 30 min depois ==");
desloc += 29 * MIN;
await T.apagarResumosAssumidos();
ok(!apagados().includes(resumoDe("Marli")!.id!), "29 min depois da assunção: ainda no grupo");
desloc += 1 * MIN + 5_000;
await T.apagarResumosAssumidos();
ok(apagados().includes(resumoDe("Marli")!.id!) && (await linha(TEL(1))).resumo_apagado_em !== null, "30 min: resumo apagado; banco marcado");
const n1 = apagados().length;
await T.apagarResumosAssumidos();
ok(apagados().length === n1, "não tenta apagar de novo");
ok((await banco.consultar("SELECT vendedor_id IS NOT NULL a FROM atendimentos WHERE chat_id = $1", [chat(TEL(1))])).rows[0].a === true, "o registro no banco continua (assunção)");

out("\n== 5. Faxina depois de um reinício ==");
desloc = Date.parse("2026-10-07T13:00:00-03:00") - agoraReal();
await encaminhar(TEL(2), "Alceu");
await falar(TEL(2), "é para a obra da rua 2");
desloc += 20 * MIN + 5_000;
await T.verificarLembretesSemAssumir();
const lembrete2 = doGrupo().find((c) => String(c.corpo.text).startsWith("⚠️ Atendimento de Alceu"))!;
const repasse2 = repassesNoGrupo().at(-1)!;
await reiniciar();
await assumir(TEL(2), "Alceu");
await espera(300);
ok(apagados().includes(lembrete2.id!) && apagados().includes(repasse2.id!) && privadoDoVendedor().at(-1) === '📩 Antes de você assumir, Alceu escreveu:\n"é para a obra da rua 2"',
  "depois do reinício: lembrete e repasse apagados, repasse no privado (vindos do banco)");
// O banco grava assumido_em com o relógio dele; o teste anda o relógio do backend: alinha esse atendimento.
await banco.consultar("UPDATE atendimentos SET assumido_em = to_timestamp($2::double precision / 1000) WHERE codigo = $1", [(await linha(TEL(2))).codigo, Date.now() - 31 * MIN]);
await reiniciar();
await T.apagarResumosAssumidos();
ok(apagados().includes(resumoDe("Alceu")!.id!), "resumo assumido há 31 min, depois de outro reinício: apagado");
await reiniciar();
const n2 = apagados().length;
await T.apagarResumosAssumidos();
ok(apagados().length === n2, "reiniciou de novo: não tenta apagar o que já saiu");

out("\n== 6. deleteMessage falhando e o limite de 48 h ==");
desloc = Date.parse("2026-10-08T10:00:00-03:00") - agoraReal();
await encaminhar(TEL(3), "Dina");
await falar(TEL(3), "pode ser amanhã");
desloc += 20 * MIN + 5_000;
await T.verificarLembretesSemAssumir();
falharApagar = true;
await assumir(TEL(3), "Dina");
await espera(300);
ok(privadoDoVendedor().at(-1) === '📩 Antes de você assumir, Dina escreveu:\n"pode ser amanhã"' && logs.some((l) => l.includes("não apagado do grupo (código 400)")),
  "deleteMessage recusado: só aviso no log; o privado recebe as mensagens assim mesmo");
desloc += 31 * MIN;
await T.apagarResumosAssumidos();
ok((await linha(TEL(3))).resumo_apagado_em !== null, "resumo: a tentativa falha, fica marcado (não repete a cada minuto)");
falharApagar = false;
ok(JSON.stringify(await falar(TEL(3), "e aí, alguém?")) === "[]" && privadoDoVendedor().at(-1) === '📩 Dina escreveu: "e aí, alguém?"', "o atendimento segue normal (mensagem ao privado de quem assumiu)");
desloc = Date.parse("2026-10-08T15:00:00-03:00") - agoraReal();
await encaminhar(TEL(4), "Edu");
await assumir(TEL(4), "Edu");
desloc += 49 * 60 * MIN;
const n3 = apagados().length;
await T.apagarResumosAssumidos();
ok(apagados().length === n3 && logs.some((l) => l.includes("não apagado do grupo (mais de 48 h)")), "resumo com mais de 48 h: não tenta apagar (limite do Telegram), só aviso");

out("\n== Logs e rede ==");
ok(!logs.some((l) => ["Marli", "Alceu", "Dina", "Edu", "modelo aqui", "sábado", "obra da rua"].some((t) => l.includes(t))), "nenhum log com dado do cliente");
ok(externas.length === 0, `nenhuma chamada de rede externa (${externas.length})`);

out("\n== Limpeza ==");
await espera(500);
const ev = (await banco.consultar("DELETE FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-faxina-%'")).rowCount;
const { limparEspelhoDeTeste, limparVendedoresDeTeste } = await import(B + "/tests/limpeza-espelho.mts");
const espelho = await limparEspelhoDeTeste(banco.consultar);
await limparVendedoresDeTeste(banco.consultar, [VEND.id], new Date(0));
ok(espelho.restantes === 0, `apagados: ${ev} eventos, ${espelho.atendimentos} atendimentos, ${espelho.clientes} clientes; restantes = ${espelho.restantes}`);
await banco.encerrarBanco();

out(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
await new Promise((r) => setTimeout(r, 300));
process.exit(falhas ? 1 : 0);
