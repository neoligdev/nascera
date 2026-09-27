// ═══════════════════════════════════════════════════════════════════════
// NASCERA — WebSocket do motor: /ws (S4-2: extraído do server.js)
//
// O handler de conexão do chat de IA — o coração do produto. Por conexão:
// verifica o token, aplica o PORTÃO de posse do projeto (W2: sem isto, trocar
// o projectId na URL lia a conversa alheia), entrega histórico, abre o canal do
// motor (ensureChannel) e roteia as mensagens do WS (chat, abort, set-model/mode/
// effort, permission/question/plan-response, compact, context/account). handleChat
// é a closure interna com o portão de crédito (billing) e a fila de turnos.
// `registrar(wss, deps)` liga tudo com as deps do server injetadas. Coberto pelo
// test:fake (chat→turno→done + ping/context-usage/set-model/abort).
// ═══════════════════════════════════════════════════════════════════════
const crypto = require('crypto');
const logger = require('../log.js');
const WebSocket = require('ws');

function registrar(wss, deps) {
  const {
    sessions, verifyToken, loadProjects, podeAcessarProjeto, trackEvent,
    loadChatHistory, ensureChannel, loadUsers, billing, appendChatMessage,
    switchAgentForProject, agentInlinePrefix, memoriaProjeto, getIntegrationsContext,
    getBuildScopeContext, BUILD_LEVELS, planejamentoAutomatico,
  } = deps;

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    const projectId = url.searchParams.get('projectId') || null;
    const decoded = verifyToken(token);

    if (!decoded) {
      ws.send(JSON.stringify({ type: 'error', data: 'Unauthorized' }));
      ws.close(4001, 'Unauthorized');
      return;
    }

    // A0.2: suspenso não abre canal de IA — a checagem é AO VIVO (users.json),
    // então suspender derruba inclusive quem já tinha token válido na mão.
    try {
      const _u = loadUsers()[decoded.user];
      if (_u && _u.suspended) {
        ws.send(JSON.stringify({ type: 'error', data: 'Conta suspensa. Fale com o administrador.' }));
        ws.close(4003, 'Suspended');
        return;
      }
    } catch {}

    const connId = crypto.randomUUID();
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    sessions.set(connId, { ws, user: decoded.user, created: Date.now() });
    logger.info(`[${connId.slice(0, 8)}] Client connected: ${decoded.user}`);

    let channel = null;

    // Portão do chat. É a porta mais perigosa do sistema: abrir sessão num
    // projeto é dar ao Claude acesso de leitura e escrita àqueles arquivos.
    // Sem esta conferência, bastava trocar o projectId na URL do WebSocket.
    //
    // A ORDEM AQUI É A CORREÇÃO. Antes, o histórico do chat era enviado ANTES
    // deste bloco: o `ws.send` já tinha despachado a conversa inteira quando o
    // `ws.close()` disparava. Fechar a conexão depois de entregar o dado não
    // desfaz a entrega — qualquer usuário autenticado lia a conversa de outro
    // (arquivos, prompts, segredos colados) só trocando o projectId na URL.
    if (projectId) {
      const alvo = loadProjects().find(p => p.id === projectId);
      if (!alvo || !podeAcessarProjeto(alvo, decoded.user)) {
        logger.warn(`[${connId.slice(0, 8)}] "${decoded.user}" tentou abrir chat em projeto que não é dele (${String(projectId).slice(0, 8)})`);
        trackEvent('acesso_negado_projeto', { projectId }, decoded.user);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', data: 'Projeto não encontrado' }));
        }
        return ws.close();
      }
    }

    // Histórico + status atual antes do 'ready' — só DEPOIS do portão.
    if (projectId) {
      const chatHistory = loadChatHistory(projectId);
      if (chatHistory.length > 0) {
        ws.send(JSON.stringify({ type: 'chat-history', messages: chatHistory }));
      }
    }

    // Abre (ou reconecta a) sessão do motor já na conexão — assim o seletor de
    // modelos/modos da UI é populado antes da primeira mensagem.
    ensureChannel(projectId, decoded.user).then((ch) => {
      channel = ch;
      ch.sockets.add(ws);
      if (ch.session.initInfo && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'init', ...ch.session.initInfo }));
      }
      if (ch.session.running && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'status', status: 'running', message: '' }));
      }
      // Reapresenta permissões/perguntas que ficaram pendentes
      if (ch.session.pendingInteractions.size > 0) ch.session.replayPending();
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ready' }));
    }).catch((err) => {
      logger.error(`[${connId.slice(0, 8)}] engine error:`, err.message);
      if (ws.readyState === WebSocket.OPEN) {
        // Limite de sessões não é "falha do motor": é o servidor cheio, e a
        // pessoa precisa saber disso com essas palavras para agir (fechar um
        // projeto, ou esperar). Prefixar com "Falha ao iniciar" confundiria.
        const mensagem = err.limiteAtingido ? err.message
                                            : 'Falha ao iniciar o motor: ' + err.message;
        ws.send(JSON.stringify({ type: 'error', data: mensagem, codigo: err.codigo || null }));
        ws.send(JSON.stringify({ type: 'ready' }));
      }
    });

    ws.on('message', async (raw) => {
      let parsed;
      try { parsed = JSON.parse(raw.toString()); } catch { return; }

      try {
        switch (parsed.type) {
          case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;

          case 'chat': {
            // Sessão pode ter sido coletada por inatividade — ensureChannel
            // recria (e retoma via resume) em vez de quebrar o chat.
            let ch = channel;
            if (!ch || ch.session.closed) ch = await ensureChannel(projectId, decoded.user);
            channel = ch;
            if (!ch.sockets.has(ws)) ch.sockets.add(ws);
            await handleChat(ch, parsed);
            break;
          }

          case 'abort':
            if (channel) {
              await channel.session.interrupt();
              channel.bcast({ type: 'done', code: 130 });
            }
            break;

          case 'set-model':
            if (channel) await channel.session.setModel(parsed.model || null);
            break;

          case 'set-mode':
            if (channel) await channel.session.setMode(parsed.mode);
            break;

          case 'set-effort':
            if (channel) await channel.session.setEffort(parsed.effort || null);
            break;

          case 'permission-response':
            if (channel) channel.session.respondInteraction(parsed.id, {
              behavior: parsed.behavior === 'allow' ? 'allow' : 'deny',
              always: !!parsed.always,
              message: parsed.message,
              interrupt: !!parsed.interrupt,
            });
            break;

          case 'question-response':
            if (channel) channel.session.respondInteraction(parsed.id, { answers: parsed.answers || {} });
            break;

          case 'plan-response':
            if (channel) channel.session.respondInteraction(parsed.id, {
              approve: !!parsed.approve, mode: parsed.mode, feedback: parsed.feedback,
            });
            break;

          case 'compact':
            if (channel) {
              // compactar também custa tokens — passa pelo portão (admins e
              // sessões com IA própria isentos — AD.1)
              const _cu = loadUsers();
              const _cAdm = _cu[decoded.user] && _cu[decoded.user].role === 'admin';
              const _cIsento = _cAdm || !!channel.iaPropria;
              if (!_cIsento) {
                const g = billing.gateDecision(decoded.user);
                if (g.decision.applicable === true && g.decision.decision === 'block') {
                  ws.send(JSON.stringify({ type: 'error', data: billing.BLOCK_MESSAGE }));
                  break;
                }
              }
              // o custo do compact cai no delta do próximo result — carimba o dono
              channel._turnUser = decoded.user;
              channel._turnExempt = _cIsento;
              channel.session.compact();
              channel.bcast({ type: 'engine_status', status: 'compacting' });
            }
            break;

          case 'context-usage':
            if (channel) {
              const usage = await channel.session.contextUsage();
              ws.send(JSON.stringify({ type: 'context_usage', data: usage }));
            }
            break;

          case 'account-info':
            if (channel) {
              const info = await channel.session.accountInfo();
              ws.send(JSON.stringify({ type: 'account', data: info }));
            }
            break;

          default:
            break;
        }
      } catch (err) {
        logger.error(`[${connId.slice(0, 8)}] ws message error:`, err.message);
        try { ws.send(JSON.stringify({ type: 'error', data: err.message })); } catch {}
      }
    });

    // Encaminha `mensagem` pra sessão do Claude que acabou de assumir o
    // projeto depois do handoff automático de planejamento — sem passar de
    // novo pelo classificador (evita reentrar em planejamento por causa de
    // uma palavra como "construa" no próprio texto de handoff) nem repetir a
    // continuidade (já embutida na própria mensagem). Carimba o turno com o
    // MESMO usuário/isenção da mensagem que originou o pipeline, senão o
    // turno de build sairia sem pagador nenhum.
    function enviarPosHandoff(novoCh, mensagem, turnoDeQuem, turnoIsento) {
      novoCh._continuidadeEnviada = true;
      novoCh._turnQueue = novoCh._turnQueue || [];
      novoCh._turnQueue.push({ id: crypto.randomUUID(), user: turnoDeQuem, exempt: !!turnoIsento });
      novoCh._turnUser = turnoDeQuem;
      novoCh._turnExempt = !!turnoIsento;
      novoCh.session.send(mensagem);
    }

    // Fase de planejamento concluída (marcador detectado OU teto de segurança
    // estourado) — grava o PRD, fecha o canal OpenCode e reabre no motor
    // normal (a escolha de proj.motor/instalação volta a valer sozinha,
    // porque o estado de planejamento já não existe mais nesse momento).
    async function concluirPlanejamentoEHandoff({ projectId, proj, textoResultado, ws: wsAtual, turnoDeQuem, turnoIsento, canalAntigo }) {
      planejamentoAutomatico.finalizarPlanejamento(projectId);
      const prd = planejamentoAutomatico.extrairPRD(textoResultado);
      if (proj && proj.path && prd) {
        try { memoriaProjeto.registrarPRD(proj.path, prd); } catch {}
      }
      // Sem fechar aqui, ensureChannel encontraria o MESMO canal OpenCode
      // ainda em cache (session.closed nunca vira true só por ter terminado
      // um turno) e devolveria ele de novo, em vez de abrir o Claude.
      try { canalAntigo.session.close('planejamento concluído'); } catch {}
      let novoCh;
      try {
        novoCh = await ensureChannel(projectId, turnoDeQuem);
      } catch (err) {
        logger.error('[planejamento] falha ao reabrir motor após handoff:', err.message);
        return;
      }
      channel = novoCh;
      if (!novoCh.sockets.has(wsAtual)) novoCh.sockets.add(wsAtual);
      const cont = (proj && proj.path && memoriaProjeto.textoDeContinuidade(proj.path)) || '';
      const msg = cont + '[Handoff automático de planejamento] Um PRD foi preparado em .nascera/prd.md — leia-o antes de agir e construa exatamente o que ele especifica.\n\n';
      enviarPosHandoff(novoCh, msg, turnoDeQuem, turnoIsento);
    }

    // Sessão OpenCode falhou durante o planejamento (CLI ausente, processo
    // morreu, etc.) — nunca deixa o usuário esperando um modelo grátis
    // quebrado: cai direto pro motor normal com a mensagem ORIGINAL dele,
    // como se o classificador tivesse mandado "build" desde o início.
    async function planejamentoFalhouEFallback({ projectId, ws: wsAtual, turnoDeQuem, turnoIsento, canalAntigo }) {
      const mensagemOriginal = planejamentoAutomatico.mensagemParaRetomar(projectId);
      planejamentoAutomatico.finalizarPlanejamento(projectId);
      // Mesmo motivo do handoff de sucesso: sem fechar, ensureChannel
      // devolveria a mesma sessão OpenCode quebrada em vez de abrir o Claude
      // — e reenviar a mensagem original pra ela reproduziria o mesmo erro.
      try { canalAntigo.session.close('planejamento falhou'); } catch {}
      let novoCh;
      try {
        novoCh = await ensureChannel(projectId, turnoDeQuem);
      } catch (err) {
        logger.error('[planejamento] falha ao voltar pro motor normal:', err.message);
        return;
      }
      channel = novoCh;
      if (!novoCh.sockets.has(wsAtual)) novoCh.sockets.add(wsAtual);
      enviarPosHandoff(novoCh, mensagemOriginal, turnoDeQuem, turnoIsento);
    }

    async function handleChat(ch, parsed) {
      const userMessage = String(parsed.message || '');
      let finalMessage = userMessage;

      if (ch.session.closed) {
        ch.bcast({ type: 'error', data: 'A sessão foi encerrada. Envie a mensagem novamente.' });
        ch.bcast({ type: 'done', code: 1 });
        return;
      }

      // ── O PORTÃO (antes do turno). Aqui é fechadura, não aviso: o NASCERA é o
      // próprio gateway, então bloquear aqui bloqueia de verdade.
      // ADMIN é isento: o dono nunca é bloqueado nem debitado pelo próprio sistema.
      // AD.1: sessão com IA PRÓPRIA (ch.iaPropria) também é isenta — o token
      // sai da credencial do usuário, não da conta do admin. A marca vem da
      // sessão REAL (env nasceu com a chave dele), nunca da flag sozinha.
      const _users = loadUsers();
      const _isAdmin = _users[decoded.user] && _users[decoded.user].role === 'admin';
      const _isento = _isAdmin || !!(ch && ch.iaPropria);
      if (!_isento) {
        const gate = billing.gateDecision(decoded.user);
        if (gate.decision.applicable === true && gate.decision.decision === 'block') {
          // quando reabre? sessão → +5h; semana → segunda; mês → dia 1º
          let resetsAt = null;
          try {
            const s = billing.summaryFor(decoded.user);
            resetsAt = gate.decision.reason === 'session' ? s.session.resetsAt
              : gate.decision.reason === 'daily' ? s.windows.dayEnd
              : gate.decision.reason === 'weekly' ? s.week.weekEnd
              : s.windows.monthEnd;
          } catch {}
          ch.bcast({ type: 'credit_blocked', user: decoded.user, reason: gate.decision.reason, resetsAt, message: billing.BLOCK_MESSAGE });
          ch.bcast({ type: 'error', data: billing.BLOCK_MESSAGE });
          ch.bcast({ type: 'done', code: 1 });
          return;
        }
      }
      // Mesmo portão, agora também na FILA. O bloco acima só decide sobre a
      // mensagem que ACABOU de chegar; as que ficam enfileiradas durante um
      // turno em voo eram despachadas depois sem ninguém perguntar de novo —
      // e como o débito só acontece no `result`, uma rajada furava os tetos.
      // O motor chama isto antes de tirar cada item da fila.
      if (ch && ch.session && !ch.session.podeDespachar) {
        const donoDaFila = decoded.user;
        const canalDaFila = ch;
        ch.session.podeDespachar = () => {
          try {
            if (canalDaFila && canalDaFila.iaPropria) return { ok: true };   // AD.1: chave do usuário
            const u = loadUsers();
            if (u[donoDaFila] && u[donoDaFila].role === 'admin') return { ok: true };
            const g = billing.gateDecision(donoDaFila);
            if (g.decision.applicable === true && g.decision.decision === 'block') {
              return { ok: false, motivo: billing.BLOCK_MESSAGE };
            }
          } catch {}
          return { ok: true };
        };
      }

      // Carimbo do turno: quem paga + idempotência do débito (admin não paga).
      // FILA, não carimbo único: o motor enfileira mensagens durante um turno
      // em voo — cada 'result' consome o carimbo mais antigo, na ordem. Um
      // carimbo único era sobrescrito pela mensagem enfileirada (turno de
      // graça via idempotência, pagador errado, isenção vazando).
      ch._turnQueue = ch._turnQueue || [];
      ch._turnQueue.push({ id: crypto.randomUUID(), user: decoded.user, exempt: _isento });
      if (ch._turnQueue.length > 50) ch._turnQueue.shift();
      // fallback para results órfãos (ex.: custo de /compact que cai no turno seguinte)
      ch._turnUser = decoded.user;
      ch._turnExempt = _isento;

      // Escopo só entra no build inicial (primeira mensagem do projeto). Depois
      // disso o usuário está iterando — mandar "entregue multi-página" num pedido
      // de "mude a cor do botão" só inflaria a tarefa. O esforço de raciocínio,
      // esse sim, continua valendo para a sessão inteira.
      const isFirstMessage = projectId ? loadChatHistory(projectId).length === 0 : false;

      if (projectId) {
        appendChatMessage(projectId, { role: 'user', content: userMessage, timestamp: Date.now() });
      }

      // Pipeline de planejamento automático (servicos/planejamento-automatico.js):
      // decide ANTES de montar qualquer coisa específica do Claude (agente,
      // continuidade, escopo) — nada disso se aplica enquanto a fase for a
      // de planejamento no OpenCode gratuito.
      if (projectId && planejamentoAutomatico) {
        const proj = loadProjects().find(p => p.id === projectId);
        const jaPlanejando = planejamentoAutomatico.estaPlanejando(projectId);
        let vaiPlanejar = jaPlanejando;
        if (!jaPlanejando && planejamentoAutomatico.elegivelParaPipeline(proj)) {
          vaiPlanejar = planejamentoAutomatico.classificar(userMessage, { primeiraMensagem: isFirstMessage }) === 'planejar';
        }

        if (vaiPlanejar) {
          let canalDePlanejamento = ch;

          if (!jaPlanejando) {
            planejamentoAutomatico.iniciarPlanejamento(projectId, userMessage);
            try { ch.session.close('planejamento automático'); } catch {}
            try {
              canalDePlanejamento = await ensureChannel(projectId, decoded.user);
            } catch (err) {
              // Nem o OpenCode abriu — desiste do planejamento pra este
              // pedido e volta pro motor normal, como se o classificador
              // tivesse mandado "build" desde o início.
              planejamentoAutomatico.finalizarPlanejamento(projectId);
              canalDePlanejamento = null;
              try {
                ch = await ensureChannel(projectId, decoded.user);
                channel = ch;
              } catch (err2) {
                logger.error(`[${connId.slice(0, 8)}] planejamento: falha ao abrir motor:`, err2.message);
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'error', data: 'Falha ao iniciar o motor: ' + err2.message }));
                }
                return;
              }
            }

            if (canalDePlanejamento) {
              channel = canalDePlanejamento;
              ch = canalDePlanejamento;
              if (!ch.sockets.has(ws)) ch.sockets.add(ws);

              const sessaoDePlanejamento = canalDePlanejamento.session;
              sessaoDePlanejamento.on('result', (r) => {
                if (!planejamentoAutomatico.estaPlanejando(projectId)) return;
                const texto = r.text || r.content || '';
                const marcou = planejamentoAutomatico.detectarMarcador(texto);
                if (marcou || canalDePlanejamento._planEstourou) {
                  concluirPlanejamentoEHandoff({
                    projectId, proj, textoResultado: texto, ws,
                    turnoDeQuem: decoded.user, turnoIsento: _isento,
                    canalAntigo: canalDePlanejamento,
                  }).catch(err => logger.error('[planejamento] handoff falhou:', err.message));
                }
              });
              sessaoDePlanejamento.on('error', () => {
                if (!planejamentoAutomatico.estaPlanejando(projectId)) return;
                planejamentoFalhouEFallback({
                  projectId, ws, turnoDeQuem: decoded.user, turnoIsento: _isento,
                  canalAntigo: canalDePlanejamento,
                }).catch(err => logger.error('[planejamento] fallback falhou:', err.message));
              });
            }
          }

          if (canalDePlanejamento && planejamentoAutomatico.estaPlanejando(projectId)) {
            const { estourou } = planejamentoAutomatico.registrarRodada(projectId, userMessage);
            canalDePlanejamento._planEstourou = estourou;
            logger.info(`[${connId.slice(0, 8)}] chat → planejamento (opencode):`, userMessage.substring(0, 100));
            canalDePlanejamento.session.send(userMessage);
            return;
          }
          // Só chega aqui se a abertura do motor de planejamento falhou logo
          // acima — `ch` já foi reaberto no motor normal, e o fluxo continua
          // abaixo como um turno comum.
        }
      }

      // @agente: injeta as instruções do agente nesta mensagem (a sessão é viva,
      // então trocar o CLAUDE.md só teria efeito na próxima sessão)
      if (projectId) {
        const mentionMatch = userMessage.match(/^@(dev|architect|qa|pm|ux|sm)\b/);
        if (mentionMatch) {
          const agent = mentionMatch[1];
          switchAgentForProject(projectId, agent);   // persiste p/ próximas sessões
          ch.bcast({ type: 'agent-changed', agent });
          finalMessage = agentInlinePrefix(agent) + userMessage.replace(/^@\w+\s*/, '');
        }
      }

      // Continuidade entre motores: na PRIMEIRA mensagem de uma sessão que
      // assumiu um projeto em andamento, o resumo da memória vai junto.
      // Confiar só no arquivo não basta — o motor às vezes não abre, e aí
      // recomeça o projeto do zero na frente do cliente.
      if (projectId && ch && !ch._continuidadeEnviada) {
        ch._continuidadeEnviada = true;
        try {
          const projMem = loadProjects().find(p => p.id === projectId);
          if (projMem && projMem.path) {
            const cont = memoriaProjeto.textoDeContinuidade(projMem.path);
            if (cont) finalMessage = cont + finalMessage;
          }
        } catch {}
      }

      // Contexto de integrações (mesmo comportamento do motor antigo)
      const intContext = getIntegrationsContext();
      if (intContext && !finalMessage.includes('Integracoes Conectadas')) {
        finalMessage = finalMessage + intContext;
      }

      if (isFirstMessage) {
        finalMessage = finalMessage + getBuildScopeContext(ch.buildLevel);
        logger.info(`[${connId.slice(0, 8)}] escopo nível ${ch.buildLevel} (${BUILD_LEVELS[ch.buildLevel].name}) aplicado ao build inicial`);
      }

      // Imagens reais: blocos base64 na mensagem
      const images = Array.isArray(parsed.images) ? parsed.images.slice(0, 10) : [];
      let content;
      if (images.length > 0) {
        content = [{ type: 'text', text: finalMessage }];
        for (const img of images) {
          if (!img || !img.data || !/^image\/(png|jpeg|gif|webp)$/.test(img.media_type || '')) continue;
          content.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
        }
      } else {
        content = finalMessage;
      }

      logger.info(`[${connId.slice(0, 8)}] chat → engine (${images.length} imagens):`, userMessage.substring(0, 100));
      ch.session.send(content);
    }

    ws.on('close', () => {
      if (channel) channel.sockets.delete(ws);
      sessions.delete(connId);
      // A sessão do motor CONTINUA viva em background — o usuário pode voltar.
      logger.info(`[${connId.slice(0, 8)}] Client disconnected`);
    });

    ws.on('error', () => {
      if (channel) channel.sockets.delete(ws);
      sessions.delete(connId);
    });
  });
}

module.exports = { registrar };
