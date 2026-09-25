#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// NASCERA — o instalador de verdade (um só, para macOS, Linux e Windows)
//
//   node scripts/instalar.js [--sim] [--json]
//
//     --sim   não pergunta nada. É como os scripts de cada sistema
//             (install.sh / install.ps1) chamam: eles já conversaram com a
//             pessoa, e uma pergunta aqui travaria a instalação num prompt
//             que ninguém está olhando.
//     --json  o relatório completo sai em JSON. Com esta flag a prosa vai
//             para a saída de ERRO e o stdout fica com UMA linha só, o JSON —
//             assim quem chamou pode ler `stdout` inteiro sem filtrar nada
//             (e essa linha é, trivialmente, a última).
//
//   Códigos de saída (contrato com os scripts de cada sistema):
//     0  instalado e pronto
//     2  parou por um motivo JÁ EXPLICADO na tela (pasta suja que exige uma
//        decisão do dono — apagar dado de alguém não é decisão de script)
//     1  falha inesperada
//
// ─── por que este arquivo existe ───────────────────────────────────────
// O dono desistiu do instalador .dmg/.exe e passou a distribuir o código. Os
// scripts de cada sistema fazem SÓ o mínimo indispensável: garantir que exista
// um Node que atenda o `engines` do package.json — é a única coisa que precisa
// acontecer ANTES de haver Node. Todo o resto é aqui, em UM lugar, testado.
// Escrever a mesma regra em bash e em PowerShell é garantir que as duas
// divirjam, e a que mente é sempre a que ninguém está olhando.
//
// ─── a premissa: a pasta vem SUJA ──────────────────────────────────────
// O cliente não baixa uma pasta limpa: ele recebe uma CÓPIA de outra máquina.
// Isto não é hipótese, é o relato escrito de quem instalou o NASCERA no segundo
// Mac do dono:
//   • o `node_modules` copiado tinha o binário do motor de OUTRA arquitetura,
//     e o chat morria sem dizer por quê;
//   • o `.env` apontava para um PostgreSQL local que não existe na máquina
//     nova (e com NASCERA_DB_STATE=pg isso não degrada: o servidor MORRE no
//     boot — server.js:2701-2704 dá process.exit(1));
//   • o `users.json` era da máquina do desenvolvedor, então o primeiro acesso
//     se recusava a rodar e o sistema estava "trancado com a chave de outra
//     pessoa".
// Cada uma dessas três tem um bloco aqui embaixo, com o nome do arquivo real.
//
// ─── o que este script NUNCA faz ───────────────────────────────────────
// Apagar dado de gente. `users.json`, `projects.json`, `.env`: ele detecta,
// explica e — quando a pessoa manda — chama quem tem essa responsabilidade
// (`scripts/limpar.js`, que mostra tudo e pede a própria confirmação). O `.env`
// nunca é sobrescrito sem uma cópia intacta ficar no disco: ele pode conter o
// JWT_SECRET de uma instalação real, e apagar isso é derrubar a sessão de
// todo mundo que estava logado.
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const net = require('net');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const RAIZ_PADRAO = path.join(__dirname, '..');

// ═══════════════════════════════════════════════════════════════════════
// PEÇAS PURAS — sem disco, sem rede, sem processo. São elas que o teste prova.
// ═══════════════════════════════════════════════════════════════════════

// ─── semver do tamanho da necessidade ──────────────────────────────────
// Não dá para `require('semver')`: este script roda ANTES do npm install,
// numa pasta que pode não ter node_modules nenhum. Um instalador que depende
// de instalar para poder decidir se instala não é instalador.
//
// Cobre o que o `engines` do projeto usa hoje (`^22.22.2 || ^24.15.0 ||
// >=26.0.0`) e os operadores vizinhos. Quando NÃO souber interpretar a faixa,
// devolve `null` — "não sei" — em vez de chutar. Chutar aqui significa barrar
// um Node bom, ou aprovar um ruim e o cliente descobrir no primeiro crash.
function partesDeVersao(v) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v || '').trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
}

function compararVersao(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

// Um comparador só: '>=22.0.0', '^24.15.0', '~1.2.3', '22', '*'.
function satisfazComparador(versao, cru) {
  const txt = String(cru || '').trim();
  if (!txt || txt === '*' || txt === 'x' || txt === 'X') return true;
  const m = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?/.exec(txt);
  if (!m) return null;                       // faixa exótica: não fingir que entendi
  const op = m[1] || '=';
  const temMenor = m[3] !== undefined && !/[xX*]/.test(m[3]);
  const alvo = partesDeVersao(`${m[2]}.${temMenor ? m[3] : 0}.${m[4] && !/[xX*]/.test(m[4]) ? m[4] : 0}`);
  if (!alvo || /[xX*]/.test(m[2])) return true;
  const cmp = compararVersao(versao, alvo);
  if (op === '=')  return cmp === 0;
  if (op === '>')  return cmp > 0;
  if (op === '>=') return cmp >= 0;
  if (op === '<')  return cmp < 0;
  if (op === '<=') return cmp <= 0;
  if (op === '^') {
    // Compatível com o mesmo "dígito significativo à esquerda". Para o Node,
    // que nunca publica major 0, é sempre o major.
    if (cmp < 0) return false;
    return versao[0] === alvo[0];
  }
  if (op === '~') {
    if (cmp < 0) return false;
    return versao[0] === alvo[0] && (!temMenor || versao[1] === alvo[1]);
  }
  return null;
}

/**
 * A versão atende à faixa do `engines`?
 * @returns {boolean|null} `null` quando a faixa não pôde ser interpretada.
 */
function satisfazFaixa(versaoTexto, faixa) {
  const versao = partesDeVersao(versaoTexto);
  if (!versao) return null;
  const txt = String(faixa || '').trim();
  if (!txt) return true;                     // sem exigência declarada: passa
  let indefinido = false;
  for (const alternativa of txt.split('||')) {
    const partes = alternativa.trim().split(/\s+/).filter(Boolean);
    if (!partes.length) continue;
    let todas = true;
    for (const p of partes) {
      const r = satisfazComparador(versao, p);
      if (r === null) { indefinido = true; todas = false; break; }
      if (!r) { todas = false; break; }
    }
    if (todas) return true;                  // um "OU" satisfeito basta
  }
  return indefinido ? null : false;
}

// ─── .env sem dotenv (mesmo motivo: roda antes do npm install) ──────────
// Só o que interessa: chave → valor, aspas removidas, comentário ignorado.
// Não expande variável nem interpreta multilinha — e não precisa: quem lê
// isto de verdade é o dotenv, em runtime. Aqui é diagnóstico.
function lerEnv(texto) {
  const out = {};
  for (const linha of String(texto || '').split(/\r?\n/)) {
    const t = linha.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const chave = t.slice(0, i).trim().replace(/^export\s+/, '');
    let valor = t.slice(i + 1).trim();
    if ((valor.startsWith('"') && valor.endsWith('"')) ||
        (valor.startsWith("'") && valor.endsWith("'"))) valor = valor.slice(1, -1);
    out[chave] = valor;
  }
  return out;
}

// Comenta as linhas indicadas, preservando TODO o resto byte a byte. É o
// oposto de reescrever o arquivo: um `.env` real tem segredo que não se
// reconstrói (JWT_SECRET, chave de imagem), e regravá-lo "limpo" seria
// destruir sessão e credencial de quem estava usando.
function comentarChaves(texto, chaves, motivo) {
  const alvo = new Set(chaves);
  const linhas = String(texto || '').split(/\r?\n/);
  let mexidas = 0;
  const saida = linhas.map((linha) => {
    const t = linha.trim();
    if (!t || t.startsWith('#')) return linha;
    const i = t.indexOf('=');
    if (i <= 0) return linha;
    const chave = t.slice(0, i).trim().replace(/^export\s+/, '');
    if (!alvo.has(chave)) return linha;
    mexidas++;
    return '# ' + linha + (motivo ? '   # ' + motivo : '');
  });
  return { texto: saida.join('\n'), mexidas };
}

/**
 * Onde a DATABASE_URL manda conectar. Devolve `null` quando não é um endereço
 * de rede (socket unix, formato exótico): sem host e porta não há o que sondar,
 * e acusar "banco morto" sem ter batido na porta seria mentira.
 */
function analisarUrlPostgres(url) {
  const txt = String(url || '').trim();
  if (!txt) return null;
  let u;
  try { u = new URL(txt); } catch { return null; }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return null;
  if (!u.hostname) return null;
  return { host: u.hostname, porta: Number(u.port || 5432) };
}

// ─── pacotes que são de UMA máquina só ─────────────────────────────────
// Convenção de npm para binário nativo: um pacote opcional por plataforma,
// terminado em `-<so>-<arch>`. O motor de IA usa (`@anthropic-ai/
// claude-agent-sdk-darwin-arm64`) e o `sharp` também (`@img/sharp-linux-x64`,
// que é o motor de imagem do produto).
//
// Quem responde pelo CLI do motor é o `motores.diagnosticarBinario()` — é dele
// a palavra final, e é ele que o resto do produto usa. Esta varredura existe
// para o SEGUNDO caso: o `sharp` de outra arquitetura não aparece no
// diagnóstico do motor, e sem ele a geração de imagem quebra no primeiro uso.
//
// A regra é conservadora de propósito: só acusa quando existe pacote de OUTRA
// plataforma e NENHUM desta. Um `node_modules` que carrega os dois (npm com
// `--force`, cache de CI) está estranho, mas roda — e verificador que grita à
// toa deixa de ser lido.
function pacotesDePlataforma(raiz, plataforma = process.platform, arch = process.arch) {
  const base = path.join(raiz, 'node_modules');
  const sufixo = /-((?:darwin|linux|win32|freebsd))-((?:x64|arm64|arm|ia32))(?:-(musl|gnu))?$/;
  const familias = new Map();                // família → { meus:[], outros:[] }

  const registrar = (nome) => {
    const m = sufixo.exec(nome);
    if (!m) return;
    const familia = nome.slice(0, m.index);
    if (!familias.has(familia)) familias.set(familia, { meus: [], outros: [] });
    const alvo = (m[1] === plataforma && m[2] === arch) ? 'meus' : 'outros';
    familias.get(familia)[alvo].push(nome);
  };

  let itens = [];
  try { itens = fs.readdirSync(base); } catch { return { conflitos: [], familias: [] }; }
  for (const it of itens) {
    if (it.startsWith('@')) {
      let filhos = [];
      try { filhos = fs.readdirSync(path.join(base, it)); } catch { continue; }
      for (const f of filhos) registrar(it + '/' + f);
    } else {
      registrar(it);
    }
  }

  const conflitos = [];
  for (const [familia, { meus, outros }] of familias) {
    if (outros.length && !meus.length) conflitos.push({ familia, outros: outros.sort() });
  }
  return { conflitos: conflitos.sort((a, b) => a.familia.localeCompare(b.familia)),
           familias: [...familias.keys()].sort() };
}

/**
 * Em que porta o painel vai atender. MESMA precedência do servidor
 * (`server.js:40` → `process.env.PORT || 3333`), com o `.env` no meio porque é
 * dele que o pm2 carrega o ambiente. Isto não é preciosismo: um número chutado
 * na mensagem final manda o cliente para uma página de erro no primeiro
 * minuto de uso.
 */
function portaDoPainel(raiz, ambiente = process.env) {
  const doAmbiente = String((ambiente && ambiente.PORT) || '').trim();
  if (/^\d+$/.test(doAmbiente)) return Number(doAmbiente);
  try {
    const env = lerEnv(fs.readFileSync(path.join(raiz, '.env'), 'utf8'));
    if (/^\d+$/.test(String(env.PORT || '').trim())) return Number(env.PORT);
  } catch { /* sem .env: instalação nova, cai no padrão */ }
  return 3333;                               // server.js:40 e ecosystem.config.js:59
}

// ═══════════════════════════════════════════════════════════════════════
// EFEITOS — disco, rede e processos. Tudo injetável, para o teste não
// precisar de internet nem esperar um npm install de verdade.
// ═══════════════════════════════════════════════════════════════════════

// Bate na porta do banco. `connect` só, sem handshake de protocolo: a pergunta
// é "existe alguém escutando aqui?", não "este Postgres aceita minha senha".
function sondarTcpReal(host, porta, ms = 1500) {
  return new Promise((resolve) => {
    let pronto = false;
    const fim = (r) => { if (!pronto) { pronto = true; try { s.destroy(); } catch {} resolve(r); } };
    const s = net.connect({ host, port: porta });
    s.setTimeout(ms);
    s.on('connect', () => fim(true));
    s.on('timeout', () => fim(false));
    s.on('error',   () => fim(false));
  });
}

function temComandoReal(comando) {
  try {
    const r = spawnSync(comando, ['--version'], { encoding: 'utf8', timeout: 10000,
                                                  shell: process.platform === 'win32' });
    return !r.error && r.status === 0;
  } catch { return false; }
}

// Como chamar o npm sem depender do PATH nem do shell.
//
// No Windows o `npm` é `npm.cmd`, um script: o Node não o encontra (a busca de
// PATH só tenta .com/.exe) e, desde o 18.20/20.12 (BatBadBut), recusa executar
// .cmd sem shell. A casa já resolveu isso uma vez, em `motores.invocacaoDe` —
// mas `motores.js` pode não carregar numa pasta sem dependências, e este
// script existe justamente para o momento em que não há dependências. Por isso
// o plano B: chamar o `npm-cli.js` que veio junto com o próprio Node, pelo
// caminho absoluto, com o Node em execução. Não passa por PATH nem por shell.
function invocacaoDoNpm(plataforma = process.platform, execPath = process.execPath) {
  try {
    const motores = require('../motores.js');
    if (motores && typeof motores.invocacaoDe === 'function') {
      const inv = motores.invocacaoDe('npm', ['install', '--omit=dev', '--no-audit', '--no-fund']);
      if (inv && inv.arquivo) return inv;
    }
  } catch { /* sem motores.js (ou sem deps): plano B abaixo */ }

  const dir = path.dirname(execPath);
  const candidatos = plataforma === 'win32'
    ? [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    : [path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
       path.join(dir, '..', 'libexec', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  for (const c of candidatos) {
    if (fs.existsSync(c)) {
      return { arquivo: execPath, args: [c, 'install', '--omit=dev', '--no-audit', '--no-fund'], shell: false };
    }
  }
  // Último recurso: o npm do PATH. Em Unix funciona; no Windows precisa do
  // shell, e aqui é seguro porque NENHUM argumento vem de fora — são estas
  // quatro constantes.
  return { arquivo: plataforma === 'win32' ? 'npm.cmd' : 'npm',
           args: ['install', '--omit=dev', '--no-audit', '--no-fund'],
           shell: plataforma === 'win32' };
}

/**
 * Roda o `npm install --omit=dev` mostrando a saída ao vivo.
 *
 * Ao vivo porque é o passo demorado (minutos, e o Chromium do puppeteer sozinho
 * são centenas de MB): tela parada parece travamento, e cliente que acha que
 * travou mata o processo no meio — que é como nasce um `node_modules` pela
 * metade.
 *
 * A saída é ENCANADA em vez de herdada por um motivo: sem ler o que o npm
 * falou, "queda de rede" e "pacote inexistente" viram o mesmo `status: 1`, e a
 * mensagem final não teria como dizer qual dos dois foi. O texto continua
 * aparecendo em tempo real; só passa por aqui no caminho.
 */
function rodarNpmInstallReal(raiz, escrever) {
  return new Promise((resolve) => {
    const inv = invocacaoDoNpm();
    let cauda = '';
    const p = spawn(inv.arquivo, inv.args, {
      cwd: raiz, shell: !!inv.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    const capturar = (buf) => {
      const s = buf.toString();
      escrever(s);
      cauda = (cauda + s).slice(-8000);     // só o fim interessa para classificar
    };
    p.stdout.on('data', capturar);
    p.stderr.on('data', capturar);
    p.on('error', (e) => resolve({ ok: false, codigo: -1, saida: String(e && e.message || e) }));
    p.on('close', (codigo) => resolve({ ok: codigo === 0, codigo, saida: cauda }));
  });
}

// A internet caiu no meio? A diferença importa: rede é "tente de novo", e
// qualquer outra coisa é "me mande esta saída". Os códigos são os que o npm
// repassa do próprio Node/registro.
function pareceFalhaDeRede(saida) {
  return /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ERR_SOCKET_TIMEOUT|network|proxy|registry\.npmjs\.org|socket hang up|getaddrinfo/i
    .test(String(saida || ''));
}

// Pergunta de sim/não. Sem TTY (rodando por script, por CI, por serviço) NÃO
// espera: devolve o padrão. Instalador que fica pendurado num prompt invisível
// é indistinguível de instalador travado.
function perguntarReal(texto, padrao = false) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve(padrao);
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(texto + (padrao ? ' [S/n] ' : ' [s/N] '), (r) => {
      rl.close();
      const t = String(r || '').trim().toLowerCase();
      if (!t) return resolve(padrao);
      resolve(t === 's' || t === 'sim' || t === 'y' || t === 'yes');
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════
// O INSTALADOR
// ═══════════════════════════════════════════════════════════════════════

const NIVEL_ORDEM = { bloqueio: 0, aviso: 1, info: 2, ok: 3 };

/**
 * Instala e confere o NASCERA nesta máquina.
 *
 * @param {object} [op] - Tudo opcional. O que não vier é o comportamento real;
 *   o teste injeta o que precisar para não tocar em rede nem em npm.
 * @param {string}  [op.raiz]        - Pasta do NASCERA (padrão: a de cima deste script).
 * @param {boolean} [op.sim]         - Não perguntar nada.
 * @param {string}  [op.plataforma]  - process.platform simulado.
 * @param {string}  [op.arch]        - process.arch simulado.
 * @param {string}  [op.versaoNode]  - process.version simulado.
 * @param {object}  [op.ambiente]    - process.env simulado.
 * @param {(msg:string)=>void}   [op.escrever]  - para onde vai a prosa.
 * @param {(h:string,p:number)=>Promise<boolean>} [op.sondarTcp]
 * @param {(raiz:string,esc:Function)=>Promise<{ok:boolean,codigo:number,saida:string}>} [op.rodarNpm]
 * @param {(id:string,o:object)=>object} [op.diagnosticarBinario]
 * @param {(cmd:string)=>boolean} [op.temComando]
 * @param {(txt:string,padrao:boolean)=>Promise<boolean>} [op.perguntar]
 * @param {(args:string[])=>Promise<number>} [op.rodarLimpar] - chama o scripts/limpar.js.
 * @param {()=>number} [op.agora]
 * @returns {Promise<object>} relatório: { ok, codigo, achados, acoes, proximosPassos, ... }
 */
async function instalar(op = {}) {
  const raiz        = op.raiz || RAIZ_PADRAO;
  const sim         = !!op.sim;
  const plataforma  = op.plataforma || process.platform;
  const arch        = op.arch || process.arch;
  const versaoNode  = op.versaoNode || process.version;
  const ambiente    = op.ambiente || process.env;
  const escrever    = op.escrever || ((s) => process.stderr.write(s));
  const sondarTcp   = op.sondarTcp || sondarTcpReal;
  const rodarNpm    = op.rodarNpm || rodarNpmInstallReal;
  const temComando  = op.temComando || temComandoReal;
  const perguntar   = op.perguntar || (sim ? (async (_t, p) => p) : perguntarReal);
  const agora       = op.agora || Date.now;
  const diagnosticar = op.diagnosticarBinario || carregarDiagnostico();

  const achados = [];
  const acoes   = [];
  const linha   = (s = '') => escrever(s + '\n');
  const anotar  = (a) => { achados.push(a); return a; };

  const caminho = (...p) => path.join(raiz, ...p);
  const existe  = (...p) => { try { return fs.existsSync(caminho(...p)); } catch { return false; } };
  const lerJson = (nome) => {
    try { return JSON.parse(fs.readFileSync(caminho(nome), 'utf8')); } catch { return null; }
  };

  linha('');
  linha('═══ NASCERA — instalação ═══');
  linha(`    Máquina: ${plataforma}-${arch} · Node ${versaoNode}`);
  linha(`    Pasta:   ${raiz}`);
  linha('');

  // ───────────────────────────────────────────────────────────────────
  // 1. O Node em execução atende o `engines`?
  //
  // Os scripts de cada sistema já deveriam ter garantido isto — mas nada
  // impede alguém de rodar `node scripts/instalar.js` direto, com o Node 18
  // velho que estava no PATH. Deixar passar aqui é empurrar a falha para o
  // primeiro `??=` que o servidor executar, com uma mensagem de sintaxe que
  // não ajuda ninguém.
  // ───────────────────────────────────────────────────────────────────
  const pkg = lerJson('package.json');
  if (!pkg) {
    anotar({ id: 'sem-package', nivel: 'bloqueio',
      titulo: 'Esta pasta não parece o NASCERA',
      explicacao: `Não achei um package.json legível em ${raiz}.`,
      solucao: 'Rode o instalador de dentro da pasta do NASCERA.' });
    return fechar();
  }
  const faixa = (pkg.engines && pkg.engines.node) || '';
  const atende = satisfazFaixa(versaoNode, faixa);
  if (atende === false) {
    anotar({ id: 'node-velho', nivel: 'bloqueio',
      titulo: 'O Node em execução não serve para este NASCERA',
      explicacao: `Este NASCERA exige Node ${faixa} e está rodando no ${versaoNode}. ` +
        'Versão de menos não é detalhe: o código usa recursos que o Node antigo nem consegue LER, ' +
        'e a falha aparece como erro de sintaxe em um arquivo qualquer.',
      solucao: plataforma === 'win32'
        ? 'Feche este terminal e rode o install.ps1, que instala o Node certo.'
        : 'Feche este terminal e rode o ./install.sh, que instala o Node certo.',
      comando: null });
    return fechar();
  }
  if (atende === null) {
    anotar({ id: 'node-indeterminado', nivel: 'aviso',
      titulo: 'Não consegui conferir a exigência de Node',
      explicacao: `O package.json pede "${faixa}", que este verificador não sabe interpretar. ` +
        `Sigo com o Node ${versaoNode} — mas se algo falhar de forma estranha, comece por aqui.`,
      solucao: 'Confira à mão se a versão em execução está dentro da faixa.' });
  } else {
    anotar({ id: 'node-ok', nivel: 'ok', titulo: `Node ${versaoNode} atende ao exigido (${faixa})` });
  }
  linha(atende === false ? '' : `  ✓ Node ${versaoNode} atende ao exigido (${faixa || 'sem exigência declarada'})`);

  // ───────────────────────────────────────────────────────────────────
  // 2. PASTA SUJA — parte A: `node_modules` de outra máquina
  //
  // O caso que matou o chat do dono. O pacote do CLI embarcado
  // (`@anthropic-ai/claude-agent-sdk-<plataforma>`) era de um Mac Apple
  // Silicon rodando em OUTRA máquina; o arquivo estava lá, com tamanho e
  // permissão certos, e simplesmente não executava.
  //
  // Quem dá o veredito sobre o motor é `motores.diagnosticarBinario()` — não
  // reimplemento a regra dele aqui. A varredura própria (`pacotesDePlataforma`)
  // cobre o resto do node_modules, `sharp` inclusive.
  //
  // A ação é reinstalar, e ela NÃO precisa de permissão: `node_modules` não é
  // dado de ninguém, é derivado do package.json e se refaz sozinho. Apagar a
  // pasta antes é obrigatório — o npm reaproveita o que já está lá, e o pacote
  // da arquitetura errada sobreviveria a um install por cima.
  // ───────────────────────────────────────────────────────────────────
  let precisaReinstalar = false;
  const temNodeModules = existe('node_modules');

  const conflitos = pacotesDePlataforma(raiz, plataforma, arch).conflitos;
  const diagAntes = temNodeModules ? diagnosticar('claude', { raiz, plataforma, arch }) : null;
  const motorDeOutraMaquina = !!(diagAntes && diagAntes.causa === 'arquitetura');

  if (motorDeOutraMaquina || conflitos.length) {
    precisaReinstalar = true;
    const quais = conflitos.map(c => c.outros.join(', ')).join('; ');
    anotar({ id: 'node-modules-de-outra-maquina', nivel: 'info',
      titulo: 'As dependências desta pasta vieram de outro computador',
      explicacao: (motorDeOutraMaquina ? (diagAntes.explicacao + ' ') : '') +
        (conflitos.length ? `Também encontrei pacotes compilados para outra máquina: ${quais}. ` : '') +
        'Programa compilado só roda na máquina para a qual foi feito.',
      solucao: 'Vou apagar o node_modules e reinstalar tudo nesta máquina — nada de seu é perdido: ' +
        'essa pasta é gerada a partir do package.json.',
      comando: 'npm install --omit=dev',
      detalhes: { motor: motorDeOutraMaquina ? diagAntes.encontrado || null : null, conflitos } });
    linha('  ⚠ node_modules veio de outro computador — vou refazê-lo nesta máquina.');
  }

  // ───────────────────────────────────────────────────────────────────
  // 3. PASTA SUJA — parte B: o `.env` de outra máquina
  //
  // O relato real: "o .env dentro da pasta veio de outra máquina (aponta para
  // um PostgreSQL local que não existe aqui)". A consequência não é degradação
  // silenciosa — é morte no boot: com `NASCERA_DB_STATE=pg`, `estado-db.iniciar`
  // lança, e o server.js:2701-2704 responde com `[FATAL]` e `process.exit(1)`.
  // O cliente veria o processo subir e morrer, para sempre, sem uma tela.
  //
  // Sem `NASCERA_DB_STATE=pg` o servidor SOBE (db.js:25 só liga o pool quando há
  // DATABASE_URL, e o estado continua em JSON), mas o que fala com o banco
  // direto — billing com NASCERA_DB_BILLING — degrada. Aviso, não bloqueio.
  //
  // O que este script NÃO faz: apagar o `.env`. Ele pode conter o JWT_SECRET
  // de uma instalação real (server.js:48), e apagá-lo derruba a sessão de
  // todo mundo. A única coisa que ele oferece é DESLIGAR as linhas do banco —
  // com o arquivo inteiro copiado antes para `.env.bak-<epoch>`, a mesma
  // convenção que o `scripts/limpar.js` já conhece.
  // ───────────────────────────────────────────────────────────────────
  const envPath = caminho('.env');
  let envTexto = null;
  try { envTexto = fs.readFileSync(envPath, 'utf8'); } catch { /* instalação nova */ }

  if (envTexto) {
    const env = lerEnv(envTexto);
    const alvo = analisarUrlPostgres(env.DATABASE_URL);
    const arbitro = String(env.NASCERA_DB_STATE || '').trim() === 'pg';

    if (alvo) {
      const vivo = await sondarTcp(alvo.host, alvo.porta);
      if (!vivo) {
        const CHAVES_DE_BANCO = ['DATABASE_URL', 'NASCERA_BACKUP_DATABASE_URL', 'NASCERA_DB_STATE', 'NASCERA_DB_BILLING'];
        const consequencia = arbitro
          ? 'Com NASCERA_DB_STATE=pg o servidor NÃO SOBE: ele tenta o banco no boot, não consegue, ' +
            'imprime [FATAL] e encerra. Você veria o processo morrer sem nenhuma tela abrir.'
          : 'O servidor sobe (o estado continua em arquivo), mas tudo que fala com o banco direto — ' +
            'crédito e cobrança — vai falhar quando for usado.';

        let resolvido = false;
        if (!sim) {
          linha('');
          linha('  ⚠ O .env desta pasta aponta para um banco que não responde nesta máquina:');
          linha(`      DATABASE_URL → ${alvo.host}:${alvo.porta}  (ninguém atende)`);
          linha('    ' + consequencia);
          linha('');
          const ok = await perguntar(
            '    Posso DESLIGAR só as linhas de banco do .env? (o arquivo inteiro fica\n' +
            '    guardado em .env.bak-<data>, e nada mais é alterado)', false);
          if (ok) {
            const marca = Math.floor(agora() / 1000);
            const backup = caminho('.env.bak-' + marca);
            fs.copyFileSync(envPath, backup);
            const r = comentarChaves(envTexto, CHAVES_DE_BANCO,
              'desligado pelo instalador: banco de outra máquina não respondia');
            fs.writeFileSync(envPath, r.texto);
            envTexto = r.texto;
            resolvido = true;
            acoes.push({ id: 'env-banco-desligado', linhas: r.mexidas, backup: path.basename(backup) });
            anotar({ id: 'env-de-outra-maquina', nivel: 'info',
              titulo: 'O .env apontava para um banco de outra máquina — linhas de banco desligadas',
              explicacao: `${r.mexidas} linha(s) foram comentadas. O arquivo original está inteiro em ` +
                `${path.basename(backup)} — nenhum segredo foi perdido.`,
              solucao: 'Para voltar a usar Postgres, descomente as linhas e aponte a DATABASE_URL para um banco desta máquina.' });
            linha(`  ✓ .env ajustado (${r.mexidas} linha(s)). Cópia intacta em ${path.basename(backup)}`);
          }
        }

        if (!resolvido) {
          anotar({ id: 'env-de-outra-maquina', nivel: arbitro ? 'bloqueio' : 'aviso',
            titulo: 'O .env desta pasta veio de outra máquina',
            explicacao: `A DATABASE_URL manda conectar em ${alvo.host}:${alvo.porta}, e não há ninguém ` +
              `escutando nesse endereço aqui. ${consequencia}`,
            solucao: 'Rode `node scripts/instalar.js` sem --sim e responda "s" quando ele oferecer desligar ' +
              'as linhas de banco (o .env inteiro é copiado antes). À mão: comente DATABASE_URL, ' +
              'NASCERA_DB_STATE, NASCERA_BACKUP_DATABASE_URL e NASCERA_DB_BILLING no .env — e NÃO apague o ' +
              'arquivo, ele guarda o JWT_SECRET das sessões.',
            comando: 'node scripts/instalar.js',
            detalhes: { host: alvo.host, porta: alvo.porta, arbitro } });
          linha(`  ${arbitro ? '✖' : '⚠'} .env aponta para um banco que não responde (${alvo.host}:${alvo.porta}).`);
        }
      }
    }

    // Caminho gravado no .env que não existe nesta máquina é o mesmo sintoma
    // por outra porta: configuração da máquina antiga viajando na cópia.
    for (const chave of ['PROJECTS_BASE', 'CLAUDE_CMD', 'NASCERA_CAMINHO_BACKUP']) {
      const v = String(env[chave] || '').trim();
      if (!v) continue;
      const pai = path.dirname(v);
      let paiExiste = false;
      try { paiExiste = fs.existsSync(pai); } catch { /* sem permissão: não acusar */ paiExiste = true; }
      if (!paiExiste) {
        anotar({ id: 'env-caminho-fantasma-' + chave, nivel: 'aviso',
          titulo: `${chave} no .env aponta para uma pasta que não existe aqui`,
          explicacao: `O .env manda usar "${v}", e nem a pasta que a conteria (${pai}) existe nesta máquina — ` +
            'é caminho da máquina de onde esta cópia veio.',
          solucao: `Corrija ou apague a linha ${chave} do .env.` });
        linha(`  ⚠ .env: ${chave} aponta para ${v}, que não existe aqui.`);
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // 4. PASTA SUJA — parte C: dados de OUTRA instalação
  //
  // "o users.json que veio na pasta era da máquina do desenvolvedor... o
  // sistema estava trancado com a chave de outra pessoa." Com admin no
  // `users.json`, `POST /api/setup/create-account` responde 400 "Conta admin já
  // existe" (rotas/setup.js:149) e o primeiro acesso não roda.
  //
  // Isto é AVISO, não bloqueio — e a diferença é deliberada: desde a
  // `POST /api/setup/assumir-instalacao` (rotas/setup.js:222) existe saída pelo
  // PRODUTO. Quem tem a máquina lê o código no terminal, assume a instalação, e
  // as contas antigas são SUSPENSAS (não apagadas). O sistema está instalado e
  // é utilizável; mentir "não dá para entrar" seria tão ruim quanto o silêncio
  // de antes.
  //
  // E aqui não se apaga nada. Zerar a cópia é decisão do dono, tem consequência
  // irreversível, e já tem responsável: `scripts/limpar.js`, que lista tudo e
  // pede a própria confirmação. Dependência OPCIONAL: se o arquivo não existir,
  // explico o caminho pelo produto e sigo — a ausência dele nunca falha nada.
  // ───────────────────────────────────────────────────────────────────
  const usuarios = lerJson('users.json');
  if (usuarios && typeof usuarios === 'object') {
    const nomes = Object.keys(usuarios);
    const admins = nomes.filter(n => usuarios[n] && usuarios[n].role === 'admin');
    if (admins.length) {
      // Sinal forte de "veio de outra máquina": a pasta de dados da conta não
      // existe neste disco. Sinal, não prova — conta antiga pode não ter
      // `dataDir` gravado —, e é assim que ele é apresentado.
      const orfas = nomes.filter((n) => {
        const d = usuarios[n] && usuarios[n].dataDir;
        if (!d) return false;
        try { return !fs.existsSync(d); } catch { return false; }
      });
      const projetos = lerJson('projects.json');
      const projetosSemPasta = Array.isArray(projetos)
        ? projetos.filter(p => p && p.path && !fs.existsSync(p.path)).length : 0;

      anotar({ id: 'dados-de-outra-instalacao', nivel: 'aviso',
        titulo: 'Esta pasta já tem contas de outra instalação',
        explicacao: `Encontrei ${nomes.length} conta(s) (${admins.length} de administrador) no users.json` +
          (orfas.length ? `, e ${orfas.length} dela(s) aponta(m) para pastas de dados que não existem nesta máquina` : '') +
          (projetosSemPasta ? `, além de ${projetosSemPasta} projeto(s) cujo diretório não existe aqui` : '') +
          '. A tela de primeiro acesso NÃO vai aparecer: para o sistema, esta instalação já tem dono. ' +
          'As senhas dessas contas são irrecuperáveis (scrypt), então não adianta tentar adivinhar.',
        solucao: 'Na tela de login use "não consigo entrar em nenhuma destas contas": o servidor imprime um ' +
          'código no terminal, você digita, cria a SUA conta de administrador e as contas antigas ficam ' +
          'SUSPENSAS (não apagadas, e os projetos delas continuam no disco).' +
          (existe('scripts', 'limpar.js')
            ? ' Se preferir começar do zero, `node scripts/limpar.js` mostra tudo que apagaria antes de apagar.'
            : ''),
        detalhes: { contas: nomes.length, admins: admins.length, orfas: orfas.length, projetosSemPasta } });

      linha('');
      linha(`  ⚠ Esta pasta já tem ${nomes.length} conta(s) de outra instalação` +
            (orfas.length ? ` (${orfas.length} com pasta de dados inexistente aqui)` : '') + '.');
      linha('    Nada será apagado por mim. Você tem duas saídas, e as duas estão no fim deste relatório.');

      // Oferta — só com pessoa na frente, e mesmo assim quem apaga é o
      // limpar.js, com a confirmação DELE. Nunca passo --sim adiante: seria
      // usar o "não me pergunte" que eu recebi para calar a pergunta dele.
      if (!sim && existe('scripts', 'limpar.js')) {
        const quer = await perguntar(
          '    Quer zerar esta cópia agora? Vou chamar o scripts/limpar.js, que\n' +
          '    LISTA tudo que apagaria e pede a confirmação dele', false);
        if (quer) {
          const rodarLimpar = op.rodarLimpar || rodarLimparReal;
          const codigo = await rodarLimpar(raiz, ['--apagar']);
          acoes.push({ id: 'limpar-chamado', codigo });
          linha(codigo === 0 ? '  ✓ limpeza concluída.' : `  ⚠ o limpar.js saiu com código ${codigo}.`);
        }
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // 5. As dependências
  //
  // Idempotência: se tudo já está no lugar e o motor executa, não há nada a
  // fazer — e rodar `npm install` "por garantia" custa minutos e uma chance a
  // mais de quebrar o que estava funcionando.
  // ───────────────────────────────────────────────────────────────────
  const faltando = dependenciasFaltando(raiz, pkg);
  const precisaInstalar = precisaReinstalar || !temNodeModules || faltando.length > 0 ||
                          !(diagAntes && diagAntes.ok);

  if (!precisaInstalar) {
    anotar({ id: 'dependencias-ok', nivel: 'ok',
      titulo: 'Dependências já instaladas e íntegras nesta máquina' });
    linha('  ✓ Dependências já estão instaladas e conferidas — nada a baixar.');
  } else {
    if (precisaReinstalar && temNodeModules) {
      linha('  → apagando node_modules (é gerado, não é dado seu)...');
      try {
        fs.rmSync(caminho('node_modules'), { recursive: true, force: true });
        acoes.push({ id: 'node-modules-apagado' });
      } catch (e) {
        anotar({ id: 'node-modules-preso', nivel: 'bloqueio',
          titulo: 'Não consegui apagar o node_modules',
          explicacao: 'A pasta tem dependências de outro computador e precisa ser refeita, mas o sistema ' +
            `não deixou apagá-la: ${e.message}. No Windows isso é quase sempre um NASCERA ainda rodando, ` +
            'ou o antivírus com um arquivo aberto.',
          solucao: 'Feche o NASCERA (e o editor), apague a pasta node_modules à mão e rode o instalador de novo.' });
        return fechar();
      }
    }

    linha('');
    linha('  → instalando dependências (npm install --omit=dev).');
    linha('    Isso demora — são centenas de MB, e o navegador de captura vem junto.');
    linha('    A saída do npm aparece abaixo; enquanto houver texto, está trabalhando.');
    linha('');

    const r = await rodarNpm(raiz, escrever);
    if (!r.ok) {
      const rede = pareceFalhaDeRede(r.saida);
      anotar({ id: rede ? 'npm-rede' : 'npm-falhou', nivel: 'bloqueio',
        titulo: rede ? 'A instalação parou por falta de internet' : 'O npm install falhou',
        explicacao: rede
          ? 'O npm não conseguiu falar com o registro de pacotes. Ou a conexão caiu no meio, ou há um ' +
            'proxy/firewall entre esta máquina e a internet. O que já baixou continua no disco — rodar de ' +
            'novo continua de onde parou, não recomeça.'
          : `O npm saiu com código ${r.codigo}. As últimas linhas dele estão acima.`,
        solucao: rede
          ? 'Confira a internet e rode o instalador de novo. Atrás de proxy corporativo, configure ' +
            '`npm config set proxy` e `npm config set https-proxy` antes.'
          : 'Mande as últimas linhas da saída acima para o suporte.',
        comando: 'node scripts/instalar.js',
        detalhes: { codigo: r.codigo, rede } });
      return fechar();
    }
    acoes.push({ id: 'npm-install', codigo: 0 });
    anotar({ id: 'dependencias-instaladas', nivel: 'ok', titulo: 'Dependências instaladas' });
    linha('');
    linha('  ✓ dependências instaladas.');
  }

  // ───────────────────────────────────────────────────────────────────
  // 6. Ficou pronto DE VERDADE?
  //
  // "o npm saiu com zero" não é prova de nada: foi exatamente assim que o
  // node_modules de outra arquitetura chegou até o chat do dono. A prova é o
  // diagnóstico do binário — o mesmo que o motor usa em produção.
  // ───────────────────────────────────────────────────────────────────
  const faltandoDepois = dependenciasFaltando(raiz, pkg);
  if (faltandoDepois.length) {
    anotar({ id: 'dependencias-incompletas', nivel: 'bloqueio',
      titulo: 'Faltam dependências mesmo depois da instalação',
      explicacao: `Estes pacotes declarados no package.json não estão no node_modules: ${faltandoDepois.join(', ')}.`,
      solucao: 'Rode o instalador de novo; se persistir, mande esta lista para o suporte.',
      comando: 'npm install --omit=dev' });
    linha(`  ✖ faltam pacotes: ${faltandoDepois.join(', ')}`);
  }

  const diagDepois = diagnosticar('claude', { raiz, plataforma, arch });
  if (diagDepois && diagDepois.ok) {
    anotar({ id: 'motor-ok', nivel: 'ok', titulo: 'O motor de IA está pronto para rodar nesta máquina' });
    linha('  ✓ motor de IA: pronto para rodar nesta máquina.');
  } else if (diagDepois) {
    // `certeza: 'provavel'` é aviso, não erro: o diagnóstico foi honesto ao
    // dizer que não consegue provar sem executar, e tratar suspeita como
    // certeza é o começo do verificador que grita à toa.
    const grave = diagDepois.certeza !== 'provavel';
    anotar({ id: 'motor-nao-roda', nivel: grave ? 'bloqueio' : 'aviso',
      titulo: diagDepois.titulo, explicacao: diagDepois.explicacao,
      solucao: diagDepois.solucao, comando: diagDepois.comando || null,
      detalhes: { causa: diagDepois.causa, certeza: diagDepois.certeza } });
    linha(`  ${grave ? '✖' : '⚠'} motor de IA: ${diagDepois.titulo}.`);
    if (diagDepois.comando) linha(`      → ${diagDepois.comando}`);
  }

  // ─── git ───────────────────────────────────────────────────────────
  // VEREDITO: opcional, com aviso forte. Não é chute — é o que o código faz.
  //
  // `server.js:496` embrulha o git num try/catch que devolve `null` em QUALQUER
  // falha, inclusive "comando não existe". Então, sem git instalado:
  //   • criar projeto, conversar, construir, pré-visualizar e publicar
  //     continuam funcionando — o `git init` do scaffold.js:256 falha calado;
  //   • o histórico de versões fica sempre vazio e `getNextVersion` responde 1
  //     para sempre (servicos/git-commit.js:59), então toda publicação vira
  //     "v1" por cima da anterior;
  //   • e o pior: `/api/projects/:id/revert` (rotas/projetos-versao.js:357)
  //     roda os três gits, todos devolvem null, e a rota responde
  //     `{ ok: true, message: 'Revertido para …' }` sem ter revertido NADA.
  //     Uma tela dizendo "restaurado" sobre um arquivo intocado é pior do que
  //     um erro. Por isso o aviso é forte — mas bloquear a instalação inteira
  //     por causa dele seria impedir o cliente de usar o produto que ele
  //     comprou por causa de um recurso que ele talvez nem abra.
  const gitOk = temComando('git');
  if (!gitOk) {
    anotar({ id: 'sem-git', nivel: 'aviso',
      titulo: 'O git não está instalado nesta máquina',
      explicacao: 'O NASCERA funciona sem ele: criar projeto, conversar, construir e publicar não dependem ' +
        'de git. Mas o histórico de versões de cada projeto É git — sem ele o histórico fica vazio, ' +
        'toda publicação vira "v1", e o botão de restaurar uma versão anterior responde "restaurado" ' +
        'sem restaurar coisa nenhuma.',
      solucao: plataforma === 'darwin'
        ? 'Instale com: xcode-select --install (ou pelo Homebrew: brew install git).'
        : plataforma === 'win32'
          ? 'Instale o Git for Windows: https://git-scm.com/download/win'
          : 'Instale pelo gerenciador da sua distribuição (apt install git / dnf install git).' });
    linha('  ⚠ git não encontrado — histórico de versões e "restaurar versão" não vão funcionar.');
  } else {
    anotar({ id: 'git-ok', nivel: 'ok', titulo: 'git disponível (histórico de versões funciona)' });
  }

  return fechar();

  // ─── fim: monta o relatório e a mensagem final ─────────────────────
  function fechar() {
    achados.sort((a, b) => NIVEL_ORDEM[a.nivel] - NIVEL_ORDEM[b.nivel]);
    const bloqueios = achados.filter(a => a.nivel === 'bloqueio');
    const avisos    = achados.filter(a => a.nivel === 'aviso');
    const codigo    = bloqueios.length ? 2 : 0;

    const porta = portaDoPainel(raiz, ambiente);
    const temPm2 = codigo === 0 ? temComando('pm2') : false;
    const comando = temPm2 ? 'pm2 start ecosystem.config.js && pm2 save' : 'npm start';
    // 127.0.0.1 e não "SEU-IP": o servidor amarra em 127.0.0.1 por padrão
    // (S1), então o endereço que funciona na máquina do cliente é este.
    const endereco = `http://localhost:${porta}`;
    const inherit = achados.some(a => a.id === 'dados-de-outra-instalacao');

    const proximosPassos = {
      porta, endereco, comando,
      // A verdade sobre a conta, que o install.sh já conta e que este script
      // não pode contradizer: NÃO existe senha padrão. A conta nasce na
      // primeira tela, com o código que o SERVIDOR imprime ao subir — nunca
      // por e-mail, nunca por HTTP (server.js:2756).
      contaInicial: inherit
        ? 'assumir-instalacao'                 // já existe admin herdado nesta pasta
        : 'primeiro-acesso',
      senhaPadrao: false,
    };

    linha('');
    if (codigo === 0) {
      linha('═══ pronto ═══');
      linha('');
      linha(`    1) Suba o NASCERA:   ${comando}`);
      if (!temPm2) {
        linha('       (`npm start` roda enquanto este terminal estiver aberto. Para o NASCERA');
        linha('        subir sozinho ao ligar a máquina, instale o pm2: npm i -g pm2)');
      }
      linha(`    2) Abra no navegador:  ${endereco}`);
      if (inherit) {
        linha('    3) A tela vai pedir LOGIN, e não criar conta: esta pasta já tem contas de');
        linha('       outra instalação. Clique em "não consigo entrar em nenhuma destas contas".');
        linha('       O servidor imprime um CÓDIGO no terminal; com ele você cria a SUA conta de');
        linha('       administrador, e as contas antigas ficam suspensas (não apagadas).');
      } else {
        linha('    3) A tela pede um CÓDIGO DE INSTALAÇÃO, e com ele VOCÊ cria a conta de');
        linha('       administrador (usuário e senha escolhidos por você).');
      }
      linha('');
      linha('       O código não aparece aqui e não vem por e-mail: quem o imprime é o');
      linha('       servidor ao subir, no terminal. Se estiver com pm2:  pm2 logs nascera --lines 40');
      linha('');
      linha('    NÃO existe senha padrão. Se alguém te entregou uma, ela não vale.');
    } else {
      linha('═══ parei aqui ═══');
      linha('');
      for (const b of bloqueios) {
        linha(`    ✖ ${b.titulo}`);
        linha(`      ${b.explicacao}`);
        linha(`      → ${b.solucao}`);
        if (b.comando) linha(`      → ${b.comando}`);
        linha('');
      }
      linha('    Nada foi apagado. Resolva o item acima e rode o instalador de novo:');
      linha('    ele continua de onde parou.');
    }
    if (avisos.length) {
      linha('');
      linha('    Avisos (não impedem de usar):');
      for (const a of avisos) linha(`      ⚠ ${a.titulo}`);
    }
    linha('');

    return {
      ok: codigo === 0,
      codigo,
      plataforma: `${plataforma}-${arch}`,
      node: versaoNode,
      raiz,
      achados,
      acoes,
      bloqueios: bloqueios.map(b => b.id),
      avisos: avisos.map(a => a.id),
      proximosPassos,
    };
  }
}

// ─── auxiliares que tocam o disco ──────────────────────────────────────

// Carrega o diagnóstico do motor sem deixar a falta de dependências derrubar o
// instalador: `motores.js` só depende de módulos nativos hoje, mas ele NÃO é
// meu, pode ganhar um `require` de pacote amanhã, e este script roda
// exatamente no minuto em que não há node_modules. Quando não carregar, o
// substituto diz "não sei" em vez de fingir um veredito.
function carregarDiagnostico() {
  try {
    const motores = require('../motores.js');
    if (motores && typeof motores.diagnosticarBinario === 'function') return motores.diagnosticarBinario;
  } catch { /* sem motores.js: substituto abaixo */ }
  return () => ({
    ok: false, causa: 'indeterminado', certeza: 'provavel',
    titulo: 'Não consegui conferir o motor de IA',
    explicacao: 'O módulo que sabe examinar o programa do motor (motores.js) não pôde ser carregado nesta pasta.',
    solucao: 'Confira se a pasta do NASCERA veio inteira.',
    comando: null,
  });
}

// Pacote declarado que não está no node_modules. Só o primeiro nível: é o que
// pega instalação interrompida e cópia parcial, sem o custo de auditar a árvore
// inteira (o `npm ls` faria isso, e leva segundos que ninguém tem paciência de
// esperar duas vezes).
function dependenciasFaltando(raiz, pkg) {
  const deps = Object.keys((pkg && pkg.dependencies) || {});
  const faltam = [];
  for (const nome of deps) {
    if (!fs.existsSync(path.join(raiz, 'node_modules', nome, 'package.json'))) faltam.push(nome);
  }
  return faltam;
}

// Chama o `scripts/limpar.js` SEM `--sim`: quem apaga tem que fazer a própria
// pergunta. Dependência opcional — se o arquivo não existir, nem chegamos aqui.
function rodarLimparReal(raiz, args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(raiz, 'scripts', 'limpar.js'), ...args],
                    { cwd: raiz, stdio: 'inherit' });
    p.on('error', () => resolve(1));
    p.on('close', (c) => resolve(c === null ? 1 : c));
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Linha de comando
// ═══════════════════════════════════════════════════════════════════════
async function principal(argv = process.argv) {
  const sim  = argv.includes('--sim');
  const json = argv.includes('--json');

  // Com --json o stdout é do relatório e de mais nada: quem chamou faz
  // `JSON.parse` da saída inteira sem precisar caçar a última linha. A prosa
  // (e o npm) vão para o stderr, onde a pessoa continua vendo tudo.
  const escrever = json ? (s) => process.stderr.write(s) : (s) => process.stdout.write(s);

  try {
    const r = await instalar({ sim, escrever });
    if (json) process.stdout.write(JSON.stringify(r) + '\n');
    return r.codigo;
  } catch (e) {
    // Código 1 é "falha INESPERADA" — tudo que eu soube explicar já saiu como 2.
    const msg = (e && e.stack) || String(e);
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, codigo: 1, erro: String(e && e.message || e) }) + '\n');
      process.stderr.write('\n[instalar] falha inesperada:\n' + msg + '\n');
    } else {
      process.stdout.write('\n[instalar] falha inesperada:\n' + msg + '\n');
    }
    return 1;
  }
}

if (require.main === module) {
  principal().then((c) => { process.exitCode = c; });
}

module.exports = {
  instalar, principal,
  // expostos para o teste provar as decisões isoladamente
  satisfazFaixa, satisfazComparador, lerEnv, comentarChaves, analisarUrlPostgres,
  pacotesDePlataforma, portaDoPainel, dependenciasFaltando, pareceFalhaDeRede,
  invocacaoDoNpm,
};
