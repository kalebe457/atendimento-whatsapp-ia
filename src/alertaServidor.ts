import { consultar } from "./banco.js";

import { avisarAdministradores, restaurarEstadoTelegram } from "./telegramBot.js";

/*
 * Alerta de falha de um serviço do servidor (systemd OnFailure=): manda
 * uma mensagem no PRIVADO dos administradores do grupo de vendedores que
 * estão registrados (tabela vendedores). Nenhum dado de cliente.
 *
 * Roda fora do backend (src/alertarAdmins.ts), como o usuário atendimento,
 * com o mesmo .env e o mesmo papel do banco.
 */

/**
 * Nome do serviço só se tiver o formato de uma unidade do systemd.
 */
export function textoFalhaServico(unidade: string): string {
  const nome = /^[\w@.-]{1,100}$/.test(unidade) ? unidade : "desconhecido";

  return [
    `⚠️ Servidor da loja Exemplo Materiais de Construção: o serviço ${nome} falhou.`,
    `Detalhes no servidor: sudo journalctl -u ${nome} -n 50`,
  ].join("\n");
}

/**
 * Devolve quantos administradores receberam.
 */
export async function alertarAdministradoresDoServidor(texto: string): Promise<number> {
  const vendedores = (
    await consultar<{ telegram_user_id: string; nome: string; telegram_chat_id: string }>(
      "SELECT telegram_user_id, nome, telegram_chat_id FROM vendedores WHERE ativo",
    )
  ).rows.map((v) => ({ userId: String(v.telegram_user_id), nome: v.nome, chatPrivadoId: Number(v.telegram_chat_id) }));

  restaurarEstadoTelegram({ vendedores, resumosPublicados: [] });

  return avisarAdministradores(texto);
}
