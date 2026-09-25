# Sistema Nascera — Servidor Web (IDE + IA)

O coração do produto: uma interface web para o Claude Code CLI, com chat de IA,
preview ao vivo dos projetos, editor de código, biblioteca de temas e publicação
de sites com um clique.

## O que roda aqui (3 processos)

| Processo PM2     | Script              | Porta padrão | Função                                    |
|------------------|---------------------|--------------|-------------------------------------------|
| `nascera`          | `server.js`         | **3333**     | Painel, API, WebSocket e motor de IA      |
| `nascera-preview`  | `preview-server.js` | 4001         | Preview dos projetos em tempo real        |
| `nascera-publish`  | `publish-server.js` | 4102         | Sites publicados (domínios personalizados)|

**A porta do painel é 3333 e só.** Ela vale para todas as formas de subir:
`npm start`, `node server.js`, `pm2 start ecosystem.config.js`, o `iniciar.bat`
do Windows e o app de Mac. Quem decide em execução é `server.js`
(`process.env.PORT || 3333`); o `ecosystem.config.js` usa o mesmo número, e
`testes/porta-unica.test.js` falha se os dois se separarem.

Para trocar a porta de uma máquina, grave `PORT=` no `.env` dela — não edite
código. Servidor que já rodava em 3334 tem essa linha desde a instalação e
continua onde estava mesmo depois de atualizar; o valor do arquivo sempre vence
o padrão. `publish-server.js` sozinho cai em 4002; é o `.env` gerado pelo PM2
que o coloca em 4102.

## Pré-requisitos

- **Node.js 22+** e **npm** (ver `engines` no `package.json`)
- **PM2** (gerenciador de processos): `npm i -g pm2`
- **Claude Code CLI** instalado e autenticado (`claude`) — é o motor de IA.
  Veja https://docs.claude.com/claude-code
- (Recomendado) Linux/macOS. Em produção, use uma VPS.

## Instalação rápida

```bash
./install.sh                      # instala dependências
pm2 start ecosystem.config.js     # a 1ª subida cria o .env desta máquina
pm2 save
```

Acesse `http://SEU-IP:3333`.

**Não existe senha padrão, e nenhum arquivo precisa ser editado à mão.** Na
primeira vez o NASCERA mostra a tela de criação da conta de administrador e pede
um **código de instalação**. Esse código não trafega por HTTP e não vem por
e-mail: o servidor o imprime no terminal ao subir, na linha `PRIMEIRO ACESSO`.

```bash
pm2 logs nascera --lines 40         # procure a linha PRIMEIRO ACESSO
```

Usuário e senha são os que **você** escolher nessa tela; ficam no `users.json`
com hash scrypt (`senhas.js`). O código some sozinho assim que o admin existe —
enquanto não houver admin, ele é o que impede outra pessoa na mesma rede de
criar a conta antes de você.

Para instalar uma VPS inteira (Node, PM2, firewall, Caddy com HTTPS automático e
os domínios dos clientes), use `install-vps.sh` — veja `SETUP-VPS.md`.

## Configuração (arquivo `.env`)

O `ecosystem.config.js` **não guarda segredo**. Na primeira subida ele cria um
`.env` (permissão 0600, fora do git) com os valores únicos desta instalação, e
nunca sobrescreve o que já estiver lá — ele só acrescenta a linha que falta.

| Variável             | Para que serve                                                          |
|----------------------|-------------------------------------------------------------------------|
| `PORT`               | Porta do painel. Padrão 3333. **Fonte única da verdade da máquina.**     |
| `JWT_SECRET`         | Chave que assina as sessões. Gerada sozinha; trocá-la desloga todo mundo.|
| `PREVIEW_PORT`       | Porta do preview (padrão 4001).                                          |
| `PUBLISH_PORT`       | Porta dos sites publicados (padrão 4102).                                |
| `CLAUDE_CMD`         | Caminho do Claude CLI. **Deixe ausente** salvo motivo forte: sem ela o NASCERA prefere o CLI embarcado e se auto-repara. |
| `LICENSE_SERVER_URL` | URL do Dashboard Admin (Pacote 2). Vazio = telemetria desligada.          |
| `NASCERA_BUILD_MODEL`  | Modelo usado nas construções (padrão `sonnet`).                          |

> `AUTH_USER` e `AUTH_PASS` **não são login** e nunca foram: nada no servidor lê
> `process.env.AUTH_PASS`. O acesso ao painel é `users.json` + scrypt. A chave
> `AUTH_PASS` continua no `.env` porque o `install-vps.sh` a usa como senha do
> admin inicial de um VPS novo — se você não usa aquele script, ela não serve
> para nada.

## Estrutura

```
server.js            # backend principal (API + WebSocket)
preview-server.js    # preview ao vivo
publish-server.js    # sites publicados
ecosystem.config.js  # processos do PM2 + geração do .env (não edite: use o .env)
rotas/               # rotas do Express (setup, projetos, admin, webhooks...)
servicos/            # serviços de apoio (e-mail, gateways, motor de canal...)
public/              # frontend (app.html, home.html, editor.html, ...)
agents/              # definições dos agentes de IA (@dev, @architect, @qa...)
themes/              # biblioteca de temas e design-systems
templates/           # templates de projeto
testes/              # suíte (`npm test`)
system-prompt.md     # system prompt do assistente
```

## Como se conecta aos outros pacotes

- **Dashboard Admin (Pacote 2):** aponte `LICENSE_SERVER_URL` para a URL do admin.
  É lá que ficam licenças, assinaturas e telemetria.
- **Landing Page (Pacote 3):** site de marketing independente; os botões de
  login/cadastro da LP devem apontar para a URL deste sistema (`/` e `/auth`)
  ou para o cadastro do Dashboard Admin.

## Comandos úteis (PM2)

```bash
pm2 logs nascera            # o que o painel está fazendo
pm2 restart nascera         # reiniciar após atualizar o código
pm2 status                # estado dos 3 processos
pm2 stop all              # parar tudo
```

## Windows

O caminho do Windows é outro (`instalar.bat` / `iniciar.bat`, sem PM2) e está
documentado em `README-WINDOWS.md`.
