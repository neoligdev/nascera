// testes/setup-claude-auth.test.js
// Rodar: node --test testes/setup-claude-auth.test.js
//
// As rotas que TROCAM a credencial de Claude do servidor inteiro
// (claude-login-start/claude-login-code/claude-token) e a que lê o status
// (claude-auth-status) não exigiam nenhuma autenticação — qualquer um na
// internet podia logar a própria conta de Claude no lugar da do admin.
// Achado na auditoria de segurança de 2026-10-09. Este teste prova o gate.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const setupRotas = require('../rotas/setup.js');

// Mesma semântica do authMiddleware real de server.js (não é exportado à
// parte, então replicamos aqui: sem "Authorization: Bearer x" -> 401).
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  req.user = { user: 'admin' };
  next();
}

function novaApp() {
  const app = express();
  app.use(express.json());
  setupRotas.registrar(app, {
    authMiddleware,
    loadUsers: () => ({}),
    saveUsers: () => {},
    USERS: {},
    senhas: { esperaObrigatoria: () => 0, registrarErro: () => 0, limparErros: () => {} },
    signToken: () => 'tok',
    appendActivity: () => {},
    PROJECTS_BASE: '/tmp',
    tokenConfere: () => false,
    tokenDeSetup: () => 'X',
    limparTokenDeSetup: () => {},
    claudeCmd: () => '/usr/bin/true',
    isDesktopLocal: true, // evita propagar credencial de verdade no teste
  });
  return app;
}

async function semCabecalho(base, method, path, body) {
  return fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test('sem token: as 4 rotas de login do motor recusam com 401 (não iniciam nem leem login)', async (t) => {
  global._claudeLoginProc = null;
  const app = novaApp();
  const server = app.listen(0);
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;

  const r1 = await semCabecalho(base, 'POST', '/api/setup/claude-login-start');
  assert.equal(r1.status, 401, 'claude-login-start deve exigir login');

  const r2 = await semCabecalho(base, 'GET', '/api/setup/claude-auth-status');
  assert.equal(r2.status, 401, 'claude-auth-status deve exigir login');

  const r3 = await semCabecalho(base, 'POST', '/api/setup/claude-login-code', { code: '123456' });
  assert.equal(r3.status, 401, 'claude-login-code deve exigir login');

  const r4 = await semCabecalho(base, 'POST', '/api/setup/claude-token', { token: 'sk-ant-oat-x' });
  assert.equal(r4.status, 401, 'claude-token deve exigir login');
});

test('com token de admin: claude-auth-status e claude-login-code passam do portão (não é mais 401)', async (t) => {
  global._claudeLoginProc = null;
  const app = novaApp();
  const server = app.listen(0);
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const auth = { Authorization: 'Bearer tok', 'Content-Type': 'application/json' };

  const status = await fetch(base + '/api/setup/claude-auth-status', { headers: auth });
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.equal(typeof statusBody.loggedIn, 'boolean');

  // Sem processo de login pendente: resposta rápida e determinística, sem
  // precisar spawnar nada — prova que passou do `authMiddleware` e chegou
  // na lógica da rota.
  const code = await fetch(base + '/api/setup/claude-login-code', {
    method: 'POST', headers: auth, body: JSON.stringify({ code: '123456' }),
  });
  assert.equal(code.status, 200);
  const codeBody = await code.json();
  assert.equal(codeBody.success, false);
  assert.match(codeBody.error, /expirou/i);
});
