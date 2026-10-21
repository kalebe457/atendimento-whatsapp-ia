// Acompanhamento dos atendimentos (SÓ LEITURA), para olhar pelo terminal/SSH.
//
//   npx tsx scripts/ver-atendimentos.mts                 últimos 20 atendimentos
//   npx tsx scripts/ver-atendimentos.mts --hoje          só os de hoje (Belém)
//   npx tsx scripts/ver-atendimentos.mts --dias 7        dos últimos 7 dias
//   npx tsx scripts/ver-atendimentos.mts --sem-assumir   foram para HUMANO e ninguém assumiu (últimos 2 dias;
//                                                        com --dias N, os últimos N dias)
//   npx tsx scripts/ver-atendimentos.mts --curtos        cliente desistiu (até 2 mensagens dele)
//   npx tsx scripts/ver-atendimentos.mts ATD-00000AA003  a conversa inteira e o resumo do grupo
//
// No servidor: sudo -u atendimento bash -c 'cd /opt/app/backend && npx tsx scripts/ver-atendimentos.mts [código|opções]'
//
// Conecta com DB_* do .env (sem imprimir valores; no servidor, o papel atendimento_app), numa sessão
// default_transaction_read_only: qualquer escrita é recusada pelo próprio PostgreSQL. Só SELECT.
// Mostra na tela (não grava em arquivo nem em log). Telefone sempre mascarado; chat_id nunca aparece.
// "⚠️ provável": a falha de envio não é gravada no banco; é inferida (a última mensagem antes do
// resumo ir ao grupo é do cliente, sem resposta da IA).
import "dotenv/config";
import pg from "pg";
import { fileURLToPath } from "node:url";

import { linhasDeItens } from "../src/itensPedido.js";
import { descreverErro, mascararTelefone } from "../src/logSeguro.js";
import { primeiroNomeVendedor } from "../src/telegramBot.js";

type Consultar = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;

export const SEM_ASSUMIR_DIAS_PADRAO = 2;

export type Opcoes = { hoje: boolean; dias: number | null; semAssumir: boolean; curtos: boolean };

export const USO = [
  "Uso: npx tsx scripts/ver-atendimentos.mts [ATD-XXXXXXXXXX | --hoje | --dias N | --sem-assumir | --curtos]",
  "  sem argumento: os últimos 20 atendimentos; as opções podem ser combinadas.",
].join("\n");

/**
 * Conexão só de leitura com DB_* do .env (statement_timeout de 10 s).
 */
export async function conectarSomenteLeitura(): Promise<pg.Client> {
  const cliente = new pg.Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: "-c default_transaction_read_only=on -c statement_timeout=10000",
  });

  await cliente.connect();

  return cliente;
}

function telefoneMascarado(telefone: unknown): string {
  return typeof telefone === "string" && /^\d{10,15}$/.test(telefone) ? mascararTelefone(telefone) : "-";
}

function situacao(l: Record<string, any>): string {
  if (l.vendedor_id !== null) {
    return "HUMANO (assumido)";
  }

  if (l.status === "HUMANO") {
    return "HUMANO (sem assumir)";
  }

  return l.encerrado_em ? "encerrado por inatividade" : "IA (em andamento)";
}

/*
 * Falha de envio provável: a última mensagem antes do resumo ir ao grupo é do cliente.
 */
const SQL_FALHA = `
  a.resumo_enviado_em IS NOT NULL AND (
    SELECT m.direcao FROM mensagens m
     WHERE m.atendimento_id = a.id AND m.criado_em <= a.resumo_enviado_em
     ORDER BY m.criado_em DESC, m.id DESC LIMIT 1
  ) = 'ENTRADA'`;

/**
 * Lista de atendimentos, mais novos primeiro (linhas prontas para a tela).
 */
export async function listarAtendimentos(consultar: Consultar, opcoes: Opcoes): Promise<string[]> {
  const filtros: string[] = [];

  const params: unknown[] = [];

  if (opcoes.hoje) {
    filtros.push("(a.criado_em AT TIME ZONE 'America/Belem')::date = (now() AT TIME ZONE 'America/Belem')::date");
  }

  if (opcoes.dias !== null) {
    params.push(opcoes.dias);
    filtros.push(`a.criado_em >= now() - make_interval(days => $${params.length})`);
  }

  if (opcoes.semAssumir) {
    filtros.push("a.status = 'HUMANO' AND a.vendedor_id IS NULL");
  }

  if (opcoes.curtos) {
    filtros.push("(SELECT count(*) FROM mensagens m WHERE m.atendimento_id = a.id AND m.direcao = 'ENTRADA') <= 2");
  }

  const limite = opcoes.hoje || opcoes.dias !== null ? 200 : 20;

  const { rows } = await consultar(
    `SELECT a.codigo, a.status, a.vendedor_id, a.encerrado_em,
            to_char(a.criado_em AT TIME ZONE 'America/Belem', 'DD/MM HH24:MI') AS quando,
            c.telefone, v.nome AS vendedor,
            (SELECT count(*) FROM mensagens m WHERE m.atendimento_id = a.id)::int AS mensagens,
            (SELECT count(*) FROM mensagens m WHERE m.atendimento_id = a.id AND m.direcao = 'ENTRADA')::int AS do_cliente,
            (${SQL_FALHA}) AS falha
       FROM atendimentos a
       LEFT JOIN clientes c ON c.id = a.cliente_id
       LEFT JOIN vendedores v ON v.id = a.vendedor_id
      ${filtros.length ? `WHERE ${filtros.join(" AND ")}` : ""}
      ORDER BY a.criado_em DESC, a.id DESC
      LIMIT ${limite}`,
    params,
  );

  if (rows.length === 0) {
    return ["Nenhum atendimento encontrado."];
  }

  return rows.map((l) =>
    [
      l.codigo,
      l.quando,
      telefoneMascarado(l.telefone),
      situacao(l),
      `${l.mensagens} msg (${l.do_cliente} do cliente)`,
      l.vendedor_id !== null ? `vendedor: ${primeiroNomeVendedor(l.vendedor) ?? "(sem nome)"}` : "",
      l.falha ? "⚠️ falha de envio (provável)" : "",
    ]
      .filter((parte) => parte !== "")
      .join(" | "),
  );
}

const ROTULO_CAMPO = (valor: unknown) => (typeof valor === "string" && valor.trim() !== "" ? valor : "Não informado");

/**
 * Conversa inteira de um atendimento, em ordem, e o resumo que foi para o grupo.
 */
export async function verConversa(consultar: Consultar, codigo: string): Promise<string[]> {
  const { rows: atds } = await consultar(
    `SELECT a.id, a.codigo, a.status, a.vendedor_id, a.encerrado_em, a.nome, a.produto, a.quantidade, a.observacoes,
            to_char(a.criado_em AT TIME ZONE 'America/Belem', 'DD/MM/YYYY HH24:MI') AS criado,
            to_char(a.resumo_enviado_em AT TIME ZONE 'America/Belem', 'DD/MM HH24:MI') AS resumo_em,
            to_char(a.assumido_em AT TIME ZONE 'America/Belem', 'DD/MM HH24:MI') AS assumido_em,
            c.telefone, v.nome AS vendedor, (${SQL_FALHA}) AS falha
       FROM atendimentos a
       LEFT JOIN clientes c ON c.id = a.cliente_id
       LEFT JOIN vendedores v ON v.id = a.vendedor_id
      WHERE a.codigo = $1`,
    [codigo],
  );

  const a = atds[0];

  if (!a) {
    return [`Atendimento ${codigo} não encontrado.`];
  }

  const { rows: msgs } = await consultar(
    `SELECT direcao, texto, to_char(criado_em AT TIME ZONE 'America/Belem', 'HH24:MI') AS hora
       FROM mensagens WHERE atendimento_id = $1 ORDER BY criado_em, id`,
    [a.id],
  );

  const linhas = [
    `${a.codigo} | criado ${a.criado} | ${telefoneMascarado(a.telefone)} | ${situacao(a)}`,
    "",
    "== Conversa ==",
  ];

  if (msgs.length === 0) {
    linhas.push("(sem mensagens: ainda não gravadas ou apagadas pela retenção)");
  }

  for (const m of msgs) {
    const quem = m.direcao === "ENTRADA" ? "Cliente" : "IA";

    linhas.push(`[${m.hora}] ${quem}: ${String(m.texto ?? "").replace(/\n/g, "\n          ")}`);
  }

  linhas.push(
    "",
    "== Resumo para o grupo ==",
    a.resumo_em ? `publicado ${a.resumo_em}${a.falha ? " | ⚠️ falha de envio (provável)" : ""}` : "não publicado no grupo",
    `Nome: ${ROTULO_CAMPO(a.nome)}`,
    `Telefone: ${telefoneMascarado(a.telefone)}`,
    ...linhasDeItens(a.produto, a.quantidade),
    `Observações: ${ROTULO_CAMPO(a.observacoes)}`,
    a.vendedor_id !== null ? `Assumido ${a.assumido_em} por ${primeiroNomeVendedor(a.vendedor) ?? "(sem nome)"}` : "Não assumido",
  );

  return linhas;
}

/**
 * Lê os argumentos. null = argumento inválido.
 */
export function lerArgumentos(args: string[]): { codigo: string } | { opcoes: Opcoes } | null {
  if (args.length === 1 && /^ATD-[0-9A-F]{10}$/i.test(args[0] ?? "")) {
    return { codigo: args[0]!.toUpperCase() };
  }

  const opcoes: Opcoes = { hoje: false, dias: null, semAssumir: false, curtos: false };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];

    if (a === "--hoje") {
      opcoes.hoje = true;
    } else if (a === "--sem-assumir") {
      opcoes.semAssumir = true;
    } else if (a === "--curtos") {
      opcoes.curtos = true;
    } else if (a === "--dias" && /^\d{1,4}$/.test(args[i + 1] ?? "") && Number(args[i + 1]) > 0) {
      opcoes.dias = Number(args[++i]);
    } else {
      return null;
    }
  }

  /*
   * --sem-assumir sozinho: só os últimos SEM_ASSUMIR_DIAS_PADRAO dias
   * (--dias N amplia; --hoje restringe).
   */
  if (opcoes.semAssumir && opcoes.dias === null && !opcoes.hoje) {
    opcoes.dias = SEM_ASSUMIR_DIAS_PADRAO;
  }

  return { opcoes };
}

/**
 * Executa e devolve as linhas da tela.
 */
export async function executar(consultar: Consultar, args: string[]): Promise<{ codigo: number; linhas: string[] }> {
  const lido = lerArgumentos(args);

  if (!lido) {
    return { codigo: 1, linhas: [USO] };
  }

  return { codigo: 0, linhas: "codigo" in lido ? await verConversa(consultar, lido.codigo) : await listarAtendimentos(consultar, lido.opcoes) };
}

/*
 * Chamado pela linha de comando (não quando importado pelos testes).
 */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let cliente: pg.Client | null = null;

  let codigo = 0;

  try {
    cliente = await conectarSomenteLeitura();

    const c = cliente;

    const r = await executar((sql, params) => c.query(sql, params), process.argv.slice(2));

    console.log(r.linhas.join("\n"));

    codigo = r.codigo;
  } catch (erro: unknown) {
    console.error(`[ver-atendimentos] falha (${descreverErro(erro)}).`);

    codigo = 1;
  } finally {
    await cliente?.end().catch(() => undefined);
  }

  process.exit(codigo);
}
