/*
 * ═══════════════════════════════════════════════════════════════════════
 * NASCERA Engine — GPT Codex
 *
 * Segundo motor do NASCERA, ao lado do Claude Code. O resto do sistema não
 * deve saber qual dos dois está rodando: esta classe expõe a MESMA
 * superfície de `ClaudeSession` (mesmos métodos, mesmos eventos), porque o
 * server.js e o chat consomem 17 métodos e 13 eventos dela. Qualquer
 * diferença aqui vira bug lá.
 *
 * A diferença de fundo entre os dois motores:
 *
 *   Claude Code  → sessão VIVA. Um processo fica de pé, recebe mensagem por
 *                  streaming e responde. Permissão de ferramenta é
 *                  perguntada em tempo real (canUseTool).
 *
 *   Codex        → um processo POR TURNO. `codex exec --json` roda, emite
 *                  eventos em JSONL e termina. A continuidade vem do
 *                  `thread_id`, retomado com `resume`.
 *
 * Isso tem uma consequência que não dá para esconder: no Codex a permissão
 * é decidida ANTES do turno (pela sandbox), não durante. Por isso o "modo
 * de execução" do NASCERA vira flag de sandbox, e não há pergunta no meio do
 * caminho. O evento 'question' existe aqui só para manter o contrato.
 *
 * Vocabulário de eventos do Codex, verificado rodando de verdade:
 *   thread.started   → { thread_id }            (id da sessão, p/ resume)
 *   turn.started
 *   item.started     → { item: {type, ...} }
 *   item.completed   → { item: {type, ...} }    agent_message | file_change
 *                                               | command_execution | error
 *   turn.completed   → { usage: {input_tokens, output_tokens, ...} }
 * ═══════════════════════════════════════════════════════════════════════
 */

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

// Os mesmos nomes de modo do NASCERA, traduzidos para o que o Codex entende.
// 'turbo' e 'bypass' liberam tudo porque é o que o cliente espera do NASCERA:
// ele pediu um site, não quer aprovar cada arquivo.
const MODO_PARA_SANDBOX = {
  plan: 'read-only',      // só lê: serve para planejar sem tocar em nada
  ask: 'workspace-write',
  edits: 'workspace-write',
  turbo: 'workspace-write',
  bypass: 'danger-full-access',
};

export const CODEX_MODELOS = [
  { value: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', description: 'Padrão do Codex para código', supportsEffort: true },
  { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini', description: 'Mais rápido e barato', supportsEffort: true },
];
const ESFORCOS = ['minimal', 'low', 'medium', 'high'];

export class CodexSession extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.cwd = opts.cwd || process.cwd();
    this.mode = MODO_PARA_SANDBOX[opts.mode] ? opts.mode : 'turbo';
    this.model = opts.model || null;
    this.effort = opts.effort || null;
    this.env = opts.env || {};
    this.comando = opts.codexPath || 'codex';
    this.log = opts.log || (() => {});
    this._spawnWrapper = opts.spawnClaudeCodeProcess || null;

    this.closed = false;
    this.running = false;
    // VAZAMENTO DE SESSÃO: o sweeper do SessionManager decide o que varrer com
    // `Date.now() - s.lastActivity > timeout`. Sem este campo, a conta dava
    // `NaN`, e toda comparação com NaN é falsa — ou seja, sessão de Codex
    // NUNCA era varrida e o processo ficava vivo para sempre. O Claude já
    // definia isto no construtor; aqui faltava.
    this.lastActivity = Date.now();
    this.sessionId = opts.resumeSessionId || null;   // thread_id do Codex
    this.modelList = CODEX_MODELOS;
    this.commandList = [];
    this.accountCache = null;
    this.pendingInteractions = new Map();   // o Codex não pergunta no meio; fica vazio
    this.initInfo = null;
    this._backlog = [];
    this._proc = null;
    this._turnos = 0;
    this._tokens = { entrada: 0, saida: 0 };
  }

  // ─── contrato: start ───────────────────────────────────────────────
  // O Claude sobe um processo aqui. O Codex não tem o que subir antes do
  // primeiro turno, então apenas anunciamos o init para a UI popular os
  // seletores de modelo/modo/esforço.
  start() {
    if (this.initInfo) return;
    this.initInfo = {
      sessionId: this.sessionId,
      model: this.model || CODEX_MODELOS[0].value,
      mode: this.mode,
      motor: 'codex',
      models: this.modelList,
      commands: this.commandList,
      effortLevels: ESFORCOS,
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
    // Marca atividade a cada mensagem: sem isto, uma sessão em uso seria
    // varrida no meio do trabalho assim que o relógio de ociosidade passasse.
    this.lastActivity = Date.now();
    if (this.running) {
      // TETO no backlog: sem limite, um cliente que dispara mensagens mais
      // rápido do que o motor consome faz a fila crescer sem fim até estourar
      // a memória do processo — que derruba TODOS os usuários, não só ele.
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

  // A ORDEM importa e não é intuitiva. A sintaxe é:
  //   codex exec [OPÇÕES] <PROMPT>
  //   codex exec [OPÇÕES] resume <SESSION_ID> <PROMPT>
  // O prompt é ARGUMENTO POSICIONAL, sempre por último. Montar as opções e
  // esquecer o prompt faz o Codex ficar esperando stdin e travar o turno.
  _argumentos(prompt) {
    const args = ['exec', '--json', '--skip-git-repo-check', '--cd', this.cwd];
    args.push('-s', MODO_PARA_SANDBOX[this.mode] || 'workspace-write');
    if (this.mode === 'bypass') args.push('--dangerously-bypass-approvals-and-sandbox');
    if (this.model) args.push('-m', this.model);
    // Esforço não é flag: é config. Sem isto o seletor da UI seria decorativo.
    if (this.effort && ESFORCOS.includes(this.effort)) {
      args.push('-c', `model_reasoning_effort="${this.effort}"`);
    }
    // Continuidade: sem o thread_id cada mensagem começaria do zero e o
    // Codex não lembraria do que acabou de construir.
    if (this.sessionId) args.push('resume', this.sessionId);
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
    this.log('codex ' + args.slice(0, -1).join(' ') + ' <prompt>');
    this.emit('status', { status: 'running', message: '' });

    const opcoes = {
      command: this.comando, args, cwd: this.cwd,
      env: { ...process.env, ...this.env },
    };
    // Mesmo cofre do outro motor: se o servidor passou um embrulho de
    // spawn, o Codex roda dentro dele também.
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
      this.emit('error', { message: 'Codex falhou ao iniciar: ' + err.message });
    });

    this._proc.on('close', (code) => {
      this.running = false;
      this._proc = null;
      if (code !== 0 && code !== null) {
        this.emit('error', { message: 'Codex terminou com código ' + code });
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

    // O prompt já foi como último argumento. Fechar o stdin é obrigatório:
    // com ele aberto o Codex fica lendo entrada e o turno nunca termina.
    if (this._proc.stdin) {
      try { this._proc.stdin.end(); } catch {}
    }
  }

  // Traduz o vocabulário do Codex para os eventos que o NASCERA já entende.
  _traduzirEvento(ev, respostaFinal) {
    switch (ev.type) {
      case 'thread.started':
        if (ev.thread_id) {
          this.sessionId = ev.thread_id;
          this.emit('init', { ...(this.initInfo || {}), sessionId: this.sessionId });
        }
        break;

      case 'turn.completed':
        if (ev.usage) {
          this._tokens.entrada += ev.usage.input_tokens || 0;
          this._tokens.saida += ev.usage.output_tokens || 0;
        }
        break;

      case 'item.started':
      case 'item.completed': {
        const item = ev.item || {};
        if (item.type === 'agent_message' && item.text) {
          // Só no completed, senão o texto sai duplicado na tela.
          if (ev.type === 'item.completed') {
            this.emit('text', { content: item.text, parentId: null });
            respostaFinal = item.text;
          }
        } else if (item.type === 'command_execution') {
          this.emit('delta', {
            kind: 'tool', name: 'Bash',
            input: { command: item.command || '' },
            status: ev.type === 'item.completed' ? 'done' : 'running',
          });
        } else if (item.type === 'file_change') {
          this.emit('delta', {
            kind: 'tool', name: 'Edit',
            input: { path: item.path || (item.changes && item.changes[0] && item.changes[0].path) || '' },
            status: ev.type === 'item.completed' ? 'done' : 'running',
          });
        } else if (item.type === 'reasoning' && item.text) {
          this.emit('delta', { kind: 'thinking', text: item.text });
        } else if (item.type === 'todo_list') {
          this.emit('plan', { items: item.items || [] });
        } else if (item.type === 'error' && ev.type === 'item.completed') {
          // O Codex emite avisos como item de erro; só o que interrompe o
          // turno merece virar erro na cara do usuário.
          const msg = String(item.message || '');
          if (/Under-development features/i.test(msg)) this.log('aviso do codex: ' + msg.slice(0, 160));
          else this.emit('error', { message: msg });
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

    // Mesmo portão do motor Claude: os tetos de crédito precisam valer para
    // CADA turno da fila, não só para o primeiro. Sem isto, uma rajada de
    // mensagens passava toda pelo portão de entrada (que lê o saldo antes de
    // qualquer débito) e era despachada aqui sem nova conferência.
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

  async setEffort(effort) {
    if (!ESFORCOS.includes(effort)) return { ok: false };
    this.effort = effort;
    return { ok: true };
  }

  async setMode(mode) {
    if (!MODO_PARA_SANDBOX[mode]) return { ok: false };
    this.mode = mode;
    this.emit('init', { ...(this.initInfo || {}), mode });
    return { ok: true };
  }

  // O Codex não pergunta no meio do turno — a sandbox já decidiu. Mantido
  // para o contrato não quebrar quando a UI chamar.
  respondInteraction() { return false; }
  replayPending() {}

  interrupt() {
    if (this._proc) { try { this._proc.kill('SIGTERM'); } catch {} }
    this._backlog = [];
    this.running = false;
    this.emit('status', { status: 'idle', message: 'interrompido' });
  }

  // Não existe compactação no Codex: o thread é gerenciado por ele.
  async compact() { return { ok: false, motivo: 'O Codex gerencia o contexto sozinho.' }; }

  accountInfo() { return this.accountCache; }
  contextUsage() { return null; }
  usedPct() { return null; }
  resetsAt() { return null; }

  status() {
    return {
      motor: 'codex',
      running: this.running,
      closed: this.closed,
      sessionId: this.sessionId,
      model: this.model || CODEX_MODELOS[0].value,
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

export default CodexSession;
