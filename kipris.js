// Network and evidence collection for the published KIPRIS Plus products.
const Kipris = (() => {
  const origin = 'https://plus.kipris.or.kr';
  const rest = '/openapi/rest/';
  const gazette = '/kipo-api/kipi/patUtiModInfoSearchSevice/';
  const history = rest + 'RelatedDocsonfilePatService/relatedDocsonfileInfo';
  const pdfServices = { OA: 'OP', RD: 'RE', RG: 'RG' };
  const maxPdf = 20 * 1024 * 1024;
  const messages = {
    invalid_number: '특허(10)·실용신안(20) 출원번호 13자리를 입력해 주세요.',
    missing_key: '설정에서 KIPRIS PLUS API 키를 저장해 주세요.',
    auth: '인증 실패 또는 키 미등록',
    permission: '상품 이용 권한 없음',
    not_found: '서비스에 해당 자료가 없음',
    missing_path: '응답에서 일치하는 PDF 경로를 찾을 수 없음',
    unsafe_path: '허용된 KIPRIS PLUS HTTPS 경로가 아님',
    download: '원문 다운로드 실패 또는 리다이렉트 차단',
    timeout: 'KIPRIS PLUS 응답 시간 초과',
    rate: 'KIPRIS PLUS 요청 한도 초과',
    server: 'KIPRIS PLUS 서버 오류',
    response: 'KIPRIS PLUS 응답 형식 또는 결과 코드 오류',
    pagination: '전체 응답 페이지를 확인하지 못함',
    pdf: 'PDF 형식·크기·페이지 검증 실패',
    pdf_text: 'PDF 본문 또는 페이지 추출 불완전',
    identity: 'PDF의 문서 식별자를 확인하지 못했거나 응답이 불일치함',
    manual: '자동 원문 제공 경로 미확인. 수동 첨부 필요',
    pending: '조회 대기',
    cancelled: '사용자 취소',
    interrupted: '작업이 중단되었습니다. 조회 버튼으로 재개할 수 있습니다.',
    limit: '문서 처리 한도 초과',
    empty: '행정처리 이력에 문서가 없음',
    verified: '원문과 문서 식별 확인',
    complete: '조회 완료',
    partial: '일부 자료만 확보',
    other: '이력 정보만 표시'
  };

  class Error extends globalThis.Error {
    constructor(code, extra = {}) {
      super(messages[code] || messages.response);
      this.code = code;
      Object.assign(this, extra);
    }
  }

  function applicationNumber(input) {
    const number = String(input || '').normalize('NFKC').replace(/[\s‐‑–-]/g, '');
    if (!/^(10|20)\d{11}$/.test(number)) throw new Error('invalid_number');
    return number;
  }

  function safePdfURL(value) {
    let url;
    try { url = new URL(value, origin); } catch { throw new Error('unsafe_path'); }
    if (url.hostname !== 'plus.kipris.or.kr' || url.port || url.username || url.password
      || !['http:', 'https:'].includes(url.protocol) || url.hash) throw new Error('unsafe_path');
    url.protocol = 'https:';
    return url;
  }

  function decodeXml(value) {
    return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (_, key) => {
      const literal = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[key];
      if (literal) return literal;
      const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '�';
    });
  }

  // Extension workers have no DOMParser. This reader supports KIPRIS data XML and rejects DTDs.
  function xmlTree(xml) {
    const root = { name: '', children: [], text: '' };
    const stack = [root];
    const tokens = /<!--[\s\S]*?-->|<\?[^]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[\w:.-]+(?:\s[^<>]*?)?\s*\/?>|[^<]+/gy;
    let cursor = 0;
    let match;
    while ((match = tokens.exec(xml))) {
      cursor = tokens.lastIndex;
      const token = match[0];
      const parent = stack.at(-1);
      if (token.startsWith('<![CDATA[')) parent.text += token.slice(9, -3);
      else if (token.startsWith('<?') || token.startsWith('<!--')) continue;
      else if (token.startsWith('</')) {
        if (stack.length < 2 || token.slice(2, -1).trim() !== parent.fullName) throw new Error('response');
        stack.pop();
      } else if (token.startsWith('<')) {
        const fullName = token.match(/^<([\w:.-]+)/)[1];
        const node = { name: fullName.split(':').at(-1).toLowerCase(), fullName, children: [], text: '', parent };
        parent.children.push(node);
        if (!token.endsWith('/>')) stack.push(node);
        if (stack.length > 64) throw new Error('response');
      } else parent.text += decodeXml(token);
    }
    if (cursor !== xml.length || stack.length !== 1 || root.children.length !== 1 || root.text.trim()) throw new Error('response');
    const response = root.children[0];
    if (!['response', 'openapi_serviceresponse', 'result'].includes(response.name)) throw new Error('response');
    return response;
  }

  function nodes(node, name) {
    const wanted = name.toLowerCase();
    const found = [];
    function walk(item) {
      if (item.name === wanted) found.push(item);
      for (const child of item.children) walk(child);
    }
    walk(node);
    return found;
  }

  function value(node, ...names) {
    return names.map(name => nodes(node, name)[0]?.text.trim()).find(Boolean) || '';
  }

  function records(node, field, map) {
    return nodes(node, field).map(item => item.parent).filter(Boolean).map(map);
  }

  function checkResult(root) {
    const code = value(root, 'resultCode', 'returnReasonCode');
    if (/^(?:0+|SUCCESS|NORMAL_SERVICE)$/i.test(code)) return;
    const msg = value(root, 'resultMsg', 'returnAuthMsg', 'errMsg');
    if (/^(30|31|101)$/.test(code) || /(?:인증키|서비스키|SERVICE.?KEY|API.?KEY).*(?:미등록|invalid|등록되지|not.registered|없)/i.test(msg)) {
      throw new Error('auth');
    }
    if (/^(20|22|33)$/.test(code) || /권한|이용신청|접근.{0,5}거부|access.denied|service.access/i.test(msg)) {
      throw new Error('permission');
    }
    if (code === '03' || /NO_DATA/i.test(msg)) throw new Error('not_found');
    if (code === '429' || /한도|LIMITED_NUMBER/i.test(msg)) throw new Error('rate');
    if (code || msg) throw new Error('response');
    if (!nodes(root, 'body').length && !nodes(root, 'items').length) throw new Error('response');
  }

  async function readBytes(response, maximum, limitCode) {
    if (!response.body || Number(response.headers.get('content-length')) > maximum) throw new Error(limitCode);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value: bytes } = await reader.read();
        if (done) break;
        size += bytes.length;
        if (size > maximum) {
          await reader.cancel();
          throw new Error(limitCode);
        }
        chunks.push(bytes);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }

  async function request(url, signal, pdf = false) {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const timeout = AbortSignal.timeout(22000);
      try {
        const response = await fetch(url.href, { signal: AbortSignal.any([signal, timeout]),
          redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
        if (!response.ok) {
          const status = response.status;
          const code = { 401: 'auth', 403: 'permission', 404: 'not_found', 429: 'rate' }[status]
            || (status >= 500 ? 'server' : 'download');
          const after = retryDelay(response.headers.get('Retry-After'));
          await response.body?.cancel();
          throw new Error(code, { after });
        }
        return await readBytes(response, pdf ? maxPdf : 8 * 1024 * 1024, pdf ? 'pdf' : 'limit');
      } catch (error) {
        signal.throwIfAborted();
        if (timeout.aborted) throw new Error('timeout');
        if (!(error instanceof Error)) throw new Error('download');
        if (attempt || !['rate', 'server'].includes(error.code) || error.after > 5000) throw error;
        await waitForRetry(Math.max(error.after || 0, 1000), signal);
      }
    }
  }

  async function getXML(path, app, key, signal, page) {
    if (!key) throw new Error('missing_key');
    const url = new URL(path, origin);
    url.searchParams.set('applicationNumber', app);
    url.searchParams.set(path.startsWith(gazette) ? 'ServiceKey' : 'accessKey', key);
    if (page > 1) url.searchParams.set('pageNo', page);
    const xml = xmlTree(new TextDecoder('utf-8', { fatal: true }).decode(await request(url, signal)));
    checkResult(xml);
    return xml;
  }

  async function allRecords(path, app, key, signal, getRows) {
    const results = [];
    const fingerprints = new Set();
    for (let page = 1; page <= 100; page++) {
      let root;
      try { root = await getXML(path, app, key, signal, page); }
      catch (error) {
        if (page === 1 && error.code === 'not_found') return [];
        if (results.length && !signal.aborted) throw new Error('pagination', { partial: results });
        throw error;
      }
      const rows = getRows(root);
      const fingerprint = JSON.stringify(rows);
      if (fingerprints.has(fingerprint)) throw new Error('pagination', { partial: results });
      fingerprints.add(fingerprint);
      results.push(...rows);
      const total = Number(value(root, 'totalCount', 'totalRecords'));
      const pageSize = Number(value(root, 'numOfRows', 'pageSize', 'rowsPerPage'));
      const pages = Number(value(root, 'totalPages', 'totalPage', 'pageCount')) || (total && pageSize ? Math.ceil(total / pageSize) : 0);
      if (pages ? page >= pages : !total || results.length >= total) {
        if (total && results.length < total) throw new Error('pagination', { partial: results });
        return results;
      }
      if (!rows.length) break;
    }
    throw new Error('pagination', { partial: results });
  }

  function documentType(title) {
    const name = title.replace(/\s/g, '');
    if (/최후.*(?:통지|의견)|의견제출통지|거절이유통지/.test(name)) return 'OA';
    if (/거절결정/.test(name)) return 'RD';
    if (/(특허|실용신안|등록)결정/.test(name)) return 'RG';
    if (/명세서.*보정|보정서/.test(name)) return 'AM';
    if (/의견서/.test(name)) return 'OPINION';
    if (/정정/.test(name)) return 'CORRECTION';
    return 'OTHER';
  }

  const date = raw => String(raw || '').replace(/[-./\s]/g, '').match(/^\d{8}$/)?.[0] || '';
  const number = raw => String(raw || '').replace(/[-\s]/g, '');

  async function getHistory(app, key, signal) {
    const parse = root => records(root, 'documentNumber', row => ({
      application: number(value(row, 'applicationNumber')), id: number(value(row, 'documentNumber')),
      date: date(value(row, 'documentDate')), title: value(row, 'documentTitle'),
      processing: value(row, 'processingStatus', 'documentStatus', 'status')
    }));
    let rows;
    let status = 'complete';
    try { rows = await allRecords(history, app, key, signal, parse); }
    catch (error) {
      if (!error.partial) throw error;
      rows = error.partial;
      status = 'pagination';
    }
    const unique = new Map();
    for (const row of rows) {
      if (!row.id || !row.title || !row.date || (row.application && row.application !== app)) {
        status = 'pagination';
        continue;
      }
      const existing = unique.get(row.id);
      if (existing && (existing.title !== row.title || existing.date !== row.date)) status = 'pagination';
      if (!existing) unique.set(row.id, { ...row, kind: documentType(row.title) });
    }
    return { status: unique.size || status !== 'complete' ? status : 'empty',
      rows: [...unique.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)) };
  }

  async function pdfLocations(kind, app, key, signal) {
    if (kind === 'PUB' || kind === 'REG') {
      const method = kind === 'PUB' ? 'getPubFullTextInfoSearch' : 'getAnnFullTextInfoSearch';
      return allRecords(gazette + method, app, key, signal, root =>
        records(root, 'path', row => ({ path: value(row, 'path'), title: value(row, 'docName') })));
    }
    const path = rest + `IntermediateDocument${pdfServices[kind]}Service/pdfInfoV2`;
    return allRecords(path, app, key, signal, root => records(root, 'sendNumber', row => ({
      id: number(value(row, 'sendNumber')), application: number(value(row, 'applicationNumber')),
      path: value(row, 'filePath')
    })));
  }

  async function getClaimHistory(app, key, signal) {
    const base = rest + 'ClaimsChangeHistoryService/';
    const common = row => ({
      serial: value(row, 'receiptSendSerialNumber'), id: number(value(row, 'receiptSendNumber')),
      date: date(value(row, 'receiptSendDate')), title: value(row, 'receiptSendDocumentName')
    });
    const getRows = detail => root => records(root, detail ? 'petitionclauseNumber' : 'receiptSendSerialNumber', row =>
      detail ? { ...common(row), claim: value(row, 'petitionclauseNumber'), change: value(row, 'changeTypeName'),
        text: value(row, 'petitionclause').replace(/<br\s*\/?>/gi, '\n') } : common(row));
    const [events, changes] = await Promise.all([
      allRecords(base + 'amendmentHistoryInfo', app, key, signal, getRows(false)),
      allRecords(base + 'amendmentHistoryDetailInfo', app, key, signal, getRows(true))
    ]);
    return { events, changes };
  }

  async function registeredClaims(app, key, signal) {
    return allRecords(gazette + 'patentClaimInfo', app, key, signal, root =>
      nodes(root, 'claim').map(row => row.text.trim() || value(row, 'claimText')).filter(Boolean));
  }

  async function download(path, signal) {
    return request(safePdfURL(path), signal, true);
  }

  function citations(pages) {
    const found = new Map();
    for (const page of pages || []) {
      for (const hit of page.text.matchAll(/(?:\bKR\s*|(?:공개특허공보|등록특허공보|특허공보)\s*(?:제\s*)?)((?:10|20)\s*[-–]\s*(?:\d{4}\s*[-–]\s*\d{7}|\d{7}))(?!\d)/gi)) {
        const id = hit[1].replace(/\D/g, '');
        found.set(id, 'KR ' + hit[1].replace(/\s/g, ''));
      }
      for (const hit of page.text.matchAll(/\b(US|EP|JP|WO|CN)\s*((?:\d[ .,/\-]*){6,13})(?:[A-Z]\d)?(?!\d)/g)) {
        const id = hit[1] + hit[2].replace(/\D/g, '');
        found.set(id, hit[1] + ' ' + hit[2].trim());
      }
    }
    return [...found].slice(0, 50).map(([citationNumber, citationLabel]) => ({ citationNumber, citationLabel }));
  }

  async function inspectPdf(bytes, app, doc, extract) {
    const prefix = new TextDecoder().decode(bytes.subarray(0, 8));
    const trailer = new TextDecoder().decode(bytes.subarray(-2048));
    if (bytes.length < 128 || bytes.length > maxPdf || !prefix.startsWith('%PDF-') || !trailer.includes('%%EOF')) {
      throw new Error('pdf');
    }
    const parsed = await extract(bytes);
    if (!parsed?.pageCount) throw new Error('pdf');
    const pages = parsed.pages;
    const first = pages[0]?.text || '';
    const compact = first.normalize('NFKC').replace(/[\s-]/g, '');
    const dates = [...first.matchAll(/(?<!\d)(\d{4})(?:[.\/-]\s*|\s*년\s*)?(\d{1,2})(?:[.\/-]\s*|\s*월\s*)?(\d{1,2})(?!\d)/g)]
      .map(([, year, month, day]) => year + month.padStart(2, '0') + day.padStart(2, '0'));
    const titleOk = doc.kind === 'PUB' ? /공개.*공보/.test(compact)
      : doc.kind === 'REG' ? /등록.*공보/.test(compact)
      : doc.kind === 'ATTACHMENT' || documentType(compact) === doc.kind || compact.includes(doc.title.replace(/\s/g, ''));
    const idOk = doc.kind === 'CITATION'
      ? first.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '').includes(doc.citationNumber)
      : compact.includes(app) && titleOk && (['PUB', 'REG'].includes(doc.kind)
        || (compact.includes(doc.id) && dates.includes(doc.date)));
    const exactPages = pages.length === parsed.pageCount && pages.every(page => page.text);
    return {
      status: !exactPages ? 'pdf_text' : idOk ? 'verified' : 'identity',
      size: bytes.length, pageCount: parsed.pageCount,
      pages: idOk ? pages : [], identityVerified: idOk
    };
  }

  return { Error, messages, applicationNumber, documentType, safePdfURL, getHistory, pdfLocations,
    getClaimHistory, registeredClaims, download, inspectPdf, citations, maxPdf };
})();
