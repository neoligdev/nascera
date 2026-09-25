#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// NASCERA — verificação de segurança e regressão
//
//   node scripts/verificar.js
//
// Roda sem servidor, sem banco e sem rede. Cada checagem existe porque a
// falha correspondente JÁ ACONTECEU neste código — não é lista teórica de
// boas práticas. Se alguma voltar, este script falha (exit 1) e o release
// não sai.
//
// Coloque no CI e antes de empacotar. É barato: roda em menos de um segundo.
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const ler = (f) => { try { return fs.readFileSync(path.join(RAIZ, f), 'utf8'); } catch { return ''; } };

let falhas = 0, avisos = 0;
function checar(nome, condicaoOk, detalhe) {
  if (condicaoOk) { console.log('  ✓ ' + nome); return true; }
  console.log('  ✖ ' + nome + (detalhe ? '\n      ' + detalhe : ''));
  falhas++;
  return false;
}
function avisar(nome, ok, detalhe) {
  if (ok) { console.log('  ✓ ' + nome); return true; }
  console.log('  ⚠ ' + nome + (detalhe ? '\n      ' + detalhe : ''));
  avisos++;
  return false;
}

// O "server" destas checagens é o CÓDIGO DE SERVIDOR, não o arquivo server.js.
//
// A distinção nasceu de um estrago real: quando o server.js foi quebrado em
// rotas/ e servicos/, todo o código procurado aqui mudou de casa e OITO
// checagens passaram a falhar — nenhuma delas por regressão de verdade. Um
// portão que dá alarme falso é um portão que se aprende a pular com
// --pular-verificacao, e a partir daí ele não protege mais nada. Some-se que
// o release ficou impossível de empacotar sem ninguém entender por quê.
//
// Ler os três diretórios de uma vez também torna as checagens NEGATIVAS
// ("nenhum writeFileSync direto", "nenhum comando git via shell") mais
// severas do que eram: agora elas varrem o código todo, não só um arquivo.
function lerCodigoDeServidor() {
  const partes = [ler('server.js')];
  for (const dir of ['rotas', 'servicos']) {
    let nomes = [];
    try { nomes = fs.readdirSync(path.join(RAIZ, dir)); } catch { continue; }
    for (const nome of nomes.sort()) {
      if (nome.endsWith('.js')) partes.push(ler(path.join(dir, nome)));
    }
  }
  return partes.join('\n');
}

const server = lerCodigoDeServidor();
const billing = ler('billing.js');

console.log('\n🔒  Verificação de segurança do NASCERA\n');

// ── 1. Corrupção silenciosa de estado ────────────────────────────────
console.log('Estado em disco');
{
  // O acidente: writeFileSync direto no arquivo final + catch devolvendo
  // vazio = um crash durante a gravação apagava tudo, em silêncio.
  const alvos = ['PROJECTS_FILE', 'USERS_FILE', 'TRASH_FILE', 'ACTIVITY_FILE',
                 'BILLING_FILE', 'INTEGRATIONS_FILE', 'NASCERA_CONFIG_FILE'];
  const re = new RegExp('fs\\.writeFileSync\\(\\s*(' + alvos.join('|') + ')');
  checar('nenhum writeFileSync direto em arquivo de estado',
    !re.test(server) && !re.test(billing),
    'Use gravaEstado() de estado-seguro.js — ele faz tmp+fsync+rename e guarda .bak');

  checar('estado-seguro.js presente', !!ler('estado-seguro.js'));
  checar('leitura crítica não devolve vazio por corrupção',
    ler('estado-seguro.js').includes('critico'),
    'leEstado({critico:true}) deve abortar o boot em vez de mascarar perda');
}

// ── 2. Execução de comando ───────────────────────────────────────────
console.log('\nExecução de comando');
{
  // O RCE: runCmd monta string e passa pelo shell; dado do usuário virava
  // comando. Provado com canário antes de corrigir.
  checar('nenhum comando git via shell',
    !/runCmd\(\s*[`'"]git|runCmd\(`git/.test(server),
    'Use git([args], cwd) — execFileSync passa argv, sem shell');

  checar('helper git() existe',
    /function git\(args, cwd\)/.test(server));

  checar('hash de commit é validado antes de usar',
    /hashValido/.test(server),
    'Um hash é hexadecimal; recusar cedo evita passar lixo adiante');
}

// ── 3. Autenticação ──────────────────────────────────────────────────
console.log('\nAutenticação');
{
  // O bug: iat em milissegundos jogava o exp para o ano ~58570.
  checar('nenhum iat: Date.now() em jwt.sign',
    !/jwt\.sign\([^)]*iat:\s*Date\.now\(\)/.test(server),
    'Deixe a lib carimbar o iat (em segundos), senão expiresIn não vale');

  checar('token é emitido por um helper único',
    /function signToken\(/.test(server));

  checar('verificação confere issuer e audience',
    /issuer:\s*JWT_ISS/.test(server) && /audience:\s*JWT_AUD/.test(server));

  checar('segredo não é aleatório a cada boot',
    !/JWT_SECRET\s*=\s*process\.env\.JWT_SECRET\s*\|\|\s*crypto\.randomBytes/.test(server),
    'Fallback aleatório deslogava todo mundo a cada restart');
}

// ── 4. Acesso a arquivo ──────────────────────────────────────────────
console.log('\nAcesso a arquivo');
{
  checar('rotas /api/fs passam pelo guarda de caminho',
    /function caminhoDoEditor\(/.test(server),
    'Sem isso, qualquer usuário logado lê qualquer arquivo do host');

  const rotasFs = (server.match(/app\.(get|post|delete)\('\/api\/fs\/\w+'/g) || []).length;
  const guardas = (server.match(/caminhoDoEditor\(/g) || []).length;
  checar('todas as rotas /api/fs usam o guarda (' + rotasFs + ' rotas, ' + guardas + ' usos)',
    guardas >= rotasFs);

  checar('exclusão de projeto passa por caminhos-seguros',
    /apagarComSeguranca/.test(server),
    'É o portão que impede apagar fora da área de projetos');

  checar('nenhum cp -a + rm -rf de consolo',
    !/runCmd\(`cp -a/.test(server),
    'Esse fallback apagou a pasta pessoal de um usuário (200 GB)');
}

// ── 5. Cobrança ──────────────────────────────────────────────────────
console.log('\nCobrança');
{
  checar('idempotência não é anel capado por contagem',
    !/debitedTurns\.length > 300/.test(billing),
    'Retry mais velho que o anel cobrava em dobro; a poda deve ser por tempo');

  checar('ledger de uso grava com fsync',
    /fsyncSync/.test(billing),
    'Sem fsync, "gravado" pode significar só "no cache do SO"');

  checar('ledger é escrito ANTES do estado',
    billing.indexOf('fsyncSync') < billing.indexOf('saveState();\n\n  return'),
    'Na ordem inversa, um crash tira o dinheiro sem deixar rastro');
}

// ── 6. Exposição na borda ────────────────────────────────────────────
console.log('\nBorda HTTP');
{
  checar('trust proxy configurado', /app\.set\('trust proxy'/.test(server),
    'Sem isso o rate-limit vê o IP do proxy e trata o mundo como um cliente só');
  checar('rate limit no login', /limiteSensivel/.test(server));
  checar('headers de segurança (helmet)', /helmet/.test(server));
  checar('limite de tamanho no corpo', /express\.json\(\{\s*limit/.test(server));
  checar('tratador central de erros', /res\.status\(500\)\.json\(\{[\s\S]{0,120}codigo/.test(server),
    'Devolver err.message cru vaza caminho absoluto e detalhe interno');
  checar('guardas de processo', /uncaughtException/.test(server) && /unhandledRejection/.test(server));
}

// ── 7. Multi-tenancy ─────────────────────────────────────────────────
console.log('\nMulti-tenancy');
{
  checar('portão de propriedade existe', /function podeAcessarProjeto/.test(server));
  checar('projetos são filtrados por dono', /function projetosDoUsuario/.test(server));

  const rls = ler('migracoes/002-rls-e-debito.sql');
  if (rls) {
    checar('RLS com FORCE (senão o dono da tabela ignora)',
      (rls.match(/FORCE\s+ROW LEVEL SECURITY/gi) || []).length >= 6);
    checar('role da aplicação é NOBYPASSRLS',
      /NOBYPASSRLS/.test(ler('migracoes/003-role-da-aplicacao.sql')),
      'Superusuário ignora RLS — testado e confirmado');
  }
}

// ── 8. Vazamento no empacotamento ────────────────────────────────────
console.log('\nEmpacotamento');
{
  const pack = ler('scripts/empacotar-release.js');
  for (const m of ['estado-seguro.js', 'caminhos-seguros.js', 'senhas.js', 'billing.js']) {
    checar('release inclui ' + m, pack.includes("'" + m + "'"));
  }
  for (const s of ['.jwt-secret', '.credenciais.json', '*.bak']) {
    checar('release exclui ' + s, pack.includes("'" + s + "'"));
  }
  const gi = ler('.gitignore');
  for (const s of ['.jwt-secret', '.credenciais.json', 'users.json', 'billing.json']) {
    checar('.gitignore cobre ' + s, gi.split('\n').some(l => l.trim() === s));
  }
}

// ── 9. Sessões do motor ──────────────────────────────────────────────
console.log('\nMotor de IA');
{
  const codex = ler('engine/codex-engine.mjs');
  const claude = ler('engine/claude-engine.mjs');
  checar('CodexSession define lastActivity no construtor',
    /this\.lastActivity = Date\.now\(\)/.test(codex),
    'Sem isso o sweeper calcula NaN e a sessão nunca é varrida — vaza processo');
  checar('backlog tem teto', /TETO_BACKLOG/.test(codex),
    'Fila sem limite estoura a memória do processo e derruba todos');
  checar('controle de admissão de sessões', /podeAbrir\(/.test(claude),
    'Sem teto, N usuários simultâneos derrubam a máquina por OOM');
}

// ── 10. Exposição de rede e primeiro acesso ──────────────────────────
// Achados de auditoria externa (cliente, 07/08/2026). Todos confirmados
// no código antes de corrigir.
console.log('\nExposição de rede');
{
  checar('servidor não escuta 0.0.0.0 por padrão',
    /const BIND = process\.env\.NASCERA_BIND/.test(server) && !/listen\(PORT, '0\.0\.0\.0'/.test(server),
    'Em rede pública, alcançar a porta é meio caminho para controlar a máquina');

  for (const f of ['preview-server.js', 'publish-server.js']) {
    checar(f + ' respeita NASCERA_BIND', /NASCERA_BIND/.test(ler(f)));
  }

  checar('criação da conta admin exige código de instalação',
    /tokenConfere\(setupToken/.test(server),
    'Sem isso, quem chegasse na porta primeiro virava admin da máquina');

  checar('comparação do código é em tempo constante',
    /timingSafeEqual/.test(server),
    'Um === vaza, pelo tempo, quantos caracteres iniciais estavam certos');

  checar('slug de extração é VALIDADO, não apenas limpo',
    /function slugDeExtracao/.test(server),
    'Sanitizar ".." dava string vazia, e path.join apontava para a pasta-mãe');
}

console.log('\nAtualizações');
{
  checar('módulo de assinatura presente', !!ler('assinatura.js'));
  checar('atualizador verifica assinatura antes de aplicar',
    /verificarArquivo\(pacote/.test(ler('atualizacao.js')),
    'sha256 do mesmo servidor não protege contra servidor comprometido');
  checar('assinatura usa Ed25519', /ed25519/i.test(ler('assinatura.js')));
  avisar('chave pública de atualização configurada',
    !!process.env.NASCERA_UPDATE_PUBKEY,
    'Sem NASCERA_UPDATE_PUBKEY o cliente aceita pacote sem assinatura (compatibilidade)');
}

// ── 11. Credenciais de projeto remoto ────────────────────────────────
// Achado da varredura interna (08/08/2026): era RCE autenticado.
console.log('\nCredenciais remotas');
{
  // A senha nunca pode ir por ARGUMENTO: em string de shell dá injeção, e
  // mesmo escapada apareceria em `ps` para qualquer processo da máquina.
  checar('nenhum sshpass -p (senha por argumento)',
    !/sshpass -p/.test(server.replace(/^\s*\/\/.*$/gm, '')),
    'Use sshpass -f <arquivo 0600>, ou sshExec (ssh2, sem shell)');

  checar('senha SSH não é escrita no CLAUDE.md',
    !/sshCmd \+ '" "'/.test(server) && /ssh\.sh/.test(server),
    'CLAUDE.md é commitado no git E enviado ao modelo — credencial ali vaza triplo');

  checar('varredura remota usa sshExec (ssh2, sem shell)',
    /await sshExec\(\s*$|await sshExec\(/m.test(server));

  checar('senha SSH vai para o cofre cifrado',
    /segredos\.guardar\('ssh:/.test(server),
    'projects.json é 644 e vai em backup — senha de root de cliente não pode viver lá');

  checar('respostas de API filtram credenciais',
    /function semSegredos/.test(server) && /\.map\(semSegredos\)/.test(server));

  checar('cofre usa AES-GCM (cifra E autentica)',
    /aes-256-gcm/.test(ler('segredos.js')),
    'Sem autenticação, adulterar o arquivo devolveria lixo em vez de erro');

  const gi = ler('.gitignore');
  for (const s of ['.chave-cofre', '.cofre.json', '.setup-token']) {
    checar('.gitignore cobre ' + s, gi.split('\n').some(l => l.trim() === s));
  }
}


// ── 12. Achados da varredura adversarial (08/08/2026) ────────────────
// 18 vulnerabilidades confirmadas por caçadores + cético. Cada checagem
// abaixo trava a volta de uma delas.
console.log('\nVarredura adversarial');
{
  checar('allowlist de plugin não é anulável por packageName',
    !/packageName \|\| installMap/.test(server.replace(/^\s*\/\/.*$/gm, '')),
    'Era RCE: o corpo da requisição ignorava o allowlist e caía no execSync');

  checar('instalação de plugin não usa shell',
    !/runCmd\(installCmd|runCmd\(enableCmd|runCmd\(addCmd/.test(server));

  const rotasId = (server.match(/app\.(get|post|put|delete)\('\/api\/projects\/:id/g) || []).length;
  const portoes = (server.match(/projectOr404\(req, res\)/g) || []).length;
  checar('rotas de projeto com portão de dono (' + portoes + ' portões / ' + rotasId + ' rotas)',
    portoes >= rotasId * 0.8,
    'chat-history, status, agent e preview-url liam/alteravam projeto alheio');

  checar('histórico do WS enviado DEPOIS do portão',
    server.indexOf('podeAcessarProjeto(alvo, decoded.user)') <
    server.indexOf("type: 'chat-history'"),
    'Fechar a conexão depois de mandar o dado não desfaz a entrega');

  checar('preview exige ticket assinado',
    /function ticketDePreview/.test(server) && /conferirTicket/.test(server),
    'Sem isto, quem soubesse o slug lia o código-fonte de qualquer cliente');

  const app = ler('public/app.html');
  checar('iframe do preview tem sandbox sem allow-same-origin',
    /sandbox="allow-scripts/.test(app) && !/sandbox="[^"]*allow-same-origin/.test(app),
    'Sem sandbox, o site gerado lê parent.localStorage e rouba a sessão');

  checar('markdown da IA é sanitizado',
    /DOMPurify\.sanitize/.test(app),
    'Prompt-injection fazia a resposta da IA executar JS no painel');

  checar('portão de crédito re-checado na fila',
    /podeDespachar/.test(ler('engine/claude-engine.mjs')) &&
    /podeDespachar/.test(ler('engine/codex-engine.mjs')),
    'Rajada de mensagens furava os tetos de sessão/dia/semana/mês');

  checar('SSRF filtrado no teste de integração',
    /Endereço não permitido para integração/.test(server),
    'A URL do usuário virava sonda para a rede interna e metadata da nuvem');
}

// ── 13. Segredos versionados ─────────────────────────────────────────
console.log('\nSegredos');
{
  for (const arq of ['.credenciais.json', '.jwt-secret', '.env']) {
    avisar('nenhuma chave real em ' + arq + ' rastreada', true);
  }
  // Chave de API hardcoded em qualquer arquivo de código do produto.
  const codigos = fs.readdirSync(RAIZ).filter(n => n.endsWith('.js'));
  let comChave = [];
  for (const c of codigos) {
    const t = ler(c);
    if (/sk-[A-Za-z0-9_-]{30,}|sk-ant-api\w/.test(t)) comChave.push(c);
  }
  checar('nenhuma chave de API embutida no código',
    comChave.length === 0, comChave.join(', '));
}

// ── resultado ────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
if (falhas === 0) {
  console.log('  ✓ Nenhuma regressão de segurança' + (avisos ? ' (' + avisos + ' aviso[s])' : '') + '\n');
  process.exit(0);
}
console.log('  ✖ ' + falhas + ' verificação(ões) FALHARAM — release bloqueado\n');
process.exit(1);
