// testes/billing-pacotes.test.js
// Rodar: node --test testes/billing-pacotes.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpBase = path.join(os.tmpdir(), 'nascera-test-pacotes-' + process.pid + '-' + Date.now());
process.env.NASCERA_CONFIG_FILE = tmpBase + '-config.json';
process.env.NASCERA_BILLING_FILE = tmpBase + '-billing.json';
process.env.NASCERA_USAGE_EVENTS_FILE = tmpBase + '-events.jsonl';

const test = require('node:test');
const assert = require('node:assert/strict');
const billing = require('../billing.js');

test('getConfig: sem pacotes configurados, cai nos 6 pacotes padrão do doc', () => {
  const cfg = billing.getConfig();
  assert.equal(cfg.pacotes.length, 6);
  assert.deepEqual(cfg.pacotes.map(p => p.creditos), [100, 300, 1000, 2500, 5000, 10000]);
});

test('validatePacotes: id duplicado é rejeitado', () => {
  assert.throws(() => billing.validatePacotes([
    { id: 'a', creditos: 100, precoBrl: 10 },
    { id: 'a', creditos: 200, precoBrl: 20 },
  ]), /duplicado/);
});

test('validatePacotes: créditos ou preço zerados geram aviso, não erro', () => {
  const warnings = billing.validatePacotes([
    { id: 'a', creditos: 0, precoBrl: 10 },
    { id: 'b', creditos: 100, precoBrl: 0 },
  ]);
  assert.equal(warnings.length, 2);
});
