# Planos, Créditos e Motor 2 — Fase 2 (classificador de operação + pacotes avulsos)

Status: aprovado para implementação (spec) — implementação ainda não iniciada.

## Contexto

A Fase 1 (ver `docs/superpowers/specs/` do núcleo de billing, e o histórico de commits recentes)
implementou os 4 planos comerciais, o ledger de créditos por origem (premium/bônus/comprado) e o
Motor 2, deixando duas peças do documento `NASCERA_Documento_Tecnico_Comercial_Planos_Creditos_Motor2.pdf`
deliberadamente de fora, documentadas como "Fase 2":

1. **Cobrança por preço fixo por operação** — a tabela de créditos por tipo de tarefa (criar
   componente = 5, CRUD = 22, API = 20, etc.) que hoje só existe como estimativa estática de UX; o
   valor realmente debitado continua vindo do custo real em tokens.
2. **Compra avulsa de pacotes de créditos** (100 a 10.000, com preço decrescente por volume) — que
   hoje não existe como fluxo nenhum; só há compra de PLANO inteiro.

Esta spec cobre as duas, tratadas como um projeto único a pedido do usuário — mas com seções
internas separadas (Parte A / Parte B) porque são tecnicamente quase independentes.

## Decisões fechadas nesta rodada (não reabrir durante a implementação)

| Decisão | Escolha | Por quê |
|---|---|---|
| Mecanismo do classificador de categoria | Heurística por padrão de arquivo/diff, PÓS-turno | Usa o que já flui (eventos `tool_use` do motor), sem custo/latência extra de IA. Mesma filosofia do classificador do pipeline de planejamento: heurística v1 simples, documentada como recalibrável. |
| Turno com múltiplas categorias | Soma dos créditos de cada categoria encontrada, por ARQUIVO único tocado | Mais justo com o valor entregue num turno grande; um arquivo tocado duas vezes no mesmo turno conta uma vez só. |
| Turno sem categoria reconhecida | Cai no motor de custo real (tokens×markup) já existente | Nunca cobra errado (nem de menos nem de graça) por falta de reconhecimento — o fallback já está testado. |
| Coexistência com o custo real | Os dois convivem: cliente paga o preço fixo; o custo real continua calculado e registrado (não debitado) para o dashboard de margem/desvio (doc §12) | É exatamente o que o documento comercial pede na seção de controle econômico. |
| Ativação do preço fixo | Toggle global do admin (`cfg.billing.precoFixoAtivo`, default `false`) | Mesmo padrão já usado para `pipelineAutomatico` e `motor2.ligado` — permite ligar/desligar sem deploy. |
| Estimativa prévia de créditos (doc §11) | Entra nesta Fase 2, via endpoint dedicado (classificador de INTENÇÃO, separado do classificador de RESULTADO usado pra cobrar) | Evita duplicar lógica de classificação no front; é deliberadamente aproximada. |
| Checkout dos pacotes avulsos | Os 4 gateways automáticos (Hotmart/Kiwify/Asaas/Mercado Pago) desde o início | Reaproveita o núcleo de webhook já testado (`rotas/webhooks.js`) — extensão pequena, não um fluxo novo. |

## Parte A — Classificador de operação + preço fixo

### A.1 — Sinal de classificação: eventos `tool_use` acumulados por turno

`servicos/motor-canal.js` (`bindChannel`) já recebe `session.on('tool_use', (tu) => ...)` por turno,
com `tu.tool` (`Write`/`Edit`/`MultiEdit`/`NotebookEdit`/outros) e `tu.input` (contém o caminho do
arquivo para as ferramentas de escrita). Em vez de reconstruir um `git diff` depois do fato, o canal
passa a acumular uma lista `ch._arquivosTocados` (Set de caminhos, só ferramentas de
escrita/edição) durante o turno, zerada a cada novo turno iniciado, e entrega essa lista ao
classificador no momento do `result`.

### A.2 — Novo serviço `servicos/classificador-operacao.js` (mesmo formato de `planejamento-automatico.js`)

Exporta `classificar(arquivosTocados, contextoProjeto)` → devolve uma lista de categorias detectadas
(uma por arquivo, pode repetir). Tabela de categorias e créditos (do doc, seção 5), com padrões de
primeira versão (a recalibrar com telemetria real, mesmo aviso que o doc já faz sobre a própria
tabela):

| Categoria | Créditos | Padrão de detecção (v1) |
|---|---|---|
| Alterar texto/botão | 2 | Edit em arquivo já existente, diff pequeno (heurística de tamanho) |
| Alterar estilo | 3 | Edit em arquivo CSS/estilo ou bloco de estilo inline |
| Remover componente | 3 | Edit que remove um bloco de componente sem criar arquivo novo |
| Criar componente | 5 | Write de um arquivo novo dentro da pasta de componentes do tema |
| Página simples | 8 | Write de um arquivo novo de página, sem indícios de formulário/API |
| Landing page completa | 17 | Write de múltiplos arquivos de uma página só, com seções (hero/features/cta) |
| Formulário + validação | 10 | Arquivo novo/editado com padrão de formulário + validação |
| Login/cadastro | 14 | Arquivo relacionado a `auth`/`login`/`cadastro`/`senha` |
| CRUD | 22 | Conjunto de arquivos (rota + modelo + UI) de um mesmo recurso |
| API | 20 | Caminho dentro de `rotas/`/`api/` |
| Dashboard | 25 | Página com múltiplos widgets/gráficos |
| Upload/storage | 16 | Padrão de upload de arquivo/imagem |
| Pagamento/checkout | 27 | Caminho ou conteúdo relacionado a `pagamento`/`checkout`/gateway |
| Correção média | 14 | Edit em resposta a um pedido classificado como correção (reaproveita sinal do classificador de planejamento) |
| Refatoração grande | 36 | Muitos arquivos editados, poucos criados |
| Módulo complexo | 54 | Muitos arquivos criados, atravessando front+back |

Nenhum padrão bate → o arquivo não entra na soma (vira parte do fallback de custo real se NENHUM
arquivo do turno bater com nada).

### A.3 — Débito com preço fixo (`billing.js`, extensão de `debitTurn`)

`debitTurn(username, turn, turnId)` continua sendo a única função de débito — `priceTurn()` (custo
real) roda em TODO turno, sem exceção, porque alimenta o dashboard de margem/desvio (doc §12). A
diferença: `turn` ganha um campo opcional `creditosFixos` (a soma calculada pela Parte A.2). Quando
`cfg.billing.precoFixoAtivo` está ligado E `creditosFixos` foi informado, ELE (não o valor derivado de
`chargedUsd`) é o que determina `costMilli` — e a partir daí a mecânica de ordem (bônus → premium 90%
→ comprado → overage), idempotência, ledger append-only e espelho Postgres continuam EXATAMENTE
iguais à Fase 1, sem duplicar lógica. `baseUsd`/`chargedUsd` reais continuam gravados no evento do
ledger (campos novos `realBaseUsd`/`realChargedUsd`, paralelos aos já existentes) só para auditoria de
margem — nunca usados para decidir quanto debitar quando o toggle está ligado.

Quando `precoFixoAtivo` está desligado (default), o comportamento é idêntico ao da Fase 1 — nenhuma
mudança visível.

### A.4 — Estimativa prévia (doc §11)

Novo endpoint `POST /api/billing/estimar` (síncrono, sem custo de IA): recebe o texto da mensagem
ainda não enviada, roda uma heurística de palavra-chave (separada e mais simples que a de A.2 — essa
classifica a INTENÇÃO antes de qualquer arquivo existir) e devolve uma faixa aproximada de créditos.
O composer (`public/app.html`) chama esse endpoint ao digitar (debounced) e mostra a estimativa antes
do envio — deliberadamente aproximada, nunca o valor exato cobrado.

## Parte B — Pacotes avulsos de créditos

### B.1 — Catálogo (`nascera-config.json`, `billing.pacotes[]`)

Novo array paralelo a `billing.plans[]`: `{ id, creditos, precoBrl }` — populado por padrão com a
tabela do doc (100/R$19,90, 300/R$37,90, 1.000/R$99,90, 2.500/R$189,90, 5.000/R$369,90,
10.000/R$695,90). Editável pelo admin no mesmo padrão da tela de planos.

### B.2 — Extensão do núcleo de webhook (`rotas/webhooks.js`)

Hoje `resolverPlano(conf, ofertaId, produtoId)` resolve só planos via `conf.planoPorOferta`. Ganha uma
função irmã `resolverPacote(conf, ofertaId, produtoId)` lendo um novo mapa `conf.pacotePorOferta`. No
núcleo do webhook (`app.post('/api/webhooks/:gateway', ...)`), depois de tentar resolver um plano,
tenta resolver um pacote; se resolver um pacote em vez de um plano, chama `billing.addBalance(username,
pacote.creditos, 'Pacote ' + pacote.id)` em vez de `billing.setUserPlan`. Mesma idempotência
(`vendas.jaExiste`), mesmo ledger, mesmo e-mail de confirmação — só muda o que é aplicado. Uma oferta
nunca mapeia para plano E pacote ao mesmo tempo (validação na tela de configuração do gateway).

### B.3 — Ledger (`servicos/vendas.js` + nova migração)

Nova migração (`008-pacotes-avulsos.sql`): `ALTER TABLE vendas ADD COLUMN pacote_creditos INTEGER`
(paralelo a `plano`, nunca os dois preenchidos na mesma venda). `vendas.registrar()` ganha o campo
`pacoteCreditos` no objeto de entrada; `paraApp()` devolve o campo quando presente.

### B.4 — UI

- **Cliente**: novo catálogo de pacotes em `public/app.html` (mesmo padrão da tela de planos que já
  existe via `GET /api/billing/planos` — endpoint irmão `GET /api/billing/pacotes`).
- **Admin**: `public/admin.html`, tela de configuração de cada gateway ganha o mapeamento
  oferta→pacote ao lado do mapeamento oferta→plano já existente; tela de billing ganha o editor do
  catálogo de pacotes (mesmo padrão do editor de planos da Fase 1).

## Arquivos críticos

- `billing.js` — `debitTurn` (campo `creditosFixos`), `getConfig`/`defaultConfig` (`precoFixoAtivo`,
  `pacotes[]`), `addBalance` (já existe da Fase 1, reaproveitado por B.2).
- `servicos/classificador-operacao.js` (novo) — tabela de categorias/créditos, `classificar()`.
- `servicos/motor-canal.js` — acumula `tool_use` por turno (`ch._arquivosTocados`), chama o
  classificador no `result`, monta `creditosFixos` antes de chamar `debitTurn`.
- `rotas/webhooks.js` — `resolverPacote`, ramo de aplicação de pacote no núcleo do webhook.
- `servicos/vendas.js` + `migracoes/008-pacotes-avulsos.sql` — campo `pacoteCreditos`.
- `rotas/compras.js` — `GET /api/billing/pacotes`, `POST /api/billing/estimar`.
- `rotas/admin-billing.js` — config de `precoFixoAtivo`, catálogo de pacotes, tabela de
  categorias/créditos (se o admin puder recalibrar os valores).
- `public/app.html` — estimativa prévia no composer.
- `public/admin.html` — toggle de preço fixo, editor de pacotes, mapeamento oferta→pacote por gateway.

## Riscos e decisões a confirmar na implementação

1. **Padrões de detecção da tabela A.2 são um primeiro rascunho** — vão errar em casos ambíguos
   (mesma natureza do classificador de planejamento). Documentar como heurística v1, recalibrável com
   telemetria real de produção — não vale a complexidade de um classificador por IA agora sem medir o
   erro real primeiro (mesmo raciocínio já registrado no classificador de planejamento).
2. **"Página simples" vs. "Landing page completa" vs. "Módulo complexo"** têm fronteiras
   inerentemente nebulosas por contagem de arquivo/tamanho — os limiares exatos (quantos arquivos,
   que tamanho de diff) precisam de um valor de partida arbitrário na implementação, ajustável depois.
3. **Migração de contas já usando preço fixo**: como não há usuários em produção ainda (mesma
   premissa da Fase 1), o toggle nasce desligado e pode ser ligado quando o admin decidir, sem
   necessidade de migração de dado.

## Plano de testes

- `testes/classificador-operacao.test.js` (novo, `node --test`): cada padrão de detecção da tabela
  A.2 isoladamente, soma multi-categoria por arquivos únicos, fallback quando nenhum arquivo bate com
  nenhum padrão.
- Extensão de `testes/billing-planos-motor2.test.js`: `debitTurn` com `creditosFixos` informado e
  `precoFixoAtivo` ligado debita o valor fixo (não o derivado de `chargedUsd`), mas
  `realBaseUsd`/`realChargedUsd` continuam corretos no ledger; com o toggle desligado, o
  comportamento da Fase 1 não muda nem um pouco (teste de regressão explícito).
- Novo teste de `rotas/webhooks.js` (ou extensão de um existente): oferta mapeada para pacote chama
  `addBalance` e NÃO `setUserPlan`; idempotência de reentrega preservada; oferta mapeada para AMBOS
  (erro de configuração) é rejeitada na tela de config, não em runtime.

## Verificação end-to-end

- `npm test` cobrindo os testes novos acima.
- Manual: ligar `precoFixoAtivo`, mandar um pedido que crie 2 componentes numa mensagem só, confirmar
  que o débito é `2 × 5 = 10` créditos (não o custo real de tokens); desligar o toggle e confirmar que
  o mesmo pedido volta a debitar pelo custo real. Configurar uma oferta de teste num gateway mapeada
  para um pacote e confirmar que uma venda de teste credita o saldo "comprado" em vez de trocar de
  plano.
