/* ═══ NASCERA ADMIN v2 — DOMÍNIOS ═══════════════════════════════════════
   Onde o site do cliente ganha endereço próprio: para onde o DNS dele deve
   apontar, quem entrega o HTTPS e quais domínios já chegaram de verdade.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
var Z = window.ZAdmin, C = Z.C;

var cfg = {}, todos = [], filtro = 'todos', termo = '', sslSel = 'proxy';

var MODOS = [
  { id: 'proxy',  tit: 'Proxy do Caddy',     icone: 'bloqueio',
    txt: 'O NASCERA escreve o Caddyfile e o Caddy emite o certificado sozinho. É o caminho de uma VPS limpa.' },
  { id: 'direct', tit: 'TLS já resolvido',   icone: 'link',
    txt: 'Alguém na frente já termina o HTTPS (Cloudflare em modo proxy, load balancer). O NASCERA só serve o site.' },
  { id: 'off',    tit: 'Sem HTTPS',          icone: 'alerta',
    txt: 'Serve em HTTP puro. Só para teste em rede local — navegador nenhum trata isso como site sério.' },
];

Z.registrar('dominios', {
  render: function (alvo) {
    return Z.api('/api/admin/domains').then(function (d) {
      var cab = C.cab({
        trilha: 'Produto · Endereços dos sites',
        icone: 'dominios',
        titulo: 'Domínios',
        sub: 'Cada cliente pode plugar o domínio dele no site que construiu aqui. Você configura uma vez para onde ' +
             'o DNS deve apontar — o resto é verificação.',
        acoes: [
          C.btn('Baixar Caddyfile', { icone: 'baixar', acao: 'baixar-caddy' }),
          C.btn('Atualizar', { icone: 'atualiza', acao: 'recarregar' }),
        ],
      });

      if (d && d.error) {
        Z.erro(d.error);
        alvo.innerHTML = '<div id="dom-raiz">' + cab + C.vazio({
          tom: 'erro', icone: 'alerta', tit: 'Não consegui ler os domínios',
          txt: Z.esc(d.error),
          acao: C.btn('Tentar de novo', { classe: 'primario', acao: 'recarregar' }),
        }) + '</div>';
        Z.ligarAcoes('dom-raiz', { 'recarregar': function () { Z.recarregar(); } });
        return;
      }
      cfg = d.config || {};
      todos = d.domains || [];
      filtro = 'todos'; termo = '';
      sslSel = ['proxy', 'direct', 'off'].indexOf(cfg.sslMode) >= 0 ? cfg.sslMode : 'proxy';

      var ativos = contar('ativo'), pendentes = contar('pendente'), comErro = contar('erro');

      var html = cab;

      html += C.stats([
        { rot: 'Domínios cadastrados', num: Z.num(todos.length), cap: 'Somando todos os projetos', icone: 'dominios' },
        { rot: 'No ar', num: Z.num(ativos), cap: ativos ? 'DNS apontando e servindo' : 'Nenhum ativo ainda', icone: 'check', tom: ativos ? 'ok' : '' },
        { rot: 'Aguardando DNS', num: Z.num(pendentes), cap: pendentes ? 'O cliente ainda não apontou' : 'Ninguém na fila', icone: 'relogio', tom: pendentes ? 'alerta' : '' },
        { rot: 'Com erro', num: Z.num(comErro), cap: comErro ? 'Precisam de olhada' : 'Nenhum problema', icone: 'alerta', tom: comErro ? 'erro' : '' },
      ]);

      // ── Configuração ──
      html += '<span class="z-rotulo" style="margin-top:8px">Para onde o cliente aponta</span>';
      html += C.card({
        tit: 'Endereços do servidor',
        sub: 'É o que o NASCERA mostra ao cliente na hora de configurar o DNS dele — e o que a verificação confere depois.',
        corpo:
          '<div class="z-campos">' +
            '<div class="z-campo"><label>IP do servidor</label>' +
              '<div class="z-linha" style="gap:8px;flex-wrap:nowrap">' +
                '<input class="z-in" id="dom-serverIp" type="text" value="' + att(cfg.serverIp || '') + '" placeholder="203.0.113.10">' +
                C.btn('Detectar', { acao: 'detectar-ip', icone: 'busca', titulo: 'Pergunta o IP público para fora' }) +
              '</div>' +
              '<div class="z-dica">O cliente cria um registro <b>A</b> apontando para cá.</div>' +
            '</div>' +
            C.campo({ id: 'dom-cname', rotulo: 'Alvo de CNAME', valor: cfg.cnameTarget || '', dica: 'sites.seudominio.com.br',
              ajuda: 'Opcional. Serve para o <b>www</b> e para quem prefere CNAME em vez de IP fixo.' }) +
            C.campo({ id: 'dom-panel', rotulo: 'Domínio do painel', valor: cfg.panelDomain || '', dica: 'painel.seudominio.com.br',
              ajuda: 'Trava de segurança: este domínio nunca pode virar site de cliente.' }) +
            C.campo({ id: 'dom-porta', rotulo: 'Porta de origem dos sites', tipo: 'number', valor: cfg.publishPort || 4002,
              ajuda: 'A porta interna que serve os sites publicados. O proxy encaminha para ela.' }) +
            C.campo({ id: 'dom-ttl', rotulo: 'Intervalo entre verificações (min)', tipo: 'number', valor: cfg.verifyTtlMin != null ? cfg.verifyTtlMin : 1,
              ajuda: 'Evita martelar o DNS quando o cliente fica apertando "verificar".' }) +
            C.campo({ id: 'dom-email', rotulo: 'E-mail do Let’s Encrypt', valor: cfg.leEmail || '', dica: 'voce@suaempresa.com.br',
              ajuda: 'Recebe avisos de certificado prestes a vencer.' }) +
          '</div>',
      });

      html += '<span class="z-rotulo" style="margin-top:22px">Como o HTTPS é entregue</span>';
      html += '<div id="dom-ssl">' + htmlSsl(sslSel) + '</div>';

      html += '<div style="margin-top:14px">' + C.card({
        tit: 'Automação do proxy',
        sub: 'Com isto ligado, o NASCERA reescreve o Caddyfile e recarrega o Caddy sozinho toda vez que um domínio é verificado.',
        corpo:
          '<div style="padding:2px 0 12px">' + C.switch('dom-caddy', 'Escrever e recarregar o Caddy automaticamente', !!cfg.autoCaddy) + '</div>' +
          '<div class="z-col" style="gap:6px">' +
            linha('Arquivo do Caddy', '<span class="z-mono">' + Z.esc(cfg.caddyfilePath || '—') + '</span>') +
            linha('Quem entrega o certificado', Z.esc(cfg.sslProvider === 'nginx' ? 'nginx + certbot' : 'Caddy')) +
            linha('Porta do painel', Z.esc(String(cfg.panelPort || '—'))) +
          '</div>' +
          '<div class="z-dica" style="margin-top:10px">' +
            'Desligado, nada é escrito no servidor: use <b>Ver Caddyfile</b> e cole o conteúdo você mesmo.' +
          '</div>' +
          '<div class="z-linha" style="margin-top:13px">' +
            C.btn('Ver Caddyfile', { icone: 'codigo', acao: 'ver-caddy' }) +
            C.btn('Baixar Caddyfile', { icone: 'baixar', acao: 'baixar-caddy' }) +
          '</div>',
      }) + '</div>';

      html += '<div class="z-linha" style="margin-top:16px">' +
        C.btn('Salvar configuração', { classe: 'primario', icone: 'check', acao: 'salvar-config' }) +
        '<span class="z-dica" style="margin:0">Vale para os próximos domínios e reescreve o proxy se a automação estiver ligada.</span>' +
      '</div>';

      // ── Lista ──
      html += '<span class="z-rotulo" style="margin-top:26px">Domínios dos clientes</span>';
      html += C.filtros('dom-filtros', [
        { id: 'todos', t: 'Todos', n: todos.length },
        { id: 'ativo', t: 'No ar', n: ativos },
        { id: 'pendente', t: 'Aguardando DNS', n: pendentes },
        { id: 'erro', t: 'Com erro', n: comErro },
      ], 'todos');
      html += C.busca('dom-busca', 'Buscar por domínio, projeto ou dono…');
      html += '<div id="dom-tabela">' + htmlTabela() + '</div>';

      // Container próprio: o roteador reaproveita #z-conteudo, então prender
      // os cliques aqui evita empilhar ouvintes a cada visita à seção.
      alvo.innerHTML = '<div id="dom-raiz">' + html + '</div>';

      Z.ligarFiltros('dom-filtros', function (f) { filtro = f; repintarTabela(); });
      var busca = document.getElementById('dom-busca');
      if (busca) busca.oninput = function () { termo = busca.value.toLowerCase().trim(); repintarTabela(); };

      Z.ligarAcoes('dom-raiz', {
        'recarregar':    function () { Z.recarregar(); },
        'detectar-ip':   detectarIp,
        'ssl-modo':      function (id) { sslSel = id; document.getElementById('dom-ssl').innerHTML = htmlSsl(sslSel); },
        'salvar-config': salvarConfig,
        'ver-caddy':     verCaddyfile,
        'baixar-caddy':  baixarCaddyfile,
        'verificar':     verificar,
        'remover':       remover,
        'detalhe':       detalhe,
      });
    });
  },
});

// ─── modo de SSL em três cartões ──────────────────────────────────────
function htmlSsl(sel) {
  return '<div class="z-grade">' + MODOS.map(function (m) {
    var ativo = m.id === sel;
    return '<div class="z-item" data-acao="ssl-modo" data-dado="' + m.id + '"' +
      (ativo ? ' style="border-color:rgba(var(--z-acc-rgb),.45);background:var(--z-card-hi)"' : '') + '>' +
      '<div class="z-item-cab">' +
        '<div class="z-item-icone">' + Z.svg(m.icone) + '</div>' +
        '<div class="z-item-tit">' + Z.esc(m.tit) + '</div>' +
      '</div>' +
      '<div class="z-item-chips">' + (ativo ? C.chipPonto('Selecionado', 'acento') : C.chip('Clique para usar', '')) + '</div>' +
      '<div class="z-item-desc">' + Z.esc(m.txt) + '</div>' +
    '</div>';
  }).join('') + '</div>';
}

// ─── tabela ───────────────────────────────────────────────────────────
function contar(st) { return todos.filter(function (d) { return d.status === st; }).length; }

function visiveis() {
  return todos.filter(function (d) {
    if (filtro !== 'todos' && d.status !== filtro) return false;
    if (!termo) return true;
    var alvo = (d.domain || '') + ' ' + (d.slug || '') + ' ' + (d.user || '');
    return alvo.toLowerCase().indexOf(termo) >= 0;
  });
}

function htmlTabela() {
  var lista = visiveis();
  var linhas = lista.map(function (d) {
    var sub = '';
    if (d.status === 'ativo' && d.pointing === false) {
      sub = '<div class="z-cel-sub">posse provada, mas o tráfego ainda não chega aqui</div>';
    } else if (d.error) {
      sub = '<div class="z-cel-sub">' + Z.esc(d.error) + '</div>';
    }
    return '<tr>' +
      '<td class="forte"><span class="z-mono" style="font-size:12.5px">' + Z.esc(d.domain) + '</span>' +
        (d.primary ? ' ' + C.chip('principal', 'acento') : '') + '</td>' +
      '<td>' + Z.esc(d.slug || d.projectId || '—') + '</td>' +
      '<td>' + chipStatus(d.status) + sub + '</td>' +
      '<td>' + Z.esc(d.user || '—') + '</td>' +
      '<td class="dir z-fg3">' + (d.lastCheckAt ? Z.desde(d.lastCheckAt) : 'nunca') + '</td>' +
      '<td class="dir"><div class="z-linha" style="justify-content:flex-end;gap:6px;flex-wrap:nowrap">' +
        C.btn('Detalhes', { classe: 'mini fantasma', icone: 'olho', acao: 'detalhe', dado: d.domain }) +
        C.btn('Verificar', { classe: 'mini', icone: 'atualiza', acao: 'verificar', dado: d.domain }) +
        C.btn('Remover', { classe: 'mini perigo', icone: 'lixeira', acao: 'remover', dado: d.domain }) +
      '</div></td>' +
    '</tr>';
  });

  var vazioTxt = todos.length
    ? 'Nenhum domínio bate com este filtro. Tente “Todos” ou limpe a busca.'
    : 'Quando um cliente plugar o domínio dele num projeto, ele aparece aqui — e você acompanha a verificação do DNS.';

  return C.card({
    corpo: C.tabela(
      [{ t: 'Domínio' }, { t: 'Projeto' }, { t: 'Status' }, { t: 'Dono' }, { t: 'Última checagem', dir: true }, { t: 'Ações', dir: true }],
      linhas,
      { icone: 'dominios', vazioTit: todos.length ? 'Nada com este filtro' : 'Nenhum domínio ainda', vazioTxt: vazioTxt }),
  });
}
function repintarTabela() {
  var el = document.getElementById('dom-tabela');
  if (el) el.innerHTML = htmlTabela();
}
function chipStatus(st) {
  if (st === 'ativo') return C.chipPonto('No ar', 'ok');
  if (st === 'erro') return C.chipPonto('Erro', 'erro');
  return C.chipPonto('Aguardando DNS', 'alerta');
}

// ─── ações ────────────────────────────────────────────────────────────
function detectarIp(_dado, el) {
  var antes = el.innerHTML;
  el.disabled = true; el.textContent = 'Procurando…';
  Z.api('/api/admin/domains/detect-ip').then(function (d) {
    el.disabled = false; el.innerHTML = antes;
    if (d.error && !d.publicIp) return Z.erro('Não consegui descobrir o IP público: ' + d.error);
    if (d.publicIp) {
      var inp = document.getElementById('dom-serverIp');
      if (inp) inp.value = d.publicIp;
      Z.ok('IP público encontrado: ' + d.publicIp + '. Confira e salve.');
    }
    if (d.isLocalOnly) {
      Z.toast('Esta máquina só tem endereço de rede local — domínio de verdade não chega até aqui.', 'erro');
    }
  }).catch(function () { el.disabled = false; el.innerHTML = antes; Z.erro('A detecção falhou.'); });
}

function salvarConfig(_dado, el) {
  var corpo = {
    serverIp: valor('dom-serverIp'),
    cnameTarget: valor('dom-cname'),
    panelDomain: valor('dom-panel'),
    publishPort: valor('dom-porta'),
    verifyTtlMin: valor('dom-ttl'),
    leEmail: valor('dom-email'),
    sslMode: sslSel,
    autoCaddy: !!(document.getElementById('dom-caddy') || {}).checked,
  };
  el.disabled = true;
  Z.apiJson('/api/admin/domains/config', 'PUT', corpo).then(function (d) {
    el.disabled = false;
    if (d.error) return Z.erro(d.error);
    Z.ok('Configuração salva.');
    if (d.ssl && d.ssl.aplicado) Z.toast('Proxy atualizado: ' + d.ssl.motivo);
    else if (d.ssl && d.ssl.motivo && corpo.autoCaddy && sslSel === 'proxy') Z.toast('Proxy não recarregado — ' + d.ssl.motivo, 'erro');
    Z.recarregar();
  }).catch(function () { el.disabled = false; Z.erro('Não consegui salvar.'); });
}
function valor(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }

function verificar(dominio, el) {
  var antes = el.innerHTML;
  el.disabled = true; el.textContent = 'Checando…';
  Z.apiJson('/api/admin/domains/' + encodeURIComponent(dominio) + '/verify', 'POST', {}).then(function (d) {
    el.disabled = false; el.innerHTML = antes;
    if (d.error) return Z.erro(d.error);
    var r = d.domain || {};
    if (r.status === 'ativo' && r.pointing) Z.ok(dominio + ' está no ar.');
    else if (r.status === 'ativo') Z.toast('Posse provada pelo TXT, mas o tráfego ainda não chega. Falta o registro A/CNAME propagar.');
    else Z.erro(r.error || 'O DNS ainda não aponta para este servidor.');
    Z.recarregar();
  }).catch(function () { el.disabled = false; el.innerHTML = antes; Z.erro('A verificação falhou.'); });
}

function remover(dominio) {
  Z.confirmar({
    titulo: 'Remover ' + Z.esc(dominio) + '?',
    texto: 'O site sai do ar neste endereço na hora. O projeto do cliente e os arquivos dele continuam intactos — ' +
           'só o apontamento é desfeito, e o cliente pode plugar o domínio de novo depois.',
    confirmar: 'Remover domínio', perigo: true,
    aoConfirmar: function () {
      Z.api('/api/admin/domains/' + encodeURIComponent(dominio), { method: 'DELETE' }).then(function (d) {
        if (d.error) return Z.erro(d.error);
        Z.ok('Domínio removido.');
        Z.recarregar();
      });
    },
  });
}

function detalhe(dominio) {
  var d = todos.filter(function (x) { return x.domain === dominio; })[0];
  if (!d) return Z.erro('Domínio não encontrado nesta lista.');
  var lc = d.lastCheck || {};

  var chips = [chipStatus(d.status)];
  if (d.primary) chips.push(C.chip('principal', 'acento'));
  if (d.status === 'ativo' && d.pointing === false) chips.push(C.chip('só TXT', 'alerta'));

  Z.modal({
    icone: 'dominios', largo: true,
    titulo: Z.esc(d.domain),
    chips: chips,
    sub: 'O que o DNS respondeu na última consulta — é isto que decide se o site sobe ou fica esperando.',
    corpo:
      '<div class="z-col" style="gap:7px">' +
        linha('Projeto', Z.esc(d.slug || d.projectId || '—')) +
        linha('Dono', Z.esc(d.user || '—')) +
        linha('Cadastrado em', Z.data(d.createdAt, true)) +
        linha('Verificado em', d.verifiedAt ? Z.data(d.verifiedAt, true) : 'ainda não') +
        linha('Última checagem', d.lastCheckAt ? Z.data(d.lastCheckAt, true) : 'nunca') +
      '</div>' +
      (d.error ? '<div style="margin-top:14px">' + C.banner(Z.esc(d.error), 'alerta') + '</div>' : '') +
      '<div class="z-sep"></div>' +
      '<span class="z-rotulo">O que o DNS respondeu</span>' +
      '<div class="z-col" style="gap:7px">' +
        linha('Registro A', regs(lc.a)) +
        linha('Registro AAAA', regs(lc.aaaa)) +
        linha('CNAME', regs(lc.cname)) +
        linha('TXT em _nascera', regs(lc.txt)) +
      '</div>' +
      '<div class="z-sep"></div>' +
      '<span class="z-rotulo">Confronto com o esperado</span>' +
      '<div class="z-col" style="gap:7px">' +
        linha('IP esperado', '<span class="z-mono">' + Z.esc(lc.expectedIp || cfg.serverIp || '—') + '</span>') +
        linha('CNAME esperado', '<span class="z-mono">' + Z.esc(lc.expectedCname || cfg.cnameTarget || '—') + '</span>') +
        linha('Bate pelo A', sim(lc.pointsA)) +
        linha('Bate pelo CNAME', sim(lc.pointsCname)) +
        linha('Bate indiretamente', sim(lc.pointsIndirect)) +
        linha('TXT de posse', sim(lc.hasTxt)) +
      '</div>' +
      '<div class="z-sep"></div>' +
      '<span class="z-rotulo">Token de posse</span>' +
      '<div class="z-mono z-fg3" style="overflow-wrap:anywhere">' + Z.esc(d.token || '—') + '</div>' +
      '<div class="z-dica">O cliente prova que o domínio é dele publicando este valor num TXT em <b>_nascera.' +
        Z.esc(d.domain) + '</b>.</div>',
    pe: '<button class="z-btn" data-fechar>Fechar</button>' +
        C.btn('Verificar agora', { classe: 'primario', icone: 'atualiza', id: 'dom-mod-verificar' }),
    // o modal vive fora de #z-conteudo, então ligarAcoes não alcança: liga aqui
    aoAbrir: function (m) {
      m.querySelector('#dom-mod-verificar').onclick = function () {
        Z.fecharModal();
        // Reaproveita o botão da linha (para o "Checando…" aparecer onde o dono
        // está olhando). Domínio torto quebraria o seletor, então cai no plano B.
        var botao = null;
        try {
          botao = document.querySelector('[data-acao="verificar"][data-dado="' + Z.esc(d.domain).replace(/["\\]/g, '\\$&') + '"]');
        } catch (e) { botao = null; }
        if (botao) botao.click(); else verificarSemBotao(d.domain);
      };
    },
  });
}
function verificarSemBotao(dominio) {
  Z.apiJson('/api/admin/domains/' + encodeURIComponent(dominio) + '/verify', 'POST', {}).then(function (r) {
    if (r.error) return Z.erro(r.error);
    Z.ok('Verificação refeita.');
    Z.recarregar();
  });
}
function regs(lista) {
  if (!lista || !lista.length) return '<span class="z-fg3">nenhum</span>';
  return '<span class="z-mono" style="overflow-wrap:anywhere">' + Z.esc(lista.join(', ')) + '</span>';
}
function sim(v) { return v ? '<span class="z-chip ok">sim</span>' : '<span class="z-chip">não</span>'; }

// ─── Caddyfile (texto puro, então vai de fetch direto) ────────────────
function pegarCaddyfile() {
  return fetch('/api/admin/domains/caddyfile', {
    headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('nascera_token') || '') },
  }).then(function (r) {
    if (!r.ok) throw new Error('o servidor respondeu ' + r.status);
    return r.text();
  });
}

function verCaddyfile() {
  pegarCaddyfile().then(function (txt) {
    Z.modal({
      icone: 'codigo', largo: true,
      titulo: 'Caddyfile',
      sub: 'Gerado a partir dos domínios ativos e da configuração acima. Com a automação ligada, o NASCERA escreve ' +
           'este arquivo sozinho; desligada, cole você mesmo no servidor.',
      corpo: '<div class="z-mono" style="white-space:pre-wrap;overflow-wrap:anywhere;background:rgba(0,0,0,.28);' +
             'border:1px solid var(--z-line);border-radius:10px;padding:14px;max-height:52vh;overflow:auto">' +
             Z.esc(txt) + '</div>',
      pe: '<button class="z-btn" data-fechar>Fechar</button>' +
          C.btn('Baixar arquivo', { classe: 'primario', icone: 'baixar', id: 'dom-mod-baixar' }),
      aoAbrir: function (m) {
        m.querySelector('#dom-mod-baixar').onclick = function () { baixarCaddyfile(); };
      },
    });
  }).catch(function (e) { Z.erro('Não consegui gerar o Caddyfile: ' + e.message); });
}

function baixarCaddyfile() {
  pegarCaddyfile().then(function (txt) {
    var url = URL.createObjectURL(new Blob([txt], { type: 'text/plain' }));
    var a = document.createElement('a');
    a.href = url; a.download = 'Caddyfile';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    Z.ok('Caddyfile baixado.');
  }).catch(function (e) { Z.erro('Não consegui gerar o Caddyfile: ' + e.message); });
}

// ─── utilidades locais ────────────────────────────────────────────────
// Z.esc não escapa aspas; num atributo isso deixaria um IP salvo torto
// quebrar o input inteiro.
function att(v) { return Z.esc(v == null ? '' : v).replace(/"/g, '&quot;'); }
function linha(rot, val) {
  return '<div class="z-linha entre" style="font-size:12.5px">' +
    '<span class="z-fg3">' + rot + '</span><span class="z-fg2" style="text-align:right">' + val + '</span></div>';
}
})();
