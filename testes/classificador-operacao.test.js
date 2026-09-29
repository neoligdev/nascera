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

test('estilo: Edit em arquivo .css vira ALTERAR_ESTILO (3)', () => {
  const arquivo = { caminho: 'public/estilos/tema.css', tool: 'Edit', conteudo: '.botao{color:red}', tamanhoAntes: 20, tamanhoDepois: 22 };
  assert.equal(_classificarArquivo(arquivo, {}), 'ALTERAR_ESTILO');
});

test('remover componente: Edit que encolhe MUITO o conteúdo vira REMOVER_COMPONENTE (3)', () => {
  const arquivo = { caminho: 'componentes/Banner.jsx', tool: 'Edit', conteudo: '', tamanhoAntes: 500, tamanhoDepois: 40 };
  assert.equal(_classificarArquivo(arquivo, {}), 'REMOVER_COMPONENTE');
});

test('criar componente: Write dentro de componentes/ vira CRIAR_COMPONENTE (5)', () => {
  const arquivo = { caminho: 'componentes/Novo.jsx', tool: 'Write', conteudo: 'export default function Novo(){return null}', tamanhoAntes: 0, tamanhoDepois: 45 };
  assert.equal(_classificarArquivo(arquivo, {}), 'CRIAR_COMPONENTE');
});

test('página simples: Write dentro de paginas/ sem form/dashboard vira PAGINA_SIMPLES (8)', () => {
  const arquivo = { caminho: 'paginas/sobre.html', tool: 'Write', conteudo: '<h1>Sobre nós</h1><p>texto</p>', tamanhoAntes: 0, tamanhoDepois: 30 };
  assert.equal(_classificarArquivo(arquivo, {}), 'PAGINA_SIMPLES');
});

test('correção média: Edit com contexto.pedidoDeCorrecao e sem sinal mais específico vira CORRECAO_MEDIA (14)', () => {
  const conteudo = 'ajuste de lógica no cálculo de frete '.repeat(6);   // > 200 chars, não cai em "texto pequeno"
  const arquivo = { caminho: 'servicos/frete.js', tool: 'Edit', conteudo, tamanhoAntes: 300, tamanhoDepois: 300 };
  assert.equal(_classificarArquivo(arquivo, { pedidoDeCorrecao: true }), 'CORRECAO_MEDIA');
});

test('alterar texto/botão: Edit pequeno, sem contexto de correção, vira ALTERAR_TEXTO (2)', () => {
  const arquivo = { caminho: 'paginas/sobre.html', tool: 'Edit', conteudo: 'Fale com a gente', tamanhoAntes: 12, tamanhoDepois: 16 };
  assert.equal(_classificarArquivo(arquivo, {}), 'ALTERAR_TEXTO');
});

const { classificar } = require('../servicos/classificador-operacao.js');

test('classificar: turno sem arquivo nenhum devolve soma zero', () => {
  const r = classificar([], {});
  assert.deepEqual(r, { categorias: [], totalCreditos: 0, totalCreditosBruto: 0, arquivosSemCategoria: [] });
});

test('classificar: soma de categorias diferentes em arquivos diferentes', () => {
  const arquivos = [
    { caminho: 'public/estilos/a.css', tool: 'Edit', conteudo: '.a{}', tamanhoAntes: 10, tamanhoDepois: 12 },
    { caminho: 'componentes/Novo.jsx', tool: 'Write', conteudo: 'x', tamanhoAntes: 0, tamanhoDepois: 5 },
  ];
  const r = classificar(arquivos, {});
  assert.equal(r.totalCreditos, 3 + 5);
  assert.equal(r.categorias.length, 2);
});

test('classificar: dois arquivos .css somam a MESMA categoria duas vezes (6, não 3)', () => {
  const arquivos = [
    { caminho: 'public/estilos/a.css', tool: 'Edit', conteudo: '.a{}', tamanhoAntes: 10, tamanhoDepois: 12 },
    { caminho: 'public/estilos/b.css', tool: 'Edit', conteudo: '.b{}', tamanhoAntes: 10, tamanhoDepois: 12 },
  ];
  const r = classificar(arquivos, {});
  assert.equal(r.totalCreditos, 6);
});

test('classificar: mesmo caminho repetido na entrada conta 1 vez só (defesa extra)', () => {
  const arq = { caminho: 'public/estilos/a.css', tool: 'Edit', conteudo: '.a{}', tamanhoAntes: 10, tamanhoDepois: 12 };
  const r = classificar([arq, { ...arq }], {});
  assert.equal(r.totalCreditos, 3);
  assert.equal(r.categorias.length, 1);
});

test('classificar: arquivo sem padrão fica em arquivosSemCategoria e não entra na soma', () => {
  const arquivos = [
    { caminho: 'notas/rascunho.md', tool: 'Edit', conteudo: 'sem sinal nenhum'.repeat(50), tamanhoAntes: 5000, tamanhoDepois: 5000 },
  ];
  const r = classificar(arquivos, {});
  assert.equal(r.totalCreditos, 0);
  assert.deepEqual(r.arquivosSemCategoria, ['notas/rascunho.md']);
});

test('classificar: CRUD detecta rota + página do MESMO recurso e credita os dois (22+22)', () => {
  const arquivos = [
    { caminho: 'rotas/produtos.js', tool: 'Write', conteudo: 'app.get(...)', tamanhoAntes: 0, tamanhoDepois: 300 },
    { caminho: 'public/produtos.html', tool: 'Write', conteudo: '<table>...</table>', tamanhoAntes: 0, tamanhoDepois: 300 },
  ];
  const r = classificar(arquivos, {});
  assert.equal(r.totalCreditos, 44);
  assert.ok(r.categorias.every(c => c.categoria === 'CRUD'));
});

// ── Achados da revisão final (fix pass) ─────────────────────────────────

test('Important #6: o nome do projeto no caminho ABSOLUTO não pode poluir a categoria — usa caminho relativo à raiz quando informada', () => {
  const arquivo = {
    caminho: '/home/user/Nascera AI Projects/loja-checkout/paginas/sobre.html',
    tool: 'Write', conteudo: '<h1>Sobre</h1>', tamanhoAntes: 0, tamanhoDepois: 30,
  };
  // Sem raiz: o "checkout" no nome do projeto ainda pesa (comportamento antigo).
  assert.equal(_classificarArquivo(arquivo, {}), 'PAGAMENTO_CHECKOUT');
  // Com raiz: só o caminho RELATIVO ao projeto entra na regra.
  assert.equal(
    _classificarArquivo(arquivo, { raiz: '/home/user/Nascera AI Projects/loja-checkout' }),
    'PAGINA_SIMPLES'
  );
});

test('Important #7: slug genérico (index/app/main/home/server) nunca vira grupo CRUD', () => {
  const arquivos = [
    { caminho: 'rotas/index.js', tool: 'Write', conteudo: 'app.get(...)', tamanhoAntes: 0, tamanhoDepois: 100 },
    { caminho: 'public/index.html', tool: 'Write', conteudo: '<h1>Início</h1>', tamanhoAntes: 0, tamanhoDepois: 100 },
  ];
  const r = classificar(arquivos, {});
  assert.ok(!r.categorias.some(c => c.categoria === 'CRUD'), 'index.js + index.html não deveria virar CRUD');
});

test('Important #8: diff pequeno vira ALTERAR_TEXTO (2) mesmo com palavra de correção — não CORRECAO_MEDIA (14)', () => {
  const arquivo = { caminho: 'paginas/sobre.html', tool: 'Edit', conteudo: 'Fale com a gente (corrigido)', tamanhoAntes: 12, tamanhoDepois: 28 };
  assert.equal(_classificarArquivo(arquivo, { pedidoDeCorrecao: true }), 'ALTERAR_TEXTO');
});

test('Important #9: soma nunca ultrapassa o teto por turno (a categoria mais cara da tabela, 54)', () => {
  const arquivos = [];
  for (let i = 0; i < 5; i++) {
    arquivos.push({ caminho: 'rotas/recurso' + i + '.js', tool: 'Write', conteudo: 'x', tamanhoAntes: 0, tamanhoDepois: 5 });
  }
  const r = classificar(arquivos, {});
  assert.ok(r.totalCreditosBruto > r.totalCreditos, 'deveria ter clampado');
  assert.equal(r.totalCreditos, 54);
});
