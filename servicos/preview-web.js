// ═══════════════════════════════════════════════════════════════════════
// NASCERA — servir preview e site publicado (S4-2: extraído do server.js)
//
// ticketDePreview/conferirTicket (HMAC por dono+slug+exp — W4) e os middlewares
// app.use('/preview/:slug') (com PORTÃO de ticket + posse, proxy p/ dev server, e
// servir estático confinado no servableDir) e app.use('/site/:slug') (publicado).
// registrar(app, deps) registra os middlewares e DEVOLVE ticketDePreview, que o
// server injeta no preview-runtime (screenshot) e na rota preview-ticket.
// ═══════════════════════════════════════════════════════════════════════
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function registrar(app, deps) {
  const { PREVIEW_TTL_MS, JWT_SECRET, loadUsers, loadProjects, podeAcessarProjeto, getServableDir, _devServers } = deps;

  function ticketDePreview(slug, username) {
    const exp = Date.now() + PREVIEW_TTL_MS;
    const assinatura = crypto.createHmac('sha256', JWT_SECRET)
      .update('preview:' + slug + ':' + username + ':' + exp).digest('hex').slice(0, 32);
    return exp.toString(36) + '.' + assinatura;
  }

  function conferirTicket(slug, ticket) {
    if (!ticket) return null;
    const [expB36, assinatura] = String(ticket).split('.');
    const exp = parseInt(expB36, 36);
    if (!exp || !assinatura || Date.now() > exp) return null;
    // Descobre QUAL usuário assinou: o ticket é por dono, então basta testar
    // contra os donos possíveis do slug (normalmente um só).
    for (const u of Object.keys(loadUsers())) {
      const esperado = crypto.createHmac('sha256', JWT_SECRET)
        .update('preview:' + slug + ':' + u + ':' + exp).digest('hex').slice(0, 32);
      const a = Buffer.from(assinatura), b = Buffer.from(esperado);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return u;
    }
    return null;
  }

  app.use('/preview/:slug', (req, res, next) => {
    // O segmento pode vir como "<slug>" ou "<slug>~<ticket>".
    const bruto = String(req.params.slug || '');
    const corte = bruto.lastIndexOf('~');
    const slug = corte > 0 ? bruto.slice(0, corte) : bruto;
    const ticket = corte > 0 ? bruto.slice(corte + 1) : null;

    const projects = loadProjects();
    const proj = projects.find(p => p.slug === slug);
    if (!proj || !proj.path) return res.status(404).send('Projeto não encontrado');

    // Portão: o ticket precisa ser válido E de alguém que pode ver o projeto.
    const doTicket = conferirTicket(slug, ticket);
    if (!doTicket || !podeAcessarProjeto(proj, doTicket)) {
      return res.status(404).send('Projeto não encontrado');
    }

    // Defesa em profundidade para a falha 2: mesmo servido daqui, o conteúdo
    // não pode ser enquadrado por outro site nem adivinhado por MIME.
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set('X-Content-Type-Options', 'nosniff');

    // If project has a dev server running, proxy to it
    if (_devServers[proj.id]) {
      const port = _devServers[proj.id].port;
      const targetUrl = 'http://localhost:' + port + req.path + (req._parsedUrl.search || '');
      return require('http').get(targetUrl, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      }).on('error', () => {
        res.status(502).send('Dev server nao respondeu na porta ' + port);
      });
    }

    // If previewUrl points to a localhost dev server
    if (proj.previewUrl && proj.previewUrl.startsWith('http://localhost')) {
      const targetUrl = proj.previewUrl + req.path + (req._parsedUrl.search || '');
      return require('http').get(targetUrl, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      }).on('error', () => {
        res.status(502).send('Dev server nao respondeu');
      });
    }

    const servableDir = getServableDir(proj.path);
    const filePath = req.path === '/' ? '/index.html' : req.path;
    const fullPath = path.join(servableDir, filePath);

    if (!fullPath.startsWith(servableDir)) return res.status(403).send('Acesso negado');

    res.set('Pragma', 'no-cache');

    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return res.sendFile(fullPath);
    }
    // SPA fallback
    const indexPath = path.join(servableDir, 'index.html');
    if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
    res.status(404).send('Arquivo não encontrado. Configure o preview nas configurações do projeto.');
  });

  // ─── Published Proxy (serves published files via same HTTPS domain) ─
  app.use('/site/:slug', (req, res, next) => {
    const slug = req.params.slug;
    const projects = loadProjects();
    const proj = projects.find(p => p.slug === slug);
    if (!proj || !proj.publishedPath) return res.status(404).send('Site não publicado');
    if (!fs.existsSync(proj.publishedPath)) return res.status(404).send('Site ainda não foi publicado');

    const filePath = req.path === '/' ? '/index.html' : req.path;
    const fullPath = path.join(proj.publishedPath, filePath);

    if (!fullPath.startsWith(proj.publishedPath)) return res.status(403).send('Acesso negado');

    res.set('Cache-Control', 'public, max-age=3600');

    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return res.sendFile(fullPath);
    }
    const indexPath = path.join(proj.publishedPath, 'index.html');
    if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
    res.status(404).send('Arquivo não encontrado');
  });

  return { ticketDePreview };
}

module.exports = { registrar };
