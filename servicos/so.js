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

// ─── ambiente de processo filho ──────────────────────────────────────
// O servidor carrega o `.env` no próprio `process.env` (dotenv). Todo filho
// que herda o ambiente inteiro leva junto o JWT_SECRET — e o filho, aqui, é o
// motor de IA de um cliente: bastava pedir "rode `env`" para ler o segredo que
// assina o token de admin.
//
// Lista EXATA, não padrão por nome: instalação que autentica o motor por
// ANTHROPIC_API_KEY no ambiente precisa que ela chegue lá.
const SEGREDOS_DO_SERVIDOR = /^(JWT_SECRET|AUTH_USER|AUTH_PASS|DATABASE_URL|NASCERA_.*|pm_.*|PM2_.*|pm2_.*)$/;

/**
 * Ambiente para o processo do MOTOR: o do servidor menos os segredos dele.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, string>}
 */
function ambienteDoMotor(env = process.env) {
  const limpo = {};
  for (const [k, v] of Object.entries(env)) {
    if (v == null || SEGREDOS_DO_SERVIDOR.test(k)) continue;
    limpo[k] = v;
  }
  return limpo;
}

// Código do CLIENTE (o `npm run dev` do projeto dele) é outra conversa: não
// recebe credencial NENHUMA da instalação — nem a chave da Anthropic, nem
// token de integração. Aqui o filtro é por padrão de nome, de propósito largo.
const PARECE_SEGREDO = /SECRET|PASS|TOKEN|KEY|CREDENTIAL|DATABASE_URL|^AUTH_/i;

/**
 * Ambiente para código de projeto de cliente.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, string>}
 */
function ambienteDeCliente(env = process.env) {
  const limpo = {};
  for (const [k, v] of Object.entries(ambienteDoMotor(env))) {
    if (!PARECE_SEGREDO.test(k)) limpo[k] = v;
  }
  return limpo;
}

// ─── alvo de proxy do preview ────────────────────────────────────────
// `proxyTarget` e `previewUrl` vêm do usuário (e de arquivos do projeto dele).
// Sem conferência, o preview encaminhava requisição para onde ele mandasse: a
// API administrativa do Caddy (127.0.0.1:2019), o próprio painel, outra
// máquina da rede. E o teste antigo — `startsWith('http://localhost')` —
// aprovava `http://localhost.evil.com`.
//
// Só vale dev server local: http, localhost, porta alta que não seja de um
// serviço desta máquina. Devolve a forma normalizada ou null.
function portasDeServico() {
  return new Set([
    2019, 5432,
    Number(process.env.PORT) || 3333,
    Number(process.env.PREVIEW_PORT) || 4001,
    Number(process.env.PUBLISH_PORT) || 4102, 4002,
  ]);
}

/**
 * @param {unknown} alvo
 * @returns {string|null} `http://localhost:<porta>` ou null se não for seguro.
 */
function alvoDeProxySeguro(alvo) {
  let u;
  try { u = new URL(String(alvo)); } catch { return null; }
  if (u.protocol !== 'http:' || u.username || u.password) return null;
  if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return null;
  const porta = Number(u.port);
  if (!(porta >= 1024 && porta <= 65535) || portasDeServico().has(porta)) return null;
  return 'http://localhost:' + porta;
}

module.exports = {
  ultimasLinhas, portaEmUso, primeiraPortaEmUso,
  ambienteDoMotor, ambienteDeCliente, alvoDeProxySeguro,
};
