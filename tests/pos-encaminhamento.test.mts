// Depois do encaminhamento: o atendimento HUMANO (assumido ou não) fica ativo até o fim do dia seguinte;
// mensagens do cliente vão ao vendedor (privado) ou ao grupo (resposta ao resumo), sem triagem nova nem
// resumo novo; casos reais de 20/10 com nomes e números fictícios. Também: acompanhamento de orçamento
// na 1ª mensagem, mídia sem texto (3 min), o lembrete único de 20 min e reinício. Servidor real (local, credenciais falsas) + banco de testes. Meta, Telegram e Claude
// simulados; Telegram chamado direto em processarUpdateTelegram. Chats "meta:999:55009000027xx", wamids
// "teste-posenc-...", vendedores 990000001301+.
// Banco de TESTES (atendimento_teste) fixado antes de qualquer import de src/; atendimento é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
import { createHmac } from "node:crypto";

Object.assign(process.env, {
  PORT: "39894",
  META_APP_SECRET: "meta-secret-teste",
  META_ENVIO_ATIVO: "true",
  META_ACCESS_TOKEN: "meta-token-falso",
  META_PHONE_NUMBER_ID: "999",
  META_GRAPH_VERSION: "v26.0",
  TELEGRAM_BOT_TOKEN: "123456:TOKEN-FALSO",
  TELEGRAM_CHAT_ID: "-1009999999999",
  TELEGRAM_WEBHOOK_SECRET: "segredo-teste-posenc",
  TELEGRAM_RESUMO_TTL_HORAS: "72",
  ANTHROPIC_API_KEY: "anthropic-falso",
});
const BASE = "http://127.0.0.1:39894";
const GRUPO = -1009999999999;
const MIN = 60_000;

// Relógio controlado: quarta 07/10/2026 10:36 em Belém (loja aberta).
const agoraReal = Date.now.bind(Date);
let desloc = Date.parse("2026-10-07T10:36:00-03:00") - agoraReal();
Date.now = () => agoraReal() + desloc;
const irPara = (iso: string) => { desloc = Date.parse(iso) - agoraReal(); };

const enviados: { to: string; texto: string }[] = [];
let resp = 0;
const telegram: { metodo: string; corpo: any; id?: number }[] = [];
let msgId = 9000;
let chamadasClaude = 0;
const externas: string[] = [];
const fetchReal = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = new URL(String(url));
  if (u.hostname === "127.0.0.1") return fetchReal(url, init);
  if (u.hostname === "graph.facebook.com") {
    const corpo = JSON.parse(init.body);
    enviados.push({ to: corpo.to, texto: corpo.text?.body ?? "" });
    return new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.teste-posenc-resp-${++resp}` }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  const m = /^\/bot[^/]+\/(\w+)$/.exec(u.pathname);
  if (u.hostname === "api.telegram.org" && m) {
    const corpo = JSON.parse(init.body);
    const chamada: { metodo: string; corpo: any; id?: number } = { metodo: m[1]!, corpo };
    telegram.push(chamada);
    const r = (o: any) => ({ status: 200, json: async () => o });
    if (m[1] === "getChatMember") return r({ ok: true, result: { status: "member" } });
    if (m[1] === "sendMessage") {
      chamada.id = ++msgId;
      return r({ ok: true, result: { message_id: chamada.id, chat: { id: Number(corpo.chat_id) } } });
    }
    return r({ ok: true, result: true });
  }
  externas.push(u.hostname);
  throw new Error("rede externa bloqueada no teste");
};

// Claude simulado pelo texto do turno.
const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
(Anthropic as any).Messages.prototype.parse = async function (params: any) {
  chamadasClaude++;
  const contexto = String(params.messages.at(-1).content);
  const t = ((contexto.split("Mensagem atual do cliente:\n")[1] ?? "").split("\n\nAproveite")[0] ?? "").trim();
  const s: any = { nome: "Não informado", produto: "Não informado", quantidade: "Não informado", observacoes: "Não informado" };
  let extra: any = { pergunta_comercial: null, pedido_atendente: false, acompanhamento: false, itens: [] };
  if (/^(Rita|Vera|Lia|Nina)$/.test(t)) { s.nome = t; extra.classificacao_resposta_nome = "nome_pessoa"; }
  if (t.includes("CNPJ")) {
    s.nome = "Lia"; s.observacoes = "CNPJ informado na lista.";
    extra.itens = [{ produto: "cimento", quantidade: "10 sacos" }, { produto: "areia", quantidade: "2 m³" }];
  }
  if (t.startsWith("Orçamento")) extra = { ...extra, acompanhamento: true, itens: [{ produto: t, quantidade: "" }] };
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
const TEL = (n: number) => `55009000027${String(n).padStart(2, "0")}`;
const chat = (tel: string) => `meta:999:${tel}`;
const JA = webhook.MENSAGEM_JA_ENCAMINHADO;

const previos = Number((await banco.consultar("SELECT count(*) n FROM atendimentos WHERE chat_id LIKE 'meta:999:%'")).rows[0].n);
if (previos !== 0) { out(`ABORTADO: já existem ${previos} atendimentos de teste (meta:999:)`); process.exit(1); }

let seq = 0;
async function postar(tel: string, msg: { texto?: string; imagem?: boolean; legenda?: string }) {
  const m: any = { id: `teste-posenc-${++seq}`, from: tel, timestamp: String(Math.floor(Date.now() / 1000)) };
  if (msg.imagem) Object.assign(m, { type: "image", image: { id: `teste-posenc-midia-${seq}`, mime_type: "image/jpeg", ...(msg.legenda ? { caption: msg.legenda } : {}) } });
  else Object.assign(m, { type: "text", text: { body: msg.texto } });
  const corpo = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: "999" }, messages: [m] } }] }] });
  const sig = "sha256=" + createHmac("sha256", "meta-secret-teste").update(corpo).digest("hex");
  await fetchReal(BASE + "/meta/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: corpo });
  await espera(600);
}
const recebeu = (tel: string) => enviados.filter((e) => e.to === tel).map((e) => e.texto);
const falar = async (tel: string, texto: string) => { const antes = recebeu(tel).length; await postar(tel, { texto }); return recebeu(tel).slice(antes); };
const doGrupo = () => telegram.filter((c) => c.metodo === "sendMessage" && String(c.corpo.chat_id) === String(GRUPO));
const resumos = () => doGrupo().filter((c) => String(c.corpo.text).includes("📋 NOVO ATENDIMENTO"));
const resumoDe = (trecho: string) => resumos().filter((c) => String(c.corpo.text).includes(trecho));
const repassesNoGrupo = () => doGrupo().filter((c) => String(c.corpo.text).startsWith("📩"));
const noPrivado = (id: number) => telegram.filter((c) => c.metodo === "sendMessage" && c.corpo.chat_id === id && String(c.corpo.text).startsWith("📩"));
const lembretes = () => doGrupo().filter((c) => String(c.corpo.text).startsWith("⚠️ Atendimento"));
const verificar = async () => { webhook.verificarInatividade(); await espera(700); };
const reiniciar = async () => { webhook.redefinirEstadoWebhookParaTestes(); await webhook.recuperarNaPartida(); webhook.verificarInatividade(); await espera(700); };
const estado = (tel: string) => webhook.lerEstadoEspelhavel(chat(tel));

out("== Caso real 1: encaminhado às 10:36, ninguém assumiu; o cliente volta a escrever ==");
const ENCAMINHAR = "quero falar com um vendedor";
await falar(TEL(1), "oi");
await falar(TEL(1), "Rita");
await falar(TEL(1), ENCAMINHAR);
const resumo1 = resumoDe("Nome: Rita")[0];
ok(!!resumo1 && estado(TEL(1))?.status === "HUMANO", "encaminhada (resumo publicado)");
const claude1 = chamadasClaude;
irPara("2026-10-07T10:58:00-03:00"); // 22 min depois: antes, a conversa já teria fechado
await verificar();
ok(estado(TEL(1))?.status === "HUMANO", "22 min depois: o atendimento HUMANO continua ativo (não fecha em 20 min)");
ok(JSON.stringify(await falar(TEL(1), "Eu não quero esse vendedor")) === JSON.stringify([JA]), "1ª mensagem: o aviso \"já foi passado\" (uma vez)");
ok((await falar(TEL(1), "Esse vendedor já me enganou")).length === 0, "2ª: nenhuma resposta ao cliente");
const rep1 = repassesNoGrupo().map((c) => c.corpo);
ok(rep1.length === 2 && rep1[0].text === '📩 Rita escreveu: "Eu não quero esse vendedor"' && rep1[1].text === '📩 Rita escreveu: "Esse vendedor já me enganou"' &&
   rep1.every((c: any) => c.reply_parameters?.message_id === resumo1!.id),
  "ninguém assumiu: as duas mensagens vão ao grupo, como resposta ao resumo");
irPara("2026-10-07T11:58:00-03:00");
await verificar();
await falar(TEL(1), "Tô esperando faz mais de uma hora");
ok(repassesNoGrupo().at(-1)?.corpo.text === '📩 Rita escreveu: "Tô esperando faz mais de uma hora"' && chamadasClaude === claude1 && resumoDe("Nome: Rita").length === 1,
  "11:58 (82 min depois): repassada também; a Claude não foi chamada e não há resumo novo");

out("\n== Caso real 2: assumido às 11:49; o cliente volta às 13:24 ==");
const VEND = { id: 990_000_001_301, first_name: "Vera", last_name: "Teste" };
await T.processarUpdateTelegram({ update_id: 1, message: { message_id: 1, chat: { id: VEND.id, type: "private" }, from: VEND, text: "/start" } });
irPara("2026-10-07T11:49:00-03:00");
await falar(TEL(2), "oi");
await falar(TEL(2), "Nina");
await falar(TEL(2), ENCAMINHAR);
const resumo2 = resumoDe("Nome: Nina")[0]!;
const cod2 = estado(TEL(2))!.codigo;
await T.processarUpdateTelegram({ update_id: 2, callback_query: { id: "cb-posenc-1", from: VEND, data: `assumir:${cod2}`, message: { message_id: resumo2.id, chat: { id: GRUPO, type: "supergroup" } } } });
irPara("2026-10-07T13:24:00-03:00");
await verificar();
const recebidas2 = recebeu(TEL(2)).length;
const claude2 = chamadasClaude;
ok((await falar(TEL(2), "A Vera ainda não entrou em contato")).length === 0, "13:24: assumido, nada ao cliente (sem triagem do zero)");
ok(noPrivado(VEND.id).at(-1)?.corpo.text === '📩 Nina escreveu: "A Vera ainda não entrou em contato"' && chamadasClaude === claude2 && recebeu(TEL(2)).length === recebidas2,
  "a mensagem vai ao privado da vendedora que assumiu");
ok(resumoDe("Nome: Nina").length === 1, "nenhum resumo novo");

out("\n== Caso real 3: lista com CNPJ às 08:44; \"Ok\" às 09:13 e a lista de novo ==");
irPara("2026-10-08T08:44:00-03:00");
const LISTA = "Lista: 10 sacos de cimento e 2 m³ de areia. CNPJ 00.000.000/0001-00";
await falar(TEL(3), LISTA);
ok(resumoDe("Nome: Lia").length === 1 && estado(TEL(3))?.status === "HUMANO", "lista completa: encaminhada direto (um resumo)");
irPara("2026-10-08T09:13:00-03:00");
await verificar();
const repassesAntes3 = repassesNoGrupo().length;
ok((await falar(TEL(3), "Ok")).length === 0 && repassesNoGrupo().length === repassesAntes3, "\"Ok\" 29 min depois: nada ao cliente nem ao grupo, sem triagem");
ok(JSON.stringify(await falar(TEL(3), LISTA)) === JSON.stringify([JA]), "reenviou a lista (com conteúdo): a resposta única com o texto novo");
ok(resumoDe("Nome: Lia").length === 1 && repassesNoGrupo().slice(repassesAntes3).map((c) => c.corpo.text).join(" | ") === `📩 Lia escreveu: "${LISTA}"`,
  "nenhum resumo duplicado; só a lista repassada ao grupo");

out("\n== Prazo do atendimento encaminhado: até o fim do dia seguinte ==");
irPara("2026-10-08T23:50:00-03:00"); // dia seguinte ao encaminhamento da Rita (07/10)
await verificar();
ok(estado(TEL(1))?.status === "HUMANO", "08/10 23:50: o de 07/10 ainda ativo");
irPara("2026-10-09T00:01:00-03:00");
await verificar();
ok(estado(TEL(1)) === null && estado(TEL(3))?.status === "HUMANO", "09/10 00:01: o de 07/10 encerrado; o de 08/10 continua");
ok((await banco.consultar("SELECT encerrado_em FROM atendimentos WHERE chat_id = $1 ORDER BY id DESC LIMIT 1", [chat(TEL(1))])).rows[0].encerrado_em !== null, "banco: encerrado no prazo novo");

out("\n== Reinício: o encaminhado continua sem triagem ==");
irPara("2026-10-09T09:00:00-03:00");
await reiniciar();
ok(estado(TEL(3))?.status === "HUMANO", "depois do reinício: o de 08/10 volta como HUMANO (não é encerrado nem reabre a triagem)");
const claude3 = chamadasClaude;
await falar(TEL(3), "bom dia, e o meu pedido?");
ok(chamadasClaude === claude3 && repassesNoGrupo().at(-1)?.corpo.text === '📩 Lia escreveu: "bom dia, e o meu pedido?"' && resumoDe("Nome: Lia").length === 1,
  "mensagem depois do reinício: repassada, sem Claude e sem resumo novo");
ok(estado(TEL(2))?.status === "HUMANO" || estado(TEL(2)) === null, "o assumido de 07/10 segue a mesma regra");

out("\n== Acompanhamento de orçamento na 1ª mensagem (B) ==");
irPara("2026-10-09T10:00:00-03:00");
const r4 = await falar(TEL(4), "Orçamento 12345678");
const resumo4 = String(resumoDe('"Orçamento 12345678"')[0]?.corpo.text ?? "");
ok(r4.length === 1 && r4[0]!.endsWith("Certo! Vou passar seu atendimento para um vendedor da loja.") && resumo4.includes("Itens: Não informado") &&
   resumo4.includes('Observações: Cliente falou de um pedido ou atendimento anterior: "Orçamento 12345678".'),
  "vendedor na hora, sem pedir nome; nunca vira item; as palavras do cliente nas observações");

out("\n== Mídia sem texto (C) ==");
await postar(TEL(5), { imagem: true });
ok(recebeu(TEL(5)).length === 1 && estado(TEL(5))?.status === "IA", "só uma imagem: o aviso de mídia (pede o texto)");
desloc += 2 * MIN;
await verificar();
ok(resumos().filter((c) => String(c.corpo.text).includes("sem texto")).length === 0, "2 min: ainda espera o texto");
desloc += 1 * MIN + 5_000;
await verificar();
const resumo5 = String(resumos().at(-1)?.corpo.text ?? "");
ok(resumo5.includes("Itens:\n• produto da imagem enviada: a confirmar") && resumo5.includes("Observações: Cliente enviou imagem sem texto.") && estado(TEL(5))?.status === "HUMANO" &&
   recebeu(TEL(5)).at(-1) === "Vou passar sua mensagem para um vendedor da loja, que vai continuar o seu atendimento.",
  "3 min sem texto: vai ao vendedor (item \"produto da imagem enviada\"; \"Cliente enviou imagem sem texto.\")");

out("\n== 21/10: foto com legenda na etapa do nome e o cliente some ==");
irPara("2026-10-09T11:00:00-03:00");
await falar(TEL(8), "oi");
await postar(TEL(8), { imagem: true, legenda: "Tem? Quanto?" });
ok(estado(TEL(8))?.status === "IA" && recebeu(TEL(8)).length === 2, "o aviso de mídia pede o texto (segue em triagem)");
desloc += 3 * MIN + 5_000;
await verificar();
const resumo8 = String(resumos().at(-1)?.corpo.text ?? "");
ok(estado(TEL(8))?.status === "HUMANO" && resumo8.includes("Itens:\n• produto da imagem enviada: a confirmar") &&
   resumo8.includes("Observações: Cliente enviou imagem perguntando: Tem? Quanto?") && !resumo8.includes("sem texto") &&
   recebeu(TEL(8)).at(-1) === "Vou passar sua mensagem para um vendedor da loja, que vai continuar o seu atendimento.",
  "3 min depois: vai ao vendedor (item da imagem, a pergunta da legenda; não encerra por inatividade)");

out("\n== Lembrete único de 20 min (E) ==");
irPara("2026-10-09T14:00:00-03:00");
await falar(TEL(6), "oi");
await falar(TEL(6), "Vera");
await falar(TEL(6), ENCAMINHAR);
const resumo6 = resumoDe("Nome: Vera")[0]!;
const deVera = () => lembretes().filter((c) => String(c.corpo.text).includes(" de Vera "));
for (const [min, n] of [[5, 0], [15, 0], [19, 0], [20, 1], [30, 1], [60, 1]] as const) {
  irPara(new Date(Date.parse("2026-10-09T14:00:00-03:00") + min * MIN + 5_000).toISOString());
  await T.verificarLembretesSemAssumir();
  ok(deVera().length === n, `${min} min: ${n} lembrete(s)`);
}
const l20 = deVera()[0]!.corpo;
ok(l20.text === "⚠️ Atendimento de Vera sem assumir há 20 min" && l20.reply_parameters?.message_id === resumo6.id && l20.parse_mode === undefined &&
   !telegram.some((c) => c.metodo === "getChatAdministrators"),
  "20 min: um só, como resposta ao resumo, sem menção aos administradores");
await falar(TEL(7), "oi");
await falar(TEL(7), "Lia");
await falar(TEL(7), ENCAMINHAR);
const cod7 = estado(TEL(7))!.codigo;
await T.processarUpdateTelegram({ update_id: 3, callback_query: { id: "cb-posenc-2", from: VEND, data: `assumir:${cod7}`, message: { message_id: resumoDe("Nome: Lia").at(-1)!.id, chat: { id: GRUPO, type: "supergroup" } } } });
desloc += 31 * MIN;
await T.verificarLembretesSemAssumir();
ok(lembretes().filter((c) => String(c.corpo.text).includes(" de Lia ")).length === 0, "assumido: nenhum lembrete");

out("\n== Logs e rede ==");
ok(!logs.some((l) => ["Rita", "Nina", "Vera", "Lia", "enganou", "CNPJ", "12345678", "esperando"].some((t) => l.includes(t))), "nenhum log com dado do cliente");
ok(externas.length === 0, `nenhuma chamada de rede externa (${externas.length})`);

out("\n== Limpeza ==");
await espera(500);
const ev = (await banco.consultar("DELETE FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-posenc-%'")).rowCount;
const { limparEspelhoDeTeste, limparVendedoresDeTeste } = await import(B + "/tests/limpeza-espelho.mts");
const espelho = await limparEspelhoDeTeste(banco.consultar);
await limparVendedoresDeTeste(banco.consultar, [VEND.id], new Date(0));
ok(espelho.restantes === 0, `apagados: ${ev} eventos, ${espelho.atendimentos} atendimentos, ${espelho.clientes} clientes; restantes = ${espelho.restantes}`);
await banco.encerrarBanco();

out(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
await new Promise((r) => setTimeout(r, 300));
process.exit(falhas ? 1 : 0);
