// Teste de integração do pipeline invisível OpenCode (planejamento) -> Claude
// (build): exercita servicos/motor-ws.js + servicos/motor-canal.js +
// servicos/planejamento-automatico.js de ponta a ponta, sob o motor falso
// (engine/fake-engine.mjs) — sem gastar 1 centavo nem depender de CLI real.
//
// Não sobe o server.js inteiro (precisaria de HTTP/auth/DB reais); em vez
// disso simula a conexão WebSocket com um objeto `ws` de mentira e monta só
// as dependências que motor-ws.js/motor-canal.js realmente usam — o mesmo
// espírito do fake-engine, aplicado uma camada acima.
//
// Rodar: node --test testes/pipeline-planejamento.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const motorCanal = require('../servicos/motor-canal.js');
const motorWs = require('../servicos/motor-ws.js');
const memoriaProjeto = require('../memoria-projeto.js');
const planejamentoAutomaticoMod = require('../servicos/planejamento-automatico.js');
const motores = require('../motores.js');

process.env.NASCERA_FAKE_ENGINE = '1';

function sessionKeyFor(projectId, user) {
  return projectId || ('user:' + user);
}

const BUILD_LEVELS = {
  1: { name: 'rápido', effort: 'low' },
  2: { name: 'padrão', effort: 'medium' },
  3: { name: 'completo', effort: 'medium' },
  4: { name: 'caprichado', effort: 'high' },
};

// Monta um ambiente isolado (projeto de rascunho + todas as deps de
// motor-canal/motor-ws) para um teste. Cada chamada usa um projectId novo,
// então o singleton FakeSessionManager (dentro de engine/fake-engine.mjs)
// nunca cruza sessões entre testes.
function criarAmbiente({ projetoVazio = true } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nascera-pipeline-test-'));
  const projectId = crypto.randomUUID();
  const proj = { id: projectId, path: tmpDir, owner: 'testuser' };
  const projects = [proj];
  const loadProjects = () => projects;
  const saveProjects = () => {};

  // O sinal de "primeira mensagem" que o classificador usa é o histórico de
  // chat vazio (mesma convenção já usada pelo build-scope) — não o disco. Um
  // projeto "não vazio" aqui é um projeto com CONVERSA anterior, exatamente
  // como qualquer projeto real (o scaffold já grava arquivos em todo projeto
  // novo, então "tem arquivo em disco" nunca seria um sinal útil na prática).
  const chatHistories = new Map();
  if (!projetoVazio) {
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<h1>já existe</h1>');
    chatHistories.set(projectId, [{ role: 'user', content: 'crie um site simples', timestamp: Date.now() }]);
  }
  const appendChatMessage = (pid, msg) => {
    const arr = chatHistories.get(pid) || [];
    arr.push(msg);
    chatHistories.set(pid, arr);
  };
  const loadChatHistory = (pid) => chatHistories.get(pid) || [];

  const nasceraConfig = {}; // pipelineAutomatico ligado por padrão (sem a chave)
  const loadNasceraConfig = () => nasceraConfig;

  const billing = {
    gateDecision: () => ({ decision: { applicable: false } }),
    debitTurn: () => ({ applicable: false }),
    summaryFor: () => ({ session: {}, week: {}, windows: {} }),
    BLOCK_MESSAGE: 'bloqueado',
  };

  const planejamentoAutomatico = planejamentoAutomaticoMod.criar({ loadNasceraConfig, motores });

  const channels = new Map();
  const { ensureChannel } = motorCanal.criar({
    channels, appendChatMessage, loadProjects, saveProjects, billing,
    autoCommitAsync: async () => {}, atualizarProjeto: () => {}, getCurrentVersion: () => '1',
    generateProjectScreenshot: async () => null,
    getEngine: () => import('../engine/fake-engine.mjs'),
    sessionKeyFor, isDesktopLocal: true,
    escreverFerramentaDeImagem: () => {}, memoriaProjeto,
    PROJECTS_BASE: tmpDir, normalizeBuildLevel: (v) => v || 3,
    loadNasceraConfig, modelosLocais: { ambienteParaMotor: () => ({}) },
    motores, vpsSpawnWrapper: () => null, BUILD_LEVELS,
    segredos: null, writeCavemanSkill: () => {}, planejamentoAutomatico,
  });

  const wss = new EventEmitter();
  motorWs.registrar(wss, {
    sessions: new Map(),
    verifyToken: (token) => (token === 'FAKE' ? { user: 'testuser' } : null),
    loadProjects, podeAcessarProjeto: () => true, trackEvent: () => {},
    loadChatHistory, ensureChannel, loadUsers: () => ({}), billing, appendChatMessage,
    switchAgentForProject: () => {}, agentInlinePrefix: () => '',
    memoriaProjeto, getIntegrationsContext: () => '',
    getBuildScopeContext: () => '', BUILD_LEVELS, planejamentoAutomatico,
  });

  return { wss, proj, tmpDir, planejamentoAutomatico };
}

function criarWsFalso() {
  const ws = new EventEmitter();
  ws.readyState = WebSocket.OPEN;
  ws.recebidos = [];
  ws.send = (json) => { ws.recebidos.push(JSON.parse(json)); };
  ws.close = () => {};
  return ws;
}

async function conectar(wss, projectId) {
  const ws = criarWsFalso();
  const req = { url: `/ws?token=FAKE&projectId=${projectId}`, headers: { host: 'localhost' } };
  wss.emit('connection', ws, req);
  await esperarTipo(ws, 'ready');
  ws.recebidos.length = 0; // limpa o handshake inicial pra não poluir as asserções do teste
  return ws;
}

function mandar(ws, mensagem) {
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'chat', message: mensagem })));
}

async function esperarTipo(ws, tipo, tentativasMax = 100) {
  for (let i = 0; i < tentativasMax; i++) {
    const achado = ws.recebidos.find((m) => m.type === tipo);
    if (achado) return achado;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Nunca recebi evento tipo="${tipo}" — recebidos: ${JSON.stringify(ws.recebidos)}`);
}

test('mensagem trivial em projeto com arquivos nunca entra em planejamento', async () => {
  const { wss, proj, planejamentoAutomatico } = criarAmbiente({ projetoVazio: false });
  const ws = await conectar(wss, proj.id);

  mandar(ws, 'conserta a cor do botão');
  await esperarTipo(ws, 'done');

  assert.equal(planejamentoAutomatico.estaPlanejando(proj.id), false);
  assert.equal(fs.existsSync(memoriaProjeto.caminhoDoPRD(proj.path)), false);
  // A resposta veio da sessão fake do Claude (texto característico dela).
  const resultado = ws.recebidos.find((m) => m.type === 'result');
  assert.ok(resultado, 'esperava um evento result');
});

test('pedido de criação em projeto vazio passa por planejamento e depois faz handoff pro Claude', async () => {
  const { wss, proj, planejamentoAutomatico } = criarAmbiente({ projetoVazio: true });
  const ws = await conectar(wss, proj.id);

  mandar(ws, 'crie um site para minha padaria');
  await esperarTipo(ws, 'done');

  assert.equal(planejamentoAutomatico.estaPlanejando(proj.id), false, 'planejamento deveria ter concluído');
  assert.equal(fs.existsSync(memoriaProjeto.caminhoDoPRD(proj.path)), true, 'PRD deveria existir');
  const prd = fs.readFileSync(memoriaProjeto.caminhoDoPRD(proj.path), 'utf8');
  assert.ok(!prd.includes('NASCERA_PRD_PRONTO'), 'marcador nunca deveria sobrar no PRD');
  // O PRD nunca deve vazar pro CLAUDE.md/AGENTS.md nem pro chat do usuário.
  const claudeMd = fs.existsSync(path.join(proj.path, 'CLAUDE.md')) ? fs.readFileSync(path.join(proj.path, 'CLAUDE.md'), 'utf8') : '';
  assert.ok(!claudeMd.includes('Site fake de teste'), 'PRD não deveria vazar pro CLAUDE.md');
  for (const m of ws.recebidos) {
    if (typeof m.content === 'string') assert.ok(!m.content.includes('NASCERA_PRD_PRONTO'));
  }
  // Prova de que o Claude (não o mesmo canal OpenCode) assumiu o handoff:
  // é a sessão fake do Claude que escreve este arquivo (ver fake-engine.mjs).
  assert.equal(fs.existsSync(path.join(proj.path, 'index.html')), true, 'o Claude deveria ter assumido e "construído" algo');
});

test('planejamento com múltiplas rodadas mantém a mesma sessão até o marcador', async () => {
  const { wss, proj, planejamentoAutomatico } = criarAmbiente({ projetoVazio: true });
  const ws = await conectar(wss, proj.id);

  mandar(ws, 'crie um app __PLAN_MULTI_ROUND__');
  await esperarTipo(ws, 'done');
  assert.equal(planejamentoAutomatico.estaPlanejando(proj.id), true, 'ainda deveria estar planejando após a 1ª rodada');
  ws.recebidos.length = 0;

  mandar(ws, 'só uma página mesmo');
  await esperarTipo(ws, 'done');
  assert.equal(planejamentoAutomatico.estaPlanejando(proj.id), false, 'deveria ter concluído na 2ª rodada');
  assert.equal(fs.existsSync(memoriaProjeto.caminhoDoPRD(proj.path)), true);
});

test('teto de rodadas força o handoff mesmo sem o marcador', async () => {
  const { wss, proj, planejamentoAutomatico } = criarAmbiente({ projetoVazio: true });
  const ws = await conectar(wss, proj.id);

  mandar(ws, 'crie um sistema completo __PLAN_NEVER__');
  await esperarTipo(ws, 'done');

  for (let i = 0; i < planejamentoAutomatico.MAX_RODADAS + 2 && planejamentoAutomatico.estaPlanejando(proj.id); i++) {
    ws.recebidos.length = 0;
    mandar(ws, 'continua sem se decidir __PLAN_NEVER__');
    await esperarTipo(ws, 'done');
  }

  assert.equal(planejamentoAutomatico.estaPlanejando(proj.id), false, 'o teto deveria ter forçado o handoff');
  assert.equal(fs.existsSync(memoriaProjeto.caminhoDoPRD(proj.path)), true);
  assert.equal(fs.existsSync(path.join(proj.path, 'index.html')), true, 'o Claude deveria ter assumido depois do teto');
});

test('erro do OpenCode durante o planejamento cai direto pro Claude com a mensagem original', async () => {
  const { wss, proj, planejamentoAutomatico } = criarAmbiente({ projetoVazio: true });
  const ws = await conectar(wss, proj.id);

  mandar(ws, 'crie uma landing page __PLAN_ERROR__');
  await esperarTipo(ws, 'done');

  assert.equal(planejamentoAutomatico.estaPlanejando(proj.id), false, 'planejamento deveria ter sido abandonado');
  assert.equal(fs.existsSync(memoriaProjeto.caminhoDoPRD(proj.path)), false, 'não deveria ter PRD nenhum');
  // A prova de trabalho do Claude fake (index.html) confirma que o Claude
  // realmente recebeu e processou o turno de fallback.
  assert.equal(fs.existsSync(path.join(proj.path, 'index.html')), true);
});
