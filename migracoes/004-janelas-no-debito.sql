-- ═══════════════════════════════════════════════════════════════════════
-- 004 — As janelas de gasto entram no débito atômico
--
-- A 002 criou `debitar_turno`, mas ela parava na cortesia e no saldo: as
-- JANELAS DE GASTO (dia/semana/mês/sessão) continuavam só no JSON. Isso
-- deixava o sistema pela metade e de um jeito perigoso — o portão de bloqueio
-- (`gateDecision`) decide pelas janelas, então o dinheiro saía transacional
-- mas o LIMITE que impede o prejuízo era lido de um arquivo com
-- read-modify-write. Dois turnos simultâneos liam a mesma janela, somavam em
-- cima do mesmo valor e um dos gastos sumia: o cliente consumia acima do teto
-- e a conta ficava com o provedor.
--
-- Agora o débito inteiro — evento, cortesia, saldo E janelas — acontece numa
-- transação só. Ou tudo, ou nada.
--
-- VIRADA DE JANELA SEM CORRIDA: `janelas_gasto` tem PK (username, escopo) e a
-- `chave` é coluna. O upsert compara a chave gravada com a que chegou: se
-- mudou (virou o dia/semana/mês), ZERA e recomeça; se é a mesma, ACUMULA.
-- É o `lazyReset` do JS, só que atômico — sem a janela do "li, virou o dia,
-- gravei por cima" que perdia gasto na virada.
--
-- SESSÃO: não é chave de calendário, é uma janela rolante de 5h que abre no
-- primeiro uso. Quem decide a expiração é o `inicio_ts` desta tabela, não o
-- relógio do processo — dois processos com relógios diferentes não podem mais
-- discordar sobre a sessão estar aberta.
--
-- O PREÇO continua em JS (`priceTurn`): esta função só move valor.
-- ═══════════════════════════════════════════════════════════════════════

-- A versão da 002 tem 7 parâmetros; esta tem 11 (4 com DEFAULT). No Postgres
-- isso NÃO substitui: cria uma SOBRECARGA, e aí uma chamada com 7 argumentos
-- casaria com as duas e falharia com "function is not unique". Removemos a
-- antiga explicitamente. É seguro: nada no código a chamava ainda.
DROP FUNCTION IF EXISTS debitar_turno(CITEXT, TEXT, BIGINT, NUMERIC, NUMERIC, JSONB, NUMERIC);

CREATE OR REPLACE FUNCTION debitar_turno(
  p_username     CITEXT,
  p_turn_id      TEXT,
  p_cost_milli   BIGINT,
  p_base_usd     NUMERIC,
  p_charged_usd  NUMERIC,
  p_per_model    JSONB,
  p_usd_per_credit NUMERIC,
  -- Novos, com DEFAULT para não quebrar chamador antigo: sem as chaves, a
  -- função se comporta exatamente como a versão da 002.
  p_chave_dia    TEXT DEFAULT NULL,
  p_chave_semana TEXT DEFAULT NULL,
  p_chave_mes    TEXT DEFAULT NULL,
  p_sessao_ms    BIGINT DEFAULT 18000000   -- 5h, igual ao SESSION_MS do billing.js
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
  v_sessao_ini   TIMESTAMPTZ;
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

  -- (6) JANELAS DE CALENDÁRIO (dia/semana/mês).
  -- `usd` recebe só o RESTO (o que o cliente pagou do próprio bolso, que é o
  -- que os tetos medem); `base_usd`/`charged_usd` recebem os valores
  -- INTEGRAIS, porque mesmo o turno coberto por cortesia custou dinheiro de
  -- verdade — é o que permite ver o lucro depois. Mesma regra do JS.
  IF p_chave_dia IS NOT NULL THEN
    INSERT INTO janelas_gasto (username, escopo, chave, inicio_ts, usd, base_usd, charged_usd)
    VALUES (p_username, 'day', p_chave_dia, now(), v_resto_usd, p_base_usd, p_charged_usd)
    ON CONFLICT (username, escopo) DO UPDATE SET
      -- chave diferente = janela virou: zera e começa desta cobrança
      usd         = CASE WHEN janelas_gasto.chave = EXCLUDED.chave
                         THEN janelas_gasto.usd + EXCLUDED.usd ELSE EXCLUDED.usd END,
      base_usd    = CASE WHEN janelas_gasto.chave = EXCLUDED.chave
                         THEN janelas_gasto.base_usd + EXCLUDED.base_usd ELSE EXCLUDED.base_usd END,
      charged_usd = CASE WHEN janelas_gasto.chave = EXCLUDED.chave
                         THEN janelas_gasto.charged_usd + EXCLUDED.charged_usd ELSE EXCLUDED.charged_usd END,
      inicio_ts   = CASE WHEN janelas_gasto.chave = EXCLUDED.chave
                         THEN janelas_gasto.inicio_ts ELSE EXCLUDED.inicio_ts END,
      chave       = EXCLUDED.chave;
  END IF;

  IF p_chave_semana IS NOT NULL THEN
    INSERT INTO janelas_gasto (username, escopo, chave, inicio_ts, usd, base_usd, charged_usd)
    VALUES (p_username, 'week', p_chave_semana, now(), v_resto_usd, p_base_usd, p_charged_usd)
    ON CONFLICT (username, escopo) DO UPDATE SET
      usd         = CASE WHEN janelas_gasto.chave = EXCLUDED.chave
                         THEN janelas_gasto.usd + EXCLUDED.usd ELSE EXCLUDED.usd END,
      base_usd    = CASE WHEN janelas_gasto.chave = EXCLUDED.chave
                         THEN janelas_gasto.base_usd + EXCLUDED.base_usd ELSE EXCLUDED.base_usd END,
      charged_usd = CASE WHEN janelas_gasto.chave = EXCLUDED.chave
                         THEN janelas_gasto.charged_usd + EXCLUDED.charged_usd ELSE EXCLUDED.charged_usd END,
      inicio_ts   = CASE WHEN janelas_gasto.chave = EXCLUDED.chave
                         THEN janelas_gasto.inicio_ts ELSE EXCLUDED.inicio_ts END,
      chave       = EXCLUDED.chave;
  END IF;

  IF p_chave_mes IS NOT NULL THEN
    INSERT INTO janelas_gasto (username, escopo, chave, inicio_ts, usd, base_usd, charged_usd)
    VALUES (p_username, 'month', p_chave_mes, now(), v_resto_usd, p_base_usd, p_charged_usd)
    ON CONFLICT (username, escopo) DO UPDATE SET
      usd         = CASE WHEN janelas_gasto.chave = EXCLUDED.chave
                         THEN janelas_gasto.usd + EXCLUDED.usd ELSE EXCLUDED.usd END,
      base_usd    = CASE WHEN janelas_gasto.chave = EXCLUDED.chave
                         THEN janelas_gasto.base_usd + EXCLUDED.base_usd ELSE EXCLUDED.base_usd END,
      charged_usd = CASE WHEN janelas_gasto.chave = EXCLUDED.chave
                         THEN janelas_gasto.charged_usd + EXCLUDED.charged_usd ELSE EXCLUDED.charged_usd END,
      inicio_ts   = CASE WHEN janelas_gasto.chave = EXCLUDED.chave
                         THEN janelas_gasto.inicio_ts ELSE EXCLUDED.inicio_ts END,
      chave       = EXCLUDED.chave;
  END IF;

  -- (7) SESSÃO — janela rolante de 5h, decidida pelo inicio_ts da própria
  -- linha (o relógio do banco, um só, em vez do relógio de cada processo).
  -- A sessão conta o COBRADO INTEGRAL: é ritmo de uso, não orçamento — por
  -- isso `usd` recebe p_charged_usd aqui, e não o resto.
  SELECT inicio_ts INTO v_sessao_ini FROM janelas_gasto
   WHERE username = p_username AND escopo = 'session';

  IF v_sessao_ini IS NULL OR now() - v_sessao_ini >= (p_sessao_ms || ' milliseconds')::INTERVAL THEN
    -- expirada (ou primeira): abre sessão nova
    INSERT INTO janelas_gasto (username, escopo, chave, inicio_ts, usd, base_usd, charged_usd)
    VALUES (p_username, 'session', to_char(now(), 'YYYYMMDD"T"HH24MISS'), now(),
            p_charged_usd, p_base_usd, p_charged_usd)
    ON CONFLICT (username, escopo) DO UPDATE SET
      chave = EXCLUDED.chave, inicio_ts = EXCLUDED.inicio_ts,
      usd = EXCLUDED.usd, base_usd = EXCLUDED.base_usd, charged_usd = EXCLUDED.charged_usd;
  ELSE
    UPDATE janelas_gasto
       SET usd = usd + p_charged_usd,
           base_usd = base_usd + p_base_usd,
           charged_usd = charged_usd + p_charged_usd
     WHERE username = p_username AND escopo = 'session';
  END IF;

  RETURN jsonb_build_object(
    'duplicate', false,
    'fromGrants', v_de_cortesia,
    'fromBalance', v_de_saldo,
    'remainderUsd', v_resto_usd,
    'costMilli', p_cost_milli
  );
END; $$;

-- A role da aplicação precisa poder chamar a nova assinatura (a 003 concedeu
-- para a antiga, de 7 parâmetros; esta tem 11).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nascera_app') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION debitar_turno(CITEXT, TEXT, BIGINT, NUMERIC, NUMERIC, JSONB, NUMERIC, TEXT, TEXT, TEXT, BIGINT) FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION debitar_turno(CITEXT, TEXT, BIGINT, NUMERIC, NUMERIC, JSONB, NUMERIC, TEXT, TEXT, TEXT, BIGINT) TO nascera_app';
  END IF;
END $$;

-- Leitura do estado de crédito de um usuário numa consulta só — é o que o
-- portão (`gateDecision`) e o resumo precisam. Sem isto, cada decisão faria
-- 3 ou 4 idas ao banco e o portão ficaria caro no caminho quente.
CREATE OR REPLACE FUNCTION estado_credito(p_username CITEXT)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT jsonb_build_object(
    'plano',        COALESCE((SELECT plano FROM contas_credito WHERE username = p_username), 'free'),
    'saldoMilli',   COALESCE((SELECT saldo_milli FROM contas_credito WHERE username = p_username), 0),
    'cortesiaMilli',COALESCE((SELECT SUM(restante_milli) FROM cortesias
                               WHERE username = p_username AND restante_milli > 0
                                 AND (expira_em IS NULL OR expira_em > now())), 0),
    'janelas',      COALESCE((SELECT jsonb_object_agg(escopo, jsonb_build_object(
                                 'chave', chave, 'inicioTs', inicio_ts,
                                 'usd', usd, 'baseUsd', base_usd, 'chargedUsd', charged_usd))
                              FROM janelas_gasto WHERE username = p_username), '{}'::jsonb)
  );
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nascera_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION estado_credito(CITEXT) TO nascera_app';
  END IF;
END $$;
