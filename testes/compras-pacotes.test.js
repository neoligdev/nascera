// testes/compras-pacotes.test.js
// Rodar: node --test testes/compras-pacotes.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmpBase = path.join(os.tmpdir(), 'nascera-test-compras-' + process.pid + '-' + Date.now());
process.env.NASCERA_VENDAS_FILE = tmpBase + '-vendas.json';
process.env.NASCERA_CONFIG_FILE = tmpBase + '-config.json';
process.env.NASCERA_BILLING_FILE = tmpBase + '-billing.json';
process.env.NASCERA_USAGE_EVENTS_FILE = tmpBase + '-events.jsonl';
delete process.env.NASCERA_DB_STATE;
fs.writeFileSync(process.env.NASCERA_CONFIG_FILE, JSON.stringify({ billing: { mode: 'credits' } }));

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const billing = require('../billing.js');
const vendas = require('../servicos/vendas.js');
const comprasRotas = require('../rotas/compras.js');

function novaApp(usersStore) {
  const app = express();
  app.use(express.json());
  let nasceraConfig = {
    billing: { pacotes: [{ id: 'pacote-300', creditos: 300, precoBrl: 37.90 }], plans: [{ slug: 'pro', name: 'Pro', priceBrl: 95 }] },
  };
  app.use((req, _res, next) => { req.user = { user: 'compradora' }; next(); });
  comprasRotas.registrar(app, {
    authMiddleware: (_req, _res, next) => next(),
    adminMiddleware: (_req, _res, next) => next(),
    billing, vendas,
    loadUsers: () => usersStore || {},
    loadNasceraConfig: () => nasceraConfig,
    saveNasceraConfig: (c) => { nasceraConfig = c; },
    appendActivity: () => {},
    email: null,
  });
  return app;
}

test('POST /api/me/intencao-pix aceita pacote (não só plano) e registra pacoteCreditos', async (t) => {
  const app = novaApp();
  const server = app.listen(0);
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const r = await fetch(base + '/api/me/intencao-pix', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pacote: 'pacote-300' }),
  }).then(x => x.json());
  assert.equal(r.ok, true);
  const [venda] = await vendas.listar({ username: 'compradora' });
  assert.equal(venda.pacoteCreditos, 300);
  assert.equal(venda.plano, null);
  assert.equal(venda.status, 'aguardando_confirmacao');
});

test('POST /api/admin/vendas/:id/confirmar credita o pacote via addBalance quando a venda tem pacoteCreditos', async (t) => {
  const app = novaApp();
  const server = app.listen(0);
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const { venda } = await vendas.registrar({
    gateway: 'pix-manual', username: 'compradora', valorBrl: 37.90,
    pacoteCreditos: 300, origem: 'manual', status: 'aguardando_confirmacao',
  });
  const r = await fetch(base + '/api/admin/vendas/' + venda.id + '/confirmar', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ referencia: 'comprovante-123' }),
  }).then(x => x.json());
  assert.equal(r.ok, true);
  const s = billing.summaryFor('compradora');
  assert.equal(s.saldosPorOrigem.compradoMilli, 300000);
});
