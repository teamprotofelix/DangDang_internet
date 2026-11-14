import { cp, mkdir, readdir, rm } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const destination = new URL('dist/DangDang_internet/', root);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
const runtime = (await readdir(root)).filter(name => /\.(?:js|mjs|html|css)$/.test(name));
for (const path of [...runtime, 'manifest.json', 'README.md', 'LICENSE', 'assets', 'icons', 'prompts', 'hwpx-template']) {
  await cp(new URL(path, root), new URL(path, destination), { recursive: true });
}
console.log('Installable extension prepared at dist/DangDang_internet');
