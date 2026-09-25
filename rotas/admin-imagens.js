// ═══════════════════════════════════════════════════════════════════════
// NASCERA — rotas admin de imagens (S4: extraído do server.js)
// estado, chave OpenAI, modelo/qualidade, teste. Dep: módulo imagens.
// (o token/rota do AGENTE ficou no server.js: usa JWT_SECRET e o projeto.)
// ═══════════════════════════════════════════════════════════════════════
const imagens = require('../imagens.js');

/**
 * Monta as rotas admin de imagens (`/api/admin/imagens/*`): estado, chave da
 * OpenAI, modelo/qualidade e teste de geração.
 *
 * @param {import('express').Express} app - App do Express onde as rotas são montadas.
 * @param {object} deps - Dependências injetadas pelo server.js (composition root).
 * @param {import('express').RequestHandler} deps.adminMiddleware - Guarda de admin; exige papel admin.
 * @param {(evt: object) => void} deps.appendActivity - Registra um evento no log de atividade.
 * @returns {void}
 */
function registrar(app, deps) {
  const { adminMiddleware, appendActivity } = deps;

app.get('/api/admin/imagens', adminMiddleware, (_req, res) => {
  res.json(imagens.estado());
});

app.put('/api/admin/imagens/chave', adminMiddleware, (req, res) => {
  const r = imagens.definirChaveOpenAI((req.body && req.body.chave) || '');
  if (!r.ok) return res.status(400).json({ error: r.erro });
  appendActivity({ type: 'imagens_chave_alterada', user: req.user.user, data: { configurada: r.configurada }, at: new Date().toISOString() });
  res.json({ ...r, estado: imagens.estado() });
});

// Qual modelo gera. Fica no painel e não no código porque a escolha é
// econômica, não técnica: modelo melhor custa mais por imagem, e quem paga
// a conta é quem decide.
app.put('/api/admin/imagens/modelo', adminMiddleware, (req, res) => {
  const b = req.body || {};
  if (b.modelo) {
    const r = imagens.definirModelo(b.modelo);
    if (!r.ok) return res.status(400).json({ error: r.erro });
  }
  if (b.qualidade) {
    const r = imagens.definirQualidade(b.qualidade);
    if (!r.ok) return res.status(400).json({ error: r.erro });
  }
  appendActivity({ type: 'imagens_modelo_alterado', user: req.user.user, data: { modelo: b.modelo, qualidade: b.qualidade }, at: new Date().toISOString() });
  res.json({ ok: true, estado: imagens.estado() });
});

app.post('/api/admin/imagens/testar', adminMiddleware, async (_req, res) => {
  res.json(await imagens.testar());
});
}

module.exports = { registrar };
