-- =====================================================================
-- Atendimento WhatsApp IA - 009: faxina do grupo de vendedores
--
-- Migration incremental (NÃO editar 001-008). Executar SOMENTE no banco
-- atendimento (e no atendimento_teste, pelo preparo dos testes). Roda em
-- uma transação.
--
-- O bot apaga do grupo o que já não serve, também depois de um reinício:
-- - lembrete_message_id: o lembrete "sem assumir" (apagado quando alguém
--   assume);
-- - repasses_grupo: mensagens do cliente repassadas ao grupo enquanto
--   ninguém tinha assumido ([{"id": message_id, "texto": ..., "em": ms}]);
--   quando alguém assume, vão para o privado dele e saem do grupo. Guarda
--   texto do cliente: é apagado ao ir para o privado, no encerramento do
--   atendimento e na anonimização (retenção);
-- - resumo_apagado_em: o resumo assumido foi apagado do grupo (30 min
--   depois da assunção).
-- =====================================================================

BEGIN;

ALTER TABLE atendimentos
    ADD COLUMN lembrete_message_id BIGINT,
    ADD COLUMN repasses_grupo      JSONB,
    ADD COLUMN resumo_apagado_em   TIMESTAMPTZ;

COMMIT;
