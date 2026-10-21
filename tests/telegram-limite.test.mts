// Banco de TESTES (atendimento_teste) fixado antes de qualquer import de src/; atendimento é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
process.env.TELEGRAM_BOT_TOKEN = "123456:TOKEN-FALSO-DE-TESTE";
process.env.TELEGRAM_CHAT_ID = "-1009999999999";
process.env.TELEGRAM_WEBHOOK_SECRET = "segredo-de-teste";
const GRUPO = -1009999999999;

// ---- Mock da Bot API: como a real, recusa texto acima de 4096 com 400 ----
type Chamada = { metodo: string; corpo: any };
let chamadas: Chamada[] = [];
let proximoMsgId = 100;
// Código forçado para o próximo sendMessage ao grupo (null = comportamento normal).
let codigoForcado: number | null = null;
// Descrição devolvida junto com o código forçado (como a da Bot API).
let descricaoForcada = "erro simulado";
// Administrador do grupo (fictício), grupo inacessível (getChatAdministrators recusado) e DMs recusadas.
const ADMIN = 990000000002;
let grupoInacessivel = false;
const dmRecusada = new Set<number>();
// Relógio ajustável (intervalo de 30 min do alerta).
const agoraReal = Date.now.bind(Date);
let desloc = 0;
Date.now = () => agoraReal() + desloc;
(globalThis as any).fetch = async (url: string, init: any) => {
  const m = /^https:\/\/api\.telegram\.org\/bot[^/]+\/(\w+)$/.exec(String(url));
  if (!m) throw new Error("chamada inesperada fora do Telegram: " + url);
  const corpo = JSON.parse(init.body);
  chamadas.push({ metodo: m[1]!, corpo });
  const json = (status: number, o: any) => ({ status, json: async () => o });
  if (m[1] === "getChatMember") return json(200, { ok: true, result: { status: corpo.user_id === ADMIN ? "administrator" : "member" } });
  if (m[1] === "getChatAdministrators") return grupoInacessivel
    ? json(403, { ok: false, error_code: 403, description: "Forbidden: bot was kicked from the supergroup chat" })
    : json(200, { ok: true, result: [{ status: "creator", user: { id: ADMIN, is_bot: false, first_name: "Admin" } }] });
  if (m[1] === "sendMessage" && dmRecusada.has(corpo.chat_id)) return json(403, { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
  if ((m[1] === "sendMessage" || m[1] === "editMessageText") && typeof corpo.text === "string" && corpo.text.length > 4096)
    return json(400, { ok: false, error_code: 400, description: "Bad Request: message is too long" });
  if (m[1] === "sendMessage" && String(corpo.chat_id) === String(GRUPO) && codigoForcado !== null)
    return json(codigoForcado, { ok: false, error_code: codigoForcado, description: descricaoForcada });
  if (m[1] === "sendMessage") return json(200, { ok: true, result: { message_id: proximoMsgId++, chat: { id: corpo.chat_id } } });
  return json(200, { ok: true, result: true });
};

const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const T = await import(B + "/src/telegramBot.ts");
const banco = await import(B + "/src/banco.ts");
await exigirBancoDeTeste(banco.consultar);
const limpeza = await import(B + "/tests/limpeza-espelho.mts");
const inicio = await limpeza.inicioDaExecucao(banco.consultar);
const logReal = console.log;
console.log = () => {};
const erros: string[] = [];
console.error = (...a: any[]) => erros.push(a.join(" "));

let falhas = 0;
const ok = (c: boolean, t: string) => { if (!c) falhas++; logReal(`${c ? "OK  " : "FAIL"} ${t}`); };
const paraGrupo = () => chamadas.filter((c) => c.metodo === "sendMessage" && String(c.corpo.chat_id) === String(GRUPO));
let upd = 1;
const VENDEDOR = 990000000001;
const start = () => T.processarUpdateTelegram({ update_id: upd++, message: { message_id: 1, chat: { id: VENDEDOR, type: "private" }, from: { id: VENDEDOR, first_name: "Vendedor Teste" }, text: "/start" } });
const clique = (atd: string, msgId: number) =>
  T.processarUpdateTelegram({ update_id: upd++, callback_query: { id: `cb${upd}`, from: { id: VENDEDOR, first_name: "x" }, data: `assumir:${atd}`, message: { message_id: msgId, chat: { id: GRUPO, type: "supergroup" } } } });
function reset() { T.redefinirEstadoTelegramParaTestes(); T.definirAoAssumirAtendimento(() => {}); chamadas = []; codigoForcado = null; erros.length = 0; grupoInacessivel = false; dmRecusada.clear(); }

const TEL = "5500900001234";
const longo = (base: string) => base.repeat(Math.ceil(6000 / base.length));
const resumoLongo = () => ({ nome: longo("Nome "), telefone: TEL, produto: longo("Produto 😀 "), quantidade: longo("12 "), observacoes: longo("😀") });

logReal("== Campos enormes: resumo e DM cabem no limite do Telegram ==");
reset(); await start();
const original = resumoLongo();
const copia = JSON.parse(JSON.stringify(original));
const enviado = await T.enviarResumoTelegram("ATD-00001A1A1A", `meta:999:${TEL}`, original, { avisoFalhaEnvio: true });
const textoGrupo: string = paraGrupo().at(-1)?.corpo.text ?? "";
ok(enviado === true && T.situacaoResumoTelegram("ATD-00001A1A1A") === "enviado", "resumo com campos de 6000 caracteres é aceito (antes: 400 e reenvio sem fim)");
ok(textoGrupo.length <= 4096 && textoGrupo.includes("… (cortado)") && textoGrupo.startsWith("⚠️"), `texto do grupo com ${textoGrupo.length} caracteres, campos marcados como cortados, aviso ⚠️ mantido`);
ok(/Telefone: 5500\*\*\*\*1234/.test(textoGrupo), "telefone continua só mascarado no grupo");
ok(JSON.stringify(original) === JSON.stringify(copia), "o resumo recebido não é alterado (memória e banco guardam o texto inteiro)");
ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(textoGrupo), "nenhum emoji partido ao meio");
await clique("ATD-00001A1A1A", proximoMsgId - 1);
const dm = chamadas.filter((c) => c.metodo === "sendMessage" && c.corpo.chat_id === VENDEDOR && String(c.corpo.text).startsWith("🔒")).at(-1);
ok(!!dm && dm.corpo.text.length <= 4096 && dm.corpo.text.includes(`Telefone: ${TEL}`) && String(dm.corpo.reply_markup?.inline_keyboard[0][0].url).startsWith(`https://wa.me/${TEL}?text=`),
  `DM com ${dm?.corpo.text.length ?? 0} caracteres, telefone inteiro e botão wa.me`);

logReal("\n== Campos curtos não mudam ==");
reset();
await T.enviarResumoTelegram("ATD-00002C2C2C", `meta:999:${TEL}`, { nome: "Cliente Teste", telefone: TEL, produto: "Cimento", quantidade: "10 sacos", observacoes: "Nenhuma observação adicional." });
ok(paraGrupo().at(-1)!.corpo.text === "📋 NOVO ATENDIMENTO\n\nNome: Cliente Teste\nTelefone: 5500****1234\nItens:\n• Cimento: 10 sacos\nObservações: Nenhuma observação adicional.", "texto no formato de itens (um item, uma linha)");

logReal("\n== cortarTexto ==");
ok(T.cortarTexto("abc", 10) === "abc", "texto dentro do limite volta igual");
const cortado = T.cortarTexto("x".repeat(19) + "😀" + "y".repeat(50), 31);
ok(cortado.length <= 31 && cortado === "x".repeat(19) + "… (cortado)", `corte que cairia no meio do emoji recua um (${JSON.stringify(cortado)})`);

logReal("\n== 4xx (exceto 429) no resumo: não repete ==");
for (const codigo of [400, 403]) {
  reset(); codigoForcado = codigo;
  const r = await T.enviarResumoTelegram(`ATD-0000${codigo}AAA`, `meta:999:${TEL}`, { nome: "Cliente Teste", telefone: TEL, produto: "Cimento", quantidade: "1", observacoes: "Não informado" });
  codigoForcado = null;
  await T.reenviarResumosTelegramPendentes();
  await T.reenviarResumosTelegramPendentes();
  await T.enviarResumoTelegram(`ATD-0000${codigo}AAA`, `meta:999:${TEL}`, { nome: "Cliente Teste", telefone: TEL, produto: "Cimento", quantidade: "1", observacoes: "Não informado" }, { avisoFalhaEnvio: true });
  ok(r === false && paraGrupo().length === 1 && T.situacaoResumoTelegram(`ATD-0000${codigo}AAA`) === "recusado",
    `${codigo}: uma tentativa só (${paraGrupo().length}), estado "recusado", ciclos e novos pedidos não reenviam`);
  ok(erros.some((e) => e.includes("ATENÇÃO") && e.includes(`RECUSADO pelo Telegram (código ${codigo})`)) && !erros.some((e) => e.includes("Cliente Teste") || e.includes(TEL)),
    `${codigo}: log em destaque com o código, sem dados do cliente`);
}

logReal("\n== 403 no resumo: alerta aos administradores no privado ==");
const ALERTA_GRUPO = "⚠️ O bot não consegue publicar no grupo de vendedores (sem permissão ou removido). Os resumos não estão chegando.";
const alertasGrupo = () => chamadas.filter((c) => c.metodo === "sendMessage" && c.corpo.text === ALERTA_GRUPO);
const startDe = (id: number) => T.processarUpdateTelegram({ update_id: upd++, message: { message_id: 1, chat: { id, type: "private" }, from: { id, first_name: "Teste" }, text: "/start" } });
const resumo403 = async (codigo: string) => {
  codigoForcado = 403;
  await T.enviarResumoTelegram(codigo, `meta:999:${TEL}`, { nome: "Cliente Teste", telefone: TEL, produto: "Cimento", quantidade: "1", observacoes: "Não informado" });
  codigoForcado = null;
  await T.aguardarAlertaGrupoParaTestes();
};
reset(); await startDe(ADMIN); await startDe(VENDEDOR);
await resumo403("ATD-0000403C01");
ok(alertasGrupo().length === 1 && alertasGrupo()[0]!.corpo.chat_id === ADMIN, "resumo recusado com 403: alerta no privado do administrador registrado");
ok(!alertasGrupo().some((c) => String(c.corpo.chat_id) === String(GRUPO) || c.corpo.chat_id === VENDEDOR), "nada no grupo nem para o vendedor comum");
ok(!JSON.stringify(alertasGrupo()).match(/5500|Cliente Teste|ATD-/), "alerta sem dado de cliente nem código");
await resumo403("ATD-0000403C02");
ok(alertasGrupo().length === 1 && erros.some((e) => e.includes("grupo de vendedores inacessível; alerta já enviado há menos de 30 min")), "outro 403 em menos de 30 min: só log");
desloc += 31 * 60_000;
grupoInacessivel = true; // bot removido: getChatAdministrators também recusa
await resumo403("ATD-0000403C03");
ok(alertasGrupo().length === 2 && alertasGrupo()[1]!.corpo.chat_id === ADMIN && erros.some((e) => e.includes("usando os 1 vistos por último")),
  "depois de 30 min, com o bot removido: alerta de novo aos administradores vistos por último");
desloc = 0;
reset(); grupoInacessivel = true; await startDe(VENDEDOR);
await resumo403("ATD-0000403C04");
ok(alertasGrupo().length === 0 && erros.some((e) => e.includes("[Alerta] ATENÇÃO: administradores do grupo não consultados; alerta não enviado.")),
  "nenhum administrador conhecido e grupo inacessível: só log em destaque");
reset(); await startDe(ADMIN); await startDe(VENDEDOR);
await T.enviarResumoTelegram("ATD-0000403C05", `meta:999:${TEL}`, { nome: "Cliente Teste", telefone: TEL, produto: "Cimento", quantidade: "1", observacoes: "Não informado" });
dmRecusada.add(VENDEDOR);
await clique("ATD-0000403C05", proximoMsgId - 1);
await T.aguardarAlertaGrupoParaTestes();
ok(alertasGrupo().length === 0 && chamadas.some((c) => c.metodo === "editMessageText" && /erro ao enviar a mensagem privada/.test(c.corpo.text)),
  "DM bloqueada por UM vendedor (403): sem alerta geral; o grupo mostra o aviso");

logReal("\n== 400 no resumo: alerta só quando o bot não pode publicar no grupo ==");
const resumo400 = async (codigo: string, descricao: string) => {
  codigoForcado = 400; descricaoForcada = descricao;
  await T.enviarResumoTelegram(codigo, `meta:999:${TEL}`, { nome: "Cliente Teste", telefone: TEL, produto: "Cimento", quantidade: "1", observacoes: "Não informado" });
  codigoForcado = null; descricaoForcada = "erro simulado";
  await T.aguardarAlertaGrupoParaTestes();
};
const DESCRICOES_ALERTA = [
  "Bad Request: not enough rights to send text messages to the chat",
  "Bad Request: chat not found",
  "Bad Request: have no rights to send a message",
  "Bad Request: CHAT_WRITE_FORBIDDEN",
  "Bad Request: group chat was upgraded to a supergroup chat",
];
for (const [i, descricao] of DESCRICOES_ALERTA.entries()) {
  reset(); await startDe(ADMIN);
  const codigo = `ATD-0000400D0${i}`;
  await resumo400(codigo, descricao);
  ok(alertasGrupo().length === 1 && alertasGrupo()[0]!.corpo.chat_id === ADMIN && T.situacaoResumoTelegram(codigo) === "recusado",
    `400 "${descricao}": alerta no privado do administrador; resumo "recusado"`);
  ok(!erros.some((e) => e.includes(descricao)), `400 "${descricao}": a descrição não vai para o log`);
}
reset(); await startDe(ADMIN);
await resumo400("ATD-0000400E01", "Bad Request: chat not found");
await resumo400("ATD-0000400E02", "Bad Request: not enough rights to send text messages to the chat");
ok(alertasGrupo().length === 1 && erros.some((e) => e.includes("alerta já enviado há menos de 30 min")), "dois 400 de permissão em menos de 30 min: um alerta só");
reset(); await startDe(ADMIN);
await resumo400("ATD-0000400F01", "Bad Request: can't parse entities: unsupported start tag");
ok(alertasGrupo().length === 0 && T.situacaoResumoTelegram("ATD-0000400F01") === "recusado" &&
   erros.some((e) => e.includes("ATD-0000400F01 RECUSADO pelo Telegram (código 400)")),
  "400 comum (texto inválido): sem alerta, só o log em destaque");

logReal("\n== 429, 5xx e rede: continua tentando ==");
for (const codigo of [429, 500, 502]) {
  reset(); codigoForcado = codigo;
  await T.enviarResumoTelegram(`ATD-0000${codigo}BBB`, `meta:999:${TEL}`, { nome: "Cliente Teste", telefone: TEL, produto: "Cimento", quantidade: "1", observacoes: "Não informado" });
  ok(T.situacaoResumoTelegram(`ATD-0000${codigo}BBB`) === "falhou", `${codigo}: estado "falhou" (passageiro)`);
  codigoForcado = null;
  await T.reenviarResumosTelegramPendentes();
  ok(paraGrupo().length === 2 && T.situacaoResumoTelegram(`ATD-0000${codigo}BBB`) === "enviado", `${codigo}: reenviado no ciclo seguinte e aceito`);
}
reset();
const fetchMock = (globalThis as any).fetch;
(globalThis as any).fetch = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); };
await T.enviarResumoTelegram("ATD-00000EDE00", `meta:999:${TEL}`, { nome: "Cliente Teste", telefone: TEL, produto: "Cimento", quantidade: "1", observacoes: "Não informado" });
(globalThis as any).fetch = fetchMock;
ok(T.situacaoResumoTelegram("ATD-00000EDE00") === "falhou", "erro de rede: \"falhou\" (passageiro)");
await T.reenviarResumosTelegramPendentes();
ok(T.situacaoResumoTelegram("ATD-00000EDE00") === "enviado", "erro de rede: reenviado no ciclo seguinte");

const vendedoresApagados = await limpeza.limparVendedoresDeTeste(banco.consultar, [VENDEDOR, ADMIN], inicio);
logReal(`limpeza: ${vendedoresApagados} vendedor(es) de teste apagado(s)`);
await banco.encerrarBanco();
logReal(falhas ? `\n${falhas} FALHA(S)` : "\nTODOS OS TESTES PASSARAM");
process.exit(falhas ? 1 : 0);
