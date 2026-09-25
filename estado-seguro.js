// ═══════════════════════════════════════════════════════════════════════
// NASCERA — Escrita e leitura segura de estado
//
// Existe por causa de uma falha crítica confirmada na auditoria: TODO save
// reescrevia o arquivo inteiro com `fs.writeFileSync` puro (sem tmp+rename,
// sem fsync) e TODO load fazia `catch { return [] }`. Um único crash no meio
// de uma gravação truncava o arquivo; no boot seguinte o catch engolia o
// erro de parse e devolvia VAZIO; a primeira gravação seguinte persistia esse
// vazio por cima — apagão silencioso e total de projetos, do saldo de todos
// os clientes ou de todos os usuários.
//
// Duas garantias, uma regra:
//   · gravaEstado — escreve atômico (tmp+fsync+rename, via write-file-atomic)
//     e guarda o último bom em `.bak` antes de sobrescrever.
//   · leEstado — no parse-fail NUNCA devolve vazio por cima de um arquivo que
//     existe: tenta o `.bak`; se for estado CRÍTICO e ambos falharem, ABORTA
//     o boot em vez de mascarar a perda.
//
// Regra de ouro: "arquivo não existe" (ENOENT) é vazio legítimo; "arquivo
// existe mas não parseia" é corrupção, e corrupção não vira vazio em silêncio.
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const logger = require('./log.js');
const writeFileAtomic = require('write-file-atomic');

// Escreve de forma atômica. Como o rename é atômico, o arquivo final nunca
// fica meio-escrito — o cenário do apagão deixa de existir na origem.
function gravaEstado(arquivo, dados, opcoes = {}) {
  const pretty = opcoes.pretty === undefined ? 2 : opcoes.pretty;
  const texto = pretty ? JSON.stringify(dados, null, pretty) : JSON.stringify(dados);
  // O arquivo atual sempre é completo (foi escrito atômico da última vez),
  // então copiá-lo para .bak preserva um último-bom de verdade.
  try { if (fs.existsSync(arquivo)) fs.copyFileSync(arquivo, arquivo + '.bak'); } catch {}
  writeFileAtomic.sync(arquivo, texto);   // tmp + fsync + rename
}

// Lê e parseia. `fallback` é o valor de arquivo inexistente. `critico:true`
// faz a corrupção sem backup ABORTAR (throw) em vez de devolver fallback.
function leEstado(arquivo, opcoes = {}) {
  const fallback = opcoes.fallback;
  const critico = !!opcoes.critico;

  try {
    return JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') return fallback;   // nunca existiu: vazio é legítimo
    logger.error('[estado] parse falhou em ' + arquivo + ': ' + (e && e.message) + ' — tentando .bak');
  }

  try {
    const dados = JSON.parse(fs.readFileSync(arquivo + '.bak', 'utf8'));
    logger.error('[estado] recuperado de ' + arquivo + '.bak');
    return dados;
  } catch { /* .bak também falhou */ }

  if (critico) {
    throw new Error(
      'ESTADO CRÍTICO CORROMPIDO e sem backup válido: ' + arquivo + '\n' +
      'O boot foi abortado de propósito para NÃO sobrescrever com vazio e apagar ' +
      'dados de verdade. Restaure ' + arquivo + ' (ou ' + arquivo + '.bak) e suba de novo.');
  }
  logger.error('[estado] ' + arquivo + ' irrecuperável; usando fallback (não-crítico)');
  return fallback;
}

module.exports = { gravaEstado, leEstado };
