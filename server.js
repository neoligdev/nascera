// Remove CLAUDECODE env to prevent "nested session" error
delete process.env.CLAUDECODE;

// .env antes de qualquer leitura de config. Sem isto, JWT_SECRET e afins só
// existiam se exportados à mão no ambiente — e o fallback aleatório escondia
// a ausência deles.
require('dotenv').config();
const logger = require('./log.js');

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
// spawnSync entra por causa do CLI do motor (ver claudeCliSync): ao contrário
// do execFileSync, ele devolve stdout e stderr SEPARADOS e não lança quando o
// programa sai com código != 0 — os dois são necessários para reproduzir, sem
// shell, o que a string `... 2>&1` fazia.
const { spawn, spawnSync, execSync, execFileSync } = require('child_process');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const pty = require('node-pty');
const axios = require('axios');
const billing = require('./billing');
const domains = require('./domains');
const theme = require('./theme');
const telemetry = require('./telemetry');
const atualizacao = require('./atualizacao');
const senhas = require('./senhas');
const modelosLocais = require('./modelos-locais');
const motores = require('./motores');
const memoriaProjeto = require('./memoria-projeto');
const imagens = require('./imagens');
// Cofre de credenciais reversíveis (senha SSH de projeto remoto). Elas não
// podem viver em projects.json, que é 644 e vai em backup.
const segredos = require('./segredos');
const { createHostRouter } = require('./site-router');

// ─── Config ────────────────────────────────────────────────────────
const PORT          = process.env.PORT || 3333;
// ─── Segredo de assinatura dos tokens ────────────────────────────────
// Antes: `process.env.JWT_SECRET || crypto.randomBytes(32)`. Como o fallback
// era ALEATÓRIO A CADA BOOT, todo restart invalidava os tokens de todo mundo
// — foi isso que fez a sessão do navegador cair "sozinha" nos testes, e não
// a expiração. Pior: mascarava a ausência de configuração em produção.
// Agora: env manda; sem env, gera UMA vez e PERSISTE (0600). Segredo curto
// é erro de configuração e derruba o boot — aí sim fail-closed.
const JWT_SECRET = (function resolverSegredo() {
  const doAmbiente = process.env.JWT_SECRET;
  if (doAmbiente) {
    if (doAmbiente.length < 32) {
      logger.error('\n[FATAL] JWT_SECRET tem menos de 32 caracteres. Gere um forte:\n' +
                    '        node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n');
      process.exit(1);
    }
    return doAmbiente;
  }
  const arquivo = path.join(__dirname, '.jwt-secret');
  try {
    const salvo = fs.readFileSync(arquivo, 'utf8').trim();
    if (salvo.length >= 32) return salvo;
  } catch { /* ainda não existe */ }
  const novo = crypto.randomBytes(48).toString('hex');
  try {
    fs.writeFileSync(arquivo, novo, { mode: 0o600 });
    fs.chmodSync(arquivo, 0o600);
    logger.info('[auth] JWT_SECRET gerado e salvo em .jwt-secret (0600). ' +
                'Em produção, prefira definir a variável de ambiente.');
  } catch (e) {
    logger.error('[auth] não consegui persistir o segredo (' + e.message +
                  '): as sessões vão cair a cada restart. Defina JWT_SECRET no ambiente.');
  }
  return novo;
})();
const JWT_ISS = 'nascera';
const JWT_AUD = 'nascera-app';

// Emissão única de token. O bug que isto fecha: os sign faziam `iat: Date.now()`
// (milissegundos), e o jsonwebtoken trata iat como SEGUNDOS — o exp caía no ano
// ~58570, ou seja, o token NUNCA expirava. Deixar a lib carimbar o iat (em
// segundos) faz o `expiresIn` valer de verdade. issuer/audience/jti fecham
// reuso entre contextos e dão rastro por token.
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: '24h',
    issuer: JWT_ISS,
    audience: JWT_AUD,
    jwtid: crypto.randomBytes(12).toString('hex'),
  });
}
// O CLI do motor vem do node_modules do próprio NASCERA (pinado pelo lock), não
// do `claude` global do usuário — ver o cabeçalho de motores.js. Era o global
// desatualizado que quebrava o login do cliente: aqui, global 2.1.181 contra
// embarcado 2.1.220. `binarioSync` respeita CLAUDE_CMD/CODEX_CMD do ambiente.
// ATENÇÃO: agora isto é um caminho ABSOLUTO e pode conter espaços — passe
// sempre como argv (spawn/spawnSync/execFile), nunca dentro de string de shell.
// NÃO congelar numa const: o preflight do boot (garantirMotorNoBoot) pode
// RESTAURAR o CLI embarcado depois que este módulo já foi carregado. Uma
// const capturada aqui manteria o processo inteiro chamando o binário velho
// até alguém reiniciar — o auto-conserto consertaria o disco e não o processo.
// Função com cache: resolve na primeira chamada e é invalidada após reparo.
let _claudeCmd = null;
function claudeCmd() {
  if (!_claudeCmd) _claudeCmd = motores.binarioSync('claude') || 'claude';
  return _claudeCmd;
}
function invalidarCmdDoMotor() { _claudeCmd = null; }
// No desktop (macOS/Windows) o Claude roda como o próprio usuário — não há
// claude-runner para propagar credencial nem raiz /root. Definido cedo porque
// rotas/setup.js recebe este valor por injeção no carregamento do módulo.
const isDesktopLocal = process.env.NASCERA_DESKTOP === 'true' || process.platform === 'darwin' || process.platform === 'win32';
const claudeAuth = require('./claude-auth.js');
// NASCERA_PROJECTS_FILE: override só para teste isolar o estado em tmp e NUNCA
// tocar o projects.json real. Inerte em produção (env desligada = caminho de sempre).
const PROJECTS_FILE = process.env.NASCERA_PROJECTS_FILE || path.join(__dirname, 'projects.json');
const _home = process.env.HOME || require('os').homedir() || '/root';
const PROJECTS_BASE = process.env.PROJECTS_BASE || path.join(_home, 'Nascera AI Projects');
const PUBLISHED_BASE = process.env.PUBLISHED_BASE || path.join(PROJECTS_BASE, '_published');
const TRASH_DIR = process.env.TRASH_DIR || path.join(PROJECTS_BASE, '_trash');
// Miniaturas dos projetos/extrações. Definido cedo porque rotas/tools.js
// recebe THUMB_DIR por injeção no carregamento do módulo (antes ficava lá
// embaixo, junto do screenshot, e a extração de tools batia em TDZ).
const THUMB_DIR = path.join(__dirname, 'themes', 'thumbnails');
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });
// Dev servers vivos por projeto. Içado ao topo porque rotas/projetos-preview.js
// (visual-save) recebe esta referência por injeção no load, e startDevServer +
// a rota /preview (ambos no server.js) mutam o MESMO objeto.
const _devServers = {};
// Canais do motor (um por projeto+usuário): liga os eventos da sessão UMA vez
// (persistência + broadcast); sockets entram e saem sem duplicar listeners.
// Içado ao topo (era o landmine de TDZ mais afiado) para bindChannel/ensureChannel
// e o handler do WebSocket poderem receber a referência por injeção no load.
const channels = new Map();

// ─── Em qual interface o servidor escuta ─────────────────────────────
// Antes: `0.0.0.0` fixo, ou seja, QUALQUER aparelho da rede alcançava o
// painel. Num café ou num escritório compartilhado isso é grave: o shell do
// NASCERA roda com as permissões do dono da máquina, então alcançar a porta é
// meio caminho para controlar o computador.
//
// Agora o padrão é `127.0.0.1` (só esta máquina). Expor é uma DECISÃO, feita
// de propósito com NASCERA_BIND=0.0.0.0 — que é o caso legítimo da VPS, onde o
// servidor precisa mesmo atender a internet.
const BIND = process.env.NASCERA_BIND
  || (process.env.NASCERA_DESKTOP === 'true' ? '127.0.0.1'
     : (process.platform === 'darwin' || process.platform === 'win32') ? '127.0.0.1'
     : '0.0.0.0');   // Linux/VPS mantém o comportamento de servidor
// Portão único de toda exclusão. Configurado aqui, antes de qualquer rota,
// porque nenhuma delas pode apagar arquivo sem passar por ele.
const seguranca = require('./caminhos-seguros.js');
seguranca.configurar(PROJECTS_BASE);
// Escrita atômica + leitura que não mascara corrupção como vazio.
const { gravaEstado, leEstado } = require('./estado-seguro.js');
// Banco: só entra em ação com DATABASE_URL definida. Sem ela, `db.ATIVO` é
// false e todo o produto segue no JSON, exatamente como hoje.
const db = require('./db.js');
// Plano de dados no Postgres (write-through com cache). Com NASCERA_DB_STATE=pg,
// os acessores canônicos (loadProjects & cia) passam a ler do cache e gravar
// no banco — sem quebrar a interface síncrona. Ver estado-db.js.
const estadoDb = require('./estado-db.js');
const VPS_HOST      = process.env.VPS_HOST || '138.199.165.45';
const PREVIEW_PORT  = process.env.PREVIEW_PORT || 4001;
const PUBLISH_PORT  = process.env.PUBLISH_PORT || 4002;
const AGENTS_DIR    = path.join(__dirname, 'agents');
const TEMPLATES_DIR = path.join(__dirname, 'templates');
const VALID_AGENTS  = ['dev', 'architect', 'qa', 'pm', 'ux', 'sm'];
const INTEGRATIONS_FILE = path.join(__dirname, 'integrations.json');

// Ensure published base dir exists
if (!fs.existsSync(PUBLISHED_BASE)) fs.mkdirSync(PUBLISHED_BASE, { recursive: true });
if (!fs.existsSync(TRASH_DIR)) fs.mkdirSync(TRASH_DIR, { recursive: true });

// ─── Telemetry Collector ───────────────────────────────────────────
const LICENSE_SERVER_URL = process.env.LICENSE_SERVER_URL || 'https://api.nascera.ai';
const TELEMETRY_BUFFER_FILE = path.join(__dirname, 'telemetry-buffer.json');
let telemetryBuffer = [];

// Traduz o usuário local (ex.: "maria.slv") para o email dele. É o que
// o painel do titular usa para saber QUEM fez o quê — o nome de usuário só
// existe dentro desta instalação e não diz nada lá fora.
function emailDoUsuario(username) {
  if (!username) return null;
  try {
    const u = (loadUsers() || {})[username];
    return u && u.email ? String(u.email).trim().toLowerCase() : null;
  } catch { return null; }
}

function trackEvent(eventType, data, userId, licenseId) {
  // Espelho local para o painel admin (o buffer abaixo é despachado e se perde)
  try { appendActivity({ type: eventType, user: userId || null, data: data || {}, at: new Date().toISOString() }); } catch {}
  if (typeof loadNasceraConfig === 'function' && loadNasceraConfig().telemetryEnabled === false) return;
  telemetryBuffer.push({
    eventType, data: data || {},
    // installId amarra o evento à MÁQUINA; actorEmail, à PESSOA. Sem os dois,
    // o evento chega no servidor do titular sem dono e vira número solto.
    installId: (() => { try { return telemetry.loadIdentity().installId; } catch { return null; } })(),
    actorEmail: emailDoUsuario(userId) || (data && data.email) || null,
    licenseId: licenseId || null,
    deviceOs: process.platform,
    appVersion: process.env.APP_VERSION || require('./package.json').version || '1.0.0',
    timestamp: new Date().toISOString()
  });
  if (telemetryBuffer.length >= 50) flushTelemetry();
}

async function flushTelemetry() {
  if (telemetryBuffer.length === 0) return;
  const events = [...telemetryBuffer];
  telemetryBuffer = [];
  try {
    await axios.post(`${LICENSE_SERVER_URL}/api/telemetry/batch`, { events }, { timeout: 10000 });
  } catch {
    try {
      const existing = leEstado(TELEMETRY_BUFFER_FILE, { fallback: [] });
      gravaEstado(TELEMETRY_BUFFER_FILE, [...existing, ...events].slice(-500), { pretty: 0 });
    } catch {}
  }
}
setInterval(flushTelemetry, 60000);
setTimeout(async () => {
  try {
    if (fs.existsSync(TELEMETRY_BUFFER_FILE)) {
      const buffered = JSON.parse(fs.readFileSync(TELEMETRY_BUFFER_FILE, 'utf8'));
      if (buffered.length > 0) {
        await axios.post(`${LICENSE_SERVER_URL}/api/telemetry/batch`, { events: buffered }, { timeout: 10000 });
        fs.unlinkSync(TELEMETRY_BUFFER_FILE);
      }
    }
  } catch {}
}, 10000);

// Users
let USERS = {}; // In-memory cache, populated from users.json

// ─── Projects Storage ────────────────────────────────────────────────
function loadProjects() {
  if (estadoDb.ATIVO) return estadoDb.projetos.lista();
  // Crítico: corrupção aborta o boot em vez de devolver [] e apagar tudo.
  return leEstado(PROJECTS_FILE, { fallback: [], critico: true });
}
function saveProjects(projects) {
  // Diário durável em JSON PRIMEIRO (à prova de crash), depois atravessa para
  // o Postgres. O JSON é a fonte de reconciliação no boot.
  gravaEstado(PROJECTS_FILE, projects);
  if (estadoDb.ATIVO) estadoDb.projetos.sincronizar(projects);
}

// S1-2: o único jeito seguro de alterar um projeto.
//
// O padrão load→find→mutar→save estava copiado dezenas de vezes, e a variante
// venenosa — mutar o `proj` que veio do projectOr404 (que faz o SEU próprio
// loadProjects) e depois salvar OUTRO array — não persistia nada. Foi o bug do
// S0-2 (PATCH) e de mais três rotas (miniatura por dataUrl, proxyTarget,
// publish). Aqui a mutação acontece no objeto do array que vai para o disco.
// `patch` pode ser um objeto (Object.assign) ou uma função que recebe o alvo.
// Devolve o objeto salvo, ou null se o id não existe.
function atualizarProjeto(id, patch) {
  const projects = loadProjects();
  const alvo = projects.find(p => p.id === id);
  if (!alvo) return null;
  if (typeof patch === 'function') patch(alvo);
  else if (patch && typeof patch === 'object') Object.assign(alvo, patch);
  saveProjects(projects);
  return alvo;
}

// --- Integrations Storage ---
// Cache em memória: getIntegrationsContext() roda a cada mensagem do chat; sem cache isso era
// um readFileSync síncrono toda vez. O cache é mantido em sincronia pelo saveIntegrations.
let _integrationsCache = null;
function loadIntegrations() {
  if (_integrationsCache) return _integrationsCache;
  _integrationsCache = leEstado(INTEGRATIONS_FILE, { fallback: {} });
  return _integrationsCache;
}
function saveIntegrations(data) {
  gravaEstado(INTEGRATIONS_FILE, data);
  _integrationsCache = data;
}

// ─── Chat History Persistence ───
function getChatHistoryPath(projectId) {
  const projects = loadProjects();
  const proj = projects.find(p => p.id === projectId);
  if (!proj || !proj.path) return null;
  return path.join(proj.path, '.chat-history.json');
}

// ─── Histórico de chat com cache + flush debounced (S2-1) ──────────────
// Antes, appendChatMessage relia+parseava+reescrevia o arquivo INTEIRO com
// fsync a CADA evento de ferramenta durante o streaming (~4x por evento). Num
// turno de 50 eventos isso é O(n²) de I/O e travava o event loop ~0,6s. Agora
// o histórico vive em memória por projeto: append é O(1), e a gravação em
// disco é agrupada (no máx. 1x por ~800ms e no fim do turno). Perde-se, no
// pior caso de crash, <1s de mensagens de CHAT — não é dinheiro, e o ganho de
// latência no caminho quente é enorme.
const CHAT_MAX = 200;
const CHAT_FLUSH_MS = 800;
const _chatCache = new Map();   // projectId → { fp, history, dirty, timer }

function _chatEntry(projectId) {
  let e = _chatCache.get(projectId);
  if (e) return e;
  const fp = getChatHistoryPath(projectId);
  if (!fp) return null;
  e = { fp, history: leEstado(fp, { fallback: [] }), dirty: false, timer: null };
  _chatCache.set(projectId, e);
  return e;
}

function flushChat(projectId) {
  const e = _chatCache.get(projectId);
  if (!e || !e.dirty) return;
  if (e.timer) { clearTimeout(e.timer); e.timer = null; }
  try { gravaEstado(e.fp, e.history); e.dirty = false; }
  catch (err) { logger.error('[CHAT] flush error:', err.message); }
}

function loadChatHistory(projectId) {
  const e = _chatEntry(projectId);
  return e ? e.history.slice() : [];   // cópia: quem lê não muta o cache
}

function appendChatMessage(projectId, msg) {
  const e = _chatEntry(projectId);
  if (!e) return;
  e.history.push(msg);
  if (e.history.length > CHAT_MAX) e.history = e.history.slice(-CHAT_MAX);
  e.dirty = true;
  if (!e.timer) e.timer = setTimeout(() => { e.timer = null; flushChat(projectId); }, CHAT_FLUSH_MS);
}

// Descartar o histórico (rota de limpar): zera o cache e o arquivo juntos.
function clearChatHistory(projectId) {
  const e = _chatCache.get(projectId);
  if (e && e.timer) clearTimeout(e.timer);
  _chatCache.delete(projectId);
  const fp = getChatHistoryPath(projectId);
  if (fp) { try { fs.existsSync(fp) && fs.unlinkSync(fp); } catch {} }
}

// Não perder o buffer num shutdown gracioso.
function flushTodosOsChats() { for (const id of _chatCache.keys()) flushChat(id); }

// ─── Nível de detalhe do build (slider "mais rápido ↔ mais completo") ───
// O usuário escolhe na criação do projeto. Cada nível vira: (a) uma instrução de
// escopo injetada na mensagem e (b) o esforço de raciocínio do modelo.
const BUILD_LEVELS = {
  1: {
    name: 'Rascunho',
    effort: 'low',
    scope: 'ESCOPO: rascunho rápido. Entregue UM único arquivo HTML com apenas o essencial — um título, uma frase de apoio e um botão de ação. Nada de seções extras, animações ou conteúdo de preenchimento. Priorize velocidade: menos é mais aqui.',
  },
  2: {
    name: 'Enxuto',
    effort: 'low',
    scope: 'ESCOPO: enxuto. Entregue UMA página com no máximo 3 seções (hero, um bloco de conteúdo e um fechamento com chamada para ação). Visual limpo, sem animações elaboradas e sem conteúdo de preenchimento.',
  },
  3: {
    name: 'Equilibrado',
    effort: 'medium',
    scope: 'ESCOPO: equilibrado. Entregue UMA landing page completa com 4 a 6 seções (hero, benefícios, prova social ou demonstração, chamada para ação e rodapé). Bom acabamento visual, sem exageros. Este é o padrão.',
  },
  4: {
    name: 'Completo',
    effort: 'high',
    scope: 'ESCOPO: completo. Entregue uma página rica com 7 ou mais seções, microinterações, estados de hover e acabamento caprichado. Pode incluir uma segunda página se fizer sentido para o pedido.',
  },
  5: {
    name: 'Máximo',
    effort: 'xhigh',
    scope: 'ESCOPO: máximo. Entregue um projeto multi-página com navegação entre páginas, conteúdo extenso e bem escrito, animações, estados vazios e de carregamento, e responsividade cuidadosa em todos os breakpoints. Capriche em cada detalhe.',
  },
};

function normalizeBuildLevel(v) {
  const n = parseInt(v, 10);
  return (n >= 1 && n <= 5) ? n : 3;
}

// Bloco injetado na mensagem — mesmo padrão do contexto de integrações.
function getBuildScopeContext(level) {
  const cfg = BUILD_LEVELS[normalizeBuildLevel(level)];
  return '\n\n---\n[Preferência de escopo do usuário — nível "' + cfg.name + '"]\n' + cfg.scope +
    '\nSe o pedido do usuário for explicitamente mais amplo ou mais restrito que este escopo, o pedido dele vence.';
}

// Generate slug from name
function makeSlug(name) {
  return name.trim().replace(/[^a-zA-Z0-9_\-. ]/g, '').replace(/\s+/g, '-').toLowerCase();
}

// Run a shell command in a directory, returns stdout
// ATENÇÃO: string de shell. Sobrou UM chamador, e de propósito: o ramo da VPS
// em `listarPluginsInstalados` (`su -s /bin/bash -c ...`), que é Linux por
// definição. Não use isto para nada novo — para o CLI do motor existe o
// `claudeCliSync` logo abaixo, que passa argv sem shell nos três sistemas.
function runCmd(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    return null;
  }
}

// ─── CLI do motor por ARGV, nos três sistemas ────────────────────────
// Duas armadilhas do Windows fechadas aqui, as duas silenciosas:
//   1. o `claude` instalado por npm não é executável, é um `claude.cmd`
//      (script). A busca de PATH do Node só tenta .com/.exe, então o nome nu
//      dá ENOENT sem stderr; e desde o Node 18.20/20.12 (BatBadBut,
//      CVE-2024-27980) o Node RECUSA rodar .cmd sem `shell: true` — nem
//      apontar direto para o .cmd resolvia.
//   2. o shell do Windows não é o bash: `2>&1` e aspas simples de string de
//      shell não significam lá o que significam aqui.
// Juntas, faziam a instalação de skill estourar e a lista de plugins voltar
// SEMPRE vazia, com o catch engolindo o motivo.
//
// A saída NÃO é `if (process.platform === 'win32')`: `motores.invocacaoDe` é o
// helper NEUTRO da portabilidade — em macOS/Linux devolve
// `{ arquivo: 'claude', args, shell: false }`, que é literalmente o argv de
// hoje, e só no Windows resolve o .js por trás do shim (ou, em último caso, o
// cmd.exe com cada argumento conferido um a um).
//
// spawnSync e não execFileSync porque os dois chamadores querem coisas
// diferentes da saída: um quer só o stdout (contrato antigo do install), o
// outro quer stdout e stderr juntos (era o papel do `2>&1` na listagem). E
// `erro` nunca volta vazio quando o processo NÃO RODOU: ENOENT/EINVAL não
// escrevem em stderr, e sem isto o motivo real morria dentro do catch.
function claudeCliSync(subcomandos, cwd, timeoutMs) {
  let inv;
  try {
    inv = motores.invocacaoDe('claude', subcomandos);
  } catch (e) {
    // Argumento recusado pelo helper (metacaractere que viraria injeção de
    // comando no cmd.exe) é falha do comando, não exceção solta no meio de um
    // request — mas o motivo vai junto, não vira lista vazia.
    return { ok: false, stdout: '', stderr: '', erro: e.message };
  }
  const r = spawnSync(inv.arquivo, inv.args, {
    cwd, encoding: 'utf8', timeout: timeoutMs, shell: inv.shell,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // `r.error` = o spawnSync não trouxe resposta do programa: ENOENT/EINVAL
  // (nem criou o processo) ou ETIMEDOUT (criou, estourou o prazo e levou
  // SIGTERM — neste caso `stdout`/`stderr` ainda podem trazer saída PARCIAL,
  // então não presuma que estão vazios). `r.status != 0` = rodou e respondeu
  // não. São coisas diferentes e a mensagem tem que dizer qual das duas foi.
  // Morto por sinal tem `status` NULO — dizer "saiu com código null" seria
  // mentira, então esse caso é nomeado à parte.
  const naoRodou = !!r.error;
  const comoFalhou = r.status === null
    ? ' foi morto por ' + r.signal
    : ' saiu com código ' + r.status;
  return {
    ok: !naoRodou && r.status === 0,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    erro: naoRodou
      ? String(r.error.message || r.error)
      : (r.status === 0 ? '' : 'claude ' + subcomandos.join(' ') + comoFalhou),
  };
}

// Lista os plugins/skills instalados. Devolve { ok, saida, erro }.
//
// O ramo da VPS continua no `su -s /bin/bash -c '...' claude-runner` de
// sempre, e isso é intencional: ele é LINUX POR DEFINIÇÃO — nem `su` nem
// /bin/bash existem no Windows, e ele só roda quando `isDesktop` é falso (nem
// darwin, nem win32, nem NASCERA_DESKTOP). Passá-lo pelo helper não corrigiria
// nada e abriria caminho de código novo em produção. É o último execSync de
// string do arquivo, e é de propósito.
function listarPluginsInstalados(isDesktop, homeDir, runnerUser) {
  if (!isDesktop) {
    const saida = runCmd(`su -s /bin/bash -c 'claude plugin list 2>&1' ${runnerUser}`, homeDir);
    // runCmd engole o motivo (devolve null). Não dá para dizer mais do que
    // "falhou" sem mexer nele — e mexer nele mexeria em produção Linux.
    return {
      ok: saida !== null,
      saida: saida || '',
      erro: saida === null ? 'su claude plugin list falhou' : '',
    };
  }
  const r = claudeCliSync(['plugin', 'list'], homeDir, 30000);
  // stdout + stderr juntos: era exatamente o que o `2>&1` fazia. Sem somar os
  // dois, a saída lida em macOS/Linux mudaria de conteúdo.
  return { ok: r.ok, saida: (r.stdout + r.stderr).trim(), erro: r.erro };
}

// ─── git sem shell ───────────────────────────────────────────────────
// `runCmd` monta uma STRING que passa pelo shell: qualquer dado do usuário
// dentro dela (nome de branch, hash, mensagem de commit, caminho) vira
// execução de comando. Era RCE autenticado nas rotas /revert e /rollback.
// `execFileSync` recebe um ARRAY de argumentos — o argv vai direto ao
// processo, sem shell no meio, então `; rm -rf /` é só um argumento literal.
function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    return null;
  }
}

// Um hash de commit é hexadecimal, ponto. Recusar cedo evita passar lixo
// adiante mesmo agora que o shell saiu do caminho.
function hashValido(h) { return typeof h === 'string' && /^[0-9a-f]{4,40}$/i.test(h); }

// SSH exec via ssh2 (no shell, no sshpass, no PATH dependency).
// creds: { host, port, user, password }
// Resolves with stdout; rejects with a real error (auth, network, exec).
const { Client: SSH2Client } = require('ssh2');
function sshExec(creds, command, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const conn = new SSH2Client();
    let settled = false;
    const finish = (err, out) => {
      if (settled) return; settled = true;
      try { conn.end(); } catch {}
      if (err) reject(err); else resolve(out);
    };
    const timer = setTimeout(() => finish(new Error('Timeout')), timeout);
    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { clearTimeout(timer); return finish(err); }
        let stdout = '';
        stream.on('close', () => { clearTimeout(timer); finish(null, stdout); });
        stream.on('data', (d) => { stdout += d.toString(); });
        stream.stderr.on('data', () => {});
      });
    });
    conn.on('error', (err) => { clearTimeout(timer); finish(err); });
    conn.on('keyboard-interactive', (_n, _i, _l, _p, kbFinish) => kbFinish([creds.password]));
    conn.connect({
      host: creds.host,
      port: creds.port || 22,
      username: creds.user || 'root',
      password: creds.password,
      readyTimeout: 15000,
      tryKeyboard: true,
    });
  });
}

function sshErrorMessage(err) {
  const m = (err && err.message) || String(err);
  if (/authentication/i.test(m) || err.level === 'client-authentication') return 'Usuario ou senha incorretos';
  if (/ENOTFOUND|getaddrinfo/i.test(m)) return 'Host nao encontrado: verifique o IP/dominio';
  if (/ECONNREFUSED/i.test(m)) return 'Conexao recusada: porta SSH incorreta ou servidor SSH parado';
  if (/EHOSTUNREACH|ENETUNREACH/i.test(m)) return 'Host inacessivel pela rede';
  if (/Timeout/i.test(m)) return 'Timeout: servidor nao respondeu (firewall ou rede instavel)';
  return 'Erro SSH: ' + m;
}

// ─── Agent Orchestration ──────────────────────────────────────────

// Escreve a skill de templates no projeto (.claude/skills/nascera-templates/SKILL.md).
// A skill dá ao Claude o catálogo p/ buscar/escolher/aplicar/trocar templates sob demanda,
// sem inflar o CLAUDE.md com esse manual em todo build.
function writeProjectSkill(projectPath) {
  try {
    const src = path.join(TEMPLATES_DIR, 'nascera-templates-SKILL.md');
    if (!fs.existsSync(src) || !projectPath) return;
    const skillDir = path.join(projectPath, '.claude', 'skills', 'nascera-templates');
    fs.mkdirSync(skillDir, { recursive: true });
    const content = fs.readFileSync(src, 'utf8').split('{{THEMES_DIR}}').join(path.join(__dirname, 'themes'));
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
  } catch (e) { logger.error('[SKILL] Falha ao escrever skill de templates:', e.message); }
}

// Gera themes/catalog.json — índice que a skill nascera-templates lê (UM arquivo pequeno
// em vez de varrer pastas). Regenerado a cada boot para refletir temas novos.
function ensureThemesCatalog() {
  try {
    const THEMES_BASE = path.join(__dirname, 'themes');
    const cats = [
      { dir: 'design-systems/temas_escuros', tipo: 'dark',      categoria: 'design-system' },
      { dir: 'design-systems/temas_claros',  tipo: 'light',     categoria: 'design-system' },
      { dir: 'design-systems/componentes',   tipo: 'component', categoria: 'design-system' },
      { dir: 'sites/1_temas_escuros',        tipo: 'dark',      categoria: 'site' },
      { dir: 'sites/2_temas_claros',         tipo: 'light',     categoria: 'site' },
      { dir: 'sites/3_componentes',          tipo: 'component', categoria: 'site' },
    ];
    const items = [];
    for (const c of cats) {
      const p = path.join(THEMES_BASE, c.dir);
      if (!fs.existsSync(p)) continue;
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const tp = path.join(p, e.name);
        items.push({
          id: e.name,
          pasta: c.dir + '/' + e.name,
          categoria: c.categoria,
          tipo: c.tipo,
          temIndex: fs.existsSync(path.join(tp, 'index.html')),
          temDesignSystem: fs.existsSync(path.join(tp, 'design-system.html')),
        });
      }
    }
    fs.writeFileSync(path.join(THEMES_BASE, 'catalog.json'), JSON.stringify(items, null, 1));
    return items.length;
  } catch (e) { logger.error('[SKILL] catalog.json:', e.message); return 0; }
}

// Localiza a pasta de um tema pelo id (usado pelo scaffold, pelo CLAUDE.md e pela criação de projeto)
function switchAgentForProject(projectId, newAgent) {
  if (!VALID_AGENTS.includes(newAgent)) return null;
  const projects = loadProjects();
  const proj = projects.find(p => p.id === projectId);
  if (!proj || !proj.path) return null;

  proj.activeAgent = newAgent;
  saveProjects(projects);

  // Rewrite CLAUDE.md with new active agent
  const claudeMdPath = path.join(proj.path, 'CLAUDE.md');
  const composed = composeClaudeMd(proj);
  fs.writeFileSync(claudeMdPath, composed, 'utf8');

  return proj;
}

// ─── Helpers de git por projeto (S4-2: servicos/git-commit.js) ───
const { autoCommit, autoCommitAsync, getNextVersion, getCurrentVersion } =
  require('./servicos/git-commit.js').criar({ git });
// Detect servable directory
function getServableDir(projectPath) {
  const candidates = ['dist', 'build', 'out', 'public'];
  for (const dir of candidates) {
    const full = path.join(projectPath, dir);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      if (fs.existsSync(path.join(full, 'index.html'))) return full;
    }
  }
  return projectPath;
}

// ─── Express ───────────────────────────────────────────────────────
const compression = require('compression');
const app = express();

// Atrás de nginx/Caddy, sem isto TODO request chega com o IP do proxy — o que
// faz o rate-limit e o freio de brute force tratarem o mundo inteiro como um
// único cliente (um atacante some no meio dos usuários legítimos).
app.set('trust proxy', 1);

// Headers de segurança. CSP fica DESLIGADA de propósito: o painel usa estilo
// inline e Tailwind por CDN, e uma política mal calibrada quebraria a tela
// inteira — ligar CSP é trabalho da Onda 3, com as origens mapeadas.
// Os outros headers (noSniff, frameguard, HSTS, referrer) valem desde já.
app.use(require('helmet')({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  // Preview e sites publicados carregam recursos entre origens.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(compression({ level: 6, threshold: 1024 }));
// Limite de corpo: sem teto, um POST gigante vira negação de serviço barata.
// `verify` guarda o corpo CRU só nas rotas de webhook: Kiwify e Mercado Pago
// assinam os bytes exatos que enviaram (HMAC), e o JSON re-serializado não
// bate — sem isto, a validação de assinatura desses gateways é impossível.
app.use(express.json({
  limit: '10mb',
  verify: function (req, _res, buf) {
    if (req.url && req.url.indexOf('/api/webhooks/') === 0) req.corpoCru = buf;
  },
}));

// ── Rate limiting ────────────────────────────────────────────────────
// O freio de senhas.js protege só o /login. Estes cobrem o resto: força bruta
// distribuída, varredura de rotas e abuso das rotas caras.
const rateLimit = require('express-rate-limit');
const limiteGeral = rateLimit({
  windowMs: 60 * 1000, max: 300,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas requisições. Espere um pouco.' },
  // O WebSocket e o preview dos sites publicados não passam por aqui;
  // health check fica de fora para não derrubar monitoramento.
  skip: (req) => req.path === '/api/health',
});
const limiteSensivel = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas tentativas nesta operação. Tente de novo em alguns minutos.' },
});
app.use('/api/', limiteGeral);
app.use(['/api/login', '/api/setup'], limiteSensivel);
// Rotas que mexem no histórico do projeto ou no disco: caras e destrutivas.
app.use(['/api/fs/write', '/api/fs/delete', '/api/fs/rename', '/api/fs/create'], limiteSensivel);
// /revert e /rollback têm :id no meio do caminho, então casam por regex.
// São as que mexem no git do projeto — e eram as portas do RCE.
app.use((req, res, next) => {
  if (/^\/api\/projects\/[^/]+\/(revert|rollback|publish)$/.test(req.path)) {
    return limiteSensivel(req, res, next);
  }
  next();
});

// ── DOMÍNIO PERSONALIZADO (antes de tudo) ──
// Quem chega por um domínio de cliente vê o SITE dele, nunca o painel. Só
// domínio ATIVO entra aqui; qualquer outro Host segue para o painel normal.
app.use(createHostRouter({ domains, loadProjects: () => loadProjects(), log: logger.warn }));

// ── Imagens da aparência ──
// As telas pedem sempre /logo.png, /favicon.png, etc. Quem decide qual arquivo
// sai daqui é o tema — assim o upload no painel troca a logo do sistema inteiro
// sem editar HTML nenhum. Precisa vir ANTES do express.static, senão o arquivo
// original responde primeiro.
const IMAGENS_CANONICAS = {
  '/logo.png': 'logo',
  '/favicon.png': 'favicon',
  '/apple-touch-icon.png': 'favicon',
  '/skills-bg.png': 'heroSkills',
  '/bgloading.png': 'loading',
};
const PUBLIC_DIR = path.join(__dirname, 'public');
app.get(Object.keys(IMAGENS_CANONICAS), (req, res, next) => {
  const alvo = String(theme.getTheme().images[IMAGENS_CANONICAS[req.path]] || '');
  if (!alvo || alvo === req.path) return next();            // tema aponta para o próprio arquivo
  if (/^https?:\/\//i.test(alvo)) return res.redirect(302, alvo);
  const arq = path.join(PUBLIC_DIR, alvo.replace(/^\/+/, ''));
  if (!arq.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(arq)) return next();
  res.set('Cache-Control', 'no-cache');   // trocar a logo tem que valer no F5
  res.sendFile(arq);
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    const ext = require('path').extname(filePath).toLowerCase();
    // Videos, images, fonts — cache 7 days
    if (['.mp4','.webm','.png','.jpg','.jpeg','.webp','.gif','.svg','.ico','.woff','.woff2','.ttf'].includes(ext)) {
      res.set('Cache-Control', 'public, max-age=604800, immutable');
    }
    // CSS, JS — cache 1 hour (may change with updates).
    // Exceção: o painel admin revalida sempre. Ele conversa direto com as
    // APIs, e JS velho contra API nova quebra a tela do dono por uma hora
    // depois de cada atualização. Com no-cache o ETag responde 304 e não
    // trafega byte nenhum — o custo é um round-trip, o ganho é não quebrar.
    else if (['.css','.js'].includes(ext)) {
      const doPainel = filePath.includes(`${path.sep}painel${path.sep}`);
      res.set('Cache-Control', doPainel ? 'no-cache' : 'public, max-age=3600');
    }
    // HTML — no cache (always fresh)
    else if (ext === '.html') {
      res.set('Cache-Control', 'no-cache');
    }
  }
}));

// ─── Preview Proxy (serves project files via same HTTPS domain) ────
//
// DUAS FALHAS FORAM CORRIGIDAS AQUI:
//
// 1. A rota não tinha autenticação NEM portão de dono. Como `getServableDir`
//    cai na raiz do projeto quando não acha pasta servível, qualquer pessoa
//    que soubesse o slug (previsível, e vazado em /site/, no log e na lista
//    de projetos) lia `package.json`, `.env`, código-fonte — de QUALQUER
//    cliente. Vazamento cross-tenant sem precisar de conta.
//
// 2. O preview roda na MESMA ORIGEM do painel, num iframe sem `sandbox`.
//    Um site gerado (ou clonado de um projeto malicioso) fazia
//    `parent.localStorage.nascera_token` e roubava a sessão do dono.
//
// A correção do acesso precisa funcionar DENTRO de um iframe, que não manda
// cabeçalho Authorization. Cookie resolveria — mas o `sandbox` que fecha a
// falha 2 cria origem opaca, e aí o cookie não viaja. Solução: o token vai
// no PRÓPRIO CAMINHO (`/preview/<slug>~<token>/`). Recurso relativo herda o
// prefixo, então CSS/JS/imagem continuam funcionando, e nenhum cookie é
// necessário — as duas correções passam a conviver.
const PREVIEW_TTL_MS = 12 * 60 * 60 * 1000;

// ─── Servir preview /preview/:slug + site /site/:slug (S4-2: servicos/preview-web.js) ───
const { ticketDePreview } = require('./servicos/preview-web.js').registrar(app, {
  PREVIEW_TTL_MS, JWT_SECRET, loadUsers, loadProjects, podeAcessarProjeto, getServableDir, _devServers,
});
// ─── IDE Proxy (code-server) ────────────────────────────────────────
const CODE_SERVER_PORT = 8080;
const IDE_BASE = '/ide';

app.use(IDE_BASE, (req, res) => {
  const targetPath = req.url || '/';
  const proxyHeaders = { ...req.headers };
  proxyHeaders.host = '127.0.0.1:' + CODE_SERVER_PORT;
  // Remove origin to avoid CORS issues
  delete proxyHeaders.origin;
  delete proxyHeaders.referer;

  const options = {
    hostname: '127.0.0.1',
    port: CODE_SERVER_PORT,
    path: targetPath,
    method: req.method,
    headers: proxyHeaders,
  };

  const proxyReq = http.request(options, (proxyRes) => {
    const headers = { ...proxyRes.headers };

    // Remove security headers that block iframe embedding
    delete headers['content-security-policy'];
    delete headers['x-frame-options'];

    // Fix redirects to stay within /ide/ prefix
    if (headers.location) {
      if (headers.location.startsWith('./')) {
        headers.location = IDE_BASE + '/' + headers.location.substring(2);
      } else if (headers.location.startsWith('/') && !headers.location.startsWith(IDE_BASE)) {
        headers.location = IDE_BASE + headers.location;
      }
    }

    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    logger.error('[IDE PROXY] Error:', err.message);
    if (!res.headersSent) res.status(502).send('IDE not available');
  });

  req.pipe(proxyReq, { end: true });
});

// ─── Themes API + Serve ────────────────────────────────────────────
const THEMES_BASE = path.join(__dirname, 'themes');
// ─── Scaffold + CLAUDE.md (S4-2: servicos/scaffold.js) ───
const { findThemePath, scaffoldFromTheme, resolveThemeContent, composeClaudeMd, initGit } =
  require('./servicos/scaffold.js').criar({ RAIZ: __dirname, AGENTS_DIR, THEMES_BASE, git, writeProjectSkill });

// Serve theme preview files (index.html, design-system.html, assets)
app.use('/themes', express.static(THEMES_BASE, { maxAge: '7d', etag: true, lastModified: true, immutable: true }));

// List available themes
app.get('/api/themes', (req, res) => {
  try {
    const themes = [];
    const categories = [
      { dir: 'design-systems/temas_escuros', type: 'dark', label: 'Escuro' },
      { dir: 'design-systems/temas_claros', type: 'light', label: 'Claro' },
    ];
    for (const cat of categories) {
      const catPath = path.join(THEMES_BASE, cat.dir);
      if (!fs.existsSync(catPath)) continue;
      const entries = fs.readdirSync(catPath, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const themePath = path.join(catPath, e.name);
        const hasDesignSystem = fs.existsSync(path.join(themePath, 'design-system.html'));
        const hasIndex = fs.existsSync(path.join(themePath, 'index.html'));
        if (!hasIndex) continue;
        // Check for thumbnail
        const thumbWebp = path.join(THEMES_BASE, 'thumbnails', e.name + '.webp');
        const thumbJpg = path.join(THEMES_BASE, 'thumbnails', e.name + '.jpg');
        const thumbPng = path.join(THEMES_BASE, 'thumbnails', e.name + '.png');
        let thumbnail = null;
        if (fs.existsSync(thumbJpg)) thumbnail = `/themes/thumbnails/${e.name}.jpg`;
        else if (fs.existsSync(thumbPng)) thumbnail = `/themes/thumbnails/${e.name}.png`;

        themes.push({
          id: e.name,
          name: e.name.replace(/[-_.]/g, ' ').replace(/aura build/g, '').trim(),
          type: cat.type,
          label: cat.label,
          thumbnail,
          previewUrl: `/themes/${cat.dir}/${e.name}/index.html`,
          designSystemUrl: hasDesignSystem ? `/themes/${cat.dir}/${e.name}/design-system.html` : null,
          designSystemPath: hasDesignSystem ? path.join(themePath, 'design-system.html') : null,
          indexPath: path.join(themePath, 'index.html'),
        });
      }
    }
    // Also add site references
    const siteCats = [
      { dir: 'sites/1_temas_escuros', type: 'dark', label: 'Site Escuro' },
      { dir: 'sites/2_temas_claros', type: 'light', label: 'Site Claro' },
      { dir: 'sites/3_componentes', type: 'component', label: 'Componente' },
    ];
    for (const cat of siteCats) {
      const catPath = path.join(THEMES_BASE, cat.dir);
      if (!fs.existsSync(catPath)) continue;
      const entries = fs.readdirSync(catPath, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const themePath = path.join(catPath, e.name);
        const hasIndex = fs.existsSync(path.join(themePath, 'index.html'));
        if (!hasIndex) continue;
        const siteThumbWebp = path.join(THEMES_BASE, 'thumbnails', e.name + '.webp');
        const siteThumbJpg = path.join(THEMES_BASE, 'thumbnails', e.name + '.jpg');
        const siteThumbPng = path.join(THEMES_BASE, 'thumbnails', e.name + '.png');
        let siteThumbnail = null;
        if (fs.existsSync(siteThumbJpg)) siteThumbnail = `/themes/thumbnails/${e.name}.jpg`;
        else if (fs.existsSync(siteThumbPng)) siteThumbnail = `/themes/thumbnails/${e.name}.png`;

        themes.push({
          id: `site-${e.name}`,
          name: e.name.replace(/[-_.]/g, ' ').replace(/aura build/g, '').trim(),
          type: cat.type,
          label: cat.label,
          thumbnail: siteThumbnail,
          previewUrl: `/themes/${cat.dir}/${e.name}/index.html`,
          designSystemUrl: null,
          designSystemPath: null,
          indexPath: path.join(themePath, 'index.html'),
        });
      }
    }
    res.json(themes);
  } catch (err) {
    res.status(500).json({ error: 'Falha ao listar temas: ' + err.message });
  }
});

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const decoded = verifyToken(auth.slice(7));
  if (!decoded) return res.status(401).json({ error: 'Unauthorized' });
  // A0.2: suspensão vale AO VIVO — token emitido antes da suspensão morre aqui.
  // Suspender ≠ excluir: os projetos ficam intactos; só o acesso é negado.
  if (usuarioSuspenso(decoded.user)) {
    return res.status(403).json({ error: 'Conta suspensa. Fale com o administrador.', suspensa: true });
  }
  req.user = decoded;
  next();
}

// A0.2: a flag mora no users.json ({ suspended: true, suspendedReason, suspendedAt }).
function usuarioSuspenso(username) {
  try {
    const u = loadUsers()[username];
    return !!(u && u.suspended);
  } catch { return false; }
}

// Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  // S0-6: usar `req.ip`, não o header cru. O `x-forwarded-for` é escrito pelo
  // cliente; usá-lo como chave do freio deixava o atacante trocar o IP a cada
  // tentativa e nunca ser freado. Com `trust proxy` (linha 749), o Express
  // deriva o IP real respeitando a contagem de proxies — não dá para forjar.
  const ip = req.ip || req.socket.remoteAddress || '?';

  // Freio: hash forte protege o arquivo roubado; só o freio protege da
  // tentativa em massa aqui na porta da frente.
  const espera = senhas.esperaObrigatoria(username, ip);
  if (espera > 0) {
    trackEvent('login_blocked_bruteforce', { username });
    return res.status(429).json({ error: `Muitas tentativas. Tente de novo em ${espera}s.` });
  }

  const diskUsers = loadUsers();
  const registro = diskUsers[username];
  // O cache guarda a CREDENCIAL GRAVADA (hash), nunca a senha digitada.
  const guardado = registro ? registro.password : (USERS[username] || {}).password;

  const r = guardado
    ? await senhas.conferir(password, guardado)
    // Usuário inexistente: mesmo trabalho de uma verificação real.
    : await senhas.conferirInexistente(password);

  if (!r.ok) {
    const proxima = senhas.registrarErro(username, ip);
    trackEvent('login_failed', { username });
    return res.status(401).json({
      error: 'Credenciais inválidas' + (proxima ? ` — aguarde ${proxima}s antes de tentar de novo.` : ''),
    });
  }

  // Entrou com senha antiga em texto puro: converte agora, sem pedir nada
  // ao usuário. É o único momento em que temos a senha para poder migrar.
  if (r.precisaMigrar && registro) {
    try {
      const users = loadUsers();
      if (users[username]) {
        users[username].password = await senhas.criarHash(password);
        saveUsers(users);
        logger.info('[senhas] "' + username + '" migrado para hash no login');
      }
    } catch (e) { logger.error('[senhas] falha ao migrar ' + username + ':', e.message); }
  }

  senhas.limparErros(username, ip);
  const atualizado = loadUsers()[username];
  // A0.2: suspenso não entra — mas a checagem vem DEPOIS da senha conferida,
  // para não virar oráculo de existência de conta para quem não tem a senha.
  if (atualizado && atualizado.suspended) {
    trackEvent('login_blocked_suspenso', { username });
    return res.status(403).json({ error: 'Conta suspensa. Fale com o administrador.', suspensa: true });
  }
  USERS[username] = { password: atualizado ? atualizado.password : guardado };
  const role = atualizado ? atualizado.role : 'user';
  const token = signToken({ user: username, role });
  trackEvent('login', { username, role });
  return res.json({ token, user: username, role });
});

// ─── Saúde e métricas ────────────────────────────────────────────────
// O /api/health antigo respondia {status:'ok'} SEMPRE — inclusive com o banco
// fora, o disco cheio ou o motor morto. Um monitor ligado nele nunca alertaria
// nada. Agora existem três rotas, com papéis distintos:
//
//   /api/health  — está VIVO? (barato, sem I/O; é o que o supervisor consulta
//                  para decidir se reinicia o processo)
//   /api/ready   — está PRONTO para receber tráfego? (checa dependências;
//                  é o que o balanceador consulta antes de mandar requisição)
//   /api/metrics — números para gráfico/alerta, em texto Prometheus
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
});

app.get('/api/ready', async (_req, res) => {
  const checagens = {};
  let pronto = true;

  // Banco — só conta como dependência se estiver configurado.
  if (db.ATIVO) {
    const s = await db.saude();
    checagens.banco = s;
    if (!s.ok) pronto = false;
  } else {
    checagens.banco = { ok: true, modo: 'json (banco desativado)' };
  }

  // Estado em disco: se os arquivos críticos não abrem, o servidor está de pé
  // mas não consegue trabalhar — que é justamente o caso que passava batido.
  try { loadUsers(); loadProjects(); checagens.estado = { ok: true }; }
  catch (e) { checagens.estado = { ok: false, motivo: e.message }; pronto = false; }

  // Motor: quantas sessões vivas contra o teto.
  try {
    if (_enginePromise) {
      const { sessionManager } = await _enginePromise;
      const c = sessionManager.contar();
      checagens.motor = { ok: true, sessoes: c.total, limite: sessionManager.limites().global };
    } else {
      checagens.motor = { ok: true, sessoes: 0, nota: 'motor ainda não iniciado' };
    }
  } catch (e) { checagens.motor = { ok: false, motivo: e.message }; }

  res.status(pronto ? 200 : 503).json({ pronto, checagens });
});

app.get('/api/metrics', async (_req, res) => {
  const linhas = [];
  const m = (nome, ajuda, tipo, valor) => {
    linhas.push('# HELP ' + nome + ' ' + ajuda);
    linhas.push('# TYPE ' + nome + ' ' + tipo);
    linhas.push(nome + ' ' + valor);
  };
  const mem = process.memoryUsage();
  m('nascera_uptime_segundos', 'Tempo de vida do processo', 'gauge', Math.round(process.uptime()));
  m('nascera_memoria_heap_bytes', 'Heap em uso', 'gauge', mem.heapUsed);
  m('nascera_memoria_rss_bytes', 'Memória residente', 'gauge', mem.rss);

  // Atraso do event loop: o sintoma nº 1 de trabalho síncrono pesado no
  // caminho quente (era o caso do saveProjects reescrevendo o array inteiro).
  m('nascera_event_loop_lag_ms', 'Atraso do event loop', 'gauge', Math.round(_lagEventLoop));

  try {
    if (_enginePromise) {
      const { sessionManager } = await _enginePromise;
      const c = sessionManager.contar();
      const lim = sessionManager.limites();
      m('nascera_sessoes_ativas', 'Sessões de IA vivas', 'gauge', c.total);
      m('nascera_sessoes_limite', 'Teto de sessões simultâneas', 'gauge', lim.global);
    }
  } catch {}

  if (db.ATIVO) {
    const s = await db.saude();
    m('nascera_banco_ok', 'Banco respondendo (1/0)', 'gauge', s.ok ? 1 : 0);
    if (s.pool) {
      m('nascera_banco_pool_total', 'Conexões no pool', 'gauge', s.pool.total);
      m('nascera_banco_pool_esperando', 'Requisições esperando conexão', 'gauge', s.pool.esperando);
    }
  }
  res.set('Content-Type', 'text/plain; version=0.0.4').send(linhas.join('\n') + '\n');
});

// Mede o atraso do event loop uma vez por segundo. `unref` para não segurar
// o processo vivo só por causa da métrica.
let _lagEventLoop = 0;
(() => {
  let ultimo = Date.now();
  const t = setInterval(() => {
    const agora = Date.now();
    _lagEventLoop = Math.max(0, (agora - ultimo) - 1000);
    ultimo = agora;
  }, 1000);
  t.unref && t.unref();
})();

// ─── Aparência ───────────────────────────────────────────────────────
// O CSS do tema é PÚBLICO (é folha de estilo: toda tela precisa dele, até a
// de login). Sem cache, porque mudar cor no painel tem que refletir no F5.
app.get('/theme.css', (_req, res) => {
  res.type('text/css');
  res.set('Cache-Control', 'no-cache');
  res.send(theme.themeCss());
});

// ─── Rotas admin de tema/aparência (S4: extraídas) ───
require('./rotas/admin-theme.js').registrar(app, { adminMiddleware, appendActivity });

// Trocar o motor DE UM PROJETO, do próprio chat. Diferente da configuração
// global: aqui a pessoa está no meio de um trabalho e quer continuar nele
// com o outro motor. A memória do projeto é o que faz isso não recomeçar.
// ─── Motor por projeto /api/projects/:id/{motor(PUT/GET),status} (S4: rotas/projetos-motor.js) ───
require('./rotas/projetos-motor.js').registrar(app, {
  authMiddleware, projectOr404, motores, loadNasceraConfig, loadProjects,
  saveProjects, memoriaProjeto, sessionKeyFor, appendActivity, getEngine,
  getChannels: () => channels,
});

// Escreve, DENTRO do projeto, o comando que o agente executa para pedir
// imagem. Precisa morar no projeto porque o cofre só enxerga a pasta dele —
// um script em tools/ do servidor seria invisível para o agente.
//
// Era um `.sh` com `#!/bin/sh` + `curl`. No Windows não há /bin/sh (e o curl
// nativo do PowerShell é um alias de Invoke-WebRequest, com outra sintaxe),
// então a ferramenta simplesmente não rodava e o site nascia SEM IMAGEM —
// e imagem é recurso PAGO, ou seja, o cliente pagava pelo plano e recebia
// caixa cinza. A saída neutra não é um `if (win32)`: é escrever o script em
// Node, que existe em toda instalação do Nascera por definição. Um arquivo só,
// mesmo comportamento nos três sistemas.
//
// A extensão é `.cjs`, NÃO `.js`: o projeto do cliente é quem manda no modo
// do módulo, e um projeto com `"type": "module"` no package.json (Vite, Astro,
// qualquer scaffold moderno — já existem projetos assim em produção) faria o
// `require('http')` morrer com "require is not defined in ES module scope".
// Isso quebraria a imagem PAGA nos TRÊS sistemas, não só no Windows. O `.cjs`
// é CommonJS por definição, independentemente do package.json do projeto.
function escreverFerramentaDeImagem(proj) {
  if (!proj || !proj.path || !proj.id) return;
  try {
    const dir = path.join(proj.path, '.nascera');
    fs.mkdirSync(dir, { recursive: true });
    const url = 'http://127.0.0.1:' + PORT + '/api/projects/' + proj.id + '/imagem';
    // Interpolar como literal JSON (e não concatenar cru) evita que uma aspa
    // vinda de url/token quebre o arquivo gerado.
    const urlLit = JSON.stringify(url);
    const tokenLit = JSON.stringify(tokenDeImagem(proj.id));
    const linhas = [
      '#!/usr/bin/env node',
      '// Gera uma imagem e grava dentro do projeto. Arquivo escrito pelo Nascera.',
      '//   node .nascera/imagem.cjs "descricao" assets/hero.png [800x600]',
      "const http = require('http');",
      'const [descricao, destino, tamanho] = process.argv.slice(2);',
      'if (!descricao || !destino) {',
      '  console.error("uso: imagem.cjs <descricao> <destino> [tamanho]");',
      '  process.exit(1);',
      '}',
      '// JSON.stringify no lugar do printf do shell: o printf antigo não',
      '// escapava nada, e uma descrição com aspas montava um corpo inválido.',
      'const corpo = Buffer.from(JSON.stringify({',
      '  prompt: descricao, destino: destino, tamanho: tamanho || "1024x1024",',
      '}));',
      'const req = http.request(' + urlLit + ', {',
      '  method: "POST",',
      '  headers: {',
      '    "Content-Type": "application/json",',
      '    "Content-Length": corpo.length,',
      '    "X-Nascera-Imagem": ' + tokenLit + ',',
      '  },',
      '}, (res) => {',
      '  let dados = "";',
      '  res.setEncoding("utf8");',
      '  res.on("data", (p) => { dados += p; });',
      '  res.on("end", () => {',
      '    process.stdout.write(dados);',
      '    // O `curl -s` saía com 0 até em erro HTTP: o agente lia "deu certo",',
      '    // seguia escrevendo <img src> e o site ficava com imagem quebrada.',
      '    // Falha de imagem custa dinheiro — tem que aparecer como falha.',
      '    // `exitCode` e não `exit()`: em POSIX a escrita no stdout de um PIPE',
      '    // é assíncrona, e `exit()` logo depois pode cortar o motivo do erro',
      '    // no meio — justamente o texto que o agente precisa ler.',
      '    if (!(res.statusCode >= 200 && res.statusCode < 300)) process.exitCode = 1;',
      '  });',
      '});',
      'req.on("error", (e) => { console.error("falhou: " + e.message); process.exit(1); });',
      '// Sem timeout de propósito: gerar imagem leva dezenas de segundos e o',
      '// curl também esperava o quanto fosse preciso.',
      'req.end(corpo);',
      '',
    ];
    fs.writeFileSync(path.join(dir, 'imagem.cjs'), linhas.join('\n'), { mode: 0o755 });
    // Ponte para o passado: uma sessão RETOMADA carrega no contexto do agente
    // o comando antigo (`./.nascera/imagem.sh`). Se o arquivo sumisse, projetos
    // que hoje geram imagem no macOS/Linux parariam de gerar — regressão em
    // produção. O .sh continua existindo, mas só delega: nenhuma lógica
    // duplicada, e no Windows ele é apenas um arquivo inerte.
    const ponte = [
      '#!/bin/sh',
      '# Compatibilidade: instruções antigas chamam ./.nascera/imagem.sh.',
      '# O gerador de verdade é o imagem.cjs — este arquivo só repassa.',
      'exec node "$(dirname "$0")/imagem.cjs" "$@"',
      '',
    ];
    fs.writeFileSync(path.join(dir, 'imagem.sh'), ponte.join('\n'), { mode: 0o755 });
    // Projetos que já rodaram a versão anterior desta função ficaram com um
    // `.nascera/imagem.js` que morre em projeto ESM. Some com ele para não haver
    // dois geradores, um deles quebrado, na mesma pasta.
    try { fs.unlinkSync(path.join(dir, 'imagem.js')); } catch { /* nunca existiu */ }
  } catch (e) { logger.error('[imagens] ferramenta:', e.message); }
}

// ═══════════════ IMAGENS ═══════════════
// Nem o Claude Code nem o Codex geram imagem — é outro serviço. Aqui fica a
// configuração, e a ferramenta que o agente chama enquanto constrói.
// ─── Rotas admin de imagens (S4: extraídas) ───
require('./rotas/admin-imagens.js').registrar(app, { adminMiddleware, appendActivity });

// Token que o AGENTE usa para pedir imagem. Ele roda dentro do cofre e não
// tem o login de ninguém — mas também não pode receber um token de usuário,
// que abriria o sistema inteiro. Este vale para UM projeto e UMA rota.
// Derivado, não guardado: some junto com o projeto.
function tokenDeImagem(projectId) {
  return crypto.createHmac('sha256', JWT_SECRET).update('imagem:' + projectId).digest('hex').slice(0, 48);
}

function autorizaImagem(req, res, next) {
  const t = req.headers['x-nascera-imagem'];
  if (t && req.params.id) {
    try {
      const esperado = tokenDeImagem(req.params.id);
      const a = Buffer.from(String(t)), b = Buffer.from(esperado);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        req.user = { user: 'agente:' + req.params.id, role: 'user' };
        req._viaTokenDeImagem = true;
        return next();
      }
    } catch {}
  }
  return authMiddleware(req, res, next);
}

// Chamada pelo AGENTE (via a ferramenta escrita dentro do projeto). Só grava
// DENTRO do projeto — um caminho fora dele seria escrita arbitrária no disco
// do servidor.
app.post('/api/projects/:id/imagem', autorizaImagem, async (req, res) => {
  // O token de imagem já prova que é daquele projeto; o portão normal de
  // dono só se aplica a quem chega com login de usuário.
  const proj = req._viaTokenDeImagem
    ? loadProjects().find(p => p.id === req.params.id)
    : projectOr404(req, res);
  if (!proj) { if (!res.headersSent) res.status(404).json({ error: 'Projeto não encontrado' }); return; }
  if (!proj.path) return res.status(400).json({ error: 'Projeto sem pasta' });
  try {
    const prompt = String((req.body && req.body.prompt) || '').trim();
    const rel = String((req.body && req.body.destino) || '').trim();
    if (!prompt) return res.status(400).json({ error: 'Descreva a imagem' });
    if (!rel || rel.includes('\0')) return res.status(400).json({ error: 'Destino inválido' });

    const base = path.resolve(proj.path);
    const alvo = path.resolve(base, rel);
    if (alvo !== base && !alvo.startsWith(base + path.sep)) {
      return res.status(403).json({ error: 'O destino precisa ficar dentro do projeto' });
    }

    const r = await imagens.gerar(prompt, alvo, { tamanho: (req.body && req.body.tamanho) || '1024x1024' });
    trackEvent('imagem_gerada', { provedor: r.provedor }, req.user.user);
    res.json({ ...r, arquivo: path.relative(base, r.arquivo) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════ MOTORES (Claude Code / GPT Codex) ═══════════════
// Os dois convivem. Escolher aqui vale para as sessões abertas daqui em
// diante — as vivas são encerradas na troca, senão continuariam no motor
// antigo sem ninguém entender por quê.
// ─── Rotas admin de motores (S4: extraídas para rotas/admin-motores.js) ───
require('./rotas/admin-motores.js').registrar(app, {
  adminMiddleware, loadNasceraConfig, saveNasceraConfig, invalidarCmdDoMotor,
  getChannels: () => channels, appendActivity,
});

// ═══════════════ MODELOS LOCAIS (LLM open source) ═══════════════
// Rodar de graça, na própria máquina. Só admin: trocar o modelo muda o
// comportamento do sistema inteiro para todos os usuários da instalação.
// ─── Rotas admin de modelos locais (S4: extraídas) ───
require('./rotas/admin-modelos-locais.js').registrar(app, {
  adminMiddleware, loadNasceraConfig, saveNasceraConfig, getChannels: () => channels, appendActivity,
});

// Telemetry endpoint for frontend events
app.post('/api/telemetry/event', (req, res) => {
  const { eventType, data } = req.body;
  if (eventType) trackEvent(eventType, data || {});
  res.json({ ok: true });
});

// ─── Atualização da plataforma ───────────────────────────────────────
// Só admin: um update reinicia o serviço e troca o código de todo mundo.
// ─── Rotas admin de atualização (S4: extraídas) ───
require('./rotas/admin-update.js').registrar(app, { adminMiddleware, appendActivity, trackEvent });

// Download releases for VPS installation (no auth required)
app.get('/api/download/release', (_req, res) => {
  const p = path.join(__dirname, 'nascera-release.tar.gz');
  if (!require('fs').existsSync(p)) return res.status(404).json({ error: 'Release not found' });
  res.download(p, 'nascera-release.tar.gz');
});
app.get('/api/download/themes', (_req, res) => {
  const p = '/root/nascera-themes.tar.gz';
  if (!require('fs').existsSync(p)) return res.status(404).json({ error: 'Themes not found' });
  res.download(p, 'nascera-themes.tar.gz');
});

// GET /api/settings — returns user profile, claude status, system info
// ─── Rotas de configurações (S4: extraídas para rotas/settings.js) ───
require('./rotas/settings.js').registrar(app, { authMiddleware, loadUsers, saveUsers, readClaudeAuthStatus: claudeAuth.readClaudeAuthStatus, USERS });

// ─── Token do primeiro acesso ────────────────────────────────────────
// O problema: `/api/setup/create-account` não exigia nada e criava conta
// ADMIN. Numa instalação nova exposta na rede, quem escaneasse a porta
// primeiro virava dono da máquina — e como o shell do NASCERA roda com as
// permissões do usuário, isso é tomada de controle, não só de conta.
//
// A correção: um token gerado no primeiro boot e impresso NO CONSOLE. Quem
// vê o console é quem tem acesso à máquina — exatamente quem deveria poder
// criar a conta. Some assim que o admin existe.
//
// Instalação que JÁ tem admin não é afetada: a rota continua recusando pelo
// motivo de sempre ("admin já existe"), e nenhum token é gerado.
const SETUP_TOKEN_FILE = path.join(__dirname, '.setup-token');

function tokenDeSetup() {
  try {
    const t = fs.readFileSync(SETUP_TOKEN_FILE, 'utf8').trim();
    if (t) return t;
  } catch {}
  // Curto e legível: quem digita é uma pessoa lendo o terminal, não um script.
  const novo = crypto.randomBytes(4).toString('hex').toUpperCase();
  try { fs.writeFileSync(SETUP_TOKEN_FILE, novo, { mode: 0o600 }); } catch {}
  return novo;
}

function limparTokenDeSetup() {
  try { fs.unlinkSync(SETUP_TOKEN_FILE); } catch {}
}

// Comparação em tempo constante: um `===` vaza, pelo tempo de resposta,
// quantos caracteres iniciais estavam certos.
function tokenConfere(recebido, esperado) {
  const a = Buffer.from(String(recebido || ''));
  const b = Buffer.from(String(esperado || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─── Setup / login do Claude (S4: extraído para rotas/setup.js) ───
require('./rotas/setup.js').registrar(app, {
  authMiddleware, loadUsers, saveUsers, USERS,
  senhas, signToken, appendActivity, PROJECTS_BASE,
  tokenConfere, tokenDeSetup, limparTokenDeSetup,
  claudeCmd, isDesktopLocal,
});

// ─── Projects API ────────────────────────────────────────────────────
// ─── Ciclo de vida do projeto /api/projects[/:id] (S4: rotas/projetos-crud.js) ───
require('./rotas/projetos-crud.js').registrar(app, {
  authMiddleware, projectOr404, projetosDoUsuario, semSegredos, makeSlug,
  loadProjects, saveProjects, scaffoldFromTheme, initGit, normalizeBuildLevel,
  trackEvent, seguranca, domains, loadTrash, saveTrash, loadNasceraConfig,
  PROJECTS_BASE, PUBLISHED_BASE, TRASH_DIR, THUMB_DIR, THEMES_BASE,
});

// List VPS folders
app.get('/api/vps-folders', authMiddleware, (req, res) => {
  const base = req.query.path || PROJECTS_BASE;
  const resolved = path.resolve(base);
  // Allow browsing anywhere on local, restrict on VPS.
  // BUGFIX: a detecção de desktop aqui era só pela env NASCERA_DESKTOP — no macOS/Windows
  // local (env não setada) o picker abria em /Users e tomava 403 logo na primeira listagem.
  const isDesktop = process.env.NASCERA_DESKTOP === 'true' || process.platform === 'darwin' || process.platform === 'win32';
  if (!isDesktop && !resolved.startsWith(PROJECTS_BASE) && !resolved.startsWith('/root') && !resolved.startsWith('/home')) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const folders = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== '_published' && e.name !== 'node_modules')
      .map(e => {
        const fullPath = path.join(resolved, e.name);
        let stat;
        try { stat = fs.statSync(fullPath); } catch { stat = null; }
        const markers = ['package.json', '.git', 'Cargo.toml', 'go.mod', 'requirements.txt', 'pyproject.toml', 'Makefile', 'docker-compose.yml', 'Dockerfile'];
        const hasMarker = markers.some(m => {
          try { return fs.existsSync(path.join(fullPath, m)); } catch { return false; }
        });
        // Camada 4: o picker do Mac navega o disco inteiro (a checagem de
        // prefixo acima é desligada no desktop). Então cada pasta já vem
        // dizendo se pode ser conectada — a tela desabilita as que não podem.
        const bloqueio = seguranca.motivoParaRecusar(fullPath);
        return {
          name: e.name, path: fullPath,
          modified: stat ? stat.mtime.toISOString() : null,
          isProject: hasMarker,
          bloqueada: !!bloqueio, motivoBloqueio: bloqueio || null,
        };
      })
      .sort((a, b) => {
        if (a.isProject !== b.isProject) return a.isProject ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({ base: resolved, folders });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao listar pastas: ' + err.message });
  }
});

// ─── Trash Storage ──────────────────────────────────────────────────
const TRASH_FILE = process.env.NASCERA_TRASH_FILE || path.join(__dirname, 'trash.json');
function loadTrash() {
  if (estadoDb.ATIVO) return estadoDb.lixeira.lista();
  // Crítico: a lixeira aponta para pastas de projeto reais; devolver [] por
  // corrupção perderia o rastro de restauração e deixaria pastas órfãs.
  return leEstado(TRASH_FILE, { fallback: [], critico: true });
}
function saveTrash(trash) {
  gravaEstado(TRASH_FILE, trash);
  if (estadoDb.ATIVO) estadoDb.lixeira.sincronizar(trash);
}

// ─── Rotas da lixeira (S4: extraídas para rotas/lixeira.js) ──────────
require('./rotas/lixeira.js').registrar(app, {
  authMiddleware, loadTrash, saveTrash, loadProjects, saveProjects,
  podeAcessarProjeto, seguranca, appendActivity,
});

// ─── File System APIs (for embedded editor) ─────────────────────────

// List directory contents
// Helper: check if a path belongs to a remote project, return SSH info
// Build integrations context for Claude — injected in every message
function getIntegrationsContext() {
  const integrations = loadIntegrations();
  const keys = Object.keys(integrations);
  if (keys.length === 0) return '';

  const docs = {
    slack: (c) => `- **Slack**: Use o Bash tool com curl. Header: "Authorization: Bearer ${c.botToken}". API base: https://slack.com/api/. Exemplos: chat.postMessage, conversations.list`,
    trello: (c) => `- **Trello**: Use o Bash tool com curl. Adicione ?key=${c.apiKey}&token=${c.token} nas URLs. API base: https://api.trello.com/1/. Exemplos: /boards, /cards, /lists`,
    'google-sheets': (c) => `- **Google Sheets**: Service Account configurado. Use o Bash tool com curl e o token OAuth. Credenciais salvas no servidor.`,
    'google-docs': (c) => `- **Google Docs**: Service Account configurado. Use o Bash tool com curl e o token OAuth.`,
    'google-drive': (c) => `- **Google Drive**: Service Account configurado. Use o Bash tool com curl e o token OAuth.`,
    github: (c) => `- **GitHub**: Use o Bash tool com curl. Header: "Authorization: token ${c.token}" e "User-Agent: Nascera". API base: https://api.github.com/. Exemplos: /user/repos, /repos/{owner}/{repo}`,
    figma: (c) => `- **Figma**: Use o Bash tool com curl. Header: "X-Figma-Token: ${c.token}". API base: https://api.figma.com/v1/. Exemplos: /me, /files/{key}, /files/{key}/nodes`,
    notion: (c) => `- **Notion**: Use o Bash tool com curl. Headers: "Authorization: Bearer ${c.token}" e "Notion-Version: 2022-06-28". API base: https://api.notion.com/v1/. Exemplos: /pages, /databases/{id}/query`,
    discord: (c) => `- **Discord**: Use o Bash tool com curl. Header: "Authorization: Bot ${c.botToken}". API base: https://discord.com/api/v10/. Exemplos: /guilds, /channels/{id}/messages`,
    linear: (c) => `- **Linear**: Use o Bash tool com curl POST para https://api.linear.app/graphql. Header: "Authorization: ${c.apiKey}". Corpo: { "query": "{ issues { nodes { title } } }" }`,
    vercel: (c) => `- **Vercel**: Use o Bash tool com curl. Header: "Authorization: Bearer ${c.token}". API base: https://api.vercel.com/. Exemplos: /v6/deployments, /v9/projects`,
    supabase: (c) => `- **Supabase**: URL: ${c.url}. Use o Bash tool com curl. Header: "apikey: ${c.anonKey}" e "Authorization: Bearer ${c.anonKey}". Exemplos: /rest/v1/tabela`,
    stripe: (c) => `- **Stripe**: Use o Bash tool com curl -u ${c.secretKey}: (com dois pontos no final). API base: https://api.stripe.com/v1/. Exemplos: /charges, /customers, /balance`,
    whatsapp: (c) => `- **WhatsApp (Evolution API)**: URL base: ${c.apiUrl}. Header: "apikey: ${c.apiKey}". Exemplos: /message/sendText, /instance/fetchInstances`,
    n8n: (c) => `- **n8n**: URL base: ${c.url}. Header: "X-N8N-API-KEY: ${c.apiKey}". API: /api/v1/workflows, /api/v1/executions`,
    openai: (c) => `- **OpenAI**: Use o Bash tool com curl. Header: "Authorization: Bearer ${c.apiKey}". API base: https://api.openai.com/v1/. Exemplos: /chat/completions, /images/generations`,
  };

  let context = '\n\n---\n# Integracoes Conectadas\n\n';
  context += 'O usuario tem as seguintes integracoes ativas. Use-as quando solicitado:\n\n';

  for (const id of keys) {
    const creds = integrations[id];
    if (docs[id]) {
      try { context += docs[id](creds) + '\n'; } catch {}
    }
  }

  context += '\nPara usar qualquer integracao, faca chamadas HTTP via Bash tool com curl. Sempre inclua os headers de autenticacao indicados acima.\n';
  return context;
}

// ─── Editor de arquivos /api/fs/* (S4: extraído para rotas/fs.js) ───
require('./rotas/fs.js').registrar(app, {
  authMiddleware, loadProjects, podeAcessarProjeto, senhaSshDoProjeto,
  projetosDoUsuario, ehAdmin, PROJECTS_BASE, sshExec, sshErrorMessage, git,
});

// ─── Multi-User Data Storage ────────────────────────────────────────
const USERS_FILE = path.join(__dirname, 'users.json');

function loadUsers() {
  if (estadoDb.ATIVO) return estadoDb.usuarios.obj();
  // Crítico: devolver {} por corrupção deslogaria todo mundo e a próxima
  // gravação persistiria o vazio, apagando todas as contas.
  return leEstado(USERS_FILE, { fallback: {}, critico: true });
}
function saveUsers(users) {
  gravaEstado(USERS_FILE, users);
  if (estadoDb.ATIVO) estadoDb.usuarios.sincronizar(users);
}

// Users are created via first-access setup flow

// API: List users (admin only)
// A0.6: o gate era por username literal 'root' — divergente do papel vivo.
// Agora todo o CRUD legado usa adminMiddleware (papel AO VIVO do users.json).
app.get('/api/users', adminMiddleware, (req, res) => {
  const users = loadUsers();
  const safeUsers = Object.entries(users).map(([name, data]) => ({
    username: name,
    role: data.role || 'user',
    createdAt: data.createdAt,
  }));
  res.json(safeUsers);
});

// API: Create user (admin only)
app.post('/api/users', adminMiddleware, async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username e password obrigatorios' });
  const users = loadUsers();
  if (users[username]) return res.status(409).json({ error: 'Usuario ja existe' });
  const dataDir = path.join(PROJECTS_BASE, '_userdata', username);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  users[username] = {
    password: await senhas.criarHash(password),
    role: role || 'user',
    createdAt: new Date().toISOString(),
    dataDir,
  };
  saveUsers(users);
  // Also add to in-memory USERS for immediate auth
  USERS[username] = { password: users[username].password };
  res.json({ ok: true, username });
});

// API: Delete user (admin only)
app.delete('/api/users/:username', adminMiddleware, (req, res) => {
  const { username } = req.params;
  // Não deixa o admin excluir a si mesmo (trancaria a instalação).
  if (username === req.user.user) return res.status(400).json({ error: 'Não é possível excluir a própria conta' });
  const users = loadUsers();
  if (!users[username]) return res.status(404).json({ error: 'Usuario nao encontrado' });
  delete users[username];
  delete USERS[username];
  saveUsers(users);
  res.json({ ok: true });
});

// API: Update user settings/profile
// A0.6: o caminho "self" trocava a PRÓPRIA senha sem conferir a atual — um
// token roubado virava takeover permanente. Troca de senha do próprio usuário
// é SÓ pelo /api/settings/password (que exige a senha atual). Aqui, só admin.
app.patch('/api/users/:username', adminMiddleware, async (req, res) => {
  const { username } = req.params;
  const users = loadUsers();
  if (!users[username]) return res.status(404).json({ error: 'Usuario nao encontrado' });
  const { password, role } = req.body;
  if (password) { users[username].password = await senhas.criarHash(password); USERS[username] = { password: users[username].password }; }
  if (role) users[username].role = role;
  saveUsers(users);
  res.json({ ok: true });
});

// Extend login to also check users.json

// ─── Publish API ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// PAINEL ADMIN (/admin) — visão de dono do SaaS
// ═══════════════════════════════════════════════════════════════════════
function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    // papel AO VIVO do users.json, não o congelado no JWT de 24h —
    // ex-admin perde o acesso na hora, não na expiração do token
    const users = loadUsers();
    const live = req.user && users[req.user.user];
    if (live && live.role === 'admin') return next();
    res.status(403).json({ error: 'Acesso restrito a administradores' });
  });
}

// Config editável do painel (lida dinamicamente; não exige restart)
const NASCERA_CONFIG_FILE = path.join(__dirname, 'nascera-config.json');
// S1-3: cache ciente de mtime (mesmo padrão de domains.js:93 e billing.js).
// loadNasceraConfig() é chamado em ~20 lugares, alguns no caminho quente; antes
// relia + parseava o arquivo TODA vez. O cache invalida sozinho quando o mtime
// muda (edição externa) e é zerado no saveNasceraConfig (edição do próprio
// processo, que pode cair no mesmo milissegundo do mtime).
let _cfgCache = null, _cfgMtime = 0;
function loadNasceraConfig() {
  let mtime = 0;
  try { mtime = fs.statSync(NASCERA_CONFIG_FILE).mtimeMs; } catch {}
  if (_cfgCache && mtime === _cfgMtime) return _cfgCache;
  _cfgCache = leEstado(NASCERA_CONFIG_FILE, { fallback: {} });
  _cfgMtime = mtime;
  return _cfgCache;
}
function saveNasceraConfig(cfg) {
  gravaEstado(NASCERA_CONFIG_FILE, cfg);
  _cfgCache = null; _cfgMtime = 0;   // força releitura na próxima chamada
}

// Log de atividade local (o buffer de telemetria é despachado para o servidor
// de licenças e se perde; o painel precisa de um histórico próprio)
const ACTIVITY_FILE = path.join(__dirname, 'activity-log.json');
function appendActivity(entry) {
  try {
    const log = leEstado(ACTIVITY_FILE, { fallback: [] });
    log.push(entry);
    if (log.length > 400) log.splice(0, log.length - 400);
    gravaEstado(ACTIVITY_FILE, log, { pretty: 0 });
  } catch {}
}

// Tamanho de pastas com cache (varrer a árvore é caro com muitos projetos)
//
// Era `du -sk`. O `du` não existe no Windows, então o execSync falhava, o
// catch engolia e TODO projeto aparecia com 0 KB no painel — número errado
// entregue como se fosse certo. A troca não é um `if (win32)`: é usar a
// medição em Node que o projeto JÁ tem (`seguranca.medir`, de
// caminhos-seguros.js), a mesma que informa o tamanho antes de apagar. Um
// número só no produto inteiro, e igual nos três sistemas.
//
// Custo: medir é uma varredura real (readdir + stat por arquivo), com teto
// de arquivos por projeto. Por isso o cache de 60s continua sendo o que
// segura a conta — sem ele, cada abertura do painel andaria a árvore toda.
let _sizeCache = { at: 0, map: {} };
// Teto por projeto. `medir` para de contar aqui e marca `truncado` — um
// projeto com node_modules estoura fácil, e aí o número vira "pelo menos
// isso" em vez de travar o servidor contando arquivo de dependência.
const TETO_ARQUIVOS_POR_PROJETO = 60000;
// Orçamento de tempo da passada inteira. A varredura é SÍNCRONA e segura o
// event loop — mas o `execSync` do `du` também segurava, com timeout de 20s.
// Mantemos essa garantia: a diferença é que, quando o tempo acaba, o `du`
// estourava e devolvia ZERO PARA TODOS, e aqui os projetos já medidos ficam
// medidos e os que faltaram herdam o número da rodada anterior.
const ORCAMENTO_MEDICAO_MS = 10000;
function projectSizesKb() {
  if (Date.now() - _sizeCache.at < 60000) return _sizeCache.map;
  const anterior = _sizeCache.map || {};
  const inicio = Date.now();
  const map = {};
  try {
    // O glob `"$BASE"/*/` de antes pegava só as subpastas diretas — é o que
    // `withFileTypes` + isDirectory reproduz. Symlink NÃO entra (não é
    // diretório aqui, e `medir` também não segue link): seguir levaria a
    // contar a mesma pasta duas vezes, ou o disco inteiro.
    //
    // Duas fidelidades ao glob que o readdir cru não dá de graça:
    //   • pasta oculta fora. O `*` do shell não casa com nome começando por
    //     ponto, e é exatamente por isso que a quarentena se chama
    //     `.lixeira-nascera`: sem este filtro, o lixo de todo mundo entraria na
    //     conta do "espaço usado" do painel (que soma o mapa inteiro) e ainda
    //     comeria o orçamento de 10s medindo projeto já excluído.
    //   • ordem estável. O shell expande o glob em ordem alfabética; o
    //     readdir devolve na ordem do sistema de arquivos. Com mais de 200
    //     projetos, sem o sort o corte pegaria um conjunto diferente a cada
    //     rodada e o número do painel ficaria pulando de projeto em projeto.
    const pastas = fs.readdirSync(PROJECTS_BASE, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 200);   // mesmo teto do `head -200` que existia antes
    for (const p of pastas) {
      if (Date.now() - inicio > ORCAMENTO_MEDICAO_MS) {
        // Número velho é melhor que zero: zero é mentira, velho é atraso.
        if (anterior[p.name] !== undefined) map[p.name] = anterior[p.name];
        continue;
      }
      const m = seguranca.medir(path.join(PROJECTS_BASE, p.name), TETO_ARQUIVOS_POR_PROJETO);
      // KB, como o `du -sk` devolvia — a tela divide por 1024 para exibir MB.
      map[p.name] = Math.round(m.bytes / 1024);
    }
  } catch {}
  _sizeCache = { at: Date.now(), map };
  return map;
}

// ── Visão geral ──
// ─── Painel admin (S4: extraído para rotas/admin-painel.js) ───
// ─── Serviço de e-mail (A1: servicos/email.js) — criado ANTES de todo
// registrar que o injeta (const: TDZ se ficasse depois) ───
const emailServico = require('./servicos/email.js').criar({ loadNasceraConfig, segredos });

require('./rotas/admin-painel.js').registrar(app, {
  adminMiddleware, loadUsers, saveUsers, loadProjects, loadTrash, projectSizesKb,
  getEngine, readClaudeAuthStatus: claudeAuth.readClaudeAuthStatus, PORT, USERS, appendActivity,
  loadNasceraConfig, saveNasceraConfig, normalizeBuildLevel, ACTIVITY_FILE,
  email: emailServico,   // A1: aviso de suspensão manual
});

// ─── Rotas de e-mail: config admin + esqueci-senha (A1: rotas/email.js) ───
require('./rotas/email.js').registrar(app, {
  adminMiddleware, limiteSensivel, email: emailServico, segredos,
  loadUsers, saveUsers, loadNasceraConfig, saveNasceraConfig, appendActivity,
});

// ─── Webhooks de pagamento + ledger de vendas (A0.1/A0.3: rotas/webhooks.js) ───
require('./rotas/webhooks.js').registrar(app, {
  adminMiddleware, loadUsers, saveUsers, senhas, billing,
  vendas: require('./servicos/vendas.js'), segredos,
  loadNasceraConfig, saveNasceraConfig, appendActivity, trackEvent, USERS,
  email: emailServico,   // A1: boas-vindas + compra confirmada saem sozinhos
});

// ─── IA própria do usuário — BYOK (AD.1: rotas/ia-propria.js) ───
require('./rotas/ia-propria.js').registrar(app, {
  authMiddleware, adminMiddleware, segredos, loadUsers, saveUsers,
  loadNasceraConfig, saveNasceraConfig, appendActivity,
});

// ─── Compras do cliente + extrato (A0.4/A0.5: rotas/compras.js) ───
require('./rotas/compras.js').registrar(app, {
  authMiddleware, adminMiddleware, billing, vendas: require('./servicos/vendas.js'),
  loadUsers, loadNasceraConfig, saveNasceraConfig, appendActivity,
  email: emailServico,   // A1: confirmação do Pix por e-mail
});

// ── COBRANÇAS (estrutura de crédito do X8 OS) ──

// O que a tela do usuário lê (regra de exibição §3.1 implementada no motor)
app.get('/api/billing/me', authMiddleware, (req, res) => {
  res.json(billing.summaryFor(req.user.user));
});

// O portão, no formato do cliente X8: envelope {decision:{...}}, enum fechado
app.post('/api/llm/credit-decision', authMiddleware, (req, res) => {
  res.json(billing.gateDecision(req.user.user));
});

// ─── Rotas admin de billing (S4: extraídas para rotas/admin-billing.js) ───
require('./rotas/admin-billing.js').registrar(app, { adminMiddleware, loadUsers, loadNasceraConfig, saveNasceraConfig, appendActivity, vendas: require('./servicos/vendas.js') });

// Página do painel
// Painel v2 (design novo, modular em public/admin/). O v1 continua acessível
// em /admin-v1 enquanto o v2 amadurece — nada foi apagado.
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-v2.html')));
app.get('/admin-v1', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-v1.html')));

// ─── Ferramentas /api/tools/* (S4: extraído para rotas/tools.js) ───
// O extrator de UX é OPCIONAL: há distribuições do NASCERA que saem sem ele.
// Por isso o módulo é montado só se veio junto — em vez de o servidor morrer
// num require de arquivo ausente. Quem some com o arquivo não precisa mexer em
// mais nada: a interface pergunta ao servidor se a ferramenta existe (veja
// `sumirComFerramentasAusentes` em public/home.html) e esconde o menu sozinha.
if (fs.existsSync(path.join(__dirname, 'rotas', 'tools.js'))) {
  require('./rotas/tools.js').registrar(app, {
    authMiddleware, RAIZ: __dirname, THUMB_DIR, ensureThemesCatalog, makeSlug,
    loadNasceraConfig, appendActivity, loadUsers, billing, getEngine,
  });
} else {
  logger.info('[ferramentas] extrator de UX não instalado nesta distribuição — menu oculto');
}

// ─── Versionamento/publicação /api/projects/:id/{publish,versions,history,revert,rollback} (S4: rotas/projetos-versao.js) ───
require('./rotas/projetos-versao.js').registrar(app, {
  authMiddleware, projectOr404, git, hashValido, getNextVersion,
  autoCommit, getServableDir, atualizarProjeto, PUBLISHED_BASE,
});

// ─── Domínios personalizados ─────────────────────────────────────────
// O dono do projeto cadastra o domínio, o NASCERA devolve as instruções de DNS
// e confere a propagação de verdade (consulta A/CNAME/TXT). Só depois de
// verificado o roteador por Host começa a servir o site naquele domínio.

// ═══════════════ DONO DO PROJETO ═══════════════
// Projeto sem dono é projeto de todo mundo: até 04/08/2026 qualquer conta
// recém-criada listava e abria os projetos de todos os outros clientes —
// inclusive o chat, que dá ao Claude acesso aos arquivos daquele projeto.
//
// Regra: o dono é quem criou. Admin também passa (é ele quem dá suporte e
// quem já tem a máquina inteira na mão), mas a LISTA de cada um mostra só o
// que é dele — o painel admin é o lugar de ver tudo.
function ehAdmin(username) {
  try { return (loadUsers()[username] || {}).role === 'admin'; } catch { return false; }
}

// Nenhuma resposta de API devolve credencial. Um projeto remoto antigo pode
// ainda ter `remotePass` gravado (de antes do cofre) — este filtro garante
// que ele não vaze pela API enquanto a migração não roda.
function semSegredos(proj) {
  if (!proj) return proj;
  const { remotePass, ...limpo } = proj;
  return limpo;
}

// Senha SSH do projeto: cofre primeiro; o campo antigo em projects.json é
// aceito só como legado, e migrado para o cofre na primeira leitura.
function senhaSshDoProjeto(proj) {
  if (!proj) return null;
  const doCofre = segredos.obter('ssh:' + proj.id);
  if (doCofre) return doCofre;
  if (proj.remotePass) {
    try {
      segredos.guardar('ssh:' + proj.id, proj.remotePass);
      const todos = loadProjects();
      const alvo = todos.find(p => p.id === proj.id);
      if (alvo) { delete alvo.remotePass; saveProjects(todos); }
      logger.info('[cofre] senha SSH de "' + (proj.name || proj.id) + '" migrada para o cofre');
    } catch (e) { logger.error('[cofre] migração falhou:', e.message); }
    return proj.remotePass;
  }
  return null;
}

function podeAcessarProjeto(proj, username) {
  if (!proj) return false;
  if (proj.owner) return proj.owner === username || ehAdmin(username);
  // Sem dono gravado: só admin. O backfill do boot não deveria deixar
  // nenhum assim, mas se aparecer, o padrão é fechar, não abrir.
  return ehAdmin(username);
}

// Vale para todo mundo, admin inclusive: a área de trabalho de alguém é o
// que essa pessoa criou. Ver tudo é função do painel admin.
function projetosDoUsuario(username) {
  return loadProjects().filter(p => p.owner === username);
}

function projectOr404(req, res) {
  const projects = loadProjects();
  const proj = projects.find(p => p.id === req.params.id);
  // 404 (e não 403) de propósito: responder "existe, mas não é seu" já
  // confirma para um estranho que aquele id existe.
  if (!proj || !podeAcessarProjeto(proj, req.user && req.user.user)) {
    res.status(404).json({ error: 'Projeto não encontrado' });
    return null;
  }
  return proj;
}

// ─── Domínios do projeto /api/projects/:id/domains/* (S4: rotas/projetos-dominios.js) ───
require('./rotas/projetos-dominios.js').registrar(app, { authMiddleware, projectOr404, domains, appendActivity });

// ── admin: visão geral, config e o Caddyfile que entrega o HTTPS ──
// ─── Rotas admin de domínios (S4: extraídas) ───
require('./rotas/admin-domains.js').registrar(app, { adminMiddleware, loadNasceraConfig, saveNasceraConfig, appendActivity });

// ─── Versions API ────────────────────────────────────────────────────

// ─── Project Screenshot ────────────────────────────────────────────

// Generate screenshot for a project (async, non-blocking)
// S2-3: teto de Chromium simultâneos (padrão 2). Ver o uso em
// generateProjectScreenshot.
// ─── Runtime de preview (S4-2: servicos/preview-runtime.js) ───
const { generateProjectScreenshot, startDevServer, autoDetectPreview } = require('./servicos/preview-runtime.js').criar({
  RAIZ: __dirname, ticketDePreview, loadProjects, saveProjects, devServers: _devServers,
  sshExec, senhaSshDoProjeto,
});

// API: Save project thumbnail (from frontend canvas capture)
app.post('/api/projects/:id/thumbnail', authMiddleware, (req, res) => {
  const proj = projectOr404(req, res); if (!proj) return;

  const { dataUrl } = req.body;
  if (!dataUrl || !dataUrl.startsWith('data:image/')) return res.status(400).json({ error: 'Invalid image data' });

  try {
    const THUMB_DIR = path.join(__dirname, 'public', 'thumbnails');
    if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

    const ext = dataUrl.includes('image/png') ? 'png' : 'jpg';
    const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    const thumbFile = `project_${proj.slug}.${ext}`;
    fs.writeFileSync(path.join(THUMB_DIR, thumbFile), Buffer.from(base64Data, 'base64'));

    proj.thumbnail = `/thumbnails/${thumbFile}`;
    atualizarProjeto(proj.id, { thumbnail: proj.thumbnail });   // S1-2
    res.json({ ok: true, thumbnail: proj.thumbnail });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Generate thumbnail via server-side puppeteer (VPS only)
// ─── Preview do projeto /api/projects/:id/{generate-thumbnail,screenshot,visual-save,proxy,auto-preview,preview-url} (S4: rotas/projetos-preview.js) ───
require('./rotas/projetos-preview.js').registrar(app, {
  authMiddleware, limiteSensivel, projectOr404, podeAcessarProjeto,
  loadProjects, saveProjects, atualizarProjeto, generateProjectScreenshot,
  getServableDir, autoDetectPreview, git, _devServers,
});

// ─── File Upload ─────────────────────────────────────────────────────────
app.post('/api/projects/:id/upload', authMiddleware, (req, res) => {
  const projects = loadProjects();
  const proj = projectOr404(req, res); if (!proj) return;
  if (!proj.path) return res.status(400).json({ error: 'Projeto sem path' });

  const { filename, content: fileContent, encoding } = req.body;
  if (!filename || fileContent === undefined) {
    return res.status(400).json({ error: 'filename e content sao obrigatorios' });
  }

  // Sanitize filename — no path traversal
  const safeName = require('path').basename(filename).replace(/[^a-zA-Z0-9._\-]/g, '_');
  const uploadsDir = require('path').join(proj.path, 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

  const destPath = require('path').join(uploadsDir, safeName);
  try {
    if (encoding === 'base64') {
      const buf = Buffer.from(fileContent.replace(/^data:[^;]+;base64,/, ''), 'base64');
      fs.writeFileSync(destPath, buf);
    } else {
      fs.writeFileSync(destPath, fileContent, 'utf8');
    }
    const relPath = 'uploads/' + safeName;
    res.json({ ok: true, path: relPath, fullPath: destPath, filename: safeName });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao salvar arquivo: ' + err.message });
  }
});

// API: Generate all project screenshots
// A0.6: era authMiddleware — qualquer usuário logado disparava Chromium sobre
// os projetos de TODOS (custo + furo de multi-tenancy). Operação de dono.
app.post('/api/screenshots/generate-all', adminMiddleware, async (_req, res) => {
  const projects = loadProjects();
  let count = 0;
  for (const proj of projects) {
    if (proj.slug) {
      const url = await generateProjectScreenshot(proj);
      if (url) { proj.thumbnail = url; count++; }
    }
  }
  saveProjects(projects);
  res.json({ ok: true, generated: count });
});

// ─── Agents API ──────────────────────────────────────────────────
const AGENT_META = {
  dev:       { name: 'Dev',       role: 'Desenvolvedor Full-stack', icon: 'code',     color: '#60a5fa' },
  architect: { name: 'Architect', role: 'Arquiteto de Solucoes',    icon: 'building', color: '#a78bfa' },
  qa:        { name: 'QA',        role: 'Quality Assurance',        icon: 'search',   color: '#4ade80' },
  pm:        { name: 'PM',        role: 'Product Manager',          icon: 'clipboard',color: '#f59e0b' },
  ux:        { name: 'UX',        role: 'UX Designer',              icon: 'palette',  color: '#f472b6' },
  sm:        { name: 'SM',        role: 'Scrum Master',             icon: 'target',   color: '#38bdf8' },
};

// ─── Agent Pipeline (auto-orchestration) ─────────────────────────
// Single-phase creation: direct, fast, professional
const PIPELINE_PHASES = [
  {
    agent: 'dev',
    getPrompt: function(msg) {
      return 'O usuario quer: "' + msg.substring(0, 800) + '"\n\n' +
        'INSTRUCOES OBRIGATORIAS:\n' +
        '1. IMPLEMENTE o projeto COMPLETO agora. Nao planeje, nao pergunte, CONSTRUA.\n' +
        '2. Estrutura PROFISSIONAL — minimo: index.html + style.css + script.js + componentes separados se necessario.\n' +
        '3. Use Tailwind CSS via CDN e a font Inter via Google Fonts.\n' +
        '4. Design MODERNO e IMPRESSIONANTE:\n' +
        '   - Background escuro (#08060f ou similar dark)\n' +
        '   - Glass morphism (backdrop-blur, bg-white/5, bordas sutis)\n' +
        '   - Gradientes sutis, sombras coloridas\n' +
        '   - Animacoes CSS (fadeIn, slideUp, hover effects)\n' +
        '   - Tipografia bem hierarquizada (titulos grandes, textos suaves)\n' +
        '   - Cards com borda gradiente, hover lift (-translate-y)\n' +
        '   - Responsivo mobile-first\n' +
        '5. Dados REALISTAS de exemplo (nomes reais, numeros plausíveis, graficos se aplicavel).\n' +
        '6. Se for dashboard: use Chart.js via CDN para graficos reais.\n' +
        '7. Se for landing page: hero section impactante, features grid, testimonials, CTA.\n' +
        '8. Se for app/sistema: sidebar + header + conteudo principal funcional.\n' +
        '9. index.html DEVE existir na raiz. Tudo deve funcionar abrindo esse arquivo.\n' +
        '10. O resultado deve parecer um produto REAL, nao um exercicio de tutorial.\n' +
        '11. NUNCA use placeholder como "Lorem ipsum" — crie conteudo contextual realista.\n' +
        '12. Inclua icones SVG inline ou use Lucide/Heroicons via CDN.\n' +
        '13. Escreva TODO o codigo. Nao diga "adicione aqui" — implemente completo.';
    },
  },
];

app.get('/api/agents', authMiddleware, (_req, res) => {
  res.json(AGENT_META);
});

app.get('/api/projects/:id/agent', authMiddleware, (req, res) => {
  const projects = loadProjects();
  const proj = projectOr404(req, res); if (!proj) return;
  res.json({ activeAgent: proj.activeAgent || 'dev' });
});

app.post('/api/projects/:id/agent', authMiddleware, (req, res) => {
  // Portão de dono: sem isto, trocar o :id lê/altera projeto alheio (IDOR).
  const proj = projectOr404(req, res); if (!proj) return;
  const { agent } = req.body;
  if (!agent || !VALID_AGENTS.includes(agent)) {
    return res.status(400).json({ error: 'Agente invalido. Validos: ' + VALID_AGENTS.join(', ') });
  }
  const atualizado = switchAgentForProject(proj.id, agent);
  if (!atualizado) return res.status(404).json({ error: 'Projeto nao encontrado' });
  res.json({ ok: true, activeAgent: agent, project: atualizado.name });
});

// ─── HTTP Server ───────────────────────────────────────────────────
// maxHeaderSize: o padrão do Node (16KB) conta a URL inteira — um prompt/nome
// longo na query estourava HTTP 431 antes do Express ver a requisição. O prompt
// já não viaja mais pela URL (home.html usa localStorage), mas 64KB dá folga
// para nome de projeto grande, cookies e afins sem reabrir esse bug.
const server = http.createServer({ maxHeaderSize: 64 * 1024 }, app);

// API: Connect to remote server via SSH
app.post('/api/remote/connect', authMiddleware, async (req, res) => {
  const { host, user, port, password, path: remotePath, projectName } = req.body;
  if (!host || !password) return res.status(400).json({ error: 'Host e senha sao obrigatorios' });

  const sshUser = user || 'root';
  const sshPort = port || 22;
  const rPath = remotePath || '/root';

  try {
    const creds = { host, port: sshPort, user: sshUser, password };

    try {
      const out = await sshExec(creds, 'echo OK', 15000);
      if (!out || !out.includes('OK')) {
        return res.status(400).json({ error: 'Conectou mas servidor remoto nao respondeu como esperado.' });
      }
    } catch (sshErr) {
      return res.status(400).json({ error: sshErrorMessage(sshErr) });
    }

    const slug = makeSlug((projectName || host) + '-remote');
    const name = projectName || (sshUser + '@' + host);

    // Check uniqueness
    const projects = loadProjects();
    const existing = projects.find(p => p.slug === slug);
    if (existing) {
      // Update credentials
      existing.remoteHost = host;
      existing.remoteUser = sshUser;
      existing.remotePort = sshPort;
      // A senha vai para o cofre cifrado (0600), não para projects.json —
      // que tem permissão 644, entra em backup e quase foi para um release.
      segredos.guardar('ssh:' + existing.id, password);
      delete existing.remotePass;
      existing.remotePath = rPath;
      saveProjects(projects);
      return res.json(semSegredos(existing));
    }

    // Create local folder for chat history + CLAUDE.md
    const localPath = path.join(PROJECTS_BASE, slug);
    if (!fs.existsSync(localPath)) fs.mkdirSync(localPath, { recursive: true });

    // ── Instruções de SSH SEM a senha ──────────────────────────────
    // ANTES, a senha de root do servidor do cliente era escrita EM TEXTO
    // PURO dentro do CLAUDE.md. Esse arquivo:
    //   · fica no projeto, com permissão normal de leitura;
    //   · é COMMITADO no git logo abaixo (git add -A);
    //   · e vai para o MODELO de IA como contexto a cada turno.
    // Ou seja, a credencial vazava para o disco, para o histórico e para
    // fora da máquina — sem ninguém perceber.
    //
    // Agora: a senha fica só no arquivo `.nascera/.ssh-cred` (0600, e o
    // `.nascera/` entra no .gitignore do projeto). O agente usa o wrapper
    // `./.nascera/ssh.sh`, que a lê com `sshpass -f` — assim ela também não
    // aparece na lista de processos, como apareceria com `sshpass -p`.
    const dirNascera = path.join(localPath, '.nascera');
    fs.mkdirSync(dirNascera, { recursive: true });
    fs.writeFileSync(path.join(dirNascera, '.ssh-cred'), password, { mode: 0o600 });
    try { fs.chmodSync(path.join(dirNascera, '.ssh-cred'), 0o600); } catch {}

    const wrapper = [
      '#!/bin/sh',
      '# Executa um comando no servidor remoto deste projeto.',
      '# A senha NÃO passa por argumento (não aparece em `ps`): sai de',
      '# .ssh-cred, que tem permissão 0600 e não é versionado.',
      '#   ./.nascera/ssh.sh "ls -la /caminho"',
      'DIR="$(cd "$(dirname "$0")" && pwd)"',
      'if [ -z "$1" ]; then echo "uso: ssh.sh <comando>"; exit 1; fi',
      'exec sshpass -f "$DIR/.ssh-cred" ssh -o StrictHostKeyChecking=no \\',
      '  -o ConnectTimeout=10 -p ' + Number(sshPort) + ' ' +
        JSON.stringify(sshUser + '@' + host) + ' "$@"',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dirNascera, 'ssh.sh'), wrapper, { mode: 0o755 });

    // Sem isto, o `git add -A` abaixo commitaria a credencial.
    fs.writeFileSync(path.join(localPath, '.gitignore'),
      '.nascera/\nnode_modules/\n.env\n');

    let md = '# Projeto Remoto - ' + sshUser + '@' + host + '\n\n';
    md += '## IMPORTANTE: este projeto vive num SERVIDOR REMOTO\n\n';
    md += 'Todo comando roda via SSH. Use SEMPRE o wrapper — ele já carrega a\n';
    md += 'credencial de forma segura, e a senha NÃO aparece em lugar nenhum:\n\n';
    md += '```sh\n./.nascera/ssh.sh "COMANDO_AQUI"\n```\n\n';
    md += '### Dados de conexao:\n';
    md += '- **Host:** ' + host + '\n';
    md += '- **Usuario:** ' + sshUser + '\n';
    md += '- **Porta:** ' + sshPort + '\n';
    md += '- **Diretorio do projeto:** ' + rPath + '\n\n';
    md += '### Como operar:\n';
    md += '- Listar: `./.nascera/ssh.sh "ls -la ' + rPath + '"`\n';
    md += '- Ler: `./.nascera/ssh.sh "cat ' + rPath + '/ARQUIVO"`\n';
    md += '- Executar: `./.nascera/ssh.sh "cd ' + rPath + ' && COMANDO"`\n\n';
    md += '### Regras:\n';
    md += '1. NUNCA opere em arquivos locais - tudo e remoto via SSH\n';
    md += '2. Sempre use o caminho completo ' + rPath + '\n';
    md += '3. Para multiplos comandos, use && dentro das aspas\n';
    md += '4. NUNCA imprima o conteudo de .nascera/.ssh-cred nem copie a senha\n';
    md += '   para outro arquivo, mensagem ou commit.\n';
    fs.writeFileSync(path.join(localPath, 'CLAUDE.md'), md);

    // Init git
    if (!fs.existsSync(path.join(localPath, '.git'))) {
      git(['init'], localPath);
      git(['config','user.name','Nascera AI'], localPath);
      git(['config','user.email','nascera@localhost'], localPath);
      git(['add','-A'], localPath); git(['commit','-m','Initial','--allow-empty'], localPath);
    }

    const project = {
      id: crypto.randomUUID(),
      owner: req.user.user,   // importação também tem dono
      name,
      slug,
      path: localPath,
      isRemote: true,
      remoteHost: host,
      remoteUser: sshUser,
      remotePort: sshPort,
      // remotePass NÃO entra aqui — vai cifrada no cofre (ver abaixo).
      remotePath: rPath,
      currentVersion: 0,
      publishedVersion: 0,
      sessionId: null,
      activeAgent: 'dev',
      createdAt: new Date().toISOString(),
    };
    segredos.guardar('ssh:' + project.id, password);
    projects.push(project);
    saveProjects(projects);
    res.status(201).json(semSegredos(project));
  } catch (err) {
    res.status(500).json({ error: 'Erro ao conectar: ' + err.message });
  }
});

// API: Detect or set proxy target for a project

// API: Install a plugin or skill
app.post('/api/skills/install', authMiddleware, (req, res) => {
  const { id, type, packageName } = req.body;
  if (!id) return res.status(400).json({ error: 'ID obrigatorio' });

  const RUNNER_USER = 'claude-runner';
  const installMap = {
    'superpowers': 'superpowers@superpowers-marketplace',
    'claude-mem': 'claude-mem@thedotmack',
  };

  // ERA RCE AUTENTICADO. O código fazia `packageName || installMap[id]`:
  // existia um allowlist, mas bastava mandar `packageName` no corpo da
  // requisição para ignorá-lo por completo — e o valor caía cru numa string
  // de shell (runCmd = execSync). Com `x'; comando; '` o atacante fechava o
  // `-c` do `su` e executava comando como root na VPS.
  //
  // Agora o allowlist manda. Nome livre só passa se casar com o formato de
  // um pacote de verdade — e mesmo assim vai por argv, não por shell.
  const NOME_PACOTE = /^[a-zA-Z0-9][a-zA-Z0-9@._/-]{0,80}$/;
  let pkg = installMap[id];
  if (!pkg && packageName) {
    if (!NOME_PACOTE.test(String(packageName))) {
      return res.status(400).json({ error: 'Nome de plugin inválido' });
    }
    pkg = String(packageName);
  }
  if (!pkg) return res.status(400).json({ error: 'Plugin nao encontrado no marketplace' });

  try {
    const isDesktop = process.env.NASCERA_DESKTOP === 'true' || process.platform === 'darwin' || process.platform === 'win32';
    const homeDir = process.env.HOME || require('os').homedir() || '/root';

    // Ensure marketplaces are added
    const marketplaces = {
      'superpowers-marketplace': 'https://github.com/obra/superpowers-marketplace.git',
      'thedotmack': 'https://github.com/thedotmack/claude-mem.git',
    };
    // Executa o CLI por ARGV, nunca por string de shell. Assim, mesmo que a
    // validação acima um dia afrouxe, não há linha de comando para injetar.
    //
    // Desktop: era `execFileSync('claude', args)` com o nome NU. No Windows o
    // `claude` do npm é um `claude.cmd` e o execFileSync sem shell LANÇA desde
    // o Node 18.20/20.12 — instalar skill era erro certo. Agora passa pelo
    // helper neutro (claudeCliSync → motores.invocacaoDe), que em macOS/Linux
    // devolve exatamente `claude` + argv, sem shell, como sempre foi.
    // VPS: `su -s /bin/bash` é Linux por definição — fica como está.
    const plugin = (subcomandos) => {
      if (isDesktop) {
        const r = claudeCliSync(subcomandos, homeDir, 180000);
        // Mesmo contrato de antes: stdout no sucesso, stdout+stderr na falha.
        // O que muda é só o fim da linha — quando o processo NEM RODOU não há
        // saída nenhuma, e o motivo real ("spawn claude ENOENT") vale mais que
        // um null que chega ao usuário como "Falha ao instalar" sem porquê.
        if (r.ok) return r.stdout.trim();
        return (r.stdout + r.stderr).trim() || r.erro || null;
      }
      try {
        return execFileSync('su', ['-s', '/bin/bash', '-c', 'claude ' + subcomandos.join(' '), RUNNER_USER], {
          cwd: homeDir, encoding: 'utf8', timeout: 180000, stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
      } catch (e) {
        return ((e.stdout || '') + (e.stderr || '')).trim() || null;
      }
    };

    const mkName = pkg.split('@')[1];
    if (mkName && marketplaces[mkName]) {
      try { plugin(['plugin', 'marketplace', 'add', marketplaces[mkName]]); } catch {}
    }

    const result = plugin(['plugin', 'install', pkg]);
    logger.info('[SKILLS] Install ' + pkg + ':', (result || '').substring(0, 200));

    if (result && (result.includes('Successfully installed') || result.includes('already installed'))) {
      // Enable the plugin after installing
      try { plugin(['plugin', 'enable', pkg]); } catch {}
      res.json({ ok: true, output: result });
    } else {
      res.status(500).json({ error: result || 'Falha ao instalar' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Falha ao instalar: ' + err.message });
  }
});

// API: List installed plugins
app.get('/api/skills/installed', authMiddleware, (_req, res) => {
  const RUNNER_USER = 'claude-runner';
  const isDesktop = process.env.NASCERA_DESKTOP === 'true' || process.platform === 'darwin' || process.platform === 'win32';
  const homeDir = process.env.HOME || require('os').homedir() || '/root';
  try {
    // Era `runCmd('claude plugin list 2>&1')` — execSync de STRING de shell.
    // No Windows isso falhava sempre (claude.cmd + `2>&1` que o cmd.exe não
    // entende do mesmo jeito), o catch devolvia null e a tela dizia "nenhuma
    // skill instalada" mentindo. Agora vai por argv no desktop e continua no
    // `su` na VPS — ver listarPluginsInstalados.
    const r = listarPluginsInstalados(isDesktop, homeDir, RUNNER_USER);
    // Só parseia saída de execução BEM-SUCEDIDA, como antes (o catch do runCmd
    // zerava tudo). O motivo, porém, não some mais: vai em `raw`/`erro`.
    const result = r.ok ? r.saida : '';
    // Parse installed plugin names
    const installed = [];
    if (result && !result.includes('No plugins installed')) {
      const lines = result.split('\n');
      lines.forEach(line => {
        const match = line.match(/[\u2713✔]\s+(\S+)/);
        if (match) installed.push(match[1]);
        // Also try format: "  ❯ pluginname"
        const match2 = line.match(/❯\s+(\S+)/);
        if (match2) installed.push(match2[1]);
        // Also try: "pluginname (version)" or "pluginname@marketplace"
        const match3 = line.match(/^\s+(\S+@\S+)/);
        if (match3) installed.push(match3[1].split('@')[0]);
      });
    }
    // `erro` é campo NOVO e só aparece quando houve falha: a tela lia apenas
    // `installed` e continua lendo. Antes, falha e "nada instalado" chegavam
    // idênticas ao front — impossível distinguir CLI ausente de lista vazia.
    res.json(r.ok ? { installed, raw: r.saida } : { installed, raw: r.saida, erro: r.erro });
  } catch (err) {
    res.json({ installed: [], raw: '', erro: err.message });
  }
});

// API: Check if a session is still running for a project (engine v2)
// API: Get chat history for a project
// Emite a URL de preview já com o ticket. O front chama isto antes de
// carregar o iframe; o ticket vale 12h e é escopado ao dono e ao projeto.
app.get('/api/projects/:id/preview-ticket', authMiddleware, (req, res) => {
  const proj = projectOr404(req, res); if (!proj) return;
  const ticket = ticketDePreview(proj.slug, req.user.user);
  res.json({ url: '/preview/' + proj.slug + '~' + ticket + '/', expiraEm: Date.now() + PREVIEW_TTL_MS });
});

// ─── Histórico de chat do projeto (S4: rotas/projetos-chat-historico.js) ───
require('./rotas/projetos-chat-historico.js').registrar(app, { authMiddleware, projectOr404, loadChatHistory, clearChatHistory });

// --- Integrations API ---
// ─── Rotas de integrações (S4: extraídas para rotas/integracoes.js) ───
require('./rotas/integracoes.js').registrar(app, { authMiddleware, loadIntegrations, saveIntegrations });

// ─── WebSocket ─────────────────────────────────────────────────────
const wss = new WebSocket.Server({ noServer: true });
const wssTerm = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => { wss.emit('connection', ws, req); });
  } else if (pathname === '/ws-terminal') {
    wssTerm.handleUpgrade(req, socket, head, (ws) => { wssTerm.emit('connection', ws, req); });
  } else if (pathname.startsWith('/ide')) {
    // Proxy WebSocket to code-server
    const net = require('net');
    const targetUrl = req.url.replace(/^\/ide/, '') || '/';
    const proxySocket = net.connect(CODE_SERVER_PORT, '127.0.0.1', () => {
      const reqHeaders = Object.entries(req.headers).map(([k,v]) => k + ': ' + v).join('\r\n');
      proxySocket.write(
        req.method + ' ' + targetUrl + ' HTTP/' + req.httpVersion + '\r\n' +
        'Host: 127.0.0.1:' + CODE_SERVER_PORT + '\r\n' +
        reqHeaders + '\r\n' +
        '\r\n'
      );
      if (head && head.length) proxySocket.write(head);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });
    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
  } else {
    socket.destroy();
  }
});

const sessions = new Map();

// ═══════════════════════════════════════════════════════════════════════
// ENGINE v2 — Claude Agent SDK (sessão viva por projeto)
// O motor antigo (spawn `claude -p` por mensagem) foi substituído por
// engine/claude-engine.mjs. Cada projeto tem UMA sessão viva do Claude Code
// com streaming token a token, troca de modelo/modo em runtime, permissões
// interativas, perguntas (AskUserQuestion), plan mode real e imagens.
// ═══════════════════════════════════════════════════════════════════════
let _enginePromise = null;
function getEngine() {
  // NASCERA_FAKE_ENGINE (só em teste) troca o motor real por engine/fake-engine.mjs
  // — mesma superfície, sem Claude nem crédito. Com a env desligada é idêntico.
  if (!_enginePromise) _enginePromise = import(
    process.env.NASCERA_FAKE_ENGINE ? './engine/fake-engine.mjs' : './engine/claude-engine.mjs');
  return _enginePromise;
}

// Canais: um por sessão (projeto), com N WebSockets conectados.

// VPS: roda o CLI como usuário claude-runner via su (mesma política do motor antigo)
// ═══════════════ COFRE (sandbox de execução) ═══════════════
// Qualquer usuário do painel manda o Claude executar o que quiser. Sem
// isolamento, "leia /root/fluxora-terminal/users.json" devolve a senha de
// todos os clientes, e "leia server.js" entrega o produto inteiro.
//
// Rodar como claude-runner (o que já era feito) não basta: o usuário do SO é
// o mesmo para todas as sessões, então um cliente lê o projeto do outro, e
// qualquer arquivo do servidor legível por ele.
//
// O cofre resolve na raiz: um namespace de montagem onde os caminhos que não
// interessam SIMPLESMENTE NÃO EXISTEM. Não é uma regra que o modelo possa
// contornar com um comando esperto — é o sistema de arquivos que ele enxerga.
const RUNNER_USER = 'claude-runner';
const RUNNER_HOME = '/home/' + RUNNER_USER;

let _cofre = null;
function cofreDisponivel() {
  if (_cofre) return _cofre;
  _cofre = { ok: false, motivo: '' };
  try {
    if (process.platform !== 'linux' || isDesktopLocal) {
      _cofre.motivo = 'só no servidor Linux';
      return _cofre;
    }
    if (process.getuid && process.getuid() !== 0) {
      _cofre.motivo = 'o NASCERA precisa subir como root para montar o cofre';
      return _cofre;
    }
    const cp = require('child_process');
    cp.execFileSync('bwrap', ['--version'], { stdio: 'ignore', timeout: 5000 });
    const uid = parseInt(cp.execFileSync('id', ['-u', RUNNER_USER], { timeout: 5000 }).toString().trim(), 10);
    const gid = parseInt(cp.execFileSync('id', ['-g', RUNNER_USER], { timeout: 5000 }).toString().trim(), 10);
    if (!(uid > 0) || !(gid > 0)) throw new Error('usuário ' + RUNNER_USER + ' não existe');
    _cofre = { ok: true, uid, gid };
  } catch (e) {
    _cofre = { ok: false, motivo: (e.message || String(e)).slice(0, 120) };
  }
  return _cofre;
}

// Monta a lista de binds. Regra: só entra o que a sessão precisa para
// trabalhar — e sempre em leitura, exceto o projeto e o home do runner.
function argsDoCofre(projectPath, cofre, comando) {
  const themesDir = path.join(__dirname, 'themes');
  const a = [
    // sistema, só leitura
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/sbin', '/sbin',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/etc', '/etc',
    '--proc', '/proc', '--dev', '/dev',
    // O /tmp do cofre nasce como root. O processo roda sem privilégio e o
    // Claude precisa escrever ali (ele cria /tmp/claude-<uid>) — sem o 1777
    // a sessão morre com "EACCES: mkdir /tmp/claude-1000". 1777 é o mesmo
    // modo do /tmp de verdade: qualquer um escreve, ninguém apaga do outro.
    '--tmpfs', '/tmp', '--chmod', '1777', '/tmp',
  ];
  if (fs.existsSync('/lib64')) a.push('--ro-bind', '/lib64', '/lib64');

  // DNS. No Ubuntu o /etc/resolv.conf é um link para /run/systemd/resolve/ —
  // sem montar esse caminho, o link fica pendurado, nome nenhum resolve e a
  // sessão trava sem erro visível (a conexão simplesmente nunca completa).
  // Os dois --dir são obrigatórios: o bwrap cria diretório-pai como 0700 root,
  // e o processo sem privilégio não atravessa nem até o arquivo.
  if (fs.existsSync('/run/systemd/resolve')) {
    a.push('--dir', '/run', '--chmod', '0755', '/run');
    a.push('--dir', '/run/systemd', '--chmod', '0755', '/run/systemd');
    a.push('--ro-bind', '/run/systemd/resolve', '/run/systemd/resolve');
  }

  // bwrap cria os diretórios-pai como 0700 root; sem afrouxar, o processo
  // (que roda sem privilégio) não consegue nem atravessar até o projeto.
  const pai = path.dirname(projectPath);
  a.push('--dir', '/home', '--chmod', '0755', '/home');
  a.push('--dir', '/root', '--chmod', '0711', '/root');
  // 0711: dá para ATRAVESSAR até o projeto, não para LISTAR o que mais existe
  // ali. Sem isso, o cliente descobre o nome dos projetos dos outros.
  if (pai !== '/root') a.push('--dir', pai, '--chmod', '0711', pai);

  // o que a sessão pode escrever: o projeto dela, e nada mais
  a.push('--bind', projectPath, projectPath);
  // sessão/credencial do Claude
  a.push('--bind', RUNNER_HOME, RUNNER_HOME);
  // biblioteca de temas: a skill nascera-templates lê daqui (só leitura)
  if (fs.existsSync(themesDir)) a.push('--ro-bind', themesDir, themesDir);

  // O executável do Claude vem de dentro do node_modules do NASCERA
  // (@anthropic-ai/claude-agent-sdk-linux-x64/claude), não do /usr/bin. Sem
  // montar a pasta dele, o processo nasce com "exited with code 127" — o
  // arquivo simplesmente não existe lá dentro. Montamos só a pasta do binário:
  // o resto do node_modules, e o server.js ao lado, continuam invisíveis.
  if (comando && path.isAbsolute(comando) && fs.existsSync(comando)) {
    const pastaDoBinario = path.dirname(comando);
    if (!pastaDoBinario.startsWith('/usr/') && !pastaDoBinario.startsWith('/bin')) {
      a.push('--ro-bind', pastaDoBinario, pastaDoBinario);
    }
  }

  // O MESMO problema vale para o `node`. A ferramenta de imagem do projeto
  // (.nascera/imagem.cjs) é um script Node — antes era `.sh` com curl, que vinha
  // de /usr/bin e portanto já estava montado. Quando o node é instalado por
  // nvm (~/.nvm/versions/node/vXX/bin), ele NÃO está em nenhum dos caminhos
  // de sistema montados acima: dentro do cofre o comando não existe, e a
  // geração de imagem — que é PAGA — falharia sem explicação. Montamos a
  // pasta do executável que ESTE processo está usando, que é o node certo por
  // definição. Só leitura, e nada de novo entra quando o node já vem de /usr.
  const pastaDoNode = path.dirname(process.execPath);
  if (!pastaDoNode.startsWith('/usr/') && !pastaDoNode.startsWith('/bin') && fs.existsSync(pastaDoNode)) {
    a.push('--ro-bind', pastaDoNode, pastaDoNode);
  }

  a.push(
    '--setenv', 'HOME', RUNNER_HOME,
    '--setenv', 'USER', RUNNER_USER,
    '--chdir', projectPath,
    '--unshare-pid', '--unshare-ipc', '--unshare-uts',
    '--die-with-parent',
    '--',
    // dentro do cofre, larga o privilégio de root de vez
    'setpriv', '--reuid=' + cofre.uid, '--regid=' + cofre.gid,
    '--clear-groups', '--no-new-privs',
  );
  return a;
}

function vpsSpawnWrapper(projectPath) {
  if (isDesktopLocal) return null;
  const cfgSandbox = (loadNasceraConfig().sandbox || 'auto');
  const cofre = cfgSandbox === 'off' ? { ok: false, motivo: 'desligado na configuração' } : cofreDisponivel();

  // Caminho bom: cofre de verdade.
  if (cofre.ok && projectPath && fs.existsSync(projectPath)) {
    return (o) => {
      const args = argsDoCofre(projectPath, cofre, o.command).concat([o.command], o.args || []);
      return spawn('bwrap', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...o.env, HOME: RUNNER_HOME, USER: RUNNER_USER },
      });
    };
  }

  // Sem cofre (dev, sessão sem projeto, bwrap ausente): mantém o
  // comportamento antigo — usuário sem privilégio, sem isolamento de caminho.
  if (cfgSandbox !== 'off') {
    logger.warn('[cofre] rodando SEM isolamento de caminhos: ' + (cofre.motivo || 'sessão sem projeto'));
  }
  const esc = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  return (o) => {
    const envPairs = Object.entries({ ...o.env, HOME: RUNNER_HOME, USER: RUNNER_USER })
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => esc(k + '=' + v)).join(' ');
    const cmd = 'cd ' + esc(o.cwd || RUNNER_HOME) + ' && exec env ' + envPairs + ' ' + esc(o.command) + ' ' + (o.args || []).map(esc).join(' ');
    return spawn('su', ['-s', '/bin/bash', '-c', cmd, RUNNER_USER], { stdio: ['pipe', 'pipe', 'pipe'] });
  };
}

function sessionKeyFor(projectId, user) {
  return projectId || ('user:' + user);
}

// Prefixo de agente para @mention: com sessão viva, o CLAUDE.md não é relido
// no meio da conversa — então injetamos as instruções do agente na mensagem.
function agentInlinePrefix(agent) {
  try {
    const p = path.join(AGENTS_DIR, agent + '.md');
    if (!fs.existsSync(p)) return '';
    const body = fs.readFileSync(p, 'utf8');
    return '[Instruções do agente @' + agent + ' para ESTA mensagem]\n' + body + '\n[Fim das instruções do agente]\n\n';
  } catch { return ''; }
}

// ─── Canal do motor: bindChannel (S4-2: servicos/motor-canal.js) ───
const { bindChannel, ensureChannel } = require('./servicos/motor-canal.js').criar({
  channels, appendChatMessage, loadProjects, saveProjects, billing,
  autoCommitAsync, atualizarProjeto, getCurrentVersion, generateProjectScreenshot,
  getEngine, sessionKeyFor, isDesktopLocal, escreverFerramentaDeImagem, memoriaProjeto,
  PROJECTS_BASE, normalizeBuildLevel, loadNasceraConfig, modelosLocais, motores, vpsSpawnWrapper, BUILD_LEVELS,
  // AD.1: credencial de IA própria do dono (ou null → credencial da instalação)
  credencialIaPropria: (username) => require('./rotas/ia-propria.js')
    .credencialPara(username, { loadNasceraConfig, loadUsers, segredos }),
  // A1: aviso de 80% por e-mail no fim do turno (1× por janela)
  email: emailServico, loadUsers,
});

const WS_PING_INTERVAL = 25000;
const pingInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, WS_PING_INTERVAL);

wss.on('close', () => clearInterval(pingInterval));

function verifyToken(token) {
  if (!token) return null;
  // maxAge é guarda extra contra iat adulterado; clockTolerance absorve
  // desvio de relógio entre máquinas. issuer/audience recusam token de
  // outro contexto. Tokens antigos (sem iss/aud) são rejeitados de propósito:
  // um relogin e pronto — e eles eram os do bug que nunca expirava.
  try {
    return jwt.verify(token, JWT_SECRET, {
      issuer: JWT_ISS,
      audience: JWT_AUD,
      maxAge: '24h',
      clockTolerance: 30,
    });
  } catch { return null; }
}

// ─── WebSocket do motor /ws (S4-2: servicos/motor-ws.js) ───
require('./servicos/motor-ws.js').registrar(wss, {
  sessions, verifyToken, loadProjects, podeAcessarProjeto, trackEvent,
  loadChatHistory, ensureChannel, loadUsers, billing, appendChatMessage,
  switchAgentForProject, agentInlinePrefix, memoriaProjeto, getIntegrationsContext,
  getBuildScopeContext, BUILD_LEVELS,
});

// ─── Terminal WebSocket (real PTY shell) ──────────────────────────────
// ─── WebSocket do terminal /ws-terminal (S4-2: servicos/terminal-ws.js) ───
require('./servicos/terminal-ws.js').registrar(wssTerm, { verifyToken, loadUsers, trackEvent });

// ─── Cleanup ───────────────────────────────────────────────────────
function cleanup() {
  flushTodosOsChats();   // S2-1: grava o histórico de chat pendente antes de sair
  for (const [id, session] of sessions) {
    try { session.ws.close(); } catch {}
    sessions.delete(id);
  }
  // encerra as sessões vivas do motor (processos do Claude Code)
  if (_enginePromise) {
    _enginePromise.then(({ sessionManager }) => sessionManager.closeAll()).catch(() => {});
  }
}

process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT', () => { cleanup(); process.exit(0); });

// ─── Guardas de processo ─────────────────────────────────────────────
// Sem estes, uma exceção solta em callback assíncrono derrubava o processo
// SEM encerrar as sessões do motor — deixando processos `claude`/`codex`
// órfãos, e o PM2 reiniciando por cima deles. Agora o processo sempre morre
// limpo e com log, para o supervisor subir um estado íntegro.
//
// Sair mesmo (e não seguir rodando) é deliberado: depois de uma exceção não
// tratada o estado do processo é desconhecido, e servir requisição nesse
// estado é pior do que reiniciar.
let _encerrando = false;
function morrerLimpo(motivo, err) {
  if (_encerrando) return;
  _encerrando = true;
  logger.error('\n[FATAL] ' + motivo + ':', (err && err.stack) || err);
  try { appendActivity({ type: 'processo_fatal', user: null, data: { motivo, erro: String((err && err.message) || err) }, at: new Date().toISOString() }); } catch {}
  try { cleanup(); } catch (e) { logger.error('[FATAL] cleanup falhou:', e.message); }
  // Prazo curto para o log/estado assentarem antes do exit.
  setTimeout(() => process.exit(1), 300).unref();
}
process.on('uncaughtException', (err) => morrerLimpo('uncaughtException', err));
process.on('unhandledRejection', (motivo) => morrerLimpo('unhandledRejection', motivo));

// ─── Diagnóstico do cofre ──────────────────────────────────────────
// `node server.js --cofre-doctor` responde, sem subir o servidor: o
// isolamento está de pé nesta máquina, e o que ele deixa passar? Usa o MESMO
// caminho de código das sessões reais — testar por comando manual não prova
// que o produto está protegido.
if (process.argv.includes('--cofre-doctor')) {
  const projeto = process.argv[process.argv.indexOf('--cofre-doctor') + 1]
    || (loadProjects()[0] || {}).path;
  const estado = cofreDisponivel();
  logger.info('\n  Cofre: ' + (estado.ok ? 'DISPONÍVEL (uid ' + estado.uid + ')' : 'INDISPONÍVEL — ' + estado.motivo));
  logger.info('  Projeto de teste: ' + (projeto || '(nenhum)'));
  const wrapper = vpsSpawnWrapper(projeto);
  if (!wrapper) { logger.info('  Sem wrapper (modo desktop).\n'); process.exit(0); }

  // O teste que importa não é "listo a pasta de projetos", e sim "alcanço o
  // projeto de OUTRO cliente" — que é o vazamento de verdade.
  const vizinho = (loadProjects().find(p => p.path && p.path !== projeto) || {}).path;
  const alvos = [
    ['código-fonte do NASCERA', path.join(__dirname, 'server.js')],
    ['senhas dos usuários', path.join(__dirname, 'users.json')],
    ['segredos do processo', path.join(__dirname, 'ecosystem.config.js')],
    ['listar a pasta de projetos', PROJECTS_BASE],
  ];
  if (vizinho) alvos.push(['projeto de outro cliente', vizinho]);
  const script = alvos.map(([rot, p]) =>
    `printf '  %-32s ' '${rot}'; if cat '${p}' >/dev/null 2>&1 || ls '${p}' >/dev/null 2>&1; then echo 'ACESSÍVEL (!)'; else echo 'bloqueado'; fi`
  ).join('; ') + `; printf '  %-32s ' 'escrever no próprio projeto'; touch .cofre-doctor 2>/dev/null && rm -f .cofre-doctor && echo 'ok' || echo 'FALHOU'`;

  const p = wrapper({ command: '/bin/sh', args: ['-c', script], env: process.env, cwd: projeto });
  p.stdout.on('data', d => process.stdout.write(d));
  p.stderr.on('data', d => process.stderr.write(d));
  p.on('close', (code) => { logger.info('\n  (saída ' + code + ')\n'); process.exit(0); });
} else {

// ─── Start ─────────────────────────────────────────────────────────
const _catalogCount = ensureThemesCatalog();

// Projetos criados antes de existir o conceito de dono ficam órfãos — e
// órfão, pela regra nova, só é visível para admin. Adota todos no primeiro
// admin criado, que na prática é quem instalou o NASCERA. Se algum projeto for
// de outra pessoa, o admin transfere pelo painel.
(() => {
  try {
    const projetos = loadProjects();
    const orfaos = projetos.filter(p => !p.owner);
    if (!orfaos.length) return;
    const admins = Object.entries(loadUsers() || {})
      .filter(([, u]) => u && u.role === 'admin')
      .sort((a, b) => String(a[1].createdAt || '').localeCompare(String(b[1].createdAt || '')));
    if (!admins.length) return logger.warn('  ├─ Projetos: ' + orfaos.length + ' sem dono e nenhum admin para adotá-los');
    const dono = admins[0][0];
    for (const p of orfaos) p.owner = dono;
    saveProjects(projetos);
    logger.info('  ├─ Projetos: ' + orfaos.length + ' sem dono adotado(s) por "' + dono + '"');
  } catch (e) { logger.error('[projetos] backfill de dono falhou:', e.message); }
})();

// ─── Tratador central de erros ───────────────────────────────────────
// Registrado DEPOIS de todas as rotas, que é o que o Express exige.
// O que ele conserta: rotas que estouravam sem `try` deixavam a requisição
// pendurada até o timeout do cliente, e as que respondiam devolviam
// `err.message` cru — vazando caminho absoluto e detalhe interno para a tela.
// Agora o cliente recebe uma mensagem estável e o servidor guarda o detalhe.
app.use((err, req, res, _next) => {
  const id = crypto.randomBytes(6).toString('hex');
  logger.error('[erro ' + id + '] ' + req.method + ' ' + req.originalUrl + ':', (err && err.stack) || err);

  // Corpo maior que o limite tem resposta própria: é erro do cliente, não nosso.
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: 'Conteúdo grande demais.' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido no corpo da requisição.' });
  }
  if (res.headersSent) return;   // resposta já começou: só encerra
  res.status(500).json({
    error: 'Erro interno. Se persistir, informe o código abaixo ao suporte.',
    codigo: id,
  });
});

// Nenhuma senha em texto puro sobrevive a um boot.
senhas.migrarTudo(loadUsers, saveUsers).then((r) => {
  if (r.migrados) logger.info('  ├─ Senhas: ' + r.migrados + ' migrada(s) para hash (' + r.quais.join(', ') + ')');
}).catch((e) => logger.error('[senhas] migração falhou:', e.message));
// Com a transição ligada, o cache do Postgres é hidratado do JSON e o banco
// é reconciliado ANTES de aceitar tráfego — senão o primeiro loadProjects()
// devolveria cache vazio. leEstado direto (não loadProjects) para ler do JSON
// mesmo com estadoDb já ATIVO, que é a fonte de reconciliação.
async function iniciarEstadoDb() {
  if (!estadoDb.ATIVO) return;
  try {
    const r = await estadoDb.iniciar({
      projetosJson: leEstado(PROJECTS_FILE, { fallback: [] }),
      usuariosJson: leEstado(USERS_FILE, { fallback: {} }),
      lixeiraJson: leEstado(TRASH_FILE, { fallback: [] }),
    });
    // CUTOVER (pós-S4): o Postgres é o ÁRBITRO. No boot normal o cache é
    // hidratado DO BANCO e os JSONs são regravados como backup contínuo —
    // o arquivo passa a ser o retrato do banco, não o contrário. Nos casos
    // especiais (banco vazio, ou período degradado marcado), o JSON semeia e
    // o banco é reconciliado — auto-cura, nada se perde.
    if (r.fonte === 'pg' && r.dados) {
      gravaEstado(PROJECTS_FILE, r.dados.projetos);
      gravaEstado(USERS_FILE, r.dados.usuarios);
      gravaEstado(TRASH_FILE, r.dados.lixeira);
    }
    const rotulo = r.fonte === 'pg'
      ? 'Postgres FONTE (árbitro) — backup contínuo em JSON'
      : r.fonte === 'json-primeira-carga'
        ? 'Postgres semeado do JSON (primeira carga) — próximo boot lê do banco'
        : 'Postgres RECONCILIADO do JSON (período degradado curado) — próximo boot lê do banco';
    logger.info(`  ├─ Banco:   ${rotulo} — ${r.projetos} projetos, ${r.usuarios} usuários, ${r.lixeira} na lixeira`);
  } catch (e) {
    logger.error('\n[FATAL] falha ao iniciar o plano de dados no Postgres: ' + e.message);
    logger.error('        Desligue com NASCERA_DB_STATE=json para voltar ao JSON, ou conserte o banco.\n');
    process.exit(1);
  }
}

// ─── Preflight do motor ────────────────────────────────────────────────
// Roda ANTES de servir. Se o CLI embarcado sumiu (dependência opcional que
// não instalou, node_modules copiado de outra plataforma, deploy pela
// metade), restaura sozinho — na pasta do próprio NASCERA, que ele sempre pode
// escrever. É isto que faz o cliente nunca ficar com o motor desatualizado
// sem saber: ele não faz nada, o boot conserta. Nunca derruba o servidor —
// sem motor o painel ainda precisa abrir para a pessoa ver o diagnóstico.
let _motorBoot = null;
async function garantirMotorNoBoot() {
  try {
    const r = await motores.garantirMotor('claude', { reparar: true });
    _motorBoot = r;
    // O reparo mexeu no disco: descarta o caminho em cache para que as
    // chamadas seguintes usem o CLI restaurado, sem esperar um restart.
    if (r.reparado) {
      invalidarCmdDoMotor();
      logger.info('  ├─ Motor:   CLI restaurado automaticamente (estava ausente)');
    }
    if (!r.ok) logger.warn('  ├─ Motor:   ⚠ ' + (r.erro || 'CLI do Claude não encontrado'));
    else if (r.origem === 'global') {
      logger.warn('  ├─ Motor:   ⚠ usando o CLI GLOBAL — pode estar fora de sincronia com a SDK');
    }
  } catch (e) {
    _motorBoot = { ok: false, erro: e.message };
    logger.warn('  ├─ Motor:   ⚠ preflight falhou: ' + e.message);
  }
}

// O preflight roda DEPOIS do listen, em segundo plano. Ele pode gastar
// minutos num `npm install` — e numa máquina com firewall (justamente a que
// precisa do reparo) isso seguraria o boot inteiro nesse tempo. O painel
// precisa abrir para a pessoa ver o diagnóstico; o motor se conserta atrás.
iniciarEstadoDb().then(() => server.listen(PORT, BIND, () => {
  logger.info('');
  logger.info('  ⭐  Nascera AI v4.0 — Preview/Publish');
  logger.info(`  ├─ Themes:  ${_catalogCount} no catálogo (themes/catalog.json)`);
  logger.info(`  ├─ Main:    http://${BIND === '0.0.0.0' ? 'localhost' : BIND}:${PORT}`);
  logger.info(`  ├─ Preview: http://${BIND === '0.0.0.0' ? 'localhost' : BIND}:${PREVIEW_PORT}/{slug}/`);
  logger.info(`  ├─ Publish: http://${BIND === '0.0.0.0' ? 'localhost' : BIND}:${PUBLISH_PORT}/{slug}/`);
  logger.info(`  ├─ Rede:    ${BIND === '127.0.0.1'
    ? 'só esta máquina (127.0.0.1) — seguro'
    : '⚠ EXPOSTO EM ' + BIND + ' — qualquer aparelho da rede alcança'}`);

  // Código do primeiro acesso. Impresso SÓ quando ainda não há admin, e só
  // aqui — nunca por HTTP. Quem lê o terminal é quem tem a máquina.
  try {
    const temAdmin = Object.values(loadUsers()).some(u => u && u.role === 'admin');
    if (!temAdmin) {
      const t = tokenDeSetup();
      logger.info('  │');
      logger.info('  ├─ 🔑 PRIMEIRO ACESSO — código de instalação: \x1b[1m' + t + '\x1b[0m');
      logger.info('  │     Digite-o na tela de criação da conta. Ele impede que');
      logger.info('  │     outra pessoa crie a conta de administrador antes de você.');
    }
  } catch {}
  const _domAtivos = (() => { try { return domains.listAll().filter(d => d.status === 'ativo').length; } catch { return 0; } })();
  logger.info(`  ├─ Domínios: ${_domAtivos} ativo(s) — roteamento por Host`);
  // Mostra QUAL binário o processo está REALMENTE usando e de onde veio.
  // Deriva de resolverBinario (a mesma fonte dos spawns), não do resultado do
  // preflight: reportar o estado pós-reparo faria o log dizer "embarcado"
  // enquanto o processo ainda chamava o global velho — o pior tipo de mentira
  // para quem depura. Sem isto, um cliente quebrado parecia saudável no log.
  const _res = motores.resolverBinario('claude');
  const _sdk = motores.versaoDaSdk();
  const _mv = _res.caminho
    ? `${_sdk ? 'SDK ' + _sdk + ' · ' : ''}CLI ${_res.origem}`
    : 'CLI não encontrado';
  logger.info(`  └─ Claude:  Agent SDK v2 (sessão viva, streaming) — ${_mv}`);
  logger.info('');

  // Preflight do motor em segundo plano — depois de já estar servindo.
  garantirMotorNoBoot();

  // Revalida o DNS de tempos em tempos: domínio que deixou de apontar não
  // pode continuar exibido como "ativo". Primeira passada 1min após subir.
  const revalidar = () => {
    domains.revalidateAll({ max: 40 })
      .then(r => { if (r.mudaram.length) logger.info('[dominios] status atualizado:', JSON.stringify(r.mudaram)); })
      .catch(err => logger.error('[dominios] revalidação falhou:', err.message));
  };
  setTimeout(revalidar, 60000);
  setInterval(revalidar, 6 * 60 * 60 * 1000).unref();

  // ─── Licença / telemetria: ativação + heartbeat ───────────────────
  // Registra no servidor de licenças que esta instalação subiu (prova de uso)
  // e mantém um pulso de vida. Respeita a flag telemetryEnabled do painel.
  const getTelemetryContext = () => {
    let primaryDomain = null, users = null, projects = null;
    let adminEmail = null, adminEmails = [];
    try { primaryDomain = (domains.listAll().find(d => d.status === 'ativo') || {}).domain || null; } catch {}
    try {
      const todos = loadUsers() || {};
      users = Object.keys(todos).length;
      // Quem responde por esta instalação. O primeiro admin criado (o do setup)
      // é o dono; os demais vão junto para o titular saber quem mais manda aqui.
      adminEmails = Object.values(todos)
        .filter(u => u && u.role === 'admin' && u.email)
        .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
        .map(u => String(u.email).trim().toLowerCase());
      adminEmail = adminEmails[0] || null;
    } catch {}
    try { projects = (loadProjects() || []).length; } catch {}
    return { primaryDomain, users, projects, adminEmail, adminEmails };
  };
  if (loadNasceraConfig().telemetryEnabled !== false) {
    try {
      const installId = telemetry.init(getTelemetryContext);
      logger.info(`  ├─ Licença: telemetria ativa (install ${String(installId).slice(0, 8)}…)`);
    } catch (e) { logger.error('[telemetria] falha ao iniciar:', e.message); }
  }
}));

}
