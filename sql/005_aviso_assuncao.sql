-- =====================================================================
-- Atendimento WhatsApp IA - 005: aviso ao cliente quando um vendedor assume
--
-- Migration incremental (NÃO editar 001-004). Executar SOMENTE no banco
-- atendimento (e no atendimento_teste, pelo preparo dos testes). Roda em
-- uma transação.
--
-- Quando o vendedor assume pelo Telegram, o cliente recebe UMA mensagem
-- ("Pronto! O vendedor ... vai te chamar"). A coluna é reservada ANTES do
-- envio (UPDATE só se ainda NULL): reinício e ASSUMIR repetido não
-- mandam de novo. NULL = aviso ainda não enviado.
-- =====================================================================

BEGIN;

ALTER TABLE atendimentos
    ADD COLUMN aviso_assuncao_em TIMESTAMPTZ;

COMMIT;
