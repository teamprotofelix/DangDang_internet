import { cp, mkdir } from 'node:fs/promises';

const source = new URL('../node_modules/pdfjs-dist/', import.meta.url);
const destination = new URL('../vendor/pdfjs/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const path of ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs', 'cmaps', 'standard_fonts', 'LICENSE']) {
  const input = path.startsWith('build/') ? 'legacy/' + path : path;
  await cp(new URL(input, source), new URL(path, destination), { recursive: true });
}
