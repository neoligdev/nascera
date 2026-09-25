// ═══════════════════════════════════════════════════════════════════════
// NASCERA — preview do projeto (S4: extraído do server.js)
//
// 6 rotas: generate-thumbnail e screenshot (delegam ao generateProjectScreenshot,
// que FICA no server.js com o _chromeSem), visual-save (edição visual → escrita
// atômica + git; recusa se há dev server ou preview externo), proxy/auto-preview/
// preview-url (detecção e config de preview).
//
// Posse: projectOr404 (id) e, em auto-preview/preview-url, resolução por id OU
// slug SÓ entre projetos do dono (podeAcessarProjeto — W4/cross-tenant por slug).
// generateProjectScreenshot, getServableDir, autoDetectPreview, git e o objeto
// _devServers (içado ao topo) são injetados por referência — ficam no server.js.
// ═══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

/**
 * Monta as rotas de preview de um projeto (`/api/projects/:id/*`): thumbnail e
 * screenshot, visual-save (edição visual → escrita atômica + git) e
 * proxy/auto-preview/preview-url (detecção e config de preview).
 *
 * @param {import('express').Express} app - App do Express onde as rotas são montadas.
 * @param {object} deps - Dependências injetadas pelo server.js (composition root).
 * @param {import('express').RequestHandler} deps.authMiddleware - Guarda de sessão; exige usuário logado.
 * @param {import('express').RequestHandler} deps.limiteSensivel - Rate limit mais apertado para rotas de escrita/custo.
 * @param {import('express').RequestHandler} deps.projectOr404 - Portão de dono (W1/IDOR): resolve `req.projeto` ou responde 404 se for de outro usuário.
 * @param {(proj: object, username: string) => boolean} deps.podeAcessarProjeto - O usuário pode acessar este projeto?
 * @param {() => object[]} deps.loadProjects - Lê a lista de projetos.
 * @param {(projs: object[]) => void} deps.saveProjects - Grava a lista de projetos.
 * @param {(id: string, patch: object) => object} deps.atualizarProjeto - Aplica um patch ao projeto no array real.
 * @param {(proj: object) => Promise<string>} deps.generateProjectScreenshot - Captura screenshot (fica no server.js com o pool de Chrome).
 * @param {(proj: object) => string} deps.getServableDir - Diretório servível do projeto (build ou raiz).
 * @param {(proj: object) => Promise<object>} deps.autoDetectPreview - Detecta automaticamente a URL/porta de preview.
 * @param {(args: string[], cwd: string) => string} deps.git - Executa git sem shell.
 * @param {Map<string,object>} deps._devServers - Map dos dev servers vivos por projeto.
 * @returns {void}
 */
function registrar(app, deps) {
  const {
    authMiddleware, limiteSensivel, projectOr404, podeAcessarProjeto,
    loadProjects, saveProjects, atualizarProjeto, generateProjectScreenshot,
    getServableDir, autoDetectPreview, git, _devServers,
  } = deps;

  app.post('/api/projects/:id/generate-thumbnail', authMiddleware, async (req, res) => {
    const proj = projectOr404(req, res); if (!proj) return;
    try {
      const thumbUrl = await generateProjectScreenshot(proj);
      if (thumbUrl) {
        // BUG DE PERSISTÊNCIA: `proj` vem do loadProjects() interno do
        // projectOr404 — NÃO é o mesmo objeto do array que se salva. Setar a
        // thumbnail nele e salvar outro array perdia a mudança (o PNG existia,
        // mas o projeto não sabia dele). Recarrega, acha e salva o objeto certo,
        // como o caminho automático já fazia.
        const projects = loadProjects();
        const alvo = projects.find(p => p.id === proj.id);
        if (alvo) { alvo.thumbnail = thumbUrl; saveProjects(projects); }
        return res.json({ ok: true, thumbnail: thumbUrl });
      }
      res.json({ ok: false, error: 'Screenshot nao disponivel' });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  // ─── Edição visual (salvar HTML editado no preview) ──────────────────────
  // O painel deixa o usuário ligar o "modo edição", clicar em qualquer texto do
  // preview e reescrever à mão (designMode no iframe). Ao salvar, o cliente manda
  // o HTML já limpo da página atual e nós gravamos EXATAMENTE no arquivo que o
  // preview serviu — resolvendo o caminho pela mesma regra da rota /preview
  // (getServableDir), então "o que você edita é o que foi mostrado".
  app.post('/api/projects/:id/visual-save', authMiddleware, limiteSensivel, async (req, res) => {
    const proj = projectOr404(req, res); if (!proj) return;

    // Só faz sentido em site estático servido de arquivo. Com dev server ou
    // preview externo, a página é renderizada em runtime — reescrever um arquivo
    // não teria efeito fiel (e nem sequer é o que está na tela).
    if (_devServers[proj.id] || (proj.previewUrl && /^https?:\/\//i.test(proj.previewUrl))) {
      return res.status(409).json({ error: 'A edição visual só funciona em sites estáticos (sem servidor de dev).' });
    }

    const { path: relBruto, html } = req.body || {};
    if (typeof html !== 'string' || !html.trim()) return res.status(400).json({ error: 'HTML vazio.' });
    if (html.length > 8 * 1024 * 1024) return res.status(413).json({ error: 'Página grande demais para salvar.' });

    const servableDir = path.resolve(getServableDir(proj.path));

    // Normaliza o caminho vindo do iframe (só a página, sem query/hash).
    let rel = String(relBruto || '/index.html');
    try { rel = decodeURIComponent(rel); } catch {}
    rel = rel.split('?')[0].split('#')[0];
    if (!rel || rel === '/') rel = '/index.html';
    if (!rel.startsWith('/')) rel = '/' + rel;

    // Confinar dentro do servableDir; resolve `..`/symlink e exige .html.
    const resolved = path.resolve(path.join(servableDir, rel));
    if (resolved !== servableDir && !resolved.startsWith(servableDir + path.sep)) {
      return res.status(403).json({ error: 'Caminho fora do projeto.' });
    }
    if (!/\.html?$/i.test(resolved)) {
      return res.status(400).json({ error: 'Só páginas .html podem ser editadas visualmente.' });
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return res.status(404).json({ error: 'Arquivo da página não encontrado.' });
    }

    try {
      // Ponto de desfazer: guarda a última versão ao lado (.zbak).
      try { fs.copyFileSync(resolved, resolved + '.zbak'); } catch {}
      // Escrita atômica: grava no tmp e renomeia (rename é atômico no mesmo FS).
      const tmp = resolved + '.tmp-' + process.pid + '-' + Date.now();
      fs.writeFileSync(tmp, html);
      fs.renameSync(tmp, resolved);
      // Versiona no git do projeto, se houver (igual /api/fs/write).
      const gitDir = (function achar(d) {
        if (fs.existsSync(path.join(d, '.git'))) return d;
        const pai = path.dirname(d);
        return pai !== d ? achar(pai) : null;
      })(path.dirname(resolved));
      if (gitDir) {
        try {
          const rf = path.relative(gitDir, resolved);
          git(['add', rf], gitDir);
          git(['commit', '-m', 'Edição visual: ' + rf], gitDir);
        } catch {}
      }
      res.json({ ok: true, path: path.relative(proj.path, resolved) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/projects/:id/screenshot', authMiddleware, async (req, res) => {
    const proj = projectOr404(req, res); if (!proj) return;

    const thumbUrl = await generateProjectScreenshot(proj);
    if (thumbUrl) {
      atualizarProjeto(proj.id, { thumbnail: thumbUrl });   // S1-2 (era proj órfão + saveProjects)
      res.json({ ok: true, thumbnail: thumbUrl });
    } else {
      res.json({ ok: false, message: 'No preview available' });
    }
  });

  app.post('/api/projects/:id/proxy', authMiddleware, (req, res) => {
    const proj = projectOr404(req, res); if (!proj) return;

    if (req.body.proxyTarget) {
      // Manual set (S1-2: era proj órfão + saveProjects, não persistia)
      proj.proxyTarget = req.body.proxyTarget;
      atualizarProjeto(proj.id, { proxyTarget: proj.proxyTarget });
      return res.json({ ok: true, proxyTarget: proj.proxyTarget });
    }
  
    // Auto-detect
    let detected = null;
    if (proj.path) {
      try {
        const nginxPath = path.join(proj.path, 'nginx.conf');
        if (fs.existsSync(nginxPath)) {
          const content = fs.readFileSync(nginxPath, 'utf8');
          const m = content.match(/proxy_pass\s+http:\/\/([^;\s]+)/);
          if (m) detected = 'http://' + m[1];
        }
        if (!detected) {
          const dcPaths = ['docker-compose.yaml', 'docker-compose.yml'].map(f => path.join(proj.path, f));
          for (const p of dcPaths) {
            if (fs.existsSync(p)) {
              const content = fs.readFileSync(p, 'utf8');
              const pm = content.match(/(\d{4,5}):(?:80|443|3000|8080)/);
              if (pm) { detected = 'http://localhost:' + pm[1]; break; }
            }
          }
        }
      } catch {}
    }
  
    if (detected) {
      proj.proxyTarget = detected;
      atualizarProjeto(proj.id, { proxyTarget: detected });   // S1-2
    }
    res.json({ ok: true, proxyTarget: detected || proj.proxyTarget || null });
  });


  // ─── Auto-detect Preview URL ───────────────────────────────────────
  app.post('/api/projects/:id/auto-preview', authMiddleware, async (req, res) => {
    const projects = loadProjects();
    // Resolve por id OU slug, mas SÓ entre os projetos do dono — antes, o slug
    // de outro tenant era uma porta de entrada que o :id não era.
    const proj = projects.find(p => (p.id === req.params.id || p.slug === req.params.id)
                                   && podeAcessarProjeto(p, req.user && req.user.user));
    if (!proj) return res.status(404).json({ error: 'Projeto nao encontrado' });

    const detected = await autoDetectPreview(proj);
    if (detected) {
      proj.previewUrl = detected.url;
      proj.previewType = detected.type;
      saveProjects(projects);
    }
    res.json({ ok: true, previewUrl: detected ? detected.url : proj.previewUrl, type: detected ? detected.type : 'unknown' });
  });

  // Manual preview URL configuration
  app.post('/api/projects/:id/preview-url', authMiddleware, (req, res) => {
    const { previewUrl } = req.body;
    if (!previewUrl) return res.status(400).json({ error: 'previewUrl required' });
    const projects = loadProjects();
    // Resolve por id OU slug, mas SÓ entre os projetos do dono — antes, o slug
    // de outro tenant era uma porta de entrada que o :id não era.
    const proj = projects.find(p => (p.id === req.params.id || p.slug === req.params.id)
                                   && podeAcessarProjeto(p, req.user && req.user.user));
    if (!proj) return res.status(404).json({ error: 'Projeto nao encontrado' });
    proj.previewUrl = previewUrl;
    proj.previewType = 'manual';
    saveProjects(projects);
    res.json({ ok: true, previewUrl });
  });
}

module.exports = { registrar };
