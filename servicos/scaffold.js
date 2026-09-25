// ═══════════════════════════════════════════════════════════════════════
// NASCERA — scaffold e CLAUDE.md do projeto (S4-2: extraído do server.js)
//
// findThemePath, scaffoldFromTheme (copia o template p/ o projeto),
// resolveThemeContent (instruções do tema), composeClaudeMd (monta o CLAUDE.md:
// system-prompt + agente + tema + paleta) e initGit (grava CLAUDE.md + git init).
// Fábrica criar(deps). composeClaudeMd é exportado porque switchAgentForProject
// (server.js) o reusa. Exercido pelo test:fake (POST /api/projects → initGit).
// ═══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const logger = require('../log.js');
const path = require('path');

function criar(deps) {
  const { RAIZ, AGENTS_DIR, THEMES_BASE, git, writeProjectSkill } = deps;

  function findThemePath(themeId) {
    const THEMES_BASE = path.join(RAIZ, 'themes');
    const categories = [
      'design-systems/temas_escuros','design-systems/temas_claros','design-systems/componentes',
      'sites/1_temas_escuros','sites/2_temas_claros','sites/3_componentes',
    ];
    const cleanId = String(themeId).replace('site-', '');
    // S0-5: `cleanId` vinha direto do cliente para o path.join sem barrar `..`.
    // `themeId="../../../public"` resolvia para fora de themes/ e existsSync
    // casava — vazando/escafoldando diretório arbitrário. Confina no THEMES_BASE.
    const RAIZ_TEMAS = path.resolve(THEMES_BASE);
    for (const cat of categories) {
      const p = path.join(THEMES_BASE, cat, cleanId);
      const resolvido = path.resolve(p);
      if (resolvido !== RAIZ_TEMAS && !resolvido.startsWith(RAIZ_TEMAS + path.sep)) continue;
      if (fs.existsSync(p)) {
        return {
          themePath: p,
          catLabel: cat.includes('claro') ? 'Claro' : 'Escuro',
          themeName: cleanId.replace(/[-_.]/g, ' ').replace(/aura build/g, '').trim(),
        };
      }
    }
    return null;
  }

  // Scaffold-first: copia os arquivos do tema direto para a pasta do projeto na criação.
  // O preview mostra o layout real do template em ~1s, e o Claude passa a EDITAR o site
  // (conteúdo, marca, paleta) em vez de ler os HTMLs de referência inteiros e recriar tudo
  // do zero — que era o grande custo de tempo até o primeiro layout.
  function scaffoldFromTheme(themeId, projectPath) {
    const found = findThemePath(themeId);
    if (!found || !projectPath) return false;
    const { themePath } = found;
    if (!fs.existsSync(path.join(themePath, 'index.html'))) return false;   // tema sem página → sem scaffold
    if (fs.existsSync(path.join(projectPath, 'index.html'))) return false;  // nunca sobrescreve projeto com conteúdo
    fs.cpSync(themePath, projectPath, { recursive: true });
    // design-system.html é documentação dos tokens, não página do site → vai para .references/
    const dsInProject = path.join(projectPath, 'design-system.html');
    if (fs.existsSync(dsInProject)) {
      const refDir = path.join(projectPath, '.references');
      if (!fs.existsSync(refDir)) fs.mkdirSync(refDir, { recursive: true });
      fs.renameSync(dsInProject, path.join(refDir, 'design-system.html'));
    }
    return true;
  }

  // Resolve theme: copies reference files into project and returns CLAUDE.md instructions to read them
  function resolveThemeContent(themeId, projectPath, scaffolded) {
    const found = findThemePath(themeId);
    if (!found) return '';
    const { themePath, catLabel, themeName } = found;

    // Modo scaffold: o template JÁ está copiado no projeto. Dois modos de uso:
    // pedido do MESMO tipo do template → adaptar por edições; pedido de tipo DIFERENTE
    // (ex.: dashboard sobre template de landing) → construir o pedido com o DNA visual do tema.
    if (scaffolded) {
      let s = '---\n\n';
      s += '# TEMA APLICADO NO PROJETO (scaffold)\n\n';
      s += `O projeto JA CONTEM os arquivos do tema **${themeName}** (${catLabel}): \`index.html\` + \`assets/\` (CSS, fontes, imagens, icones, scripts). Isso e o DESIGN SYSTEM VIVO do projeto — cores, tipografia, espacamentos, componentes, animacoes e assets prontos para reuso. \`.references/design-system.html\` documenta os tokens.\n\n`;
      s += '## Decida o modo de trabalho pelo pedido do usuario\n\n';
      s += '### MODO ADAPTAR — quando o pedido e do MESMO tipo de pagina que o template (landing, site institucional, portfolio, catalogo...)\n';
      s += '1. NAO recrie nada do zero e NAO reescreva o arquivo inteiro — use **Edit** (edicoes pontuais) no index.html existente.\n';
      s += '2. Reescreva TODO o conteudo textual (titulos, subtitulos, features, precos, FAQ, CTAs, footer, nome/marca) para o projeto pedido. Nenhum texto do template pode permanecer.\n';
      s += '3. Adicione/remova/duplique secoes reaproveitando os componentes e classes do proprio tema.\n\n';
      s += '### MODO CONSTRUIR COM O DNA DO TEMA — quando o pedido e um tipo DIFERENTE de aplicacao (dashboard, sistema, app, ferramenta, area logada...)\n';
      s += 'Transformar a pagina atual por edicoes NAO faz sentido nesse caso. Construa exatamente o que o usuario pediu, vestido com o design do tema:\n';
      s += '1. Preserve o original como referencia: `mv index.html .references/site-original.html` (os `assets/` FICAM onde estao — CSS, fontes, imagens e icones continuam funcionando nos caminhos relativos).\n';
      s += '2. Crie o novo `index.html` comecando pelo `<head>` do original — copie os `<link>`, `<style>` e `<script>` dele integralmente (e permitido e recomendado; e o jeito mais rapido de herdar fontes, CSS e libs do tema).\n';
      s += '3. Construa o `<body>` novo reaproveitando as classes e os padroes de markup dos componentes do tema: nav, cards, botoes, badges, tabelas, sombras, border-radius, gradientes, animacoes.\n';
      s += '4. Reuse imagens, icones e ilustracoes de `assets/` quando fizerem sentido no novo contexto. Se o tema ja carrega libs (iconify, chart.js...), USE-AS — ex.: graficos de dashboard com a lib que ja esta no head.\n';
      s += '5. O resultado deve parecer um produto da MESMA FAMILIA visual do template — nunca um layout generico.\n\n';
      s += '## Regras nos dois modos\n';
      s += '- Se o usuario escolheu uma paleta, aplique-a nas variaveis/cores principais do CSS logo no inicio (edicao rapida e cirurgica).\n';
      s += '- Conteudo 100% sobre o projeto pedido; nunca deixe textos do template no resultado final.\n';
      s += '- Velocidade: leia o index.html do tema UMA vez para mapear estrutura/classes; prefira Edit a reescrever arquivos; nao releia arquivos grandes sem necessidade.\n';
      return s;
    }

    // Copy reference files into project/.references/
    if (projectPath) {
      const refDir = path.join(projectPath, '.references');
      if (!fs.existsSync(refDir)) fs.mkdirSync(refDir, { recursive: true });

      const dsPath = path.join(themePath, 'design-system.html');
      if (fs.existsSync(dsPath)) {
        fs.copyFileSync(dsPath, path.join(refDir, 'design-system.html'));
      }
      const indexPath = path.join(themePath, 'index.html');
      if (fs.existsSync(indexPath)) {
        fs.copyFileSync(indexPath, path.join(refDir, 'site-referencia.html'));
      }
    }

    // Return compact prompt that tells Claude to READ the files
    let content = '---\n\n';
    content += '# TEMA DE REFERENCIA SELECIONADO (OBRIGATORIO)\n\n';
    content += `O usuario escolheu o tema **${themeName}** (${catLabel}) como referencia visual.\n\n`;
    content += '## INSTRUCOES CRITICAS — LEIA ANTES DE CRIAR QUALQUER ARQUIVO\n\n';
    content += '1. **PRIMEIRO**, leia o arquivo `.references/design-system.html` — ele contem o design system completo (cores, tipografia, espacamentos, componentes, animacoes)\n';
    content += '2. **SEGUNDO**, leia o arquivo `.references/site-referencia.html` — ele contem o site de referencia com a ESTRUTURA de secoes, layout e componentes\n';
    content += '3. **COPIE FIELMENTE** o design visual: paleta de cores, gradientes, sombras, border-radius, fontes, animacoes, estilos CSS\n';
    content += '4. **SIGA A ESTRUTURA** de secoes e componentes do site de referencia (hero, features, pricing, FAQ, footer, etc)\n';
    content += '5. **NAO COPIE O CONTEUDO TEXTUAL** do site de referencia. O texto, titulos, descricoes, features e FAQ devem ser 100% sobre o projeto que o usuario pediu. O template e APENAS referencia VISUAL e ESTRUTURAL.\n';
    content += '6. **ADAPTE** todo o conteudo textual ao contexto real do projeto do usuario\n\n';
    content += '> IMPORTANTE: O template de referencia e SOMENTE para copiar o DESIGN (cores, layout, componentes, animacoes).\n';
    content += '> O CONTEUDO (textos, titulos, descricoes, FAQs) deve ser 100% original e relevante ao projeto do usuario.\n';
    content += '> Os arquivos em .references/ sao somente leitura — NAO os modifique.\n';

    return content;
  }

  function composeClaudeMd(projectData) {
    try {
      // BASE: the original system-prompt.md (the proven, working prompt)
      const systemPromptSrc = path.join(RAIZ, 'system-prompt.md');
      let base = fs.existsSync(systemPromptSrc) ? fs.readFileSync(systemPromptSrc, 'utf8') : '';

      // LAYER: agent context (appended, not replacing)
      const activeAgent = projectData.activeAgent || 'dev';
      const agentFile = path.join(AGENTS_DIR, activeAgent + '.md');
      const agentDef = fs.existsSync(agentFile) ? fs.readFileSync(agentFile, 'utf8') : '';
      const manifestFile = path.join(AGENTS_DIR, 'agent-manifest.md');
      const manifest = fs.existsSync(manifestFile) ? fs.readFileSync(manifestFile, 'utf8') : '';

      let result = base;

      // Resolve o tema selecionado primeiro (copia p/ .references/ + texto compacto)
      let themeContent = projectData.themeContent || '';
      if (!themeContent && projectData.themeId) {
        themeContent = resolveThemeContent(projectData.themeId, projectData.path, !!projectData.scaffolded);
      }

      // Sem tema escolhido: em vez de embutir o designsystem.md inteiro (289 linhas) no
      // CLAUDE.md de todo build, copia p/ .references/ e aponta — e oferece o caminho melhor:
      // a skill nascera-templates, que deixa a IA escolher um template real do catálogo.
      if (!themeContent) {
        const baseDS = path.join(RAIZ, 'designsystem.md');
        if (fs.existsSync(baseDS)) {
          let pointed = false;
          if (projectData.path && fs.existsSync(projectData.path)) {
            try {
              const refDir = path.join(projectData.path, '.references');
              fs.mkdirSync(refDir, { recursive: true });
              fs.copyFileSync(baseDS, path.join(refDir, 'design-system-base.md'));
              pointed = true;
            } catch {}
          }
          result += '\n\n---\n\n# Visual (sem tema escolhido)\n\n';
          if (pointed) {
            result += 'O usuario NAO escolheu template. Nesta ordem de preferencia:\n';
            result += '1. **Use a skill `nascera-templates`**: escolha no catalogo o template que melhor casa com o pedido e aplique-o como ponto de partida (visual profissional em segundos).\n';
            result += '2. So se o pedido exigir um visual muito especifico que nenhum template atende: crie design proprio seguindo o guia `.references/design-system-base.md`.\n';
          } else {
            result += 'O usuario nao escolheu um tema. Use este design system como base visual.\n\n';
            result += fs.readFileSync(baseDS, 'utf8');
          }
        }
      }

      // Camada de agente: SÓ quando um agente especializado foi ativado via @mention/seletor.
      // No fluxo padrão (@dev) não injetamos persona nem manifesto — o comportamento nativo do
      // Claude Code é o ideal para construir, e as restrições da persona ("consulte @ux",
      // "explique antes de implementar", "mostre código no chat") só freiam e poluem o build.
      if (activeAgent !== 'dev') {
        result += '\n\n---\n\n';
        result += '# Modo de Agente Ativo\n\n';
        result += manifest + '\n\n';
        result += '## Agente Atual: @' + activeAgent + '\n\n';
        result += agentDef + '\n\n';
        result += 'IMPORTANTE: As diretrizes acima (qualidade, design bonito, workflow) continuam validas. ';
        result += 'O agente ativo adiciona foco e especialidade, mas NAO substitui as regras gerais.\n';
      }

      // Tema selecionado (já resolvido acima) — aponta o Claude para .references/
      if (themeContent) {
        result += '\n\n' + themeContent;
      }

      // Palette info
      if (projectData.paletteId || projectData.customPalette || projectData.paletteUrl) {
        const PALETTES = {
          'periwinkle-slate': { name: 'Periwinkle Slate', colors: ['#6666FF','#B8B8FF','#C5D8FF','#0C0A16','#1A1A2E'] },
          'branding-orange': { name: 'Branding Orange', colors: ['#E8600C','#FF8C00','#000000','#BABABA','#FFFFFF'] },
          'neon-teal': { name: 'Neon Teal', colors: ['#E6FF2B','#0B4650','#F9F7F2','#898A8D'] },
          'warm-copper': { name: 'Warm Copper', colors: ['#FF6D29','#453027','#1D1316','#BABABA','#FFFFFF'] },
          'burgundy-sand': { name: 'Burgundy Sand', colors: ['#4A1520','#E74B3C','#D4B896'] },
          'coastal-warm': { name: 'Coastal Warm', colors: ['#EEE9DF','#C9C1B1','#2C3840','#FFB162','#A35139','#1B2632'] },
          'nft-vibe': { name: 'NFT Vibe', colors: ['#FEFFFC','#D0FF00','#B116E0','#000000'] },
          'black-orange': { name: 'Black & Orange', colors: ['#171717','#F25623','#4D4D4D','#D1D1D1'] },
          'mirage-blaze': { name: 'Mirage & Blaze', colors: ['#16232A','#FF5B04','#079056','#E4EEF0'] },
          'deep-violet': { name: 'Deep Violet', colors: ['#0A0A2E','#1A1A5E','#8B5CF6','#E0D0FF','#FFFFFF'] },
          'neon-studio': { name: 'Neon Studio', colors: ['#1A1A1A','#2A2A2A','#D4FF00','#FFFFFF','#999999'] },
          'luca-davinci': { name: 'Luca Davinci', colors: ['#555555','#525254','#383838','#242323','#795238','#AEA7A5'] },
          'smoky-bone': { name: 'Smoky Bone', colors: ['#11120D','#565449','#D8CFBC','#FFFBF4'] },
          'forest-sage': { name: 'Forest Sage', colors: ['#051F20','#0B2B26','#163832','#235347','#8EB69B','#DAF1DE'] },
          'emerald-mint': { name: 'Emerald Mint', colors: ['#00291F','#003227','#009A6C','#23C58E','#00FF8F','#F0FFF0'] },
        };
        result += '\n\n---\n\n# Paleta de Cores Selecionada (OBRIGATORIA)\n\n';
        if (projectData.paletteId && PALETTES[projectData.paletteId]) {
          const p = PALETTES[projectData.paletteId];
          result += 'O usuario selecionou a paleta **' + p.name + '**.\n';
          result += 'Cores: ' + p.colors.join(', ') + '\n\n';
          result += 'INSTRUCAO: Use EXATAMENTE estas cores como paleta cromatica principal. Derive tons, sombras e gradientes a partir delas.\n';
        } else if (projectData.customPalette) {
          result += 'O usuario forneceu paleta personalizada. Cores: ' + projectData.customPalette + '\n\n';
          result += 'INSTRUCAO: Use estas cores como base cromatica.\n';
        } else if (projectData.paletteUrl) {
          result += 'O usuario quer extrair paleta de: ' + projectData.paletteUrl + '\n\n';
          result += 'INSTRUCAO: Analise o link e extraia a paleta predominante para usar no projeto.\n';
        }
      }

      return result;
    } catch (err) {
      logger.error('[AGENTS] Failed to compose CLAUDE.md:', err.message);
      const fallback = path.join(RAIZ, 'system-prompt.md');
      return fs.existsSync(fallback) ? fs.readFileSync(fallback, 'utf8') : '';
    }
  }

  // Initialize git in a project directory + inject CLAUDE.md system prompt
  function initGit(projectPath, themeData, projectMeta) {
    const claudeMdDest = path.join(projectPath, 'CLAUDE.md');

    // Escreve o CLAUDE.md só se ainda não existir: pasta VINCULADA pode ser um projeto real
    // com CLAUDE.md próprio — clobberar o arquivo do usuário seria destrutivo.
    if (!fs.existsSync(claudeMdDest)) {
      const composed = composeClaudeMd({
        ...projectMeta,
        path: projectPath,
        activeAgent: 'dev',
      });
      fs.writeFileSync(claudeMdDest, composed, 'utf8');
    }
    // Skill de templates disponível em todo projeto (buscar/aplicar/trocar tema sob demanda)
    writeProjectSkill(projectPath);

    if (!fs.existsSync(path.join(projectPath, '.git'))) {
      git(['init'], projectPath);
      git(['config','user.name','Nascera AI'], projectPath);
      git(['config','user.email','nascera@localhost'], projectPath);
      git(['add','-A'], projectPath);
      git(['commit','-m','Initial commit','--allow-empty'], projectPath);
    }
  }

  return { findThemePath, scaffoldFromTheme, resolveThemeContent, composeClaudeMd, initGit };
}

module.exports = { criar };
