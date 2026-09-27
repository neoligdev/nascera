// ═══════════════════════════════════════════════════════════════════════
// NASCERA — MOTOR FALSO (só para teste). Carregado APENAS sob NASCERA_FAKE_ENGINE=1
// pelo getEngine() do server.js. Espelha a superfície que o server consome do
// claude-engine.mjs (sessionManager + ClaudeSession) para exercer o fluxo real
// de build/chat — bindChannel, handleChat, WebSocket, chat-history, o ramo de
// crédito — SEM subir o Claude real e SEM gastar 1 centavo.
//
// Por construção: result sai com cost:0 e modelUsage:null ⇒ o ramo de débito do
// bindChannel (server.js) é PULADO; e o fake nem importa o SDK. É a rede que
// prova que a costura getEngine/motor continua íntegra depois de extrair a infra.
// ═══════════════════════════════════════════════════════════════════════
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

class FakeClaudeSession extends EventEmitter {
  constructor(o = {}) {
    super();
    this.key = o.key; this.cwd = o.cwd; this.dono = o.dono || null;
    this.closed = false; this.running = false;
    this.sessionId = 'fake-' + crypto.randomUUID();
    this.initInfo = null;
    this.pendingInteractions = new Map();
  }
  start() {
    process.nextTick(() => {
      if (this.closed) return;
      this.initInfo = {
        sessionId: this.sessionId, motor: 'claude', model: 'fake', mode: 'turbo',
        effort: null, modes: ['turbo', 'ask', 'edits', 'plan', 'bypass'],
        tools: [], slashCommands: [], commands: [], skills: [], agents: [],
        version: 'fake', models: [],
      };
      this.emit('init', this.initInfo);
    });
  }
  send() {
    if (this.closed) throw new Error('Sessão encerrada');
    if (this.running) { this.emit('queued', { queued: 1 }); return; }
    this.running = true;
    setImmediate(() => this._runTurn());
  }
  _runTurn() {
    if (this.closed) return;
    // "Prova de trabalho" real no cwd — como o Claude escreveria arquivos.
    try {
      fs.writeFileSync(path.join(this.cwd, 'index.html'),
        '<!doctype html><title>fake</title><h1>ok</h1>');
    } catch {}
    this.emit('session-id', { sessionId: this.sessionId });
    this.emit('tool_use', {
      id: 't1', tool: 'Write',
      input: { file_path: 'index.html', content: '<!doctype html>...' },
      parentId: null, agent: null,
    });
    this.emit('tool_result', {
      tool: 'Write', toolUseId: 't1', content: 'File written', is_error: false, parentId: null,
    });
    this.emit('text', { content: 'Pronto! Criei o index.html.', parentId: null });
    this.running = false;
    this.emit('result', {
      content: 'Pronto! Criei o index.html.', subtype: 'success', isError: false,
      cost: 0, duration: 5, usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: null, sessionId: this.sessionId,
    });
  }
  async interrupt() { this.running = false; }
  async setModel() {}
  async setMode() {}
  async setEffort() {}
  compact() {}
  async contextUsage() { return null; }
  async accountInfo() { return null; }
  respondInteraction() { return false; }
  replayPending() {}
  status() {
    return {
      key: this.key, sessionId: this.sessionId, running: this.running,
      mode: 'turbo', model: 'fake', turnCount: 0, totalCostUsd: 0,
    };
  }
  close(reason = 'manual') {
    if (this.closed) return;
    this.closed = true;
    this.emit('closed', { reason });
    this.removeAllListeners();
  }
}

// Motor falso do OpenCode — só pra exercer o pipeline de planejamento
// automático (servicos/planejamento-automatico.js) sem gastar 1 centavo nem
// depender do CLI de verdade. O `result` sai com `text` (não `content`),
// igual ao engine/opencode-engine.mjs de verdade — é essa diferença de forma
// que o pipeline precisa tratar corretamente (ver a checagem `r.text ||
// r.content` em servicos/motor-ws.js).
//
// Sentinelas no próprio texto da mensagem controlam o comportamento, pra dar
// aos testes controle determinístico sem mexer em timers:
//   __PLAN_ERROR__       → emite 'error' em vez de 'result' (testa o fallback)
//   __PLAN_MULTI_ROUND__ → não emite o marcador na 1ª rodada, só na 2ª
//   __PLAN_NEVER__       → nunca emite o marcador (testa o teto de rodadas)
class FakeOpenCodeSession extends EventEmitter {
  constructor(o = {}) {
    super();
    this.key = o.key; this.cwd = o.cwd; this.dono = o.dono || null;
    this.closed = false; this.running = false;
    this.sessionId = o.resumeSessionId || ('fake-oc-' + crypto.randomUUID());
    this.initInfo = null;
    this.pendingInteractions = new Map();
    this._turnos = 0;
  }
  start() {
    process.nextTick(() => {
      if (this.closed) return;
      this.initInfo = {
        sessionId: this.sessionId, motor: 'opencode', model: 'opencode/big-pickle',
        mode: 'turbo', effortLevels: [], models: [], commands: [],
      };
      this.emit('init', this.initInfo);
    });
  }
  send(content) {
    if (this.closed) throw new Error('Sessão encerrada');
    if (this.running) { this.emit('queued', { queued: 1 }); return; }
    this.running = true;
    const texto = typeof content === 'string' ? content : String(content || '');
    setImmediate(() => this._runTurn(texto));
  }
  _runTurn(texto) {
    if (this.closed) return;
    this._turnos++;
    if (/__PLAN_ERROR__/.test(texto)) {
      this.running = false;
      this.emit('error', { message: 'Falha simulada do OpenCode' });
      return;
    }
    const nuncaConclui = /__PLAN_NEVER__/.test(texto);
    const multiRodada = /__PLAN_MULTI_ROUND__/.test(texto);
    const semMarcadorAinda = nuncaConclui || (multiRodada && this._turnos < 2);
    const resposta = semMarcadorAinda
      ? 'Só pra confirmar: é um site de uma página ou várias?'
      : '# PRD\nSite fake de teste.\n[[NASCERA_PRD_PRONTO]]';
    this.emit('text', { content: resposta, parentId: null });
    this.running = false;
    this.emit('result', {
      text: resposta, sessionId: this.sessionId, turns: this._turnos,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  }
  async interrupt() { this.running = false; }
  async setModel() {}
  async setMode() {}
  async setEffort() { return { ok: false }; }
  compact() {}
  async contextUsage() { return null; }
  async accountInfo() { return null; }
  respondInteraction() { return false; }
  replayPending() {}
  status() {
    return {
      key: this.key, sessionId: this.sessionId, running: this.running,
      mode: 'turbo', model: 'opencode/big-pickle', turnCount: this._turnos, totalCostUsd: 0,
    };
  }
  close(reason = 'manual') {
    if (this.closed) return;
    this.closed = true;
    this.emit('closed', { reason });
    this.removeAllListeners();
  }
}

// Motor → classe de sessão fake, mesmo espírito do CONSTRUTORES_DE_MOTOR real
// (claude-engine.mjs) — sem isto, TODO turno em teste nasceria Claude, e o
// pipeline de planejamento nunca teria como ser exercido sob fake engine.
const CONSTRUTORES_DE_MOTOR_FAKE = { opencode: FakeOpenCodeSession };

class FakeSessionManager {
  constructor() { this.sessions = new Map(); }
  get(k) { return this.sessions.get(k) || null; }
  contar() { return { total: this.sessions.size, doUsuario: 0 }; }
  limites() { return { global: 24, porUsuario: 3 }; }
  podeAbrir() { return { ok: true }; }
  obtain(key, opts = {}) {
    let s = this.sessions.get(key);
    if (s && !s.closed) return s;
    const Ctor = (opts && CONSTRUTORES_DE_MOTOR_FAKE[opts.motor]) || FakeClaudeSession;
    s = new Ctor({ ...opts, key });
    this.sessions.set(key, s);
    s.on('closed', () => { if (this.sessions.get(key) === s) this.sessions.delete(key); });
    s.start();
    return s;
  }
  closeAll() {
    for (const s of this.sessions.values()) { try { s.close('shutdown'); } catch {} }
    this.sessions.clear();
  }
}

export const sessionManager = new FakeSessionManager();
export const ClaudeSession = FakeClaudeSession;
export const OpenCodeSession = FakeOpenCodeSession;
