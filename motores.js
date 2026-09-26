// ═══════════════════════════════════════════════════════════════════════
// NASCERA — Motores de IA
//
// O NASCERA trabalha com vários motores, e eles CONVIVEM: o dono escolhe qual
// conectar na instalação e troca quando quiser em Configurações.
//
//   claude    → Claude Code (Anthropic), via @anthropic-ai/claude-agent-sdk
//   codex     → GPT Codex (OpenAI), via CLI `codex exec --json`
//   opencode  → OpenCode (multi-provedor), via CLI `opencode run --format json`
//               O DeepSeek entra por aqui: não é um motor próprio, é um
//               provedor configurado dentro do OpenCode (ver opencode-engine.mjs).
//
// Este módulo só sabe responder três perguntas, que são as que a UI precisa:
// o CLI está instalado? está autenticado? como instalo/conecto?
//
// Diferenças que a UI precisa mostrar, porque mudam o que a pessoa vê no
// chat (medido, não suposto):
//
//                     Claude Code            GPT Codex              OpenCode
//   sessão            viva (1 processo)      1 processo por turno   1 processo por turno
//   permissão         pergunta no meio       decidida antes, pela   regras de config
//                                            sandbox                (allow/deny/ask)
//   modos             turbo/ask/edits/…      read-only/workspace-   mapeadas p/ regras
//                                            write/full             de permissão
//   esforço           por modelo             minimal/low/medium/    não existe — a
//                                            high                   "profundidade" é
//                                                                   o modelo escolhido
// ═══════════════════════════════════════════════════════════════════════

const { execFile, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const MOTORES = {
  claude: {
    id: 'claude',
    nome: 'Claude Code',
    fornecedor: 'Anthropic',
    binario: 'claude',
    pacote: '@anthropic-ai/claude-code',
    resumo: 'Sessão viva, pergunta permissão durante o trabalho e mostra o raciocínio.',
    comandoLogin: 'claude auth login',
    // O CLI do Claude Code vem DENTRO da @anthropic-ai/claude-agent-sdk, num
    // pacote por plataforma. Ver `binarioEmbarcado`.
    embarcado: true,
  },
  codex: {
    id: 'codex',
    nome: 'GPT Codex',
    fornecedor: 'OpenAI',
    binario: 'codex',
    pacote: '@openai/codex',
    resumo: 'Um processo por turno, com sandbox definida antes de começar.',
    comandoLogin: 'codex login',
    // O Codex não é embarcado: é um npm à parte, instalado sob demanda.
    embarcado: false,
  },
  opencode: {
    id: 'opencode',
    nome: 'OpenCode',
    fornecedor: 'Multi-provedor (Anthropic, OpenAI, DeepSeek…)',
    binario: 'opencode',
    pacote: '@opencode/cli',
    resumo: 'Um processo por turno, multi-provedor via configuração própria. ' +
            'O DeepSeek entra como provedor configurado dentro dele, não como motor à parte.',
    comandoLogin: 'opencode auth login <provedor> --method api-key',
    // Também não é embarcado: npm à parte, instalado sob demanda.
    embarcado: false,
  },
};

// ═══════════════════════════════════════════════════════════════════════
// ONDE MORA O CLI DO MOTOR — a correção do "não consigo fazer login"
//
// O problema real: o NASCERA chamava `claude` GLOBAL (o que o cliente instalou
// à mão). Esse binário se atualiza sozinho... quando o ambiente deixa. Num
// VPS ele congela por permissão (instalado como root, NASCERA roda como outro
// usuário), por sandbox ou por firewall — e aí o cliente fica com um CLI
// velho que não conhece `auth login`, ou que emite uma URL de OAuth em outro
// host. O login quebra e ninguém sabe por quê.
//
// A correção: NÃO depender do global. A própria claude-agent-sdk publica um
// pacote por plataforma com o executável dentro, e ele já vem PINADO pelo
// package-lock do NASCERA. Usar esse binário torna a versão do motor parte da
// versão do NASCERA: instalou (npm ci) = tem o CLI certo; atualizou o NASCERA =
// atualizou o motor, sempre num par testado.
//
// Medido nesta máquina quando o defeito foi diagnosticado:
//   global 2.1.181  ×  embarcado 2.1.220  → o login usava o VELHO.
// ═══════════════════════════════════════════════════════════════════════

// Alpine e afins usam musl; a SDK publica pacote separado para eles. Sem
// distinguir, escolheríamos um binário que não roda ("not found" enganoso).
function ehMusl() {
  // Só faz sentido no Linux: no macOS/Windows não existe glibc, e a ausência
  // dela marcaria "musl" em toda máquina Apple (era o que acontecia aqui).
  if (process.platform !== 'linux') return false;
  try {
    const r = process.report && process.report.getReport();
    return !!(r && r.header && !r.header.glibcVersionRuntime);
  } catch { return false; }
}

// Nomes de pacote candidatos, do mais provável ao menos — a lista existe
// porque uma imagem musl pode ter o pacote glibc instalado e vice-versa.
//
// Os parâmetros existem SÓ para o diagnóstico poder perguntar "e se esta
// máquina fosse linux-x64?" sem mexer em process.platform. Toda chamada de
// produção continua sem argumento, e aí o comportamento é o de sempre.
function sufixosDePlataforma(plataforma = process.platform, arquitetura = process.arch) {
  // Não inventar arquitetura: num ppc64/s390x, chutar 'x64' faria o reparo
  // tentar instalar um pacote inexistente a cada boot. Sem sufixo, quem
  // resolve é o global — que ali é a resposta certa.
  const arch = (arquitetura === 'arm64' || arquitetura === 'x64') ? arquitetura : null;
  if (!arch) return [];
  if (plataforma === 'linux') {
    return ehMusl()
      ? [`linux-${arch}-musl`, `linux-${arch}`]
      : [`linux-${arch}`, `linux-${arch}-musl`];
  }
  if (plataforma === 'darwin') return [`darwin-${arch}`];
  if (plataforma === 'win32')  return [`win32-${arch}`];
  return [];
}

// Caminho absoluto do CLI que veio junto com o NASCERA, ou null.
function binarioEmbarcado(id) {
  if (!MOTORES[id] || !MOTORES[id].embarcado) return null;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const sufixo of sufixosDePlataforma()) {
    const pacote = `@anthropic-ai/claude-agent-sdk-${sufixo}`;
    // require.resolve respeita a resolução real de node_modules (funciona
    // com hoisting, workspaces e instalações aninhadas).
    try {
      const pj = require.resolve(`${pacote}/package.json`, { paths: [__dirname] });
      const cand = path.join(path.dirname(pj), exe);
      if (ehExecutavel(cand)) return cand;
    } catch { /* pacote de outra plataforma: segue para o próximo */ }
    // Rede de segurança: pacote que não expõe package.json em "exports".
    const direto = path.join(__dirname, 'node_modules', pacote, exe);
    if (ehExecutavel(direto)) return direto;
  }
  return null;
}

// Procura no PATH (o jeito antigo, agora só como último recurso).
function binarioGlobalSync(binario) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawnSync(cmd, [binario], { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0) return null;
    const linhas = String(r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (!linhas.length) return null;
    // Unix continua exatamente como era: primeira linha do `which`.
    if (process.platform !== 'win32') return linhas[0];
    // O `where` do Windows lista TODAS as formas do mesmo comando, na ordem em
    // que aparecem no diretório: `codex` (script de shell escrito pelo npm,
    // inútil fora de um bash), `codex.cmd` e `codex.ps1`. Pegar a primeira
    // linha pegava justamente o script de shell — o Node nem sabe executar
    // aquilo, e o motor aparecia como "instalado mas não conectado". Escolhemos
    // por extensão: .exe/.com rodam direto; .cmd/.bat são shims que o
    // `invocacaoDe` sabe destrinchar. O .ps1 fica de fora de propósito: ele só
    // roda dentro do PowerShell e o npm sempre escreve o .cmd ao lado dele.
    for (const ext of ['.exe', '.com', '.cmd', '.bat']) {
      const achou = linhas.find(l => l.toLowerCase().endsWith(ext));
      if (achou) return achou;
    }
    return null;
  } catch { return null; }
}

// Um override do operador só vale se for um CAMINHO de verdade, existente.
//
// Sem esta guarda a correção inteira virava no-op em produção: o
// ecosystem.config.js do próprio NASCERA grava `CLAUDE_CMD=claude` (nome nu) no
// .env de toda instalação nova, e o degrau "env manda sempre" lia isso como
// "o operador escolheu" — voltando ao CLI global velho, sem aviso e sem
// reparo, exatamente nos clientes que não conseguiam fazer login. Nome nu não
// é escolha: é ausência de escolha. Só caminho absoluto existente conta.
function ehOverrideDeVerdade(valor) {
  if (!valor || typeof valor !== 'string') return false;
  const v = valor.trim();
  if (!v) return false;
  if (!v.includes(path.sep) && !v.includes('/')) return false;  // nome nu
  try { return fs.existsSync(v); } catch { return false; }
}

// Um binário só serve se existir E puder ser executado. `existsSync` sozinho
// aceita arquivo truncado (npm morto no meio do download) ou sem bit +x
// perdido numa cópia/zip — os dois viram "exited with code 126/127" na hora
// do turno, longe da causa.
function ehExecutavel(caminho) {
  try {
    const st = fs.statSync(caminho);
    if (!st.isFile() || st.size === 0) return false;
    if (process.platform !== 'win32') fs.accessSync(caminho, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

// Uma env var de escape por motor — o operador pode sempre apontar o binário
// à mão, sem depender de PATH/embarcado.
const ENV_POR_MOTOR = { claude: 'CLAUDE_CMD', codex: 'CODEX_CMD', opencode: 'OPENCODE_CMD' };

// ORDEM DE PREFERÊNCIA — e o porquê de cada degrau:
//   1. env (CLAUDE_CMD / CODEX_CMD / OPENCODE_CMD): escape do operador, manda sempre.
//   2. embarcado no node_modules:    pinado e testado com esta versão.
//   3. global no PATH:               o que quebrava; fica como último recurso
//      para não regredir quem já dependia dele (ex.: Codex).
// Devolve { caminho, origem } para a UI conseguir explicar de onde veio.
function resolverBinario(id) {
  const m = MOTORES[id];
  if (!m) return { caminho: null, origem: null };

  const doAmbiente = process.env[ENV_POR_MOTOR[id]];
  if (ehOverrideDeVerdade(doAmbiente)) return { caminho: doAmbiente, origem: 'env' };

  const emb = binarioEmbarcado(id);
  if (emb) return { caminho: emb, origem: 'embarcado' };

  const glob = binarioGlobalSync(m.binario);
  if (glob) return { caminho: glob, origem: 'global' };

  return { caminho: null, origem: null };
}

// Versão síncrona para o boot (o server precisa disto antes de servir).
function binarioSync(id) {
  return resolverBinario(id).caminho;
}

// ═══════════════════════════════════════════════════════════════════════
// EXECUTAR UM COMANDO QUE PODE SER UM SHIM DE SCRIPT (o buraco do Windows)
//
// No Windows `npm` não é um executável: é `npm.cmd`, um script. Isso quebra
// duas vezes, e as duas em silêncio:
//   1. a busca de PATH do Node (libuv) só tenta `.com` e `.exe` — o nome nu
//      `npm` nunca é encontrado e sai um ENOENT sem stderr;
//   2. desde o Node 18.20/20.12, por causa da correção do BatBadBut
//      (CVE-2024-27980), o Node RECUSA executar `.bat`/`.cmd` sem
//      `shell: true` — então nem apontar direto para o `npm.cmd` resolve.
// Vale para todo CLI instalado por `npm -g` (é o caso do `codex.cmd`).
//
// A saída NÃO é ligar `shell: true`: com shell, cada argumento passa pelo
// interpretador de comandos, e um `&`, `|` ou `%` dentro de um nome de pacote
// ou de um caminho de instalação vira execução de comando na máquina do
// cliente. O caminho preferido aqui é outro: descobrir o `.js` real que o shim
// chama e rodar `node <esse .js> <args>` — sem shell nenhum, com os argumentos
// entregues como argumentos de verdade, exatamente como em Unix.
//
// O cmd.exe só entra se esse caminho falhar, e mesmo assim com os argumentos
// conferidos um a um (ver `citarParaCmd`): metacaractere é recusado com erro,
// não escapado "com jeitinho".
// ═══════════════════════════════════════════════════════════════════════

// O que o Windows executa direto, sem intermediário.
const EXE_DIRETO = new Set(['.exe', '.com']);
// Shims de script escritos pelo npm; precisam do .js por trás ou do cmd.exe.
const SHIM_DE_SCRIPT = new Set(['.cmd', '.bat', '.ps1']);

// Lê um shim do npm e devolve o .js que ele chama, ou null.
// Formato do `cmd-shim` (estável há anos): a última linha invoca
//   "%dp0%\node_modules\@escopo\pacote\bin\cli.js" %*      (variante .cmd)
//   "$basedir/node_modules/.../cli.js"                     (variante .ps1)
// Se o shim vier em outro formato, devolvemos null e quem chama decide.
function alvoDoShim(caminhoShim) {
  const tentativas = [caminhoShim];
  // O .ps1 tem a mesma informação, mas o .cmd é o formato mais previsível.
  if (path.extname(caminhoShim).toLowerCase() === '.ps1') {
    tentativas.unshift(caminhoShim.slice(0, -4) + '.cmd');
  }
  for (const alvo of tentativas) {
    let texto;
    try {
      // Shim do npm tem poucos KB; um arquivo grande aqui não é um shim.
      if (fs.statSync(alvo).size > 64 * 1024) continue;
      texto = fs.readFileSync(alvo, 'utf8');
    } catch { continue; }
    const m = texto.match(/(?:%~?dp0%?|\$basedir)[\\/]([^"'\r\n]+?\.[cm]?js)\b/i);
    if (!m) continue;
    const js = path.join(path.dirname(alvo), m[1].replace(/\\/g, path.sep));
    try { if (fs.statSync(js).isFile()) return js; } catch { /* segue */ }
  }
  return null;
}

// Onde mora o npm-cli.js desta máquina. Ele é um .js comum: rodado por
// `node npm-cli.js …` faz exatamente o que `npm …` faria, sem shell.
function localizarCliDoNpm(qual = 'npm') {
  const alvo = qual === 'npx' ? 'npx-cli.js' : 'npm-cli.js';
  const candidatos = [];
  const shim = binarioGlobalSync(qual);
  // 1º o que o próprio shim aponta: é a verdade da instalação (cobre
  //    nvm-windows, npm atualizado por `npm i -g npm`, instalação por usuário).
  if (shim) {
    const doShim = alvoDoShim(shim);
    if (doShim) candidatos.push(doShim);
    candidatos.push(path.join(path.dirname(shim), 'node_modules', 'npm', 'bin', alvo));
  }
  // 2º o layout do instalador oficial: npm ao lado do node.exe em uso.
  candidatos.push(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', alvo));
  if (process.env.APPDATA) {
    candidatos.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', alvo));
  }
  for (const c of candidatos) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* tenta o próximo */ }
  }
  return null;
}

// Dado um comando, acha o .js que o executa de verdade (ou null).
function scriptPorTrasDoComando(cmd) {
  const base = path.basename(String(cmd));
  const ext = path.extname(base).toLowerCase();
  const nome = (ext ? base.slice(0, -ext.length) : base).toLowerCase();
  // Caminho absoluto de um shim (ex.: o codex.cmd que o `where` devolveu): o
  // próprio arquivo diz qual .js ele chama. Vem antes da busca por nome porque
  // é a resposta fiel A ESTE shim — procurar "npm" no PATH poderia achar outro.
  if (SHIM_DE_SCRIPT.has(ext) && path.isAbsolute(cmd)) {
    const doShim = alvoDoShim(cmd);
    if (doShim) return doShim;
  }
  if (nome === 'npm' || nome === 'npx') return localizarCliDoNpm(nome);
  return null;
}

// Último recurso: o cmd.exe. Aqui o argumento vira TEXTO dentro de uma linha de
// comando, então metacaractere é injeção — recusamos em vez de tentar escapar.
// Aspas são adicionadas só por causa de espaço (é comum: "C:\Program Files\…").
function citarParaCmd(valor) {
  const s = String(valor);
  if (!s) throw new Error('argumento vazio não pode ir para o cmd.exe');
  // %  expande variável mesmo dentro de aspas;  !  expande com delayed
  // expansion;  & | < > ^ " '  encadeiam ou redirecionam comandos.
  if (/[&|<>^"'`%!\r\n]/.test(s)) {
    throw new Error(`argumento recusado (metacaractere de shell): ${s}`);
  }
  return /[\s()]/.test(s) ? `"${s}"` : s;
}

/**
 * Como este comando deve ser invocado NESTA plataforma.
 * Em Unix devolve exatamente o que foi pedido — é o que garante que macOS e
 * Linux continuem com o comportamento de hoje, sem caminho de código novo.
 *
 * @param {string} cmd - Executável ou shim (ex.: 'npm', 'C:\\...\\codex.cmd').
 * @param {string[]} [args] - Argumentos, como já seriam passados ao execFile.
 * @param {object} [opcoes] - Injeção para teste: `plataforma`, `node`, `acharScript`.
 * @returns {{arquivo: string, args: string[], shell: boolean}}
 * @throws {Error} Se sobrar só o cmd.exe e algum argumento for perigoso.
 */
function invocacaoDe(cmd, args = [], opcoes = {}) {
  const plataforma = opcoes.plataforma || process.platform;
  const lista = Array.isArray(args) ? args.slice() : [];
  if (plataforma !== 'win32') return { arquivo: cmd, args: lista, shell: false };

  const ext = path.extname(String(cmd)).toLowerCase();
  // .exe/.com: executável nativo (é o caso do claude.exe embarcado). Roda direto.
  if (EXE_DIRETO.has(ext)) return { arquivo: cmd, args: lista, shell: false };

  const acharScript = opcoes.acharScript || scriptPorTrasDoComando;
  const script = acharScript(cmd);
  if (script) {
    // `node <cli.js> …`: sem shell, argumentos intocados. Este é o caminho bom.
    return { arquivo: opcoes.node || process.execPath, args: [script, ...lista], shell: false };
  }
  return { arquivo: citarParaCmd(cmd), args: lista.map(citarParaCmd), shell: true };
}

/**
 * Como invocar este comando DENTRO DE UM PSEUDO-TERMINAL (node-pty).
 *
 * O node-pty não tem a opção `shell` do child_process: no Windows ele chama
 * CreateProcessW direto, que não executa `.cmd`/`.bat` nem acha comando sem
 * extensão. Então o ramo que no execFile viraria `shell: true` aqui precisa de
 * um `cmd.exe /c` explícito — é a única forma de um pty do Windows rodar um
 * shim de script. Os outros dois ramos (executável nativo e `node <cli.js>`)
 * já são diretos e passam intactos.
 *
 * Em Unix devolve exatamente o que foi pedido: `invocacaoDe` nem entra no ramo
 * do Windows, então o login por terminal em macOS/Linux não muda uma vírgula.
 *
 * @param {string} cmd - Executável ou shim.
 * @param {string[]} [args] - Argumentos.
 * @param {object} [opcoes] - Injeção para teste: `plataforma`, `node`, `acharScript`.
 * @returns {{arquivo: string, args: string[]}}
 * @throws {Error} Se sobrar só o cmd.exe e algum argumento for perigoso.
 */
function invocacaoParaPty(cmd, args = [], opcoes = {}) {
  const inv = invocacaoDe(cmd, args, opcoes);
  if (!inv.shell) return { arquivo: inv.arquivo, args: inv.args };
  // `inv.arquivo` e `inv.args` já saíram de citarParaCmd, que RECUSA
  // metacaractere em vez de escapar — então nada aqui pode encadear comando.
  return { arquivo: 'cmd.exe', args: ['/c', inv.arquivo, ...inv.args] };
}

function rodar(cmd, args, timeout = 12000) {
  return new Promise((resolve) => {
    let inv;
    try {
      inv = invocacaoDe(cmd, args);
    } catch (e) {
      // Argumento recusado é falha do comando, não exceção solta no meio de um
      // request: quem chama já sabe tratar { ok: false }.
      return resolve({ ok: false, saida: '', erro: e.message });
    }
    execFile(inv.arquivo, inv.args, { timeout, encoding: 'utf8', shell: inv.shell }, (err, out, errOut) =>
      // `erro` caía vazio justamente quando mais importava: ENOENT/EINVAL não
      // escrevem em stderr, e o motivo real ("spawn npm ENOENT") só existe na
      // exceção. Sem isto o cliente Windows via "falha no npm" e mais nada.
      resolve({ ok: !err, saida: String(out || '').trim(),
                erro: String(errOut || '').trim() || (err ? String(err.message || err) : ''),
                // "não rodou" ≠ "rodou e respondeu não". O Node marca `err.code`
                // com STRING (ENOENT/EINVAL/EACCES) quando não conseguiu nem
                // criar o processo, e com o NÚMERO da saída quando o programa
                // rodou e terminou mal. Sem separar os dois, um `codex login
                // status` de quem simplesmente não fez login (sai com 1) seria
                // lido como defeito técnico — e a tela deixaria de dizer "rode
                // codex login" justo no caso mais comum. `killed` entra porque
                // timeout também é "nunca respondeu", não é resposta.
                naoExecutou: !!err && (typeof err.code === 'string' || !!err.killed) }));
  });
}

// (caminhoDo() foi removido: `estadoDe` passou a usar `resolverBinario`, que
// já cobre env/embarcado/global — manter as duas convidava a divergirem.)

// ─── OpenCode: onde mora a config de provedores (ex.: DeepSeek) ─────────
// O OpenCode não lê variável de ambiente para mudar o caminho do config —
// é sempre `~/.config/opencode/opencode.json(c)` (medido na v2.0.17 rodando
// `opencode debug paths`). O NASCERA gerencia só o bloco `providers.deepseek`
// desse arquivo (ver rotas/admin-motores.js); o resto do arquivo pode ter
// sido escrito à mão pelo operador, por isso a leitura aqui nunca escreve,
// só confere.
function caminhosConfigOpenCode() {
  const dir = path.join(os.homedir(), '.config', 'opencode');
  return [path.join(dir, 'opencode.json'), path.join(dir, 'opencode.jsonc')];
}

// Leitura tolerante: não é um parser JSONC completo, só o bastante para o que
// o próprio NASCERA escreve e para o exemplo padrão do OpenCode (comentário
// de linha inteira). Arquivo ilegível ou ausente devolve null — "não sei"
// nunca vira acusação de erro.
function lerConfigOpenCode() {
  for (const caminho of caminhosConfigOpenCode()) {
    let texto;
    try { texto = fs.readFileSync(caminho, 'utf8'); } catch { continue; }
    try { return JSON.parse(texto.replace(/^\s*\/\/.*$/gm, '')); } catch { continue; }
  }
  return null;
}

// "Configurado" aqui é bem mais fraco que a prova ao vivo do Claude (que bate
// na API da Anthropic): só confere que o bloco existe e que a env var que ele
// declara está setada NESTE processo — não confirma que a chave é válida.
function deepseekConfigurado() {
  const cfg = lerConfigOpenCode();
  const provedor = cfg && cfg.providers && cfg.providers.deepseek;
  if (!provedor || !Array.isArray(provedor.env)) return false;
  return provedor.env.some((nome) => !!process.env[nome]);
}

// Instalado ≠ conectado. Um CLI presente mas sem login falha só na hora do
// primeiro turno, e aí o cliente acha que o NASCERA quebrou.
async function estadoDe(id) {
  const m = MOTORES[id];
  if (!m) return null;
  const { caminho, origem } = resolverBinario(id);
  if (!caminho) {
    return { ...m, instalado: false, conectado: false, origem: null,
             comoInstalar: `npm install -g ${m.pacote}` };
  }
  const versao = (await rodar(caminho, ['--version'], 8000)).saida.split('\n')[0] || null;

  let conectado = false, conta = null, provaErro = null;
  if (id === 'claude') {
    const r = await rodar(caminho, ['auth', 'status'], 10000);
    try {
      const j = JSON.parse(r.saida);
      conectado = !!j.loggedIn;
      conta = j.email || null;
    } catch { conectado = /logged\s*in/i.test(r.saida); }
    // "Não conectado" tem duas causas MUITO diferentes: a pessoa não fez login,
    // ou o NASCERA não conseguiu nem executar o CLI (era o caso no Windows, com o
    // shim .cmd). Guardamos o motivo para a tela não acusar login que existe.
    // O gatilho é `naoExecutou`, não `!ok`: o CLI deslogado sai com código 1, e
    // usar `!ok` fazia toda instalação Unix ainda-sem-login perder o "rode
    // claude auth login" e receber no lugar o texto cru do erro.
    if (!conectado && r.naoExecutou) provaErro = (r.erro || r.saida || '').slice(-200) || null;
  } else if (id === 'opencode') {
    // O OpenCode não tem um "login" único como Claude/Codex: provedores
    // mainstream (Anthropic, OpenAI…) conectam via `auth login`/`/connect` e
    // aparecem em `auth list`; o DeepSeek, por ser um provedor customizado
    // autenticado só por variável de ambiente (ver caminhosConfigOpenCode),
    // NUNCA passa por ali (medido na v2.0.17: `auth list` só lista contas
    // salvas em auth.json). Por isso somamos as duas fontes.
    let provedoresLogados = [];
    const r = await rodar(caminho, ['auth', 'list', '--format', 'json'], 10000);
    try { provedoresLogados = JSON.parse(r.saida); } catch { provedoresLogados = []; }
    const temDeepseek = deepseekConfigurado();
    conectado = (Array.isArray(provedoresLogados) && provedoresLogados.length > 0) || temDeepseek;
    const nomes = [
      ...(Array.isArray(provedoresLogados)
        ? provedoresLogados.map((p) => (p && (p.provider || p.id || p.name)) || '?')
        : []),
      ...(temDeepseek ? ['deepseek'] : []),
    ];
    conta = nomes.length ? nomes.join(', ') : null;
    if (!conectado && r.naoExecutou) provaErro = (r.erro || r.saida || '').slice(-200) || null;
  } else {
    // O `codex login status` responde com texto livre; o que importa é
    // distinguir "não autenticado" de qualquer outra coisa.
    const r = await rodar(caminho, ['login', 'status'], 10000);
    const texto = (r.saida + ' ' + r.erro).toLowerCase();
    conectado = r.ok && !/not logged|não autenticado|no credentials|logged out/.test(texto);
    const m2 = (r.saida || '').match(/[\w.+-]+@[\w.-]+\.\w+/);
    conta = m2 ? m2[0] : null;
    // Mesma regra do claude: `codex login status` sem login sai com 1 e escreve
    // "Not logged in" — isso é RESPOSTA, não falha de execução.
    if (!conectado && r.naoExecutou) provaErro = (r.erro || r.saida || '').slice(-200) || null;
  }

  return { ...m, instalado: true, caminho, origem, versao, conectado, conta, provaErro,
           comandoLogin: m.comandoLogin };
}

async function estado() {
  const lista = await Promise.all(Object.keys(MOTORES).map(estadoDe));
  return { motores: lista };
}

// Versão da SDK que este NASCERA declara — é ela que define qual CLI é o certo.
// Lê do disco em vez de `require`: a SDK restringe "exports" e não deixa
// exigir o package.json dela (era isto que devolvia null aqui).
function versaoDaSdk() {
  const candidatos = [
    path.join(__dirname, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
  ];
  try {
    // Cobre hoisting/instalação aninhada: acha a pasta pelo módulo principal.
    const raiz = require.resolve('@anthropic-ai/claude-agent-sdk', { paths: [__dirname] });
    let dir = path.dirname(raiz);
    for (let i = 0; i < 5; i++) {
      candidatos.push(path.join(dir, 'package.json'));
      dir = path.dirname(dir);
    }
  } catch { /* sem a SDK: cai nos candidatos fixos */ }

  for (const c of candidatos) {
    try {
      const j = JSON.parse(fs.readFileSync(c, 'utf8'));
      if (j && j.name === '@anthropic-ai/claude-agent-sdk' && j.version) return j.version;
    } catch { /* tenta o próximo */ }
  }
  return null;
}

// ─── Preflight: garante o motor antes de precisar dele ─────────────────
// Roda no boot e antes do login. Se o binário embarcado sumiu (dependência
// opcional que não instalou, node_modules copiado entre plataformas, deploy
// pela metade), reinstala o pacote da plataforma NA PASTA DO PRÓPRIO NASCERA —
// que ele sempre pode escrever, ao contrário de um npm -g feito por outro
// usuário. Do lado do cliente é automático: ele não faz nada.
// Reparos em voo, por motor. Sem isto, o boot e um clique em ?reparar=1 (ou
// dois admins ao mesmo tempo) disparam `npm install` concorrentes na MESMA
// árvore de node_modules — npm não é seguro nesse cenário e pode deixar a
// árvore inconsistente. Chamadores concorrentes recebem a mesma promessa.
const _reparosEmVoo = new Map();

function garantirMotor(id = 'claude', opcoes = {}) {
  const emVoo = _reparosEmVoo.get(id);
  if (emVoo) return emVoo;
  const p = (async () => { try { return await _garantirMotor(id, opcoes); }
                           finally { _reparosEmVoo.delete(id); } })();
  _reparosEmVoo.set(id, p);
  return p;
}

async function _garantirMotor(id = 'claude', { reparar = true } = {}) {
  const m = MOTORES[id];
  if (!m) return { ok: false, erro: 'Motor desconhecido' };

  let { caminho, origem } = resolverBinario(id);
  if (caminho && origem !== 'global') {
    return { ok: true, caminho, origem, reparado: false };
  }

  // Só o Claude é embarcado — para o Codex, um global válido já serve.
  if (!m.embarcado) {
    return caminho
      ? { ok: true, caminho, origem, reparado: false }
      : { ok: false, erro: `${m.nome} não instalado`, comoInstalar: `npm install -g ${m.pacote}` };
  }

  // Chegou aqui: o embarcado não existe. O global (se houver) é justamente a
  // fonte do problema, então tentamos restaurar o embarcado.
  if (!reparar) {
    return { ok: !!caminho, caminho, origem, reparado: false,
             aviso: 'CLI embarcado ausente — usando o global, que pode estar desatualizado.' };
  }

  const versao = versaoDaSdk();
  const sufixos = sufixosDePlataforma();
  if (!versao || !sufixos.length) {
    return { ok: !!caminho, caminho, origem, reparado: false,
             erro: 'Plataforma sem pacote de CLI publicado' };
  }

  // --no-save: conserta a instalação sem sujar o package.json do cliente.
  const alvo = `@anthropic-ai/claude-agent-sdk-${sufixos[0]}@${versao}`;
  const r = await rodar('npm', ['install', '--no-save', '--no-audit', '--no-fund', alvo], 300000);

  const depois = resolverBinario(id);
  if (depois.caminho && depois.origem === 'embarcado') {
    // Não basta o arquivo existir: se o npm morreu no meio do download (o
    // timeout de rede é justamente o caso comum), sobra um binário truncado
    // que passaria em qualquer checagem de existência e só falharia no
    // primeiro turno do cliente. Provamos executando de fato.
    const prova = await rodar(depois.caminho, ['--version'], 15000);
    if (prova.ok && /\d+\.\d+/.test(prova.saida)) {
      return { ok: true, caminho: depois.caminho, origem: 'embarcado', reparado: true,
               versao: prova.saida.split('\n')[0] };
    }
    return { ok: false, caminho: null, origem: null, reparado: false,
             erro: 'CLI restaurado mas não executa (download incompleto?): ' +
                   (prova.erro || prova.saida || '').slice(-200) };
  }
  return { ok: !!depois.caminho, caminho: depois.caminho, origem: depois.origem, reparado: false,
           erro: (r.erro || 'npm não restaurou o CLI').slice(-400) };
}

// ═══════════════════════════════════════════════════════════════════════
// POR QUE ESTE BINÁRIO NÃO SOBE — diagnóstico honesto do executável
//
// O caso real: o dono levou o NASCERA empacotado para outro Mac e recebeu, vinda
// da SDK da Anthropic (não do NASCERA), esta mensagem:
//
//   "…/claude exists but failed to launch. This usually means the binary does
//    not match this system's libc…"
//
// Num Mac. Não existe libc de Alpine em Mac nenhum: o texto é genérico, serve
// para qualquer sistema e por isso não serve para nenhum. Mandou o dono caçar
// um problema de Linux que não existia e custou uma tarde.
//
// O NASCERA tem informação suficiente para dizer a verdade, porque o motivo de
// "existe mas não executa" está DENTRO DO ARQUIVO e é sempre um destes:
//
//   • é o programa de outra máquina → node_modules copiado entre computadores
//   • sem permissão de execução     → veio por pendrive FAT/exFAT ou por zip
//   • em quarentena do macOS        → chegou por download, zip ou AirDrop
//   • não está lá                   → dependências nunca instaladas aqui
//   • falta o carregador do sistema → o ÚNICO caso em que "libc" é verdade
//
// COMO DECIDIMOS DETECTAR A ARQUITETURA — lendo o CABEÇALHO do arquivo, não a
// lista de pacotes do node_modules. As duas opções foram consideradas:
//
//   • listar node_modules diz qual pacote de plataforma o npm instalou, ou
//     seja: diz o NOME DA PASTA. É metadado, e metadado mente. Uma pasta
//     `…-darwin-arm64` com um binário Intel dentro (cópia manual, rsync entre
//     máquinas, restauração de backup) passa como boa. Pior: não diz nada
//     sobre o CLI global do PATH nem sobre um CLAUDE_CMD apontado à mão, que
//     são dois dos três degraus do `resolverBinario` — o diagnóstico ficaria
//     cego justamente onde o operador mexeu.
//   • o cabeçalho é o que o PRÓPRIO KERNEL lê para decidir se executa. Mach-O
//     (macOS), ELF (Linux) e PE (Windows) declaram o processador nos primeiros
//     bytes. É evidência do arquivo exato que vamos rodar, custa uma leitura
//     de 8 KB, não depende de comando externo e vale para qualquer origem.
//
// Ficamos com o cabeçalho como PROVA. A lista de node_modules entra só como
// material de apoio, para o caso em que não sobrou binário nenhum para
// examinar: aí ela responde "existe aqui o pacote de OUTRA plataforma", que é
// exatamente a assinatura de uma pasta copiada de outro computador.
// ═══════════════════════════════════════════════════════════════════════

// Arquitetura declarada no cabeçalho, por formato. Só listamos o que a SDK
// publica mais o que é útil reconhecer para ACUSAR (x86 de 32 bits aparece em
// binário velho e o diagnóstico precisa saber dizer o nome dele).
const CPU_MACHO = { 7: 'x86', 16777223: 'x64', 12: 'arm', 16777228: 'arm64' };  // 0x01000007 / 0x0100000c
const MAQ_ELF   = { 0x03: 'x86', 0x3e: 'x64', 0x28: 'arm', 0xb7: 'arm64' };
const MAQ_PE    = { 0x014c: 'x86', 0x8664: 'x64', 0x01c4: 'arm', 0xaa64: 'arm64' };

// PT_INTERP: o carregador dinâmico que o ELF exige. É a diferença entre glibc
// (/lib64/ld-linux-*.so) e musl (/lib/ld-musl-*.so). Se o arquivo pedido não
// existe na máquina, o kernel recusa o programa com ENOENT — e é ESTE o único
// caso em que falar de "libc" é honesto.
function interpretadorElf(buf, le) {
  try {
    const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
    const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
    const u64 = (o) => Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));
    const phoff = u64(32), phentsize = u16(54), phnum = u16(56);
    if (!phoff || phentsize < 56 || !phnum || phnum > 128) return null;
    for (let i = 0; i < phnum; i++) {
      const p = phoff + i * phentsize;
      if (p + 40 > buf.length) return null;      // fora do pedaço lido: não afirmamos nada
      if (u32(p) !== 3) continue;                // 3 = PT_INTERP
      const ini = u64(p + 8), tam = u64(p + 32);
      if (!tam || tam > 512 || ini + tam > buf.length) return null;
      const s = buf.toString('latin1', ini, ini + tam);
      const nul = s.indexOf('\0');
      return (nul >= 0 ? s.slice(0, nul) : s) || null;
    }
  } catch { /* ELF fora do padrão: calar é melhor que chutar */ }
  return null;
}

/**
 * Lê os primeiros bytes e diz que programa é este: para qual sistema, para
 * qual processador. Devolve null quando nem deu para ler o arquivo — e "não
 * consegui ler" nunca vira acusação, quem chama simplesmente segue.
 *
 * @param {string} caminho
 * @returns {{formato:string, so:(string|null), arquiteturas:string[], interpretador:(string|null)}|null}
 */
function lerCabecalho(caminho) {
  let buf;
  try {
    const fd = fs.openSync(caminho, 'r');
    try {
      const tmp = Buffer.alloc(8192);
      const n = fs.readSync(fd, tmp, 0, 8192, 0);
      buf = tmp.subarray(0, n);
    } finally { fs.closeSync(fd); }
  } catch { return null; }

  const vazio = { formato: 'desconhecido', so: null, arquiteturas: [], interpretador: null };
  const script = { formato: 'script', so: null, arquiteturas: [], interpretador: null };
  if (buf.length < 4) return vazio;

  // Shim de script do npm (.cmd/.bat/.ps1): é TEXTO, não tem cabeçalho de
  // programa nenhum — e é uma instalação perfeitamente válida no Windows, que
  // o `invocacaoDe` já sabe executar. Sem esta linha, todo cliente Windows com
  // `codex.cmd` no PATH receberia "isto não parece um programa". Falso alarme
  // é o defeito que mata a confiança no verificador.
  if (SHIM_DE_SCRIPT.has(path.extname(caminho).toLowerCase())) return script;

  // `#!` — script com shebang. É a cara do CLI instalado por `npm -g` (um .js
  // com `#!/usr/bin/env node` em cima) e roda em QUALQUER arquitetura. Marcar
  // isso como defeito seria o falso alarme mais fácil de cometer aqui.
  if (buf[0] === 0x23 && buf[1] === 0x21) return script;

  const magic = buf.readUInt32BE(0);

  // ── Mach-O (macOS) ──
  // Assinatura 0xfeedface/0xfeedfacf; gravada ao contrário quando o arquivo é
  // little-endian, que é o caso de todo Mac atual. O tipo de CPU vem logo
  // depois, com a mesma ordem de bytes do magic.
  if (magic === 0xfeedface || magic === 0xfeedfacf) {
    return { formato: 'mach-o', so: 'darwin', interpretador: null,
             arquiteturas: [CPU_MACHO[buf.readUInt32BE(4)]].filter(Boolean) };
  }
  if (magic === 0xcefaedfe || magic === 0xcffaedfe) {
    return { formato: 'mach-o', so: 'darwin', interpretador: null,
             arquiteturas: [CPU_MACHO[buf.readUInt32LE(4)]].filter(Boolean) };
  }
  // Binário "universal": vários programas num arquivo só (Intel + Apple
  // Silicon). Precisa ser tratado, senão um universal legítimo seria acusado
  // de arquitetura errada. O cabeçalho fat é sempre big-endian.
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const n = buf.readUInt32BE(4);
    // Um .class de Java também começa com 0xcafebabe; lá esse campo é a versão
    // (número grande). Acima de 16 arquiteturas não é Mach-O gordo, é outra coisa.
    if (n >= 1 && n <= 16) {
      const passo = magic === 0xcafebabe ? 20 : 32;
      const arqs = [];
      for (let i = 0; i < n; i++) {
        const p = 8 + i * passo;
        if (p + 4 > buf.length) break;
        const a = CPU_MACHO[buf.readUInt32BE(p)];
        if (a && !arqs.includes(a)) arqs.push(a);
      }
      if (arqs.length) return { formato: 'mach-o', so: 'darwin', arquiteturas: arqs, interpretador: null };
    }
    return vazio;
  }

  // ── ELF (Linux) ──  \x7fELF, classe (32/64) em [4], ordem de bytes em [5].
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46 && buf.length >= 20) {
    const le = buf[5] !== 2;
    const maq = le ? buf.readUInt16LE(18) : buf.readUInt16BE(18);
    return { formato: 'elf', so: 'linux', arquiteturas: [MAQ_ELF[maq]].filter(Boolean),
             // Só lemos o carregador do ELF de 64 bits: os deslocamentos do de
             // 32 bits são outros e essa máquina nem tem CLI publicado.
             interpretador: (buf[4] === 2 && buf.length >= 64) ? interpretadorElf(buf, le) : null };
  }

  // ── PE (Windows) ──  'MZ', ponteiro para 'PE\0\0' em 0x3c, máquina em +4.
  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    if (buf.length >= 0x40) {
      const off = buf.readUInt32LE(0x3c);
      if (off > 0 && off + 6 <= buf.length && buf.readUInt32LE(off) === 0x00004550) {
        return { formato: 'pe', so: 'win32', interpretador: null,
                 arquiteturas: [MAQ_PE[buf.readUInt16LE(off + 4)]].filter(Boolean) };
      }
    }
    return { formato: 'pe', so: 'win32', arquiteturas: [], interpretador: null };
  }

  return vazio;
}

// Caminho do binário do pacote da plataforma SEM exigir que ele execute.
// Existe só para o diagnóstico e é o que separa "não instalado" de "instalado
// e bloqueado": `binarioEmbarcado` filtra por `ehExecutavel`, então um arquivo
// sem +x ou em quarentena SOME do resultado — e um diagnóstico ingênuo diria
// "não está instalado" para quem tem o arquivo ali, mandando reinstalar 250 MB
// à toa e sem resolver nada.
function binarioEmbarcadoBruto(id, { plataforma = process.platform, arch = process.arch, raiz = __dirname } = {}) {
  if (!MOTORES[id] || !MOTORES[id].embarcado) return null;
  const exe = plataforma === 'win32' ? 'claude.exe' : 'claude';
  for (const sufixo of sufixosDePlataforma(plataforma, arch)) {
    const pacote = `@anthropic-ai/claude-agent-sdk-${sufixo}`;
    const candidatos = [path.join(raiz, 'node_modules', pacote, exe)];
    try {
      const pj = require.resolve(`${pacote}/package.json`, { paths: [raiz] });
      candidatos.unshift(path.join(path.dirname(pj), exe));
    } catch { /* pacote ausente: fica só o caminho direto */ }
    for (const c of candidatos) {
      try { if (fs.statSync(c).isFile()) return c; } catch { /* tenta o próximo */ }
    }
  }
  return null;
}

// Quais pacotes de plataforma da SDK existem nesta pasta — material de apoio
// para o caso "copiei o node_modules do outro computador": lá vai estar o
// darwin-arm64 e aqui não vai ter o linux-x64.
function pacotesDePlataformaPresentes(raiz = __dirname) {
  const escopo = path.join('node_modules', '@anthropic-ai');
  const dirs = new Set([path.join(raiz, escopo)]);
  try {
    // Cobre hoisting/instalação aninhada: acha o escopo pela SDK principal.
    const r = require.resolve('@anthropic-ai/claude-agent-sdk', { paths: [raiz] });
    const i = r.lastIndexOf(escopo);
    if (i > 0) dirs.add(r.slice(0, i + escopo.length));
  } catch { /* sem SDK: fica o caminho fixo */ }

  const achados = [];
  for (const d of dirs) {
    let itens = [];
    try { itens = fs.readdirSync(d); } catch { continue; }
    for (const it of itens) {
      const m = /^claude-agent-sdk-(.+)$/.exec(it);
      if (m) achados.push(m[1]);
    }
  }
  return [...new Set(achados)].sort();
}

// O macOS marca com o atributo estendido `com.apple.quarantine` tudo que chega
// por download, zip ou AirDrop, e o Gatekeeper barra a execução até alguém
// liberar — o arquivo "existe e não roda", sem nenhuma pista no conteúdo dele.
// O Node não expõe atributo estendido em API nenhuma (não há fs.getxattr no
// Node 22, conferido nesta máquina), então aqui é comando mesmo. É ramo
// exclusivo de macOS: caminho absoluto do xattr, argumentos em vetor, sem
// shell. Qualquer falha vira "não sei" — e "não sei" nunca vira acusação.
function temQuarentena(caminho) {
  if (process.platform !== 'darwin') return false;
  try {
    const r = spawnSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', caminho],
                        { encoding: 'utf8', timeout: 5000 });
    return !r.error && r.status === 0;
  } catch { return false; }
}

// "darwin-arm64" vira "Mac com processador ARM (Apple Silicon)". Quem lê o
// diagnóstico não é técnico; o código curto fica entre parênteses para o
// suporte poder conferir.
function rotuloDePlataforma(so, arch) {
  const sos  = { darwin: 'Mac', linux: 'Linux', win32: 'Windows' };
  const arqs = { arm64: 'processador ARM (Apple Silicon / ARM64)', x64: 'processador Intel ou AMD (64 bits)',
                 arm: 'processador ARM de 32 bits', x86: 'processador Intel de 32 bits' };
  const nomeSo = sos[so] || so || 'sistema desconhecido';
  const nomeArq = arqs[arch] || arch || 'processador desconhecido';
  return `${nomeSo} com ${nomeArq} (${so || '?'}-${arch || '?'})`;
}

function entreAspas(s) { return `"${s}"`; }

/**
 * Por que o CLI deste motor não sobe NESTA máquina — e o que fazer.
 *
 * Síncrona de propósito: quem mais precisa dela é o motor, no instante em que
 * a query falhou, e um `await` ali significaria a mensagem certa chegar depois
 * da errada. Nunca executa o CLI — é justamente o que não funciona.
 *
 * O QUE ELA CHEGA A CRIAR DE PROCESSO (importa porque é síncrona, e processo
 * síncrono trava o event loop do servidor inteiro enquanto dura):
 *   • `/usr/bin/xattr` no macOS, de milissegundos, e só depois que arquitetura
 *     e permissão já foram descartadas;
 *   • `which`/`where` — SÓ quando se chama SEM `caminho`, porque aí ela precisa
 *     resolver o binário sozinha e o terceiro degrau do `resolverBinario` é o
 *     PATH. Esse comando tem timeout de 5 s, e numa instalação sem CLI é
 *     exatamente ele que demora. Por isso quem chama no meio de uma falha (o
 *     motor) deve SEMPRE passar `caminho`: o binário que ele tentou subir já
 *     está na mão dele, e assim não se paga essa espera com o servidor parado.
 *
 * @param {string} [id] - 'claude' ou 'codex'.
 * @param {object} [opcoes] - Uso normal: nenhuma.
 *   `caminho`  examina este arquivo em vez do que o NASCERA resolveria (é o que
 *              o motor passa: o binário que ele acabou de tentar subir, e é o
 *              modo que não cria processo de busca no PATH);
 *   `origem`   rótulo de origem de `caminho` (só para o relatório);
 *   injeção para teste: `plataforma`, `arch`, `raiz`, `resolver`, `lerQuarentena`.
 * @returns {{ok:boolean, causa:string, certeza:string, titulo:string,
 *            explicacao:string, solucao:string, comando:(string|null),
 *            resumo:string, motor:string, caminho:(string|null),
 *            origem:(string|null), esperado:string, encontrado:(string|null),
 *            detalhes:object}}
 *   `causa` ∈ ok | motor-desconhecido | ausente | arquitetura | incompleto |
 *            libc | permissao | quarentena | formato
 *   `certeza` ∈ 'certa' (isto IMPEDE a execução, medido) | 'provavel' (isto
 *            explica a falha, mas não dá para provar sem executar). Uma tela de
 *            status deve tratar 'provavel' como aviso, não como erro vermelho.
 */
function diagnosticarBinario(id = 'claude', opcoes = {}) {
  const plataforma    = opcoes.plataforma || process.platform;
  const arch          = opcoes.arch || process.arch;
  const raiz          = opcoes.raiz || __dirname;
  const resolver      = opcoes.resolver || resolverBinario;
  const lerQuarentena = opcoes.lerQuarentena || temQuarentena;
  const esperado      = `${plataforma}-${arch}`;
  const motor         = MOTORES[id];

  // Como consertar depende do motor: o Claude vem embarcado (reinstalar as
  // dependências do NASCERA traz o binário certo), o Codex é um npm global.
  const comandoDeInstalacao = motor && motor.embarcado
    ? 'npm install --omit=dev'
    : `npm install -g ${motor ? motor.pacote : ''}`.trim();

  const detalhes = {};
  const responder = (causa, texto, extra = {}) => {
    const r = {
      ok: causa === 'ok',
      causa,
      certeza: extra.certeza || 'certa',
      titulo: texto.titulo,
      explicacao: texto.explicacao,
      solucao: texto.solucao,
      comando: texto.comando || null,
      resumo: '',
      motor: id,
      caminho: extra.caminho || null,
      origem: extra.origem || null,
      esperado,
      encontrado: extra.encontrado || null,
      detalhes: { ...detalhes, ...(extra.detalhes || {}) },
    };
    // Uma string pronta para quem só quer mostrar UMA linha (o motor, no lugar
    // onde hoje aparece o texto da SDK falando de libc num Mac).
    r.resumo = `${r.titulo}. ${r.explicacao} ${r.solucao}` + (r.comando ? ` Comando: ${r.comando}` : '');
    return r;
  };

  if (!motor) {
    return responder('motor-desconhecido', {
      titulo: 'Motor desconhecido',
      explicacao: `O NASCERA não conhece nenhum motor chamado "${id}".`,
      solucao: 'Use "claude" ou "codex".',
    });
  }

  // ── 1. Qual arquivo examinar ────────────────────────────────────────
  let caminho = opcoes.caminho || null;
  let origem  = opcoes.caminho ? (opcoes.origem || 'informado') : null;
  if (!caminho) {
    const r = resolver(id) || {};
    caminho = r.caminho || null;
    origem  = r.origem || null;
  }
  // `resolverBinario` só devolve binário que PASSA em `ehExecutavel`. Sem este
  // segundo olhar, um arquivo sem +x ou em quarentena sairia daqui como
  // "não instalado" — o diagnóstico errado que manda reinstalar sem motivo.
  if (!caminho) {
    const cru = binarioEmbarcadoBruto(id, { plataforma, arch, raiz });
    if (cru) { caminho = cru; origem = 'embarcado'; }
  }

  // ── 2. Não há arquivo nenhum: o node_modules ainda tem o que dizer ──
  if (!caminho) {
    const presentes = pacotesDePlataformaPresentes(raiz);
    const meus      = sufixosDePlataforma(plataforma, arch);
    const deOutra   = presentes.filter((p) => !meus.includes(p));
    detalhes.pacotesPresentes = presentes;
    detalhes.pacoteEsperado   = meus.length ? `@anthropic-ai/claude-agent-sdk-${meus[0]}` : null;

    if (motor.embarcado && deOutra.length) {
      // ESTE é o caso do node_modules copiado entre computadores.
      return responder('arquitetura', {
        titulo: 'As dependências deste NASCERA vieram de outro computador',
        explicacao: `O programa do motor que está aqui foi feito para ${deOutra.join(', ')}, e ` +
          `este computador é ${rotuloDePlataforma(plataforma, arch)}. Programa compilado só roda na ` +
          'máquina para a qual foi feito — por isso copiar a pasta node_modules de um computador para ' +
          'outro nunca funciona: os arquivos vão junto, mas eles não são executáveis aqui.',
        solucao: 'Reinstale as dependências NESTA máquina; o npm baixa a versão feita para este computador.',
        comando: comandoDeInstalacao,
      }, { encontrado: deOutra.join(', ') });
    }
    if (!meus.length) {
      return responder('ausente', {
        titulo: 'Este sistema não tem CLI publicado',
        explicacao: `A Anthropic não publica o programa do motor para ${rotuloDePlataforma(plataforma, arch)}, ` +
          'então não há o que instalar automaticamente aqui.',
        solucao: 'Instale o CLI à mão e aponte o NASCERA para ele na variável CLAUDE_CMD.',
      }, { detalhes: { semPacotePublicado: true } });
    }
    return responder('ausente', {
      titulo: 'O programa do motor não está instalado',
      explicacao: 'Não existe nenhum arquivo do CLI nesta instalação: nem o que vem junto com o NASCERA, ' +
        'nem um instalado no sistema. Sem ele o chat não tem como funcionar.',
      solucao: 'Instale as dependências do NASCERA nesta pasta.',
      comando: comandoDeInstalacao,
    });
  }

  // ── 3. O arquivo está lá? Está inteiro? ─────────────────────────────
  let st = null;
  try { st = fs.statSync(caminho); } catch { /* sumiu no meio do caminho */ }
  if (!st || !st.isFile()) {
    return responder('ausente', {
      titulo: 'O programa do motor não está onde deveria',
      explicacao: `O NASCERA esperava encontrar o CLI em ${caminho}, e ali não há arquivo nenhum.`,
      solucao: 'Instale as dependências do NASCERA nesta pasta.',
      comando: comandoDeInstalacao,
    }, { caminho, origem });
  }
  detalhes.tamanho = st.size;
  if (st.size === 0) {
    return responder('incompleto', {
      titulo: 'O arquivo do motor está vazio',
      explicacao: 'O arquivo existe, mas não tem conteúdo — é o que sobra quando o download da instalação ' +
        'foi interrompido no meio (queda de internet, disco cheio).',
      solucao: 'Baixe as dependências de novo.',
      comando: comandoDeInstalacao,
    }, { caminho, origem });
  }

  // ── 4. O cabeçalho: este programa é DESTA máquina? ──────────────────
  const cab = lerCabecalho(caminho);
  if (cab) {
    detalhes.formato = cab.formato;
    detalhes.arquiteturas = cab.arquiteturas;
    if (cab.interpretador) detalhes.interpretador = cab.interpretador;
  }
  const achado = cab && cab.so && cab.arquiteturas.length
    ? `${cab.so}-${cab.arquiteturas.join('/')}`
    : (cab && cab.so ? cab.so : null);

  const formatoDeOutroSo = cab && cab.so && cab.so !== plataforma;
  const arqDeOutraMaquina = cab && cab.arquiteturas.length && !cab.arquiteturas.includes(arch);
  if (formatoDeOutroSo || arqDeOutraMaquina) {
    return responder('arquitetura', {
      titulo: 'O programa do motor é de outro computador',
      explicacao: `O arquivo que está aqui foi feito para ${rotuloDePlataforma(cab.so, cab.arquiteturas[0] || null)}, ` +
        `e este computador é ${rotuloDePlataforma(plataforma, arch)}. Programa compilado só roda na máquina ` +
        'para a qual foi feito — por isso copiar a pasta node_modules de um computador para outro nunca ' +
        'funciona: o arquivo vai junto, mas ele não é executável aqui.',
      solucao: 'Reinstale as dependências NESTA máquina; o npm baixa a versão feita para este computador.',
      comando: comandoDeInstalacao,
    }, { caminho, origem, encontrado: achado });
  }

  // ── 5. Linux: o carregador que o programa exige existe aqui? ────────
  // O ÚNICO ponto em que falar de libc/musl é verdade. Só acusamos com o
  // caminho em mãos e depois de conferir no disco que ele não existe.
  if (plataforma === 'linux' && cab && cab.formato === 'elf' && cab.interpretador) {
    let existe = false;
    try { existe = fs.existsSync(cab.interpretador); } catch { existe = true; /* na dúvida, calar */ }
    if (!existe) {
      const musl = /musl/i.test(cab.interpretador);
      return responder('libc', {
        titulo: 'O programa do motor pede uma peça do sistema que não existe aqui',
        explicacao: `Este executável precisa do carregador ${cab.interpretador}, e esse arquivo não existe ` +
          `neste Linux. É a diferença entre as distribuições comuns (Ubuntu, Debian: glibc) e o Alpine ` +
          `(musl): são bibliotecas de sistema diferentes, e o programa de uma não roda na outra. Aqui está ` +
          `instalado o pacote ${musl ? 'de musl (Alpine)' : 'de glibc'}, que é o do outro tipo de Linux.`,
        solucao: 'Reinstale as dependências NESTA máquina; o npm escolhe o pacote do tipo certo de Linux.',
        comando: comandoDeInstalacao,
      }, { caminho, origem, encontrado: achado });
    }
  }

  // ── 6. Permissão de execução ────────────────────────────────────────
  // Vem depois da arquitetura de propósito: reinstalar resolve os dois, e
  // mandar dar chmod num binário de outra máquina só faria perder tempo.
  if (plataforma !== 'win32') {
    let executavel = true;
    try { fs.accessSync(caminho, fs.constants.X_OK); } catch { executavel = false; }
    if (!executavel) {
      return responder('permissao', {
        titulo: 'O arquivo do motor perdeu a permissão de execução',
        explicacao: 'O programa está aqui e é o certo para este computador, mas o sistema não tem permissão ' +
          'para executá-lo. Isso acontece quando a pasta viaja por pendrive, por zip ou por compartilhamento ' +
          'de rede: esses formatos não guardam a marca de "isto é um programa".',
        solucao: 'Devolva a permissão de execução ao arquivo.',
        comando: `chmod +x ${entreAspas(caminho)}`,
      }, { caminho, origem, encontrado: achado });
    }
  }

  // ── 7. Quarentena do macOS ──────────────────────────────────────────
  if (plataforma === 'darwin' && lerQuarentena(caminho)) {
    return responder('quarentena', {
      titulo: 'O macOS bloqueou o programa do motor por ele ter vindo de fora',
      explicacao: 'Este Mac marcou o arquivo como "baixado da internet" (quarentena). Tudo que chega por ' +
        'download, por zip ou por AirDrop recebe essa marca, e o sistema impede que rode até alguém liberar. ' +
        'O arquivo está inteiro e é o certo para este computador — o bloqueio é do Mac, não do arquivo.',
      solucao: 'Tire a marca de quarentena (é seguro: este programa veio junto com o NASCERA). ' +
        'Se o motor voltar a funcionar, era isto.',
      comando: `xattr -d com.apple.quarantine ${entreAspas(caminho)}`,
    }, { caminho, origem, encontrado: achado,
         // Quarentena impede a execução de programa não assinado; com o
         // programa assinado o Mac pode deixar passar. Como não dá para provar
         // sem executar, dizemos "provável" em vez de inventar certeza.
         certeza: 'provavel' });
  }

  // ── 8. Formato irreconhecível ───────────────────────────────────────
  if (cab && cab.formato === 'desconhecido') {
    return responder('formato', {
      titulo: 'O arquivo do motor não parece um programa',
      explicacao: 'O arquivo existe e pode ser executado, mas não tem a cara de nenhum programa que este ' +
        'sistema saiba rodar. Costuma ser download interrompido, arquivo trocado ou conteúdo corrompido.',
      solucao: 'Baixe as dependências de novo.',
      comando: comandoDeInstalacao,
    }, { caminho, origem, certeza: 'provavel' });
  }

  // ── 9. Nada impede a execução ───────────────────────────────────────
  // Sem "quase ok", sem aviso decorativo: verificador que grita à toa deixa de
  // ser lido, e aí não serve para nada no dia em que houver problema de verdade.
  return responder('ok', {
    titulo: 'O programa do motor está pronto para rodar',
    explicacao: `O arquivo está no lugar, é o programa certo para ${rotuloDePlataforma(plataforma, arch)}, ` +
      'tem permissão de execução e não está bloqueado pelo sistema.',
    solucao: 'Nada a fazer.',
  }, { caminho, origem, encontrado: achado });
}

// Retrato para suporte: responde "de onde veio o motor e ele bate com a SDK?"
// sem precisar pedir print de terminal para o cliente.
async function diagnostico(id = 'claude') {
  const est = await estadoDe(id);
  const sdk = versaoDaSdk();
  const emb = binarioEmbarcado(id);
  const glob = binarioGlobalSync(MOTORES[id] ? MOTORES[id].binario : id);
  return {
    motor: id,
    // Aditivo: o modal de diagnóstico do painel usa isto para não ter que
    // adivinhar o título do card por um ternário hardcoded (ver ia.js).
    nome: MOTORES[id] ? MOTORES[id].nome : id,
    versaoSdk: sdk,
    plataforma: `${process.platform}-${process.arch}${ehMusl() ? '-musl' : ''}`,
    embarcado: emb || null,
    global: glob || null,
    emUso: est ? est.caminho : null,
    origem: est ? est.origem : null,
    versaoEmUso: est ? est.versao : null,
    conectado: est ? est.conectado : false,
    // Por que a prova de login falhou (quando falhou por execução, não por
    // falta de login). É o que responde "instalado, logado, e mesmo assim não
    // conecta" sem pedir print de terminal ao cliente.
    erroDaProva: est ? (est.provaErro || null) : null,
    // Por que o binário não sobe (chave nova, aditiva: nada do que já era
    // mostrado mudou). Passamos o caminho que o estado já resolveu para não
    // repetir a busca no PATH.
    binario: diagnosticarBinario(id, est && est.caminho ? { caminho: est.caminho, origem: est.origem } : {}),
  };
}

// Instala o CLI do motor. Devolve o que aconteceu em vez de lançar: a tela
// de configuração precisa mostrar o erro, não cair.
async function instalar(id) {
  const m = MOTORES[id];
  if (!m) return { ok: false, erro: 'Motor desconhecido' };

  // Claude: nunca instalar global. O certo é restaurar o embarcado, que é o
  // que casa com esta versão do NASCERA — instalar -g recriaria o descompasso.
  if (m.embarcado) {
    const g = await garantirMotor(id, { reparar: true });
    const depois = await estadoDe(id);
    return g.ok ? { ok: true, estado: depois } : { ok: false, erro: g.erro || 'falha ao restaurar o CLI' };
  }

  const r = await rodar('npm', ['install', '-g', m.pacote], 300000);
  if (!r.ok) return { ok: false, erro: (r.erro || 'falha no npm').slice(-400) };
  const depois = await estadoDe(id);
  return { ok: !!depois.instalado, estado: depois };
}

function ehValido(id) { return !!MOTORES[id]; }

module.exports = {
  MOTORES, estado, estadoDe, instalar, ehValido,
  // resolução de binário (fonte única da verdade para o server)
  binarioSync, resolverBinario, binarioEmbarcado, garantirMotor, diagnostico, versaoDaSdk,
  // POR QUE o binário resolvido não sobe nesta máquina, e o comando que
  // resolve. Síncrona, não executa o CLI — serve tanto para o motor mostrar no
  // lugar do texto genérico da SDK quanto para o painel de diagnóstico.
  diagnosticarBinario,
  // invocação neutra de comando: fonte única para quem precisa chamar `npm` ou
  // um CLI que no Windows é shim de script (usado também pelo atualizacao.js).
  invocacaoDe, invocacaoParaPty,
  // Config de provedores do OpenCode (ex.: DeepSeek) — leitura compartilhada
  // entre o diagnóstico daqui e a rota admin que grava o provedor.
  caminhosConfigOpenCode, lerConfigOpenCode, deepseekConfigurado,
};
