// Network and evidence collection for the published KIPRIS Plus products.
const Kipris = (() => {
  const origin = 'https://plus.kipris.or.kr';
  const rest = '/openapi/rest/';
  const gazette = '/kipo-api/kipi/patUtiModInfoSearchSevice/';
  const history = rest + 'RelatedDocsonfilePatService/relatedDocsonfileInfo';
  const trialService = 'judgmentInfoSearchService/';
  const correctionPath = rest + 'patUtiModInfoSearchSevice/revisionfullDocPDFInfo';
  const supplementalPdfKinds = ['REVISION_GAZETTE', 'TRIAL_PDF'];
  const pdfServices = { OA: 'OP', RD: 'RE', RG: 'RG' };
  const maxPdf = 20 * 1024 * 1024;
  const messages = {
    invalid_number: '특허(10)·실용신안(20) 출원번호 13자리를 입력해 주세요.',
    missing_key: '설정에서 KIPRIS PLUS API 키를 저장해 주세요.',
    auth: 'API 키 확인 필요',
    permission: '해당 상품 이용 권한 필요',
    not_found: '서비스에 해당 자료가 없음',
    missing_path: '이 문서의 원문 PDF가 조회되지 않음',
    expired_path: '원문 조회 실패 · 다운로드 주소 만료 또는 오류 · 재시도 가능',
    gazette_unmatched: '일치하는 공보를 조회하지 못함 · 전체 서류 다시 조회',
    unsafe_path: '허용된 KIPRIS PLUS HTTPS 경로가 아님',
    download: '원문 조회 실패 · 재시도 가능',
    timeout: '원문 조회 실패 · KIPRIS PLUS 응답 시간 초과 · 재시도 가능',
    rate: 'KIPRIS PLUS 요청 한도 초과',
    server: '원문 조회 실패 · KIPRIS PLUS 서버 오류 · 재시도 가능',
    response: 'KIPRIS PLUS 응답 형식 또는 결과 코드 오류',
    pagination: '전체 응답 페이지를 확인하지 못함',
    pdf: 'PDF 형식·크기·페이지 검증 실패',
    pdf_empty: '다운로드 응답에 파일 내용이 없음',
    pdf_size: 'PDF가 다운로드 상한 20 MB를 초과함',
    pdf_format: '서버 응답에 PDF 파일 서명이 없음',
    pdf_incomplete: 'PDF 끝 표시가 없어 파일이 불완전함',
    pdf_parser: 'PDF 확보 · 추출 페이지에 연결할 수 없음. 확장 프로그램을 다시 로드하고 패널에서 재시도해 주세요.',
    pdf_assets_missing: 'PDF 확보 · 설치 폴더에 PDF.js가 없음. GitHub Actions의 DangDang_internet_Chrome 설치용 ZIP을 사용해 주세요.',
    pdf_engine_load: 'PDF 확보 · PDF.js 초기화 실패. 확장 프로그램을 다시 로드해 주세요.',
    pdf_extract_pending: 'PDF 확보 · 텍스트 검증 대기',
    pdf_parse: 'PDF 확보 · 텍스트 추출 실패',
    pdf_password: 'PDF 확보 · 암호로 보호되어 자동 추출할 수 없음',
    pdf_text: 'PDF 확보 · 텍스트 추출 불완전',
    identity: 'PDF의 문서 식별자를 확인하지 못했거나 응답이 불일치함',
    pdf_unavailable: '원문 PDF 미제공 · 이력 조회 가능',
    pdf_unknown: '원문 PDF 제공 여부 확인 중',
    pdf_not_found: '이 문서의 원문 PDF가 조회되지 않음',
    pending: '조회 대기',
    cancelled: '사용자 취소',
    interrupted: '작업이 중단되었습니다. 조회 버튼으로 재개할 수 있습니다.',
    limit: '문서 처리 한도 초과',
    empty: '행정처리 이력에 문서가 없음',
    verified: '원문 검증 완료',
    complete: '조회 완료',
    partial: '일부 자료만 확보',
    no_evidence: '진단 보류 · 분석 가능한 원문 없음',
    other: '이력 정보만 표시'
  };
  const apiPdfKinds = ['OA', 'RD', 'RG', 'PUB', 'REG', ...supplementalPdfKinds];
  const canRetryExtraction = status => ['pdf_extract_pending', 'pdf_parser', 'pdf_parse', 'pdf_assets_missing', 'pdf_engine_load', 'pdf_text'].includes(status);
  const isGazette = kind => kind === 'PUB' || kind === 'REG';

  function documentStatus(doc) {
    const status = doc.status === 'manual'
      ? historyDocumentStatus(documentType(doc.title, doc.stage, doc.trialNumber), doc.kind)
      : doc.status === 'not_found' ? 'pdf_not_found' : doc.status;
    const message = messages[status] || status || '상태 미확인';
    const stored = doc.hasFile ?? (doc.size > 0);
    return stored && status !== 'verified' && !message.startsWith('PDF 확보')
      ? 'PDF 확보 · ' + message : message;
  }

  function historyDocumentStatus(kind, originalKind = kind) {
    if (['APP', 'AM', 'OPINION', 'SEARCH_REPORT', 'TRIAL', 'ADMIN'].includes(kind)) return 'pdf_unavailable';
    if (['CORRECTION', 'TRIAL_DECISION', 'CITATION'].includes(originalKind)) return 'pdf_unknown';
    return 'other';
  }

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
    if (!response.body) return new Uint8Array();
    if (Number(response.headers.get('content-length')) > maximum) throw new Error(limitCode);
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
          const code = { 401: 'auth', 403: 'permission', 404: pdf ? 'expired_path' : 'not_found',
            410: pdf ? 'expired_path' : 'not_found', 429: 'rate' }[status]
            || (status >= 500 ? 'server' : 'download');
          const after = retryDelay(response.headers.get('Retry-After'));
          await response.body?.cancel();
          throw new Error(code, { after });
        }
        return await readBytes(response, pdf ? maxPdf : 8 * 1024 * 1024, pdf ? 'pdf_size' : 'limit');
      } catch (error) {
        signal.throwIfAborted();
        if (timeout.aborted) throw new Error('timeout');
        if (!(error instanceof Error)) throw new Error('download');
        if (attempt || !['rate', 'server'].includes(error.code) || error.after > 5000) throw error;
        await waitForRetry(Math.max(error.after || 0, 1000), signal);
      }
    }
  }

  async function getXML(path, app, key, signal, page, params) {
    if (!key) throw new Error('missing_key');
    const url = new URL(path, origin);
    const trialPdf = path.endsWith('/getJudDocumentInfoSearch');
    const trialList = path.endsWith('/applicationNumberSearchInfo');
    url.searchParams.set(trialPdf ? 'trialNumber' : 'applicationNumber', app);
    url.searchParams.set(path.startsWith('/kipo-api/') ? 'ServiceKey' : 'accessKey', key);
    for (const [name, value] of Object.entries(params || {})) url.searchParams.set(name, value);
    if (trialList) {
      url.searchParams.set('docsStart', page);
      url.searchParams.set('docsCount', '30');
    } else if (page > 1) url.searchParams.set('pageNo', page);
    const xml = xmlTree(new TextDecoder('utf-8', { fatal: true }).decode(await request(url, signal)));
    checkResult(xml);
    return xml;
  }

  async function allRecords(path, app, key, signal, getRows, params) {
    const results = [];
    const fingerprints = new Set();
    for (let page = 1; page <= 100; page++) {
      let root;
      try { root = await getXML(path, app, key, signal, page, params); }
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
      const total = Number(value(root, 'totalCount', 'totalRecords', 'totalSearchCount'));
      const pageSize = Number(value(root, 'numOfRows', 'pageSize', 'rowsPerPage'))
        || (path.endsWith('/applicationNumberSearchInfo') ? 30 : 0);
      const pages = Number(value(root, 'totalPages', 'totalPage', 'pageCount')) || (total && pageSize ? Math.ceil(total / pageSize) : 0);
      if (pages ? page >= pages : !total || results.length >= total) {
        if (total && results.length < total) throw new Error('pagination', { partial: results });
        return results;
      }
      if (!rows.length) break;
    }
    throw new Error('pagination', { partial: results });
  }

  function normalizedTitle(title) {
    return String(title || '').normalize('NFKC').replace(/^(?:\s*\[[^\]]+\]\s*)+/, '').replace(/\s/g, '');
  }

  function documentType(title, stage = '', trialNumber = '') {
    const name = normalizedTitle(title);
    const prefix = String(title || '').normalize('NFKC').match(/^\s*(?:\[[^\]]+\]\s*)+/)?.[0] || '';
    if (/^\d{13}$/.test(trialNumber) || /심판/.test(stage) || /심판|심결/.test(prefix) || /^(?:심판|심결)/.test(name)) {
      // Claim corrections during a trial still affect the choice of registered claim version.
      if (/정정심판|정정청구/.test(prefix + name)) return 'CORRECTION';
      return /^(?:심판)?심결(?:문|등본|서)?$/.test(name) ? 'TRIAL_DECISION' : 'TRIAL';
    }
    if (/재발급|고객번호|등록증|주소변경|명의변경|서지사항정정/.test(prefix + name)) return 'ADMIN';
    if (/선행기술조사보고서/.test(name)) return 'SEARCH_REPORT';
    if (/최후.*(?:통지|의견)|의견제출통지|거절이유통지/.test(name)) return 'OA';
    if (/거절결정/.test(name)) return 'RD';
    if (/(특허|실용신안|등록)결정/.test(name)) return 'RG';
    if (/명세서.*보정|보정서/.test(name)) return 'AM';
    if (/^(?:특허|실용신안)출원서|^국내서면제출|^국내단계진입/.test(name)) return 'APP';
    if (/의견서/.test(name)) return 'OPINION';
    if (/^(?:정정(?:청구|명세서|공보|공고|심판|서)|(?:등록|특허|청구범위|명세서).*정정)/.test(name)) return 'CORRECTION';
    return 'OTHER';
  }

  const date = raw => String(raw || '').replace(/[-./\s]/g, '').match(/^\d{8}$/)?.[0] || '';
  const number = raw => String(raw || '').replace(/[-\s]/g, '');

  async function getHistory(app, key, signal) {
    const parse = root => records(root, 'documentNumber', row => ({
      application: number(value(row, 'applicationNumber')), id: number(value(row, 'documentNumber')),
      date: date(value(row, 'documentDate')), title: value(row, 'documentTitle'),
      processing: value(row, 'processingStatus', 'documentStatus', 'status'),
      stage: value(row, 'step', 'documentStage', 'processStage', 'stage'),
      trialNumber: number(value(row, 'trialNumber')).match(/^\d{13}$/)?.[0] || ''
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
      if (!existing) unique.set(row.id, { ...row, kind: documentType(row.title, row.stage, row.trialNumber) });
    }
    return { status: unique.size || status !== 'complete' ? status : 'empty',
      rows: [...unique.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)) };
  }

  function gazetteNumbers(kind, text) {
    const middle = kind === 'PUB' ? '(?:[ \\t-]*[0-9]){4}' : '';
    const pattern = new RegExp('(?<![0-9])(?:10|20)' + middle + '(?:[ \\t-]*[0-9]){7}(?![0-9])', 'g');
    return [...new Set((text.normalize('NFKC').match(pattern) || []).map(number))];
  }

  function gazetteNumberInPdf(kind, text) {
    const label = kind === 'PUB' ? '공\\s*개\\s*번\\s*호' : '등\\s*록\\s*번\\s*호';
    const values = [...text.normalize('NFKC').matchAll(new RegExp(label + '\\s*[:：]?\\s*([0-9][0-9 \\t-]*)', 'g'))];
    const numbers = [...new Set(values.flatMap(match => gazetteNumbers(kind, match[1])))];
    return numbers.length === 1 ? numbers[0] : null;
  }

  async function gazetteLocation(kind, app, row) {
    const { path, docName } = row;
    const declared = kind === 'PUB' ? row.publicationNumber || row.openNumber
      : row.registrationNumber || row.registerNumber;
    const application = number(row.applicationNumber);
    let url;
    try { if (path) url = safePdfURL(path); } catch { /* The download path validator reports the failure. */ }
    const fromName = gazetteNumbers(kind, docName + ' ' + (url?.pathname.split('/').at(-1) || ''))
      .filter(candidate => candidate !== app);
    const numbers = declared ? gazetteNumbers(kind, declared) : fromName;
    const gazetteNumber = numbers.length === 1 ? numbers[0] : null;
    const fingerprint = url && await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url.href));
    const gazetteLocator = fingerprint && Array.from(new Uint8Array(fingerprint), byte => byte.toString(16).padStart(2, '0')).join('');
    return { path, application, gazetteNumber, gazetteLocator, ambiguous: numbers.length > 1 || !!declared && !gazetteNumber };
  }

  async function pdfLocations(kind, app, key, signal, sendNumber) {
    if (isGazette(kind)) {
      const method = kind === 'PUB' ? 'getPubFullTextInfoSearch' : 'getAnnFullTextInfoSearch';
      const parse = rows => Promise.all(rows.map(row => gazetteLocation(kind, app, row)));
      // Keep pagination fingerprints serializable without keeping the XML tree's parent links.
      const rowsFrom = root => records(root, 'path', row => Object.fromEntries(
        ['path', 'docName', 'publicationNumber', 'registrationNumber', 'openNumber', 'registerNumber', 'applicationNumber']
          .map(field => [field, value(row, field)])));
      try { return await parse(await allRecords(gazette + method, app, key, signal, rowsFrom)); }
      catch (error) {
        if (error.partial) error.partial = await parse(error.partial);
        throw error;
      }
    }
    const path = rest + `IntermediateDocument${pdfServices[kind]}Service/pdfInfoV2`;
    return allRecords(path, app, key, signal, root => records(root, 'sendNumber', row => ({
      id: number(value(row, 'sendNumber')), application: number(value(row, 'applicationNumber')),
      path: value(row, 'filePath')
    })), sendNumber ? { sendNumber } : undefined);
  }

  async function correctionLocations(app, key, signal) {
    return allRecords(correctionPath, app, key, signal, root => nodes(root, 'revisionfullDocPDFInfo')
      .map(row => ({
        application: number(value(row, 'applicationNumber')),
        sequence: value(row, 'number'), typeCode: value(row, 'typeCode'),
        type: value(row, 'typeDescription'), date: date(value(row, 'date')),
        path: value(row, 'path')
      })));
  }

  async function trialDecisions(app, key, signal) {
    return allRecords(rest + trialService + 'applicationNumberSearchInfo', app, key, signal,
      root => nodes(root, 'trialInfo').map(row => ({
        application: number(value(row, 'applicationNumber')),
        trialNumber: number(value(row, 'trialNumber')),
        publicDecision: value(row, 'trialDecisionDoc') === 'Y'
      })));
  }

  async function trialPdfLocation(trialNumber, key, signal) {
    if (!/^\d{13}$/.test(trialNumber)) throw new Error('identity');
    const root = await getXML('/kipo-api/kipi/' + trialService + 'getJudDocumentInfoSearch',
      trialNumber, key, signal, 1);
    const rows = nodes(root, 'item').filter(row => value(row, 'openYN') === 'Y');
    const paths = new Set(rows.filter(row => value(row, 'kind') === 'S10221'
      && value(row, 'fileName').toLowerCase() === trialNumber + '.pdf').map(row => value(row, 'path')));
    if (paths.size > 1 || (rows.length && !paths.size)) {
      throw new Error('identity');
    }
    return [...paths][0] || '';
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
      nodes(root, 'claim').map(row => ({
        number: value(row, 'claimNumber')
          || row.parent.children.find(field => field.name === 'claimnumber')?.text.trim() || null,
        text: row.text.trim() || value(row, 'claimText')
      })));
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

  function checkPdfBytes(bytes) {
    if (!bytes.length) throw new Error('pdf_empty');
    if (bytes.length > maxPdf) throw new Error('pdf_size');
    const prefix = new TextDecoder().decode(bytes.subarray(0, 8));
    const trailer = new TextDecoder().decode(bytes.subarray(-2048));
    if (!prefix.startsWith('%PDF-')) throw new Error('pdf_format');
    if (bytes.length < 128 || !trailer.includes('%%EOF')) throw new Error('pdf_incomplete');
  }

  async function inspectPdf(bytes, app, doc, extract) {
    checkPdfBytes(bytes);
    let parsed;
    let failure = 'pdf_parse';
    try { parsed = await extract(bytes); }
    catch (error) {
      if (error instanceof Error && ['pdf_parser', 'pdf_parse', 'pdf_password', 'pdf_assets_missing', 'pdf_engine_load'].includes(error.code)) failure = error.code;
    }
    if (!parsed?.pageCount) return {
      status: failure, size: bytes.length, pageCount: null, pages: [], identityVerified: false
    };
    const pages = parsed.pages;
    const first = pages[0]?.text || '';
    const compact = first.normalize('NFKC').replace(/[\s-]/g, '');
    const dates = [...first.matchAll(/(?<!\d)(\d{4})(?:[.\/-]\s*|\s*년\s*)?(\d{1,2})(?:[.\/-]\s*|\s*월\s*)?(\d{1,2})(?!\d)/g)]
      .map(([, year, month, day]) => year + month.padStart(2, '0') + day.padStart(2, '0'));
    const titleOk = doc.kind === 'PUB' ? /공개.*공보/.test(compact)
      : doc.kind === 'REG' ? /등록.*공보/.test(compact)
      : doc.kind === 'ATTACHMENT' || documentType(compact) === doc.kind || (!!doc.title && compact.includes(doc.title.replace(/\s/g, '')));
    const gazetteNumber = isGazette(doc.kind) && gazetteNumberInPdf(doc.kind, first);
    const correctionOk = doc.kind === 'REVISION_GAZETTE' && compact.includes(app)
      && /정정(?:공고|공보)/.test(compact) && dates.includes(doc.date)
      && !!gazetteNumberInPdf(doc.baseKind, first)
      && (doc.baseKind === 'REG' ? /등록/.test(compact) : /공개/.test(compact))
      && (!doc.sameDateRevision || /^\d+$/.test(doc.revisionSequence) && new RegExp('(?:정정(?:공고|공보))?일련번호[:：]?'
        + doc.revisionSequence + '(?![0-9])').test(compact));
    const trialOk = doc.kind === 'TRIAL_PDF' && /^\d{13}$/.test(doc.trialNumber) && /심결/.test(compact)
      && new RegExp('(?:심판번호|사건번호|사건)[:：]?' + doc.trialNumber + '(?![0-9])').test(compact);
    const idOk = supplementalPdfKinds.includes(doc.kind) ? correctionOk || trialOk : doc.kind === 'CITATION'
      ? first.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '').includes(doc.citationNumber)
      : compact.includes(app) && titleOk && (isGazette(doc.kind)
        ? !!gazetteNumber && (!doc.gazetteNumber || doc.gazetteNumber === gazetteNumber)
        : compact.includes(doc.id) && dates.includes(doc.date));
    const exactPages = pages.length === parsed.pageCount && pages.every(page => page.text);
    return {
      status: !exactPages ? 'pdf_text' : idOk ? 'verified' : 'identity',
      size: bytes.length, pageCount: parsed.pageCount,
      pages: idOk ? pages : [], identityVerified: idOk,
      ...(idOk && gazetteNumber ? { gazetteNumber } : {})
    };
  }

  return { Error, messages, applicationNumber, documentType, normalizedTitle, safePdfURL, getHistory, pdfLocations,
    getClaimHistory, registeredClaims, download, checkPdfBytes, inspectPdf, citations, maxPdf, apiPdfKinds,
    canRetryExtraction, isGazette, gazetteNumberInPdf, documentStatus, historyDocumentStatus,
    supplementalPdfKinds, correctionLocations, trialDecisions, trialPdfLocation };
})();
