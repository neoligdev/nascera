-- ═══════════════════════════════════════════════════════════════════════
-- 008 — Pacotes avulsos de créditos (Fase 2, Parte B)
--
-- A venda de um PACOTE (créditos avulsos, sem assinatura) usa a MESMA
-- tabela `vendas` da 006 — só ganha uma coluna paralela a `plano`. Nunca as
-- duas preenchidas na mesma venda (rotas/webhooks.js garante isso, e a
-- config do gateway recusa oferta mapeada pra ambos ao mesmo tempo).
--
-- NÃO TESTÁVEL NESTE AMBIENTE (sem Postgres/DATABASE_URL) — validar antes
-- de produção, mesma ressalva já usada na migração 007.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE vendas ADD COLUMN IF NOT EXISTS pacote_creditos INTEGER;

-- Redundante com a 006 (a tabela inteira já foi liberada pro role da
-- aplicação; uma coluna nova herda a mesma concessão automaticamente) —
-- repetido aqui pelo mesmo hábito de defesa em profundidade das migrações
-- anteriores: cada arquivo se explica sozinho, sem depender de nenhum
-- outro ter rodado antes com o grant intacto.
REVOKE ALL ON TABLE vendas FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nascera_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE vendas TO nascera_app';
  END IF;
END $$;
