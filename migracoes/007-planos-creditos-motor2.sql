-- ═══════════════════════════════════════════════════════════════════════
-- 007 — Planos, Créditos e Motor 2 (Fase 1)
--
-- Alinha o espelho Postgres à nova regra de negócio: saldos de crédito por
-- ORIGEM (assinatura premium / bônus diário / comprado) em vez de só
-- cortesia+saldo avulso, e um ledger próprio de uso do Motor 2 (a
-- "capacidade adicional" que não debita crédito, mas tem franquia diária).
--
-- A decisão de QUANTO cobrar de cada origem continua no billing.js — esta
-- migração só dá ao Postgres onde aplicar o valor já decidido (mesmo
-- princípio do arquivo billing-db.js: "aqui só se move valor").
-- ═══════════════════════════════════════════════════════════════════════

-- ── cortesias ganham origem ─────────────────────────────────────────────
-- Lotes existentes (concessões manuais do admin, sem marca) viram 'cortesia'
-- por padrão — comportamento idêntico ao de hoje, sem migração de dado.
ALTER TABLE cortesias ADD COLUMN IF NOT EXISTS origem TEXT NOT NULL DEFAULT 'cortesia'
  CHECK (origem IN ('cortesia', 'bonus', 'comprado'));

-- ── eventos_uso ganham a fatia por origem (auditoria fina, doc §11) ─────
ALTER TABLE eventos_uso ADD COLUMN IF NOT EXISTS from_bonus_milli    BIGINT NOT NULL DEFAULT 0;
ALTER TABLE eventos_uso ADD COLUMN IF NOT EXISTS from_premium_milli  BIGINT NOT NULL DEFAULT 0;
ALTER TABLE eventos_uso ADD COLUMN IF NOT EXISTS from_comprado_milli BIGINT NOT NULL DEFAULT 0;

-- ── motor2_eventos ← ledger de uso do Motor 2 (append-only, auditoria) ──
-- O Motor 2 NÃO debita crédito (doc §7/§8: é capacidade adicional, não
-- cobrada) — mas cada uso é registrado aqui pra franquia diária e dashboard
-- de consumo (doc §13) terem de onde ler, com idempotência por turn_id igual
-- ao resto do arquivo do dinheiro.
CREATE TABLE IF NOT EXISTS motor2_eventos (
  id          BIGSERIAL PRIMARY KEY,
  username    CITEXT NOT NULL,
  projeto_id  UUID,
  turn_id     TEXT,
  dia         TEXT NOT NULL,          -- '2026-09-28' na mesma chave de fuso do billing.js
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (username, turn_id)
);
CREATE INDEX IF NOT EXISTS idx_motor2_eventos_user_dia ON motor2_eventos(username, dia);

-- ── debitar_turno: nova assinatura, ordem bônus → premium → comprado ────
-- Assinatura antiga (11 args) sai de cena — substituída pela de 14 args
-- (as 3 fatias já decididas pelo billing.js). Sem isso, a CREATE OR REPLACE
-- abaixo criaria uma SEGUNDA função por overload em vez de substituir.
DROP FUNCTION IF EXISTS debitar_turno(CITEXT, TEXT, BIGINT, NUMERIC, NUMERIC, JSONB, NUMERIC, TEXT, TEXT, TEXT, BIGINT);

CREATE FUNCTION debitar_turno(
  p_username       CITEXT,
  p_turn_id        TEXT,
  p_cost_milli     BIGINT,
  p_base_usd       NUMERIC,
  p_charged_usd    NUMERIC,
  p_per_model      JSONB,
  p_usd_per_credit NUMERIC,
  p_chave_dia      TEXT DEFAULT NULL,
  p_chave_semana   TEXT DEFAULT NULL,
  p_chave_mes      TEXT DEFAULT NULL,
  p_sessao_ms      BIGINT DEFAULT 18000000,
  p_from_bonus_milli    BIGINT DEFAULT 0,
  p_from_premium_milli  BIGINT DEFAULT 0,
  p_from_comprado_milli BIGINT DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_falta_bonus    BIGINT := p_from_bonus_milli;
  v_falta_comprado BIGINT := p_from_comprado_milli;
  v_de_bonus       BIGINT := 0;
  v_de_comprado    BIGINT := 0;
  v_de_saldo       BIGINT := 0;
  v_pega           BIGINT;
  v_cortesia       RECORD;
  v_saldo          BIGINT;
  v_coberto_usd    NUMERIC;
  v_resto_usd      NUMERIC;
  v_sessao_ini     TIMESTAMPTZ;
BEGIN
  -- Idempotência primeiro: turno já cobrado sai sem tocar em nada.
  BEGIN
    INSERT INTO eventos_uso (username, turn_id, base_usd, charged_usd, per_model, cost_milli)
    VALUES (p_username, p_turn_id, p_base_usd, p_charged_usd, p_per_model, p_cost_milli);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('duplicate', true);
  END;

  INSERT INTO contas_credito (username) VALUES (p_username)
    ON CONFLICT (username) DO NOTHING;
  SELECT saldo_milli INTO v_saldo FROM contas_credito
    WHERE username = p_username FOR UPDATE;

  -- Bônus diário: só cortesias origem='bonus', até a fatia que o billing.js
  -- já decidiu (não recalcula elegibilidade/teto aqui — só aplica).
  FOR v_cortesia IN
    SELECT id, restante_milli FROM cortesias
     WHERE username = p_username AND origem = 'bonus' AND restante_milli > 0
       AND (expira_em IS NULL OR expira_em > now())
     ORDER BY criada_em, id
     FOR UPDATE
  LOOP
    EXIT WHEN v_falta_bonus <= 0;
    v_pega := LEAST(v_cortesia.restante_milli, v_falta_bonus);
    UPDATE cortesias SET restante_milli = restante_milli - v_pega WHERE id = v_cortesia.id;
    v_falta_bonus := v_falta_bonus - v_pega;
    v_de_bonus := v_de_bonus + v_pega;
  END LOOP;

  -- Comprado + cortesia legada (sem marca de origem = 'cortesia' pelo
  -- default da coluna): mesma ordem de criação, na fatia que sobrou do
  -- premium (p_from_comprado_milli já veio calculada assim do billing.js).
  FOR v_cortesia IN
    SELECT id, restante_milli FROM cortesias
     WHERE username = p_username AND origem IN ('comprado', 'cortesia') AND restante_milli > 0
       AND (expira_em IS NULL OR expira_em > now())
     ORDER BY criada_em, id
     FOR UPDATE
  LOOP
    EXIT WHEN v_falta_comprado <= 0;
    v_pega := LEAST(v_cortesia.restante_milli, v_falta_comprado);
    UPDATE cortesias SET restante_milli = restante_milli - v_pega WHERE id = v_cortesia.id;
    v_falta_comprado := v_falta_comprado - v_pega;
    v_de_comprado := v_de_comprado + v_pega;
  END LOOP;

  IF v_falta_comprado > 0 AND v_saldo > 0 THEN
    v_pega := LEAST(v_saldo, v_falta_comprado);
    UPDATE contas_credito SET saldo_milli = saldo_milli - v_pega WHERE username = p_username;
    v_falta_comprado := v_falta_comprado - v_pega;
    v_de_saldo := v_de_saldo + v_pega;
  END IF;

  -- Cobertura real (bônus + comprado + saldo). O premium NUNCA entra aqui —
  -- ele é orçamento (janela 'month'), não um lote discreto: sua fatia cai
  -- direto no remainder abaixo, exatamente como sempre caiu (o "resto vira
  -- gasto USD cobrado nas janelas" já é, desde a 004, o mecanismo que
  -- registra consumo do plano — ver billing.js debitTurn, passo 5).
  v_coberto_usd := (v_de_bonus + v_de_comprado + v_de_saldo)::NUMERIC * p_usd_per_credit / 1000;
  v_resto_usd   := GREATEST(0, p_charged_usd - v_coberto_usd);

  UPDATE eventos_uso
     SET from_grants = v_de_bonus + v_de_comprado, from_balance = v_de_saldo,
         from_bonus_milli = v_de_bonus, from_premium_milli = p_from_premium_milli,
         from_comprado_milli = v_de_comprado + v_de_saldo,
         remainder_usd = v_resto_usd
   WHERE username = p_username AND turn_id = p_turn_id;

  -- Janelas de calendário: chave igual acumula, chave diferente vira.
  IF p_chave_dia IS NOT NULL THEN
    INSERT INTO janelas_gasto (username, escopo, chave, inicio_ts, usd, base_usd, charged_usd)
    VALUES (p_username, 'day', p_chave_dia, now(), v_resto_usd, p_base_usd, p_charged_usd)
    ON CONFLICT (username, escopo) DO UPDATE SET
      usd = CASE WHEN janelas_gasto.chave = EXCLUDED.chave
                 THEN janelas_gasto.usd + EXCLUDED.usd ELSE EXCLUDED.usd END,
      base_usd = CASE WHEN janelas_gasto.chave = EXCLUDED.chave
                 THEN janelas_gasto.base_usd + EXCLUDED.base_usd ELSE EXCLUDED.base_usd END,
      charged_usd = CASE WHEN janelas_gasto.chave = EXCLUDED.chave
                 THEN janelas_gasto.charged_usd + EXCLUDED.charged_usd ELSE EXCLUDED.charged_usd END,
      inicio_ts = CASE WHEN janelas_gasto.chave = EXCLUDED.chave
                 THEN janelas_gasto.inicio_ts ELSE EXCLUDED.inicio_ts END,
      chave = EXCLUDED.chave;
  END IF;

  IF p_chave_semana IS NOT NULL THEN
    INSERT INTO janelas_gasto (username, escopo, chave, inicio_ts, usd, base_usd, charged_usd)
    VALUES (p_username, 'week', p_chave_semana, now(), v_resto_usd, p_base_usd, p_charged_usd)
    ON CONFLICT (username, escopo) DO UPDATE SET
      usd = CASE WHEN janelas_gasto.chave = EXCLUDED.chave
                 THEN janelas_gasto.usd + EXCLUDED.usd ELSE EXCLUDED.usd END,
      base_usd = CASE WHEN janelas_gasto.chave = EXCLUDED.chave
                 THEN janelas_gasto.base_usd + EXCLUDED.base_usd ELSE EXCLUDED.base_usd END,
      charged_usd = CASE WHEN janelas_gasto.chave = EXCLUDED.chave
                 THEN janelas_gasto.charged_usd + EXCLUDED.charged_usd ELSE EXCLUDED.charged_usd END,
      inicio_ts = CASE WHEN janelas_gasto.chave = EXCLUDED.chave
                 THEN janelas_gasto.inicio_ts ELSE EXCLUDED.inicio_ts END,
      chave = EXCLUDED.chave;
  END IF;

  IF p_chave_mes IS NOT NULL THEN
    INSERT INTO janelas_gasto (username, escopo, chave, inicio_ts, usd, base_usd, charged_usd)
    VALUES (p_username, 'month', p_chave_mes, now(), v_resto_usd, p_base_usd, p_charged_usd)
    ON CONFLICT (username, escopo) DO UPDATE SET
      usd = CASE WHEN janelas_gasto.chave = EXCLUDED.chave
                 THEN janelas_gasto.usd + EXCLUDED.usd ELSE EXCLUDED.usd END,
      base_usd = CASE WHEN janelas_gasto.chave = EXCLUDED.chave
                 THEN janelas_gasto.base_usd + EXCLUDED.base_usd ELSE EXCLUDED.base_usd END,
      charged_usd = CASE WHEN janelas_gasto.chave = EXCLUDED.chave
                 THEN janelas_gasto.charged_usd + EXCLUDED.charged_usd ELSE EXCLUDED.charged_usd END,
      inicio_ts = CASE WHEN janelas_gasto.chave = EXCLUDED.chave
                 THEN janelas_gasto.inicio_ts ELSE EXCLUDED.inicio_ts END,
      chave = EXCLUDED.chave;
  END IF;

  -- Sessão: janela rolante de 5h pelo relógio do banco.
  SELECT inicio_ts INTO v_sessao_ini FROM janelas_gasto
   WHERE username = p_username AND escopo = 'session';

  IF v_sessao_ini IS NULL OR now() - v_sessao_ini >= (p_sessao_ms || ' milliseconds')::INTERVAL THEN
    INSERT INTO janelas_gasto (username, escopo, chave, inicio_ts, usd, base_usd, charged_usd)
    VALUES (p_username, 'session', to_char(now(), 'YYYYMMDD"T"HH24MISS'), now(),
            p_charged_usd, p_base_usd, p_charged_usd)
    ON CONFLICT (username, escopo) DO UPDATE SET
      chave = EXCLUDED.chave, inicio_ts = EXCLUDED.inicio_ts,
      usd = EXCLUDED.usd, base_usd = EXCLUDED.base_usd, charged_usd = EXCLUDED.charged_usd;
  ELSE
    UPDATE janelas_gasto
       SET usd = usd + p_charged_usd, base_usd = base_usd + p_base_usd,
           charged_usd = charged_usd + p_charged_usd
     WHERE username = p_username AND escopo = 'session';
  END IF;

  RETURN jsonb_build_object(
    'duplicate', false, 'fromBonus', v_de_bonus, 'fromComprado', v_de_comprado + v_de_saldo,
    'remainderUsd', v_resto_usd, 'costMilli', p_cost_milli,
    'saldoMilli', (SELECT saldo_milli FROM contas_credito WHERE username = p_username),
    'cortesiaMilli', COALESCE((SELECT SUM(restante_milli) FROM cortesias
                                WHERE username = p_username AND restante_milli > 0
                                  AND (expira_em IS NULL OR expira_em > now())), 0)
  );
END; $$;

-- ── SEGURANÇA: mesma política da 005 — só a role da aplicação executa ───
REVOKE ALL ON FUNCTION debitar_turno(CITEXT, TEXT, BIGINT, NUMERIC, NUMERIC, JSONB, NUMERIC, TEXT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON TABLE motor2_eventos FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nascera_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION debitar_turno(CITEXT, TEXT, BIGINT, NUMERIC, NUMERIC, JSONB, NUMERIC, TEXT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, BIGINT) TO nascera_app';
    EXECUTE 'GRANT SELECT, INSERT ON motor2_eventos TO nascera_app';
    EXECUTE 'GRANT USAGE ON SEQUENCE motor2_eventos_id_seq TO nascera_app';
  END IF;
END $$;
