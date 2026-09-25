# Nascera Engine v2 — motor do Claude Code

Substitui o motor antigo (um processo `claude -p "<mensagem>"` por mensagem) por
**uma sessão viva do Claude Code por projeto**, construída sobre o
`@anthropic-ai/claude-agent-sdk` em modo *streaming input*.

## Por que trocar

O modo `-p` é one-shot: cada mensagem subia um processo novo, recarregava todo o
contexto e morria. Isso impedia streaming de verdade, troca de modelo, permissões
interativas, plan mode e perguntas do Claude — tudo tinha que ser simulado com
prefixos de texto no prompt.

Com a sessão viva, esses recursos são nativos.

## O que o motor entrega

| Recurso | Como |
|---|---|
| Streaming token a token | `includePartialMessages` → evento `delta` |
| Raciocínio (thinking) | evento `thinking-delta`, renderizado num bloco colapsável |
| Troca de modelo em runtime | `query.setModel()` — sem reiniciar a sessão |
| Modos de permissão reais | `query.setPermissionMode()` + decisão no `canUseTool` |
| Prompts de permissão | `canUseTool` → evento `permission_request` → UI responde |
| Perguntas do Claude | `AskUserQuestion` → evento `question` → resposta vira `updatedInput.answers` |
| Plan mode real | `permissionMode: 'plan'`; `ExitPlanMode` → evento `plan` para aprovação |
| Imagens | blocos `{type:'image', source:{type:'base64'}}` na mensagem |
| Slash commands | enviados como texto (`/compact`); lista real vem de `supportedCommands()` |
| Skills, agents, CLAUDE.md | `settingSources: ['user','project','local']` |
| Esforço de raciocínio | `applyFlagSettings({effortLevel})` — botão "Esforço" no chat |
| Nível de detalhe do build | slider na criação do projeto → escopo + esforço |
| Custo e uso por turno | evento `result` (`total_cost_usd`, `usage`) |
| Retomada de sessão | `resume` com o `sessionId` salvo em `projects.json` |

## Modos (`NASCERA_MODES`)

| Modo Nascera | permissionMode SDK | Comportamento |
|---|---|---|
| `turbo` | `default` | Nunca pergunta — o `canUseTool` libera tudo. Perguntas e planos ainda vão à UI. |
| `ask` | `default` | Pede permissão para ações sensíveis |
| `edits` | `acceptEdits` | Aceita edições, pergunta em comandos |
| `plan` | `plan` | Só lê e planeja; o plano vem para aprovação |
| `bypass` | `bypassPermissions` | Pula tudo no próprio CLI |

**Importante:** o auto-allow do turbo é decidido *dentro* do `canUseTool`, não por
regras na camada de settings. Regras aplicadas via `options.settings` não são
removíveis de forma confiável em runtime (`applyFlagSettings({permissions: null})`
não as limpa), o que fazia a UI mostrar "Seguro" enquanto tudo seguia
auto-aprovado. Decidir no callback torna a troca de modo instantânea e correta.

## Nível de detalhe e esforço

Dois controles distintos, que o usuário costuma confundir:

**Nível de detalhe** (slider na criação do projeto, em `home.html`) define o
*escopo* do build — 1 Rascunho a 5 Máximo. Vira uma instrução injetada apenas na
**primeira** mensagem do projeto; injetá-la em toda mensagem faria um pedido de
"muda a cor do botão" carregar junto "entregue multi-página". Salvo em
`projects.json` como `buildLevel`.

**Esforço** (botão no composer do chat) é o `effort` do SDK — quanto o modelo
raciocina antes de agir. Vale para a sessão inteira. Salvo como `claudeEffort`, e
tem precedência sobre o esforço derivado do nível de detalhe.

Nem todo modelo aceita esforço: a UI lê `supportsEffort` / `supportedEffortLevels`
de `supportedModels()` e mostra só os níveis válidos (Haiku, por exemplo, não
aceita nenhum).

## Controle de fila

Uma mensagem por vez. Enquanto um turno roda, as próximas ficam num backlog **do
motor** (`_backlog`), não do CLI — o CLI não expõe API pública para cancelar o que
já entrou na fila dele, então o Stop só consegue descartar o que ainda está aqui.
Ao fim do turno o backlog é drenado automaticamente.

## Ciclo de vida

- Sessão ociosa por 45 min é encerrada; a próxima mensagem recria e retoma via `resume`.
- Uma interação pendente (permissão/pergunta/plano) tem deadline de 30 min; a sessão
  presa nela tem teto absoluto de 2 h.
- Se o `resume` falhar (sessão expirada), o motor reinicia sem `resume` e reenvia a
  última mensagem — sem quebrar o chat.

## Protocolo WebSocket

Cliente → servidor: `chat` (com `images[]`), `abort`, `set-model`, `set-mode`,
`set-effort`, `permission-response`, `question-response`, `plan-response`,
`compact`, `context-usage`, `account-info`, `ping`.

Servidor → cliente: `init`, `models`, `commands`, `text` (deltas), `thinking_delta`,
`tool_use`, `tool_result`, `tool_progress`, `permission_request`, `question`,
`plan`, `interaction_cancelled`, `model_changed`, `mode_changed`, `engine_status`,
`compact`, `queued`, `result`, `done`, `preview-refresh`, `thumbnail-updated`,
`chat-history`, `error`.

Os eventos legados (`text`, `tool_use`, `tool_result`, `result`, `done`) foram
preservados com o mesmo formato, então o frontend antigo continua funcionando.

## Arquivos

- `engine/claude-engine.mjs` — `ClaudeSession` + `SessionManager`
- `server.js` — bloco "ENGINE v2": canais (1 sessão ↔ N WebSockets), persistência, commit/screenshot
- `public/app.html` — seletores de modelo/modo, cards interativos, thinking, custo
