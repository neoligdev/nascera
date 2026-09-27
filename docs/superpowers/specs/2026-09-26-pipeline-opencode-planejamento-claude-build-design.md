# Pipeline invisível OpenCode (planejamento) → Claude Code (build) + skill Caveman

Status: aprovado para implementação (spec) — implementação ainda não iniciada.

## Contexto

Hoje o Nascera deixa o usuário final escolher manualmente um entre três motores de IA (Claude Code, Codex, OpenCode), e o motor escolhido faz tudo sozinho — não existe handoff entre motores nem fase de planejamento separada da fase de construção. O código em `server.js` até guarda um `PIPELINE_PHASES` vestigial de uma tentativa anterior de fase única, com o comentário explícito "não planeje... CONSTRUA" — ou seja, a filosofia até aqui era anti-planejamento, por causa de latência.

O objetivo desta mudança é reduzir o consumo de tokens do Claude Code (que é o motor caro) usando o OpenCode com um modelo gratuito (`opencode/big-pickle`, custo $0, já cadastrado em `engine/opencode-engine.mjs`) para conversar com o usuário, esclarecer o pedido quando necessário, e gerar um PRD/spec em markdown *antes* de qualquer código ser escrito. Só depois desse PRD pronto o Claude Code entra em cena para construir, já com o escopo definido — sem gastar tokens caros explorando ou fazendo perguntas de esclarecimento.

Isso deve ser **totalmente invisível** para o usuário final: ele nunca escolhe motor, nunca vê o PRD gerado, nunca percebe que houve uma troca de "app" por baixo — para ele é uma única conversa contínua com "a IA do Nascera". Além disso, ambos os motores devem ganhar a skill **Caveman** (github.com/JuliusBrussee/caveman, MIT) para reduzir a verbosidade das respostas e economizar tokens de saída.

## Decisões já fechadas (não reabrir durante a implementação)

| Decisão | Escolha | Por quê |
|---|---|---|
| Gatilho da fase de planejamento | Heurística por mensagem | Pedidos triviais (bug, ajuste pequeno) pulam direto pro Claude; só pedidos de algo novo/complexo passam pelo planejamento primeiro. Evita latência extra em pedidos simples. |
| Sinal de troca de fase | O próprio OpenCode sinaliza | O prompt de planejamento instrui o modelo a conversar até ter clareza suficiente e então emitir um marcador de conclusão; o sistema detecta e troca de motor sozinho. Permite ida-e-volta de esclarecimento antes de construir, sem exigir confirmação explícita do usuário. |
| Visibilidade do PRD | Totalmente interno | O PRD fica só em `.nascera/prd.md`, nunca aparece no chat nem na UI. A conversa de esclarecimento em si aparece normalmente (é diálogo real com o usuário). |
| Escopo do Caveman | Só a skill (grátis) | O Caveman tem uma skill (arquivo de regras, reduz o texto que o agente escreve) e um proxy (processo local que também comprime o que o agente lê, mas mexe em variáveis de ambiente/rede e tem telemetria ligada por padrão). O pedido original era sobre "ruído nas respostas" — exatamente o papel da skill. O proxy fica fora de escopo. |
| Vendoring do Caveman | Baixado uma vez e commitado no repo | Evita dependência de rede (`npx skills add`) em tempo de execução na criação de cada projeto. |
| Seletor manual de motor | Removido da UI do usuário final | Hoje existe um painel "Uso e motor" em `public/app.html` onde o usuário escolhe claude/codex/opencode manualmente. Isso é incompatível com "o usuário não escolhe motor". O painel admin (`public/admin.html`) continua existindo — o operador pode forçar um motor específico por instalação ou por projeto, o que também serve como "desligar" o pipeline automático quando necessário (suporte/debug). |
| Codex | Fora do pipeline | Continua existindo como motor alternativo, selecionável só pelo admin. A composição opencode+claude é a que vira o novo padrão para o usuário final; Codex não muda. |

## Arquitetura atual relevante (verificada lendo o código)

- **`servicos/motor-canal.js`** → `ensureChannel()` (linha ~237) resolve qual motor usar (override do projeto `proj.motor`, senão o padrão da instalação) e chama `sessionManager.obtain()`. `bindChannel()` (linha ~27) liga os eventos da sessão a WebSocket/billing/histórico de chat/commit automático/screenshot.
- **`engine/claude-engine.mjs`** exporta `SessionManager.obtain()`, que despacha por `opts.motor` para `ClaudeSession` (ele mesmo, usa `@anthropic-ai/claude-agent-sdk`), `CodexSession` (`engine/codex-engine.mjs`) ou `OpenCodeSession` (`engine/opencode-engine.mjs`). As três são `EventEmitter`s com a mesma interface: `start()/send()/setModel()/setEffort()/setMode()/interrupt()/compact()/respondInteraction()/status()/close()`, emitindo os mesmos eventos (`init/text/delta/tool_use/tool_result/result/error/closed`).
- **`engine/opencode-engine.mjs`**: spawna `opencode run --format json --model <m> --session <id> [--auto] <prompt>` por turno. Não existe flag de system-prompt — a única customização hoje é via env, `--model`, `--session`, `--auto`. `OPENCODE_MODELOS` já inclui `opencode/big-pickle` (custo $0, sem autenticação).
- **`servicos/motor-ws.js`** → `handleChat()` (linha ~216) é o ponto onde toda mensagem do usuário passa antes de ir pro motor — ponto natural de interceptação para a classificação/roteamento do pipeline.
- **`memoria-projeto.js`** já é a infraestrutura de artefato persistente entre motores: grava `.nascera/memoria.json` e espelha markdown em `CLAUDE.md` **e** `AGENTS.md` (comentário do próprio arquivo, linhas 9-12, afirma isso testado para o **Codex** — não confirma para o OpenCode; ver risco/spike abaixo). Tem `registrarTrocaDeMotor` e `textoDeContinuidade`, já reaproveitados hoje quando o usuário troca de motor manualmente.
- **`rotas/projetos-motor.js`** → `PUT /api/projects/:id/motor` é hoje o único lugar que troca de motor em runtime (fecha o canal, reabre no motor novo, grava `proj.motor`).
- **Bug pré-existente a corrigir junto**: `motor-canal.js` linha ~216, dentro de `session.on('result', ...)`, faz `if (r.sessionId) proj.sessionId = r.sessionId;` sem checar qual motor gerou o evento. Isso nunca causou problema porque nenhum canal troca de motor no meio da mesma conversa hoje sem passar pela rota manual (que já reabre a sessão do zero) — mas o pipeline automático é o primeiro caso que reutiliza o mesmo canal trocando de motor "por baixo", então precisa de uma guarda (`ch.motor === 'claude'`) antes de persistir `sessionId`, senão o Claude tentaria retomar uma sessão usando um id de sessão do OpenCode.
- **Billing**: `billing.js`/`DEFAULT_MODELS` só tem tabela de preço para modelos Claude. Os eventos `result` de Codex/OpenCode não carregam `cost`/`modelUsage`, então `motor-canal.js` nunca chama `billing.debitTurn` pra eles — já são efetivamente gratuitos/não cobrados por omissão. Não é necessária nenhuma mudança de billing para a fase de planejamento gratuita.

## Abordagem

### 1. Correção de base — `servicos/motor-canal.js`
Marcar `ch.motor` na criação do canal e só persistir `proj.sessionId` quando `ch.motor === 'claude'`.

### 2. Classificador + orquestração da fase de planejamento — novo arquivo `servicos/planejamento-automatico.js`
Módulo novo e focado (não cresce `motor-canal.js`, que já tem responsabilidade única de conectar eventos de motor). Expõe:

- `classificar(mensagem, proj)` — heurística leve por palavra-chave/tamanho/estado do projeto (vazio vs. já tem arquivos), com curto-circuito para texto de erro/stack trace (nunca vira PRD, sempre trivial). É deliberadamente ingênua na v1 — documentar com um comentário do tipo "heurística simples, evoluir para classificação via modelo barato se a precisão não for suficiente".
- `elegivelParaPipeline(proj, config)` — falso se o admin desativou o pipeline, ou se há um motor forçado na instalação ou no projeto (escape hatch de suporte já existente hoje).
- Estado em memória (deliberadamente não persistido — se o servidor reiniciar no meio do planejamento, a próxima mensagem simplesmente vai direto pro Claude) rastreando quais projetos estão em fase de planejamento, quantas rodadas já rolaram e quando começou.
- `MARCADOR_CONCLUSAO` — string fixa (ex.: `[[NASCERA_PRD_PRONTO]]`) que o prompt de planejamento instrui o OpenCode a emitir sozinho, na própria resposta, quando o PRD estiver pronto. Nunca deve vazar para o usuário — filtrar antes de repassar ao chat.
- Teto de segurança: número máximo de rodadas e tempo máximo de planejamento. Se estourar, finaliza com o que houver e faz o handoff mesmo assim — nunca trava o usuário esperando o modelo grátis indefinidamente.
- Em caso de erro/falha do OpenCode a qualquer momento durante o planejamento: cai direto para o Claude com a mensagem original do usuário, sem bloquear.
- `iniciarOuContinuar(...)` e `concluirEHandoff(...)` — abrem/fecham o canal OpenCode temporário e disparam a volta pro Claude reaproveitando o mecanismo existente de `textoDeContinuidade`, injetando uma referência ao **caminho** do PRD (não o texto inteiro — o Claude lê o arquivo sozinho via ferramenta de leitura, mais barato que inlinar tudo no prompt).

`servicos/motor-ws.js` (`handleChat`) passa a chamar esse módulo antes de mandar a mensagem pro motor: se o projeto já está em planejamento, a mensagem continua nele; senão, classifica e decide se entra em planejamento ou segue reto pro Claude como hoje.

### 3. PRD interno — `memoria-projeto.js`
Nova função `registrarPRD(projectPath, texto)` grava `.nascera/prd.md` (arquivo único, sobrescrito a cada ciclo — sem histórico/versionamento, desnecessário para v1). Nunca é espelhado em `CLAUDE.md`/`AGENTS.md`; só o caminho do arquivo é citado na mensagem de continuidade enviada ao Claude.

### 4. Extensão mínima do motor OpenCode — `engine/opencode-engine.mjs`
Um novo opt `promptPrefixo`, prependado só no primeiro turno da sessão de planejamento (texto fixo de instrução: "converse só se realmente precisar esclarecer, depois escreva o PRD e termine com o marcador"). Não mexe em `claude-engine.mjs`/`codex-engine.mjs` — opção específica do OpenCode, ignorada pelos outros motores. `motor-canal.js` passa esse opt e força `model: 'opencode/big-pickle'` sempre que o motor da vez for o temporário de planejamento (nunca herdar o modelo pago configurado para build do projeto).

### 5. Skill Caveman vendorizada
Baixar uma vez `skills/caveman/SKILL.md` do repositório oficial (MIT) e salvar em `templates/caveman-SKILL.md` — mesmo padrão já usado por `templates/nascera-templates-SKILL.md`, sem dependência de rede em produção. Nova função `writeCavemanSkill(projectPath)` em `server.js` (irmã de `writeProjectSkill`) escreve em `<projeto>/.claude/skills/caveman/SKILL.md` — chamada no mesmo ponto onde hoje já se reescreve a ferramenta de imagens e a memória a cada abertura de canal (`ensureChannel`), pra também curar projetos já existentes sem precisar de migração.

Para o OpenCode: como o comentário do próprio `memoria-projeto.js` só confirma que o **Codex** lê `AGENTS.md` (não afirma isso para o OpenCode), tratar como suposição a validar por spike antes de depender dela estruturalmente — testar na prática rodando `opencode run` com uma instrução distinta escrita em `AGENTS.md` do diretório e confirmar que o modelo obedece.
- Se confirmado: mesclar o corpo da skill (sem o front-matter YAML, que é convenção do carregador de skills do Claude Code) em `AGENTS.md`, via um bloco de marcadores próprio (`NASCERA:CAVEMAN:INICIO/FIM`), reaproveitando a lógica de mesclagem que `memoria-projeto.js` já usa para o bloco de memória.
- Se não confirmado: usar o mesmo `promptPrefixo` do item 4 pra carregar as regras do Caveman em toda chamada ao OpenCode (fallback simples, sem infraestrutura nova).

### 6. UI — remover seletor manual do usuário final
Em `public/app.html`: remover `carregarMotorDoProjeto()`, `trocarMotorDoProjeto()`, a chamada em `abrirPainelUso()`, e a seção "Motor deste projeto" do modal `#painel-uso`. O painel admin (`public/admin.html`, "IA & Motor") e as rotas `GET/PUT /api/projects/:id/motor` continuam existindo — uso interno pelo novo pipeline, mais escape hatch de suporte via API direta (já protegido por dono-do-projeto).

### 7. Config admin
Campo novo em `nascera-config.json` (`pipelineAutomatico`, default `true`) com um toggle simples em `admin.html` pra o operador desligar o pipeline automático globalmente, sem precisar forçar um motor específico.

## Arquivos críticos
- `servicos/motor-canal.js` — correção do bug de `sessionId`; resolução do motor temporário de planejamento
- `servicos/motor-ws.js` — ponto de interceptação em `handleChat`
- `servicos/planejamento-automatico.js` — novo; classificador + orquestração da fase
- `memoria-projeto.js` — `registrarPRD`; mesclagem em `AGENTS.md` para o Caveman
- `engine/opencode-engine.mjs` — opt `promptPrefixo`
- `rotas/projetos-motor.js` — extrair lógica de troca de motor em função reutilizável (usada tanto pela rota manual quanto pelo handoff automático)
- `server.js` — `writeCavemanSkill`
- `engine/fake-engine.mjs` — despachar sessão fake por `opts.motor` (hoje sempre cria uma sessão Claude fake, o que mascararia o pipeline em teste)
- `public/app.html` / `public/admin.html` — remoção do seletor / toggle do pipeline
- `templates/caveman-SKILL.md` — vendorizado uma vez a partir do repo oficial

## Riscos / suposições a validar antes ou durante a implementação
1. **Se o binário `opencode` de verdade lê `AGENTS.md` do `cwd` automaticamente** — não confirmado no código atual (só o Codex está confirmado). Decide o caminho do item 5. Fazer o spike primeiro.
2. **Se `opencode run --format json` com `--session` suporta de fato uma conversa de várias rodadas** (o modelo faz uma pergunta e espera) — o código atual só tem confirmação registrada de um turno único sem chamada de ferramenta. Testar na prática antes de confiar em produção.
3. Licença/atribuição do arquivo vendorizado do Caveman — confirmar que um comentário de atribuição no topo do arquivo (com a URL de origem e a licença MIT) é suficiente, ou se vale copiar o `LICENSE` também.

## Todo — ordem de implementação sugerida

- [ ] **Spike**: confirmar se `opencode run` lê `AGENTS.md` do `cwd` (testar num projeto de rascunho)
- [ ] Corrigir o bug de `sessionId` em `motor-canal.js` (marcar `ch.motor`, guardar a atribuição)
- [ ] Baixar e vendorizar `templates/caveman-SKILL.md`, com atribuição de licença
- [ ] Adicionar `writeCavemanSkill()` em `server.js` e chamar em `ensureChannel`
- [ ] Implementar a mesclagem em `AGENTS.md` (ou o fallback via `promptPrefixo`, conforme o resultado do spike)
- [ ] Adicionar opt `promptPrefixo` em `engine/opencode-engine.mjs`
- [ ] Criar `servicos/planejamento-automatico.js` (classificador, estado em memória, marcador de conclusão, teto de segurança, handoff)
- [ ] Adicionar `registrarPRD()` em `memoria-projeto.js`
- [ ] Extrair a lógica de troca de motor em `rotas/projetos-motor.js` para uma função reutilizável
- [ ] Ligar tudo em `servicos/motor-ws.js` (`handleChat`) e `servicos/motor-canal.js` (`ensureChannel` resolvendo o motor temporário)
- [ ] Adicionar campo `pipelineAutomatico` em `nascera-config.json` + toggle em `admin.html`
- [ ] Remover o seletor manual de `public/app.html`
- [ ] Estender `engine/fake-engine.mjs` pra despachar por `opts.motor` e simular marcador/erro/estouro de rodadas
- [ ] Testes automatizados com `NASCERA_FAKE_ENGINE=1` cobrindo: mensagem trivial (nunca planeja), mensagem de criação em projeto vazio (planeja → PRD → volta pro Claude), estouro do teto de rodadas, erro do OpenCode
- [ ] Teste manual com motores reais: pedido trivial (confirmar que `opencode run` nunca é chamado) e pedido complexo (confirmar spawn do `opencode/big-pickle`, PRD escrito, volta pro Claude, resultado construído) — sem nenhuma mensagem de "trocando de motor" visível e sem reload de página
- [ ] Rodar `/caveman` numa sessão real do Claude Code e do OpenCode do projeto gerado e confirmar respostas mais diretas, sem regressão perceptível de qualidade
