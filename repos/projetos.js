// ═══════════════════════════════════════════════════════════════════════
// ⚠ NÃO ESTÁ NO CAMINHO DE EXECUÇÃO (S1-1). Nenhum arquivo importa este módulo
//   hoje. O que roda em produção é o `estado-db.js` (cache do JSON + espelho
//   write-through no Postgres). Este arquivo é a CAMADA DO CUTOVER: quando o
//   Postgres virar árbitro de verdade (passo pós-Sprint 3, com rede de
//   testes), o server passa a ler daqui, com RLS no caminho por-usuário.
//   Mantido — não é código morto, é seam planejado — mas não confunda: a
//   leitura de projeto hoje NÃO passa por aqui.
// ═══════════════════════════════════════════════════════════════════════
// NASCERA — repositório de projetos
//
// Duas implementações atrás da MESMA interface:
//   json → o comportamento de hoje (arquivo único, escrita atômica)
//   pg   → Postgres com RLS
//
// A troca é por variável de ambiente, POR SUBSISTEMA:
//   NASCERA_DB_PROJETOS=pg    (padrão: json)
//
// Virar de uma vez o sistema inteiro seria apostar tudo numa jogada. Assim
// dá para virar um subsistema, observar em produção, e reverter mudando uma
// variável — sem deploy e sem migração de volta.
//
// O ganho que a implementação `pg` traz e o JSON não tem:
//   · UPDATE de um campo não reescreve o array inteiro (eram 27 pontos);
//   · `cost_usd = cost_usd + $1` soma NO BANCO, matando o lost-update do
//     caminho quente do motor;
//   · busca por índice em vez de find() linear;
//   · RLS: o banco recusa ler/escrever projeto de outro dono.
// ═══════════════════════════════════════════════════════════════════════

const db = require('../db.js');

const usarPg = () => db.ATIVO && process.env.NASCERA_DB_PROJETOS === 'pg';

// ─── tradução banco → forma que o resto do código já espera ──────────
// O produto inteiro fala camelCase; o banco fala snake_case. A tradução
// mora AQUI e em nenhum outro lugar — nenhuma rota precisa saber disso.
function paraApp(r) {
  if (!r) return null;
  return {
    id: r.id,
    owner: r.owner_username,
    name: r.nome,
    slug: r.slug,
    path: r.path,
    publishedPath: r.published_path,
    previewUrl: r.preview_url,
    publishUrl: r.publish_url,
    currentVersion: r.current_version,
    publishedVersion: r.published_version,
    sessionId: r.session_id,
    activeAgent: r.active_agent,
    buildLevel: r.build_level,
    themeId: r.theme_id,
    scaffolded: r.scaffolded,
    paletteId: r.palette_id,
    paletteUrl: r.palette_url,
    customPalette: r.custom_palette,
    claudeEffort: r.claude_effort,
    thumbnail: r.thumbnail,
    costUsd: r.cost_usd === null ? 0 : Number(r.cost_usd),
    origem: r.origem,
    createdAt: r.criado_em,
    ...(r.extra || {}),
  };
}

// Campos que a aplicação atualiza, e a coluna de cada um. Lista explícita:
// um patch com chave desconhecida não vira SQL, vira erro — é o que impede
// injeção por nome de coluna.
const COLUNAS = {
  name: 'nome', slug: 'slug', path: 'path', publishedPath: 'published_path',
  previewUrl: 'preview_url', publishUrl: 'publish_url',
  currentVersion: 'current_version', publishedVersion: 'published_version',
  sessionId: 'session_id', activeAgent: 'active_agent', buildLevel: 'build_level',
  themeId: 'theme_id', scaffolded: 'scaffolded', paletteId: 'palette_id',
  paletteUrl: 'palette_url', customPalette: 'custom_palette',
  claudeEffort: 'claude_effort', thumbnail: 'thumbnail', costUsd: 'cost_usd',
  origem: 'origem', owner: 'owner_username',
};

function criar({ loadProjects, saveProjects }) {
  // ── implementação JSON (comportamento atual) ──
  const json = {
    async listarDoDono(username, ehAdmin) {
      const todos = loadProjects();
      return ehAdmin ? todos : todos.filter(p => p.owner === username);
    },
    async porId(id) {
      return loadProjects().find(p => p.id === id) || null;
    },
    async atualizar(id, patch) {
      const projetos = loadProjects();
      const p = projetos.find(x => x.id === id);
      if (!p) return null;
      Object.assign(p, patch);
      saveProjects(projetos);
      return p;
    },
    async somarCusto(id, delta) {
      const projetos = loadProjects();
      const p = projetos.find(x => x.id === id);
      if (!p) return null;
      p.costUsd = (p.costUsd || 0) + delta;
      saveProjects(projetos);
      return p.costUsd;
    },
    async inserir(proj) {
      const projetos = loadProjects();
      projetos.push(proj);
      saveProjects(projetos);
      return proj;
    },
    async remover(id) {
      const projetos = loadProjects();
      const i = projetos.findIndex(p => p.id === id);
      if (i < 0) return false;
      projetos.splice(i, 1);
      saveProjects(projetos);
      return true;
    },
  };

  // ── implementação Postgres ──
  const pg = {
    async listarDoDono(username, ehAdmin) {
      const r = await db.comUsuario(username, ehAdmin ? 'admin' : 'user',
        c => c.query('SELECT * FROM projetos ORDER BY criado_em DESC'));
      return r.rows.map(paraApp);
    },
    async porId(id, username, ehAdmin) {
      const r = await db.comUsuario(username, ehAdmin ? 'admin' : 'user',
        c => c.query('SELECT * FROM projetos WHERE id=$1', [id]));
      return paraApp(r.rows[0]);
    },
    async atualizar(id, patch, username, ehAdmin) {
      const sets = [], vals = [];
      for (const [k, v] of Object.entries(patch)) {
        const col = COLUNAS[k];
        if (!col) continue;                       // chave desconhecida não vira SQL
        vals.push(k === 'customPalette' && v ? JSON.stringify(v) : v);
        sets.push(col + '=$' + (vals.length + 1));
      }
      if (!sets.length) return this.porId(id, username, ehAdmin);
      vals.unshift(id);
      const r = await db.comUsuario(username, ehAdmin ? 'admin' : 'user',
        c => c.query('UPDATE projetos SET ' + sets.join(',') +
                     ', atualizado_em=now() WHERE id=$1 RETURNING *', vals));
      return paraApp(r.rows[0]);
    },
    // A soma acontece NO BANCO: duas sessões somando ao mesmo tempo não se
    // atropelam, que é o lost-update do caminho quente do motor.
    async somarCusto(id, delta, username, ehAdmin) {
      const r = await db.comUsuario(username, ehAdmin ? 'admin' : 'user',
        c => c.query('UPDATE projetos SET cost_usd = cost_usd + $2 WHERE id=$1 RETURNING cost_usd',
                     [id, delta]));
      return r.rows[0] ? Number(r.rows[0].cost_usd) : null;
    },
    async inserir(proj, username, ehAdmin) {
      const r = await db.comUsuario(username, ehAdmin ? 'admin' : 'user', c => c.query(
        `INSERT INTO projetos (id, owner_username, owner_id, nome, slug, path, published_path,
           preview_url, publish_url, current_version, published_version, session_id,
           active_agent, build_level, theme_id, scaffolded, palette_id, palette_url,
           custom_palette, claude_effort, thumbnail, cost_usd, origem)
         VALUES ($1,$2,(SELECT id FROM usuarios WHERE username=$2),$3,$4,$5,$6,$7,$8,
                 $9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
        [proj.id, proj.owner, proj.name, proj.slug, proj.path, proj.publishedPath,
         proj.previewUrl, proj.publishUrl, proj.currentVersion || 0, proj.publishedVersion || 0,
         proj.sessionId, proj.activeAgent, proj.buildLevel, proj.themeId, !!proj.scaffolded,
         proj.paletteId, proj.paletteUrl,
         proj.customPalette ? JSON.stringify(proj.customPalette) : null,
         proj.claudeEffort, proj.thumbnail, proj.costUsd || 0, proj.origem || 'proprio']));
      return paraApp(r.rows[0]);
    },
    async remover(id, username, ehAdmin) {
      const r = await db.comUsuario(username, ehAdmin ? 'admin' : 'user',
        c => c.query('DELETE FROM projetos WHERE id=$1', [id]));
      return r.rowCount > 0;
    },
  };

  // Fachada: escolhe a implementação a cada chamada, para a flag valer sem
  // restart do processo em ambiente de teste.
  const fachada = {};
  for (const metodo of Object.keys(json)) {
    fachada[metodo] = (...args) => (usarPg() ? pg : json)[metodo](...args);
  }
  fachada.backend = () => (usarPg() ? 'pg' : 'json');
  return fachada;
}

module.exports = { criar, paraApp };
