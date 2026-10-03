// ═══════════════════════════════════════════════════════════════════════
// NASCERA — Segurança de caminhos
//
// Escrito depois de um acidente real: um usuário conectou a própria pasta
// pessoal como projeto e clicou em excluir. O `rename` para a lixeira falhou
// com EINVAL (a lixeira fica DENTRO da pasta pessoal), o `catch` partiu para
// `cp -a` + `rm -rf`, e apagou mais de 200 GB — a máquina dele parou de
// funcionar com o usuário logado.
//
// A lição não é "melhorar o aviso". É que nenhuma exclusão pode depender de
// alguém ter lido um aviso. Este módulo é o ponto único por onde toda
// operação destrutiva passa: se o caminho não estiver na área de projetos,
// não se apaga — e ponto.
//
// Regra de ouro deste arquivo: quando estiver em dúvida, NÃO apague.
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const logger = require('./log.js');
const os = require('os');
const path = require('path');

let BASE = null;   // raiz da área de projetos, definida pelo server no boot
// Pasta onde o PRODUTO está instalado (server.js, .env, users.json). Nenhum
// projeto pode apontar para ela: o motor de IA, o editor e o dev server
// trabalham na pasta do projeto, e aqui isso é editar o próprio Nascera.
let INSTALACAO = null;
// Servidor (VPS, vários clientes na mesma máquina): só se conecta pasta de
// dentro da área de projetos. No desktop a máquina é do dono e ele conecta o
// que quiser — menos sistema, credenciais e a instalação.
let RESTRITO = false;

// `opcoes` é opcional de propósito: scripts/limpar.js e os testes antigos
// chamam com um argumento só e continuam valendo como antes.
function configurar(raizDeProjetos, opcoes) {
  const o = opcoes || {};
  BASE = path.resolve(raizDeProjetos);
  INSTALACAO = o.instalacao ? path.resolve(o.instalacao) : null;
  RESTRITO = !!o.restrito;
}

function restrito() { return RESTRITO; }

function base() {
  if (!BASE) throw new Error('caminhos-seguros: configurar() não foi chamado');
  return BASE;
}

// ─── normalização ────────────────────────────────────────────────────
// `realpathSync` resolve symlink: sem isso, um link apontando para a home
// passaria por qualquer checagem de prefixo.
function normalizar(p) {
  if (!p || typeof p !== 'string') return null;
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch { /* ainda não existe: resolve basta */ }
  return r;
}

// ─── camada 1: a área de projetos ────────────────────────────────────
// Comparação por SEGMENTO. Um `startsWith` cru aprovaria
// "/Users/x/Nascera AI Projects Antigos" como se fosse de dentro.
function dentroDaAreaDeProjetos(p) {
  const alvo = normalizar(p);
  const raiz = normalizar(base());
  if (!alvo || !raiz) return false;
  if (alvo === raiz) return false;                 // a própria raiz não se apaga
  return alvo.startsWith(raiz + path.sep);
}

// ─── camada 4: pastas que ninguém conecta por querer ─────────────────
// Memorizada: são ~25 `realpathSync`, e desde que `motivoParaOperar` entrou no
// caminho de toda requisição de projeto isso rodava a cada chamada. A lista
// só depende da home e do disco, que não mudam com o processo no ar.
let _proibidas = null;
function pastasProibidas() {
  if (_proibidas) return _proibidas;
  const casa = os.homedir();
  const lista = [
    '/', casa, path.join(casa, 'Desktop'), path.join(casa, 'Documents'),
    path.join(casa, 'Downloads'), path.join(casa, 'Library'), path.join(casa, 'Pictures'),
    path.join(casa, 'Movies'), path.join(casa, 'Music'), path.join(casa, 'Public'),
    '/Users', '/Applications', '/System', '/Library', '/Volumes', '/private',
    '/usr', '/bin', '/sbin', '/etc', '/var', '/opt', '/root', '/home',
    'C:\\', 'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)',
  ];
  _proibidas = lista.map(normalizar).filter(Boolean);
  return _proibidas;
}

// `dentro` É `pai` ou está abaixo dele. Por SEGMENTO, pelo mesmo motivo da
// camada 1: prefixo cru aprovaria "/root/nascera-antigo" como "/root/nascera".
function contem(pai, dentro) {
  return dentro === pai || dentro.startsWith(pai + path.sep);
}

// ─── camada 4b: a instalação do próprio Nascera ──────────────────────
// Escrito depois de outro acidente real: no servidor, a pasta da instalação
// foi conectada como projeto. A lista de `pastasProibidas` recusava `/root`
// por IGUALDADE e deixava `/root/nascera` passar. Aqui a pergunta é de
// sobreposição: o alvo é a instalação, está dentro dela ou a contém?
//
// Uma exceção, e só ela: instalação que guarda os projetos numa subpasta
// própria (`projetos/`, que o atualizador preserva). Ali a ÁREA fica dentro da
// instalação e o que está dentro da área é projeto legítimo.
function sobrepoeInstalacao(alvo) {
  const inst = INSTALACAO && normalizar(INSTALACAO);
  if (!inst) return false;
  if (contem(alvo, inst)) return true;              // é a instalação, ou a contém
  if (!contem(inst, alvo)) return false;            // não tem nada a ver com ela
  const raiz = BASE && normalizar(BASE);
  return !(raiz && contem(inst, raiz) && dentroDaAreaDeProjetos(alvo));
}

// Sistema e credenciais, por PREFIXO: `/etc/caddy` e `~/.ssh/qualquer-coisa`
// são tão proibidos quanto `/etc` e `~/.ssh`. As duas formas de cada raiz
// (crua e resolvida) porque no macOS `/etc` é link para `/private/etc`, e um
// alvo que ainda não existe não é resolvido por `normalizar`.
const RAIZES_DE_SISTEMA = ['/etc', '/usr', '/bin', '/sbin', '/boot', '/proc', '/sys', '/dev', 'C:\\Windows'];
// Em qualquer home, não só na de quem roda o servidor.
const PASTAS_DE_CREDENCIAL = new Set(['.ssh', '.gnupg', '.aws', '.pm2', '.claude', '.config']);

let _raizesDeSistema = null;
function ehSistemaOuCredencial(alvo) {
  if (!_raizesDeSistema) {
    _raizesDeSistema = [...new Set(RAIZES_DE_SISTEMA.flatMap((r) => [path.resolve(r), normalizar(r)]))];
  }
  if (_raizesDeSistema.some((r) => contem(r, alvo))) return true;
  return alvo.split(path.sep).some((seg) => PASTAS_DE_CREDENCIAL.has(seg));
}

const MOTIVO_INSTALACAO = 'Esta pasta é a instalação do próprio Nascera (ou fica dentro dela, ou a contém). Um projeto aqui daria ao motor de IA acesso ao código do produto.';
const MOTIVO_SISTEMA = 'Esta é uma pasta do sistema ou de credenciais. Ela não pode ser usada como projeto.';

// Devolve o MOTIVO da recusa, ou null se a pasta pode ser conectada.
// Texto em português porque vai direto para a tela.
function motivoParaRecusar(p) {
  const alvo = normalizar(p);
  if (!alvo) return 'Caminho inválido.';

  if (sobrepoeInstalacao(alvo)) return MOTIVO_INSTALACAO;
  if (ehSistemaOuCredencial(alvo)) return MOTIVO_SISTEMA;

  if (pastasProibidas().includes(alvo)) {
    return 'Esta é uma pasta do sistema ou a sua pasta pessoal. Conectar uma pasta dessas coloca tudo que existe dentro dela sob risco de exclusão. Escolha uma subpasta específica do seu projeto.';
  }
  // Raiz de volume: "/", "/Volumes/Backup", "C:\"
  if (path.dirname(alvo) === alvo) return 'Não é possível conectar a raiz de um disco.';
  if (/^\/Volumes\/[^/]+$/.test(alvo)) return 'Não é possível conectar a raiz de um disco externo.';

  // A área de projetos NÃO pode ser conectada como se fosse um projeto: ela
  // contém a lixeira, os publicados e os dados de todos os usuários.
  const raiz = normalizar(base());
  if (raiz && (alvo === raiz || raiz.startsWith(alvo + path.sep))) {
    return 'Esta pasta contém a própria área de projetos do Nascera. Escolha uma pasta de dentro dela.';
  }
  if (RESTRITO && !dentroDaAreaDeProjetos(alvo)) {
    return 'Neste servidor só é possível conectar pastas de dentro da área de projetos do Nascera.';
  }
  return null;
}

// Pode o Nascera TRABALHAR nesta pasta (abrir o motor, subir dev server,
// mostrar no editor)? É a pergunta para projeto que JÁ EXISTE no cadastro —
// inclusive o que foi conectado antes de a regra acima existir. Recusar só na
// hora de conectar deixaria o registro ruim funcionando para sempre.
//
// `RESTRITO` fica de fora de propósito: ele fecha vínculo NOVO. Um cliente que
// já tinha uma pasta legítima fora da área não pode perder o projeto numa
// atualização. E não lança sem `configurar()`: quem chama está no caminho
// quente do motor, e ali um throw derrubaria o chat em vez de proteger nada.
function motivoParaOperar(p) {
  const alvo = normalizar(p);
  if (!alvo) return 'Caminho inválido.';
  if (sobrepoeInstalacao(alvo)) return MOTIVO_INSTALACAO;
  if (BASE && dentroDaAreaDeProjetos(alvo)) return null;
  if (ehSistemaOuCredencial(alvo)) return MOTIVO_SISTEMA;
  if (pastasProibidas().includes(alvo) || path.dirname(alvo) === alvo) {
    return 'Esta é uma pasta do sistema ou a pasta pessoal. Ela não pode ser usada como projeto.';
  }
  return null;
}

// ─── camada 6: dizer a verdade antes de apagar ───────────────────────
// Anda na árvore com TETO: uma pasta pessoal tem milhões de arquivos e a
// medição não pode travar o servidor. Se estourar, devolve `truncado`, e a
// tela mostra "mais de N" — que já é o suficiente para assustar.
function medir(p, tetoArquivos = 20000) {
  const raiz = normalizar(p);
  const r = { arquivos: 0, bytes: 0, truncado: false, existe: false };
  if (!raiz || !fs.existsSync(raiz)) return r;
  r.existe = true;

  const fila = [raiz];
  while (fila.length) {
    if (r.arquivos >= tetoArquivos) { r.truncado = true; break; }
    const dir = fila.pop();
    let entradas;
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entradas) {
      const filho = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;            // não segue link: contaria o mundo
      if (e.isDirectory()) { fila.push(filho); continue; }
      r.arquivos++;
      try { r.bytes += fs.statSync(filho).size; } catch {}
      if (r.arquivos >= tetoArquivos) { r.truncado = true; break; }
    }
  }
  return r;
}

function formatarTamanho(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(0) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

// ─── camada 5: lixeira do sistema, não `rm -rf` ──────────────────────
// Mesmo dentro da área de projetos, apagar de verdade é a última escolha.
// A lixeira do macOS é só `~/.Trash` — mover para lá não exige permissão
// especial nem AppleScript, e o usuário recupera com dois cliques.
//
// `plataforma` tem default e ninguém em produção passa argumento: existe para
// o teste conseguir provar o caminho do Windows rodando num Mac, sem precisar
// mexer em `process.platform` global (o que contaminaria os outros testes).
function lixeiraDoSistema(plataforma = process.platform) {
  if (plataforma === 'darwin') return path.join(os.homedir(), '.Trash');
  if (plataforma === 'linux') return path.join(os.homedir(), '.local', 'share', 'Trash', 'files');
  return null;   // Windows e qualquer SO futuro caem na quarentena abaixo
}

// ─── camada 5b: quarentena do Nascera, para SO sem lixeira ─────────────
// O Windows TEM lixeira, mas a `$Recycle.Bin` não é uma pasta onde se possa
// mover arquivo à mão: ela é um índice mantido pelo Shell (SHFileOperation).
// Escrever lá direto deixa o item invisível na Lixeira e irrecuperável pelo
// "Restaurar" — pior que não ter lixeira nenhuma. E chamar o PowerShell para
// isso reintroduziria a dependência de shell que estamos justamente tirando.
//
// Por que uma pasta própria e não um gate `if (win32)` no fluxo de exclusão:
// aqui não existe API neutra de Node que mande para a lixeira do SO, então o
// gate de plataforma fica num lugar só — `lixeiraDoSistema()`, que já era o
// gate — e todo o resto do caminho (nome único, rename, EXDEV) continua
// idêntico nas três plataformas.
//
// Por que NÃO trocar a lixeira do SO também no macOS/Linux: lá o item cai num
// lugar que o usuário já conhece e restaura com dois cliques, fora da área do
// Nascera. Trocar isso por uma pasta escondida seria piorar a recuperação de
// quem hoje funciona. A quarentena é o fallback de "plataforma sem lixeira
// conhecida" — resolve o Windows e qualquer SO futuro de uma vez.
//
// Onde ela fica, e por quê:
//   • DENTRO da área de projetos: é a única pasta que este módulo garante ser
//     do Nascera, e por estar no mesmo volume do que está sendo apagado o
//     `rename` é instantâneo — nada de copiar gigabytes entre discos.
//   • com nome começando por ponto: o listador de pastas do produto pula tudo
//     que começa com "." (server.js), então a quarentena não aparece como
//     pasta conectável nem é varrida como se fosse um projeto.
const PASTA_QUARENTENA = '.lixeira-nascera';

function lixeiraDoNascera() {
  // normalizar() na raiz porque no macOS `/tmp` é symlink para `/private/tmp`:
  // sem resolver, a comparação de contenção lá embaixo erraria só por texto.
  const raiz = base();
  return path.join(normalizar(raiz) || raiz, PASTA_QUARENTENA);
}

// Move de verdade para `lixo`, com nome que não colide. Extraído para que a
// lixeira do SO e a quarentena sigam exatamente o mesmo caminho de código —
// duas implementações seriam dois conjuntos de bugs.
function moverParaLixeira(alvo, lixo, metodo) {
  try { fs.mkdirSync(lixo, { recursive: true }); } catch {}

  // Nome único: a lixeira já pode ter algo com o mesmo nome, e sobrescrever
  // seria apagar coisa de outra pessoa.
  const carimbo = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let destino = path.join(lixo, path.basename(alvo) + ' (Nascera ' + carimbo + ')');
  let n = 1;
  while (fs.existsSync(destino)) destino = destino + '-' + (n++);

  try {
    fs.renameSync(alvo, destino);
    return { ok: true, destino, metodo };
  } catch (e) {
    // Volume diferente (EXDEV) é o único caso legítimo de copiar. Mesmo aqui,
    // só removemos a origem DEPOIS de confirmar que a cópia chegou inteira —
    // e a origem já foi validada como dentro da área de projetos.
    if (e.code === 'EXDEV') {
      try {
        fs.cpSync(alvo, destino, { recursive: true, errorOnExist: false });
        const antes = medir(alvo, 5000), depois = medir(destino, 5000);
        if (depois.arquivos < antes.arquivos) {
          return { ok: false, erro: 'A cópia para a lixeira ficou incompleta; nada foi removido.' };
        }
        fs.rmSync(alvo, { recursive: true, force: true });
        return { ok: true, destino, metodo: 'copia' };
      } catch (e2) {
        return { ok: false, erro: e2.message };
      }
    }
    return { ok: false, erro: e.message };
  }
}

// Devolve { ok, destino, metodo } ou { ok:false, erro }.
// NUNCA chama rmSync: se não conseguir mover, prefere falhar e deixar o
// arquivo no lugar. Um projeto que não sumiu é um chamado de suporte; uma
// pasta pessoal apagada é um processo.
//
// `opcoes.plataforma` só existe para o teste; em produção ninguém passa nada.
function mandarParaLixeiraDoSistema(p, opcoes) {
  // `opcoes || {}` em vez de valor default no parâmetro: o default só cobre
  // `undefined`, e um `null` explícito viraria TypeError DENTRO da única porta
  // de exclusão do produto — na purga automática, que roda em setInterval sem
  // try/catch, isso derrubaria o processo em vez de recusar a exclusão.
  const o = opcoes || {};
  const alvo = normalizar(p);
  if (!alvo || !fs.existsSync(alvo)) return { ok: true, destino: null, metodo: 'inexistente' };

  const lixo = lixeiraDoSistema(o.plataforma || process.platform);
  if (lixo) return moverParaLixeira(alvo, lixo, 'lixeira');

  // Daqui para baixo: SO sem lixeira acessível por arquivo (Windows). Antes
  // este caminho devolvia `{ok:false}` sempre — e era por isso que no Windows
  // o disco só enchia: a purga automática falhava de hora em hora, "esvaziar
  // lixeira" tirava o item da LISTA e deixava a pasta no disco para sempre, e
  // restaurar travava quando precisava abrir espaço no destino.
  let quarentena;
  try {
    quarentena = lixeiraDoNascera();
  } catch {
    // base() não configurado. Falha explícita: sem área definida não existe
    // lugar seguro para pôr nada, e adivinhar um é como o acidente começou.
    return { ok: false, erro: 'Área de projetos não configurada; nada foi movido.' };
  }

  // O acidente do cabeçalho outra vez, por outro caminho: mover a quarentena
  // (ou qualquer pasta que a contenha) para dentro dela mesma dá EINVAL. Antes
  // de deixar o erro cru do SO vazar, recusa com motivo legível.
  if (alvo === quarentena || quarentena.startsWith(alvo + path.sep)) {
    return { ok: false, erro: 'Este caminho contém a própria quarentena do Nascera; nada foi movido.' };
  }

  // mkdir com erro na cara, não engolido: se a quarentena não pôde ser criada,
  // o `rename` falharia com um ENOENT sem contexto e o suporte ficaria cego.
  try {
    fs.mkdirSync(quarentena, { recursive: true });
  } catch (e) {
    return { ok: false, erro: 'Não consegui criar a quarentena do Nascera (' + (e.code || e.message) + '); nada foi movido.' };
  }

  // A quarentena tem que continuar DENTRO da área DEPOIS de resolvida. É a
  // mesma razão pela qual `normalizar()` resolve symlink na origem: se alguém
  // puser um link no lugar de `.lixeira-nascera`, o `rename` levaria o projeto
  // para onde o link apontar — fora da área, sem ninguém perceber. Verificado:
  // sem esta guarda, com a quarentena virada symlink, o projeto saía da área.
  const quarentenaReal = normalizar(quarentena);
  if (!quarentenaReal || !dentroDaAreaDeProjetos(quarentenaReal)) {
    return { ok: false, erro: 'A quarentena do Nascera não está dentro da área de projetos; nada foi movido.' };
  }

  return moverParaLixeira(alvo, quarentenaReal, 'quarentena');
}

// ─── o portão ────────────────────────────────────────────────────────
// Única porta para apagar arquivo de projeto. Quem não passa aqui, não apaga.
// `motivo` só serve para o log — ajuda a entender depois qual botão chamou.
// `opcoes` é repassado inteiro para a camada 5 (hoje só `plataforma`, do
// teste). Quem chama em produção continua passando dois argumentos.
function apagarComSeguranca(p, motivo, opcoes) {
  const alvo = normalizar(p);
  if (!alvo) return { ok: false, erro: 'Caminho inválido' };

  if (!dentroDaAreaDeProjetos(alvo)) {
    logger.error('[seguranca] RECUSADO apagar fora da área de projetos:', alvo, '|', motivo || '');
    return { ok: false, erro: 'Fora da área de projetos — nada foi apagado.', recusado: true };
  }
  // Instalação dentro da área (PROJECTS_BASE apontando para a pasta-mãe dela):
  // estar "dentro da área" não basta para mandar o próprio produto à lixeira.
  if (sobrepoeInstalacao(alvo)) {
    logger.error('[seguranca] RECUSADO apagar a instalação do Nascera:', alvo, '|', motivo || '');
    return { ok: false, erro: 'Esta é a instalação do Nascera — nada foi apagado.', recusado: true };
  }
  const r = mandarParaLixeiraDoSistema(alvo, opcoes);
  // `metodo` no log porque num chamado de suporte a primeira pergunta é onde o
  // item foi parar: lixeira do SO, quarentena do Nascera ou cópia entre volumes.
  if (r.ok) logger.info('[seguranca] para a lixeira (' + (motivo || '?') + ', ' + r.metodo + '):', alvo);
  return r;
}

module.exports = {
  configurar, restrito, normalizar, dentroDaAreaDeProjetos, motivoParaRecusar, motivoParaOperar,
  medir, formatarTamanho, mandarParaLixeiraDoSistema, apagarComSeguranca,
  pastasProibidas, lixeiraDoSistema, lixeiraDoNascera,
};
