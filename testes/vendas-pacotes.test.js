const fs = require('fs');
const os = require('os');
const path = require('path');
const ARQ = path.join(os.tmpdir(), 'nascera-test-vendas-pacotes-' + process.pid + '-' + Date.now() + '.json');
process.env.NASCERA_VENDAS_FILE = ARQ;
delete process.env.NASCERA_DB_STATE;

const test = require('node:test');
const assert = require('node:assert/strict');
const vendas = require('../servicos/vendas.js');

test('registrar(): pacoteCreditos é gravado; plano fica null (paralelo, nunca os dois)', async () => {
  const { venda, duplicada } = await vendas.registrar({
    gateway: 'hotmart', transactionId: 'tx-pacote-1', username: 'compradora',
    email: 'c@teste.com', valorBrl: 37.90, pacoteCreditos: 300, status: 'aprovada', origem: 'webhook',
  });
  assert.equal(duplicada, false);
  assert.equal(venda.pacoteCreditos, 300);
  assert.equal(venda.plano, null);
});

test('registrar(): venda de plano continua com pacoteCreditos null (regressão)', async () => {
  const { venda } = await vendas.registrar({
    gateway: 'hotmart', transactionId: 'tx-plano-1', username: 'compradora2',
    email: 'c2@teste.com', valorBrl: 95, plano: 'pro', status: 'aprovada', origem: 'webhook',
  });
  assert.equal(venda.plano, 'pro');
  assert.equal(venda.pacoteCreditos, null);
});

test('jaExiste + registrar: reentrega da mesma transação de pacote não duplica', async () => {
  await vendas.registrar({ gateway: 'kiwify', transactionId: 'tx-dup', pacoteCreditos: 100, status: 'aprovada' });
  assert.equal(await vendas.jaExiste('kiwify', 'tx-dup'), true);
  const { duplicada } = await vendas.registrar({ gateway: 'kiwify', transactionId: 'tx-dup', pacoteCreditos: 100, status: 'aprovada' });
  assert.equal(duplicada, true);
});
