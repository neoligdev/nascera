// ═══════════════════════════════════════════════════════════════════════
// NASCERA — perguntas sobre o sistema, sem chamar binário de shell
//
// Duas perguntas que o NASCERA faz o tempo todo e que, até aqui, eram
// respondidas disparando um processo Unix:
//
//   "o que aconteceu no fim deste log?"   →  tail -80 "arquivo"
//   "tem alguém servindo nesta porta?"    →  lsof -i :3000 -t
//
// No Windows nenhum dos dois existe: a aba de logs vinha sempre vazia e a
// detecção de preview disparava QUINZE processos inúteis por projeto (um por
// porta da lista) para não achar nada.
//
// A troca não é um `if (process.platform === 'win32')`. É API de Node, que
// responde a mesma pergunta nos três sistemas — e responde melhor:
// `lsof` diz "alguém abriu esta porta", enquanto conectar de verdade diz
// "alguém está ACEITANDO conexão nela", que é o que o preview precisa saber.
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const net = require('net');

// Quanto do fim do arquivo lemos de uma vez. 80 linhas de log cabem MUITO
// folgadamente em 256 KB, e ler só o rabo é o que impede um log de 2 GB de
// virar 2 GB de memória — que era a razão de o código original usar `tail`.
const JANELA = 256 * 1024;

/**
 * As últimas `n` linhas de um arquivo de texto, sem carregá-lo inteiro.
 *
 * @param {string} arquivo - Caminho do arquivo.
 * @param {number} [n] - Quantas linhas do fim.
 * @returns {string} As linhas, ou '' se o arquivo não existir/não puder ser lido.
 */
function ultimasLinhas(arquivo, n = 80) {
  let fd;
  try {
    const tamanho = fs.statSync(arquivo).size;
    if (!tamanho) return '';
    fd = fs.openSync(arquivo, 'r');
    const quanto = Math.min(tamanho, JANELA);
    const buf = Buffer.alloc(quanto);
    fs.readSync(fd, buf, 0, quanto, tamanho - quanto);

    let texto = buf.toString('utf8');
    // Se o arquivo é maior que a janela, cortamos no meio de uma linha (e
    // possivelmente no meio de um caractere multibyte). Descartar até a
    // primeira quebra devolve só linhas inteiras — o mesmo que o tail faria.
    if (quanto < tamanho) {
      const primeiraQuebra = texto.indexOf('\n');
      texto = primeiraQuebra === -1 ? '' : texto.slice(primeiraQuebra + 1);
    }

    const linhas = texto.split('\n');
    // Um log terminado em '\n' produz um último elemento vazio, que contaria
    // como linha e comeria uma das N pedidas.
    if (linhas.length && linhas[linhas.length - 1] === '') linhas.pop();
    return linhas.slice(-n).join('\n');
  } catch {
    return '';                       // arquivo ausente é resposta, não erro
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

/**
 * Tem alguém aceitando conexão nesta porta, aqui nesta máquina?
 *
 * @param {number} porta
 * @param {object} [opcoes]
 * @param {number} [opcoes.timeout] - Teto em ms (o padrão é curto de propósito:
 *   é loopback, então ou responde na hora ou não tem ninguém).
 * @param {string} [opcoes.host]
 * @returns {Promise<boolean>}
 */
function portaEmUso(porta, opcoes = {}) {
  const timeout = opcoes.timeout || 300;
  const host = opcoes.host || '127.0.0.1';
  return new Promise((resolve) => {
    const soquete = new net.Socket();
    let respondido = false;
    const responder = (valor) => {
      if (respondido) return;
      respondido = true;
      // destroy() antes de resolver: sem isso, um servidor que aceita e não
      // fala nada deixaria o soquete pendurado segurando o event loop.
      soquete.destroy();
      resolve(valor);
    };
    soquete.setTimeout(timeout);
    soquete.once('connect', () => responder(true));
    soquete.once('timeout', () => responder(false));
    soquete.once('error', () => responder(false));
    soquete.connect(porta, host);
  });
}

/**
 * A primeira porta da lista que estiver em uso, ou null.
 * Sonda todas em paralelo: quinze portas em série, mesmo com timeout curto,
 * somariam segundos de espera antes de o preview aparecer.
 *
 * @param {number[]} portas
 * @param {object} [opcoes] - Repassado a `portaEmUso`.
 * @returns {Promise<number|null>}
 */
async function primeiraPortaEmUso(portas, opcoes = {}) {
  const respostas = await Promise.all(portas.map((p) => portaEmUso(p, opcoes)));
  const i = respostas.findIndex(Boolean);
  return i === -1 ? null : portas[i];
}

module.exports = { ultimasLinhas, portaEmUso, primeiraPortaEmUso };
