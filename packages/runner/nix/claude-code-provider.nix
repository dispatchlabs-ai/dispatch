{ runCommand, applyPatches, fetchFromGitHub, nodejs_24, runner }:
let
  revision = "d5b5e04c314d3452d357174d16d10dda34daa2d2";
  upstream = fetchFromGitHub {
    owner = "earendil-works";
    repo = "pi-claude-code";
    rev = revision;
    hash = "sha256-86zfGr9YoM+I/PmWHDJb8AbcxhYC1m8aOeghJjvN414=";
  };
  # Claude Code's history replay omits signed thinking from earlier assistant turns;
  # restore Pi's canonical assistant content so reasoning survives tool-use boundaries.
  source = applyPatches {
    name = "pi-claude-code-source";
    src = upstream;
    patches = [ ./pi-claude-code-replay-thinking.patch ];
  };
in runCommand "pi-claude-code-${builtins.substring 0 12 revision}-replay-thinking" { } ''
  mkdir -p "$out/lib/pi-claude-code"
  cp ${source}/{LICENSE,README.md,ARCHITECTURE.md} "$out/lib/pi-claude-code/"
  cp ${source}/src/inert-mcp.mjs "$out/lib/pi-claude-code/"
  ln -s ${runner}/lib/agent-node_modules "$out/lib/pi-claude-code/node_modules"
  ${nodejs_24}/bin/node --input-type=module - ${source}/src "$out/lib/pi-claude-code" <<'JS'
  import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { stripTypeScriptTypes } from 'node:module';
  const [source, output] = process.argv.slice(2);
  for (const file of readdirSync(source).filter(file => file.endsWith('.ts'))) {
    const javascript = stripTypeScriptTypes(readFileSync(join(source, file), 'utf8'), { mode: 'transform' })
      .replace(/(from\s+"\.[^"]*)\.ts"/g, '$1.js"');
    writeFileSync(join(output, file.replace(/\.ts$/, '.js')), javascript);
  }
  writeFileSync(join(output, 'index.js'), readFileSync(join(output, 'index.js'), 'utf8')
    + '\nexport { closeClaudeProcesses } from "./claude-cli.js";\n');
  writeFileSync(join(output, 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
  writeFileSync(join(output, 'source.json'), JSON.stringify({
    repository: 'https://github.com/earendil-works/pi-claude-code', revision: '${revision}', patches: ['replay-thinking']
  }) + '\n');
  JS
''
