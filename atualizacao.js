// ═══════════════════════════════════════════════════════════════════════
// NASCERA — Atualização pelo painel
//
// O dono da instalação aperta um botão e a cópia dele se atualiza sozinha.
// Antes disso, atualizar era "entre por SSH e copie arquivos" — o que na
// prática significa que ninguém atualizava.
//
// A regra que manda em tudo aqui: CÓDIGO é substituído, DADO nunca.
// Um update que apaga users.json ou projects.json destrói o negócio do
// cliente; por isso a lista PRESERVAR abaixo é conferida em dois momentos
// (ao extrair e ao copiar), e o backup é feito antes de encostar em nada.
//
// A segunda regra veio do Windows: SÓ SAIR SE HOUVER QUEM SUBA DE VOLTA.
// `process.exit(0)` é "reiniciar" onde existe pm2/systemd e é "desaparecer"
// numa janela de PowerShell — e a tela não pode prometer um enquanto acontece
// o outro. Quem responde a essa pergunta é `haQuemMeSuba()`.
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const logger = require('./log.js');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { execFileSync } = require('child_process');
// Verificação de assinatura do pacote — sem ela, um servidor de atualização
// comprometido vira execução remota em toda a base instalada.
const assinatura = require('./assinatura.js');
// `invocacaoDe` é a fonte única de "como se chama este comando nesta máquina".
// Mora em motores.js porque lá já existiam as três chamadas de npm; duplicar a
// regra aqui era garantir que uma das cópias envelhecesse sozinha.
const { invocacaoDe } = require('./motores.js');

const LICENSE_SERVER_URL = process.env.LICENSE_SERVER_URL || 'https://api.nascera.ai';
const RAIZ = __dirname;
// Deixou de ser constante quando a raiz virou parâmetro: os backups têm que
// ficar DENTRO da instalação que está sendo atualizada, nunca na do processo.
function pastaDeBackups(raiz) { return path.join(raiz || RAIZ, '.backups'); }

// Nunca sobrescrever: é o que o cliente construiu e o que o servidor dele é.
const PRESERVAR = new Set([
  'users.json', 'projects.json', 'billing.json', 'domains.json', 'theme.json',
  'integrations.json', 'trash.json', 'activity-log.json', 'nascera-config.json',
  '.credenciais.json',
  '.env', 'ecosystem.config.js', '.nascera-install.json', '.nascera-activation-pending.json',
  'telemetry-buffer.json', 'node_modules', '.backups', 'projetos', 'projects',
]);

// Dentro de public/, o cliente pode ter coisa dele (landing page, uploads).
// Só apagamos o que vem no pacote; o resto fica.
function ehPreservado(rel) {
  const primeiro = rel.split(path.sep)[0];
  return PRESERVAR.has(primeiro) || PRESERVAR.has(rel) || rel.startsWith('.backups');
}

// Lê do DISCO, não do `require` — que guarda o package.json em cache desde o
// boot. Quando a máquina não tem supervisor (Windows nativo), o processo
// continua vivo DEPOIS da troca de arquivos: com o valor em cache o painel
// voltaria dizendo que a versão instalada é a antiga, o servidor de
// atualizações concordaria e o botão Atualizar reapareceria — o cliente
// baixaria e aplicaria o MESMO pacote sem fim, criando um backup a cada volta.
// O que está instalado é o que está no disco; o `require` fica de reserva para
// o caso de o arquivo estar ilegível no exato instante da leitura.
function versaoAtual() {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
    if (p && p.version) return String(p.version);
  } catch { /* cai na reserva abaixo */ }
  try { return require('./package.json').version || '0.0.0'; } catch { return '0.0.0'; }
}

// ─── quem sobe o Nascera de volta? ─────────────────────────────────────
// A pergunta NÃO é "é Windows?" — é "existe alguém que me suba de novo se eu
// sair?". No Linux/macOS de produção é o pm2 (ou o systemd), e sair É o jeito
// de subir com o código novo. No Windows nativo o Nascera é `npm start` numa
// janela do PowerShell (README-WINDOWS, Passo 5): ninguém o supervisiona, e um
// `process.exit(0)` ali significa "o Nascera some da máquina" — junto com os
// sites publicados — enquanto a tela diz "reiniciando". Um `node server.js`
// solto no Mac morre exatamente do mesmo jeito; por isso o gate é o supervisor,
// não a plataforma.
//
// pm2 e systemd carimbam o ambiente do processo que supervisionam; é isso que
// lemos. NASCERA_REINICIO_AUTOMATICO é a saída para quem usa um supervisor que
// não conhecemos (docker com restart, nssm, forever): sem ela, essa instalação
// passaria a pedir reinício manual sem precisar.
function haQuemMeSuba(env) {
  const e = env || process.env;
  const forcado = String(e.NASCERA_REINICIO_AUTOMATICO || '').trim().toLowerCase();
  if (forcado === '1' || forcado === 'true') return true;
  if (forcado === '0' || forcado === 'false') return false;
  return !!(e.pm_id || e.pm2_env || e.PM2_HOME || e.pm_exec_path        // pm2
         || e.INVOCATION_ID || e.NOTIFY_SOCKET                          // systemd
         || e.SUPERVISOR_ENABLED);                                      // supervisord
}

// A instrução tem que nomear o que a pessoa REALMENTE usou para subir. Se a
// instalação tiver um atalho, foi nele que ela clicou; senão é o `npm start`
// que o README manda digitar. Mandar rodar um comando que o cliente nunca viu
// é o mesmo tipo de mentira que estamos tirando daqui.
//
// O atalho só vale se ESTA plataforma souber executá-lo. `iniciar.bat` viaja
// DENTRO do pacote de release (está em INCLUIR no empacotar-release), então
// depois da primeira atualização ele existe também no Mac e no Linux — e
// "feche a janela e abra com o iniciar.bat" dito a um usuário de macOS é
// exatamente a frase falsa que este arquivo existe para acabar. Por isso a
// lista é escolhida por plataforma, no mesmo padrão de `lixeiraDoSistema()`:
// um gate só, no lugar onde a pergunta realmente é sobre o SO.
function comandoParaSubir(raiz, plataforma = process.platform) {
  const atalhos = plataforma === 'win32'
    ? ['iniciar.bat', 'iniciar.cmd']
    : ['iniciar.command', 'iniciar.sh'];   // hoje não existem; ficam prontos se alguém criar
  for (const atalho of atalhos) {
    try {
      // `./` no Unix porque sem ele o shell não acha o arquivo do diretório
      // atual — a instrução precisa ser copiável como está.
      if (fs.existsSync(path.join(raiz, atalho))) {
        return plataforma === 'win32' ? 'o ' + atalho : './' + atalho;
      }
    } catch { /* segue */ }
  }
  return 'npm start';
}

function installId() {
  try { return require('./telemetry').loadIdentity().installId; } catch { return null; }
}

// ─── Consulta ────────────────────────────────────────────────────────
async function verificar() {
  const atual = versaoAtual();
  const r = await axios.get(`${LICENSE_SERVER_URL}/api/update/latest`, {
    params: { current: atual, installId: installId() },
    timeout: 15000,
  });
  const d = r.data || {};
  return {
    ok: true,
    versaoAtual: atual,
    versaoNova: d.version || null,
    temAtualizacao: !!d.updateAvailable && !!d.version,
    notas: d.notes || null,
    tamanho: d.size || null,
    sha256: d.sha256 || null,
    assinatura: d.signature || d.assinatura || null,
    publicadaEm: d.publishedAt || null,
    downloadUrl: d.downloadUrl || null,
  };
}

// ─── Aplicação ───────────────────────────────────────────────────────
// Estado em memória: a atualização é longa e o painel acompanha por polling.
let _estado = { rodando: false, etapa: null, erro: null, concluido: false, versao: null, em: null };
function estado() { return { ..._estado }; }
function marcar(etapa) { _estado.etapa = etapa; _estado.em = new Date().toISOString(); }

// `raiz`, `env` e `plataforma` só existem para o teste: com eles a atualização
// é aplicada numa pasta descartável, a ausência de supervisor é simulada sem
// mexer no ambiente do processo e o texto do Windows é provado rodando num Mac.
// Em produção ninguém passa nada e vale a instalação de verdade — mesmo padrão
// do `plataforma` em caminhos-seguros.js.
async function aplicar({ aoTerminar, raiz, env, plataforma } = {}) {
  const ALVO = raiz || RAIZ;
  if (_estado.rodando) return { erro: 'Já existe uma atualização em andamento' };
  _estado = {
    rodando: true, etapa: 'verificando', erro: null, concluido: false,
    versao: null, em: new Date().toISOString(), reinicio: null, mensagem: null,
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nascera-update-'));

  // PONTO SEM VOLTA: do primeiro `cpSync` sobre a instalação em diante ela está
  // MISTURADA — parte nova, parte velha. Antes só o catch do npm desfazia; um
  // EPERM no meio da cópia (antivírus ou o próprio Windows segurando um
  // arquivo, o cenário mais comum lá) passava direto e a instalação ficava meio
  // de cada, sem rollback e sem ninguém avisado.
  let backup = null, sobrescrevendo = false, restaurado = false;

  // Desfaz UMA vez só: o catch do npm e o catch de fora podem os dois chegar
  // aqui. Devolve o pedaço de frase que descreve o que REALMENTE aconteceu —
  // inclusive quando a própria restauração falha, que é justamente o caso em
  // que o dono precisa saber onde estão os arquivos antigos.
  const desfazer = () => {
    if (!sobrescrevendo || !backup || restaurado) return '';
    restaurado = true;
    marcar('desfazendo');
    if (restaurar(backup, ALVO)) return ' A versão anterior foi restaurada e nada mudou.';
    return ' ATENÇÃO: a restauração automática também falhou e a instalação ficou misturada —'
         + ' os arquivos da versão anterior estão em ' + backup + '.';
  };

  try {
    const info = await verificar();
    if (!info.temAtualizacao) throw new Error('Já está na versão mais recente');
    _estado.versao = info.versaoNova;

    // 1. baixar
    marcar('baixando');
    const pacote = path.join(tmp, 'pacote.tar.gz');
    const resp = await axios.get(info.downloadUrl, {
      responseType: 'arraybuffer', timeout: 600000, maxContentLength: 500 * 1024 * 1024,
      params: { installId: installId() },
    });
    fs.writeFileSync(pacote, Buffer.from(resp.data));

    // 2. conferir o que chegou — pacote corrompido não pode encostar no disco
    marcar('conferindo');
    const sha = crypto.createHash('sha256').update(fs.readFileSync(pacote)).digest('hex');
    if (info.sha256 && sha !== info.sha256) {
      throw new Error('O pacote baixado não confere com o publicado — atualização abortada');
    }

    // 2b. ASSINATURA — a checagem que realmente importa.
    // O sha256 acima veio do mesmo servidor que serviu o pacote: se esse
    // servidor for comprometido, ele entrega o pacote malicioso E o hash que
    // bate. Como aqui roda CÓDIGO na máquina do cliente, isso viraria execução
    // remota em toda a base instalada. A assinatura Ed25519 é verificada com
    // uma chave pública embutida no cliente — o servidor não consegue forjar.
    const ver = assinatura.verificarArquivo(pacote, info.assinatura);
    if (!ver.ok) {
      throw new Error('Atualização recusada: ' + ver.motivo);
    }
    if (!ver.verificado) {
      logger.warn('[atualizacao] pacote aplicado SEM verificação de assinatura (' +
                   ver.motivo + '). Configure NASCERA_UPDATE_PUBKEY para exigir.');
    }

    // 3. abrir num canto isolado
    marcar('extraindo');
    const extraido = path.join(tmp, 'novo');
    fs.mkdirSync(extraido);
    execFileSync('tar', ['xzf', pacote, '-C', extraido], { timeout: 300000 });

    const origem = raizDoPacote(extraido);
    if (!fs.existsSync(path.join(origem, 'server.js'))) {
      throw new Error('O pacote não parece ser um NASCERA (não achei server.js)');
    }

    // 4. backup do que existe hoje
    marcar('salvando backup');
    backup = path.join(pastaDeBackups(ALVO), `antes-de-${info.versaoNova}-${Date.now()}`);
    fs.mkdirSync(backup, { recursive: true });
    for (const nome of listarDoPacote(origem)) {
      const atual = path.join(ALVO, nome);
      if (fs.existsSync(atual)) {
        fs.cpSync(atual, path.join(backup, nome), { recursive: true });
      }
    }

    // 5. copiar por cima — só o que veio no pacote, nunca dado
    marcar('aplicando');
    let copiados = 0;
    sobrescrevendo = true;   // a partir daqui, qualquer falha tem que desfazer
    for (const nome of listarDoPacote(origem)) {
      if (ehPreservado(nome)) continue;
      fs.cpSync(path.join(origem, nome), path.join(ALVO, nome), { recursive: true, force: true });
      copiados++;
    }

    // 6. dependências novas, se o pacote trouxe package.json diferente
    marcar('instalando dependências');
    try {
      // No Windows `npm` é `npm.cmd` — um script, não um executável. O
      // execFileSync nunca o achava (a busca de PATH do Node só tenta .com/.exe)
      // e, desde o Node 18.20/20.12, recusa rodar .cmd sem shell. O resultado
      // era o pior possível: o catch abaixo restaurava o backup, então o botão
      // Atualizar DESFAZIA a atualização toda vez e o cliente Windows ficava
      // preso na versão que instalou. `invocacaoDe` devolve `node npm-cli.js …`
      // lá e o `npm` de sempre aqui — sem abrir shell em nenhum dos dois.
      const inv = invocacaoDe('npm', ['install', '--omit=dev', '--no-audit', '--no-fund']);
      execFileSync(inv.arquivo, inv.args, {
        cwd: ALVO, timeout: 600000, shell: inv.shell,
        // stderr capturado (era 'ignore'): o motivo da falha é justamente o que
        // faltava para diagnosticar um rollback. maxBuffer folgado porque
        // estourá-lo MATA o npm no meio — e aí a falha seria nossa.
        stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 32 * 1024 * 1024,
      });
    } catch (e) {
      // Sem as dependências o código novo não sobe. Deixar assim derrubaria a
      // plataforma do cliente — então desfaz tudo e volta para o que funcionava.
      // A frase do desfazer vem de `desfazer()` porque ela precisa MUDAR quando
      // a restauração não dá certo: antes o texto garantia que "nada mudou"
      // mesmo quando `restaurar` tinha devolvido false.
      const motivo = String((e && e.stderr) || (e && e.message) || '').trim().slice(-400);
      logger.error('[atualizacao] npm install falhou —', motivo);
      throw new Error('As dependências não instalaram.' + desfazer() +
                      (motivo ? ' Motivo: ' + motivo : ''));
    }

    gravarHistorico({ versao: info.versaoNova, backup, arquivos: copiados }, ALVO);
    const resultado = { ok: true, versao: info.versaoNova, arquivos: copiados, backup };
    const automatico = haQuemMeSuba(env);

    // ─── e agora, quem reinicia? ─────────────────────────────────────
    // Duas saídas eram possíveis: (a) o processo se relançar sozinho (`spawn`
    // detached + unref) ou (b) não sair e mandar a pessoa abrir o Nascera de
    // novo. Escolhemos (b) para quem não tem supervisor, porque é a previsível:
    //   • em (a) o processo novo precisa achar a porta livre no instante em que
    //     o velho ainda está saindo. Se não achar, ele morre com EADDRINUSE
    //     SEM JANELA NENHUMA para mostrar o erro — a máquina fica sem Nascera e o
    //     cliente achando que atualizou. É exatamente a falha silenciosa que
    //     este trecho existe para acabar.
    //   • em (a), no Windows, `detached` significa processo sem console: o Nascera
    //     passa a rodar invisível, fechar a janela não o mata mais e o próximo
    //     `npm start` bate em "porta 3333 já está em uso" sem que exista janela
    //     alguma para fechar. Para quem não é técnico isso é um beco sem saída.
    //   • em (b) a máquina nunca fica sem Nascera: o que está no ar continua no ar
    //     (o código velho já está carregado na memória) e a instrução é uma coisa
    //     só, que a pessoa já sabe fazer — foi assim que ela abriu o Nascera.
    // Onde HÁ supervisor nada muda: sair continua sendo o jeito certo de subir
    // com o código novo, e é o caminho da produção Linux/macOS de hoje.
    if (aoTerminar || automatico) {
      marcar('reiniciando');
      _estado.reinicio = 'automatico';
      _estado.mensagem = 'O Nascera vai reiniciar sozinho com a versão nova.';
      _estado.concluido = true;
      _estado.rodando = false;
      setTimeout(() => {
        try { (aoTerminar || (() => process.exit(0)))(); }
        catch (e) {
          logger.error('[atualizacao] o encerramento falhou —', (e && e.message) || e);
          // Só insiste em sair se houver mesmo quem suba de novo. Sem
          // supervisor, sair é sumir.
          if (automatico) process.exit(0);
        }
      }, 1500);
      return { ...resultado, reinicio: 'automatico', mensagem: _estado.mensagem };
    }

    // Sem supervisor: a atualização está no disco e o processo CONTINUA VIVO.
    // A etapa não vira 'reiniciando' de propósito — nada vai reiniciar, e o
    // painel usa esse nome para dizer que está reiniciando.
    const aviso = 'Versão ' + info.versaoNova + ' instalada no disco. Ela passa a valer quando o Nascera for aberto'
      + ' de novo: esta máquina não tem quem o reinicie sozinho. Feche a janela em que o Nascera está rodando'
      + ' (Ctrl + C) e abra com ' + comandoParaSubir(ALVO, plataforma) + '. Até lá o Nascera continua no ar, funcionando,'
      + ' com a versão anterior — nada foi perdido.';
    _estado.reinicio = 'manual';
    _estado.mensagem = aviso;
    _estado.concluido = true;
    _estado.rodando = false;
    // No Windows a janela do PowerShell É o Nascera rodando (README-WINDOWS,
    // Passo 5). Escrever nela é falar com a pessoa no lugar onde ela já olha
    // quando desconfia de alguma coisa.
    logger.warn('[atualizacao] ' + aviso);
    return { ...resultado, reinicio: 'manual', mensagem: aviso };
  } catch (err) {
    // Falha depois que a cópia começou deixaria a instalação meio nova e meio
    // velha — e o processo seguiria rodando código misturado até alguém
    // reiniciar. `desfazer()` é no-op se nada tinha sido sobrescrito ainda.
    const volta = desfazer();
    _estado.rodando = false;
    _estado.erro = err.message + volta;
    return { erro: _estado.erro };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// Volta o que o backup guardou. Só toca no que foi salvo — o que nunca foi
// mexido continua onde está. (`raiz` só é parâmetro para o teste.)
function restaurar(backup, raiz) {
  const alvo = raiz || RAIZ;
  try {
    for (const nome of fs.readdirSync(backup)) {
      if (ehPreservado(nome)) continue;
      fs.cpSync(path.join(backup, nome), path.join(alvo, nome), { recursive: true, force: true });
    }
    return true;
  } catch (e) {
    // Se nem o rollback funcionou, o dono precisa saber onde estão os arquivos.
    logger.error('[atualização] falha ao restaurar de', backup, '—', e.message);
    return false;
  }
}

// O tar pode vir com tudo dentro de uma pasta só — segue para dentro dela.
function raizDoPacote(dir) {
  const itens = fs.readdirSync(dir).filter(n => !n.startsWith('._'));
  if (itens.length === 1) {
    const unico = path.join(dir, itens[0]);
    if (fs.statSync(unico).isDirectory()) return unico;
  }
  return dir;
}

function listarDoPacote(dir) {
  return fs.readdirSync(dir).filter(n => !n.startsWith('._') && n !== '.' && n !== '..');
}

function gravarHistorico(item, raiz) {
  const f = path.join(raiz || RAIZ, '.updates.json');
  let hist = [];
  try { hist = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  hist.unshift({ ...item, em: new Date().toISOString() });
  try { fs.writeFileSync(f, JSON.stringify(hist.slice(0, 20), null, 2)); } catch {}
}

function historico() {
  try { return JSON.parse(fs.readFileSync(path.join(RAIZ, '.updates.json'), 'utf8')); } catch { return []; }
}

// `haQuemMeSuba` é exportado porque é a decisão que separa "sair é reiniciar"
// de "sair é sumir": ela precisa de teste próprio, e o painel/instalador podem
// querer avisar de antemão que esta máquina vai pedir reinício manual.
module.exports = { verificar, aplicar, estado, historico, versaoAtual, haQuemMeSuba, PRESERVAR };
