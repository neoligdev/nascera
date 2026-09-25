/* ═══ NASCERA ADMIN v2 — VISÃO GERAL ═══════════════════════════════════
   O painel do dono: o dinheiro primeiro, depois o produto, depois a máquina.
   Referência de estilo para as demais seções.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
var Z = window.ZAdmin, C = Z.C;

Z.registrar('visao', {
  render: function (alvo) {
    return Promise.all([
      Z.api('/api/admin/overview').catch(function () { return {}; }),
      Z.api('/api/admin/vendas').catch(function () { return { resumo: {} }; }),
      Z.api('/api/admin/activity').catch(function () { return []; }),
      Z.api('/api/admin/sessions').catch(function () { return []; }),
    ]).then(function (r) {
      var o = r[0] || {}, vend = r[1] || {}, ativ = r[2] || [], ses = r[3] || [];
      var res = vend.resumo || {}, u = o.users || {}, p = o.projects || {}, sis = o.system || {}, cl = o.claude || {};

      var html = C.cab({
        trilha: 'Negócio · Painel do dono',
        icone: 'visao',
        titulo: 'Visão Geral',
        sub: 'O retrato do seu negócio agora: o que entrou, quem está usando e como a máquina está.',
        acoes: [C.btn('Atualizar', { icone: 'atualiza', acao: 'recarregar' })],
      });

      // ── Dinheiro (o que mais importa) ──
      html += '<span class="z-rotulo">Dinheiro</span>';
      html += C.stats([
        { rot: 'Receita do mês', num: Z.brl(res.mes), cap: (res.vendasMes || 0) + ' venda(s) confirmada(s)', icone: 'dinheiro', tom: res.mes > 0 ? 'ok' : '' },
        { rot: 'Receita total', num: Z.brl(res.total), cap: 'Desde o início', icone: 'receita' },
        { rot: 'Reembolsos', num: Z.num(res.reembolsos), cap: res.reembolsos ? 'Contas suspensas' : 'Nenhum até agora', icone: 'alerta', tom: res.reembolsos ? 'erro' : '' },
        { rot: 'Custo de IA acumulado', num: Z.usd(p.totalCostUsd), cap: 'Somando todos os projetos', icone: 'raio' },
      ]);

      // ── Produto ──
      html += '<span class="z-rotulo" style="margin-top:22px">Produto</span>';
      html += C.stats([
        { rot: 'Clientes', num: Z.num(u.total), cap: (u.admins || 0) + ' admin(s)', icone: 'clientes' },
        { rot: 'Projetos', num: Z.num(p.total), cap: (p.published || 0) + ' publicados · ' + (p.inTrash || 0) + ' na lixeira', icone: 'projetos' },
        { rot: 'Sessões de IA vivas', num: Z.num(ses.length), cap: ses.filter(function (s) { return s.running; }).length + ' trabalhando agora', icone: 'ia', tom: ses.length ? 'acento' : '' },
        { rot: 'Disco dos projetos', num: (p.diskMb > 1024 ? (p.diskMb / 1024).toFixed(1) + ' GB' : Z.num(p.diskMb) + ' MB'), cap: 'Espaço em uso', icone: 'caixa' },
      ]);

      html += '<div class="z-grid2" style="margin-top:22px">';

      // ── Motor / Claude ──
      var motorCorpo;
      if (cl.loggedIn) {
        motorCorpo =
          '<div class="z-linha" style="margin-bottom:13px">' + C.chipPonto('Conectado', 'ok') +
            (cl.subscriptionType ? C.chip(String(cl.subscriptionType).toUpperCase(), 'acento') : '') + '</div>' +
          '<div class="z-col" style="gap:7px">' +
            linha('Conta', Z.esc(cl.email || '—')) +
            linha('Método', Z.esc(cl.authMethod || '—')) +
            linha('Sessões abertas', Z.num(ses.length)) +
          '</div>';
      } else {
        motorCorpo = C.vazio({
          tom: 'erro', icone: 'alerta', tit: 'Claude Code desconectado',
          txt: 'Nenhum build funciona sem isso. Conecte a conta para o motor voltar a responder.',
          acao: C.btn('Ir para IA & Motor', { classe: 'primario', acao: 'ir-ia' }),
        });
      }
      html += C.card({ tit: 'Motor de IA', sub: 'Quem responde os builds dos seus clientes', corpo: motorCorpo });

      // ── Sistema ──
      html += C.card({
        tit: 'Servidor', sub: 'A máquina que hospeda tudo',
        corpo: '<div class="z-col" style="gap:7px">' +
          linha('No ar há', tempoDeVida(sis.uptimeSec)) +
          linha('Memória', Z.num(sis.memoryMb) + ' MB') +
          linha('Plataforma', Z.esc(sis.platform || '—') + ' · Node ' + Z.esc(sis.nodeVersion || '—')) +
          linha('Porta', Z.esc(sis.port || '—')) +
        '</div>',
      });
      html += '</div>';

      // ── Atividade ──
      var linhas = ativ.slice(0, 12).map(function (a) {
        return '<tr><td class="forte">' + Z.esc(rotuloEvento(a.type)) + '</td>' +
          '<td>' + Z.esc(a.user || (a.data && a.data.username) || '—') + '</td>' +
          '<td class="dir z-fg3">' + Z.desde(a.at) + '</td></tr>';
      });
      html += '<div style="margin-top:22px">' + C.card({
        tit: 'Atividade recente', sub: 'Os últimos acontecimentos do sistema',
        acoes: [C.btn('Ver tudo', { classe: 'mini', acao: 'ir-atividade' })],
        corpo: C.tabela(
          [{ t: 'Evento' }, { t: 'Quem' }, { t: 'Quando', dir: true }], linhas,
          { icone: 'atividade', vazioTit: 'Nada aconteceu ainda', vazioTxt: 'Os eventos aparecem aqui conforme o sistema é usado.' }),
      }) + '</div>';

      // Container próprio: o roteador reaproveita #z-conteudo, então prender
      // os cliques aqui evita empilhar ouvintes a cada visita à seção.
      alvo.innerHTML = '<div id="vs-raiz">' + html + '</div>';
      Z.ligarAcoes('vs-raiz', {
        'recarregar': function () { Z.recarregar(); },
        'ir-ia': function () { Z.irPara('ia'); },
        'ir-atividade': function () { Z.irPara('atividade'); },
      });
    });
  },
});

function linha(rot, val) {
  return '<div class="z-linha entre" style="font-size:12.5px">' +
    '<span class="z-fg3">' + rot + '</span><span class="z-fg2">' + val + '</span></div>';
}
function tempoDeVida(s) {
  s = Number(s) || 0;
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'min';
  if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'min';
  return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
}
var EVENTOS = {
  login: 'entrou no sistema', login_failed: 'tentativa de login falhou',
  login_blocked_suspenso: 'login bloqueado (suspenso)',
  project_created: 'criou um projeto', trash_purged: 'apagou da lixeira',
  trash_emptied: 'esvaziou a lixeira', admin_criado: 'conta admin criada',
  domain_added: 'domínio adicionado', domain_verified: 'domínio verificado',
  domain_removed: 'domínio removido', venda_hotmart: 'venda pela Hotmart',
  venda_hotmart_pendente: 'venda Hotmart sem plano', reembolso_hotmart: 'reembolso na Hotmart',
  venda_confirmada: 'venda confirmada', intencao_pix: 'cliente avisou Pix',
  admin_user_created: 'usuário criado', admin_user_updated: 'usuário editado',
  admin_user_deleted: 'usuário excluído', admin_user_suspenso: 'usuário suspenso',
  admin_user_reativado: 'usuário reativado', admin_billing_user: 'crédito/plano alterado',
  admin_billing_config: 'cobrança configurada', admin_ia_propria: 'IA própria alterada',
  ia_propria_conectada: 'conectou a própria IA', ia_propria_desconectada: 'desconectou a própria IA',
  admin_email_config: 'e-mail configurado', admin_webhook_hotmart_config: 'webhook configurado',
  admin_pix_config: 'Pix configurado', admin_link_acesso: 'link de acesso gerado',
  primeiro_acesso_concluido: 'definiu a senha', esqueci_senha_pedido: 'pediu redefinição de senha',
  admin_theme: 'aparência alterada', projeto_motor_alterado: 'trocou o motor do projeto',
};
function rotuloEvento(t) { return EVENTOS[t] || String(t || '').replace(/_/g, ' '); }
})();
