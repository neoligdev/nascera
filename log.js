// @ts-check
// ═══════════════════════════════════════════════════════════════════════
// NASCERA — logger com níveis e GATE de ambiente.
//
// Substitui os console.* espalhados. O nível é lido POR CHAMADA (não no load
// do módulo), então respeita o LOG_LEVEL que o dotenv carrega do .env depois.
//
//   LOG_LEVEL=error  → só erros
//   LOG_LEVEL=warn   → erros + avisos (bom para PRODUÇÃO: silencia o ruído)
//   LOG_LEVEL=info   → + informativo (PADRÃO)
//   LOG_LEVEL=debug  → tudo (streaming do motor, dev-server, screenshot…)
//
// Saída idêntica ao console (sem reformatar as linhas existentes): o valor aqui
// é o GATE e a centralização — um lugar para, amanhã, plugar timestamp/JSON/
// transporte externo sem tocar em 200+ call sites.
//
// Este módulo é o primeiro com checagem de tipos (`// @ts-check` + JSDoc):
// `npm run typecheck` o valida. É o padrão para adotar tipos incrementalmente.
// ═══════════════════════════════════════════════════════════════════════

/** @typedef {'error'|'warn'|'info'|'debug'} Nivel */

/** @type {Record<Nivel, number>} */
const NIVEIS = { error: 0, warn: 1, info: 2, debug: 3 };

/** Teto de verbosidade atual, lido do ambiente por chamada. @returns {number} */
function teto() {
  const v = String(process.env.LOG_LEVEL || 'info').toLowerCase();
  return v in NIVEIS ? NIVEIS[/** @type {Nivel} */ (v)] : NIVEIS.info;
}

/**
 * @param {Nivel} nivel
 * @param {any[]} args
 */
function emit(nivel, args) {
  if (NIVEIS[nivel] > teto()) return;
  const fn = nivel === 'error' ? console.error : nivel === 'warn' ? console.warn : console.log;
  fn.apply(console, args);
}

module.exports = {
  /** @param {...any} a */
  error: (...a) => emit('error', a),
  /** @param {...any} a */
  warn: (...a) => emit('warn', a),
  /** @param {...any} a */
  info: (...a) => emit('info', a),
  /** @param {...any} a */
  debug: (...a) => emit('debug', a),
  nivelAtual: () => String(process.env.LOG_LEVEL || 'info').toLowerCase(),
};
