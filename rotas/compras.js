// ═══════════════════════════════════════════════════════════════════════
// NASCERA — compras do cliente e extrato (A0.4 + A0.5 do BACKLOG-ADMIN)
//
// O lado do CLIENTE da monetização, enquanto os gateways automáticos (A2)
// não chegam:
//   • GET  /api/billing/planos      — catálogo público (nome/preço) + Pix do dono
//   • POST /api/me/intencao-pix     — "já fiz o Pix" → entra na fila do admin
//   • GET  /api/billing/me/extrato  — onde MEU crédito foi gasto, turno a turno
//     (quem VÊ onde gastou não pede reembolso achando que foi roubado)
// E o lado do ADMIN:
//   • PUT  /api/admin/pagamentos/pix         — chave Pix exibida na tela de compra
//   • POST /api/admin/vendas/:id/confirmar   — confere o Pix → aplica o plano +
//     aprova a venda no ledger (idempotente)
//   • GET  /api/admin/billing/users/:username/extrato — extrato de qualquer conta
//
// O extrato lê o ledger append-only (usage-events.jsonl) que o débito já grava
// com fsync — nenhuma escrita nova, só leitura filtrada.
// ═══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const EVENTS_FILE = path.join(__dirname, '..', 'usage-events.jsonl');

// Últimos N eventos de consumo de um usuário (mais novos primeiro).
function extratoDe(username, limite) {
  let linhas = [];
  try { linhas = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const eventos = [];
  // De trás para a frente: os mais novos estão no fim do arquivo.
  for (let i = linhas.length - 1; i >= 0 && eventos.length < (limite || 100); i--) {
    try {
      const e = JSON.parse(linhas[i]);
      if (e.user !== username) continue;
      eventos.push({
        ts: e.ts, chargedUsd: e.chargedUsd, baseUsd: e.baseUsd,
        creditos: (e.costMilli || 0) / 1000,
        daCortesia: (e.fromGrants || 0) / 1000, doSaldo: (e.fromBalance || 0) / 1000,
        turnId: e.turnId || null,
      });
    } catch {}
  }
  return eventos;
}

function registrar(app, deps) {
  const {
    authMiddleware, adminMiddleware, billing, vendas, loadUsers,
    loadNasceraConfig, saveNasceraConfig, appendActivity,
    email,   // A1 (opcional): confirmação de compra por e-mail
  } = deps;

  // ── cliente: catálogo de planos + como pagar ────────────────────────
  app.get('/api/billing/planos', authMiddleware, (_req, res) => {
    const cfg = loadNasceraConfig();
    const b = cfg.billing || {};
    const pix = (cfg.pagamentos || {}).pix || {};
    res.json({
      // Só o que é público: nome e preço. Margens/custos ficam com o admin.
      planos: (b.plans || []).filter(p => p.priceBrl > 0).map(p => ({
        slug: p.slug, name: p.name, priceBrl: p.priceBrl,
      })),
      pix: pix.chave ? { chave: pix.chave, titular: pix.titular || null, instrucoes: pix.instrucoes || null } : null,
    });
  });

  // ── cliente: "já fiz o Pix" → fila de confirmação do admin ──────────
  app.post('/api/me/intencao-pix', authMiddleware, async (req, res) => {
    const slug = String((req.body || {}).plano || '');
    const cfg = loadNasceraConfig();
    const plano = ((cfg.billing || {}).plans || []).find(p => p.slug === slug && p.priceBrl > 0);
    if (!plano) return res.status(400).json({ error: 'Plano inválido' });
    // Uma intenção pendente por vez: evita a fila virar spam de cliques.
    const pendente = (await vendas.listar({ username: req.user.user }))
      .find(v => v.status === 'aguardando_confirmacao');
    if (pendente) {
      return res.json({ ok: true, jaPendente: true, mensagem: 'Você já tem um pagamento aguardando confirmação. Assim que o admin conferir, seu plano é ativado.' });
    }
    const { venda } = await vendas.registrar({
      gateway: 'pix-manual', username: req.user.user,
      email: (loadUsers()[req.user.user] || {}).email || null,
      valorBrl: plano.priceBrl, meio: 'pix', referencia: 'aguardando comprovante',
      plano: plano.slug, origem: 'manual', status: 'aguardando_confirmacao',
    });
    appendActivity({ type: 'intencao_pix', user: req.user.user, data: { plano: plano.slug, valor: plano.priceBrl, vendaId: venda.id }, at: new Date().toISOString() });
    res.json({ ok: true, mensagem: 'Recebido! Assim que o pagamento for conferido, seu plano é ativado — você não precisa fazer mais nada.' });
  });

  // ── cliente: meu extrato (consumo turno a turno + minhas compras) ───
  app.get('/api/billing/me/extrato', authMiddleware, async (req, res) => {
    res.json({
      eventos: extratoDe(req.user.user, Number(req.query.limite) || 100),
      compras: await vendas.listar({ username: req.user.user, limite: 20 }),
    });
  });

  // ── admin: extrato de qualquer conta ────────────────────────────────
  app.get('/api/admin/billing/users/:username/extrato', adminMiddleware, async (req, res) => {
    res.json({
      eventos: extratoDe(req.params.username, Number(req.query.limite) || 100),
      compras: await vendas.listar({ username: req.params.username, limite: 20 }),
    });
  });

  // ── admin: chave Pix exibida na tela de compra ──────────────────────
  app.put('/api/admin/pagamentos/pix', adminMiddleware, (req, res) => {
    const cfg = loadNasceraConfig();
    cfg.pagamentos = cfg.pagamentos || {};
    cfg.pagamentos.pix = {
      chave: String((req.body || {}).chave || '').trim() || null,
      titular: String((req.body || {}).titular || '').trim() || null,
      instrucoes: String((req.body || {}).instrucoes || '').trim() || null,
    };
    saveNasceraConfig(cfg);
    appendActivity({ type: 'admin_pix_config', user: req.user.user, data: {}, at: new Date().toISOString() });
    res.json({ ok: true });
  });

  // ── admin: conferiu o Pix → aprova a venda E aplica o plano ─────────
  app.post('/api/admin/vendas/:id/confirmar', adminMiddleware, async (req, res) => {
    const antes = (await vendas.listar({})).find(v => v.id === req.params.id);
    if (!antes) return res.status(404).json({ error: 'Venda não encontrada' });
    const jaAprovada = antes.status === 'aprovada';
    const referencia = String((req.body || {}).referencia || '').trim();
    const v = await vendas.confirmar(req.params.id, { registradaPor: req.user.user, referencia: referencia || null });
    if (!jaAprovada && v.username && v.plano) {
      try { billing.setUserPlan(v.username, v.plano); }
      catch (e) { return res.status(400).json({ error: 'Venda aprovada, mas o plano falhou: ' + e.message }); }
      // A1: o cliente fica sabendo NA HORA que o Pix foi conferido.
      if (email) {
        const u = loadUsers()[v.username];
        if (u && u.email) {
          email.enviarEvento('compra-confirmada', u.email, {
            nome: u.name || v.username, plano: v.plano,
            valor: Number(v.valorBrl || 0).toFixed(2).replace('.', ','),
          });
        }
      }
    }
    appendActivity({ type: 'venda_confirmada', user: req.user.user, data: { vendaId: v.id, username: v.username, plano: v.plano, referencia: referencia || null }, at: new Date().toISOString() });
    res.json({ ok: true, venda: v, jaAprovada });
  });
}

module.exports = { registrar, extratoDe };
