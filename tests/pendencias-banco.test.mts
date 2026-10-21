// B3: gravações do Telegram que falharam no banco (vendedor do /start, resumo publicado, assunção e DM)
// ficam pendentes na memória e são regravadas depois (a cada minuto no servidor; aqui chamadas direto).
// Banco de testes (atendimento_teste); falha de banco simulada no pool.connect. Telegram simulado.
// Chats "meta:999:55009000014xx", vendedores 9900000005xx.
// Banco de TESTES (atendimento_teste) fixado antes de qualquer import de src/; atendimento é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
process.env.TELEGRAM_BOT_TOKEN = "123456:TOKEN-FALSO-DE-TESTE";
process.env.TELEGRAM_CHAT_ID = "-1009999999999";
process.env.TELEGRAM_WEBHOOK_SECRET = "segredo-de-teste";
const GRUPO = -1009999999999;

// ---- Bot API simulada ----
type Chamada = { metodo: string; corpo: any };
let chamadas: Chamada[] = [];
let proximoMsgId = 500;
const falharDMPara = new Set<number>();
(globalThis as any).fetch = async (url: string, init: any) => {
  const m = /^https:\/\/api\.telegram\.org\/bot[^/]+\/(\w+)$/.exec(String(url));
  if (!m) throw new Error("chamada inesperada fora do Telegram: " + url);
  const corpo = JSON.parse(init.body);
  chamadas.push({ metodo: m[1]!, corpo });
  const json = (status: number, o: any) => ({ status, json: async () => o });
  if (m[1] === "getChatMember") return json(200, { ok: true, result: { status: "member" } });
  if (m[1] === "sendMessage" && falharDMPara.has(corpo.chat_id)) return json(403, { ok: false, error_code: 403, description: "Forbidden" });
  if (m[1] === "sendMessage") return json(200, { ok: true, result: { message_id: proximoMsgId++, chat: { id: corpo.chat_id } } });
  return json(200, { ok: true, result: true });
};

const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const T = await import(B + "/src/telegramBot.ts");
const banco = await import(B + "/src/banco.ts");
await exigirBancoDeTeste(banco.consultar);
const espelho = await import(B + "/src/persistenciaAtendimento.ts");
const logReal = console.log;
const logs: string[] = [];
for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => { logs.push(a.join(" ")); };

let falhas = 0;
const ok = (c: boolean, t: string) => { if (!c) falhas++; logReal(`${c ? "OK  " : "FAIL"} ${t}`); };
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

const pool = banco.obterPool();
const connectOriginal = pool.connect.bind(pool);
const bancoFora = () => { (pool as any).connect = (...a: unknown[]) => (a.length === 0 ? Promise.reject(Object.assign(new Error("conexão recusada (simulada)"), { code: "ECONNREFUSED" })) : (connectOriginal as any)(...a)); };
const bancoVolta = () => { (pool as any).connect = connectOriginal; };

const previos = Number((await banco.consultar("SELECT count(*) n FROM atendimentos WHERE chat_id LIKE 'meta:999:%'")).rows[0].n);
if (previos !== 0) { logReal(`ABORTADO: já existem ${previos} atendimentos de teste (meta:999:)`); process.exit(1); }

const V1 = 990_000_000_501, V2 = 990_000_000_502;
let upd = 1;
const start = (id: number, nome: string) => T.processarUpdateTelegram({ update_id: upd++, message: { message_id: 1, chat: { id, type: "private" }, from: { id, first_name: nome }, text: "/start" } });
const clique = (id: number, nome: string, codigo: string, msg: number) =>
  T.processarUpdateTelegram({ update_id: upd++, callback_query: { id: `cb-pend-${upd}`, from: { id, first_name: nome }, data: `assumir:${codigo}`, message: { message_id: msg, chat: { id: GRUPO, type: "supergroup" } } } });
type Linha = { vendedor_id: string | null; v_user: string | null; dm_status: string | null; telegram_message_id: string | null; resumo_enviado_em: Date | null; assumido_em: Date | null };
const linha = async (codigo: string): Promise<Linha | undefined> => (await banco.consultar(
  `SELECT a.vendedor_id, v.telegram_user_id::text v_user, a.dm_status, a.telegram_message_id::text, a.resumo_enviado_em, a.assumido_em
     FROM atendimentos a LEFT JOIN vendedores v ON v.id = a.vendedor_id WHERE a.codigo = $1`, [codigo])).rows[0];
const vendedorNoBanco = async (id: number) => (await banco.consultar("SELECT nome FROM vendedores WHERE telegram_user_id = $1", [id])).rows[0];
let n = 0;
async function novoAtendimento() {
  const tel = `55009000014${String(++n).padStart(2, "0")}`;
  const codigo = `ATD-00000B3${String(n).padStart(3, "0")}`;
  await espelho.registrarAtividadeAtendimento({ codigo, chatId: `meta:999:${tel}`, telefone: tel, atividadeEm: Date.now(), encerrado: false });
  return { codigo, tel };
}
const resumo = (tel: string) => ({ nome: "Cliente Teste", telefone: tel, produto: "Cimento", quantidade: "1", observacoes: "Não informado" });

T.redefinirEstadoTelegramParaTestes();
T.definirAoAssumirAtendimento(() => {});

logReal("== Banco fora: /start, resumo, assunção e DM ficam pendentes ==");
const A = await novoAtendimento();
bancoFora();
await start(V1, "Teste Vendedor Pend Um");
await T.enviarResumoTelegram(A.codigo, `meta:999:${A.tel}`, resumo(A.tel));
const msgA = proximoMsgId - 1;
const resumoEm = Date.now();
await espera(1100);
await clique(V1, "Teste Vendedor Pend Um", A.codigo, msgA);
const assumidoEm = Date.now();
ok(T.quantasPendenciasBanco() === 4, `4 gravações pendentes (vendedor, resumo, assunção, DM): ${T.quantasPendenciasBanco()}`);
ok(logs.some((l) => l.includes(`assunção de ${A.codigo} pendente no banco; nova tentativa a cada minuto`)) &&
   logs.some((l) => /vendedor 9900\*\*\*\*0501 pendente no banco/.test(l)) && !logs.some((l) => l.includes(String(V1)) || l.includes(A.tel)),
  "log de pendência sem dado pessoal (user_id mascarado)");
const nada = await linha(A.codigo);
ok(nada?.vendedor_id === null && nada?.telegram_message_id === null && (await vendedorNoBanco(V1)) === undefined, "nada gravado no banco (ainda)");

logReal("\n== Banco ainda fora: a rodada para na primeira falha ==");
const tentativas0 = logs.filter((l) => l.includes("[Persistência] falha ao")).length;
ok((await T.regravarPendenciasBanco()) === 0 && T.quantasPendenciasBanco() === 4, "nada regravado; as 4 continuam pendentes");
ok(logs.filter((l) => l.includes("[Persistência] falha ao")).length === tentativas0 + 1, "uma tentativa só nessa rodada (sem repetir a falha 4 vezes)");

logReal("\n== Banco de volta: tudo regravado, com o horário real ==");
await espera(1100);
bancoVolta();
const gravadas = await T.regravarPendenciasBanco();
const la = await linha(A.codigo);
ok(gravadas === 3 && T.quantasPendenciasBanco() === 0, `vendedor, resumo e assunção regravados (a DM vai junto com a assunção); nenhuma pendente (${gravadas})`);
ok((await vendedorNoBanco(V1))?.nome === "Teste Vendedor Pend Um", "vendedor do /start gravado");
ok(la?.v_user === String(V1) && la?.telegram_message_id === String(msgA) && la?.dm_status === "ENVIADA", "assunção, resumo e DM ENVIADA gravados");
const difAss = Math.abs((la?.assumido_em?.getTime() ?? 0) - assumidoEm), difRes = Math.abs((la?.resumo_enviado_em?.getTime() ?? 0) - resumoEm);
ok(difAss < 1000 && difRes < 1000, `assumido_em e resumo_enviado_em com o horário real, não o da regravação (diferenças ${difAss} e ${difRes} ms)`);
ok((await T.regravarPendenciasBanco()) === 0, "rodada seguinte: nada a fazer");

logReal("\n== Banco já tem OUTRO vendedor: a pendência é descartada ==");
const C = await novoAtendimento();
await T.enviarResumoTelegram(C.codigo, `meta:999:${C.tel}`, resumo(C.tel));
const msgC = proximoMsgId - 1;
bancoFora();
await clique(V1, "Teste Vendedor Pend Um", C.codigo, msgC);
bancoVolta();
await banco.consultar(`INSERT INTO vendedores (telegram_user_id, nome, telegram_chat_id, ativo) VALUES ($1, 'Teste Vendedor Pend Dois', $1, TRUE)`, [V2]);
await banco.consultar(`UPDATE atendimentos SET vendedor_id = (SELECT id FROM vendedores WHERE telegram_user_id = $2), assumido_em = now(), status = 'HUMANO',
  encerrado_em = COALESCE(encerrado_em, now()), dm_status = 'FALHOU' WHERE codigo = $1`, [C.codigo, V2]);
await T.regravarPendenciasBanco();
const lc = await linha(C.codigo);
ok(lc?.v_user === String(V2) && lc?.dm_status === "FALHOU" && T.quantasPendenciasBanco() === 0,
  "o banco continua com o outro vendedor e a DM dele intacta; nenhuma pendência sobra");
ok(logs.some((l) => l.includes(`[Persistência] ATENÇÃO: ${C.codigo}: o banco já registra OUTRO vendedor`)), "conflito logado em destaque");

logReal("\n== Gravação mais nova vence a pendente ==");
const D = await novoAtendimento();
await T.enviarResumoTelegram(D.codigo, `meta:999:${D.tel}`, resumo(D.tel));
falharDMPara.add(V1);
await clique(V1, "Teste Vendedor Pend Um", D.codigo, proximoMsgId - 1);
falharDMPara.delete(V1);
bancoFora();
// Força uma falha de banco no FALHOU: grava de novo pelo mesmo caminho (reenvio pelo /start falhando a DM).
falharDMPara.add(V1);
await start(V1, "Teste Vendedor Pend Um");
falharDMPara.delete(V1);
bancoVolta();
ok(T.quantasPendenciasBanco() === 2, `pendentes: vendedor e DM FALHOU (${T.quantasPendenciasBanco()})`);
await start(V1, "Teste Vendedor Pend Um"); // banco de volta: DM reenviada e ENVIADA gravada direto
ok(T.quantasPendenciasBanco() === 0 && (await linha(D.codigo))?.dm_status === "ENVIADA", "gravação direta bem-sucedida apaga a pendente");
await T.regravarPendenciasBanco();
ok((await linha(D.codigo))?.dm_status === "ENVIADA", "a regravação não volta o FALHOU antigo");

logReal("\n== Validade de 24 h ==");
bancoFora();
await start(V1, "Teste Vendedor Pend Um");
bancoVolta();
ok(T.quantasPendenciasBanco() === 1, "1 pendente");
await T.regravarPendenciasBanco(Date.now() + 25 * 60 * 60_000);
ok(T.quantasPendenciasBanco() === 0 && logs.some((l) => l.includes("[Persistência] ATENÇÃO: vendedor 9900****0501 não gravado no banco em 24 h; desistindo")), "descartada com log em destaque");

logReal("\n== Reinício (memória zerada) ==");
bancoFora();
await start(V1, "Teste Vendedor Pend Um");
bancoVolta();
T.redefinirEstadoTelegramParaTestes();
ok(T.quantasPendenciasBanco() === 0, "pendências se perdem num reinício (limitação conhecida)");

const { limparEspelhoDeTeste, limparVendedoresDeTeste } = await import(B + "/tests/limpeza-espelho.mts");
const limpo = await limparEspelhoDeTeste(banco.consultar);
await limparVendedoresDeTeste(banco.consultar, [V1, V2], new Date(0));
const sobraV = Number((await banco.consultar("SELECT count(*) n FROM vendedores WHERE telegram_user_id = ANY($1::bigint[])", [[V1, V2]])).rows[0].n);
ok(limpo.restantes === 0 && sobraV === 0, `limpeza: ${limpo.atendimentos} atendimentos, ${limpo.clientes} clientes; restantes = ${limpo.restantes + sobraV}`);
await banco.encerrarBanco();
logReal(falhas ? `\n${falhas} FALHA(S)` : "\nTODOS OS TESTES PASSARAM");
process.exit(falhas ? 1 : 0);
