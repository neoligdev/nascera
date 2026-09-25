// ═══════════════════════════════════════════════════════════════════════
// NASCERA — Billing no Postgres
//
// POR QUE ESTE ARQUIVO EXISTE
// O billing.js guarda saldo, cortesia e janelas de gasto num JSON com
// read-modify-write. Num processo só isso funciona (o JS não é preemptivo no
// meio de uma função), mas não sobrevive ao que vem depois: pm2 em cluster,
// duas instâncias atrás de um balanceador, ou um crash entre o débito e o
// save. Aí dois turnos simultâneos leem o mesmo saldo, gravam por cima um do
// outro, e um débito some — o cliente consome e a conta fica com o provedor.
//
// Aqui o débito inteiro (evento + cortesia + saldo + janelas) vira UMA
// transação no Postgres, com `FOR UPDATE` serializando concorrentes e UNIQUE
// no turn_id garantindo idempotência PERMANENTE (o JSON tinha janela de 24h).
//
// A RESTRIÇÃO QUE MOLDOU O DESENHO
// `gateDecision` é chamado de `podeDespachar`, um predicado SÍNCRONO: o motor
// espera true/false na hora, não dá para await. Então hoje:
//   • o DÉBITO (escrita) é assíncrono e vai para o Postgres de forma atômica;
//   • o PORTÃO (leitura) continua decidindo pela conta local do billing.js.
//
// ESTADO REAL, sem enfeite: o Postgres ainda NÃO é a fonte do portão. As duas
// pontas são mantidas iguais porque toda mutação (débito e as quatro
// operações de admin) escreve nos dois lados; `conferir()` existe para provar
// isso. Enquanto o portão não ler daqui, o Postgres é o registro durável e
// auditável — não o árbitro. Trocar o árbitro exige mudar `podeDespachar`
// para um predicado que consulte um estado pré-carregado, e isso é um passo
// separado, não um efeito colateral deste arquivo.
//
// REVERSÍVEL: sem NASCERA_DB_BILLING=pg, nada aqui entra em ação e o billing
// segue 100% no JSON, exatamente como antes.
// ═══════════════════════════════════════════════════════════════════════

const db = require('./db.js');
const logger = require('./log.js');
const fs = require('fs');
const path = require('path');

const ATIVO = db.ATIVO && process.env.NASCERA_DB_BILLING === 'pg';

// ─── Outbox de débito (S0-9) ───────────────────────────────────────────
// Antes, um débito que falhava no Postgres (banco fora, timeout) virava só uma
// linha de console.error e sumia — o dinheiro saía do JSON e o banco nunca
// sabia. Aqui o débito falho é PENDURADO num arquivo append-only e um dreno
// periódico o reaplica. É seguro reaplicar: debitar_turno é idempotente por
// turn_id (UNIQUE), então um débito que na verdade tinha entrado só devolve
// `duplicate` e não cobra de novo.
const OUTBOX = path.join(__dirname, 'billing-outbox.jsonl');

function pendurar(payload) {
  try {
    const fd = fs.openSync(OUTBOX, 'a');
    try { fs.writeSync(fd, JSON.stringify(payload) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  } catch (e) { logger.error('[billing] não consegui pendurar débito no outbox: ' + e.message); }
}

let _drenando = false;
async function drenar() {
  if (_drenando || !ATIVO) return { tentados: 0, ok: 0, restam: 0 };
  _drenando = true;
  try {
    let linhas;
    try { linhas = fs.readFileSync(OUTBOX, 'utf8').split('\n').filter(Boolean); }
    catch { return { tentados: 0, ok: 0, restam: 0 }; }   // sem arquivo = nada a fazer
    const restantes = [];
    let ok = 0;
    for (const linha of linhas) {
      let p; try { p = JSON.parse(linha); } catch { continue; }  // linha corrompida: descarta
      try { await debitar(p); ok++; }                            // idempotente: reaplicar é seguro
      catch { restantes.push(linha); }                           // ainda falhando: mantém
    }
    // Reescreve com o que sobrou (atômico: tmp + rename).
    if (restantes.length) {
      const tmp = OUTBOX + '.tmp';
      fs.writeFileSync(tmp, restantes.join('\n') + '\n'); fs.renameSync(tmp, OUTBOX);
    } else {
      try { fs.unlinkSync(OUTBOX); } catch {}
    }
    if (ok) logger.info('[billing] outbox drenado: ' + ok + ' débito(s) reconciliado(s), ' + restantes.length + ' pendente(s)');
    return { tentados: linhas.length, ok, restam: restantes.length };
  } finally { _drenando = false; }
}

// Dreno periódico só quando o billing PG está ligado.
if (ATIVO) setInterval(() => { drenar().catch(() => {}); }, 60 * 1000).unref();

// Fila por usuário: dois débitos do MESMO usuário são serializados já aqui,
// antes de chegar no banco. O `FOR UPDATE` da função também os serializa, mas
// enfileirar no processo evita segurar conexão do pool à toa.
const _filas = new Map();
function enfileirar(chave, tarefa) {
  const anterior = _filas.get(chave) || Promise.resolve();
  // `then(tarefa, tarefa)` de propósito: um débito que falhou não pode
  // travar a fila do usuário — o próximo roda de qualquer jeito.
  const atual = anterior.then(tarefa, tarefa);
  // A cauda guardada é a versão "amansada" (sem rejeição), e é ELA que
  // precisa ser comparada na limpeza. Criar outro `.catch()` aqui geraria
  // uma promessa nova a cada chamada, o `===` nunca casaria e a entrada
  // ficaria no Map para sempre — vazamento de uma entrada por usuário.
  const cauda = atual.catch(() => {});
  _filas.set(chave, cauda);
  cauda.then(() => { if (_filas.get(chave) === cauda) _filas.delete(chave); });
  return atual;
}

// Débito atômico. Recebe o preço JÁ CALCULADO pelo billing.js — a regra de
// negócio (quanto custa) continua lá; aqui só se move valor.
async function debitar({ username, turnId, costMilli, baseUsd, chargedUsd, perModel,
                         usdPerCredit, chaveDia, chaveSemana, chaveMes, sessaoMs }) {
  return enfileirar('deb:' + username, () => db.comSistema(async (cli) => {
    const r = await cli.query(
      'SELECT debitar_turno($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS r',
      [username, turnId, costMilli, baseUsd, chargedUsd,
       JSON.stringify(perModel || {}), usdPerCredit,
       chaveDia || null, chaveSemana || null, chaveMes || null, sessaoMs || 18000000]
    );
    return r.rows[0].r;
  }));
}

// Retrato completo do crédito de um usuário — o que o portão e o resumo leem.
// As chaves de janela vêm de fora (quem sabe o fuso é o billing.js). Sem
// elas a função não consegue distinguir "gasto de hoje" de "gasto de ontem"
// e devolveria a janela vencida como se fosse a corrente.
async function estado(username, { chaveDia, chaveSemana, chaveMes, sessaoMs } = {}) {
  return db.comSistema(async (cli) => {
    const r = await cli.query('SELECT estado_credito($1,$2,$3,$4,$5) AS e',
      [username, chaveDia || null, chaveSemana || null, chaveMes || null, sessaoMs || 18000000]);
    return r.rows[0].e;
  });
}

// Garante que a conta existe (o débito já cria, mas o admin precisa mexer
// em conta que nunca gastou: definir plano, dar cortesia, pôr saldo).
async function garantirConta(username, plano) {
  return db.comSistema(async (cli) => {
    await cli.query(
      `INSERT INTO contas_credito (username, plano) VALUES ($1, COALESCE($2,'free'))
       ON CONFLICT (username) DO UPDATE SET plano = COALESCE($2, contas_credito.plano)`,
      [username, plano || null]
    );
  });
}

async function definirPlano(username, plano) {
  return garantirConta(username, plano);
}

// Saldo avulso: soma (ou subtrai) crédito da conta. Nunca deixa negativo —
// o CHECK da tabela é a última linha de defesa, mas travamos antes para dar
// erro claro em vez de exceção de constraint.
async function somarSaldo(username, deltaMilli) {
  await garantirConta(username);
  return db.comSistema(async (cli) => {
    const r = await cli.query(
      `UPDATE contas_credito
          SET saldo_milli = GREATEST(0, saldo_milli + $2)
        WHERE username = $1
        RETURNING saldo_milli`,
      [username, deltaMilli]
    );
    return r.rows[0] ? Number(r.rows[0].saldo_milli) : 0;
  });
}

// Cortesia: crédito com prazo, consumido antes do saldo.
async function darCortesia(username, milli, label, expiraEm, id) {
  await garantirConta(username);
  return db.comSistema(async (cli) => {
    // O id vem do JSON quando existe: os dois lados guardam a MESMA cortesia,
    // então reimportar o arquivo não cria uma segunda (ON CONFLICT).
    const r = await cli.query(
      `INSERT INTO cortesias (id, username, label, restante_milli, expira_em)
       VALUES (COALESCE($5::uuid, gen_random_uuid()),$1,$2,$3,$4)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [username, label || null, milli, expiraEm || null, id || null]
    );
    return r.rows[0] ? r.rows[0].id : id;
  });
}

// Zera as janelas de gasto (o "resetSpend" do admin). Não mexe em saldo nem
// em cortesia: é só o contador do período.
async function zerarJanelas(username) {
  return db.comSistema(async (cli) => {
    await cli.query('DELETE FROM janelas_gasto WHERE username = $1', [username]);
  });
}

// Visão do admin: todas as contas com saldo, cortesia e gasto do mês.
async function panorama() {
  return db.comSistema(async (cli) => {
    const r = await cli.query(
      `SELECT c.username, c.plano, c.saldo_milli,
              COALESCE((SELECT SUM(restante_milli) FROM cortesias g
                         WHERE g.username = c.username AND g.restante_milli > 0
                           AND (g.expira_em IS NULL OR g.expira_em > now())), 0) AS cortesia_milli,
              COALESCE((SELECT usd FROM janelas_gasto w
                         WHERE w.username = c.username AND w.escopo = 'month'), 0) AS gasto_mes_usd
         FROM contas_credito c ORDER BY c.username`
    );
    return r.rows;
  });
}

// Conferência JSON × Postgres — para virar a chave com prova, não com fé.
async function conferir(contasJson) {
  const linhas = await panorama();
  const noBanco = new Map(linhas.map(l => [String(l.username).toLowerCase(), l]));
  const divergencias = [];
  for (const [user, acct] of Object.entries(contasJson || {})) {
    const b = noBanco.get(String(user).toLowerCase());
    if (!b) { divergencias.push({ user, erro: 'ausente no Postgres' }); continue; }
    // saldo avulso
    const saldoJson = Number(acct.balanceMilli || 0);
    const saldoPg = Number(b.saldo_milli || 0);
    if (saldoJson !== saldoPg) divergencias.push({ user, campo: 'saldo', json: saldoJson, pg: saldoPg });
    // cortesia ativa (S0-9: antes só o saldo era comparado — dava falso "ok")
    const agora = Date.now();
    const cortesiaJson = (acct.grants || []).reduce((s, g) => {
      const ativa = !g.expiresAt || new Date(g.expiresAt).getTime() > agora;
      return s + (ativa ? Number(g.remainingMilli || 0) : 0);
    }, 0);
    const cortesiaPg = Number(b.cortesia_milli || 0);
    if (cortesiaJson !== cortesiaPg) divergencias.push({ user, campo: 'cortesia', json: cortesiaJson, pg: cortesiaPg });
    // plano
    if ((acct.plan || 'free') !== (b.plano || 'free')) {
      divergencias.push({ user, campo: 'plano', json: acct.plan || 'free', pg: b.plano || 'free' });
    }
    // gasto do mês (tolerância de centésimo: USD com 6 casas × arredondamento)
    const mesJson = Number((acct.spend && acct.spend.month && acct.spend.month.usd) || 0);
    const mesPg = Number(b.gasto_mes_usd || 0);
    if (Math.abs(mesJson - mesPg) > 0.01) divergencias.push({ user, campo: 'gasto_mes', json: mesJson, pg: mesPg });
  }
  return { contasJson: Object.keys(contasJson || {}).length, contasPg: linhas.length, divergencias };
}

module.exports = {
  ATIVO, debitar, estado, garantirConta, definirPlano,
  somarSaldo, darCortesia, zerarJanelas, panorama, conferir,
  pendurar, drenar,
};
