// ═══════════════════════════════════════════════════════════════════════
// NASCERA — motor (CLI de IA) por projeto: config e status (S4: extraído do server.js)
//
// 3 rotas: PUT /motor (troca o motor do projeto — e DERRUBA a sessão viva, que
// nasceu com o motor antigo), GET /motor (motor em uso + estado dos CLIs +
// memória do projeto), GET /status (a sessão está rodando?).
//
// NÃO inclui imagem nem agent: `imagem` está entrelaçada com o fluxo de build
// (o helper escreverFerramentaDeImagem roda quando a sessão nasce e compartilha
// tokenDeImagem), então fica no server.js — feature paga, sem risco de untangle.
// O turno de build/chat em si é o handler do WebSocket `/ws`, que também fica.
//
// `channels` (o Map das sessões vivas) vem por getter `getChannels()` — o mesmo
// padrão do admin-motores — porque é definido depois deste ponto no server.js;
// o arrow só avalia em request-time, quando o Map já existe (sem TDZ).
// Posse: projectOr404 (W1/IDOR). PUT /motor coberto por testes/projetos-motor.test.js
// (fecha a sessão viva + remove o canal na troca).
// ═══════════════════════════════════════════════════════════════════════
/**
 * Monta as rotas de motor (CLI de IA) por projeto: `PUT /motor` (troca o motor e
 * derruba a sessão viva), `GET /motor` (motor em uso + estado dos CLIs) e
 * `GET /status` (a sessão está rodando?).
 *
 * @param {import('express').Express} app - App do Express onde as rotas são montadas.
 * @param {object} deps - Dependências injetadas pelo server.js (composition root).
 * @param {import('express').RequestHandler} deps.authMiddleware - Guarda de sessão; exige usuário logado.
 * @param {import('express').RequestHandler} deps.projectOr404 - Portão de dono (W1/IDOR): resolve `req.projeto` ou responde 404 se for de outro usuário.
 * @param {object} deps.motores - Módulo de motores (lista/estado/troca dos CLIs de IA).
 * @param {() => object} deps.loadNasceraConfig - Lê a config global do Nascera.
 * @param {() => object[]} deps.loadProjects - Lê a lista de projetos.
 * @param {(projs: object[]) => void} deps.saveProjects - Grava a lista de projetos.
 * @param {object} deps.memoriaProjeto - Memória por projeto (registra a troca de motor).
 * @param {(proj: object) => string} deps.sessionKeyFor - Chave da sessão viva do projeto.
 * @param {(evt: object) => void} deps.appendActivity - Registra um evento no log de atividade.
 * @param {() => Promise<object>} deps.getEngine - Resolve o motor/`sessionManager` sob demanda.
 * @param {() => Map<string,object>} deps.getChannels - Resolve o Map `channels` em tempo de request (evita TDZ).
 * @returns {void}
 */
function registrar(app, deps) {
  const {
    authMiddleware, projectOr404, motores, loadNasceraConfig, loadProjects,
    saveProjects, memoriaProjeto, sessionKeyFor, appendActivity, getEngine,
    getChannels,
  } = deps;

  app.put('/api/projects/:id/motor', authMiddleware, async (req, res) => {
    const proj = projectOr404(req, res); if (!proj) return;
    const id = String((req.body && req.body.id) || '');
    if (!motores.ehValido(id)) return res.status(400).json({ error: 'Motor desconhecido' });

    const est = await motores.estadoDe(id);
    if (!est.instalado) return res.status(400).json({ error: `O CLI do ${est.nome} não está instalado nesta máquina.` });
    if (!est.conectado) {
      // Mesmo portão do admin: quando a prova de login não rodou (o CLI nem
      // executou — no Windows era o shim .cmd), mandar "faça login" é acusar o
      // usuário de um defeito da máquina. Com motivo técnico, ele vai na frente.
      return res.status(400).json({
        error: est.provaErro
          ? `Não deu para confirmar o login do ${est.nome}: ${est.provaErro}`
          : `O ${est.nome} não está conectado. Rode: ${est.comandoLogin}`,
      });
    }

    const anterior = proj.motor || loadNasceraConfig().motor || 'claude';
    const projetos = loadProjects();
    const alvo = projetos.find(p => p.id === proj.id);
    alvo.motor = id;
    saveProjects(projetos);

    // Registra na memória ANTES de derrubar a sessão: é o que o motor novo vai
    // ler para saber que está assumindo trabalho em andamento.
    if (proj.path) {
      try { memoriaProjeto.registrarTrocaDeMotor(proj.path, anterior, id); } catch {}
    }

    // A sessão viva nasceu com o motor antigo; sem fechar, a troca não valeria.
    const chave = sessionKeyFor(proj.id, req.user.user);
    const channels = getChannels();
    const ch = channels.get(chave);
    if (ch) { try { ch.session.close('troca de motor'); } catch {} channels.delete(chave); }

    appendActivity({ type: 'projeto_motor_alterado', user: req.user.user, data: { projectId: proj.id, de: anterior, para: id }, at: new Date().toISOString() });
    res.json({ ok: true, motor: id, anterior });
  });

  app.get('/api/projects/:id/motor', authMiddleware, async (req, res) => {
    const proj = projectOr404(req, res); if (!proj) return;
    const padrao = motores.ehValido(loadNasceraConfig().motor) ? loadNasceraConfig().motor : 'claude';
    const e = await motores.estado();
    res.json({
      emUso: motores.ehValido(proj.motor) ? proj.motor : padrao,
      doProjeto: motores.ehValido(proj.motor) ? proj.motor : null,
      padraoDaInstalacao: padrao,
      motores: e.motores,
      memoria: proj.path ? memoriaProjeto.ler(proj.path) : null,
    });
  });

  app.get('/api/projects/:id/status', authMiddleware, async (req, res) => {
    // Portão de dono: sem isto, trocar o :id lê/altera projeto alheio (IDOR).
    const proj = projectOr404(req, res); if (!proj) return;
    try {
      const { sessionManager } = await getEngine();
      const s = sessionManager.get(req.params.id);
      res.json({ status: s && s.running ? 'running' : 'idle', session: s ? s.status() : null });
    } catch {
      res.json({ status: 'idle' });
    }
  });
}

module.exports = { registrar };
