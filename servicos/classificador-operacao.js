// servicos/classificador-operacao.js
//
// Classificador de RESULTADO (pós-turno, Fase 2, doc §5): dado o conjunto de
// arquivos tocados por um turno (Write/Edit/MultiEdit/NotebookEdit),
// devolve, por arquivo, qual categoria comercial foi entregue. Mesmo espírito
// do classificador de servicos/planejamento-automatico.js: heurística v1
// simples por padrão de arquivo/conteúdo, sem custo de IA, documentada como
// recalibrável com telemetria real — não vale a complexidade de IA agora.
//
// Entrada por arquivo (montada por servicos/motor-canal.js a partir dos
// eventos `tool_use`, sem git diff):
//   { caminho: string, tool: 'Write'|'Edit'|'MultiEdit'|'NotebookEdit',
//     conteudo: string, tamanhoAntes: number, tamanhoDepois: number }
// `conteudo` é o texto novo relevante pra regex de padrão (o `content` do
// Write; a concatenação dos `new_string` do Edit/MultiEdit).

const CREDITOS = {
  ALTERAR_TEXTO: 2,
  ALTERAR_ESTILO: 3,
  REMOVER_COMPONENTE: 3,
  CRIAR_COMPONENTE: 5,
  PAGINA_SIMPLES: 8,
  FORMULARIO_VALIDACAO: 10,
  LOGIN_CADASTRO: 14,
  CORRECAO_MEDIA: 14,
  UPLOAD_STORAGE: 16,
  API: 20,
  CRUD: 22,
  DASHBOARD: 25,
  PAGAMENTO_CHECKOUT: 27,
};

const RE_PAGAMENTO = /pagamento|checkout|payment|gateway|stripe|mercadopago|mercado[-_]?pago|hotmart|kiwify|asaas/i;
const RE_AUTH = /\bauth\b|autenticacao|autentica[çc][aã]o|\blogin\b|cadastro|\bsenha\b|password|signup|signin/i;
const RE_UPLOAD = /upload|storage|multer|presigned|multipart\/form-data|\bs3\./i;
const RE_DASHBOARD = /chart\.js|recharts|apexcharts|d3\.|<canvas|dashboard[-_]?widget|gr[aá]fico/i;
const RE_FORMULARIO = /<form[\s>]|type=["']submit["']|\brequired\b|\.validate\(|yup\.|zod\.|schema\.validate/i;
const RE_API_PATH = /(^|[\\/])(rotas|routes|api)[\\/]/i;

function normCaminho(c) { return String(c || '').replace(/\\/g, '/'); }

// Limiares da heurística v1 (arbitrários — Risco #2 do doc: "página simples"
// vs. "landing" vs. "módulo complexo" têm fronteira nebulosa por natureza;
// estes valores são o ponto de partida, ajustável depois de medir telemetria
// real, sem precisar reabrir o classificador).
const LIMIAR_DIFF_PEQUENO = 200;    // chars: acima disso não é mais "ajuste de texto"
const LIMIAR_REMOCAO_MIN = 80;      // chars removidos p/ contar como "remoção de bloco"
const LIMIAR_REMOCAO_RATIO = 0.5;   // tamanhoDepois precisa ser <= 50% do tamanhoAntes

const RE_CSS_PATH = /\.(css|scss|less)$/i;
const RE_CSS_INLINE = /style=\{|<style[\s>]/i;
const RE_COMPONENTE_PATH = /(^|[\\/])(componentes|components)[\\/]/i;
const RE_PAGINA_PATH = /(^|[\\/])(paginas|pages)[\\/]|\.html$/i;

// Classifica UM arquivo (fora de qualquer agrupamento cross-file — ver
// Task 3 para CRUD). Ordem = mais específico primeiro; um arquivo que bate
// em mais de um padrão fica com o PRIMEIRO que casar.
function classificarArquivo(arquivo, contexto) {
  const caminho = normCaminho(arquivo.caminho);
  const conteudo = String(arquivo.conteudo || '');
  const criado = arquivo.tool === 'Write';
  const antes = arquivo.tamanhoAntes || 0;
  const depois = arquivo.tamanhoDepois || 0;

  if (RE_PAGAMENTO.test(caminho) || RE_PAGAMENTO.test(conteudo)) return 'PAGAMENTO_CHECKOUT';
  if (RE_AUTH.test(caminho) || RE_AUTH.test(conteudo)) return 'LOGIN_CADASTRO';
  if (RE_UPLOAD.test(caminho) || RE_UPLOAD.test(conteudo)) return 'UPLOAD_STORAGE';
  if (RE_DASHBOARD.test(conteudo)) return 'DASHBOARD';
  if (RE_FORMULARIO.test(conteudo)) return 'FORMULARIO_VALIDACAO';
  if (RE_API_PATH.test(caminho)) return 'API';

  // Daqui pra baixo só se aplica a EDIT (arquivo já existia) — Write cai nas
  // categorias de criação mais abaixo.
  if (!criado) {
    if (RE_CSS_PATH.test(caminho) || RE_CSS_INLINE.test(conteudo)) return 'ALTERAR_ESTILO';
    if (antes >= LIMIAR_REMOCAO_MIN && depois <= antes * LIMIAR_REMOCAO_RATIO) return 'REMOVER_COMPONENTE';
  }

  if (criado && RE_COMPONENTE_PATH.test(caminho)) return 'CRIAR_COMPONENTE';
  if (criado && RE_PAGINA_PATH.test(caminho)) return 'PAGINA_SIMPLES';

  // "Correção média" reaproveita o sinal do classificador de planejamento
  // (contexto.pedidoDeCorrecao) — só depois de estilo/remoção/criação/página,
  // porque essas são sinais mais específicos sobre O QUE mudou; correção é
  // o "catch-all" de um pedido de fix que não é nenhuma delas.
  if (!criado && contexto && contexto.pedidoDeCorrecao) return 'CORRECAO_MEDIA';

  if (!criado && depois <= LIMIAR_DIFF_PEQUENO) return 'ALTERAR_TEXTO';

  return null;   // nenhum padrão bate — cai no fallback de custo real
}

module.exports = { CREDITOS, _classificarArquivo: classificarArquivo };
