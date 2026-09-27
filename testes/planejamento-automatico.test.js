// Testes do classificador/estado do pipeline de planejamento automático.
// Rodar: node --test testes/planejamento-automatico.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { classificar, criar } = require('../servicos/planejamento-automatico.js');

const ehValido = (m) => ['claude', 'codex', 'opencode'].includes(m);

test('classificar: primeira mensagem sempre planeja', () => {
  assert.equal(classificar('oi', { primeiraMensagem: true }), 'planejar');
});

test('classificar: pedido de bug/ajuste vai direto pro build', () => {
  assert.equal(classificar('conserta a cor do botão', {}), 'build');
});

test('classificar: texto de erro nunca vira PRD, mesmo com palavra de build', () => {
  assert.equal(classificar('Error: build falhou at server.js:42', {}), 'build');
});

test('classificar: pedido de algo novo planeja', () => {
  assert.equal(classificar('crie um site para minha padaria', {}), 'planejar');
});

test('classificar: texto ambíguo sem sinal cai no padrão conservador (build)', () => {
  assert.equal(classificar('mude o footer', {}), 'build');
});

test('elegivelParaPipeline: falso quando o admin desligou o pipeline', () => {
  const mod = criar({ loadNasceraConfig: () => ({ pipelineAutomatico: false }), motores: { ehValido } });
  assert.equal(mod.elegivelParaPipeline({}), false);
});

test('elegivelParaPipeline: falso quando o projeto tem motor forçado', () => {
  const mod = criar({ loadNasceraConfig: () => ({}), motores: { ehValido } });
  assert.equal(mod.elegivelParaPipeline({ motor: 'codex' }), false);
});

test('elegivelParaPipeline: falso quando a instalação forçou um motor != claude', () => {
  const mod = criar({ loadNasceraConfig: () => ({ motor: 'opencode' }), motores: { ehValido } });
  assert.equal(mod.elegivelParaPipeline({}), false);
});

test('elegivelParaPipeline: verdadeiro no caso padrão', () => {
  const mod = criar({ loadNasceraConfig: () => ({}), motores: { ehValido } });
  assert.equal(mod.elegivelParaPipeline({}), true);
});

test('ciclo de estado: iniciar -> motor/modelo temporário -> finalizar', () => {
  const mod = criar({ loadNasceraConfig: () => ({}), motores: { ehValido } });
  assert.equal(mod.estaPlanejando('p1'), false);
  mod.iniciarPlanejamento('p1', 'crie um site');
  assert.equal(mod.estaPlanejando('p1'), true);
  assert.equal(mod.motorTemporario('p1'), 'opencode');
  assert.equal(mod.modeloTemporario('p1'), 'opencode/big-pickle');
  assert.ok(mod.promptPrefixoTemporario('p1').includes('[[NASCERA_PRD_PRONTO]]'));
  mod.finalizarPlanejamento('p1');
  assert.equal(mod.estaPlanejando('p1'), false);
  assert.equal(mod.motorTemporario('p1'), null);
});

test('registrarRodada: estoura o teto depois de MAX_RODADAS', () => {
  const mod = criar({ loadNasceraConfig: () => ({}), motores: { ehValido } });
  mod.iniciarPlanejamento('p1', 'crie um site');
  let ultimo;
  for (let i = 0; i < mod.MAX_RODADAS; i++) ultimo = mod.registrarRodada('p1');
  assert.equal(ultimo.estourou, true);
});

test('registrarRodada: guarda a última mensagem para retomar em caso de erro', () => {
  const mod = criar({ loadNasceraConfig: () => ({}), motores: { ehValido } });
  mod.iniciarPlanejamento('p1', 'primeira mensagem');
  mod.registrarRodada('p1', 'segunda mensagem');
  assert.equal(mod.mensagemParaRetomar('p1'), 'segunda mensagem');
});

test('detectarMarcador / extrairPRD: marcador nunca sobra no PRD', () => {
  const mod = criar({ loadNasceraConfig: () => ({}), motores: { ehValido } });
  const texto = '# PRD\nAlgo aqui.\n[[NASCERA_PRD_PRONTO]]';
  assert.equal(mod.detectarMarcador(texto), true);
  assert.equal(mod.extrairPRD(texto).includes('NASCERA_PRD_PRONTO'), false);
  assert.equal(mod.extrairPRD(texto), '# PRD\nAlgo aqui.');
});
