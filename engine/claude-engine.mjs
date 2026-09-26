// ═══════════════════════════════════════════════════════════════════════
// NASCERA Engine v2 — Motor do Claude Code sobre o @anthropic-ai/claude-agent-sdk
//
// Substitui o modelo antigo (um processo `claude -p` por mensagem) por UMA
// sessão viva por projeto, com streaming de entrada/saída. Isso habilita:
//   • streaming token a token (partial messages)
//   • troca de modelo em tempo real (setModel)
//   • permission modes reais (default/acceptEdits/plan/bypassPermissions)
//   • prompts de permissão interativos (canUseTool → UI)
//   • AskUserQuestion respondido pela UI (perguntas com opções)
//   • Plan mode real com aprovação de plano (ExitPlanMode)
//   • thinking (raciocínio estendido) visível
//   • imagens reais na mensagem (base64 content blocks)
//   • slash commands (/compact, /custom…), skills, subagents, hooks
//   • custo/uso por turno + uso de contexto
//   • resume de sessão persistida em ~/.claude (sobrevive a restart)
// ═══════════════════════════════════════════════════════════════════════

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { CodexSession } from './codex-engine.mjs';
import { OpenCodeSession } from './opencode-engine.mjs';
import fs from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
// Fronteira ESM↔CJS: `motores.js` é CommonJS e este arquivo é ESM. O Node
// entrega o `module.exports` do CJS como DEFAULT do import — não precisa de
// createRequire nem de reescrever nada lá. Importante: é o MESMO módulo que a
// tela de status e o login já usam, então "o binário que o NASCERA mostra" e "o
// binário que o NASCERA executa" passam a ser, por construção, o mesmo.
import motoresPadrao from '../motores.js';

// Modos expostos pela UI → configuração SDK.
// 'turbo'  = Nascera clássico: nunca pergunta. O auto-allow é decidido DENTRO do
//            canUseTool (não via allow-rules na camada de settings, que não é
//            removível de forma confiável em runtime), então trocar de modo tem
//            efeito imediato e perguntas do Claude/planos ainda chegam à UI.
// 'ask'    = pede permissão para ações sensíveis
// 'edits'  = acceptEdits (aceita edições, pergunta para comandos)
// 'plan'   = plan mode real (só lê/planeja; plano vem para aprovação)
// 'bypass' = bypassPermissions (pula TUDO no próprio CLI, sem passar por aqui)
export const NASCERA_MODES = ['turbo', 'ask', 'edits', 'plan', 'bypass'];

// No turbo, estas continuam indo para a UI mesmo "sem perguntar": são interações
// que o Claude iniciou e cuja resposta é o conteúdo esperado, não uma permissão.
const ALWAYS_INTERACTIVE = new Set(['AskUserQuestion', 'ExitPlanMode']);

function sdkModeFor(nasceraMode) {
  switch (nasceraMode) {
    case 'ask': return 'default';
    case 'edits': return 'acceptEdits';
    case 'plan': return 'plan';
    case 'bypass': return 'bypassPermissions';
    case 'turbo':
    default: return 'default';
  }
}

// ───────────────────────────────────────────────────────────────────────
// ClaudeSession — uma sessão viva do Claude Code para um projeto.
//
// Eventos emitidos (todos objetos prontos para serializar à UI):
//   'init'               {sessionId, model, modes, mode, tools, slashCommands, skills, version, models}
//   'delta'              {text}                      — streaming de texto
//   'thinking-delta'     {text}                      — streaming de raciocínio
//   'text'               {content}                   — bloco de texto completo
//   'thinking'           {content}                   — bloco de raciocínio completo
//   'tool_use'           {id, tool, input, parentId, agent}
//   'tool_result'        {tool, content, is_error, toolUseId}
//   'tool_progress'      {description, tool}
//   'permission_request' {id, tool, input, title, description, suggestions}
//   'question'           {id, questions}
//   'plan'               {id, plan}
//   'result'             {content, cost, duration, usage, sessionId, isError, subtype}
//   'status'             {status}                    — compacting | requesting | idle | running
//   'compact'            {trigger, preTokens, postTokens}
//   'model-changed'      {model}
//   'mode-changed'       {mode}
//   'error'              {message}
//   'closed'             {reason}
// ───────────────────────────────────────────────────────────────────────
export class ClaudeSession extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.key = opts.key;                          // projectId ou 'user:<nome>'
    this.cwd = opts.cwd;
    this.resumeSessionId = opts.resumeSessionId || null;
    this.model = opts.model || null;              // null = padrão da conta
    this.mode = NASCERA_MODES.includes(opts.mode) ? opts.mode : 'turbo';
    this.env = opts.env || {};
    this.log = opts.log || (() => {});
    this._spawnWrapper = opts.spawnClaudeCodeProcess || null;
    // Quem responde "onde mora o CLI do Claude Code". Injetável só para teste
    // (dublê de `motores`) e para quem já tenha o caminho na mão — em produção
    // é sempre o módulo `motores.js`. Ver `_executavelDoMotor`.
    this._motores = opts.motores || motoresPadrao;
    this.pathToClaudeCodeExecutable = opts.pathToClaudeCodeExecutable || null;
    // Sessões de ferramenta rodam isoladas (settingSources: []) para não
    // carregar skills/plugins pessoais do usuário — mais rápido e previsível.
    this.settingSources = Array.isArray(opts.settingSources) ? opts.settingSources : ['user', 'project', 'local'];
    this.initialEffort = opts.effort || null;

    this.sessionId = this.resumeSessionId;
    this.running = false;                          // turno em andamento
    this.closed = false;
    this.startedAt = Date.now();
    this.lastActivity = Date.now();
    this.turnCount = 0;
    this.totalCostUsd = 0;

    this.initInfo = null;                          // payload do evento 'init'
    this.effort = null;                            // null = padrão do modelo
    this.modelList = [];
    this.commandList = [];
    this.accountCache = null;
    this.pendingInteractions = new Map();          // id → {kind, payload, resolve}

    this._queue = [];          // mensagens já entregues ao gerador do SDK
    this._backlog = [];        // mensagens do usuário aguardando o turno atual
    this._wake = null;
    this._query = null;
    this._pumpPromise = null;
  }

  // ── entrada em streaming: gerador alimentado por fila ──
  // O epoch invalida geradores antigos quando a query é reiniciada (retry de
  // resume): um gerador de epoch anterior nunca consome a fila da nova query.
  async *_inputStream(epoch) {
    while (!this.closed && this._epoch === epoch) {
      while (this._queue.length > 0 && this._epoch === epoch) yield this._queue.shift();
      if (this.closed || this._epoch !== epoch) return;
      await new Promise((resolve) => { this._wake = resolve; });
    }
  }

  _pushInput(msg) {
    this._queue.push(msg);
    if (this._wake) { const w = this._wake; this._wake = null; w(); }
  }

  start() {
    if (this._query) return;
    this._startQuery();
  }

  // ── Qual executável do Claude Code esta sessão vai rodar ──────────────
  //
  // O DEFEITO QUE ISTO FECHA: até aqui, o NASCERA resolvia o CLI com todo o
  // cuidado (env → embarcado da plataforma → global no PATH) e depois NÃO
  // contava o resultado para a SDK. A SDK então resolvia por conta própria, a
  // partir do node_modules em que ELA está, aceitando o primeiro arquivo que
  // EXISTE — `existsSync` e nada mais: não pergunta se dá para executar (bit
  // +x, ACL herdada de outro usuário, download truncado), e não tem os degraus
  // de env e de PATH que este projeto tem. Num diretório copiado de outra
  // máquina isso vira o binário daquela máquina. O dono levou o NASCERA
  // empacotado para outro Mac e o chat morreu com uma mensagem da SDK falando
  // de "musl" e "libc" — vocabulário de Linux, num Mac. A resolução do NASCERA
  // valia para a tela de status e para o login, mas não para o trabalho de
  // verdade. (A mensagem enganosa é da SDK e sai para QUALQUER caminho nativo
  // que falhe ao spawnar; o que dá para fazer daqui é não deixar chegar lá um
  // caminho que este projeto já sabe que não serve.)
  //
  // SEM CACHE, de propósito: o `garantirMotor` do boot (e o botão de reparo do
  // painel) pode restaurar o binário embarcado DEPOIS deste módulo carregar. O
  // server.js precisa de `invalidarCmdDoMotor()` justamente porque congela o
  // caminho numa variável; aqui a sessão resolve na hora em que nasce, então um
  // reparo vale na próxima sessão sem reiniciar o processo. O custo é
  // desprezível: numa instalação sã, `binarioSync` é um require.resolve mais um
  // statSync — e ninguém abre sessão a cada segundo.
  //
  // QUANDO NÃO HÁ BINÁRIO, FALHAMOS — e esta é uma escolha, não um descuido.
  // A alternativa era deixar a SDK adivinhar (o comportamento de hoje). Só que
  // "o NASCERA não achou nada" e "a SDK acha alguma coisa" só divergem em UM
  // cenário: o arquivo existe mas foi REPROVADO por este projeto — truncado por
  // um npm que morreu no meio, sem permissão de execução depois de um zip, ou
  // de uma plataforma que não é esta. Ou seja: deixar passar aqui é escolher
  // justamente o binário errado, e o desfecho para quem está do outro lado da
  // tela é o do caso real — o turno começa, o processo morre segundos depois, e
  // a mensagem fala de libc em inglês no meio do chat. Falhar agora troca isso
  // por uma frase em português, no início da sessão, que diz o que fazer. O
  // preço é um caso exótico: plataforma que a SDK publica e o `motores` não
  // reconhece (Android/Termux — `sufixosDePlataforma` não trata 'android'). Aí
  // a saída documentada continua valendo: apontar CLAUDE_CMD para o executável.
  _executavelDoMotor() {
    if (this.pathToClaudeCodeExecutable) return this.pathToClaudeCodeExecutable;
    const caminho = this._motores.binarioSync('claude');
    if (!caminho) {
      const err = new Error(
        'Motor do Claude Code não encontrado nesta máquina (' + process.platform + '-' + process.arch + '). ' +
        'O NASCERA procurou na variável CLAUDE_CMD, no pacote embarcado em node_modules e no PATH. ' +
        'Rode `npm ci` na pasta do NASCERA, ou use o reparo do painel de Motores, ' +
        'ou aponte CLAUDE_CMD para o executável correto.');
      err.codigo = 'motor_ausente';   // o WS repassa este código para a UI
      throw err;
    }
    this.pathToClaudeCodeExecutable = caminho;
    return caminho;
  }

  // Monta as opções entregues à SDK. Separado de `_startQuery` porque é aqui
  // que mora o contrato com a SDK — e assim dá para conferi-lo num teste sem
  // subir processo nenhum.
  _montarOpcoes() {
    const env = { ...process.env, ...this.env };
    delete env.CLAUDECODE;          // evita erro de "nested session"
    delete env.CLAUDE_CODE_ENTRYPOINT;

    const options = {
      cwd: this.cwd,
      env,
      // O binário que o NASCERA resolveu — ver `_executavelDoMotor`. Sem esta
      // linha a SDK adivinha, e num node_modules copiado adivinha errado.
      pathToClaudeCodeExecutable: this._executavelDoMotor(),
      // Carrega settings/skills/CLAUDE.md do usuário e do projeto — é o que
      // deixa o Nascera "turbinado" (skill de templates, agents, CLAUDE.md).
      settingSources: this.settingSources,
      // MCP: só os servers passados explicitamente (mesma decisão do motor
      // antigo — MCPs globais do usuário só adicionam latência ao cold start).
      strictMcpConfig: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      includePartialMessages: true,
      permissionMode: sdkModeFor(this.mode),
      allowDangerouslySkipPermissions: true,   // permite alternar p/ bypass em runtime
      canUseTool: (toolName, input, meta) => this._onCanUseTool(toolName, input, meta),
      stderr: (data) => this.log('stderr: ' + String(data).slice(0, 400)),
    };
    if (this.model) options.model = this.model;
    if (this.initialEffort) options.effort = this.initialEffort;
    if (this.resumeSessionId) options.resume = this.resumeSessionId;
    // VPS: permite embrulhar o spawn (ex.: rodar como claude-runner via su).
    // Os dois convivem sem conflito, e é bom que convivam: a SDK usa o caminho
    // acima para MONTAR o comando e entrega esse comando pronto ao embrulho
    // (`o.command`) em vez de spawnar ela mesma. Ou seja, o cofre passa a
    // receber o binário que o NASCERA escolheu — inclusive para montar a pasta
    // dele dentro do bwrap, que é feito a partir de `o.command`.
    if (this._spawnWrapper) options.spawnClaudeCodeProcess = this._spawnWrapper;

    return options;
  }

  // ── A frase que custou uma tarde ──────────────────────────────────────
  //
  // A SDK devolve o MESMO texto sobre "musl" e "libc" para QUALQUER executável
  // nativo que falhe ao spawnar (`_xe` no sdk.mjs; basta o erro ter código
  // ENOENT/EACCES/EPERM/ENOTDIR/ELOOP/ENAMETOOLONG/EROFS). Num Mac isso é
  // simplesmente falso: não existe glibc nem musl ali, e o dono passou uma
  // tarde atrás de um problema de Linux que nunca existiu.
  //
  // Escolher o binário certo (acima) evita a maioria dos casos, mas NÃO todos:
  // o degrau `CLAUDE_CMD` do `motores` só confere que o caminho EXISTE, e entre
  // resolver e spawnar o arquivo pode perder o +x. Este é o último ponto por
  // onde o texto passa antes da tela — então é aqui que ele vira uma frase
  // verdadeira, em português, com o caminho real. O texto original vai junto,
  // entre colchetes: mensagem trocada em silêncio é outro jeito de mentir.
  _traduzirFalhaDoMotor(texto) {
    const t = String(texto == null ? '' : texto);
    // No Linux a explicação da SDK pode ser exatamente a verdade — não mexemos.
    if (process.platform === 'linux' || !/musl|libc/i.test(t)) return t;
    const cli = this.pathToClaudeCodeExecutable || '(não resolvido)';

    // Aqui a lista de palpites vira MEDIDA. `diagnosticarBinario` abre o
    // cabeçalho do arquivo (Mach-O/PE/ELF declaram a arquitetura nos primeiros
    // bytes), confere o bit +x e olha a quarentena do macOS — e devolve UMA
    // causa com o comando que a resolve. Sem isto, o texto abaixo listava três
    // possibilidades e não mencionava quarentena, que é a mais provável quando
    // a pasta chegou por zip ou AirDrop. Se o diagnóstico não souber responder,
    // caímos no texto genérico: palpite é melhor que silêncio, mentira não.
    let medido = '';
    try {
      const d = this._motores.diagnosticarBinario && this._motores.diagnosticarBinario('claude', { caminho: cli });
      if (d && !d.ok && d.resumo) medido = ' ' + d.resumo;
    } catch { /* diagnóstico é acessório: nunca pode engolir o erro original */ }

    return 'o executável do motor não pôde ser iniciado nesta máquina ('
      + process.platform + '-' + process.arch + '): ' + cli
      + '. A menção da SDK a musl/libc é de Linux e NÃO se aplica aqui.'
      + (medido || ' Confira se esse arquivo existe e tem permissão de execução (chmod +x); '
        + 'rode `npm ci` na pasta do NASCERA, use o reparo do painel de Motores, '
        + 'ou aponte CLAUDE_CMD para o executável correto.')
      + ' [texto da SDK: ' + t.slice(0, 300) + ']';
  }

  _startQuery() {
    const options = this._montarOpcoes();
    this.log('CLI do motor: ' + options.pathToClaudeCodeExecutable);

    this._epoch = (this._epoch || 0) + 1;
    const q = query({ prompt: this._inputStream(this._epoch), options });
    this._query = q;
    this._pumpPromise = this._pump(q).catch((err) => {
      if (this._query !== q) return;   // query antiga descartada num restart — ignora
      const errMsg = (err && err.message) || String(err);
      if (this._maybeRetryWithoutResume(errMsg)) return;
      this.log('pump error: ' + (err && err.stack || err));   // o log guarda o texto cru
      this.emit('error', { message: 'Motor falhou: ' + this._traduzirFalhaDoMotor(errMsg) });
      this._teardown('pump-error');
    });

    // Em streaming input, o system/init do stream só chega junto do primeiro
    // turno. Buscamos o resultado da inicialização proativamente para que a UI
    // tenha modelos/comandos/conta ANTES da primeira mensagem.
    this._query.initializationResult()
      .then((r) => {
        if (this.closed) return;
        this.modelList = (r.models || []).map(m => ({
          value: m.value, label: m.displayName, description: m.description || '',
          supportsEffort: !!m.supportsEffort,
          effortLevels: m.supportedEffortLevels || [],
        }));
        this.commandList = (r.commands || []).map(c => ({
          name: c.name, description: c.description || '', argumentHint: c.argumentHint || '',
        }));
        this.accountCache = r.account || null;
        if (!this.initInfo) {
          this.initInfo = {
            sessionId: this.sessionId,
            motor: 'claude',   // a UI usa isto para saber quais controles mostrar
            model: this.model || 'default',
            mode: this.mode,
            effort: this.effort || null,
            modes: NASCERA_MODES,
            tools: [],
            slashCommands: this.commandList.map(c => c.name),
            commands: this.commandList,
            skills: [],
            agents: (r.agents || []).map(a => a.name || a),
            version: null,
            models: this.modelList,
          };
          this.emit('init', this.initInfo);
        } else {
          this.initInfo.models = this.modelList;
          this.initInfo.commands = this.commandList;
          this.emit('models', { models: this.modelList });
          this.emit('commands', { commands: this.commandList });
        }
      })
      .catch((err) => this.log('initializationResult: ' + err.message));
  }

  // ── laço principal: consome mensagens do SDK e emite eventos normalizados ──
  async _pump(q) {
    for await (const msg of q) {
      if (this._query !== q) return;   // sessão foi reiniciada — abandona o laço antigo
      this.lastActivity = Date.now();
      try { this._handleMessage(msg); } catch (err) {
        this.log('handle error: ' + (err && err.stack || err));
      }
    }
    if (this._query === q) this._teardown('stream-ended');
  }

  // Resume de sessão inexistente/expirada NÃO pode matar o motor: reinicia a
  // query sem resume e reenvia a última mensagem pendente do usuário.
  _maybeRetryWithoutResume(errText) {
    if (this._resumeRetried || !this.resumeSessionId || this.closed) return false;
    if (!/No conversation found with session ID/i.test(errText || '')) return false;
    this._resumeRetried = true;
    this.log('resume falhou (' + this.resumeSessionId + ') — reiniciando sessão nova');
    this.resumeSessionId = null;
    this.sessionId = null;
    const old = this._query;
    this._query = null;
    try { if (old) old.close(); } catch {}
    // acorda o gerador antigo para ele encerrar; a fila é preservada
    if (this._wake) { const w = this._wake; this._wake = null; w(); }
    this._startQuery();
    if (this._lastUserContent && this._queue.length === 0) {
      this.send(this._lastUserContent);
    }
    this.emit('resume-recovered', {});
    return true;
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'system':
        this._handleSystem(msg);
        break;

      case 'stream_event': {
        if (msg.parent_tool_use_id) break;   // deltas de subagentes não vão pro chat
        const ev = msg.event;
        if (ev && ev.type === 'content_block_delta' && ev.delta) {
          if (ev.delta.type === 'text_delta' && ev.delta.text) {
            this.emit('delta', { text: ev.delta.text });
          } else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) {
            this.emit('thinking-delta', { text: ev.delta.thinking });
          }
        }
        break;
      }

      case 'assistant': {
        if (msg.session_id) this._setSessionId(msg.session_id);
        const content = msg.message && msg.message.content || [];
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            this.emit('text', { content: block.text, parentId: msg.parent_tool_use_id || null });
          } else if (block.type === 'thinking' && block.thinking) {
            this.emit('thinking', { content: block.thinking });
          } else if (block.type === 'tool_use') {
            this.emit('tool_use', {
              id: block.id,
              tool: block.name,
              input: block.input,
              parentId: msg.parent_tool_use_id || null,
              agent: msg.subagent_type || null,
            });
          }
        }
        break;
      }

      case 'user': {
        // tool_results voltam como mensagens 'user'
        const content = msg.message && msg.message.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          let text = '';
          if (typeof block.content === 'string') text = block.content;
          else if (Array.isArray(block.content)) {
            text = block.content.map(c => (typeof c === 'string' ? c : (c.text || ''))).join('\n');
          }
          this.emit('tool_result', {
            tool: block.tool_name || null,
            toolUseId: block.tool_use_id || null,
            content: text.slice(0, 2000),
            is_error: !!block.is_error,
            parentId: msg.parent_tool_use_id || null,
          });
        }
        break;
      }

      case 'tool_progress':
        // heartbeat de ferramenta longa — repassa como progresso leve
        this.emit('tool_progress', {
          description: (msg.tool_name || '') + ' em execução (' + Math.round(msg.elapsed_time_seconds || 0) + 's)',
          tool: msg.tool_name || '',
        });
        break;

      case 'result': {
        const resultErrText = Array.isArray(msg.errors) ? msg.errors.join(' ') : '';
        if (msg.is_error && this._maybeRetryWithoutResume(resultErrText)) return;
        this.running = false;
        this.turnCount = msg.num_turns || this.turnCount;
        if (typeof msg.total_cost_usd === 'number') this.totalCostUsd = msg.total_cost_usd;
        if (msg.session_id) this._setSessionId(msg.session_id);
        this.emit('result', {
          content: msg.subtype === 'success' ? (msg.result || '') : '',
          subtype: msg.subtype,
          isError: !!msg.is_error,
          errors: msg.errors || undefined,
          cost: msg.total_cost_usd,
          duration: msg.duration_ms,
          usage: msg.usage || null,
          modelUsage: msg.modelUsage || null,
          sessionId: msg.session_id || this.sessionId,
        });
        // Turno acabou: libera a próxima mensagem que o usuário enfileirou
        this._drainBacklog();
        break;
      }

      default:
        break;
    }
  }

  _handleSystem(msg) {
    switch (msg.subtype) {
      case 'init': {
        this._setSessionId(msg.session_id);
        this.initInfo = {
          sessionId: msg.session_id,
          motor: 'claude',   // a UI usa isto para escolher quais controles mostrar
          model: msg.model,
          mode: this.mode,
          effort: this.effort || null,
          modes: NASCERA_MODES,
          tools: msg.tools || [],
          slashCommands: msg.slash_commands || [],
          commands: this.commandList,
          skills: msg.skills || [],
          agents: msg.agents || [],
          version: msg.claude_code_version,
          models: this.modelList,
        };
        // Busca modelos e comandos (com descrição) sem bloquear o init
        this._query.supportedModels()
          .then((models) => {
            this.modelList = (models || []).map(m => ({
              value: m.value, label: m.displayName, description: m.description || '',
              supportsEffort: !!m.supportsEffort,
              effortLevels: m.supportedEffortLevels || [],
            }));
            if (this.initInfo) this.initInfo.models = this.modelList;
            this.emit('models', { models: this.modelList });
          })
          .catch(() => {});
        this._query.supportedCommands()
          .then((cmds) => {
            this.commandList = (cmds || []).map(c => ({
              name: c.name, description: c.description || '', argumentHint: c.argumentHint || '',
            }));
            if (this.initInfo) this.initInfo.commands = this.commandList;
            this.emit('commands', { commands: this.commandList });
          })
          .catch(() => {});
        this.emit('init', this.initInfo);
        break;
      }
      case 'status':
        if (msg.status) this.emit('status', { status: msg.status });
        if (msg.permissionMode) this._syncModeFromSdk(msg.permissionMode);
        break;
      case 'session_state_changed':
        this.emit('status', { status: msg.state });
        if (msg.state === 'idle') { this.running = false; this._drainBacklog(); }
        break;
      case 'compact_boundary':
        this.emit('compact', {
          trigger: msg.compact_metadata && msg.compact_metadata.trigger || 'auto',
          preTokens: msg.compact_metadata && msg.compact_metadata.pre_tokens,
          postTokens: msg.compact_metadata && msg.compact_metadata.post_tokens,
        });
        break;
      case 'task_progress':
        this.emit('tool_progress', {
          description: msg.summary || msg.description || '',
          tool: msg.last_tool_name || '',
        });
        break;
      case 'permission_denied':
        this.emit('tool_result', {
          tool: msg.tool_name, toolUseId: msg.tool_use_id,
          content: msg.message || 'Permissão negada', is_error: true, parentId: null,
        });
        break;
      default:
        break;
    }
  }

  _setSessionId(id) {
    if (id && id !== this.sessionId) {
      this.sessionId = id;
      this.emit('session-id', { sessionId: id });
    }
  }

  _syncModeFromSdk(sdkMode) {
    // Mantém o modo Nascera coerente quando o CLI muda sozinho (ex.: o modelo
    // chama EnterPlanMode, ou a saída do plan volta para default).
    const map = { default: this.mode === 'turbo' ? 'turbo' : 'ask', acceptEdits: 'edits', plan: 'plan', bypassPermissions: 'bypass' };
    const z = map[sdkMode];
    if (!z || z === this.mode) return;
    this.mode = z;
    this.emit('mode-changed', { mode: z });
  }

  // ── canUseTool: roteia para a UI e espera a resposta do usuário ──
  async _onCanUseTool(toolName, input, meta) {
    const id = meta.requestId || crypto.randomUUID();

    // Turbo: libera sem perguntar. Decidido aqui (e não por allow-rules na
    // camada de settings) para que a troca de modo valha na hora seguinte.
    if (this.mode === 'turbo' && !ALWAYS_INTERACTIVE.has(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }

    if (toolName === 'AskUserQuestion') {
      return this._waitInteraction(id, 'question', {
        id, questions: (input && input.questions) || [],
      }, meta.signal).then((answer) => {
        if (!answer || answer.cancelled) {
          return { behavior: 'deny', message: 'Usuário não respondeu às perguntas.', interrupt: !!(answer && answer.interrupt) };
        }
        return { behavior: 'allow', updatedInput: { ...input, answers: answer.answers || {} } };
      });
    }

    if (toolName === 'ExitPlanMode') {
      // O CLI atual entrega o plano em input.plan; planFilePath é o fallback
      // (e o caminho usado por builds que só gravam o plano em arquivo).
      let planText = (input && (input.plan || input.message)) || '';
      if (!planText && input && input.planFilePath) {
        try { planText = fs.readFileSync(input.planFilePath, 'utf8'); } catch {}
      }
      if (!planText) planText = meta.description || meta.title || '';
      return this._waitInteraction(id, 'plan', {
        id, plan: planText,
      }, meta.signal).then(async (answer) => {
        if (answer && answer.approve) {
          const nextMode = answer.mode === 'ask' ? 'ask' : (answer.mode || 'edits');
          // aprova o plano e já troca o modo para execução
          setTimeout(() => this.setMode(nextMode).catch(() => {}), 50);
          return { behavior: 'allow', updatedInput: input };
        }
        return { behavior: 'deny', message: (answer && answer.feedback) || 'Plano rejeitado pelo usuário. Ajuste o plano conforme o feedback.' };
      });
    }

    // Permissão comum → prompt na UI
    return this._waitInteraction(id, 'permission', {
      id,
      tool: toolName,
      input,
      title: meta.title || null,
      displayName: meta.displayName || null,
      description: meta.description || null,
      decisionReason: meta.decisionReason || null,
      suggestions: meta.suggestions || [],
    }, meta.signal).then((answer) => {
      if (answer && answer.behavior === 'allow') {
        const res = { behavior: 'allow', updatedInput: answer.updatedInput || input };
        if (answer.always && meta.suggestions && meta.suggestions.length) {
          res.updatedPermissions = meta.suggestions;
        }
        return res;
      }
      return {
        behavior: 'deny',
        message: (answer && answer.message) || 'Usuário negou a permissão.',
        interrupt: !!(answer && answer.interrupt),
      };
    });
  }

  _waitInteraction(id, kind, payload, signal) {
    return new Promise((resolve) => {
      // Deadline: se o usuário fechar a aba e nunca voltar, a interação não pode
      // segurar o subprocesso do Claude Code vivo para sempre.
      const timer = setTimeout(() => {
        if (this.pendingInteractions.delete(id)) {
          this.log('interação ' + kind + ' expirou após ' + (INTERACTION_TIMEOUT_MS / 60000) + 'min');
          this.emit('interaction-cancelled', { id });
          resolve({ cancelled: true, timedOut: true });
        }
      }, INTERACTION_TIMEOUT_MS);
      if (timer.unref) timer.unref();

      const settle = (value) => { clearTimeout(timer); resolve(value); };
      const entry = { id, kind, payload, resolve: settle, createdAt: Date.now() };
      this.pendingInteractions.set(id, entry);
      this.emit(kind === 'permission' ? 'permission_request' : kind, payload);
      if (signal) {
        signal.addEventListener('abort', () => {
          if (this.pendingInteractions.delete(id)) {
            this.emit('interaction-cancelled', { id });
            settle({ cancelled: true });
          }
        }, { once: true });
      }
    });
  }

  // Reemite interações pendentes (quando a UI reconecta)
  replayPending() {
    for (const entry of this.pendingInteractions.values()) {
      this.emit(entry.kind === 'permission' ? 'permission_request' : entry.kind, entry.payload);
    }
  }

  respondInteraction(id, answer) {
    const entry = this.pendingInteractions.get(id);
    if (!entry) return false;
    this.pendingInteractions.delete(id);
    entry.resolve(answer);
    return true;
  }

  // ── API pública ──

  // content: string OU array de blocos [{type:'text',text}, {type:'image',source:{...}}]
  //
  // Uma mensagem por vez: enquanto um turno roda, as próximas ficam numa fila
  // DO MOTOR (não do CLI). Assim o Stop consegue descartá-las — o CLI não expõe
  // API pública para cancelar o que já entrou na fila dele.
  send(content) {
    if (this.closed) throw new Error('Sessão encerrada');
    this.lastActivity = Date.now();
    if (this.running) {
      this._backlog.push(content);
      this.emit('queued', { queued: this._backlog.length });
      return;
    }
    this._dispatch(content);
  }

  _dispatch(content) {
    this.running = true;
    this._lastUserContent = content;
    this._pushInput({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    });
  }

  _drainBacklog() {
    if (this.closed || this.running || this._backlog.length === 0) return;

    // PORTÃO NA FILA — sem isto, os tetos de crédito valiam só para a
    // PRIMEIRA mensagem. O portão roda quando a mensagem chega; o débito só
    // acontece no `result`. Uma rajada de N mensagens (o WebSocket não passa
    // pelo rate-limit do Express) entrava toda antes do primeiro débito, lia
    // o mesmo saldo pré-débito, passava, e vinha parar aqui — onde era
    // despachada uma a uma sem ninguém perguntar de novo. Resultado: gasto
    // muito acima do limite de sessão/dia/semana/mês.
    //
    // `podeDespachar` é injetado pelo servidor (quem conhece o billing). Sem
    // ele, o comportamento é o de antes — o motor não decide sobre dinheiro.
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

    this._dispatch(this._backlog.shift());
  }

  async interrupt() {
    if (!this._query) return;
    // Stop = parar TUDO. Descarta o que ainda não foi entregue ao CLI (senão
    // iniciaria um turno "fantasma" logo após o Stop) e cancela as interações
    // pendentes para não deixar a UI travada.
    this._queue.length = 0;
    this._backlog.length = 0;
    for (const [id, entry] of this.pendingInteractions) {
      this.pendingInteractions.delete(id);
      this.emit('interaction-cancelled', { id });
      entry.resolve({ cancelled: true });
    }
    try {
      await this._query.interrupt();
    } catch (err) {
      this.log('interrupt: ' + err.message);
    }
    this.running = false;
  }

  async setModel(model) {
    if (!this._query) return;
    await this._query.setModel(model || undefined);
    this.model = model || null;
    this.emit('model-changed', { model: this.model });
  }

  async setMode(nasceraMode) {
    if (!this._query || !NASCERA_MODES.includes(nasceraMode)) return;
    const prev = this.mode;
    this.mode = nasceraMode;
    try {
      await this._query.setPermissionMode(sdkModeFor(nasceraMode));
      this.emit('mode-changed', { mode: nasceraMode });
    } catch (err) {
      this.mode = prev;
      this.emit('error', { message: 'Falha ao trocar modo: ' + err.message });
    }
  }

  async setEffort(level) {
    if (!this._query) return;
    await this._query.applyFlagSettings({ effortLevel: level || null });
    this.effort = level || null;
    this.emit('effort-changed', { effort: this.effort });
  }

  async contextUsage() {
    if (!this._query) return null;
    try { return await this._query.getContextUsage(); } catch { return null; }
  }

  async accountInfo() {
    if (!this._query) return this.accountCache;
    try { return await this._query.accountInfo(); } catch { return this.accountCache; }
  }

  // /compact não gera 'result' — envia direto, sem marcar turno em andamento
  compact() {
    if (this.closed) return;
    this.lastActivity = Date.now();
    this._pushInput({
      type: 'user',
      message: { role: 'user', content: '/compact' },
      parent_tool_use_id: null,
    });
  }

  status() {
    return {
      key: this.key,
      sessionId: this.sessionId,
      running: this.running,
      mode: this.mode,
      model: this.model,
      turnCount: this.turnCount,
      totalCostUsd: this.totalCostUsd,
      pendingInteractions: this.pendingInteractions.size,
      uptimeMs: Date.now() - this.startedAt,
      idleMs: Date.now() - this.lastActivity,
    };
  }

  _teardown(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pendingInteractions) entry.resolve({ cancelled: true });
    this.pendingInteractions.clear();
    if (this._wake) { const w = this._wake; this._wake = null; w(); }
    this.emit('closed', { reason });
    this.removeAllListeners();
  }

  close(reason = 'manual') {
    if (this.closed) return;
    try { if (this._query) this._query.close(); } catch {}
    this._teardown(reason);
  }
}

// ───────────────────────────────────────────────────────────────────────
// SessionManager — uma sessão viva por chave (projeto/usuário), com timeout
// de inatividade. Sessões fechadas são retomadas depois via `resume`.
// ───────────────────────────────────────────────────────────────────────
const IDLE_TIMEOUT_MS = 45 * 60 * 1000;   // 45 min sem atividade → libera o processo
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const PENDING_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;  // teto absoluto p/ sessão travada em prompt

// Deadline de uma interação (permissão/pergunta/plano) sem resposta do usuário.
// Generoso: o usuário pode sair para tomar um café — mas não é infinito.
const INTERACTION_TIMEOUT_MS = 30 * 60 * 1000;

// ─── Controle de admissão ────────────────────────────────────────────
// Cada sessão viva é um processo `claude`/`codex` residente consumindo RAM.
// Sem teto, N usuários simultâneos derrubam a máquina por OOM — e quando o
// processo morre, morre para TODOS, não só para quem abusou.
//
// O teto global é derivado da memória da máquina (~400 MB por sessão, medido
// no uso real), com piso de 2 e teto de 24. O teto por usuário impede que uma
// única conta ocupe todos os lugares.
import os from 'node:os';
const MAX_SESSOES_GLOBAL = parseInt(process.env.NASCERA_MAX_SESSOES || '0', 10)
  || Math.max(2, Math.min(24, Math.floor(os.totalmem() / (400 * 1024 * 1024))));
const MAX_SESSOES_POR_USUARIO = parseInt(process.env.NASCERA_MAX_SESSOES_USUARIO || '3', 10);

// Motor → classe de sessão. Claude fica de fora (é o padrão, ver `obtain`)
// porque é o único que não roda por cima deste dispatch — ele É a sessão
// viva deste arquivo.
const CONSTRUTORES_DE_MOTOR = { codex: CodexSession, opencode: OpenCodeSession };

export class SessionManager {
  constructor() {
    this.sessions = new Map();
    this._sweeper = setInterval(() => this._sweep(), SWEEP_INTERVAL_MS);
    this._sweeper.unref && this._sweeper.unref();
  }

  get(key) { return this.sessions.get(key) || null; }

  // Quantas sessões vivas e de quem. `dono` vem em opts para o teto por conta.
  contar(dono) {
    let total = 0, doUsuario = 0;
    for (const s of this.sessions.values()) {
      if (s.closed) continue;
      total++;
      if (dono && s.dono === dono) doUsuario++;
    }
    return { total, doUsuario };
  }

  limites() {
    return { global: MAX_SESSOES_GLOBAL, porUsuario: MAX_SESSOES_POR_USUARIO };
  }

  // Diz se cabe mais uma sessão. Devolve o motivo quando não cabe, para a UI
  // dizer a verdade ("o servidor está cheio") em vez de um erro genérico.
  podeAbrir(dono) {
    const { total, doUsuario } = this.contar(dono);
    if (doUsuario >= MAX_SESSOES_POR_USUARIO) {
      return { ok: false, motivo: 'Você já tem ' + doUsuario + ' projetos abertos com IA. ' +
                                  'Feche um para começar outro.', codigo: 'limite_usuario' };
    }
    if (total >= MAX_SESSOES_GLOBAL) {
      return { ok: false, motivo: 'O servidor está no limite de sessões simultâneas. ' +
                                  'Tente de novo em alguns minutos.', codigo: 'limite_global' };
    }
    return { ok: true };
  }

  // Cria (ou retorna) a sessão viva para a chave.
  // `opts.motor` escolhe qual motor atende: 'claude' (padrão, se ausente ou
  // desconhecido), 'codex' ou 'opencode' — ver CONSTRUTORES_DE_MOTOR. Todos
  // expõem a mesma superfície, então daqui para cima nada no NASCERA precisa
  // saber a diferença.
  obtain(key, opts) {
    let s = this.sessions.get(key);
    if (s && !s.closed) return s;

    // Portão de admissão ANTES de spawnar. Reaproveitar sessão existente não
    // passa por aqui — só a criação de uma NOVA consome um lugar.
    const dono = (opts && opts.dono) || null;
    const veredito = this.podeAbrir(dono);
    if (!veredito.ok) {
      const err = new Error(veredito.motivo);
      err.codigo = veredito.codigo;
      err.limiteAtingido = true;
      throw err;
    }

    const Ctor = (opts && CONSTRUTORES_DE_MOTOR[opts.motor]) || ClaudeSession;
    s = new Ctor({ ...opts, key });
    s.dono = dono;   // usado pelo teto por usuário
    this.sessions.set(key, s);
    s.on('closed', () => { if (this.sessions.get(key) === s) this.sessions.delete(key); });
    // `start()` pode falhar ANTES do primeiro turno — hoje, quando não existe
    // um CLI do motor utilizável nesta máquina. Sem tirar a sessão do mapa, ela
    // ficaria lá com `closed: false` e a próxima conexão a reaproveitaria: o
    // chat aceitaria mensagens que ninguém consome, e o erro — que já tinha
    // aparecido uma vez — nunca mais apareceria. Trocar erro visível por
    // silêncio é o pior desfecho possível; o erro sobe para quem chamou.
    try {
      s.start();
    } catch (err) {
      this.sessions.delete(key);
      try { s.close('start-failed'); } catch {}
      throw err;
    }
    return s;
  }

  _sweep() {
    for (const [key, s] of this.sessions) {
      if (s.closed) { this.sessions.delete(key); continue; }
      // Sessão presa num prompt sem ninguém para responder: o deadline da
      // interação resolve o caso normal; este é o teto absoluto.
      if (s.pendingInteractions.size > 0) {
        if (Date.now() - s.lastActivity > PENDING_IDLE_TIMEOUT_MS) {
          s.close('pending-timeout');
          this.sessions.delete(key);
        }
        continue;
      }
      if (s.running) continue;   // turno em andamento nunca é derrubado
      if (Date.now() - s.lastActivity > IDLE_TIMEOUT_MS) {
        s.close('idle-timeout');
        this.sessions.delete(key);
      }
    }
  }

  closeAll() {
    for (const [, s] of this.sessions) { try { s.close('shutdown'); } catch {} }
    this.sessions.clear();
  }
}

export const sessionManager = new SessionManager();
