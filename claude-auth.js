// ═══════════════════════════════════════════════════════════════════════
// NASCERA — estado de login do Claude (S4: extraído do server.js)
//
// Duas coisas que a tela de setup, as configurações e o painel admin
// consultam, e que estavam interligadas no meio das rotas de setup:
//   • readClaudeAuthStatus — "estou logado no Claude?" com cache curto, para
//     que vários polls/telas não disparem vários `claude auth status` (cada um
//     é um spawn síncrono de um CLI de centenas de MB).
//   • propagateClaudeAuth — copia a credencial (login feito como root) para o
//     usuário claude-runner, que é quem roda o Claude Code nos projetos.
//   • consultarAuthStatus — a ÚNICA volta ao `claude auth status` do sistema.
//     Devolve o que aconteceu separando as duas falhas que a tela de setup
//     confundia: "rodou e disse que não" ≠ "não conseguiu rodar".
//
// Resolve o binário do Claude pelo mesmo lugar que o resto do sistema
// (motores.binarioSync), então fica consistente com o claudeCmd() do server.
// ═══════════════════════════════════════════════════════════════════════
const cp = require('child_process');
const logger = require('./log.js');
const motores = require('./motores.js');

function cmd() {
  // Mesma fonte de verdade do claudeCmd() do server: env > embarcado > global.
  return motores.binarioSync('claude') || 'claude';
}

// ─── Erro que pode aparecer na TELA ─────────────────────────────────────
// As rotas de setup NÃO têm autenticação (a máquina pode nem ter admin ainda),
// então tudo que sai delas é público. A mensagem crua do spawn carrega o
// caminho absoluto do CLI ("spawn C:\Users\ana\AppData\Roaming\npm\claude.cmd
// ENOENT") — isso é planta baixa do servidor. Para a tela fica só o nome do
// arquivo, que é a parte que diagnostica; o caminho inteiro vai para o log,
// onde quem tem acesso à máquina lê.
const LIMITE_ERRO = 200;

function soONome(caminho) {
  const partes = String(caminho).split(/[\\/]/).filter(Boolean);
  return partes.length ? partes[partes.length - 1] : String(caminho);
}

function semCaminhos(texto, alvo) {
  let t = String(texto == null ? '' : texto);
  // Troca EXATA do caminho que originou a falha, antes de qualquer regex.
  // As regex abaixo param no primeiro espaço em branco, e caminho com espaço é
  // a regra no desktop ("NASCERA NEW", "C:\Program Files", "/Users/Ana Paula"):
  // sem esta troca, "spawn /Users/gu/NASCERA NEW/x/claude ENOENT" saía como
  // "spawn NASCERA NEW/x/claude ENOENT" — meio caminho do servidor numa resposta
  // de rota SEM autenticação. Aqui o caminho é conhecido, não há o que adivinhar.
  if (alvo) {
    const inteiro = String(alvo);
    if (inteiro.length > 1) t = t.split(inteiro).join(soONome(inteiro));
  }
  t = t
    .replace(/\\\\[^\s"']+/g, soONome)              // \\servidor\share\claude.cmd
    // A letra de unidade não pode ser precedida de letra/dígito: sem isso o
    // "s" de "https://…" casava como unidade e a URL virava lixo ilegível.
    .replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"']*/g, soONome)  // C:\Users\ana\…\claude.cmd
    .replace(/(^|[\s"'(])(\/[^\s"']*)/g, (_m, antes, caminho) => antes + soONome(caminho))
    // Rede de segurança para o resto de um caminho com espaço que as regex
    // acima deixaram para trás: qualquer palavra que ainda carregue separador
    // vira só o último pedaço. URL fica de fora — não é topologia do servidor.
    .replace(/\S*[\\/]\S*/g, (tok) => (tok.includes('://') ? tok : soONome(tok)))
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > LIMITE_ERRO ? t.slice(0, LIMITE_ERRO - 1) + '…' : t;
}

// ─── O CLI rodou, ou nem chegou a rodar? ────────────────────────────────
// spawnSync não lança: ele DEVOLVE o problema. `error` vem quando o processo
// nem foi criado (ENOENT do CLI ausente; EINVAL do .cmd, que o Node recusa sem
// shell desde o 18.20/20.12 por causa do BatBadBut) e `status === null` quando
// ele morreu sem código de saída (timeout, sinal). Nos dois casos NÃO existe
// resposta do CLI para interpretar — tratar isso como "não está logado" é
// mentir sobre o que aconteceu, e era o que deixava o cliente Windows gerando
// link de login para sempre.
//
// O texto devolvido é uma ORAÇÃO que completa "O motor de IA (Claude Code) …"
// na tela. Antes a frase da tela afirmava "não chegou a rodar" para os três
// casos — inclusive para o timeout, em que o processo rodou e foi morto. Dizer
// "não chegou a rodar: encerrado por SIGTERM" é descrever o que não aconteceu.
function falhaDeExecucao(r) {
  if (!r) return 'não chegou a rodar: o processo não foi criado';
  if (r.error) return 'não chegou a rodar: ' + String(r.error.message || r.error);
  if (r.status === null) {
    return r.signal ? `foi encerrado por ${r.signal} antes de responder`
                    : 'não respondeu dentro do tempo limite';
  }
  return null;
}

// O log fica com o texto INTEIRO (inclusive o caminho). Dedupe de 60s porque a
// tela de setup faz polling a cada 2,5s: sem ele, um motor quebrado enche o log
// de linhas idênticas e esconde o resto.
let _ultimaFalha = { msg: '', at: 0 };
function anotarFalha(detalhe, alvo) {
  // O detalhe já é a oração ("não chegou a rodar: …", "foi encerrado por …"):
  // repetir "não executou" aqui contradiria o caso do timeout.
  const msg = `[claude-auth] o CLI do Claude ${detalhe} (${alvo})`;
  if (msg === _ultimaFalha.msg && Date.now() - _ultimaFalha.at < 60000) return;
  _ultimaFalha = { msg, at: Date.now() };
  logger.warn(msg);
}

/**
 * Roda `claude auth status` UMA vez e conta o que aconteceu.
 *
 * @param {string} [comando] - Binário do Claude (padrão: o resolvido aqui).
 * @returns {{parsed: object|null, falhou: string|null}} `falhou` só vem
 *   preenchido quando o CLI não respondeu NADA aproveitável, e é uma oração que
 *   completa "O motor de IA (Claude Code) …", já sem caminho absoluto — pronta
 *   para ir à tela de uma rota sem autenticação.
 */
function consultarAuthStatus(comando) {
  const alvo = comando || cmd();
  let r;
  try {
    // invocacaoDe: em Unix devolve LITERALMENTE o spawnSync de hoje (arquivo =
    // alvo, args intocados, sem shell). No Windows destrincha o shim
    // `claude.cmd` em `node <cli.js>` — que é o que o spawnSync aceita. Era
    // exatamente aqui que o login morria e a tela culpava o código do usuário.
    const inv = motores.invocacaoDe(alvo, ['auth', 'status']);
    r = cp.spawnSync(inv.arquivo, inv.args,
      { encoding: 'utf8', timeout: 10000, env: process.env, shell: inv.shell });
  } catch (e) {
    // invocacaoDe recusa argumento perigoso quando só sobra o cmd.exe.
    const detalhe = 'não chegou a rodar: ' + String((e && e.message) || e);
    anotarFalha(detalhe, alvo);
    return { parsed: null, falhou: semCaminhos(detalhe, alvo) };
  }

  // RESPOSTA PRIMEIRO. O CLI escreve o JSON e só depois sai; se ele travar
  // DEPOIS de responder (checagem de update, telemetria), o timeout de 10s o
  // mata e o spawnSync devolve status null + SIGTERM com o stdout inteiro. O
  // código de hoje lia esse stdout e reportava o login corretamente — olhar a
  // causa de morte antes da saída transformava um "logado" em "loggedIn:false
  // com erro de motor". Só é falha de execução quando NÃO há resposta nenhuma.
  const out = (r.stdout || '') + (r.stderr || '');
  let parsed = null;
  try { parsed = JSON.parse(out.trim()); } catch {
    const m = out.match(/\{[\s\S]*"loggedIn"[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { /* saída suja: sem resposta */ } }
  }
  if (parsed) return { parsed, falhou: null };

  const falha = falhaDeExecucao(r);
  if (falha) {
    anotarFalha(falha, alvo);
    return { parsed: null, falhou: semCaminhos(falha, alvo) };
  }
  return { parsed: null, falhou: null };
}

let _cache = { at: 0, value: null };

function readClaudeAuthStatus(maxAgeMs = 1500) {
  if (_cache.value && Date.now() - _cache.at < maxAgeMs) {
    return _cache.value;
  }
  let value = { loggedIn: false };
  try {
    const { parsed, falhou } = consultarAuthStatus();
    if (parsed) {
      value = {
        loggedIn: !!parsed.loggedIn,
        email: parsed.email || parsed.account || '',
        authMethod: parsed.authMethod || '',
        subscriptionType: parsed.subscriptionType || '',
      };
    } else if (falhou) {
      // Campo ADITIVO: quem só lê `loggedIn` (settings, painel admin, a tela de
      // setup) não muda em nada. Quem quiser explicar POR QUE não há login
      // agora tem o motivo, em vez de um "false" sem causa.
      value = { loggedIn: false, erroDoMotor: falhou };
    }
  } catch {}
  _cache = { at: Date.now(), value };
  return value;
}

// Invalida o cache — útil após um login/logout, para a próxima leitura refletir
// o estado novo sem esperar a janela do cache.
function invalidarCache() { _cache = { at: 0, value: null }; }

// Copia a credencial do Claude (login feito como root) para o claude-runner,
// que roda o Claude Code nos projetos. Sem isso, o login "não vale" para eles.
//
// Devolve true só quando a cópia foi mesmo tentada e concluída — o valor é
// aditivo (nenhum chamador de hoje o lê), serve para o teste e para quem
// precisar decidir algo em cima disso amanhã.
function propagateClaudeAuth() {
  // Exceção legítima à regra de "não gatear por plataforma": aqui NÃO existe
  // equivalente neutro a copiar. O arranjo inteiro é do servidor Linux — um
  // segundo usuário do SO (claude-runner) rodando o CLI, credencial do /root
  // copiada e `chown` devolvendo a posse. No desktop (macOS/Windows) o Claude
  // roda como o próprio usuário: não há /root, não há claude-runner, não há o
  // que propagar. E no Windows a string abaixo cai no cmd.exe, que não tem
  // `mkdir -p`, `cp -f` nem `chown` — o cliente levava um erro no log a cada
  // login que, na verdade, deu certo. Degrada em silêncio, com log claro.
  if (process.platform !== 'linux') {
    logger.info('[claude-auth] propagação dispensada: o usuário claude-runner só existe no servidor Linux (plataforma: ' + process.platform + ')');
    return false;
  }
  try {
    cp.execSync(
      'mkdir -p /home/claude-runner/.claude && ' +
      'cp -f /root/.claude/.credentials.json /home/claude-runner/.claude/.credentials.json 2>/dev/null; ' +
      'cp -f /root/.claude.json /home/claude-runner/.claude.json 2>/dev/null; ' +
      'chown -R claude-runner:claude-runner /home/claude-runner/.claude /home/claude-runner/.claude.json 2>/dev/null; true',
      { timeout: 10000 });
    logger.info('[claude-auth] credencial propagada para claude-runner');
    return true;
  } catch (e) {
    logger.error('[claude-auth] falha ao propagar credencial:', e.message);
    return false;
  }
}

module.exports = {
  readClaudeAuthStatus, invalidarCache, propagateClaudeAuth,
  // consultarAuthStatus/semCaminhos são usados por rotas/setup.js: o login
  // precisa distinguir "não logado" de "motor não rodou", e a rota não pode
  // devolver caminho absoluto para quem não fez login.
  consultarAuthStatus, semCaminhos,
};
