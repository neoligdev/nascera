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

// Classifica UM arquivo (fora de qualquer agrupamento cross-file — ver
// Task 3 para CRUD). Ordem = mais específico primeiro; um arquivo que bate
// em mais de um padrão fica com o PRIMEIRO que casar.
function classificarArquivo(arquivo, contexto) {
  const caminho = normCaminho(arquivo.caminho);
  const conteudo = String(arquivo.conteudo || '');

  if (RE_PAGAMENTO.test(caminho) || RE_PAGAMENTO.test(conteudo)) return 'PAGAMENTO_CHECKOUT';
  if (RE_AUTH.test(caminho) || RE_AUTH.test(conteudo)) return 'LOGIN_CADASTRO';
  if (RE_UPLOAD.test(caminho) || RE_UPLOAD.test(conteudo)) return 'UPLOAD_STORAGE';
  if (RE_DASHBOARD.test(conteudo)) return 'DASHBOARD';
  if (RE_FORMULARIO.test(conteudo)) return 'FORMULARIO_VALIDACAO';
  if (RE_API_PATH.test(caminho)) return 'API';
  return null;   // Task 2 adiciona os padrões de tamanho/estilo/correção aqui
}

module.exports = { CREDITOS, _classificarArquivo: classificarArquivo };
