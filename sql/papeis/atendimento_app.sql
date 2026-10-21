-- =====================================================================
-- Papel do BACKEND em produção: atendimento_app (fora da numeração das
-- migrations; rodar de novo depois de cada migration nova é seguro).
--
-- Sem superusuário, sem CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS. Só
-- SELECT/INSERT/UPDATE/DELETE nas tabelas e USAGE/SELECT nas sequências
-- do schema public do banco onde for executado. Não cria nem apaga
-- tabelas: as migrations continuam com o DONO do banco.
--
-- A senha NUNCA fica neste arquivo. Rodar como o dono do banco:
--
--   sudo -u postgres psql -d atendimento -f sql/papeis/atendimento_app.sql
--
-- e digitar a senha quando o psql pedir (\password não mostra o que é
-- digitado). O .env de produção usa DB_USER=atendimento_app e essa senha.
--
-- Variáveis opcionais do psql (usadas nos testes locais):
--   -v papel=<nome>    outro nome de papel (padrão: atendimento_app)
--   -v senha_app=<s>   senha sem pergunta (NÃO usar em produção: fica no
--                      histórico do shell)
-- =====================================================================

\set ON_ERROR_STOP on

\if :{?papel}
\else
  \set papel atendimento_app
\endif

-- Cria o papel só se ainda não existir (idempotente).
SELECT format('CREATE ROLE %I LOGIN', :'papel')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'papel') \gexec

ALTER ROLE :"papel" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- Nada de criar objetos no schema public (vale para todos os papéis comuns).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO :"papel";

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"papel";

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"papel";

-- Tabelas e sequências criadas DEPOIS pelas migrations (rodadas por este
-- mesmo dono) já nascem com as permissões do backend.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"papel";

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO :"papel";

-- O controle de migrations (migrations_aplicadas) é só do dono: o backend não lê nem escreve.
SELECT format('REVOKE ALL ON TABLE migrations_aplicadas FROM %I', :'papel')
 WHERE to_regclass('public.migrations_aplicadas') IS NOT NULL \gexec

\if :{?senha_app}
  ALTER ROLE :"papel" PASSWORD :'senha_app';
\else
  \echo 'Defina a senha do papel (não aparece na tela):'
  \password :papel
\endif

\echo 'Papel configurado.'
