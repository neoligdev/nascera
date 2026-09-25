// ═══════════════════════════════════════════════════════════════════════
// NASCERA — Roteador de sites por Host (domínio personalizado)
//
// Middleware único usado pelo servidor principal E pelo publish-server:
// se o Host da requisição casa com um domínio ATIVO, serve o site publicado
// daquele projeto na raiz ("/"), como se fosse o site dele mesmo.
//
// Cuidados que este arquivo assume para si:
//  - Path traversal: resolve o caminho e exige que ele fique DENTRO da pasta
//    publicada (comparando com separador, senão "/pub-evil" passaria por
//    "/pub"). Também recusa bytes nulos e desiste de URLs mal-encodadas.
//  - Só serve domínio ATIVO. Pendente/erro cai no próximo middleware.
//  - index.html não é cacheado (o cliente republica e quer ver na hora);
//    assets ganham cache longo.
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

function createHostRouter({ domains, loadProjects, log }) {
  return function hostRouter(req, res, next) {
    let rec = null;
    try { rec = domains.findByHost(req.headers.host); } catch { rec = null; }
    if (!rec) return next();

    const projects = loadProjects();
    const proj = projects.find(p => p.id === rec.projectId) || projects.find(p => p.slug === rec.slug);
    if (!proj || !proj.publishedPath) {
      return res.status(404).type('html').send(pageNotPublished(rec.domain));
    }
    const baseDir = path.resolve(proj.publishedPath);
    if (!fs.existsSync(baseDir)) {
      return res.status(404).type('html').send(pageNotPublished(rec.domain));
    }

    // caminho pedido → caminho real, sem escapar da pasta publicada
    let rel;
    try { rel = decodeURIComponent(req.path); } catch { return res.status(400).send('URL inválida'); }
    if (rel.indexOf('\0') !== -1) return res.status(400).send('URL inválida');
    if (rel === '/' || rel === '') rel = '/index.html';

    const full = path.resolve(baseDir, '.' + rel);
    if (full !== baseDir && !full.startsWith(baseDir + path.sep)) {
      return res.status(403).send('Acesso negado');
    }

    const sendIt = (file, isIndex) => {
      res.set('Cache-Control', isIndex ? 'no-cache' : 'public, max-age=3600');
      res.set('X-Content-Type-Options', 'nosniff');
      return res.sendFile(file);
    };

    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        return sendIt(full, full.endsWith('index.html'));
      }
      // diretório com index (ex.: /sobre/)
      const dirIndex = path.join(full, 'index.html');
      if (fs.existsSync(dirIndex) && fs.statSync(dirIndex).isFile()) {
        return sendIt(dirIndex, true);
      }
      // fallback de SPA
      const spa = path.join(baseDir, 'index.html');
      if (fs.existsSync(spa)) return sendIt(spa, true);
    } catch (err) {
      if (log) log('[dominio] erro servindo ' + rec.domain + ': ' + err.message);
      return res.status(500).send('Erro ao servir o site');
    }
    // Sem index.html na raiz: a pasta existe mas nada foi publicado ainda.
    // O dono do domínio merece saber disso, não um "404" seco.
    if (!fs.existsSync(path.join(baseDir, 'index.html'))) {
      return res.status(404).type('html').send(pageNotPublished(rec.domain));
    }
    return res.status(404).send('Arquivo não encontrado');
  };
}

// Página amigável: o domínio já aponta pra cá, mas o site ainda não foi publicado
function pageNotPublished(domain) {
  return `<!doctype html><meta charset="utf-8">
<title>Site ainda não publicado</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#08060f;
       color:#fff;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .c{text-align:center;padding:40px;max-width:460px}
  h1{font-size:19px;font-weight:600;margin:0 0 10px}
  p{color:rgba(255,255,255,.45);margin:0;font-size:13.5px}
  code{background:rgba(255,255,255,.06);padding:2px 7px;border-radius:5px;font-size:12.5px}
</style>
<div class="c">
  <h1>Quase lá 🚀</h1>
  <p>O domínio <code>${String(domain).replace(/[<>&"]/g, '')}</code> já está apontado corretamente,
  mas o site ainda não foi publicado. Publique o projeto no painel e recarregue esta página.</p>
</div>`;
}

module.exports = { createHostRouter };
