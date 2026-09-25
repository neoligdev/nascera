// ═══════════════════════════════════════════════════════════════════════
// NASCERA — rotas de primeiro acesso e login do Claude (S4: extraído do server.js)
//
// Bloco contíguo de 6 rotas, todas SEM autenticação por natureza (a máquina
// ainda não tem admin, ou o dono está ligando o Claude Code):
//   • GET  /api/setup-status              — a máquina já tem admin? já tem Claude?
//   • POST /api/setup/create-account      — cria o admin (portão: token de setup)
//   • POST /api/setup/assumir-instalacao  — destrava instalação herdada (mesmo portão)
//   • POST /api/setup/claude-login-start  — abre o fluxo OAuth e devolve a URL
//   • GET  /api/setup/claude-auth-status  — polling: "o login já concluiu?"
//   • POST /api/setup/claude-login-code   — cola o código no prompt do CLI
//   • POST /api/setup/claude-token        — login alternativo via setup-token
//   • POST /api/setup/claude-logout       — desloga (esta exige auth)
//
// O portão de segurança que importa: create-account só cria admin com o token
// de setup válido E enquanto não houver admin. Coberto por
// testes/rotas-autorizacao.js (create-account com admin existente → 400).
//
// `assumir-instalacao` é a saída para quem herdou um `users.json` de outra
// máquina (senhas em scrypt, irrecuperáveis) e ficaria trancado para sempre.
// Mesmo portão — o código de instalação —, mais freio de força bruta, mais
// rastro em appendActivity. Coberto por testes/setup-destravar.test.js.
//
// readClaudeAuthStatus/propagateClaudeAuth vêm de ../claude-auth.js — os mesmos
// que settings.js e admin-painel.js usam, para o estado de login ser único.
// ═══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const logger = require('../log.js');
const path = require('path');
const claudeAuth = require('../claude-auth.js');
const motores = require('../motores.js');
const { readClaudeAuthStatus, propagateClaudeAuth } = claudeAuth;

// ─── "Não logado" ≠ "o motor não rodou" ─────────────────────────────────
// As três conferências de login desta rota faziam, cada uma, o seu próprio
// `spawnSync(claudeCmd(), ['auth','status'])` e liam só o stdout. Quando o
// spawn falhava — o caso do Windows, onde `claude` é `claude.cmd` e o Node o
// recusa sem shell desde o 18.20/20.12 — não havia stdout, o JSON não vinha, e
// a rota respondia "Código inválido ou expirado. Gere um novo link.". Falso: o
// CLI nem chegou a rodar, e o cliente gerava link novo para sempre.
//
// Agora as três passam por claudeAuth.consultarAuthStatus, que usa o
// motores.invocacaoDe (idêntico ao spawn de hoje em Unix) e devolve `falhou`
// quando o processo não executou.
function estadoDoLogin(comando) {
  try {
    const { parsed, falhou } = claudeAuth.consultarAuthStatus(comando);
    return {
      logado: !!(parsed && parsed.loggedIn),
      email: (parsed && (parsed.email || parsed.account)) || '',
      falhou,
    };
  } catch (e) {
    // Isto roda dentro de callback de pty e de timer: uma exceção solta aqui
    // derrubaria o processo inteiro. Vira falha de execução — que é o que ela
    // é — em vez de crash ou de silêncio.
    return { logado: false, email: '', falhou: claudeAuth.semCaminhos((e && e.message) || e) };
  }
}

// Resposta do caso (b): o CLI não chegou a rodar. Dizer "código inválido" aqui
// seria mentira — nenhum código foi conferido. O detalhe já vem sem caminho
// absoluto (estas rotas não exigem login: qualquer um alcança a resposta); o
// caminho inteiro fica no log do servidor.
// O `detalhe` já vem como oração ("não chegou a rodar: …", "foi encerrado por
// SIGTERM antes de responder", "não respondeu dentro do tempo limite"): a frase
// fixa não pode afirmar "não chegou a rodar" para os três, porque no timeout o
// processo RODOU e foi morto — seria descrever o que não aconteceu.
function erroDeMotor(detalhe) {
  return 'O motor de IA (Claude Code) ' + detalhe +
         '. Nenhum código foi verificado — confira a instalação do Claude Code.';
}

/**
 * Monta as rotas de primeiro acesso e login do Claude (`/api/setup*`), todas
 * SEM autenticação por natureza (a máquina ainda não tem admin, ou o dono está
 * ligando o Claude Code). A criação de conta é protegida pelo token de setup.
 *
 * @param {import('express').Express} app - App do Express onde as rotas são montadas.
 * @param {object} deps - Dependências injetadas pelo server.js (composition root).
 * @param {import('express').RequestHandler} deps.authMiddleware - Guarda de sessão (usado só nas rotas que exigem login já feito).
 * @param {() => Object<string,object>} deps.loadUsers - Lê o store de usuários.
 * @param {(users: Object<string,object>) => void} deps.saveUsers - Grava o store de usuários.
 * @param {string} deps.USERS - Caminho do arquivo de usuários.
 * @param {object} deps.senhas - Módulo de senhas: scrypt (cria/confere hash) E o freio de força bruta (esperaObrigatoria/registrarErro/limparErros), reusado pela retomada de instalação.
 * @param {(payload: object) => string} deps.signToken - Assina um JWT de sessão.
 * @param {(evt: object) => void} deps.appendActivity - Registra um evento no log de atividade.
 * @param {string} deps.PROJECTS_BASE - Raiz da área de projetos.
 * @param {(token: string) => boolean} deps.tokenConfere - Confere o token de setup em tempo constante.
 * @param {() => string} deps.tokenDeSetup - Devolve o token de setup atual.
 * @param {() => void} deps.limparTokenDeSetup - Invalida o token de setup após uso.
 * @param {() => string} deps.claudeCmd - Comando do CLI do Claude a invocar.
 * @param {boolean} deps.isDesktopLocal - A instância está rodando em desktop local (não VPS)? É VALOR, não função: o server.js injeta a constante, e as rotas usam `!isDesktopLocal` direto (uma função seria sempre truthy e o portão nunca fecharia).
 * @returns {void}
 */
function registrar(app, deps) {
  const {
    authMiddleware, loadUsers, saveUsers, USERS,
    senhas, signToken, appendActivity, PROJECTS_BASE,
    tokenConfere, tokenDeSetup, limparTokenDeSetup,
    claudeCmd, isDesktopLocal,
  } = deps;

  // ─── First Access Setup (no auth required) ─────────────────────────
  app.get('/api/setup-status', (_req, res) => {
    const users = loadUsers();
    const hasAdmin = Object.values(users).some(u => u.role === 'admin');
    // Check Claude auth
    let claudeAuthOk = false;
    // Rota SEM autenticação: não pode disparar um processo por requisição. O CLI
    // pesa centenas de MB e o spawn é síncrono — qualquer um poderia travar o
    // event loop em rajada. Reusa o leitor com cache (30s aqui: estado de login
    // não muda a cada refresh da tela de setup).
    try { claudeAuthOk = readClaudeAuthStatus(30000).loggedIn === true; } catch {}
    // A tela precisa saber que vai pedir o código — mas o código em si NUNCA
    // sai por HTTP: quem o vê é quem lê o terminal da máquina.
    //
    // `podeAssumir` é a ÚNICA coisa nova que esta rota conta. Sem ela, a tela de
    // login de uma instalação herdada (users.json de outra máquina, senhas em
    // scrypt irrecuperáveis) era um beco sem saída: "usuário ou senha inválidos"
    // para sempre, sem nada indicando que existe uma saída pelo produto. Com
    // ela, o front oferece o "não consigo entrar em nenhuma destas contas".
    //
    // Por que isto NÃO vaza nada: `podeAssumir` é exatamente `hasAdmin`, que já
    // saía daqui desde sempre. É uma constante do produto ("existe rota de
    // retomada"), não um fato sobre esta máquina — não diz quem existe, quantos
    // existem, nem se alguém já tentou.
    //
    // Considerado e RECUSADO: um `dadosDeOutraMaquina` heurístico (nenhum
    // dataDir das contas existentes cai sob o PROJECTS_BASE de agora). Dois
    // motivos: (1) numa rota pública, contar "esta caixa parece órfã" é sinal de
    // alvo para quem varre a internet, e ele não ajuda quem tem o código —
    // ajuda só quem não tem; (2) contas antigas sem `dataDir` gravado dariam
    // falso positivo, e a tela acusaria sequestro numa instalação legítima.
    // Mentira na tela é defeito, mesmo quando é a favor da segurança.
    res.json({
      hasAdmin, claudeAuth: claudeAuthOk, firstAccess: !hasAdmin, precisaToken: !hasAdmin,
      podeAssumir: hasAdmin,
    });
  });

  app.post('/api/setup/create-account', async (req, res) => {
    const users = loadUsers();
    const hasAdmin = Object.values(users).some(u => u.role === 'admin');
    // Mesma recusa de sempre (status e texto intocados — rotas-autorizacao.js
    // depende deles). O `podeAssumir` é só o ponteiro para a saída: quem caiu
    // aqui numa instalação herdada precisa saber que a retomada existe, em vez
    // de ficar batendo numa porta que nunca vai abrir.
    if (hasAdmin) return res.status(400).json({ error: 'Conta admin já existe', podeAssumir: true });

    const { name, email, username, password, setupToken } = req.body;

    // O token prova acesso à máquina. Sem ele, alguém na mesma rede poderia
    // criar a conta admin antes do dono numa instalação recém-subida.
    if (!tokenConfere(setupToken, tokenDeSetup())) {
      logger.warn('[setup] tentativa de criar admin com token inválido de ' +
                   (req.ip || '?'));
      return res.status(403).json({
        error: 'Código de instalação inválido. Ele aparece no terminal onde o Nascera foi iniciado.',
        precisaToken: true,
      });
    }

    if (!username || !password || password.length < 6) {
      return res.status(400).json({ error: 'Usuário e senha (mín. 6 chars) obrigatórios' });
    }

    users[username] = {
      name: name || username,
      email: email || '',
      password: await senhas.criarHash(password),
      role: 'admin',
      createdAt: new Date().toISOString(),
      dataDir: path.join(PROJECTS_BASE, '_userdata', username),
    };
    USERS[username] = { password: users[username].password };
    saveUsers(users);

    // O token cumpriu o papel: já existe admin, e a rota se fecha sozinha.
    // Deixar o arquivo para trás seria guardar um segredo sem função.
    limparTokenDeSetup();
    appendActivity({ type: 'admin_criado', user: username, data: { ip: req.ip || null }, at: new Date().toISOString() });

    const token = signToken({ user: username, role: 'admin' });
    res.json({ ok: true, token, user: username, role: 'admin' });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // ASSUMIR A INSTALAÇÃO — a saída para "trancado com a chave de outra pessoa"
  //
  // O caso real: o dono levou a pasta do NASCERA para outro Mac. O `users.json`
  // veio junto, com três contas da máquina do desenvolvedor e nenhuma senha
  // recuperável (scrypt). Como `hasAdmin` era verdadeiro, `create-account`
  // respondia "Conta admin já existe" e o primeiro acesso se recusava a rodar.
  // Resultado: a instalação estava trancada e NÃO havia saída pelo produto —
  // só um técnico mexendo em arquivo pelo terminal destravou. Cliente que
  // comprou não faz isso; ele pede reembolso.
  //
  // O portão é o MESMO da criação do primeiro admin, de propósito: o código de
  // instalação que o servidor imprime no terminal. Ele prova uma coisa
  // específica e suficiente — quem pede tem acesso físico à máquina onde o
  // NASCERA roda. Nada de segundo mecanismo: um segundo caminho para virar admin
  // é um segundo caminho para errar.
  //
  // Uma diferença obrigatória em relação ao primeiro acesso: numa instalação
  // herdada o servidor NÃO imprime o código no boot (o boot só imprime quando
  // não há admin) e o `.setup-token` foi apagado na máquina de origem, quando
  // o admin de lá foi criado. Então esta rota tem dois passos: o primeiro POST,
  // sem código, faz o servidor gerar/recuperar o código e IMPRIMI-LO NO LOG do
  // processo — o mesmo canal do boot, que só quem tem a máquina lê. O código
  // nunca sai no corpo da resposta.
  // ═══════════════════════════════════════════════════════════════════════

  // Alvo fixo no freio de força bruta de senhas.js. Aqui não há "usuário"
  // tentando entrar: o que se adivinha é o código da MÁQUINA. Com um nome fixo,
  // a chave do freio vira '<alvo>|<ip>' e o atraso é por IP nesta operação —
  // sem contaminar o freio de login de nenhuma conta real (e sem deixar que
  // trocar o nome no corpo do POST zere a contagem, que é o furo óbvio de usar
  // o username enviado pelo cliente como chave).
  const ALVO_DO_FREIO = '__assumir_instalacao__';

  // ─── Validade do código que ESTA rota materializa ───────────────────────
  // O passo 1 CRIA um `.setup-token` numa máquina que não tinha nenhum: antes
  // desta rota, uma instalação com admin não expunha chave alguma para
  // adivinhar. O código tem 32 bits (`randomBytes(4)` no server.js) e o arquivo
  // não morre sozinho — sem janela, os palpites de um adivinhador distribuído
  // ACUMULAM contra um alvo fixo até o espaço inteiro cair (ordem de semanas
  // com botnet; o freio e o rate-limit são POR IP e não somam contra isso).
  //
  // Com a janela, o código vale 15 minutos e o passo 1 seguinte ROTACIONA: os
  // palpites de uma janela não valem para a próxima, e o teto de tentativas por
  // código passa a ser o do express-rate-limit (20/15min por IP). Isso resolve
  // no servidor, sem tocar em server.js, o problema de "32 bits sem expiração".
  //
  // A janela só governa o código que ESTA rota gerou. Um `.setup-token` que já
  // estava na máquina por outro motivo continua valendo como antes — expirar
  // chave alheia não é papel desta rota.
  let janela = null;                       // { ate } — epoch ms em que o código morre
  const VALIDADE_MS = 15 * 60 * 1000;
  const VALIDADE_TXT = '15 minutos';

  app.post('/api/setup/assumir-instalacao', async (req, res) => {
    // ── Só desta instalação ───────────────────────────────────────────────
    // Rota pública e sem sessão. Um POST SIMPLES entre origens é ENVIADO pelo
    // navegador de qualquer jeito — o CORS esconde a RESPOSTA, não impede o
    // efeito. Sem esta guarda, qualquer página que o dono visitasse disparava o
    // passo 1 no NASCERA dele: gravava a chave de admin no disco de uma máquina
    // que não tinha nenhuma e, no app de Mac, abria o diálogo "Código de
    // instalação: XXXX" (desktop/main.js pesca essa linha do log) — código
    // pronto para uma tela de phishing pedir de volta.
    // O painel manda a própria origem; `curl` e o app não mandam Origin.
    const origem = (req.headers && req.headers.origin) || '';
    if (origem) {
      let hostDaOrigem = '';
      try { hostDaOrigem = new URL(origem).host; } catch { hostDaOrigem = '\0'; }
      const daCasa = [req.headers && req.headers.host, req.hostname].filter(Boolean);
      if (!daCasa.includes(hostDaOrigem)) {
        logger.warn('[setup] assumir-instalacao recusado: origem "' + origem + '" não é esta instalação');
        return res.status(403).json({ error: 'Requisição vinda de outro site foi recusada.' });
      }
    }

    // Mesmo raciocínio do /api/login: `req.ip` (derivado com trust proxy), não
    // o x-forwarded-for cru — que o próprio atacante escreve, e que deixaria o
    // freio ser zerado a cada tentativa.
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || '?';
    const users = loadUsers();
    const nomesAntes = Object.keys(users);
    const hasAdmin = Object.values(users).some(u => u && u.role === 'admin');

    // Sem admin não há nada a assumir — isto é o primeiro acesso normal, e ele
    // já tem rota própria. Recusar aqui mantém UM caminho para criar o primeiro
    // admin; dois caminhos para a mesma porta é como um deles fica sem portão.
    if (!hasAdmin) {
      return res.status(400).json({
        error: 'Esta instalação ainda não tem administrador — crie a conta pelo primeiro acesso.',
        firstAccess: true,
      });
    }

    const espera = senhas.esperaObrigatoria(ALVO_DO_FREIO, ip);
    if (espera > 0) {
      return res.status(429).json({ error: `Muitas tentativas. Tente de novo em ${espera}s.` });
    }

    const { name, email, username, password, setupToken } = req.body || {};
    // Maiúsculas no recebido, não no esperado: o código é gerado em hex
    // MAIÚSCULO (`randomBytes(4).toString('hex').toUpperCase()`), e quem digita
    // é uma pessoa copiando do terminal. Sem isto, "a1b2c3d4" seria recusado
    // como inválido e a saída viraria um suporte por dia. O create-account
    // depende do front fazer esse `.toUpperCase()`; aqui a regra fica no
    // servidor, que é onde ela não some se a tela mudar.
    const codigo = String(setupToken || '').trim().toUpperCase();

    // ── Passo 1: ninguém apresentou código ainda ──────────────────────────
    // Gera (ou recupera — `tokenDeSetup` reusa o arquivo se ele existir, então
    // pedir de novo mostra o MESMO código, não um novo) e imprime no log do
    // processo. `warn` porque este é o nível que sobrevive ao LOG_LEVEL de
    // produção: um código impresso em `info` num VPS que roda com LOG_LEVEL=warn
    // seria um código que ninguém consegue ler — a saída trancada de novo.
    if (!codigo) {
      const agora = Date.now();
      // Janela vencida: o código velho morre AQUI, antes de nascer o novo. Sem
      // esta linha, pedir de novo a cada 15 min manteria o MESMO código vivo
      // para sempre (tokenDeSetup reusa o arquivo) e os palpites voltariam a
      // acumular — a expiração viraria enfeite.
      if (janela && agora > janela.ate) { limparTokenDeSetup(); janela = null; }
      const t = tokenDeSetup();

      // O código só serve se ficou GRAVADO. Numa pasta sem permissão de escrita
      // — pasta copiada com o dono errado, ou o servidor rodando de dentro do
      // `.app` assinado — o `writeFileSync` do server.js falha em silêncio
      // (`catch {}`) e cada leitura devolve um número NOVO. O código impresso
      // seria recusado para sempre, e a recusa diria "código inválido" para
      // quem digitou exatamente o que leu. Erro na cara, e com o conserto.
      if (tokenDeSetup() !== t) {
        logger.error('[setup] o código de instalação NÃO pôde ser gravado — a pasta do Nascera não é gravável.');
        return res.status(500).json({
          error: 'Não consegui gravar o código de instalação: a pasta onde o Nascera está instalado não tem permissão de escrita. ' +
                 'Ajuste o dono/permissão dessa pasta e tente de novo — sem isso, qualquer código digitado aqui será recusado.',
          pastaSemEscrita: true,
        });
      }

      if (!janela) janela = { ate: agora + VALIDADE_MS };
      logger.warn('');
      logger.warn('  🔑 RETOMADA DE INSTALAÇÃO — código de instalação: \x1b[1m' + t + '\x1b[0m');
      logger.warn('     Alguém (' + ip + ') pediu para assumir esta instalação.');
      logger.warn('     Vale por ' + VALIDADE_TXT + '; depois disso este código morre e é preciso pedir outro.');
      logger.warn('     Se foi você, digite o código na tela. Se NÃO foi você, ignore:');
      logger.warn('     sem este código ninguém entra.');
      logger.warn('');
      return res.status(403).json({
        precisaToken: true,
        codigoNoTerminal: true,
        validoPor: VALIDADE_TXT,
        error: 'Código de instalação impresso no terminal onde o Nascera está rodando. ' +
               'Abra esse terminal, copie o código e digite-o aqui — ele vale por ' + VALIDADE_TXT + '.',
      });
    }

    // Código vencido: some daqui, e o próximo pedido gera outro. Dizer
    // "expirou" em vez de "inválido" importa — a pessoa digitou exatamente o
    // que leu, e mandá-la conferir o que já está certo é mentira com custo de
    // suporte. Não conta como erro no freio: não é palpite contra segredo vivo.
    if (janela && Date.now() > janela.ate) {
      limparTokenDeSetup();
      janela = null;
      return res.status(403).json({
        precisaToken: true, expirado: true,
        error: 'Este código de instalação expirou (ele vale ' + VALIDADE_TXT + '). ' +
               'Peça um novo e use o que aparecer agora no terminal.',
      });
    }

    // ── Passo 2: conferência em tempo constante ───────────────────────────
    // `tokenConfere` compara com timingSafeEqual; um `===` vazaria, pelo tempo
    // de resposta, quantos caracteres iniciais estavam certos.
    if (!tokenConfere(codigo, tokenDeSetup())) {
      const proxima = senhas.registrarErro(ALVO_DO_FREIO, ip);
      // O rastro do ERRO fica só no log do processo, nunca no appendActivity:
      // o log de atividade é um anel de 400 entradas, e gravar cada tentativa
      // errada daria a qualquer um na internet uma forma barata de EXPULSAR o
      // histórico real da instalação — apagar rastro fingindo criar rastro.
      logger.warn('[setup] tentativa de ASSUMIR a instalação com código inválido, de ' + ip);
      return res.status(403).json({
        // Nada do código certo aqui: nem tamanho, nem prefixo, nem "quase".
        error: 'Código de instalação inválido. Ele aparece no terminal onde o Nascera está rodando.' +
               (proxima ? ` Aguarde ${proxima}s antes de tentar de novo.` : ''),
        precisaToken: true,
      });
    }

    // Tipo antes de tamanho, e por dois motivos concretos:
    //
    // • `senhas.criarHash` LANÇA para qualquer coisa que não seja string. Um
    //   POST com `"password": 123456` passaria por um teste de comprimento
    //   ingênuo, a promessa rejeitaria dentro do handler async (o Express 4 não
    //   captura isso) e cairia no `unhandledRejection` do server.js — que mata
    //   o processo de propósito. Ou seja: derrubar o NASCERA com um JSON de 20
    //   bytes, sem autenticação nenhuma.
    //
    // • O nome do usuário vira CHAVE de objeto. `"username": "__proto__"` não
    //   cria conta nenhuma: a atribuição cai no setter de Object.prototype e
    //   troca o protótipo em vez de criar a chave, e o JSON.stringify do save
    //   descarta. A rota responderia `ok: true` e devolveria um JWT para um
    //   admin que não existe — e o login seguinte falharia para sempre, de
    //   volta ao beco. Resposta que mente é defeito, mesmo sem invasão.
    //   O formato sozinho NÃO pega isto (`__proto__` é só letra e `_`); a
    //   lista de reservados pega. Descoberto pelo teste, não pela intuição.
    const RESERVADOS = ['__proto__', 'constructor', 'prototype'];
    const usuario = typeof username === 'string' ? username.trim() : '';
    const senha = typeof password === 'string' ? password : '';
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(usuario) || RESERVADOS.includes(usuario) || senha.length < 6) {
      return res.status(400).json({
        error: 'Usuário (3-32 letras, números, ponto, hífen ou _) e senha (mín. 6 chars) obrigatórios',
      });
    }

    // Nome que já existe seria sobrescrever a conta de um desconhecido — e o
    // NASCERA é multi-inquilino: o novo admin herdaria, calado, os projetos que
    // pertencem àquele nome. Efeito colateral silencioso é justamente o que
    // esta rota não pode ter. Recusa explícita, com o que fazer.
    if (Object.prototype.hasOwnProperty.call(users, usuario)) {
      return res.status(409).json({
        error: 'Já existe uma conta com o nome "' + usuario + '" nesta instalação. ' +
               'Escolha outro nome de usuário — assim você não herda os projetos de outra pessoa sem perceber.',
      });
    }

    const agora = new Date().toISOString();
    users[usuario] = {
      name: (typeof name === 'string' && name.trim()) || usuario,
      email: (typeof email === 'string' && email.trim()) || '',
      password: await senhas.criarHash(senha),
      role: 'admin',
      createdAt: agora,
      dataDir: path.join(PROJECTS_BASE, '_userdata', usuario),
    };

    // ── Apagar as contas antigas ou preservá-las? PRESERVAR, SUSPENSAS ────
    // Apagar seria irreversível e órfã dados: os projetos têm dono (o portão
    // `projectOr404` filtra por `owner`), então sumir com o registro do usuário
    // não apaga a pasta do projeto — apaga o único jeito de alcançá-la. Numa
    // pasta copiada de propósito (o dono migrando de máquina, que é o caso
    // real), isso destruiria o trabalho dele no ato da "recuperação".
    //
    // Deixar ativas também não serve: são contas cuja senha ninguém aqui
    // conhece, que continuariam entrando pelo login.
    //
    // Suspender é o meio-termo que JÁ EXISTE no produto (A0.2): a flag
    // `suspended` barra o /api/login E o authMiddleware ao vivo — então até
    // token de sessão emitido na máquina antiga morre aqui —, nada é destruído,
    // e o novo admin pode reativar pelo painel a conta que reconhecer, com os
    // projetos intactos. É reversível; apagar não é.
    const contasSuspensas = [];
    for (const n of nomesAntes) {
      if (n === usuario) continue;                // não existe (409 acima), mas explícito
      if (!users[n] || users[n].suspended) continue;
      users[n].suspended = true;
      users[n].suspendedAt = agora;
      users[n].suspendedReason = 'Instalação assumida por "' + usuario + '" com o código de instalação em ' + agora;
      contasSuspensas.push(n);
    }

    USERS[usuario] = { password: users[usuario].password };
    saveUsers(users);

    // O código cumpriu o papel e some — igual ao create-account. Guardar um
    // segredo sem função é só dar uma chance a mais para ele vazar.
    limparTokenDeSetup();
    janela = null;                 // a janela morre com o código que ela governava
    senhas.limparErros(ALVO_DO_FREIO, ip);

    // O rastro: QUEM assumiu, QUANDO, de onde, e o que aconteceu com as contas
    // antigas. Se um dia esta rota for usada indevidamente, é por aqui que se
    // descobre — sem isto, a tomada de conta seria indistinguível de um login.
    appendActivity({
      type: 'instalacao_assumida',
      user: usuario,
      data: { ip, contasSuspensas, contasAntes: nomesAntes.length },
      at: agora,
    });
    logger.warn('[setup] instalação ASSUMIDA por "' + usuario + '" (' + ip + '); ' +
                contasSuspensas.length + ' conta(s) antiga(s) suspensa(s)');

    const token = signToken({ user: usuario, role: 'admin' });
    // A consequência vai EXPLÍCITA na resposta: a tela tem que poder dizer, com
    // nome e número, o que foi feito com as contas que estavam aqui. (Quem lê
    // isto acabou de provar acesso à máquina e já é o admin — veria os mesmos
    // nomes no painel um clique depois.)
    res.json({
      ok: true, token, user: usuario, role: 'admin',
      contasSuspensas,
      mensagem: contasSuspensas.length
        ? 'Instalação assumida. ' + contasSuspensas.length + ' conta(s) da instalação anterior foram SUSPENSAS ' +
          '(não excluídas): ' + contasSuspensas.join(', ') + '. Os projetos delas continuam no disco; ' +
          'reative no painel de administração a conta que você reconhecer.'
        : 'Instalação assumida. Não havia outras contas para suspender.',
    });
  });

  // ═══ Claude Auth: Via Login (OAuth) ═══
  // Uses auth login for full scopes URL, keeps setup-token process for code input
  app.post('/api/setup/claude-login-start', (_req, res) => {
    try {
      // Kill any previous login process
      if (global._claudeLoginProc) { try { global._claudeLoginProc.kill(); } catch {} global._claudeLoginProc = null; }

      const pty = require('node-pty');
      let output = '';
      let urlSent = false;

      // 'auth login' gera a URL JÁ com todos os escopos (org:create_api_key, user:profile,
      // user:inference, user:sessions:claude_code, user:mcp_servers, user:file_upload) e o
      // PKCE correto para eles, mostrando o prompt "Paste code" no mesmo processo.
      // NÃO usar setup-token + reescrita de scope: aquilo gera OAuth error 400 na troca.
      // node-pty chama CreateProcessW direto e não tem opção `shell`: no Windows
      // ele não executa `claude.cmd` nem acha `claude` sem extensão. `invocacaoParaPty`
      // resolve isso (e em Unix devolve exatamente o que se passaria hoje).
      const invLogin = motores.invocacaoParaPty(claudeCmd(), ['auth', 'login', '--claudeai']);
      const proc = pty.spawn(invLogin.arquivo, invLogin.args, {
        name: 'xterm-256color',
        cols: 2000, rows: 50,
        env: { ...process.env },
      });

      global._claudeLoginProc = proc;

      proc.onData((data) => {
        output += data;
        if (!urlSent) {
          const clean = output.replace(/\x1b\[[0-9;]*[A-Za-z]|\r/g, '');
          // With cols=2000 the URL should be on one line
          // Aceita claude.com E claude.ai: versões diferentes do CLI emitem
          // hosts diferentes, e casar só um deles fazia o login "dar timeout"
          // sem erro nenhum — o pior sintoma possível para o suporte.
          const urlMatch = clean.match(/https:\/\/(?:claude\.com|claude\.ai)[^\s\x00-\x1f]+/);
          if (urlMatch && urlMatch[0].includes('state=')) {
            urlSent = true;
            // A URL do 'auth login' já vem com todos os escopos e o PKCE correto — usar como está
            const url = urlMatch[0].trim();
            // Process stays alive — it has "Paste code" prompt waiting
            res.json({ success: true, method: 'login', url: url });
          }
        }
      });

      proc.onExit(() => {
        if (!urlSent) {
          global._claudeLoginProc = null;
          if (!res.headersSent) res.json({ success: false, error: 'Processo encerrou sem gerar URL. Tente via Token.' });
        }
      });

      setTimeout(() => {
        if (!urlSent && !res.headersSent) {
          try { proc.kill(); } catch {}
          global._claudeLoginProc = null;
          res.json({ success: false, error: 'Timeout gerando URL. Tente via Token.' });
        }
      }, 30000);

      // Kill after 5min if user hasn't completed auth
      setTimeout(() => {
        if (global._claudeLoginProc === proc) { try { proc.kill(); } catch {} global._claudeLoginProc = null; }
      }, 300000);

    } catch (err) {
      if (!res.headersSent) res.json({ success: false, error: 'Erro: ' + err.message });
    }
  });

  // ═══ Claude Auth: status para polling da UI ═══
  // O CLI atual abre o navegador sozinho e conclui o login sem código colado.
  // A UI consulta este endpoint enquanto o modal está aberto e se atualiza sozinha.
  app.get('/api/setup/claude-auth-status', (_req, res) => {
    const status = readClaudeAuthStatus();
    if (status.loggedIn) {
      // Login concluído (pelo navegador ou por código): encerra o processo pendente
      // e propaga a credencial para o usuário que roda os projetos.
      if (global._claudeLoginProc) {
        try { global._claudeLoginProc.kill(); } catch {}
        global._claudeLoginProc = null;
        if (!isDesktopLocal) propagateClaudeAuth();
      }
    }
    res.json(status);
  });

  // ═══ Claude Auth: Submit auth code to the "Paste code here" prompt ═══
  app.post('/api/setup/claude-login-code', (req, res) => {
    const { code } = req.body;
    if (!code || !code.trim()) return res.json({ success: false, error: 'Codigo vazio' });

    const proc = global._claudeLoginProc;
    if (!proc) {
      return res.json({ success: false, error: 'Processo de login expirou. Clique em "Gerar Link" novamente.' });
    }

    // The "Paste code here if prompted >" prompt should already be showing
    // Write the code immediately to the pty
    try {
      proc.write(code.trim());
      setTimeout(() => { try { proc.write('\r'); } catch {} }, 500);
    } catch (e) {
      return res.json({ success: false, error: 'Erro ao enviar codigo: ' + e.message });
    }

    // Monitor process exit — if it exits after we wrote the code, check auth
    proc.onExit(() => {
      global._claudeLoginProc = null;
      // Small delay then check if auth succeeded
      setTimeout(() => {
        if (res.headersSent) return;
        const r = estadoDoLogin(claudeCmd());
        if (r.logado) {
          // Mesmo portão da rota de status (acima): propagar credencial só
          // faz sentido no servidor Linux, onde existe o usuário
          // claude-runner. Sem este `if` o desktop (macOS/Windows) disparava
          // uma cópia que não tinha para onde ir — barulho de erro no log em
          // cima de um login que deu certo.
          if (!isDesktopLocal) propagateClaudeAuth();
          return res.json({ success: true, email: r.email });
        }
        // (b) o CLI não executou: a causa é instalação do motor, não o código.
        if (r.falhou) return res.json({ success: false, motorFalhou: true, error: erroDeMotor(r.falhou) });
        // (a) o CLI rodou e disse que não está logado: a mensagem de sempre.
        if (!res.headersSent) res.json({ success: false, error: 'Codigo invalido ou expirado. Gere um novo link.' });
      }, 1000);
    });

    // Also poll claude auth status every 2s for up to 40s
    let checks = 0;
    const maxChecks = 20;
    const checkAuth = () => {
      if (res.headersSent) return;
      checks++;
      const r = estadoDoLogin(claudeCmd());
      if (r.logado) {
        try { proc.kill(); } catch {}
        global._claudeLoginProc = null;
        // Mesmo portão das outras duas saídas de login bem-sucedido.
        if (!isDesktopLocal) propagateClaudeAuth();
        if (!res.headersSent) return res.json({ success: true, email: r.email });
        return;
      }
      // Insistir 20 vezes não conserta instalação quebrada — e cada volta é um
      // spawn de um CLI de centenas de MB. Responde a verdade na primeira.
      if (r.falhou) {
        if (!res.headersSent) res.json({ success: false, motorFalhou: true, error: erroDeMotor(r.falhou) });
        return;
      }
      if (checks < maxChecks) {
        setTimeout(checkAuth, 2000);
      } else {
        if (!res.headersSent) res.json({ success: false, error: 'Codigo invalido ou expirado. Gere um novo link.' });
      }
    };
    setTimeout(checkAuth, 3000);
  });

  // ═══ Claude Auth: Via Token (setup-token) ═══
  app.post('/api/setup/claude-token', (req, res) => {
    const { token } = req.body;
    if (!token || !token.trim()) return res.json({ success: false, error: 'Token vazio' });

    try {
      const pty = require('node-pty');
      let output = '';
      let responded = false;
      let codeSent = false;

      // Mesma razão do login por código: o pty do Windows não roda shim de script.
      const invToken = motores.invocacaoParaPty(claudeCmd(), ['setup-token']);
      const proc = pty.spawn(invToken.arquivo, invToken.args, {
        name: 'xterm-256color',
        cols: 200, rows: 50,
        env: { ...process.env },
      });

      proc.onData((data) => {
        output += data;
        if (!codeSent) {
          const clean = output.replace(/\x1b\[[0-9;]*[A-Za-z]|\r/g, '');
          // When the process asks for input (token/paste/enter prompt)
          if (clean.length > 10) {
            codeSent = true;
            setTimeout(() => {
              proc.write(token.trim());
              setTimeout(() => proc.write(String.fromCharCode(13)), 300);
            }, 500);
          }
        }
      });

      proc.onExit(() => {
        if (responded) return;
        responded = true;
        // Check if auth worked
        const r = estadoDoLogin(claudeCmd());
        if (r.logado) return res.json({ success: true, email: r.email });
        // (b) o CLI não executou: culpar o token do cliente seria mentira — ele
        // nem chegou a ser conferido.
        if (r.falhou) return res.json({ success: false, motorFalhou: true, error: erroDeMotor(r.falhou) });
        res.json({ success: false, error: 'Token invalido ou expirado. Gere um novo token em claude.ai/settings/tokens' });
      });

      setTimeout(() => {
        if (responded) return;
        responded = true;
        try { proc.kill(); } catch {}
        res.json({ success: false, error: 'Timeout. Tente novamente.' });
      }, 30000);

    } catch (err) {
      res.json({ success: false, error: 'Erro: ' + err.message });
    }
  });

  // Claude logout
  app.post('/api/setup/claude-logout', authMiddleware, (req, res) => {
    try {
      // argv em vez de shell: o caminho do CLI pode ter espaços.
      // spawnSync NÃO lança em falha (execSync lançava) — sem este teste
      // explícito, o catch abaixo virava código morto e a rota respondia
      // "ok: true" sem ter deslogado ninguém, deixando a credencial no disco.
      //
      // Mesmo helper neutro do `auth status`: em Unix devolve o spawn de hoje
      // sem tirar nem pôr; no Windows o `claude.cmd` era recusado pelo Node
      // (BatBadBut) e o logout caía SEMPRE no plano B — apagar um arquivo que
      // ali pode nem ser onde a credencial mora.
      const inv = motores.invocacaoDe(claudeCmd(), ['auth', 'logout']);
      const r = require('child_process').spawnSync(inv.arquivo, inv.args,
        { encoding: 'utf8', timeout: 10000, env: process.env, shell: inv.shell });
      if (r.error || r.status !== 0) {
        throw (r.error || new Error('claude auth logout saiu com código ' + r.status));
      }
      claudeAuth.invalidarCache();
      res.json({ ok: true });
    } catch (err) {
      // Try alternative
      try {
        const home = require('os').homedir();
        const credPath = require('path').join(home, '.claude', '.credentials.json');
        if (fs.existsSync(credPath)) fs.unlinkSync(credPath);
        claudeAuth.invalidarCache();
        res.json({ ok: true });
      } catch {
        res.json({ ok: false, error: err.message });
      }
    }
  });
}

module.exports = { registrar };
