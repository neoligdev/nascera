// ═══════════════════════════════════════════════════════════════════════
// NASCERA — rotas admin de billing (S4: extraído do server.js)
// overview, config de preço/planos/modelos, ajuste de plano/cortesia/saldo
// por usuário. Dep principal: o módulo billing. Coberto pelo smoke
// (/api/admin/billing) e o débito por test:pg.
// ═══════════════════════════════════════════════════════════════════════
const billing = require('../billing.js');

/**
 * Monta as rotas admin de billing (`/api/admin/billing/*`): overview, config de
 * preço/planos/modelos e ajuste de plano/cortesia/saldo por usuário.
 *
 * @param {import('express').Express} app - App do Express onde as rotas são montadas.
 * @param {object} deps - Dependências injetadas pelo server.js (composition root).
 * @param {import('express').RequestHandler} deps.adminMiddleware - Guarda de admin; exige papel admin.
 * @param {() => Object<string,object>} deps.loadUsers - Lê o store de usuários.
 * @param {() => object} deps.loadNasceraConfig - Lê a config global do Nascera.
 * @param {(cfg: object) => void} deps.saveNasceraConfig - Grava a config global.
 * @param {(evt: object) => void} deps.appendActivity - Registra um evento no log de atividade.
 * @returns {void}
 */
function registrar(app, deps) {
  const { adminMiddleware, loadUsers, loadNasceraConfig, saveNasceraConfig, appendActivity, vendas } = deps;

app.get('/api/admin/billing', adminMiddleware, (_req, res) => {
  const users = Object.keys(loadUsers());
  res.json(billing.adminOverview(users));
});

app.put('/api/admin/billing/config', adminMiddleware, (req, res) => {
  const { mode, usdPerCredit, defaultDailyLimitUsd, timezone, plans, models, defaultMarkup, usdToBrl, sessionsPerWeek } = req.body;
  const cfg = loadNasceraConfig();
  const b = { ...(cfg.billing || {}) };
  if (mode !== undefined) {
    if (!['off', 'subscription', 'credits'].includes(mode)) return res.status(400).json({ error: 'Modo inválido' });
    b.mode = mode;
  }
  if (usdPerCredit !== undefined) {
    const v = parseFloat(usdPerCredit);
    if (!(v > 0 && v < 100)) return res.status(400).json({ error: 'US$/crédito inválido' });
    // A alavanca de preço do produto inteiro — e reprecifica retroativamente:
    // o saldo exibido é recalculado do gasto histórico em USD.
    b.usdPerCredit = v;
  }
  if (defaultDailyLimitUsd !== undefined) {
    const v = parseFloat(defaultDailyLimitUsd);
    if (!(v >= 0)) return res.status(400).json({ error: 'Limite diário inválido' });
    b.defaultDailyLimitUsd = v;
  }
  if (timezone !== undefined) {
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { return res.status(400).json({ error: 'Fuso inválido' }); }
    b.timezone = timezone;
  }
  if (defaultMarkup !== undefined) {
    const v = parseFloat(defaultMarkup);
    // INVARIANTE: markup ≥ 1× (mínimo repassa o custo — nunca fica negativo)
    if (!(v >= 1 && v <= 100)) return res.status(400).json({ error: 'Markup inválido: o mínimo é +0% (repasse do custo). Nunca se vende abaixo do custo.' });
    b.defaultMarkup = v;
  }
  if (usdToBrl !== undefined) {
    const v = parseFloat(usdToBrl);
    if (!(v > 0 && v < 100)) return res.status(400).json({ error: 'Câmbio US$→R$ inválido' });
    b.usdToBrl = v;
  }
  if (sessionsPerWeek !== undefined) {
    const v = parseInt(sessionsPerWeek, 10);
    if (!(v >= 1 && v <= 50)) return res.status(400).json({ error: 'Sessões de 5h por semana inválido (1–50)' });
    b.sessionsPerWeek = v;
  }
  let warnings = [];
  if (models !== undefined) {
    if (!Array.isArray(models) || !models.length) return res.status(400).json({ error: 'Lista de modelos vazia' });
    const cleanModels = [];
    for (const m of models) {
      const id = String(m.id || '').trim().toLowerCase();
      if (!id) return res.status(400).json({ error: 'Modelo sem id' });
      // markup 0 = herda o padrão; se definido, mínimo 1× (nunca abaixo do custo)
      const mkRaw = parseFloat(m.markup) || 0;
      if (mkRaw > 0 && mkRaw < 1) return res.status(400).json({ error: `Modelo "${id}": markup abaixo de +0% venderia abaixo do custo.` });
      cleanModels.push({
        id, name: String(m.name || id).trim(),
        inMtok: Math.max(0, parseFloat(m.inMtok) || 0),
        outMtok: Math.max(0, parseFloat(m.outMtok) || 0),
        cacheReadMtok: Math.max(0, parseFloat(m.cacheReadMtok) || 0),
        cacheWriteMtok: Math.max(0, parseFloat(m.cacheWriteMtok) || 0),
        markup: mkRaw,
      });
    }
    // preço zerado não fura mais o invariante (o débito tem piso no custo
    // real do SDK), mas merece aviso — provavelmente foi campo limpo sem querer
    for (const m of cleanModels) {
      if (m.inMtok === 0 && m.outMtok === 0) {
        warnings.push(`Modelo "${m.name}": preços por Mtok zerados — os turnos dele serão cobrados pelo custo real do SDK com o markup padrão.`);
      }
    }
    b.models = cleanModels;
  }
  if (plans !== undefined) {
    if (!Array.isArray(plans) || !plans.length) return res.status(400).json({ error: 'Lista de planos vazia' });
    // Modelo Claude: o plano é SÓ preço (o consumo deriva dele) + bônus
    // opcional (subsídio p/ free/trial). Nada de orçamento digitável — foi o
    // que causou plano vendendo abaixo do custo.
    const clean = plans.map(p => ({
      slug: String(p.slug || '').trim(), name: String(p.name || '').trim(),
      priceBrl: Math.max(0, parseFloat(p.priceBrl) || 0),
      bonusUsd: Math.max(0, parseFloat(p.bonusUsd) || 0),
      // legado: vira a cortesia de entrada dos planos zerados (free 10cr)
      creditsPerMonth: Math.max(0, Math.round(parseFloat(p.creditsPerMonth) || 0)),
    }));
    try {
      warnings = warnings.concat(billing.validatePlans(clean));
    } catch (err) { return res.status(400).json({ error: err.message }); }
    b.plans = clean;
  }
  cfg.billing = b;
  saveNasceraConfig(cfg);
  appendActivity({ type: 'admin_billing_config', user: req.user.user, data: { mode: b.mode }, at: new Date().toISOString() });
  res.json({ ok: true, warnings, config: billing.getConfig() });
});

app.post('/api/admin/billing/users/:username', adminMiddleware, async (req, res) => {
  const username = req.params.username;
  const { plan, grantCredits, grantLabel, grantExpiresAt, addBalanceCredits, resetSpend } = req.body;
  try {
    if (plan !== undefined) billing.setUserPlan(username, plan);
    if (grantCredits !== undefined) billing.grantCredits(username, parseFloat(grantCredits), grantLabel, grantExpiresAt);
    if (addBalanceCredits !== undefined) billing.addBalance(username, parseFloat(addBalanceCredits));
    if (resetSpend) billing.resetSpend(username);
    // A0.3: se a concessão corresponde a DINHEIRO RECEBIDO (Pix no WhatsApp,
    // transferência…), o admin informa valor+meio+referência e a venda entra
    // no ledger — a partir daí MRR/conciliação existem e a auditoria tem o
    // "por quê" de cada crédito. Referência é obrigatória junto com o valor.
    const valorPago = parseFloat(req.body.valorPagoBrl);
    if (valorPago > 0) {
      const referencia = String(req.body.referenciaPagamento || '').trim();
      if (!referencia) return res.status(400).json({ error: 'Informe a referência do pagamento (comprovante/ID) junto com o valor.' });
      await vendas.registrar({
        gateway: 'manual', username,
        email: (loadUsers()[username] || {}).email || null,
        valorBrl: valorPago, meio: req.body.meioPagamento || 'pix',
        referencia, plano: plan !== undefined ? plan : null,
        origem: 'manual', registradaPor: req.user.user,
      });
    }
    appendActivity({ type: 'admin_billing_user', user: req.user.user, data: { username, plan, grantCredits, addBalanceCredits, resetSpend, valorPagoBrl: valorPago > 0 ? valorPago : undefined }, at: new Date().toISOString() });
    res.json({ ok: true, summary: billing.summaryFor(username) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
}

module.exports = { registrar };
