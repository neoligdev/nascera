#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// NASCERA — devolve ESTA cópia ao estado de fábrica
//
//   node scripts/limpar.js                        (ENSAIO: só mostra)
//   node scripts/limpar.js --apagar               (apaga; pede confirmação)
//   node scripts/limpar.js --apagar --sim         (sem pergunta, para script)
//   node scripts/limpar.js --apagar --incluir-projetos
//
// Para quem copiou o NASCERA de outra máquina e quer zerar: apaga contas,
// cofre, segredos, configuração, projetos registrados, histórico, ledgers,
// logs e miniaturas — deixando a pasta como um download recém-baixado.
//
// Por que existe: um pacote foi levado para outro Mac carregando 46 capturas
// de tela de projetos de CLIENTES, com o nome do cliente no arquivo. O
// empacotador agora impede que isso SAIA daqui (scripts/empacotar-release.js);
// este script conserta as cópias que JÁ saíram.
//
// ─── o que este script NÃO toca ─────────────────────────────────────────
// A área de PROJETOS. Ela fica FORA da pasta do NASCERA
// (`process.env.PROJECTS_BASE || <home>/Nascera AI Projects`, server.js) e
// contém o trabalho da pessoa. O padrão é não encostar. Com
// `--incluir-projetos` ela entra — e mesmo assim cada exclusão passa por
// `caminhos-seguros.js`, o portão que existe por causa do acidente dos 200 GB
// (um `rm -rf` que saiu da área de projetos e comeu a pasta pessoal de um
// usuário). Aqui não se apaga nada fora da área por decisão minha: se o portão
// recusar, o item fica.
//
// Nada fora da pasta do NASCERA é apagado. `~/.claude` (a sessão do Claude Code
// da máquina) é do dono do computador, não do NASCERA, e continua onde está.
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

// O servidor lê a configuração do .env (server.js linha 7: `require('dotenv')
// .config()`). Sem carregar o mesmo .env aqui, este script enxergava um
// ambiente VAZIO e mentia duas vezes: dizia "a área de projetos NÃO será
// tocada: <caminho padrão>" quando PROJECTS_BASE apontava para outro lugar, e
// — pior — o aviso do Postgres NUNCA disparava, porque DATABASE_URL mora no
// .env e não no shell. Nesta máquina o estado vive no Postgres
// (NASCERA_DB_STATE=pg) e o relatório final anunciava "estado de fábrica, sem
// contas" com todas as contas intactas no banco.
// `try` porque a limpeza pode rodar numa cópia recém-baixada, antes do
// `npm install` — sem dotenv o script segue, só volta a enxergar menos.
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true }); } catch { /* sem node_modules ainda */ }

const RAIZ = path.join(__dirname, '..');
const seguranca = require('../caminhos-seguros.js');
// O empacotador já sabe RASTREAR, lendo o código, tudo que o servidor grava
// dentro da própria pasta. Reaproveitar isso evita a lista decorada envelhecer
// sozinha: se amanhã nascer um `public/capturas`, ele aparece aqui de graça.
const empacotador = require('./empacotar-release.js');

// ─── o que é dado desta instalação ────────────────────────────────────
// Cada linha veio de LER o código (a origem está no comentário), não de
// memória. Esta lista é a espinha; o rastreio do empacotador entra depois e
// acrescenta o que ela não previu.
const GRUPOS = [
  {
    titulo: 'Segredos e credenciais',
    porque: 'quem recebe a cópia entraria com a chave do dono anterior',
    alvos: [
      '.env', '.env.bak-*',              // instaladores (install.sh / install.ps1)
      '.credenciais.json',               // imagens.js — chave da API de imagem
      '.jwt-secret',                     // server.js — assina TODA sessão
      '.chave-cofre', '.cofre.json',     // segredos.js — senha de SSH dos projetos
      '.setup-token',                    // server.js — token do primeiro acesso
      'ecosystem.config.js',             // pm2: leva as variáveis de ambiente
    ],
  },
  {
    titulo: 'Contas, projetos e negócio',
    porque: 'é o cadastro de OUTRAS pessoas: usuários, saldo, domínios, clientes',
    alvos: [
      'users.json',                      // server.js — logins e hashes de senha
      'projects.json',                   // server.js — projetos e caminhos do dono
      'billing.json',                    // billing.js — saldo de crédito
      'vendas.json',                     // servicos/vendas.js — ledger de vendas
      'domains.json',                    // domains.js — domínios apontados
      'integrations.json',               // server.js
      'theme.json',                      // theme.js — marca branca do dono
      'nascera-config.json',               // server.js — tabela de preços e planos
      'trash.json',                      // server.js — lixeira de projetos
      'activity-log.json',               // server.js — quem fez o quê
    ],
  },
  {
    titulo: 'Registros de execução',
    porque: 'é o histórico de uso de outra instalação',
    alvos: [
      'usage-events.jsonl',              // billing.js — extrato append-only
      'billing-outbox.jsonl',            // billing-db.js
      'emails.jsonl',                    // servicos/email.js
      'telemetry-buffer.json',           // server.js
      '.updates.json',                   // atualizacao.js — histórico de updates
      '.pg-degradado',                   // estado-db.js — marcador de degradação
      '*.log',
    ],
  },
  {
    titulo: 'Identidade desta máquina',
    porque: 'a instalação nova precisa nascer com identidade própria, não herdada',
    alvos: [
      '.nascera-install.json',             // telemetry.js — installId
      '.nascera-activation-pending.json',  // telemetry.js
    ],
  },
  {
    titulo: 'Gerado dentro do produto',
    porque: 'é conteúdo de uso, criado em runtime, dentro de pastas que são código',
    alvos: [
      'public/thumbnails',               // server.js — captura de cada projeto (o vazamento)
      'themes/thumbnails/project_*',     // rotas/tools.js — captura de projeto no meio do catálogo
      'public/uploads',                  // theme.js — imagens que o dono subiu
      'public/lp',                       // landing page do dono
      'themes/_extracoes',               // rotas/tools.js — espelhos de sites de terceiros
      'themes/catalog.json',             // server.js — regenerado no próximo boot
    ],
  },
  {
    titulo: 'Backups e sobras',
    porque: 'um .bak carrega exatamente o mesmo conteúdo do estado que ele protege',
    alvos: [
      '*.bak', '*.bak-*',                // estado-seguro.js — cópia do último bom
      '.backups',                        // atualizacao.js — a instalação INTEIRA antes do update
      '_tmp_estado',
      'nascera-*.tar.gz', 'nascera-*.tar.gz.sig', 'nascera-release.tar.gz',
    ],
  },
];

// Pastas que o produto precisa que EXISTAM (o servidor recria, mas vazias já
// evita o susto de "sumiu a pasta"). Só vale para as que são criadas em runtime.
const RECRIAR_VAZIAS = ['public/thumbnails', 'public/uploads'];

// ─── portão local: nada fora da pasta do NASCERA ────────────────────────
// Mesma regra de segmento de caminhos-seguros.js — um `startsWith` cru
// aprovaria "<RAIZ> Antigo" como se fosse de dentro. `normalizar` resolve
// symlink na origem: um link plantado dentro da pasta não leva o rm para fora.
const RAIZ_REAL = seguranca.normalizar(RAIZ);
function dentroDaInstalacao(alvo) {
  const r = seguranca.normalizar(alvo);
  if (!r || !RAIZ_REAL) return false;
  if (r === RAIZ_REAL) return false;                       // a própria pasta, não
  return r.startsWith(RAIZ_REAL + path.sep);
}

// Rede contra erro de digitação NA MINHA LISTA: 'public' em vez de
// 'public/thumbnails' apagaria o produto inteiro. Nenhum alvo pode ser uma
// entrada de topo do pacote — essas são código.
function ehRaizDeCodigo(rel) {
  return empacotador.INCLUIR.includes(rel) || rel === 'themes' || rel === 'node_modules';
}

// Expande `*` no último segmento (o único lugar onde uso curinga).
function expandir(rel) {
  if (!rel.includes('*')) return fs.existsSync(path.join(RAIZ, rel)) ? [rel] : [];
  const dir = path.dirname(rel);
  const molde = path.basename(rel);
  const rx = new RegExp('^' + molde.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  let nomes = [];
  try { nomes = fs.readdirSync(path.join(RAIZ, dir)); } catch { return []; }
  return nomes.filter(n => rx.test(n)).map(n => (dir === '.' ? n : dir + '/' + n));
}

// `medir` do caminhos-seguros.js anda numa ÁRVORE; para arquivo solto ele
// devolve zero (nunca precisou disso). Aqui a maioria dos alvos é arquivo, e
// mostrar "0 B" para o users.json seria mentir na tela de confirmação.
function ehDiretorio(abs) {
  try { return fs.statSync(abs).isDirectory(); } catch { return false; }
}

function contagem(m) {
  const n = m.arquivos + (m.truncado ? '+' : '');
  return m.arquivos === 1 && !m.truncado ? '1 arquivo' : n + ' arquivos';
}

function medida(abs) {
  const m = seguranca.medir(abs);
  if (!m.existe || m.arquivos) return m;
  try {
    const st = fs.statSync(abs);
    if (!st.isDirectory()) return { ...m, arquivos: 1, bytes: st.size };
  } catch { /* sumiu no meio: fica como está */ }
  return m;
}

// Monta a lista final: a espinha acima + o que o rastreio do empacotador achar
// e ninguém tiver listado. O extra aparece em separado, para a próxima pessoa
// ver que existe algo novo e decidir se vira linha fixa.
function planejar() {
  const itens = [];
  const vistos = new Set();
  const juntar = (rel, grupo, porque) => {
    // Já coberto por si mesmo ou por uma PASTA que já entrou na lista: apagar
    // duas vezes não estraga nada, mas a tela de confirmação viraria um muro
    // de 46 linhas por baixo de "public/thumbnails".
    if (vistos.has(rel)) return;
    if ([...vistos].some(v => rel.startsWith(v + '/'))) return;
    vistos.add(rel);
    const abs = path.join(RAIZ, rel);
    const m = medida(abs);
    // Pasta gerada e VAZIA (public/uploads numa instalação que nunca subiu
    // imagem) não é sujeira: apagar e recriar só encheria a tela.
    if (!m.arquivos && ehDiretorio(abs)) return;
    const recusa = ehRaizDeCodigo(rel) ? 'é raiz de código do produto'
      : !dentroDaInstalacao(abs) ? 'está fora da pasta do NASCERA'
      : null;
    itens.push({ rel, abs, grupo, porque, recusa, medida: m });
  };

  for (const g of GRUPOS) {
    for (const molde of g.alvos) for (const rel of expandir(molde)) juntar(rel, g.titulo, g.porque);
  }

  const rastreados = empacotador.caminhosEscritosPeloCodigo(
    RAIZ, empacotador.arquivosDeCodigoDeProduto(RAIZ));
  for (const rel of [...rastreados].sort()) {
    // O rastreio aponta a PASTA que recebe escrita, e algumas são mistas:
    // themes/thumbnails guarda as 76 miniaturas do catálogo de temas (produto,
    // ficam) e, no meio delas, a captura de cada projeto (dado, sai pelo molde
    // `project_*` da lista acima). Apagar a pasta inteira aqui deixaria o
    // comprador com uma galeria de temas sem imagem nenhuma. Mesma isenção que
    // o empacotador usa — uma fonte só para os dois.
    if (empacotador.ESCRITO_MAS_DO_PRODUTO.includes(rel)) continue;
    for (const achado of expandir(rel)) {
      juntar(achado, 'Achado pelo rastreio do código',
        'o servidor grava aqui em tempo de execução e ninguém tinha listado');
    }
  }
  return itens;
}

// ─── a área de projetos (opcional, e por outro caminho) ───────────────
const _home = process.env.HOME || os.homedir() || '/root';
const PROJECTS_BASE = process.env.PROJECTS_BASE || path.join(_home, 'Nascera AI Projects');

// A área de projetos vem de uma variável de ambiente. Se ela estiver apontando
// para uma pasta que NÃO é uma área de projetos — a home, /root (é o default do
// preview-server.js), a raiz de um disco — então `--incluir-projetos` mandaria
// tudo que estiver lá dentro para a lixeira, item por item, sem nada recusar:
// `configurar(BASE)` faz `dentroDaAreaDeProjetos` aprovar QUALQUER filho da
// base, e é ele quem `apagarComSeguranca` consulta. A defesa contra isso já
// existia em caminhos-seguros.js (`pastasProibidas`, do acidente dos 200 GB) e
// não estava sendo usada aqui. Não dá para chamar `motivoParaRecusar` depois de
// `configurar`: ele recusa a própria base por definição, e recusaria também a
// área legítima. Então a pergunta é feita antes e só sobre a base.
function motivoBaseProibida() {
  const alvo = seguranca.normalizar(PROJECTS_BASE);
  if (!alvo) return 'o caminho é inválido';
  if (seguranca.pastasProibidas().includes(alvo))
    return 'é uma pasta do sistema ou a sua pasta pessoal, não uma área de projetos';
  if (path.dirname(alvo) === alvo) return 'é a raiz de um disco';
  if (RAIZ_REAL && (alvo === RAIZ_REAL || RAIZ_REAL.startsWith(alvo + path.sep)))
    return 'contém a própria pasta do NASCERA';
  return null;
}

function planejarProjetos() {
  if (motivoBaseProibida()) return [];
  if (!fs.existsSync(PROJECTS_BASE)) return [];
  seguranca.configurar(PROJECTS_BASE);
  return fs.readdirSync(PROJECTS_BASE).map(n => {
    const abs = path.join(PROJECTS_BASE, n);
    return {
      rel: path.join(path.basename(PROJECTS_BASE), n),
      abs,
      // O portão decide, não eu. Se ele recusar, o item simplesmente fica.
      recusa: seguranca.dentroDaAreaDeProjetos(abs) ? null : 'o portão de exclusão recusou',
      medida: medida(abs),
    };
  });
}

// ─── saída ────────────────────────────────────────────────────────────
function mostrar(itens, projetos, ensaio) {
  const vivos = itens.filter(i => i.medida.existe && !i.recusa);
  const recusados = itens.filter(i => i.recusa);

  console.log(`\n🧹  Limpeza do NASCERA — ${ensaio ? 'ENSAIO (nada será apagado)' : 'APAGANDO DE VERDADE'}`);
  console.log(`    pasta: ${RAIZ}\n`);

  if (!vivos.length) {
    console.log('  Nada a apagar: esta cópia já está no estado de fábrica.');
  } else {
    let grupo = null;
    for (const i of vivos) {
      if (i.grupo !== grupo) {
        grupo = i.grupo;
        console.log(`  ${grupo}`);
        console.log(`    (${i.porque})`);
      }
      const tam = seguranca.formatarTamanho(i.medida.bytes);
      const qtd = i.medida.arquivos > 1 ? `, ${contagem(i.medida)}` : '';
      console.log(`      · ${i.rel}   ${tam}${qtd}`);
    }
  }

  if (recusados.length) {
    console.log('\n  Não vou tocar (o portão recusou):');
    for (const i of recusados) console.log(`      · ${i.rel} — ${i.recusa}`);
  }

  const baseProibida = projetos ? motivoBaseProibida() : null;
  if (baseProibida) {
    console.log('\n  ÁREA DE PROJETOS — NÃO vou tocar, apesar do --incluir-projetos');
    console.log(`    ${PROJECTS_BASE}`);
    console.log(`    ${baseProibida}.`);
    console.log('    Apagar item por item de uma pasta dessas é o acidente que o portão');
    console.log('    de caminhos-seguros.js existe para impedir. Corrija PROJECTS_BASE');
    console.log('    (no .env ou no ambiente) e rode de novo.');
  } else if (projetos) {
    console.log('\n  ÁREA DE PROJETOS — o trabalho da pessoa (--incluir-projetos)');
    console.log(`    ${PROJECTS_BASE}`);
    if (!projetos.length) console.log('      (vazia ou inexistente)');
    for (const p of projetos) {
      const tam = seguranca.formatarTamanho(p.medida.bytes);
      console.log(`      · ${p.rel}   ${tam}, ${contagem(p.medida)}`
        + (p.recusa ? `   [${p.recusa}]` : ''));
    }
    console.log('    Vai para a LIXEIRA do sistema (recuperável), não para o /dev/null.');
  } else {
    console.log(`\n  A área de projetos NÃO será tocada: ${PROJECTS_BASE}`);
    console.log('    (use --incluir-projetos se você quiser apagá-la também)');
  }
  return vivos;
}

function confirmar(quantos, comProjetos) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      console.error('\n  ⚠  Terminal não interativo. Sem --sim eu não apago nada.');
      return resolve(false);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const aviso = comProjetos ? ' E A ÁREA DE PROJETOS' : '';
    console.log(`\n  Isto vai apagar ${quantos} item(ns) desta instalação${aviso}. Não tem desfazer.`);
    rl.question('  Digite APAGAR para confirmar: ', (r) => {
      rl.close();
      resolve(String(r).trim() === 'APAGAR');
    });
  });
}

async function principal(argv = process.argv) {
  const apagar = argv.includes('--apagar');
  const semPergunta = argv.includes('--sim');
  const comProjetos = argv.includes('--incluir-projetos');
  const ensaio = !apagar;

  const itens = planejar();
  const projetos = comProjetos ? planejarProjetos() : null;
  const vivos = mostrar(itens, projetos, ensaio);

  if (ensaio) {
    console.log('\n  Isto foi um ENSAIO. Para apagar de verdade:');
    console.log('    node scripts/limpar.js --apagar' + (comProjetos ? ' --incluir-projetos' : '') + '\n');
    return 0;
  }
  if (!vivos.length && !(projetos && projetos.length)) {
    console.log('\n  Nada a fazer.\n');
    return 0;
  }
  if (!semPergunta) {
    const ok = await confirmar(vivos.length, comProjetos && projetos.length);
    if (!ok) { console.log('\n  Cancelado. Nada foi apagado.\n'); return 1; }
  }

  console.log('');
  let apagados = 0, falhas = 0;
  for (const i of vivos) {
    // Segunda passada pelo portão: entre planejar e apagar o disco pode ter
    // mudado, e o custo de conferir de novo é zero perto do custo de errar.
    if (!dentroDaInstalacao(i.abs) || ehRaizDeCodigo(i.rel)) {
      console.log(`  ✖ ${i.rel} — recusado no portão`); falhas++; continue;
    }
    try { fs.rmSync(i.abs, { recursive: true, force: true }); apagados++; console.log(`  ✓ ${i.rel}`); }
    catch (e) { falhas++; console.log(`  ✖ ${i.rel} — ${e.message}`); }
  }
  for (const rel of RECRIAR_VAZIAS) {
    try { fs.mkdirSync(path.join(RAIZ, rel), { recursive: true }); } catch {}
  }

  let projetosApagados = 0;
  if (projetos && projetos.length) {
    console.log('\n  Área de projetos → lixeira do sistema:');
    for (const p of projetos) {
      // O portão de caminhos-seguros.js é quem apaga. Ele manda para a
      // lixeira e recusa qualquer coisa fora da área — inclusive a raiz.
      const r = seguranca.apagarComSeguranca(p.abs, 'limpar.js --incluir-projetos');
      if (r.ok) { projetosApagados++; console.log(`  ✓ ${p.rel} (${r.metodo})`); }
      else { falhas++; console.log(`  ✖ ${p.rel} — ${r.erro}`); }
    }
  }

  // ─── o que foi feito e o que fazer agora ───────────────────────────
  console.log('\n  ─────────────────────────────────────────────');
  console.log(`  Apagados ${apagados} item(ns) da instalação`
    + (projetos && projetos.length ? ` e ${projetosApagados} projeto(s)` : '')
    + (falhas ? `; ${falhas} não saíram (motivo acima)` : '') + '.');
  // Quais subsistemas estão MESMO no banco depende de duas chaves separadas
  // (estado-db.js: `db.ATIVO && NASCERA_DB_STATE === 'pg'`; billing-db.js: o
  // mesmo com NASCERA_DB_BILLING). Dizer "o estado vive no Postgres" com as duas
  // desligadas seria assustar à toa; dizer nada com elas ligadas seria prometer
  // uma limpeza que não aconteceu. Então diz-se exatamente o que está ligado —
  // e a frase "estado de fábrica" só sai quando ela é verdade.
  const noBanco = [];
  if (process.env.DATABASE_URL) {
    if (process.env.NASCERA_DB_STATE === 'pg') noBanco.push('contas, projetos, domínios e configuração');
    if (process.env.NASCERA_DB_BILLING === 'pg') noBanco.push('créditos e extrato');
  }

  // "Está tudo limpo" com item que não saiu — ou com o estado vivo no banco —
  // é a mensagem que mente. Quem lê precisa saber que a cópia AINDA carrega
  // dado do dono, e por qual dos dois motivos.
  if (falhas) {
    console.log('  ⚠  Como nem tudo saiu, esta cópia NÃO está no estado de fábrica:');
    console.log('     os itens marcados com ✖ acima continuam no disco. Resolva o');
    console.log('     motivo de cada um (permissão, arquivo em uso) e rode de novo.');
  } else if (noBanco.length) {
    console.log('  ⚠  A PASTA está limpa, mas esta instalação NÃO está no estado de');
    console.log('     fábrica: o estado real dela não mora mais nos .json apagados.');
  } else {
    console.log('  Esta cópia está no estado de fábrica: sem contas, sem cofre, sem');
    console.log('  configuração personalizada, sem projetos registrados e sem histórico.');
  }

  // O `.git` é o outro lugar onde o dado apagado continua vivo — e este script
  // não pode reescrever histórico de repositório de ninguém. Conferido nesta
  // máquina: 34 miniaturas de public/thumbnails e 20 de themes/thumbnails
  // estão RASTREADAS, e o .gitignore não cobre "thumbnails". Depois desta
  // limpeza, um `git checkout .` traz as capturas dos projetos de volta.
  if (fs.existsSync(path.join(RAIZ, '.git'))) {
    console.log('\n  ⚠  Esta pasta tem um repositório .git — e ele NÃO foi tocado.');
    console.log('     O que acabou de sair do disco pode continuar no histórico e voltar');
    console.log('     com um `git checkout`. Confira com `git status`; se aparecerem');
    console.log('     miniaturas de projeto apagadas, elas estavam versionadas.');
    console.log('     Para entregar a cópia sem histórico, apague a pasta .git.');
  }

  if (process.env.DATABASE_URL) {
    console.log('\n  ⚠  DATABASE_URL está definida: existe um POSTGRES fora desta pasta,');
    console.log('     e ele NÃO foi tocado.');
    if (noBanco.length) {
      console.log(`     Hoje ele é a fonte da verdade de: ${noBanco.join('; ')}.`);
      console.log('     As contas continuam de pé — apagar os .json acima não zerou nada');
      console.log('     disso. Zere o banco à parte antes de entregar a cópia.');
    } else {
      console.log('     Nenhum subsistema está lendo dele agora (NASCERA_DB_STATE e');
      console.log('     NASCERA_DB_BILLING não estão em "pg"), mas confira se sobrou dado lá.');
    }
  }
  console.log('\n  Próximo passo:');
  const win = process.platform === 'win32' && fs.existsSync(path.join(RAIZ, 'iniciar.bat'));
  // node_modules NÃO é apagado (não é dado de ninguém), mas numa pasta COPIADA
  // de outra máquina ele carrega binários compilados para o SO/arquitetura de
  // lá — inclusive o binário do Claude Code dentro de
  // @anthropic-ai/claude-agent-sdk-*. Foi exatamente esse o segundo defeito do
  // caso que originou este script: "binary exists but failed to launch ...
  // does not match this system's libc". Mandar "npm start" sem dizer isto é
  // entregar a tarde perdida de novo.
  if (fs.existsSync(path.join(RAIZ, 'node_modules'))) {
    console.log('    0. Se esta pasta veio COPIADA de outro computador, apague node_modules');
    console.log('       e rode `npm install` aqui: os binários de lá não rodam nesta máquina.');
  }
  console.log(win ? '    1. Abra o iniciar.bat' : '    1. npm start');
  console.log('    2. Abra http://localhost:3333 — a tela pedirá para CRIAR a conta nova.');
  console.log('    3. O primeiro login vira o administrador desta instalação.\n');
  return falhas ? 1 : 0;
}

if (require.main === module) {
  principal().then(c => process.exit(c)).catch(e => {
    console.error('\n  ✖ ' + (e && e.message) + '\n');
    process.exit(1);
  });
}

module.exports = { GRUPOS, planejar, planejarProjetos, motivoBaseProibida, dentroDaInstalacao, ehRaizDeCodigo, expandir, PROJECTS_BASE, RAIZ };
