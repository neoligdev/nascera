// ═══════════════════════════════════════════════════════════════════════
// NASCERA — Motor de domínios personalizados
//
// "O domínio é do cliente; a prova é o DNS."
//
// Fluxo de um domínio:
//   PENDENTE (token gerado) → o dono aponta o DNS → VERIFICAR (consulta real)
//   → ATIVO (o roteador por Host passa a servir o site publicado)
//
// Duas provas aceitas na verificação (basta UMA):
//   1. Apontamento: A/AAAA no IP do servidor, ou CNAME no alvo configurado.
//      É a prova forte — sem isso o site nem chegaria aqui.
//   2. TXT `_nascera.<dominio>` = token. Serve para PRÉ-validar a posse antes
//      de virar o DNS de produção (migração sem downtime).
//
// Regras que o código garante:
//  - Um domínio pertence a UM projeto (índice global, sem colisão).
//  - Só serve quem está ATIVO — pendente/erro não expõe site nenhum.
//  - `www.<dominio>` é alias automático do apex, salvo se alguém registrou
//    o www explicitamente (aí o registro explícito manda).
//  - Domínio reservado (localhost, IP, o host do próprio painel) é recusado.
//  - Verificação tem TTL: consulta DNS é I/O e alvo fácil de abuso.
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const logger = require('./log.js');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const { gravaEstado } = require('./estado-seguro.js');
const estadoDb = require('./estado-db.js');

const CONFIG_FILE = path.join(__dirname, 'nascera-config.json');
const DOMAINS_FILE = path.join(__dirname, 'domains.json');

// Status possíveis — enum fechado (a UI pinta por ele)
const STATUS = ['pendente', 'ativo', 'erro'];

// Nunca aceitar: sequestraria o painel ou não faz sentido como domínio de site
const RESERVED = new Set([
  'localhost', 'localhost.localdomain', '127.0.0.1', '0.0.0.0',
  'nascera.local', 'admin', 'www',
]);

function defaultConfig() {
  return {
    // IP público do servidor — é o que o cliente aponta com registro A
    serverIp: '',
    // Alvo de CNAME (ex.: sites.nascera.com.br). Vazio = só A/AAAA
    cnameTarget: '',
    // Como o HTTPS é resolvido:
    //   'proxy'  → um proxy na frente (Caddy/nginx) termina TLS. Padrão.
    //   'direct' → algo já termina TLS antes (Cloudflare proxied, LB)
    sslMode: 'proxy',
    // Porta que o proxy usa como origem dos sites publicados
    publishPort: 4002,
    // Minutos de cache entre verificações do mesmo domínio
    verifyTtlMin: 1,
    // Domínio do PAINEL. Nunca pode virar site de cliente, senão o roteador
    // por Host engoliria o próprio NASCERA e ninguém mais entraria.
    panelDomain: '',
    // Porta do painel (o Caddy encaminha o panelDomain para cá)
    // 3333 é a porta única do painel (server.js e ecosystem.config.js).
    // Era 3334 e o Caddy passou a mandar o domínio para uma porta morta → 502.
    panelPort: 3333,
    // Escrever o Caddyfile e recarregar o Caddy sozinho quando um domínio
    // é verificado. O instalador da VPS liga isto; em dev fica desligado.
    autoCaddy: false,
    caddyfilePath: '/etc/caddy/Caddyfile',
    // Quem entrega o HTTPS. 'caddy' é o padrão (uma VPS limpa); 'nginx' é
    // para servidor que já tem nginx na frente — aí o certificado sai pelo
    // certbot e cada domínio ganha um vhost próprio.
    sslProvider: 'caddy',
    nginxSitesDir: '/etc/nginx/sites-available',
    nginxEnabledDir: '/etc/nginx/sites-enabled',
    acmeWebroot: '/var/www/letsencrypt',
    nginxProxyPort: 0,   // 0 = usa panelPort
    // E-mail das notificações do Let's Encrypt (expiração, problemas).
    // Fica NA CONFIG, não no arquivo: o Caddyfile é regravado a cada
    // verificação, então um bloco escrito à mão se perderia.
    leEmail: '',
  };
}

function getConfig() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  const cfg = { ...defaultConfig(), ...(raw.domains || {}) };
  if (!['proxy', 'direct', 'off'].includes(cfg.sslMode)) cfg.sslMode = 'proxy';
  if (!(cfg.publishPort > 0)) cfg.publishPort = 4002;
  if (!(cfg.verifyTtlMin >= 0)) cfg.verifyTtlMin = 1;
  return cfg;
}

// ── estado (domains.json), com cache ciente de mtime (mesma lição do billing) ──
let _state = null;
let _stateMtime = 0;
function loadState() {
  let mtime = 0;
  try { mtime = fs.statSync(DOMAINS_FILE).mtimeMs; } catch {}
  if (_state && mtime === _stateMtime) return _state;
  try { _state = JSON.parse(fs.readFileSync(DOMAINS_FILE, 'utf8')); } catch { _state = { domains: {} }; }
  if (!_state.domains) _state.domains = {};
  _stateMtime = mtime;
  return _state;
}
function saveState() {
  if (!_state) return;
  // Escrita ATÔMICA (tmp + rename). Antes era writeFileSync direto: um crash
  // no meio deixava domains.json truncado, e domínio corrompido derruba o
  // roteamento por Host de todos os sites publicados. Os outros arquivos de
  // estado já usavam isto; este tinha ficado para trás.
  gravaEstado(DOMAINS_FILE, _state);
  try { _stateMtime = fs.statSync(DOMAINS_FILE).mtimeMs; } catch {}
  // Espelha no Postgres. A tabela `dominios` era um retrato congelado do
  // import inicial — verificação de DNS, troca de status e domínio novo nunca
  // chegavam nela. Agora cada gravação atravessa, como já acontece com
  // projetos e usuários.
  try {
    if (estadoDb.ATIVO && estadoDb.dominios) estadoDb.dominios.sincronizar(_state.domains || {});
  } catch (e) {
    logger.error('[dominios] espelho no Postgres falhou: ' + e.message + ' (o JSON está íntegro)');
  }
}

// ── normalização e validação ──
// Aceita "https://Exemplo.com.br/caminho" e devolve "exemplo.com.br".
function normalizeDomain(input) {
  let d = String(input || '').trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '');   // tira esquema
  d = d.split('/')[0];                 // tira caminho
  d = d.split('?')[0].split('#')[0];
  d = d.replace(/\.$/, '');            // ponto final do FQDN
  d = d.split(':')[0];                 // tira porta
  return d;
}

function validateDomain(d) {
  if (!d) throw new Error('Informe um domínio');
  if (d.length > 253) throw new Error('Domínio longo demais');
  if (RESERVED.has(d)) throw new Error(`"${d}" é reservado pelo sistema`);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(d)) throw new Error('Use um domínio, não um IP');
  if (d.includes('*')) throw new Error('Curinga (*) não é suportado — cadastre cada domínio');
  // rótulos: letras/números/hífen, sem começar/terminar com hífen
  const labels = d.split('.');
  if (labels.length < 2) throw new Error('Domínio incompleto (ex.: seusite.com.br)');
  for (const l of labels) {
    if (!l || l.length > 63) throw new Error('Parte do domínio inválida: "' + l + '"');
    if (!/^[a-z0-9-]+$/.test(l) || l.startsWith('-') || l.endsWith('-')) {
      throw new Error('Parte do domínio inválida: "' + l + '"');
    }
  }
  return d;
}

function apexOf(d) {
  return d.startsWith('www.') ? d.slice(4) : d;
}

// ── CRUD ──
function listAll() {
  const st = loadState();
  return Object.values(st.domains);
}

function listForProject(projectId) {
  return listAll().filter(d => d.projectId === projectId);
}

function getDomain(domain) {
  const d = normalizeDomain(domain);
  return loadState().domains[d] || null;
}

function addDomain(domain, { projectId, slug, user }) {
  const d = validateDomain(normalizeDomain(domain));
  // trava anti-sequestro: o domínio do painel não pode virar site
  const panel = normalizeDomain(getConfig().panelDomain);
  if (panel && (d === panel || d === 'www.' + panel || 'www.' + d === panel)) {
    throw new Error('Este é o domínio do painel — não pode ser usado como site');
  }
  const st = loadState();
  const existing = st.domains[d];
  if (existing) {
    if (existing.projectId === projectId) throw new Error('Este domínio já está neste projeto');
    throw new Error('Este domínio já está em uso em outro projeto');
  }
  st.domains[d] = {
    domain: d,
    projectId, slug,
    user: user || null,
    status: 'pendente',
    token: 'nascera-verify-' + crypto.randomBytes(16).toString('hex'),
    createdAt: new Date().toISOString(),
    verifiedAt: null,
    lastCheckAt: null,
    lastCheck: null,       // detalhe da última consulta DNS
    error: null,
    primary: !listForProject(projectId).some(x => x.primary),  // 1º vira principal
  };
  saveState();
  return st.domains[d];
}

function removeDomain(domain) {
  const d = normalizeDomain(domain);
  const st = loadState();
  if (!st.domains[d]) throw new Error('Domínio não encontrado');
  const wasPrimary = st.domains[d].primary;
  const projectId = st.domains[d].projectId;
  delete st.domains[d];
  // o projeto não pode ficar sem principal
  if (wasPrimary) {
    const rest = Object.values(st.domains).filter(x => x.projectId === projectId);
    const next = rest.find(x => x.status === 'ativo') || rest[0];
    if (next) next.primary = true;
  }
  saveState();
  return true;
}

function setPrimary(domain) {
  const d = normalizeDomain(domain);
  const st = loadState();
  const rec = st.domains[d];
  if (!rec) throw new Error('Domínio não encontrado');
  for (const x of Object.values(st.domains)) {
    if (x.projectId === rec.projectId) x.primary = (x.domain === d);
  }
  saveState();
  return rec;
}

// ── verificação: consulta DNS de verdade ──
//
// Não dá para perguntar ao resolvedor do sistema. O recursivo do provedor
// (Hetzner, AWS, seja quem for) guarda a resposta ANTIGA pelo TTL inteiro —
// já vimos 4 horas mostrando o IP velho enquanto o dono do domínio jurava
// que tinha trocado, e estava certo. "Verificar agora" tem que significar
// agora, então perguntamos ao nameserver autoritativo do próprio domínio.
const RESOLVEDORES_PUBLICOS = ['1.1.1.1', '8.8.8.8', '9.9.9.9'];

function novoResolver(servidores) {
  const r = new dns.Resolver({ timeout: 4000, tries: 1 });
  r.setServers(servidores);
  return r;
}

// Descobre os IPs dos nameservers que mandam neste domínio.
let _cacheNs = new Map();   // apex → { ips, em }
async function ipsAutoritativos(apex) {
  const guardado = _cacheNs.get(apex);
  if (guardado && Date.now() - guardado.em < 5 * 60000) return guardado.ips;

  const publico = novoResolver(RESOLVEDORES_PUBLICOS);
  let nomes = [];
  // Sobe na hierarquia: teste.x8labs.com.br pode não ter NS próprio, mas
  // x8labs.com.br tem.
  const partes = apex.split('.');
  for (let i = 0; i < partes.length - 1; i++) {
    const zona = partes.slice(i).join('.');
    try {
      nomes = await publico.resolveNs(zona);
      if (nomes.length) break;
    } catch {}
  }
  if (!nomes.length) return [];

  const ips = [];
  for (const nome of nomes.slice(0, 4)) {
    try { ips.push(...await publico.resolve4(nome)); } catch {}
  }
  _cacheNs.set(apex, { ips, em: Date.now() });
  return ips;
}

// Pergunta primeiro a quem manda no domínio; se não der, cai para os
// resolvedores públicos; só então usa o do sistema.
async function consultar(metodo, nome, apex) {
  const tentativas = [];
  const autoritativos = await ipsAutoritativos(apex).catch(() => []);
  if (autoritativos.length) tentativas.push(novoResolver(autoritativos));
  tentativas.push(novoResolver(RESOLVEDORES_PUBLICOS));

  for (const r of tentativas) {
    try {
      const res = await r[metodo](nome);
      if (res && res.length) return res;
    } catch (e) {
      // NXDOMAIN/NODATA é resposta legítima: o registro não existe mesmo.
      if (e && (e.code === 'ENOTFOUND' || e.code === 'ENODATA')) return [];
    }
  }
  try { return await dns[metodo](nome); } catch { return []; }   // dns aqui já é a API de promises
}

async function resolveSafe(fn, name) {
  try { return await fn(name); } catch { return []; }
}

async function verifyDomain(domain, opts) {
  const cfg = getConfig();
  const d = normalizeDomain(domain);
  const st = loadState();
  const rec = st.domains[d];
  if (!rec) throw new Error('Domínio não encontrado');

  // TTL: não martelar o DNS a cada clique (a menos que force)
  const ttlMs = (cfg.verifyTtlMin || 0) * 60000;
  if (!opts || !opts.force) {
    if (rec.lastCheckAt && Date.now() - Date.parse(rec.lastCheckAt) < ttlMs) {
      return { ...rec, cached: true };
    }
  }

  const apex = apexOf(d);
  const [a, aaaa, cname, txt] = await Promise.all([
    consultar('resolve4', d, apex),
    consultar('resolve6', d, apex),
    consultar('resolveCname', d, apex),
    consultar('resolveTxt', '_nascera.' + apex, apex),
  ]);

  const txtFlat = txt.map(chunks => (Array.isArray(chunks) ? chunks.join('') : String(chunks)));
  const target = (cfg.cnameTarget || '').toLowerCase().replace(/\.$/, '');

  const pointsA = !!cfg.serverIp && a.includes(cfg.serverIp);
  const pointsCname = !!target && cname.some(c => String(c).toLowerCase().replace(/\.$/, '') === target);
  const hasTxt = txtFlat.includes(rec.token);

  // CNAME para o alvo pode ser indireto (Cloudflare achata): se o A do domínio
  // bate com o A do alvo, também vale como apontamento.
  let pointsIndirect = false;
  if (!pointsA && !pointsCname && target && a.length) {
    const targetA = await resolveSafe(dns.resolve4, target);
    pointsIndirect = targetA.length > 0 && a.some(ip => targetA.includes(ip));
  }

  const pointing = pointsA || pointsCname || pointsIndirect;
  rec.lastCheckAt = new Date().toISOString();
  rec.lastCheck = {
    a, aaaa, cname, txt: txtFlat,
    pointsA, pointsCname, pointsIndirect, hasTxt,
    expectedIp: cfg.serverIp || null,
    expectedCname: cfg.cnameTarget || null,
  };

  if (pointing || hasTxt) {
    rec.status = 'ativo';
    rec.error = null;
    if (!rec.verifiedAt) rec.verifiedAt = rec.lastCheckAt;
    // apontou de fato? então já dá para servir. Só TXT = posse provada,
    // mas o tráfego ainda não chega — a UI avisa.
    rec.pointing = pointing;
  } else {
    rec.status = 'pendente';
    rec.pointing = false;
    rec.error = (a.length || cname.length)
      ? 'O DNS responde, mas não aponta para este servidor ainda (propagação leva alguns minutos)'
      : 'Nenhum registro DNS encontrado para este domínio';
  }
  saveState();
  return { ...rec, cached: false };
}

// ── roteamento por Host (o coração: transforma Host em site) ──
// Devolve o registro ATIVO que atende aquele Host, ou null.
function findByHost(hostHeader) {
  const host = normalizeDomain(String(hostHeader || '').split(',')[0]);
  if (!host) return null;
  const st = loadState();
  const direct = st.domains[host];
  if (direct && direct.status === 'ativo') return direct;
  // www.exemplo.com cai no registro do apex (alias automático)
  if (host.startsWith('www.')) {
    const apex = st.domains[host.slice(4)];
    if (apex && apex.status === 'ativo') return apex;
  }
  return null;
}

// ── instruções de DNS que a UI mostra ao cliente ──
function dnsInstructions(rec) {
  const cfg = getConfig();
  const d = rec.domain;
  const isApex = !d.startsWith('www.') && d.split('.').length <= 3;

  // O painel do registrador pede o nome RELATIVO à zona. Para loja.site.com.br
  // o nome é "loja", não "@" — quem copia "@" cria o registro no domínio raiz
  // e fica horas achando que o DNS está errado.
  const rotulo = subdominioDe(d);

  const rows = [];
  if (cfg.serverIp) {
    rows.push({ type: 'A', name: rotulo || '@', value: cfg.serverIp, ttl: '3600' });
  }
  if (cfg.cnameTarget) {
    rows.push({ type: 'CNAME', name: rotulo ? `www.${rotulo}` : 'www', value: cfg.cnameTarget, ttl: '3600' });
  }
  // O TXT é conferido em _nascera.<apex>, e apexOf tira o "www." — a instrução
  // precisa apontar para o MESMO lugar, senão o cliente cria um registro que
  // nunca vai ser lido.
  const rotuloTxt = subdominioDe(apexOf(d));
  rows.push({
    type: 'TXT',
    name: rotuloTxt ? `_nascera.${rotuloTxt}` : '_nascera',
    value: rec.token, ttl: '3600', optional: true,
  });
  return { rows, isApex, zona: zonaDe(d), sslMode: cfg.sslMode };
}

// "loja.site.com.br" → "loja"   |   "site.com.br" → ""   |   "www.site.com.br" → "www"
function subdominioDe(d) {
  const partes = String(d).split('.');
  // .com.br, .co.uk e afins têm o registrável com 3 rótulos; os demais, 2.
  const composto = /\.(com|net|org|gov|edu|ind|adv|art|eco|emp|esp|etc|far|flog|imb|inf|jus|leg|mil|mus|nom|not|ntr|odo|ppg|psi|qsl|rec|slg|srv|teo|tmp|trd|tur|tv|vet|zlg|co|ac|sch)\.[a-z]{2}$/i.test(d);
  const raiz = composto ? 3 : 2;
  return partes.length > raiz ? partes.slice(0, partes.length - raiz).join('.') : '';
}

function zonaDe(d) {
  const sub = subdominioDe(d);
  return sub ? String(d).slice(sub.length + 1) : d;
}

// ── Caddyfile: o que realmente entrega HTTPS automático ──
// Cobre o PAINEL (se houver domínio) e todos os sites ATIVOS. O proxy
// encaminha preservando o Host — é dele que o roteador depende.
function caddyfile() {
  const cfg = getConfig();
  const ativos = listAll().filter(d => d.status === 'ativo');
  const linhas = [
    '# Caddyfile gerado pelo NASCERA — HTTPS automático (Let\'s Encrypt)',
    '# NÃO edite à mão: é regravado a cada domínio verificado.',
    '# Recarregar:  sudo systemctl reload caddy',
    '',
  ];

  if (cfg.leEmail) {
    linhas.push('{', '\temail ' + cfg.leEmail, '}', '');
  }

  if (cfg.panelDomain) {
    linhas.push(
      '# Painel do NASCERA',
      cfg.panelDomain + ' {',
      '\tencode gzip',
      '\treverse_proxy 127.0.0.1:' + (cfg.panelPort || 3333),
      '}',
      ''
    );
  }

  const hosts = [];
  for (const d of ativos) {
    hosts.push(d.domain);
    if (!d.domain.startsWith('www.') && !ativos.some(x => x.domain === 'www.' + d.domain)) {
      hosts.push('www.' + d.domain);
    }
  }
  if (hosts.length) {
    linhas.push(
      '# Sites publicados (domínios verificados)',
      hosts.join(', ') + ' {',
      '\tencode gzip',
      '\treverse_proxy 127.0.0.1:' + cfg.publishPort + ' {',
      '\t\theader_up Host {host}',
      '\t\theader_up X-Forwarded-Proto {scheme}',
      '\t}',
      '}',
      ''
    );
  } else if (!cfg.panelDomain) {
    linhas.push('# Nenhum domínio ativo ainda — verifique um domínio no painel.', '');
  }
  return linhas.join('\n');
}

// ── Aplicar o Caddyfile sozinho (o que torna o HTTPS realmente automático) ──
// Escreve o arquivo e recarrega o Caddy. Só age se autoCaddy estiver ligado e
// o processo tiver permissão — em VPS rodando como root, é o caso.
// Devolve {aplicado, motivo} em vez de lançar: a verificação do domínio não
// pode falhar porque o proxy não pôde ser recarregado.
function applyCaddy() {
  const cfg = getConfig();
  if (!cfg.autoCaddy) return { aplicado: false, motivo: 'autoCaddy desligado' };
  if (cfg.sslMode !== 'proxy') return { aplicado: false, motivo: 'modo de SSL não é proxy' };
  const destino = cfg.caddyfilePath || '/etc/caddy/Caddyfile';
  const conteudo = caddyfile();
  try {
    // não reescreve nem recarrega se nada mudou (evita reload à toa)
    let atual = null;
    try { atual = fs.readFileSync(destino, 'utf8'); } catch {}
    if (atual === conteudo) return { aplicado: false, motivo: 'sem mudanças' };
    fs.writeFileSync(destino, conteudo);
  } catch (err) {
    return { aplicado: false, motivo: 'não consegui escrever em ' + destino + ': ' + err.message };
  }
  try {
    const { execFileSync } = require('child_process');
    execFileSync('systemctl', ['reload', 'caddy'], { timeout: 15000, stdio: 'ignore' });
    return { aplicado: true, motivo: 'Caddyfile atualizado e recarregado' };
  } catch (err) {
    return { aplicado: false, motivo: 'Caddyfile escrito, mas o reload falhou: ' + err.message };
  }
}

// ── HTTPS automático em servidor nginx ────────────────────────────────
// Nem toda VPS pode rodar Caddy: quando já existe nginx na frente (com
// outros sites, painéis, gateways), instalar o Caddy é briga por porta 80/443.
// Aqui fazemos o mesmo trabalho com as ferramentas que o servidor já tem:
// certbot emite o certificado e o nginx ganha um vhost por domínio.
//
// Nunca lança: o domínio ficar sem HTTPS é ruim, mas a verificação não pode
// quebrar por causa disso.
function provisionarNginx(dominio) {
  const cfg = getConfig();
  if (cfg.sslProvider !== 'nginx') return { aplicado: false, motivo: 'sslProvider não é nginx' };

  const d = normalizeDomain(dominio);
  if (!/^[a-z0-9.-]+$/.test(d)) return { aplicado: false, motivo: 'domínio inválido' };

  const rec = loadState().domains[d];
  if (!rec || rec.status !== 'ativo') {
    return { aplicado: false, motivo: 'domínio ainda não está ativo' };
  }

  const { execFileSync } = require('child_process');
  const sitesDir = cfg.nginxSitesDir || '/etc/nginx/sites-available';
  const enabledDir = cfg.nginxEnabledDir || '/etc/nginx/sites-enabled';
  const webroot = cfg.acmeWebroot || '/var/www/letsencrypt';
  const porta = cfg.nginxProxyPort || cfg.panelPort || 3333;
  const arquivo = path.join(sitesDir, 'nascera-dom-' + d);
  const link = path.join(enabledDir, 'nascera-dom-' + d);
  const vivo = '/etc/letsencrypt/live/' + d;

  // 1. Certificado. O desafio HTTP-01 cai no webroot que o vhost padrão da
  //    porta 80 já serve — por isso funciona antes de existir vhost do domínio.
  if (!fs.existsSync(path.join(vivo, 'fullchain.pem'))) {
    const args = ['certonly', '--webroot', '-w', webroot, '-d', d,
      '--non-interactive', '--agree-tos', '--keep-until-expiring'];
    if (cfg.leEmail) args.push('-m', cfg.leEmail); else args.push('--register-unsafely-without-email');
    try {
      execFileSync('certbot', args, { timeout: 180000, stdio: 'pipe' });
    } catch (err) {
      const saida = (err.stderr || err.stdout || '').toString().split('\n').filter(Boolean).slice(-3).join(' ');
      return { aplicado: false, motivo: 'certbot falhou: ' + (saida || err.message) };
    }
  }

  // 2. vhost. Escreve num arquivo próprio, com prefixo — nunca encosta na
  //    configuração que o dono do servidor escreveu à mão.
  const conteudo = vhostNginx(d, porta, webroot);
  let anterior = null;
  try { anterior = fs.readFileSync(arquivo, 'utf8'); } catch {}
  if (anterior === conteudo && fs.existsSync(link)) {
    return { aplicado: false, motivo: 'já configurado' };
  }
  try {
    fs.writeFileSync(arquivo, conteudo);
    if (!fs.existsSync(link)) fs.symlinkSync(arquivo, link);
  } catch (err) {
    return { aplicado: false, motivo: 'não consegui escrever o vhost: ' + err.message };
  }

  // 3. Testar ANTES de recarregar. Config inválida derruba todos os sites
  //    do servidor, não só este — então em caso de erro, desfaz.
  try {
    execFileSync('nginx', ['-t'], { timeout: 20000, stdio: 'pipe' });
  } catch (err) {
    try { fs.rmSync(link, { force: true }); } catch {}
    try { anterior === null ? fs.rmSync(arquivo, { force: true }) : fs.writeFileSync(arquivo, anterior); } catch {}
    return { aplicado: false, motivo: 'nginx recusou a configuração (desfeito): ' + (err.stderr || '').toString().slice(-200) };
  }

  try {
    execFileSync('systemctl', ['reload', 'nginx'], { timeout: 20000, stdio: 'ignore' });
  } catch (err) {
    return { aplicado: false, motivo: 'vhost criado, mas o reload do nginx falhou: ' + err.message };
  }
  return { aplicado: true, motivo: 'HTTPS ativo em https://' + d };
}

function vhostNginx(d, porta, webroot) {
  return `# Gerado pelo NASCERA para ${d} — não edite à mão (é reescrito).
server {
    listen 80;
    server_name ${d};
    location /.well-known/acme-challenge/ { root ${webroot}; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl;
    server_name ${d};

    ssl_certificate     /etc/letsencrypt/live/${d}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${d}/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    # O 301 só age em navegação nova. Quem já tem a versão HTTP no cache do
    # navegador continua vendo "Não seguro" para sempre. Isto manda o browser
    # nunca mais tentar HTTP neste domínio.
    # 180 dias (não 1 ano): se o cliente levar o domínio embora para uma
    # hospedagem sem HTTPS, o site dele não fica inacessível por um ano.
    add_header Strict-Transport-Security "max-age=15552000" always;

    location / {
        proxy_pass http://127.0.0.1:${porta};
        # O NASCERA decide qual site servir pelo Host — se este cabeçalho se
        # perder, o visitante cai no painel em vez do site do cliente.
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;
}

// Tira o domínio do nginx quando ele é removido do painel.
function removerNginx(dominio) {
  const cfg = getConfig();
  if (cfg.sslProvider !== 'nginx') return { aplicado: false };
  const d = normalizeDomain(dominio);
  if (!/^[a-z0-9.-]+$/.test(d)) return { aplicado: false };
  const arquivo = path.join(cfg.nginxSitesDir || '/etc/nginx/sites-available', 'nascera-dom-' + d);
  const link = path.join(cfg.nginxEnabledDir || '/etc/nginx/sites-enabled', 'nascera-dom-' + d);
  try {
    fs.rmSync(link, { force: true });
    fs.rmSync(arquivo, { force: true });
    require('child_process').execFileSync('systemctl', ['reload', 'nginx'], { timeout: 20000, stdio: 'ignore' });
    return { aplicado: true };
  } catch (err) { return { aplicado: false, motivo: err.message }; }
}

// Ponto único: o servidor chama isto e não precisa saber se a VPS usa Caddy
// ou nginx.
function aplicarSsl(dominio) {
  const cfg = getConfig();
  if (cfg.sslProvider === 'nginx') return provisionarNginx(dominio);
  return applyCaddy();
}

// Espelho de aplicarSsl para a remoção.
function removerSsl(dominio) {
  const cfg = getConfig();
  if (cfg.sslProvider === 'nginx') return removerNginx(dominio);
  return applyCaddy();   // no Caddy o arquivo é global: reescrever já tira o domínio
}

function adminOverview() {
  return {
    config: getConfig(),
    domains: listAll().sort((a, b) => (a.domain > b.domain ? 1 : -1)),
  };
}

// ── revalidação em segundo plano ──
// DNS muda: um domínio que apontava pode deixar de apontar (troca de servidor,
// cliente que saiu, registro removido). Sem isso o painel mostraria "ativo"
// para sempre — status mentiroso é pior que status ausente.
async function revalidateAll(opts) {
  const max = (opts && opts.max) || 40;
  const alvos = listAll().slice(0, max);
  const out = { checados: 0, mudaram: [] };
  for (const d of alvos) {
    const antes = d.status + '/' + (d.pointing ? 'ok' : 'no');
    try {
      const r = await verifyDomain(d.domain, { force: true });
      out.checados++;
      const depois = r.status + '/' + (r.pointing ? 'ok' : 'no');
      if (antes !== depois) out.mudaram.push({ domain: d.domain, de: antes, para: depois });
    } catch {}
  }
  return out;
}

module.exports = {
  STATUS,
  getConfig, normalizeDomain, validateDomain,
  listAll, listForProject, getDomain,
  addDomain, removeDomain, setPrimary, verifyDomain, revalidateAll,
  findByHost, dnsInstructions, caddyfile, applyCaddy, adminOverview,
  provisionarNginx, removerNginx, aplicarSsl, removerSsl,
  _reloadState: () => { _state = null; },
};
