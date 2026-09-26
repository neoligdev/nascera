// ═══════════════════════════════════════════════════════════════════════
// NASCERA — rotas admin de motores (S4: extraído do server.js)
// estado, diagnóstico (o atalho do suporte), trocar e instalar motor.
// Dep principal: o módulo motores. Coberto pelo smoke (/api/admin/motores*).
// `getChannels` é getter: o Map `channels` só existe mais adiante no
// server.js, então resolvemos em tempo de request (sem TDZ).
// ═══════════════════════════════════════════════════════════════════════
const motores = require('../motores.js');
const fs = require('fs');
const path = require('path');

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
 * @param {{guardar,obter,esquecer}} deps.segredos - Cofre AES-256-GCM (segredos.js); guarda a chave do provedor DeepSeek do OpenCode.
 * @returns {void}
 */
// Chave do cofre (segredos.js) onde fica a API key do provedor DeepSeek do
// OpenCode — nível de instalação, não por usuário (ver rotas/ia-propria.js
// para o BYOK por usuário, que é outra coisa). O valor nunca vai para o
// opencode.json: o config só referencia o NOME da env var (`DEEPSEEK_API_KEY`);
// quem injeta o valor de verdade é servicos/motor-canal.js, lendo do cofre.
const COFRE_DEEPSEEK = 'motor:opencode:deepseek';

// Garante o bloco `providers.deepseek` no `opencode.json` GLOBAL (nunca no
// `.jsonc` — esse é espaço do operador, ex.: plugins que ele já tenha
// configurado à mão; não pisamos em cima). Escreve só uma vez: se o bloco já
// existir (o operador pode ter editado à mão), não sobrescreve. A chave em
// si NUNCA entra aqui — o arquivo só referencia o NOME da env var
// (DEEPSEEK_API_KEY); quem injeta o valor é servicos/motor-canal.js, lendo
// do cofre na hora de montar o env do processo.
function garantirProvedorDeepSeek() {
  const [caminhoJson] = motores.caminhosConfigOpenCode();
  let atual = {};
  try { atual = JSON.parse(fs.readFileSync(caminhoJson, 'utf8')); } catch { atual = {}; }
  if (atual.providers && atual.providers.deepseek) return; // já existe: não pisar em cima

  fs.mkdirSync(path.dirname(caminhoJson), { recursive: true });
  const novo = {
    ...atual,
    providers: {
      ...(atual.providers || {}),
      deepseek: {
        name: 'DeepSeek',
        env: ['DEEPSEEK_API_KEY'],
        package: '@ai-sdk/openai-compatible',
        settings: { baseURL: 'https://api.deepseek.com/v1' },
        models: {
          'deepseek-chat': { name: 'DeepSeek Chat' },
          'deepseek-reasoner': { name: 'DeepSeek Reasoner' },
        },
      },
    },
  };
  fs.writeFileSync(caminhoJson, JSON.stringify(novo, null, 2) + '\n', { mode: 0o600 });
}

function registrar(app, deps) {
  const { adminMiddleware, loadNasceraConfig, saveNasceraConfig, invalidarCmdDoMotor, getChannels, appendActivity, segredos } = deps;

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
    const ids = Object.keys(motores.MOTORES);
    const diagnosticos = await Promise.all(ids.map((id) => motores.diagnostico(id)));
    const porId = {};
    ids.forEach((id, i) => { porId[id] = diagnosticos[i]; });
    res.json({ ...porId, node: process.version });
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

// ── Provedor DeepSeek dentro do OpenCode (config de instalação, não BYOK) ──
// Não confundir com /api/admin/ia-propria (rotas/ia-propria.js): aquilo é
// por usuário e só fala Anthropic. Isto é uma chave única da instalação,
// igual ao "modelo local" — o admin cola uma vez e todo mundo que usar o
// motor OpenCode com um modelo `deepseek/...` usa essa chave.
app.get('/api/admin/motores/opencode/provedores/deepseek', adminMiddleware, (_req, res) => {
  res.json({ configurada: !!segredos.obter(COFRE_DEEPSEEK) });
});

app.put('/api/admin/motores/opencode/provedores/deepseek', adminMiddleware, (req, res) => {
  const chave = String((req.body && req.body.apiKey) || '').trim();
  if (!chave) return res.status(400).json({ error: 'Informe a chave do DeepSeek.' });
  try {
    garantirProvedorDeepSeek();
    segredos.guardar(COFRE_DEEPSEEK, chave);
    appendActivity({ type: 'motor_provedor_configurado', user: req.user.user, data: { motor: 'opencode', provedor: 'deepseek' }, at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/motores/opencode/provedores/deepseek', adminMiddleware, (req, res) => {
  segredos.esquecer(COFRE_DEEPSEEK);
  appendActivity({ type: 'motor_provedor_removido', user: req.user.user, data: { motor: 'opencode', provedor: 'deepseek' }, at: new Date().toISOString() });
  res.json({ ok: true });
});
}

module.exports = { registrar };
