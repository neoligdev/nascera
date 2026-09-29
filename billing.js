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

// Overrides por env var (mesmo padrão de servicos/vendas.js `NASCERA_VENDAS_FILE`)
// — usado pelos testes pra isolar o arquivo do dinheiro do repo real.
const CONFIG_FILE = process.env.NASCERA_CONFIG_FILE || path.join(__dirname, 'nascera-config.json');
const BILLING_FILE = process.env.NASCERA_BILLING_FILE || path.join(__dirname, 'billing.json');
const EVENTS_FILE = process.env.NASCERA_USAGE_EVENTS_FILE || path.join(__dirname, 'usage-events.jsonl');

// Enum fechado do portão — valor fora da lista invalida a decisão (doc §2.1)
const REASONS = ['ok', 'session', 'daily', 'weekly', 'monthly', 'trial_expired', 'access_expired',
  'user_limit', 'company_pool', 'grant_expired', 'no_active_credits', 'credit_check_unavailable',
  'motor2_limit'];

// Janela de sessão no modelo Claude: 5 horas rolantes a partir do 1º uso
const SESSION_MS = 5 * 60 * 60 * 1000;

// A mensagem de bloqueio é INTERFACE (doc §3.3) — não mudar o texto sem
// atualizar quem a reconhece.
const BLOCK_MESSAGE = 'Você ultrapassou seu limite de créditos. Fale com o administrador ou aguarde a virada do ciclo.';

// Planos vigentes (doc "NASCERA — Planos, Créditos e Motor 2"). creditsPerMonth
// é a fonte de verdade do orçamento premium (ver planMonthCapUsd). dailyBonusCap/
// monthlyBonusCap regem o bônus diário (§3 do doc: não acumula, teto mensal de
// CONCEDIDO). motor2 marca elegibilidade pra "zona protegida" (§7/§8). maxProjetos/
// maxDominios são `null` = ilimitado.
const DEFAULT_PLANS = [
  { slug: 'free',     name: 'Free',     priceBrl: 0,   creditsPerMonth: 0,    dailyBonusCap: 10, monthlyBonusCap: 60, maxProjetos: 1,    maxDominios: 5,    motor2: false },
  { slug: 'start',    name: 'Start',    priceBrl: 35,  creditsPerMonth: 240,  dailyBonusCap: 60, monthlyBonusCap: 60, maxProjetos: null, maxDominios: 20,   motor2: false },
  { slug: 'pro',      name: 'Pro',      priceBrl: 95,  creditsPerMonth: 540,  dailyBonusCap: 60, monthlyBonusCap: 60, maxProjetos: null, maxDominios: null, motor2: true },
  { slug: 'business', name: 'Business', priceBrl: 155, creditsPerMonth: 1240, dailyBonusCap: 60, monthlyBonusCap: 60, maxProjetos: null, maxDominios: null, motor2: true },
];

// Pacotes avulsos de créditos (doc, tabela de preço decrescente por
// volume). Creditados via addBalance() → origem 'comprado', com a MESMA
// validade de cfg.creditoCompradoValidadeDias — nunca recalculada aqui.
const DEFAULT_PACOTES = [
  { id: 'pacote-100',   creditos: 100,   precoBrl: 19.90 },
  { id: 'pacote-300',   creditos: 300,   precoBrl: 37.90 },
  { id: 'pacote-1000',  creditos: 1000,  precoBrl: 99.90 },
  { id: 'pacote-2500',  creditos: 2500,  precoBrl: 189.90 },
  { id: 'pacote-5000',  creditos: 5000,  precoBrl: 369.90 },
  { id: 'pacote-10000', creditos: 10000, precoBrl: 695.90 },
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
    creditoCompradoValidadeDias: 365, // ~12 meses (doc §6): validade do lote origem='comprado'
    precoFixoAtivo: false,   // Fase 2 (A.3): toggle do admin, mesmo padrão de pipelineAutomatico/motor2.ligado
    pacotes: DEFAULT_PACOTES,
  };
}

function getConfig() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  const cfg = { ...defaultConfig(), ...(raw.billing || {}) };
  if (!Array.isArray(cfg.plans) || !cfg.plans.length) cfg.plans = DEFAULT_PLANS;
  if (!Array.isArray(cfg.pacotes) || !cfg.pacotes.length) cfg.pacotes = DEFAULT_PACOTES;
  if (!Array.isArray(cfg.models) || !cfg.models.length) cfg.models = DEFAULT_MODELS;
  // INVARIANTE do produto: markup nunca abaixo de 1× — no mínimo repassa o custo
  if (!(cfg.defaultMarkup >= 1)) cfg.defaultMarkup = 1;
  if (!(cfg.usdToBrl > 0)) cfg.usdToBrl = 5.5;
  if (!(cfg.sessionsPerWeek >= 1)) cfg.sessionsPerWeek = 5;
  if (!(cfg.creditoCompradoValidadeDias > 0)) cfg.creditoCompradoValidadeDias = 365;
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
// bonusUsd é subsídio deliberado (free/trial), somado por cima quando existe.
// creditsPerMonth é a FONTE DE VERDADE do teto quando definido (>0): é o que
// o plano vende ("540 créditos premium/mês"), e priceBrl é só o preço comercial
// — sem isso, um plano pago SEMPRE caía no câmbio (priceBrl/usdToBrl), que
// nunca bate com os créditos anunciados (ex.: Pro R$95 → US$17 ≈ 86 créditos
// a 0,20, não os 540 prometidos). priceBrl só vira teto quando o plano não
// declara creditsPerMonth (compat com planos antigos definidos só por preço).
function planMonthCapUsd(cfg, plan) {
  if (plan.creditsPerMonth > 0) return r6(plan.creditsPerMonth * cfg.usdPerCredit + (plan.bonusUsd || 0));
  return r6((plan.priceBrl || 0) / cfg.usdToBrl + (plan.bonusUsd || 0));
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
      balanceMilli: 0,                 // créditos avulsos legado (pré-origem; ver grants 'comprado')
      grants: [],                      // [{id,label,remainingMilli,expiresAt|null,origem:'cortesia'|'bonus'|'comprado'}]
      bonusGrant: { monthKey: null, grantedMilli: 0 },  // teto cumulativo mensal do bônus CONCEDIDO
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

// Consome até `toCover` milli dos grants ativos cuja origem está em `origens`,
// na ordem de criação (array order == criada_em) — mesmo critério que o SQL
// espelha (migração 005, achado (3)).
function takeFromGrants(acct, toCover, origens) {
  let taken = 0;
  for (const g of activeGrants(acct)) {
    if (toCover <= 0) break;
    if (!origens.includes(g.origem || 'cortesia')) continue;
    const take = Math.min(g.remainingMilli, toCover);
    g.remainingMilli -= take;
    toCover -= take;
    taken += take;
  }
  return { toCover, taken };
}

function planOf(cfg, acct) {
  return cfg.plans.find(p => p.slug === acct.plan) || cfg.plans[0] || DEFAULT_PLANS[0];
}

// ── bônus diário (doc §3/§4): concede uma vez por dia, até o teto MENSAL do
// que já foi concedido (não do que resta — o contador só cresce, nunca
// decresce por expiração, senão um bônus não usado "devolveria" cota pro
// mês). O grant em si expira sozinho pelo mecanismo de `activeGrants()` —
// "não acumula de um dia pro outro" não precisa de código extra nenhum.
function garantirBonusDoDia(acct, cfg, plan) {
  if (!acct.bonusGrant || typeof acct.bonusGrant !== 'object') {
    acct.bonusGrant = { monthKey: null, grantedMilli: 0 };
  }
  const dailyCap = Number(plan.dailyBonusCap) || 0;
  const monthlyCap = Number(plan.monthlyBonusCap) || 0;
  if (dailyCap <= 0 || monthlyCap <= 0) return;

  const mk = monthKey(cfg.timezone);
  if (acct.bonusGrant.monthKey !== mk) acct.bonusGrant = { monthKey: mk, grantedMilli: 0 };

  const hojeExpira = dayEndIso(cfg.timezone);
  const jaConcedidoHoje = acct.grants.some(g => g.origem === 'bonus' && g.expiresAt === hojeExpira);
  if (jaConcedidoHoje) return;

  const dailyCapMilli = Math.round(dailyCap * 1000);
  const monthlyCapMilli = Math.round(monthlyCap * 1000);
  const restanteMilli = monthlyCapMilli - acct.bonusGrant.grantedMilli;
  if (restanteMilli <= 0) return;   // teto do mês de bônus CONCEDIDO já batido

  const concederMilli = Math.min(dailyCapMilli, restanteMilli);
  if (concederMilli <= 0) return;

  acct.grants.push({
    id: crypto.randomUUID(), label: 'Bônus diário', origem: 'bonus',
    remainingMilli: concederMilli, expiresAt: hojeExpira,
    grantedAt: new Date().toISOString(),
  });
  acct.bonusGrant.grantedMilli += concederMilli;
}


// ── o portão (roda ANTES do turno; envelope + enum fechado) ──
function gateDecision(username) {
  const cfg = getConfig();
  if (cfg.mode !== 'credits') {
    return { decision: { decision: 'allow', applicable: false, reason: 'ok', ttlMs: 15000 } };
  }
  const acct = account(username);
  lazyReset(acct, cfg);
  const plan = planOf(cfg, acct);
  garantirBonusDoDia(acct, cfg, plan);
  saveState();

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
  // O custo REAL sempre é calculado — alimenta o dashboard de margem/desvio
  // (doc §12) mesmo quando o preço fixo decide o débito. Só entra no débito
  // em si quando NÃO há preço fixo válido (mesma guarda de sempre).
  const precoFixoValido = cfg.precoFixoAtivo && Number(t.creditosFixos) > 0;
  if (!precoFixoValido && !(priced.chargedUsd > 0)) return { applicable: false };

  const acct = account(username);
  lazyReset(acct, cfg);
  const plan = planOf(cfg, acct);
  garantirBonusDoDia(acct, cfg, plan);

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

  // costMilli/chargedUsd são o que efetivamente sai do orçamento do cliente.
  // Preço fixo (A.3, doc): creditosFixos decide direto, sem passar pelo
  // custo real. Senão, EXATAMENTE o cálculo da Fase 1 (floor, não round —
  // nenhuma origem paga MAIS que o turno custou de verdade).
  let costMilli, chargedUsd;
  if (precoFixoValido) {
    costMilli = Math.round(Number(t.creditosFixos) * 1000);
    chargedUsd = milliToUsd(costMilli, cfg);
  } else {
    chargedUsd = priced.chargedUsd;
    costMilli = Math.floor((chargedUsd / cfg.usdPerCredit) * 1000);
  }
  let restante = costMilli;
  let fromBonus = 0, fromPremium = 0, fromComprado = 0;

  // 1. bônus diário primeiro — é o que expira mais cedo (hoje), então é o
  //    primeiro a ser gasto (o que expira antes é gasto antes).
  { const r = takeFromGrants(acct, restante, ['bonus']); restante = r.toCover; fromBonus = r.taken; }

  // 2. premium mensal — travado a 90% do teto pra planos com Motor 2 (os
  //    últimos 10% são a "zona protegida": preservados pra dar lugar ao
  //    Motor 2 assumir, doc §7/§8). Planos sem Motor 2 (Free/Start) não têm
  //    reserva — não há pra onde a "zona protegida" faria handoff — e
  //    consomem até 100%, como sempre. O que exceder o teto tenta a origem
  //    seguinte (comprado) antes de virar overage.
  if (restante > 0) {
    const monthCapUsd = planMonthCapUsd(cfg, plan);
    const limiteUsd = plan.motor2 ? monthCapUsd * 0.9 : monthCapUsd;
    const premiumDisponivelMilli = Math.max(0, usdToMilli(limiteUsd, cfg) - usdToMilli(acct.spend.month.usd, cfg));
    fromPremium = Math.min(restante, premiumDisponivelMilli);
    restante -= fromPremium;
  }

  // 3. comprado + cortesia (legado, sem marca de origem) — o que excedeu o
  //    teto premium tenta esses lotes antes de virar overage de verdade.
  { const r = takeFromGrants(acct, restante, ['comprado', 'cortesia']); restante = r.toCover; fromComprado = r.taken; }
  // 4. saldo avulso legado (addBalance hoje cria grant 'comprado'; isto é
  //    só o fallback pra saldo somado antes desta mudança).
  if (restante > 0 && acct.balanceMilli > 0) {
    const take = Math.min(acct.balanceMilli, restante);
    acct.balanceMilli -= take;
    restante -= take;
    fromComprado += take;
  }

  // 5. o que sobrar (fromPremium + overage real além de tudo) vira gasto em
  //    USD COBRADO nas janelas — derivado do valor real, não do milli
  //    arredondado (turno de US$0,000041 não pode sair de graça), e NUNCA
  //    bloqueia o turno em andamento (só o gate do PRÓXIMO turno).
  const coveredUsd = milliToUsd(fromBonus + fromComprado, cfg);
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
      // Fatias JÁ decididas aqui (bônus/premium/comprado) — o Postgres só
      // aplica o valor, não re-decide a regra de negócio (mesmo princípio
      // do resto do arquivo: "aqui só se move valor").
      fromBonusMilli: fromBonus, fromPremiumMilli: fromPremium, fromCompradoMilli: fromComprado,
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
      realBaseUsd: priced.baseUsd, realChargedUsd: priced.chargedUsd,
      costMilli, fromBonus, fromPremium, fromComprado, remainderUsd: r6(remainderUsd), turnId,
    }) + '\n';
    const fd = fs.openSync(EVENTS_FILE, 'a');
    try { fs.writeSync(fd, linha); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (e) { logger.error('[billing] ledger falhou:', e.message); }

  saveState();

  return {
    applicable: true, baseUsd: priced.baseUsd, chargedUsd, perModel: priced.perModel,
    realBaseUsd: priced.baseUsd, realChargedUsd: priced.chargedUsd,
    costMilli, fromBonus, fromPremium, fromComprado, remainderUsd, summary: summaryFor(username),
  };
}

// ── o resumo que a tela lê (regra de exibição §3.1) ──
function summaryFor(username) {
  const cfg = getConfig();
  const acct = account(username);
  lazyReset(acct, cfg);
  const plan = planOf(cfg, acct);
  garantirBonusDoDia(acct, cfg, plan);
  // Orçamento em US$ COBRADO — "na prática os créditos são dólares"
  const monthCapUsd = planMonthCapUsd(cfg, plan);
  const monthRemainingUsd = Math.max(0, monthCapUsd - acct.spend.month.usd);
  const cycleMilli = usdToMilli(monthCapUsd, cfg);
  const spentMilli = usdToMilli(acct.spend.month.usd, cfg);
  const remainingMilli = usdToMilli(monthRemainingUsd, cfg);
  const grants = activeGrants(acct);
  const grantTotal = grants.reduce((a, g) => a + g.remainingMilli, 0);
  // Zona protegida (doc §7/§8): % do teto premium do ciclo ainda não gasto,
  // fixo sobre o TOTAL do ciclo (nunca recalculado só sobre o restante —
  // isso encolheria pra sempre sem nunca zerar de verdade).
  const premiumRemainingPct = monthCapUsd > 0
    ? r6(Math.max(0, (monthCapUsd - acct.spend.month.usd) / monthCapUsd) * 100) : 0;
  // Saldos separados por origem (doc §11: "mostrar saldo premium separado
  // do bônus diário"). balanceMilli legado conta como 'comprado' pra exibição.
  const bonusMilli = grants.filter(g => g.origem === 'bonus').reduce((a, g) => a + g.remainingMilli, 0);
  const compradoMilli = grants.filter(g => g.origem === 'comprado').reduce((a, g) => a + g.remainingMilli, 0) + acct.balanceMilli;
  const cortesiaMilli = grants.filter(g => (g.origem || 'cortesia') === 'cortesia').reduce((a, g) => a + g.remainingMilli, 0);

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
    premiumRemainingPct,
    motor2Elegivel: !!plan.motor2,
    saldosPorOrigem: { premiumMilli: remainingMilli, bonusMilli, compradoMilli, cortesiaMilli },
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

// Limite do plano do usuário pra um campo (maxProjetos/maxDominios, doc
// tabela de planos). `null` = ilimitado OU billing desligado (mode !==
// 'credits') — sem cobrança ativa, não faz sentido travar por plano.
function planLimitFor(username, campo) {
  const cfg = getConfig();
  if (cfg.mode !== 'credits') return null;
  const plan = planOf(cfg, account(username));
  const v = plan[campo];
  return (typeof v === 'number' && v > 0) ? v : null;
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
        premiumRemainingPct: s.premiumRemainingPct,
        motor2Elegivel: s.motor2Elegivel,
        saldosPorOrigem: s.saldosPorOrigem,  // { premiumMilli, bonusMilli, compradoMilli, cortesiaMilli }
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

// origem: 'cortesia' (padrão — concessão manual do admin) | 'bonus' | 'comprado'.
function grantCredits(username, credits, label, expiresAt, origem) {
  const milli = Math.round(credits * 1000);
  if (!(milli > 0)) throw new Error('Quantidade inválida');
  const id = crypto.randomUUID();
  const org = ['bonus', 'comprado'].includes(origem) ? origem : 'cortesia';
  account(username).grants.push({
    id, label: label || 'Cortesia', origem: org,
    remainingMilli: milli, expiresAt: expiresAt || null,
    grantedAt: new Date().toISOString(),
  });
  saveState();
  // Mesmo id dos dois lados: sem isso, reimportar o JSON duplicaria a cortesia.
  espelhar('cortesia', () => billingDb.darCortesia(username, milli, label || 'Cortesia', expiresAt || null, id, org));
}

// Créditos comprados (doc §6): agora um lote com validade própria (origem
// 'comprado'), não mais uma soma cega em balanceMilli — assim entram no
// ledger por origem e no `saldosPorOrigem` da tela, sem esperar o checkout
// avulso da Fase 2 (que só vai chamar esta mesma função).
function addBalance(username, credits, label) {
  const cfg = getConfig();
  const validadeMs = cfg.creditoCompradoValidadeDias * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + validadeMs).toISOString();
  grantCredits(username, credits, label || 'Créditos comprados', expiresAt, 'comprado');
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
    if (p.priceBrl === 0 && !(p.bonusUsd > 0) && !(p.creditsPerMonth > 0) && !(p.dailyBonusCap > 0)) {
      warnings.push(`Plano "${p.name}": gratuito sem bônus, créditos nem bônus diário — usuários deste plano ficam bloqueados.`);
    }
  }
  return warnings;
}

// Validação dos pacotes avulsos (doc §6, Fase 2). id duplicado é erro (não dá
// pra saber qual dos dois o admin quis dizer no mapeamento oferta→pacote);
// créditos/preço zerados só avisam (pode ser edição em andamento).
function validatePacotes(pacotes) {
  const warnings = [];
  const ids = new Set();
  for (const p of pacotes) {
    if (!p.id) throw new Error('Pacote sem id');
    if (ids.has(p.id)) throw new Error(`Id de pacote duplicado: "${p.id}"`);
    ids.add(p.id);
    if (!(p.creditos > 0)) warnings.push(`Pacote "${p.id}": créditos zerados ou negativos — ninguém recebe nada nesta compra.`);
    if (!(p.precoBrl > 0)) warnings.push(`Pacote "${p.id}": preço zerado ou negativo.`);
  }
  return warnings;
}

module.exports = {
  REASONS, BLOCK_MESSAGE, DEFAULT_PLANS, DEFAULT_PACOTES, DEFAULT_MODELS,
  getConfig, usdToMilli, milliToUsd,
  priceTurn, modelRowFor, planMonthCapUsd, planWeekCapUsd, planSessionCapUsd,
  gateDecision, debitTurn, summaryFor, planLimitFor,
  adminOverview, setUserPlan, grantCredits, addBalance, resetSpend, validatePlans, validatePacotes,
  _reloadState: () => { _state = null; },
  _garantirBonusDoDia: garantirBonusDoDia,   // hook de teste (mesmo espírito de _reloadState)
};
