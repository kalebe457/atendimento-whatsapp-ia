import type { Cliente, EstadoTriagem, EtapaTriagem, MidiaRecebida, ResultadoIA } from "./tipos.js";

export interface IA {
  responder(mensagem: string, cliente: Cliente): Promise<ResultadoIA>;

  /**
   * Mídia do cliente (áudio, imagem...): aviso, "mesmo envio" (resposta
   * vazia = nada a enviar) ou HUMANO. Não chama o Claude.
   * recebidaEm: chegada da mídia ao backend (relógio local).
   */
  responderMidia(midia: MidiaRecebida, cliente: Cliente, recebidaEm: number): Promise<ResultadoIA>;

  /**
   * Desfaz o que a última resposta registrou como
   * entregue quando houve tentativa REAL de envio
   * e ela falhou.
   */
  desfazerRespostaNaoEntregue(): void;

  /**
   * Junta às observações as legendas de mídia do atendimento
   * (quando o atendimento vai para HUMANO).
   */
  anexarLegendas(observacoes: string): string;

  /**
   * Cópia do estado atual da triagem (para o espelho no banco).
   */
  estadoTriagem(): EstadoTriagem;

  /**
   * Etapa cuja pergunta espera resposta (null = nenhuma).
   */
  etapaAguardandoResposta(): EtapaTriagem | null;

  /**
   * O cliente parou de responder: encerra a triagem com o que já tem
   * (HUMANO, sem chamar a Claude).
   */
  encaminharPorInatividade(motivo: "observacoes" | "parou" | "midia", aberta: boolean): ResultadoIA;

  /**
   * Mídia (com ou sem legenda) depois da qual o cliente não escreveu (o
   * aviso de mídia pediu o texto): os rótulos das mídias. Senão, null.
   */
  midiaSemContinuacao(): string[] | null;
}
