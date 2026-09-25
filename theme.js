// ═══════════════════════════════════════════════════════════════════════
// NASCERA — Aparência (tema do sistema)
//
// As cores do NASCERA estavam cravadas em centenas de lugares
// (`rgba(153,255,0,.3)`, `#C4F877`, …). Aqui elas viram VARIÁVEIS: os HTMLs
// passaram a usar `rgba(var(--zh-accent-rgb), .3)` e este módulo serve o
// arquivo que dá valor a essas variáveis.
//
// Por que servir CSS em vez de escrever nos HTMLs: trocar uma cor não pode
// exigir editar arquivo nenhum — o dono mexe no painel e a próxima requisição
// já vem com a cor nova. E se o tema estiver corrompido, o padrão volta.
//
// O vídeo do buraco negro é tratado por filtro CSS (hue/saturação/brilho),
// que é o único jeito de recolorir vídeo sem reprocessar o arquivo.
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const THEME_FILE = path.join(__dirname, 'theme.json');
// Imagens enviadas pelo painel. Fica dentro de public/ porque o express já
// serve essa pasta — o arquivo enviado vira URL sem precisar de rota nova.
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const MAX_UPLOAD = 5 * 1024 * 1024;   // 5 MB

// Os valores ORIGINAIS do sistema. Mudar aqui muda o "Restaurar padrão".
const DEFAULTS = {
  colors: {
    accent:    '#99FF00',   // verde principal (da marca Nascera) — botões, destaques, foco
    accent2:   '#C4F877',   // verde claro — links, ícones, texto de realce
    grad1:     '#C0FF9C',   // ponta clara do gradiente dos títulos
    grad2:     '#FFDF9C',   // ponta quente do gradiente dos títulos
    bg:        '#030014',   // fundo profundo do sistema
    surface:   '#0b0718',   // cartões e barras
    text:      '#ffffff',   // texto principal
    success:   '#4ade80',
    danger:    '#f87171',
    warning:   '#fbbf24',
    info:      '#60a5fa',
  },
  video: {
    enabled: true,
    hue: 174,        // graus  (-180 a 180) — recolore o buraco negro (roxo) para o verde da marca
    saturation: 100, // %      (0 a 300)
    brightness: 100, // %      (0 a 200)
    contrast: 100,   // %      (0 a 200)
    blur: 0,         // px     (0 a 20)
    opacity: 100,    // %      (0 a 100)
  },
  images: {
    logo: '/logo.png',
    favicon: '/favicon.png',
    heroSkills: '/skills-bg.png',
    loading: '/bgloading.png',
  },
  ui: {
    radius: 12,        // px — raio dos cartões
    glow: 100,         // % — intensidade dos brilhos verdes
  },
};

function clonar(o) { return JSON.parse(JSON.stringify(o)); }

function mesclar(base, novo) {
  const out = clonar(base);
  for (const secao of Object.keys(base)) {
    if (novo && typeof novo[secao] === 'object' && novo[secao]) {
      for (const k of Object.keys(base[secao])) {
        if (novo[secao][k] !== undefined) out[secao][k] = novo[secao][k];
      }
    }
  }
  return out;
}

let _cache = null;
let _mtime = 0;
function getTheme() {
  let mtime = 0;
  try { mtime = fs.statSync(THEME_FILE).mtimeMs; } catch {}
  if (_cache && mtime === _mtime) return _cache;
  let salvo = {};
  try { salvo = JSON.parse(fs.readFileSync(THEME_FILE, 'utf8')); } catch {}
  _cache = mesclar(DEFAULTS, salvo);
  _mtime = mtime;
  return _cache;
}

function saveTheme(parcial) {
  const atual = getTheme();
  const novo = mesclar(atual, parcial || {});
  validar(novo);
  fs.writeFileSync(THEME_FILE, JSON.stringify(novo, null, 2));
  try { _mtime = fs.statSync(THEME_FILE).mtimeMs; } catch {}
  _cache = novo;
  return novo;
}

function resetTheme() {
  try { fs.rmSync(THEME_FILE, { force: true }); } catch {}
  _cache = null; _mtime = 0;
  const t = getTheme();
  limparOrfaos(t);   // as imagens enviadas viraram lixo: o padrão não aponta para elas
  return t;
}

// ── upload de imagem ──────────────────────────────────────────────────
// Não dá para confiar no nome nem no Content-Type que o navegador manda:
// a extensão é decidida pelos BYTES do arquivo. SVG fica de fora de
// propósito — SVG executa script, e serviríamos ele na nossa própria origem.
const ASSINATURAS = [
  { ext: 'png',  bate: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: 'jpg',  bate: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif',  bate: b => b.slice(0, 3).toString('latin1') === 'GIF' },
  { ext: 'webp', bate: b => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' },
  { ext: 'ico',  bate: b => b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00 },
];

function salvarImagem(chave, buffer) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS.images, chave)) {
    throw new Error(`Imagem desconhecida: "${chave}"`);
  }
  if (!buffer || !buffer.length) throw new Error('Arquivo vazio — escolha uma imagem');
  if (buffer.length > MAX_UPLOAD) throw new Error('Imagem muito grande — o limite é 5 MB');

  const tipo = ASSINATURAS.find(a => buffer.length > 12 && a.bate(buffer));
  if (!tipo) throw new Error('Formato não suportado — envie PNG, JPG, WEBP, GIF ou ICO');

  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  // Nome novo a cada envio: o express serve public/ com cache "immutable",
  // então reaproveitar o nome deixaria o navegador mostrando a imagem velha.
  const nome = `${chave}-${Date.now().toString(36)}.${tipo.ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, nome), buffer);

  const t = saveTheme({ images: { [chave]: '/uploads/' + nome } });
  limparOrfaos(t);
  return { url: '/uploads/' + nome, theme: t };
}

// Só sobrevive em uploads/ o que o tema atual usa. Sem isso, cada troca de
// logo deixaria um arquivo para sempre no disco do servidor.
function limparOrfaos(t) {
  try {
    const usadas = new Set(Object.values(t.images).map(v => String(v).replace('/uploads/', '')));
    for (const nome of fs.readdirSync(UPLOADS_DIR)) {
      if (!usadas.has(nome)) fs.rmSync(path.join(UPLOADS_DIR, nome), { force: true });
    }
  } catch {}   // pasta ainda não existe — nada a limpar
}

// ── validação: um valor inválido aqui quebra a tela inteira ──
const HEX = /^#[0-9a-fA-F]{6}$/;
function validar(t) {
  for (const [k, v] of Object.entries(t.colors)) {
    if (!HEX.test(String(v))) throw new Error(`Cor inválida em "${k}": use #rrggbb`);
  }
  const faixas = {
    hue: [-180, 180], saturation: [0, 300], brightness: [0, 200],
    contrast: [0, 200], blur: [0, 20], opacity: [0, 100],
  };
  for (const [k, [min, max]] of Object.entries(faixas)) {
    const v = Number(t.video[k]);
    if (!Number.isFinite(v) || v < min || v > max) throw new Error(`Vídeo: "${k}" deve ficar entre ${min} e ${max}`);
    t.video[k] = v;
  }
  t.video.enabled = !!t.video.enabled;
  for (const [k, v] of Object.entries(t.images)) {
    const s = String(v || '').trim();
    // caminho local ou URL http(s) — nada de javascript:, data: etc.
    if (s && !/^\/[\w\-./]*$/.test(s) && !/^https?:\/\//i.test(s)) {
      throw new Error(`Imagem inválida em "${k}": use um caminho como /logo.png ou uma URL https`);
    }
    t.images[k] = s;
  }
  const r = Number(t.ui.radius);
  if (!Number.isFinite(r) || r < 0 || r > 40) throw new Error('Raio deve ficar entre 0 e 40');
  t.ui.radius = r;
  const g = Number(t.ui.glow);
  if (!Number.isFinite(g) || g < 0 || g > 200) throw new Error('Brilho deve ficar entre 0 e 200');
  t.ui.glow = g;
  return t;
}

// ── hex → "r,g,b" (as variáveis precisam dos componentes soltos, porque o
//    sistema usa rgba(var(--x), .3) com alfa variável em cada lugar) ──
function hexRgb(hex) {
  const h = String(hex).replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ].join(',');
}

// ── o CSS que o navegador recebe ──
function themeCss() {
  const t = getTheme();
  const c = t.colors, v = t.video;
  const filtros = [
    v.hue ? `hue-rotate(${v.hue}deg)` : '',
    v.saturation !== 100 ? `saturate(${v.saturation}%)` : '',
    v.brightness !== 100 ? `brightness(${v.brightness}%)` : '',
    v.contrast !== 100 ? `contrast(${v.contrast}%)` : '',
    v.blur ? `blur(${v.blur}px)` : '',
  ].filter(Boolean).join(' ') || 'none';

  return `/* NASCERA — aparência (gerado; edite pelo painel em Admin → Aparência) */
:root {
  --zh-accent: ${c.accent};
  --zh-accent-rgb: ${hexRgb(c.accent)};
  --zh-accent2: ${c.accent2};
  --zh-accent2-rgb: ${hexRgb(c.accent2)};
  --zh-grad1: ${c.grad1};
  --zh-grad1-rgb: ${hexRgb(c.grad1)};
  --zh-grad2: ${c.grad2};
  --zh-grad2-rgb: ${hexRgb(c.grad2)};
  --zh-bg: ${c.bg};
  --zh-bg-rgb: ${hexRgb(c.bg)};
  --zh-surface: ${c.surface};
  --zh-surface-rgb: ${hexRgb(c.surface)};
  --zh-text: ${c.text};
  --zh-text-rgb: ${hexRgb(c.text)};
  --zh-success: ${c.success};
  --zh-danger: ${c.danger};
  --zh-warning: ${c.warning};
  --zh-info: ${c.info};
  --zh-radius: ${t.ui.radius}px;
  --zh-glow: ${t.ui.glow / 100};
}

/* Vídeo do buraco negro — recolorido por filtro (não reprocessa o arquivo) */
.hero-video-bg {
  filter: ${filtros};
  opacity: ${v.opacity / 100};
  ${v.enabled ? '' : 'display: none;'}
}
`;
}

module.exports = {
  DEFAULTS, MAX_UPLOAD,
  getTheme, saveTheme, resetTheme, salvarImagem, themeCss, hexRgb,
  _reload: () => { _cache = null; },
};
