// testes/motor-canal-creditos-fixos.test.js
// Rodar: node --test testes/motor-canal-creditos-fixos.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { criar } = require('../servicos/motor-canal.js');

function deps() {
  return {
    channels: new Map(), appendChatMessage: () => {}, loadProjects: () => [], saveProjects: () => {},
    billing: { getConfig: () => ({ precoFixoAtivo: true }) },
    classificadorOperacao: require('../servicos/classificador-operacao.js'),
    planejamentoAutomatico: { pareceCorrecao: (m) => /conserta|corrige/i.test(String(m || '')) },
  };
}

test('montarCreditosFixos: soma os créditos quando o toggle está ligado e há arquivo reconhecido', () => {
  const { _montarCreditosFixos } = criar(deps());
  const arquivos = [{ caminho: 'componentes/Novo.jsx', tool: 'Write', conteudo: 'x', tamanhoAntes: 0, tamanhoDepois: 5 }];
  const cfg = { precoFixoAtivo: true };
  assert.equal(_montarCreditosFixos(cfg, arquivos, 'crie um componente novo'), 5);
});

test('montarCreditosFixos: toggle desligado nunca monta creditosFixos', () => {
  const { _montarCreditosFixos } = criar(deps());
  const arquivos = [{ caminho: 'componentes/Novo.jsx', tool: 'Write', conteudo: 'x', tamanhoAntes: 0, tamanhoDepois: 5 }];
  const cfg = { precoFixoAtivo: false };
  assert.equal(_montarCreditosFixos(cfg, arquivos, 'crie um componente novo'), undefined);
});

test('montarCreditosFixos: turno sem arquivo tocado não monta nada mesmo com o toggle ligado', () => {
  const { _montarCreditosFixos } = criar(deps());
  const cfg = { precoFixoAtivo: true };
  assert.equal(_montarCreditosFixos(cfg, [], 'qualquer coisa'), undefined);
});

test('montarCreditosFixos: nenhum arquivo reconhecido cai no fallback (undefined)', () => {
  const { _montarCreditosFixos } = criar(deps());
  const arquivos = [{ caminho: 'notas/x.md', tool: 'Edit', conteudo: 'texto sem sinal'.repeat(50), tamanhoAntes: 5000, tamanhoDepois: 5000 }];
  const cfg = { precoFixoAtivo: true };
  assert.equal(_montarCreditosFixos(cfg, arquivos, ''), undefined);
});

// Achado da revisão (Important #6): o nome do PROJETO (pasta) não pode
// poluir a categoria — montarCreditosFixos precisa repassar a raiz do
// projeto pro classificador relativizar o caminho antes de comparar.
test('montarCreditosFixos: repassa raizProjeto pro classificador (nome do projeto não conta como sinal de categoria)', () => {
  const { _montarCreditosFixos } = criar(deps());
  const arquivos = [{ caminho: '/projetos/loja-checkout/paginas/sobre.html', tool: 'Write', conteudo: '<h1>Sobre</h1>', tamanhoAntes: 0, tamanhoDepois: 30 }];
  const cfg = { precoFixoAtivo: true };
  // Sem raiz: "checkout" no caminho pesa, PAGAMENTO_CHECKOUT = 27.
  assert.equal(_montarCreditosFixos(cfg, arquivos, ''), 27);
  // Com raiz: só o caminho relativo entra, PAGINA_SIMPLES = 8.
  assert.equal(_montarCreditosFixos(cfg, arquivos, '', '/projetos/loja-checkout'), 8);
});
