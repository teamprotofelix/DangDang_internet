// The offscreen parser only checks identity on the first page.
globalThis.KiprisPdfIdentity = (() => {
  function matches(text, app, doc) {
    const first = text.normalize('NFKC');
    const compact = first.replace(/\s/g, '');
    const correction = doc.kind === 'CORR_PUB' || doc.kind === 'CORR_REG';
    const publication = doc.kind === 'PUB' || doc.kind === 'CORR_PUB';
    const application = [...first.matchAll(/출\s*원\s*번\s*호[ \t:：]*([\d \t-]+)/g)]
      .map(match => match[1].replace(/[^\d]/g, ''));
    if (!application.length || !application.every(number => number === app)) return false;

    const label = publication ? '공\\s*개\\s*번\\s*호' : '등\\s*록\\s*번\\s*호';
    const expectedLength = publication ? 13 : 9;
    const numbers = new Set([...first.matchAll(new RegExp(label + '[ \\t:：]*([\\d \\t-]+)', 'g'))]
      .map(match => match[1].replace(/[^\d]/g, ''))
      .filter(number => /^(10|20)\d+$/.test(number) && number.length === expectedLength));
    if (numbers.size !== 1 || (doc.gazetteNumber && !numbers.has(doc.gazetteNumber))) return false;
    const heading = compact.slice(0, 500);
    if (!(publication ? /공개/ : /등록/).test(heading)) return false;
    const corrected = /정정공[보고]/.test(heading);
    if (!correction) return !corrected && (publication ? /공개(?:특허|실용신안)?공보/ : /등록(?:특허|실용신안)?공보/).test(heading);

    const expectedDate = doc.date;
    const dates = [...first.matchAll(/(?<!\d)(\d{4})(?:[.\/-]\s*|\s*년\s*)?(\d{1,2})(?:[.\/-]\s*|\s*월\s*)?(\d{1,2})(?!\d)/g)]
      .map(([, year, month, day]) => year + month.padStart(2, '0') + day.padStart(2, '0'));
    if (!corrected || !dates.includes(expectedDate)) return false;
    const serials = [...first.matchAll(
      /정\s*정\s*공\s*[고보]\s*(?:일\s*련(?:\s*번\s*호)?|순\s*번|연\s*번|회\s*차|번\s*호)[ \t:：]*(\d+)(?![ \t]*-|\d)/g)]
      .map(match => match[1].replace(/^0+(?=\d)/, ''));
    const expectedSerial = doc.serial.replace(/^0+(?=\d)/, '');
    return serials.length > 0 && serials.every(serial => serial === expectedSerial);
  }
  return { matches };
})();
