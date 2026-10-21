import { consultar } from "./banco.js";

/*
 * Deduplicação persistente das MENSAGENS RECEBIDAS dos webhooks
 * (tabela eventos_processados, migration 002).
 *
 * "Já processei este evento?" — independe de atendimento: um
 * evento registrado e depois descartado por outra regra continua
 * registrado, e uma nova chegada do mesmo ID é duplicata.
 *
 * NÃO vale para statuses[] da Meta (trazem o mesmo wamid da
 * mensagem original).
 *
 * O canal OPENWA continua aceito (tipo e CHECK do banco), mas o
 * backend não produz mais eventos desse canal.
 *
 * O registro acontece ANTES do processamento e guarda o evento
 * (sql/007) até ele ser processado: se o backend cair nesse meio-tempo,
 * a recuperação na partida reprocessa (lerEventosPendentes). Ao
 * processar, o conteúdo é apagado (marcarEventosProcessados).
 */

export type CanalEvento = "META" | "OPENWA";

export type ResultadoRegistroEvento = "novo" | "duplicado";

/*
 * Tamanho da coluna mensagem_externa_id.
 */
const TAMANHO_MAXIMO_ID = 150;

/**
 * O ID cabe na tabela? IDs vazios ou maiores que a coluna
 * não são registrados (o evento segue como "sem ID externo").
 */
export function idRegistravel(mensagemExternaId: string): boolean {
  return mensagemExternaId !== "" && mensagemExternaId.length <= TAMANHO_MAXIMO_ID;
}

/**
 * Registra o evento de forma atômica pela restrição única
 * (canal, mensagem_externa_id).
 *
 * - "novo": este processo inseriu agora e deve processar;
 * - "duplicado": já existia (inclusive inserido por outra
 *   requisição concorrente); não processar.
 *
 * Qualquer erro de banco é LANÇADO: não é duplicata, e quem
 * chama não deve processar a mensagem.
 */
export async function registrarEventoRecebido(
  canal: CanalEvento,
  mensagemExternaId: string,
  evento?: unknown,
): Promise<ResultadoRegistroEvento> {
  const resultado = await consultar(
    `INSERT INTO eventos_processados (canal, mensagem_externa_id, evento)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (canal, mensagem_externa_id) DO NOTHING
     RETURNING id`,
    [canal, mensagemExternaId, evento === undefined ? null : JSON.stringify(evento)],
  );

  return resultado.rowCount === 1 ? "novo" : "duplicado";
}

/**
 * Eventos já tratados (respondidos, descartados ou ignorados): o
 * conteúdo sai do banco e não volta na recuperação. Falha só gera log
 * (no pior caso, a mensagem é reprocessada depois de um reinício).
 */
export async function marcarEventosProcessados(canal: CanalEvento, mensagemExternaIds: string[]): Promise<void> {
  const ids = mensagemExternaIds.filter(idRegistravel);

  if (ids.length === 0) {
    return;
  }

  try {
    await consultar(
      `UPDATE eventos_processados SET evento = NULL, processado_em = now()
        WHERE canal = $1 AND mensagem_externa_id = ANY($2::varchar[])`,
      [canal, ids],
    );
  } catch (erro: unknown) {
    const codigo = (erro as { code?: unknown })?.code;

    console.error(`[Dedup] ${canal}: falha ao marcar ${ids.length} evento(s) como processado(s) (${typeof codigo === "string" ? codigo : "erro"}).`);
  }
}

/**
 * Eventos que estavam esperando processamento quando o processo caiu
 * (recebidos há menos de 20 min, só dos chats do prefixo), em ordem de
 * chegada. null = falha de banco.
 */
export async function lerEventosPendentes(canal: CanalEvento, prefixoChat: string): Promise<unknown[] | null> {
  try {
    const resultado = await consultar<{ evento: unknown }>(
      `SELECT evento FROM eventos_processados
        WHERE canal = $1 AND processado_em IS NULL AND evento IS NOT NULL
          AND recebido_em > now() - interval '20 minutes'
          AND evento->'data'->>'chatId' LIKE $2
        ORDER BY recebido_em, id`,
      [canal, `${prefixoChat}%`],
    );

    return resultado.rows.map((linha) => linha.evento);
  } catch (erro: unknown) {
    const codigo = (erro as { code?: unknown })?.code;

    console.error(`[Recuperação] ATENÇÃO: mensagens pendentes não lidas do banco (${typeof codigo === "string" ? codigo : "erro"}).`);

    return null;
  }
}
