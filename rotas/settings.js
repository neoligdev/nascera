// ═══════════════════════════════════════════════════════════════════════
// NASCERA — rotas de configurações do usuário (S4: extraído do server.js)
// perfil, troca de senha, status do Claude. Coberto pelo smoke (/api/settings).
// ═══════════════════════════════════════════════════════════════════════
const senhas = require('../senhas.js');

/**
 * Monta as rotas de configuração do usuário (`/api/settings`): perfil, troca de
 * senha e status do login do Claude.
 *
 * @param {import('express').Express} app - App do Express onde as rotas são montadas.
 * @param {object} deps - Dependências injetadas pelo server.js (composition root).
 * @param {import('express').RequestHandler} deps.authMiddleware - Guarda de sessão; exige usuário logado.
 * @param {() => Object<string,object>} deps.loadUsers - Lê o store de usuários.
 * @param {(users: Object<string,object>) => void} deps.saveUsers - Grava o store de usuários (escrita atômica).
 * @param {() => object} deps.readClaudeAuthStatus - Estado atual do login do Claude Code.
 * @param {string} deps.USERS - Caminho do arquivo de usuários.
 * @returns {void}
 */
function registrar(app, deps) {
  const { authMiddleware, loadUsers, saveUsers, readClaudeAuthStatus, USERS } = deps;

app.get('/api/settings', authMiddleware, async (req, res) => {
  const users = loadUsers();
  const u = users[req.user.user];
  const result = { user: {}, claude: {}, system: {} };

  if (u) {
    result.user = { name: u.name || '', email: u.email || '', username: req.user.user };
  }

  // Claude status
  // Reusa o leitor com cache em vez de spawnar aqui: era uma string de shell,
  // e o caminho do CLI agora é absoluto e pode ter espaços ('NASCERA NEW') —
  // interpolado num shell viraria dois argumentos e o status ficaria "não
  // logado" para sempre. O leitor também tolera stderr/JSON sujo na saída.
  try {
    const s = readClaudeAuthStatus(5000);
    result.claude = { loggedIn: !!s.loggedIn, email: s.email || '',
                      authMethod: s.authMethod || '', subscriptionType: s.subscriptionType || '' };
  } catch {
    result.claude = { loggedIn: false };
  }

  // System info
  result.system = { nodeVersion: process.version, platform: process.platform + ' ' + require('os').release(), uptime: process.uptime() };

  res.json(result);
});

app.put('/api/settings/profile', authMiddleware, (req, res) => {
  const users = loadUsers();
  const u = users[req.user.user];
  if (!u) return res.status(404).json({ error: 'Usuario nao encontrado' });
  const { name, email } = req.body;
  if (name) u.name = name;
  if (email) u.email = email;
  saveUsers(users);
  res.json({ ok: true });
});

app.put('/api/settings/password', authMiddleware, async (req, res) => {
  const users = loadUsers();
  const u = users[req.user.user];
  if (!u) return res.status(404).json({ error: 'Usuario nao encontrado' });
  const { currentPassword, newPassword } = req.body || {};
  const atual = await senhas.conferir(currentPassword, u.password);
  if (!atual.ok) return res.status(401).json({ error: 'Senha atual incorreta' });
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Nova senha deve ter no minimo 6 caracteres' });
  u.password = await senhas.criarHash(newPassword);
  USERS[req.user.user] = { password: u.password };
  saveUsers(users);
  res.json({ ok: true });
});
}

module.exports = { registrar };
