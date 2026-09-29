const fs = require('fs');
const os = require('os');
const path = require('path');
const tmpBase = path.join(os.tmpdir(), 'nascera-test-webhooks-' + process.pid + '-' + Date.now());
process.env.NASCERA_CONFIG_FILE = tmpBase + '-config.json';
process.env.NASCERA_BILLING_FILE = tmpBase + '-billing.json';
process.env.NASCERA_USAGE_EVENTS_FILE = tmpBase + '-events.jsonl';
process.env.NASCERA_VENDAS_FILE = tmpBase + '-vendas.json';
fs.writeFileSync(process.env.NASCERA_CONFIG_FILE, JSON.stringify({ billing: {} }));

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const billing = require('../billing.js');
const vendas = require('../servicos/vendas.js');
const senhas = require('../senhas.js');
const webhooksRotas = require('../rotas/webhooks.js');

const HOTTOK = 'segredo-de-teste';

function novaApp() {
  const app = express();
  app.use(express.json({
    limit: '1mb',
    verify: (req, _res, buf) => { if (req.url.indexOf('/api/webhooks/') === 0) req.corpoCru = buf; },
  }));
  const cofre = new Map([['gateway:hotmart:hottok', HOTTOK]]);
  const usersStore = {};
  let nasceraConfig = {
    billing: { mode: 'credits', pacotes: [{ id: 'pacote-300', creditos: 300, precoBrl: 37.90 }] },
    gateways: { hotmart: { planoPadrao: null, planoPorOferta: {}, pacotePorOferta: { 'oferta-pacote-300': 'pacote-300' } } },
  };
  webhooksRotas.registrar(app, {
    adminMiddleware: (req, _res, next) => { req.user = { user: 'admin-teste' }; next(); },
    loadUsers: () => usersStore,
    saveUsers: (u) => Object.assign(usersStore, u),
    senhas, billing, vendas,
    segredos: {
      guardar: (id, v) => cofre.set(id, v),
      obter: (id) => cofre.get(id) || null,
      esquecer: (id) => cofre.delete(id),
    },
    loadNasceraConfig: () => nasceraConfig,
    saveNasceraConfig: (c) => { nasceraConfig = c; },
    appendActivity: () => {}, trackEvent: () => {}, USERS: {},
    email: null,
  });
  return app;
}

function eventoHotmart(txId, ofertaId, emailComprador) {
  return {
    event: 'PURCHASE_APPROVED', id: txId,
    data: {
      purchase: { transaction: txId, price: { value: 37.90 }, offer: { code: ofertaId } },
      buyer: { email: emailComprador, name: 'Compradora Teste' },
      product: { id: 'produto-1' },
    },
  };
}
async function postWebhook(base, body) {
  return fetch(base + '/api/webhooks/hotmart', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hotmart-hottok': HOTTOK },
    body: JSON.stringify(body),
  }).then(r => r.json());
}

test('oferta mapeada para pacote credita saldo "comprado" e NÃO troca de plano', async (t) => {
  const app = novaApp();
  const server = app.listen(0);
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const email = 'compradora-' + Date.now() + '@teste.com';
  const r = await postWebhook(base, eventoHotmart('tx-1', 'oferta-pacote-300', email));
  assert.equal(r.ok, true);
  assert.equal(r.plano, null);
  assert.equal(r.pacote, 'pacote-300');
  const [venda] = await vendas.listar({ gateway: 'hotmart' });
  assert.equal(venda.pacoteCreditos, 300);
  assert.equal(venda.plano, null);
  const s = billing.summaryFor(r.username);
  assert.equal(s.saldosPorOrigem.compradoMilli, 300000);
});

test('idempotência: a mesma transação reentregue não credita 2×', async (t) => {
  const app = novaApp();
  const server = app.listen(0);
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const email = 'compradora2-' + Date.now() + '@teste.com';
  const r1 = await postWebhook(base, eventoHotmart('tx-2', 'oferta-pacote-300', email));
  const r2 = await postWebhook(base, eventoHotmart('tx-2', 'oferta-pacote-300', email));
  assert.equal(r2.duplicada, true);
  const s = billing.summaryFor(r1.username);
  assert.equal(s.saldosPorOrigem.compradoMilli, 300000);
});

test('oferta sem mapeamento nenhum cai em "sem_plano", como antes', async (t) => {
  const app = novaApp();
  const server = app.listen(0);
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const r = await postWebhook(base, eventoHotmart('tx-3', 'oferta-desconhecida', 'x-' + Date.now() + '@teste.com'));
  assert.equal(r.pendente, true);
  assert.equal(r.plano, null);
  assert.equal(r.pacote, null);
});

test('PUT /api/admin/gateways/:id rejeita oferta mapeada pra plano E pacote ao mesmo tempo', async (t) => {
  const app = novaApp();
  const server = app.listen(0);
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const r = await fetch(base + '/api/admin/gateways/hotmart', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planoPorOferta: { 'oferta-x': 'pro' }, pacotePorOferta: { 'oferta-x': 'pacote-300' } }),
  }).then(r => r.json());
  assert.match(r.error, /plano E pacote/);
});
