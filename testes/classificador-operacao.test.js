// testes/classificador-operacao.test.js
// Rodar: node --test testes/classificador-operacao.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { _classificarArquivo } = require('../servicos/classificador-operacao.js');

test('pagamento/checkout: path com "checkout" vira PAGAMENTO_CHECKOUT (27)', () => {
  const arquivo = { caminho: 'rotas/checkout.js', tool: 'Write', conteudo: 'app.post(...)', tamanhoAntes: 0, tamanhoDepois: 80 };
  assert.equal(_classificarArquivo(arquivo, {}), 'PAGAMENTO_CHECKOUT');
});

test('login/cadastro: path com "login" vira LOGIN_CADASTRO (14)', () => {
  const arquivo = { caminho: 'public/login.html', tool: 'Write', conteudo: '<h1>Entrar</h1>', tamanhoAntes: 0, tamanhoDepois: 40 };
  assert.equal(_classificarArquivo(arquivo, {}), 'LOGIN_CADASTRO');
});

test('upload/storage: conteúdo com "multer" vira UPLOAD_STORAGE (16)', () => {
  const arquivo = { caminho: 'rotas/anexos.js', tool: 'Write', conteudo: "const multer = require('multer');", tamanhoAntes: 0, tamanhoDepois: 60 };
  assert.equal(_classificarArquivo(arquivo, {}), 'UPLOAD_STORAGE');
});

test('dashboard: conteúdo com <canvas> vira DASHBOARD (25)', () => {
  const arquivo = { caminho: 'paginas/relatorios.html', tool: 'Write', conteudo: '<div><canvas id="g1"></canvas></div>', tamanhoAntes: 0, tamanhoDepois: 50 };
  assert.equal(_classificarArquivo(arquivo, {}), 'DASHBOARD');
});

test('formulário+validação: conteúdo com <form> e required vira FORMULARIO_VALIDACAO (10)', () => {
  const arquivo = { caminho: 'paginas/contato.html', tool: 'Write', conteudo: '<form><input required></form>', tamanhoAntes: 0, tamanhoDepois: 40 };
  assert.equal(_classificarArquivo(arquivo, {}), 'FORMULARIO_VALIDACAO');
});

test('API: path dentro de rotas/ sem sinal mais específico vira API (20)', () => {
  const arquivo = { caminho: 'rotas/produtos.js', tool: 'Edit', conteudo: 'res.json(produtos)', tamanhoAntes: 100, tamanhoDepois: 120 };
  assert.equal(_classificarArquivo(arquivo, {}), 'API');
});

test('sem padrão nenhum: devolve null (cai no custo real)', () => {
  const arquivo = { caminho: 'notas/rascunho.md', tool: 'Edit', conteudo: 'anotação qualquer sem nenhum sinal reconhecível', tamanhoAntes: 5000, tamanhoDepois: 5000 };
  assert.equal(_classificarArquivo(arquivo, {}), null);
});
