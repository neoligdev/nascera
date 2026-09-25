// ═══════════════════════════════════════════════════════════════════════
// NASCERA — rotas de e-mail (Sprint A1 do BACKLOG-ADMIN)
//
// Admin:
//   • GET/PUT /api/admin/email            — config SMTP (senha no cofre, mascarada)
//   • POST    /api/admin/email/testar     — envia AGORA e devolve o erro verbatim
//   • PUT     /api/admin/email/templates  — override por evento (vazio = volta ao padrão)
// Público:
//   • POST /api/esqueci-senha — gera token de 30min (mesmo mecanismo do link de
//     primeiro acesso) e envia o e-mail. Resposta SEMPRE ok quando o SMTP está
//     de pé — não confirma se o e-mail existe (anti-enumeração). Com SMTP
//     desconfigurado devolve erro honesto (estado global, não vaza usuário).
//
// A troca do token pela senha nova é o /api/primeiro-acesso que já existe
// (rotas/webhooks.js) — um mecanismo só, uma página só (definir-senha.html).
// ═══════════════════════════════════════════════════════════════════════
const crypto = require('crypto');

function registrar(app, deps) {
  const {
    adminMiddleware, limiteSensivel, email, segredos, loadUsers, saveUsers,
    loadNasceraConfig, saveNasceraConfig, appendActivity,
  } = deps;

  // ── admin: config SMTP ──────────────────────────────────────────────
  app.get('/api/admin/email', adminMiddleware, (_req, res) => {
    const c = loadNasceraConfig().email || {};
    const senha = segredos.obter(email.COFRE_SENHA);
    const overrides = loadNasceraConfig().emailTemplates || {};
    res.json({
      configurado: email.configurado(),
      host: c.host || '', port: c.port || 587,
      usuario: c.usuario || '', remetente: c.remetente || '', remetenteNome: c.remetenteNome || '',
      urlBase: c.urlBase || '',
      senhaConfigurada: senha !== null,
      // Templates: o efetivo (override ou padrão) + a marca de qual é qual.
      templates: email.EVENTOS.map(ev => ({
        evento: ev,
        assunto: (overrides[ev] && overrides[ev].assunto) || email.PADRAO[ev].assunto,
        corpo: (overrides[ev] && overrides[ev].corpo) || email.PADRAO[ev].corpo,
        personalizado: !!overrides[ev],
      })),
      log: email.logRecentes(20).filter(e => !e.reserva),
    });
  });

  app.put('/api/admin/email', adminMiddleware, (req, res) => {
    const { host, port, usuario, remetente, remetenteNome, senha, urlBase } = req.body || {};
    const cfg = loadNasceraConfig();
    cfg.email = {
      host: String(host || '').trim(), port: Number(port) || 587,
      usuario: String(usuario || '').trim(),
      remetente: String(remetente || '').trim(), remetenteNome: String(remetenteNome || '').trim(),
      // Links dos e-mails (definir senha, comprar) precisam de URL absoluta —
      // o webhook da Hotmart não tem "origin" para deduzir.
      urlBase: String(urlBase || '').trim().replace(/\/+$/, ''),
    };
    saveNasceraConfig(cfg);
    if (senha !== undefined && senha !== '') segredos.guardar(email.COFRE_SENHA, String(senha));
    appendActivity({ type: 'admin_email_config', user: req.user.user, data: { host: cfg.email.host }, at: new Date().toISOString() });
    res.json({ ok: true, configurado: email.configurado() });
  });

  app.post('/api/admin/email/testar', adminMiddleware, async (req, res) => {
    const para = String((req.body || {}).para || '').trim();
    if (!para) return res.status(400).json({ error: 'Informe o e-mail de destino' });
    const r = await email.testar(para);
    // Erro VERBATIM: "Invalid login: 535..." diz ao dono exatamente o que corrigir.
    res.json(r.ok ? { ok: true } : { ok: false, error: r.erro });
  });

  app.put('/api/admin/email/templates', adminMiddleware, (req, res) => {
    const { evento, assunto, corpo } = req.body || {};
    if (!email.EVENTOS.includes(evento)) return res.status(400).json({ error: 'Evento desconhecido' });
    const cfg = loadNasceraConfig();
    cfg.emailTemplates = cfg.emailTemplates || {};
    const a = String(assunto || '').trim(), c = String(corpo || '').trim();
    // Vazio (ou igual ao padrão) = volta ao embutido — nunca fica "sem template".
    if (!a && !c) delete cfg.emailTemplates[evento];
    else cfg.emailTemplates[evento] = { assunto: a || undefined, corpo: c || undefined };
    saveNasceraConfig(cfg);
    res.json({ ok: true });
  });

  // Preview renderizado com variáveis de exemplo (o admin vê o que o cliente vê).
  app.post('/api/admin/email/preview', adminMiddleware, (req, res) => {
    const { evento, assunto, corpo } = req.body || {};
    if (!email.EVENTOS.includes(evento)) return res.status(400).json({ error: 'Evento desconhecido' });
    // Renderiza o RASCUNHO (sem salvar): injeta override temporário via vars? Não —
    // renderizar lê da config. Para preview de rascunho, monta direto:
    const vars = {
      nome: 'Maria', usuario: 'maria', plano: 'Pro', valor: '600,00', pct: '85',
      motivo: 'pagamento pendente', link: 'https://seunascera.com/definir-senha.html?t=exemplo',
      produto: loadNasceraConfig().nomeProduto || 'Nascera',
    };
    const preencher = (t) => String(t || '').replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
    res.json({ assunto: preencher(assunto), corpo: preencher(corpo) });
  });

  // ── público: esqueci minha senha ────────────────────────────────────
  app.post('/api/esqueci-senha', limiteSensivel, (req, res) => {
    const alvo = String((req.body || {}).email || '').trim().toLowerCase();
    if (!alvo) return res.status(400).json({ error: 'Informe o e-mail da conta' });
    // SMTP fora do ar é estado GLOBAL — dizer isso não vaza conta nenhuma,
    // e evita o usuário esperando um e-mail que nunca virá.
    if (!email.configurado() && !process.env.NASCERA_MAIL_FAKE) {
      return res.status(503).json({ error: 'Recuperação por e-mail não está configurada nesta instalação. Fale com o administrador.' });
    }
    const users = loadUsers();
    const entrada = Object.entries(users).find(([, u]) =>
      String(u.email || '').trim().toLowerCase() === alvo && !u.suspended);
    if (entrada) {
      const [username, u] = entrada;
      const token = crypto.randomBytes(32).toString('base64url');
      u.definirSenha = {
        hash: crypto.createHash('sha256').update(token).digest('hex'),
        expiraEm: Date.now() + 30 * 60 * 1000,      // 30 min, uso único
      };
      saveUsers(users);
      const cfgMail = loadNasceraConfig().email || {};
      const base = cfgMail.urlBase ||
        (String(req.headers.origin || '').match(/^https?:\/\//) ? req.headers.origin : '');
      email.enviarEvento('esqueci-senha', u.email, {
        nome: u.name || username, usuario: username,
        link: base + '/definir-senha.html?t=' + token,
      });
      appendActivity({ type: 'esqueci_senha_pedido', user: username, data: {}, at: new Date().toISOString() });
    }
    // Mesma resposta com ou sem conta: nada de oráculo de e-mails cadastrados.
    res.json({ ok: true, mensagem: 'Se este e-mail tiver uma conta, o link de redefinição chega em instantes.' });
  });
}

module.exports = { registrar };
