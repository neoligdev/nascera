// ═══════════════════════════════════════════════════════════════════════
// NASCERA — editor de arquivos (S4: extraído do server.js)
//
// As 6 rotas /api/fs/* (list, read, write, create, delete, rename) e o portão
// que as protege. Sub-sistema fechado: os helpers só existem para estas rotas.
//
// Segurança (por que este portão importa tanto):
//   • caminhoDoEditor — todo caminho LOCAL tem de resolver DENTRO de um projeto
//     do próprio usuário; `realpath` neutraliza `..` e symlink. Sem ele,
//     qualquer usuário logado lia/gravava qualquer arquivo do host.
//   • getRemoteInfo — para projeto REMOTO (VPS), só resolve credencial de
//     projeto que o usuário pode acessar (S0-1: era cross-tenant).
//
// Coberto por testes/rotas-autorizacao.js (S0-1: usuário comum não lista nem
// lê arquivo de projeto alheio → 403).
// ═══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

/**
 * Monta o editor de arquivos (`/api/fs/*`): list, read, write, create, delete e
 * rename — mais o portão `caminhoDoEditor`, que exige que todo caminho local
 * resolva DENTRO de um projeto do próprio usuário (`realpath` neutraliza `..` e
 * symlink). Projetos remotos passam por `getRemoteInfo`, que só resolve
 * credencial de projeto que o usuário pode acessar (S0-1: era cross-tenant).
 *
 * @param {import('express').Express} app - App do Express onde as rotas são montadas.
 * @param {object} deps - Dependências injetadas pelo server.js (composition root).
 * @param {import('express').RequestHandler} deps.authMiddleware - Guarda de sessão; exige usuário logado.
 * @param {() => object[]} deps.loadProjects - Lê a lista de projetos.
 * @param {(proj: object, username: string) => boolean} deps.podeAcessarProjeto - O usuário pode acessar este projeto?
 * @param {(proj: object) => string} deps.senhaSshDoProjeto - Resolve a senha SSH de um projeto remoto.
 * @param {(username: string) => object[]} deps.projetosDoUsuario - Lista os projetos do dono.
 * @param {(username: string) => boolean} deps.ehAdmin - O usuário é admin?
 * @param {string} deps.PROJECTS_BASE - Raiz da área de projetos.
 * @param {(creds: object, cmd: string, timeout?: number) => Promise<string>} deps.sshExec - Executa um comando via SSH em projeto remoto.
 * @param {(err: Error) => string} deps.sshErrorMessage - Traduz um erro de SSH para mensagem de tela.
 * @param {(args: string[], cwd: string) => string} deps.git - Executa git sem shell.
 * @returns {void}
 */
function registrar(app, deps) {
  const {
    authMiddleware, loadProjects, podeAcessarProjeto, senhaSshDoProjeto,
    projetosDoUsuario, ehAdmin, PROJECTS_BASE, sshExec, sshErrorMessage, git,
  } = deps;

  function getRemoteInfo(requestPath, username) {
    // BYPASS CROSS-TENANT (S0-1): antes esta função varria TODOS os projetos e
    // casava só pelo prefixo do path, SEM olhar o dono — e as rotas /api/fs/*
    // a chamam ANTES do portão `caminhoDoEditor`, com `return` dentro. Logo,
    // qualquer usuário logado que soubesse (ou adivinhasse) o path de um projeto
    // remoto de OUTRO cliente lia e escrevia arquivo como root no VPS dele, e o
    // portão nem era alcançado. Agora só casa projeto que o usuário pode acessar.
    // `username` é obrigatório: sem ele, fail-closed (não resolve remoto nenhum).
    if (!username) return null;
    const projects = loadProjects();
    for (const p of projects) {
      if (!podeAcessarProjeto(p, username)) continue;
      if (p.isRemote && p.remoteHost && p.path && requestPath.startsWith(p.path)) {
        const creds = {
          host: p.remoteHost,
          port: p.remotePort || 22,
          user: p.remoteUser || 'root',
          password: senhaSshDoProjeto(p) || '',
        };
        const relativePath = requestPath.substring(p.path.length) || '';
        const remotePath = relativePath || '/';
        return { creds, remotePath, project: p };
      }
    }
    return null;
  }

  // ─── Guarda do editor de arquivos ───────────────────────────────────
  // Antes disto, /api/fs/* aceitava QUALQUER caminho absoluto do cliente:
  // qualquer usuário logado lia e gravava qualquer arquivo do host — senhas,
  // código-fonte, .credenciais.json, e os projetos de OUTROS clientes. Agora
  // todo caminho local tem de resolver DENTRO de um projeto que o usuário é
  // dono. Resolve `realpath` para que `..` e symlink não escapem do root.
  function realpathMaisProfundo(abs) {
    let existente = abs; const extra = [];
    while (!fs.existsSync(existente)) {
      extra.unshift(path.basename(existente));
      const pai = path.dirname(existente);
      if (pai === existente) break;
      existente = pai;
    }
    let base; try { base = fs.realpathSync(existente); } catch { base = existente; }
    return extra.length ? path.join(base, ...extra) : base;
  }
  function rootsDoEditor(username) {
    // Set: `path` e `publishedPath` frequentemente resolvem para o mesmo lugar,
    // e raiz repetida vira pasta duplicada na árvore do editor.
    const roots = new Set();
    const juntar = (cand) => {
      if (!cand) return;
      try { roots.add(fs.realpathSync(cand)); } catch { roots.add(path.resolve(cand)); }
    };
    for (const p of projetosDoUsuario(username)) { juntar(p.path); juntar(p.publishedPath); }
    // Admin enxerga a área de projetos inteira (browse do painel).
    if (ehAdmin(username)) juntar(PROJECTS_BASE);
    return [...roots];
  }
  // Devolve o caminho absoluto seguro, ou null se estiver fora de todo projeto
  // do usuário. Serve para ler, gravar, criar, apagar e renomear.
  function caminhoDoEditor(fpPedido, username) {
    if (!fpPedido || typeof fpPedido !== 'string') return null;
    const roots = rootsDoEditor(username);
    if (!roots.length) return null;
    const abs = realpathMaisProfundo(path.resolve(fpPedido));
    return roots.some(r => abs === r || abs.startsWith(r + path.sep)) ? abs : null;
  }
  const FS_FORA = { error: 'Acesso negado: o caminho está fora dos seus projetos.' };

  app.get('/api/fs/list', authMiddleware, async (req, res) => {
    // Sem caminho, lista os projetos do usuário como raízes — em vez do antigo
    // default '/root', que abria o disco inteiro para navegação.
    if (!req.query.path) {
      const roots = rootsDoEditor(req.user.user)
        .map(r => { try { return { name: path.basename(r), path: r, isDir: true, size: 0 }; } catch { return null; } })
        .filter(Boolean);
      return res.json(roots);
    }
    const dirPath = req.query.path;
    const remote = getRemoteInfo(dirPath, req.user.user);

    if (remote) {
      try {
        const output = await sshExec(remote.creds, "ls -la --time-style=long-iso '" + remote.remotePath.replace(/'/g, "'\\''") + "' 2>/dev/null");
        const entries = (output || '').split('\n').filter(l => l && !l.startsWith('total')).map(line => {
          const parts = line.split(/\s+/);
          if (parts.length < 8) return null;
          const perms = parts[0];
          const size = parseInt(parts[4]) || 0;
          const name = parts.slice(7).join(' ');
          if (!name || name === '.' || name === '..' || name.startsWith('.')) return null;
          const isDir = perms.startsWith('d');
          return { name, path: path.join(dirPath, name), isDir, size };
        }).filter(Boolean).sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return res.json(entries);
      } catch (err) {
        return res.status(500).json({ error: 'SSH error: ' + err.message });
      }
    }

    // Local filesystem
    const seguro = caminhoDoEditor(dirPath, req.user.user);
    if (!seguro) return res.status(403).json(FS_FORA);
    try {
      if (!fs.existsSync(seguro) || !fs.statSync(seguro).isDirectory()) {
        return res.status(404).json({ error: 'Diretorio nao encontrado' });
      }
      const entries = fs.readdirSync(seguro, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.'))
        .map(e => ({
          name: e.name,
          path: path.join(seguro, e.name),
          isDir: e.isDirectory(),
          size: e.isFile() ? (function() { try { return fs.statSync(path.join(seguro, e.name)).size; } catch { return 0; } })() : 0,
        }))
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      res.json(entries);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Read file
  app.get('/api/fs/read', authMiddleware, async (req, res) => {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'Path obrigatorio' });

    const remote = getRemoteInfo(filePath, req.user.user);
    if (remote) {
      try {
        const content = await sshExec(remote.creds, "cat '" + remote.remotePath.replace(/'/g, "'\\''") + "'");
        const ext = path.extname(filePath).substring(1);
        return res.json({ content: content || '', path: filePath, size: (content || '').length, ext });
      } catch (err) {
        return res.status(500).json({ error: sshErrorMessage(err) });
      }
    }

    const seguro = caminhoDoEditor(filePath, req.user.user);
    if (!seguro) return res.status(403).json(FS_FORA);
    try {
      if (!fs.existsSync(seguro)) return res.status(404).json({ error: 'Arquivo nao encontrado' });
      const stat = fs.statSync(seguro);
      if (stat.size > 2 * 1024 * 1024) return res.status(413).json({ error: 'Arquivo muito grande (max 2MB)' });
      const content = fs.readFileSync(seguro, 'utf8');
      const ext = path.extname(seguro).substring(1);
      res.json({ content, path: seguro, size: stat.size, ext });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Write file
  app.post('/api/fs/write', authMiddleware, async (req, res) => {
    const { filePath: fp, content: c } = req.body;
    if (!fp) return res.status(400).json({ error: 'Path obrigatorio' });

    const remote = getRemoteInfo(fp, req.user.user);
    if (remote) {
      try {
        const b64 = Buffer.from(c || '').toString('base64');
        const remoteDir = path.dirname(remote.remotePath).replace(/'/g, "'\\''");
        const remoteFile = remote.remotePath.replace(/'/g, "'\\''");
        await sshExec(remote.creds, "mkdir -p '" + remoteDir + "' && echo " + b64 + " | base64 -d > '" + remoteFile + "'");
        return res.json({ ok: true, path: fp });
      } catch (err) {
        return res.status(500).json({ error: sshErrorMessage(err) });
      }
    }

    const seguro = caminhoDoEditor(fp, req.user.user);
    if (!seguro) return res.status(403).json(FS_FORA);
    try {
      const dir = path.dirname(seguro);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(seguro, c || '');
      // Auto-commit if inside a git project
      const gitCheck = (function findGit(d) {
        if (fs.existsSync(path.join(d, '.git'))) return d;
        const parent = path.dirname(d);
        return parent !== d ? findGit(parent) : null;
      })(dir);
      if (gitCheck) {
        try {
          const relFile = path.relative(gitCheck, seguro);
          git(['add', relFile], gitCheck);
          git(['commit', '-m', 'Editado: ' + relFile], gitCheck);
        } catch(e) {}
      }
      res.json({ ok: true, path: seguro });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create file or directory
  app.post('/api/fs/create', authMiddleware, (req, res) => {
    const { filePath: fp, isDir } = req.body;
    if (!fp) return res.status(400).json({ error: 'Path obrigatorio' });
    const seguro = caminhoDoEditor(fp, req.user.user);
    if (!seguro) return res.status(403).json(FS_FORA);
    try {
      if (isDir) {
        fs.mkdirSync(seguro, { recursive: true });
      } else {
        const dir = path.dirname(seguro);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(seguro)) fs.writeFileSync(seguro, '');
      }
      res.json({ ok: true, path: seguro });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete file or directory
  app.delete('/api/fs/delete', authMiddleware, (req, res) => {
    const fp = req.query.path;
    if (!fp) return res.status(400).json({ error: 'Path obrigatorio' });
    const seguro = caminhoDoEditor(fp, req.user.user);
    if (!seguro) return res.status(403).json(FS_FORA);
    try {
      if (!fs.existsSync(seguro)) return res.status(404).json({ error: 'Nao encontrado' });
      fs.rmSync(seguro, { recursive: true, force: true });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Rename/move — as DUAS pontas precisam estar dentro dos projetos do usuário,
  // senão daria para mover um arquivo do projeto para cima de /etc/qualquer.
  app.post('/api/fs/rename', authMiddleware, (req, res) => {
    const { oldPath, newPath } = req.body;
    if (!oldPath || !newPath) return res.status(400).json({ error: 'Paths obrigatorios' });
    const de = caminhoDoEditor(oldPath, req.user.user);
    const para = caminhoDoEditor(newPath, req.user.user);
    if (!de || !para) return res.status(403).json(FS_FORA);
    try {
      fs.renameSync(de, para);
      res.json({ ok: true, path: para });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registrar };
