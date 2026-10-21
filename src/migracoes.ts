import { readFileSync, readdirSync } from "node:fs";

/*
 * Controle de migrations (sql/NNN_*.sql).
 *
 * A tabela migrations_aplicadas registra o que já foi aplicado. Cada
 * migration que falta roda numa transação JUNTO com o seu registro: ou
 * entra inteira e registrada, ou nada muda. Idempotente: rodar de novo
 * não faz nada.
 *
 * Usado por scripts/migrar.mts (npm run migrate, como o dono do banco) e
 * pelo preparo do banco de testes. Não faz parte da execução do backend.
 */

export const TABELA_CONTROLE = "migrations_aplicadas";

/*
 * Bancos em que este mecanismo pode rodar. Qualquer outro: aborta.
 */
export const BANCOS_PERMITIDOS = ["atendimento", "atendimento_teste"] as const;

const PADRAO_MIGRATION = /^\d{3}_[a-z0-9_]+\.sql$/;

/*
 * Chave do advisory lock: duas execuções ao mesmo tempo esperam uma à outra.
 */
const CHAVE_LOCK = 7_310_045;

export type ClienteSql = { query(texto: string, parametros?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };

/**
 * Arquivos de migration da pasta, em ordem.
 */
export function listarMigrations(pastaSql: string): string[] {
  return readdirSync(pastaSql).filter((arquivo) => PADRAO_MIGRATION.test(arquivo)).sort();
}

/**
 * Corpo da migration sem o BEGIN; / COMMIT; dela (a transação passa a ser
 * a do controle). Exige exatamente um de cada, em linhas próprias.
 */
export function corpoDaMigration(nome: string, sql: string): string {
  const inicio = sql.match(/^BEGIN;[ \t]*$/gm) ?? [];

  const fim = sql.match(/^COMMIT;[ \t]*$/gm) ?? [];

  if (inicio.length !== 1 || fim.length !== 1) {
    throw new Error(`${nome}: precisa ter exatamente uma linha "BEGIN;" e uma "COMMIT;".`);
  }

  return sql.replace(/^BEGIN;[ \t]*$/m, "").replace(/^COMMIT;[ \t]*$/m, "");
}

export type ResultadoMigracao = { banco: string; aplicadas: string[]; jaAplicadas: number };

/**
 * Aplica, em ordem, as migrations de pastaSql que ainda não estão em
 * migrations_aplicadas. Lança no primeiro erro (a migration com erro não
 * entra; as anteriores já ficaram registradas).
 */
export async function aplicarMigrationsPendentes(
  cliente: ClienteSql,
  pastaSql: string,
  log: (texto: string) => void = () => undefined,
): Promise<ResultadoMigracao> {
  const banco = (await cliente.query("SELECT current_database() AS db")).rows[0]?.db;

  if (!(BANCOS_PERMITIDOS as readonly string[]).includes(banco)) {
    throw new Error(`ABORTADO: migrations só em ${BANCOS_PERMITIDOS.join(" ou ")} (conectado em "${banco}"); nada foi executado.`);
  }

  const arquivos = listarMigrations(pastaSql);

  if (arquivos.length === 0) {
    throw new Error("ABORTADO: nenhuma migration encontrada; nada foi executado.");
  }

  await cliente.query(`SELECT pg_advisory_lock(${CHAVE_LOCK})`);

  try {
    await cliente.query(
      `CREATE TABLE IF NOT EXISTS ${TABELA_CONTROLE} (
         nome         TEXT         NOT NULL PRIMARY KEY,
         aplicada_em  TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    );

    const registradas = new Set<string>(
      (await cliente.query(`SELECT nome FROM ${TABELA_CONTROLE}`)).rows
        .map((linha) => linha.nome)
        .filter((nome): nome is string => typeof nome === "string"),
    );

    /*
     * Banco que já tem as tabelas mas nenhum registro: as migrations foram
     * aplicadas antes do controle existir. Reaplicar a 001 quebraria.
     */
    if (registradas.size === 0) {
      const existe = (await cliente.query("SELECT to_regclass('public.atendimentos') IS NOT NULL AS existe")).rows[0]?.existe;

      if (existe === true) {
        throw new Error(
          `ABORTADO: ${banco} já tem tabelas, mas ${TABELA_CONTROLE} está vazia. Registre antes as migrations já aplicadas; nada foi executado.`,
        );
      }
    }

    const aplicadas: string[] = [];

    for (const arquivo of arquivos) {
      if (registradas.has(arquivo)) {
        continue;
      }

      const corpo = corpoDaMigration(arquivo, readFileSync(`${pastaSql}/${arquivo}`, "utf8"));

      await cliente.query("BEGIN");

      try {
        await cliente.query(corpo);

        await cliente.query(`INSERT INTO ${TABELA_CONTROLE} (nome) VALUES ($1)`, [arquivo]);

        await cliente.query("COMMIT");
      } catch (erro: unknown) {
        await cliente.query("ROLLBACK").catch(() => undefined);

        const codigo = (erro as { code?: unknown } | null)?.code;

        throw new Error(`${arquivo}: falhou (${typeof codigo === "string" ? codigo : "erro"}); nada desta migration foi aplicado.`);
      }

      aplicadas.push(arquivo);

      log(`[migrate] ${banco}: ${arquivo} aplicada`);
    }

    return { banco, aplicadas, jaAplicadas: registradas.size };
  } finally {
    await cliente.query(`SELECT pg_advisory_unlock(${CHAVE_LOCK})`).catch(() => undefined);
  }
}
