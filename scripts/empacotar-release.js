#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// NASCERA — empacota uma versão para publicar em api.nascera.ai
//
//   node scripts/empacotar-release.js 1.3.0
//   node scripts/empacotar-release.js 1.3.0 --sem-temas    (pacote leve)
//   node scripts/empacotar-release.js 1.3.0 --auditar      (só audita, não gera nada)
//
// Gera nascera-<versão>.tar.gz com CÓDIGO apenas. Nada de users.json,
// projects.json, .env ou qualquer coisa que pertença a uma instalação —
// esse pacote vai rodar na máquina de outra pessoa.
//
// A lista branca INCLUIR protege a RAIZ muito bem: users.json e .env não
// entram porque não estão nela. O que ela NÃO protegia: diretório entra
// INTEIRO. Foi por esse buraco que 46 capturas de tela de projetos de
// CLIENTES (public/thumbnails/project_<nome-do-cliente>.png) viajaram dentro
// de um pacote "só de código" até outro Mac. Por isso agora há duas camadas:
//
//   1. EXCLUIR_PADROES — o que já se RASTREOU como gerado em tempo de
//      execução (cada linha cita a escrita correspondente no servidor);
//   2. auditarPacote() — a trava: abre o que está prestes a entrar e ABORTA
//      se achar arquivo com cara de instalação, inclusive dentro de um
//      diretório que ainda nem existia quando isto foi escrito.
//
// A lição das duas redes de segurança que já existiam aqui é que lista fixa
// envelhece. Então a trava não pergunta "este arquivo está na lista?", e sim
// "o servidor escreve aqui?", "o atualizador preserva isto?", "isto tem
// formato de registro/segredo?". Quando ela erra, erra ABORTANDO um release
// (barulhento, reversível) — nunca deixando dado de alguém passar.
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');

// O que VAI no pacote. Lista explícita: incluir por engano um arquivo de
// dados seria mandar o dado de um cliente para dentro da máquina de outro.
const INCLUIR = [
  'server.js', 'telemetry.js', 'atualizacao.js', 'billing.js', 'billing-db.js', 'domains.js',
  'theme.js', 'senhas.js', 'imagens.js', 'motores.js', 'memoria-projeto.js', 'modelos-locais.js',
  'caminhos-seguros.js', 'estado-seguro.js', 'estado-db.js', 'assinatura.js', 'segredos.js',
  'claude-auth.js', 'log.js', 'db.js', 'migrar.js', 'migracoes', 'repos',
  'site-router.js', 'preview-server.js', 'publish-server.js',
  'package.json', 'system-prompt.md', 'designsystem.md',
  // Instaladores e leia-me: é por AQUI que o cliente começa. Sem eles no
  // pacote, quem baixa recebe um monte de código e nenhuma porta de entrada.
  'install-vps.sh', 'install.sh', 'install.ps1', 'instalar.bat', 'iniciar.bat',
  'README.md', 'README-WINDOWS.md', 'CHANGELOG.md',
  // rotas/ e servicos/ nasceram na modularização do server.js: são 36 require()
  // do servidor. Sem eles o pacote morre no primeiro require, em qualquer SO.
  'rotas', 'servicos',
  'engine', 'tools', 'agents', 'templates', 'public', 'scripts',
];

// Arquivos .js da raiz que NÃO são código de produto (ou que são dados).
// Tudo que não estiver aqui nem em INCLUIR vira aviso alto — foi assim que o
// senhas.js quase saiu de fora de um release de segurança.
const NAO_E_CODIGO = new Set(['ecosystem.config.js', 'server.js.bak-engine-v1']);

// Dentro dos diretórios que o pacote leva, isto aqui é de instalação — não
// pode viajar. Cada linha foi achada RASTREANDO a escrita no código, não por
// intuição; a referência fica no comentário para a próxima pessoa conferir.
const EXCLUIR_PADROES = [
  'public/uploads',   // theme.js: UPLOADS_DIR — imagens que o dono subiu no painel
  'public/lp',        // landing page do cliente, servida de dentro de public/
  'node_modules', '.git', '.DS_Store', '._*',
  // Segredos e sobras da escrita atômica: um `.bak` carrega o mesmo conteúdo
  // do estado que ele protege, então vazaria dado de instalação no pacote.
  '.jwt-secret', '.chave-cofre', '.cofre.json', '.setup-token', '.credenciais.json', '.env', '*.bak',

  // ─── o vazamento das 46 miniaturas ─────────────────────────────────
  // server.js (POST /api/projects/:id/thumbnail) grava `project_<slug>.png`
  // em public/thumbnails, e servicos/preview-runtime.js grava a captura do
  // preview no mesmo lugar. O slug É o nome que o cliente deu ao projeto
  // dele: a pasta inteira é trabalho de terceiro com o nome na etiqueta.
  // Nada em public/thumbnails é código — a pasta só existe em runtime.
  'public/thumbnails',
  // Menos óbvio e igualmente grave: themes/thumbnails é do PRODUTO (o
  // catálogo de temas), mas rotas/tools.js e rotas/projetos-crud.js gravam
  // `project_<slug>.jpg` ali dentro também. Nesta máquina havia 10. Some só
  // a captura de projeto; as miniaturas de tema continuam viajando.
  'themes/thumbnails/project_*',
  // rotas/tools.js: EXTRACTIONS_BASE. Espelho de sites de terceiros que o
  // DONO extraiu — pesado, regenerável e material de outra pessoa (o
  // .gitignore já dizia isso; o pacote é que não sabia).
  'themes/_extracoes',
  // server.js: ensureThemesCatalog() reescreve isto a cada boot. É o índice
  // dos temas DAQUELA máquina; a instalação nova regenera o dela no boot.
  'themes/catalog.json',
  // Sobra do navegador da extração de UX (console-*.log dentro de um tema).
  // Achado pela própria trava desta rodada, não por memória de ninguém.
  '.playwright-mcp',

  // ─── extrator de UX: fica com o dono, não vai para o cliente ───────
  // Decisão comercial, não técnica: a ferramenta que aspira o layout de um
  // site e monta um Design System é diferencial de quem VENDE o NASCERA, não
  // parte do que o comprador recebe. Sair do pacote é seguro porque o produto
  // já se adapta: server.js monta rotas/tools.js só se o arquivo existir, e
  // public/home.html pergunta ao servidor e esconde o menu quando a rota
  // responde 404. Nada de flag de configuração nem de código em duas versões.
  //
  // tools/chrome.js NÃO entra nesta lista: ele é usado também pelas capturas
  // de tela do preview (servicos/preview-runtime.js) e é do produto.
  'tools/ux-extract.mjs',
  'tools/design-system-prompt.md',
  'rotas/tools.js',
];

// ─── isenções da TRAVA ────────────────────────────────────────────────
// Caminhos que o servidor escreve em runtime MAS que também são conteúdo do
// produto. Isentam apenas os sinais de "pasta gerada" — o que tiver cara de
// segredo ou de registro continua barrado mesmo aqui dentro.
const ESCRITO_MAS_DO_PRODUTO = [
  // 76 miniaturas do catálogo de temas viajam de propósito; o que é captura
  // de projeto já saiu no EXCLUIR_PADROES acima (themes/thumbnails/project_*).
  'themes/thumbnails',
];

// ─── vocabulário da TRAVA ─────────────────────────────────────────────
// Não são nomes de arquivo, são FORMATOS. Um arquivo novo com um destes
// formatos é pego sem ninguém precisar cadastrá-lo.
const EXTENSOES_DE_REGISTRO = new Set([
  '.jsonl',            // ledger append-only (usage-events, billing-outbox, emails)
  '.log', '.pid', '.tmp', '.zbak',
  '.sqlite', '.sqlite3', '.db',
]);
const EXTENSOES_DE_CREDENCIAL = new Set(['.pem', '.key', '.crt', '.p12', '.pfx', '.keystore', '.env']);
// Pasta cujo nome, em qualquer nível, significa "isto nasceu de um uso".
const PASTAS_DE_INSTALACAO = new Set([
  'uploads', 'thumbnails', 'capturas', 'screenshots',
  'cache', '.cache', 'logs', 'tmp', 'temp', '.backups', 'node_modules',
]);
// Abaixo destas pastas a árvore NÃO é o disco desta máquina: é o espelho da
// URL de um site de terceiro (tools/ux-extract.mjs baixa o site inteiro e
// rotas/tools.js copia o espelho para dentro do tema instalado). Um tema
// legítimo daqui carrega
// `_ext/<host>/storage/v1/object/public/cms-media/uploads/foto.webp` — o
// "uploads" ali é da Supabase de outra pessoa, não desta instalação. Sem esta
// isenção o release abortava em cima do próprio catálogo de temas.
const PASTAS_ESPELHO = new Set(['_ext', '_capture']);
// Chamadas que ESCREVEM em disco → índice do argumento que é o destino.
// copyFileSync/cpSync/renameSync têm o destino no SEGUNDO argumento.
// `writeFileAtomic.sync` e `gravaEstado` entram porque quase todo estado do
// NASCERA é gravado por eles (estado-seguro.js), não por fs.writeFileSync.
// `openSync` só conta quando o MODO é de escrita — ver o filtro adiante.
const CHAMADAS_QUE_ESCREVEM = {
  mkdirSync: 0, mkdir: 0, writeFileSync: 0, writeFile: 0,
  appendFileSync: 0, appendFile: 0, createWriteStream: 0, gravaEstado: 0,
  'writeFileAtomic.sync': 0, openSync: 0,
  copyFileSync: 1, cpSync: 1, renameSync: 1,
};

// ═══════════════════════════════════════════════════════════════════════
// A TRAVA — o que está prestes a entrar no pacote
// ═══════════════════════════════════════════════════════════════════════

// Reproduz a semântica do --exclude do tar (GNU e libarchive/bsdtar): o padrão
// NÃO é ancorado no início — casa a partir de qualquer componente do caminho —
// e `*` atravessa barra. É por isso que `.DS_Store` pega em qualquer nível e
// `public/uploads` pega a pasta inteira. Sem esta função a auditoria olharia
// um conjunto de arquivos diferente do que o tar realmente empacota.
function combinaComPadrao(rel, padrao) {
  const rx = String(padrao)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('(^|/)' + rx + '($|/)').test(rel);
}

function seriaExcluido(rel, padroes = EXCLUIR_PADROES) {
  return padroes.some(p => combinaComPadrao(rel, p));
}

// Lista, em caminhos relativos com '/', TODO arquivo que o tar levaria.
function listarQueEntram(raiz, entradas, padroes = EXCLUIR_PADROES) {
  const dentro = [];
  const andar = (rel) => {
    if (seriaExcluido(rel, padroes)) return;          // o tar poda a pasta inteira
    let st;
    try { st = fs.lstatSync(path.join(raiz, rel)); } catch { return; }
    if (st.isDirectory()) {
      for (const n of fs.readdirSync(path.join(raiz, rel)).sort()) andar(rel + '/' + n);
    } else {
      dentro.push(rel);
    }
  };
  for (const e of entradas) if (fs.existsSync(path.join(raiz, e))) andar(e);
  return dentro;
}

// ─── sinal 1: o que o SERVIDOR escreve dentro da própria pasta ────────
// Em vez de decorar nomes, lemos o código e seguimos as escritas — a mesma
// pergunta que a rede nº2 faz com os require(). Se alguém criar amanhã um
// `public/capturas` com um mkdirSync, isto aqui acha sozinho.
//
// Convenções deste projeto que o resolvedor usa: `__dirname` é a pasta do
// arquivo lido, e `RAIZ` é a pasta do NASCERA (server.js injeta `RAIZ: __dirname`
// em rotas/ e servicos/). Segmento não-literal (variável) encerra o caminho no
// PREFIXO — `path.join(THUMB_DIR, thumbFile)` vira "a pasta THUMB_DIR".
function separarArgumentos(texto) {
  const partes = [];
  let nivel = 0, atual = '', aspas = null;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      atual += c;
      if (c === '\\') { atual += texto[++i] || ''; continue; }
      if (c === aspas) aspas = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { aspas = c; atual += c; continue; }
    if (c === '(' || c === '[' || c === '{') nivel++;
    if (c === ')' || c === ']' || c === '}') nivel--;
    if (c === ',' && nivel === 0) { partes.push(atual); atual = ''; continue; }
    atual += c;
  }
  if (atual.trim()) partes.push(atual);
  return partes;
}

// Metade dos estados do NASCERA é declarada como `process.env.X || path.join(…)`
// (o override existe para o teste isolar o arquivo em tmp). Sem enxergar o
// `||`, o rastreio perderia projects.json, trash.json, vendas.json e os
// ledgers .jsonl — que são justamente os arquivos mais sensíveis.
function partesDoOu(texto) {
  const partes = [];
  let nivel = 0, atual = '', aspas = null;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      atual += c;
      if (c === '\\') { atual += texto[++i] || ''; continue; }
      if (c === aspas) aspas = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { aspas = c; atual += c; continue; }
    if (c === '(' || c === '[' || c === '{') nivel++;
    if (c === ')' || c === ']' || c === '}') nivel--;
    if (c === '|' && texto[i + 1] === '|' && nivel === 0) { partes.push(atual); atual = ''; i++; continue; }
    atual += c;
  }
  if (atual.trim()) partes.push(atual);
  return partes;
}

// Devolve o texto de dentro dos parênteses que começam em `iAbre`.
function argumentosDaChamada(texto, iAbre) {
  let nivel = 0, aspas = null;
  for (let i = iAbre; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '\\') { i++; continue; }
      if (c === aspas) aspas = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { aspas = c; continue; }
    if (c === '(') nivel++;
    else if (c === ')') { nivel--; if (nivel === 0) return texto.slice(iAbre + 1, i); }
  }
  return null;                                        // parêntese não fecha: desiste
}

function literal(txt) {
  const m = /^\s*'([^']*)'\s*$|^\s*"([^"]*)"\s*$/.exec(txt);
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2];
}

// Uma expressão pode resolver para VÁRIOS caminhos: o mesmo nome (THUMB_DIR)
// aparece duas vezes no server.js apontando para pastas diferentes, e as duas
// recebem escrita. Perder uma delas era exatamente o buraco.
function resolverCaminhos(expr, ligacoes, dirDoArquivo, raiz) {
  const e = String(expr || '').trim();
  if (!e) return [];
  if (e === '__dirname') return [dirDoArquivo];
  if (e === 'RAIZ') return [raiz];
  const ou = partesDoOu(e);
  if (ou.length > 1) return ou.flatMap(p => resolverCaminhos(p, ligacoes, dirDoArquivo, raiz));
  if (/^[A-Za-z_$][\w$]*$/.test(e)) return ligacoes.get(e) || [];
  const m = /^path\.join\(([\s\S]*)\)$/.exec(e);
  if (!m) return [];
  const partes = separarArgumentos(m[1]);
  if (!partes.length) return [];
  const bases = resolverCaminhos(partes[0], ligacoes, dirDoArquivo, raiz);
  if (!bases.length) return [];
  const resto = partes.slice(1);
  const segs = [];
  for (let i = 0; i < resto.length; i++) {
    const lit = literal(resto[i]);
    if (lit !== null) { segs.push(lit); continue; }
    // Segmento variável. Só vale como PREFIXO se for o último — aí ele é o
    // NOME DO ARQUIVO e a pasta acima é de verdade a pasta que recebe escrita
    // (`path.join(THUMB_DIR, thumbFile)` → a pasta THUMB_DIR).
    // Se ainda vêm segmentos depois dele, a variável é um NÍVEL DE PASTA e o
    // prefixo é grosso demais para servir de resposta: `path.join(RAIZ,
    // 'themes', catDir, slug)` viraria "o servidor escreve em themes/" e
    // condenaria a biblioteca de temas inteira. Nesse caso não se afirma nada.
    if (i !== resto.length - 1) return [];
    break;
  }
  return bases.map(b => path.resolve(b, ...segs));
}

function ligacoesDoArquivo(texto, dirDoArquivo, raiz) {
  const ligacoes = new Map();      // nome → caminhos absolutos
  const textos = new Map();        // nome → texto da declaração (para o prefixo do nome)
  const rx = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
  // Três passadas: uma ligação pode citar outra declarada mais abaixo.
  for (let volta = 0; volta < 3; volta++) {
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(texto))) {
      if (volta === 0) textos.set(m[1], [...new Set([...(textos.get(m[1]) || []), m[2].trim()])]);
      const caminhos = resolverCaminhos(m[2], ligacoes, dirDoArquivo, raiz);
      if (!caminhos.length) continue;
      const antes = ligacoes.get(m[1]) || [];
      ligacoes.set(m[1], [...new Set([...antes, ...caminhos])]);
    }
  }
  return { ligacoes, textos };
}

// Uma pasta pode ser do produto E receber escrita: themes/thumbnails guarda as
// 76 miniaturas do catálogo de temas (viajam de propósito) e, no meio delas, a
// captura de cada PROJETO. Isentar a pasta inteira reabriria o buraco — então
// além de "onde grava" o rastreio também colhe "como batiza": o código escreve
// `project_${proj.slug}.png`, e o prefixo literal `project_` é o que separa o
// dado do cliente do conteúdo do produto, sem ninguém precisar cadastrá-lo.
function prefixoDeNomeGerado(expr, textos = new Map(), prof = 0) {
  const e = String(expr || '').trim();
  if (!e || prof > 3) return null;
  // O nome quase nunca está na chamada: está uma declaração acima
  // (`const thumbFile = \`project_${slug}.${ext}\`` no server.js,
  //  `const thumbPath = path.join(thumbDir, \`project_${slug}.png\`)` no
  //  preview-runtime). Por isso o rastreio atravessa a ligação.
  if (/^[A-Za-z_$][\w$]*$/.test(e)) {
    for (const t of textos.get(e) || []) {
      const p = prefixoDeNomeGerado(t, textos, prof + 1);
      if (p) return p;
    }
    return null;
  }
  const direto = /^`([^`$]{3,})\$\{/.exec(e) || /^'([^']{3,})'\s*\+/.exec(e) || /^"([^"]{3,})"\s*\+/.exec(e);
  if (direto) return direto[1];
  const juncao = /^path\.join\(([\s\S]*)\)$/.exec(e);
  if (juncao) {
    const partes = separarArgumentos(juncao[1]);
    return prefixoDeNomeGerado(partes[partes.length - 1], textos, prof + 1);
  }
  return null;
}

function caminhosEscritosPeloCodigo(raiz, arquivos) {
  const achados = new Set();
  for (const rel of arquivos) {
    let texto;
    try { texto = fs.readFileSync(path.join(raiz, rel), 'utf8'); } catch { continue; }
    const dirDoArquivo = path.dirname(path.resolve(raiz, rel));
    const { ligacoes, textos } = ligacoesDoArquivo(texto, dirDoArquivo, raiz);
    const nomes = Object.keys(CHAMADAS_QUE_ESCREVEM).map(k => k.replace(/\./g, '\\.'));
    const rxChamada = new RegExp('\\b(' + nomes.join('|') + ')\\s*\\(', 'g');
    let m;
    while ((m = rxChamada.exec(texto))) {
      const args = argumentosDaChamada(texto, m.index + m[0].length - 1);
      if (args === null) continue;
      const partes = separarArgumentos(args);
      // `openSync` tanto lê quanto escreve; quem decide é o modo. Contar o
      // modo 'r' como escrita marcaria arquivo de LEITURA como gerado.
      if (m[1] === 'openSync') {
        const modo = literal(partes[1] || '');
        if (!modo || !/[aw+]/.test(modo)) continue;
      }
      const destino = partes[CHAMADAS_QUE_ESCREVEM[m[1]]];
      const prefixo = prefixoDeNomeGerado(destino, textos);
      for (const abs of resolverCaminhos(destino, ligacoes, dirDoArquivo, raiz)) {
        const r = path.relative(raiz, abs).split(path.sep).join('/');
        if (!r || r.startsWith('..')) continue;
        achados.add(r);
        if (prefixo) achados.add(r + '/' + prefixo + '*');
      }
    }
  }
  return achados;
}

// Código de PRODUTO — o que roda na máquina do cliente. scripts/ e testes/
// ficam de fora de propósito: a bancada de build escreve na própria pasta por
// dever de ofício (este arquivo reescreve o package.json para carimbar a
// versão), e ler isso como "package.json é gerado" abortaria todo release.
const CODIGO_DE_PRODUTO = ['rotas', 'servicos', 'engine', 'repos', 'tools'];

function arquivosDeCodigoDeProduto(raiz) {
  const lista = [];
  const varrer = (rel) => {
    let entradas;
    try { entradas = fs.readdirSync(path.join(raiz, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) varrer(r);
      else if (/\.(js|mjs|cjs)$/.test(e.name)) lista.push(r);
    }
  };
  for (const n of fs.existsSync(raiz) ? fs.readdirSync(raiz) : []) {
    const p = path.join(raiz, n);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (CODIGO_DE_PRODUTO.includes(n)) varrer(n); }
    else if (n.endsWith('.js') && !NAO_E_CODIGO.has(n)) lista.push(n);
  }
  return lista;
}

// ─── sinal 2: o que o ATUALIZADOR se recusa a sobrescrever ────────────
// A lista não é minha: é a PRESERVAR do atualizacao.js. Se um arquivo precisa
// sobreviver a um update, ele é da instalação por definição — e então jamais
// pode estar DENTRO de um pacote. Lida do código-fonte (não por require, que
// arrastaria axios e o resto do servidor): quando o atualizador aprender um
// arquivo novo, esta trava aprende junto. Devolve null se não conseguir ler —
// quem chama AVISA, porque link quebrado em silêncio é o defeito de sempre.
function nomesPreservadosPeloAtualizador(raiz) {
  let texto;
  try { texto = fs.readFileSync(path.join(raiz, 'atualizacao.js'), 'utf8'); } catch { return null; }
  const m = /const\s+PRESERVAR\s*=\s*new\s+Set\(\[([\s\S]*?)\]\)/.exec(texto);
  if (!m) return null;
  const nomes = (m[1].match(/'[^']+'|"[^"]+"/g) || []).map(s => s.slice(1, -1));
  return nomes.length ? new Set(nomes) : null;
}

// ─── o julgamento ─────────────────────────────────────────────────────
// Conteúdo do produto que mora onde o servidor também escreve. Vale para os
// dois sinais de pasta; nunca para os sinais de segredo e de registro.
function isentoPeloProduto(rel, isencoes = ESCRITO_MAS_DO_PRODUTO) {
  return isencoes.some(i => rel === i || rel.startsWith(i + '/'));
}

function pareceDadoDeInstalacao(rel, contexto) {
  const { gerados = new Set(), preservados = null, isencoes = ESCRITO_MAS_DO_PRODUTO } = contexto || {};
  const partes = rel.split('/');
  const nome = partes[partes.length - 1];
  const ext = path.extname(nome).toLowerCase();

  // Segredo tem precedência sobre qualquer isenção: não existe pasta do
  // produto onde uma chave privada seja conteúdo legítimo.
  if (EXTENSOES_DE_CREDENCIAL.has(ext) || nome.startsWith('.env'))
    return 'tem formato de credencial (' + (ext || nome) + ')';

  if (preservados && (preservados.has(nome) || partes.some(p => preservados.has(p))))
    return 'o atualizador PRESERVA este nome — logo ele pertence à instalação, não ao produto';

  if (EXTENSOES_DE_REGISTRO.has(ext))
    return 'tem formato de registro de execução (' + ext + ')';

  // Nome que o código gera (ex.: "project_…"). Vale INCLUSIVE dentro de pasta
  // isenta — é o que distingue a captura do cliente da miniatura do catálogo.
  for (const g of gerados) {
    if (g.includes('*') && combinaComPadrao(rel, g))
      return 'o código batiza o que grava ali de "' + g.split('/').pop() + '" (rastreado no código)';
  }

  if (isentoPeloProduto(rel, isencoes)) return null;

  // Sinal 1 (rastreado) antes do sinal por nome de pasta: ele aponta um
  // caminho exato lido do código, então vence a heurística — e por isso o
  // espelho NÃO o isenta. `themes/_extracoes/<x>/_ext/…` é extração do dono
  // dentro de uma pasta que o servidor grava; continua sendo dado dele.
  for (const g of gerados) {
    if (rel === g || rel.startsWith(g + '/'))
      return 'o servidor GRAVA em "' + g + '" em tempo de execução (rastreado no código)';
  }

  // Abaixo de um espelho, o nome da pasta é da URL de outro site, não desta
  // máquina — a heurística por nome não vale ali.
  if (partes.slice(0, -1).some(p => PASTAS_ESPELHO.has(p))) return null;

  const pasta = partes.slice(0, -1).find(p => PASTAS_DE_INSTALACAO.has(p));
  if (pasta) return 'está dentro de "' + pasta + '/", que só existe depois que alguém usa o sistema';

  return null;
}

// Ponto único da trava. Devolve o que achou; quem chama decide abortar.
function auditarPacote(raiz, entradas, opcoes = {}) {
  const padroes = opcoes.padroes || EXCLUIR_PADROES;
  const isencoes = opcoes.isencoes || ESCRITO_MAS_DO_PRODUTO;
  const preservados = opcoes.preservados !== undefined
    ? opcoes.preservados
    : nomesPreservadosPeloAtualizador(raiz);
  const gerados = opcoes.gerados !== undefined
    ? opcoes.gerados
    : caminhosEscritosPeloCodigo(raiz, arquivosDeCodigoDeProduto(raiz));

  const candidatos = listarQueEntram(raiz, entradas, padroes);
  const achados = [];
  for (const rel of candidatos) {
    const motivo = pareceDadoDeInstalacao(rel, { gerados, preservados, isencoes });
    if (motivo) achados.push({ arquivo: rel, motivo });
  }
  return { achados, arquivos: candidatos.length, gerados, preservados };
}

// ═══════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════
function principal(argv = process.argv) {
  const versao = argv[2];
  const semTemas = argv.includes('--sem-temas');
  const soAuditar = argv.includes('--auditar');
  const forcar = argv.includes('--forcar');

  if (!versao || !/^\d+(\.\d+){0,3}$/.test(versao)) {
    console.error('\nUso: node scripts/empacotar-release.js <versão>   (ex.: 1.3.0)\n');
    process.exit(1);
  }
  if (!semTemas) INCLUIR.push('themes');

  console.log(`\n📦  Empacotando NASCERA ${versao}${semTemas ? ' (sem temas)' : ''}\n`);

  // Portão de segurança ANTES de empacotar. Cada verificação corresponde a uma
  // falha que já aconteceu neste código (RCE, leitura de arquivo arbitrário,
  // token perpétuo, corrupção silenciosa de estado). Um pacote que reintroduza
  // qualquer uma delas não deve sair — e "eu lembro de checar" não é processo.
  if (!argv.includes('--pular-verificacao') && !soAuditar) {
    try {
      execFileSync('node', [path.join(__dirname, 'verificar.js')], { cwd: RAIZ, stdio: 'inherit' });
    } catch {
      console.error('\n  ⚠  Verificação de segurança FALHOU — empacotamento abortado.');
      console.error('     Corrija os itens acima. Para empacotar assim mesmo (não recomendado):');
      console.error('     node scripts/empacotar-release.js ' + versao + ' --pular-verificacao\n');
      process.exit(1);
    }
  }

  // Sincroniza o package.json com a versão que está sendo publicada — é dele
  // que a instalação lê a própria versão para saber se está atrasada.
  const pkgPath = path.join(RAIZ, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkg.version !== versao && !soAuditar) {
    pkg.version = versao;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`  ✓ package.json marcado como ${versao}`);
  }

  const presentes = INCLUIR.filter(n => fs.existsSync(path.join(RAIZ, n)));
  const faltando = INCLUIR.filter(n => !fs.existsSync(path.join(RAIZ, n)));
  if (faltando.length) console.log(`  ! não encontrados (ignorados): ${faltando.join(', ')}`);

  // Rede de segurança: módulo novo na raiz que ninguém lembrou de incluir.
  // Um release que sai sem um arquivo de código não quebra na hora — quebra na
  // máquina do cliente, depois do update, com o servidor fora do ar.
  const esquecidos = fs.readdirSync(RAIZ)
    .filter(n => n.endsWith('.js') && !INCLUIR.includes(n) && !NAO_E_CODIGO.has(n));
  if (esquecidos.length) {
    console.error(`\n  ⚠  ESTES ARQUIVOS .js FICARAM DE FORA DO PACOTE:\n     ${esquecidos.join(', ')}`);
    console.error('     Se forem código, acrescente em INCLUIR; se não forem, em NAO_E_CODIGO.');
    if (!forcar) {
      console.error('     Abortando. Use --forcar para empacotar mesmo assim.\n');
      process.exit(1);
    }
  }

  // Rede de segurança nº2: a de cima só olha .js SOLTO na raiz, então um
  // DIRETÓRIO inteiro de código pode ficar de fora sem ninguém notar — foi o que
  // aconteceu quando o server.js virou rotas/ e servicos/. Aqui a pergunta é
  // outra e não depende de memória: de tudo que o pacote leva, existe algum
  // require/import apontando para um arquivo que NÃO vai junto?
  const RAIZES_DE_CODIGO = ['rotas', 'servicos', 'engine', 'tools', 'agents', 'scripts'];
  const orfaos = [];
  (function conferirDependencias() {
    const arquivos = [];
    const varrer = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) varrer(p);
        else if (/\.(js|mjs|cjs)$/.test(e.name)) arquivos.push(p);
      }
    };
    for (const n of fs.readdirSync(RAIZ)) {
      const p = path.join(RAIZ, n);
      if (fs.statSync(p).isDirectory()) { if (RAIZES_DE_CODIGO.includes(n)) varrer(p); }
      else if (n.endsWith('.js') && !NAO_E_CODIGO.has(n)) arquivos.push(p);
    }

    const alvo = /(?:require\(|(?:^|\s)from\s+)['"](\.[^'"]+)['"]/g;
    for (const arq of arquivos) {
      const texto = fs.readFileSync(arq, 'utf8');
      for (const m of texto.matchAll(alvo)) {
        const bruto = path.resolve(path.dirname(arq), m[1]);
        const resolvido = ['', '.js', '.mjs', '.cjs', '/index.js'].map(s => bruto + s).find(fs.existsSync);
        if (!resolvido) continue;                       // require dinâmico ou opcional
        const rel = path.relative(RAIZ, resolvido);
        if (rel.startsWith('..')) continue;             // fora do projeto
        const topo = rel.split(path.sep)[0];
        if (!INCLUIR.includes(topo)) {
          orfaos.push(`${path.relative(RAIZ, arq)} → ${rel}`);
        }
      }
    }
  })();
  if (orfaos.length) {
    const unicos = [...new Set(orfaos)];
    console.error('\n  ⚠  O PACOTE LEVA CÓDIGO QUE DEPENDE DE ARQUIVO QUE FICOU DE FORA:');
    for (const o of unicos.slice(0, 20)) console.error(`     ${o}`);
    if (unicos.length > 20) console.error(`     … e mais ${unicos.length - 20}`);
    console.error('     Isso quebra na máquina do cliente, no primeiro require. Acrescente em INCLUIR.');
    if (!forcar) {
      console.error('     Abortando. Use --forcar para empacotar mesmo assim.\n');
      process.exit(1);
    }
  }

  // Rede de segurança nº3 (a TRAVA): as duas de cima perguntam se falta código.
  // Esta pergunta o contrário — se está SOBRANDO dado de gente. Diretório entra
  // inteiro no tar, e foi assim que 46 capturas de projetos de clientes saíram
  // daqui dentro de um pacote "só de código".
  const auditoria = auditarPacote(RAIZ, presentes);
  if (!auditoria.preservados) {
    console.error('\n  ⚠  Não consegui ler a lista PRESERVAR de atualizacao.js.');
    console.error('     A trava perdeu um dos sinais (segue com os outros). Confira se a');
    console.error('     declaração `const PRESERVAR = new Set([...])` ainda existe lá.');
  }
  if (auditoria.achados.length) {
    console.error('\n  ⛔  DADO DE INSTALAÇÃO PRESTES A ENTRAR NO PACOTE:');
    for (const a of auditoria.achados.slice(0, 30)) {
      console.error(`     ${a.arquivo}\n        ↳ ${a.motivo}`);
    }
    if (auditoria.achados.length > 30) console.error(`     … e mais ${auditoria.achados.length - 30}`);
    console.error('');
    console.error('     Este pacote roda na máquina de OUTRA pessoa. Nenhum destes arquivos');
    console.error('     pertence ao produto — eles pertencem a ESTA instalação.');
    console.error('     · Se for mesmo gerado: acrescente o caminho em EXCLUIR_PADROES.');
    console.error('     · Se for conteúdo do produto que só por acaso mora numa pasta que o');
    console.error('       servidor também escreve: acrescente em ESCRITO_MAS_DO_PRODUTO.');
    if (!forcar) {
      console.error('     Abortando. Use --forcar para empacotar mesmo assim (não recomendado).\n');
      process.exit(1);
    }
  } else {
    console.log(`  ✓ trava: ${auditoria.arquivos} arquivos inspecionados, nenhum é de instalação`);
  }

  if (soAuditar) {
    console.log('\n  (--auditar: nada foi empacotado)\n');
    return;
  }

  const saida = path.join(RAIZ, `nascera-${versao}.tar.gz`);
  const args = ['czf', saida];
  for (const p of EXCLUIR_PADROES) args.push(`--exclude=${p}`);
  args.push(...presentes);

  execFileSync('tar', args, { cwd: RAIZ, stdio: 'inherit' });

  const bytes = fs.statSync(saida).size;
  const sha = crypto.createHash('sha256').update(fs.readFileSync(saida)).digest('hex');

  console.log(`\n  ✓ ${path.basename(saida)}`);
  console.log(`    tamanho: ${(bytes / 1048576).toFixed(1)} MB`);
  console.log(`    sha256:  ${sha}`);

  // ── Assinatura ───────────────────────────────────────────────────────
  // O sha256 acima viaja pelo MESMO servidor que serve o pacote, então não
  // protege contra servidor comprometido. A assinatura sim: a chave privada
  // não está no servidor. Assina automaticamente se NASCERA_CHAVE_PRIVADA
  // apontar para o arquivo da chave.
  const chavePriv = process.env.NASCERA_CHAVE_PRIVADA;
  if (chavePriv && fs.existsSync(chavePriv)) {
    try {
      const { assinarArquivo } = require('../assinatura.js');
      const sig = assinarArquivo(saida, fs.readFileSync(chavePriv, 'utf8'));
      fs.writeFileSync(saida + '.sig', sig);
      console.log(`    assinatura: ${sig.slice(0, 32)}…  (salva em ${path.basename(saida)}.sig)`);
    } catch (e) {
      console.error('    ⚠ falha ao assinar: ' + e.message);
    }
  } else {
    console.log('    ⚠ SEM ASSINATURA — defina NASCERA_CHAVE_PRIVADA=/caminho/privada.pem');
    console.log('      Um pacote sem assinatura só é aceito por instalações que ainda');
    console.log('      não têm chave pública configurada. Gere o par com:');
    console.log('        node assinatura.js --gerar-par');
  }
  console.log(`    inclui:  ${presentes.join(', ')}`);
  console.log(`\n  Agora publique em https://api.nascera.ai/admin.html → aba Atualizações.`);
  console.log(`  Ou pela linha de comando, com o token de admin do painel:\n`);
  console.log(`    curl -X POST "https://api.nascera.ai/api/admin/releases?version=${versao}&notes=SUAS+NOTAS" \\`);
  console.log(`      -H "Authorization: Bearer SEU_TOKEN" -H "Content-Type: application/gzip" \\`);
  console.log(`      --data-binary @${path.basename(saida)}\n`);
}

// Só roda quando é chamado como comando. O `require` existe para o teste
// conferir a DECISÃO (o pacote tem centenas de MB; ninguém testa o tar).
if (require.main === module) principal();

module.exports = {
  INCLUIR, NAO_E_CODIGO, EXCLUIR_PADROES, ESCRITO_MAS_DO_PRODUTO,
  PASTAS_DE_INSTALACAO, EXTENSOES_DE_REGISTRO, EXTENSOES_DE_CREDENCIAL,
  combinaComPadrao, seriaExcluido, listarQueEntram,
  caminhosEscritosPeloCodigo, arquivosDeCodigoDeProduto,
  nomesPreservadosPeloAtualizador, pareceDadoDeInstalacao, auditarPacote,
  principal, RAIZ,
};
