// testes/compras-estimar.test.js
// Rodar: node --test testes/compras-estimar.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { estimarCreditos } = require('../rotas/compras.js');

test('estimarCreditos: pedido de pagamento estima faixa alta e fixa (27)', () => {
  assert.deepEqual(estimarCreditos('preciso de um checkout de pagamento'), { min: 27, max: 27 });
});

test('estimarCreditos: pedido de ajuste pequeno estima faixa baixa', () => {
  assert.deepEqual(estimarCreditos('troca a cor do botão'), { min: 2, max: 5 });
});

test('estimarCreditos: texto sem sinal nenhum cai na faixa padrão', () => {
  assert.deepEqual(estimarCreditos('oi, tudo bem?'), { min: 2, max: 20 });
});
