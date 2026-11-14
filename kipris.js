// Network and evidence collection for the published KIPRIS Plus products.
const Kipris = (() => {
  const origin = 'https://plus.kipris.or.kr';
  const rest = '/openapi/rest/';
  const modern = '/kipo-api/kipi/';
  const gazette = modern + 'patUtiModInfoSearchSevice/';
  const correctionPath = rest + 'patUtiModInfoSearchSevice/revisionfullDocPDFInfo';
  const trialPath = 'judgmentInfoSearchService/';
  const history = rest + 'RelatedDocsonfilePatService/relatedDocsonfileInfo';
  const pdfServices = { OA: 'OP', RD: 'RE', RG: 'RG' };
  const maxPdf = 20 * 1024 * 1024;
  const messages = {
    invalid_number: '특허(10)·실용신안(20) 출원번호 13자리를 입력해 주세요.',
    missing_key: '설정에서 KIPRIS PLUS API 키를 저장해 주세요.',
    auth: 'API 키 확인 필요',
    permission: '해당 상품 이용 권한 필요',
    not_found: '서비스에 해당 자료가 없음',
    missing_path: '응답에서 일치하는 PDF 경로를 찾을 수 없음',
    expired_path: 'PDF 다운로드 경로가 만료됐거나 서버에서 찾을 수 없음',
    gazette_unmatched: '공보 식별자가 일치하는 경로가 없음 · 전체 서류 조회 필요',
    unsafe_path: '허용된 KIPRIS PLUS HTTPS 경로가 아님',
    download: '원문 다운로드 실패 또는 리다이렉트 차단',
    timeout: 'KIPRIS PLUS 응답 시간 초과',
    rate: 'KIPRIS PLUS 요청 한도 초과',
    server: 'KIPRIS PLUS 서버 오류',
    response: 'KIPRIS PLUS 응답 형식 또는 결과 코드 오류',
    pagination: '전체 응답 페이지를 확인하지 못함',
    pdf: 'PDF 형식·크기·페이지 검증 실패',
    pdf_empty: '다운로드 응답에 파일 내용이 없음',
    pdf_size: 'PDF가 다운로드 상한 20 MB를 초과함',
    pdf_format: '서버 응답에 PDF 파일 서명이 없음',
    pdf_incomplete: 'PDF 끝 표시가 없어 파일이 불완전함',
    identity: 'PDF의 문서 식별자를 확인하지 못했거나 응답이 불일치함',
    metadata_only: '원문 PDF 미제공 · 이력 또는 서지 정보 조회 가능',
    missing_trial_number: '심판번호 확인 필요 · 이력 조회 가능',
    available: '원문 PDF 제공',
    busy: '다른 KIPRIS 작업이 진행 중입니다.',
    lookup_required: '현재 출원의 서류를 다시 조회해 주세요.',
    cancelled: '사용자 취소',
    limit: '문서 처리 한도 초과',
    empty: '행정처리 이력에 문서가 없음',
    complete: '조회 완료'
  };
  const searchKey = 'kipris_download_search';
  const canDownload = doc => ['available', 'expired_path', 'download', 'timeout', 'server', 'rate',
    'response', 'missing_path', 'pagination', 'auth', 'permission', 'identity'].includes(doc.status);
  const isGazette = kind => kind === 'PUB' || kind === 'REG';
  const isCorrectionGazette = kind => kind === 'CORR_PUB' || kind === 'CORR_REG';
  const isTrialDecision = kind => kind === 'TRIAL_DECISION' || kind === 'TRIAL_SUPPLEMENT';
  const canLookupOriginal = doc => !!doc && apiPdfKinds.includes(doc.kind) && doc.status !== 'missing_trial_number'
    && (!doc.hasFile || isCorrectionGazette(doc.kind) && doc.status === 'identity');

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

  async function getXML(path, app, key, signal, page, sendNumber, trialNumber) {
    if (!key) throw new Error('missing_key');
    const url = new URL(path, origin);
    const identifier = !trialNumber ? 'applicationNumber'
      : path.endsWith('/trialBibliographicSummaryInfo') ? 'TrialNumber' : 'trialNumber';
    url.searchParams.set(identifier, trialNumber || app);
    url.searchParams.set(path.startsWith(modern) ? 'ServiceKey' : 'accessKey', key);
    if (sendNumber) url.searchParams.set('sendNumber', sendNumber);
    if (page > 1) url.searchParams.set('pageNo', page);
    const xml = xmlTree(new TextDecoder('utf-8', { fatal: true }).decode(await request(url, signal)));
    checkResult(xml);
    return xml;
  }

  async function allRecords(path, app, key, signal, getRows, sendNumber, trialNumber) {
    const results = [];
    const fingerprints = new Set();
    for (let page = 1; page <= 100; page++) {
      let root;
      try { root = await getXML(path, app, key, signal, page, sendNumber, trialNumber); }
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

  function normalizedTitle(title) {
    return String(title || '').normalize('NFKC').replace(/^(?:\s*\[[^\]]+\]\s*)+/, '').replace(/\s/g, '');
  }

  const validTrialNumber = raw => /^(?:19|20)\d{11}$/.test(raw);

  function documentType(title, { stage = '', trialNumber = '' } = {}) {
    const text = String(title || '').normalize('NFKC').trim();
    const prefixes = [...text.matchAll(/\[([^\]]+)\]/g)].map(match => match[1]).join(' ');
    const name = normalizedTitle(text);
    const scopeDecision = /^권리범위확인심결(?:\([^()]+\))?$/.test(name);
    if (scopeDecision || validTrialNumber(trialNumber) || /심판|심결/.test(stage + prefixes)
      || /^(?:심판|심결|정정심판|무효심판|거절결정불복)/.test(name)) {
      if (/경정결정문|경정결정서/.test(name)) return 'TRIAL_SUPPLEMENT';
      return scopeDecision || /심결문|심결서|심판결문|심결.*통지|^심결$/.test(name) ? 'TRIAL_DECISION' : 'TRIAL_FILING';
    }
    if (/증서|등록증|고객번호|출원인코드|대리인코드|재발급/.test(prefixes + name)) return 'OTHER';
    if (/선행기술조사.*(?:보고|결과|의뢰)/.test(name)) return 'SEARCH_REPORT';
    if (/최후.*(?:통지|의견)|의견제출통지|거절이유통지/.test(name)) return 'OA';
    if (/거절결정/.test(name)) return 'RD';
    if (/(특허|실용신안|등록)결정/.test(name)) return 'RG';
    if (/명세서.*보정|보정서/.test(name)) return 'AM';
    if (/^(?:특허|실용신안)출원서|^국내서면제출|^국내단계진입/.test(name)) return 'APP';
    if (/의견서/.test(name)) return 'OPINION';
    if (/정정(?:공보|공고|청구|명세서|보정)|(?:청구범위|청구항|명세서|도면).*정정/.test(name)) return 'CORRECTION';
    return 'OTHER';
  }

  const date = raw => String(raw || '').replace(/[-./\s]/g, '').match(/^\d{8}$/)?.[0] || '';
  const number = raw => String(raw || '').replace(/[-\s]/g, '');

  async function getHistory(app, key, signal) {
    const parse = root => records(root, 'documentNumber', row => ({
      application: number(value(row, 'applicationNumber')), id: number(value(row, 'documentNumber')),
      date: date(value(row, 'documentDate')), title: value(row, 'documentTitle'),
      processing: value(row, 'processingStatus', 'documentStatus', 'status'),
      stage: value(row, 'step'),
      trialNumber: number(value(row, 'trialNumber'))
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
      if (existing && (existing.title !== row.title || existing.date !== row.date
        || existing.trialNumber !== row.trialNumber || existing.stage !== row.stage)) {
        unique.set(row.id, { ...existing, kind: 'OTHER', trialNumber: '' });
        status = 'pagination';
      }
      if (!existing) unique.set(row.id, { ...row, kind: documentType(row.title, row) });
    }
    return { status: unique.size || status !== 'complete' ? status : 'empty',
      rows: [...unique.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)) };
  }

  function gazetteNumbers(kind, text) {
    const middle = kind === 'PUB' ? '(?:[ \\t-]*[0-9]){4}' : '';
    const pattern = new RegExp('(?<![0-9])(?:10|20)' + middle + '(?:[ \\t-]*[0-9]){7}(?![0-9])', 'g');
    return [...new Set((text.normalize('NFKC').match(pattern) || []).map(number))];
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
      const stem = kind === 'PUB' ? 'Pub' : 'Ann';
      const method = 'get' + stem + 'FullTextInfoSearch';
      const parse = rows => Promise.all(rows.map(row => gazetteLocation(kind, app, row)));
      // Keep pagination fingerprints serializable without keeping the XML tree's parent links.
      const rowsFrom = root => records(root, 'path', row => Object.fromEntries(
        ['path', 'docName', 'publicationNumber', 'registrationNumber', 'openNumber', 'registerNumber', 'applicationNumber']
          .map(field => [field, value(row, field)])));
      try {
        let rows;
        try { rows = await allRecords(gazette + method, app, key, signal, rowsFrom); }
        catch (error) { if (error.code !== 'not_found') throw error; }
        return await parse(rows?.length ? rows
          : await allRecords(gazette + 'getStandard' + stem + 'FullTextInfoSearch', app, key, signal, rowsFrom));
      }
      catch (error) {
        if (error.partial) error.partial = await parse(error.partial);
        throw error;
      }
    }
    const path = rest + `IntermediateDocument${pdfServices[kind]}Service/pdfInfoV2`;
    return allRecords(path, app, key, signal, root => records(root, 'sendNumber', row => ({
      id: number(value(row, 'sendNumber')), application: number(value(row, 'applicationNumber')),
      path: value(row, 'filePath')
    })), sendNumber);
  }

  async function correctionLocations(app, key, signal) {
    return allRecords(correctionPath, app, key, signal, root =>
      nodes(root, 'revisionfullDocPDFInfo').map(row => {
        const description = value(row, 'typeDescription').normalize('NFKC').replace(/\s/g, '');
        const kind = /정정공[보고]\(공개\)/.test(description) ? 'CORR_PUB'
          : /정정공[보고]\(등록\)/.test(description) ? 'CORR_REG' : '';
        return { kind, application: number(value(row, 'applicationNumber')), date: date(value(row, 'date')),
          serial: value(row, 'number'), typeCode: value(row, 'typeCode'), path: value(row, 'path') };
      }));
  }

  async function trialSummary(doc, app, key, signal) {
    const path = rest + trialPath + 'trialBibliographicSummaryInfo';
    const rows = await allRecords(path, app, key, signal, root =>
      nodes(root, 'trialBibliographicSummaryInfo').map(row => ({
        trialNumber: number(value(row, 'TrialNumber')), application: number(value(row, 'ApplicationNumber')),
        trialNumberName: number(value(row, 'TrialNumberName')).normalize('NFKC'),
        decisionDate: date(value(row, 'TrialdecisionDate'))
      })), null, doc.trialNumber);
    if (rows.length !== 1 || rows[0].trialNumber !== doc.trialNumber || rows[0].application !== app) {
      throw new Error(rows.length ? 'identity' : 'not_found');
    }
    return rows[0];
  }

  async function trialDecisionLocations(doc, app, key, signal) {
    if (!validTrialNumber(doc.trialNumber) || [app, doc.id].includes(doc.trialNumber)) throw new Error('missing_trial_number');
    const supplement = doc.kind === 'TRIAL_SUPPLEMENT';
    const path = (supplement ? rest : modern) + trialPath
      + (supplement ? 'trialSupplementaryDecisionInfo' : 'getJudDocumentInfoSearch');
    return allRecords(path, app, key, signal, root =>
      nodes(root, supplement ? 'trialSupplementaryDecisionInfo' : 'item').map(row => ({
        path: value(row, 'path'), fileName: value(row, 'fileName'), open: value(row, 'openYN'),
        trialNumber: number(value(row, 'trialNumber'))
      })), null, doc.trialNumber);
  }

  async function download(path, signal) {
    return request(safePdfURL(path), signal, true);
  }

  function checkPdfBytes(bytes) {
    if (!bytes.length) throw new Error('pdf_empty');
    if (bytes.length > maxPdf) throw new Error('pdf_size');
    const prefix = new TextDecoder().decode(bytes.subarray(0, 8));
    const trailer = new TextDecoder().decode(bytes.subarray(-2048));
    if (!prefix.startsWith('%PDF-')) throw new Error('pdf_format');
    if (bytes.length < 128 || !trailer.includes('%%EOF')) throw new Error('pdf_incomplete');
  }

  return { Error, messages, searchKey, canDownload, applicationNumber, documentType, normalizedTitle,
    safePdfURL, getHistory, pdfLocations, download, checkPdfBytes, maxPdf, isGazette, isCorrectionGazette,
    isTrialDecision, correctionLocations, trialDecisionLocations, validTrialNumber, trialSummary };
})();
