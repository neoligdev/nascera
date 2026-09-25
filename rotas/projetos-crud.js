// ═══════════════════════════════════════════════════════════════════════
// NASCERA — ciclo de vida do projeto (S4: extraído do server.js)
//
// 5 rotas: GET /api/projects (lista do dono, sem segredos), POST (cria pasta +
// scaffold do tema + git, NÃO invoca o motor — o build de IA é pelo WebSocket),
// PATCH (persiste no objeto REAL do array — regressão S0-2), DELETE (soft: move
// p/ lixeira, NUNCA rm -rf; pasta VINCULADA só é desconectada — o acidente dos
// 200 GB) e GET :id/impacto (o que exatamente será excluído, antes de confirmar).
//
// Portão de posse: projectOr404 (W1/IDOR). DELETE cross-tenant coberto por
// rotas-autorizacao (S0-3). GET /api/projects fixado por rotas-smoke.
// NÃO inclui /api/vps-folders (folder picker, fica no server.js entre GET e POST).
// ═══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const logger = require('../log.js');
const path = require('path');
const crypto = require('crypto');

/**
 * Monta o ciclo de vida do projeto (`/api/projects*`): listar (do dono, sem
 * segredos), criar (pasta + scaffold do tema + git; NÃO invoca o motor),
 * atualizar (patch no objeto real), excluir (soft: vai para a lixeira, nunca
 * `rm -rf`) e prever o impacto de uma exclusão.
 *
 * @param {import('express').Express} app - App do Express onde as rotas são montadas.
 * @param {object} deps - Dependências injetadas pelo server.js (composition root).
 * @param {import('express').RequestHandler} deps.authMiddleware - Guarda de sessão; exige usuário logado.
 * @param {import('express').RequestHandler} deps.projectOr404 - Portão de dono (W1/IDOR): resolve `req.projeto` ou responde 404 se for de outro usuário.
 * @param {(username: string) => object[]} deps.projetosDoUsuario - Lista os projetos do dono.
 * @param {(proj: object) => object} deps.semSegredos - Devolve o projeto sem campos sensíveis (para a resposta).
 * @param {(nome: string) => string} deps.makeSlug - Gera um slug de URL a partir do nome.
 * @param {() => object[]} deps.loadProjects - Lê a lista de projetos.
 * @param {(projs: object[]) => void} deps.saveProjects - Grava a lista de projetos.
 * @param {(themeId: string, projectPath: string) => void} deps.scaffoldFromTheme - Copia o tema base para a pasta do projeto.
 * @param {(projectPath: string) => void} deps.initGit - Inicializa o repositório git do projeto.
 * @param {(v: unknown) => string} deps.normalizeBuildLevel - Normaliza o nível de build para um valor válido.
 * @param {(nome: string, dados?: object) => void} deps.trackEvent - Emite um evento de telemetria.
 * @param {object} deps.seguranca - Módulo `caminhos-seguros`: único portão de exclusão.
 * @param {object} deps.domains - Módulo de domínios (limpeza ao excluir o projeto).
 * @param {() => object[]} deps.loadTrash - Lê a lixeira.
 * @param {(itens: object[]) => void} deps.saveTrash - Grava a lixeira.
 * @param {() => object} deps.loadNasceraConfig - Lê a config global do Nascera.
 * @param {string} deps.PROJECTS_BASE - Raiz da área de projetos.
 * @param {string} deps.PUBLISHED_BASE - Raiz dos sites publicados.
 * @param {string} deps.TRASH_DIR - Diretório da lixeira.
 * @param {string} deps.THUMB_DIR - Diretório dos thumbnails.
 * @param {string} deps.THEMES_BASE - Raiz do catálogo de temas.
 * @returns {void}
 */
function registrar(app, deps) {
  const {
    authMiddleware, projectOr404, projetosDoUsuario, semSegredos, makeSlug,
    loadProjects, saveProjects, scaffoldFromTheme, initGit, normalizeBuildLevel,
    trackEvent, seguranca, domains, loadTrash, saveTrash, loadNasceraConfig,
    PROJECTS_BASE, PUBLISHED_BASE, TRASH_DIR, THUMB_DIR, THEMES_BASE,
  } = deps;

  app.get('/api/projects', authMiddleware, (req, res) => {
    const projects = projetosDoUsuario(req.user.user);
    // semSegredos: nenhuma credencial sai por API, nem a legada de projeto remoto.
    res.json(projects.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map(semSegredos));
  });

  // Create project — now with auto slug, git init, and auto URLs
  app.post('/api/projects', authMiddleware, (req, res) => {
    const { name, folderPath, createNew, themeId, paletteId, customPalette, paletteUrl } = req.body;
    if (!name) return res.status(400).json({ error: 'nome é obrigatório' });

    const slug = makeSlug(name);
    let projectPath = folderPath || null;

    // Check slug uniqueness
    const existing = loadProjects();
    if (existing.find(p => p.slug === slug)) {
      return res.status(400).json({ error: `Projeto com slug "${slug}" já existe` });
    }

    if (createNew && name) {
      projectPath = path.join(PROJECTS_BASE, slug);
      if (!projectPath.startsWith(PROJECTS_BASE)) {
        return res.status(400).json({ error: 'Nome inválido' });
      }
      try {
        if (!fs.existsSync(projectPath)) {
          fs.mkdirSync(projectPath, { recursive: true });
        }
      } catch (err) {
        return res.status(500).json({ error: 'Falha ao criar pasta: ' + err.message });
      }
    }

    // If linking existing folder, use folder name as path
    if (!projectPath && folderPath) {
      projectPath = folderPath;
    }

    // ── Camadas 2 e 4: a pasta vinculada é a que causou o acidente ──
    // Antes daqui, `folderPath` vinha do corpo da requisição e virava proj.path
    // sem checagem nenhuma — conectar a pasta pessoal e clicar em excluir
    // apagava a máquina inteira. Duas coisas mudam:
    //   · pastas do sistema e a home são recusadas na origem;
    //   · o projeto guarda a ORIGEM, e pasta que o Nascera não criou nunca é
    //     apagada por ele — no máximo, desconectada.
    const proprio = !!(createNew && projectPath && seguranca.dentroDaAreaDeProjetos(projectPath));
    if (!proprio && projectPath) {
      const recusa = seguranca.motivoParaRecusar(projectPath);
      if (recusa) return res.status(400).json({ error: recusa });
    }

    // Resolve theme data if selected
    let themeData = null;
    if (themeId) {
      // Fetch theme info from /api/themes logic
      const categories = [
        { dir: 'design-systems/temas_escuros', type: 'dark', label: 'Escuro' },
        { dir: 'design-systems/temas_claros', type: 'light', label: 'Claro' },
        { dir: 'sites/1_temas_escuros', type: 'dark', label: 'Site Escuro' },
        { dir: 'sites/2_temas_claros', type: 'light', label: 'Site Claro' },
        { dir: 'sites/3_componentes', type: 'component', label: 'Componente' },
      ];
      for (const cat of categories) {
        const catPath = path.join(THEMES_BASE, cat.dir);
        if (!fs.existsSync(catPath)) continue;
        const cleanId = themeId.replace('site-', '');
        const themePath = path.join(catPath, cleanId);
        if (fs.existsSync(themePath)) {
          const hasDS = fs.existsSync(path.join(themePath, 'design-system.html'));
          themeData = {
            name: cleanId.replace(/[-_.]/g, ' ').replace(/aura build/g, '').trim(),
            label: cat.label,
            designSystemPath: hasDS ? path.join(themePath, 'design-system.html') : null,
            indexPath: fs.existsSync(path.join(themePath, 'index.html')) ? path.join(themePath, 'index.html') : null,
          };
          break;
        }
      }
    }

    // Scaffold-first: projeto novo com tema nasce com os arquivos do template já copiados.
    // O preview carrega o layout real em ~1s; o Claude só adapta conteúdo/paleta via Edit.
    let scaffolded = false;
    if (createNew && themeId && projectPath) {
      try {
        scaffolded = scaffoldFromTheme(themeId, projectPath);
      } catch (e) {
        logger.error('[SCAFFOLD] Falha ao copiar template:', e.message);
      }
    }

    // Log theme data for debugging
    logger.info('[PROJECT] Creating:', name, '| themeId:', themeId || 'none', '| themeData:', themeData ? themeData.name : 'none', '| scaffold:', scaffolded);

    // Auto-detect if project has its own server (proxyTarget)
    if (projectPath && !themeData) {
      let detectedProxy = null;
      try {
        // Check docker-compose for port mappings
        const dcPath = path.join(projectPath, 'docker-compose.yaml') ;
        const dcPath2 = path.join(projectPath, 'docker-compose.yml');
        if (fs.existsSync(dcPath) || fs.existsSync(dcPath2)) {
          const dcContent = fs.readFileSync(fs.existsSync(dcPath) ? dcPath : dcPath2, 'utf8');
          // Look for proxy_pass or port mappings
          const proxyMatch = dcContent.match(/proxy_pass\s+http:\/\/([^;\s]+)/);
          const portMatch = dcContent.match(/(\d{4,5}):(?:80|443|3000|8080|8000|5000)/);
          if (proxyMatch) detectedProxy = 'http://' + proxyMatch[1];
          else if (portMatch) detectedProxy = 'http://localhost:' + portMatch[1];
        }
        // Check package.json for dev/start scripts with port
        const pkgPath = path.join(projectPath, 'package.json');
        if (!detectedProxy && fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          const startScript = (pkg.scripts && (pkg.scripts.dev || pkg.scripts.start)) || '';
          const portMatch = startScript.match(/(?:PORT|port)[=:\s]*(\d{4,5})/);
          if (portMatch) detectedProxy = 'http://localhost:' + portMatch[1];
        }
        // Check nginx.conf
        const nginxPath = path.join(projectPath, 'nginx.conf');
        if (!detectedProxy && fs.existsSync(nginxPath)) {
          const nginxContent = fs.readFileSync(nginxPath, 'utf8');
          const proxyMatch = nginxContent.match(/proxy_pass\s+http:\/\/([^;\s]+)/);
          if (proxyMatch) detectedProxy = 'http://' + proxyMatch[1];
        }
      } catch (e) {}
      if (detectedProxy) {
        logger.info('[PROJECT] Detected proxy target:', detectedProxy);
      }
    }

    // Init git + inject CLAUDE.md with agent orchestration
    if (projectPath) {
      initGit(projectPath, themeData, { name: name.trim(), slug, themeId: themeId || null, scaffolded, createdAt: new Date().toISOString(), paletteId: paletteId || null, customPalette: customPalette || null, paletteUrl: paletteUrl || null });
    }

    // Create published directory
    const publishedPath = path.join(PUBLISHED_BASE, slug);
    if (!fs.existsSync(publishedPath)) {
      fs.mkdirSync(publishedPath, { recursive: true });
    }

    // Auto-generate URLs (relative paths so they work via same HTTPS domain)
    const previewUrl = `/preview/${slug}/`;
    const publishUrl = `/site/${slug}/`;

    const projects = loadProjects();
    const project = {
      id: crypto.randomUUID(),
      owner: req.user.user,   // quem cria é o dono; o resto do sistema confere por aqui
      name: name.trim(),
      slug,
      path: projectPath,
      // 'proprio' = o Nascera criou a pasta dentro da área de projetos e pode
      // apagá-la. 'vinculado' = pasta preexistente do usuário; o Nascera edita,
      // mas NUNCA apaga — só solta o vínculo.
      origem: proprio ? 'proprio' : 'vinculado',
      publishedPath,
      previewUrl,
      publishUrl,
      currentVersion: 0,
      publishedVersion: 0,
      sessionId: null,
      activeAgent: 'dev',
      buildLevel: normalizeBuildLevel(req.body.buildLevel),
      themeId: themeId || null,
      scaffolded,
      paletteId: paletteId || null,
      customPalette: customPalette || null,
      paletteUrl: paletteUrl || null,
      createdAt: new Date().toISOString(),
    };
    projects.push(project);
    saveProjects(projects);
    // No servidor Linux o Claude roda como claude-runner — dá a ele permissão de
    // escrita no projeto recém-criado (senão a execução trava com "permission denied").
    if (process.platform === 'linux' && process.env.NASCERA_DESKTOP !== 'true') {
      try {
        const cp = require('child_process');
        if (projectPath) cp.execFileSync('chown', ['-R', 'claude-runner:claude-runner', projectPath]);
        cp.execFileSync('chown', ['-R', 'claude-runner:claude-runner', publishedPath]);
      } catch (e) { logger.error('[projects] chown claude-runner falhou:', e.message); }
    }
    trackEvent('project_created', { name: project.name, slug: project.slug, themeId: project.themeId });
    res.status(201).json(project);
  });

  // Update project
  app.patch('/api/projects/:id', authMiddleware, (req, res) => {
    const proj = projectOr404(req, res); if (!proj) return;   // posse + 404
    // BUG DE PERSISTÊNCIA (S0-2): `proj` vem do loadProjects() interno do
    // projectOr404 — NÃO é o mesmo objeto do array que se salva. Mutar `proj`
    // e gravar outro array fazia renomear/favoritar responderem 200 e não
    // persistirem. Muta o objeto certo do array que vai para o disco.
    const projects = loadProjects();
    const alvo = projects.find(p => p.id === proj.id);
    if (!alvo) return res.status(404).json({ error: 'Projeto nao encontrado' });
    if (req.body.sessionId) alvo.sessionId = req.body.sessionId;
    if (req.body.name) alvo.name = req.body.name.trim();
    if (req.body.previewUrl !== undefined) alvo.previewUrl = req.body.previewUrl || null;
    if (req.body.proxyTarget !== undefined) alvo.proxyTarget = req.body.proxyTarget || null;
    if (req.body.favorite !== undefined) alvo.favorite = !!req.body.favorite;
    saveProjects(projects);
    res.json(alvo);
  });

  // Soft-delete: move project to trash with 7-day auto-purge
  app.delete('/api/projects/:id', authMiddleware, (req, res) => {
    let projects = loadProjects();
    const proj = projectOr404(req, res); if (!proj) return;

    // If keepFiles=true, just remove from list without touching files
    const keepFiles = req.query.keepFiles === 'true';

    // Projeto sem origem gravada é anterior a esta correção: decide pelo lugar.
    // Na dúvida, trata como vinculado — o erro barato é não apagar.
    const ehProprio = proj.origem
      ? proj.origem === 'proprio'
      : seguranca.dentroDaAreaDeProjetos(proj.path);

    let arquivos = 'mantidos';
    if (!keepFiles && proj.path && fs.existsSync(proj.path)) {
      if (!ehProprio) {
        // Camada 2: pasta que o Nascera não criou é DESCONECTADA, nunca apagada.
        // É a regra que teria evitado o acidente mesmo sem nenhuma outra.
        logger.info('[seguranca] projeto vinculado — desconectando sem tocar nos arquivos:', proj.path);
        arquivos = 'preservados';
      } else {
        // Camada 1 + 3: mover para a lixeira INTERNA (de onde dá para restaurar).
        // Se o rename falhar, ABORTA — o `cp -a` + `rm -rf` que existia aqui foi
        // o que apagou a pasta pessoal de um usuário. Nunca mais.
        const trashPath = path.join(TRASH_DIR, proj.slug || proj.id);
        const r = seguranca.apagarComSeguranca(trashPath, 'limpar lixeira anterior');
        if (r.recusado) logger.error('[seguranca] lixeira anterior fora da área:', trashPath);
        try {
          fs.mkdirSync(TRASH_DIR, { recursive: true });
          fs.renameSync(proj.path, trashPath);
          proj._trashPath = trashPath;
          arquivos = 'na lixeira';
        } catch (err) {
          logger.error('[TRASH] não consegui mover ' + proj.path + ':', err.message);
          return res.status(500).json({
            error: 'Não foi possível mover a pasta do projeto para a lixeira (' + err.code + '). '
                 + 'Nada foi apagado. Mova ou remova a pasta manualmente se quiser excluí-la.',
          });
        }
      }
    }

    // Publicado é sempre gerado pelo Nascera, mas passa pelo portão do mesmo jeito.
    if (proj.publishedPath && fs.existsSync(proj.publishedPath)) {
      seguranca.apagarComSeguranca(proj.publishedPath, 'excluir publicado');
    }

    // Solta os domínios: sem isso o Host continuaria mapeado para um projeto
    // que não existe mais — e o domínio ficaria preso, impossível de recadastrar
    try {
      for (const d of domains.listForProject(proj.id)) domains.removeDomain(d.domain);
    } catch (err) { logger.error('[dominios] limpeza na exclusão falhou:', err.message); }

    // Remove thumbnail
    const thumbJpg = path.join(THUMB_DIR, `project_${proj.slug}.jpg`);
    const thumbPng = path.join(THUMB_DIR, `project_${proj.slug}.png`);
    try { if (fs.existsSync(thumbJpg)) fs.unlinkSync(thumbJpg); } catch {}
    try { if (fs.existsSync(thumbPng)) fs.unlinkSync(thumbPng); } catch {}

    // Save to trash list
    const trash = loadTrash();
    trash.push({
      ...proj,
      deletedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + (loadNasceraConfig().trashRetentionDays || 7) * 24 * 60 * 60 * 1000).toISOString(),
      trashPath: proj._trashPath || null,
      arquivos,   // 'na lixeira' | 'preservados' | 'mantidos'
    });
    saveTrash(trash);

    // Remove from active projects
    projects = projects.filter(p => p.id !== req.params.id);
    saveProjects(projects);

    res.json({
      ok: true, arquivos,
      message: arquivos === 'preservados'
        ? 'Projeto desconectado. A pasta e todos os arquivos continuam no lugar.'
        : 'Projeto movido para a lixeira',
    });
  });

  // Camada 6: o que exatamente vai ser excluído. A tela pergunta ANTES de
  // mostrar a confirmação — 200 GB não podem sair com o mesmo clique de uma
  // pasta vazia.
  app.get('/api/projects/:id/impacto', authMiddleware, (req, res) => {
    const proj = projectOr404(req, res); if (!proj) return;
    const ehProprio = proj.origem
      ? proj.origem === 'proprio'
      : seguranca.dentroDaAreaDeProjetos(proj.path);
    const m = seguranca.medir(proj.path);
    res.json({
      caminho: proj.path || null,
      origem: ehProprio ? 'proprio' : 'vinculado',
      existe: m.existe,
      arquivos: m.arquivos,
      truncado: m.truncado,
      tamanho: seguranca.formatarTamanho(m.bytes),
      bytes: m.bytes,
      // O que REALMENTE vai acontecer, em uma frase, para a tela repetir.
      consequencia: ehProprio
        ? 'A pasta vai para a lixeira e pode ser restaurada por 7 dias.'
        : 'Só o vínculo é removido. Nenhum arquivo seu é apagado.',
    });
  });
}

module.exports = { registrar };
