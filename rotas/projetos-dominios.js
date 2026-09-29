// ═══════════════════════════════════════════════════════════════════════
// NASCERA — domínios de um projeto (S4: extraído do server.js)
//
// As 5 rotas /api/projects/:id/domains/* — listar, adicionar, verificar (DNS
// real + SSL), marcar primário e remover. Corte mais limpo do núcleo projects:
// toda a persistência mora no módulo `domains` (domains.json próprio); aqui não
// há git, motor, channels nem chat-cache. Espelha o admin-domains.js já extraído.
//
// Portão de posse: projectOr404 (W1/IDOR — 404 para projeto alheio). Cada rota
// :domain confere rec.projectId === proj.id, então não dá para mexer no domínio
// de um projeto pela rota de outro.
// ═══════════════════════════════════════════════════════════════════════
/**
 * Monta as rotas de domínios de um projeto (`/api/projects/:id/domains/*`):
 * listar, adicionar, verificar (DNS real + SSL), marcar primário e remover.
 *
 * @param {import('express').Express} app - App do Express onde as rotas são montadas.
 * @param {object} deps - Dependências injetadas pelo server.js (composition root).
 * @param {import('express').RequestHandler} deps.authMiddleware - Guarda de sessão; exige usuário logado.
 * @param {import('express').RequestHandler} deps.projectOr404 - Portão de dono (W1/IDOR): resolve `req.projeto` ou responde 404 se for de outro usuário.
 * @param {object} deps.domains - Módulo de domínios (dono do `domains.json` e da verificação DNS/SSL).
 * @param {(evt: object) => void} deps.appendActivity - Registra um evento no log de atividade.
 * @returns {void}
 */
function registrar(app, deps) {
  const { authMiddleware, projectOr404, domains, appendActivity, billing } = deps;

  app.get('/api/projects/:id/domains', authMiddleware, (req, res) => {
    const proj = projectOr404(req, res); if (!proj) return;
    const cfg = domains.getConfig();
    const list = domains.listForProject(proj.id).map(d => ({ ...d, dns: domains.dnsInstructions(d) }));
    res.json({ domains: list, config: { sslMode: cfg.sslMode, serverIp: cfg.serverIp, cnameTarget: cfg.cnameTarget } });
  });

  app.post('/api/projects/:id/domains', authMiddleware, (req, res) => {
    const proj = projectOr404(req, res); if (!proj) return;
    // Limite de domínios por plano (doc de Planos, Créditos e Motor 2) — conta
    // no total da CONTA, não por projeto (mesma leitura da tabela do doc).
    // Admin é isento, mesmo padrão do billing de créditos.
    if (req.user.role !== 'admin' && billing) {
      const max = billing.planLimitFor(req.user.user, 'maxDominios');
      if (max != null) {
        const atual = domains.listAll().filter(d => d.user === req.user.user).length;
        if (atual >= max) return res.status(403).json({ error: `Seu plano permite até ${max} domínio(s). Faça upgrade para adicionar mais.` });
      }
    }
    try {
      const rec = domains.addDomain(req.body.domain, {
        projectId: proj.id, slug: proj.slug, user: req.user.user,
      });
      appendActivity({ type: 'domain_added', user: req.user.user, data: { domain: rec.domain, slug: proj.slug }, at: new Date().toISOString() });
      res.json({ ok: true, domain: { ...rec, dns: domains.dnsInstructions(rec) } });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/projects/:id/domains/:domain/verify', authMiddleware, async (req, res) => {
    const proj = projectOr404(req, res); if (!proj) return;
    const rec = domains.getDomain(req.params.domain);
    if (!rec || rec.projectId !== proj.id) return res.status(404).json({ error: 'Domínio não encontrado neste projeto' });
    try {
      const out = await domains.verifyDomain(req.params.domain, { force: true });
      let ssl = null;
      if (out.status === 'ativo') {
        // virou ativo → o proxy precisa saber (e pedir o certificado)
        ssl = domains.aplicarSsl(req.params.domain);
        if (!rec.verifiedAt) {
          appendActivity({ type: 'domain_verified', user: req.user.user, data: { domain: out.domain, ssl: ssl.motivo }, at: new Date().toISOString() });
        }
      }
      res.json({ ok: true, ssl, domain: { ...out, dns: domains.dnsInstructions(out) } });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/projects/:id/domains/:domain/primary', authMiddleware, (req, res) => {
    const proj = projectOr404(req, res); if (!proj) return;
    const rec = domains.getDomain(req.params.domain);
    if (!rec || rec.projectId !== proj.id) return res.status(404).json({ error: 'Domínio não encontrado neste projeto' });
    try { res.json({ ok: true, domain: domains.setPrimary(req.params.domain) }); }
    catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.delete('/api/projects/:id/domains/:domain', authMiddleware, (req, res) => {
    const proj = projectOr404(req, res); if (!proj) return;
    const rec = domains.getDomain(req.params.domain);
    if (!rec || rec.projectId !== proj.id) return res.status(404).json({ error: 'Domínio não encontrado neste projeto' });
    try {
      domains.removeDomain(req.params.domain);
      domains.removerSsl(req.params.domain);   // tira o domínio do proxy/nginx também
      appendActivity({ type: 'domain_removed', user: req.user.user, data: { domain: rec.domain }, at: new Date().toISOString() });
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });
}

module.exports = { registrar };
