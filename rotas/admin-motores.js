// ═══════════════════════════════════════════════════════════════════════
// NASCERA — rotas admin de motores (S4: extraído do server.js)
// estado, diagnóstico (o atalho do suporte), trocar e instalar motor.
// Dep principal: o módulo motores. Coberto pelo smoke (/api/admin/motores*).
// `getChannels` é getter: o Map `channels` só existe mais adiante no
// server.js, então resolvemos em tempo de request (sem TDZ).
// ═══════════════════════════════════════════════════════════════════════
const motores = require('../motores.js');

/**
 * Monta as rotas admin de motores/CLIs de IA (`/api/admin/motores/*`): estado,
 * diagnóstico (atalho do suporte), trocar e instalar motor.
 *
 * @param {import('express').Express} app - App do Express onde as rotas são montadas.
 * @param {object} deps - Dependências injetadas pelo server.js (composition root).
 * @param {import('express').RequestHandler} deps.adminMiddleware - Guarda de admin; exige papel admin.
 * @param {() => object} deps.loadNasceraConfig - Lê a config global do Nascera.
 * @param {(cfg: object) => void} deps.saveNasceraConfig - Grava a config global.
 * @param {() => void} deps.invalidarCmdDoMotor - Zera o cache do comando do motor após troca.
 * @param {() => Map<string,object>} deps.getChannels - Resolve o Map `channels` em tempo de request (evita TDZ).
 * @param {(evt: object) => void} deps.appendActivity - Registra um evento no log de atividade.
 * @returns {void}
 */
function registrar(app, deps) {
  const { adminMiddleware, loadNasceraConfig, saveNasceraConfig, invalidarCmdDoMotor, getChannels, appendActivity } = deps;

app.get('/api/admin/motores', adminMiddleware, async (_req, res) => {
  try {
    const e = await motores.estado();
    res.json({ ...e, emUso: motores.ehValido(loadNasceraConfig().motor) ? loadNasceraConfig().motor : 'claude' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Diagnóstico do motor — o atalho do suporte para "não consigo fazer login".
// Responde de onde veio o CLI (embarcado/global/env), qual versão está em uso
// e se ela casa com a SDK. Antes disso, a única saída era pedir print de
// terminal para o cliente. `?reparar=1` tenta restaurar o CLI embarcado.
app.get('/api/admin/motores/diagnostico', adminMiddleware, async (req, res) => {
  try {
    if (String(req.query.reparar || '') === '1') {
      const r = await motores.garantirMotor('claude', { reparar: true });
      // O reparo trocou o binário no disco: descarta o caminho em cache para
      // que as próximas chamadas usem o CLI novo sem exigir restart.
      if (r.reparado) invalidarCmdDoMotor();
      return res.json({ reparo: r, diagnostico: await motores.diagnostico('claude') });
    }
    const [claude, codex] = await Promise.all([
      motores.diagnostico('claude'),
      motores.diagnostico('codex'),
    ]);
    res.json({ claude, codex, node: process.version });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/motores/usar', adminMiddleware, async (req, res) => {
  try {
    const id = String((req.body && req.body.id) || '');
    if (!motores.ehValido(id)) return res.status(400).json({ error: 'Motor desconhecido' });

    // Não deixar escolher um motor que não vai funcionar: o erro apareceria
    // só no primeiro turno, parecendo defeito do NASCERA.
    const est = await motores.estadoDe(id);
    if (!est.instalado) return res.status(400).json({ error: `O CLI do ${est.nome} não está instalado. Instale com: ${est.comoInstalar}` });
    if (!est.conectado) {
      // "Instalado mas não conectado" era mentira sempre que o NASCERA não
      // conseguiu nem EXECUTAR o CLI para perguntar (no Windows, o shim .cmd).
      // O cliente já tinha feito login e o painel mandava fazer de novo. Quando
      // há motivo técnico, ele vai junto — a mensagem passa a apontar o defeito
      // real em vez de acusar o usuário.
      return res.status(400).json({
        error: est.provaErro
          ? `Não deu para confirmar o login do ${est.nome}: ${est.provaErro}`
          : `O ${est.nome} está instalado mas não conectado. Rode: ${est.comandoLogin}`,
      });
    }

    const cfg = loadNasceraConfig();
    cfg.motor = id;
    saveNasceraConfig(cfg);

    const channels = getChannels();
    let encerradas = 0;
    try {
      for (const [, ch] of channels) { try { ch.session.close('troca de motor'); encerradas++; } catch {} }
      channels.clear();
    } catch {}
    appendActivity({ type: 'motor_alterado', user: req.user.user, data: { motor: id }, at: new Date().toISOString() });
    res.json({ ok: true, emUso: id, sessoesReiniciadas: encerradas });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/admin/motores/instalar', adminMiddleware, async (req, res) => {
  const id = String((req.body && req.body.id) || '');
  if (!motores.ehValido(id)) return res.status(400).json({ error: 'Motor desconhecido' });
  appendActivity({ type: 'motor_instalando', user: req.user.user, data: { motor: id }, at: new Date().toISOString() });
  res.json(await motores.instalar(id));
});
}

module.exports = { registrar };
