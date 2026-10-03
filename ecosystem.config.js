// ═══════════════════════════════════════════════════════════════════════
// NASCERA — configuração do PM2 (por máquina, fora do git)
//
// Sobe os 3 processos do produto e, na primeira execução, cria o `.env`
// desta instalação com segredos únicos (nunca sobrescreve o que já existir —
// só acrescenta a linha que falta). Ver README.md, seção "Configuração".
//
// `server.js` lê o próprio `.env` via dotenv, então só precisa existir.
// `preview-server.js` e `publish-server.js` NÃO leem `.env`: dependem de
// receber `PORT` já pronto no ambiente do processo — é este arquivo que
// traduz `PREVIEW_PORT`/`PUBLISH_PORT` do `.env` para o `PORT` de cada um.
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV_PATH = path.join(__dirname, '.env');

function gerarSenha(tamanho = 20) {
  return crypto.randomBytes(tamanho * 2)
    .toString('base64')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, tamanho);
}

// Cria o .env se não existir; se existir, só acrescenta chaves que faltam.
function garantirEnv() {
  let existente = '';
  try { existente = fs.readFileSync(ENV_PATH, 'utf8'); } catch {}
  const jaTem = new Set(
    existente.split('\n').map((l) => (l.match(/^([A-Z_]+)=/) || [])[1]).filter(Boolean)
  );

  const novas = [];
  const acrescentar = (chave, valorFn) => {
    if (!jaTem.has(chave)) novas.push(`${chave}=${valorFn()}`);
  };

  acrescentar('PORT', () => '3333');
  acrescentar('JWT_SECRET', () => crypto.randomBytes(48).toString('hex'));
  acrescentar('PREVIEW_PORT', () => '4001');
  acrescentar('PUBLISH_PORT', () => '4102');
  acrescentar('AUTH_USER', () => 'admin');
  acrescentar('AUTH_PASS', () => gerarSenha());

  if (novas.length) {
    const prefixo = existente && !existente.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(ENV_PATH, existente + prefixo + novas.join('\n') + '\n', { mode: 0o600 });
  }
  try { fs.chmodSync(ENV_PATH, 0o600); } catch {}
}

garantirEnv();
require('dotenv').config({ path: ENV_PATH });

// Os três processos escutam só em 127.0.0.1: quem atende a internet é o proxy
// (Caddy), e nenhum deles tem por que aceitar conexão direta de fora. Quem
// roda SEM proxy na frente define NASCERA_BIND=0.0.0.0 no `.env`, de propósito.
const BIND = process.env.NASCERA_BIND || '127.0.0.1';

const BASE = {
  cwd: __dirname,
  autorestart: true,
  max_restarts: 10,
  restart_delay: 2000,
};

module.exports = {
  apps: [
    {
      ...BASE,
      name: 'nascera',
      script: 'server.js',
      env: { PORT: process.env.PORT || '3333', NASCERA_BIND: BIND },
      max_memory_restart: '1G',
    },
    {
      ...BASE,
      name: 'nascera-preview',
      script: 'preview-server.js',
      env: { PORT: process.env.PREVIEW_PORT || '4001', NASCERA_BIND: BIND },
      max_memory_restart: '512M',
    },
    {
      ...BASE,
      name: 'nascera-publish',
      script: 'publish-server.js',
      env: { PORT: process.env.PUBLISH_PORT || '4102', NASCERA_BIND: BIND },
      max_memory_restart: '512M',
    },
  ],
};
