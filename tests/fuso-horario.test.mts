// Fuso: o servidor fica nos EUA. Horário de funcionamento, data do /fechar e ranking usam America/Belem
// explicitamente, qualquer que seja o fuso do processo (TZ) ou da sessão do PostgreSQL.
// Banco de testes (atendimento_teste). Chats "meta:999:55009000017xx", vendedor 990000000901.
// Banco de TESTES (atendimento_teste) fixado antes de qualquer import de src/; atendimento é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);

// O processo "nos EUA" (o Node relê process.env.TZ a cada mudança) e a sessão do PostgreSQL também
// (PGOPTIONS é lido pelo pg ao abrir cada conexão).
process.env.TZ = "America/New_York";
process.env.PGOPTIONS = "-c timezone=America/New_York";

const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const banco = await import(B + "/src/banco.ts");
await exigirBancoDeTeste(banco.consultar);
const horario = await import(B + "/src/horarioFuncionamento.ts");
const assuncao = await import(B + "/src/persistenciaAssuncao.ts");
const espelho = await import(B + "/src/persistenciaAtendimento.ts");

let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; console.log(`${c ? "OK  " : "FAIL"} ${t}`); };

console.log("== Horário de funcionamento e data local (processo em outros fusos) ==");
// Instantes em UTC e o que eles são em Belém (UTC-3, sem horário de verão).
const casos = [
  // 2026-10-08 03:30Z = quinta 08/10 00:30 em Belém (em Nova York ainda é quarta 07/10, 23:30).
  { iso: "2026-10-08T03:30:00Z", data: "2026-10-08", aberta: false, rotulo: "quinta 00:30 em Belém (quarta 23:30 em NY)" },
  // 2026-10-07 11:30Z = quarta 08:30 em Belém (07:30 em NY: em NY a loja estaria fechada).
  { iso: "2026-10-07T11:30:00Z", data: "2026-10-07", aberta: true, rotulo: "quarta 08:30 em Belém (07:30 em NY)" },
  // 2026-10-07 22:30Z = quarta 19:30 em Belém (18:30 em NY: em NY a loja estaria aberta).
  { iso: "2026-10-07T22:30:00Z", data: "2026-10-07", aberta: false, rotulo: "quarta 19:30 em Belém (18:30 em NY)" },
  // 2026-10-10 17:30Z = sábado 14:30 em Belém (aberta até 15:00).
  { iso: "2026-10-10T17:30:00Z", data: "2026-10-10", aberta: true, rotulo: "sábado 14:30 em Belém" },
  // 2026-10-10 18:30Z = sábado 15:30 em Belém (fechada).
  { iso: "2026-10-10T18:30:00Z", data: "2026-10-10", aberta: false, rotulo: "sábado 15:30 em Belém" },
];
for (const tz of ["America/New_York", "America/Los_Angeles", "Asia/Tokyo", "UTC"]) {
  process.env.TZ = tz;
  const certos = casos.filter((c) => {
    const t = Date.parse(c.iso);
    return horario.dataLocal(t) === c.data && horario.lojaAberta(t) === c.aberta;
  });
  ok(certos.length === casos.length, `TZ=${tz}: data e loja aberta/fechada pelo horário de Belém (${certos.length}/${casos.length})`);
}
process.env.TZ = "America/New_York";
horario.definirDiasFechados(["2026-10-08"]);
ok(!horario.lojaAberta(Date.parse("2026-10-08T13:00:00Z")) && horario.lojaAberta(Date.parse("2026-10-07T13:00:00Z")) &&
   horario.mensagemLojaFechada(Date.parse("2026-10-08T03:30:00Z")) === horario.MENSAGEM_DIA_FECHADO,
  "/fechar 08/10: vale de 00:00 a 23:59 de Belém (00:30 de Belém já é o dia fechado, mesmo sendo 07/10 em NY)");
horario.definirDiasFechados([]);

console.log("\n== Ranking com a sessão do PostgreSQL em Nova York ==");
const tzSessao = (await banco.consultar("SHOW TIME ZONE")).rows[0]?.TimeZone as string | undefined;
ok(tzSessao === "America/New_York", `sessão do banco em ${tzSessao}`);
// Início do mês atual em Belém; um atendimento assumido 30 min depois (conta no mês) e outro 30 min antes (mês anterior).
const inicioMes = (await banco.consultar(
  "SELECT date_trunc('month', now() AT TIME ZONE 'America/Belem') AT TIME ZONE 'America/Belem' AS t")).rows[0]!.t.getTime() as number;
const VEND = 990_000_000_901;
await banco.consultar("INSERT INTO vendedores (telegram_user_id, nome, telegram_chat_id, ativo) VALUES ($1, 'Teste Vendedor Fuso', $1, TRUE)", [VEND]);
for (const [n, assumidoEm] of [[1, inicioMes + 30 * 60_000], [2, inicioMes - 30 * 60_000]] as const) {
  const tel = `55009000017${String(n).padStart(2, "0")}`;
  const codigo = `ATD-0000F0500${n}`;
  await espelho.registrarAtividadeAtendimento({ codigo, chatId: `meta:999:${tel}`, telefone: tel, atividadeEm: assumidoEm, encerrado: false });
  await banco.consultar(
    `UPDATE atendimentos SET vendedor_id = (SELECT id FROM vendedores WHERE telegram_user_id = $2), assumido_em = $3, status = 'HUMANO',
       encerrado_em = $3, dm_status = 'ENVIADA', telegram_chat_id = '-1009999999999', telegram_message_id = $4, resumo_enviado_em = $3
     WHERE codigo = $1`, [codigo, VEND, new Date(assumidoEm), n]);
}
const ranking = await assuncao.consultarRanking();
const linha = ranking?.find((l: { nome: string }) => l.nome === "Teste Vendedor Fuso");
ok(linha?.mes === 1 && linha?.total === 2,
  `mês contado em Belém: 30 min depois do início do mês conta, 30 min antes não (mês ${linha?.mes}, total ${linha?.total})`);

console.log("\n== Limpeza ==");
const { limparEspelhoDeTeste, limparVendedoresDeTeste } = await import(B + "/tests/limpeza-espelho.mts");
const limpo = await limparEspelhoDeTeste(banco.consultar);
await limparVendedoresDeTeste(banco.consultar, [VEND], new Date(0));
const sobra = Number((await banco.consultar("SELECT count(*) n FROM vendedores WHERE telegram_user_id = $1", [VEND])).rows[0].n);
ok(limpo.restantes === 0 && sobra === 0, `apagados: ${limpo.atendimentos} atendimentos, ${limpo.clientes} clientes; restantes = ${limpo.restantes + sobra}`);
await banco.encerrarBanco();

console.log(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
process.exit(falhas ? 1 : 0);
