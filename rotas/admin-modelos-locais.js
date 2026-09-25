// ═══════════════════════════════════════════════════════════════════════
// NASCERA — rotas admin de modelos locais / LLM open source (S4)
// listar/baixar/progresso/remover/testar/usar. Dep: modelos-locais.
// getChannels resolve o Map `channels` em tempo de request (sem TDZ).
// ═══════════════════════════════════════════════════════════════════════
const modelosLocais = require('../modelos-locais.js');

/**
 * Monta as rotas admin de modelos locais / LLM open source
 * (`/api/admin/modelos-locais/*`): listar, baixar, progresso, remover, testar e usar.
 *
 * @param {import('express').Express} app - App do Express onde as rotas são montadas.
 * @param {object} deps - Dependências injetadas pelo server.js (composition root).
 * @param {import('express').RequestHandler} deps.adminMiddleware - Guarda de admin; exige papel admin.
 * @param {() => object} deps.loadNasceraConfig - Lê a config global do Nascera.
 * @param {(cfg: object) => void} deps.saveNasceraConfig - Grava a config global.
 * @param {() => Map<string,object>} deps.getChannels - Resolve o Map `channels` em tempo de request (evita TDZ).
 * @param {(evt: object) => void} deps.appendActivity - Registra um evento no log de atividade.
 * @returns {void}
 */
function registrar(app, deps) {
  const { adminMiddleware, loadNasceraConfig, saveNasceraConfig, getChannels, appendActivity } = deps;

app.get('/api/admin/modelos-locais', adminMiddleware, async (_req, res) => {
  try {
    const [estado, catalogo] = await Promise.all([modelosLocais.estado(), modelosLocais.catalogo()]);
    res.json({ ...estado, ...catalogo, emUso: loadNasceraConfig().modeloLocal || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/modelos-locais/baixar', adminMiddleware, (req, res) => {
  try {
    const job = modelosLocais.baixar(String(req.body && req.body.id || ''));
    appendActivity({ type: 'modelo_local_download', user: req.user.user, data: { id: job.id }, at: new Date().toISOString() });
    res.json({ ok: true, progresso: job });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/admin/modelos-locais/progresso/:id(*)', adminMiddleware, (req, res) => {
  res.json(modelosLocais.progresso(req.params.id) || { desconhecido: true });
});

app.delete('/api/admin/modelos-locais/:id(*)', adminMiddleware, async (req, res) => {
  try {
    // Apagar o modelo que está em uso deixaria o motor apontando para o nada.
    if (loadNasceraConfig().modeloLocal === req.params.id) {
      return res.status(400).json({ error: 'Este modelo está em uso. Volte para o Claude antes de removê-lo.' });
    }
    res.json(await modelosLocais.remover(req.params.id));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/admin/modelos-locais/testar', adminMiddleware, async (req, res) => {
  res.json(await modelosLocais.testar(String(req.body && req.body.id || '')));
});

// Escolher o modelo. id vazio = voltar para o Claude.
app.put('/api/admin/modelos-locais/usar', adminMiddleware, async (req, res) => {
  try {
    const id = String((req.body && req.body.id) || '').trim();
    if (id) {
      const instalados = (await modelosLocais.listar()).map(m => m.id);
      if (!instalados.includes(id)) return res.status(400).json({ error: 'Esse modelo não está baixado nesta máquina.' });
    }
    const cfg = loadNasceraConfig();
    cfg.modeloLocal = id || null;
    saveNasceraConfig(cfg);
    // As sessões vivas nasceram com o modelo antigo no ambiente; só um
    // reinício faz o motor pegar o novo.
    const channels = getChannels();
    let encerradas = 0;
    try {
      for (const [, ch] of channels) { try { ch.session.close('troca de modelo'); encerradas++; } catch {} }
      channels.clear();
    } catch {}
    appendActivity({ type: 'modelo_local_selecionado', user: req.user.user, data: { id: id || 'claude' }, at: new Date().toISOString() });
    res.json({ ok: true, emUso: cfg.modeloLocal, sessoesReiniciadas: encerradas });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
}

module.exports = { registrar };
