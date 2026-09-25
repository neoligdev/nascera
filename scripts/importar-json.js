#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// NASCERA — importa o estado dos arquivos JSON para o Postgres
//
//   DATABASE_URL=... node scripts/importar-json.js            (importa)
//   DATABASE_URL=... node scripts/importar-json.js --conferir (só confere)
//
// Duas propriedades inegociáveis:
//
// IDEMPOTENTE — roda quantas vezes quiser sem duplicar nada (ON CONFLICT DO
// NOTHING em todo lugar, e os UUIDs do JSON são PRESERVADOS). Isso permite
// rodar o import várias vezes durante a migração, conferindo a cada rodada.
//
// ORDEM TOPOLÓGICA DE FK — usuarios ANTES de projetos, projetos antes de
// domínios/lixeira. A revisão adversarial pegou este erro no plano original,
// que virava projetos primeiro: um projeto cujo dono ainda não existe quebra
// a FK e a policy de RLS não reconhece o dono.
//
// NÃO apaga nem altera nada nos JSONs. A fonte de verdade continua sendo o
// arquivo até a virada de leitura ser feita, subsistema por subsistema.
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const db = require('../db.js');

const RAIZ = path.join(__dirname, '..');
const ler = (nome, padrao) => {
  try { return JSON.parse(fs.readFileSync(path.join(RAIZ, nome), 'utf8')); }
  catch { return padrao; }
};

const apenasConferir = process.argv.includes('--conferir');
const contagem = {};

async function importarUsuarios(cli) {
  const users = ler('users.json', {});
  let n = 0;
  for (const [username, u] of Object.entries(users)) {
    // Chaves que não são conta (o JSON misturava, ex.: "_tema_adm").
    if (!u || typeof u !== 'object' || !u.password) continue;
    const r = await cli.query(
      `INSERT INTO usuarios (username, nome, email, senha_hash, papel, data_dir, criado_em)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, now()))
       ON CONFLICT (username) DO NOTHING`,
      [username, u.name || null, u.email || null, u.password,
       u.role === 'admin' ? 'admin' : 'user', u.dataDir || null, u.createdAt || null]);
    n += r.rowCount;
  }
  contagem.usuarios = n;
}

async function importarProjetos(cli) {
  const projs = ler('projects.json', []);
  let n = 0;
  for (const p of projs) {
    if (!p || !p.id) continue;
    // owner_id resolvido por username; se o dono não existir, deixa NULL
    // (a FK permite) mas mantém owner_username, que é o que a RLS usa.
    const r = await cli.query(
      `INSERT INTO projetos (
         id, owner_username, owner_id, nome, slug, path, published_path,
         preview_url, publish_url, current_version, published_version,
         session_id, active_agent, build_level, theme_id, scaffolded,
         palette_id, palette_url, custom_palette, claude_effort, thumbnail,
         cost_usd, origem, criado_em)
       VALUES ($1,$2,(SELECT id FROM usuarios WHERE username=$2),$3,$4,$5,$6,
               $7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
               COALESCE($23::timestamptz, now()))
       ON CONFLICT (id) DO NOTHING`,
      [p.id, p.owner || null, p.name || '(sem nome)', p.slug || p.id,
       p.path || null, p.publishedPath || null, p.previewUrl || null, p.publishUrl || null,
       p.currentVersion || 0, p.publishedVersion || 0, p.sessionId || null,
       p.activeAgent || null, p.buildLevel ?? null, p.themeId || null, !!p.scaffolded,
       p.paletteId || null, p.paletteUrl || null,
       p.customPalette ? JSON.stringify(p.customPalette) : null,
       p.claudeEffort || null, p.thumbnail || null, p.costUsd || 0,
       p.origem === 'vinculado' ? 'vinculado' : 'proprio', p.createdAt || null]);
    n += r.rowCount;
  }
  contagem.projetos = n;
}

async function importarBilling(cli) {
  const st = ler('billing.json', { accounts: {} });
  let contas = 0, cortesias = 0, janelas = 0;
  for (const [username, acct] of Object.entries(st.accounts || {})) {
    if (!acct || typeof acct !== 'object') continue;
    const r = await cli.query(
      `INSERT INTO contas_credito (username, usuario_id, plano, saldo_milli)
       VALUES ($1,(SELECT id FROM usuarios WHERE username=$1),$2,$3)
       ON CONFLICT (username) DO NOTHING`,
      [username, acct.plan || 'free', Math.max(0, acct.balanceMilli || 0)]);
    contas += r.rowCount;

    for (const g of (acct.grants || [])) {
      if (!g) continue;
      const rg = await cli.query(
        `INSERT INTO cortesias (id, username, label, restante_milli, expira_em)
         VALUES (COALESCE($1::uuid, gen_random_uuid()),$2,$3,$4,$5)
         ON CONFLICT (id) DO NOTHING`,
        [/^[0-9a-f-]{36}$/i.test(String(g.id || '')) ? g.id : null,
         username, g.label || null, Math.max(0, g.remainingMilli || 0), g.expiresAt || null]);
      cortesias += rg.rowCount;
    }

    for (const escopo of ['session', 'day', 'week', 'month']) {
      const w = (acct.spend || {})[escopo];
      if (!w) continue;
      const rj = await cli.query(
        `INSERT INTO janelas_gasto (username, escopo, chave, inicio_ts, usd, base_usd, charged_usd)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (username, escopo) DO NOTHING`,
        [username, escopo, w.key || null,
         w.startTs ? new Date(w.startTs).toISOString() : null,
         w.usd || 0, w.baseUsd || 0, w.chargedUsd || 0]);
      janelas += rj.rowCount;
    }
  }
  contagem.contas_credito = contas;
  contagem.cortesias = cortesias;
  contagem.janelas_gasto = janelas;
}

async function importarDominios(cli) {
  const d = ler('domains.json', { domains: {} });
  let n = 0;
  for (const [host, reg] of Object.entries(d.domains || {})) {
    if (!reg || !reg.projectId) continue;
    // Domínio de projeto que não existe seria FK quebrada: pula e avisa.
    const existe = await cli.query('SELECT 1 FROM projetos WHERE id=$1', [reg.projectId]);
    if (!existe.rowCount) { console.warn('  ! domínio ' + host + ': projeto ' + reg.projectId + ' não existe, pulado'); continue; }
    const r = await cli.query(
      `INSERT INTO dominios (dominio, projeto_id, slug, owner_username, status, token,
                             principal, pointing, erro, ultima_checagem, verificado_em,
                             ultima_checagem_em, criado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13::timestamptz, now()))
       ON CONFLICT (dominio) DO NOTHING`,
      [host, reg.projectId, reg.slug || null, reg.user || null,
       ['pendente', 'ativo', 'erro'].includes(reg.status) ? reg.status : 'pendente',
       reg.token || '', !!reg.primary, reg.pointing ?? null, reg.error || null,
       reg.lastCheck ? JSON.stringify(reg.lastCheck) : null,
       reg.verifiedAt || null, reg.lastCheckAt || null, reg.createdAt || null]);
    n += r.rowCount;
  }
  contagem.dominios = n;
}

async function importarLixeira(cli) {
  const itens = ler('trash.json', []);
  let n = 0;
  for (const t of itens) {
    if (!t || !t.id) continue;
    const r = await cli.query(
      `INSERT INTO lixeira (id, owner_username, nome, slug, snapshot, trash_path,
                            arquivos, deletado_em, expira_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now()),
               COALESCE($9::timestamptz, now() + interval '7 days'))
       ON CONFLICT (id) DO NOTHING`,
      [t.id, t.owner || '(desconhecido)', t.name || null, t.slug || null,
       JSON.stringify(t), t.trashPath || t._trashPath || null, t.arquivos || null,
       t.deletedAt || null, t.expiresAt || null]);
    n += r.rowCount;
  }
  contagem.lixeira = n;
}

async function importarLog(cli) {
  const log = ler('activity-log.json', []);
  // O log já existente no banco não deve duplicar numa segunda rodada.
  const { rows } = await cli.query('SELECT count(*)::int AS n FROM log_atividade');
  if (rows[0].n > 0) { contagem.log_atividade = 0; return; }
  let n = 0;
  for (const e of log) {
    if (!e || !e.type) continue;
    const r = await cli.query(
      `INSERT INTO log_atividade (tipo, usuario, dados, em)
       VALUES ($1,$2,$3,COALESCE($4::timestamptz, now()))`,
      [e.type, e.user || null, e.data ? JSON.stringify(e.data) : null, e.at || null]);
    n += r.rowCount;
  }
  contagem.log_atividade = n;
}

async function conferir() {
  const alvos = [
    ['usuarios', Object.values(ler('users.json', {})).filter(u => u && u.password).length],
    ['projetos', ler('projects.json', []).filter(p => p && p.id).length],
    ['lixeira', ler('trash.json', []).filter(t => t && t.id).length],
    ['dominios', Object.keys(ler('domains.json', { domains: {} }).domains || {}).length],
    ['contas_credito', Object.keys(ler('billing.json', { accounts: {} }).accounts || {}).length],
  ];
  console.log('\n  Conferência JSON × banco:');
  let tudoOk = true;
  for (const [tabela, noJson] of alvos) {
    const { rows } = await db.query('SELECT count(*)::int AS n FROM ' + tabela);
    const ok = rows[0].n >= noJson;
    if (!ok) tudoOk = false;
    console.log('    ' + (ok ? '✓' : '✖') + ' ' + tabela.padEnd(16) +
                'json=' + String(noJson).padStart(4) + '  banco=' + String(rows[0].n).padStart(4));
  }
  return tudoOk;
}

(async () => {
  if (!db.ATIVO) {
    console.error('\n  DATABASE_URL não configurada.\n');
    process.exit(1);
  }
  try {
    if (!apenasConferir) {
      console.log('\n📥  Importando JSON → Postgres (ordem topológica de FK)\n');
      // Tudo numa transação: ou o estado inteiro entra, ou nada entra.
      await db.comTransacao(async (cli) => {
        await importarUsuarios(cli);
        await importarProjetos(cli);
        await importarBilling(cli);
        await importarDominios(cli);
        await importarLixeira(cli);
        await importarLog(cli);
      });
      for (const [k, v] of Object.entries(contagem)) {
        console.log('  ' + (v > 0 ? '+' : ' ') + String(v).padStart(4) + '  ' + k);
      }
      console.log('\n  (0 = já estava importado — o script é idempotente)');
    }
    const ok = await conferir();
    console.log('\n  ' + (ok ? '✓ Banco em dia com os arquivos.' : '✖ Divergência — investigue antes de virar a leitura.') + '\n');
    await db.encerrar();
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error('\n[importar] FALHOU (nada foi gravado):', e.message, '\n');
    await db.encerrar();
    process.exit(1);
  }
})();
