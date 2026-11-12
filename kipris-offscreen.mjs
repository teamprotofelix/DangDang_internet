import { getDocument, GlobalWorkerOptions } from './vendor/pdfjs/build/pdf.min.mjs';

GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/build/pdf.worker.min.mjs');

async function extractPdf(encoded) {
  const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  const loading = getDocument({
    data: bytes,
    cMapUrl: chrome.runtime.getURL('vendor/pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: chrome.runtime.getURL('vendor/pdfjs/standard_fonts/'),
    useWasm: false,
    isEvalSupported: false,
    enableXfa: false,
    stopAtErrors: true
  });
  try {
    const pdf = await loading.promise;
    if (!pdf.numPages || pdf.numPages > 300) return { pageCount: pdf.numPages, pages: [] };
    const pages = [];
    let size = 0;
    for (let page = 1; page <= pdf.numPages; page++) {
      const data = await (await pdf.getPage(page)).getTextContent();
      const text = data.items.map(item => typeof item.str === 'string'
        ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
      size += text.length;
      if (size > 1500000) return { pageCount: pdf.numPages, pages: [] };
      pages.push({ page, text });
    }
    return { pageCount: pdf.numPages, pages };
  } finally {
    await loading.destroy();
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== 'kipris_pdf_parse' || sender.id !== chrome.runtime.id || sender.tab
    || sender.url !== chrome.runtime.getURL('background.js')) return false;
  extractPdf(message.encoded).then(
    result => reply({ result }),
    error => reply({ error: error?.name === 'PasswordException' ? 'pdf_password' : 'pdf_parse' })
  );
  return true;
});
