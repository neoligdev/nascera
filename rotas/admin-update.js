// ═══════════════════════════════════════════════════════════════════════
// NASCERA — rotas admin de atualização da plataforma (S4: extraído)
// check, status, apply. Dep principal: módulo atualizacao (update assinado).
// ═══════════════════════════════════════════════════════════════════════
const atualizacao = require('../atualizacao.js');

/**
 * Monta as rotas admin de atualização da plataforma (`/api/admin/update/*`):
 * check, status e apply (update assinado).
 *
 * @param {import('express').Express} app - App do Express onde as rotas são montadas.
 * @param {object} deps - Dependências injetadas pelo server.js (composition root).
 * @param {import('express').RequestHandler} deps.adminMiddleware - Guarda de admin; exige papel admin.
 * @param {(evt: object) => void} deps.appendActivity - Registra um evento no log de atividade.
 * @param {(nome: string, dados?: object) => void} deps.trackEvent - Emite um evento de telemetria.
 * @returns {void}
 */
function registrar(app, deps) {
  const { adminMiddleware, appendActivity, trackEvent } = deps;

app.get('/api/admin/update/check', adminMiddleware, async (_req, res) => {
  try {
    res.json(await atualizacao.verificar());
  } catch (err) {
    res.json({ ok: false, erro: 'Não deu para falar com o servidor de atualizações: ' + err.message });
  }
});

// O estado carrega dois campos que a tela precisa respeitar: `reinicio`
// ('automatico' | 'manual') e `mensagem`. Onde não há supervisor o Nascera NÃO
// reinicia sozinho — dizer "reiniciando" ali seria mentira, e `mensagem` traz o
// texto verdadeiro, com a instrução do que fazer.
app.get('/api/admin/update/status', adminMiddleware, (_req, res) => {
  res.json({ ...atualizacao.estado(), historico: atualizacao.historico(), versaoAtual: atualizacao.versaoAtual() });
});

app.post('/api/admin/update/apply', adminMiddleware, async (req, res) => {
  appendActivity({ type: 'admin_update_started', user: req.user.user, data: {}, at: new Date().toISOString() });
  // Sem `aoTerminar` de propósito: quem sabe se ESTA máquina volta sozinha é o
  // módulo de atualização, que conhece o supervisor — não a camada HTTP. Mandar
  // um encerramento daqui era o que fazia o Nascera sumir no Windows: a rota
  // pedia para morrer sem que existisse alguém para subir de novo.
  const r = await atualizacao.aplicar();
  if (r.erro) return res.status(400).json({ error: r.erro });
  trackEvent('platform_updated', { version: r.versao, reinicio: r.reinicio }, req.user.user);
  // `r` leva `reinicio` e `mensagem` adiante: a resposta é o que a tela mostra,
  // e ela tem que corresponder ao que vai acontecer de verdade.
  res.json(r);
});
}

module.exports = { registrar };
