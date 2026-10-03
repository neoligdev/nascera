# Relatório de segurança — Nascera

**Data:** 2026-10-02
**Escopo:** código do repositório (working tree sobre o commit `2005893`) e o servidor de produção `nascera.ia.br` (Ubuntu 24.04, pm2, Caddy).
**Método:** leitura do código e inspeção do servidor por SSH. Não houve teste de invasão: os achados são o que o código e a configuração permitem, com a evidência indicada. Onde algo não foi verificado, está escrito.

## Resumo

O Nascera é um produto em que clientes pagantes mandam um motor de IA escrever e executar código numa máquina compartilhada. O risco central é, portanto, **um cliente (ou o código que a IA dele gera) sair da pasta do próprio projeto** — para a pasta de outro cliente, para o código do produto ou para o root da máquina.

A base está melhor do que a média: autenticação, freio de força bruta, hash de senha, confinamento do editor por `realpath`, cofre `bwrap` para o motor, firewall e atualizações automáticas já existem. Os buracos graves estão nos caminhos que **contornam** o cofre: o vínculo de pastas (corrigido hoje), o dev server dos projetos (roda como root) e a execução do motor fora do cofre em alguns casos.

| Gravidade | Qtde | Situação |
|---|---|---|
| Crítica | 6 | 5 corrigidas, 1 aberta (C4, depende de você) |
| Alta | 6 | 4 corrigidas, 2 abertas (A2, A5) |
| Média | 7 | 3 resolvidas, 4 abertas |

## Estado de cada item (segunda rodada, 2026-10-02)

| # | Item | Estado | Como foi verificado |
|---|---|---|---|
| C1 | Vincular pasta arbitrária | Corrigido | teste automatizado + módulo no servidor |
| C2 | `chown -R` em pasta vinculada | Corrigido | leitura do código; posse conferida no servidor |
| C3 | Dev server como root, fora do cofre | Corrigido | teste de ponta a ponta no servidor (abaixo) |
| C4 | SSH com root por senha | **Aberto** | precisa da sua chave pública |
| C5 | Sessão sem projeto montava `/root` inteiro no cofre (novo) | Corrigido | teste no servidor: sem pasta de sessão, recusa |
| C6 | Motor recebia `JWT_SECRET` e `AUTH_PASS` no ambiente (novo) | Corrigido | teste no servidor: `JWT_SECRET` ausente |
| A1 | Cofre alcança serviços locais | Corrigido por firewall | `claude-runner` bloqueado em 2019/4001/4102/22; 3333 liberada |
| A2 | `HOME` do motor compartilhada entre clientes | **Aberto** | ver nota |
| A3 | `proxyTarget`/`previewUrl` sem validação (SSRF) | Corrigido | teste automatizado |
| A4 | Motor rodava sem cofre em alguns casos | Corrigido | falha fechada; só `sandbox: "off"` explícito passa |
| A5 | Servidor roda como root | **Aberto** (parcial) | `opencode serve` órfão encerrado; o Node segue como root |
| A6 | Preview (4001) sem autenticação | Mitigado | escuta só em 127.0.0.1 e o motor não o alcança |
| M1 | CSP desligada, token em `localStorage` | Aberto | — |
| M2 | Token na query string do WebSocket | Aberto | — |
| M3 | Processos escutando em `0.0.0.0` | Corrigido | `ss` no servidor: 3333/4001/4102 em 127.0.0.1 |
| M4 | Atualização sem assinatura obrigatória | Não se aplica mais | o atualizador foi removido do produto |
| M5 | Tokens de integração no prompt | Aberto | — |
| M6 | Sem Postgres/RLS | Aberto | — |
| M7 | Senha mínima de 6 | Corrigido | mínimo 10 no servidor e nas telas |

**Teste de ponta a ponta do cofre (no servidor).** Um projeto de teste com `"dev": "node sonda.js"` foi iniciado pelo código de produção. De dentro, a sonda relatou: uid 1001 (`claude-runner`); nenhuma variável com cara de segredo; `EACCES` ao ler `.env`, `server.js`, `users.json` e `/etc/shadow`, ao listar `/root`, a instalação e a área de projetos, e ao gravar na instalação; gravação liberada só na própria pasta; conexão recusada em 2019, 4001, 4102 e 22; conexão aceita na 3333. O dev server apontado para a pasta da instalação foi recusado. O binário do motor (`claude --version`) executou dentro do cofre com o ambiente limpo.

**Não verificado:** um turno real de IA depois das mudanças (exige login no painel). Vale abrir um projeto e mandar uma mensagem de teste.

### Achados novos desta rodada

- **C5 — sessão sem projeto.** `servicos/motor-canal.js` usava `/root` como pasta de sessão quando não havia projeto, e o cofre monta com escrita "a pasta da sessão". Qualquer usuário que abrisse um chat sem projeto tinha `/root` inteiro dentro do cofre — incluindo as pastas de todos os projetos, que pertencem ao mesmo `claude-runner`. Agora cada usuário ganha uma pasta vazia própria em `<área>/.sessoes/<usuário>`.
- **C6 — segredos no ambiente do motor.** Os três motores montavam o ambiente do processo da IA com `{ ...process.env }`, e o servidor carrega o `.env` em `process.env`. Bastava pedir "rode `env`" para ler o `JWT_SECRET` e forjar um token de admin. Agora o motor recebe o ambiente sem `JWT_SECRET`, `AUTH_*`, `DATABASE_URL`, `NASCERA_*`; o dev server do cliente não recebe credencial nenhuma. **Isto reforça a pendência de trocar o `JWT_SECRET`**: ele esteve ao alcance de qualquer sessão de motor desde a instalação.
- **A3 era alcançável de fora.** Além do `proxyTarget`, o `previewUrl` (gravável pelo dono do projeto) era encaminhado pelo painel principal com o teste `startsWith('http://localhost')`, que aprovava `http://localhost.evil.com` e `http://localhost:2019`.

### Telemetria e atualização automática — removidas do produto

Por decisão do dono, as duas saíram por completo (terceira rodada, 2026-10-02):

- **Histórico:** a telemetria nunca esteve desligada neste servidor — o `nascera-config.json` não tinha a chave `telemetryEnabled` e o padrão do código era ligado desde o primeiro commit. Nada chegou ao destino (`api.nascera.ai` não resolve no DNS); saíram apenas as consultas de IP público que faziam parte do pulso.
- **Removido do código:** `telemetry.js`, `atualizacao.js`, `assinatura.js`, `rotas/admin-update.js`, a seção "Atualizações" dos três painéis, o interruptor de telemetria, a rota `/api/telemetry/event`, a opção `--license-url` do instalador e as menções no README.
- **O que ficou:** `trackEvent` passou a ser só o registro local da seção "Atividade" do painel (`activity-log.json`); não envia nada.
- **CLI do Claude:** o motor agora sobe com `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, que desliga a telemetria, o relatório de erro e a checagem de atualização do próprio CLI. Codex e OpenCode não foram verificados quanto a isso.
- **No servidor:** os módulos e os arquivos de dados (`.nascera-install.json`, ativação pendente, buffer) foram movidos para `/root/nascera-incidente-20261002/telemetria-e-atualizacao-removidas/`. Conferido: o boot não menciona licença, as rotas respondem 404 e nenhum arquivo do produto referencia `api.nascera.ai`.
- **Consequência:** atualizar o Nascera volta a ser manual (enviar os arquivos e reiniciar). O achado M4 deixa de existir.
- **Fora do escopo:** alguns temas da biblioteca são cópias de sites de terceiros e trazem scripts de rastreamento desses sites (por exemplo `fbevents.js`). É conteúdo de modelo, não telemetria do Nascera — mas vai junto para o site de quem usar o tema.

### Pendências abertas e por quê

- **C4 (SSH):** desligar senha sem ter certeza de que você entra por chave tranca o servidor. Há uma chave em `authorized_keys`; não sei se é sua.
- **`JWT_SECRET`:** a escrita no `.env` do servidor é bloqueada pelo controle de permissões desta sessão.
- **A2 (`HOME` por projeto):** exige separar credencial (compartilhada) de transcrições (por cliente) para Claude, Codex e OpenCode, e migrar as sessões existentes. Feito às cegas, quebra a retomada de conversa de todos os projetos. Hoje o servidor tem um usuário e zero projetos, então não há exposição ativa; precisa ser feito antes de entrar o segundo cliente.
- **A5 (sair do root):** o cofre é montado como root. Tirar isso pede um auxiliar privilegiado pequeno ou `bwrap` com user namespaces — redesenho, não ajuste.
- **Residual de rede:** o motor ainda alcança portas locais altas, ou seja, o dev server de outro projeto. Fecha de vez com namespace de rede por sessão.
- **M1, M2, M5, M6:** mudanças de arquitetura (sessão em cookie + CSP, ticket de WebSocket, tokens fora do prompt, Postgres com RLS).

## O incidente de hoje

Um projeto chamado "nascera" estava cadastrado no servidor com caminho `/root/nascera` — a instalação do produto.

**Como aconteceu.** A tela "conectar pasta existente" chama `GET /api/vps-folders`, que no servidor liberava a navegação de `/root` e `/home` para qualquer usuário logado. O `POST /api/projects` aceitava o `folderPath` escolhido e só o conferia contra uma lista de igualdade exata (`/root` era recusado; `/root/nascera` não). Em seguida a rota executava `chown -R claude-runner` na pasta.

**O que isso causou no servidor.**

- A instalação inteira passou a pertencer a `claude-runner`, o usuário sem privilégio com que o motor de IA roda. O `.env` (com `JWT_SECRET` e a senha inicial do admin) e o `users.json` ficaram legíveis por ele desde 29/09.
- O motor gravou arquivos dele na raiz da instalação: `AGENTS.md`, `CLAUDE.md`, `.nascera/`, `.claude/skills/`, `.references/` e um `.git` vazio.
- O dev server rodou `npm run dev` dentro da instalação — uma segunda cópia do servidor, como root, na porta 3639. Não estava mais no ar no momento da inspeção.
- **Nenhum arquivo de código foi alterado**: os 4.366 arquivos versionados batiam byte a byte com o git antes e depois.

**O que foi feito.**

- Código corrigido (ver C1 e C2) e publicado no servidor.
- Registro removido do `projects.json` (era o único projeto cadastrado).
- Posse devolvida a `root`; arquivos de dados em modo 600. Conferido: `claude-runner` não lê mais `.env` nem `users.json` e não grava em `server.js`.
- Artefatos da IA movidos (não apagados) para `/root/nascera-incidente-20261002/artefatos-ia/`. Na mesma pasta ficaram o backup do `projects.json`, do `.env` e a lista de donos de antes.

**Pendente, com você:**

1. **Trocar o `JWT_SECRET`** no `/root/nascera/.env` e reiniciar o pm2. A troca automática foi bloqueada pelo controle de permissões desta sessão. Comando: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`, colar no `.env`, `pm2 restart ecosystem.config.js --update-env`. Todos precisam logar de novo.
2. **Trocar a senha do admin** pelo painel.
3. **Trocar a senha de root do servidor** (ver C4).

## Achados críticos

### C1 — Qualquer usuário conectava qualquer pasta do servidor como projeto · CORRIGIDO

- **Onde:** `server.js` (`/api/vps-folders`), `rotas/projetos-crud.js` (`POST /api/projects`), `caminhos-seguros.js` (`motivoParaRecusar`).
- **Ataque:** um cliente comum manda `folderPath: "/root/nascera"` (ou `/root/.ssh`, `/etc/caddy`, a pasta de outro cliente). A partir daí o editor de arquivos, o motor de IA e o preview operam nessa pasta com as permissões do produto.
- **Correção aplicada:**
  - a instalação do Nascera nunca pode ser projeto — nem ela, nem o que está dentro, nem o que a contém;
  - sistema e credenciais são recusados por prefixo (`/etc`, `/usr`, `~/.ssh`, `~/.claude`…), não por igualdade;
  - no servidor, só se conecta pasta de dentro da área de projetos, e só admin; usuário comum só reaproveita pasta de projeto dele (botão "duplicar");
  - `/api/vps-folders` no servidor é só para admin e não sai da área de projetos;
  - projeto antigo que aponte para pasta proibida fica bloqueado em todas as rotas (`projectOr404`), no motor (`ensureChannel`), no dev server, no editor e no preview — só o DELETE passa, para soltar o vínculo;
  - o portão de exclusão recusa mandar a instalação para a lixeira.
- **Teste:** `testes/caminhos-seguros.test.js` (8 casos). Suíte completa: 89/89.
- **Não exercitado:** as rotas HTTP com um token real de usuário comum no servidor. A regra foi verificada chamando o módulo com a mesma configuração do servidor.

### C2 — `chown -R` para o usuário do motor em pasta vinculada · CORRIGIDO

- **Onde:** `rotas/projetos-crud.js:259-266`.
- **Ataque:** combinado com C1, conectar `/root/.ssh` entregava a pasta a `claude-runner`; o motor então grava `authorized_keys` e vira root.
- **Correção aplicada:** o `chown` só roda em pasta de dentro da área de projetos.

### C3 — O dev server do projeto rodava como root, fora do cofre · CORRIGIDO

- **Onde:** `servicos/preview-runtime.js:105-135`.
- **O problema:** para mostrar o preview, o Nascera executa `npm run dev` (ou `start`/`serve`) na pasta do projeto com `spawn(..., { shell: true, env: { ...process.env } })`. O processo herda o usuário do servidor (root no VPS) e o ambiente inteiro, incluindo `JWT_SECRET` e `AUTH_PASS`. Não passa pelo `bwrap` nem pelo `su claude-runner`.
- **Ataque:** o `package.json` é do cliente — escrito pela IA dele ou por ele mesmo no editor. Um `"dev": "curl … | sh"` é execução de comando como root. Qualquer cliente pagante vira dono da máquina e dos dados de todos os outros.
- **Correção sugerida:** rodar o dev server pelo mesmo `vpsSpawnWrapper` do motor (cofre `bwrap`, usuário `claude-runner`), com ambiente mínimo (`PATH`, `PORT`, `HOME`), sem `shell: true`. Enquanto isso não existe, desligar o início automático do dev server no VPS.
- **Prioridade:** a mais alta do relatório.

### C4 — SSH aceita root por senha · ABERTO

- **Onde:** `sshd -T` no servidor: `permitrootlogin yes`, `passwordauthentication yes`.
- **O problema:** a senha de root circulou em texto nesta conversa. O `fail2ban` está ativo e reduz força bruta, mas não protege uma senha que vazou.
- **Correção sugerida:** criar chave SSH, `PasswordAuthentication no`, `PermitRootLogin prohibit-password`, trocar a senha.

## Achados altos

### A1 — O cofre do motor não isola a rede

- **Onde:** `server.js:2420-2500` (`argsDoCofre`): há `--unshare-pid/ipc/uts`, não há `--unshare-net`.
- **O problema:** de dentro do cofre o motor alcança `127.0.0.1`: o painel (`:3333`), o preview (`:4001`, sem autenticação — ver A6), a API administrativa do Caddy (`:2019`, que reconfigura o proxy) e um `opencode serve` rodando como root (`:49374`).
- **Correção sugerida:** namespace de rede próprio com saída só para a internet (ou proxy de saída com lista de destinos); no mínimo, bloquear `127.0.0.0/8` e o endereço de metadados da nuvem para o uid do `claude-runner` via `iptables -m owner`.

### A2 — A pasta pessoal do `claude-runner` é compartilhada entre todos os clientes

- **Onde:** `server.js:2461` (`--bind RUNNER_HOME RUNNER_HOME`, com escrita).
- **O problema:** toda sessão, de todo cliente, monta `/home/claude-runner`. Lá estão a credencial do Claude da instalação e as transcrições das sessões de todos os projetos. O motor de um cliente consegue ler as conversas de outro e copiar a credencial.
- **Correção sugerida:** uma pasta de sessão por projeto (ou por cliente) montada como `HOME`, com a credencial entregue só em leitura — ou por variável de ambiente, fora do disco.

### A3 — `proxyTarget` definido pelo usuário, sem validação (SSRF)

- **Onde:** `rotas/projetos-crud.js:285`, `rotas/projetos-preview.js:150`; consumido em `preview-server.js:65`.
- **O problema:** o dono do projeto grava qualquer URL como alvo de proxy; o servidor de preview passa a encaminhar requisições para ela, inclusive `http://127.0.0.1:2019`.
- **Atenuante hoje:** a porta 4001 está fechada no firewall e o Caddy só encaminha a 3333. Não verifiquei se o painel principal usa `proxyTarget` em algum caminho alcançável de fora.
- **Correção sugerida:** aceitar só `http://localhost:<porta>` de uma faixa reservada a dev servers, e validar na leitura também.

### A4 — Sem cofre, o motor roda só com troca de usuário

- **Onde:** `server.js:2504-2533` (`vpsSpawnWrapper`), `servicos/motor-canal.js:328`.
- **O problema:** em sessão sem projeto, com `bwrap` ausente ou com `sandbox: "off"` na configuração, o motor roda via `su claude-runner`, com diretório `/root` e sem isolamento de caminhos. Nesse modo ele enxerga tudo o que o `claude-runner` enxerga na máquina — inclusive as pastas de todos os projetos, que pertencem a esse mesmo usuário.
- **Correção sugerida:** no servidor, falhar fechado: sem cofre, não abre sessão. Sessão sem projeto ganha uma pasta vazia dentro da área e passa pelo cofre.

### A5 — O servidor inteiro roda como root

- **Onde:** `pm2 ls` (usuário `root`), `ps` (`opencode serve` como root).
- **O problema:** qualquer falha de execução no processo Node — em qualquer dependência — vale root. O root só é necessário para montar o cofre.
- **Correção sugerida:** rodar o Nascera com um usuário de serviço e deixar o privilégio só num auxiliar pequeno (`sudo` restrito a `bwrap`, ou `bwrap` com user namespaces). O `opencode serve` deve rodar como `claude-runner`.

### A6 — O servidor de preview (porta 4001) não tem autenticação

- **Onde:** `preview-server.js` (não há checagem de token nem de ticket).
- **O problema:** quem alcança a porta 4001 lê os arquivos de qualquer projeto pelo slug — código-fonte ainda não publicado. O painel principal já corrigiu isso com ticket (`servicos/preview-web.js`), mas este processo separado não. (O `publish-server`, na 4102, serve o que já é público por definição.)
- **Atenuante hoje:** porta fechada no firewall. A proteção depende inteiramente dele — e do motor, que a alcança por dentro (A1).
- **Correção sugerida:** escutar em `127.0.0.1` e exigir o mesmo ticket; ou aposentar o `preview-server` em favor da rota do painel.

## Achados médios

| # | Achado | Onde | Correção sugerida |
|---|---|---|---|
| M1 | CSP desligada e token de sessão em `localStorage`: um XSS no painel leva a sessão do usuário, admin inclusive | `server.js:671`, `public/index.html:242` | Ligar CSP com as origens mapeadas; mover a sessão para cookie `HttpOnly; Secure; SameSite=Strict` |
| M2 | Token JWT na query string dos WebSockets (fica em logs e histórico) | `servicos/terminal-ws.js:17`, `servicos/motor-ws.js:27` | Ticket de uso único e vida curta para abrir o socket |
| M3 | Painel, preview e publish escutam em `0.0.0.0` | `server.js:144-147` | `NASCERA_BIND=127.0.0.1` atrás do Caddy |
| M4 | Atualização aplicada sem verificar assinatura quando `NASCERA_UPDATE_PUBKEY` não está definida — e não está, no servidor | `assinatura.js:33,62` | Embutir a chave pública no código e recusar pacote sem assinatura |
| M5 | Tokens de integrações (GitHub, Vercel, Notion, Trello…) entram em texto no prompt do motor | `server.js:1480-1490` | Entregar por variável de ambiente da sessão, ou por um proxy que injeta o cabeçalho |
| M6 | Produção sem Postgres: o isolamento entre clientes é filtro de aplicação sobre JSON; a RLS desenhada em `db.js` não está em uso | `.env` do servidor (sem `DATABASE_URL`) | Subir o Postgres e ligar `NASCERA_DB_STATE=pg` antes de ter vários clientes |
| M7 | Senha mínima de 6 caracteres, sem checagem de senha comum | `rotas/setup.js:164`, `rotas/settings.js:69`, `rotas/admin-painel.js:97`, `rotas/webhooks.js:412` | Mínimo de 10–12 e recusa de senhas vazadas conhecidas; 2FA para admin |

Não verificado, mas vale olhar: se trocar a senha ou sair invalida os tokens já emitidos (o JWT vale 24 h e não vi lista de revogação).

## O que já está certo

- **Autenticação:** JWT com segredo forte obrigatório, `iss`/`aud`/`jti`, 24 h; papel de admin e suspensão conferidos ao vivo, não pelo token.
- **Login:** freio por usuário e IP, hash forte, tempo constante para usuário inexistente, `trust proxy` correto.
- **Borda:** `helmet` (sem CSP), rate limit geral e reforçado nas rotas sensíveis, limite de corpo.
- **Arquivos:** editor confinado por `realpath` aos projetos do usuário; exclusão por portão único que só move para a lixeira.
- **Motor:** cofre `bwrap` com sistema em leitura, projeto como única pasta gravável, privilégio largado com `setpriv --no-new-privs`.
- **Terminal web:** só admin, e abre como `claude-runner`.
- **Webhooks:** assinatura HMAC sobre o corpo cru.
- **Preview no painel:** ticket por projeto e dono.
- **Servidor:** ufw ativo (só 22, 80, 443), `fail2ban` e `unattended-upgrades` ativos, HTTPS automático pelo Caddy.

## Ordem sugerida

1. **Hoje:** trocar `JWT_SECRET`, senha do admin e senha de root; SSH só por chave (C4).
2. **Próximo:** dev server dentro do cofre, sem root e sem o ambiente do servidor (C3).
3. **Em seguida:** falhar fechado sem cofre (A4), `HOME` por projeto (A2), rede do cofre (A1).
4. **Depois:** validar `proxyTarget` (A3), autenticar ou aposentar o servidor de preview (A6), bind em `127.0.0.1` (M3), assinatura de atualização obrigatória (M4).
5. **Estrutural:** tirar o servidor do root (A5), Postgres com RLS (M6), CSP e sessão em cookie (M1, M2), política de senha e 2FA (M7), tokens de integração fora do prompt (M5).
