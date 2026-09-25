// ═══════════════════════════════════════════════════════════════════════
// NASCERA — histórico de chat de um projeto (S4: extraído do server.js)
//
// GET/DELETE /api/projects/:id/chat-history. Só as DUAS pontas de leitura são
// extraídas; o cache vivo (_chatCache), o appendChatMessage e o flushChat
// PERMANECEM no server.js — são donos do caminho quente do WebSocket/motor.
// Aqui só entram loadChatHistory (devolve cópia) e clearChatHistory (S2-1:
// zera cache E arquivo juntos), injetados por referência. O Map nunca é movido,
// então não há landmine de estado compartilhado.
//
// Portão de dono: projectOr404 (W1/IDOR — 404 para projeto alheio).
// ═══════════════════════════════════════════════════════════════════════
/**
 * Monta as duas rotas de leitura do histórico de chat de um projeto
 * (`GET`/`DELETE /api/projects/:id/chat-history`). O cache vivo e a escrita
 * permanecem no server.js — aqui só entram as pontas de leitura/limpeza.
 *
 * @param {import('express').Express} app - App do Express onde as rotas são montadas.
 * @param {object} deps - Dependências injetadas pelo server.js (composition root).
 * @param {import('express').RequestHandler} deps.authMiddleware - Guarda de sessão; exige usuário logado.
 * @param {import('express').RequestHandler} deps.projectOr404 - Portão de dono (W1/IDOR): resolve `req.projeto` ou responde 404 se for de outro usuário.
 * @param {(projectId: string) => object[]} deps.loadChatHistory - Devolve uma cópia do histórico do projeto.
 * @param {(projectId: string) => void} deps.clearChatHistory - Zera cache e arquivo juntos (S2-1).
 * @returns {void}
 */
function registrar(app, deps) {
  const { authMiddleware, projectOr404, loadChatHistory, clearChatHistory } = deps;

  app.get('/api/projects/:id/chat-history', authMiddleware, (req, res) => {
    // Portão de dono: sem isto, trocar o :id lê/altera projeto alheio (IDOR).
    const proj = projectOr404(req, res); if (!proj) return;
    const history = loadChatHistory(proj.id);
    res.json({ messages: history });
  });

  // API: Clear chat history
  app.delete('/api/projects/:id/chat-history', authMiddleware, (req, res) => {
    // Portão de dono: sem isto, trocar o :id lê/altera projeto alheio (IDOR).
    const proj = projectOr404(req, res); if (!proj) return;
    clearChatHistory(proj.id);   // S2-1: zera cache E arquivo
    res.json({ ok: true });
  });
}

module.exports = { registrar };
