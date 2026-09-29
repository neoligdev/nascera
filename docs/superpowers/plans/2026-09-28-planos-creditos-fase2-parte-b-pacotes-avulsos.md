# Plano de Implementação — Parte B: Pacotes avulsos de créditos

> **Para agentes:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recomendado) ou `superpowers:executing-plans` para executar este plano tarefa a tarefa. Passos usam `- [ ]` para rastreio.

Spec de origem: `docs/superpowers/specs/2026-09-28-planos-creditos-fase2-design.md`, seções B.1–B.4 + itens correspondentes de "Arquivos críticos", "Riscos" e "Plano de testes". Nenhuma decisão de produto da spec é reaberta aqui — só a engenharia de como implementá-las.

## Achados da investigação que corrigem a spec (leia antes de começar)

1. **A "tela de planos que já existe" não é `public/app.html` — é `public/comprar.html`.** Confirmado: `app.html` não tem nenhum código de catálogo de planos (só o resumo de saldo em `linhaSaldo`); `GET /api/billing/planos` e `POST /api/me/intencao-pix` são consumidos por `public/comprar.html`, uma página standalone com seu próprio `<script>` e helper `api()`. O catálogo de pacotes vai lá, não em `app.html`.
2. **A tela de config de gateway do admin está morta/desatualizada.** `public/admin.html` (o arquivo ativo) só tem um formulário fixo de "Hotmart único", chamando `PUT /api/admin/webhooks/hotmart` — **endpoint que não existe** em `rotas/webhooks.js` hoje (o backend real já é genérico: `GET/PUT/DELETE /api/admin/gateways/:id`, suportando os 4 gateways com `planoPorOferta`). Não há "mapeamento oferta→plano já existente" para colocar o pacote "ao lado" — a UI real desse mapeamento nunca foi construída. Decisão tomada aqui: substituir o formulário morto por uma UI genérica de 4 gateways (dirigida por `GET /api/admin/gateways`) com os dois mapeamentos (plano e pacote) desde o início, em vez de manter dois sistemas conflitantes no ar.
3. **Corrida de crédito em dobro em reentrega simultânea.** A spec assume que "mesma idempotência (`vendas.jaExiste`)" basta — mas `setUserPlan` é idempotente por natureza (aplicar o mesmo plano 2× é inofensivo) enquanto `addBalance` **não é** (concede créditos a cada chamada). No código atual, `jaExiste()` é `await`ado *antes* de aplicar o plano/pacote e *antes* de `vendas.registrar()` — duas entregas quase simultâneas passam ambas pelo `jaExiste` (false, false) e, sem o reordenamento abaixo, ambas creditariam o pacote antes de qualquer uma vencer a corrida no ledger. Corrigido na Tarefa 4 (crédito de pacote só depois do `vendas.registrar()` confirmar que venceu a corrida).

## Goal

Cliente compra um pacote avulso de créditos (100 a 10.000) via qualquer um dos 4 gateways automáticos já integrados; o crédito cai no saldo "comprado" existente (Fase 1) sem tocar em plano/assinatura, com o mesmo rigor de idempotência, ledger e e-mail que a venda de plano já tem.

## Architecture

Reaproveita 100% do núcleo de webhook (`rotas/webhooks.js`) e do motor de créditos (`billing.js`, `addBalance` inalterado). Só três coisas são novas: (1) um catálogo de pacotes na config (`billing.pacotes[]`, mesmo desenho de `billing.plans[]`); (2) uma função-irmã `resolverPacote` ao lado de `resolverPlano`, resolvida **primeiro** no núcleo do webhook (pacote não tem "padrão pega-tudo" como o plano tem); (3) uma coluna paralela em `vendas` (`pacote_creditos`) para o ledger de vendas registrar qual dos dois foi vendido — nunca os dois na mesma venda.

## Tech Stack

Node.js/Express, sem TypeScript. Testes com `node --test` (nenhum framework novo). Sem Postgres neste ambiente (sem `DATABASE_URL`) — todo teste automatizado roda no caminho de arquivo (`NASCERA_DB_STATE` ≠ `'pg'`, `billingDb.ATIVO` false). A migração SQL fica marcada como não testável aqui.

## Spec

B.1–B.4 da spec de origem, verbatim nas decisões de produto (catálogo padrão de 6 pacotes, `addBalance` sem mudar assinatura, mesma idempotência/ledger/e-mail, oferta nunca mapeia para plano E pacote). Plano irmão (Parte A): `docs/superpowers/plans/2026-09-28-planos-creditos-fase2-parte-a-classificador-preco-fixo.md` — independente deste, nenhuma interface compartilhada.

## Global Constraints

- Nunca modificar a assinatura de `billing.addBalance(username, credits, label)`.
- `resolverPlano`/`setUserPlan` e todo o comportamento hoje testado (planos, cortesias, Motor 2) continuam bit-a-bit iguais — a única mudança de ordem no núcleo do webhook é a que fecha a corrida de dobro (item 3 acima), e só afeta o caminho do pacote.
- Toda validade de crédito comprado vem de `cfg.creditoCompradoValidadeDias` (já existe, Fase 1) — nunca recalcular/hardcoded no código novo.
- `node --test testes/*.test.js` precisa passar do jeito que está, sem Postgres.

## Review Focus

1. **Webhook reentregando a mesma venda de pacote duas vezes.** A proteção de duas camadas (`jaExiste` antes + `vendas.registrar()`'s `ON CONFLICT`/dedupe de arquivo depois) só fecha a corrida de fato se o crédito (`addBalance`) rodar **depois** de `vendas.registrar()` confirmar que venceu — não antes, como a leitura ingênua da spec ("mesma idempotência") sugeriria. É a mudança de ordem da Tarefa 4.3/4.4; qualquer PR que mova `billing.addBalance(...)` de volta para antes do `await vendas.registrar(...)` reabre o buraco.
2. **Oferta sem mapeamento nenhum continua caindo no fluxo `sem_plano` já existente.** Confirmado pela tabela de verdade do `status` na Tarefa 4.3: `resolverPacote` nunca tem padrão pega-tudo, então uma oferta desconhecida nunca "acidentalmente" vira pacote nem plano — cai exatamente no mesmo `sem_plano`/`venda_gateway_pendente` de sempre. Testado explicitamente em `webhooks-pacotes.test.js`.
3. **Pacote creditado pro usuário errado quando o e-mail não bate com nenhuma conta.** Hoje isso nunca credita a conta *errada* de alguém real — cria uma conta *nova* (`criarComprador`) quando o e-mail do comprador não corresponde a nenhum cadastro existente. O risco real é: um cliente que já tem conta sob um e-mail diferente do usado na compra ganha uma segunda conta duplicada, e os créditos do pacote vão pra essa duplicata em vez da conta "certa" que ele já usa. É um risco preexistente da Fase 1 (idêntico pra venda de plano) — não introduzido por esta Parte B, mas mais fácil de passar despercebido com crédito avulso (silencioso) do que com troca de plano (visível no painel). Vale um item de suporte/operação, não de código.
4. **Validade do crédito vem de `creditoCompradoValidadeDias` já existente, não hardcoded de novo.** `resolverPacote`/`billing.addBalance` na Tarefa 4 nunca calculam data de expiração — só passam `pacote.creditos` e o rótulo pra `addBalance`, que já lê `cfg.creditoCompradoValidadeDias` internamente (Fase 1, inalterado). Qualquer código novo que compute um `expiresAt` manualmente para pacote é bug — o crédito vira dois padrões de validade divergentes na mesma conta.
5. **Reembolso de venda de pacote — decisão documentada.** O fluxo de `ev.tipo === 'reembolsada'` (linha ~207 de `rotas/webhooks.js`) só suspende a conta (`users[username].suspended = true`) — nunca removeu crédito nem, hoje, downgrade de plano, mesmo para vendas de plano na Fase 1. `suspended` bloqueia login/uso por completo (`server.js:951`), então o cliente reembolsado não consegue gastar o crédito de qualquer jeito enquanto suspenso. **Decisão**: estender exatamente o mesmo comportamento pra pacotes (nenhuma clawback de crédito, só suspensão) — é consistente com o que a Fase 1 já aceita para planos, não introduz um caso novo, e evitar um clawback automático evita o risco maior (debitar/remover crédito que o cliente já gastou construindo algo, gerando um saldo negativo ou uma reversão incoerente). Se o produto decidir mais adiante que reembolso de pacote deve reverter crédito não usado, é uma decisão de produto nova, fora desta Parte B — documentar isso explicitamente no PR para não ser assumido como "esquecido".

---

## Task 1: Catálogo de pacotes em `billing.js`

**Files:**
- `billing.js`
- `testes/billing-pacotes.test.js` (novo)

**Interfaces:**
```js
const DEFAULT_PACOTES = [ /* 6 pacotes do doc */ ];
function validatePacotes(pacotes) /* → string[] (warnings); throws em id ausente/duplicado */
// getConfig() ganha: cfg.pacotes (fallback DEFAULT_PACOTES quando ausente/vazio)
```

- [ ] **1.1** Criar `testes/billing-pacotes.test.js` isolando `NASCERA_CONFIG_FILE` (mesmo padrão de `billing-planos-motor2.test.js`), com o teste `'getConfig: sem pacotes configurados, cai nos 6 pacotes padrão do doc'` esperando `cfg.pacotes.length === 6` e `cfg.pacotes.map(p=>p.creditos)` igual a `[100,300,1000,2500,5000,10000]`. Rodar `node --test testes/billing-pacotes.test.js` e confirmar que falha (pacotes ainda não existe).

- [ ] **1.2** Em `billing.js`, adicionar a constante logo depois de `DEFAULT_PLANS`:
```js
// Pacotes avulsos de créditos (doc, tabela de preço decrescente por
// volume). Creditados via addBalance() → origem 'comprado', com a MESMA
// validade de cfg.creditoCompradoValidadeDias — nunca recalculada aqui.
const DEFAULT_PACOTES = [
  { id: 'pacote-100',   creditos: 100,   precoBrl: 19.90 },
  { id: 'pacote-300',   creditos: 300,   precoBrl: 37.90 },
  { id: 'pacote-1000',  creditos: 1000,  precoBrl: 99.90 },
  { id: 'pacote-2500',  creditos: 2500,  precoBrl: 189.90 },
  { id: 'pacote-5000',  creditos: 5000,  precoBrl: 369.90 },
  { id: 'pacote-10000', creditos: 10000, precoBrl: 695.90 },
];
```
Em `defaultConfig()`, adicionar `pacotes: DEFAULT_PACOTES,` ao lado de `plans: DEFAULT_PLANS,`. Em `getConfig()`, adicionar `if (!Array.isArray(cfg.pacotes) || !cfg.pacotes.length) cfg.pacotes = DEFAULT_PACOTES;` ao lado da linha equivalente de `cfg.plans`. Rodar o teste — deve passar.

- [ ] **1.3** Adicionar em `testes/billing-pacotes.test.js` os testes `'validatePacotes: id duplicado é rejeitado'` (`assert.throws(..., /duplicado/)`) e `'validatePacotes: créditos ou preço zerados geram aviso, não erro'` (`warnings.length === 2`, sem lançar). Rodar — deve falhar (função não existe).

- [ ] **1.4** Implementar em `billing.js`, ao lado de `validatePlans`:
```js
function validatePacotes(pacotes) {
  const warnings = [];
  const ids = new Set();
  for (const p of pacotes) {
    if (!p.id) throw new Error('Pacote sem id');
    if (ids.has(p.id)) throw new Error(`Id de pacote duplicado: "${p.id}"`);
    ids.add(p.id);
    if (!(p.creditos > 0)) warnings.push(`Pacote "${p.id}": créditos zerados ou negativos — ninguém recebe nada nesta compra.`);
    if (!(p.precoBrl > 0)) warnings.push(`Pacote "${p.id}": preço zerado ou negativo.`);
  }
  return warnings;
}
```
Adicionar `DEFAULT_PACOTES, validatePacotes` ao `module.exports`. Rodar `node --test testes/billing-pacotes.test.js` — todos passam.

- [ ] **1.5** Rodar `npm test` completo (regressão) e commitar:
```bash
git add billing.js testes/billing-pacotes.test.js
git commit -m "feat(billing): catálogo de pacotes avulsos de créditos (DEFAULT_PACOTES, validatePacotes)"
```

---

## Task 2: Migração `008-pacotes-avulsos.sql`

**Files:** `migracoes/008-pacotes-avulsos.sql` (novo)

- [ ] **2.1** Criar o arquivo seguindo o estilo de `006`/`007`:
```sql
-- ═══════════════════════════════════════════════════════════════════════
-- 008 — Pacotes avulsos de créditos (Fase 2, Parte B)
--
-- A venda de um PACOTE (créditos avulsos, sem assinatura) usa a MESMA
-- tabela `vendas` da 006 — só ganha uma coluna paralela a `plano`. Nunca as
-- duas preenchidas na mesma venda (rotas/webhooks.js garante isso, e a
-- config do gateway recusa oferta mapeada pra ambos ao mesmo tempo).
--
-- NÃO TESTÁVEL NESTE AMBIENTE (sem Postgres/DATABASE_URL) — validar antes
-- de produção, mesma ressalva já usada na migração 007.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE vendas ADD COLUMN IF NOT EXISTS pacote_creditos INTEGER;

-- Redundante com a 006 (a tabela inteira já foi liberada pro role da
-- aplicação; uma coluna nova herda a mesma concessão automaticamente) —
-- repetido aqui pelo mesmo hábito de defesa em profundidade das migrações
-- anteriores: cada arquivo se explica sozinho, sem depender de nenhum
-- outro ter rodado antes com o grant intacto.
REVOKE ALL ON TABLE vendas FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nascera_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE vendas TO nascera_app';
  END IF;
END $$;
```

- [ ] **2.2** Sem Postgres disponível aqui, validar só sintaticamente (revisão manual linha a linha contra o padrão da 006/007). Marcar explicitamente no PR/checklist de deploy: "rodar `008-pacotes-avulsos.sql` contra um Postgres de staging antes de produção".

- [ ] **2.3** Commit isolado (arquivo `.sql` sozinho, sem código JS — facilita reverter se a validação em staging achar algo):
```bash
git add migracoes/008-pacotes-avulsos.sql
git commit -m "feat(db): migração 008 — coluna pacote_creditos em vendas (não testável neste ambiente)"
```

---

## Task 3: `servicos/vendas.js`: campo `pacoteCreditos`

**Files:**
- `servicos/vendas.js`
- `testes/vendas-pacotes.test.js` (novo)

**Interfaces:**
```js
// registrar(venda): venda.pacoteCreditos?: number|null — paralelo a venda.plano
// paraApp(r): devolve pacoteCreditos quando presente (mesma regra de omissão de null que já existe pros outros campos)
```

- [ ] **3.1** Criar `testes/vendas-pacotes.test.js`, isolando `NASCERA_VENDAS_FILE` (mesmo padrão já usado no arquivo real) e **sem** `NASCERA_DB_STATE=pg` (garante o caminho de arquivo, o único testável aqui):
```js
const fs = require('fs');
const os = require('os');
const path = require('path');
const ARQ = path.join(os.tmpdir(), 'nascera-test-vendas-pacotes-' + process.pid + '-' + Date.now() + '.json');
process.env.NASCERA_VENDAS_FILE = ARQ;
delete process.env.NASCERA_DB_STATE;

const test = require('node:test');
const assert = require('node:assert/strict');
const vendas = require('../servicos/vendas.js');

test('registrar(): pacoteCreditos é gravado; plano fica null (paralelo, nunca os dois)', async () => {
  const { venda, duplicada } = await vendas.registrar({
    gateway: 'hotmart', transactionId: 'tx-pacote-1', username: 'compradora',
    email: 'c@teste.com', valorBrl: 37.90, pacoteCreditos: 300, status: 'aprovada', origem: 'webhook',
  });
  assert.equal(duplicada, false);
  assert.equal(venda.pacoteCreditos, 300);
  assert.equal(venda.plano, null);
});

test('registrar(): venda de plano continua com pacoteCreditos null (regressão)', async () => {
  const { venda } = await vendas.registrar({
    gateway: 'hotmart', transactionId: 'tx-plano-1', username: 'compradora2',
    email: 'c2@teste.com', valorBrl: 95, plano: 'pro', status: 'aprovada', origem: 'webhook',
  });
  assert.equal(venda.plano, 'pro');
  assert.equal(venda.pacoteCreditos, null);
});

test('jaExiste + registrar: reentrega da mesma transação de pacote não duplica', async () => {
  await vendas.registrar({ gateway: 'kiwify', transactionId: 'tx-dup', pacoteCreditos: 100, status: 'aprovada' });
  assert.equal(await vendas.jaExiste('kiwify', 'tx-dup'), true);
  const { duplicada } = await vendas.registrar({ gateway: 'kiwify', transactionId: 'tx-dup', pacoteCreditos: 100, status: 'aprovada' });
  assert.equal(duplicada, true);
});
```
Rodar — falha (campo ainda não existe no objeto `registro`).

- [ ] **3.2** Em `registrar()`, adicionar ao objeto `registro`:
```js
pacoteCreditos: venda.pacoteCreditos != null ? (Math.round(Number(venda.pacoteCreditos)) || null) : null,
```
(logo depois de `plano: venda.plano || null,`). Rodar o teste — os dois primeiros passam (caminho de arquivo, sem PG); o terceiro já passava.

- [ ] **3.3** Atualizar o INSERT do caminho PG (mesmo bloco, para não deixar o código do Postgres divergente do de arquivo mesmo sem poder testá-lo aqui):
```js
const ins = await db.comSistema(cli => cli.query(
  `INSERT INTO vendas (id, gateway, transaction_id, username, email, valor_brl, meio,
     referencia, plano, pacote_creditos, origem, status, evento, registrada_por, criada_em)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
   ON CONFLICT (gateway, transaction_id) DO NOTHING
   RETURNING *`,
  [registro.id, gateway, transactionId, registro.username, registro.email,
   registro.valorBrl, registro.meio, registro.referencia, registro.plano, registro.pacoteCreditos,
   registro.origem, registro.status, registro.evento, registro.registradaPor, registro.criadaEm]));
```
Marcar com comentário `// PG: não testável neste ambiente — validar junto da migração 008 em staging.`

- [ ] **3.4** Atualizar `paraApp()`:
```js
pacoteCreditos: r.pacote_creditos != null ? Number(r.pacote_creditos) : null,
```
(logo depois de `plano: r.plano,`, antes do laço que remove chaves `null`/`undefined` — assim uma venda de plano não leva `pacoteCreditos: null` pro JSON de resposta, e vice-versa).

- [ ] **3.5** Rodar `node --test testes/vendas-pacotes.test.js` e depois `npm test` inteiro. Commit:
```bash
git add servicos/vendas.js testes/vendas-pacotes.test.js
git commit -m "feat(vendas): campo pacoteCreditos paralelo a plano (ledger de vendas)"
```

---

## Task 4: `rotas/webhooks.js`: `resolverPacote` + aplicação + correção da corrida

**Files:**
- `rotas/webhooks.js`
- `testes/webhooks-pacotes.test.js` (novo)

**Interfaces:**
```js
function resolverPacote(conf, ofertaId, produtoId)  // → id do pacote (string) | null — SEM padrão pega-tudo
function pacoteDoCatalogo(pacoteId)                  // → {id,creditos,precoBrl} | null
```

- [ ] **4.1** Criar `testes/webhooks-pacotes.test.js` montando um Express mínimo com `rotas/webhooks.js` real e deps injetadas (`billing`, `vendas` reais, isolados por env var; `segredos`/`loadNasceraConfig`/`USERS` em memória), usando o adaptador **Hotmart** (verificação por header simples, sem HMAC — o mais barato de simular; o núcleo depois do `validar()` é idêntico pros 4 gateways):
```js
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmpBase = path.join(os.tmpdir(), 'nascera-test-webhooks-' + process.pid + '-' + Date.now());
process.env.NASCERA_CONFIG_FILE = tmpBase + '-config.json';
process.env.NASCERA_BILLING_FILE = tmpBase + '-billing.json';
process.env.NASCERA_USAGE_EVENTS_FILE = tmpBase + '-events.jsonl';
process.env.NASCERA_VENDAS_FILE = tmpBase + '-vendas.json';
fs.writeFileSync(process.env.NASCERA_CONFIG_FILE, JSON.stringify({ billing: {} }));

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const billing = require('../billing.js');
const vendas = require('../servicos/vendas.js');
const senhas = require('../senhas.js');
const webhooksRotas = require('../rotas/webhooks.js');

const HOTTOK = 'segredo-de-teste';

function novaApp() {
  const app = express();
  app.use(express.json({
    limit: '1mb',
    verify: (req, _res, buf) => { if (req.url.indexOf('/api/webhooks/') === 0) req.corpoCru = buf; },
  }));
  const cofre = new Map([['gateway:hotmart:hottok', HOTTOK]]);
  const usersStore = {};
  let nasceraConfig = {
    billing: { mode: 'credits', pacotes: [{ id: 'pacote-300', creditos: 300, precoBrl: 37.90 }] },
    gateways: { hotmart: { planoPadrao: null, planoPorOferta: {}, pacotePorOferta: { 'oferta-pacote-300': 'pacote-300' } } },
  };
  webhooksRotas.registrar(app, {
    adminMiddleware: (req, _res, next) => { req.user = { user: 'admin-teste' }; next(); },
    loadUsers: () => usersStore,
    saveUsers: (u) => Object.assign(usersStore, u),
    senhas, billing, vendas,
    segredos: {
      guardar: (id, v) => cofre.set(id, v),
      obter: (id) => cofre.get(id) || null,
      esquecer: (id) => cofre.delete(id),
    },
    loadNasceraConfig: () => nasceraConfig,
    saveNasceraConfig: (c) => { nasceraConfig = c; },
    appendActivity: () => {}, trackEvent: () => {}, USERS: {},
    email: null,
  });
  return app;
}

function eventoHotmart(txId, ofertaId, emailComprador) {
  return {
    event: 'PURCHASE_APPROVED', id: txId,
    data: {
      purchase: { transaction: txId, price: { value: 37.90 }, offer: { code: ofertaId } },
      buyer: { email: emailComprador, name: 'Compradora Teste' },
      product: { id: 'produto-1' },
    },
  };
}
async function postWebhook(base, body) {
  return fetch(base + '/api/webhooks/hotmart', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hotmart-hottok': HOTTOK },
    body: JSON.stringify(body),
  }).then(r => r.json());
}

test('oferta mapeada para pacote credita saldo "comprado" e NÃO troca de plano', async (t) => {
  const app = novaApp();
  const server = app.listen(0);
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const email = 'compradora-' + Date.now() + '@teste.com';
  const r = await postWebhook(base, eventoHotmart('tx-1', 'oferta-pacote-300', email));
  assert.equal(r.ok, true);
  assert.equal(r.plano, null);
  assert.equal(r.pacote, 'pacote-300');
  const [venda] = await vendas.listar({ gateway: 'hotmart' });
  assert.equal(venda.pacoteCreditos, 300);
  assert.equal(venda.plano, null);
  const s = billing.summaryFor(r.username);
  assert.equal(s.saldosPorOrigem.compradoMilli, 300000);
});

test('idempotência: a mesma transação reentregue não credita 2×', async (t) => {
  const app = novaApp();
  const server = app.listen(0);
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const email = 'compradora2-' + Date.now() + '@teste.com';
  const r1 = await postWebhook(base, eventoHotmart('tx-2', 'oferta-pacote-300', email));
  const r2 = await postWebhook(base, eventoHotmart('tx-2', 'oferta-pacote-300', email));
  assert.equal(r2.duplicada, true);
  const s = billing.summaryFor(r1.username);
  assert.equal(s.saldosPorOrigem.compradoMilli, 300000);
});

test('oferta sem mapeamento nenhum cai em "sem_plano", como antes', async (t) => {
  const app = novaApp();
  const server = app.listen(0);
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const r = await postWebhook(base, eventoHotmart('tx-3', 'oferta-desconhecida', 'x-' + Date.now() + '@teste.com'));
  assert.equal(r.pendente, true);
  assert.equal(r.plano, null);
  assert.equal(r.pacote, null);
});

test('PUT /api/admin/gateways/:id rejeita oferta mapeada pra plano E pacote ao mesmo tempo', async (t) => {
  const app = novaApp();
  const server = app.listen(0);
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const r = await fetch(base + '/api/admin/gateways/hotmart', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planoPorOferta: { 'oferta-x': 'pro' }, pacotePorOferta: { 'oferta-x': 'pacote-300' } }),
  }).then(r => r.json());
  assert.match(r.error, /plano E pacote/);
});
```
Rodar `node --test testes/webhooks-pacotes.test.js` — todos falham (nada implementado ainda).

- [ ] **4.2** Em `rotas/webhooks.js`, adicionar depois de `resolverPlano`:
```js
// Irmã de resolverPlano, mas SEM padrão pega-tudo: pacote é avulso, não
// mensalidade — não existe "pacote padrão pra toda oferta sem mapeamento".
// Só resolve com mapeamento EXPLÍCITO em conf.pacotePorOferta.
function resolverPacote(conf, ofertaId, produtoId) {
  const mapa = (conf && conf.pacotePorOferta) || {};
  return (ofertaId && mapa[String(ofertaId)]) || (produtoId && mapa[String(produtoId)]) || null;
}
function pacoteDoCatalogo(pacoteId) {
  if (!pacoteId) return null;
  return (billing.getConfig().pacotes || []).find(p => p.id === pacoteId) || null;
}
```
(`billing` já está em `deps`, disponível no escopo de `registrar`.)

- [ ] **4.3** Substituir o corpo do `if (ev.tipo === 'aprovada')` (do `const conf = cfgDe(gid);` até o `return res.json({ ok: true, gateway: gid, ... })`) por:
```js
const conf = cfgDe(gid);
// Pacote resolve PRIMEIRO: resolverPlano tem um padrão pega-tudo
// (conf.planoPadrao) — se rodasse antes, uma oferta pensada pra pacote
// mas ainda sem mapeamento cairia no plano padrão do gateway por engano.
// Pacote nunca tem padrão, então checá-lo primeiro nunca desvia uma
// venda de plano de verdade.
const pacoteId = resolverPacote(conf, ev.ofertaId, ev.produtoId);
const pacote = pacoteId ? pacoteDoCatalogo(pacoteId) : null;
const plano = pacoteId ? null : resolverPlano(conf, ev.ofertaId, ev.produtoId);
const emailComprador = ev.email || null;
let username = acharPorEmail(emailComprador) ||
               (ev.referenciaExterna ? acharPorEmail(ev.referenciaExterna) : null) ||
               (ev.referenciaExterna && loadUsers()[ev.referenciaExterna] ? ev.referenciaExterna : null);
let criado = false, tokenAcesso = null;
if (!username && emailComprador) {
  const novo = await criarComprador(emailComprador, ev.nome, gid);
  username = novo.username; tokenAcesso = novo.token; criado = true;
}

let status = 'aprovada';
if (username && plano) {
  try { billing.setUserPlan(username, plano); }
  catch (e) { status = 'sem_plano'; }   // plano do mapa não existe mais
} else if (!(username && pacote)) {
  status = 'sem_plano';                  // sem mapeamento ou sem e-mail
}
// pacote (se houver) NÃO é aplicado aqui ainda — só depois que o registro
// abaixo vencer a corrida contra uma reentrega simultânea. setUserPlan
// pode rodar antes porque aplicar o MESMO plano 2× é inofensivo;
// addBalance não é — duas entregas quase simultâneas passariam pelo
// jaExiste() dos dois lados antes de qualquer uma vencer o ledger.

const reg = await vendas.registrar({
  gateway: gid, transactionId: ev.txId, username, email: emailComprador,
  valorBrl: ev.valorBrl || 0, meio: gid, referencia: ev.txId,
  plano: status === 'aprovada' && plano ? plano : null,
  pacoteCreditos: status === 'aprovada' && pacote ? pacote.creditos : null,
  origem: 'webhook', status, evento: ev.evento,
});
// Corrida entre duas entregas simultâneas: o UNIQUE decide — quem perdeu
// NÃO manda e-mail, NÃO conta como criado, e (novo) NÃO credita o pacote.
if (reg.duplicada) return res.json({ ok: true, duplicada: true });

if (status === 'aprovada' && pacote) {
  billing.addBalance(username, pacote.creditos, 'Pacote ' + pacote.id);
}

if (email && emailComprador) {
  const nome = ev.nome || username;
  if (criado && tokenAcesso) {
    email.enviarEvento('boas-vindas', emailComprador, {
      nome, usuario: username, link: urlBase() + '/definir-senha.html?t=' + tokenAcesso,
    });
  } else if (status === 'aprovada') {
    email.enviarEvento('compra-confirmada', emailComprador, {
      nome, plano: pacote ? ('Pacote de ' + pacote.creditos + ' créditos') : plano,
      valor: (ev.valorBrl || 0).toFixed(2).replace('.', ','),
    });
  }
}
appendActivity({
  type: status === 'aprovada' ? 'venda_gateway' : 'venda_gateway_pendente',
  user: username || emailComprador || '?',
  data: { gateway: gid, txId: ev.txId, plano, pacote: pacote ? pacote.id : null, valor: ev.valorBrl, criado,
          motivo: status === 'aprovada' ? null : 'sem mapeamento de plano/pacote ou sem e-mail' },
  at: new Date().toISOString(),
});
return res.json({
  ok: true, gateway: gid, username,
  plano: status === 'aprovada' && plano ? plano : null,
  pacote: status === 'aprovada' && pacote ? pacote.id : null,
  criado, pendente: status !== 'aprovada',
});
```
Rodar os 3 primeiros testes — devem passar.

- [ ] **4.4** Atualizar `GET /api/admin/gateways` (adicionar `pacotePorOferta: conf.pacotePorOferta || {}` ao `Object.assign` de retorno) e `PUT /api/admin/gateways/:id`:
```js
const planoPorOferta = (corpo.planoPorOferta && typeof corpo.planoPorOferta === 'object') ? corpo.planoPorOferta : {};
const pacotePorOferta = (corpo.pacotePorOferta && typeof corpo.pacotePorOferta === 'object') ? corpo.pacotePorOferta : {};
// A mesma oferta nunca pode significar plano E pacote — rejeitado AQUI
// (config), nunca em runtime: em runtime resolverPacote()/resolverPlano()
// resolveriam pra um dos dois silenciosamente.
const conflitos = Object.keys(planoPorOferta).filter(k => pacotePorOferta[k] !== undefined);
if (conflitos.length) {
  return res.status(400).json({ error: 'Oferta mapeada para plano E pacote ao mesmo tempo: ' + conflitos.join(', ') });
}
const cfg = loadNasceraConfig();
cfg.gateways = cfg.gateways || {};
cfg.gateways[gid] = { planoPadrao: corpo.planoPadrao || null, planoPorOferta, pacotePorOferta };
saveNasceraConfig(cfg);
```
Rodar o 4º teste — deve passar.

- [ ] **4.5** Rodar `node --test testes/webhooks-pacotes.test.js` completo, depois `npm test` inteiro (regressão nos outros arquivos). Commit:
```bash
git add rotas/webhooks.js testes/webhooks-pacotes.test.js
git commit -m "feat(webhooks): resolverPacote + aplicação de pacote sem corrida de crédito duplo"
```

---

## Task 5: `rotas/compras.js`: `GET /api/billing/pacotes`

**Files:** `rotas/compras.js`

*(Nota de escopo: `POST /api/billing/estimar`, listado nos "Arquivos críticos" da spec para este arquivo, é da Parte A — fora do escopo deste plano.)*

- [ ] **5.1** Não há suíte de rotas em `node --test` para `compras.js` hoje — a cobertura automatizada real do catálogo de pacotes já está na Tarefa 4, via `billing.getConfig().pacotes`; aqui a rota é uma leitura fina de config, sem lógica de negócio nova. Verificar manualmente com o servidor rodando: `curl -H "Authorization: Bearer $TOKEN" localhost:PORT/api/billing/pacotes`.

- [ ] **5.2** Implementar, ao lado de `GET /api/billing/planos`:
```js
app.get('/api/billing/pacotes', authMiddleware, (_req, res) => {
  const cfg = loadNasceraConfig();
  const b = cfg.billing || {};
  res.json({
    pacotes: (b.pacotes || []).filter(p => p.creditos > 0 && p.precoBrl > 0)
      .map(p => ({ id: p.id, creditos: p.creditos, precoBrl: p.precoBrl })),
  });
});
```

- [ ] **5.3** Verificar manualmente (passo 5.1) e commit:
```bash
git add rotas/compras.js
git commit -m "feat(compras): GET /api/billing/pacotes (catálogo público de pacotes avulsos)"
```

---

## Task 6: `public/comprar.html`: catálogo de pacotes pro cliente

**Files:** `public/comprar.html`

- [ ] **6.1** Verificação manual: abrir `comprar.html` num navegador/`curl` antes da mudança, confirmar que hoje não renderiza pacote nenhum (baseline).

- [ ] **6.2** Adicionar HTML depois do `<div class="planos" id="planos"></div>` existente:
```html
<h2 style="font-size:16px;font-weight:600;margin:32px 0 4px">Pacotes de créditos avulsos</h2>
<p class="sub" style="margin-bottom:14px">Créditos que não expiram com o mês — use quando o plano acabar. A compra é feita na página do gateway; aqui é só o catálogo.</p>
<div class="planos" id="pacotes"></div>
```

- [ ] **6.3** Adicionar no `<script>`, ao lado do `.then` de `/api/billing/planos`:
```js
api('/api/billing/pacotes').then(function(d) {
  document.getElementById('pacotes').innerHTML = (d.pacotes || []).map(function(p) {
    return '<div class="plano">' +
      '<h3>' + p.creditos + ' créditos</h3>' +
      '<div class="preco">R$ ' + p.precoBrl.toFixed(2).replace('.', ',') + '</div>' +
      '</div>';
  }).join('') || '<p style="color:#67637d;font-size:13.5px">Nenhum pacote disponível no momento.</p>';
});
```

- [ ] **6.4** Verificação manual: recarregar `comprar.html` com o backend das Tarefas 1/5 no ar, confirmar os 6 cards de pacote aparecendo com os preços do doc. Commit:
```bash
git add public/comprar.html
git commit -m "feat(comprar): catálogo de pacotes avulsos na tela do cliente"
```

---

## Task 7: `rotas/admin-billing.js`: aceitar `pacotes` no PUT de config

**Files:** `rotas/admin-billing.js`

- [ ] **7.1** A validação real (`validatePacotes`) já tem teste na Tarefa 1 — aqui é só fiação da rota; verificação manual com `curl` (payload com `pacotes` inválido → 400; válido → 200 e `GET /api/admin/billing` devolve `config.pacotes` atualizado).

- [ ] **7.2** Em `PUT /api/admin/billing/config`, adicionar ao destructuring do body: `pacotes`. Depois do bloco `if (plans !== undefined) { ... }`, adicionar:
```js
if (pacotes !== undefined) {
  if (!Array.isArray(pacotes)) return res.status(400).json({ error: 'Lista de pacotes inválida' });
  const cleanPacotes = pacotes.map(p => ({
    id: String(p.id || '').trim(),
    creditos: Math.max(0, Math.round(parseFloat(p.creditos) || 0)),
    precoBrl: Math.max(0, parseFloat(p.precoBrl) || 0),
  }));
  try {
    warnings = warnings.concat(billing.validatePacotes(cleanPacotes));
  } catch (err) { return res.status(400).json({ error: err.message }); }
  b.pacotes = cleanPacotes;
}
```
(`warnings` já existe como `let` no escopo da função, populado antes por `models`/`plans`.)

- [ ] **7.3** Verificação manual (passo 7.1). Commit:
```bash
git add rotas/admin-billing.js
git commit -m "feat(admin-billing): aceitar e validar pacotes em PUT /api/admin/billing/config"
```

---

## Task 8: `public/admin.html`: editor de pacotes + reconstrução da config de gateway

**Files:** `public/admin.html`

- [ ] **8.1** **Editor do catálogo de pacotes** (mirror exato de `bill-plans-card`/`renderBillPlans`). Adicionar HTML depois do `bill-plans-card` (antes do card "Usuários"):
```html
<div class="card" style="margin-bottom:14px" id="bill-pacotes-card">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
    <div class="stat-label" style="margin:0">Pacotes avulsos de créditos</div>
    <button class="btn btn-ghost btn-xs" onclick="billAddPacote()">+ Pacote</button>
  </div>
  <div id="bill-pacotes-tbody"></div>
  <p style="font-size:10.5px;color:rgba(255,255,255,.25);margin:10px 0 0">Origem "comprado", validade em creditoCompradoValidadeDias (mesma regra do saldo avulso). O id de cada pacote é usado no mapeamento oferta→pacote de cada gateway, abaixo.</p>
</div>
```
JS:
```js
function renderBillPacotes() {
  document.getElementById('bill-pacotes-tbody').innerHTML = (_billCfg.pacotes || []).map(function(p, i) {
    return '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;padding:10px 14px;border-radius:12px;margin-bottom:8px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06)">' +
      '<div><label class="inp-label" style="font-size:10px">Id</label><input class="inp" style="width:110px;padding:6px 8px;font-size:11.5px" value="' + esc(p.id) + '" onchange="_billCfg.pacotes[' + i + '].id=this.value"/></div>' +
      '<div><label class="inp-label" style="font-size:10px">Créditos</label><input class="inp" style="width:80px;padding:6px 8px;font-size:11.5px" type="number" min="1" step="1" value="' + p.creditos + '" onchange="_billCfg.pacotes[' + i + '].creditos=parseInt(this.value,10)||0"/></div>' +
      '<div><label class="inp-label" style="font-size:10px">Preço (R$)</label><input class="inp" style="width:80px;padding:6px 8px;font-size:11.5px" type="number" min="0" step="0.01" value="' + p.precoBrl + '" onchange="_billCfg.pacotes[' + i + '].precoBrl=parseFloat(this.value)||0"/></div>' +
      '<button class="btn btn-danger btn-xs" style="margin-left:auto" onclick="_billCfg.pacotes.splice(' + i + ',1);renderBillPacotes()">Remover</button>' +
    '</div>';
  }).join('');
}
function billAddPacote() {
  _billCfg.pacotes = _billCfg.pacotes || [];
  _billCfg.pacotes.push({ id: 'pacote-' + Date.now().toString(36), creditos: 100, precoBrl: 19.90 });
  renderBillPacotes();
}
```
Em `loadBilling()`, adicionar `renderBillPacotes();` ao lado de `renderBillPlans();`. Em `saveBillingConfig()`, adicionar ao `body`:
```js
pacotes: (_billCfg.pacotes || []).map(function(p) { return { id: p.id, creditos: p.creditos || 0, precoBrl: p.precoBrl || 0 }; }),
```

- [ ] **8.2** Verificação manual: abrir `/admin.html`, aba de billing, confirmar os 6 pacotes padrão aparecendo, editar/adicionar/remover, salvar, recarregar — persistiu.

- [ ] **8.3** **Remover o formulário morto de Hotmart único**: excluir do HTML os inputs `hm-url`, `hm-hottok`, `hm-hottok-estado`, `hm-plano` e o botão que chama `salvarHotmart()`; excluir a função JS `salvarHotmart()`; em `loadVendas()`, remover as linhas que leem `/api/admin/webhooks/hotmart` e populam esses inputs — manter só o resumo/tabela de vendas e o card de Pix (`px-chave`/`px-titular`, que continua funcionando via `PUT /api/admin/pagamentos/pix`).

- [ ] **8.4** **UI genérica de gateways** (4 cards, dirigidos por `GET /api/admin/gateways`), no lugar do formulário removido:
```html
<div class="card" style="margin-bottom:14px" id="gw-card">
  <div class="stat-label" style="margin-bottom:10px">Gateways de pagamento (automáticos)</div>
  <div id="gw-list"></div>
</div>
```
JS:
```js
function loadGateways() {
  api('/api/admin/gateways').then(function(d) {
    if (d.error) return;
    document.getElementById('gw-list').innerHTML = (d.gateways || []).map(renderGatewayCard).join('');
  });
}
function gwOpcoesValor(tipo, atual) {
  var lista = tipo === 'pacote' ? (_billCfg.pacotes || []) : (_billCfg.plans || []);
  return lista.map(function(x) {
    var id = tipo === 'pacote' ? x.id : x.slug;
    var rotulo = tipo === 'pacote' ? (x.creditos + ' créditos (R$ ' + x.precoBrl + ')') : x.name;
    return '<option value="' + esc(id) + '"' + (id === atual ? ' selected' : '') + '>' + esc(rotulo) + '</option>';
  }).join('');
}
function linhaMapaHtml(l) {
  return '<div class="gw-linha-mapa" style="display:flex;gap:6px;margin-bottom:6px">' +
    '<input class="inp gw-mapa-chave" style="width:140px" value="' + esc(l.chave) + '" placeholder="id da oferta/produto"/>' +
    '<select class="inp gw-mapa-tipo" style="width:90px" onchange="gwTrocaTipo(this)">' +
      '<option value="plano"' + (l.tipo === 'plano' ? ' selected' : '') + '>Plano</option>' +
      '<option value="pacote"' + (l.tipo === 'pacote' ? ' selected' : '') + '>Pacote</option></select>' +
    '<select class="inp gw-mapa-valor" style="width:180px">' + gwOpcoesValor(l.tipo, l.valor) + '</select>' +
    '<button class="btn btn-danger btn-xs" onclick="this.closest(\'.gw-linha-mapa\').remove()">×</button></div>';
}
function gwTrocaTipo(sel) {
  sel.parentNode.querySelector('.gw-mapa-valor').innerHTML = gwOpcoesValor(sel.value, null);
}
function renderGatewayCard(g) {
  var linhas = [];
  Object.keys(g.planoPorOferta || {}).forEach(function(k) { linhas.push({ chave: k, tipo: 'plano', valor: g.planoPorOferta[k] }); });
  Object.keys(g.pacotePorOferta || {}).forEach(function(k) { linhas.push({ chave: k, tipo: 'pacote', valor: g.pacotePorOferta[k] }); });
  var planoOpts = '<option value="">— escolher plano —</option>' + (_billCfg.plans || []).map(function(p) {
    return '<option value="' + esc(p.slug) + '"' + (g.planoPadrao === p.slug ? ' selected' : '') + '>' + esc(p.name) + '</option>';
  }).join('');
  return '<div class="gw-card" data-gw="' + g.id + '" style="padding:14px 16px;border-radius:12px;margin-bottom:12px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06)">' +
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">' +
      '<strong>' + esc(g.nome) + '</strong>' +
      '<span style="font-size:11px;color:' + (g.configurado ? '#4ade80' : 'rgba(255,255,255,.4)') + '">' + (g.configurado ? 'configurado' : 'faltando: ' + g.faltando.join(', ')) + '</span>' +
    '</div>' +
    '<input readonly value="' + location.origin + g.url + '" onclick="this.select()" style="width:100%;margin-bottom:8px;padding:7px 10px;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.08);border-radius:7px;color:rgba(255,255,255,.6);font-size:11px;font-family:ui-monospace,monospace"/>' +
    g.campos.map(function(c) {
      return '<div style="margin-bottom:8px"><label class="inp-label" style="font-size:10px">' + esc(c.rotulo) + '</label>' +
        '<input class="inp gw-campo" data-campo="' + c.id + '" type="password" placeholder="' + (g.valores[c.id] ? 'Configurado (' + g.valores[c.id] + ') — cole outro para trocar' : c.ajuda) + '" autocomplete="off"/></div>';
    }).join('') +
    '<div style="margin-bottom:8px"><label class="inp-label" style="font-size:10px">Plano padrão (oferta sem mapeamento)</label><select class="inp gw-plano-padrao" style="width:220px">' + planoOpts + '</select></div>' +
    '<div class="stat-label" style="margin:10px 0 6px;font-size:10px">Oferta/produto → plano ou pacote</div>' +
    '<div class="gw-mapa">' + linhas.map(linhaMapaHtml).join('') + '</div>' +
    '<button class="btn btn-ghost btn-xs" onclick="this.closest(\'.gw-card\').querySelector(\'.gw-mapa\').insertAdjacentHTML(\'beforeend\', linhaMapaHtml({chave:\'\',tipo:\'plano\',valor:null}))">+ Mapeamento</button> ' +
    '<button class="btn btn-primary btn-xs" style="margin-left:8px" onclick="salvarGateway(\'' + g.id + '\', this)">Salvar ' + esc(g.nome) + '</button>' +
  '</div>';
}
function salvarGateway(gid, btn) {
  var card = btn.closest('.gw-card');
  var planoPorOferta = {}, pacotePorOferta = {}, conflitos = [];
  card.querySelectorAll('.gw-linha-mapa').forEach(function(linha) {
    var chave = linha.querySelector('.gw-mapa-chave').value.trim();
    var valor = linha.querySelector('.gw-mapa-valor').value;
    if (!chave || !valor) return;
    var tipo = linha.querySelector('.gw-mapa-tipo').value;
    if (tipo === 'pacote') { if (planoPorOferta[chave] !== undefined) conflitos.push(chave); pacotePorOferta[chave] = valor; }
    else { if (pacotePorOferta[chave] !== undefined) conflitos.push(chave); planoPorOferta[chave] = valor; }
  });
  if (conflitos.length) return alert('Oferta mapeada para plano E pacote ao mesmo tempo: ' + conflitos.join(', ') + '.');
  var body = { planoPadrao: card.querySelector('.gw-plano-padrao').value || null, planoPorOferta: planoPorOferta, pacotePorOferta: pacotePorOferta };
  card.querySelectorAll('.gw-campo').forEach(function(inp) { if (inp.value.trim()) body[inp.dataset.campo] = inp.value.trim(); });
  api('/api/admin/gateways/' + gid, { method: 'PUT', body: JSON.stringify(body) }).then(function(r) {
    if (r.error) return alert(r.error);
    loadGateways();
  });
}
```
Chamar `loadGateways();` dentro de `loadBilling()` (depois de `_billCfg = d.config;`, já que `gwOpcoesValor` depende de `_billCfg.plans`/`_billCfg.pacotes` estarem carregados).

- [ ] **8.5** Verificação manual completa: configurar um segredo de teste num gateway, mapear uma oferta pra pacote e outra pra plano, salvar, recarregar a página e confirmar que os mapeamentos persistiram; tentar mapear a mesma oferta pros dois e confirmar o alerta de conflito antes de qualquer chamada de rede bem-sucedida.

- [ ] **8.6** Commit:
```bash
git add public/admin.html
git commit -m "feat(admin): editor de pacotes avulsos + UI genérica de gateways (plano e pacote por oferta)"
```

---

## Arquivos críticos (Parte B)

- `billing.js` — `DEFAULT_PACOTES`, `validatePacotes`, `getConfig`/`defaultConfig` (`pacotes[]`), `addBalance` (reaproveitada sem mudar assinatura).
- `rotas/webhooks.js` — `resolverPacote`, `pacoteDoCatalogo`, ramo de aplicação reordenado (crédito de pacote só após `vendas.registrar()` vencer a corrida), validação de conflito em `PUT /api/admin/gateways/:id`.
- `servicos/vendas.js` + `migracoes/008-pacotes-avulsos.sql` — campo `pacoteCreditos`.
- `rotas/compras.js` — `GET /api/billing/pacotes`.
- `rotas/admin-billing.js` — aceita/valida `pacotes` em `PUT /api/admin/billing/config`.
- `public/comprar.html` (não `app.html` — ver correção no topo) — catálogo de pacotes pro cliente.
- `public/admin.html` — editor do catálogo de pacotes + UI de mapeamento oferta→plano/pacote por gateway (substitui o formulário Hotmart único morto).

## Riscos e decisões a confirmar

1. **Padrão da spec ("mesma tela de planos que já existe") não corresponde ao código real** — a tela é `comprar.html`, não `app.html`; e a tela de config de gateway do admin nunca foi migrada pro backend genérico de 4 gateways. Corrigido nas Tarefas 6 e 8 (documentado no topo deste plano).
2. **Corrida de crédito em dobro** em reentrega quase simultânea da mesma venda de pacote — `addBalance` não é idempotente como `setUserPlan`. Corrigido na Tarefa 4 (crédito só depois de `vendas.registrar()` vencer a corrida).
3. **Migração de contas já usando pacotes**: não há usuários em produção ainda (mesma premissa da Fase 1) — o catálogo nasce populado com os 6 pacotes padrão do doc, sem migração de dado necessária.
4. **Reembolso de venda de pacote** — decisão documentada no Review Focus #5.

## Plano de testes

- `testes/billing-pacotes.test.js` (novo): catálogo padrão de 6 pacotes, `validatePacotes` (id duplicado rejeita, créditos/preço zerados avisam sem bloquear).
- `testes/vendas-pacotes.test.js` (novo): `pacoteCreditos` persiste e é devolvido; venda de plano continua com `pacoteCreditos: null` (regressão); idempotência de `jaExiste`/`registrar` no modo arquivo.
- `testes/webhooks-pacotes.test.js` (novo): oferta mapeada pra pacote chama `addBalance` e NÃO `setUserPlan`; idempotência de reentrega preservada (saldo não dobra); oferta sem mapeamento nenhum cai em `sem_plano` como hoje; `PUT /api/admin/gateways/:id` rejeita oferta mapeada pra plano E pacote ao mesmo tempo.
- Migração SQL: **não testável neste ambiente** (sem Postgres/`DATABASE_URL`) — validar em staging antes de produção, mesma ressalva já usada na migração 007.

## Verificação end-to-end

- `npm test` cobrindo os 3 arquivos novos, sem regressão nos existentes.
- Manual: configurar uma oferta de teste num gateway (Tarefa 8) mapeada para um pacote, disparar uma venda de teste (ou reusar o teste de integração da Tarefa 4 como script manual) e confirmar que credita o saldo "comprado" em vez de trocar de plano; confirmar em `comprar.html` que o catálogo de pacotes aparece com os 6 preços do doc.
