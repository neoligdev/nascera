// ═══════════════════════════════════════════════════════════════════════
// NASCERA — rotas admin de aparência/tema (S4: extraído do server.js)
// get/put do tema, upload de imagem (logo/favicon), reset. Dep: módulo theme.
// ═══════════════════════════════════════════════════════════════════════
const express = require('express');
const theme = require('../theme.js');

/**
 * Monta as rotas admin de aparência/tema (`/api/admin/theme/*`): get/put do
 * tema, upload de imagem (logo/favicon) e reset.
 *
 * @param {import('express').Express} app - App do Express onde as rotas são montadas.
 * @param {object} deps - Dependências injetadas pelo server.js (composition root).
 * @param {import('express').RequestHandler} deps.adminMiddleware - Guarda de admin; exige papel admin.
 * @param {(evt: object) => void} deps.appendActivity - Registra um evento no log de atividade.
 * @returns {void}
 */
function registrar(app, deps) {
  const { adminMiddleware, appendActivity } = deps;

app.get('/api/admin/theme', adminMiddleware, (_req, res) => {
  res.json({ theme: theme.getTheme(), defaults: theme.DEFAULTS });
});

app.put('/api/admin/theme', adminMiddleware, (req, res) => {
  try {
    const novo = theme.saveTheme(req.body || {});
    appendActivity({ type: 'admin_theme_updated', user: req.user.user, data: {}, at: new Date().toISOString() });
    res.json({ ok: true, theme: novo });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Upload de imagem da aparência (logo, favicon, fundos).
// O corpo é o arquivo cru — sem multipart, sem base64: o navegador manda o
// File direto no fetch e o servidor grava os bytes. `express.json()` não
// encosta porque o Content-Type é de imagem.
const corpoImagem = express.raw({ type: () => true, limit: theme.MAX_UPLOAD });
app.post('/api/admin/theme/upload/:chave', adminMiddleware, (req, res, next) => {
  corpoImagem(req, res, (err) => {
    if (err) return res.status(413).json({ error: 'Imagem muito grande — o limite é 5 MB' });
    next();
  });
}, (req, res) => {
  try {
    const { url, theme: novo } = theme.salvarImagem(req.params.chave, req.body);
    appendActivity({ type: 'admin_theme_image_uploaded', user: req.user.user, data: { chave: req.params.chave, url }, at: new Date().toISOString() });
    res.json({ ok: true, url, theme: novo });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/theme/reset', adminMiddleware, (req, res) => {
  const t = theme.resetTheme();
  appendActivity({ type: 'admin_theme_reset', user: req.user.user, data: {}, at: new Date().toISOString() });
  res.json({ ok: true, theme: t });
});
}

module.exports = { registrar };
