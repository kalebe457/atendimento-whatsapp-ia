// Nenhum cliente se perde: os dois casos reais de produção de ponta a ponta (nomes fictícios), a resposta
// única depois do encaminhamento, o lembrete de resumo sem assumir (20 min, uma vez, nunca se alguém
// assumiu, também depois de um reinício) e o encaminhamento automático do cliente que parou (3 min nas
// observações, 10 min com nome ou produto, "oi" só encerra; reinício no meio da espera).
// Servidor real (local, credenciais falsas) + banco de testes. Meta, Telegram e Claude simulados; Telegram
// chamado direto em processarUpdateTelegram. Chats "meta:999:55009000026xx", wamids "teste-encam-...",
// vendedor 990000001101. Reinício simulado zerando a memória e chamando a recuperação da partida.
// Banco de TESTES (atendimento_teste) fixado antes de qualquer import de src/; atendimento é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
import { createHmac } from "node:crypto";

Object.assign(process.env, {
  PORT: "39893",
  META_APP_SECRET: "meta-secret-teste",
  META_ENVIO_ATIVO: "true",
  META_ACCESS_TOKEN: "meta-token-falso",
  META_PHONE_NUMBER_ID: "999",
  META_GRAPH_VERSION: "v26.0",
  TELEGRAM_BOT_TOKEN: "123456:TOKEN-FALSO",
  TELEGRAM_CHAT_ID: "-1009999999999",
  TELEGRAM_WEBHOOK_SECRET: "segredo-teste-encam",
  TELEGRAM_RESUMO_TTL_HORAS: "72",
  ANTHROPIC_API_KEY: "anthropic-falso",
});
const BASE = "http://127.0.0.1:39893";
const GRUPO = -1009999999999;
const MIN = 60_000;

// Relógio controlado: quarta 07/10/2026 10:00 em Belém (loja aberta).
const agoraReal = Date.now.bind(Date);
let desloc = Date.parse("2026-10-07T10:00:00-03:00") - agoraReal();
Date.now = () => agoraReal() + desloc;

const enviados: { to: string; texto: string }[] = [];
let resp = 0;
const telegram: { metodo: string; corpo: any; id?: number }[] = [];
let msgId = 7000;
const externas: string[] = [];
const fetchReal = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = new URL(String(url));
  if (u.hostname === "127.0.0.1") return fetchReal(url, init);
  if (u.hostname === "graph.facebook.com") {
    const corpo = JSON.parse(init.body);
    enviados.push({ to: corpo.to, texto: corpo.text?.body ?? "" });
    return new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.teste-encam-resp-${++resp}` }] }), { status: 200, headers: { "Content-Type": "application/json" } });
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

// Claude simulado: a saída depende só do texto do turno (os campos já coletados ficam pela memória).
const PERGUNTA_CHEQUE = "Gostaria de saber se vocês aceitam o cheque bora estudar?";
const OBS_CHEQUE = "Cliente quer saber se a loja aceita cheque Bora Estudar.";
const NOMES = new Set(["Joana", "Wanda", "Bruna", "Carla", "Dora", "Elis", "Fabi", "Gina"]);
const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
(Anthropic as any).Messages.prototype.parse = async function (params: any) {
  const contexto = String(params.messages.at(-1).content);
  const t = ((contexto.split("Mensagem atual do cliente:\n")[1] ?? "").split("\n\nAproveite")[0] ?? "").trim();
  const s: any = { nome: "Não informado", produto: "Não informado", quantidade: "Não informado", observacoes: "Não informado" };
  let extra: any = { pergunta_comercial: null, itens: [] };
  if (NOMES.has(t)) { s.nome = t; extra = { ...extra, classificacao_resposta_nome: "nome_pessoa" }; }
  if (t === PERGUNTA_CHEQUE) { s.observacoes = OBS_CHEQUE; s.produto = t; extra = { pergunta_comercial: "pagamento", classificacao_resposta_nome: "outro", itens: [{ produto: t, quantidade: "" }] }; }
  if (t === "Bom dia! Vocês tem tinta branco neve?") extra = { pergunta_comercial: "disponibilidade", itens: [{ produto: "tinta branco neve", quantidade: "" }] };
  if (t === "cimento") extra = { ...extra, itens: [{ produto: "cimento", quantidade: "" }] };
  if (t === "10 sacos") extra = { ...extra, itens: [{ produto: "cimento", quantidade: "10 sacos" }] };
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
const TEL = (n: number) => `55009000026${String(n).padStart(2, "0")}`;
const chat = (tel: string) => `meta:999:${tel}`;
const NOME = "Para começarmos, qual é o seu nome?";
const PRODUTO = "Qual produto ou material você está procurando? Pode ser também a marca ou o modelo.";
const QTD = "Qual quantidade você precisa? Se ainda não souber, sem problema.";
const OBS = 'Quer acrescentar alguma observação para o vendedor? Se não, é só responder "não" que já te encaminho.';
const HUMANO = "Perfeito! Vou encaminhar seu atendimento para um vendedor da loja, que dará continuidade.";
const JA = webhook.MENSAGEM_JA_ENCAMINHADO;
const AUTO_OBS = "Vou passar seu pedido para um vendedor da loja, que vai continuar o seu atendimento.";
const AUTO_PAROU = "Vou passar sua mensagem para um vendedor da loja, que vai continuar o seu atendimento.";
const FECHADA = "que vai te chamar no próximo horário de atendimento.";

const previos = Number((await banco.consultar("SELECT count(*) n FROM atendimentos WHERE chat_id LIKE 'meta:999:%'")).rows[0].n);
if (previos !== 0) { out(`ABORTADO: já existem ${previos} atendimentos de teste (meta:999:)`); process.exit(1); }

let seq = 0;
async function postar(tel: string, texto: string) {
  const corpo = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: "999" },
    messages: [{ id: `teste-encam-${++seq}`, from: tel, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: texto } }] } }] }] });
  const sig = "sha256=" + createHmac("sha256", "meta-secret-teste").update(corpo).digest("hex");
  await fetchReal(BASE + "/meta/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: corpo });
  await espera(600);
}
const recebeu = (tel: string) => enviados.filter((e) => e.to === tel).map((e) => e.texto);
const falar = async (tel: string, texto: string) => { const antes = recebeu(tel).length; await postar(tel, texto); return recebeu(tel).slice(antes); };
const doGrupo = () => telegram.filter((c) => c.metodo === "sendMessage" && String(c.corpo.chat_id) === String(GRUPO));
const resumos = () => doGrupo().filter((c) => String(c.corpo.text).includes("📋 NOVO ATENDIMENTO"));
const lembretes = () => doGrupo().filter((c) => String(c.corpo.text).startsWith("⚠️ Atendimento"));
const deNome = (nome: string) => lembretes().filter((c) => String(c.corpo.text).includes(` de ${nome} `)).length;
const resumoDe = (nome: string) => resumos().filter((c) => String(c.corpo.text).includes(`Nome: ${nome}\n`));
const atendimento = async (tel: string) => (await banco.consultar(
  "SELECT codigo, status, encerrado_em, lembrete_sem_assumir_em FROM atendimentos WHERE chat_id = $1 ORDER BY id DESC LIMIT 1", [chat(tel)])).rows[0];
// A verificação periódica (30 s) roda aqui na hora; o encaminhamento entra na fila da conversa.
const verificar = async () => { webhook.verificarInatividade(); await espera(700); };
const reiniciar = async () => { webhook.redefinirEstadoWebhookParaTestes(); const r = await webhook.recuperarNaPartida(); webhook.verificarInatividade(); await espera(700); return r; };

out("== Caso real 1 (pagamento): nunca vira item; depois do encaminhamento, uma resposta só ==");
await falar(TEL(1), "Bom dia");
let r = await falar(TEL(1), PERGUNTA_CHEQUE);
ok(r.length === 1 && r[0] === `Formas de pagamento quem confirma é o vendedor, que vai continuar o seu atendimento.\n\nE qual é o seu nome?`,
  `pergunta de pagamento na etapa do nome: aviso + "E qual é o seu nome?": ${JSON.stringify(r[0])}`);
ok((await falar(TEL(1), "Joana"))[0] === `Certo, Joana! ${PRODUTO}`, "nome → \"Certo, Joana!\" e o produto");
r = await falar(TEL(1), PERGUNTA_CHEQUE);
const resumo1 = String(resumoDe("Joana")[0]?.corpo.text ?? "");
ok(r[0]?.endsWith(HUMANO) === true && resumo1.includes("Itens: Não informado") && resumo1.includes(`Observações: ${OBS_CHEQUE}`) && !resumo1.includes("cheque bora estudar?:"),
  "repetiu a pergunta: vai ao vendedor; resumo com \"Itens: Não informado\" e a pergunta nas observações");
ok((await falar(TEL(1), "Ok")).length === 0, "\"Ok\" depois do encaminhamento: nada (sem conteúdo)");
ok(JSON.stringify(await falar(TEL(1), "Olá")) === JSON.stringify([JA]), `"Olá" (com conteúdo): a resposta única "${JA}"`);
ok((await falar(TEL(1), "alguém aí")).length === 0, "a seguinte: nada (uma resposta por atendimento)");
ok(resumoDe("Joana").length === 1, "um resumo só");

out("\n== Lembrete de resumo sem assumir ==");
ok(lembretes().length === 0 && T.LEMBRETE_SEM_ASSUMIR_MS === 20 * MIN, "antes de 20 min: nenhum lembrete (o tempo é a constante)");
desloc += 19 * MIN;
await T.verificarLembretesSemAssumir();
ok(lembretes().length === 0, "19 min: ainda não");
desloc += 1 * MIN + 5_000;
await T.verificarLembretesSemAssumir();
const lemb = lembretes();
ok(lemb.length === 1 && lemb[0]!.corpo.text === "⚠️ Atendimento de Joana sem assumir há 20 min" && lemb[0]!.corpo.reply_parameters?.message_id === resumoDe("Joana")[0]!.id &&
   lemb[0]!.corpo.parse_mode === undefined,
  `20 min: UM lembrete, como resposta ao resumo, sem menção: ${JSON.stringify(lemb[0]?.corpo.text)}`);
ok((await atendimento(TEL(1))).lembrete_sem_assumir_em !== null, "banco: lembrete marcado (sql/008)");
desloc += 20 * MIN;
await T.verificarLembretesSemAssumir();
ok(deNome("Joana") === 1, "40 min: não repete (um só por resumo)");

out("\n== Caso real 2 (disponibilidade): pede só o nome e vai direto ao vendedor ==");
r = await falar(TEL(2), "Bom dia! Vocês tem tinta branco neve?");
ok(r.length === 1 && r[0]!.endsWith(`Quem confirma o estoque é o vendedor, que vai continuar o seu atendimento.\n\n${NOME}`), "apresentação + aviso de estoque + só o nome");
r = await falar(TEL(2), "Wanda");
const resumo2 = String(resumoDe("Wanda")[0]?.corpo.text ?? "");
ok(r[0] === "Certo, Wanda! Vou encaminhar seu atendimento para um vendedor da loja, que dará continuidade." &&
   resumo2.includes("Itens:\n• tinta branco neve: a confirmar") && resumo2.includes("Observações: Cliente quer saber se tem tinta branco neve."),
  "com o nome: encaminhado (sem quantidade nem observações), item a confirmar e a pergunta nas observações");

out("\n== Lembrete não sai se alguém assumiu ==");
const VEND = { id: 990_000_001_101, first_name: "Vito", last_name: "Teste" };
await T.processarUpdateTelegram({ update_id: 1, message: { message_id: 1, chat: { id: VEND.id, type: "private" }, from: VEND, text: "/start" } });
const cod2 = (await atendimento(TEL(2))).codigo;
await T.processarUpdateTelegram({ update_id: 2, callback_query: { id: "cb-encam-1", from: VEND, data: `assumir:${cod2}`, message: { message_id: resumoDe("Wanda")[0]!.id, chat: { id: GRUPO, type: "supergroup" } } } });
ok((await atendimento(TEL(2))).status === "HUMANO" && (await atendimento(TEL(2))).encerrado_em !== null, "Wanda assumida pelo vendedor");
const antesAssumido = recebeu(TEL(2)).length;
desloc += 21 * MIN;
await T.verificarLembretesSemAssumir();
ok(deNome("Wanda") === 0, "21 min depois: nenhum lembrete para o assumido");
await falar(TEL(2), "obrigada");
ok(recebeu(TEL(2)).length === antesAssumido, "mensagem do cliente depois de assumido: nada (o vendedor fala)");

out("\n== Sem resposta às observações: encaminhado em 3 min ==");
await falar(TEL(3), "oi");
await falar(TEL(3), "Bruna");
await falar(TEL(3), "cimento");
ok((await falar(TEL(3), "10 sacos"))[0] === OBS, "pergunta das observações (texto novo)");
desloc += 2 * MIN;
await verificar();
ok(resumoDe("Bruna").length === 0, "2 min: ainda espera");
desloc += 1 * MIN + 5_000;
await verificar();
const resumo3 = String(resumoDe("Bruna")[0]?.corpo.text ?? "");
ok(resumoDe("Bruna").length === 1 && resumo3.includes("Itens:\n• cimento: 10 sacos") && resumo3.includes("Observações: Não informado") && !resumo3.includes("parou de responder"),
  "3 min: resumo publicado (Observações: Não informado, sem o aviso de parada)");
ok(recebeu(TEL(3)).at(-1) === AUTO_OBS && (await atendimento(TEL(3))).status === "HUMANO", `cliente recebe "${AUTO_OBS}" (sem o "Perfeito!"); HUMANO no banco`);
ok(JSON.stringify(await falar(TEL(3), "não")) === JSON.stringify([JA]), "respondeu depois: \"já foi passado\" (a IA não volta)");

out("\n== Parou na quantidade com nome e produto: encaminhado em 10 min, com o aviso ==");
await falar(TEL(4), "oi");
await falar(TEL(4), "Carla");
ok((await falar(TEL(4), "cimento"))[0] === QTD, "pergunta da quantidade");
desloc += 9 * MIN;
await verificar();
ok(resumoDe("Carla").length === 0, "9 min: ainda espera");
desloc += 1 * MIN + 5_000;
await verificar();
const resumo4 = String(resumoDe("Carla")[0]?.corpo.text ?? "");
ok(resumo4.startsWith("⚠️ Cliente parou de responder na etapa: quantidade\n\n📋 NOVO ATENDIMENTO") && resumo4.includes("• cimento: a confirmar"),
  `10 min: resumo com "⚠️ Cliente parou de responder na etapa: quantidade"`);
ok(recebeu(TEL(4)).at(-1) === AUTO_PAROU, `cliente recebe "${AUTO_PAROU}"`);
ok(logs.some((l) => /cliente parou de responder \(10 min, etapa quantidade\); encaminhado ao vendedor automaticamente/.test(l)), "log do encaminhamento automático (sem dado do cliente)");

out("\n== Só \"oi\": encerra sem resumo ==");
await falar(TEL(5), "oi");
const resumosAntes = resumos().length;
desloc += 21 * MIN;
await verificar();
ok((await atendimento(TEL(5))).encerrado_em !== null && (await atendimento(TEL(5))).status === "IA" && resumos().length === resumosAntes, "21 min: encerrado por inatividade, sem resumo");

out("\n== Respondeu antes do tempo: segue normal ==");
await falar(TEL(6), "oi");
await falar(TEL(6), "Dora");
await falar(TEL(6), "cimento");
desloc += 8 * MIN;
await verificar();
ok((await falar(TEL(6), "10 sacos"))[0] === OBS, "8 min depois respondeu a quantidade: segue para as observações");
desloc += 2 * MIN;
await verificar();
ok(resumoDe("Dora").length === 0, "2 min depois da pergunta das observações: ainda espera (conta da última pergunta)");
ok(JSON.stringify(await falar(TEL(6), "não")) === JSON.stringify([HUMANO]) && resumoDe("Dora").length === 1 && !String(resumoDe("Dora")[0]!.corpo.text).includes("parou de responder"),
  "respondeu \"não\": encaminhado normal, um resumo só, sem aviso");

out("\n== Reinício no meio da espera ==");
await falar(TEL(7), "oi");
await falar(TEL(7), "Elis");
await falar(TEL(7), "cimento");
desloc += 4 * MIN;
let rec = await reiniciar();
ok(rec.ok && resumoDe("Elis").length === 0 && webhook.lerEstadoEspelhavel(chat(TEL(7)))?.status === "IA", "reinício com 4 min parada: volta em triagem, sem resumo ainda");
desloc += 6 * MIN + 5_000;
await verificar();
ok(String(resumoDe("Elis")[0]?.corpo.text ?? "").startsWith("⚠️ Cliente parou de responder na etapa: quantidade"), "10 min no total (atravessando o reinício): resumo com o aviso");
await falar(TEL(8), "oi");
await falar(TEL(8), "Fabi");
desloc += 25 * MIN; // processo "fora" mais que os 20 min da inatividade
rec = await reiniciar();
ok(rec.ok && String(resumoDe("Fabi")[0]?.corpo.text ?? "").startsWith("⚠️ Cliente parou de responder na etapa: produto") && recebeu(TEL(8)).at(-1) === AUTO_PAROU,
  "fora por 25 min com o nome: a partida NÃO encerra; encaminha logo depois (aviso na etapa do produto)");
await falar(TEL(9), "oi");
desloc += 25 * MIN;
const resumosAntes9 = resumos().length;
await reiniciar();
ok((await atendimento(TEL(9))).encerrado_em !== null && resumos().length === resumosAntes9, "fora por 25 min só com \"oi\": encerrado na partida, sem resumo");

out("\n== Lembrete depois de um reinício ==");
// O banco grava resumo_enviado_em com o relógio dele; o teste anda o relógio do backend: alinha o de Fabi.
// (A verificação real de 30 s também roda durante o teste: conta-se o total de lembretes por nome.)
const codFabi = (await atendimento(TEL(8))).codigo;
await banco.consultar("UPDATE atendimentos SET resumo_enviado_em = to_timestamp($2::double precision / 1000) WHERE codigo = $1", [codFabi, Date.now() - 15 * MIN]);
const joanaAntes = deNome("Joana");
await reiniciar();
desloc += 6 * MIN;
await T.verificarLembretesSemAssumir();
ok(deNome("Joana") === joanaAntes && joanaAntes === 1, "o de Joana (já lembrado antes do reinício) não se repete");
ok(deNome("Fabi") === 1 && (await atendimento(TEL(8))).lembrete_sem_assumir_em !== null, "o resumo publicado antes do reinício recebe o seu lembrete (uma vez, marcado no banco)");
await reiniciar();
desloc += 6 * MIN;
await T.verificarLembretesSemAssumir();
ok(deNome("Fabi") === 1 && deNome("Joana") === joanaAntes, "reiniciou de novo: nenhum lembrete repetido");

out("\n== Encaminhamento automático com a loja fechada ==");
// Quarta 18:55 (aberta até 19h): a triagem começa aberta e o encaminhamento cai com a loja fechada.
desloc = Date.parse("2026-10-07T18:55:00-03:00") - agoraReal();
await falar(TEL(10), "oi");
await falar(TEL(10), "Gina");
await falar(TEL(10), "cimento");
ok((await falar(TEL(10), "10 sacos"))[0] === OBS, "observações perguntadas às 18:55");
desloc += 6 * MIN;
await verificar();
ok(recebeu(TEL(10)).at(-1) === `Vou passar seu pedido para um vendedor da loja, ${FECHADA}`, "observações sem resposta, loja já fechada: \"seu pedido\" + próximo horário");
desloc = Date.parse("2026-10-07T18:52:00-03:00") - agoraReal();
await falar(TEL(11), "oi");
ok((await falar(TEL(11), "Gina"))[0]?.endsWith(PRODUTO) === true, "produto perguntado às 18:52");
desloc += 11 * MIN;
await verificar();
ok(recebeu(TEL(11)).at(-1) === `Vou passar sua mensagem para um vendedor da loja, ${FECHADA}` && String(resumos().at(-1)?.corpo.text).startsWith("⚠️ Cliente parou de responder na etapa: produto"),
  "parou no produto, loja já fechada: \"sua mensagem\" + próximo horário, resumo com o aviso");

out("\n== Logs e rede ==");
ok(!logs.some((l) => ["Joana", "Wanda", "Bruna", "Carla", "Dora", "Elis", "Fabi", "Gina", "cheque", "tinta", "cimento"].some((t) => l.includes(t))), "nenhum log com dado do cliente");
ok(externas.length === 0, `nenhuma chamada de rede externa (${externas.length})`);

out("\n== Limpeza ==");
await espera(500);
const ev = (await banco.consultar("DELETE FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-encam-%'")).rowCount;
const { limparEspelhoDeTeste, limparVendedoresDeTeste } = await import(B + "/tests/limpeza-espelho.mts");
const espelho = await limparEspelhoDeTeste(banco.consultar);
await limparVendedoresDeTeste(banco.consultar, [VEND.id], new Date(0));
ok(espelho.restantes === 0, `apagados: ${ev} eventos, ${espelho.atendimentos} atendimentos, ${espelho.clientes} clientes; restantes = ${espelho.restantes}`);
await banco.encerrarBanco();

out(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
await new Promise((r) => setTimeout(r, 300));
process.exit(falhas ? 1 : 0);
