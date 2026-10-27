import { readFileSync, mkdirSync, cpSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Source/GitHub installs need ordinary transitive dependencies. Only the
// offline release artifact may claim that playwright-core is bundled.
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const stage = join(root, '.release-stage', manifest.version);
mkdirSync(stage, { recursive: true });
for (const item of ['index.mjs', 'lib', 'assets/logo.svg', 'README.md', 'docs', 'LICENSE']) {
  const target = join(stage, item);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(root, item), target, { recursive: true });
}
const core = dirname(createRequire(import.meta.url).resolve('playwright-core/package.json'));
mkdirSync(join(stage, 'node_modules'), { recursive: true });
cpSync(core, join(stage, 'node_modules', 'playwright-core'), { recursive: true });
manifest.bundledDependencies = ['playwright-core'];
writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(stage);
