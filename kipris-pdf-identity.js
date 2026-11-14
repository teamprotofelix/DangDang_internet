// Read identifiers from the first page without returning any PDF text.
globalThis.KiprisPdfIdentity = (() => {
  function read(text, app, doc) {
    const first = text.normalize('NFKC');
    const compact = first.replace(/\s/g, '');
    const correction = doc.kind === 'CORR_PUB' || doc.kind === 'CORR_REG';
    const publication = doc.kind === 'PUB' || doc.kind === 'CORR_PUB';
    const application = [...first.matchAll(/출\s*원\s*번\s*호[ \t:]*([\d \t-]+)/g)]
      .map(match => match[1].replace(/[^\d]/g, ''));
    if (!application.length || !application.every(number => number === app)) return null;

    const label = publication ? '공\\s*개\\s*번\\s*호' : '등\\s*록\\s*번\\s*호';
    const expectedLength = publication ? 13 : 9;
    const numbers = new Set([...first.matchAll(new RegExp(label + '[ \\t:]*([\\d \\t-]+)', 'g'))]
      .map(match => match[1].replace(/[^\d]/g, ''))
      .filter(number => /^(10|20)\d+$/.test(number) && number.length === expectedLength));
    const [number] = numbers;
    if (numbers.size !== 1 || (doc.gazetteNumber && doc.gazetteNumber !== number)) return null;

    if (!correction) {
      const heading = compact.slice(0, 500);
      const title = publication ? /공개(?:특허|실용신안)?공보/ : /등록(?:특허|실용신안)?공보/;
      return title.test(heading) && !/정정공[보고]/.test(heading) ? { number } : null;
    }

    const titleTypes = first.split(/\r?\n/).slice(0, 12).map(line => line.replace(/\s/g, ''))
      .map(line => line.match(/^(?:\(\d{2}\))?(?:정정공[보고]\((공개|등록)(?:특허|실용신안)?\)|(?:(공개|등록)(?:특허|실용신안)?)정정공[보고])$/))
      .filter(Boolean).map(match => match[1] || match[2]);
    const expectedType = publication ? '공개' : '등록';
    if (!titleTypes.length || !titleTypes.every(type => type === expectedType)) return null;

    const dates = [...first.matchAll(
      /(?:^|[\s)])정\s*정\s*공\s*[고보]\s*일(?:\s*자)?[ \t:]*\s*(\d{4})(?:[.\/-]\s*|\s*년\s*)?(\d{1,2})(?:[.\/-]\s*|\s*월\s*)?(\d{1,2})(?!\d)/g)]
      .map(([, year, month, day]) => year + month.padStart(2, '0') + day.padStart(2, '0'));
    if (!dates.length || !dates.every(date => date === doc.date)) return null;
    const serials = [...first.matchAll(
      /정\s*정\s*공\s*[고보]\s*(?:일\s*련(?:\s*번\s*호)?|순\s*번|연\s*번|회\s*차|번\s*호)[ \t:]*(\d+)(?![ \t]*-|\d)/g)]
      .map(match => match[1].replace(/^0+(?=\d)/, ''));
    const expectedSerial = doc.serial?.replace(/^0+(?=\d)/, '');
    return serials.length && serials.every(serial => serial === expectedSerial) ? { number } : null;
  }

  return { read };
})();
