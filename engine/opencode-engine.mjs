/*
 * ═══════════════════════════════════════════════════════════════════════
 * NASCERA Engine — OpenCode
 *
 * Terceiro motor do NASCERA, ao lado do Claude Code e do GPT Codex. Expõe a
 * MESMA superfície de `ClaudeSession`/`CodexSession` (mesmos métodos, mesmos
 * eventos) — o resto do sistema não deve saber qual dos três está rodando.
 *
 * A diferença de fundo: como o Codex, o OpenCode roda UM PROCESSO POR TURNO
 * (`opencode run --format json`), sem sessão viva. A continuidade vem do
 * `sessionID` (formato `ses_...`), retomado com `--session <id>`.
 *
 * `--standalone` evita um problema real e medido: sem ela, em versões que a
 * suportam (testado no pacote npm `@opencode/cli`, v2.0.17), `opencode run`
 * fala com um serviço de fundo COMPARTILHADO pela máquina inteira, preso a
 * uma porta fixa — turnos concorrentes de projetos/clientes diferentes
 * disputariam o mesmo processo. Por isso este motor usa a flag SEMPRE que a
 * instalação a reconhece (ver `suportaStandalone`); numa instalação sem essa
 * flag (medido: um binário 1.18.32 instalado nesta máquina não a tem, e
 * rejeitaria o turno inteiro se ela fosse passada às cegas), o motor segue
 * sem `--standalone` — o isolamento entre turnos concorrentes nessa versão
 * mais antiga ainda não foi medido e é um risco residual, não uma garantia.
 *
 * O OpenCode é multi-provedor: o DeepSeek entra aqui como um MODELO
 * (`deepseek/deepseek-chat`), não como motor à parte. Ele só funciona se o
 * admin tiver configurado o provedor `deepseek` no `opencode.json` global
 * (ver `motores.js:lerConfigOpenCode` e `rotas/admin-motores.js`) E setado a
 * variável de ambiente que esse provedor declara — que este motor injeta no
 * `env` do processo (vindo de `servicos/motor-canal.js`), sem escrever
 * config nenhuma por turno.
 *
 * MEDIDO DE VERDADE (pacote @opencode/cli v2.0.17, instalação isolada, sem
 * chave real): um turno com provedor `deepseek` configurado e chave FALSA
 * produziu
 *   {"type":"error","timestamp":...,"sessionID":"ses_...","error":{"type":"provider.auth","message":"...","status":401}}
 * confirmando que o mecanismo de provedor customizado por env var funciona —
 * a requisição realmente chegou à API do DeepSeek. NÃO foi possível capturar
 * ainda um turno de SUCESSO (exigiria uma chave real ou um Ollama local), então
 * os eventos de texto/ferramenta abaixo seguem uma hipótese de terceiros
 * (não documentada oficialmente) e precisam ser confirmados com um turno real
 * antes de considerar a tradução definitiva — o `default` do switch cobre
 * o caso de o formato vir diferente do esperado sem quebrar o turno.
 *
 * `--standalone` NÃO EXISTE EM TODA VERSÃO — medido nesta mesma máquina:
 * uma instalação real via `opencode.ai/install` (binário 1.18.32) não tem
 * essa flag, e o parser de argumentos dela é estrito o bastante para
 * imprimir o help e SAIR COM CÓDIGO 1 em vez de ignorá-la — ou seja, passar
 * `--standalone` sem checar quebraria TODO turno nessa instalação. Por isso
 * `suportaStandalone()` abaixo detecta uma vez (via `run --help`) e cacheia,
 * em vez de supor que a flag sempre existe.
 * ═══════════════════════════════════════════════════════════════════════
 */

import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';

// Cache por caminho de binário — instalações diferentes (embarcada vs global
// vs apontada por OPENCODE_CMD) podem ter versões diferentes na mesma
// máquina. `run --help` é rápido e não spawna processo nenhum de turno.
const _suportaStandaloneCache = new Map();
function suportaStandalone(comando) {
  if (_suportaStandaloneCache.has(comando)) return _suportaStandaloneCache.get(comando);
  let suporta = false;
  try {
    const r = spawnSync(comando, ['run', '--help'], { encoding: 'utf8', timeout: 8000 });
    suporta = /--standalone\b/.test(String(r.stdout || '') + String(r.stderr || ''));
  } catch { suporta = false; }
  _suportaStandaloneCache.set(comando, suporta);
  return suporta;
}

// O OpenCode não tem sandbox tipo Codex nem pergunta em tempo real (o `run`
// é não-interativo): o controle real é `--auto` (aprova tudo que não for
// negado explicitamente por uma regra de `permissions`). Sem `--auto`, uma
// ação que exigiria aprovação não tem para quem perguntar — o comportamento
// exato (nega, falha visível, ou trava) ainda não foi medido (ver
// docs/superpowers/specs, item de verificação do plano), por isso os modos
// "de meio-termo" (`ask`/`edits`) ficam do lado conservador (sem --auto) até
// isso ser confirmado.
const MODO_USA_AUTO = { plan: false, ask: false, edits: false, turbo: true, bypass: true };

export const OPENCODE_MODELOS = [
  { value: 'deepseek/deepseek-chat', label: 'DeepSeek Chat', description: 'Rápido, custo baixo', supportsEffort: false },
  { value: 'deepseek/deepseek-reasoner', label: 'DeepSeek Reasoner', description: 'Raciocínio mais profundo, mais lento', supportsEffort: false },
];

export class OpenCodeSession extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.cwd = opts.cwd || process.cwd();
    this.mode = MODO_USA_AUTO[opts.mode] !== undefined ? opts.mode : 'turbo';
    this.model = opts.model || null;
    this.effort = null; // o OpenCode não tem escala de esforço própria
    this.env = opts.env || {};
    this.comando = opts.opencodePath || 'opencode';
    this.log = opts.log || (() => {});
    this._spawnWrapper = opts.spawnClaudeCodeProcess || null;

    this.closed = false;
    this.running = false;
    // Mesmo campo que Codex/Claude precisam para o sweeper do SessionManager
    // não varrer uma sessão em uso (ver o comentário equivalente em codex-engine.mjs).
    this.lastActivity = Date.now();
    this.sessionId = opts.resumeSessionId || null; // sessionID do OpenCode
    this.modelList = OPENCODE_MODELOS;
    this.commandList = [];
    this.accountCache = null;
    this.pendingInteractions = new Map(); // o OpenCode não pergunta no meio; fica vazio
    this.initInfo = null;
    this._backlog = [];
    this._proc = null;
    this._turnos = 0;
    this._tokens = { entrada: 0, saida: 0 };
  }

  // ─── contrato: start ───────────────────────────────────────────────
  start() {
    if (this.initInfo) return;
    this.initInfo = {
      sessionId: this.sessionId,
      model: this.model || OPENCODE_MODELOS[0].value,
      mode: this.mode,
      motor: 'opencode',
      models: this.modelList,
      commands: this.commandList,
      effortLevels: [],
      account: null,
    };
    setImmediate(() => {
      this.emit('init', this.initInfo);
      this.emit('models', { models: this.modelList });
    });
  }

  // ─── contrato: send ────────────────────────────────────────────────
  send(content) {
    if (this.closed) throw new Error('Sessão encerrada');
    this.lastActivity = Date.now();
    if (this.running) {
      const TETO_BACKLOG = 50;
      if (this._backlog.length >= TETO_BACKLOG) {
        this.emit('error', new Error(
          'Fila cheia (' + TETO_BACKLOG + ' mensagens). Espere o turno atual terminar.'));
        return;
      }
      this._backlog.push(content);
      this.emit('queued', { queued: this._backlog.length });
      return;
    }
    this._rodarTurno(content);
  }

  // O prompt é ARGUMENTO POSICIONAL, sempre por último (mesma regra do
  // Codex). `--standalone` só entra quando a instalação suporta (ver
  // suportaStandalone, no topo do arquivo, e o porquê no cabeçalho). Sem
  // `--dir`/`--cd`: usamos o `cwd` do PROCESSO (opção do spawn, não flag de
  // CLI) para que funcione nas duas versões testadas — uma tem `--dir`,
  // outra não, mas `cwd` do processo é universal.
  _argumentos(prompt) {
    const args = ['run', '--format', 'json'];
    if (suportaStandalone(this.comando)) args.push('--standalone');
    if (this.model) args.push('--model', this.model);
    if (this.sessionId) args.push('--session', this.sessionId);
    if (MODO_USA_AUTO[this.mode]) args.push('--auto');
    args.push(prompt);
    return args;
  }

  _rodarTurno(content) {
    this.running = true;
    this._turnos++;
    const texto = typeof content === 'string'
      ? content
      : (Array.isArray(content)
          ? content.map(b => (b && b.type === 'text' ? b.text : '')).join('\n')
          : String(content || ''));

    const args = this._argumentos(texto);
    this.log('opencode ' + args.slice(0, -1).join(' ') + ' <prompt>');
    this.emit('status', { status: 'running', message: '' });

    const opcoes = {
      command: this.comando, args, cwd: this.cwd,
      env: { ...process.env, ...this.env },
    };
    // Mesmo cofre do outro motor: se o servidor passou um embrulho de spawn,
    // o OpenCode roda dentro dele também.
    this._proc = this._spawnWrapper
      ? this._spawnWrapper(opcoes)
      : spawn(opcoes.command, opcoes.args, { cwd: opcoes.cwd, env: opcoes.env, stdio: ['pipe', 'pipe', 'pipe'] });

    let buffer = '';
    let respostaFinal = '';

    this._proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      const linhas = buffer.split('\n');
      buffer = linhas.pop();
      for (const linha of linhas) {
        if (!linha.trim()) continue;
        let ev;
        try { ev = JSON.parse(linha); } catch { continue; }
        respostaFinal = this._traduzirEvento(ev, respostaFinal);
      }
    });

    this._proc.stderr.on('data', (d) => this.log('stderr: ' + String(d).slice(0, 300)));

    this._proc.on('error', (err) => {
      this.running = false;
      this.emit('error', { message: 'OpenCode falhou ao iniciar: ' + err.message });
    });

    this._proc.on('close', (code) => {
      this.running = false;
      this._proc = null;
      if (code !== 0 && code !== null) {
        this.emit('error', { message: 'OpenCode terminou com código ' + code });
      }
      this.emit('result', {
        text: respostaFinal,
        sessionId: this.sessionId,
        turns: this._turnos,
        usage: { input_tokens: this._tokens.entrada, output_tokens: this._tokens.saida },
      });
      this.emit('status', { status: 'idle', message: '' });
      this._drenarFila();
    });

    if (this._proc.stdin) {
      try { this._proc.stdin.end(); } catch {}
    }
  }

  // Traduz o vocabulário do OpenCode para os eventos que o NASCERA já
  // entende. Só o ramo `error` foi confirmado rodando de verdade (ver
  // cabeçalho do arquivo); os demais são a melhor hipótese disponível e
  // caem no `default` sem quebrar o turno se o formato vier diferente.
  _traduzirEvento(ev, respostaFinal) {
    if (ev && ev.sessionID && ev.sessionID !== this.sessionId) {
      this.sessionId = ev.sessionID;
      this.emit('init', { ...(this.initInfo || {}), sessionId: this.sessionId });
    }
    switch (ev && ev.type) {
      case 'error': {
        const msg = (ev.error && (ev.error.message || ev.error.type)) || 'Erro do OpenCode';
        this.emit('error', { message: msg });
        break;
      }
      case 'text': {
        const t = ev.part && typeof ev.part.text === 'string' ? ev.part.text : null;
        if (t) { this.emit('text', { content: t, parentId: null }); respostaFinal = t; }
        break;
      }
      case 'tool_use': {
        const nome = ev.part && ev.part.tool;
        const status = ev.part && ev.part.state && ev.part.state.status;
        if (nome) {
          this.emit('delta', { kind: 'tool', name: nome, input: (ev.part.state && ev.part.state.input) || {}, status: status || 'running' });
        }
        break;
      }
      default:
        break;
    }
    return respostaFinal;
  }

  _drenarFila() {
    if (this.closed || this.running || !this._backlog.length) return;
    if (typeof this.podeDespachar === 'function') {
      let veredito;
      try { veredito = this.podeDespachar(); } catch { veredito = { ok: true }; }
      if (veredito && veredito.ok === false) {
        const descartadas = this._backlog.length;
        this._backlog.length = 0;
        this.emit('error', new Error(veredito.motivo ||
          'Limite de créditos atingido — ' + descartadas + ' mensagem(ns) na fila foram descartadas.'));
        return;
      }
    }
    this._rodarTurno(this._backlog.shift());
  }

  // ─── contrato: o resto da superfície ───────────────────────────────
  async setModel(model) {
    this.model = model;
    this.emit('init', { ...(this.initInfo || {}), model });
    return { ok: true };
  }

  // O OpenCode não tem escala de esforço própria — a "profundidade" é o
  // modelo escolhido (ex.: deepseek-reasoner em vez de deepseek-chat).
  async setEffort() { return { ok: false }; }

  async setMode(mode) {
    if (MODO_USA_AUTO[mode] === undefined) return { ok: false };
    this.mode = mode;
    this.emit('init', { ...(this.initInfo || {}), mode });
    return { ok: true };
  }

  // O OpenCode não pergunta no meio do turno (run é não-interativo). Mantido
  // para o contrato não quebrar quando a UI chamar.
  respondInteraction() { return false; }
  replayPending() {}

  interrupt() {
    if (this._proc) { try { this._proc.kill('SIGTERM'); } catch {} }
    this._backlog = [];
    this.running = false;
    this.emit('status', { status: 'idle', message: 'interrompido' });
  }

  // Não existe compactação de contexto documentada para o OpenCode.
  async compact() { return { ok: false, motivo: 'O OpenCode gerencia o contexto sozinho.' }; }

  accountInfo() { return this.accountCache; }
  contextUsage() { return null; }
  usedPct() { return null; }
  resetsAt() { return null; }

  status() {
    return {
      motor: 'opencode',
      running: this.running,
      closed: this.closed,
      sessionId: this.sessionId,
      model: this.model || OPENCODE_MODELOS[0].value,
      mode: this.mode,
      turns: this._turnos,
      queued: this._backlog.length,
      usage: { input_tokens: this._tokens.entrada, output_tokens: this._tokens.saida },
    };
  }

  close(reason = 'manual') {
    if (this.closed) return;
    this.closed = true;
    this.interrupt();
    this.emit('closed', { reason });
    this.removeAllListeners();
  }
}

export default OpenCodeSession;
