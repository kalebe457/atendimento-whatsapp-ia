// Aviso de falha de serviço do servidor (systemd OnFailure= → node dist/alertarAdmins.js <unidade>):
// vai SÓ no privado dos administradores do grupo registrados na tabela vendedores; nunca no grupo,
// nunca para membro comum ou admin sem registro; nome da unidade saneado; nenhum dado de cliente.
// Banco de testes; Telegram simulado; rede externa bloqueada. Vendedores 9900000006xx.
// Banco de TESTES (atendimento_teste) fixado antes de qualquer import de src/; atendimento é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);

Object.assign(process.env, {
  TELEGRAM_BOT_TOKEN: "123456:TOKEN-FALSO",
  TELEGRAM_CHAT_ID: "-1009999999999",
  TELEGRAM_WEBHOOK_SECRET: "segredo-teste-alerta",
});
const GRUPO = "-1009999999999";
const ADMIN = 990_000_000_601, ADMIN_SEM_REGISTRO = 990_000_000_602, MEMBRO = 990_000_000_603, BOT = 990_000_000_604;

const telegram: { metodo: string; corpo: any }[] = [];
const externas: string[] = [];
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = new URL(String(url));
  const m = /^\/bot[^/]+\/(\w+)$/.exec(u.pathname);
  if (u.hostname === "api.telegram.org" && m) {
    const corpo = JSON.parse(init.body);
    telegram.push({ metodo: m[1]!, corpo });
    const r = (o: any) => ({ status: o.ok ? 200 : 400, json: async () => o });
    if (m[1] === "getChatAdministrators") {
      return r({ ok: true, result: [
        { status: "creator", user: { id: ADMIN, is_bot: false } },
        { status: "administrator", user: { id: ADMIN_SEM_REGISTRO, is_bot: false } },
        { status: "administrator", user: { id: BOT, is_bot: true } },
      ] });
    }
    if (m[1] === "sendMessage") return r({ ok: true, result: { message_id: 1, chat: { id: Number(corpo.chat_id) } } });
    return r({ ok: true, result: true });
  }
  externas.push(u.hostname);
  throw new Error("rede externa bloqueada no teste");
};

const logs: string[] = [];
const out = console.log.bind(console);
for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => { logs.push(a.join(" ")); };

let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; out(`${c ? "OK  " : "FAIL"} ${t}`); };

const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const banco = await import(B + "/src/banco.ts");
await exigirBancoDeTeste(banco.consultar);
const { alertarAdministradoresDoServidor, textoFalhaServico } = await import(B + "/src/alertaServidor.ts");

for (const [id, ativo] of [[ADMIN, true], [MEMBRO, true], [BOT, true]] as const) {
  await banco.consultar("INSERT INTO vendedores (telegram_user_id, nome, telegram_chat_id, ativo) VALUES ($1, 'Teste Alerta', $1, $2)", [id, ativo]);
}

out("== Texto ==");
const texto = textoFalhaServico("atendimento-backup.service");
ok(texto === "⚠️ Servidor da loja Exemplo Materiais de Construção: o serviço atendimento-backup.service falhou.\nDetalhes no servidor: sudo journalctl -u atendimento-backup.service -n 50", "nome da unidade e o comando do log");
ok(textoFalhaServico("x; rm -rf / $(id)").includes("o serviço desconhecido falhou"), "nome fora do formato de unidade: \"desconhecido\"");

out("\n== Envio ==");
const enviados = await alertarAdministradoresDoServidor(texto);
const dms = telegram.filter((c) => c.metodo === "sendMessage");
ok(enviados === 1 && dms.length === 1 && dms[0]!.corpo.chat_id === ADMIN && dms[0]!.corpo.text === texto,
  "só o administrador registrado recebe, no privado");
ok(!dms.some((c) => String(c.corpo.chat_id) === GRUPO || [MEMBRO, ADMIN_SEM_REGISTRO, BOT].includes(c.corpo.chat_id)),
  "nada no grupo, nem para membro comum, admin sem registro ou bot");

out("\n== Ninguém alcançável ==");
await banco.consultar("UPDATE vendedores SET ativo = FALSE WHERE telegram_user_id = $1", [ADMIN]);
telegram.length = 0;
// O comando roda uma vez por processo: zera a memória do Telegram como num processo novo.
(await import(B + "/src/telegramBot.ts")).redefinirEstadoTelegramParaTestes();
const nenhum = await alertarAdministradoresDoServidor(texto);
ok(nenhum === 0 && !telegram.some((c) => c.metodo === "sendMessage") && logs.some((l) => l.includes("[Alerta] ATENÇÃO: nenhum administrador alcançável")),
  "admin desativado: ninguém recebe, log em destaque (o comando sai com 1)");
ok(externas.length === 0, `nenhuma chamada de rede externa (${externas.length})`);

out("\n== Limpeza ==");
const apagados = (await banco.consultar("DELETE FROM vendedores WHERE telegram_user_id = ANY($1::bigint[])", [[ADMIN, MEMBRO, BOT]])).rowCount;
ok(apagados === 3, `apagados: ${apagados} vendedores de teste`);
await banco.encerrarBanco();

out(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
await new Promise((r) => setTimeout(r, 300));
process.exit(falhas ? 1 : 0);
