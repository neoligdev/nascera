// ═══════════════════════════════════════════════════════════════════════
// NASCERA — versionamento e publicação de um projeto (S4: extraído do server.js)
//
// 5 rotas git-only: publish (tag + espelho p/ published), versions, history,
// revert (por hash) e rollback (por versão). Sem motor, sem channels.
//
// SEGURANÇA — as validações que fecharam o RCE autenticado ficam DENTRO daqui
// e não podem ser afrouxadas: revert exige hashValido (^[0-9a-f]{4,40}$) e
// rollback exige versão numérica (^\d+(\.\d+){0,3}$); git roda por ARGV, nunca
// por shell. Portão de posse: projectOr404 (W1/IDOR) — versions/history cobertos
// por testes/rotas-autorizacao.js (dono=200, outro=404). PENDENTE: teste unitário
// dos gates de revert/rollback (hash/versão inválidos → 400) e do argv sem shell.
//
// Removidos os `const projects = loadProjects()` MORTOS de versions/history/
// revert/rollback — projectOr404 já recarrega; ninguém lia aquele array.
// ═══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const logger = require('../log.js');
const path = require('path');
// Só o normalizador (resolve symlink antes de comparar caminho): sem ele, uma
// pasta publicada que fosse um link para a home passaria por checagem de
// prefixo. O portão de exclusão em si (`apagarComSeguranca`) NÃO serve aqui —
// o porquê está comentado na rota de publish.
const { normalizar } = require('../caminhos-seguros.js');

// ═══════════════════════════════════════════════════════════════════════
// Espelhar a pasta servível na pasta publicada (o que o rsync fazia)
//
// Era `execFileSync('rsync', ['-a','--delete','--exclude=.git',
// '--exclude=node_modules', ...])` com um catch que só chamava logger.error.
// No Windows não existe rsync: o execFileSync estourava ENOENT, o catch
// engolia, e a rota respondia `{ok:true, message:'Publicado vN'}` com a pasta
// publicada VAZIA — o visitante tomava 404 enquanto o painel dizia que tinha
// publicado. Era a pior falha possível: o produto mentindo sobre a sua razão
// de existir.
//
// A troca não é um `if (win32)`: `fs.cpSync` (Node >= 16.7) copia recursivo
// nos três sistemas e some com a dependência de binário externo. As três
// coisas que o rsync fazia estão reproduzidas abaixo — recursão, `--delete`
// e os dois `--exclude`.
// ═══════════════════════════════════════════════════════════════════════

// Os mesmos dois `--exclude` do comando antigo.
const EXCLUIDOS = new Set(['.git', 'node_modules']);

// O rsync casa o padrão com QUALQUER componente do caminho, em qualquer
// profundidade. Olhar só o último nome basta porque o cpSync não desce em
// pasta que o filtro recusou — os pais já foram cortados antes de chegar aqui.
function excluidoDoEspelho(caminho) { return EXCLUIDOS.has(path.basename(caminho)); }

/**
 * `--delete` do rsync: tira do destino o que não existe mais na origem.
 *
 * Apagar o destino inteiro e recopiar seria mais curto e é exatamente o que a
 * regra de ouro do `caminhos-seguros.js` proíbe ("quando em dúvida, NÃO
 * apague"). Aqui removemos entrada por entrada, sempre DENTRO do destino e
 * nunca o próprio destino — o pior estrago possível fica sendo apagar um
 * arquivo publicado que a origem já não tem, que é justamente o combinado.
 *
 * @param {string} origem - Pasta servível do projeto (referência do que deve sobrar).
 * @param {string} destino - Pasta publicada correspondente.
 * @returns {number} Quantas entradas foram removidas.
 */
function podarSobras(origem, destino) {
  let removidos = 0;
  let entradas;
  try { entradas = fs.readdirSync(destino, { withFileTypes: true }); } catch { return 0; }

  for (const e of entradas) {
    // O rsync PROTEGE do --delete o que está em --exclude (só --delete-excluded
    // removia). Um node_modules/.git que já estivesse na pasta publicada não
    // sumia — e continua não sumindo.
    if (EXCLUIDOS.has(e.name)) continue;

    const alvo = path.join(destino, e.name);
    const par = path.join(origem, e.name);
    let stPar = null;
    try { stPar = fs.lstatSync(par); } catch { /* não existe na origem */ }

    // Fora quando sumiu da origem OU quando mudou de tipo (arquivo virou
    // pasta): o cpSync estoura ENOTSUP nesse conflito, então limpar aqui é o
    // que deixa a cópia recriar do jeito certo.
    const mesmoTipo = !!stPar
      && stPar.isDirectory() === e.isDirectory()
      && stPar.isSymbolicLink() === e.isSymbolicLink();
    if (!mesmoTipo) { fs.rmSync(alvo, { recursive: true, force: true }); removidos++; continue; }

    // Desce só em pasta DE VERDADE. `isDirectory()` de um dirent é lstat, então
    // link simbólico cai fora daqui de propósito: seguir um link levaria a
    // apagar arquivo FORA da pasta publicada.
    if (e.isDirectory()) removidos += podarSobras(par, alvo);
  }
  return removidos;
}

/**
 * Deixa `destino` idêntico a `origem`, sem `.git` nem `node_modules`.
 * Substitui o `rsync -a --delete`; qualquer falha vira exceção (publicar é a
 * razão de existir do produto — responder ok sem ter copiado é inaceitável).
 *
 * @param {string} origem - Pasta servível do projeto.
 * @param {string} destino - Pasta publicada.
 * @param {{apagarSobras?: boolean}} [opcoes] - `apagarSobras:false` desliga o `--delete` (destino fora da área publicada).
 * @returns {{removidos: number}} Quantas sobras foram podadas.
 */
function espelharPasta(origem, destino, opcoes = {}) {
  const apagarSobras = opcoes.apagarSobras !== false;

  // A origem é conferida ANTES de qualquer remoção: sem isto, um projeto cuja
  // pasta sumiu apagaria o site publicado e só depois falharia.
  let st = null;
  try { st = fs.statSync(origem); } catch { st = null; }
  if (!st) throw new Error('pasta de origem não encontrada: ' + origem);
  if (!st.isDirectory()) throw new Error('a origem não é uma pasta: ' + origem);

  // O comando antigo era `rsync -a <servível>/ <publicada>`: com a barra no fim
  // ele copia o CONTEÚDO, seguindo o link quando a própria pasta servível é um
  // link (`dist -> ../compartilhado`, comum em monorepo — o getServableDir
  // aceita, porque statSync segue link). O cpSync trata link no topo como link
  // e tenta criar um link NO LUGAR da pasta publicada: estoura EEXIST e a
  // publicação vira 500. Resolver só o TOPO devolve o comportamento antigo;
  // links de DENTRO continuam copiados como estão (verbatimSymlinks abaixo).
  try { if (fs.lstatSync(origem).isSymbolicLink()) origem = fs.realpathSync(origem); } catch { /* segue com o caminho original */ }

  fs.mkdirSync(destino, { recursive: true });
  const removidos = apagarSobras ? podarSobras(origem, destino) : 0;

  fs.cpSync(origem, destino, {
    recursive: true,
    force: true,
    // `-a` do rsync preserva data de modificação; manter isso evita mudar o
    // Last-Modified de todo arquivo publicado a cada publicação no Unix.
    preserveTimestamps: true,
    // `-a` do rsync inclui `-l`: link simbólico é copiado COMO ESTÁ. Sem esta
    // opção o cpSync reescreve link relativo em ABSOLUTO — `assets -> ./compartilhado`
    // viraria um link para dentro da pasta de código do projeto, e o site
    // publicado passaria a servir arquivo de fora da área publicada. Isso muda
    // o comportamento no Unix, que é justamente o que não pode mudar.
    verbatimSymlinks: true,
    // A raiz nunca é excluída (o rsync também não exclui o próprio diretório
    // transferido) — só o que está dentro dela.
    filter: (org) => org === origem || !excluidoDoEspelho(org),
  });

  return { removidos };
}

/**
 * Resolve symlink no trecho do caminho que JÁ EXISTE e devolve o resto colado.
 *
 * `normalizar()` sozinho não serve para comparar os dois lados: ele só chama
 * realpath no que existe. Na primeira publicação o destino ainda não existe,
 * então a raiz vinha resolvida (`/private/var/...`) e o destino não
 * (`/var/...`) — a comparação dava falso e o `--delete` desligava sozinho, em
 * silêncio. Numa máquina onde o HOME é um link isso valeria para SEMPRE.
 *
 * @param {string} p - Caminho a resolver.
 * @returns {string|null}
 */
function normalizarProfundo(p) {
  if (!p || typeof p !== 'string') return null;
  let existente = path.resolve(p);
  const restos = [];
  while (!fs.existsSync(existente)) {
    const pai = path.dirname(existente);
    if (pai === existente) break;              // chegou na raiz do disco
    restos.unshift(path.basename(existente));
    existente = pai;
  }
  return path.join(normalizar(existente) || existente, ...restos);
}

/**
 * `alvo` é uma subpasta REAL de `raiz`? Comparação por segmento, igual à do
 * `caminhos-seguros.js`: um `startsWith` cru aprovaria "_published-antigo"
 * como se fosse de dentro de "_published". A raiz em si é recusada de
 * propósito — com slug vazio o destino vira a própria área publicada, e podar
 * ali apagaria o site de TODOS os projetos.
 *
 * @param {string} raiz - Área publicada do NASCERA (PUBLISHED_BASE).
 * @param {string} alvo - Pasta publicada do projeto.
 * @returns {boolean}
 */
function dentroDe(raiz, alvo) {
  const r = normalizarProfundo(raiz);
  const a = normalizarProfundo(alvo);
  if (!r || !a || a === r) return false;
  return a.startsWith(r + path.sep);
}

/**
 * Monta as rotas git-only de versionamento e publicação de um projeto
 * (`/api/projects/:id/*`): publish (tag + espelho), versions, history, revert (por
 * hash) e rollback (por versão). SEGURANÇA: revert exige `hashValido`
 * (`^[0-9a-f]{4,40}$`) — validação que fechou o RCE autenticado; não afrouxar.
 *
 * @param {import('express').Express} app - App do Express onde as rotas são montadas.
 * @param {object} deps - Dependências injetadas pelo server.js (composition root).
 * @param {import('express').RequestHandler} deps.authMiddleware - Guarda de sessão; exige usuário logado.
 * @param {import('express').RequestHandler} deps.projectOr404 - Portão de dono (W1/IDOR): resolve `req.projeto` ou responde 404 se for de outro usuário.
 * @param {(args: string[], cwd: string) => string} deps.git - Executa git sem shell.
 * @param {(h: string) => boolean} deps.hashValido - Valida um hash git (`^[0-9a-f]{4,40}$`); barra injeção de argumento.
 * @param {(proj: object) => string} deps.getNextVersion - Calcula a próxima versão a publicar.
 * @param {(proj: object, msg: string) => void} deps.autoCommit - Commit automático antes de operações destrutivas.
 * @param {(proj: object) => string} deps.getServableDir - Diretório servível do projeto (build ou raiz).
 * @param {(id: string, patch: object) => object} deps.atualizarProjeto - Aplica um patch ao projeto no array real.
 * @param {string} deps.PUBLISHED_BASE - Raiz dos sites publicados.
 * @returns {void}
 */
function registrar(app, deps) {
  const {
    authMiddleware, projectOr404, git, hashValido, getNextVersion,
    autoCommit, getServableDir, atualizarProjeto, PUBLISHED_BASE,
  } = deps;

  app.post('/api/projects/:id/publish', authMiddleware, (req, res) => {
    const proj = projectOr404(req, res); if (!proj) return;
    if (!proj.path) return res.status(400).json({ error: 'Projeto sem diretório' });

    try {
      // Auto-commit pending changes
      autoCommit(proj.path, 'Pre-publish save');

      // Create version tag
      const version = getNextVersion(proj.path);
      const message = req.body.message || `Publish v${version}`;
      git(['tag','-a','v'+version,'-m',String(message||('v'+version))], proj.path);

      // Detect servable dir e espelha na pasta publicada
      const servableDir = getServableDir(proj.path);
      const publishedPath = proj.publishedPath || path.join(PUBLISHED_BASE, proj.slug);

      // Portão da parte destrutiva: só podamos sobras quando o destino é
      // comprovadamente uma SUBPASTA da área publicada do NASCERA. Um
      // `publishedPath` herdado apontando para fora (instalação antiga, env
      // PUBLISHED_BASE trocada) publica mesmo assim — só não apaga nada.
      //
      // Não uso `apagarComSeguranca()` aqui de propósito, e o motivo é duplo:
      // ele manda para a lixeira do sistema, que não existe no Windows (a rota
      // falharia justo na plataforma que estamos consertando), e mandaria o
      // site INTEIRO para a lixeira a cada publicação, enchendo o disco do
      // usuário. O que se aproveita dele é a checagem por segmento com
      // symlink resolvido — em `dentroDe()`, sobre a área publicada.
      const podeApagar = dentroDe(PUBLISHED_BASE, publishedPath);
      if (!podeApagar) {
        logger.error('[publish] destino fora da área publicada — copiando SEM apagar sobras:', publishedPath);
      }

      // Sem shell e sem binário externo: erro aqui SOBE para o catch de fora e
      // vira 500. Antes o catch local só logava e a rota respondia "Publicado".
      espelharPasta(servableDir, publishedPath, { apagarSobras: podeApagar });

      // Update project (S1-2: `proj` vem do projectOr404, não do array `projects`
      // carregado acima — mutar+salvar aquele array não persistia. Persiste no
      // objeto certo; `proj` segue mutado só para a resposta abaixo.)
      proj.currentVersion = version;
      proj.publishedVersion = version;
      proj.publishedPath = publishedPath;
      atualizarProjeto(proj.id, { currentVersion: version, publishedVersion: version, publishedPath });

      res.json({
        ok: true,
        version,
        publishUrl: proj.publishUrl,
        message: `Publicado v${version}`,
      });
    } catch (err) {
      res.status(500).json({ error: 'Falha ao publicar: ' + err.message });
    }
  });

  app.get('/api/projects/:id/versions', authMiddleware, (req, res) => {
    const proj = projectOr404(req, res); if (!proj) return;
    if (!proj.path || !fs.existsSync(path.join(proj.path, '.git'))) {
      return res.json({ versions: [], publishedVersion: 0 });
    }

    try {
      const tagsRaw = git(['tag','-l','v*','--sort=-version:refname'], proj.path);
      if (!tagsRaw) return res.json({ versions: [], publishedVersion: proj.publishedVersion || 0 });

      const versions = tagsRaw.split('\n').filter(Boolean).map(tag => {
        const num = parseInt(tag.replace('v', ''), 10);
        const date = git(['log','-1','--format=%ci',tag], proj.path);
        const msg = git(['tag','-n1',tag], proj.path);
        return {
          version: num,
          tag,
          date: date || '',
          message: msg ? msg.replace(/^v\d+\s*/, '') : '',
          isPublished: num === (proj.publishedVersion || 0),
        };
      });

      res.json({ versions, publishedVersion: proj.publishedVersion || 0 });
    } catch (err) {
      res.status(500).json({ error: 'Falha ao listar versões: ' + err.message });
    }
  });

  // API: Full change history (all commits)
  app.get('/api/projects/:id/history', authMiddleware, (req, res) => {
    const proj = projectOr404(req, res); if (!proj) return;
    if (!proj.path) return res.json({ history: [] });
    if (!fs.existsSync(path.join(proj.path, '.git'))) return res.json({ history: [] });

    try {
      const logRaw = git(['log','--pretty=format:%H|||%h|||%s|||%ci|||%an','--name-status','-50'], proj.path);
      if (!logRaw) return res.json({ history: [] });

      const entries = [];
      let current = null;

      logRaw.split('\n').forEach(line => {
        if (!line.trim()) return;
        if (line.includes('|||')) {
          const parts = line.split('|||');
          current = {
            hash: parts[0], shortHash: parts[1], message: parts[2],
            date: parts[3], author: parts[4], files: [],
            isVersion: false, versionTag: null,
          };
          entries.push(current);
        } else if (current) {
          const match = line.match(/^([MADR])\t(.+)/);
          if (match) current.files.push({ status: match[1], file: match[2] });
        }
      });

      // Check version tags
      const tagsRaw = git(['tag','-l','v*','--format=%(objectname:short) %(refname:short)'], proj.path) || '';
      const tagMap = {};
      tagsRaw.split('\n').filter(Boolean).forEach(line => {
        const [hash, tag] = line.split(' ');
        tagMap[hash] = tag;
      });
      entries.forEach(e => {
        if (tagMap[e.shortHash]) { e.isVersion = true; e.versionTag = tagMap[e.shortHash]; }
      });

      res.json({ history: entries });
    } catch (err) {
      res.json({ history: [] });
    }
  });

  // API: Revert to a specific commit
  app.post('/api/projects/:id/revert', authMiddleware, (req, res) => {
    const { hash } = req.body;
    if (!hash) return res.status(400).json({ error: 'Hash obrigatorio' });
    // Era RCE autenticado: `hash` ia cru para dentro de uma string de shell.
    // Agora valida o formato E passa por argv (sem shell).
    if (!hashValido(hash)) return res.status(400).json({ error: 'Hash inválido' });
    const proj = projectOr404(req, res); if (!proj) return;
    if (!proj.path) return res.status(404).json({ error: 'Projeto nao encontrado' });
    try {
      git(['checkout', hash, '--', '.'], proj.path);
      git(['add', '-A'], proj.path);
      git(['commit', '-m', 'Revertido para ' + hash.substring(0, 7)], proj.path);
      res.json({ ok: true, message: 'Revertido para ' + hash.substring(0, 7) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });


  // ─── Rollback API ────────────────────────────────────────────────────
  app.post('/api/projects/:id/rollback', authMiddleware, (req, res) => {
    const { version } = req.body;
    if (!version) return res.status(400).json({ error: 'version é obrigatório' });
    // Mesma falha do /revert: `version` entrava cru no shell. Uma versão é
    // numérica (1, 1.2, 1.2.3) — qualquer outra coisa é recusada aqui.
    if (!/^\d+(\.\d+){0,3}$/.test(String(version))) {
      return res.status(400).json({ error: 'Versão inválida' });
    }

    const proj = projectOr404(req, res); if (!proj) return;
    if (!proj.path) return res.status(400).json({ error: 'Projeto sem diretório' });

    try {
      // Check tag exists
      const tagExists = git(['tag', '-l', 'v' + version], proj.path);
      if (!tagExists) return res.status(404).json({ error: `Versão v${version} não encontrada` });

      // Checkout files from that version
      git(['checkout', 'v' + version, '--', '.'], proj.path);
      git(['add', '-A'], proj.path);
      git(['commit', '-m', 'Rollback to v' + version], proj.path);

      res.json({ ok: true, message: `Rollback para v${version} realizado` });
    } catch (err) {
      res.status(500).json({ error: 'Falha no rollback: ' + err.message });
    }
  });
}

// `espelharPasta` e `dentroDe` saem daqui para o teste poder provar a cópia e o
// portão sem subir servidor. Quem monta as rotas segue usando só `registrar`.
module.exports = { registrar, espelharPasta, dentroDe };
