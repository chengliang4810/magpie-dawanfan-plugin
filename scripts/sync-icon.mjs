import { readFile, writeFile } from 'node:fs/promises';
const packageURL = new URL('../package.json', import.meta.url);
const manifest = JSON.parse(await readFile(packageURL, 'utf8'));
const svg = await readFile(new URL('../assets/logo.svg', import.meta.url));
manifest.magpie.icon = `data:image/svg+xml;base64,${svg.toString('base64')}`;
await writeFile(packageURL, `${JSON.stringify(manifest, null, 2)}\n`);
