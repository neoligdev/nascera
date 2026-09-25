// ═══════════════════════════════════════════════════════════════════════
// NASCERA — rotas de integrações (S4: extraído do server.js)
// Coberto pelo smoke (/api/integrations) e pelo teste de SSRF do /:id/test.
// ═══════════════════════════════════════════════════════════════════════
const axios = require('axios');

/**
 * Monta as rotas de integrações (`/api/integrations/*`): listar, conectar,
 * remover e testar. O teste (`/:id/test`) atravessa o guarda de SSRF.
 *
 * @param {import('express').Express} app - App do Express onde as rotas são montadas.
 * @param {object} deps - Dependências injetadas pelo server.js (composition root).
 * @param {import('express').RequestHandler} deps.authMiddleware - Guarda de sessão; exige usuário logado.
 * @param {() => object} deps.loadIntegrations - Lê o store de integrações.
 * @param {(data: object) => void} deps.saveIntegrations - Grava o store de integrações.
 * @returns {void}
 */
function registrar(app, deps) {
  const { authMiddleware, loadIntegrations, saveIntegrations } = deps;

app.get('/api/integrations', authMiddleware, (_req, res) => {
  const data = loadIntegrations();
  res.json(data);
});

app.post('/api/integrations/connect', authMiddleware, (req, res) => {
  const { id, credentials } = req.body;
  if (!id || !credentials) return res.status(400).json({ error: 'id and credentials required' });
  const data = loadIntegrations();
  data[id] = { ...credentials, connectedAt: new Date().toISOString() };
  saveIntegrations(data);
  res.json({ ok: true, connectedAt: data[id].connectedAt });
});

app.delete('/api/integrations/:id', authMiddleware, (req, res) => {
  const data = loadIntegrations();
  delete data[req.params.id];
  saveIntegrations(data);
  res.json({ ok: true });
});

app.post('/api/integrations/:id/test', authMiddleware, async (req, res) => {
  const { credentials } = req.body;
  const id = req.params.id;
  if (!credentials) return res.status(400).json({ error: 'credentials required' });
  try {
    if (id === 'trello') {
      await axios.get('https://api.trello.com/1/members/me?key=' + credentials.apiKey + '&token=' + credentials.token);
    } else if (id === 'github') {
      await axios.get('https://api.github.com/user', { headers: { Authorization: 'token ' + credentials.token, 'User-Agent': 'Fluxora' } });
    } else if (id === 'slack') {
      const r = await axios.post('https://slack.com/api/auth.test', {}, { headers: { Authorization: 'Bearer ' + credentials.botToken } });
      if (!r.data.ok) throw new Error(r.data.error || 'Slack auth failed');
    } else if (id === 'openai') {
      await axios.get('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer ' + credentials.apiKey } });
    } else if (id === 'notion') {
      await axios.get('https://api.notion.com/v1/users/me', { headers: { Authorization: 'Bearer ' + credentials.token, 'Notion-Version': '2022-06-28' } });
    } else if (id === 'figma') {
      await axios.get('https://api.figma.com/v1/me', { headers: { 'X-Figma-Token': credentials.token } });
    } else if (id === 'discord') {
      await axios.get('https://discord.com/api/v10/users/@me', { headers: { Authorization: 'Bot ' + credentials.botToken } });
    } else if (id === 'linear') {
      await axios.post('https://api.linear.app/graphql', { query: '{ viewer { id } }' }, { headers: { Authorization: credentials.apiKey } });
    } else if (id === 'vercel') {
      await axios.get('https://api.vercel.com/v2/user', { headers: { Authorization: 'Bearer ' + credentials.token } });
    } else if (id === 'stripe') {
      await axios.get('https://api.stripe.com/v1/balance', { headers: { Authorization: 'Bearer ' + credentials.secretKey } });
    } else if (id === 'supabase') {
        // SSRF: diferente das outras integrações (host fixo), aqui a URL vem
        // do usuário. Sem filtro, o "teste de conexão" vira uma sonda para a
        // rede interna — inclusive o metadata da nuvem (169.254.169.254), que
        // devolve credenciais da instância. Exige HTTPS e recusa destino privado.
        let alvo;
        try { alvo = new URL(String(credentials.url || '')); }
        catch { return res.json({ ok: false, error: 'URL do Supabase inválida' }); }
        if (alvo.protocol !== 'https:') {
          return res.json({ ok: false, error: 'A URL do Supabase precisa ser https://' });
        }
        const _h = alvo.hostname;
        const _privado = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?|172\.(1[6-9]|2\d|3[01])\.)/i.test(_h)
          || _h.endsWith('.local') || _h.endsWith('.internal');
        if (_privado) return res.json({ ok: false, error: 'Endereço não permitido para integração' });
        await axios.get(alvo.origin + '/rest/v1/', {
          timeout: 8000, maxRedirects: 0,   // redirect é rota de fuga do filtro
          headers: { apikey: credentials.anonKey, Authorization: 'Bearer ' + credentials.anonKey },
        });
    } else {
      return res.json({ ok: true, message: 'Credenciais salvas (teste nao disponivel para esta integracao)' });
    }
    res.json({ ok: true, message: 'Conexao verificada com sucesso!' });
  } catch (err) {
    const msg = err.response ? (err.response.data.error || err.response.data.message || err.response.statusText) : err.message;
    res.status(400).json({ ok: false, error: 'Falha na conexao: ' + msg });
  }
});
}

module.exports = { registrar };
