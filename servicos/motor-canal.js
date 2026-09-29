// ═══════════════════════════════════════════════════════════════════════
// NASCERA — canal do motor: bindChannel (S4-2: extraído do server.js)
//
// Liga UMA vez os ~25 eventos de uma sessão viva do motor ao broadcast do WS +
// persistência (chat-history, thumbnail) + o DÉBITO de crédito no evento result
// (cost/modelUsage do turno). Fábrica criar(deps) que fecha sobre o estado do
// server (o Map channels, billing, loadProjects/saveProjects, autoCommitAsync,
// generateProjectScreenshot). Exercido de ponta a ponta pelo test:fake — um
// turno inteiro (init→tool_use→tool_result→text→result→done) passa por aqui.
// ═══════════════════════════════════════════════════════════════════════
const crypto = require('crypto');
const logger = require('../log.js');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');

function criar(deps) {
  const {
    channels, appendChatMessage, loadProjects, saveProjects, billing,
    autoCommitAsync, atualizarProjeto, getCurrentVersion, generateProjectScreenshot,
    getEngine, sessionKeyFor, isDesktopLocal, escreverFerramentaDeImagem, memoriaProjeto,
    PROJECTS_BASE, normalizeBuildLevel, loadNasceraConfig, modelosLocais, motores, vpsSpawnWrapper, BUILD_LEVELS,
    credencialIaPropria, email, loadUsers, segredos, writeCavemanSkill, planejamentoAutomatico, motor2,
  } = deps;

  // A.1 (Fase 2 — classificador de operação): acumula, por turno, os
  // arquivos tocados por ferramentas de escrita/edição, no formato que
  // servicos/classificador-operacao.js espera — sem git diff, só o que já
  // flui nos eventos `tool_use`. Map (não Set): um mesmo caminho tocado 2x
  // no turno fica com o registro da ÚLTIMA edição, contando 1 vez só na
  // soma (decisão fechada da spec A.1).
  function registrarArquivoTocado(ch, tu) {
    const caminho = tu.input && tu.input.file_path;
    if (!caminho) return;
    ch._arquivosTocados = ch._arquivosTocados || new Map();
    if (tu.tool === 'Write') {
      const content = String((tu.input && tu.input.content) || '');
      ch._arquivosTocados.set(caminho, { caminho, tool: 'Write', conteudo: content, tamanhoAntes: 0, tamanhoDepois: content.length });
    } else if (tu.tool === 'Edit') {
      const antes = String((tu.input && tu.input.old_string) || '');
      const depois = String((tu.input && tu.input.new_string) || '');
      ch._arquivosTocados.set(caminho, { caminho, tool: 'Edit', conteudo: depois, tamanhoAntes: antes.length, tamanhoDepois: depois.length });
    } else if (tu.tool === 'MultiEdit') {
      const edits = Array.isArray(tu.input && tu.input.edits) ? tu.input.edits : [];
      let antes = 0, depois = 0, conteudo = '';
      for (const e of edits) {
        antes += String((e && e.old_string) || '').length;
        const novo = String((e && e.new_string) || '');
        depois += novo.length;
        conteudo += novo;
      }
      ch._arquivosTocados.set(caminho, { caminho, tool: 'MultiEdit', conteudo, tamanhoAntes: antes, tamanhoDepois: depois });
    } else if (tu.tool === 'NotebookEdit') {
      const novo = String((tu.input && (tu.input.new_source || tu.input.new_string)) || '');
      ch._arquivosTocados.set(caminho, { caminho, tool: 'NotebookEdit', conteudo: novo, tamanhoAntes: 0, tamanhoDepois: novo.length });
    }
  }

  function bindChannel(ch) {
    const { session, projectId } = ch;

    const bcast = (data) => {
      const json = JSON.stringify(data);
      for (const ws of ch.sockets) {
        if (ws.readyState === WebSocket.OPEN) { try { ws.send(json); } catch {} }
      }
    };
    ch.bcast = bcast;

    // Prévia progressiva: recarrega o iframe enquanto o Claude ainda trabalha
    let previewTimer = null;
    const schedulePreviewRefresh = () => {
      if (previewTimer) return;
      previewTimer = setTimeout(() => { previewTimer = null; bcast({ type: 'preview-refresh' }); }, 2500);
    };

    session.on('init', (info) => bcast({ type: 'init', ...info }));
    session.on('models', (m) => bcast({ type: 'models', ...m }));
    session.on('commands', (c) => bcast({ type: 'commands', ...c }));

    // Streaming token a token → evento legado 'text' (o front concatena)
    session.on('delta', (d) => bcast({ type: 'text', content: d.text }));
    session.on('thinking-delta', (d) => bcast({ type: 'thinking_delta', content: d.text }));

    // Bloco de texto completo → só persistência (a UI já recebeu via deltas)
    session.on('text', (t) => {
      if (projectId && !t.parentId && t.content && t.content.trim()) {
        appendChatMessage(projectId, { role: 'assistant', content: t.content, timestamp: Date.now() });
      }
    });

    session.on('tool_use', (tu) => {
      bcast({ type: 'tool_use', tool: tu.tool, input: tu.input, agent: tu.agent || undefined });
      if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tu.tool)) {
        schedulePreviewRefresh();
        registrarArquivoTocado(ch, tu);
      }
      if (projectId && !tu.parentId) {
        appendChatMessage(projectId, { role: 'tool', tool: tu.tool, input: tu.input, timestamp: Date.now() });
      }
    });

    session.on('tool_result', (tr) => {
      bcast({ type: 'tool_result', tool: tr.tool || 'unknown', content: tr.content, is_error: tr.is_error });
      if (projectId && !tr.parentId) {
        appendChatMessage(projectId, { role: 'tool_result', content: (tr.content || '').substring(0, 300), is_error: tr.is_error, timestamp: Date.now() });
      }
    });

    session.on('tool_progress', (tp) => bcast({ type: 'tool_progress', description: tp.description, tool: tp.tool }));
    session.on('queued', (q) => bcast({ type: 'queued', queued: q.queued }));

    // Interações que esperam resposta do usuário
    session.on('permission_request', (p) => bcast({ type: 'permission_request', ...p }));
    session.on('question', (q) => bcast({ type: 'question', ...q }));
    session.on('plan', (p) => bcast({ type: 'plan', ...p }));
    session.on('interaction-cancelled', (i) => bcast({ type: 'interaction_cancelled', id: i.id }));

    session.on('status', (s) => bcast({ type: 'engine_status', status: s.status }));
    session.on('compact', (c) => bcast({ type: 'compact', trigger: c.trigger, preTokens: c.preTokens, postTokens: c.postTokens }));
    session.on('model-changed', (m) => {
      bcast({ type: 'model_changed', model: m.model });
      if (projectId) {
        const projects = loadProjects();
        const proj = projects.find(p => p.id === projectId);
        if (proj) { proj.claudeModel = m.model; saveProjects(projects); }
      }
    });
    session.on('effort-changed', (e) => {
      bcast({ type: 'effort_changed', effort: e.effort });
      if (projectId) {
        const projects = loadProjects();
        const proj = projects.find(p => p.id === projectId);
        if (proj) { proj.claudeEffort = e.effort; saveProjects(projects); }
      }
    });
    session.on('mode-changed', (m) => {
      bcast({ type: 'mode_changed', mode: m.mode });
      if (projectId) {
        const projects = loadProjects();
        const proj = projects.find(p => p.id === projectId);
        if (proj) { proj.claudeMode = m.mode; saveProjects(projects); }
      }
    });

    session.on('session-id', (s) => {
      if (!projectId) return;
      const projects = loadProjects();
      const proj = projects.find(p => p.id === projectId);
      if (proj && proj.sessionId !== s.sessionId) { proj.sessionId = s.sessionId; saveProjects(projects); }
    });

    // Fim de turno: commit, screenshot, e 'done' para a UI carregar a prévia
    session.on('result', (r) => {
      // A.2/A.3 (Fase 2): consome a lista do turno que está terminando e já
      // deixa o mapa vazio pro próximo — turnos são serializados por sessão
      // (a fila em ch._turnQueue garante um `result` por vez), então zerar
      // aqui É "zerar a cada novo turno iniciado" sem precisar de outro gancho.
      const arquivosTocadosDoTurno = Array.from((ch._arquivosTocados || new Map()).values());
      ch._arquivosTocados = new Map();

      // Delta de custo do turno (o total_cost_usd do SDK é cumulativo por sessão)
      let turnCostUsd = 0;
      if (typeof r.cost === 'number') {
        turnCostUsd = Math.max(0, r.cost - (ch._lastCost || 0));
        ch._lastCost = r.cost;
      }
      // Delta de tokens POR MODELO (modelUsage também é cumulativo por sessão) —
      // é o que permite precificar cada modelo pelo seu custo + markup.
      let modelDeltas = null;
      if (r.modelUsage && typeof r.modelUsage === 'object') {
        const last = ch._lastModelUsage || {};
        modelDeltas = {};
        for (const [mid, u] of Object.entries(r.modelUsage)) {
          const l = last[mid] || {};
          const d = {
            inputTokens: Math.max(0, (u.inputTokens || 0) - (l.inputTokens || 0)),
            outputTokens: Math.max(0, (u.outputTokens || 0) - (l.outputTokens || 0)),
            cacheReadInputTokens: Math.max(0, (u.cacheReadInputTokens || 0) - (l.cacheReadInputTokens || 0)),
            cacheCreationInputTokens: Math.max(0, (u.cacheCreationInputTokens || 0) - (l.cacheCreationInputTokens || 0)),
            costUSD: Math.max(0, (u.costUSD || 0) - (l.costUSD || 0)),
          };
          if (d.inputTokens || d.outputTokens || d.cacheReadInputTokens || d.cacheCreationInputTokens || d.costUSD) {
            modelDeltas[mid] = d;
          }
        }
        ch._lastModelUsage = r.modelUsage;
        if (!Object.keys(modelDeltas).length) modelDeltas = null;
      }
      // ── DÉBITO de créditos: o NASCERA é o gateway — o dinheiro já saiu, agora
      // cobra de quem mandou ESTE turno. O carimbo sai da FILA (um por result,
      // na ordem) — cada turno tem seu pagador, seu turnId e sua isenção.
      const stamp = (ch._turnQueue && ch._turnQueue.shift())
        || { id: crypto.randomUUID(), user: ch._turnUser, exempt: !!ch._turnExempt };
      let creditEvent = null;
      if (ch.motor2Ativo && stamp.user) {
        // Motor 2 nunca debita crédito (doc §7/§8) — registra o uso pra
        // franquia diária e auditoria em vez de chamar billing.debitTurn.
        // Isto NÃO depende do motor por baixo omitir custo/tokens no evento
        // 'result' (hoje o OpenCode omite; amanhã pode não omitir mais) —
        // a isenção é uma decisão explícita daqui, não um acaso de telemetria.
        try { motor2 && motor2.registrarUso(stamp.user, projectId, stamp.id || null); }
        catch (err) { logger.error('[motor2] registrar uso falhou:', err.message); }
      } else if ((turnCostUsd > 0 || modelDeltas) && stamp.user && !stamp.exempt) {
        try {
          const deb = billing.debitTurn(stamp.user, { costUsd: turnCostUsd, modelDeltas }, stamp.id || null);
          if (deb && deb.applicable && !deb.duplicate) {
            creditEvent = {
              type: 'credits',
              user: stamp.user,   // o front ignora eventos que não são dele
              availableMilli: deb.summary.availableMilli,
              debitedMilli: deb.costMilli,
              mode: deb.summary.mode,
              weekUsedPct: deb.summary.week ? deb.summary.week.usedPct : null,
              weekEnd: deb.summary.week ? deb.summary.week.weekEnd : null,
              sessionUsedPct: deb.summary.session ? deb.summary.session.usedPct : null,
              sessionResetsAt: deb.summary.session ? deb.summary.session.resetsAt : null,
            };
            // A1/A0.4: cruzou 80% da semana → e-mail de aviso, no máximo 1 a
            // cada 6 dias (a janela reinicia na segunda). O banner do app cobre
            // quem está online; o e-mail alcança quem fechou a aba.
            if (email && deb.summary.week && deb.summary.week.usedPct >= 80) {
              try {
                const u = (loadUsers && loadUsers()[stamp.user]) || null;
                if (u && u.email) {
                  email.enviarEventoUnico('credito-80', u.email, {
                    nome: u.name || stamp.user,
                    pct: Math.min(100, Math.round(deb.summary.week.usedPct)),
                    link: (((loadNasceraConfig().email || {}).urlBase) || '') + '/comprar.html',
                  }, 6);
                }
              } catch {}
            }
          }
        } catch (err) {
          logger.error('[billing] débito falhou:', err.message);
        }
      }

      // ORDEM IMPORTA: o débito acontece antes de anunciar o fim, e 'done' é
      // sempre o ÚLTIMO evento do turno. Assim ninguém vê "terminou" com o
      // saldo velho — nem um cliente que feche a conexão ao receber 'done'.
      // cost = custo DESTE turno (a linha da UI é por turno); totalCost = acumulado.
      bcast({ type: 'result', content: r.content, cost: turnCostUsd, totalCost: r.cost, duration: r.duration, usage: r.usage, session_id: r.sessionId, subtype: r.subtype });
      if (creditEvent) bcast(creditEvent);
      if (r.isError && r.errors && r.errors.length) {
        bcast({ type: 'error', data: String(r.errors[0]).substring(0, 500) });
      }
      bcast({ type: 'done', code: r.isError ? 1 : 0 });

      if (!projectId) return;
      const projects = loadProjects();
      const proj = projects.find(p => p.id === projectId);
      if (!proj) return;
      if (turnCostUsd > 0) {
        proj.costUsd = Math.round(((proj.costUsd || 0) + turnCostUsd) * 10000) / 10000;
      }
      if (proj.path) {
        // S2-2: git fora do caminho quente. A versão é relida e persistida na
        // continuação, depois do commit landar — não bloqueia o fim do turno.
        const _pp = proj.path, _pid = proj.id;
        autoCommitAsync(_pp, 'AI: alteracao automatica').then(() => {
          atualizarProjeto(_pid, { currentVersion: getCurrentVersion(_pp) });
        });
      }
      // Só o Claude tem sessionId retomável por aqui (Codex/OpenCode usam o
      // próprio conceito de sessão, resolvido dentro do motor). Sem essa
      // guarda, um canal que passasse por outro motor no meio da conversa
      // (ex.: pipeline de planejamento) sobrescreveria proj.sessionId com um
      // id que o Claude não entende, e a próxima sessão dele nasceria
      // tentando retomar uma sessão inexistente.
      if (r.sessionId && ch.motor === 'claude') proj.sessionId = r.sessionId;
      saveProjects(projects);
      if (proj.slug) {
        generateProjectScreenshot(proj).then(url => {
          if (url) {
            const ps = loadProjects();
            const p2 = ps.find(p => p.id === projectId);
            if (p2) { p2.thumbnail = url; saveProjects(ps); }
            bcast({ type: 'thumbnail-updated', thumbnail: url });
          }
        }).catch(() => {});
      }
    });

    session.on('error', (e) => bcast({ type: 'error', data: e.message }));
    session.on('closed', () => {
      bcast({ type: 'engine_closed' });
      if (channels.get(ch.key) === ch) channels.delete(ch.key);
    });
  }

  async function ensureChannel(projectId, user) {
    const { sessionManager } = await getEngine();
    const key = sessionKeyFor(projectId, user);
    let ch = channels.get(key);
    if (ch && !ch.session.closed) return ch;

    // Config do projeto: cwd, sessão a retomar, modelo/modo preferidos
    let cwd = isDesktopLocal ? (process.env.HOME || os.homedir()) : '/root';
    let resumeSessionId = null, model = null, mode = null, buildLevel = 3, effortPref = null;
    if (projectId) {
      const projects = loadProjects();
      const proj = projects.find(p => p.id === projectId);
      if (proj) {
        try { escreverFerramentaDeImagem(proj); } catch {}
        // Instrução de imagens vai junto: sem ela o agente ignora a ferramenta.
        try { if (proj.path) memoriaProjeto.escreverArquivos(proj.path); } catch {}
        // Skill Caveman: idempotente, também cura projetos já existentes sem migração.
        try { if (proj.path && writeCavemanSkill) writeCavemanSkill(proj.path); } catch {}
        try { if (proj.path) memoriaProjeto.escreverCaveman(proj.path); } catch {}
        // Projeto sem pasta (ex.: criado sem createNew): cria agora — o Claude
        // NUNCA deve trabalhar solto no HOME por engano.
        if (!proj.path && proj.slug) {
          try {
            const p = path.join(PROJECTS_BASE, proj.slug);
            fs.mkdirSync(p, { recursive: true });
            proj.path = p;
            saveProjects(projects);
          } catch {}
        }
        if (proj.path) {
          try { fs.mkdirSync(proj.path, { recursive: true }); } catch {}
          cwd = proj.path;
        }
        if (proj.sessionId) resumeSessionId = proj.sessionId;
        if (proj.claudeModel) model = proj.claudeModel;
        if (proj.claudeMode) mode = proj.claudeMode;
        buildLevel = normalizeBuildLevel(proj.buildLevel);
        if (proj.claudeEffort) effortPref = proj.claudeEffort;
      }
    }
    // Modelo padrão de build definido no painel admin (o projeto pode sobrepor)
    if (!model) {
      const adminDefault = loadNasceraConfig().defaultBuildModel;
      if (adminDefault) model = adminDefault;
    }

    // Modelo local: o motor é o mesmo Claude Code, só que apontado para o
    // Ollama, que fala a API de Mensagens da Anthropic. Se um modelo local
    // estiver escolhido no painel, ele manda — e o turno não custa crédito,
    // porque quem paga a conta é a máquina do cliente.
    let envDoMotor = {};
    const modeloLocal = loadNasceraConfig().modeloLocal;
    if (modeloLocal) {
      envDoMotor = modelosLocais.ambienteParaMotor(modeloLocal);
      model = modeloLocal;
      logger.info('[engine] modelo local em uso: ' + modeloLocal);
    }

    // Qual motor atende esta sessão. A escolha do PROJETO manda; sem ela,
    // vale o padrão da instalação. É isso que permite trocar de motor no meio
    // de um projeto sem mexer na configuração de todo mundo.
    let motorEscolhido = motores.ehValido(loadNasceraConfig().motor) ? loadNasceraConfig().motor : 'claude';
    if (projectId) {
      const p = loadProjects().find(x => x.id === projectId);
      if (p && motores.ehValido(p.motor)) motorEscolhido = p.motor;
    }

    // Pipeline de planejamento automático: enquanto o projeto está na fase de
    // planejamento (servicos/planejamento-automatico.js), o motor da vez é
    // sempre o OpenCode gratuito, por cima de qualquer escolha acima — nunca
    // herda o modelo pago configurado para o build, e nunca retoma uma
    // sessão do Claude (o `resumeSessionId` seria de outro motor).
    let promptPrefixoDoMotor = null;
    if (projectId && planejamentoAutomatico && planejamentoAutomatico.motorTemporario(projectId)) {
      motorEscolhido = planejamentoAutomatico.motorTemporario(projectId);
      model = planejamentoAutomatico.modeloTemporario(projectId);
      promptPrefixoDoMotor = planejamentoAutomatico.promptPrefixoTemporario(projectId);
      resumeSessionId = null;
    }

    // O dono da sessão alimenta o teto por usuário no controle de admissão.
    const donoDaSessao = (() => {
      try {
        if (!projectId) return null;
        const p = loadProjects().find(x => x.id === projectId);
        return (p && p.owner) || null;
      } catch { return null; }
    })();

    // Motor 2 (doc §7/§8): por cima da escolha normal quando `user` (quem
    // paga o turno — mesmo alvo que motor-ws.js usa pra debitar, não
    // necessariamente o dono do projeto) está na zona protegida e ainda tem
    // franquia diária. NUNCA por cima do pipeline de planejamento (bloco
    // acima já teria assumido `motorEscolhido` se fosse o caso — a guarda
    // `motorEscolhido === 'claude'` também respeita motor forçado por
    // admin/projeto, mesma lógica do pipeline). Sigilo (doc §10): o motor
    // real nunca aparece pro cliente, só o rótulo "Motor 2" na UI.
    let motor2Ativo = false;
    if (motorEscolhido === 'claude' && motor2 && user) {
      try { motor2Ativo = motor2.deveAssumir(user); } catch { motor2Ativo = false; }
      if (motor2Ativo) {
        motorEscolhido = motor2.MOTOR_INTERNO;
        model = motor2.MODELO_INTERNO;
        resumeSessionId = null;
      }
    }

    // AD.1 (IA própria): se o admin liberou E o dono conectou a própria chave,
    // a sessão nasce com a credencial DELE no env — o token sai da conta do
    // usuário, não do admin. Só no motor claude (o codex não fala essa chave).
    // ch.iaPropria marca a credencial REAL da sessão: é o que isenta o débito.
    let iaPropriaAtiva = false;
    if (motorEscolhido === 'claude' && typeof credencialIaPropria === 'function') {
      const cred = credencialIaPropria(donoDaSessao || user);
      if (cred) {
        envDoMotor = { ...envDoMotor, [cred.envVar]: cred.valor };
        iaPropriaAtiva = true;
      }
    }

    // DeepSeek dentro do OpenCode: chave de NÍVEL DE INSTALAÇÃO (o admin cola
    // uma vez, ver rotas/admin-motores.js), não BYOK por usuário. O
    // opencode.json global só referencia o NOME da env var — quem entrega o
    // valor de verdade é aqui, igual ao padrão do "modelo local" acima.
    if (motorEscolhido === 'opencode' && segredos) {
      const chaveDeepSeek = segredos.obter('motor:opencode:deepseek');
      if (chaveDeepSeek) envDoMotor = { ...envDoMotor, DEEPSEEK_API_KEY: chaveDeepSeek };
    }

    // ONDE FICA A ESCOLHA DO BINÁRIO DO MOTOR — e por que NÃO é aqui.
    //
    // Esta função monta as opções da sessão, mas não resolve o executável do
    // CLI: quem faz isso é o próprio motor (engine/claude-engine.mjs), na hora
    // em que a sessão nasce, chamando `motores.binarioSync('claude')` — a mesma
    // fonte que a tela de status e o login usam. A razão de não resolver aqui é
    // que este NÃO é o único lugar onde nasce sessão: rotas/tools.js cria uma
    // `ClaudeSession` direto para a extração de design system. Resolver no canal
    // consertaria o chat e deixaria a ferramenta com o defeito antigo — duas
    // respostas para a mesma pergunta, que é como o furo apareceu em primeiro
    // lugar (o `motores` sabia o caminho certo e o motor não perguntava).
    //
    // Consequência prática: quando não existe CLI utilizável, `obtain` estoura
    // aqui mesmo, e o `.catch` do WebSocket mostra "Falha ao iniciar o motor:
    // …" com a explicação em português — em vez de o turno começar e morrer
    // segundos depois com um texto da SDK sobre musl/libc.
    const session = sessionManager.obtain(key, {
      cwd, resumeSessionId, model, mode: mode || 'turbo',
      motor: motorEscolhido,
      dono: donoDaSessao,
      env: envDoMotor,
      promptPrefixo: promptPrefixoDoMotor,
      spawnClaudeCodeProcess: vpsSpawnWrapper(cwd),
      log: (m) => logger.info('[engine ' + key.slice(0, 12) + '] ' + m),
    });

    // Esforço de raciocínio: a escolha manual do usuário (botão no chat) tem
    // precedência; sem ela, deriva do nível de detalhe escolhido na criação.
    const applyEffort = () => {
      session.setEffort(effortPref || BUILD_LEVELS[buildLevel].effort).catch(() => {});
    };
    if (session.initInfo) applyEffort(); else session.once('init', applyEffort);

    ch = { key, projectId, session, sockets: new Set(), buildLevel, iaPropria: iaPropriaAtiva, motor: motorEscolhido, motor2Ativo };
    channels.set(key, ch);
    bindChannel(ch);
    return ch;
  }

  return { bindChannel, ensureChannel };
}

module.exports = { criar };
