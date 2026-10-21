-- =====================================================================
-- Atendimento WhatsApp IA - 006: abertura manual temporária (/abrir_agora no Telegram)
--
-- Migration incremental (NÃO editar 001-005). Executar SOMENTE no banco
-- atendimento (e no atendimento_teste, pelo preparo dos testes). Roda em
-- uma transação.
--
-- Um administrador do grupo abre a loja por alguns minutos (5 a 720),
-- mesmo fora do horário ou em dia fechado manualmente. A memória do
-- backend é a fonte de verdade; esta tabela só a recarrega na partida
-- (uma abertura ainda válida: fim no futuro e não cancelada). Um novo
-- /abrir_agora cancela a anterior (cancelado_em).
-- =====================================================================

BEGIN;

CREATE TABLE aberturas_manuais (
    id            BIGSERIAL    NOT NULL,

    inicio        TIMESTAMPTZ  NOT NULL,

    fim           TIMESTAMPTZ  NOT NULL,

    -- Quem abriu (vendedores.id). NULL quando o administrador não está na
    -- tabela vendedores (nunca fez /start nem assumiu).
    criado_por    BIGINT,

    -- /cancelar_abertura ou substituída por outro /abrir_agora.
    cancelado_em  TIMESTAMPTZ,

    criado_em     TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT pk_aberturas_manuais PRIMARY KEY (id),

    CONSTRAINT chk_aberturas_manuais_periodo CHECK (fim > inicio),

    -- SET NULL: apagar um vendedor nunca é impedido por uma abertura.
    CONSTRAINT fk_aberturas_manuais_vendedor
        FOREIGN KEY (criado_por) REFERENCES vendedores (id)
        ON DELETE SET NULL
);

CREATE INDEX ix_aberturas_manuais_fim ON aberturas_manuais (fim);

COMMIT;
