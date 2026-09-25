// ═══════════════════════════════════════════════════════════════════════
// NASCERA — Onde está o Chrome
//
// O extrator de UX e o gerador de thumbnail precisam de um navegador. Cada um
// resolvia isso de um jeito: o extrator confiava no Chrome que o puppeteer
// baixa (que não existia na VPS → "Could not find Chrome"), e o thumbnail
// varria uma lista de caminhos fixos. Resultado: um funcionava e o outro não,
// na mesma máquina.
//
// Aqui a busca é uma só, em ordem de confiabilidade:
//   1. PUPPETEER_EXECUTABLE_PATH — quem administra a máquina manda.
//   2. O Chrome for Testing que o puppeteer baixa. É a versão que ele
//      espera; é o caminho feliz.
//   3. Chrome/Chromium do sistema.
//
// Snap fica por último de propósito: o /usr/bin/chromium-browser do Ubuntu é
// um invólucro de snap, confinado por AppArmor. Ele até abre, mas trava ao
// escrever perfil temporário — falha estranha e difícil de diagnosticar.
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');

const CAMINHOS_SISTEMA = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/opt/google/chrome/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  // por último: invólucros de snap
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

function existe(p) {
  try { return !!p && fs.existsSync(p); } catch { return false; }
}

// Devolve o caminho do executável, ou null se não houver navegador na máquina.
function acharChrome() {
  if (existe(process.env.PUPPETEER_EXECUTABLE_PATH)) return process.env.PUPPETEER_EXECUTABLE_PATH;
  try {
    const p = require('puppeteer').executablePath();
    if (existe(p)) return p;
  } catch {}
  for (const p of CAMINHOS_SISTEMA) if (existe(p)) return p;
  return null;
}

// Mensagem que diz o que fazer, em vez de despejar um stack trace do
// puppeteer na cara de quem só queria extrair um site.
const COMO_RESOLVER =
  'Nenhum navegador encontrado nesta máquina. No servidor, rode:\n' +
  '  cd <pasta do nascera> && npx puppeteer browsers install chrome\n' +
  '  apt-get install -y libnss3 libnspr4\n' +
  'Ou aponte um Chrome já instalado em PUPPETEER_EXECUTABLE_PATH.';

// Opções de launch com o executável já resolvido.
function opcoesDeLaunch(extra = {}) {
  const executablePath = acharChrome();
  if (!executablePath) { const e = new Error(COMO_RESOLVER); e.code = 'SEM_CHROME'; throw e; }
  return {
    headless: 'new',
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      ...(extra.args || [])],
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'args')),
  };
}

module.exports = { acharChrome, opcoesDeLaunch, COMO_RESOLVER };
