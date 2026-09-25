-- ═══════════════════════════════════════════════════════════════════════
-- NASCERA — Row Level Security + débito atômico
--
-- Aqui a multi-tenancy deixa de ser disciplina de código e passa a ser regra
-- do banco. O portão em `projectOr404` continua sendo a PRIMEIRA barreira —
-- isto é a segunda, a que não falha por esquecimento. Foi exatamente um
-- esquecimento (a rota /api/fs/* sem checagem) que abriu o vazamento entre
-- clientes; com RLS, a mesma omissão não teria vazado nada.
--
-- Como o contexto chega: db.js abre transação e faz
--   SELECT set_config('app.usuario', $1, true)   -- true = LOCAL (só nesta tx)
-- Sem transação não há contexto, e a policy nega. Isso é intencional: melhor
-- negar acesso legítimo (erro visível) do que vazar (erro invisível).
-- ═══════════════════════════════════════════════════════════════════════

-- Helpers: leem o contexto da transação. STABLE porque não mudam dentro dela.
CREATE OR REPLACE FUNCTION app_usuario() RETURNS TEXT
  LANGUAGE sql STABLE AS $$ SELECT current_setting('app.usuario', true) $$;

CREATE OR REPLACE FUNCTION app_eh_admin() RETURNS BOOLEAN
  LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.papel', true) = 'admin', false) $$;

-- ── policies ─────────────────────────────────────────────────────────
-- FORCE faz a regra valer até para o dono da tabela; sem ele, a conta que
-- criou o schema passaria por cima de tudo e a proteção seria decorativa.

ALTER TABLE projetos       ENABLE ROW LEVEL SECURITY;
ALTER TABLE projetos       FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS projetos_dono ON projetos;
CREATE POLICY projetos_dono ON projetos
  USING      (owner_username = app_usuario() OR app_eh_admin())
  WITH CHECK (owner_username = app_usuario() OR app_eh_admin());

ALTER TABLE lixeira        ENABLE ROW LEVEL SECURITY;
ALTER TABLE lixeira        FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lixeira_dono ON lixeira;
CREATE POLICY lixeira_dono ON lixeira
  USING      (owner_username = app_usuario() OR app_eh_admin())
  WITH CHECK (owner_username = app_usuario() OR app_eh_admin());

ALTER TABLE dominios       ENABLE ROW LEVEL SECURITY;
ALTER TABLE dominios       FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dominios_dono ON dominios;
CREATE POLICY dominios_dono ON dominios
  USING      (owner_username = app_usuario() OR app_eh_admin())
  WITH CHECK (owner_username = app_usuario() OR app_eh_admin());

ALTER TABLE contas_credito ENABLE ROW LEVEL SECURITY;
ALTER TABLE contas_credito FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contas_dono ON contas_credito;
CREATE POLICY contas_dono ON contas_credito
  USING      (username = app_usuario() OR app_eh_admin())
  WITH CHECK (username = app_usuario() OR app_eh_admin());

ALTER TABLE cortesias      ENABLE ROW LEVEL SECURITY;
ALTER TABLE cortesias      FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cortesias_dono ON cortesias;
CREATE POLICY cortesias_dono ON cortesias
  USING      (username = app_usuario() OR app_eh_admin())
  WITH CHECK (username = app_usuario() OR app_eh_admin());

ALTER TABLE janelas_gasto  ENABLE ROW LEVEL SECURITY;
ALTER TABLE janelas_gasto  FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS janelas_dono ON janelas_gasto;
CREATE POLICY janelas_dono ON janelas_gasto
  USING      (username = app_usuario() OR app_eh_admin())
  WITH CHECK (username = app_usuario() OR app_eh_admin());

ALTER TABLE eventos_uso    ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventos_uso    FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS eventos_dono ON eventos_uso;
CREATE POLICY eventos_dono ON eventos_uso
  USING      (username = app_usuario() OR app_eh_admin())
  WITH CHECK (username = app_usuario() OR app_eh_admin());

-- usuarios: cada um enxerga a própria conta; admin enxerga todas.
ALTER TABLE usuarios       ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuarios       FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS usuarios_proprio ON usuarios;
CREATE POLICY usuarios_proprio ON usuarios
  USING      (username = app_usuario() OR app_eh_admin())
  WITH CHECK (username = app_usuario() OR app_eh_admin());

-- log_atividade: escrever é livre (o app registra em nome de qualquer um);
-- LER é restrito ao próprio usuário, ou tudo para admin.
ALTER TABLE log_atividade  ENABLE ROW LEVEL SECURITY;
ALTER TABLE log_atividade  FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS log_leitura  ON log_atividade;
DROP POLICY IF EXISTS log_escrita  ON log_atividade;
CREATE POLICY log_leitura ON log_atividade FOR SELECT
  USING (usuario = app_usuario() OR app_eh_admin() OR usuario IS NULL);
CREATE POLICY log_escrita ON log_atividade FOR INSERT WITH CHECK (true);

-- ── débito atômico ───────────────────────────────────────────────────
-- Substitui o read-modify-write do billing.json. Três garantias que o
-- arquivo não dava:
--   1. idempotência PERMANENTE (UNIQUE em turn_id), não um anel de 300;
--   2. FOR UPDATE serializa débitos concorrentes da mesma conta;
--   3. tudo numa transação — ou o débito inteiro acontece, ou nada acontece.
--
-- SECURITY DEFINER: o débito precisa escrever mesmo com RLS ligada. A função
-- é a ÚNICA porta que faz isso, e ela sempre escreve na conta que recebeu
-- por parâmetro — não há como um usuário debitar a conta de outro por aqui.
--
-- O PREÇO continua em JS (priceTurn, em billing.js): esta função só move
-- valor, não decide quanto custa. Regra de negócio fica onde já está.
CREATE OR REPLACE FUNCTION debitar_turno(
  p_username     CITEXT,
  p_turn_id      TEXT,
  p_cost_milli   BIGINT,
  p_base_usd     NUMERIC,
  p_charged_usd  NUMERIC,
  p_per_model    JSONB,
  p_usd_per_credit NUMERIC
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_falta        BIGINT := p_cost_milli;
  v_de_cortesia  BIGINT := 0;
  v_de_saldo     BIGINT := 0;
  v_pega         BIGINT;
  v_cortesia     RECORD;
  v_saldo        BIGINT;
  v_coberto_usd  NUMERIC;
  v_resto_usd    NUMERIC;
BEGIN
  -- (1) Idempotência primeiro: se o turno já foi cobrado, sai sem tocar em nada.
  BEGIN
    INSERT INTO eventos_uso (username, turn_id, base_usd, charged_usd, per_model, cost_milli)
    VALUES (p_username, p_turn_id, p_base_usd, p_charged_usd, p_per_model, p_cost_milli);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('duplicate', true);
  END;

  -- (2) Trava a conta: dois débitos simultâneos viram fila, não corrida.
  SELECT saldo_milli INTO v_saldo FROM contas_credito
    WHERE username = p_username FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO contas_credito (username) VALUES (p_username);
    v_saldo := 0;
  END IF;

  -- (3) Cortesia primeiro, da que expira antes (NULL = sem prazo, por último).
  FOR v_cortesia IN
    SELECT id, restante_milli FROM cortesias
     WHERE username = p_username AND restante_milli > 0
       AND (expira_em IS NULL OR expira_em > now())
     ORDER BY expira_em NULLS LAST
     FOR UPDATE
  LOOP
    EXIT WHEN v_falta <= 0;
    v_pega := LEAST(v_cortesia.restante_milli, v_falta);
    UPDATE cortesias SET restante_milli = restante_milli - v_pega WHERE id = v_cortesia.id;
    v_falta := v_falta - v_pega;
    v_de_cortesia := v_de_cortesia + v_pega;
  END LOOP;

  -- (4) Depois o saldo avulso. O CHECK da tabela impede ficar negativo.
  IF v_falta > 0 AND v_saldo > 0 THEN
    v_pega := LEAST(v_saldo, v_falta);
    UPDATE contas_credito SET saldo_milli = saldo_milli - v_pega WHERE username = p_username;
    v_falta := v_falta - v_pega;
    v_de_saldo := v_de_saldo + v_pega;
  END IF;

  -- (5) O que não foi coberto vira gasto nas janelas, em USD com precisão
  --     total (derivado do valor real, não do milli arredondado).
  v_coberto_usd := (v_de_cortesia + v_de_saldo)::NUMERIC * p_usd_per_credit / 1000;
  v_resto_usd   := GREATEST(0, p_charged_usd - v_coberto_usd);

  UPDATE eventos_uso
     SET from_grants = v_de_cortesia, from_balance = v_de_saldo, remainder_usd = v_resto_usd
   WHERE username = p_username AND turn_id = p_turn_id;

  RETURN jsonb_build_object(
    'duplicate', false,
    'fromGrants', v_de_cortesia,
    'fromBalance', v_de_saldo,
    'remainderUsd', v_resto_usd,
    'costMilli', p_cost_milli
  );
END; $$;

-- ── exibição (§3.1 das regras invioláveis) ───────────────────────────
-- VIEW para que a soma proibida (saldo + cortesia + remaining) não volte por
-- descuido: quem consulta daqui recebe o número certo por construção.
CREATE OR REPLACE VIEW v_resumo_credito AS
  SELECT c.username,
         c.plano,
         c.saldo_milli,
         COALESCE((SELECT SUM(restante_milli) FROM cortesias g
                    WHERE g.username = c.username AND g.restante_milli > 0
                      AND (g.expira_em IS NULL OR g.expira_em > now())), 0) AS cortesia_milli
    FROM contas_credito c;
