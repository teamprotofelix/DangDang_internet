// Return only an identity result to the service worker. PDF text stays in memory here.
import { getDocument, GlobalWorkerOptions } from './vendor/pdfjs/build/pdf.min.mjs';

GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/build/pdf.worker.min.mjs');

async function readIdentity({ encoded, app, doc }) {
  const data = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  const loading = getDocument({
    data,
    cMapUrl: chrome.runtime.getURL('vendor/pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: chrome.runtime.getURL('vendor/pdfjs/standard_fonts/'),
    useWasm: false,
    isEvalSupported: false,
    enableXfa: false,
    stopAtErrors: true
  });
  const timeout = setTimeout(() => { void loading.destroy().catch(() => {}); }, 12000);
  try {
    const pdf = await loading.promise;
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    const text = content.items.map(item => typeof item.str === 'string'
      ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
    return globalThis.KiprisPdfIdentity.read(text, app, doc);
  } finally {
    clearTimeout(timeout);
    await loading.destroy().catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== 'kipris_pdf_identity' || sender.id !== chrome.runtime.id || sender.tab
    || sender.url !== chrome.runtime.getURL('background.js')) return false;
  readIdentity(message).then(identity => reply({ identity }), () => reply({ error: 'pdf_read' }));
  return true;
});
