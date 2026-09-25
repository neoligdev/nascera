/* ═══ NASCERA ADMIN v2 — IA & MOTOR ═════════════════════════════════════
   O coração do produto em quatro abas: as sessões que estão vivas agora,
   qual CLI responde os builds, quem trouxe a própria chave e os modelos
   que rodam dentro desta máquina.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
var Z = window.ZAdmin, C = Z.C;

var ABAS = [
  { id: 'sessoes', t: 'Sessões vivas',          icone: 'raio' },
  { id: 'motores', t: 'Motores',                icone: 'ia' },
  { id: 'propria', t: 'IA própria dos clientes',icone: 'usuario' },
  { id: 'locais',  t: 'Modelos locais',         icone: 'caixa' },
];
var abaAtual = 'sessoes';

// polling dos downloads de modelo — um timer só, olhando todos os ids
var timer = null, vigiando = [];

Z.registrar('ia', {
  render: function (alvo) {
    pararTudo();

    // Container próprio: o roteador reaproveita #z-conteudo, então prender
    // os cliques aqui evita empilhar ouvintes a cada visita à seção.
    alvo.innerHTML = '<div id="ia-raiz">' +
      C.cab({
        trilha: 'Produto · Motor de IA',
        icone: 'ia',
        titulo: 'IA & Motor',
        sub: 'Quem responde os builds dos seus clientes: o que está rodando agora, qual CLI está no comando, ' +
             'quem trouxe a própria chave e os modelos instalados nesta máquina.',
        acoes: [C.btn('Atualizar', { icone: 'atualiza', acao: 'recarregar' })],
      }) +
      C.abas('ia-abas', ABAS, abaAtual) +
      '<div id="ia-corpo">' + C.carregando() + '</div>' +
    '</div>';

    Z.ligarAbas('ia-abas', function (id) {
      abaAtual = id;
      pintar().catch(falha);
    });

    Z.ligarAcoes('ia-raiz', {
      'recarregar':      function () { Z.recarregar(); },
      'encerrar-sessao': encerrarSessao,
      'usar-motor':      usarMotor,
      'instalar-motor':  instalarMotor,
      'diagnostico':     abrirDiagnostico,
      'copiar':          copiar,
      'baixar-modelo':   baixarModelo,
      'testar-modelo':   testarModelo,
      'usar-modelo':     usarModelo,
      'voltar-claude':   voltarAoClaude,
    });

    return pintar();
  },
});

// ─── troca de aba ─────────────────────────────────────────────────────
function corpoEl() { return document.getElementById('ia-corpo'); }

function pintar() {
  var cx = corpoEl();
  if (!cx) return Promise.resolve();
  cx.innerHTML = C.carregando();
  if (abaAtual === 'motores') return abaMotores(cx);
  if (abaAtual === 'propria') return abaPropria(cx);
  if (abaAtual === 'locais')  return abaLocais(cx);
  return abaSessoes(cx);
}
function falha(e) {
  var cx = corpoEl();
  if (!cx) return;
  cx.innerHTML = C.vazio({
    tom: 'erro', icone: 'alerta', tit: 'Não consegui carregar esta aba',
    txt: Z.esc(e && e.message ? e.message : 'Erro inesperado.'),
  });
}
function apiErro(cx, d) {
  if (!d || !d.error) return false;
  Z.erro(d.error);
  cx.innerHTML = C.vazio({ tom: 'erro', icone: 'alerta', tit: 'A API recusou', txt: Z.esc(d.error) });
  return true;
}

// ═══ ABA 1 — SESSÕES VIVAS ════════════════════════════════════════════
function abaSessoes(cx) {
  return Z.api('/api/admin/sessions').then(function (lista) {
    if (apiErro(cx, lista)) return;
    lista = Array.isArray(lista) ? lista : [];

    var rodando = lista.filter(function (s) { return s.running; }).length;
    var esperando = lista.reduce(function (a, s) { return a + (Number(s.pendingInteractions) || 0); }, 0);
    var custo = lista.reduce(function (a, s) { return a + (Number(s.totalCostUsd) || 0); }, 0);

    var html = C.stats([
      { rot: 'Sessões abertas', num: Z.num(lista.length), cap: 'Projetos com o motor de pé', icone: 'raio', tom: lista.length ? 'acento' : '' },
      { rot: 'Trabalhando agora', num: Z.num(rodando), cap: rodando ? 'A IA está escrevendo' : 'Ninguém em turno', icone: 'play', tom: rodando ? 'ok' : '' },
      { rot: 'Esperando você', num: Z.num(esperando), cap: esperando ? 'Pedidos de permissão parados' : 'Nada travado', icone: 'alerta', tom: esperando ? 'alerta' : '' },
      { rot: 'Custo destas sessões', num: Z.usd(custo), cap: 'Desde que cada uma abriu', icone: 'dinheiro' },
    ]);

    var linhas = lista.map(function (s) {
      var est = estadoSessao(s);
      return '<tr>' +
        '<td class="forte">' + Z.esc(s.projectName || 'Projeto sem nome') +
          '<div class="z-cel-sub z-mono">' + Z.esc(s.key || '—') + '</div></td>' +
        '<td>' + est + '</td>' +
        '<td>' + Z.esc(s.mode || '—') + '</td>' +
        '<td class="z-mono">' + Z.esc(s.model || '—') + '</td>' +
        '<td class="num">' + Z.num(s.turnCount) + '</td>' +
        '<td class="dir num">' + Z.usd(s.totalCostUsd) + '</td>' +
        '<td class="dir z-fg3">' + dur(s.uptimeMs) + '</td>' +
        '<td class="dir z-fg3">' + dur(s.idleMs) + '</td>' +
        '<td class="dir">' + C.btn('Encerrar', {
          classe: 'mini perigo', icone: 'fechado', acao: 'encerrar-sessao', dado: s.key,
          titulo: 'Fecha o processo do motor deste projeto',
        }) + '</td>' +
      '</tr>';
    });

    html += '<span class="z-rotulo" style="margin-top:22px">Sessões abertas</span>';
    html += C.card({
      tit: 'O que está de pé agora',
      sub: 'Cada linha é um processo de IA de pé nesta máquina. Encerrar libera memória — o cliente só perde o ' +
           'contexto da conversa, o projeto e os arquivos ficam intactos.',
      corpo: C.tabela([
        { t: 'Projeto' }, { t: 'Estado' }, { t: 'Modo' }, { t: 'Modelo' }, { t: 'Turnos' },
        { t: 'Custo', dir: true }, { t: 'Ativa há', dir: true }, { t: 'Ociosa há', dir: true }, { t: 'Ações', dir: true },
      ], linhas, {
        icone: 'raio',
        vazioTit: 'Nenhuma sessão aberta agora',
        vazioTxt: 'Quando um cliente abre um projeto e conversa com a IA, a sessão dele aparece aqui — com custo e tempo em tempo real.',
      }),
    });

    cx.innerHTML = html;
  });
}

function estadoSessao(s) {
  if (Number(s.pendingInteractions) > 0) return C.chipPonto('Aguardando você', 'alerta');
  if (s.running) return C.chipPonto('Trabalhando', 'ok');
  return C.chipPonto('Ociosa', '');
}

function encerrarSessao(key) {
  Z.confirmar({
    titulo: 'Encerrar esta sessão?',
    texto: 'O processo do motor é derrubado agora. O cliente perde o contexto da conversa em andamento, mas ' +
           'nenhum arquivo do projeto é tocado — na próxima mensagem dele uma sessão nova nasce.',
    confirmar: 'Encerrar sessão', perigo: true,
    aoConfirmar: function () {
      Z.apiJson('/api/admin/sessions/' + encodeURIComponent(key) + '/close', 'POST', {}).then(function (d) {
        if (d.error) return Z.erro(d.error);
        Z.ok('Sessão encerrada.');
        pintar().catch(falha);
      });
    },
  });
}

// ═══ ABA 2 — MOTORES ══════════════════════════════════════════════════
function abaMotores(cx) {
  return Z.api('/api/admin/motores').then(function (d) {
    if (apiErro(cx, d)) return;
    var lista = d.motores || [];
    var emUso = d.emUso || 'claude';

    var html = C.banner(
      'Trocar de motor <b>fecha todas as sessões abertas</b> — o próximo turno de cada cliente já nasce no motor novo. ' +
      'Um CLI instalado mas sem login não constrói nada: ele só falha na primeira mensagem.', 'info');

    html += '<div class="z-linha entre" style="margin-bottom:12px">' +
      '<span class="z-rotulo" style="margin:0">Motores disponíveis</span>' +
      C.btn('Diagnóstico', { classe: 'mini', icone: 'olho', acao: 'diagnostico', titulo: 'De onde veio o CLI e qual versão está rodando' }) +
    '</div>';

    if (!lista.length) {
      cx.innerHTML = html + C.vazio({
        tom: 'erro', icone: 'alerta', tit: 'Nenhum motor reconhecido',
        txt: 'O servidor não devolveu nenhum CLI. Isso normalmente é instalação quebrada — o diagnóstico conta de onde o NASCERA tentou ler o binário.',
        acao: C.btn('Abrir diagnóstico', { classe: 'primario', icone: 'olho', acao: 'diagnostico' }),
      });
      return;
    }

    html += '<div class="z-grade">' + lista.map(function (m) {
      var chips = [];
      if (m.id === emUso) chips.push(C.chipPonto('Em uso', 'acento'));
      chips.push(m.instalado ? C.chip('Instalado', 'ok') : C.chip('Não instalado', 'erro'));
      if (m.instalado) chips.push(m.conectado ? C.chipPonto('Conectado', 'ok') : C.chip('Sem login', 'alerta'));
      if (m.embarcado) chips.push(C.chip('Embarcado', 'info'));

      var botoes = [];
      if (!m.instalado) {
        botoes.push(C.btn('Instalar', { classe: 'primario', icone: 'baixar', acao: 'instalar-motor', dado: m.id }));
      } else if (!m.conectado) {
        botoes.push(C.btn('Copiar comando', { icone: 'codigo', acao: 'copiar', dado: m.comandoLogin || '' }));
        botoes.push(C.btn('Reinstalar CLI', { classe: 'fantasma', icone: 'atualiza', acao: 'instalar-motor', dado: m.id }));
      } else if (m.id !== emUso) {
        botoes.push(C.btn('Usar este motor', { classe: 'primario', icone: 'check', acao: 'usar-motor', dado: m.id }));
      }

      var aviso = '';
      if (m.instalado && !m.conectado) {
        aviso = '<div style="margin-top:12px">' + C.banner(
          'Falta o login. No terminal do servidor rode <b class="z-mono">' + Z.esc(m.comandoLogin || '—') +
          '</b> e volte aqui.', 'alerta') + '</div>';
      } else if (!m.instalado) {
        aviso = '<div style="margin-top:12px">' + C.banner(
          'O CLI não está nesta máquina. O botão abaixo instala pra você.', 'erro') + '</div>';
      }

      return '<div class="z-item" style="cursor:default">' +
        '<div class="z-item-cab">' +
          '<div class="z-item-icone">' + Z.svg('ia') + '</div>' +
          '<div><div class="z-item-tit">' + Z.esc(m.nome || m.id) + '</div>' +
            '<div class="z-cel-sub">' + Z.esc(m.fornecedor || '—') + '</div></div>' +
        '</div>' +
        '<div class="z-item-chips">' + chips.join('') + '</div>' +
        '<div class="z-item-desc">' + Z.esc(m.resumo || '') + '</div>' +
        '<div class="z-sep"></div>' +
        '<div class="z-col" style="gap:6px">' +
          linha('Versão', Z.esc(m.versao || '—')) +
          linha('Conta', Z.esc(m.conta || '—')) +
          linha('Origem do binário', Z.esc(rotuloOrigem(m.origem))) +
        '</div>' +
        (m.caminho ? '<div class="z-mono z-fg3" style="margin-top:9px;overflow-wrap:anywhere">' + Z.esc(m.caminho) + '</div>' : '') +
        aviso +
        (botoes.length ? '<div class="z-linha" style="margin-top:13px">' + botoes.join('') + '</div>' : '') +
      '</div>';
    }).join('') + '</div>';

    cx.innerHTML = html;
  });
}

function rotuloOrigem(o) {
  if (o === 'embarcado') return 'embarcado no NASCERA (recomendado)';
  if (o === 'global') return 'instalação global da máquina';
  if (o === 'env') return 'caminho forçado por variável de ambiente';
  return '—';
}

function usarMotor(id) {
  Z.confirmar({
    titulo: 'Trocar o motor para este?',
    texto: 'Todas as sessões abertas são fechadas na hora e o próximo turno de cada cliente já nasce no motor novo. ' +
           'Nenhum projeto é perdido.',
    confirmar: 'Trocar motor',
    aoConfirmar: function () {
      Z.apiJson('/api/admin/motores/usar', 'PUT', { id: id }).then(function (d) {
        if (d.error) return Z.erro(d.error);
        Z.ok('Motor trocado. ' + Z.num(d.sessoesReiniciadas) + ' sessão(ões) reiniciada(s).');
        pintar().catch(falha);
      });
    },
  });
}

function instalarMotor(id, el) {
  var antes = el.innerHTML;
  el.disabled = true;
  el.textContent = 'Instalando…';
  Z.toast('Instalando o CLI. Isso pode levar alguns minutos — não feche o painel.');
  Z.apiJson('/api/admin/motores/instalar', 'POST', { id: id }).then(function (d) {
    el.disabled = false; el.innerHTML = antes;
    if (d.error) return Z.erro(d.error);
    if (!d.ok) return Z.erro(d.erro || 'Não consegui instalar o CLI.');
    Z.ok('CLI instalado. Se ainda faltar o login, o cartão avisa o comando.');
    pintar().catch(falha);
  }).catch(function (e) {
    el.disabled = false; el.innerHTML = antes;
    Z.erro('Falhou na instalação: ' + (e && e.message ? e.message : 'erro inesperado'));
  });
}

function abrirDiagnostico() {
  Z.api('/api/admin/motores/diagnostico').then(function (d) {
    if (d.error) return Z.erro(d.error);
    Z.modal({
      icone: 'olho', largo: true,
      titulo: 'Diagnóstico do motor',
      sub: 'De onde veio o CLI que está rodando e se ele casa com a SDK deste NASCERA. É por aqui que se resolve ' +
           '“não consigo fazer login”.',
      corpo:
        C.banner('Node desta máquina: <b class="z-mono">' + Z.esc(d.node || '—') + '</b>', 'info') +
        '<div class="z-grid2">' + ['claude', 'codex'].map(function (k) {
          var m = d[k] || {};
          return C.card({
            tit: k === 'claude' ? 'Claude Code' : 'GPT Codex',
            corpo: '<div class="z-col" style="gap:6px">' +
              linha('Conectado', m.conectado ? '<span class="z-chip ok">sim</span>' : '<span class="z-chip erro">não</span>') +
              linha('Versão em uso', Z.esc(m.versaoEmUso || '—')) +
              linha('Versão da SDK', Z.esc(m.versaoSdk || '—')) +
              linha('Origem', Z.esc(rotuloOrigem(m.origem))) +
              linha('Plataforma', Z.esc(m.plataforma || '—')) +
            '</div>' +
            '<div class="z-sep"></div>' +
            '<div class="z-col" style="gap:5px">' +
              caminhoLinha('Em uso', m.emUso) +
              caminhoLinha('Embarcado', m.embarcado) +
              caminhoLinha('Global', m.global) +
            '</div>',
          });
        }).join('') + '</div>',
      pe: '<button class="z-btn" data-fechar>Fechar</button>' +
          '<button class="z-btn primario" id="ia-reparar">Reparar o CLI do Claude</button>',
      aoAbrir: function (m) {
        m.querySelector('#ia-reparar').onclick = function () {
          var b = this; b.disabled = true; b.textContent = 'Reparando…';
          Z.api('/api/admin/motores/diagnostico?reparar=1').then(function (r) {
            Z.fecharModal();
            if (r.error) return Z.erro(r.error);
            if (r.reparo && r.reparo.ok) Z.ok(r.reparo.reparado ? 'CLI restaurado do pacote embarcado.' : 'O CLI já estava certo — nada a reparar.');
            else Z.erro((r.reparo && r.reparo.erro) || 'Não consegui reparar o CLI.');
            pintar().catch(falha);
          });
        };
      },
    });
  });
}
function caminhoLinha(rot, valor) {
  return '<div style="font-size:11.5px"><span class="z-fg3">' + rot + '</span>' +
    '<div class="z-mono z-fg2" style="overflow-wrap:anywhere">' + Z.esc(valor || '—') + '</div></div>';
}

// ═══ ABA 3 — IA PRÓPRIA DOS CLIENTES ══════════════════════════════════
function abaPropria(cx) {
  return Z.api('/api/admin/ia-propria').then(function (d) {
    if (apiErro(cx, d)) return;
    var conectados = d.conectados || [];

    var html = C.stats([
      { rot: 'Recurso', num: d.permitir ? 'Liberado' : 'Bloqueado', pequeno: true,
        cap: d.permitir ? 'Os clientes podem colar a chave deles' : 'Só a sua conta paga os builds',
        icone: 'bloqueio', tom: d.permitir ? 'ok' : '' },
      { rot: 'Clientes com chave própria', num: Z.num(conectados.length),
        cap: conectados.length ? 'Isentos de débito de crédito' : 'Ninguém conectou ainda',
        icone: 'usuario', tom: conectados.length ? 'acento' : '' },
    ]);

    html += '<span class="z-rotulo" style="margin-top:8px">O interruptor</span>';
    html += C.card({
      tit: 'Deixar o cliente usar a própria IA',
      sub: 'Ligado, cada cliente pode colar a chave da Anthropic dele nas configurações da conta.',
      corpo:
        '<div style="padding:4px 0 16px">' + C.switch('ia-propria-sw',
          d.permitir ? 'Liberado para os clientes' : 'Bloqueado para todos', d.permitir) + '</div>' +
        '<div class="z-col" style="gap:9px">' +
          ponto('O token sai da conta <b>dele</b>, não da sua: o consumo cai na fatura da Anthropic do próprio cliente.') +
          ponto('Por isso ele fica <b>isento de débito de crédito</b> aqui dentro — o NASCERA vira só a interface.') +
          ponto('A chave nunca fica em texto puro: vive no cofre criptografado e a API só devolve os 4 últimos dígitos.') +
          ponto('Chave de <b>API</b> é testada de verdade contra a Anthropic na hora de conectar; token de assinatura é validado só no formato.') +
        '</div>' +
        '<div style="margin-top:14px">' + C.banner(
          'Vale para sessões <b>novas</b>. Quem já está com um projeto aberto continua na credencial anterior até a sessão fechar.',
          'info') + '</div>',
    });

    var linhas = conectados.map(function (c) {
      return '<tr>' +
        '<td class="forte">' + Z.esc(c.username) + '</td>' +
        '<td>' + (c.tipo === 'oauth' ? C.chip('Assinatura Pro/Max', 'acento') : C.chip('Chave de API', 'info')) + '</td>' +
        '<td class="z-mono">' + Z.esc(c.sufixo || '—') + '</td>' +
        '<td class="dir z-fg3">' + Z.data(c.conectadaEm, true) + '</td>' +
      '</tr>';
    });

    html += '<span class="z-rotulo" style="margin-top:22px">Quem já conectou</span>';
    html += C.card({
      tit: 'Clientes na chave deles',
      sub: 'Estes clientes rodam por conta própria. Você não paga o build deles — e também não cobra crédito por ele.',
      corpo: C.tabela(
        [{ t: 'Cliente' }, { t: 'Tipo' }, { t: 'Chave' }, { t: 'Conectou em', dir: true }], linhas,
        { icone: 'usuario', vazioTit: 'Ninguém conectou a própria IA ainda',
          vazioTxt: d.permitir
            ? 'O recurso está liberado. Assim que um cliente colar a chave dele, ele aparece aqui.'
            : 'O recurso está bloqueado. Ligue o interruptor acima para os clientes poderem conectar.' }),
    });

    cx.innerHTML = html;

    var sw = document.getElementById('ia-propria-sw');
    if (sw) sw.onchange = function () {
      var val = sw.checked;
      sw.disabled = true;
      Z.apiJson('/api/admin/ia-propria', 'PUT', { permitir: val }).then(function (r) {
        sw.disabled = false;
        if (r.error) { sw.checked = !val; return Z.erro(r.error); }
        Z.ok(val ? 'Liberado: os clientes já podem conectar a própria chave.' : 'Bloqueado: só a sua conta paga os builds agora.');
        pintar().catch(falha);
      }).catch(function () { sw.disabled = false; sw.checked = !val; Z.erro('Não consegui salvar.'); });
    };
  });
}
function ponto(txt) {
  return '<div class="z-linha" style="align-items:flex-start;gap:9px">' +
    '<span class="z-ponto" style="margin-top:7px;color:var(--z-acc)"></span>' +
    '<div class="z-p" style="flex:1">' + txt + '</div></div>';
}

// ═══ ABA 4 — MODELOS LOCAIS ═══════════════════════════════════════════
function abaLocais(cx) {
  return Z.api('/api/admin/modelos-locais').then(function (d) {
    if (apiErro(cx, d)) return;
    var modelos = d.modelos || [];
    var emUso = d.emUso || null;

    var chips = [];
    chips.push(d.instalado ? C.chip('Ollama instalado', 'ok') : C.chip('Ollama ausente', 'erro'));
    if (d.instalado) chips.push(d.rodando ? C.chipPonto('Rodando', 'ok') : C.chip('Parado', 'alerta'));

    var estadoCorpo =
      '<div class="z-item-chips">' + chips.join('') + '</div>' +
      '<div class="z-col" style="gap:6px">' +
        linha('Versão do Ollama', Z.esc(d.versao || '—')) +
        linha('RAM desta máquina', d.ramGb ? Z.num(d.ramGb) + ' GB' : '—') +
        linha('Motor em uso', emUso ? '<span class="z-chip acento">' + Z.esc(emUso) + '</span>' : '<span class="z-chip ok">Claude (nuvem)</span>') +
      '</div>' +
      (d.caminho ? '<div class="z-mono z-fg3" style="margin-top:9px;overflow-wrap:anywhere">' + Z.esc(d.caminho) + '</div>' : '');

    if (!d.instalado) {
      estadoCorpo += '<div style="margin-top:14px">' + C.banner(
        'O Ollama não está nesta máquina — é ele que roda os modelos locais. Instale com ' +
        '<b class="z-mono">' + Z.esc(d.comoInstalar || '') + '</b>', 'erro') + '</div>' +
        '<div class="z-linha">' + C.btn('Copiar comando', { classe: 'mini', icone: 'codigo', acao: 'copiar', dado: d.comoInstalar || '' }) + '</div>';
    } else if (!d.rodando) {
      estadoCorpo += '<div style="margin-top:14px">' + C.banner(
        'O Ollama está instalado mas parado. Suba com <b class="z-mono">' + Z.esc(d.comoIniciar || '') + '</b>', 'alerta') + '</div>' +
        '<div class="z-linha">' + C.btn('Copiar comando', { classe: 'mini', icone: 'codigo', acao: 'copiar', dado: d.comoIniciar || '' }) + '</div>';
    }

    if (emUso) {
      estadoCorpo += '<div style="margin-top:14px">' + C.banner(
        'Todos os builds estão passando por <b>' + Z.esc(emUso) + '</b> nesta máquina. A Anthropic não é chamada — ' +
        'e a velocidade cai bastante em comparação com o Claude.', 'alerta') + '</div>' +
        '<div class="z-linha">' + C.btn('Voltar ao Claude', { classe: 'primario', icone: 'atualiza', acao: 'voltar-claude' }) + '</div>';
    }

    var html = '<span class="z-rotulo">Estado do Ollama</span>';
    html += C.card({
      tit: 'Modelos na sua máquina',
      sub: 'Roda a IA aqui dentro, sem mandar nada para fora e sem custo por token. Em troca: precisa de RAM sobrando e é mais lento.',
      corpo: estadoCorpo,
    });

    html += '<span class="z-rotulo" style="margin-top:22px">Modelos verificados</span>';

    if (!modelos.length) {
      cx.innerHTML = html + C.vazio({
        icone: 'caixa', tit: 'Nenhum modelo no catálogo',
        txt: 'O NASCERA só oferece modelo que passou no teste de ponta a ponta — chamar ferramenta e escrever arquivo ' +
             'num turno real. Enquanto nenhum passar, a lista fica vazia de propósito.',
      });
      return;
    }

    html += '<div class="z-grade">' + modelos.map(function (m) {
      var k = chave(m.id);
      var cs = [];
      if (m.id === emUso) cs.push(C.chipPonto('Em uso', 'acento'));
      if (m.recomendado) cs.push(C.chip('Recomendado', 'acento'));
      cs.push(m.instalado ? C.chip('Baixado', 'ok') : C.chip('Não baixado', ''));
      if (m.ferramentas === 'sim') cs.push(C.chip('Chama ferramentas', 'ok'));
      else if (m.ferramentas === 'nao') cs.push(C.chip('Não chama ferramentas', 'erro'));
      else cs.push(C.chip('Ferramentas não verificadas', 'alerta'));
      if (!m.cabeNestaMaquina) cs.push(C.chip('RAM insuficiente', 'erro'));

      var botoes = [];
      if (d.rodando && !m.instalado) botoes.push(C.btn('Baixar', { classe: 'primario', icone: 'baixar', acao: 'baixar-modelo', dado: m.id }));
      if (d.rodando && m.instalado) {
        botoes.push(C.btn('Testar', { icone: 'play', acao: 'testar-modelo', dado: m.id, titulo: 'Prova se o modelo chama ferramenta de verdade' }));
        if (m.id === emUso) botoes.push(C.btn('Voltar ao Claude', { icone: 'atualiza', acao: 'voltar-claude' }));
        else botoes.push(C.btn('Usar este modelo', { classe: 'primario', icone: 'check', acao: 'usar-modelo', dado: m.id }));
      }

      return '<div class="z-item" style="cursor:default">' +
        '<div class="z-item-cab">' +
          '<div class="z-item-icone">' + Z.svg('caixa') + '</div>' +
          '<div><div class="z-item-tit">' + Z.esc(m.nome || m.id) + '</div>' +
            '<div class="z-cel-sub z-mono">' + Z.esc(m.id) + '</div></div>' +
        '</div>' +
        '<div class="z-item-chips">' + cs.join('') + '</div>' +
        '<div class="z-item-desc">' + Z.esc(m.resumo || '') + '</div>' +
        '<div class="z-sep"></div>' +
        '<div class="z-col" style="gap:6px">' +
          linha('Tamanho do download', m.gb ? Z.num(m.gb) + ' GB' : '—') +
          linha('RAM recomendada', m.ramMin ? Z.num(m.ramMin) + ' GB' : '—') +
        '</div>' +
        (m.aviso ? '<div style="margin-top:12px">' + C.banner(Z.esc(m.aviso), 'erro') + '</div>' : '') +
        (m.avisoFerramentas ? '<div style="margin-top:12px">' + C.banner(Z.esc(m.avisoFerramentas), 'alerta') + '</div>' : '') +
        '<div id="prog-' + k + '" style="display:none;margin-top:13px">' +
          '<div style="height:6px;border-radius:4px;background:rgba(255,255,255,.08);overflow:hidden">' +
            '<div id="bar-' + k + '" style="height:100%;width:0%;background:linear-gradient(90deg,var(--z-acc),var(--z-acc2));transition:width .3s"></div>' +
          '</div>' +
          '<div id="txt-' + k + '" class="z-dica" style="margin-top:6px">Preparando o download…</div>' +
        '</div>' +
        (botoes.length ? '<div class="z-linha" style="margin-top:13px">' + botoes.join('') + '</div>' : '') +
      '</div>';
    }).join('') + '</div>';

    cx.innerHTML = html;

    // um download já em curso (o dono trocou de aba e voltou) volta a aparecer
    modelos.forEach(function (m) {
      if (m.instalado) return;
      Z.api('/api/admin/modelos-locais/progresso/' + encodeURIComponent(m.id)).then(function (p) {
        if (p && !p.desconhecido && !p.fim) vigiar(m.id);
      }).catch(function () {});
    });
  });
}

function baixarModelo(id, el) {
  el.disabled = true;
  Z.apiJson('/api/admin/modelos-locais/baixar', 'POST', { id: id }).then(function (d) {
    el.disabled = false;
    if (d.error) return Z.erro(d.error);
    Z.toast('Download começou. Pode levar bastante tempo — dá para navegar por outras telas.');
    vigiar(id);
  }).catch(function () { el.disabled = false; Z.erro('Não consegui começar o download.'); });
}

function testarModelo(id, el) {
  var antes = el.innerHTML;
  el.disabled = true; el.textContent = 'Testando…';
  Z.apiJson('/api/admin/modelos-locais/testar', 'POST', { id: id }).then(function (r) {
    el.disabled = false; el.innerHTML = antes;
    if (r.error) return Z.erro(r.error);
    Z.modal({
      icone: r.ok && r.usaFerramentas ? 'check' : 'alerta',
      titulo: r.ok && r.usaFerramentas ? 'Este modelo serve' : 'Este modelo não serve para construir',
      sub: 'Pedimos ao modelo que criasse um arquivo usando ferramenta. Responder texto não basta: sem chamada de ' +
           'ferramenta o agente não escreve nada.',
      corpo: !r.ok
        ? C.banner('O teste falhou: ' + Z.esc(r.erro || 'erro desconhecido'), 'erro')
        : '<div class="z-col" style="gap:7px">' +
            linha('Respondeu', r.respondeu ? '<span class="z-chip ok">sim</span>' : '<span class="z-chip erro">não</span>') +
            linha('Chamou a ferramenta', r.usaFerramentas ? '<span class="z-chip ok">sim</span>' : '<span class="z-chip erro">não</span>') +
            linha('Tempo de resposta', Z.esc(String(r.segundos || 0)) + 's') +
          '</div>' +
          (r.aviso ? '<div style="margin-top:14px">' + C.banner(Z.esc(r.aviso), 'alerta') + '</div>' : ''),
      pe: '<button class="z-btn primario" data-fechar>Entendi</button>',
    });
  }).catch(function () { el.disabled = false; el.innerHTML = antes; Z.erro('O teste não completou.'); });
}

function usarModelo(id) {
  Z.confirmar({
    titulo: 'Mandar todos os builds para este modelo?',
    texto: 'A partir de agora a IA responde de dentro desta máquina, sem chamar a Anthropic. As sessões abertas são ' +
           'fechadas e a velocidade cai bastante — modelo local leva minutos onde o Claude leva segundos.',
    confirmar: 'Usar o modelo local',
    aoConfirmar: function () {
      Z.apiJson('/api/admin/modelos-locais/usar', 'PUT', { id: id }).then(function (d) {
        if (d.error) return Z.erro(d.error);
        Z.ok('Modelo local no comando. ' + Z.num(d.sessoesReiniciadas) + ' sessão(ões) reiniciada(s).');
        pintar().catch(falha);
      });
    },
  });
}

function voltarAoClaude() {
  Z.confirmar({
    titulo: 'Voltar para o Claude?',
    texto: 'Os builds voltam a rodar na nuvem da Anthropic — mais rápidos e com custo por token de novo. ' +
           'As sessões abertas são fechadas.',
    confirmar: 'Voltar ao Claude',
    aoConfirmar: function () {
      Z.apiJson('/api/admin/modelos-locais/usar', 'PUT', { id: '' }).then(function (d) {
        if (d.error) return Z.erro(d.error);
        Z.ok('Claude de volta ao comando.');
        pintar().catch(falha);
      });
    },
  });
}

// ─── polling do download ──────────────────────────────────────────────
function vigiar(id) {
  if (vigiando.indexOf(id) < 0) vigiando.push(id);
  var cx = document.getElementById('prog-' + chave(id));
  if (cx) cx.style.display = 'block';
  if (timer) return;
  timer = setInterval(bater, 1500);
  bater();
}
function tirar(id) {
  var i = vigiando.indexOf(id);
  if (i >= 0) vigiando.splice(i, 1);
  if (!vigiando.length && timer) { clearInterval(timer); timer = null; }
}
function pararTudo() { if (timer) clearInterval(timer); timer = null; vigiando = []; }
function bater() {
  if (!vigiando.length) { pararTudo(); return; }
  vigiando.slice().forEach(function (id) {
    Z.api('/api/admin/modelos-locais/progresso/' + encodeURIComponent(id)).then(function (p) {
      var k = chave(id);
      var cx = document.getElementById('prog-' + k);
      if (!cx) { tirar(id); return; }               // saiu da tela: para sozinho
      if (!p || p.desconhecido) { tirar(id); cx.style.display = 'none'; return; }
      cx.style.display = 'block';
      var pct = p.total ? Math.min(100, Math.round((p.recebido / p.total) * 100)) : 0;
      var barra = document.getElementById('bar-' + k);
      var txt = document.getElementById('txt-' + k);
      if (barra) barra.style.width = pct + '%';
      if (txt) {
        txt.textContent = p.erro
          ? 'Falhou: ' + p.erro
          : (p.status || 'baixando') + ' · ' + pct + '%' +
            (p.total ? ' · ' + bytesGb(p.recebido) + ' de ' + bytesGb(p.total) : '');
      }
      if (p.fim) {
        tirar(id);
        if (p.erro) Z.erro('Download falhou: ' + p.erro);
        else { Z.ok('Modelo baixado. Agora dá para testar antes de usar.'); pintar().catch(falha); }
      }
    }).catch(function () { tirar(id); });
  });
}

// ─── utilidades locais ────────────────────────────────────────────────
function linha(rot, val) {
  return '<div class="z-linha entre" style="font-size:12.5px">' +
    '<span class="z-fg3">' + rot + '</span><span class="z-fg2">' + val + '</span></div>';
}
function dur(ms) {
  var s = Math.floor((Number(ms) || 0) / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'min';
  if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'min';
  return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
}
function bytesGb(n) {
  n = Number(n) || 0;
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(0) + ' MB';
  return (n / 1073741824).toFixed(1) + ' GB';
}
function chave(id) { return String(id || '').replace(/[^a-zA-Z0-9]/g, '-'); }
function copiar(txt) {
  if (!txt) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(
      function () { Z.ok('Comando copiado.'); },
      function () { Z.erro('Não consegui copiar — selecione o texto e copie à mão.'); });
  } else {
    Z.erro('Este navegador não deixa copiar automático. Selecione o texto e copie à mão.');
  }
}
})();
