-- ═══════════════════════════════════════════════════════════════════════
-- 005 — Correções na função do dinheiro (achados da revisão adversarial)
--
-- A 004 entregou o débito com as janelas, mas a revisão encontrou quatro
-- defeitos reais, dois deles de SEGURANÇA. Todos reproduzidos contra o banco.
-- ═══════════════════════════════════════════════════════════════════════

-- ── (1) SEGURANÇA: SECURITY DEFINER sem search_path ────────────────────
-- A 003 aplicava `SET search_path` na função; a 004 recriou o corpo e a
-- cláusula se perdeu. Numa função SECURITY DEFINER isso é sequestro: quem
-- puder criar objeto em `pg_temp` planta uma tabela `cortesias` falsa, e a
-- função do DINHEIRO passa a ler e escrever nela achando que cobrou.
--
-- ── (2) ATOMICIDADE: conta nova + dois turnos = débito perdido ──────────
-- `SELECT ... FOR UPDATE` numa linha que ainda não existe não trava nada, e
-- o `INSERT INTO contas_credito` seguinte não tinha ON CONFLICT. Com dois
-- turnos simultâneos de um usuário novo, o segundo estoura unique_violation
-- FORA do handler (que só cobre o INSERT em eventos_uso) e a transação
-- inteira é revertida: evento, cortesia, saldo e janelas do turno somem.
-- O JSON já tinha cobrado. Reproduzido com duas conexões: A devolveu débito,
-- B devolveu 23505 e o banco ficou com 1 evento para 2 turnos cobrados.
-- Correção: upsert ANTES do FOR UPDATE — a linha passa a existir sempre, e
-- a corrida vira fila, que é o que a função promete.
--
-- ── (3) PARIDADE: ordem de consumo das cortesias ────────────────────────
-- O JS gasta as cortesias na ordem de criação; o SQL gastava a que expira
-- primeiro. Num cliente com duas cortesias de prazos diferentes os dois
-- lados debitam de bolsos distintos e o saldo diverge para sempre. Como o
-- JSON é o que está em produção hoje, o SQL passa a seguir ELE (criada_em).
-- (Gastar a que expira antes é melhor para o cliente — vale como mudança de
-- produto depois, feita nos DOIS lados ao mesmo tempo.)
--
-- ── (4) JANELA VENCIDA NA LEITURA ───────────────────────────────────────
-- `estado_credito` devolvia a janela gravada mesmo que a chave fosse de
-- ontem/do mês passado: o portão leria gasto velho como se fosse de agora e
-- bloquearia cliente pagante. Agora a leitura recebe as chaves de hoje e
-- zera o que está vencido — o mesmo lazyReset do JS, na leitura.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION debitar_turno(
  p_username     CITEXT,
  p_turn_id      TEXT,
  p_cost_milli   BIGINT,
  p_base_usd     NUMERIC,
  p_charged_usd  NUMERIC,
  p_per_model    JSONB,
  p_usd_per_credit NUMERIC,
  p_chave_dia    TEXT DEFAULT NULL,
  p_chave_semana TEXT DEFAULT NULL,
  p_chave_mes    TEXT DEFAULT NULL,
  p_sessao_ms    BIGINT DEFAULT 18000000
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog   -- (1) pg_temp fora do caminho
AS $$
DECLARE
  v_falta        BIGINT := p_cost_milli;
  v_de_cortesia  BIGINT := 0;
  v_de_saldo     BIGINT := 0;
  v_pega         BIGINT;
  v_cortesia     RECORD;
  v_saldo        BIGINT;
  v_coberto_usd  NUMERIC;
  v_resto_usd    NUMERIC;
  v_sessao_ini   TIMESTAMPTZ;
BEGIN
  -- Idempotência primeiro: turno já cobrado sai sem tocar em nada.
  BEGIN
    INSERT INTO eventos_uso (username, turn_id, base_usd, charged_usd, per_model, cost_milli)
    VALUES (p_username, p_turn_id, p_base_usd, p_charged_usd, p_per_model, p_cost_milli);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('duplicate', true);
  END;

  -- (2) Garante a linha ANTES de travar. Sem isto, dois turnos simultâneos
  -- de conta nova faziam o segundo abortar a transação inteira.
  INSERT INTO contas_credito (username) VALUES (p_username)
    ON CONFLICT (username) DO NOTHING;
  SELECT saldo_milli INTO v_saldo FROM contas_credito
    WHERE username = p_username FOR UPDATE;

  -- (3) Cortesia na MESMA ordem do JS: por criação.
  FOR v_cortesia IN
    SELECT id, restante_milli FROM cortesias
     WHERE username = p_username AND restante_milli > 0
       AND (expira_em IS NULL OR expira_em > now())
     ORDER BY criada_em, id
     FOR UPDATE
  LOOP
    EXIT WHEN v_falta <= 0;
    v_pega := LEAST(v_cortesia.restante_milli, v_falta);
    UPDATE cortesias SET restante_milli = restante_milli - v_pega WHERE id = v_cortesia.id;
    v_falta := v_falta - v_pega;
    v_de_cortesia := v_de_cortesia + v_pega;
  END LOOP;

  IF v_falta > 0 AND v_saldo > 0 THEN
    v_pega := LEAST(v_saldo, v_falta);
    UPDATE contas_credito SET saldo_milli = saldo_milli - v_pega WHERE username = p_username;
    v_falta := v_falta - v_pega;
    v_de_saldo := v_de_saldo + v_pega;
  END IF;

  v_coberto_usd := (v_de_cortesia + v_de_saldo)::NUMERIC * p_usd_per_credit / 1000;
  v_resto_usd   := GREATEST(0, p_charged_usd - v_coberto_usd);

  UPDATE eventos_uso
     SET from_grants = v_de_cortesia, from_balance = v_de_saldo, remainder_usd = v_resto_usd
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
    'duplicate', false, 'fromGrants', v_de_cortesia, 'fromBalance', v_de_saldo,
    'remainderUsd', v_resto_usd, 'costMilli', p_cost_milli,
    -- devolve o estado pós-débito para o chamador espelhar sem outra ida ao banco
    'saldoMilli', (SELECT saldo_milli FROM contas_credito WHERE username = p_username),
    'cortesiaMilli', COALESCE((SELECT SUM(restante_milli) FROM cortesias
                                WHERE username = p_username AND restante_milli > 0
                                  AND (expira_em IS NULL OR expira_em > now())), 0)
  );
END; $$;

-- (4) Leitura que respeita a virada de janela. Recebe as chaves de agora e
-- devolve 0 para a janela cuja chave não bate — o portão passa a ler o
-- período corrente, não o gasto de ontem.
CREATE OR REPLACE FUNCTION estado_credito(
  p_username     CITEXT,
  p_chave_dia    TEXT DEFAULT NULL,
  p_chave_semana TEXT DEFAULT NULL,
  p_chave_mes    TEXT DEFAULT NULL,
  p_sessao_ms    BIGINT DEFAULT 18000000
) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_build_object(
    'plano',        COALESCE((SELECT plano FROM contas_credito WHERE username = p_username), 'free'),
    'saldoMilli',   COALESCE((SELECT saldo_milli FROM contas_credito WHERE username = p_username), 0),
    'cortesiaMilli',COALESCE((SELECT SUM(restante_milli) FROM cortesias
                               WHERE username = p_username AND restante_milli > 0
                                 AND (expira_em IS NULL OR expira_em > now())), 0),
    'janelas',      COALESCE((SELECT jsonb_object_agg(escopo, jsonb_build_object(
                                 'chave', chave, 'inicioTs', inicio_ts,
                                 -- janela vencida conta como zero
                                 'usd', CASE WHEN vencida THEN 0 ELSE usd END,
                                 'baseUsd', CASE WHEN vencida THEN 0 ELSE base_usd END,
                                 'chargedUsd', CASE WHEN vencida THEN 0 ELSE charged_usd END,
                                 'vencida', vencida))
                              FROM (
                                SELECT w.*, (
                                  CASE w.escopo
                                    WHEN 'day'   THEN p_chave_dia    IS NOT NULL AND w.chave <> p_chave_dia
                                    WHEN 'week'  THEN p_chave_semana IS NOT NULL AND w.chave <> p_chave_semana
                                    WHEN 'month' THEN p_chave_mes    IS NOT NULL AND w.chave <> p_chave_mes
                                    WHEN 'session' THEN now() - w.inicio_ts >= (p_sessao_ms || ' milliseconds')::INTERVAL
                                    ELSE false END) AS vencida
                                  FROM janelas_gasto w WHERE w.username = p_username) z), '{}'::jsonb)
  );
$$;

-- ── SEGURANÇA: fechar EXECUTE para PUBLIC ──────────────────────────────
-- As duas funções são SECURITY DEFINER e leem/escrevem o financeiro de
-- qualquer conta. Com EXECUTE em PUBLIC, QUALQUER role do cluster (inclusive
-- uma role de leitura criada depois para relatórios) consegue ler o crédito
-- de todos os clientes — e chamar o débito. Só a role da aplicação executa.
REVOKE ALL ON FUNCTION debitar_turno(CITEXT, TEXT, BIGINT, NUMERIC, NUMERIC, JSONB, NUMERIC, TEXT, TEXT, TEXT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION estado_credito(CITEXT, TEXT, TEXT, TEXT, BIGINT) FROM PUBLIC;
DROP FUNCTION IF EXISTS estado_credito(CITEXT);   -- a versão de 1 arg da 004

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nascera_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION debitar_turno(CITEXT, TEXT, BIGINT, NUMERIC, NUMERIC, JSONB, NUMERIC, TEXT, TEXT, TEXT, BIGINT) TO nascera_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION estado_credito(CITEXT, TEXT, TEXT, TEXT, BIGINT) TO nascera_app';
  END IF;
END $$;
