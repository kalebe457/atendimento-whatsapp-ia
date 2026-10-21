// scripts/ver-atendimentos.mts: listagem, filtros, conversa, telefone mascarado e só leitura.
// Banco de testes (atendimento_teste). Chats "meta:999:55009000020xx", vendedor 990000000701.
// Banco de TESTES (atendimento_teste) fixado antes de qualquer import de src/; atendimento é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const raiz = fileURLToPath(new URL("..", import.meta.url));
const banco = await import(B + "/src/banco.ts");
await exigirBancoDeTeste(banco.consultar);
const espelho = await import(B + "/src/persistenciaAtendimento.ts");
const V = await import(B + "/scripts/ver-atendimentos.mts");

const logReal = console.log;
console.log = () => {};
let falhas = 0;
const ok = (c: boolean, t: string) => { if (!c) falhas++; logReal(`${c ? "OK  " : "FAIL"} ${t}`); };

const previos = Number((await banco.consultar("SELECT count(*) n FROM atendimentos WHERE chat_id LIKE 'meta:999:%'")).rows[0].n);
if (previos !== 0) { logReal(`ABORTADO: já existem ${previos} atendimentos de teste (meta:999:)`); process.exit(1); }

// ---- Dados de teste ----
const TEL = (n: number) => `55009000020${String(n).padStart(2, "0")}`;
const COD = (n: number) => `ATD-00000AB00${n}`;
const VEND = 990_000_000_701;
await banco.consultar("INSERT INTO vendedores (telegram_user_id, nome, telegram_chat_id, ativo) VALUES ($1, 'Paulo 🔥 Teste', $1, TRUE)", [VEND]);
let base = Date.now() - 60 * 60_000;
async function atendimento(n: number, msgs: ("E" | "S")[]) {
  await espelho.registrarAtividadeAtendimento({ codigo: COD(n), chatId: `meta:999:${TEL(n)}`, telefone: TEL(n), atividadeEm: Date.now(), encerrado: false });
  const id = (await banco.consultar("SELECT id FROM atendimentos WHERE codigo = $1", [COD(n)])).rows[0].id;
  let t = (base += 60_000);
  for (const [i, d] of msgs.entries()) {
    await banco.consultar("INSERT INTO mensagens (atendimento_id, direcao, canal, texto, criado_em) VALUES ($1, $2, 'META', $3, $4)",
      [id, d === "E" ? "ENTRADA" : "SAIDA", d === "E" ? `cliente ${n}.${i} cimento` : `ia ${n}.${i} qual o seu nome?`, new Date((t += 1000))]);
  }
  return { id, ultimo: t };
}
// 1: IA em andamento, curto (1 do cliente).
await atendimento(1, ["E", "S"]);
// 2: encerrado por inatividade, 2 do cliente.
await atendimento(2, ["E", "S", "E", "S"]);
await banco.consultar("UPDATE atendimentos SET encerrado_em = now() WHERE codigo = $1", [COD(2)]);
// 3: HUMANO sem assumir, resposta não chegou (última antes do resumo é do cliente) → ⚠️.
const a3 = await atendimento(3, ["E", "S", "E", "S", "E"]);
await banco.consultar(`UPDATE atendimentos SET status = 'HUMANO', nome = 'Cliente Três', produto = 'cimento', quantidade = '10 sacos',
  telegram_chat_id = -1009999999999, telegram_message_id = 1, resumo_enviado_em = $2 WHERE codigo = $1`, [COD(3), new Date(a3.ultimo + 500)]);
// 4: assumido; a IA respondeu antes do resumo (sem ⚠️).
const a4 = await atendimento(4, ["E", "S", "E", "S", "E", "S"]);
await banco.consultar(`UPDATE atendimentos SET status = 'HUMANO', vendedor_id = (SELECT id FROM vendedores WHERE telegram_user_id = $2), assumido_em = $3,
  encerrado_em = $3, dm_status = 'ENVIADA', telegram_chat_id = -1009999999999, telegram_message_id = 2, resumo_enviado_em = $3 WHERE codigo = $1`,
  [COD(4), VEND, new Date(a4.ultimo + 500)]);
// 5: de 3 dias atrás, sem mensagens.
await atendimento(5, []);
await banco.consultar("UPDATE atendimentos SET criado_em = now() - interval '3 days' WHERE codigo = $1", [COD(5)]);

const leitura = await V.conectarSomenteLeitura();
const consultar = (sql: string, params?: unknown[]) => leitura.query(sql, params);
const rodar = async (...args: string[]) => (await V.executar(consultar, args));
const linhaDe = (linhas: string[], n: number) => linhas.find((l) => l.startsWith(COD(n)));
const codigos = (linhas: string[]) => linhas.map((l) => l.split(" | ")[0]).filter((c) => /^ATD-00000AB00\d$/.test(c ?? ""));

logReal("== Listagem ==");
const lista = (await rodar()).linhas;
ok(JSON.stringify(codigos(lista)) === JSON.stringify([COD(4), COD(3), COD(2), COD(1), COD(5)]), `mais novos primeiro: ${codigos(lista).join(", ")}`);
ok(/\| \d{2}\/\d{2} \d{2}:\d{2} \|/.test(linhaDe(lista, 1) ?? ""), "data/hora (Belém) na linha");
ok(linhaDe(lista, 1)!.includes("IA (em andamento)") && linhaDe(lista, 1)!.includes("2 msg (1 do cliente)"), "1: IA em andamento, contagem de mensagens");
ok(linhaDe(lista, 2)!.includes("encerrado por inatividade"), "2: encerrado por inatividade");
ok(linhaDe(lista, 3)!.includes("HUMANO (sem assumir)") && linhaDe(lista, 3)!.includes("⚠️ falha de envio (provável)"), "3: HUMANO sem assumir, com ⚠️");
ok(linhaDe(lista, 4)!.includes("HUMANO (assumido)") && linhaDe(lista, 4)!.includes("vendedor: Paulo") && !linhaDe(lista, 4)!.includes("⚠️"), "4: assumido, vendedor pelo primeiro nome, sem ⚠️");
const textoLista = lista.join("\n");
ok(textoLista.includes("5500****2001") && ![1, 2, 3, 4, 5].some((n) => textoLista.includes(TEL(n))) && !textoLista.includes("meta:"), "telefone só mascarado; chat_id nunca aparece");

logReal("\n== Filtros ==");
ok(JSON.stringify(codigos((await rodar("--sem-assumir")).linhas)) === JSON.stringify([COD(3)]), "--sem-assumir: só o 3");
ok(JSON.stringify(codigos((await rodar("--curtos")).linhas)) === JSON.stringify([COD(2), COD(1), COD(5)]), "--curtos: até 2 mensagens do cliente (2, 1 e o 5 sem mensagens)");
ok(!codigos((await rodar("--hoje")).linhas).includes(COD(5)) && codigos((await rodar("--hoje")).linhas).includes(COD(1)), "--hoje: sem o de 3 dias atrás");
ok(codigos((await rodar("--dias", "7")).linhas).includes(COD(5)) && !codigos((await rodar("--dias", "2")).linhas).includes(COD(5)), "--dias 7 inclui o de 3 dias; --dias 2 não");
ok(JSON.stringify(codigos((await rodar("--hoje", "--sem-assumir")).linhas)) === JSON.stringify([COD(3)]), "opções combinadas");
// O de 3 dias atrás passa a ser HUMANO sem assumir: --sem-assumir sozinho mostra só os últimos 2 dias.
await banco.consultar("UPDATE atendimentos SET status = 'HUMANO' WHERE codigo = $1", [COD(5)]);
ok(V.SEM_ASSUMIR_DIAS_PADRAO === 2 && JSON.stringify(codigos((await rodar("--sem-assumir")).linhas)) === JSON.stringify([COD(3)]), "--sem-assumir: por padrão só os últimos 2 dias (sem o de 3 dias)");
ok(JSON.stringify(codigos((await rodar("--sem-assumir", "--dias", "7")).linhas)) === JSON.stringify([COD(3), COD(5)]), "--sem-assumir --dias 7: amplia e inclui o de 3 dias");
await banco.consultar("UPDATE atendimentos SET status = 'IA' WHERE codigo = $1", [COD(5)]);
const invalido = await rodar("--dias", "x");
ok(invalido.codigo === 1 && invalido.linhas[0]!.startsWith("Uso:"), "argumento inválido: uso, código 1");

logReal("\n== Conversa ==");
const conversa = (await rodar(COD(3).toLowerCase())).linhas;
const textoConversa = conversa.join("\n");
ok(conversa[0]!.startsWith(`${COD(3)} | criado `) && conversa[0]!.includes("5500****2003") && !textoConversa.includes(TEL(3)), "cabeçalho com o telefone mascarado");
const falas = conversa.filter((l: string) => /^\[\d{2}:\d{2}\] (Cliente|IA): /.test(l));
ok(falas.length === 5 && falas[0]!.includes("Cliente: cliente 3.0") && falas[1]!.includes("IA: ia 3.1") && falas[4]!.includes("Cliente: cliente 3.4"), "mensagens em ordem, Cliente / IA com horário");
ok(textoConversa.includes("== Resumo para o grupo ==") && textoConversa.includes("Nome: Cliente Três") && textoConversa.includes("Itens:\n• cimento: 10 sacos") &&
   textoConversa.includes("Observações: Não informado") && textoConversa.includes("⚠️ falha de envio (provável)") && textoConversa.includes("Não assumido"),
  "resumo final para o grupo (campos, ⚠️, não assumido)");
ok((await rodar(COD(4))).linhas.some((l: string) => /^Assumido \d{2}\/\d{2} \d{2}:\d{2} por Paulo$/.test(l)), "assumido: quando e por quem");
ok((await rodar(COD(5))).linhas.some((l: string) => l.startsWith("(sem mensagens")), "sem mensagens: avisa");
ok((await rodar("ATD-00000ABFFF")).linhas[0] === "Atendimento ATD-00000ABFFF não encontrado.", "código inexistente");

logReal("\n== Só leitura ==");
let escrita = "";
try { await leitura.query("UPDATE atendimentos SET nome = 'x' WHERE codigo = $1", [COD(1)]); } catch (e: any) { escrita = e?.code ?? "erro"; }
ok(escrita === "25006", `escrita recusada pelo PostgreSQL (read-only, ${escrita})`);
await leitura.end();

logReal("\n== Linha de comando ==");
const cmd = spawnSync(process.execPath, ["--import", "tsx", "scripts/ver-atendimentos.mts", COD(4)], { cwd: raiz, env: { ...process.env, DB_NAME: "atendimento_teste" }, encoding: "utf8", timeout: 60_000 });
ok(cmd.status === 0 && cmd.stdout.includes(`${COD(4)} | criado`) && cmd.stdout.includes("Assumido") && !cmd.stdout.includes(TEL(4)), "executado pelo terminal: imprime a conversa (telefone mascarado)");
const cmdRuim = spawnSync(process.execPath, ["--import", "tsx", "scripts/ver-atendimentos.mts", "--nada"], { cwd: raiz, env: { ...process.env, DB_NAME: "atendimento_teste" }, encoding: "utf8", timeout: 60_000 });
ok(cmdRuim.status === 1 && cmdRuim.stdout.startsWith("Uso:"), "opção desconhecida: uso e código 1");

logReal("\n== Limpeza ==");
const { limparEspelhoDeTeste, limparVendedoresDeTeste } = await import(B + "/tests/limpeza-espelho.mts");
const limpo = await limparEspelhoDeTeste(banco.consultar);
await limparVendedoresDeTeste(banco.consultar, [VEND], new Date(0));
const sobra = Number((await banco.consultar("SELECT count(*) n FROM vendedores WHERE telegram_user_id = $1", [VEND])).rows[0].n);
ok(limpo.restantes === 0 && sobra === 0, `apagados: ${limpo.atendimentos} atendimentos, ${limpo.clientes} clientes; restantes = ${limpo.restantes + sobra}`);
await banco.encerrarBanco();
logReal(falhas ? `\n${falhas} FALHA(S)` : "\nTODOS OS TESTES PASSARAM");
process.exit(falhas ? 1 : 0);
