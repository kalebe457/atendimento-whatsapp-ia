import { consultar } from "./banco.js";

import type { AberturaManual } from "./horarioFuncionamento.js";

import { descreverErro } from "./logSeguro.js";

/*
 * Fechamentos manuais da loja no PostgreSQL (tabela fechamentos, sql/004).
 *
 * A memória (horarioFuncionamento.ts) é a fonte de verdade: o banco só a
 * recarrega na partida (se falhar, de novo a cada minuto até carregar).
 * Falha de banco nunca lança: só log com o código.
 * Comandos curtos (pool.query), com timeout próprio.
 */

const TIMEOUT_MS = 5_000;

function comTimeout<T>(promessa: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return Promise.race([
    promessa,
    new Promise<T>((_, rejeitar) => {
      timer = setTimeout(() => rejeitar(Object.assign(new Error("timeout"), { code: "TIMEOUT" })), TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Fechamentos de "desde" (AAAA-MM-DD) em diante. null = falha de banco.
 */
export async function lerFechamentos(desde: string): Promise<string[] | null> {
  try {
    const resultado = await comTimeout(
      consultar<{ data: string }>(
        "SELECT to_char(data, 'YYYY-MM-DD') AS data FROM fechamentos WHERE data >= $1::date ORDER BY data",
        [desde],
      ),
    );

    return resultado.rows.map((linha) => linha.data);
  } catch (erro: unknown) {
    console.error(`[Loja] ATENÇÃO: fechamentos não carregados do banco (${descreverErro(erro)}); sem fechamentos manuais até carregar (nova tentativa a cada minuto).`);

    return null;
  }
}

/**
 * Grava o fechamento (idempotente). criado_por: o vendedor com esse
 * telegram_user_id, se existir.
 */
export async function gravarFechamento(data: string, telegramUserId: string): Promise<boolean> {
  try {
    await comTimeout(
      consultar(
        `INSERT INTO fechamentos (data, criado_por)
         VALUES ($1::date, (SELECT id FROM vendedores WHERE telegram_user_id = $2::bigint))
         ON CONFLICT (data) DO NOTHING`,
        [data, telegramUserId],
      ),
    );

    return true;
  } catch (erro: unknown) {
    console.error(`[Loja] falha ao gravar fechamento no banco (${descreverErro(erro)}); vale até o próximo reinício.`);

    return false;
  }
}

export async function apagarFechamento(data: string): Promise<boolean> {
  try {
    await comTimeout(consultar("DELETE FROM fechamentos WHERE data = $1::date", [data]));

    return true;
  } catch (erro: unknown) {
    console.error(`[Loja] falha ao remover fechamento do banco (${descreverErro(erro)}); pode voltar no próximo reinício.`);

    return false;
  }
}

/**
 * Grava uma abertura manual (/abrir_agora) e cancela a que ainda valia.
 * Devolve o id da linha (null = falha de banco: vale só a memória).
 */
export async function gravarAberturaManual(inicio: Date, fim: Date, telegramUserId: string): Promise<string | null> {
  try {
    const resultado = await comTimeout(
      consultar<{ id: string }>(
        `WITH anteriores AS (
           UPDATE aberturas_manuais SET cancelado_em = $1
            WHERE cancelado_em IS NULL AND fim > $1
         )
         INSERT INTO aberturas_manuais (inicio, fim, criado_por)
         VALUES ($1, $2, (SELECT id FROM vendedores WHERE telegram_user_id = $3::bigint))
         RETURNING id::text AS id`,
        [inicio, fim, telegramUserId],
      ),
    );

    return resultado.rows[0]?.id ?? null;
  } catch (erro: unknown) {
    console.error(`[Loja] falha ao gravar a abertura manual no banco (${descreverErro(erro)}); vale até o próximo reinício.`);

    return null;
  }
}

/**
 * Cancela a abertura manual que ainda vale (/cancelar_abertura). O
 * instante vem do relógio do backend (o mesmo da memória).
 */
export async function cancelarAberturaManual(agora = new Date(Date.now())): Promise<boolean> {
  try {
    await comTimeout(consultar("UPDATE aberturas_manuais SET cancelado_em = $1 WHERE cancelado_em IS NULL AND fim > $1", [agora]));

    return true;
  } catch (erro: unknown) {
    console.error(`[Loja] falha ao cancelar a abertura manual no banco (${descreverErro(erro)}); ela pode voltar num reinício.`);

    return false;
  }
}

/**
 * Abertura manual ainda válida (fim no futuro, não cancelada), para a
 * recuperação na partida. null no ok = nenhuma.
 */
export async function lerAberturaManualAtiva(agora = new Date(Date.now())): Promise<{ ok: true; abertura: AberturaManual | null } | { ok: false }> {
  try {
    const resultado = await comTimeout(
      consultar<{ id: string; inicio: Date; fim: Date }>(
        `SELECT id::text AS id, inicio, fim FROM aberturas_manuais
          WHERE cancelado_em IS NULL AND fim > $1
          ORDER BY fim DESC LIMIT 1`,
        [agora],
      ),
    );

    const linha = resultado.rows[0];

    return { ok: true, abertura: linha ? { id: linha.id, inicio: linha.inicio.getTime(), fim: linha.fim.getTime() } : null };
  } catch (erro: unknown) {
    console.error(`[Loja] ATENÇÃO: abertura manual não carregada do banco (${descreverErro(erro)}); nova tentativa a cada minuto.`);

    return { ok: false };
  }
}
