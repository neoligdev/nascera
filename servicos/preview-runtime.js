// ═══════════════════════════════════════════════════════════════════════
// NASCERA — runtime de preview (S4-2: extraído do server.js)
//
// Dois helpers de runtime que NÃO são rota: generateProjectScreenshot (sobe um
// Chromium via puppeteer-core, com teto de concorrência próprio) e startDevServer
// (npm/yarn/pnpm run <script> e espera a porta). Fábrica `criar(deps)` que fecha
// sobre as deps do server (RAIZ, ticketDePreview, loadProjects/saveProjects e o
// objeto devServers compartilhado) — o server injeta e usa os dois por referência.
// O semáforo de Chromium (NASCERA_MAX_CHROME, padrão 2) é privado deste módulo.
// Coberto de ponta a ponta pelo build/chat real via test:fake (o evento 'result'
// dispara generateProjectScreenshot).
// ═══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const logger = require('../log.js');
const path = require('path');
const { Semaphore } = require('async-mutex');
const so = require('./so.js');
const { spawn } = require('child_process');

function criar(deps) {
  const { RAIZ, ticketDePreview, loadProjects, saveProjects, devServers, sshExec, senhaSshDoProjeto } = deps;
  const chromeSem = new Semaphore(Math.max(1, Number(process.env.NASCERA_MAX_CHROME) || 2));

  async function generateProjectScreenshot(proj) {
    if (!proj.slug) return null;

    const thumbDir = path.join(RAIZ, 'public', 'thumbnails');
    if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });
    const thumbPath = path.join(thumbDir, `project_${proj.slug}.png`);

    // Determine preview URL
    const port = process.env.PORT || 3333;
    const base = `http://127.0.0.1:${port}`;
    // O preview interno (/preview/<slug>/) passou a exigir ticket assinado
    // (correção de segurança). Sem ticket, ele responde 404 — e era por isso
    // que a miniatura dos projetos novos parava de ser gerada. O gerador roda
    // no servidor e é confiável, então emite um ticket em nome do dono.
    const ticketar = (u) => {
      const m = String(u).match(/^\/preview\/([^/~]+)(\/.*)?$/);
      if (!m) return u;
      const tk = ticketDePreview(m[1], proj.owner || '');
      return '/preview/' + m[1] + '~' + tk + (m[2] || '/');
    };
    let previewUrl = proj.previewUrl;
    if (previewUrl && previewUrl.startsWith('/preview/')) {
      previewUrl = base + ticketar(previewUrl);
    } else if (previewUrl && previewUrl.startsWith('/')) {
      previewUrl = base + previewUrl;
    } else if (!previewUrl) {
      previewUrl = base + ticketar(`/preview/${proj.slug}/`);
    }

    try {
      // Check if preview responds
      const check = await new Promise((resolve) => {
        require('http').get(previewUrl, (res) => resolve(res.statusCode === 200)).on('error', () => resolve(false));
      });
      if (!check) { logger.info(`[SCREENSHOT] Preview not responding: ${previewUrl}`); return null; }

      // Mesmo resolvedor do extrator: um lugar só para achar navegador.
      const { opcoesDeLaunch } = require('../tools/chrome.js');
      let opcoes;
      try { opcoes = opcoesDeLaunch(); }
      catch (e) { logger.info('[SCREENSHOT] ' + e.message.split('\n')[0]); return null; }

      const puppeteer = require('puppeteer-core');
      // S2-3: cap de concorrência. Cada screenshot sobe um Chromium inteiro;
      // sem limite, gerar as miniaturas de N projetos de uma vez (o /generate-all)
      // subia N navegadores juntos e estourava a RAM. O semáforo enfileira: no
      // máximo NASCERA_MAX_CHROME simultâneos (padrão 2). E o browser.close() vai
      // para o finally — antes ele ficava fora do try e vazava se a foto falhasse.
      const [, liberar] = await chromeSem.acquire();
      let browser = null;
      try {
        browser = await puppeteer.launch(opcoes);
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
        // domcontentloaded (não networkidle2): sites com analytics/polling nunca
        // ficam com a rede quieta e estouravam o timeout. Um pequeno assentamento
        // dá tempo do layout pintar antes da foto.
        try { await page.goto(previewUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }); }
        catch (e) { logger.info('[SCREENSHOT] carga demorou: ' + e.message); }
        await new Promise((r) => setTimeout(r, 1200));
        await page.screenshot({ path: thumbPath, type: 'png' });
      } finally {
        if (browser) { try { await browser.close(); } catch {} }
        liberar();
      }

      const thumbUrl = `/thumbnails/project_${proj.slug}.png`;
      logger.info(`[SCREENSHOT] Generated: ${thumbUrl}`);

      // Update project thumbnail
      const projects = loadProjects();
      const p = projects.find(x => x.id === proj.id);
      if (p) { p.thumbnail = thumbUrl; saveProjects(projects); }

      return thumbUrl;
    } catch (err) {
      logger.error(`[SCREENSHOT] Failed for ${proj.slug}:`, err.message);
      return null;
    }
  }

  async function startDevServer(proj, scriptName) {
    if (devServers[proj.id]) return devServers[proj.id].port; // Already running

    const projPath = proj.path;
    const portCandidate = 3000 + Math.floor(Math.random() * 1000);

    try {
      // Check if npm/yarn/pnpm
      const hasYarn = fs.existsSync(path.join(projPath, 'yarn.lock'));
      const hasPnpm = fs.existsSync(path.join(projPath, 'pnpm-lock.yaml'));
      const runner = hasPnpm ? 'pnpm' : hasYarn ? 'yarn' : 'npm';

      const isDesktop = process.env.NASCERA_DESKTOP === 'true' || process.platform === 'darwin' || process.platform === 'win32';
      const env = { ...process.env, PORT: String(portCandidate), BROWSER: 'none', NO_COLOR: '1' };

      logger.info(`[DEV-SERVER] Starting ${runner} run ${scriptName} for ${proj.name} on port ${portCandidate}`);

      const proc = spawn(runner, ['run', scriptName], {
        cwd: projPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env,
        shell: true,
        detached: false,
      });

      devServers[proj.id] = { proc, port: portCandidate };

      proc.stdout.on('data', (d) => {
        const text = d.toString();
        // Detect actual port from output (Next.js, Vite, etc print it)
        const portMatch = text.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{4,5})/);
        if (portMatch) {
          const realPort = parseInt(portMatch[1]);
          if (realPort !== portCandidate) {
            devServers[proj.id].port = realPort;
            logger.info(`[DEV-SERVER] ${proj.name} actual port: ${realPort}`);
          }
        }
      });
      proc.stderr.on('data', (d) => {
        const text = d.toString();
        const portMatch = text.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{4,5})/);
        if (portMatch) {
          devServers[proj.id].port = parseInt(portMatch[1]);
        }
      });

      proc.on('exit', () => {
        logger.info(`[DEV-SERVER] ${proj.name} exited`);
        delete devServers[proj.id];
      });

      // Wait for server to be ready (up to 30s)
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const port = devServers[proj.id]?.port || portCandidate;
        try {
          await new Promise((resolve, reject) => {
            const req = require('http').get('http://localhost:' + port, (res) => { resolve(res.statusCode); });
            req.on('error', reject);
            req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
          });
          logger.info(`[DEV-SERVER] ${proj.name} ready on port ${port}`);
          return port;
        } catch {}
      }

      logger.info(`[DEV-SERVER] ${proj.name} timeout waiting for port`);
      return portCandidate; // Return anyway, might work
    } catch (err) {
      logger.error(`[DEV-SERVER] Failed to start for ${proj.name}:`, err.message);
      return null;
    }
  }

  async function autoDetectPreview(proj) {
    const projPath = proj.path;
    if (!projPath) return null;

    // 1. Static index.html → serve via preview-server
    if (fs.existsSync(path.join(projPath, 'index.html'))) {
      // Ensure symlink exists in preview-server public dir
      const linkPath = path.join(RAIZ, '_published', proj.slug);
      if (!fs.existsSync(linkPath)) {
        try { fs.symlinkSync(projPath, linkPath); } catch {}
      }
      return { url: '/preview/' + proj.slug + '/', type: 'static' };
    }

    // 2. package.json → check for dev server
    const pkgPath = path.join(projPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const scripts = pkg.scripts || {};
        // Já tem dev server de pé em alguma porta conhecida?
        // Era `lsof -i :PORTA` num laço — QUINZE processos por preview, e no
        // Windows quinze falhas silenciosas seguidas. Agora é uma sondagem de
        // conexão, em paralelo e neutra de plataforma: além de funcionar nos
        // três sistemas, ela responde a pergunta certa (alguém ACEITA conexão
        // aqui?) em vez de "alguém abriu esta porta".
        const ports = [3000, 3001, 3456, 3500, 4000, 4200, 4321, 5000, 5173, 5174, 5500, 8000, 8080, 8888, 9000];
        const emUso = await so.primeiraPortaEmUso(ports);
        if (emUso) return { url: 'http://localhost:' + emUso, type: 'dev-server' };
        // Has start/dev script but not running → start it automatically
        if (scripts.dev || scripts.start || scripts.serve) {
          const scriptName = scripts.dev ? 'dev' : scripts.start ? 'start' : 'serve';
          const devPort = await startDevServer(proj, scriptName);
          if (devPort) {
            return { url: 'http://localhost:' + devPort, type: 'dev-server' };
          }
          return { url: null, type: 'startable', script: scriptName };
        }
      } catch {}
    }

    // 3. Docker compose → detect mapped ports
    for (const dcName of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
      const dcPath = path.join(projPath, dcName);
      if (fs.existsSync(dcPath)) {
        try {
          const content = fs.readFileSync(dcPath, 'utf8');
          const portMatch = content.match(/(d{4,5}):(80|443|3000|8080|8000)/);
          if (portMatch) {
            return { url: 'http://localhost:' + portMatch[1], type: 'docker' };
          }
        } catch {}
      }
    }

    // 4. Remote project via SSH → scan running services
    //
    // ERA RCE AUTENTICADO. O código montava a linha de comando concatenando as
    // credenciais do projeto:
    //     'sshpass -p "' + proj.remotePass + '" ssh ... ' + user + '@' + host
    // e passava para `execSync`, que abre um shell. Como essas três strings vêm
    // do corpo de /api/remote/connect, bastava cadastrar um projeto remoto com
    // senha `x"; comando; #` para fechar a aspa e executar o que quisesse na
    // máquina do NASCERA. Provado com canário antes de corrigir.
    //
    // Agora usa o `sshExec` que já existia neste arquivo: ssh2 puro, sem shell,
    // sem sshpass, com as credenciais entregues pela API da biblioteca — não há
    // linha de comando para injetar.
    if (proj.remoteHost) {
      try {
        const saida = await sshExec(
          { host: proj.remoteHost, port: proj.remotePort || 22, user: proj.remoteUser,
            password: senhaSshDoProjeto(proj) },
          'ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null',
          10000);
        // A regex antiga (/:(d+)s/) estava errada — faltava a barra invertida,
        // então procurava a letra "d" literal e nunca casava. Porta é \d+.
        const m = String(saida || '').match(/:(\d{2,5})\b/);
        if (m) return { url: 'http://' + proj.remoteHost + ':' + m[1], type: 'remote-service' };
      } catch (e) {
        logger.error('[preview] varredura remota falhou:', e.message);
      }
    }

    // 5. Check for common build outputs (dist/, build/, public/, out/)
    for (const dir of ['dist', 'build', 'public', 'out', '.next/static', '.output/public']) {
      const buildDir = path.join(projPath, dir);
      if (fs.existsSync(path.join(buildDir, 'index.html'))) {
        const linkPath = path.join(RAIZ, '_published', proj.slug);
        if (!fs.existsSync(linkPath)) {
          try { fs.symlinkSync(buildDir, linkPath); } catch {}
        }
        return { url: '/preview/' + proj.slug + '/', type: 'build-output' };
      }
    }

    return null;
  }

  return { generateProjectScreenshot, startDevServer, autoDetectPreview };
}

module.exports = { criar };
