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
