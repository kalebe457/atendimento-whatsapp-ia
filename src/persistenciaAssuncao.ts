import { obterConexao } from "./banco.js";

import { descreverErro } from "./logSeguro.js";

/*
 * Assunção pelo Telegram no PostgreSQL (Passo 5c).
 *
 * A MEMÓRIA continua sendo a fonte de verdade; o banco registra o
 * resumo publicado, quem assumiu e a DM, e é um SEGUNDO portão contra
 * assunção dupla (o UPDATE só vale se ainda não houver vendedor).
 *
 * Mesmas regras do espelho: transação curta, statement_timeout de
 * 5 s, falha de banco só gera log curto (código do erro, sem dados
 * pessoais nem segredos). Nenhuma função lança.
 */

const STATEMENT_TIMEOUT = "5s";

type Conexao = Awaited<ReturnType<typeof obterConexao>>;

/**
 * Executa fn numa transação curta. Erro: ROLLBACK, log e
 * devolve { ok: false, codigo }. confirmar(valor) = false
 * desfaz a transação sem ser erro.
 */
async function emTransacao<T>(
  rotulo: string,
  fn: (conexao: Conexao) => Promise<T>,
  confirmar: (valor: T) => boolean = () => true,
): Promise<{ ok: true; valor: T } | { ok: false; codigo: string }> {
  let conexao: Conexao | null = null;

  try {
    conexao = await obterConexao();

    await conexao.query("BEGIN");

    await conexao.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);

    const valor = await fn(conexao);

    await conexao.query(confirmar(valor) ? "COMMIT" : "ROLLBACK");

    return { ok: true, valor };
  } catch (erro: unknown) {
    if (conexao) {
      await conexao.query("ROLLBACK").catch(() => undefined);
    }

    const codigo = descreverErro(erro);

    console.error(`[Persistência] falha ao ${rotulo} (${codigo}).`);

    return { ok: false, codigo };
  } finally {
    conexao?.release();
  }
}

export type DadosVendedor = {
  telegramUserId: string;

  /*
   * Nome atual do vendedor no Telegram.
   */
  nome: string;

  /*
   * Chat privado do vendedor com o bot (DM).
   */
  chatPrivadoId: number;
};

/**
 * Upsert do vendedor pelo telegram_user_id (nome atual, chat
 * privado, ativo = TRUE). Devolve o id.
 */
async function upsertVendedor(conexao: Conexao, dados: DadosVendedor): Promise<string | undefined> {
  const vendedor = await conexao.query<{ id: string }>(
    `INSERT INTO vendedores (telegram_user_id, nome, telegram_chat_id, ativo)
     VALUES ($1, $2, $3, TRUE)
     ON CONFLICT (telegram_user_id) DO UPDATE SET
       nome = EXCLUDED.nome,
       telegram_chat_id = EXCLUDED.telegram_chat_id,
       ativo = TRUE,
       atualizado_em = now()
     RETURNING id`,
    [dados.telegramUserId, dados.nome, dados.chatPrivadoId],
  );

  return vendedor.rows[0]?.id;
}

/**
 * /start aceito: grava o vendedor (a recuperação na partida o
 * devolve à memória sem novo /start). Falha só gera log.
 */
export async function registrarVendedor(dados: DadosVendedor): Promise<boolean> {
  const resultado = await emTransacao("registrar o vendedor do /start", (conexao) =>
    upsertVendedor(conexao, dados),
  );

  return resultado.ok;
}

/**
 * Resumo publicado (ou republicado) no grupo: grava a mensagem
 * que está valendo. publicadoEm: o horário real, quando a gravação
 * é repetida depois (senão, now()).
 *
 * "erro" = falha de banco (vale repetir); "sem_linha" = o atendimento
 * não está no banco.
 */
export async function registrarResumoPublicado(
  codigo: string,
  telegramChatId: number | string,
  telegramMessageId: number,
  publicadoEm?: Date,
): Promise<"gravado" | "sem_linha" | "erro"> {
  const resultado = await emTransacao(
    `registrar o resumo publicado de ${codigo}`,
    (conexao) =>
      conexao.query(
        `UPDATE atendimentos
            SET telegram_chat_id = $2, telegram_message_id = $3,
                resumo_enviado_em = COALESCE($4::timestamptz, now()), atualizado_em = now()
          WHERE codigo = $1`,
        [codigo, String(telegramChatId), telegramMessageId, publicadoEm ?? null],
      ),
  );

  if (!resultado.ok) {
    return "erro";
  }

  if (resultado.valor.rowCount === 0) {
    console.warn(
      `[Persistência] resumo de ${codigo} publicado, mas o atendimento não está no banco.`,
    );

    return "sem_linha";
  }

  return "gravado";
}

export type DadosAssuncao = DadosVendedor & {
  codigo: string;

  /*
   * Mensagem do resumo onde houve o clique (vindos do callback).
   */
  telegramChatId: number | string;

  telegramMessageId: number;

  /*
   * Horário real da assunção, quando a gravação é repetida
   * depois (senão, now()).
   */
  assumidoEm?: Date;
};

/*
 * - "assumido": o banco registrou este vendedor;
 * - "ja_por_voce": o banco já tinha ESTE vendedor, com a DM ENVIADA;
 * - "ja_por_voce_dm_pendente": ESTE vendedor, mas a DM não consta
 *   como ENVIADA (ENVIANDO ou FALHOU): a DM deve ser reenviada;
 * - "ja_por_outro": o banco já tinha OUTRO vendedor (o banco vence);
 * - "sem_linha": o atendimento não está no banco (espelho falhou);
 * - "erro": falha de banco (já logada com o código).
 */
export type ResultadoAssuncaoBanco =
  | "assumido"
  | "ja_por_voce"
  | "ja_por_voce_dm_pendente"
  | "ja_por_outro"
  | "sem_linha"
  | "erro";

/**
 * Numa transação: upsert do vendedor pelo telegram_user_id e um
 * UPDATE condicional do atendimento (só se ainda sem vendedor).
 * Só confirma em "assumido" e "ja_por_voce".
 */
export async function registrarAssuncao(
  dados: DadosAssuncao,
): Promise<ResultadoAssuncaoBanco> {
  const resultado = await emTransacao(
    `registrar a assunção de ${dados.codigo}`,
    async (conexao): Promise<ResultadoAssuncaoBanco> => {
      const vendedorId = await upsertVendedor(conexao, dados);

      const atualizado = await conexao.query(
        `UPDATE atendimentos SET
           vendedor_id = $2,
           assumido_em = COALESCE($5::timestamptz, now()),
           status = 'HUMANO',
           encerrado_em = COALESCE(encerrado_em, $5::timestamptz, now()),
           dm_status = 'ENVIANDO',
           telegram_chat_id = COALESCE(telegram_chat_id, $3),
           telegram_message_id = COALESCE(telegram_message_id, $4),
           resumo_enviado_em = COALESCE(resumo_enviado_em, $5::timestamptz, now()),
           atualizado_em = now()
         WHERE codigo = $1 AND vendedor_id IS NULL
         RETURNING id`,
        [dados.codigo, vendedorId, String(dados.telegramChatId), dados.telegramMessageId, dados.assumidoEm ?? null],
      );

      if (atualizado.rowCount === 1) {
        return "assumido";
      }

      const atual = await conexao.query<{ vendedor_id: string | null; dm_status: string | null }>(
        "SELECT vendedor_id, dm_status FROM atendimentos WHERE codigo = $1",
        [dados.codigo],
      );

      const linha = atual.rows[0];

      if (!linha) {
        return "sem_linha";
      }

      if (linha.vendedor_id !== vendedorId) {
        return "ja_por_outro";
      }

      return linha.dm_status === "ENVIADA" ? "ja_por_voce" : "ja_por_voce_dm_pendente";
    },
    /*
     * Sem linha ou com outro vendedor: nada é gravado
     * (nem o vendedor, que ficaria sem atendimento).
     */
    (valor) => valor === "assumido" || valor === "ja_por_voce" || valor === "ja_por_voce_dm_pendente",
  );

  return resultado.ok ? resultado.valor : "erro";
}

/**
 * Resultado da DM ao vencedor. Só altera atendimento já assumido
 * no banco (respeita chk_atendimentos_dm_vendedor).
 */
export async function registrarDmStatus(
  codigo: string,
  status: "ENVIADA" | "FALHOU",
): Promise<boolean> {
  const resultado = await emTransacao(
    `registrar a DM de ${codigo}`,
    (conexao) =>
      conexao.query(
        `UPDATE atendimentos SET dm_status = $2, atualizado_em = now()
          WHERE codigo = $1 AND vendedor_id IS NOT NULL`,
        [codigo, status],
      ),
  );

  return resultado.ok;
}

/**
 * Reserva o aviso ao cliente da assunção (sql/005), ANTES do envio:
 * só a primeira chamada por atendimento recebe "reservado".
 *
 * - "reservado": marcado agora, pode enviar;
 * - "ja_enviado": já marcado antes (outro processo, reinício, clique repetido);
 * - "sem_linha": o atendimento não está no banco (vale a memória);
 * - "erro": falha de banco (já logada com o código).
 */
export async function reservarAvisoAssuncao(
  codigo: string,
): Promise<"reservado" | "ja_enviado" | "sem_linha" | "erro"> {
  const resultado = await emTransacao(
    `reservar o aviso de assunção de ${codigo}`,
    async (conexao): Promise<"reservado" | "ja_enviado" | "sem_linha"> => {
      const marcado = await conexao.query(
        `UPDATE atendimentos SET aviso_assuncao_em = now(), atualizado_em = now()
          WHERE codigo = $1 AND aviso_assuncao_em IS NULL
          RETURNING id`,
        [codigo],
      );

      if (marcado.rowCount === 1) {
        return "reservado";
      }

      const existe = await conexao.query("SELECT 1 FROM atendimentos WHERE codigo = $1", [codigo]);

      return existe.rowCount === 1 ? "ja_enviado" : "sem_linha";
    },
  );

  return resultado.ok ? resultado.valor : "erro";
}

/**
 * Reserva o lembrete "sem assumir" de um resumo ANTES do envio (sql/008):
 * - "reservado": marcado agora, pode enviar;
 * - "nao_enviar": já marcado antes (reinício) ou o banco já tem vendedor;
 * - "sem_linha": o atendimento não está no banco (vale a memória);
 * - "erro": falha de banco (já logada; vale a memória).
 */
export async function reservarLembreteSemAssumir(
  codigo: string,
): Promise<"reservado" | "nao_enviar" | "sem_linha" | "erro"> {
  const resultado = await emTransacao(
    `reservar o lembrete de ${codigo}`,
    async (conexao): Promise<"reservado" | "nao_enviar" | "sem_linha"> => {
      const marcado = await conexao.query(
        `UPDATE atendimentos SET lembrete_sem_assumir_em = now(), atualizado_em = now()
          WHERE codigo = $1 AND lembrete_sem_assumir_em IS NULL AND vendedor_id IS NULL
          RETURNING id`,
        [codigo],
      );

      if (marcado.rowCount === 1) {
        return "reservado";
      }

      const existe = await conexao.query("SELECT 1 FROM atendimentos WHERE codigo = $1", [codigo]);

      return existe.rowCount === 1 ? "nao_enviar" : "sem_linha";
    },
  );

  return resultado.ok ? resultado.valor : "erro";
}

/*
 * Faxina do grupo (sql/009). Falha de banco só gera log (a memória
 * continua valendo; um reinício pode deixar algo no grupo).
 */

/**
 * message_id do lembrete "sem assumir" no grupo (null = já apagado).
 */
export async function gravarLembreteMensagem(codigo: string, messageId: number | null): Promise<boolean> {
  const resultado = await emTransacao(`gravar o lembrete de ${codigo}`, (conexao) =>
    conexao.query("UPDATE atendimentos SET lembrete_message_id = $2, atualizado_em = now() WHERE codigo = $1", [codigo, messageId]),
  );

  return resultado.ok;
}

export type RepasseGrupo = { id: number; texto: string; em: number };

/**
 * Mensagem do cliente repassada ao grupo enquanto ninguém assumiu.
 */
export async function anexarRepasseGrupo(codigo: string, repasse: RepasseGrupo): Promise<boolean> {
  const resultado = await emTransacao(`gravar o repasse de ${codigo}`, (conexao) =>
    conexao.query(
      `UPDATE atendimentos SET repasses_grupo = COALESCE(repasses_grupo, '[]'::jsonb) || $2::jsonb, atualizado_em = now()
        WHERE codigo = $1`,
      [codigo, JSON.stringify([repasse])],
    ),
  );

  return resultado.ok;
}

/**
 * Os repasses foram para o privado de quem assumiu: o texto sai do banco.
 */
export async function limparRepassesGrupo(codigo: string): Promise<boolean> {
  const resultado = await emTransacao(`limpar os repasses de ${codigo}`, (conexao) =>
    conexao.query("UPDATE atendimentos SET repasses_grupo = NULL, atualizado_em = now() WHERE codigo = $1", [codigo]),
  );

  return resultado.ok;
}

/**
 * O resumo assumido saiu do grupo.
 */
export async function marcarResumoApagado(codigo: string): Promise<boolean> {
  const resultado = await emTransacao(`marcar o resumo apagado de ${codigo}`, (conexao) =>
    conexao.query("UPDATE atendimentos SET resumo_apagado_em = now(), atualizado_em = now() WHERE codigo = $1", [codigo]),
  );

  return resultado.ok;
}

/**
 * Marca o aviso como enviado (regravação depois de uma reserva que
 * falhou por banco fora). Não sobrescreve uma marca existente.
 */
export async function marcarAvisoAssuncao(codigo: string, em: Date): Promise<boolean> {
  const resultado = await emTransacao(`marcar o aviso de assunção de ${codigo}`, (conexao) =>
    conexao.query(
      `UPDATE atendimentos SET aviso_assuncao_em = COALESCE(aviso_assuncao_em, $2), atualizado_em = now()
        WHERE codigo = $1`,
      [codigo, em],
    ),
  );

  return resultado.ok;
}

export type LinhaRanking = {
  nome: string;

  mes: number;

  total: number;
};

/**
 * Atendimentos assumidos por vendedor: no mês atual
 * (America/Belem) e no total. null = falha de banco.
 */
export async function consultarRanking(): Promise<LinhaRanking[] | null> {
  const resultado = await emTransacao("consultar o ranking", (conexao) =>
    conexao.query<{ nome: string; mes: string; total: string }>(
      `SELECT v.nome,
              count(*) FILTER (
                WHERE a.assumido_em >= date_trunc('month', now() AT TIME ZONE 'America/Belem')
                                       AT TIME ZONE 'America/Belem'
              ) AS mes,
              count(*) AS total
         FROM vendedores v
         JOIN atendimentos a ON a.vendedor_id = v.id
        GROUP BY v.id, v.nome
        ORDER BY mes DESC, total DESC, v.nome`,
    ),
  );

  if (!resultado.ok) {
    return null;
  }

  return resultado.valor.rows.map((linha) => ({
    nome: linha.nome,
    mes: Number(linha.mes),
    total: Number(linha.total),
  }));
}
