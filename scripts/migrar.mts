// Aplica as migrations que faltam (sql/NNN_*.sql), em ordem, cada uma numa transação junto com o
// seu registro em migrations_aplicadas. Idempotente. Roda como o DONO do banco (as migrations
// criam e alteram tabelas; o papel atendimento_app do backend não pode).
//
// Produção (usuário postgres, socket local, sem senha):
//   sudo -u postgres bash -c 'cd /opt/app/backend && PGHOST=/var/run/postgresql PGDATABASE=atendimento npm run migrate'
// Desenvolvimento (conexão DB_* do .env):
//   npm run migrate
//
// Conexão: se PGHOST estiver definido, usa só as variáveis PG* (PGHOST, PGPORT, PGUSER,
// PGDATABASE, PGPASSWORD); senão, DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME do .env.
// Só roda em atendimento ou atendimento_teste. Mostra só nomes de arquivos e contagens.
import pg from "pg";
import { fileURLToPath } from "node:url";

import { aplicarMigrationsPendentes } from "../src/migracoes.js";
import { descreverErro } from "../src/logSeguro.js";

const PASTA_SQL = fileURLToPath(new URL("../sql", import.meta.url));

function configuracao(): pg.ClientConfig {
  if (process.env.PGHOST) {
    return {};
  }

  try {
    process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
  } catch {
    // Sem .env legível: segue com o que estiver no ambiente.
  }

  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  };
}

const cliente = new pg.Client(configuracao());

let codigo = 0;

try {
  await cliente.connect();

  const resultado = await aplicarMigrationsPendentes(cliente, PASTA_SQL, (texto) => console.log(texto));

  console.log(
    resultado.aplicadas.length === 0
      ? `[migrate] ${resultado.banco}: nada a aplicar (${resultado.jaAplicadas} já aplicadas).`
      : `[migrate] ${resultado.banco}: ${resultado.aplicadas.length} aplicada(s) agora; ${resultado.jaAplicadas} já estavam aplicadas.`,
  );
} catch (erro: unknown) {
  const mensagem = erro instanceof Error && /^(ABORTADO|\d{3}_)/.test(erro.message) ? erro.message : `falha (${descreverErro(erro)})`;

  console.log(`[migrate] ${mensagem}`);

  codigo = 1;
} finally {
  await cliente.end().catch(() => undefined);
}

process.exit(codigo);
