-- ═══════════════════════════════════════════════════════════════════════
-- 006 — Ledger de VENDAS no Postgres + `extra` nos usuários (pré-cutover)
--
-- (1) VENDAS: até aqui a receita vivia só em vendas.json. Esta tabela torna a
--     idempotência de webhook INSERT-first de verdade: UNIQUE(gateway,
--     transaction_id) faz a reentrega da Hotmart (que reenvia por DIAS) virar
--     conflito — nunca crédito em dobro, mesmo após restore de backup.
--
-- (2) USUARIOS.EXTRA: a tabela só conhecia nome/email/senha/papel. Os campos
--     novos do admin comercial (suspended, iaPropria, definirSenha, criadoPor)
--     não tinham onde morar — um boot com o PG como árbitro DES-SUSPENDERIA
--     clientes e apagaria tokens. O JSONB `extra` carrega tudo que a coluna
--     não conhece, no mesmo desenho que `projetos.extra` já usa.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS vendas (
  id               UUID PRIMARY KEY,
  gateway          TEXT NOT NULL,
  transaction_id   TEXT NOT NULL,
  username         CITEXT,
  email            TEXT,
  valor_brl        NUMERIC(12,2) NOT NULL DEFAULT 0,
  meio             TEXT,
  referencia       TEXT,
  plano            TEXT,
  origem           TEXT NOT NULL DEFAULT 'manual',
  status           TEXT NOT NULL DEFAULT 'aprovada',
  evento           TEXT,
  registrada_por   TEXT,
  confirmada_por   TEXT,
  confirmada_em    TIMESTAMPTZ,
  reembolso_evento TEXT,
  reembolsada_em   TIMESTAMPTZ,
  criada_em        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A trava que vale dinheiro: um gateway nunca credita a mesma transação 2×.
  CONSTRAINT vendas_gateway_tx UNIQUE (gateway, transaction_id)
);

CREATE INDEX IF NOT EXISTS vendas_username_idx  ON vendas (username);
CREATE INDEX IF NOT EXISTS vendas_criada_em_idx ON vendas (criada_em DESC);

-- Mesmo endurecimento das migrações anteriores: nada para PUBLIC; a aplicação
-- (nascera_app, NOSUPERUSER NOBYPASSRLS) ganha só o que usa. Sem DELETE: o
-- ledger é imutável em espírito — reembolso é UPDATE de status, nunca apagar.
REVOKE ALL ON TABLE vendas FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nascera_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE vendas TO nascera_app';
  END IF;
END $$;
