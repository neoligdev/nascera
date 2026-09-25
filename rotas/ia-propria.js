// ═══════════════════════════════════════════════════════════════════════
// NASCERA — IA PRÓPRIA do usuário (AD.1 do BACKLOG-ADMIN, "BYOK")
//
// O admin decide (toggle global) se os usuários podem conectar a PRÓPRIA
// credencial da Anthropic. Com ela conectada, as sessões dos projetos daquele
// usuário rodam por conta DELE — o token não sai do bolso do admin, e o débito
// de créditos é isento (o NASCERA vira "só o front").
//
// Aceita dois formatos:
//   • sk-ant-api…  → chave de API (console.anthropic.com) → ANTHROPIC_API_KEY
//   • sk-ant-oat…  → token OAuth de assinatura Pro/Max (`claude setup-token`)
//                    → CLAUDE_CODE_OAUTH_TOKEN
//
// Segurança: a chave vive no COFRE (AES-256-GCM), nunca em users.json; a API
// só devolve o sufixo mascarado; chave de API é TESTADA ao conectar (chamada
// real ao /v1/models). A troca só vale para sessões NOVAS — a isenção de
// débito acompanha a credencial REAL da sessão (ch.iaPropria), nunca a flag
// sozinha, para ninguém ganhar isenção com o token ainda saindo do admin.
// ═══════════════════════════════════════════════════════════════════════

function registrar(app, deps) {
  const {
    authMiddleware, adminMiddleware, segredos, loadUsers, saveUsers,
    loadNasceraConfig, saveNasceraConfig, appendActivity,
  } = deps;

  const permitido = () => !!((loadNasceraConfig().iaPropria || {}).permitir);

  // ── usuário: estado da própria conexão ──────────────────────────────
  app.get('/api/me/ia-propria', authMiddleware, (req, res) => {
    const u = loadUsers()[req.user.user] || {};
    res.json({
      permitido: permitido(),
      conectada: !!u.iaPropria,
      tipo: (u.iaPropria && u.iaPropria.tipo) || null,
      sufixo: (u.iaPropria && u.iaPropria.sufixo) || null,
      conectadaEm: (u.iaPropria && u.iaPropria.conectadaEm) || null,
    });
  });

  // ── usuário: conectar a chave ───────────────────────────────────────
  app.post('/api/me/ia-propria', authMiddleware, async (req, res) => {
    if (!permitido()) return res.status(403).json({ error: 'O administrador não liberou IA própria nesta instalação.' });
    const chave = String((req.body || {}).chave || '').trim();
    if (!/^sk-ant-/.test(chave) || chave.length < 20) {
      return res.status(400).json({ error: 'Formato inválido. A chave começa com "sk-ant-…" (API) ou "sk-ant-oat…" (assinatura, via `claude setup-token`).' });
    }
    const tipo = chave.startsWith('sk-ant-oat') ? 'oauth' : 'api';

    // Chave de API dá para testar DE VERDADE antes de aceitar. Token OAuth de
    // assinatura não fala com a API pública — fica na validação de formato.
    let aviso = null;
    if (tipo === 'api') {
      try {
        const r = await fetch('https://api.anthropic.com/v1/models', {
          headers: { 'x-api-key': chave, 'anthropic-version': '2023-06-01' },
          signal: AbortSignal.timeout(8000),
        });
        if (r.status === 401 || r.status === 403) {
          return res.status(400).json({ error: 'A Anthropic recusou esta chave (inválida ou revogada). Confira em console.anthropic.com.' });
        }
      } catch {
        // Sem rede agora não é chave errada: aceita com aviso honesto.
        aviso = 'Não consegui validar com a Anthropic agora (sem rede?). A chave foi salva; se estiver errada, o build vai falhar com erro de autenticação.';
      }
    }

    segredos.guardar('ia:' + req.user.user, chave);
    const users = loadUsers();
    const u = users[req.user.user];
    if (!u) return res.status(404).json({ error: 'Usuário não encontrado' });
    u.iaPropria = { tipo, sufixo: '•••' + chave.slice(-4), conectadaEm: new Date().toISOString() };
    saveUsers(users);
    appendActivity({ type: 'ia_propria_conectada', user: req.user.user, data: { tipo }, at: new Date().toISOString() });
    res.json({
      ok: true, tipo, sufixo: u.iaPropria.sufixo, aviso,
      nota: 'Vale para sessões NOVAS: projetos com sessão aberta continuam na credencial anterior até a sessão fechar.',
    });
  });

  // ── usuário: desconectar ────────────────────────────────────────────
  app.delete('/api/me/ia-propria', authMiddleware, (req, res) => {
    segredos.esquecer('ia:' + req.user.user);
    const users = loadUsers();
    if (users[req.user.user]) { delete users[req.user.user].iaPropria; saveUsers(users); }
    appendActivity({ type: 'ia_propria_desconectada', user: req.user.user, data: {}, at: new Date().toISOString() });
    res.json({ ok: true });
  });

  // ── admin: o toggle + quem está conectado ───────────────────────────
  app.get('/api/admin/ia-propria', adminMiddleware, (_req, res) => {
    const users = loadUsers();
    res.json({
      permitir: permitido(),
      conectados: Object.entries(users)
        .filter(([, u]) => u.iaPropria)
        .map(([username, u]) => ({ username, tipo: u.iaPropria.tipo, sufixo: u.iaPropria.sufixo, conectadaEm: u.iaPropria.conectadaEm })),
    });
  });

  app.put('/api/admin/ia-propria', adminMiddleware, (req, res) => {
    const cfg = loadNasceraConfig();
    cfg.iaPropria = { permitir: !!(req.body || {}).permitir };
    saveNasceraConfig(cfg);
    appendActivity({ type: 'admin_ia_propria', user: req.user.user, data: { permitir: cfg.iaPropria.permitir }, at: new Date().toISOString() });
    res.json({ ok: true, permitir: cfg.iaPropria.permitir });
  });
}

// Resolve a credencial que uma SESSÃO nova deve usar para o dono `username`,
// ou null (usa a credencial da instalação). É o único lugar que decide isso —
// ensureChannel injeta no env do motor e marca ch.iaPropria, e a isenção de
// débito no WebSocket segue essa marca (a credencial REAL da sessão).
function credencialPara(username, { loadNasceraConfig, loadUsers, segredos }) {
  try {
    if (!username) return null;
    if (!((loadNasceraConfig().iaPropria || {}).permitir)) return null;
    const u = loadUsers()[username];
    if (!u || !u.iaPropria) return null;
    const chave = segredos.obter('ia:' + username);
    if (!chave) return null;
    return {
      envVar: chave.startsWith('sk-ant-oat') ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY',
      valor: chave,
    };
  } catch { return null; }
}

module.exports = { registrar, credencialPara };
