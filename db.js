// ═══════════════════════════════════════════════════════════════════════
// NASCERA — Conexão com o banco
//
// Espelha o padrão que o license-server já opera há tempos (pg.Pool +
// DATABASE_URL), para a casa ter UMA forma de falar com Postgres.
//
// Decisão da revisão adversarial: NÃO adotamos o distro Supabase inteiro.
// Se falamos com o banco por pg.Pool e mantemos autenticação própria, os ~10
// contêineres do distro (Kong, GoTrue, PostgREST, Realtime, Storage…) viram
// peso morto disputando a RAM do mesmo VPS que já roda o motor de IA e um
// Chromium por turno. Postgres puro + este pool entrega o que interessa.
//
// PONTO CRÍTICO DE SEGURANÇA — leia antes de mexer:
// A multi-tenancy é imposta por RLS, que lê `current_setting('app.usuario')`.
// `SET LOCAL` só sobrevive DENTRO de uma transação. Portanto TODA query que
// toca dado de inquilino precisa passar por `comUsuario()`, que abre a
// transação, aplica o contexto e fecha. Uma query solta fora de transação
// perde o contexto e a policy nega tudo — ou, com `SET` sem `LOCAL`, vazaria
// o contexto de um usuário para a query de outro no mesmo cliente do pool.
// ═══════════════════════════════════════════════════════════════════════

const { Pool } = require('pg');
const logger = require('./log.js');

const ATIVO = !!process.env.DATABASE_URL;

let pool = null;
function obterPool() {
  if (!ATIVO) throw new Error('DATABASE_URL não configurada — banco desativado');
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: parseInt(process.env.DB_POOL_MAX || '10', 10),
      idleTimeoutMillis: 30000,
      // Uma conexão que não vem em 5s é sinal de pool esgotado — falhar rápido
      // é melhor que empilhar requisições penduradas.
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', (err) => logger.error('[db] erro no pool:', err.message));
  }
  return pool;
}

// Query administrativa/sem inquilino (migrations, health, import).
// NÃO use para dado de usuário — veja comUsuario().
function query(text, params) {
  return obterPool().query(text, params);
}

// Executa `fn(cliente)` dentro de uma transação, já com o contexto do
// inquilino aplicado — é este contexto que as policies de RLS leem.
// `papel` NÃO vem do token: quem chama deve passar o papel lido AO VIVO do
// banco, senão um admin rebaixado continuaria admin até o token vencer.
async function comUsuario(username, papel, fn) {
  const cliente = await obterPool().connect();
  try {
    await cliente.query('BEGIN');
    // set_config com parâmetro: o valor NUNCA é concatenado no SQL.
    await cliente.query("SELECT set_config('app.usuario', $1, true)", [username || '']);
    await cliente.query("SELECT set_config('app.papel', $1, true)", [papel || 'user']);
    const r = await fn(cliente);
    await cliente.query('COMMIT');
    return r;
  } catch (e) {
    try { await cliente.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    cliente.release();
  }
}

// Transação sem contexto de inquilino (rotinas internas, import, admin).
async function comTransacao(fn) {
  const cliente = await obterPool().connect();
  try {
    await cliente.query('BEGIN');
    const r = await fn(cliente);
    await cliente.query('COMMIT');
    return r;
  } catch (e) {
    try { await cliente.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    cliente.release();
  }
}

// Contexto de SISTEMA: enxerga e escreve todas as linhas, independente de RLS.
// Usado pelos acessores internos (loadProjects & cia) que sempre devolveram
// TUDO e deixavam o filtro de dono por conta do app (projectOr404,
// projetosDoUsuario) — exatamente como faziam com o JSON. A RLS continua
// valendo como segunda muralha para o caminho por-requisição (comUsuario com
// o usuário real). Isto NÃO enfraquece o modelo: reproduz o que o JSON fazia.
async function comSistema(fn) {
  return comUsuario('__sistema__', 'admin', fn);
}

async function saude() {
  if (!ATIVO) return { ok: false, motivo: 'DATABASE_URL não configurada' };
  try {
    const t0 = Date.now();
    await query('SELECT 1');
    const p = obterPool();
    return {
      ok: true, ms: Date.now() - t0,
      pool: { total: p.totalCount, ociosos: p.idleCount, esperando: p.waitingCount },
    };
  } catch (e) {
    return { ok: false, motivo: e.message };
  }
}

async function encerrar() {
  if (pool) { await pool.end().catch(() => {}); pool = null; }
}

module.exports = { ATIVO, query, comUsuario, comSistema, comTransacao, saude, encerrar, obterPool };
