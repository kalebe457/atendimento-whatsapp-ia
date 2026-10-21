// /ajuda (vendedor x administrador), /start sugerindo o /ajuda e o menu de comandos (setMyCommands /
// deleteMyCommands). Bot API simulada; updates chamados direto em processarUpdateTelegram (nenhum webhook).
// Banco de testes (atendimento_teste); vendedores 9900000009xx.
// Banco de TESTES (atendimento_teste) fixado antes de qualquer import de src/; atendimento é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
import { readFileSync } from "node:fs";
process.env.TELEGRAM_BOT_TOKEN = "123456:TOKEN-FALSO-DE-TESTE";
process.env.TELEGRAM_CHAT_ID = "-1009999999999";
process.env.TELEGRAM_WEBHOOK_SECRET = "segredo-de-teste";
const GRUPO = -1009999999999;

const VEND = { id: 990_000_000_901, first_name: "Vera", last_name: "Teste" };
const ADMIN = { id: 990_000_000_902, first_name: "Alan", last_name: "Teste" };
const FORA = { id: 990_000_000_903, first_name: "Fora", last_name: "Teste" };
const ERRO = { id: 990_000_000_904, first_name: "Erro", last_name: "Teste" };
const STATUS: Record<number, string> = { [VEND.id]: "member", [ADMIN.id]: "administrator", [FORA.id]: "left" };

type Chamada = { metodo: string; corpo: any };
let chamadas: Chamada[] = [];
let menuFalha = false;
(globalThis as any).fetch = async (url: string, init: any) => {
  const m = /^https:\/\/api\.telegram\.org\/bot[^/]+\/(\w+)$/.exec(String(url));
  if (!m) throw new Error("chamada inesperada fora do Telegram: " + url);
  const corpo = JSON.parse(init.body);
  chamadas.push({ metodo: m[1]!, corpo });
  const json = (status: number, o: any) => ({ status, json: async () => o });
  if (m[1] === "getChatMember") {
    const st = STATUS[corpo.user_id];
    return st ? json(200, { ok: true, result: { status: st } }) : json(400, { ok: false, error_code: 400, description: "simulado" });
  }
  if ((m[1] === "setMyCommands" || m[1] === "deleteMyCommands") && menuFalha) return json(400, { ok: false, error_code: 400, description: "simulado" });
  if (m[1] === "sendMessage") return json(200, { ok: true, result: { message_id: 1, chat: { id: corpo.chat_id } } });
  return json(200, { ok: true, result: true });
};

const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const T = await import(B + "/src/telegramBot.ts");
const banco = await import(B + "/src/banco.ts");
await exigirBancoDeTeste(banco.consultar);
const limpeza = await import(B + "/tests/limpeza-espelho.mts");
const inicio = await limpeza.inicioDaExecucao(banco.consultar);
const logReal = console.log;
const logs: string[] = [];
for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => { logs.push(a.join(" ")); };

let falhas = 0;
const ok = (c: boolean, t: string) => { if (!c) falhas++; logReal(`${c ? "OK  " : "FAIL"} ${t}`); };
let upd = 1;
async function privado(v: typeof VEND, texto: string, tipo: "private" | "supergroup" = "private") {
  chamadas = [];
  await T.processarUpdateTelegram({ update_id: upd++, message: { message_id: 1, chat: { id: tipo === "private" ? v.id : GRUPO, type: tipo }, from: v, text: texto } });
  return {
    resposta: chamadas.filter((c) => c.metodo === "sendMessage" && c.corpo.chat_id === v.id).at(-1)?.corpo.text as string | undefined,
    menus: chamadas.filter((c) => c.metodo === "setMyCommands" || c.metodo === "deleteMyCommands"),
  };
}
T.redefinirEstadoTelegramParaTestes();

logReal("== /ajuda do vendedor ==");
const v = await privado(VEND, "/ajuda");
ok(v.resposta === T.textoAjuda(false), "membro do grupo: texto de vendedor");
ok(v.resposta!.includes("/ajuda") && v.resposta!.includes("ASSUMIR") && /privado/.test(v.resposta!) && /cliente recebe um aviso/.test(v.resposta!),
  "cita /ajuda e explica o ASSUMIR (privado e aviso ao cliente)");
ok(["/ranking", "/fechar", "/abrir", "/fechamentos", "/abrir_agora", "/cancelar_abertura"].every((c) => !v.resposta!.includes(c)), "nenhum comando de administrador (nem /ranking)");
ok(v.menus.length === 1 && v.menus[0]!.metodo === "deleteMyCommands" && v.menus[0]!.corpo.scope.type === "chat" && v.menus[0]!.corpo.scope.chat_id === VEND.id,
  "menu: escopo do chat do vendedor apagado (fica o menu do privado de todos)");

logReal("\n== /ajuda do administrador ==");
const a = await privado(ADMIN, "/ajuda");
ok(a.resposta === T.textoAjuda(true) && a.resposta!.startsWith(T.textoAjuda(false)), "administrador: texto de vendedor + comandos de administrador");
ok(["/ranking", "/fechar [DD/MM]", "/abrir [DD/MM]", "/fechamentos", "/abrir_agora [minutos]", "/cancelar_abertura", "Ex.: /fechar 25/12", "Ex.: /abrir 25/12", "Ex.: /abrir_agora 90"].every((t) => a.resposta!.includes(t)),
  "comandos de administrador com exemplos");
const menuAdmin = a.menus[0];
ok(a.menus.length === 1 && menuAdmin!.metodo === "setMyCommands" && menuAdmin!.corpo.scope.type === "chat" && menuAdmin!.corpo.scope.chat_id === ADMIN.id &&
   JSON.stringify(menuAdmin!.corpo.commands.map((c: any) => c.command)) === JSON.stringify(["ajuda", "ranking", "fechar", "abrir", "fechamentos", "abrir_agora", "cancelar_abertura"]),
  "menu completo no chat privado do administrador");
ok(menuAdmin!.corpo.commands.every((c: any) => /^[a-z0-9_]{1,32}$/.test(c.command) && c.description.length >= 1 && c.description.length <= 256), "comandos e descrições no formato do Telegram");

logReal("\n== Quem não pode ==");
const f = await privado(FORA, "/ajuda");
ok(f.resposta === "Você não faz parte da equipe de vendedores da loja Exemplo Materiais de Construção." && f.menus.length === 0, "fora do grupo: recusado, sem mexer no menu");
const e = await privado(ERRO, "/ajuda");
ok(e.resposta === "Não consegui verificar sua participação na equipe agora. Tente novamente em instantes." && e.menus.length === 0, "falha ao verificar: mensagem de erro técnico");
const g = await privado(ADMIN, "/ajuda", "supergroup");
ok(chamadas.length === 0 && g.resposta === undefined, "/ajuda no grupo: ignorado (nenhuma chamada)");

logReal("\n== /start sugere o /ajuda ==");
const sv = await privado(VEND, "/start");
ok(sv.resposta === "✅ Você está registrado para assumir atendimentos da loja Exemplo Materiais de Construção. Envie /ajuda para ver os comandos." && sv.menus.length === 0, "vendedor: termina sugerindo /ajuda; menu não muda");
const sa = await privado(ADMIN, "/start");
ok(sa.resposta?.endsWith("Envie /ajuda para ver os comandos.") === true && sa.menus.length === 1 && sa.menus[0]!.corpo.scope.chat_id === ADMIN.id && sa.menus[0]!.metodo === "setMyCommands",
  "administrador: o /start já define o menu completo no privado dele");

logReal("\n== Menu do boot ==");
chamadas = [];
await T.registrarMenuComandos();
const boot1 = JSON.stringify(chamadas);
chamadas = [];
await T.registrarMenuComandos();
ok(boot1 === JSON.stringify(chamadas), "idempotente: as mesmas chamadas a cada boot");
const menus = JSON.parse(boot1) as Chamada[];
ok(menus.length === 2 && menus.every((c) => c.metodo === "setMyCommands") &&
   menus[0]!.corpo.scope.type === "all_group_chats" && menus[0]!.corpo.commands.length === 0 &&
   menus[1]!.corpo.scope.type === "all_private_chats" && JSON.stringify(menus[1]!.corpo.commands.map((c: any) => c.command)) === JSON.stringify(["ajuda"]),
  "grupos: lista vazia; privado de todos: só /ajuda");
ok(!menus.some((c) => c.corpo.scope.type === "chat_administrators" || c.corpo.scope.type === "all_chat_administrators"), "nenhum escopo de administradores do grupo");
menuFalha = true;
logs.length = 0;
let lancou = false;
try { await T.registrarMenuComandos(); await privado(ADMIN, "/ajuda"); } catch { lancou = true; }
menuFalha = false;
ok(!lancou && logs.filter((l) => l.startsWith("[Telegram] aviso: menu de comandos")).length === 3, "falha no setMyCommands/deleteMyCommands: só aviso no log, nada quebra");

logReal("\n== A ajuda cita todos os comandos tratados ==");
const fonte = readFileSync(new URL("../src/telegramBot.ts", import.meta.url), "utf8");
const tratados = new Set<string>();
for (const m of fonte.matchAll(/\/\^\\\/\(?([a-z_|]+)\)?\(\?:@\\w\+\)\?/g)) for (const c of m[1]!.split("|")) tratados.add(c);
ok(tratados.size >= 8 && ["start", "ajuda", "ranking", "fechar", "abrir", "fechamentos", "abrir_agora", "cancelar_abertura"].every((c) => tratados.has(c)),
  `comandos tratados em processarUpdateTelegram: ${[...tratados].join(", ")}`);
const ajudaAdmin = T.textoAjuda(true);
ok([...tratados].every((c) => new RegExp(`/${c}(?![a-z_])`).test(ajudaAdmin)), "a ajuda do administrador cita todos eles");
ok([...tratados].filter((c) => c !== "start").every((c) => menuAdmin!.corpo.commands.some((m: any) => m.command === c)), "e o menu do administrador tem todos (menos o /start)");

const apagados = await limpeza.limparVendedoresDeTeste(banco.consultar, [VEND.id, ADMIN.id], inicio);
logReal(`limpeza: ${apagados} vendedor(es) de teste apagado(s)`);
await banco.encerrarBanco();
logReal(falhas ? `\n${falhas} FALHA(S)` : "\nTODOS OS TESTES PASSARAM");
process.exit(falhas ? 1 : 0);
