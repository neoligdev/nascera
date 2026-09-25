const express = require('express');
const logger = require('./log.js');
const path = require('path');
const fs = require('fs');

const domains = require('./domains');
const { createHostRouter } = require('./site-router');

const PORT = process.env.PORT || 4002;
const PUBLISHED_BASE = process.env.PUBLISHED_BASE || '/root/_published';
const PROJECTS_FILE = path.join(__dirname, 'projects.json');

const app = express();
app.disable('x-powered-by');

function loadProjects() {
  try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')); }
  catch { return []; }
}

// ── 1º: DOMÍNIO PERSONALIZADO ──
// Se o Host casa com um domínio ativo, o site é servido na raiz ("/"), como
// se este servidor fosse o dele. Só depois disso valem as rotas por slug.
app.use(createHostRouter({ domains, loadProjects, log: console.warn }));

// ── 2º: rota clássica por slug: /{slug}/* ──
app.use('/:slug', (req, res, next) => {
  const slug = req.params.slug;
  const projects = loadProjects();
  const proj = projects.find(p => p.slug === slug);

  if (!proj || !proj.publishedPath) {
    return res.status(404).send('Site não publicado');
  }

  const publishedDir = path.resolve(proj.publishedPath);

  if (!fs.existsSync(publishedDir)) {
    return res.status(404).send('Site ainda não foi publicado');
  }

  let rel;
  try { rel = decodeURIComponent(req.path); } catch { return res.status(400).send('URL inválida'); }
  if (rel.indexOf('\0') !== -1) return res.status(400).send('URL inválida');
  if (rel === '/' || rel === '') rel = '/index.html';

  const fullPath = path.resolve(publishedDir, '.' + rel);

  // Segurança: exige o separador, senão "/pub-evil" passaria por "/pub"
  if (fullPath !== publishedDir && !fullPath.startsWith(publishedDir + path.sep)) {
    return res.status(403).send('Acesso negado');
  }

  res.set('X-Content-Type-Options', 'nosniff');

  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    res.set('Cache-Control', fullPath.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600');
    return res.sendFile(fullPath);
  }

  // SPA fallback
  const indexPath = path.join(publishedDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.set('Cache-Control', 'no-cache');
    return res.sendFile(indexPath);
  }

  res.status(404).send('Arquivo não encontrado');
});

// Mesma regra do servidor principal: só esta máquina por padrão. Expor
// para a rede é decisão explícita via NASCERA_BIND (caso da VPS).
const BIND = process.env.NASCERA_BIND
  || ((process.platform === 'darwin' || process.platform === 'win32') ? '127.0.0.1' : '0.0.0.0');

app.listen(PORT, BIND, () => {
  logger.info(`  🌐  Publish Server running on port ${PORT}`);
  const ativos = domains.listAll().filter(d => d.status === 'ativo').length;
  logger.info(`  🔗  Domínios personalizados ativos: ${ativos}`);
});
