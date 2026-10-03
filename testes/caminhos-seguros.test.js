// testes/caminhos-seguros.test.js
// Rodar: node --test testes/caminhos-seguros.test.js
//
// O acidente que este teste prende: no servidor, um projeto foi conectado à
// pasta da PRÓPRIA INSTALAÇÃO (/root/nascera). O motor de IA, o editor e o dev
// server passaram a operar sobre o código do produto, e o `chown -R` do
// vínculo entregou `.env` e `users.json` ao usuário do motor.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const seguranca = require('../caminhos-seguros.js');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nascera-test-caminhos-')));
const AREA = path.join(tmp, 'area');
const INSTALACAO = path.join(tmp, 'instalacao');
const FORA = path.join(tmp, 'fora', 'site');
for (const d of [path.join(AREA, 'meu-projeto'), path.join(INSTALACAO, 'rotas'), FORA]) {
  fs.mkdirSync(d, { recursive: true });
}

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('a instalação, o que está dentro dela e o que a contém não podem ser conectados', () => {
  seguranca.configurar(AREA, { instalacao: INSTALACAO });
  assert.match(seguranca.motivoParaRecusar(INSTALACAO), /instalação/);
  assert.match(seguranca.motivoParaRecusar(path.join(INSTALACAO, 'rotas')), /instalação/);
  assert.match(seguranca.motivoParaRecusar(tmp), /instalação|área de projetos/);
});

test('pastas de sistema e de credenciais são recusadas por prefixo, não só por igualdade', () => {
  seguranca.configurar(AREA, { instalacao: INSTALACAO });
  assert.ok(seguranca.motivoParaRecusar(path.join(os.homedir(), '.ssh')));
  assert.ok(seguranca.motivoParaRecusar(path.join(os.homedir(), '.ssh', 'chaves')));
  assert.ok(seguranca.motivoParaRecusar('/etc/caddy'));
  assert.ok(seguranca.motivoParaRecusar('/usr/local/lib'));
});

test('desktop: pasta comum fora da área continua podendo ser conectada', () => {
  seguranca.configurar(AREA, { instalacao: INSTALACAO });
  assert.equal(seguranca.motivoParaRecusar(FORA), null);
});

test('servidor (restrito): só se conecta pasta de dentro da área de projetos', () => {
  seguranca.configurar(AREA, { instalacao: INSTALACAO, restrito: true });
  assert.equal(seguranca.restrito(), true);
  assert.match(seguranca.motivoParaRecusar(FORA), /área de projetos/);
  assert.equal(seguranca.motivoParaRecusar(path.join(AREA, 'meu-projeto')), null);
});

test('motivoParaOperar: registro antigo apontando para a instalação é barrado; os legítimos seguem', () => {
  seguranca.configurar(AREA, { instalacao: INSTALACAO, restrito: true });
  assert.match(seguranca.motivoParaOperar(INSTALACAO), /instalação/);
  assert.match(seguranca.motivoParaOperar(path.join(INSTALACAO, 'rotas')), /instalação/);
  assert.equal(seguranca.motivoParaOperar(path.join(AREA, 'meu-projeto')), null);
  // Vínculo antigo fora da área não quebra na atualização: `restrito` vale
  // para vínculo NOVO, não para o que o cliente já tinha.
  assert.equal(seguranca.motivoParaOperar(FORA), null);
});

test('área de projetos DENTRO da instalação (pasta `projetos/`) continua funcionando', () => {
  const areaInterna = path.join(INSTALACAO, 'projetos');
  fs.mkdirSync(path.join(areaInterna, 'loja'), { recursive: true });
  seguranca.configurar(areaInterna, { instalacao: INSTALACAO, restrito: true });
  assert.equal(seguranca.motivoParaOperar(path.join(areaInterna, 'loja')), null);
  assert.match(seguranca.motivoParaOperar(path.join(INSTALACAO, 'rotas')), /instalação/);
});

test('instalação DENTRO da área: a pasta da instalação não vira projeto nem por dentro da área', () => {
  seguranca.configurar(tmp, { instalacao: INSTALACAO });
  assert.match(seguranca.motivoParaOperar(INSTALACAO), /instalação/);
  assert.equal(seguranca.motivoParaOperar(AREA), null);
  // ...e o portão de exclusão não manda o produto para a lixeira.
  const r = seguranca.apagarComSeguranca(INSTALACAO, 'teste');
  assert.equal(r.ok, false);
  assert.equal(r.recusado, true);
  assert.equal(fs.existsSync(path.join(INSTALACAO, 'rotas')), true);
});

test('sem configurar a instalação (scripts, testes antigos) nada muda', () => {
  seguranca.configurar(AREA);
  assert.equal(seguranca.restrito(), false);
  assert.equal(seguranca.motivoParaRecusar(FORA), null);
  assert.equal(seguranca.motivoParaOperar(INSTALACAO), null);
});
