import "dotenv/config";

import { descreverErro } from "./logSeguro.js";

import { iniciarWebhook, instalarDesligamentoOrdenado } from "./webhook.js";

/*
 * SIGTERM (systemd) e Ctrl+C: para de aceitar webhooks, termina a
 * fila em andamento e fecha o banco antes de sair.
 */
instalarDesligamentoOrdenado();

/*
 * Recupera os atendimentos do banco e só então aceita webhooks.
 * Falha aqui é da porta/servidor (o banco nunca impede a partida).
 */
iniciarWebhook().catch((erro: unknown) => {
  console.error(
    "Falha ao iniciar o backend:",
    descreverErro(erro),
  );

  process.exit(1);
});
