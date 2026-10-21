import "dotenv/config";

import { alertarAdministradoresDoServidor, textoFalhaServico } from "./alertaServidor.js";

import { encerrarBanco } from "./banco.js";

import { descreverErro } from "./logSeguro.js";

/*
 * Comando do systemd OnFailure= (deploy/atendimento-alerta@.service):
 *
 *   node dist/alertarAdmins.js <unidade que falhou>
 *
 * Avisa os administradores do grupo de vendedores no privado. Sai com 1
 * se ninguém recebeu (o journald guarda o motivo).
 */
let codigo = 1;

try {
  const enviados = await alertarAdministradoresDoServidor(textoFalhaServico(process.argv[2] ?? ""));

  codigo = enviados > 0 ? 0 : 1;
} catch (erro: unknown) {
  console.error(`[Alerta] ATENÇÃO: falha ao avisar os administradores (${descreverErro(erro)}).`);
} finally {
  await encerrarBanco().catch(() => undefined);
}

process.exit(codigo);
