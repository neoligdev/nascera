// ═══════════════════════════════════════════════════════════════════════
// NASCERA — rotas admin de domínios (S4: extraído do server.js)
// overview, config (IP/SSL/Caddy), caddyfile, detect-ip, verify, remove.
// Deps: módulos domains + axios (detect-ip consulta o IP público).
// ═══════════════════════════════════════════════════════════════════════
const axios = require('axios');
const domains = require('../domains.js');

/**
 * Monta as rotas admin de domínios (`/api/admin/domains/*`): overview, config
 * (IP/SSL/Caddy), Caddyfile, detecção de IP público, verificação e remoção.
 *
 * @param {import('express').Express} app - App do Express onde as rotas são montadas.
 * @param {object} deps - Dependências injetadas pelo server.js (composition root).
 * @param {import('express').RequestHandler} deps.adminMiddleware - Guarda de admin; exige papel admin.
 * @param {() => object} deps.loadNasceraConfig - Lê a config global do Nascera.
 * @param {(cfg: object) => void} deps.saveNasceraConfig - Grava a config global.
 * @param {(evt: object) => void} deps.appendActivity - Registra um evento no log de atividade.
 * @returns {void}
 */
function registrar(app, deps) {
  const { adminMiddleware, loadNasceraConfig, saveNasceraConfig, appendActivity } = deps;

app.get('/api/admin/domains', adminMiddleware, (_req, res) => {
  res.json(domains.adminOverview());
});

app.put('/api/admin/domains/config', adminMiddleware, (req, res) => {
  const { serverIp, cnameTarget, sslMode, publishPort, panelDomain, verifyTtlMin, autoCaddy } = req.body;
  const cfg = loadNasceraConfig();
  const d = { ...(cfg.domains || {}) };
  if (serverIp !== undefined) {
    const v = String(serverIp).trim();
    if (v && !/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return res.status(400).json({ error: 'IP do servidor inválido' });
    d.serverIp = v;
  }
  if (cnameTarget !== undefined) d.cnameTarget = domains.normalizeDomain(cnameTarget);
  if (panelDomain !== undefined) d.panelDomain = domains.normalizeDomain(panelDomain);
  if (sslMode !== undefined) {
    if (!['proxy', 'direct', 'off'].includes(sslMode)) return res.status(400).json({ error: 'Modo de SSL inválido' });
    d.sslMode = sslMode;
  }
  if (publishPort !== undefined) {
    const v = parseInt(publishPort, 10);
    if (!(v > 0 && v < 65536)) return res.status(400).json({ error: 'Porta inválida' });
    d.publishPort = v;
  }
  if (verifyTtlMin !== undefined) {
    const v = parseFloat(verifyTtlMin);
    if (!(v >= 0 && v <= 60)) return res.status(400).json({ error: 'TTL de verificação inválido (0–60 min)' });
    d.verifyTtlMin = v;
  }
  if (autoCaddy !== undefined) d.autoCaddy = !!autoCaddy;
  if (req.body.leEmail !== undefined) {
    const e = String(req.body.leEmail).trim();
    if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return res.status(400).json({ error: 'E-mail inválido' });
    d.leEmail = e;
  }
  cfg.domains = d;
  saveNasceraConfig(cfg);
  const ssl = domains.applyCaddy();   // panelDomain/porta mudaram? reescreve (no nginx cada domínio tem vhost próprio)
  appendActivity({ type: 'admin_domains_config', user: req.user.user, data: { sslMode: d.sslMode }, at: new Date().toISOString() });
  res.json({ ok: true, ssl, config: domains.getConfig() });
});

app.get('/api/admin/domains/caddyfile', adminMiddleware, (_req, res) => {
  res.type('text/plain').send(domains.caddyfile());
});

// Descobre o endereço que os clientes devem apontar. O servidor não sabe o
// próprio IP público (está atrás de NAT/roteador), então pergunta pra fora.
app.get('/api/admin/domains/detect-ip', adminMiddleware, async (_req, res) => {
  const os = require('os');
  // IPs das interfaces: úteis em LAN, inúteis para DNS público (mas ajudam
  // a explicar ao dono por que localhost não serve para domínio de verdade)
  const locais = [];
  for (const [nome, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) locais.push({ iface: nome, ip: a.address });
    }
  }
  const privado = (ip) => /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

  let publico = null, erro = null;
  const fontes = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'];
  for (const url of fontes) {
    try {
      const r = await axios.get(url, { timeout: 4000, responseType: 'text' });
      const ip = String(r.data).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) { publico = ip; break; }
    } catch (e) { erro = e.message; }
  }

  res.json({
    publicIp: publico,
    localIps: locais,
    // localhost puro = nenhuma interface pública; domínio real não chega aqui
    isLocalOnly: !locais.length || locais.every(l => privado(l.ip)),
    error: publico ? null : (erro || 'não foi possível consultar o IP público'),
  });
});

app.post('/api/admin/domains/:domain/verify', adminMiddleware, async (req, res) => {
  try { res.json({ ok: true, domain: await domains.verifyDomain(req.params.domain, { force: true }) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/admin/domains/:domain', adminMiddleware, (req, res) => {
  try {
    domains.removeDomain(req.params.domain);
    appendActivity({ type: 'domain_removed', user: req.user.user, data: { domain: req.params.domain, byAdmin: true }, at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
}

module.exports = { registrar };
