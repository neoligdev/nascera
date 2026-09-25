// ═══════════════════════════════════════════════════════════════════════
// NASCERA — ledger de VENDAS (A0.3) — agora PG-FIRST (migração 006)
//
// Com o Postgres ativo, a AUTORIDADE é o banco:
//   • registrar() faz INSERT ... ON CONFLICT (gateway, transaction_id) DO
//     NOTHING — a reentrega de webhook vira conflito NO BANCO, à prova de
//     restart, de restore de backup e de corrida. O JSON vira diário de
//     backup, gravado depois do banco aceitar.
//   • Dinheiro falha FECHADO: banco fora do ar → registrar/jaExiste LANÇAM →
//     o webhook responde 500 → a Hotmart reentrega mais tarde (e a
//     idempotência absorve). Melhor não creditar agora do que creditar 2×.
//   • Leituras (listar/resumo) degradam para o arquivo se o banco cair —
//     ler o painel não pode depender do PG estar de pé.
//
// Sem o Postgres (NASCERA_DB_STATE≠pg, ex.: testes), tudo funciona no arquivo
// como antes. A API é assíncrona nos dois modos — contrato único.
// ═══════════════════════════════════════════════════════════════════════
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const writeFileAtomic = require('write-file-atomic');
const db = require('../db.js');
const logger = require('../log.js');

const ARQUIVO = process.env.NASCERA_VENDAS_FILE || path.join(__dirname, '..', 'vendas.json');
const PG = () => db.ATIVO && process.env.NASCERA_DB_STATE === 'pg';

// ── camada de arquivo (o diário de backup / modo sem banco) ─────────────
function lerTodas() {
  try {
    const v = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function gravarTodas(vendas) {
  writeFileAtomic.sync(ARQUIVO, JSON.stringify(vendas, null, 2), { mode: 0o600 });
}
function upsertNoArquivo(registro) {
  const todas = lerTodas();
  const i = todas.findIndex(v => v.id === registro.id);
  if (i >= 0) todas[i] = registro; else todas.push(registro);
  gravarTodas(todas);
}

// ── tradução banco ↔ app ────────────────────────────────────────────────
function paraApp(r) {
  if (!r) return null;
  const o = {
    id: r.id, gateway: r.gateway, transactionId: r.transaction_id,
    username: r.username, email: r.email, valorBrl: Number(r.valor_brl) || 0,
    meio: r.meio, referencia: r.referencia, plano: r.plano,
    origem: r.origem, status: r.status, evento: r.evento,
    registradaPor: r.registrada_por, confirmadaPor: r.confirmada_por,
    confirmadaEm: r.confirmada_em, reembolsoEvento: r.reembolso_evento,
    reembolsadaEm: r.reembolsada_em, criadaEm: r.criada_em,
  };
  for (const k of Object.keys(o)) if (o[k] === null || o[k] === undefined) delete o[k];
  return o;
}

// ── API (assíncrona nos dois modos) ─────────────────────────────────────

async function jaExiste(gateway, transactionId) {
  if (!gateway || !transactionId) return false;
  if (PG()) {
    // Falha ABERTA aqui seria crédito em dobro; deixa o erro subir (500 → retry).
    const r = await db.comSistema(cli => cli.query(
      'SELECT 1 FROM vendas WHERE gateway=$1 AND transaction_id=$2', [gateway, String(transactionId)]));
    return r.rowCount > 0;
  }
  return lerTodas().some(v => v.gateway === gateway && v.transactionId === String(transactionId));
}

/**
 * Registra uma venda. Reentrega → { duplicada: true, venda } sem creditar.
 * Com PG: o UNIQUE decide (INSERT-first); o arquivo recebe o espelho depois.
 */
async function registrar(venda) {
  const gateway = String(venda.gateway || 'manual');
  const transactionId = venda.transactionId ? String(venda.transactionId) : crypto.randomUUID();
  const registro = {
    id: crypto.randomUUID(),
    gateway, transactionId,
    username: venda.username || null,
    email: venda.email || null,
    valorBrl: Number(venda.valorBrl) || 0,
    meio: venda.meio || gateway,
    referencia: venda.referencia || transactionId,
    plano: venda.plano || null,
    origem: venda.origem || 'manual',
    status: venda.status || 'aprovada',
    evento: venda.evento || null,
    registradaPor: venda.registradaPor || null,
    criadaEm: new Date().toISOString(),
  };

  if (PG()) {
    const ins = await db.comSistema(cli => cli.query(
      `INSERT INTO vendas (id, gateway, transaction_id, username, email, valor_brl, meio,
         referencia, plano, origem, status, evento, registrada_por, criada_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (gateway, transaction_id) DO NOTHING
       RETURNING *`,
      [registro.id, gateway, transactionId, registro.username, registro.email,
       registro.valorBrl, registro.meio, registro.referencia, registro.plano,
       registro.origem, registro.status, registro.evento, registro.registradaPor, registro.criadaEm]));
    if (ins.rowCount === 0) {
      // Conflito = a transação JÁ entrou (reentrega). Devolve a original.
      const r = await db.comSistema(cli => cli.query(
        'SELECT * FROM vendas WHERE gateway=$1 AND transaction_id=$2', [gateway, transactionId]));
      return { duplicada: true, venda: paraApp(r.rows[0]) };
    }
    // Banco aceitou → diário de backup (falha aqui não desfaz o fato).
    try { upsertNoArquivo(registro); } catch (e) { logger.error('[vendas] backup json falhou:', e.message); }
    return { duplicada: false, venda: registro };
  }

  // Modo arquivo (sem PG): comportamento original.
  const todas = lerTodas();
  const existente = todas.find(v => v.gateway === gateway && v.transactionId === transactionId);
  if (existente) return { duplicada: true, venda: existente };
  todas.push(registro);
  gravarTodas(todas);
  return { duplicada: false, venda: registro };
}

// Confirma uma venda pendente (Pix conferido). Idempotente: 2ª chamada é no-op.
async function confirmar(id, { registradaPor, referencia } = {}) {
  if (PG()) {
    const upd = await db.comSistema(cli => cli.query(
      `UPDATE vendas SET status='aprovada', confirmada_por=$2, confirmada_em=now(),
              referencia=COALESCE(NULLIF($3,''), referencia)
       WHERE id=$1 AND status <> 'aprovada'
       RETURNING *`, [id, registradaPor || null, referencia || '']));
    if (upd.rowCount) { const v = paraApp(upd.rows[0]); try { upsertNoArquivo(v); } catch {} return v; }
    const r = await db.comSistema(cli => cli.query('SELECT * FROM vendas WHERE id=$1', [id]));
    return paraApp(r.rows[0]);   // já aprovada (idempotente) ou null
  }
  const todas = lerTodas();
  const v = todas.find(x => x.id === id);
  if (!v) return null;
  if (v.status === 'aprovada') return v;
  v.status = 'aprovada';
  v.confirmadaPor = registradaPor || null;
  v.confirmadaEm = new Date().toISOString();
  if (referencia) v.referencia = referencia;
  gravarTodas(todas);
  return v;
}

// Reembolso/chargeback: UPDATE de status — o ledger nunca apaga um fato.
async function marcarReembolso(gateway, transactionId, evento) {
  if (PG()) {
    const upd = await db.comSistema(cli => cli.query(
      `UPDATE vendas SET status='reembolsada', reembolso_evento=$3, reembolsada_em=now()
       WHERE gateway=$1 AND transaction_id=$2 RETURNING *`,
      [gateway, String(transactionId), evento || null]));
    const v = paraApp(upd.rows[0]);
    if (v) { try { upsertNoArquivo(v); } catch {} }
    return v;
  }
  const todas = lerTodas();
  const v = todas.find(x => x.gateway === gateway && x.transactionId === String(transactionId));
  if (!v) return null;
  v.status = 'reembolsada';
  v.reembolsoEvento = evento || null;
  v.reembolsadaEm = new Date().toISOString();
  gravarTodas(todas);
  return v;
}

async function listar({ username, gateway, limite } = {}) {
  if (PG()) {
    try {
      const conds = [], vals = [];
      if (username) { vals.push(username); conds.push('username=$' + vals.length); }
      if (gateway) { vals.push(gateway); conds.push('gateway=$' + vals.length); }
      const where = conds.length ? ' WHERE ' + conds.join(' AND ') : '';
      vals.push(Math.min(1000, limite || 1000));
      const r = await db.comSistema(cli => cli.query(
        `SELECT * FROM vendas${where} ORDER BY criada_em DESC LIMIT $` + vals.length, vals));
      return r.rows.map(paraApp);
    } catch (e) {
      logger.error('[vendas] leitura no PG falhou, servindo do arquivo:', e.message);
    }
  }
  let v = lerTodas();
  if (username) v = v.filter(x => x.username === username);
  if (gateway) v = v.filter(x => x.gateway === gateway);
  v.sort((a, b) => (b.criadaEm || '').localeCompare(a.criadaEm || ''));
  return limite ? v.slice(0, limite) : v;
}

async function resumo() {
  if (PG()) {
    try {
      const r = await db.comSistema(cli => cli.query(`
        SELECT
          COALESCE(SUM(valor_brl) FILTER (WHERE status='aprovada'), 0)::float AS total,
          COALESCE(SUM(valor_brl) FILTER (WHERE status='aprovada'
            AND date_trunc('month', criada_em) = date_trunc('month', now())), 0)::float AS mes,
          COUNT(*) FILTER (WHERE status='aprovada'
            AND date_trunc('month', criada_em) = date_trunc('month', now()))::int AS vendas_mes,
          COUNT(*) FILTER (WHERE status='reembolsada')::int AS reembolsos
        FROM vendas`));
      const g = await db.comSistema(cli => cli.query(
        `SELECT gateway, SUM(valor_brl)::float AS v FROM vendas WHERE status='aprovada' GROUP BY gateway`));
      const row = r.rows[0];
      return {
        total: row.total, mes: row.mes, vendasMes: row.vendas_mes, reembolsos: row.reembolsos,
        porGateway: Object.fromEntries(g.rows.map(x => [x.gateway, x.v])),
      };
    } catch (e) {
      logger.error('[vendas] resumo no PG falhou, servindo do arquivo:', e.message);
    }
  }
  const v = lerTodas();
  const aprovadas = v.filter(x => x.status === 'aprovada');
  const mesAtual = new Date().toISOString().slice(0, 7);
  const doMes = aprovadas.filter(x => (x.criadaEm || '').startsWith(mesAtual));
  return {
    total: aprovadas.reduce((s, x) => s + x.valorBrl, 0),
    mes: doMes.reduce((s, x) => s + x.valorBrl, 0),
    vendasMes: doMes.length,
    reembolsos: v.filter(x => x.status === 'reembolsada').length,
    porGateway: aprovadas.reduce((m, x) => { m[x.gateway] = (m[x.gateway] || 0) + x.valorBrl; return m; }, {}),
  };
}

module.exports = { registrar, jaExiste, confirmar, marcarReembolso, listar, resumo, ARQUIVO };
