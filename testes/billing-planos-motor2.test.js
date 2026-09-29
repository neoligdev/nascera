// Testes do núcleo de Planos, Créditos e Motor 2 (Fase 1).
// Isola o arquivo do dinheiro do repo real via env vars (mesmo padrão de
// NASCERA_VENDAS_FILE em servicos/vendas.js) — nunca toca billing.json real.
// Rodar: node --test testes/billing-planos-motor2.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpBase = path.join(os.tmpdir(), 'nascera-test-' + process.pid + '-' + Date.now());
process.env.NASCERA_CONFIG_FILE = tmpBase + '-config.json';
process.env.NASCERA_BILLING_FILE = tmpBase + '-billing.json';
process.env.NASCERA_USAGE_EVENTS_FILE = tmpBase + '-events.jsonl';

// markup=1 simplifica a conta (chargedUsd === costUsd, sem markup por cima).
fs.writeFileSync(process.env.NASCERA_CONFIG_FILE, JSON.stringify({
  billing: { mode: 'credits', defaultMarkup: 1, usdPerCredit: 0.20 },
}));

const test = require('node:test');
const assert = require('node:assert/strict');
const billing = require('../billing.js');
const motor2Mod = require('../servicos/motor2.js');

let _n = 0;
function novoUsuario() { return 'teste-' + (++_n) + '-' + Date.now(); }

test.afterEach(() => { billing._reloadState(); });

test('teto mensal: creditsPerMonth é a fonte de verdade (não priceBrl/câmbio)', () => {
  const cfg = billing.getConfig();
  const start = cfg.plans.find(p => p.slug === 'start');
  const pro = cfg.plans.find(p => p.slug === 'pro');
  const business = cfg.plans.find(p => p.slug === 'business');
  assert.equal(billing.planMonthCapUsd(cfg, start), 240 * cfg.usdPerCredit);
  assert.equal(billing.planMonthCapUsd(cfg, pro), 540 * cfg.usdPerCredit);
  assert.equal(billing.planMonthCapUsd(cfg, business), 1240 * cfg.usdPerCredit);
});

test('bônus diário: grant expirado não conta no saldo disponível (não acumula)', () => {
  const u = novoUsuario();
  billing.grantCredits(u, 5, 'Bônus de ontem', new Date(Date.now() - 1000).toISOString(), 'bonus');
  // summaryFor() também concede o bônus de HOJE (mesmo mecanismo do gate) —
  // o teste confirma que só ESSE aparece, não o de "ontem" (expirado).
  const cfg = billing.getConfig();
  const plan = cfg.plans.find(p => p.slug === 'free');
  const autoBonusMilli = Math.round(Math.min(plan.dailyBonusCap, plan.monthlyBonusCap) * 1000);
  const s = billing.summaryFor(u);
  assert.equal(s.saldosPorOrigem.bonusMilli, autoBonusMilli);
});

test('bônus diário: teto mensal de CONCEDIDO nunca é ultrapassado', () => {
  const cfg = billing.getConfig();
  const plan = { dailyBonusCap: 10, monthlyBonusCap: 60 };
  const acct = { grants: [], bonusGrant: { monthKey: null, grantedMilli: 0 } };
  // Simula 8 concessões diárias (8×10=80 > teto de 60) limpando o grant do
  // "dia anterior" antes de cada chamada — sem mockar relógio, testa só a
  // lógica do contador cumulativo, que é o que importa aqui.
  for (let dia = 0; dia < 8; dia++) {
    acct.grants = [];
    billing._garantirBonusDoDia(acct, cfg, plan);
  }
  assert.equal(acct.bonusGrant.grantedMilli, 60000);   // 60 créditos, nunca mais
});

test('bônus diário: plano sem dailyBonusCap/monthlyBonusCap não concede nada', () => {
  const cfg = billing.getConfig();
  const acct = { grants: [], bonusGrant: { monthKey: null, grantedMilli: 0 } };
  billing._garantirBonusDoDia(acct, cfg, { dailyBonusCap: 0, monthlyBonusCap: 0 });
  assert.equal(acct.grants.length, 0);
});

test('ordem de débito: bônus (inclui o auto-concedido pelo próprio debitTurn) → premium (até 90% no plano com Motor 2) → comprado → overage real (nunca bloqueia o turno)', () => {
  const u = novoUsuario();
  billing.setUserPlan(u, 'business');   // creditsPerMonth=1240 → monthCapUsd = 1240*0.20 = 248
  const cfg = billing.getConfig();
  const plan = cfg.plans.find(p => p.slug === 'business');
  // debitTurn concede o bônus do dia sozinho (garantirBonusDoDia) — o teste
  // não hardcoda esse valor, lê do próprio plano pra não quebrar se a
  // config mudar.
  const autoBonusMilli = Math.round(Math.min(plan.dailyBonusCap, plan.monthlyBonusCap) * 1000);
  billing.grantCredits(u, 5, 'Bônus extra manual', null, 'bonus');          // 5000 milli
  billing.grantCredits(u, 200, 'Comprados', null, 'comprado');              // 200000 milli
  const bonusEsperado = 5000 + autoBonusMilli;

  const monthCapUsd = billing.planMonthCapUsd(cfg, plan);                  // 248
  const premiumCapMilli = Math.round((monthCapUsd * 0.9) / cfg.usdPerCredit * 1000);  // 1.116.000

  // Turno 1: 1300 créditos (260 USD) — estoura bônus + 90% do premium e
  // ainda sobra pro comprado.
  const d1 = billing.debitTurn(u, 260, 'turno-1-' + u);
  assert.equal(d1.applicable, true);
  assert.equal(d1.fromBonus, bonusEsperado);
  assert.equal(d1.fromPremium, premiumCapMilli);
  const compradoEsperado1 = Math.round(260 / cfg.usdPerCredit * 1000) - bonusEsperado - premiumCapMilli;
  assert.equal(d1.fromComprado, compradoEsperado1);

  let s = billing.summaryFor(u);
  assert.equal(s.month.spentUsd, Math.round(monthCapUsd * 0.9 * 100) / 100);  // nunca passou de 90%
  assert.equal(Math.round(s.premiumRemainingPct * 10) / 10, 10);              // zona protegida: 10%
  assert.equal(s.saldosPorOrigem.bonusMilli, 0);
  const compradoRestante = 200000 - compradoEsperado1;
  assert.equal(s.saldosPorOrigem.compradoMilli, compradoRestante);

  // Turno 2: sem bônus (já drenado), sem espaço premium (piso de 90% já
  // batido) — cobre com o resto do comprado e o que sobrar vira overage
  // REAL, sem nunca bloquear o turno em andamento.
  const custoTurno2Milli = compradoRestante + 30000;   // força passar do que resta
  const d2 = billing.debitTurn(u, (custoTurno2Milli / 1000) * cfg.usdPerCredit, 'turno-2-' + u);
  assert.equal(d2.fromBonus, 0);
  assert.equal(d2.fromPremium, 0);
  assert.equal(d2.fromComprado, compradoRestante);

  s = billing.summaryFor(u);
  assert.ok(s.month.spentUsd > monthCapUsd * 0.9, 'overage real deve ultrapassar o piso de 90%');
  assert.equal(s.saldosPorOrigem.compradoMilli, 0);
});

test('planos sem Motor 2 (Free/Start) consomem o premium até 100%, sem reserva', () => {
  const u = novoUsuario();
  billing.setUserPlan(u, 'start');   // creditsPerMonth=240 → monthCapUsd = 48 USD
  const cfg = billing.getConfig();
  const plan = cfg.plans.find(p => p.slug === 'start');
  const monthCapUsd = billing.planMonthCapUsd(cfg, plan);
  const autoBonusMilli = Math.round(Math.min(plan.dailyBonusCap, plan.monthlyBonusCap) * 1000);
  const premiumMilli = Math.round(monthCapUsd / cfg.usdPerCredit * 1000);
  const custoUsd = ((autoBonusMilli + premiumMilli) / 1000) * cfg.usdPerCredit;  // bônus + 100% do premium
  const d = billing.debitTurn(u, custoUsd, 'turno-' + u);
  assert.equal(d.fromBonus, autoBonusMilli);
  assert.equal(d.fromPremium, premiumMilli);   // 100% do teto, não 90% (sem Motor 2 não há reserva)
  const s = billing.summaryFor(u);
  assert.equal(s.premiumRemainingPct, 0);
});

test('idempotência: retry do mesmo turnId não cobra duas vezes', () => {
  const u = novoUsuario();
  billing.setUserPlan(u, 'pro');
  const turnId = 'turno-unico-' + u;
  const d1 = billing.debitTurn(u, 5, turnId);
  const s1 = billing.summaryFor(u);
  const d2 = billing.debitTurn(u, 5, turnId);
  const s2 = billing.summaryFor(u);
  assert.equal(d1.duplicate, undefined);
  assert.equal(d2.duplicate, true);
  assert.deepEqual(s2.saldosPorOrigem, s1.saldosPorOrigem);
  assert.equal(s2.month.spentUsd, s1.month.spentUsd);
});

test('motor2.zonaProtegidaAtiva: só true com plano elegível e ≤10% de premium restante', () => {
  const u = novoUsuario();
  billing.setUserPlan(u, 'business');
  const motor2 = motor2Mod.criar({
    loadNasceraConfig: () => ({ motor2: { ligado: true } }),
    billing, db: { ATIVO: false },
  });
  assert.equal(motor2.zonaProtegidaAtiva(u), false);   // recém-criado: 100% do premium disponível
  billing.debitTurn(u, 248 * 0.95, 'estoura-' + u);    // gasta 95% do teto (> 90%)
  assert.equal(motor2.zonaProtegidaAtiva(u), true);
});

test('motor2.zonaProtegidaAtiva: falso pra plano sem Motor 2 mesmo com premium zerado', () => {
  const u = novoUsuario();
  billing.setUserPlan(u, 'start');
  const motor2 = motor2Mod.criar({
    loadNasceraConfig: () => ({ motor2: { ligado: true } }),
    billing, db: { ATIVO: false },
  });
  billing.debitTurn(u, 48, 'zera-' + u);
  assert.equal(motor2.zonaProtegidaAtiva(u), false);
});

test('motor2.franquiaDisponivelHoje: bloqueia no N+1º uso do dia', () => {
  const u = novoUsuario();
  billing.setUserPlan(u, 'business');
  const motor2 = motor2Mod.criar({
    loadNasceraConfig: () => ({ motor2: { ligado: true, limiteDiarioPorPlano: { business: 2 } } }),
    billing, db: { ATIVO: false },
  });
  assert.equal(motor2.franquiaDisponivelHoje(u), true);
  motor2.registrarUso(u, null, 't1');
  assert.equal(motor2.franquiaDisponivelHoje(u), true);
  motor2.registrarUso(u, null, 't2');
  assert.equal(motor2.franquiaDisponivelHoje(u), false);
});

test('planLimitFor: limites de projeto/domínio por plano, null = ilimitado', () => {
  const uFree = novoUsuario();
  billing.setUserPlan(uFree, 'free');
  assert.equal(billing.planLimitFor(uFree, 'maxProjetos'), 1);
  assert.equal(billing.planLimitFor(uFree, 'maxDominios'), 5);

  const uPro = novoUsuario();
  billing.setUserPlan(uPro, 'pro');
  assert.equal(billing.planLimitFor(uPro, 'maxProjetos'), null);   // ilimitado
  assert.equal(billing.planLimitFor(uPro, 'maxDominios'), null);
});

test('motor2.ligadoGlobalmente: respeita o toggle do admin', () => {
  const motorLigado = motor2Mod.criar({ loadNasceraConfig: () => ({}), billing, db: { ATIVO: false } });
  assert.equal(motorLigado.ligadoGlobalmente(), true);   // default: ligado
  const motorDesligado = motor2Mod.criar({ loadNasceraConfig: () => ({ motor2: { ligado: false } }), billing, db: { ATIVO: false } });
  assert.equal(motorDesligado.ligadoGlobalmente(), false);
});

// ── Fase 2 (A.3): preço fixo por operação (creditosFixos) ──────────────
// Helper: reescreve cfg.billing no arquivo de config isolado do teste (ver
// topo do arquivo) — getConfig() relê o arquivo a cada chamada, sem cache.
function setBillingConfig(patch) {
  const raw = JSON.parse(fs.readFileSync(process.env.NASCERA_CONFIG_FILE, 'utf8'));
  raw.billing = { ...raw.billing, ...patch };
  fs.writeFileSync(process.env.NASCERA_CONFIG_FILE, JSON.stringify(raw));
}

test('precoFixoAtivo desligado (default): creditosFixos é ignorado — comportamento idêntico à Fase 1', () => {
  const u = novoUsuario();
  billing.setUserPlan(u, 'pro');
  const d = billing.debitTurn(u, { costUsd: 5, creditosFixos: 999 }, 'turno-regressao-' + u);
  assert.equal(d.applicable, true);
  // 999 créditos custariam 999*0,20=199,80 USD — bem mais que os 5 USD reais.
  // Se o toggle (default false) tivesse efeito, o gasto do mês explodiria.
  assert.equal(d.costMilli, Math.floor((5 / 0.20) * 1000));
  const s = billing.summaryFor(u);
  assert.ok(s.month.spentUsd < 10, 'gasto deve refletir o custo real (~5 USD), não os 999 créditos fixos');
});

test('precoFixoAtivo ligado: creditosFixos decide costMilli; realBaseUsd/realChargedUsd guardam o custo real', () => {
  setBillingConfig({ precoFixoAtivo: true });
  try {
    const u = novoUsuario();
    billing.setUserPlan(u, 'pro');
    const d = billing.debitTurn(u, { costUsd: 0.01, creditosFixos: 22 }, 'turno-fixo-' + u);
    assert.equal(d.applicable, true);
    assert.equal(d.costMilli, 22000);          // 22 créditos, não o custo real de 0,01 USD
    assert.equal(d.chargedUsd, 22 * 0.20);      // 22 créditos convertidos p/ USD (usdPerCredit=0.20)
    assert.equal(d.realBaseUsd, 0.01);          // custo real preservado p/ auditoria de margem
    assert.ok(d.realChargedUsd > 0 && d.realChargedUsd < 1);
    const linhas = fs.readFileSync(process.env.NASCERA_USAGE_EVENTS_FILE, 'utf8').trim().split('\n');
    const ultima = JSON.parse(linhas[linhas.length - 1]);
    assert.equal(ultima.costMilli, 22000);
    assert.equal(ultima.realBaseUsd, 0.01);
  } finally {
    setBillingConfig({ precoFixoAtivo: false });
  }
});

test('precoFixoAtivo ligado sem creditosFixos: cai no custo real (fallback do classificador)', () => {
  setBillingConfig({ precoFixoAtivo: true });
  try {
    const u = novoUsuario();
    billing.setUserPlan(u, 'pro');
    const d = billing.debitTurn(u, { costUsd: 5 }, 'turno-sem-fixo-' + u);   // sem creditosFixos
    assert.equal(d.costMilli, Math.floor((5 / 0.20) * 1000));
  } finally {
    setBillingConfig({ precoFixoAtivo: false });
  }
});

test('idempotência: turnId repetido com creditosFixos e toggle ligado não cobra duas vezes', () => {
  setBillingConfig({ precoFixoAtivo: true });
  try {
    const u = novoUsuario();
    billing.setUserPlan(u, 'pro');
    const turnId = 'turno-fixo-idemp-' + u;
    const d1 = billing.debitTurn(u, { costUsd: 0.01, creditosFixos: 10 }, turnId);
    const s1 = billing.summaryFor(u);
    const d2 = billing.debitTurn(u, { costUsd: 0.01, creditosFixos: 10 }, turnId);
    const s2 = billing.summaryFor(u);
    assert.equal(d1.duplicate, undefined);
    assert.equal(d2.duplicate, true);
    assert.deepEqual(s2.saldosPorOrigem, s1.saldosPorOrigem);
  } finally {
    setBillingConfig({ precoFixoAtivo: false });
  }
});
