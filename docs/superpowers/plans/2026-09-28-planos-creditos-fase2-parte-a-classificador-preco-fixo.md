# Plano de Implementação — Parte A: Classificador de operação + preço fixo

> **Para agentes:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recomendado) ou `superpowers:executing-plans` para executar este plano tarefa a tarefa. Passos usam `- [ ]` para rastreio.

**Goal:** Fazer o classificador de operação (heurística por padrão de arquivo, pós-turno) decidir uma cobrança em créditos FIXOS por turno, coexistindo com o custo real em tokens (que continua sempre calculado para auditoria de margem), com um toggle de admin (`precoFixoAtivo`, default `false`) e um endpoint de estimativa prévia aproximada no composer.

**Architecture:** Um serviço novo e puro (`servicos/classificador-operacao.js`, sem I/O) recebe a lista de arquivos tocados no turno (montada por `servicos/motor-canal.js` a partir dos eventos `tool_use`, sem git diff) e devolve categorias + soma de créditos. `billing.js` ganha um campo opcional `creditosFixos` em `debitTurn`, que substitui o `costMilli` derivado do custo real SÓ quando `cfg.billing.precoFixoAtivo` está ligado — toda a mecânica de ordem/idempotência/ledger a partir do `costMilli` permanece intocada. Uma segunda heurística, menor e independente (em `rotas/compras.js`), classifica a INTENÇÃO do texto ainda não enviado para a estimativa prévia — não reusa o classificador de resultado, porque antes do envio não existe arquivo tocado nenhum.

**Tech Stack:** Node.js/Express, sem TypeScript, `node --test` (`node:test` + `node:assert/strict`), sem dependências novas.

**Spec:** `docs/superpowers/specs/2026-09-28-planos-creditos-fase2-design.md` (seções A.1–A.4, "Arquivos críticos", "Riscos e decisões a confirmar", "Plano de testes" — Parte A apenas; Parte B fora de escopo deste plano — ver o plano irmão de pacotes avulsos).

## Global Constraints

- O classificador é heurística por padrão de arquivo/diff, PÓS-turno — nunca chama IA, nunca custa tokens extra (decisão fechada da spec, não reabrir).
- Turno com múltiplas categorias soma os créditos de cada categoria encontrada, por ARQUIVO ÚNICO tocado (um arquivo tocado 2x no turno conta 1 vez).
- Turno em que NENHUM arquivo bate com nenhum padrão cai inteiro no custo real já existente (nunca cobra errado por falta de reconhecimento).
- `priceTurn()` (custo real) roda em TODO turno, sem exceção — alimenta o dashboard de margem mesmo com preço fixo ativo.
- Quando `cfg.billing.precoFixoAtivo` está ligado E `creditosFixos` foi informado, ele decide `costMilli`; a partir daí bônus→premium 90%→comprado→overage, idempotência por `turnId`, ledger append-only e espelho Postgres continuam EXATAMENTE como na Fase 1, sem lógica duplicada.
- `precoFixoAtivo` nasce `false` (mesmo padrão de `pipelineAutomatico` e `motor2.ligado`) — comportamento visível hoje não muda até o admin ligar.
- A estimativa prévia (`POST /api/billing/estimar`) usa um classificador de INTENÇÃO separado e mais simples, deliberadamente aproximado, nunca o valor exato cobrado.
- Simplificação desta implementação (documentar, não reabrir): "Landing page completa" (17cr), "Refatoração grande" (36cr) e "Módulo complexo" (54cr) são categorias de AGREGADO do turno inteiro, sem um classificador de agregado dedicado — são aproximadas pela SOMA das categorias finas por arquivo (ex.: 3 arquivos "Página simples" @8 somam 24, próximo do valor fixo de uma landing). Se a telemetria real mostrar divergência grande, aí sim vale um passo de agregação por cima — não antes de medir.

## Review Focus

1. **Toggle desligado (default) não muda nada da Fase 1** — mesmo se `creditosFixos` vier preenchido no `turn`, `debitTurn` deve produzir `costMilli`/`chargedUsd`/ledger byte-idênticos ao cálculo antigo. Coberto no Task 7 (teste de regressão explícito).
2. **Turno sem nenhum arquivo tocado** — `classificar([], contexto)` não pode explodir nem inventar categoria; deve devolver soma zero e a chamada em `motor-canal.js` não deve passar `creditosFixos` para `debitTurn` (cai no custo real). Coberto no Task 3 e no Task 6.
3. **Arquivo sem nenhum padrão reconhecido** — precisa aparecer em `arquivosSemCategoria`, nunca entrar na soma, e (quando é o ÚNICO arquivo do turno) o turno inteiro cai no fallback de custo real. Coberto no Task 3.
4. **Soma correta de múltiplos arquivos na MESMA categoria** — dois arquivos `.css` editados somam 3+3=6, não 3; um arquivo repetido na lista de entrada (defesa extra, já que a fonte real é um `Map` deduplicado) não pode ser contado 2x. Coberto no Task 3.
5. **Idempotência do `turnId` com `creditosFixos`** — um retry do mesmo `turnId`, com preço fixo ativo, deve devolver `duplicate:true` e não debitar de novo (mesma garantia da Fase 1, agora testada também no caminho de preço fixo). Coberto no Task 7.

---

## Task 1: `servicos/classificador-operacao.js` — padrões de path/conteúdo (sem tamanho, sem CRUD)

**Files:**
- Create: `servicos/classificador-operacao.js`
- Test: `testes/classificador-operacao.test.js`

**Interfaces:**
- Consumes: nada (arquivo novo, sem dependências de outros serviços).
- Produces: `classificarArquivo(arquivo, contexto)` → nome da categoria (string) ou `null`. `arquivo = { caminho, tool, conteudo, tamanhoAntes, tamanhoDepois }`. Usado pelas Tasks 2 e 3 e, indiretamente, por `classificar()` (Task 3).

- [ ] **Step 1: Escrever o teste que falha**

```js
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
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `node --test testes/classificador-operacao.test.js`
Expected: FAIL — `Cannot find module '../servicos/classificador-operacao.js'`

- [ ] **Step 3: Implementação mínima**

```js
// servicos/classificador-operacao.js
//
// Classificador de RESULTADO (pós-turno, Fase 2, doc §5): dado o conjunto de
// arquivos tocados por um turno (Write/Edit/MultiEdit/NotebookEdit),
// devolve, por arquivo, qual categoria comercial foi entregue. Mesmo espírito
// do classificador de servicos/planejamento-automatico.js: heurística v1
// simples por padrão de arquivo/conteúdo, sem custo de IA, documentada como
// recalibrável com telemetria real — não vale a complexidade de IA agora.
//
// Entrada por arquivo (montada por servicos/motor-canal.js a partir dos
// eventos `tool_use`, sem git diff):
//   { caminho: string, tool: 'Write'|'Edit'|'MultiEdit'|'NotebookEdit',
//     conteudo: string, tamanhoAntes: number, tamanhoDepois: number }
// `conteudo` é o texto novo relevante pra regex de padrão (o `content` do
// Write; a concatenação dos `new_string` do Edit/MultiEdit).

const CREDITOS = {
  ALTERAR_TEXTO: 2,
  ALTERAR_ESTILO: 3,
  REMOVER_COMPONENTE: 3,
  CRIAR_COMPONENTE: 5,
  PAGINA_SIMPLES: 8,
  FORMULARIO_VALIDACAO: 10,
  LOGIN_CADASTRO: 14,
  CORRECAO_MEDIA: 14,
  UPLOAD_STORAGE: 16,
  API: 20,
  CRUD: 22,
  DASHBOARD: 25,
  PAGAMENTO_CHECKOUT: 27,
};

const RE_PAGAMENTO = /pagamento|checkout|payment|gateway|stripe|mercadopago|mercado[-_]?pago|hotmart|kiwify|asaas/i;
const RE_AUTH = /\bauth\b|autenticacao|autentica[çc][aã]o|\blogin\b|cadastro|\bsenha\b|password|signup|signin/i;
const RE_UPLOAD = /upload|storage|multer|presigned|multipart\/form-data|\bs3\./i;
const RE_DASHBOARD = /chart\.js|recharts|apexcharts|d3\.|<canvas|dashboard[-_]?widget|gr[aá]fico/i;
const RE_FORMULARIO = /<form[\s>]|type=["']submit["']|\brequired\b|\.validate\(|yup\.|zod\.|schema\.validate/i;
const RE_API_PATH = /(^|[\\/])(rotas|routes|api)[\\/]/i;

function normCaminho(c) { return String(c || '').replace(/\\/g, '/'); }

// Classifica UM arquivo (fora de qualquer agrupamento cross-file — ver
// Task 3 para CRUD). Ordem = mais específico primeiro; um arquivo que bate
// em mais de um padrão fica com o PRIMEIRO que casar.
function classificarArquivo(arquivo, contexto) {
  const caminho = normCaminho(arquivo.caminho);
  const conteudo = String(arquivo.conteudo || '');

  if (RE_PAGAMENTO.test(caminho) || RE_PAGAMENTO.test(conteudo)) return 'PAGAMENTO_CHECKOUT';
  if (RE_AUTH.test(caminho) || RE_AUTH.test(conteudo)) return 'LOGIN_CADASTRO';
  if (RE_UPLOAD.test(caminho) || RE_UPLOAD.test(conteudo)) return 'UPLOAD_STORAGE';
  if (RE_DASHBOARD.test(conteudo)) return 'DASHBOARD';
  if (RE_FORMULARIO.test(conteudo)) return 'FORMULARIO_VALIDACAO';
  if (RE_API_PATH.test(caminho)) return 'API';
  return null;   // Task 2 adiciona os padrões de tamanho/estilo/correção aqui
}

module.exports = { CREDITOS, _classificarArquivo: classificarArquivo };
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `node --test testes/classificador-operacao.test.js`
Expected: PASS (7 testes)

- [ ] **Step 5: Commit**

```bash
git add servicos/classificador-operacao.js testes/classificador-operacao.test.js
git commit -m "feat(billing): classificador de operação — padrões de path/conteúdo (parte 1)"
```

---

## Task 2: `servicos/classificador-operacao.js` — heurísticas de tamanho + estilo + correção média

**Files:**
- Modify: `servicos/classificador-operacao.js`
- Test: `testes/classificador-operacao.test.js`

**Interfaces:**
- Consumes: `classificarArquivo` do Task 1 (mesma assinatura, corpo estendido).
- Produces: `classificarArquivo` completo (todas as 12 categorias por-arquivo, exceto CRUD). `contexto = { pedidoDeCorrecao: boolean }` — usado pela Task 4/6.

- [ ] **Step 1: Escrever o teste que falha**

```js
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
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `node --test testes/classificador-operacao.test.js`
Expected: FAIL — os 6 testes novos recebem `null` em vez da categoria esperada.

- [ ] **Step 3: Implementação mínima**

```js
// servicos/classificador-operacao.js — adicionar acima de classificarArquivo()

// Limiares da heurística v1 (arbitrários — Risco #2 do doc: "página simples"
// vs. "landing" vs. "módulo complexo" têm fronteira nebulosa por natureza;
// estes valores são o ponto de partida, ajustável depois de medir telemetria
// real, sem precisar reabrir o classificador).
const LIMIAR_DIFF_PEQUENO = 200;    // chars: acima disso não é mais "ajuste de texto"
const LIMIAR_REMOCAO_MIN = 80;      // chars removidos p/ contar como "remoção de bloco"
const LIMIAR_REMOCAO_RATIO = 0.5;   // tamanhoDepois precisa ser <= 50% do tamanhoAntes

const RE_CSS_PATH = /\.(css|scss|less)$/i;
const RE_CSS_INLINE = /style=\{|<style[\s>]/i;
const RE_COMPONENTE_PATH = /(^|[\\/])(componentes|components)[\\/]/i;
const RE_PAGINA_PATH = /(^|[\\/])(paginas|pages)[\\/]|\.html$/i;

// Substituir o `return null;` do fim de classificarArquivo() por:
function classificarArquivo(arquivo, contexto) {
  const caminho = normCaminho(arquivo.caminho);
  const conteudo = String(arquivo.conteudo || '');
  const criado = arquivo.tool === 'Write';
  const antes = arquivo.tamanhoAntes || 0;
  const depois = arquivo.tamanhoDepois || 0;

  if (RE_PAGAMENTO.test(caminho) || RE_PAGAMENTO.test(conteudo)) return 'PAGAMENTO_CHECKOUT';
  if (RE_AUTH.test(caminho) || RE_AUTH.test(conteudo)) return 'LOGIN_CADASTRO';
  if (RE_UPLOAD.test(caminho) || RE_UPLOAD.test(conteudo)) return 'UPLOAD_STORAGE';
  if (RE_DASHBOARD.test(conteudo)) return 'DASHBOARD';
  if (RE_FORMULARIO.test(conteudo)) return 'FORMULARIO_VALIDACAO';
  if (RE_API_PATH.test(caminho)) return 'API';

  // Daqui pra baixo só se aplica a EDIT (arquivo já existia) — Write cai nas
  // categorias de criação mais abaixo.
  if (!criado) {
    if (RE_CSS_PATH.test(caminho) || RE_CSS_INLINE.test(conteudo)) return 'ALTERAR_ESTILO';
    if (antes >= LIMIAR_REMOCAO_MIN && depois <= antes * LIMIAR_REMOCAO_RATIO) return 'REMOVER_COMPONENTE';
  }

  if (criado && RE_COMPONENTE_PATH.test(caminho)) return 'CRIAR_COMPONENTE';
  if (criado && RE_PAGINA_PATH.test(caminho)) return 'PAGINA_SIMPLES';

  // "Correção média" reaproveita o sinal do classificador de planejamento
  // (contexto.pedidoDeCorrecao) — só depois de estilo/remoção/criação/página,
  // porque essas são sinais mais específicos sobre O QUE mudou; correção é
  // o "catch-all" de um pedido de fix que não é nenhuma delas.
  if (!criado && contexto && contexto.pedidoDeCorrecao) return 'CORRECAO_MEDIA';

  if (!criado && depois <= LIMIAR_DIFF_PEQUENO) return 'ALTERAR_TEXTO';

  return null;   // nenhum padrão bate — cai no fallback de custo real
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `node --test testes/classificador-operacao.test.js`
Expected: PASS (13 testes)

- [ ] **Step 5: Commit**

```bash
git add servicos/classificador-operacao.js testes/classificador-operacao.test.js
git commit -m "feat(billing): classificador de operação — tamanho de edição, estilo e correção média (parte 2)"
```

---

## Task 3: `servicos/classificador-operacao.js` — CRUD cross-file, dedup, soma e `classificar()` público

**Files:**
- Modify: `servicos/classificador-operacao.js`
- Test: `testes/classificador-operacao.test.js`

**Interfaces:**
- Consumes: `classificarArquivo` (Tasks 1–2), `CREDITOS`.
- Produces: `classificar(arquivosTocados, contextoProjeto)` → `{ categorias: [{caminho, categoria, creditos}], totalCreditos, arquivosSemCategoria: [caminho] }`. Esta é a função pública que `motor-canal.js` (Task 6) consome.

- [ ] **Step 1: Escrever o teste que falha**

```js
const { classificar } = require('../servicos/classificador-operacao.js');

test('classificar: turno sem arquivo nenhum devolve soma zero', () => {
  const r = classificar([], {});
  assert.deepEqual(r, { categorias: [], totalCreditos: 0, arquivosSemCategoria: [] });
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
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `node --test testes/classificador-operacao.test.js`
Expected: FAIL — `classificar` não está exportado ainda.

- [ ] **Step 3: Implementação mínima**

```js
// servicos/classificador-operacao.js — adicionar no fim, antes do module.exports

const path = require('path');

// ── CRUD (A.2): única categoria que correlaciona arquivos DIFERENTES do
// mesmo recurso — ex.: rotas/produtos.js + public/produtos.html. As demais
// categorias de agregado (landing/refatoração/módulo complexo) são
// deliberadamente aproximadas pela soma das categorias finas (ver nota no
// fim do arquivo) — CRUD ficou de fora dessa simplificação porque o doc já
// descreve um padrão de detecção concreto pra ela (linha da tabela A.2).
const RE_DIR_API = /(^|\/)(rotas|routes|api)\//i;
const RE_DIR_OUTRA_CAMADA = /(^|\/)(modelos|models|servicos|services|views|paginas|pages|componentes|components|public)\//i;

function slugRecurso(caminho) {
  return path.basename(normCaminho(caminho)).replace(/\.[^.]+$/, '').toLowerCase().replace(/[-_]/g, '');
}

// Devolve o Set de caminhos que pertencem a um grupo CRUD: ≥2 arquivos com
// o mesmo "slug de recurso" (nome de arquivo sem extensão), sendo pelo menos
// um numa pasta de API/rota e outro numa pasta de modelo/UI.
function detectarGruposCrud(arquivos) {
  const porSlug = new Map();
  for (const a of arquivos) {
    const slug = slugRecurso(a.caminho);
    if (!slug) continue;
    if (!porSlug.has(slug)) porSlug.set(slug, []);
    porSlug.get(slug).push(a);
  }
  const crudPaths = new Set();
  for (const grupo of porSlug.values()) {
    if (grupo.length < 2) continue;
    const temApi = grupo.some(a => RE_DIR_API.test(normCaminho(a.caminho)));
    const temOutraCamada = grupo.some(a => RE_DIR_OUTRA_CAMADA.test(normCaminho(a.caminho)));
    if (temApi && temOutraCamada) grupo.forEach(a => crudPaths.add(a.caminho));
  }
  return crudPaths;
}

// Dedup por caminho (a fonte real — ch._arquivosTocados em motor-canal.js —
// já é um Map deduplicado; isto é defesa extra pra classificar() nunca
// contar 2x um caminho repetido na entrada, seja qual for o chamador).
function dedupPorCaminho(arquivos) {
  const porCaminho = new Map();
  for (const a of arquivos) porCaminho.set(a.caminho, a);
  return Array.from(porCaminho.values());
}

// classificar(arquivosTocados, contextoProjeto) → { categorias, totalCreditos, arquivosSemCategoria }
function classificar(arquivosTocados, contextoProjeto) {
  const arquivos = dedupPorCaminho(Array.isArray(arquivosTocados) ? arquivosTocados : []);
  const contexto = contextoProjeto || {};
  const crudPaths = detectarGruposCrud(arquivos);
  const categorias = [];
  const arquivosSemCategoria = [];
  for (const a of arquivos) {
    const nome = crudPaths.has(a.caminho) ? 'CRUD' : classificarArquivo(a, contexto);
    if (!nome) { arquivosSemCategoria.push(a.caminho); continue; }
    categorias.push({ caminho: a.caminho, categoria: nome, creditos: CREDITOS[nome] });
  }
  const totalCreditos = categorias.reduce((soma, c) => soma + c.creditos, 0);
  return { categorias, totalCreditos, arquivosSemCategoria };
}

module.exports = {
  classificar, CREDITOS,
  _classificarArquivo: classificarArquivo, _detectarGruposCrud: detectarGruposCrud,
};

// NOTA (heurística v1, mesmo espírito da nota em planejamento-automatico.js):
// "Landing page completa" (17cr), "Refatoração grande" (36cr) e "Módulo
// complexo" (54cr) são categorias de AGREGADO/TAMANHO do turno inteiro (doc
// §5), não de um arquivo isolado. Em vez de um classificador de agregado à
// parte — que exigiria decidir limiares de contagem/tamanho sem nenhum dado
// real ainda (Risco #2 do doc) —, a v1 as APROXIMA pela soma das categorias
// finas por arquivo (3 arquivos "Página simples" somam 24, próximo do que
// uma landing cobraria fixo). ponytail: se a telemetria mostrar divergência
// grande entre a soma e o preço fixo do agregado, criar um passo extra em
// classificar() que primeiro checa limiares de contagem/tamanho do TURNO e,
// se baterem, substitui a soma pelo valor fixo — sem tocar na classificação
// por arquivo já validada.
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `node --test testes/classificador-operacao.test.js`
Expected: PASS (19 testes)

- [ ] **Step 5: Commit**

```bash
git add servicos/classificador-operacao.js testes/classificador-operacao.test.js
git commit -m "feat(billing): classificador de operação — CRUD cross-file, dedup e classificar() público (parte 3)"
```

---

## Task 4: `servicos/planejamento-automatico.js` — expor `pareceCorrecao`

**Files:**
- Modify: `servicos/planejamento-automatico.js`
- Test: `testes/planejamento-automatico.test.js`

**Interfaces:**
- Consumes: `PALAVRAS_TRIVIAIS` (já existe no arquivo, não exportado).
- Produces: `pareceCorrecao(mensagem)` → boolean, exportado no nível do módulo e no objeto devolvido por `criar()`. Consumido por `motor-canal.js` (Task 6) via `planejamentoAutomatico.pareceCorrecao(...)`.

- [ ] **Step 1: Escrever o teste que falha**

```js
// testes/planejamento-automatico.test.js — adicionar
const { pareceCorrecao } = require('../servicos/planejamento-automatico.js');

test('pareceCorrecao: pedido de conserto/ajuste é reconhecido como correção', () => {
  assert.equal(pareceCorrecao('conserta a cor do botão'), true);
});

test('pareceCorrecao: pedido de algo novo não é correção', () => {
  assert.equal(pareceCorrecao('crie um site para minha padaria'), false);
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `node --test testes/planejamento-automatico.test.js`
Expected: FAIL — `pareceCorrecao is not a function`

- [ ] **Step 3: Implementação mínima**

```js
// servicos/planejamento-automatico.js — adicionar depois de classificar()

// Exposto pro classificador de operação (Fase 2, doc A.2): "Correção média"
// reaproveita este MESMO sinal em vez de duplicar a lista de palavras-chave.
function pareceCorrecao(mensagem) {
  return PALAVRAS_TRIVIAIS.test(String(mensagem || ''));
}

// module.exports (nível do módulo) — trocar a linha existente por:
module.exports = { criar, classificar, pareceCorrecao, MARCADOR_CONCLUSAO, PROMPT_PLANEJAMENTO, MODELO_PLANEJAMENTO };
```

E dentro de `criar(deps)`, no `return { ... }` (linha ~142-148), adicionar `pareceCorrecao` à lista devolvida:

```js
  return {
    classificar, elegivelParaPipeline, estaPlanejando, pareceCorrecao,
    motorTemporario, modeloTemporario, promptPrefixoTemporario,
    iniciarPlanejamento, registrarRodada, mensagemParaRetomar, finalizarPlanejamento,
    detectarMarcador, extrairPRD,
    MARCADOR_CONCLUSAO, MAX_RODADAS, MAX_MS_PLANEJAMENTO,
  };
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `node --test testes/planejamento-automatico.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add servicos/planejamento-automatico.js testes/planejamento-automatico.test.js
git commit -m "feat(billing): expor pareceCorrecao em planejamento-automatico para o classificador de operação"
```

---

## Task 5: `servicos/motor-canal.js` — acumular arquivos tocados por turno

**Files:**
- Modify: `servicos/motor-canal.js`

**Interfaces:**
- Consumes: eventos `tu.tool`/`tu.input` já emitidos por `session.on('tool_use', ...)` (schema confirmado em `engine/fake-engine.mjs`: `input.file_path`, `input.content`; Edit usa `input.old_string`/`input.new_string`; MultiEdit usa `input.edits: [{old_string,new_string}]` — schema padrão do Claude Code, validar no primeiro teste manual em produção).
- Produces: `ch._arquivosTocados` (Map, `caminho → {caminho, tool, conteudo, tamanhoAntes, tamanhoDepois}`, mesmo shape que `classificador-operacao.classificar()` espera). Consumido pelo Task 6.

Não há teste automatizado de ponta a ponta viável aqui sem reconstruir todo o harness de engine (o `test:fake` do `package.json` está fora do ar nesta checkout — arquivo `testes/build-chat-fake.js` não existe). A verificação deste passo é a leitura de código + o teste funcional do Task 6, que exercita a mesma lógica via uma função pura extraída.

- [ ] **Step 1: Modificar o handler `tool_use` para acumular**

Em `servicos/motor-canal.js`, dentro de `bindChannel`, substituir:

```js
    session.on('tool_use', (tu) => {
      bcast({ type: 'tool_use', tool: tu.tool, input: tu.input, agent: tu.agent || undefined });
      if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tu.tool)) schedulePreviewRefresh();
      if (projectId && !tu.parentId) {
        appendChatMessage(projectId, { role: 'tool', tool: tu.tool, input: tu.input, timestamp: Date.now() });
      }
    });
```

por:

```js
    session.on('tool_use', (tu) => {
      bcast({ type: 'tool_use', tool: tu.tool, input: tu.input, agent: tu.agent || undefined });
      if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tu.tool)) {
        schedulePreviewRefresh();
        registrarArquivoTocado(ch, tu);
      }
      if (projectId && !tu.parentId) {
        appendChatMessage(projectId, { role: 'tool', tool: tu.tool, input: tu.input, timestamp: Date.now() });
      }
    });
```

- [ ] **Step 2: Adicionar a função de acumulação**

Adicionar antes de `function bindChannel(ch) {`:

```js
  // A.1 (Fase 2 — classificador de operação): acumula, por turno, os
  // arquivos tocados por ferramentas de escrita/edição, no formato que
  // servicos/classificador-operacao.js espera — sem git diff, só o que já
  // flui nos eventos `tool_use`. Map (não Set): um mesmo caminho tocado 2x
  // no turno fica com o registro da ÚLTIMA edição, contando 1 vez só na
  // soma (decisão fechada da spec A.1).
  function registrarArquivoTocado(ch, tu) {
    const caminho = tu.input && tu.input.file_path;
    if (!caminho) return;
    ch._arquivosTocados = ch._arquivosTocados || new Map();
    if (tu.tool === 'Write') {
      const content = String((tu.input && tu.input.content) || '');
      ch._arquivosTocados.set(caminho, { caminho, tool: 'Write', conteudo: content, tamanhoAntes: 0, tamanhoDepois: content.length });
    } else if (tu.tool === 'Edit') {
      const antes = String((tu.input && tu.input.old_string) || '');
      const depois = String((tu.input && tu.input.new_string) || '');
      ch._arquivosTocados.set(caminho, { caminho, tool: 'Edit', conteudo: depois, tamanhoAntes: antes.length, tamanhoDepois: depois.length });
    } else if (tu.tool === 'MultiEdit') {
      const edits = Array.isArray(tu.input && tu.input.edits) ? tu.input.edits : [];
      let antes = 0, depois = 0, conteudo = '';
      for (const e of edits) {
        antes += String((e && e.old_string) || '').length;
        const novo = String((e && e.new_string) || '');
        depois += novo.length;
        conteudo += novo;
      }
      ch._arquivosTocados.set(caminho, { caminho, tool: 'MultiEdit', conteudo, tamanhoAntes: antes, tamanhoDepois: depois });
    } else if (tu.tool === 'NotebookEdit') {
      const novo = String((tu.input && (tu.input.new_source || tu.input.new_string)) || '');
      ch._arquivosTocados.set(caminho, { caminho, tool: 'NotebookEdit', conteudo: novo, tamanhoAntes: 0, tamanhoDepois: novo.length });
    }
  }

```

- [ ] **Step 3: Consumir e zerar no `result`**

No handler `session.on('result', (r) => { ... })`, logo no início (antes do cálculo de `turnCostUsd`), adicionar:

```js
      // A.2/A.3 (Fase 2): consome a lista do turno que está terminando e já
      // deixa o mapa vazio pro próximo — turnos são serializados por sessão
      // (a fila em ch._turnQueue garante um `result` por vez), então zerar
      // aqui É "zerar a cada novo turno iniciado" sem precisar de outro gancho.
      const arquivosTocadosDoTurno = Array.from((ch._arquivosTocados || new Map()).values());
      ch._arquivosTocados = new Map();
```

- [ ] **Step 4: Verificar manualmente (sem harness de teste automatizado disponível)**

Run: `node -e "require('./servicos/motor-canal.js')"` — confirma que o arquivo ainda carrega sem erro de sintaxe.
Expected: sem erro (o `require` só carrega o módulo, não executa `criar()`).

- [ ] **Step 5: Commit**

```bash
git add servicos/motor-canal.js
git commit -m "feat(billing): motor-canal acumula arquivos tocados por turno (base do classificador de operação)"
```

---

## Task 6: `servicos/motor-canal.js` + `servicos/motor-ws.js` + `server.js` — montar `creditosFixos` e debitar

**Files:**
- Modify: `servicos/motor-canal.js`
- Modify: `servicos/motor-ws.js` (uma linha: carimbar a mensagem original no turno, pro sinal de correção)
- Modify: `server.js` (uma linha: injetar `classificadorOperacao` nos deps de `motor-canal.js`)
- Test: `testes/motor-canal-creditos-fixos.test.js` (novo — testa a lógica de montagem via função pura extraída, sem precisar do harness de engine)

**Interfaces:**
- Consumes: `arquivosTocadosDoTurno` (Task 5), `classificadorOperacao.classificar(arquivosTocados, contexto)` (Task 3), `planejamentoAutomatico.pareceCorrecao(mensagem)` (Task 4), `billing.getConfig()` (já existe).
- Produces: `montarCreditosFixos(cfg, arquivosTocadosDoTurno, mensagem, deps)` → `number|undefined`, exportado como hook de teste (`_montarCreditosFixos`) e usado internamente antes de chamar `billing.debitTurn`.

- [ ] **Step 1: Escrever o teste que falha**

```js
// testes/motor-canal-creditos-fixos.test.js
// Rodar: node --test testes/motor-canal-creditos-fixos.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { criar } = require('../servicos/motor-canal.js');

function deps() {
  return {
    channels: new Map(), appendChatMessage: () => {}, loadProjects: () => [], saveProjects: () => {},
    billing: { getConfig: () => ({ precoFixoAtivo: true }) },
    classificadorOperacao: require('../servicos/classificador-operacao.js'),
    planejamentoAutomatico: { pareceCorrecao: (m) => /conserta|corrige/i.test(String(m || '')) },
  };
}

test('montarCreditosFixos: soma os créditos quando o toggle está ligado e há arquivo reconhecido', () => {
  const { _montarCreditosFixos } = criar(deps());
  const arquivos = [{ caminho: 'componentes/Novo.jsx', tool: 'Write', conteudo: 'x', tamanhoAntes: 0, tamanhoDepois: 5 }];
  const cfg = { precoFixoAtivo: true };
  assert.equal(_montarCreditosFixos(cfg, arquivos, 'crie um componente novo'), 5);
});

test('montarCreditosFixos: toggle desligado nunca monta creditosFixos', () => {
  const { _montarCreditosFixos } = criar(deps());
  const arquivos = [{ caminho: 'componentes/Novo.jsx', tool: 'Write', conteudo: 'x', tamanhoAntes: 0, tamanhoDepois: 5 }];
  const cfg = { precoFixoAtivo: false };
  assert.equal(_montarCreditosFixos(cfg, arquivos, 'crie um componente novo'), undefined);
});

test('montarCreditosFixos: turno sem arquivo tocado não monta nada mesmo com o toggle ligado', () => {
  const { _montarCreditosFixos } = criar(deps());
  const cfg = { precoFixoAtivo: true };
  assert.equal(_montarCreditosFixos(cfg, [], 'qualquer coisa'), undefined);
});

test('montarCreditosFixos: nenhum arquivo reconhecido cai no fallback (undefined)', () => {
  const { _montarCreditosFixos } = criar(deps());
  const arquivos = [{ caminho: 'notas/x.md', tool: 'Edit', conteudo: 'texto sem sinal'.repeat(50), tamanhoAntes: 5000, tamanhoDepois: 5000 }];
  const cfg = { precoFixoAtivo: true };
  assert.equal(_montarCreditosFixos(cfg, arquivos, ''), undefined);
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `node --test testes/motor-canal-creditos-fixos.test.js`
Expected: FAIL — `_montarCreditosFixos` não existe no objeto devolvido por `criar()`.

- [ ] **Step 3: Implementação mínima**

Em `servicos/motor-canal.js`, destructurar a nova dep no topo de `criar(deps)`:

```js
function criar(deps) {
  const {
    channels, appendChatMessage, loadProjects, saveProjects, billing,
    autoCommitAsync, atualizarProjeto, getCurrentVersion, generateProjectScreenshot,
    getEngine, sessionKeyFor, isDesktopLocal, escreverFerramentaDeImagem, memoriaProjeto,
    PROJECTS_BASE, normalizeBuildLevel, loadNasceraConfig, modelosLocais, motores, vpsSpawnWrapper, BUILD_LEVELS,
    credencialIaPropria, email, loadUsers, segredos, writeCavemanSkill, planejamentoAutomatico, motor2,
    classificadorOperacao,
  } = deps;
```

Adicionar a função de montagem (fora de `bindChannel`, ao lado de `registrarArquivoTocado`):

```js
  // A.3 (Fase 2): decide o valor de creditosFixos pro turno que está
  // terminando. undefined = "não aplica" (billing.debitTurn cai no custo
  // real automaticamente, seja porque o toggle está desligado, seja porque
  // nenhum arquivo bateu com nenhum padrão).
  function montarCreditosFixos(cfg, arquivosTocadosDoTurno, mensagemDoTurno) {
    if (!cfg || !cfg.precoFixoAtivo) return undefined;
    if (!arquivosTocadosDoTurno || !arquivosTocadosDoTurno.length) return undefined;
    const pedidoDeCorrecao = !!(planejamentoAutomatico && planejamentoAutomatico.pareceCorrecao
      && planejamentoAutomatico.pareceCorrecao(mensagemDoTurno));
    const resultado = classificadorOperacao.classificar(arquivosTocadosDoTurno, { pedidoDeCorrecao });
    return resultado.totalCreditos > 0 ? resultado.totalCreditos : undefined;
  }
```

No handler `session.on('result', ...)`, onde hoje o `stamp` é obtido e o `billing.debitTurn` é chamado, ajustar:

```js
      const stamp = (ch._turnQueue && ch._turnQueue.shift())
        || { id: crypto.randomUUID(), user: ch._turnUser, exempt: !!ch._turnExempt };
      let creditEvent = null;
      if (ch.motor2Ativo && stamp.user) {
        try { motor2 && motor2.registrarUso(stamp.user, projectId, stamp.id || null); }
        catch (err) { logger.error('[motor2] registrar uso falhou:', err.message); }
      } else if ((turnCostUsd > 0 || modelDeltas) && stamp.user && !stamp.exempt) {
        try {
          const creditosFixos = montarCreditosFixos(billing.getConfig(), arquivosTocadosDoTurno, stamp.mensagem);
          const deb = billing.debitTurn(stamp.user, { costUsd: turnCostUsd, modelDeltas, creditosFixos }, stamp.id || null);
          if (deb && deb.applicable && !deb.duplicate) {
```

(o resto do bloco `if (deb...)` continua idêntico ao já existente no arquivo.)

No `return` de `criar(deps)`:

```js
  return { bindChannel, ensureChannel, _montarCreditosFixos: montarCreditosFixos };
```

E em `server.js`, na chamada de `require('./servicos/motor-canal.js').criar({...})`, adicionar a nova dep:

```js
const { bindChannel, ensureChannel } = require('./servicos/motor-canal.js').criar({
  channels, appendChatMessage, loadProjects, saveProjects, billing,
  autoCommitAsync, atualizarProjeto, getCurrentVersion, generateProjectScreenshot,
  getEngine, sessionKeyFor, isDesktopLocal, escreverFerramentaDeImagem, memoriaProjeto,
  PROJECTS_BASE, normalizeBuildLevel, loadNasceraConfig, modelosLocais, motores, vpsSpawnWrapper, BUILD_LEVELS,
  segredos, writeCavemanSkill, planejamentoAutomatico, motor2,
  classificadorOperacao: require('./servicos/classificador-operacao.js'),
  credencialIaPropria: (username) => require('./rotas/ia-propria.js')
    .credencialPara(username, { loadNasceraConfig, loadUsers, segredos }),
  email: emailServico, loadUsers,
});
```

E em `servicos/motor-ws.js`, na linha que carimba o turno em `handleChat` (hoje sem a mensagem original), adicionar o campo `mensagem` — é o único jeito de o classificador de "correção média" (Task 2/4) receber o sinal sem duplicar lógica de intenção:

```js
      ch._turnQueue = ch._turnQueue || [];
      ch._turnQueue.push({ id: crypto.randomUUID(), user: decoded.user, exempt: _isento, mensagem: userMessage });
      if (ch._turnQueue.length > 50) ch._turnQueue.shift();
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `node --test testes/motor-canal-creditos-fixos.test.js`
Expected: PASS (4 testes)

Também rodar `node -e "require('./server.js')"` **não** é seguro (sobe o servidor de verdade) — em vez disso, confirmar sintaxe com `node --check server.js servicos/motor-ws.js servicos/motor-canal.js`.
Expected: sem erro de sintaxe nos 3 arquivos.

- [ ] **Step 5: Commit**

```bash
git add servicos/motor-canal.js servicos/motor-ws.js server.js testes/motor-canal-creditos-fixos.test.js
git commit -m "feat(billing): motor-canal monta creditosFixos do turno e passa pro debitTurn"
```

---

## Task 7: `billing.js` — `debitTurn` aceita `creditosFixos`, `defaultConfig` ganha `precoFixoAtivo`

**Files:**
- Modify: `billing.js`
- Test: `testes/billing-planos-motor2.test.js`

**Interfaces:**
- Consumes: nada novo (`priceTurn`, `takeFromGrants` etc. já existem).
- Produces: `defaultConfig()` com `precoFixoAtivo: false`; `debitTurn(username, turn, turnId)` aceita `turn.creditosFixos` (number opcional); retorno de `debitTurn` ganha `realBaseUsd`/`realChargedUsd`; evento do ledger (`usage-events.jsonl`) ganha os mesmos dois campos.

- [ ] **Step 1: Escrever os testes que falham**

Adicionar em `testes/billing-planos-motor2.test.js` (helper + 4 testes):

```js
// Helper: reescreve cfg.billing no arquivo de config isolado do teste (ver
// topo do arquivo) — getConfig() relê o arquivo a cada chamada, sem cache.
function setBillingConfig(patch) {
  const raw = JSON.parse(fs.readFileSync(process.env.NASCERA_CONFIG_FILE, 'utf8'));
  raw.billing = { ...raw.billing, ...patch };
  fs.writeFileSync(process.env.NASCERA_CONFIG_FILE, JSON.stringify(raw));
}

test('precoFixoAtivo desligado (default): creditosFixos é ignorado — comportamento idêntico à Fase 1', () => {
  const u = novoUsuario();
  billing.setUserPlan(u, 'pro');
  const d = billing.debitTurn(u, { costUsd: 5, creditosFixos: 999 }, 'turno-regressao-' + u);
  assert.equal(d.applicable, true);
  // 999 créditos custariam 999*0,20=199,80 USD — bem mais que os 5 USD reais.
  // Se o toggle (default false) tivesse efeito, o gasto do mês explodiria.
  assert.equal(d.costMilli, Math.floor((5 / 0.20) * 1000));
  const s = billing.summaryFor(u);
  assert.ok(s.month.spentUsd < 10, 'gasto deve refletir o custo real (~5 USD), não os 999 créditos fixos');
});

test('precoFixoAtivo ligado: creditosFixos decide costMilli; realBaseUsd/realChargedUsd guardam o custo real', () => {
  setBillingConfig({ precoFixoAtivo: true });
  try {
    const u = novoUsuario();
    billing.setUserPlan(u, 'pro');
    const d = billing.debitTurn(u, { costUsd: 0.01, creditosFixos: 22 }, 'turno-fixo-' + u);
    assert.equal(d.applicable, true);
    assert.equal(d.costMilli, 22000);          // 22 créditos, não o custo real de 0,01 USD
    assert.equal(d.chargedUsd, 22 * 0.20);      // 22 créditos convertidos p/ USD (usdPerCredit=0.20)
    assert.equal(d.realBaseUsd, 0.01);          // custo real preservado p/ auditoria de margem
    assert.ok(d.realChargedUsd > 0 && d.realChargedUsd < 1);
    const linhas = fs.readFileSync(process.env.NASCERA_USAGE_EVENTS_FILE, 'utf8').trim().split('\n');
    const ultima = JSON.parse(linhas[linhas.length - 1]);
    assert.equal(ultima.costMilli, 22000);
    assert.equal(ultima.realBaseUsd, 0.01);
  } finally {
    setBillingConfig({ precoFixoAtivo: false });
  }
});

test('precoFixoAtivo ligado sem creditosFixos: cai no custo real (fallback do classificador)', () => {
  setBillingConfig({ precoFixoAtivo: true });
  try {
    const u = novoUsuario();
    billing.setUserPlan(u, 'pro');
    const d = billing.debitTurn(u, { costUsd: 5 }, 'turno-sem-fixo-' + u);   // sem creditosFixos
    assert.equal(d.costMilli, Math.floor((5 / 0.20) * 1000));
  } finally {
    setBillingConfig({ precoFixoAtivo: false });
  }
});

test('idempotência: turnId repetido com creditosFixos e toggle ligado não cobra duas vezes', () => {
  setBillingConfig({ precoFixoAtivo: true });
  try {
    const u = novoUsuario();
    billing.setUserPlan(u, 'pro');
    const turnId = 'turno-fixo-idemp-' + u;
    const d1 = billing.debitTurn(u, { costUsd: 0.01, creditosFixos: 10 }, turnId);
    const s1 = billing.summaryFor(u);
    const d2 = billing.debitTurn(u, { costUsd: 0.01, creditosFixos: 10 }, turnId);
    const s2 = billing.summaryFor(u);
    assert.equal(d1.duplicate, undefined);
    assert.equal(d2.duplicate, true);
    assert.deepEqual(s2.saldosPorOrigem, s1.saldosPorOrigem);
  } finally {
    setBillingConfig({ precoFixoAtivo: false });
  }
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `node --test testes/billing-planos-motor2.test.js`
Expected: FAIL — o teste "precoFixoAtivo ligado" quebra (`d.costMilli` sai calculado do custo real, não 22000; `d.realBaseUsd` é `undefined`).

- [ ] **Step 3: Implementação mínima**

Em `billing.js`, `defaultConfig()`:

```js
function defaultConfig() {
  return {
    mode: 'off',
    usdPerCredit: 0.20,
    defaultDailyLimitUsd: 10,
    timezone: 'America/Sao_Paulo',
    defaultMarkup: 2,
    usdToBrl: 5.5,
    sessionsPerWeek: 5,
    models: DEFAULT_MODELS,
    plans: DEFAULT_PLANS,
    creditoCompradoValidadeDias: 365,
    precoFixoAtivo: false,   // Fase 2 (A.3): toggle do admin, mesmo padrão de pipelineAutomatico/motor2.ligado
  };
}
```

Em `debitTurn`, a partir do início da função até o cálculo de `costMilli`/`chargedUsd`, trocar:

```js
function debitTurn(username, turn, turnId) {
  const cfg = getConfig();
  if (cfg.mode !== 'credits') return { applicable: false };
  const t = (typeof turn === 'number') ? { costUsd: turn, modelDeltas: null } : (turn || {});
  const priced = priceTurn(cfg, t.modelDeltas, t.costUsd);
  // O custo REAL sempre é calculado — alimenta o dashboard de margem/desvio
  // (doc §12) mesmo quando o preço fixo decide o débito. Só entra no débito
  // em si quando NÃO há preço fixo válido (mesma guarda de sempre).
  const precoFixoValido = cfg.precoFixoAtivo && Number(t.creditosFixos) > 0;
  if (!precoFixoValido && !(priced.chargedUsd > 0)) return { applicable: false };

  const acct = account(username);
  lazyReset(acct, cfg);
  const plan = planOf(cfg, acct);
  garantirBonusDoDia(acct, cfg, plan);

  if (turnId && jaCobrado(acct, turnId)) {
    return { applicable: true, duplicate: true, summary: summaryFor(username) };
  }

  // costMilli/chargedUsd são o que efetivamente sai do orçamento do cliente.
  // Preço fixo (A.3, doc): creditosFixos decide direto, sem passar pelo
  // custo real. Senão, EXATAMENTE o cálculo da Fase 1 (floor, não round —
  // nenhuma origem paga MAIS que o turno custou de verdade).
  let costMilli, chargedUsd;
  if (precoFixoValido) {
    costMilli = Math.round(Number(t.creditosFixos) * 1000);
    chargedUsd = milliToUsd(costMilli, cfg);
  } else {
    chargedUsd = priced.chargedUsd;
    costMilli = Math.floor((chargedUsd / cfg.usdPerCredit) * 1000);
  }
  let restante = costMilli;
  let fromBonus = 0, fromPremium = 0, fromComprado = 0;
```

(o restante da função — ordem bônus→premium→comprado→overage, janelas, sessão, ledger, billingDb — permanece EXATAMENTE como está hoje, todas as referências a `chargedUsd`/`costMilli` já apontam pras variáveis novas sem precisar tocar mais nada até o `try { const linha = ... }`).

No bloco do ledger, adicionar os dois campos novos:

```js
  try {
    const linha = JSON.stringify({
      ts: new Date().toISOString(), user: username,
      baseUsd: priced.baseUsd, chargedUsd, perModel: priced.perModel,
      realBaseUsd: priced.baseUsd, realChargedUsd: priced.chargedUsd,
      costMilli, fromBonus, fromPremium, fromComprado, remainderUsd: r6(remainderUsd), turnId,
    }) + '\n';
```

E no `return` final de `debitTurn`:

```js
  return {
    applicable: true, baseUsd: priced.baseUsd, chargedUsd, perModel: priced.perModel,
    realBaseUsd: priced.baseUsd, realChargedUsd: priced.chargedUsd,
    costMilli, fromBonus, fromPremium, fromComprado, remainderUsd, summary: summaryFor(username),
  };
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `node --test testes/billing-planos-motor2.test.js`
Expected: PASS (todos os testes, os antigos e os 4 novos — os antigos continuam passando porque `precoFixoValido` é `false` por padrão e o `else` reproduz a conta antiga byte a byte)

Também rodar a suíte inteira pra garantir que nada mais quebrou:
Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add billing.js testes/billing-planos-motor2.test.js
git commit -m "feat(billing): debitTurn aceita creditosFixos sob precoFixoAtivo, preserva custo real em realBaseUsd/realChargedUsd"
```

---

## Task 8: `rotas/admin-billing.js` + `public/admin.html` — toggle `precoFixoAtivo`

**Files:**
- Modify: `rotas/admin-billing.js`
- Modify: `public/admin.html`

**Interfaces:**
- Consumes: `billing.getConfig()`/`billing` já injetado nas rotas; endpoint existente `PUT /api/admin/billing/config`.
- Produces: campo `precoFixoAtivo` aceito e persistido pelo mesmo endpoint (sem rota nova — ele já vive em `cfg.billing`, mesmo lugar de `mode`/`defaultMarkup`).

Este campo é um passthrough booleano simples (sem branch/loop/parser de risco) — a cobertura fica no teste de `billing.js` (Task 7), que já exercita `precoFixoAtivo` de ponta a ponta via `getConfig()`. Aqui só a verificação manual abaixo.

- [ ] **Step 1: Adicionar o campo ao endpoint existente**

Em `rotas/admin-billing.js`, na assinatura da rota `PUT /api/admin/billing/config`:

```js
app.put('/api/admin/billing/config', adminMiddleware, (req, res) => {
  const { mode, usdPerCredit, defaultDailyLimitUsd, timezone, plans, models, defaultMarkup, usdToBrl, sessionsPerWeek, precoFixoAtivo } = req.body;
  const cfg = loadNasceraConfig();
  const b = { ...(cfg.billing || {}) };
  if (mode !== undefined) {
    if (!['off', 'subscription', 'credits'].includes(mode)) return res.status(400).json({ error: 'Modo inválido' });
    b.mode = mode;
  }
```

E, depois do bloco de `sessionsPerWeek` (antes de `let warnings = [];`), adicionar:

```js
  if (precoFixoAtivo !== undefined) {
    // Fase 2 (A.3): cobrança por preço fixo por operação em vez do custo
    // real em tokens. Default false — igual ao padrão de pipelineAutomatico
    // e motor2.ligado: nenhuma mudança visível até o admin ligar.
    b.precoFixoAtivo = !!precoFixoAtivo;
  }
```

- [ ] **Step 2: Adicionar o checkbox em `public/admin.html`**

No card `id="bill-credits-cfg"` (aba "Receita & Planos"), adicionar um bloco de toggle no mesmo padrão de `pa-toggle`/`motor2-toggle` (ver `id="sec-config"`), como último filho da grade existente:

```html
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06);margin-top:14px">
          <div style="flex:1;min-width:0">
            <div style="font-size:12.5px;color:rgba(255,255,255,.7)">Preço fixo por operação</div>
            <p style="font-size:11px;color:rgba(255,255,255,.35);margin:2px 0 0;line-height:1.5">Cobra uma tabela fixa de créditos por tipo de tarefa detectada (criar componente, CRUD, API...) em vez do custo real em tokens. O custo real continua calculado por baixo, só pra auditoria de margem — nunca é o que sai do saldo do cliente enquanto isto estiver ligado.</p>
          </div>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;white-space:nowrap;flex-shrink:0">
            <input type="checkbox" id="bill-preco-fixo" style="width:16px;height:16px;accent-color:var(--zh-accent)">
          </label>
        </div>
```

Em `loadBilling()`, junto dos outros campos (`bill-usd`, `bill-daily`, etc.):

```js
    document.getElementById('bill-preco-fixo').checked = !!d.config.precoFixoAtivo;
```

Em `saveBillingConfig()`, junto dos outros campos do `body`:

```js
    precoFixoAtivo: document.getElementById('bill-preco-fixo').checked,
```

- [ ] **Step 3: Verificar manualmente**

Run: `node --check rotas/admin-billing.js`
Expected: sem erro de sintaxe.

Subir o servidor localmente e, autenticado como admin: `curl -X PUT localhost:PORTA/api/admin/billing/config -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"precoFixoAtivo":true}'` → resposta `{ ok: true, config: { precoFixoAtivo: true, ... } }`. Repetir com `false` e confirmar que volta.

- [ ] **Step 4: Commit**

```bash
git add rotas/admin-billing.js public/admin.html
git commit -m "feat(billing): admin liga/desliga precoFixoAtivo pela tela de Receita & Planos"
```

---

## Task 9: `rotas/compras.js` — `POST /api/billing/estimar`

**Files:**
- Modify: `rotas/compras.js`
- Test: `testes/compras-estimar.test.js` (novo)

**Interfaces:**
- Produces: `estimarCreditos(mensagem)` → `{ min, max }` (exportado, puro, sem I/O); rota `POST /api/billing/estimar` (autenticada) → `{ minCreditos, maxCreditos, aproximado: true }`.

- [ ] **Step 1: Escrever o teste que falha**

```js
// testes/compras-estimar.test.js
// Rodar: node --test testes/compras-estimar.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { estimarCreditos } = require('../rotas/compras.js');

test('estimarCreditos: pedido de pagamento estima faixa alta e fixa (27)', () => {
  assert.deepEqual(estimarCreditos('preciso de um checkout de pagamento'), { min: 27, max: 27 });
});

test('estimarCreditos: pedido de ajuste pequeno estima faixa baixa', () => {
  assert.deepEqual(estimarCreditos('troca a cor do botão'), { min: 2, max: 5 });
});

test('estimarCreditos: texto sem sinal nenhum cai na faixa padrão', () => {
  assert.deepEqual(estimarCreditos('oi, tudo bem?'), { min: 2, max: 20 });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `node --test testes/compras-estimar.test.js`
Expected: FAIL — `estimarCreditos` não está exportado.

- [ ] **Step 3: Implementação mínima**

Em `rotas/compras.js`, adicionar antes de `function registrar(app, deps) {`:

```js
// ── A.4 (Fase 2): estimativa prévia de créditos (doc §11) ──────────────
// Heurística de INTENÇÃO — mais simples que o classificador de RESULTADO
// (servicos/classificador-operacao.js): aqui não existe nenhum arquivo
// tocado ainda, só o texto que o usuário está digitando. Serve só pra
// mostrar uma faixa aproximada ANTES do envio — nunca o valor exato cobrado
// (esse vem do classificador de resultado, pós-turno).
const FAIXAS_INTENCAO = [
  { min: 27, max: 27, re: /pagamento|checkout|gateway de pagamento/i },
  { min: 22, max: 25, re: /\bcrud\b|cadastro completo|dashboard/i },
  { min: 14, max: 20, re: /\blogin\b|autentica[çc][aã]o|\bapi\b|integra[çc][aã]o/i },
  { min: 8, max: 17, re: /landing page|p[aá]gina (nova|completa)|site completo/i },
  { min: 5, max: 10, re: /formul[aá]rio|componente novo|criar (um |uma )?(componente|se[çc][aã]o)/i },
  { min: 2, max: 5, re: /muda|troca|ajust|corrig|conserta|cor do bot[aã]o|texto/i },
];
const FAIXA_PADRAO = { min: 2, max: 20 };

function estimarCreditos(mensagem) {
  const texto = String(mensagem || '');
  for (const faixa of FAIXAS_INTENCAO) {
    if (faixa.re.test(texto)) return { min: faixa.min, max: faixa.max };
  }
  return FAIXA_PADRAO;
}
```

E dentro de `registrar(app, deps)`, junto das outras rotas de cliente:

```js
  // ── cliente: estimativa prévia de créditos (composer, deliberadamente
  // aproximada) ────────────────────────────────────────────────────────
  app.post('/api/billing/estimar', authMiddleware, (req, res) => {
    const mensagem = String((req.body || {}).mensagem || '');
    const faixa = estimarCreditos(mensagem);
    res.json({ minCreditos: faixa.min, maxCreditos: faixa.max, aproximado: true });
  });
```

E no `module.exports` do fim do arquivo:

```js
module.exports = { registrar, extratoDe, estimarCreditos };
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `node --test testes/compras-estimar.test.js`
Expected: PASS (3 testes)

- [ ] **Step 5: Commit**

```bash
git add rotas/compras.js testes/compras-estimar.test.js
git commit -m "feat(billing): endpoint POST /api/billing/estimar (estimativa prévia de créditos, doc §11)"
```

---

## Task 10: `public/app.html` — estimativa prévia no composer

**Files:**
- Modify: `public/app.html`

**Interfaces:**
- Consumes: `POST /api/billing/estimar` (Task 9), variável global `token` já existente, elemento `#msg-input` já existente, `#credits-chip` (visibilidade já controlada por `renderCreditsChip`) como sinal de "modo créditos ativo".

Sem teste automatizado (é HTML/JS de página sem harness de DOM no repo) — verificação é manual, listada no Step 3.

- [ ] **Step 1: Adicionar o elemento de exibição**

Junto ao `#credits-chip` (perto da linha `<div id="credits-chip" ...>`), adicionar um span discreto para a estimativa, antes do chip de créditos:

```html
                <span id="estimativa-creditos" style="display:none;font-size:10.5px;color:rgba(255,255,255,.35);font-family:ui-monospace,monospace;white-space:nowrap;margin-right:6px"></span>
```

- [ ] **Step 2: Adicionar o listener debounced**

Junto aos outros `input.addEventListener('input', ...)` do composer (perto da linha 3391), adicionar:

```js
// ── Estimativa prévia de créditos (A.4, doc §11) — debounced, aproximada.
var _estimativaTimer = null;
input.addEventListener('input', function() {
  clearTimeout(_estimativaTimer);
  var texto = input.value.trim();
  var el = document.getElementById('estimativa-creditos');
  if (!el) return;
  if (texto.length < 8 || document.getElementById('credits-chip').style.display === 'none') {
    el.style.display = 'none';
    return;
  }
  _estimativaTimer = setTimeout(function() {
    fetch('/api/billing/estimar', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mensagem: texto }),
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (!d || d.minCreditos === undefined) { el.style.display = 'none'; return; }
      el.textContent = '≈ ' + d.minCreditos + '–' + d.maxCreditos + ' cr';
      el.style.display = 'inline';
    }).catch(function() { el.style.display = 'none'; });
  }, 500);
});
```

- [ ] **Step 3: Verificar manualmente**

Run: `node --check` não se aplica a HTML — abrir a página no navegador (`npm start` local), entrar no modo de cobrança por créditos (admin com `mode: 'credits'`), digitar "crie um formulário de contato" no composer e confirmar que, ~500ms depois, aparece "≈ 5–10 cr" ao lado do chip de créditos. Apagar o texto e confirmar que o span desaparece.

- [ ] **Step 4: Commit**

```bash
git add public/app.html
git commit -m "feat(billing): estimativa prévia de créditos no composer (debounced, aproximada)"
```

---

## Self-Review (executada ao escrever este plano)

**1. Cobertura da spec (A.1–A.4 + arquivos críticos + riscos + plano de testes correspondentes):**
- A.1 (acumular `tool_use` por turno) → Task 5.
- A.2 (classificador `servicos/classificador-operacao.js`, tabela de categorias/créditos) → Tasks 1–3.
- A.3 (`debitTurn` com `creditosFixos`, `realBaseUsd`/`realChargedUsd`) → Task 7.
- A.4 (`POST /api/billing/estimar`) → Task 9; composer no `app.html` → Task 10.
- Arquivos críticos listados para Parte A: `billing.js` (Task 7), `servicos/classificador-operacao.js` (Tasks 1–3), `servicos/motor-canal.js` (Tasks 5–6), `rotas/compras.js` (Task 9), `rotas/admin-billing.js` (Task 8), `public/app.html` (Task 10), `public/admin.html` (Task 8) — todos cobertos. `servicos/planejamento-automatico.js` e `servicos/motor-ws.js`/`server.js` não estavam na lista da spec mas são glue mínimo indispensável (sinal de correção e injeção de dependência) — Tasks 4 e 6 os tratam explicitamente como tal.
- Risco #1 (heurística v1, recalibrável) → documentado nos comentários do Task 1–3 e na nota final do arquivo.
- Risco #2 (fronteiras nebulosas de tamanho/agregado) → decisão de simplificação documentada no Global Constraints e na nota do Task 3.
- Risco #3 (sem usuários em produção, toggle nasce desligado) → Task 7 (default `false`) e Task 8 (toggle explícito do admin).
- Plano de testes da spec: `testes/classificador-operacao.test.js` (Tasks 1–3) e extensão de `testes/billing-planos-motor2.test.js` com toggle ligado/desligado + `realBaseUsd`/`realChargedUsd` (Task 7) — ambos entregues.

**2. Placeholder scan:** nenhum "TODO"/"implementar depois" — todo Step tem código real. Os únicos pontos sem teste automatizado (`motor-canal.js` Task 5, `admin-billing.js`/`admin.html` Task 8, `app.html` Task 10) têm verificação manual explícita com comando/passo concreto, e a lógica de risco real de cada um está coberta indiretamente por outro teste (Task 6 para a montagem de créditos, Task 7 para o efeito do toggle no débito).

**3. Consistência de tipos/assinaturas:** `classificar(arquivosTocados, contextoProjeto)` (Task 3) é chamada com esse shape exato em `montarCreditosFixos` (Task 6). O shape `{caminho, tool, conteudo, tamanhoAntes, tamanhoDepois}` é produzido em `registrarArquivoTocado` (Task 5) e consumido sem alteração em `classificarArquivo`/`classificar` (Tasks 1–3). `debitTurn(username, turn, turnId)` com `turn.creditosFixos` (Task 7) é chamado com esse campo em `montarCreditosFixos`→`billing.debitTurn` (Task 6). `pareceCorrecao(mensagem)` (Task 4) é chamado com `stamp.mensagem` (Task 6), que vem do `mensagem: userMessage` adicionado em `motor-ws.js` (Task 6).

**4. Review Focus:** os 5 itens fornecidos foram mapeados 1:1 a testes concretos nas Tasks 3, 6 e 7 (ver seção Review Focus acima).
