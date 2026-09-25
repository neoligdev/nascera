/* ═══ NASCERA ADMIN v2 — PROJETOS ══════════════════════════════════════
   Todo site que já nasceu aqui: de quem é, em que nível foi feito, se
   está no ar, quanto ocupa e quanto custou de IA. É o produto inteiro
   numa tela só.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
var Z = window.ZAdmin, C = Z.C;

// Os mesmos nomes que o cliente vê no editor (BUILD_LEVELS no server.js).
var NIVEIS = { 1: 'Rascunho', 2: 'Enxuto', 3: 'Equilibrado', 4: 'Completo', 5: 'Máximo' };

Z.registrar('projetos', {
  render: function (alvo) {
    return Z.api('/api/admin/projects').then(function (d) {
      var cab = C.cab({
        trilha: 'Produto · Todos os sites',
        icone: 'projetos',
        titulo: 'Projetos',
        sub: 'Cada projeto é um site de um cliente seu. Aqui você vê tudo o que existe na máquina — inclusive o que ninguém publicou ainda.',
        acoes: [C.btn('Atualizar', { icone: 'atualiza', acao: 'recarregar' })],
      });

      // A rota devolve uma lista; qualquer outra coisa é falha do servidor.
      if (!Array.isArray(d)) {
        var msg = (d && d.error) || 'O servidor não devolveu a lista de projetos.';
        Z.erro(msg);
        alvo.innerHTML = '<div id="pj-raiz">' + cab + C.vazio({
          tom: 'erro', icone: 'alerta', tit: 'Não consegui listar os projetos',
          txt: Z.esc(msg),
          acao: C.btn('Tentar de novo', { classe: 'primario', acao: 'recarregar' }),
        }) + '</div>';
        Z.ligarAcoes(document.getElementById('pj-raiz'), { 'recarregar': function () { Z.recarregar(); } });
        return;
      }

      var lista = d;
      var publicados = lista.filter(function (p) { return p.publishedVersion > 0; }).length;
      var rascunhos = lista.length - publicados;
      var semDono = lista.filter(function (p) { return !p.owner; }).length;
      var custo = lista.reduce(function (a, p) { return a + (Number(p.costUsd) || 0); }, 0);
      var disco = lista.reduce(function (a, p) { return a + (Number(p.sizeKb) || 0); }, 0);

      var html = cab;

      html += C.stats([
        { rot: 'Projetos', num: Z.num(lista.length), cap: publicados + ' no ar · ' + rascunhos + ' em rascunho', icone: 'projetos' },
        { rot: 'Publicados', num: Z.num(publicados), cap: publicados ? 'Sites vivos na internet' : 'Ninguém publicou ainda', icone: 'link', tom: publicados ? 'ok' : '' },
        { rot: 'Custo de IA', num: Z.usd(custo), cap: 'Somando todos os projetos', icone: 'raio' },
        { rot: 'Disco ocupado', num: Z.mb(disco), cap: 'Arquivos dos projetos no servidor', icone: 'caixa' },
      ]);

      if (semDono) {
        html += C.banner('<b>' + semDono + ' projeto(s) sem dono.</b> Sobraram de antes do controle de propriedade — ' +
          'só administradores conseguem abrir. Filtre por "Sem dono" para ver quais são.', 'alerta');
      }

      html += '<span class="z-rotulo" style="margin-top:22px">Todos os projetos</span>';
      html += C.card({
        tit: 'Lista completa',
        sub: 'Busque por nome, endereço (slug) ou dono. Clique em Abrir para entrar no projeto como se fosse o cliente.',
        corpo:
          C.busca('pj-busca', 'Buscar por nome, slug ou dono…') +
          C.filtros('pj-filtros', [
            { id: 'todos', t: 'Todos', n: lista.length },
            { id: 'publicados', t: 'Publicados', n: publicados },
            { id: 'rascunho', t: 'Rascunho', n: rascunhos },
            { id: 'semdono', t: 'Sem dono', n: semDono },
          ], 'todos') +
          '<div id="pj-lista"></div>',
      });

      // Container próprio: o roteador reaproveita #z-conteudo, então prender
      // os cliques aqui evita empilhar ouvintes a cada visita à seção.
      alvo.innerHTML = '<div id="pj-raiz">' + html + '</div>';
      var raiz = document.getElementById('pj-raiz');

      var estado = { filtro: 'todos', busca: '' };

      function passa(p) {
        if (estado.filtro === 'publicados' && !(p.publishedVersion > 0)) return false;
        if (estado.filtro === 'rascunho' && p.publishedVersion > 0) return false;
        if (estado.filtro === 'semdono' && p.owner) return false;
        if (!estado.busca) return true;
        var alvoTexto = ((p.name || '') + ' ' + (p.slug || '') + ' ' + (p.owner || '')).toLowerCase();
        return alvoTexto.indexOf(estado.busca) >= 0;
      }

      function pintar() {
        var visiveis = lista.filter(passa);
        var linhas = visiveis.map(linhaProjeto);
        var vazio = lista.length
          ? { vazioTit: 'Nenhum projeto com esse recorte', vazioTxt: 'Troque o filtro ou limpe a busca para ver os outros.' }
          : { vazioTit: 'Nenhum projeto ainda', vazioTxt: 'Assim que alguém criar o primeiro site, ele aparece aqui.' };
        document.getElementById('pj-lista').innerHTML = C.tabela([
          { t: 'Projeto' }, { t: 'Dono' }, { t: 'Nível' }, { t: 'Versão' },
          { t: 'Publicado' }, { t: 'Tamanho', dir: true }, { t: 'Custo', dir: true }, { t: 'Ações', dir: true },
        ], linhas, { icone: 'projetos', vazioTit: vazio.vazioTit, vazioTxt: vazio.vazioTxt });
      }

      pintar();

      Z.ligarFiltros('pj-filtros', function (f) { estado.filtro = f; pintar(); });
      var campo = document.getElementById('pj-busca');
      campo.oninput = function () { estado.busca = campo.value.trim().toLowerCase(); pintar(); };

      function achar(id) {
        for (var i = 0; i < lista.length; i++) if (lista[i].id === id) return lista[i];
        return null;
      }

      Z.ligarAcoes(raiz, {
        'recarregar': function () { Z.recarregar(); },

        'abrir': function (id) {
          var p = achar(id); if (!p) return;
          window.open('/app.html?projectId=' + encodeURIComponent(p.id) +
            '&projectName=' + encodeURIComponent(p.name || ''), '_blank');
        },

        'ver-site': function (id) {
          var p = achar(id); if (!p) return;
          if (!p.publishUrl) return Z.erro('Este projeto está publicado, mas não tem endereço gravado. Publique de novo pelo editor.');
          window.open(p.publishUrl, '_blank');
        },

        'lixeira': function (id) {
          var p = achar(id); if (!p) return;
          Z.confirmar({
            titulo: 'Mover para a lixeira?',
            texto: 'O projeto <b>' + Z.esc(p.name || p.slug || 'sem nome') + '</b> sai da lista do cliente e os arquivos vão para a lixeira interna. ' +
                   (p.publishedVersion > 0 ? 'O site publicado sai do ar na hora. ' : '') +
                   'Nada é apagado agora — a limpeza definitiva acontece pela retenção configurada.',
            confirmar: 'Mover para a lixeira',
            perigo: true,
            aoConfirmar: function () {
              Z.api('/api/projects/' + encodeURIComponent(p.id), { method: 'DELETE' }).then(function (r) {
                if (r && r.error) return Z.erro(r.error);
                Z.ok('"' + (p.name || p.slug) + '" foi para a lixeira.');
                Z.recarregar();
              }).catch(function (e) { Z.erro(e.message || 'Não consegui mover o projeto.'); });
            },
          });
        },
      });
    });
  },
});

function linhaProjeto(p) {
  var nivel = Number(p.buildLevel) || 3;
  if (!NIVEIS[nivel]) nivel = 3;

  var acoes =
    C.btn('Abrir', { classe: 'mini', acao: 'abrir', dado: p.id, titulo: 'Abrir no editor' }) +
    (p.publishedVersion > 0
      ? C.btn('Ver site', { classe: 'mini', icone: 'externo', acao: 'ver-site', dado: p.id, titulo: 'Abrir o site publicado' })
      : '') +
    C.btn('Lixeira', { classe: 'mini perigo', icone: 'lixeira', acao: 'lixeira', dado: p.id, titulo: 'Mover para a lixeira' });

  return '<tr>' +
    '<td class="forte">' + Z.esc(p.name || 'Sem nome') +
      '<div class="z-cel-sub z-mono">' + Z.esc(p.slug || p.id) + '</div></td>' +
    '<td>' + (p.owner ? Z.esc(p.owner) : C.chip('sem dono', 'alerta')) + '</td>' +
    '<td>' + C.chip(nivel + ' · ' + NIVEIS[nivel], nivel >= 4 ? 'acento' : '') + '</td>' +
    '<td class="num z-fg3">v' + (Number(p.currentVersion) || 0) + '</td>' +
    '<td>' + (p.publishedVersion > 0 ? C.chipPonto('v' + p.publishedVersion, 'ok') : C.chip('não')) + '</td>' +
    '<td class="dir num">' + Z.mb(p.sizeKb) + '</td>' +
    '<td class="dir num">' + (p.costUsd ? Z.usd(p.costUsd) : '<span class="z-fg3">—</span>') + '</td>' +
    '<td class="dir"><div class="z-linha" style="justify-content:flex-end;flex-wrap:nowrap;gap:6px">' + acoes + '</div></td>' +
  '</tr>';
}

})();
