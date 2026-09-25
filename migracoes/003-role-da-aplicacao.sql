-- ═══════════════════════════════════════════════════════════════════════
-- NASCERA — role da aplicação
--
-- Sem esta migration, TODA a RLS da 002 é decorativa. Descobri isso testando:
-- as policies estavam certas, mas o app conectava como superusuário — e
-- superusuário ignora Row Level Security, inclusive com FORCE. O teste
-- mostrava alice enxergando os projetos do bob.
--
-- A regra: o app NUNCA conecta como superusuário nem como dono do schema.
-- Conecta como `nascera_app`, que é NOSUPERUSER e NOBYPASSRLS — assim as
-- policies valem de verdade. Quem cria/migra schema é outra conta.
-- ═══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nascera_app') THEN
    -- Sem senha aqui de propósito: quem define é o operador, fora do
    -- repositório (ALTER ROLE nascera_app PASSWORD '...'), para o segredo
    -- não viver no controle de versão.
    CREATE ROLE nascera_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  ELSE
    ALTER ROLE nascera_app NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO nascera_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nascera_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nascera_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO nascera_app;

-- Tabelas e sequências criadas por migrations futuras já nascem acessíveis.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nascera_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO nascera_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO nascera_app;

-- O controle de migrations é do administrador, não do app.
REVOKE ALL ON TABLE _migracoes FROM nascera_app;

-- `debitar_turno` é SECURITY DEFINER: roda com os poderes de quem a criou,
-- para poder escrever no saldo mesmo com RLS ligada. Fixar o search_path
-- impede que um schema plantado no caminho sequestre a função.
ALTER FUNCTION debitar_turno(CITEXT, TEXT, BIGINT, NUMERIC, NUMERIC, JSONB, NUMERIC)
  SET search_path = public, pg_temp;
