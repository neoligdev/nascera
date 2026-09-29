// ═══════════════════════════════════════════════════════════════════════
// NASCERA — Motor 2: capacidade adicional de desenvolvimento
//
// Exclusivo dos planos Pro/Business (doc §8). Quando a conta entra na "zona
// protegida" (≤10% dos créditos premium do mês restantes — billing.js
// reserva essa fatia e nunca a debita, ver debitTurn), o motor da vez passa
// a ser o OpenCode por baixo (`MOTOR_INTERNO`/`MODELO_INTERNO`), sem debitar
// crédito — mas com uma franquia diária POR USUÁRIO, configurável pelo
// admin, pra proteger custo de infraestrutura (doc §12/§13).
//
// Sigilo obrigatório (doc §10): NUNCA expor ao cliente qual motor/modelo
// está por trás, a palavra "fallback", ou a reserva interna de 10%. As
// mensagens fixas abaixo (MENSAGEM_MOTOR2/MENSAGEM_FRANQUIA_ESGOTADA) são o
// único texto autorizado a chegar no cliente sobre isso.
//
// Este arquivo é só a DECISÃO e o ESTADO (elegibilidade, franquia diária em
// memória, textos fixos) — mesmo formato de servicos/planejamento-
// automatico.js. Quem liga isso ao canal de verdade (roteamento, isenção de
// débito) é servicos/motor-canal.js (ensureChannel + session.on('result'))
// e servicos/motor-ws.js (handoff no meio de uma sessão já aberta).
// ═══════════════════════════════════════════════════════════════════════
const logger = require('../log.js');

const MOTOR_INTERNO = 'opencode';
const MODELO_INTERNO = 'opencode/big-pickle';

const MENSAGEM_MOTOR2 = 'Motor 2 — capacidade adicional de desenvolvimento exclusiva dos planos Pro e '
  + 'Business. Seu desenvolvimento não precisa parar. Quando seus créditos premium estiverem próximos '
  + 'do limite, o Motor 2 disponibiliza capacidade adicional dentro da franquia diária do seu plano.';

const MENSAGEM_FRANQUIA_ESGOTADA = MENSAGEM_MOTOR2 + ' Hoje ela já foi usada — volta amanhã.';

const LIMITE_DIARIO_PADRAO = 30;

function criar(deps) {
  const { loadNasceraConfig, billing, db } = deps;

  // Franquia diária: contador em memória por usuário, deliberadamente NÃO
  // persistido (mesmo espírito do estado de planejamento automático) — um
  // reinício no meio do dia, no pior caso, dá mais alguns usos de graça, não
  // tira saldo de ninguém. O ledger em Postgres (motor2_eventos, quando
  // ativo) é o registro durável pra auditoria; este Map é só o freio em
  // tempo real.
  const usoDiario = new Map(); // username(lower) -> {dia, count}

  function ligadoGlobalmente() {
    const cfg = loadNasceraConfig() || {};
    return (cfg.motor2 && cfg.motor2.ligado) !== false;   // default: ligado
  }

  function limiteDiarioDoPlano(planoSlug) {
    const cfg = loadNasceraConfig() || {};
    const limites = (cfg.motor2 && cfg.motor2.limiteDiarioPorPlano) || {};
    const v = limites[planoSlug];
    return (typeof v === 'number' && v >= 0) ? v : LIMITE_DIARIO_PADRAO;
  }

  function elegivel(plano) {
    return !!(plano && plano.motor2);
  }

  // Mesma chave de dia do billing.js (fuso configurado, não UTC cru) — pra
  // "franquia diária" virar junto com o resto do produto.
  function hojeChave() {
    const cfg = billing.getConfig();
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    return fmt.format(new Date());
  }

  function contadorDoDia(username) {
    const chave = String(username || '').toLowerCase();
    const dia = hojeChave();
    const atual = usoDiario.get(chave);
    if (!atual || atual.dia !== dia) {
      const novo = { dia, count: 0 };
      usoDiario.set(chave, novo);
      return novo;
    }
    return atual;
  }

  // Zona protegida ativa = elegível (plano com Motor 2) + Motor 2 ligado +
  // ≤10% dos créditos premium do ciclo restantes. O CÁLCULO de "10%" mora no
  // billing.js (summaryFor().premiumRemainingPct) — este arquivo só lê.
  function zonaProtegidaAtiva(username) {
    if (!ligadoGlobalmente()) return false;
    try {
      const cfg = billing.getConfig();
      if (cfg.mode !== 'credits') return false;
      const s = billing.summaryFor(username);
      return !!s.motor2Elegivel && s.premiumRemainingPct <= 10;
    } catch (err) {
      logger.error('[motor2] zonaProtegidaAtiva falhou:', err.message);
      return false;
    }
  }

  function franquiaDisponivelHoje(username) {
    try {
      const s = billing.summaryFor(username);
      const limite = limiteDiarioDoPlano(s.creditAccounts.personal.planSlug);
      if (!(limite > 0)) return false;
      return contadorDoDia(username).count < limite;
    } catch (err) {
      logger.error('[motor2] franquiaDisponivelHoje falhou:', err.message);
      return false;
    }
  }

  // Conveniência pro roteamento: "deve o Motor 2 assumir agora?"
  function deveAssumir(username) {
    return zonaProtegidaAtiva(username) && franquiaDisponivelHoje(username);
  }

  // Chamado uma vez por turno REALMENTE processado pelo Motor 2 (não por
  // checagem de elegibilidade) — consome a franquia do dia e espelha no
  // Postgres pra auditoria (doc §11: registrar projeto, usuário, tarefa).
  function registrarUso(username, projectId, turnId) {
    contadorDoDia(username).count += 1;
    if (db && db.ATIVO) {
      const chave = String(username || '').toLowerCase();
      const dia = hojeChave();
      db.comSistema((cli) => cli.query(
        `INSERT INTO motor2_eventos (username, projeto_id, turn_id, dia)
         VALUES ($1,$2,$3,$4) ON CONFLICT (username, turn_id) DO NOTHING`,
        [chave, projectId || null, turnId || null, dia]
      )).catch((err) => logger.error('[motor2] espelho de uso falhou: ' + err.message));
    }
  }

  // Painel admin (doc §13: "dashboard de consumo por plano, usuário e
  // projeto") — versão local do dia corrente. Histórico multi-dia por
  // projeto fica em `motor2_eventos` no Postgres quando ativo (Fase 2/
  // futuro: endpoint dedicado de histórico, se a necessidade aparecer).
  function resumoDoDia() {
    const dia = hojeChave();
    const usuarios = [];
    for (const [username, v] of usoDiario) {
      if (v.dia === dia) usuarios.push({ username, usosHoje: v.count });
    }
    return { dia, usuarios };
  }

  return {
    ligadoGlobalmente, limiteDiarioDoPlano, elegivel,
    zonaProtegidaAtiva, franquiaDisponivelHoje, deveAssumir, registrarUso, resumoDoDia,
    MOTOR_INTERNO, MODELO_INTERNO, MENSAGEM_MOTOR2, MENSAGEM_FRANQUIA_ESGOTADA,
  };
}

module.exports = { criar, MOTOR_INTERNO, MODELO_INTERNO, MENSAGEM_MOTOR2, MENSAGEM_FRANQUIA_ESGOTADA };
