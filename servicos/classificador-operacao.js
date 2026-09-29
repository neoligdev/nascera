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

const path = require('path');

// ── CRUD (A.2): única categoria que correlaciona arquivos DIFERENTES do
// mesmo recurso — ex.: rotas/produtos.js + public/produtos.html. As demais
// categorias de agregado (landing/refatoração/módulo complexo) são
// deliberadamente aproximadas pela soma das categorias finas (ver nota no
// fim do arquivo) — CRUD ficou de fora dessa simplificação porque o doc já
// descreve um padrão de detecção concreto pra ela (linha da tabela A.2).
const RE_DIR_API = /(^|\/)(rotas|routes|api)\//i;
const RE_DIR_OUTRA_CAMADA = /(^|\/)(modelos|models|servicos|services|views|paginas|pages|componentes|components|public)\//i;

function slugRecurso(caminho) {
  return path.basename(normCaminho(caminho)).replace(/\.[^.]+$/, '').toLowerCase().replace(/[-_]/g, '');
}

// Devolve o Set de caminhos que pertencem a um grupo CRUD: ≥2 arquivos com
// o mesmo "slug de recurso" (nome de arquivo sem extensão), sendo pelo menos
// um numa pasta de API/rota e outro numa pasta de modelo/UI.
function detectarGruposCrud(arquivos) {
  const porSlug = new Map();
  for (const a of arquivos) {
    const slug = slugRecurso(a.caminho);
    if (!slug) continue;
    if (!porSlug.has(slug)) porSlug.set(slug, []);
    porSlug.get(slug).push(a);
  }
  const crudPaths = new Set();
  for (const grupo of porSlug.values()) {
    if (grupo.length < 2) continue;
    const temApi = grupo.some(a => RE_DIR_API.test(normCaminho(a.caminho)));
    const temOutraCamada = grupo.some(a => RE_DIR_OUTRA_CAMADA.test(normCaminho(a.caminho)));
    if (temApi && temOutraCamada) grupo.forEach(a => crudPaths.add(a.caminho));
  }
  return crudPaths;
}

// Dedup por caminho (a fonte real — ch._arquivosTocados em motor-canal.js —
// já é um Map deduplicado; isto é defesa extra pra classificar() nunca
// contar 2x um caminho repetido na entrada, seja qual for o chamador).
function dedupPorCaminho(arquivos) {
  const porCaminho = new Map();
  for (const a of arquivos) porCaminho.set(a.caminho, a);
  return Array.from(porCaminho.values());
}

// classificar(arquivosTocados, contextoProjeto) → { categorias, totalCreditos, arquivosSemCategoria }
function classificar(arquivosTocados, contextoProjeto) {
  const arquivos = dedupPorCaminho(Array.isArray(arquivosTocados) ? arquivosTocados : []);
  const contexto = contextoProjeto || {};
  const crudPaths = detectarGruposCrud(arquivos);
  const categorias = [];
  const arquivosSemCategoria = [];
  for (const a of arquivos) {
    const nome = crudPaths.has(a.caminho) ? 'CRUD' : classificarArquivo(a, contexto);
    if (!nome) { arquivosSemCategoria.push(a.caminho); continue; }
    categorias.push({ caminho: a.caminho, categoria: nome, creditos: CREDITOS[nome] });
  }
  const totalCreditos = categorias.reduce((soma, c) => soma + c.creditos, 0);
  return { categorias, totalCreditos, arquivosSemCategoria };
}

module.exports = {
  classificar, CREDITOS,
  _classificarArquivo: classificarArquivo, _detectarGruposCrud: detectarGruposCrud,
};

// NOTA (heurística v1, mesmo espírito da nota em planejamento-automatico.js):
// "Landing page completa" (17cr), "Refatoração grande" (36cr) e "Módulo
// complexo" (54cr) são categorias de AGREGADO/TAMANHO do turno inteiro (doc
// §5), não de um arquivo isolado. Em vez de um classificador de agregado à
// parte — que exigiria decidir limiares de contagem/tamanho sem nenhum dado
// real ainda (Risco #2 do doc) —, a v1 as APROXIMA pela soma das categorias
// finas por arquivo (3 arquivos "Página simples" somam 24, próximo do que
// uma landing cobraria fixo). ponytail: se a telemetria mostrar divergência
// grande entre a soma e o preço fixo do agregado, criar um passo extra em
// classificar() que primeiro checa limiares de contagem/tamanho do TURNO e,
// se baterem, substitui a soma pelo valor fixo — sem tocar na classificação
// por arquivo já validada.
