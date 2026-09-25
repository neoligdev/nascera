// ═══════════════════════════════════════════════════════════════════════
// NASCERA — plano de dados no Postgres (write-through com cache)
//
// O PROBLEMA que este módulo resolve: `loadProjects()` é SÍNCRONO e é chamado
// em 52 lugares síncronos; `loadUsers()` em 32. O Postgres é assíncrono.
// Trocar a leitura por uma query `await` quebraria as 84 chamadas e exigiria
// tornar meio server.js async — refatoração enorme e arriscada.
//
// A SOLUÇÃO: o Postgres passa a estar no loop SEM mudar a interface síncrona.
//   · No boot, o cache é hidratado do JSON (a fonte durável e à prova de
//     crash) e o Postgres é RECONCILIADO para bater com ele.
//   · Leitura (`lista`/`obj`) devolve o cache — síncrono, como antes.
//   · Escrita (`sincronizar`) grava o JSON (síncrono, diário durável), atualiza
//     o cache, e ATRAVESSA para o Postgres numa transação serializada.
//
// Resultado: o banco fica vivo, atual e consultável a cada mudança; o JSON
// garante que um crash não perca nada; e reverter é desligar a flag. Não há
// split-brain porque JSON e banco são mantidos idênticos, e o JSON sempre
// vence na reconciliação do boot.
//
// Billing NÃO passa por aqui: está vazio hoje e sua migração para a função
// `debitar_turno` é um porte à parte, que merece teste dedicado (é dinheiro).
// ═══════════════════════════════════════════════════════════════════════

const db = require('./db.js');
const logger = require('./log.js');
const fs = require('fs');
const path = require('path');

// Liga só com banco configurado E a flag explícita. Sem a flag, tudo segue
// no JSON exatamente como antes — a transição é uma decisão, não um efeito
// colateral de ter DATABASE_URL setada.
const ATIVO = db.ATIVO && process.env.NASCERA_DB_STATE === 'pg';

// CUTOVER: com o marcador ausente, o PG é o ÁRBITRO no boot (hidrata do banco).
// Se alguma escrita ao PG falhar em runtime, o marcador é gravado — e o
// PRÓXIMO boot volta a confiar no JSON (que nunca falhou), reconcilia o banco
// e limpa o marcador. Assim uma queda do PG nunca vira perda de dado no restart.
const MARCADOR_DEGRADADO = path.join(__dirname, '.pg-degradado');

// Fila de escrita: as gravações ao Postgres são serializadas para não se
// atropelarem (duas sincronizações concorrentes da mesma tabela). Erros são
// gritados no log, marcam a degradação, mas NÃO derrubam a requisição — o
// JSON já garantiu o dado.
let _fila = Promise.resolve();
function enfileirar(rotulo, fn) {
  _fila = _fila.then(fn).catch((e) => {
    logger.error('[estado-db] falha ao gravar ' + rotulo + ' no Postgres: ' + e.message +
                  ' (o JSON está íntegro; o próximo boot reconcilia a partir dele)');
    try { fs.writeFileSync(MARCADOR_DEGRADADO, new Date().toISOString() + ' ' + rotulo + ': ' + e.message + '\n', { flag: 'a' }); } catch {}
  });
  return _fila;
}

// ─── tradução projeto: app (camelCase) ↔ banco (snake_case) ──────────
const COLS_PROJ = {
  owner: 'owner_username', name: 'nome', slug: 'slug', path: 'path',
  publishedPath: 'published_path', previewUrl: 'preview_url', publishUrl: 'publish_url',
  currentVersion: 'current_version', publishedVersion: 'published_version',
  sessionId: 'session_id', activeAgent: 'active_agent', buildLevel: 'build_level',
  themeId: 'theme_id', scaffolded: 'scaffolded', paletteId: 'palette_id',
  paletteUrl: 'palette_url', claudeEffort: 'claude_effort', thumbnail: 'thumbnail',
  costUsd: 'cost_usd', origem: 'origem',
};
// Campos do app que já têm coluna própria; o resto vai para `extra` JSONB.
const CONHECIDOS_PROJ = new Set([...Object.keys(COLS_PROJ), 'id', 'createdAt', 'customPalette']);

function projParaApp(r) {
  if (!r) return null;
  const o = {
    id: r.id, owner: r.owner_username, name: r.nome, slug: r.slug, path: r.path,
    publishedPath: r.published_path, previewUrl: r.preview_url, publishUrl: r.publish_url,
    currentVersion: r.current_version, publishedVersion: r.published_version,
    sessionId: r.session_id, activeAgent: r.active_agent, buildLevel: r.build_level,
    themeId: r.theme_id, scaffolded: r.scaffolded, paletteId: r.palette_id,
    paletteUrl: r.palette_url, customPalette: r.custom_palette, claudeEffort: r.claude_effort,
    thumbnail: r.thumbnail, costUsd: r.cost_usd == null ? 0 : Number(r.cost_usd),
    origem: r.origem, createdAt: r.criado_em,
  };
  if (r.extra && typeof r.extra === 'object') Object.assign(o, r.extra);
  // remove nulos que só existem por causa da tradução, para o objeto ficar
  // igual ao que o JSON entregava
  for (const k of Object.keys(o)) if (o[k] === null || o[k] === undefined) delete o[k];
  return o;
}

async function upsertProjeto(cli, p) {
  const extra = {};
  for (const k of Object.keys(p)) if (!CONHECIDOS_PROJ.has(k)) extra[k] = p[k];
  await cli.query(
    `INSERT INTO projetos (id, owner_username, owner_id, nome, slug, path, published_path,
       preview_url, publish_url, current_version, published_version, session_id, active_agent,
       build_level, theme_id, scaffolded, palette_id, palette_url, custom_palette, claude_effort,
       thumbnail, cost_usd, origem, extra, criado_em)
     VALUES ($1,$2,(SELECT id FROM usuarios WHERE username=$2),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
             $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,COALESCE($24::timestamptz,now()))
     ON CONFLICT (id) DO UPDATE SET
       owner_username=EXCLUDED.owner_username, nome=EXCLUDED.nome, slug=EXCLUDED.slug,
       path=EXCLUDED.path, published_path=EXCLUDED.published_path, preview_url=EXCLUDED.preview_url,
       publish_url=EXCLUDED.publish_url, current_version=EXCLUDED.current_version,
       published_version=EXCLUDED.published_version, session_id=EXCLUDED.session_id,
       active_agent=EXCLUDED.active_agent, build_level=EXCLUDED.build_level,
       theme_id=EXCLUDED.theme_id, scaffolded=EXCLUDED.scaffolded, palette_id=EXCLUDED.palette_id,
       palette_url=EXCLUDED.palette_url, custom_palette=EXCLUDED.custom_palette,
       claude_effort=EXCLUDED.claude_effort, thumbnail=EXCLUDED.thumbnail,
       cost_usd=EXCLUDED.cost_usd, origem=EXCLUDED.origem, extra=EXCLUDED.extra,
       atualizado_em=now()`,
    [p.id, p.owner || null, p.name || '(sem nome)', p.slug || p.id, p.path || null,
     p.publishedPath || null, p.previewUrl || null, p.publishUrl || null,
     p.currentVersion || 0, p.publishedVersion || 0, p.sessionId || null, p.activeAgent || null,
     p.buildLevel ?? null, p.themeId || null, !!p.scaffolded, p.paletteId || null,
     p.paletteUrl || null, p.customPalette ? JSON.stringify(p.customPalette) : null,
     p.claudeEffort || null, p.thumbnail || null, p.costUsd || 0,
     p.origem === 'vinculado' ? 'vinculado' : 'proprio', JSON.stringify(extra), p.createdAt || null]);
}

// ─── stores ──────────────────────────────────────────────────────────
let _cacheProjetos = [];
let _cacheUsuarios = {};
let _cacheLixeira = [];

const projetos = {
  lista() { return _cacheProjetos.map(p => ({ ...p })); },
  sincronizar(arr) {
    _cacheProjetos = arr.map(p => ({ ...p }));
    const ids = arr.map(p => p.id).filter(Boolean);
    enfileirar('projetos', () => db.comSistema(async (cli) => {
      for (const p of arr) if (p && p.id) await upsertProjeto(cli, p);
      // apaga do banco os que sumiram do array (exclusão, restauração)
      if (ids.length) await cli.query('DELETE FROM projetos WHERE NOT (id = ANY($1::uuid[]))', [ids]);
      else await cli.query('DELETE FROM projetos');
    }));
  },
  async hidratar() {
    const r = await db.comSistema(cli => cli.query('SELECT * FROM projetos'));
    _cacheProjetos = r.rows.map(projParaApp);
  },
};

// Campos do usuário que têm coluna própria; TODO o resto (suspended, iaPropria,
// definirSenha, criadoPor, o que vier) viaja no JSONB `extra` (migração 006) —
// sem isso, um boot com o PG como árbitro DES-SUSPENDERIA clientes.
const CONHECIDOS_USER = new Set(['name', 'email', 'password', 'role', 'dataDir', 'createdAt']);

const usuarios = {
  obj() { return JSON.parse(JSON.stringify(_cacheUsuarios)); },
  sincronizar(dict) {
    _cacheUsuarios = JSON.parse(JSON.stringify(dict));
    const nomes = Object.keys(dict);
    enfileirar('usuarios', () => db.comSistema(async (cli) => {
      for (const [username, u] of Object.entries(dict)) {
        if (!u || !u.password) continue;
        const extra = {};
        for (const k of Object.keys(u)) if (!CONHECIDOS_USER.has(k)) extra[k] = u[k];
        await cli.query(
          `INSERT INTO usuarios (username, nome, email, senha_hash, papel, data_dir, extra, criado_em)
           VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz,now()))
           ON CONFLICT (username) DO UPDATE SET
             nome=EXCLUDED.nome, email=EXCLUDED.email, senha_hash=EXCLUDED.senha_hash,
             papel=EXCLUDED.papel, data_dir=EXCLUDED.data_dir, extra=EXCLUDED.extra,
             atualizado_em=now()`,
          [username, u.name || null, u.email || null, u.password,
           u.role === 'admin' ? 'admin' : 'user', u.dataDir || null,
           JSON.stringify(extra), u.createdAt || null]);
      }
      if (nomes.length) await cli.query('DELETE FROM usuarios WHERE NOT (username = ANY($1::citext[]))', [nomes]);
    }));
  },
  async hidratar() {
    const r = await db.comSistema(cli => cli.query('SELECT * FROM usuarios'));
    const d = {};
    for (const u of r.rows) {
      const o = { name: u.nome, email: u.email, password: u.senha_hash,
                  role: u.papel, createdAt: u.criado_em, dataDir: u.data_dir };
      if (u.extra && typeof u.extra === 'object') Object.assign(o, u.extra);
      for (const k of Object.keys(o)) if (o[k] === null || o[k] === undefined) delete o[k];
      d[u.username] = o;
    }
    _cacheUsuarios = d;
  },
};

const lixeira = {
  lista() { return _cacheLixeira.map(x => ({ ...x })); },
  sincronizar(arr) {
    _cacheLixeira = arr.map(x => ({ ...x }));
    const ids = arr.map(x => x.id).filter(Boolean);
    enfileirar('lixeira', () => db.comSistema(async (cli) => {
      for (const it of arr) {
        if (!it || !it.id) continue;
        await cli.query(
          `INSERT INTO lixeira (id, owner_username, nome, slug, snapshot, trash_path, arquivos,
             deletado_em, expira_em)
           VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz,now()),
                   COALESCE($9::timestamptz, now() + interval '7 days'))
           ON CONFLICT (id) DO UPDATE SET snapshot=EXCLUDED.snapshot, arquivos=EXCLUDED.arquivos`,
          [it.id, it.owner || '(desconhecido)', it.name || null, it.slug || null,
           JSON.stringify(it), it.trashPath || it._trashPath || null, it.arquivos || null,
           it.deletedAt || null, it.expiresAt || null]);
      }
      if (ids.length) await cli.query('DELETE FROM lixeira WHERE NOT (id = ANY($1::uuid[]))', [ids]);
      else await cli.query('DELETE FROM lixeira');
    }));
  },
  async hidratar() {
    const r = await db.comSistema(cli => cli.query('SELECT * FROM lixeira'));
    _cacheLixeira = r.rows.map(x => ({ ...(x.snapshot || {}), id: x.id }));
  },
};

// ─── Domínios ──────────────────────────────────────────────────────────
// A tabela `dominios` era um retrato CONGELADO: quem a preencheu foi o
// import inicial, e o domains.js vivo só escrevia no JSON. Toda verificação
// de DNS, troca de status e domínio novo depois disso ficou invisível para o
// banco — e a divergência crescia calada. Aqui o mesmo write-through dos
// projetos: o JSON continua sendo o diário durável e o banco recebe o espelho.
//
// Recebe o objeto do domains.json ({ "host": {…} }) e não um array, porque é
// assim que aquele módulo guarda o estado.
const dominios = {
  sincronizar(mapa) {
    const regs = Object.entries(mapa || {});
    const hosts = regs.map(([h]) => h);
    enfileirar('dominios', () => db.comSistema(async (cli) => {
      for (const [host, reg] of regs) {
        if (!reg || !reg.projectId) continue;
        // FK: domínio de projeto que já não existe derrubaria a transação
        // inteira e levaria junto os domínios válidos.
        const existe = await cli.query('SELECT 1 FROM projetos WHERE id=$1', [reg.projectId]);
        if (!existe.rowCount) continue;
        await cli.query(
          `INSERT INTO dominios (dominio, projeto_id, slug, owner_username, status, token,
                                 principal, pointing, erro, ultima_checagem, verificado_em,
                                 ultima_checagem_em, criado_em)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13::timestamptz, now()))
           ON CONFLICT (dominio) DO UPDATE SET
             projeto_id=EXCLUDED.projeto_id, slug=EXCLUDED.slug,
             owner_username=EXCLUDED.owner_username, status=EXCLUDED.status,
             token=EXCLUDED.token, principal=EXCLUDED.principal, pointing=EXCLUDED.pointing,
             erro=EXCLUDED.erro, ultima_checagem=EXCLUDED.ultima_checagem,
             verificado_em=EXCLUDED.verificado_em, ultima_checagem_em=EXCLUDED.ultima_checagem_em`,
          [host, reg.projectId, reg.slug || null, reg.user || null,
           ['pendente', 'ativo', 'erro'].includes(reg.status) ? reg.status : 'pendente',
           reg.token || '', !!reg.primary, reg.pointing ?? null, reg.error || null,
           reg.lastCheck ? JSON.stringify(reg.lastCheck) : null,
           reg.verifiedAt || null, reg.lastCheckAt || null, reg.createdAt || null]);
      }
      // Domínio removido no painel tem de sumir do banco também.
      if (hosts.length) await cli.query('DELETE FROM dominios WHERE NOT (dominio = ANY($1::text[]))', [hosts]);
      else await cli.query('DELETE FROM dominios');
    }));
  },
};

// ═══ Boot — CUTOVER: o Postgres é o ÁRBITRO ═══
//
// Ordem de decisão:
//   1. Marcador de degradação presente (alguma escrita ao PG falhou desde o
//      último boot) → o JSON venceu aquele período → semeia do JSON, reconcilia
//      o banco e LIMPA o marcador. Auto-cura: nada se perde.
//   2. PG vazio (primeira subida / banco novo) → semeia do JSON (import).
//   3. Caso normal → HIDRATA DO POSTGRES (a fonte) e devolve os dados para o
//      server regravar os JSONs como BACKUP CONTÍNUO — daqui em diante o
//      arquivo é o retrato do banco, não o contrário.
async function iniciar({ projetosJson, usuariosJson, lixeiraJson }) {
  if (!ATIVO) return { ativo: false };

  const degradado = fs.existsSync(MARCADOR_DEGRADADO);
  let vazio = true;
  try {
    const r = await db.comSistema(cli => cli.query('SELECT count(*)::int AS n FROM usuarios'));
    vazio = r.rows[0].n === 0;
  } catch (e) {
    throw new Error('não consegui consultar o banco no boot: ' + e.message);
  }

  if (degradado || vazio) {
    // JSON vence: semeia o cache e reconcilia o banco (o desenho antigo).
    _cacheProjetos = (projetosJson || []).map(p => ({ ...p }));
    _cacheUsuarios = JSON.parse(JSON.stringify(usuariosJson || {}));
    _cacheLixeira = (lixeiraJson || []).map(x => ({ ...x }));
    usuarios.sincronizar(_cacheUsuarios);   // usuários primeiro (FK dos projetos)
    projetos.sincronizar(_cacheProjetos);
    lixeira.sincronizar(_cacheLixeira);
    await _fila;   // reconciliação completa antes de aceitar tráfego
    if (degradado) {
      try { fs.unlinkSync(MARCADOR_DEGRADADO); } catch {}
      logger.warn('[estado-db] período degradado detectado: banco reconciliado a partir do JSON; marcador limpo');
    }
    return {
      ativo: true, fonte: vazio ? 'json-primeira-carga' : 'json-reconciliacao',
      projetos: _cacheProjetos.length,
      usuarios: Object.keys(_cacheUsuarios).length,
      lixeira: _cacheLixeira.length,
    };
  }

  // Caminho normal: o banco manda.
  await usuarios.hidratar();
  await projetos.hidratar();
  await lixeira.hidratar();
  return {
    ativo: true, fonte: 'pg',
    projetos: _cacheProjetos.length,
    usuarios: Object.keys(_cacheUsuarios).length,
    lixeira: _cacheLixeira.length,
    // O server regrava os JSONs com isto — o backup nasce igual ao árbitro.
    dados: {
      projetos: _cacheProjetos.map(p => ({ ...p })),
      usuarios: JSON.parse(JSON.stringify(_cacheUsuarios)),
      lixeira: _cacheLixeira.map(x => ({ ...x })),
    },
  };
}

module.exports = { ATIVO, iniciar, projetos, usuarios, lixeira, dominios };
