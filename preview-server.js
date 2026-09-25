const express = require('express');
const logger = require('./log.js');
const path = require('path');
const fs = require('fs');
const { createProxyMiddleware } = require('http-proxy-middleware');

const PORT = process.env.PORT || 4001;
const PROJECTS_BASE = process.env.PROJECTS_BASE || '/root';
const PROJECTS_FILE = path.join(__dirname, 'projects.json');

const app = express();

function loadProjects() {
  try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')); }
  catch { return []; }
}

// Dynamic proxy cache for projects with proxyTarget
const proxyCache = new Map();
function getProxy(target, slug) {
  if (proxyCache.has(slug)) return proxyCache.get(slug);
  const mw = createProxyMiddleware({
    target: target,
    changeOrigin: true,
    pathRewrite: { ['^/' + slug]: '' },
    ws: true,
    onProxyRes: (proxyRes) => {
      // Remove headers that block iframe
      delete proxyRes.headers['x-frame-options'];
      delete proxyRes.headers['content-security-policy'];
    }
  });
  proxyCache.set(slug, mw);
  return mw;
}

// Detect the servable directory for a project
function getServableDir(projectPath) {
  const candidates = ['dist', 'build', 'out', 'public'];
  for (const dir of candidates) {
    const full = path.join(projectPath, dir);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      // Check it has an index.html
      if (fs.existsSync(path.join(full, 'index.html'))) return full;
    }
  }
  // Fallback: project root if it has index.html
  if (fs.existsSync(path.join(projectPath, 'index.html'))) return projectPath;
  // Last resort: project root anyway
  return projectPath;
}

// Route: /{slug}/* -> proxy or serve from project working directory
app.use('/:slug', (req, res, next) => {
  const slug = req.params.slug;
  const projects = loadProjects();
  const proj = projects.find(p => p.slug === slug);

  if (!proj || !proj.path) {
    return res.status(404).send('Projeto não encontrado');
  }

  // If project has proxyTarget, proxy the request
  if (proj.proxyTarget) {
    const proxy = getProxy(proj.proxyTarget, slug);
    return proxy(req, res, next);
  }

  const servableDir = getServableDir(proj.path);
  const filePath = req.path === '/' ? '/index.html' : req.path;
  const fullPath = path.join(servableDir, filePath);

  // Security: prevent directory traversal
  if (!fullPath.startsWith(servableDir)) {
    return res.status(403).send('Acesso negado');
  }

  // No cache for preview
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('X-Frame-Options', 'ALLOWALL');
  res.removeHeader('X-Frame-Options');

  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    return res.sendFile(fullPath);
  }

  // SPA fallback: serve index.html for non-file routes
  const indexPath = path.join(servableDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }

  res.status(404).send('Arquivo não encontrado');
});

// Mesma regra do servidor principal: só esta máquina por padrão. Expor
// para a rede é decisão explícita via NASCERA_BIND (caso da VPS).
const BIND = process.env.NASCERA_BIND
  || ((process.platform === 'darwin' || process.platform === 'win32') ? '127.0.0.1' : '0.0.0.0');

app.listen(PORT, BIND, () => {
  logger.info(`  📺  Preview Server running on port ${PORT}`);
});
