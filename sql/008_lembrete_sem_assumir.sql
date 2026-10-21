-- =====================================================================
-- Atendimento WhatsApp IA - 008: lembrete de resumo sem ninguém assumir
--
-- Migration incremental (NÃO editar 001-007). Executar SOMENTE no banco
-- atendimento (e no atendimento_teste, pelo preparo dos testes). Roda em
-- uma transação.
--
-- Resumo publicado no grupo e ninguém assumiu em 5 minutos: o grupo
-- recebe UM lembrete. A coluna é reservada ANTES do envio (UPDATE só se
-- ainda NULL e sem vendedor): reinício não manda de novo. NULL = lembrete
-- ainda não enviado.
-- =====================================================================

BEGIN;

ALTER TABLE atendimentos
    ADD COLUMN lembrete_sem_assumir_em TIMESTAMPTZ;

COMMIT;
