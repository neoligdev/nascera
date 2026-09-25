// ═══════════════════════════════════════════════════════════════════════
// NASCERA — executor de migrations
//
// Por que não `CREATE TABLE IF NOT EXISTS` solto no boot: esse padrão (que o
// license-server usa hoje) não sabe o que JÁ rodou, então não dá para evoluir
// schema com segurança nem detectar divergência entre ambientes. Aqui cada
// arquivo roda UMA vez, em ordem, dentro de uma transação, e fica registrado.
//
//   node migrar.js            aplica o que falta
//   node migrar.js --status   mostra o que já rodou
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const logger = require('./log.js');
const path = require('path');
const crypto = require('crypto');
const db = require('./db.js');

const DIR = path.join(__dirname, 'migracoes');

async function garantirControle() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migracoes (
      nome       TEXT PRIMARY KEY,
      sha256     TEXT NOT NULL,
      aplicada_em TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

function arquivos() {
  try {
    return fs.readdirSync(DIR).filter(n => n.endsWith('.sql')).sort();
  } catch { return []; }
}

async function aplicar({ silencioso = false } = {}) {
  if (!db.ATIVO) return { ok: false, motivo: 'DATABASE_URL não configurada' };
  await garantirControle();

  const jaRodaram = new Map(
    (await db.query('SELECT nome, sha256 FROM _migracoes')).rows.map(r => [r.nome, r.sha256]));

  const aplicadas = [];
  for (const nome of arquivos()) {
    const sql = fs.readFileSync(path.join(DIR, nome), 'utf8');
    const hash = crypto.createHash('sha256').update(sql).digest('hex');

    if (jaRodaram.has(nome)) {
      // Migration já aplicada que MUDOU no disco: sinal de que alguém editou
      // um arquivo em vez de criar o próximo. Avisa alto — em produção isso
      // significa que o schema real e o repositório divergiram.
      if (jaRodaram.get(nome) !== hash) {
        logger.error('[migrar] ⚠ ' + nome + ' foi ALTERADA depois de aplicada. ' +
                      'Migration aplicada não se edita: crie a próxima.');
      }
      continue;
    }

    // Cada migration numa transação: ou entra inteira, ou não entra.
    await db.comTransacao(async (cli) => {
      await cli.query(sql);
      await cli.query('INSERT INTO _migracoes (nome, sha256) VALUES ($1, $2)', [nome, hash]);
    });
    aplicadas.push(nome);
    if (!silencioso) logger.info('  ✓ ' + nome);
  }
  return { ok: true, aplicadas, total: arquivos().length };
}

async function status() {
  await garantirControle();
  const r = await db.query('SELECT nome, aplicada_em FROM _migracoes ORDER BY nome');
  const noDisco = arquivos();
  const aplicadas = new Set(r.rows.map(x => x.nome));
  return {
    aplicadas: r.rows,
    pendentes: noDisco.filter(n => !aplicadas.has(n)),
  };
}

module.exports = { aplicar, status };

if (require.main === module) {
  (async () => {
    try {
      if (process.argv.includes('--status')) {
        const s = await status();
        logger.info('\nAplicadas:');
        for (const a of s.aplicadas) logger.info('  ' + a.nome + '  ' + new Date(a.aplicada_em).toLocaleString('pt-BR'));
        logger.info('\nPendentes:', s.pendentes.length ? s.pendentes.join(', ') : 'nenhuma');
      } else {
        logger.info('\n📦  Aplicando migrations…');
        const r = await aplicar();
        if (!r.ok) { logger.error('  ✖ ' + r.motivo); process.exit(1); }
        logger.info(r.aplicadas.length ? '\n  ' + r.aplicadas.length + ' aplicada(s).' : '\n  Nada a fazer — schema em dia.');
      }
      await db.encerrar();
    } catch (e) {
      logger.error('\n[migrar] FALHOU:', e.message);
      await db.encerrar();
      process.exit(1);
    }
  })();
}
