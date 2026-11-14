import { existsSync, readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Chrome Manifest V3 required');

const worker = manifest.background.service_worker;
const pages = [manifest.side_panel.default_path, 'kipris-offscreen.html'];
const dependencies = [
  worker,
  ...pages,
  ...manifest.content_scripts.flatMap(entry => [...entry.js, ...(entry.css || [])]),
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  ...pages.flatMap(page => [...readFileSync(page, 'utf8').matchAll(/<script[^>]+src="([^"]+)"/g)]
    .map(([, source]) => source)),
  ...[...readFileSync(worker, 'utf8').match(/importScripts\(([^)]*)\)/)[1].matchAll(/'([^']+)'/g)]
    .map(([, source]) => source),
  'vendor/pdfjs/build/pdf.min.mjs',
  'vendor/pdfjs/build/pdf.worker.min.mjs'
];
for (const file of dependencies) if (!existsSync(file)) throw new Error('Missing file: ' + file);
if (manifest.host_permissions.some(host => /^http:\/\//.test(host) && !/^http:\/\/(localhost|127\.0\.0\.1)\//.test(host))) {
  throw new Error('Only loopback hosts can allow HTTP.');
}
console.log('Manifest V3 dependencies validated.');
