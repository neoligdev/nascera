// ═══════════════════════════════════════════════════════════════════════
// NASCERA — painel admin: dashboard/usuários/projetos/sessões/config/logs (S4)
// O grupo mais acoplado ao núcleo — recebe ~15 dependências por injeção.
// Coberto pelo smoke (/api/admin/overview, /users, /config).
// ═══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const logger = require('../log.js');
const path = require('path');
const so = require('../servicos/so.js');
const senhas = require('../senhas.js');

/**
 * Monta o painel admin (`/api/admin/*`): dashboard/overview, CRUD de usuários,
 * lista de projetos, sessões vivas, config e logs. É o grupo mais acoplado ao
 * núcleo — recebe ~15 dependências por injeção.
 *
 * @param {import('express').Express} app - App do Express onde as rotas são montadas.
 * @param {object} deps - Dependências injetadas pelo server.js (composition root).
 * @param {import('express').RequestHandler} deps.adminMiddleware - Guarda de admin; exige papel admin.
 * @param {() => Object<string,object>} deps.loadUsers - Lê o store de usuários.
 * @param {(users: Object<string,object>) => void} deps.saveUsers - Grava o store de usuários.
 * @param {() => object[]} deps.loadProjects - Lê a lista de projetos.
 * @param {() => object[]} deps.loadTrash - Lê a lixeira.
 * @param {() => Object<string,number>} deps.projectSizesKb - Tamanho (KB) de cada projeto, com cache.
 * @param {() => Promise<object>} deps.getEngine - Resolve o motor/`sessionManager` sob demanda.
 * @param {() => object} deps.readClaudeAuthStatus - Estado atual do login do Claude Code.
 * @param {number} deps.PORT - Porta em que o servidor escuta.
 * @param {string} deps.USERS - Caminho do arquivo de usuários.
 * @param {(evt: object) => void} deps.appendActivity - Registra um evento no log de atividade.
 * @param {() => object} deps.loadNasceraConfig - Lê a config global do Nascera.
 * @param {(cfg: object) => void} deps.saveNasceraConfig - Grava a config global.
 * @param {(v: unknown) => string} deps.normalizeBuildLevel - Normaliza o nível de build para um valor válido.
 * @param {string} deps.ACTIVITY_FILE - Caminho do arquivo de log de atividade.
 * @returns {void}
 */
function registrar(app, deps) {
  const {
    adminMiddleware, loadUsers, saveUsers, loadProjects, loadTrash, projectSizesKb,
    getEngine, readClaudeAuthStatus, PORT, USERS, appendActivity,
    loadNasceraConfig, saveNasceraConfig, normalizeBuildLevel, ACTIVITY_FILE,
  } = deps;

app.get('/api/admin/overview', adminMiddleware, async (_req, res) => {
  const users = loadUsers();
  const projects = loadProjects();
  const trash = loadTrash();
  const sizes = projectSizesKb();
  const totalKb = Object.values(sizes).reduce((a, b) => a + b, 0);
  const totalCost = projects.reduce((a, p) => a + (p.costUsd || 0), 0);

  let engine = { sessions: 0, running: 0, list: [] };
  try {
    const { sessionManager } = await getEngine();
    for (const [, s] of sessionManager.sessions) {
      engine.sessions++;
      if (s.running) engine.running++;
    }
  } catch {}

  const os = require('os');
  res.json({
    users: { total: Object.keys(users).length, admins: Object.values(users).filter(u => u.role === 'admin').length },
    projects: {
      total: projects.length,
      published: projects.filter(p => p.publishedVersion > 0).length,
      inTrash: trash.length,
      diskMb: Math.round(totalKb / 1024),
      totalCostUsd: totalCost,
    },
    engine,
    claude: readClaudeAuthStatus(5000),
    system: {
      nodeVersion: process.version,
      platform: process.platform + ' ' + os.release(),
      uptimeSec: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      loadAvg: os.loadavg().map(n => Math.round(n * 100) / 100),
      port: PORT,
    },
  });
});

// ── Usuários (enriquecidos; senha nunca sai daqui) ──
app.get('/api/admin/users', adminMiddleware, (_req, res) => {
  const users = loadUsers();
  res.json(Object.entries(users).map(([username, u]) => ({
    username, name: u.name || '', email: u.email || '',
    role: u.role || 'user', createdAt: u.createdAt || null,
    suspended: !!u.suspended, suspendedReason: u.suspendedReason || null,
    iaPropria: !!u.iaPropria,   // AD.1: usa a própria chave (isento de crédito)
  })));
});

app.post('/api/admin/users', adminMiddleware, async (req, res) => {
  const { username, password, name, email, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
  if (password.length < 6) return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' });
  const users = loadUsers();
  if (users[username]) return res.status(400).json({ error: 'Usuário já existe' });
  users[username] = {
    name: name || username, email: email || '', password: await senhas.criarHash(password),
    role: role === 'admin' ? 'admin' : 'user',
    createdAt: new Date().toISOString(),
  };
  saveUsers(users);
  appendActivity({ type: 'admin_user_created', user: req.user.user, data: { username }, at: new Date().toISOString() });
  res.json({ ok: true });
});

app.patch('/api/admin/users/:username', adminMiddleware, async (req, res) => {
  const users = loadUsers();
  const u = users[req.params.username];
  if (!u) return res.status(404).json({ error: 'Usuário não encontrado' });
  const { name, email, role, password } = req.body;
  if (name !== undefined) u.name = name;
  if (email !== undefined) u.email = email;
  if (role !== undefined) {
    // nunca deixa o sistema sem nenhum admin
    if (u.role === 'admin' && role !== 'admin') {
      const admins = Object.values(users).filter(x => x.role === 'admin').length;
      if (admins <= 1) return res.status(400).json({ error: 'Não é possível rebaixar o único admin' });
    }
    u.role = role === 'admin' ? 'admin' : 'user';
  }
  if (password) {
    if (password.length < 6) return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' });
    u.password = await senhas.criarHash(password);
    delete USERS[req.params.username];   // invalida cache em memória do login
  }
  // A0.2: suspender ≠ excluir. Projetos e dados ficam intactos; o acesso é
  // negado ao vivo (login, authMiddleware e WebSocket conferem a flag).
  if (req.body.suspended !== undefined) {
    if (req.params.username === req.user.user) {
      return res.status(400).json({ error: 'Você não pode suspender a si mesmo' });
    }
    if (req.body.suspended) {
      u.suspended = true;
      u.suspendedReason = String(req.body.suspendedReason || '').slice(0, 300) || null;
      u.suspendedAt = new Date().toISOString();
      // A1 (opcional): o cliente sabe o porquê e o caminho de regularização.
      if (deps.email && u.email) {
        deps.email.enviarEvento('suspensao', u.email, {
          nome: u.name || req.params.username,
          motivo: u.suspendedReason || 'pendência com o administrador',
        });
      }
    } else {
      delete u.suspended; delete u.suspendedReason; delete u.suspendedAt;
    }
    appendActivity({
      type: req.body.suspended ? 'admin_user_suspenso' : 'admin_user_reativado',
      user: req.user.user,
      data: { username: req.params.username, motivo: u.suspendedReason || null },
      at: new Date().toISOString(),
    });
  }
  saveUsers(users);
  appendActivity({ type: 'admin_user_updated', user: req.user.user, data: { username: req.params.username }, at: new Date().toISOString() });
  res.json({ ok: true });
});

app.delete('/api/admin/users/:username', adminMiddleware, (req, res) => {
  if (req.params.username === req.user.user) return res.status(400).json({ error: 'Você não pode excluir a si mesmo' });
  const users = loadUsers();
  if (!users[req.params.username]) return res.status(404).json({ error: 'Usuário não encontrado' });
  delete users[req.params.username];
  delete USERS[req.params.username];
  saveUsers(users);
  appendActivity({ type: 'admin_user_deleted', user: req.user.user, data: { username: req.params.username }, at: new Date().toISOString() });
  res.json({ ok: true });
});

// ── Projetos (todos, com tamanho e custo) ──
app.get('/api/admin/projects', adminMiddleware, (_req, res) => {
  const projects = loadProjects();
  const sizes = projectSizesKb();
  res.json(projects.map(p => ({
    id: p.id, name: p.name, slug: p.slug, owner: p.owner || null,
    createdAt: p.createdAt || null,
    currentVersion: p.currentVersion || 0,
    publishedVersion: p.publishedVersion || 0,
    buildLevel: p.buildLevel || 3,
    model: p.claudeModel || null,
    mode: p.claudeMode || 'turbo',
    costUsd: p.costUsd || 0,
    sizeKb: sizes[p.slug] || 0,
    previewUrl: p.previewUrl || null,
    publishUrl: p.publishUrl || null,
    thumbnail: p.thumbnail || null,
  })));
});

// ── Sessões vivas do motor ──
app.get('/api/admin/sessions', adminMiddleware, async (_req, res) => {
  try {
    const { sessionManager } = await getEngine();
    const projects = loadProjects();
    const list = [];
    for (const [key, s] of sessionManager.sessions) {
      const st = s.status();
      const proj = projects.find(p => p.id === key);
      list.push({ ...st, projectName: proj ? proj.name : null });
    }
    res.json(list);
  } catch (err) {
    res.json([]);
  }
});

app.post('/api/admin/sessions/:key/close', adminMiddleware, async (req, res) => {
  try {
    const { sessionManager } = await getEngine();
    const s = sessionManager.get(req.params.key);
    if (!s) return res.status(404).json({ error: 'Sessão não encontrada' });
    s.close('admin');
    appendActivity({ type: 'admin_session_closed', user: req.user.user, data: { key: req.params.key }, at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Atividade recente ──
app.get('/api/admin/activity', adminMiddleware, (_req, res) => {
  let log = [];
  try { log = JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8')); } catch {}
  res.json(log.slice(-120).reverse());
});

// ── Configurações do sistema ──
app.get('/api/admin/config', adminMiddleware, (_req, res) => {
  const cfg = loadNasceraConfig();
  res.json({
    defaultBuildModel: cfg.defaultBuildModel || '',
    defaultBuildLevel: cfg.defaultBuildLevel || 3,
    trashRetentionDays: cfg.trashRetentionDays || 7,
    telemetryEnabled: cfg.telemetryEnabled !== false,
  });
});

app.put('/api/admin/config', adminMiddleware, (req, res) => {
  const cfg = loadNasceraConfig();
  const { defaultBuildModel, defaultBuildLevel, trashRetentionDays, telemetryEnabled } = req.body;
  if (defaultBuildModel !== undefined) cfg.defaultBuildModel = String(defaultBuildModel || '');
  if (defaultBuildLevel !== undefined) cfg.defaultBuildLevel = normalizeBuildLevel(defaultBuildLevel);
  if (trashRetentionDays !== undefined) {
    const d = parseInt(trashRetentionDays, 10);
    cfg.trashRetentionDays = (d >= 1 && d <= 90) ? d : 7;
  }
  if (telemetryEnabled !== undefined) cfg.telemetryEnabled = !!telemetryEnabled;
  saveNasceraConfig(cfg);
  appendActivity({ type: 'admin_config_updated', user: req.user.user, data: cfg, at: new Date().toISOString() });
  res.json({ ok: true, config: cfg });
});

// ── Logs do servidor (pm2) ──
// Dois defeitos que deixavam esta aba vazia:
//   • `tail -80` não existe no Windows (e interpolava o caminho numa linha de
//     shell). Agora é leitura em Node, que lê só o fim do arquivo;
//   • o nome procurado era `nascera-v2`, mas o ecosystem.config.js chama o
//     processo de `nascera` — ou seja, a aba estava vazia TAMBÉM no Linux.
//     Mantemos o nome antigo na lista porque instalação velha ainda o usa.
app.get('/api/admin/logs', adminMiddleware, (_req, res) => {
  const home = process.env.HOME || require('os').homedir();
  const base = path.join(home, '.pm2', 'logs');
  const result = {};
  for (const nome of ['nascera', 'nascera-v2']) {
    for (const tipo of ['out', 'error']) {
      const arquivo = path.join(base, `${nome}-${tipo}.log`);
      const conteudo = so.ultimasLinhas(arquivo, 80);
      // Só entra na resposta o que existe: senão a tela mostra quatro caixas,
      // metade delas vazias por serem de um nome de processo que não é o desta
      // instalação — e "vazio" viraria de novo "não sei o que aconteceu".
      if (conteudo) result[`${nome}-${tipo}.log`] = conteudo;
    }
  }
  res.json(result);
});

// ── Reiniciar o servidor (o pm2 reergue com autorestart) ──
app.post('/api/admin/restart', adminMiddleware, (req, res) => {
  appendActivity({ type: 'admin_restart', user: req.user.user, data: {}, at: new Date().toISOString() });
  res.json({ ok: true });
  logger.info('[admin] reinício solicitado por ' + req.user.user);
  setTimeout(() => process.exit(0), 500);
});
}

module.exports = { registrar };
