-- =====================================================================
-- Atendimento WhatsApp IA - 007: mensagens recebidas aguardando processamento
--
-- Migration incremental (NÃO editar 001-006). Executar SOMENTE no banco
-- atendimento (e no atendimento_teste, pelo preparo dos testes). Roda em
-- uma transação.
--
-- As mensagens do cliente esperam alguns segundos (agrupamento de
-- mensagens seguidas) antes de ir para a IA. Se o processo cair nesse
-- meio-tempo, a mensagem não pode se perder: o registro da deduplicação
-- passa a guardar o evento até ele ser processado.
--
-- - evento: a mensagem normalizada (só enquanto não processada; apagada
--   ao processar);
-- - processado_em: quando o lote foi processado. NULL com evento = a
--   recuperação na partida reprocessa (se recebido há menos de 20 min).
-- Linhas antigas (sem evento) não são reprocessadas.
-- =====================================================================

BEGIN;

ALTER TABLE eventos_processados
    ADD COLUMN evento        JSONB,
    ADD COLUMN processado_em TIMESTAMPTZ;

CREATE INDEX ix_eventos_processados_pendentes
    ON eventos_processados (recebido_em)
    WHERE processado_em IS NULL AND evento IS NOT NULL;

COMMIT;
