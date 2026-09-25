// ═══════════════════════════════════════════════════════════════════════
// NASCERA — Motor de créditos (estrutura do X8 OS)
//
// "O crédito é um teto de gasto em dólar, vestido de moeda."
//
// Quatro unidades, cada uma no seu lugar:
//   USD          → ledger e eventos (precisão de 6 casas; é o que custa de verdade)
//   milicrédito  → inteiro; cortesias, saldo, tudo que a API devolve
//   crédito      → 1000 milli; o que o usuário entende
//   BRL          → os planos
//
// Fluxo por turno:  PORTÃO (antes, allow/block) → GATEWAY (o motor gasta)
//                   → DÉBITO (USD→milli, cortesia primeiro, resto vira gasto USD)
//
// Regras herdadas do doc (e dos bugs que ele documenta):
//  - O enforcement é NO SERVIDOR. Aqui o portão é fechadura de verdade,
//    porque o NASCERA é o próprio gateway.
//  - O gasto registrado sai do USD REAL menos o que a cortesia cobriu — nunca
//    do milicrédito arredondado (senão turno pequeno sai de graça).
//  - Janelas diária/mensal zeram no FUSO do escopo, com reset preguiçoso.
//  - Débito idempotente por turnId (retry não cobra duas vezes).
//  - Exibição (§3.1): disponível = remaining do ciclo se finito; senão
//    max(0, saldo, maior cortesia ativa). NUNCA a soma.
//  - O teto mensal aplicado = créditos do plano × taxa (plano e teto amarrados).
//  - Nenhum plano pago pode ter ≤ 20 créditos (limiar de free do cliente).
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const logger = require('./log.js');
const path = require('path');
const crypto = require('crypto');
// Escrita atômica + leitura que não mascara corrupção do arquivo do dinheiro.
const { gravaEstado, leEstado } = require('./estado-seguro.js');
const billingDb = require('./billing-db.js');

const CONFIG_FILE = path.join(__dirname, 'nascera-config.json');
const BILLING_FILE = path.join(__dirname, 'billing.json');
const EVENTS_FILE = path.join(__dirname, 'usage-events.jsonl');

// Enum fechado do portão — valor fora da lista invalida a decisão (doc §2.1)
const REASONS = ['ok', 'session', 'daily', 'weekly', 'monthly', 'trial_expired', 'access_expired',
  'user_limit', 'company_pool', 'grant_expired', 'no_active_credits', 'credit_check_unavailable'];

// Janela de sessão no modelo Claude: 5 horas rolantes a partir do 1º uso
const SESSION_MS = 5 * 60 * 60 * 1000;

// A mensagem de bloqueio é INTERFACE (doc §3.3) — não mudar o texto sem
// atualizar quem a reconhece.
const BLOCK_MESSAGE = 'Você ultrapassou seu limite de créditos. Fale com o administrador ou aguarde a virada do ciclo.';

const DEFAULT_PLANS = [
  { slug: 'free',    name: 'Free',              priceBrl: 0,    creditsPerMonth: 10 },
  { slug: 'pro',     name: 'Pro / Individual',  priceBrl: 600,  creditsPerMonth: 250 },
  { slug: 'max',     name: 'Max',               priceBrl: 1200, creditsPerMonth: 550 },
  { slug: 'piloto',  name: 'Piloto (até 5)',    priceBrl: 1500, creditsPerMonth: 750 },
  { slug: 'empresa', name: 'Empresa (5–10)',    priceBrl: 3000, creditsPerMonth: 1500 },
];

// Custo BASE por milhão de tokens (US$) — preços da Anthropic (ago/2026).
// O `id` é casado por SUBSTRING contra o model id real do SDK e o casamento
// mais ESPECÍFICO (id mais longo) vence: 'opus-5' ganha de 'opus' para
// 'claude-opus-5', então versões separadas convivem na lista.
// Cache leitura = 10% da entrada; escrita = 1.25× a entrada.
// markup 0 = usa o defaultMarkup da config.
const DEFAULT_MODELS = [
  { id: 'fable',    name: 'Claude Fable 5',    inMtok: 10, outMtok: 50, cacheReadMtok: 1,   cacheWriteMtok: 12.5, markup: 0 },
  { id: 'opus-5',   name: 'Claude Opus 5',     inMtok: 5,  outMtok: 25, cacheReadMtok: 0.5, cacheWriteMtok: 6.25, markup: 0 },
  { id: 'opus-4',   name: 'Claude Opus 4.x',   inMtok: 5,  outMtok: 25, cacheReadMtok: 0.5, cacheWriteMtok: 6.25, markup: 0 },
  { id: 'sonnet-5', name: 'Claude Sonnet 5',   inMtok: 3,  outMtok: 15, cacheReadMtok: 0.3, cacheWriteMtok: 3.75, markup: 0 },
  { id: 'sonnet-4', name: 'Claude Sonnet 4.x', inMtok: 3,  outMtok: 15, cacheReadMtok: 0.3, cacheWriteMtok: 3.75, markup: 0 },
  { id: 'haiku',    name: 'Claude Haiku 4.5',  inMtok: 1,  outMtok: 5,  cacheReadMtok: 0.1, cacheWriteMtok: 1.25, markup: 0 },
];

// ── config (vive em nascera-config.json, chave "billing") ──
function defaultConfig() {
  return {
    mode: 'off',                      // 'off' | 'subscription' | 'credits'
    usdPerCredit: 0.20,               // conversão das cortesias/saldo (1 cr = US$)
    defaultDailyLimitUsd: 10,         // teto diário padrão (US$)
    timezone: 'America/Sao_Paulo',    // as janelas viram NESTE fuso
    defaultMarkup: 2,                 // multiplicador cobrado sobre o custo base (≥1: nunca abaixo do custo)
    usdToBrl: 5.5,                    // câmbio p/ converter preço do plano em consumo
    sessionsPerWeek: 5,               // quantas janelas de 5h cheias cabem numa semana
    models: DEFAULT_MODELS,           // custo base + markup por modelo
    plans: DEFAULT_PLANS,
  };
}

function getConfig() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  const cfg = { ...defaultConfig(), ...(raw.billing || {}) };
  if (!Array.isArray(cfg.plans) || !cfg.plans.length) cfg.plans = DEFAULT_PLANS;
  if (!Array.isArray(cfg.models) || !cfg.models.length) cfg.models = DEFAULT_MODELS;
  // INVARIANTE do produto: markup nunca abaixo de 1× — no mínimo repassa o custo
  if (!(cfg.defaultMarkup >= 1)) cfg.defaultMarkup = 1;
  if (!(cfg.usdToBrl > 0)) cfg.usdToBrl = 5.5;
  if (!(cfg.sessionsPerWeek >= 1)) cfg.sessionsPerWeek = 5;
  // fuso inválido derrubaria TODO gate/débito/summary — valida e cai no padrão
  try { new Intl.DateTimeFormat('en', { timeZone: cfg.timezone }); }
  catch { cfg.timezone = 'America/Sao_Paulo'; }
  return cfg;
}

// ── precificação por modelo ──
// Casa o id configurado por substring contra o model id real do SDK.
// O casamento mais específico (id mais longo) vence: 'opus-5' > 'opus'.
function modelRowFor(cfg, modelId) {
  const mid = String(modelId || '').toLowerCase();
  let best = null;
  for (const m of cfg.models) {
    const id = String(m.id).toLowerCase();
    if (!mid.includes(id)) continue;
    if (!best || id.length > String(best.id).length) best = m;
  }
  return best;
}

function markupOf(cfg, row) {
  const mk = (row && row.markup > 0) ? row.markup : cfg.defaultMarkup;
  // nunca vender abaixo do custo: markup mínimo é 1× (repasse puro)
  return Math.max(1, mk);
}

// Precifica o DELTA de um turno. modelDeltas = { modelId: {inputTokens,
// outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD} }.
// Modelo fora da tabela cai no costUSD do próprio SDK (que já sabe o preço).
// Sem modelDeltas, cai no custo real do turno com o markup padrão.
function priceTurn(cfg, modelDeltas, fallbackCostUsd) {
  const perModel = [];
  let baseUsd = 0, chargedUsd = 0;
  const entries = modelDeltas ? Object.entries(modelDeltas) : [];
  for (const [modelId, d] of entries) {
    const row = modelRowFor(cfg, modelId);
    let base;
    if (row) {
      base = ((d.inputTokens || 0) * row.inMtok
        + (d.outputTokens || 0) * row.outMtok
        + (d.cacheReadInputTokens || 0) * (row.cacheReadMtok || 0)
        + (d.cacheCreationInputTokens || 0) * (row.cacheWriteMtok || 0)) / 1e6;
    } else {
      base = Math.max(0, d.costUSD || 0);
    }
    const mk = markupOf(cfg, row);
    const charged = base * mk;
    if (base <= 0 && charged <= 0) continue;
    perModel.push({ model: modelId, baseUsd: r6(base), chargedUsd: r6(charged), markup: mk });
    baseUsd += base;
    chargedUsd += charged;
  }
  if (!entries.length) {
    baseUsd = Math.max(0, fallbackCostUsd || 0);
    chargedUsd = baseUsd * markupOf(cfg, null);   // clampado: nunca abaixo do custo
  } else {
    // PISO do custo real: se a tabela precificou MENOS do que o turno custou
    // de verdade (linha zerada, modelo sem costUSD, web search etc.), o
    // déficit entra com o markup padrão. Invariante: nunca abaixo do custo.
    const fb = Math.max(0, fallbackCostUsd || 0);
    const deficit = r6(Math.max(0, fb - baseUsd));
    if (deficit > 0) {
      const mk = markupOf(cfg, null);
      baseUsd += deficit;
      chargedUsd += deficit * mk;
      perModel.push({ model: '(custo não mapeado)', baseUsd: deficit, chargedUsd: r6(deficit * mk), markup: mk });
    }
  }
  return { baseUsd: r6(baseUsd), chargedUsd: r6(chargedUsd), perModel };
}

function r6(v) { return Math.round(v * 1e6) / 1e6; }

// ── Consumo liberado: DERIVADO da mensalidade (modelo Claude) ──
// O preço do plano convertido em US$ É o orçamento de uso cobrado do mês.
// Como cobrado = base × markup e markup ≥ 1, o custo real no consumo total
// nunca passa da receita: NUNCA fica negativo — no mínimo repassa o custo.
// bonusUsd é subsídio deliberado (free/trial); plano zerado herda os
// créditos legados (free 10cr × taxa) como cortesia de entrada.
function planMonthCapUsd(cfg, plan) {
  const cap = (plan.priceBrl || 0) / cfg.usdToBrl + (plan.bonusUsd || 0);
  if (cap > 0) return r6(cap);
  return r6((plan.creditsPerMonth || 0) * cfg.usdPerCredit);
}
function planWeekCapUsd(cfg, plan) {
  return r6(planMonthCapUsd(cfg, plan) / 4);
}
function planSessionCapUsd(cfg, plan) {
  return r6(planWeekCapUsd(cfg, plan) / (cfg.sessionsPerWeek || 5));
}

// ── estado (billing.json) ──
let _state = null;
let _stateMtime = 0;
function loadState() {
  // Relê se o arquivo mudou por fora (edição manual, script, outro processo) —
  // senão o cache serviria saldo velho.
  let mtime = 0;
  try { mtime = fs.statSync(BILLING_FILE).mtimeMs; } catch {}
  if (_state && mtime === _stateMtime) return _state;
  // Crítico: NÃO devolver {accounts:{}} por corrupção — isso zera o saldo de
  // todos no próximo saveState. ENOENT (instalação nova) segue como vazio.
  _state = leEstado(BILLING_FILE, { fallback: { accounts: {} }, critico: true });
  if (!_state.accounts) _state.accounts = {};
  _stateMtime = mtime;
  return _state;
}
function saveState() {
  if (!_state) return;
  gravaEstado(BILLING_FILE, _state);
  try { _stateMtime = fs.statSync(BILLING_FILE).mtimeMs; } catch {}
}

// S0-9: username normalizado a minúsculas aqui, no único ponto que cria/lê
// conta. No Postgres a coluna é CITEXT (case-insensitive); no JSON a chave era
// sensível, então 'Ana' e 'ana' viravam DUAS contas de um lado e UMA do outro
// — divergência de dinheiro garantida no dia da virada. Normalizar aqui faz os
// dois lados concordarem. (Os usernames de hoje já são minúsculos: no-op para
// os dados atuais, blindagem para o futuro.)
function normU(u) { return String(u == null ? '' : u).toLowerCase(); }

function account(username) {
  username = normU(username);
  const st = loadState();
  if (!st.accounts[username]) {
    st.accounts[username] = {
      plan: 'free',
      balanceMilli: 0,                 // créditos avulsos (inteiro)
      grants: [],                      // [{id,label,remainingMilli,expiresAt|null}]
      spend: {
        session: { startTs: null, usd: 0, baseUsd: 0, chargedUsd: 0 },
        day: { key: null, usd: 0, baseUsd: 0, chargedUsd: 0 },
        week: { key: null, usd: 0, baseUsd: 0, chargedUsd: 0 },
        month: { key: null, usd: 0, baseUsd: 0, chargedUsd: 0 },
      },
      debitedTurns: {},                // idempotência: { turnId: timestamp }
      createdAt: new Date().toISOString(),
    };
  }
  return st.accounts[username];
}

// ── unidades ──
function usdToMilli(usd, cfg) {
  return Math.round((usd / (cfg || getConfig()).usdPerCredit) * 1000);
}
function milliToUsd(milli, cfg) {
  return (milli / 1000) * (cfg || getConfig()).usdPerCredit;
}

// ── janelas no fuso do escopo, reset preguiçoso ──
function tzParts(tz, date) {
  const d = date || new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const [y, m, day] = fmt.format(d).split('-');
  return { y: +y, m: +m, d: +day };
}
function dayKey(tz) { const p = tzParts(tz); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; }
function monthKey(tz) { const p = tzParts(tz); return `${p.y}-${String(p.m).padStart(2, '0')}`; }

// Offset real do fuso naquele instante (meio-dia evita bordas de DST).
// Substitui o antigo "3h fixo" que só valia para GMT-3.
function tzOffsetMs(tz, y, m, d) {
  const probe = Date.UTC(y, m - 1, d, 12);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date(probe))) parts[p.type] = p.value;
  const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +(parts.hour % 24 || parts.hour), +parts.minute);
  return local - probe;   // positivo a leste de UTC, negativo a oeste
}
// Instante UTC em que o fuso bate 00:00 do dia (y,m,d)
function tzMidnightIso(tz, y, m, d) {
  return new Date(Date.UTC(y, m - 1, d) - tzOffsetMs(tz, y, m, d)).toISOString();
}
function dayEndIso(tz) {
  const p = tzParts(tz);
  const next = new Date(Date.UTC(p.y, p.m - 1, p.d) + 86400000);
  return tzMidnightIso(tz, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}
// Semana no modelo Claude Code: janela de calendário que vira toda segunda
// 00:00 no fuso. A chave é a data da segunda-feira daquela semana.
function weekMonday(tz) {
  const p = tzParts(tz);
  const utc = Date.UTC(p.y, p.m - 1, p.d);
  const dow = new Date(utc).getUTCDay();          // 0=domingo
  const back = (dow + 6) % 7;                     // dias desde a segunda
  return new Date(utc - back * 86400000);
}
function weekKey(tz) {
  const d = weekMonday(tz);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function weekEndIso(tz) {
  const d = new Date(weekMonday(tz).getTime() + 7 * 86400000);
  // próxima segunda 00:00 NO FUSO configurado (offset real, não GMT-3 fixo)
  return tzMidnightIso(tz, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}
function monthEndIso(tz) {
  const p = tzParts(tz);
  // primeiro dia do mês seguinte, 00:00 NO FUSO configurado
  const next = p.m === 12 ? { y: p.y + 1, m: 1 } : { y: p.y, m: p.m + 1 };
  return tzMidnightIso(tz, next.y, next.m, 1);
}

function lazyReset(acct, cfg) {
  const dk = dayKey(cfg.timezone), wk = weekKey(cfg.timezone), mk = monthKey(cfg.timezone);
  // sessão de 5h rolante (modelo Claude): abre no 1º uso, expira 5h depois.
  // Sessão malformada (gasto sem startTs) também reseta — senão vira um
  // bloqueio 'session' que nunca expira.
  const s = acct.spend.session;
  if (!s || typeof s.usd !== 'number'
    || (s.usd > 0 && !s.startTs)
    || (s.startTs && Date.now() - s.startTs >= SESSION_MS)) {
    acct.spend.session = { startTs: null, usd: 0, baseUsd: 0, chargedUsd: 0 };
  }
  if (acct.spend.day.key !== dk) acct.spend.day = { key: dk, usd: 0, baseUsd: 0, chargedUsd: 0 };
  if (!acct.spend.week || acct.spend.week.key !== wk) acct.spend.week = { key: wk, usd: 0, baseUsd: 0, chargedUsd: 0 };
  if (acct.spend.month.key !== mk) acct.spend.month = { key: mk, usd: 0, baseUsd: 0, chargedUsd: 0 };
}

function activeGrants(acct) {
  const now = Date.now();
  return acct.grants.filter(g => g.remainingMilli > 0 && (!g.expiresAt || Date.parse(g.expiresAt) > now));
}

function planOf(cfg, acct) {
  return cfg.plans.find(p => p.slug === acct.plan) || cfg.plans[0] || DEFAULT_PLANS[0];
}


// ── o portão (roda ANTES do turno; envelope + enum fechado) ──
function gateDecision(username) {
  const cfg = getConfig();
  if (cfg.mode !== 'credits') {
    return { decision: { decision: 'allow', applicable: false, reason: 'ok', ttlMs: 15000 } };
  }
  const acct = account(username);
  lazyReset(acct, cfg);
  saveState();

  const plan = planOf(cfg, acct);
  // Na prática os créditos SÃO dólares: o plano tem X US$ de uso (cobrado),
  // e cada modelo consome desse orçamento pelo seu preço com markup.
  const monthCapUsd = planMonthCapUsd(cfg, plan);
  const monthRemainingUsd = Math.max(0, monthCapUsd - acct.spend.month.usd);
  const weekCapUsd = planWeekCapUsd(cfg, plan);
  const weekRemainingUsd = Math.max(0, weekCapUsd - acct.spend.week.usd);
  const grantMilli = activeGrants(acct).reduce((a, g) => a + g.remainingMilli, 0);

  const make = (decision, reason) => ({ decision: { decision, applicable: true, reason, ttlMs: 15000 } });

  // SESSÃO 5h (modelo Claude) — é RITMO, não orçamento: cortesia não fura;
  // espera a janela reabrir (a sessão conta o uso cobrado INTEGRAL)
  const sessionCapUsd = planSessionCapUsd(cfg, plan);
  if (sessionCapUsd > 0 && acct.spend.session.usd >= sessionCapUsd) {
    return make('block', 'session');
  }
  // teto diário (US$) — aviso de gasto desgovernado num dia só
  if (cfg.defaultDailyLimitUsd > 0 && acct.spend.day.usd >= cfg.defaultDailyLimitUsd) {
    if (grantMilli === 0 && acct.balanceMilli === 0) return make('block', 'daily');
  }
  // teto SEMANAL — a janela que o usuário enxerga (cortesia/saldo ainda cobrem)
  if (weekCapUsd > 0 && weekRemainingUsd <= 0 && grantMilli === 0 && acct.balanceMilli === 0) {
    return make('block', 'weekly');
  }
  if (monthRemainingUsd > 0 || grantMilli > 0 || acct.balanceMilli > 0) return make('allow', 'ok');
  if (monthCapUsd === 0 && grantMilli === 0 && acct.balanceMilli === 0) return make('block', 'no_active_credits');
  return make('block', 'monthly');
}

// ── idempotência dos turnos cobrados ──
// Guarda { id: timestamp } e expurga por IDADE. O formato antigo era um array
// de ids capado em 300; ele é aceito e convertido na primeira passagem, para
// nenhuma instalação existente perder a proteção contra cobrança dupla.
const JANELA_IDEMPOTENCIA_MS = 24 * 60 * 60 * 1000;

function turnosCobrados(acct) {
  if (Array.isArray(acct.debitedTurns)) {
    // Migração do formato antigo: sem timestamp, assume "agora" — o pior caso
    // é manter a proteção por 24h a mais, que é o lado seguro do erro.
    const agora = Date.now();
    const convertido = {};
    for (const id of acct.debitedTurns) convertido[id] = agora;
    acct.debitedTurns = convertido;
  } else if (!acct.debitedTurns || typeof acct.debitedTurns !== 'object') {
    acct.debitedTurns = {};
  }
  return acct.debitedTurns;
}

function jaCobrado(acct, turnId) {
  const mapa = turnosCobrados(acct);
  const quando = mapa[turnId];
  if (!quando) return false;
  if (Date.now() - quando > JANELA_IDEMPOTENCIA_MS) { delete mapa[turnId]; return false; }
  return true;
}

function registrarCobrado(acct, turnId) {
  const mapa = turnosCobrados(acct);
  mapa[turnId] = Date.now();
  // Expurgo por idade a cada débito: memória limitada sem cap por contagem.
  const limite = Date.now() - JANELA_IDEMPOTENCIA_MS;
  for (const id of Object.keys(mapa)) if (mapa[id] < limite) delete mapa[id];
}

// ── o débito (roda DEPOIS do turno) ──
// turn = número (legado: US$ reais do turno) OU { costUsd, modelDeltas }.
// O turno é PRECIFICADO por modelo (custo base × markup) e o valor COBRADO
// é o que sai do orçamento do plano. Cortesia primeiro, em milli inteiro;
// o resto vira gasto em USD cobrado com precisão total.
function debitTurn(username, turn, turnId) {
  const cfg = getConfig();
  if (cfg.mode !== 'credits') return { applicable: false };
  const t = (typeof turn === 'number') ? { costUsd: turn, modelDeltas: null } : (turn || {});
  const priced = priceTurn(cfg, t.modelDeltas, t.costUsd);
  if (!(priced.chargedUsd > 0)) return { applicable: false };

  const acct = account(username);
  lazyReset(acct, cfg);

  // Idempotência: um retry não pode cobrar duas vezes.
  //
  // Antes, os turnos cobrados viviam num anel capado em 300 ENTRADAS: num
  // usuário ativo, 300 turnos passam rápido, e um retry mais velho que isso
  // reentrava e COBRAVA DE NOVO. A poda agora é por TEMPO (24h), não por
  // contagem — nenhum retry plausível é mais velho que a janela, e a memória
  // continua limitada porque o expurgo roda a cada débito.
  if (turnId && jaCobrado(acct, turnId)) {
    return { applicable: true, duplicate: true, summary: summaryFor(username) };
  }

  const chargedUsd = priced.chargedUsd;
  // FLOOR (não round): a cortesia nunca paga MAIS que o turno custou —
  // a fração que sobra vai para as janelas como remainder, com precisão total
  const costMilli = Math.floor((chargedUsd / cfg.usdPerCredit) * 1000);
  let toCover = costMilli;
  let fromGrants = 0, fromBalance = 0;

  // 1. cortesia primeiro (inteiro, pulando expiradas)
  for (const g of activeGrants(acct)) {
    if (toCover <= 0) break;
    const take = Math.min(g.remainingMilli, toCover);
    g.remainingMilli -= take;
    toCover -= take;
    fromGrants += take;
  }
  // 2. saldo avulso
  if (toCover > 0 && acct.balanceMilli > 0) {
    const take = Math.min(acct.balanceMilli, toCover);
    acct.balanceMilli -= take;
    toCover -= take;
    fromBalance += take;
  }
  // 3. o que sobrou vira gasto em USD COBRADO — derivado do valor real, não
  //    do milli arredondado (turno de US$0,000041 não pode sair de graça)
  const coveredUsd = milliToUsd(fromGrants + fromBalance, cfg);
  const remainderUsd = Math.max(0, chargedUsd - coveredUsd);
  for (const w of [acct.spend.day, acct.spend.week, acct.spend.month]) {
    w.usd = r6(w.usd + remainderUsd);
    // contabilidade do lucro: custo base e cobrado INTEGRAIS (mesmo os
    // turnos cobertos por cortesia custaram dinheiro de verdade)
    w.baseUsd = r6((w.baseUsd || 0) + priced.baseUsd);
    w.chargedUsd = r6((w.chargedUsd || 0) + chargedUsd);
  }
  // sessão 5h: abre no 1º uso e conta o COBRADO INTEGRAL (ritmo, não orçamento)
  const sess = acct.spend.session;
  if (!sess.startTs) sess.startTs = Date.now();
  sess.usd = r6(sess.usd + chargedUsd);
  sess.baseUsd = r6((sess.baseUsd || 0) + priced.baseUsd);
  sess.chargedUsd = r6((sess.chargedUsd || 0) + chargedUsd);

  if (turnId) registrarCobrado(acct, turnId);

  // ── Espelho autoritativo no Postgres ──────────────────────────────────
  // Por que os dois caminhos convivem: `debitTurn` é SÍNCRONO (o portão
  // `podeDespachar` exige resposta na hora) e o banco é assíncrono. A conta
  // local segue respondendo agora; o Postgres registra o MESMO débito de
  // forma atômica — evento, cortesia, saldo e janelas numa transação só, com
  // idempotência PERMANENTE por turn_id (a checagem local expira em 24h) e
  // `FOR UPDATE` serializando concorrentes de verdade, o que o
  // read-modify-write do arquivo nunca deu.
  // Quando os dois discordarem, o banco é a verdade: `billingDb.conferir()`
  // existe para achar divergência antes que ela vire dinheiro errado.
  // Sem NASCERA_DB_BILLING=pg isto não roda e o comportamento é o de sempre.
  if (billingDb.ATIVO && turnId) {
    const _payload = {
      username: normU(username), turnId, costMilli,
      baseUsd: priced.baseUsd, chargedUsd, perModel: priced.perModel,
      usdPerCredit: cfg.usdPerCredit,
      chaveDia: dayKey(cfg.timezone),
      chaveSemana: weekKey(cfg.timezone),
      chaveMes: monthKey(cfg.timezone),
      sessaoMs: SESSION_MS,
    };
    billingDb.debitar(_payload).catch((e) => {
      // Nunca derruba o turno: o ledger em arquivo já gravou (com fsync). Mas
      // agora o débito falho NÃO se perde — vai para o outbox durável, e o
      // dreno periódico o reaplica (idempotente por turnId). (S0-9)
      logger.error('[billing] débito no Postgres falhou, pendurando no outbox (turno ' + turnId + '): ' + e.message);
      billingDb.pendurar(_payload);
    });
  }

  // ORDEM IMPORTANTE: o ledger append-only vai ANTES do estado.
  // Se o processo morrer entre os dois, o evento existe e o saldo pode ser
  // reconstruído; na ordem inversa, o dinheiro sairia sem rastro nenhum.
  // O fsync garante que "escrito" significa "no disco", e não "no cache do SO".
  try {
    const linha = JSON.stringify({
      ts: new Date().toISOString(), user: username,
      baseUsd: priced.baseUsd, chargedUsd, perModel: priced.perModel,
      costMilli, fromGrants, fromBalance, remainderUsd: r6(remainderUsd), turnId,
    }) + '\n';
    const fd = fs.openSync(EVENTS_FILE, 'a');
    try { fs.writeSync(fd, linha); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (e) { logger.error('[billing] ledger falhou:', e.message); }

  saveState();

  return {
    applicable: true, baseUsd: priced.baseUsd, chargedUsd, perModel: priced.perModel,
    costMilli, fromGrants, fromBalance, remainderUsd, summary: summaryFor(username),
  };
}

// ── o resumo que a tela lê (regra de exibição §3.1) ──
function summaryFor(username) {
  const cfg = getConfig();
  const acct = account(username);
  lazyReset(acct, cfg);
  const plan = planOf(cfg, acct);
  // Orçamento em US$ COBRADO — "na prática os créditos são dólares"
  const monthCapUsd = planMonthCapUsd(cfg, plan);
  const monthRemainingUsd = Math.max(0, monthCapUsd - acct.spend.month.usd);
  const cycleMilli = usdToMilli(monthCapUsd, cfg);
  const spentMilli = usdToMilli(acct.spend.month.usd, cfg);
  const remainingMilli = usdToMilli(monthRemainingUsd, cfg);
  const grants = activeGrants(acct);
  const grantTotal = grants.reduce((a, g) => a + g.remainingMilli, 0);

  // "Disponível" NÃO é soma: remaining do ciclo (regra §3.1)
  const availableMilli = remainingMilli;

  // Janela semanal (modelo Claude Code): o usuário enxerga % da semana usada
  const weekCapUsd = planWeekCapUsd(cfg, plan);
  const weekUsedPct = weekCapUsd > 0
    ? Math.min(999, Math.round((acct.spend.week.usd / weekCapUsd) * 100))
    : (acct.spend.week.usd > 0 ? 100 : 0);

  // Sessão 5h (modelo Claude): % da janela e quando reabre
  const sessionCapUsd = planSessionCapUsd(cfg, plan);
  const sess = acct.spend.session;
  const sessionUsedPct = sessionCapUsd > 0
    ? Math.min(999, Math.round((sess.usd / sessionCapUsd) * 100))
    : (sess.usd > 0 ? 100 : 0);

  return {
    mode: cfg.mode,
    usdPerCredit: cfg.usdPerCredit,
    session: {
      capUsd: sessionCapUsd,
      spentUsd: sess.usd,
      usedPct: sessionUsedPct,
      startedAt: sess.startTs ? new Date(sess.startTs).toISOString() : null,
      resetsAt: sess.startTs ? new Date(sess.startTs + SESSION_MS).toISOString() : null,
    },
    week: {
      capUsd: r6(weekCapUsd),
      spentUsd: acct.spend.week.usd,
      remainingUsd: r6(Math.max(0, weekCapUsd - acct.spend.week.usd)),
      usedPct: weekUsedPct,
      limitMilli: usdToMilli(weekCapUsd, cfg),
      spentMilli: usdToMilli(acct.spend.week.usd, cfg),
      weekKey: acct.spend.week.key,
      weekEnd: weekEndIso(cfg.timezone),
    },
    month: {
      capUsd: r6(monthCapUsd),
      spentUsd: acct.spend.month.usd,
      remainingUsd: r6(monthRemainingUsd),
      baseUsd: acct.spend.month.baseUsd || 0,       // custo real p/ nós
      chargedUsd: acct.spend.month.chargedUsd || 0, // cobrado (incl. cortesias)
    },
    creditAccounts: {
      personal: {
        planName: plan.name,
        planSlug: plan.slug,
        ownerType: 'user',
        subscriptionStatus: 'active',
        creditsPerCycleMilli: cycleMilli,
      },
    },
    cycleCredits: { creditsPerCycleMilli: cycleMilli, remainingMilli },
    balanceMilli: acct.balanceMilli,
    activeGrantBalanceMilli: grantTotal,
    availableMilli,
    spend: {
      dailyUsd: acct.spend.day.usd,
      monthlyUsd: acct.spend.month.usd,
      dailyMilli: usdToMilli(acct.spend.day.usd, cfg),
      monthlyMilli: spentMilli,
    },
    windows: {
      dayKey: acct.spend.day.key, monthKey: acct.spend.month.key,
      dayEnd: dayEndIso(cfg.timezone), monthEnd: monthEndIso(cfg.timezone),
    },
  };
}

// ── administração ──
function adminOverview(usernames) {
  const cfg = getConfig();
  const st = loadState();
  const users = [...new Set([...(usernames || []), ...Object.keys(st.accounts)])];
  return {
    config: cfg,
    reasons: REASONS,
    users: users.map((u) => {
      const s = summaryFor(u);
      const acct = account(u);
      return {
        username: u,
        plan: acct.plan,
        planName: s.creditAccounts.personal.planName,
        availableMilli: s.availableMilli,
        balanceMilli: acct.balanceMilli,
        grantMilli: s.activeGrantBalanceMilli,
        monthlySpendUsd: s.spend.monthlyUsd,
        monthlySpendMilli: s.spend.monthlyMilli,
        cycleMilli: s.cycleCredits.creditsPerCycleMilli,
        weekUsedPct: s.week.usedPct,
        weekLimitMilli: s.week.limitMilli,
        weekSpentMilli: s.week.spentMilli,
        weekCapUsd: s.week.capUsd,
        sessionUsedPct: s.session.usedPct,
        sessionCapUsd: s.session.capUsd,
        sessionResetsAt: s.session.resetsAt,
        monthCapUsd: s.month.capUsd,
        monthBaseUsd: s.month.baseUsd,       // custo real p/ nós no mês
        monthChargedUsd: s.month.chargedUsd, // cobrado no mês
      };
    }),
  };
}

// ── Espelho das operações de ADMIN ─────────────────────────────────────
// Antes, só o DÉBITO atravessava para o Postgres. Cortesia, saldo, plano e
// reset ficavam apenas no JSON — o banco achava que todo cliente tinha saldo
// zero. Consequência medida: um turno coberto por cortesia era registrado no
// JSON como custo zero e no banco como gasto INTEGRAL do plano. Um cliente
// com 250 créditos de cortesia aparecia no banco tendo queimado 46% de um
// plano em que não encostou. Era o mesmo "retrato congelado" que a tabela de
// domínios tinha — e o banco é justamente o lado que vai virar autoritativo.
// Falha aqui NÃO derruba a operação do admin: o JSON já gravou.
function espelhar(rotulo, fn) {
  if (!billingDb.ATIVO) return;
  try {
    Promise.resolve(fn()).catch((e) =>
      logger.error('[billing] espelho de ' + rotulo + ' falhou no Postgres: ' + e.message));
  } catch (e) {
    logger.error('[billing] espelho de ' + rotulo + ' falhou: ' + e.message);
  }
}

function setUserPlan(username, planSlug) {
  const cfg = getConfig();
  if (!cfg.plans.some(p => p.slug === planSlug)) throw new Error('Plano inexistente: ' + planSlug);
  account(username).plan = planSlug;
  saveState();
  espelhar('plano', () => billingDb.definirPlano(username, planSlug));
}

function grantCredits(username, credits, label, expiresAt) {
  const milli = Math.round(credits * 1000);
  if (!(milli > 0)) throw new Error('Quantidade inválida');
  const id = crypto.randomUUID();
  account(username).grants.push({
    id, label: label || 'Cortesia',
    remainingMilli: milli, expiresAt: expiresAt || null,
    grantedAt: new Date().toISOString(),
  });
  saveState();
  // Mesmo id dos dois lados: sem isso, reimportar o JSON duplicaria a cortesia.
  espelhar('cortesia', () => billingDb.darCortesia(username, milli, label || 'Cortesia', expiresAt || null, id));
}

function addBalance(username, credits) {
  const milli = Math.round(credits * 1000);
  const acct = account(username);
  acct.balanceMilli = Math.max(0, acct.balanceMilli + milli);
  saveState();
  espelhar('saldo', () => billingDb.somarSaldo(username, milli));
}

function resetSpend(username) {
  const acct = account(username);
  acct.spend = {
    session: { startTs: null, usd: 0, baseUsd: 0, chargedUsd: 0 },
    day: { key: null, usd: 0, baseUsd: 0, chargedUsd: 0 },
    week: { key: null, usd: 0, baseUsd: 0, chargedUsd: 0 },
    month: { key: null, usd: 0, baseUsd: 0, chargedUsd: 0 },
  };
  saveState();
  espelhar('reset de janelas', () => billingDb.zerarJanelas(username));
}

// Validação dos planos. O consumo agora DERIVA do preço (nunca negativo por
// construção); o que merece aviso é subsídio deliberado via bônus.
function validatePlans(plans) {
  const warnings = [];
  for (const p of plans) {
    if (!p.slug || !p.name) throw new Error('Plano sem slug/nome');
    if (p.priceBrl > 0 && p.bonusUsd > 0) {
      warnings.push(`Plano "${p.name}": pago com bônus de US$ ${p.bonusUsd} — o bônus é subsídio (sai do seu bolso além do preço).`);
    }
    if (p.priceBrl === 0 && !(p.bonusUsd > 0) && !(p.creditsPerMonth > 0)) {
      warnings.push(`Plano "${p.name}": gratuito sem bônus nem créditos — usuários deste plano ficam bloqueados.`);
    }
  }
  return warnings;
}

module.exports = {
  REASONS, BLOCK_MESSAGE, DEFAULT_PLANS, DEFAULT_MODELS,
  getConfig, usdToMilli, milliToUsd,
  priceTurn, modelRowFor, planMonthCapUsd, planWeekCapUsd, planSessionCapUsd,
  gateDecision, debitTurn, summaryFor,
  adminOverview, setUserPlan, grantCredits, addBalance, resetSpend, validatePlans,
  _reloadState: () => { _state = null; },
};
