/* ═══ NASCERA ADMIN v2 — ATUALIZAÇÕES ═══════════════════════════════════
   O dono aperta um botão e a cópia dele se atualiza sozinha: baixa, confere
   a assinatura, guarda backup, troca o código e reinicia. Dado do cliente
   (usuários, projetos, cobranças, domínios, aparência) nunca é tocado.

   Enquanto a atualização roda, esta tela acompanha o estado por polling —
   e no fim fica batendo em /api/health até o servidor voltar de pé.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
var Z = window.ZAdmin, C = Z.C;

// As etapas na ordem em que o servidor as marca (atualizacao.js).
var ETAPAS = [
  { k: 'verificando',              t: 'Conferindo se há versão nova',            p: 10 },
  { k: 'baixando',                 t: 'Baixando o pacote',                       p: 34 },
  { k: 'conferindo',               t: 'Conferindo o pacote e a assinatura',      p: 54 },
  { k: 'extraindo',                t: 'Abrindo o pacote num canto isolado',      p: 65 },
  { k: 'salvando backup',          t: 'Guardando o backup da versão atual',      p: 75 },
  { k: 'aplicando',                t: 'Trocando os arquivos de código',          p: 85 },
  { k: 'instalando dependências',  t: 'Instalando as dependências novas',        p: 93 },
  { k: 'reiniciando',              t: 'Reiniciando o Nascera',                     p: 100 },
];

var timerStatus = null, timerSaude = null;

Z.registrar('updates', {
  render: function (alvo) {
    pararTimers();
    return Promise.all([
      Z.api('/api/admin/update/check').catch(function () {
        return { ok: false, erro: 'Não deu para falar com o servidor de atualizações.' };
      }),
      Z.api('/api/admin/update/status').catch(function () { return {}; }),
    ]).then(function (r) {
      var d = r[0] || {}, s = r[1] || {};
      var hist = s.historico || [];
      var atualVersao = d.versaoAtual || s.versaoAtual || '—';
      var falhou = (d.ok === false) || !!d.erro;
      var tem = !falhou && !!d.temAtualizacao && !!d.versaoNova;

      // o selo "novo" da barra lateral acompanha o que a gente descobriu aqui
      var selo = document.getElementById('upd-selo');
      if (selo) selo.classList.toggle('z-oculto', !tem);

      var html = C.cab({
        trilha: 'Sistema · Manutenção da plataforma',
        icone: 'updates',
        titulo: 'Atualizações',
        sub: 'A versão do Nascera que roda na sua máquina. Atualizar troca só o código — clientes, projetos, cobranças, domínios e aparência ficam onde estão.',
        acoes: [C.btn('Verificar de novo', { icone: 'atualiza', acao: 'recarregar' })],
      });

      html += C.stats([
        { rot: 'Versão instalada', num: Z.esc(atualVersao), cap: 'A que está rodando agora', icone: 'caixa', pequeno: true, tom: tem ? 'alerta' : 'ok' },
        { rot: 'Versão publicada', num: Z.esc(falhou ? '—' : (d.versaoNova || atualVersao)),
          cap: falhou ? 'Não consegui consultar' : (tem ? 'Pronta para instalar' : 'Você já está nela'),
          icone: 'raio', pequeno: true, tom: tem ? 'acento' : '' },
        { rot: 'Tamanho do pacote', num: tem && d.tamanho ? Z.mb(Number(d.tamanho) / 1024) : '—',
          cap: tem && d.publicadaEm ? 'Publicada em ' + Z.data(d.publicadaEm) : 'Nada para baixar', icone: 'baixar', pequeno: true },
        { rot: 'Atualizações aplicadas', num: Z.num(hist.length),
          cap: hist.length ? 'A última foi ' + Z.desde(hist[0].em) + ' atrás' : 'Nenhuma por aqui ainda', icone: 'relogio' },
      ]);

      html += '<span class="z-rotulo" style="margin-top:6px">Estado</span>';
      html += '<div id="upd-caixa">' + (falhou ? corpoFalha(d, atualVersao) : (tem ? corpoNova(d, atualVersao) : corpoEmDia(atualVersao))) + '</div>';

      html += '<span class="z-rotulo" style="margin-top:22px">Histórico</span>';
      html += C.card({
        tit: 'Atualizações já aplicadas nesta instalação',
        sub: 'Cada linha guardou um backup da versão anterior na pasta <span class="z-mono">.backups</span> do servidor.',
        corpo: C.tabela(
          [{ t: 'Versão' }, { t: 'Itens trocados' }, { t: 'Backup' }, { t: 'Quando', dir: true }],
          hist.map(function (x) {
            return '<tr><td class="forte">' + Z.esc(x.versao || '—') + '</td>' +
              '<td class="num">' + Z.num(x.arquivos) + '</td>' +
              '<td class="z-mono z-fg3">' + Z.esc(nomeBackup(x.backup)) + '</td>' +
              '<td class="dir z-fg3">' + Z.data(x.em, true) + '</td></tr>';
          }),
          { icone: 'updates', vazioTit: 'Nenhuma atualização aplicada por aqui',
            vazioTxt: 'Quando você atualizar pelo painel, cada versão aparece nesta lista com o backup que ficou guardado.' }),
      });

      // O #z-conteudo é o MESMO elemento entre telas — só o innerHTML troca.
      // Pendurar os cliques nele empilharia um ouvinte por visita e um clique
      // em "Atualizar agora" viraria três POST /apply. Esta raiz nasce a cada
      // render, então os ouvintes antigos morrem junto com ela.
      alvo.innerHTML = '<div id="upd-raiz">' + html + '</div>';

      Z.ligarAcoes('upd-raiz', {
        'recarregar': function () { Z.recarregar(); },
        'aplicar': function () { confirmarAplicar(d); },
      });
    });
  },
});

// ─── Estados da caixa principal ──────────────────────────────────────
function corpoFalha(d, atualVersao) {
  return C.vazio({
    tom: 'erro', icone: 'alerta',
    tit: 'Não deu para consultar o servidor de atualizações',
    txt: Z.esc(d.erro || 'O servidor de atualizações não respondeu.') +
         '<br>Sua instalação continua rodando normal na versão <b>' + Z.esc(atualVersao) +
         '</b> — isso só impede saber se existe versão nova.',
    acao: C.btn('Tentar de novo', { classe: 'primario', icone: 'atualiza', acao: 'recarregar' }),
  });
}

function corpoEmDia(atualVersao) {
  return C.vazio({
    icone: 'check',
    tit: 'Tudo em dia',
    txt: 'Você está na versão <b>' + Z.esc(atualVersao) + '</b>, a mais recente publicada. ' +
         'Não precisa fazer nada — quando sair uma nova, ela aparece aqui e um selo acende no menu.',
    acao: C.btn('Verificar de novo', { icone: 'atualiza', acao: 'recarregar' }),
  });
}

function corpoNova(d, atualVersao) {
  var chips =
    C.chipPonto('Versão ' + d.versaoNova, 'acento') +
    (d.tamanho ? C.chip('Pacote de ' + Z.mb(Number(d.tamanho) / 1024)) : '') +
    (d.publicadaEm ? C.chip('Publicada em ' + Z.data(d.publicadaEm)) : '') +
    (d.assinatura ? C.chip('Assinatura conferida', 'ok') : C.chip('Sem assinatura no anúncio', 'alerta')) +
    (d.sha256 ? C.chip('Hash publicado', 'info') : '');

  return C.card({
    tit: 'Versão ' + d.versaoNova + ' disponível',
    sub: 'Você está na <b>' + Z.esc(atualVersao) + '</b>. O Nascera baixa o pacote, confere a assinatura, ' +
         'guarda um backup, troca o código e reinicia sozinho.',
    acoes: [C.btn('Atualizar agora', { classe: 'primario', icone: 'baixar', acao: 'aplicar' })],
    corpo:
      '<div class="z-item-chips" style="margin-bottom:14px">' + chips + '</div>' +
      C.banner('Seus <b>clientes, projetos, cobranças, domínios e aparência</b> ficam exatamente como estão — ' +
               'o update só substitui código. O servidor sai do ar por alguns segundos ao reiniciar.', 'info') +
      (d.notas
        ? '<span class="z-rotulo">O que muda nesta versão</span>' +
          '<div class="z-p" style="white-space:pre-wrap;background:rgba(0,0,0,.22);border:1px solid var(--z-line-soft);' +
          'border-radius:10px;padding:13px 15px">' + Z.esc(d.notas) + '</div>'
        : '<div class="z-dica">Esta versão veio sem notas de lançamento.</div>'),
  });
}

// ─── Aplicar ─────────────────────────────────────────────────────────
function confirmarAplicar(d) {
  Z.confirmar({
    titulo: 'Atualizar para a versão ' + Z.esc(d.versaoNova) + '?',
    texto: 'O Nascera vai baixar o pacote, guardar um backup e <b>reiniciar o servidor</b> no fim. ' +
           'Durante alguns segundos ninguém consegue entrar nem publicar. ' +
           'Não feche esta tela enquanto estiver rodando.',
    confirmar: 'Atualizar agora',
    aoConfirmar: aplicar,
  });
}

function aplicar() {
  var caixa = document.getElementById('upd-caixa');
  if (!caixa) return;
  caixa.innerHTML = telaProgresso();
  pintarEtapa(null);

  timerStatus = setInterval(function () {
    if (!document.getElementById('upd-barra')) { pararTimers(); return; }
    Z.api('/api/admin/update/status').then(function (s) {
      s = s || {};
      pintarEtapa(s.etapa);
      if (s.erro) { pararTimers(); mostrarFalha(s.erro); }
      else if (s.concluido) { pararTimers(); esperarVoltar(); }
    }).catch(function () { /* o servidor está reiniciando — é esperado */ });
  }, 1500);

  // Esta chamada só responde quando TUDO acabou (ou falhou). Quem move a
  // tela é o polling acima; aqui só interessa o erro imediato.
  Z.api('/api/admin/update/apply', { method: 'POST' }).then(function (r) {
    if (r && r.error) { pararTimers(); mostrarFalha(r.error); }
  }).catch(function () { /* a conexão cai no restart — esperado */ });
}

function telaProgresso() {
  return C.card({
    tit: 'Atualizando o Nascera',
    sub: 'Isso leva alguns minutos. Deixe esta tela aberta — o servidor reinicia sozinho no fim.',
    corpo:
      '<div class="z-linha entre" style="margin-bottom:9px">' +
        '<span class="z-fg2" id="upd-etapa" style="font-size:13px">Começando…</span>' +
        '<span class="z-mono" id="upd-pct" style="color:var(--z-acc2)">0%</span>' +
      '</div>' +
      '<div style="height:5px;border-radius:5px;background:rgba(255,255,255,.07);overflow:hidden">' +
        '<div id="upd-barra" style="height:100%;width:4%;border-radius:5px;' +
        'background:linear-gradient(90deg,var(--z-acc),var(--z-acc2));transition:width .5s var(--z-ease)"></div>' +
      '</div>' +
      '<div class="z-col" style="gap:9px;margin-top:18px">' +
        ETAPAS.map(function (e, i) {
          return '<div class="z-linha" id="upd-e-' + i + '" style="gap:9px;font-size:12.5px;opacity:.3">' +
            '<span class="z-ponto"></span><span>' + Z.esc(e.t) + '</span></div>';
        }).join('') +
      '</div>',
  });
}

function pintarEtapa(etapa) {
  var idx = -1;
  for (var i = 0; i < ETAPAS.length; i++) if (ETAPAS[i].k === etapa) idx = i;

  var rot = document.getElementById('upd-etapa');
  var barra = document.getElementById('upd-barra');
  var pct = document.getElementById('upd-pct');
  if (!barra) return;

  if (etapa === 'desfazendo') {
    if (rot) rot.textContent = 'Deu problema — desfazendo e voltando a versão anterior';
    return;
  }
  var p = idx >= 0 ? ETAPAS[idx].p : 4;
  if (rot) rot.textContent = idx >= 0 ? ETAPAS[idx].t : 'Começando…';
  if (pct) pct.textContent = p + '%';
  barra.style.width = p + '%';

  for (var j = 0; j < ETAPAS.length; j++) {
    var el = document.getElementById('upd-e-' + j);
    if (!el) continue;
    el.style.opacity = j <= idx ? '1' : '.3';
    el.style.color = j < idx ? 'var(--z-ok)' : (j === idx ? 'var(--z-acc2)' : '');
  }
}

function mostrarFalha(msg) {
  var caixa = document.getElementById('upd-caixa');
  if (!caixa) return;
  caixa.innerHTML = C.vazio({
    tom: 'erro', icone: 'alerta',
    tit: 'A atualização não foi aplicada',
    txt: Z.esc(msg || 'Erro inesperado durante a atualização.') +
         '<br>Nada foi perdido: o Nascera continua na versão anterior e os seus dados não foram tocados.',
    acao: C.btn('Voltar', { classe: 'primario', acao: 'recarregar' }),
  });
  Z.erro('A atualização não foi aplicada.');
}

// O servidor está subindo com o código novo — fica batendo até ele responder.
function esperarVoltar() {
  var caixa = document.getElementById('upd-caixa');
  if (!caixa) return;
  caixa.innerHTML = C.card({
    tit: 'Quase lá — reiniciando o Nascera',
    sub: 'O código novo já está no lugar. Assim que o servidor responder, esta página recarrega sozinha.',
    corpo: '<div class="z-linha"><span class="z-chip acento"><span class="z-ponto"></span>Esperando o servidor voltar</span></div>' +
           '<div class="z-dica" style="margin-top:10px">Se demorar mais de dois minutos, veja os logs do servidor. ' +
           'O backup da versão anterior está na pasta <span class="z-mono">.backups</span>.</div>',
  });

  var tentativas = 0;
  timerSaude = setInterval(function () {
    tentativas++;
    if (tentativas > 60) {
      pararTimers();
      var cx = document.getElementById('upd-caixa');
      if (cx) cx.innerHTML = C.vazio({
        tom: 'erro', icone: 'alerta',
        tit: 'O Nascera está demorando a voltar',
        txt: 'A atualização foi aplicada, mas o servidor não respondeu em dois minutos. ' +
             'Veja os logs — o backup da versão anterior está na pasta <span class="z-mono">.backups</span>.',
        acao: C.btn('Tentar recarregar', { classe: 'primario', acao: 'recarregar' }),
      });
      return;
    }
    fetch('/api/health', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) return;
      pararTimers();
      var cx = document.getElementById('upd-caixa');
      if (cx) cx.innerHTML = C.vazio({
        icone: 'check', tit: 'Atualizado!',
        txt: 'O Nascera voltou com a versão nova. Recarregando o painel…',
      });
      Z.ok('Nascera atualizado.');
      setTimeout(function () { location.reload(); }, 1500);
    }).catch(function () { /* ainda subindo */ });
  }, 2000);
}

function pararTimers() {
  if (timerStatus) { clearInterval(timerStatus); timerStatus = null; }
  if (timerSaude) { clearInterval(timerSaude); timerSaude = null; }
}

function nomeBackup(caminho) {
  var s = String(caminho || '');
  if (!s) return '—';
  var partes = s.split('/');
  return partes[partes.length - 1] || s;
}
})();
