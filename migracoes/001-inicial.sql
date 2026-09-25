-- ═══════════════════════════════════════════════════════════════════════
-- NASCERA — schema inicial
--
-- Substitui os arquivos JSON que hoje guardam todo o estado do produto.
-- Cada tabela resolve uma falha concreta do arquivo que ela aposenta; os
-- comentários dizem qual.
--
-- Convenção herdada do license-server (a metade da casa que já usa Postgres).
-- Migrations são VERSIONADAS: este arquivo nunca é editado depois de aplicado
-- em produção — mudança vira 002-, 003-, e assim por diante.
-- ═══════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ── usuarios ← users.json ────────────────────────────────────────────
-- O JSON misturava chaves que não são usuário (ex.: "_tema_adm") no mesmo
-- objeto iterado como lista de contas. Aqui, quem está na tabela é conta.
CREATE TABLE IF NOT EXISTS usuarios (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      CITEXT UNIQUE NOT NULL,
  nome          TEXT,
  email         CITEXT UNIQUE,
  senha_hash    TEXT NOT NULL,          -- 'scrypt$N$r$p$salt$hash' — mesmo formato de senhas.js
  papel         TEXT NOT NULL DEFAULT 'user' CHECK (papel IN ('user','admin')),
  data_dir      TEXT,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── projetos ← projects.json ─────────────────────────────────────────
-- Aposenta: busca O(n) com find(), rewrite do array inteiro para mudar um
-- campo (27 pontos no server.js) e o lost-update de custo no caminho quente.
CREATE TABLE IF NOT EXISTS projetos (
  id                UUID PRIMARY KEY,             -- PRESERVA o id do JSON
  owner_username    CITEXT NOT NULL,              -- espelho para RLS sem join
  owner_id          UUID REFERENCES usuarios(id) ON DELETE RESTRICT,
  nome              TEXT NOT NULL,
  slug              CITEXT UNIQUE NOT NULL,
  path              TEXT,
  published_path    TEXT,
  preview_url       TEXT,
  publish_url       TEXT,
  current_version   INT NOT NULL DEFAULT 0,
  published_version INT NOT NULL DEFAULT 0,
  -- TEXT, não UUID: hoje o Claude emite UUID, mas o id de sessão do Codex é
  -- opaco e pode não ser. Fixar UUID derrubaria o turno num cast inválido.
  session_id        TEXT,
  active_agent      TEXT,
  build_level       INT,
  theme_id          TEXT,
  scaffolded        BOOLEAN NOT NULL DEFAULT false,
  palette_id        TEXT,
  palette_url       TEXT,
  custom_palette    JSONB,
  claude_effort     TEXT,
  thumbnail         TEXT,
  cost_usd          NUMERIC(12,6) NOT NULL DEFAULT 0,
  -- Campos novos entram aqui sem migração de forma (o JSON divergiu entre
  -- projects.json e trash.json justamente por não ter onde pousar).
  extra             JSONB NOT NULL DEFAULT '{}',
  origem            TEXT NOT NULL DEFAULT 'proprio' CHECK (origem IN ('proprio','vinculado')),
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_projetos_owner   ON projetos(owner_username);
CREATE INDEX IF NOT EXISTS idx_projetos_session ON projetos(session_id);

-- ── lixeira ← trash.json ─────────────────────────────────────────────
-- Excluir era 3 escritas sem transação (pasta + trash.json + projects.json):
-- um crash no meio deixava o projeto duplicado ou órfão. Agora os metadados
-- viram UMA transação; o movimento da pasta segue por caminhos-seguros.js.
CREATE TABLE IF NOT EXISTS lixeira (
  id             UUID PRIMARY KEY,
  owner_username CITEXT NOT NULL,
  nome           TEXT,
  slug           CITEXT,
  snapshot       JSONB NOT NULL,        -- o projeto inteiro, para restaurar
  trash_path     TEXT,
  arquivos       TEXT,                  -- 'na lixeira' | 'preservados' | 'mantidos'
  deletado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lixeira_expira ON lixeira(expira_em);
CREATE INDEX IF NOT EXISTS idx_lixeira_owner  ON lixeira(owner_username);

-- ── dominios ← domains.json ──────────────────────────────────────────
-- PK no domínio dá anti-colisão de graça; o índice parcial garante
-- "um principal por projeto" que hoje é mantido à mão.
CREATE TABLE IF NOT EXISTS dominios (
  dominio            TEXT PRIMARY KEY,
  projeto_id         UUID NOT NULL REFERENCES projetos(id) ON DELETE CASCADE,
  slug               CITEXT,
  owner_username     CITEXT,
  status             TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','ativo','erro')),
  token              TEXT NOT NULL,
  principal          BOOLEAN NOT NULL DEFAULT false,
  pointing           BOOLEAN,
  erro               TEXT,
  ultima_checagem    JSONB,
  verificado_em      TIMESTAMPTZ,
  ultima_checagem_em TIMESTAMPTZ,
  criado_em          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dominios_projeto ON dominios(projeto_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dominio_principal ON dominios(projeto_id) WHERE principal;

-- ── billing ← billing.json (4 tabelas) ───────────────────────────────
-- O coração das regras invioláveis. O JSON tinha: débito read-modify-write,
-- idempotência num anel capado (retry velho cobrava em dobro) e crash no
-- save truncando o arquivo do dinheiro.
CREATE TABLE IF NOT EXISTS contas_credito (
  username     CITEXT PRIMARY KEY,
  usuario_id   UUID REFERENCES usuarios(id) ON DELETE CASCADE,
  plano        TEXT NOT NULL DEFAULT 'free',
  -- CHECK impede saldo negativo no próprio banco: nenhuma ordem de operações
  -- no código consegue furar isso.
  saldo_milli  BIGINT NOT NULL DEFAULT 0 CHECK (saldo_milli >= 0),
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cortesias (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username        CITEXT NOT NULL REFERENCES contas_credito(username) ON DELETE CASCADE,
  label           TEXT,
  restante_milli  BIGINT NOT NULL CHECK (restante_milli >= 0),
  expira_em       TIMESTAMPTZ,
  criada_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cortesias_ativas ON cortesias(username) WHERE restante_milli > 0;

CREATE TABLE IF NOT EXISTS janelas_gasto (
  username     CITEXT NOT NULL REFERENCES contas_credito(username) ON DELETE CASCADE,
  escopo       TEXT NOT NULL CHECK (escopo IN ('session','day','week','month')),
  chave        TEXT,                  -- '2026-08-07', '2026-W32'… reset preguiçoso
  inicio_ts    TIMESTAMPTZ,
  usd          NUMERIC(14,6) NOT NULL DEFAULT 0,
  base_usd     NUMERIC(14,6) NOT NULL DEFAULT 0,
  charged_usd  NUMERIC(14,6) NOT NULL DEFAULT 0,
  PRIMARY KEY (username, escopo)
);

CREATE TABLE IF NOT EXISTS eventos_uso (
  id            BIGSERIAL PRIMARY KEY,
  username      CITEXT NOT NULL,
  turn_id       TEXT NOT NULL,
  base_usd      NUMERIC(14,6),
  charged_usd   NUMERIC(14,6),
  per_model     JSONB,
  cost_milli    BIGINT,
  from_grants   BIGINT,
  from_balance  BIGINT,
  remainder_usd NUMERIC(14,6),
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Idempotência PERMANENTE — aposenta o anel de 300 que deixava um retry
  -- antigo cobrar duas vezes. É o banco que garante, não a memória.
  UNIQUE (username, turn_id)
);
CREATE INDEX IF NOT EXISTS idx_eventos_uso_user ON eventos_uso(username, criado_em DESC);

-- ── log_atividade ← activity-log.json ────────────────────────────────
-- Fim do rewrite do arquivo inteiro por evento e do cap silencioso de 400.
CREATE TABLE IF NOT EXISTS log_atividade (
  id       BIGSERIAL PRIMARY KEY,
  tipo     TEXT NOT NULL,
  usuario  CITEXT,
  dados    JSONB,
  em       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_log_em   ON log_atividade(em DESC);
CREATE INDEX IF NOT EXISTS idx_log_tipo ON log_atividade(tipo, em DESC);
