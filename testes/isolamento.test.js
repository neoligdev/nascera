// testes/isolamento.test.js
// Rodar: node --test testes/isolamento.test.js
//
// Duas portas por onde o código de um cliente saía da pasta dele:
//   · o alvo de proxy do preview vinha do usuário sem conferência (SSRF: a API
//     administrativa do Caddy em 127.0.0.1:2019, o próprio painel, outra máquina);
//   · o dev server do projeto herdava o ambiente inteiro do servidor, com
//     JWT_SECRET e AUTH_PASS dentro.
const test = require('node:test');
const assert = require('node:assert/strict');
const so = require('../servicos/so.js');
const { ambienteDoDevServer } = require('../servicos/preview-runtime.js');

test('alvoDeProxySeguro: só dev server local, em porta que não é de serviço da máquina', () => {
  assert.equal(so.alvoDeProxySeguro('http://localhost:5173'), 'http://localhost:5173');
  assert.equal(so.alvoDeProxySeguro('http://127.0.0.1:3000/app'), 'http://localhost:3000');
  for (const ruim of [
    'http://localhost:2019',            // API administrativa do Caddy
    'http://localhost:3333',            // o próprio painel
    'http://localhost:4001',            // servidor de preview, sem autenticação
    'http://localhost:22', 'http://localhost:80', 'http://localhost',
    'http://localhost.evil.com:3000',   // passava no `startsWith('http://localhost')`
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.5:3000', 'https://localhost:3000', 'file:///etc/passwd',
    'http://user:senha@localhost:3000', 'nada', '', null, undefined,
  ]) {
    assert.equal(so.alvoDeProxySeguro(ruim), null, String(ruim));
  }
});

test('ambienteDoDevServer: nenhum segredo do servidor vai para o processo do cliente', () => {
  const env = ambienteDoDevServer(3456, {
    PATH: '/usr/bin', HOME: '/root', LANG: 'C.UTF-8',
    JWT_SECRET: 'x', AUTH_PASS: 'x', AUTH_USER: 'admin', DATABASE_URL: 'postgres://x',
    ANTHROPIC_API_KEY: 'x', GITHUB_TOKEN: 'x', NASCERA_LICENSE_KEY: 'x', SMTP_PASSWORD: 'x',
    pm_id: '0', PM2_HOME: '/root/.pm2',
  });
  assert.deepEqual(Object.keys(env).sort(), ['BROWSER', 'HOME', 'LANG', 'NO_COLOR', 'PATH', 'PORT']);
  assert.equal(env.PORT, '3456');
});
