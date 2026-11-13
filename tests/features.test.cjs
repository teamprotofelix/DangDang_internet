const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const { testPdf } = require('./pdf-fixture.cjs');

const paths = ['config.js', 'utils.js', 'api.js', 'coding.js', 'file-io.js', 'kipris.js',
  'patent-rules.js', 'patent-diagnosis.js'];
const source = paths.map(path => readFileSync(path, 'utf8')).join('\n');
const testRuntime = fetch => {
  const ctx = vm.createContext({ URL, fetch, AbortController, AbortSignal, setTimeout, clearTimeout,
    TextDecoder, TextEncoder, Blob, Response, crypto, console: { warn() {} } });
  return vm.runInContext(source + `\n({ CONFIG, LLMClient, chatCompletionURL, buildChatCompletionRequest,
    CodeProjects, FileIO, Kipris, PatentRules, PatentDiagnosis, computeRequestBudget, resolveKeyForOrigin, isTrustedExtensionUI })`, ctx);
};
const plain = value => JSON.parse(JSON.stringify(value));
const app = '1099990000001';
const exa = {
  apiBase: 'https://api.exaone.ai/v1',
  apiPreset: 'exaone',
  apiKey: 'fixture-placeholder',
  model: 'k-exaone_v2.5',
  modelContextTokens: 32768,
  modelMaxOutputTokens: 8192
};
const message = [{ role: 'user', content: 'Hello' }];
const withFence = (lang, content) => ['```' + lang, content, '```'].join('\n');
const xml = (body, code = '00') => '<response><header><resultCode>' + code
  + '</resultCode></header><body>' + body + '</body></response>';
const historyRow = (id, name, date = '20990102') => '<item><applicationNumber>' + app
  + '</applicationNumber><documentNumber>' + id + '</documentNumber><documentTitle>' + name
  + '</documentTitle><documentDate>' + date + '</documentDate></item>';

for (const [lang, ext, code] of [
  ['html', 'html', '<!doctype html><script>globalThis.fixture = 1</script>'],
  ['python', 'py', 'print("안녕")'],
  ['js', 'js', 'console.log("fixture");'],
  ['powershell', 'ps1', 'Write-Output "안녕"'],
  ['racket', 'racket', '#lang racket\n(displayln 1)']
]) {
  test(`코드 언어 자동 인식 ${lang}`, () => {
    const { CodeProjects } = testRuntime();
    const [file] = CodeProjects.parse(withFence(lang, code));
    assert.equal(file.name, 'file-1.' + ext);
    assert.equal(file.content, code);
    assert.equal(file.downloadable, true);
    assert.equal(globalThis.fixture, undefined);
  });
}

test('다중 파일과 UTF-8 ZIP의 경로 및 파일 바이트', async () => {
  const { CodeProjects, FileIO } = testRuntime();
  const files = CodeProjects.parse('File: `src/main.py`\n' + withFence('python', 'print("안녕")')
    + '\nFile: 한글/README.md\n' + withFence('markdown', '사용법'));
  assert.deepEqual(plain(files.map(item => item.name)), ['src/main.py', '한글/README.md']);
  const blob = await FileIO.zipStore(files.map(file => ({ name: file.name, data: file.content })), 'application/zip');
  assert.equal(blob.type, 'application/zip');
  const contents = await FileIO.unzip(await blob.arrayBuffer());
  assert.equal(contents['한글/README.md'], '사용법');
});

test('코드 경로 순회 및 ZIP 경로 충돌을 막고 설명만 있는 응답은 파일로 취급하지 않음', () => {
  const { CodeProjects } = testRuntime();
  assert.equal(CodeProjects.filename('../x', 'python'), 'file-1.py');
  assert.equal(CodeProjects.filename('C:\\x', 'python'), 'file-1.py');
  assert.equal(CodeProjects.filename('src/CON.txt', 'text'), 'file-1.txt');
  assert.equal(CodeProjects.parse('아래는 설명입니다.\n' + withFence('text', '설명만 있습니다')).length, 0);
  assert.throws(() => CodeProjects.parse('File: src\n' + withFence('txt', 'a')
    + '\nFile: src/main.js\n' + withFence('js', 'b')), /같은 파일명/);
  assert.throws(() => CodeProjects.parse('```python\nprint(1)'), /닫히지/);
});

test('구형 HTML 세션을 옮기고 수정 요청에 기존 파일 전문을 전달', async () => {
  const { CodeProjects } = testRuntime();
  const session = CodeProjects.migrate({ prompt: '계산기', html: '<p>원본</p>' });
  assert.equal(session.files[0].name, 'app.html');
  assert.equal(session.files[0].status, 'migrated');
  const client = {
    async chatStream(messages) {
      const data = JSON.parse(messages[1].content);
      assert.equal(data.request, '문구 수정');
      assert.equal(data.existingFiles[0].content, '<p>원본</p>');
      return { content: 'File: app.html\n' + withFence('html', '<p>수정</p>') };
    }
  };
  const result = await CodeProjects.generate({ client, config: exa, prompt: '문구 수정', language: 'auto',
    files: session.files, instruction: 'Generate files.' });
  assert.equal(result.files[0].status, 'modified');
});

test('EXAONE 공식 URL, 생성 예산, 추론 옵션 및 공급자 키 격리', () => {
  const { CONFIG, chatCompletionURL, buildChatCompletionRequest, resolveKeyForOrigin } = testRuntime();
  assert.equal(CONFIG.apiPresets.exaone.apiBase, exa.apiBase);
  assert.equal(chatCompletionURL(exa), 'https://api.exaone.ai/v1/chat/completions');
  assert.equal(chatCompletionURL({ ...exa, apiBase: exa.apiBase + '/chat/completions/' }),
    'https://api.exaone.ai/v1/chat/completions');
  assert.throws(() => chatCompletionURL({ ...exa, apiBase: 'https://elsewhere.invalid/v1' }), /프리셋/);
  assert.throws(() => chatCompletionURL({ ...exa, apiPreset: 'custom', apiBase: 'http://127.0.0.1/v1' }), /HTTPS/);
  const request = buildChatCompletionRequest(exa, message, { maxTokens: 9000, reasoningEffort: 'high' });
  assert.equal(request.max_tokens, 8192);
  assert.equal(request.reasoning_effort, 'high');
  assert.equal(request.max_completion_tokens, undefined);
  assert.throws(() => buildChatCompletionRequest({ ...exa, modelContextTokens: 9999999 },
    [{ role: 'user', content: '한'.repeat(600000) }], { maxTokens: 1000 }), /컨텍스트/);
  const keys = { 'https://api.exaone.ai': exa.apiKey };
  assert.equal(resolveKeyForOrigin(keys, 'https://api.openai.com', exa.apiKey), '');
  assert.equal(resolveKeyForOrigin(keys, 'https://api.exaone.ai', exa.apiKey), exa.apiKey);
});

test('EXAONE 비스트림 답변이 추론 필드를 분리하고 인증 헤더를 설정', async () => {
  const { LLMClient } = testRuntime(async (url, init) => {
    assert.equal(url, 'https://api.exaone.ai/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer fixture-placeholder');
    assert.equal(init.redirect, 'error');
    return Response.json({ choices: [{ message: { reasoning_content: '추론', content: '\n\nOK' },
      finish_reason: 'stop' }] });
  });
  const client = new LLMClient();
  client.applyConfig(exa);
  assert.deepEqual(plain(await client.chat(message)), { content: 'OK', raw: null, finishReason: 'stop', truncated: false });
});

test('EXAONE SSE에서 추론 청크를 건너뛰고 최종 완료를 인식', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"reasoning_content":"private"}}]}',
    'data: {"choices":[{"delta":{"content":"정상"},"finish_reason":"stop"}]}',
    'data: [DONE]'
  ].join('\n\n');
  const { LLMClient } = testRuntime(async () => new Response(sse));
  const client = new LLMClient();
  client.applyConfig(exa);
  const deltas = [];
  const result = await client.chatStream(message, {}, (_, delta) => deltas.push(delta));
  assert.deepEqual(deltas, ['정상']);
  assert.equal(result.content, '정상');
});

test('중단된 SSE의 일부 답변과 상태를 보존하고 중복 호출하지 않음', async () => {
  let calls = 0;
  const { LLMClient } = testRuntime(async () => {
    calls++;
    return new Response('data: {"choices":[{"delta":{"content":"일부"}}]}\n\n');
  });
  const client = new LLMClient();
  client.applyConfig(exa);
  await assert.rejects(client.chatStream(message), error => error.partialContent === '일부' && !error.canFallbackToChat());
  assert.equal(calls, 1);
});

for (const status of [401, 403, 429, 502]) {
  test(`EXAONE HTTP ${status}의 원인과 Retry-After 보존`, async () => {
    let calls = 0;
    const { LLMClient } = testRuntime(async () => {
      calls++;
      return Response.json({ error: { message: 'fixture-placeholder' } }, {
        status, headers: { 'Retry-After': '20' }
      });
    });
    const client = new LLMClient();
    client.applyConfig(exa);
    await assert.rejects(client.chatWithRetry(message), error => error.statusCode === status
      && error.retryAfterMs === 20000 && !error.getUserMessage().includes(exa.apiKey));
    assert.equal(calls, 1);
  });
}

test('EXAONE SSE 429는 짧은 Retry-After에서 한 번만 재시도', async () => {
  let calls = 0;
  const { LLMClient } = testRuntime(async () => {
    if (++calls === 1) return new Response('', { status: 429, headers: { 'Retry-After': '0' } });
    return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n');
  });
  const client = new LLMClient();
  client.applyConfig(exa);
  client.retryBackoffMs = 1;
  assert.equal((await client.chatStream(message)).content, 'OK');
  assert.equal(calls, 2);
});

test('KIPRIS 출원번호 검증 및 HTTPS PDF 호스트 제한', () => {
  const { Kipris } = testRuntime();
  assert.equal(Kipris.applicationNumber('10-9999-0000001'), app);
  assert.equal(Kipris.applicationNumber('２０ ９９９９ ００００００１'), '2099990000001');
  assert.throws(() => Kipris.applicationNumber('30-9999-0000001'), { code: 'invalid_number' });
  assert.throws(() => Kipris.applicationNumber('10000000000000'), { code: 'invalid_number' });
  assert.equal(Kipris.safePdfURL('http://plus.kipris.or.kr/document.pdf').protocol, 'https:');
  assert.throws(() => Kipris.safePdfURL('https://plus.kipris.or.kr.evil.invalid/file'), { code: 'unsafe_path' });
  assert.throws(() => Kipris.safePdfURL('https://user@plus.kipris.or.kr/file'), { code: 'unsafe_path' });
});

test('행정처리 이력의 여러 페이지, 문서번호 중복 제거, OA·최후·RD·RG 분기', async () => {
  const seen = [];
  const { Kipris } = testRuntime(async url => {
    const request = new URL(url);
    assert.equal(request.searchParams.get('accessKey'), 'fixture-kipris');
    const page = request.searchParams.get('pageNo') || '1';
    seen.push(page);
    const first = historyRow('20', '최후의견제출통지서') + historyRow('10', '의견제출통지서', '20990101');
    const second = historyRow('20', '최후의견제출통지서') + historyRow('30', '특허거절결정서', '20990103')
      + historyRow('40', '특허결정서', '20990104');
    return new Response(xml('<totalPages>2</totalPages><items>' + (page === '1' ? first : second) + '</items>'));
  });
  const result = await Kipris.getHistory(app, 'fixture-kipris', new AbortController().signal);
  assert.equal(result.status, 'complete');
  assert.deepEqual(plain(result.rows.map(row => [row.id, row.kind])), [
    ['10', 'OA'], ['20', 'OA'], ['30', 'RD'], ['40', 'RG']
  ]);
  assert.deepEqual(seen, ['1', '2']);
});

test('반복 페이지는 완전으로 처리하지 않고 확보한 이력을 반환', async () => {
  const { Kipris } = testRuntime(async () => new Response(xml('<totalPages>2</totalPages>' + historyRow('10', '의견제출통지서'))));
  const result = await Kipris.getHistory(app, 'fixture-kipris', new AbortController().signal);
  assert.equal(result.status, 'pagination');
  assert.equal(result.rows.length, 1);
});

test('KIPRIS 키 없음, 권한, XML 오류, 빈 결과를 구분', async () => {
  let payload = xml('<items/>', '20');
  const { Kipris } = testRuntime(async () => new Response(payload));
  const signal = new AbortController().signal;
  await assert.rejects(Kipris.getHistory(app, '', signal), { code: 'missing_key' });
  await assert.rejects(Kipris.getHistory(app, 'fixture-kipris', signal), { code: 'permission' });
  payload = '<html>Bad Gateway</html>';
  await assert.rejects(Kipris.getHistory(app, 'fixture-kipris', signal), { code: 'response' });
  payload = '<!DOCTYPE response [<!ENTITY x SYSTEM "https://example.invalid">]><response/>';
  await assert.rejects(Kipris.getHistory(app, 'fixture-kipris', signal), { code: 'response' });
  payload = xml('<items/>');
  assert.equal((await Kipris.getHistory(app, 'fixture-kipris', signal)).status, 'empty');
});

test('중간서류 XML에서 발송번호와 모든 PDF 경로를 읽고 취소 요청을 전송하지 않음', async () => {
  let calls = 0;
  const { Kipris } = testRuntime(async url => {
    calls++;
    assert.match(url, /IntermediateDocumentOPService\/pdfInfoV2/);
    const requested = new URL(url).searchParams.get('sendNumber');
    return new Response(xml((requested ? [requested] : [1, 2]).map(i => '<pdfInfoV2><sendNumber>' + i
      + '</sendNumber><filePath>https://plus.kipris.or.kr/' + i + '.pdf?x=1&amp;y=2</filePath></pdfInfoV2>').join('')));
  });
  const signal = new AbortController();
  const paths = await Kipris.pdfLocations('OA', app, 'fixture-kipris', signal.signal);
  assert.equal(paths.length, 2);
  assert.equal(paths[1].id, '2');
  assert.match(paths[1].path, /x=1&y=2/);
  assert.deepEqual(plain(await Kipris.pdfLocations('OA', app, 'fixture-kipris', signal.signal, '2')), [plain(paths[1])]);
  signal.abort();
  await assert.rejects(Kipris.download(paths[1].path, signal.signal), { name: 'AbortError' });
  assert.equal(calls, 2);
});

test('공보 경로는 공보번호를 우선하며 번호 없는 경로는 정확한 해시로만 구별', async () => {
  const { Kipris } = testRuntime(async () => new Response(xml([
    '<item><publicationNumber>10-2099-0000011</publicationNumber><path>/file?ticket=alpha</path></item>',
    '<item><docName>10-2099-0000012.pdf</docName><path>/file?ticket=beta</path></item>',
    '<item><path>/file?ticket=gamma</path></item>',
    '<item><path>/file?ticket=delta</path></item>'
  ].join(''))));
  const locations = await Kipris.pdfLocations('PUB', app, 'fixture-kipris', AbortSignal.timeout(1000));
  assert.deepEqual(Array.from(locations, item => item.gazetteNumber), ['1020990000011', '1020990000012', null, null]);
  assert.match(locations[2].gazetteLocator, /^[a-f0-9]{64}$/);
  assert.notEqual(locations[2].gazetteLocator, locations[3].gazetteLocator);
});

test('공보 PDF는 출원번호가 같아도 요청한 공보번호와 다르면 검증하지 않음', async () => {
  const { Kipris } = testRuntime();
  const bytes = new TextEncoder().encode('%PDF-1.4\n' + ' '.repeat(150) + '%%EOF');
  for (const [kind, title, label, expected, actual] of [
    ['PUB', '공개특허공보', '공개번호', '1020990000011', '10-2099-0000012'],
    ['REG', '등록특허공보', '등록번호', '100000011', '10-0000012']
  ]) {
    const extract = async () => ({ pageCount: 1, pages: [{ page: 1, text: title + '\n출원번호 ' + app + '\n' + label + ' ' + actual }] });
    const mismatch = await Kipris.inspectPdf(bytes, app, { kind, gazetteNumber: expected }, extract);
    assert.equal(mismatch.status, 'identity');
    assert.equal(mismatch.pages.length, 0);
    const match = await Kipris.inspectPdf(bytes, app, { kind, gazetteNumber: actual.replaceAll('-', '') }, extract);
    assert.equal(match.status, 'verified');
    assert.equal(match.gazetteNumber, actual.replaceAll('-', ''));
  }
});

test('PDF 바이트·페이지·문서 식별자와 스캔 상태를 구분', async () => {
  const { Kipris } = testRuntime();
  const doc = { id: '959999000000001', date: '20990102', kind: 'OA', title: '의견제출통지서' };
  const bytes = new TextEncoder().encode('%PDF-1.4\n' + ' '.repeat(150) + '%%EOF');
  const extract = text => async () => ({ pageCount: 1, pages: [{ page: 1, text }] });
  const page = `의견제출통지서\n출원번호 ${app}\n발송번호 ${doc.id}\n2099.01.02`;
  assert.equal((await Kipris.inspectPdf(bytes, app, doc, extract(page))).status, 'verified');
  assert.equal((await Kipris.inspectPdf(bytes, app, doc, extract('다른 출원번호'))).status, 'identity');
  assert.equal((await Kipris.inspectPdf(bytes, app, doc, extract(''))).status, 'pdf_text');
  await assert.rejects(Kipris.inspectPdf(new TextEncoder().encode('<html>error</html>'), app, doc, extract(page)), { code: 'pdf_format' });
  await assert.rejects(Kipris.inspectPdf(bytes.subarray(0, -5), app, doc, extract(page)), { code: 'pdf_incomplete' });
  await assert.rejects(Kipris.inspectPdf(new Uint8Array(), app, doc, extract(page)), { code: 'pdf_empty' });
  await assert.rejects(Kipris.inspectPdf(new Uint8Array(Kipris.maxPdf + 1), app, doc, extract(page)), { code: 'pdf_size' });
  assert.equal((await Kipris.inspectPdf(bytes, app, doc, async () => null)).status, 'pdf_parse');
  const unavailable = await Kipris.inspectPdf(bytes, app, doc, async () => { throw new Kipris.Error('pdf_parser'); });
  assert.equal(unavailable.status, 'pdf_parser');
  assert.equal(unavailable.size, bytes.length);
  assert.equal(unavailable.identityVerified, false);
  assert.equal(unavailable.pages.length, 0);
  const missing = await Kipris.inspectPdf(bytes, app, doc, async () => { throw new Kipris.Error('pdf_assets_missing'); });
  assert.equal(missing.status, 'pdf_assets_missing');
  assert.equal(Kipris.canRetryExtraction(missing.status), true);
});

test('행정처리 분류 접두사가 있는 최초 출원서를 당시 청구항의 시작점으로 인식', () => {
  const { Kipris, PatentRules } = testRuntime();
  const event = { serial: '1', id: '112099000000001', date: '20990101', title: '[특허출원]특허출원서' };
  assert.equal(Kipris.documentType(event.title), 'APP');
  const version = PatentRules.restoreClaims({ events: [event],
    changes: [{ ...event, claim: '1', change: '신규', text: '센서를 포함하는 장치.' }] },
  [{ ...event, kind: 'APP' }], { date: '20990102' });
  assert.equal(version.status, 'reconstructed');
  assert.equal(version.claims[0].text, '센서를 포함하는 장치.');
});

test('청구항은 최초 기록과 통지 이전 보정만 반영하고 당일 보정은 보류', () => {
  const { PatentRules } = testRuntime();
  const events = [
    { serial: '1', id: '101', date: '20990101', title: '특허출원서' },
    { serial: '2', id: '102', date: '20990102', title: '명세서 보정서' },
    { serial: '3', id: '103', date: '20990105', title: '명세서 보정서' }
  ];
  const change = (event, claim, operation, text = '') => ({ ...event, claim, change: operation, text });
  const changes = [
    change(events[0], '1', '신규', '기본 장치'), change(events[0], '2', '신규', '제1항의 장치'),
    change(events[0], '3', '신규', '제1항에 부가한 장치'), change(events[1], '2', '수정', '제1항의 개선 장치'),
    change(events[1], '3', '삭제'), change(events[1], '4', '신규', '제1항 또는 제2항의 장치'),
    change(events[2], '1', '수정', '통지 이후 문언')
  ];
  const rows = events.map((event, index) => ({ ...event, kind: index ? 'AM' : 'OTHER' }));
  const version = PatentRules.restoreClaims({ events, changes }, rows, { date: '20990103' });
  assert.equal(version.status, 'reconstructed');
  assert.deepEqual(plain(version.claims.map(claim => [claim.id, claim.text, claim.references])), [
    [1, '기본 장치', []], [2, '제1항의 개선 장치', [1]], [4, '제1항 또는 제2항의 장치', [1, 2]]
  ]);
  assert.equal(PatentRules.restoreClaims({ events, changes }, rows, { date: '20990105' }).status, 'unavailable');
  assert.equal(PatentRules.restoreClaims({ events, changes }, rows.slice(0, 1), { date: '20990103' }).status, 'unavailable');
});

test('등록공보·청구항 텍스트 교차 확인 및 종속항 번호 점검', () => {
  const { PatentRules } = testRuntime();
  const reg = { id: 'REG', status: 'verified', pages: [{ page: 1,
    text: '등록번호 10-9999999\n등록일자 2099.01.05\n전체 청구항 수 : 총 2 항\n청구항 1\n장치 전문\n청구항 2\n제3항의 장치 전문' }] };
  const version = PatentRules.verifyRegisteredClaims(['장치 전문', '제3항의 장치 전문'], reg, []);
  assert.equal(version.status, 'verified');
  assert.equal(PatentRules.registeredFindings(reg, version)[0].rule, 'RC-01');
  assert.equal(PatentRules.verifyRegisteredClaims(['불일치'], reg, []).status, 'unavailable');
  assert.equal(PatentRules.verifyRegisteredClaims(['장치 전문', '제3항의 장치 전문'], reg, [{ kind: 'CORRECTION' }]).status, 'unavailable');
});

test('등록공보는 청구항 번호별 전문을 대조하며 접두사·번호 뒤바뀜·다음 항 혼입을 거부', () => {
  const { PatentRules } = testRuntime();
  const reg = { id: 'REG', status: 'verified', pages: [
    { page: 1, text: '등록번호 10-9999999\n등록일자 2099.01.05\n전체 청구항 수 : 총 2 항\n청구항 1\n장치 전문\n청구항 2\n제1항의 장치로서\n- 1 -' },
    { page: 2, text: '등록특허 10-9999999\n센서를 포함하는 장치\n[발명의 설명]\n명세서의 상세한 본문\n- 2 -' }
  ] };
  const first = '장치 전문';
  const second = '제1항의 장치로서 센서를 포함하는 장치';
  const verify = api => PatentRules.verifyRegisteredClaims(api, reg, []).status;
  assert.equal(verify([first, '제1항의 장치']), 'unavailable');
  assert.equal(verify([second, first]), 'unavailable');
  assert.equal(verify([first + ' 청구항 2 ' + second, second]), 'unavailable');
  assert.equal(verify(['청구항 1: ' + second, '청구항 2: ' + first]), 'unavailable');
  assert.equal(verify([{ number: '1', text: '청구항 2: ' + first }, second]), 'unavailable');
  assert.equal(verify([first, second]), 'verified');
  assert.equal(verify([{ number: '2', text: second }, { number: '1', text: first }]), 'verified');
});

test('등록청구항 API 파싱은 제공된 번호와 빈 전문을 보존', async () => {
  const { Kipris } = testRuntime(async () => new Response(xml(
    '<claimInfo><claimNumber>2</claimNumber><claim>제1항의 장치</claim></claimInfo>'
    + '<claimInfo><claim><claimNumber>1</claimNumber><claimText>장치 전문</claimText></claim></claimInfo>'
    + '<claimInfo><claim>번호 없는 장치</claim></claimInfo>'
    + '<claimInfo><claimNumber>4</claimNumber><claim/></claimInfo>'
  )));
  const rows = await Kipris.registeredClaims(app, 'fixture-kipris', new AbortController().signal);
  assert.deepEqual(plain(rows), [
    { number: '2', text: '제1항의 장치' }, { number: '1', text: '장치 전문' },
    { number: null, text: '번호 없는 장치' }, { number: '4', text: '' }
  ]);
});

test('OA-07 판단은 통지서 및 검증된 인용발명 원문의 실제 인용을 각각 요구', () => {
  const { PatentRules } = testRuntime();
  const notice = { id: 'oa', kind: 'OA', pages: [{ page: 1, text: '통지서의 제조방법 기재' }] };
  const filing = { id: 'app', kind: 'APP', status: 'verified', pages: [{ page: 1, text: '출원 명세서의 제조방법 기재' }] };
  const citation = { id: 'cited', kind: 'CITATION', status: 'verified', pages: [{ page: 3, text: '인용발명 원문의 결과물 기재' }] };
  const noticeRef = { document: notice.id, page: 1, quote: notice.pages[0].text };
  const filingRef = { document: filing.id, page: 1, quote: filing.pages[0].text };
  const citationRef = { document: citation.id, page: 3, quote: citation.pages[0].text };
  const read = (level, evidence, source = citation) => PatentRules.readFindings(JSON.stringify([{
    rule: 'OA-07', level, evidence, comparison: '비교', analysis: '분석', verdict: '판정'
  }]), [['OA-07']], [notice, filing, source], notice.id);
  for (const level of ['검토한 규칙에서 발견되지 않음', '조건부 점검']) {
    assert.equal(read(level, [noticeRef]).length, 0);
    assert.equal(read(level, [noticeRef, filingRef]).length, 0);
    assert.equal(read(level, [noticeRef, { ...citationRef, page: 1 }]).length, 0);
    assert.equal(read(level, [noticeRef, citationRef], { ...citation, status: 'pdf_text' }).length, 0);
    assert.equal(read(level, [citationRef]).length, 0);
    assert.equal(read(level, [noticeRef, citationRef])[0].level, level);
  }
  assert.equal(read('확인 불가', [noticeRef])[0].level, '확인 불가');
});

test('OA-07은 인용발명 파일을 제공해도 대조 인용이 빠진 응답을 보고서에서 보류', async () => {
  const filing = { id: 'app', kind: 'APP', title: '특허출원서', date: '20990101',
    status: 'verified', identityVerified: true, pages: [{ page: 1, text: '출원 명세서의 제조방법 기재' }] };
  const notice = { id: 'oa', kind: 'OA', title: '의견제출통지서', date: '20990102',
    status: 'verified', identityVerified: true, pages: [{ page: 1, text: '통지서의 제조방법 기재' }] };
  const cited = { id: 'cited', kind: 'CITATION', title: '인용발명', citedBy: [notice.id],
    status: 'verified', identityVerified: true, pages: [{ page: 3, text: '인용발명 원문의 결과물 기재' }] };
  const event = { serial: '1', id: filing.id, date: filing.date, title: filing.title };
  const record = { application: app, docs: [filing, notice, cited], historyStatus: 'complete',
    collectionStatus: 'complete', claimStatus: 'complete',
    claimHistory: { events: [event], changes: [{ ...event, claim: '1', change: '신규', text: '제조방법으로 특정한 장치' }] } };
  let requested = false;
  const { PatentDiagnosis } = testRuntime(async (_, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    const checksOA07 = input.rules.some(([rule]) => rule === 'OA-07');
    if (checksOA07) requested = input.documents.some(doc => doc.id === cited.id && doc.kind === 'CITATION');
    const findings = checksOA07 ? [{ rule: 'OA-07', level: '검토한 규칙에서 발견되지 않음',
      evidence: [{ document: notice.id, page: 1, quote: notice.pages[0].text }],
      comparison: '비교', analysis: '분석', verdict: '판정' }] : [];
    return Response.json({ choices: [{ message: { content: JSON.stringify(findings) }, finish_reason: 'stop' }] });
  });
  const report = await PatentDiagnosis.evaluate(record, exa, new AbortController().signal, async () => {});
  assert.equal(requested, true);
  const result = report.findings.find(row => row.rule === 'OA-07');
  assert.equal(result.level, '확인 불가');
  assert.match(result.verdict, /인용발명 원문/);
});

test('부분 진단은 빠진 선행 통지와 잘못된 모델 인용을 확정하지 않음', () => {
  const { PatentDiagnosis, PatentRules } = testRuntime();
  const target = { id: 'rd', title: '거절결정서', date: '20990102', kind: 'RD',
    status: 'verified', identityVerified: true, pages: [{ page: 1, text: '원문 근거가 있는 문장' }] };
  const result = PatentDiagnosis.prepare({ historyStatus: 'complete',
    docs: [{ id: 'oa', date: '20990101', kind: 'OA', status: 'permission' }, target] });
  assert.ok(result.findings.some(row => row.rule === 'RD-01' && row.level === '확인 불가'));
  assert.ok(result.tasks[0].rules.some(([rule]) => rule === 'RD-04'));
  const candidate = { rule: 'RD-04', level: '조건부 점검', comparison: '비교', analysis: '분석', verdict: '판정',
    code: '9999', evidence: [{ document: 'rd', page: 2, quote: '원문 근거가 있는 문장' }] };
  assert.equal(PatentRules.readFindings(JSON.stringify([candidate]), [['RD-04']], [target], 'rd').length, 0);
  candidate.evidence[0].page = 1;
  assert.equal(PatentRules.readFindings(JSON.stringify([candidate]), [['RD-04']], [target], 'rd')[0].code, null);
});

test('최후통지 규칙은 선행 통지와 보정 전후 청구항 판본을 함께 요구', () => {
  const { PatentDiagnosis, PatentRules } = testRuntime();
  const verified = { status: 'verified', identityVerified: true,
    pages: [{ page: 1, text: '특허법 제42조 제4항에 따른 거절이유' }] };
  const earlier = { ...verified, id: 'earlier', kind: 'OA', title: '의견제출통지서', date: '20990102' };
  const final = { ...verified, id: 'final', kind: 'OA', title: '최후의견제출통지서', date: '20990104' };
  const filing = { serial: '1', id: 'app', title: '특허출원서', date: '20990101', kind: 'APP' };
  const amendment = { serial: '2', id: 'am', title: '보정서', date: '20990103', kind: 'AM' };
  const record = { docs: [filing, earlier, amendment, final], historyStatus: 'complete', claimStatus: 'complete',
    claimHistory: { events: [filing, amendment], changes: [
      { ...filing, claim: '1', change: '신규', text: '센서를 갖는 장치' },
      { ...amendment, claim: '1', change: '수정', text: '온도 센서를 갖는 장치' }
    ] } };
  const { tasks } = PatentDiagnosis.prepare(record);
  const task = tasks.find(item => item.target.id === final.id);
  assert.ok(task.rules.some(([id]) => id === 'OA-15'));
  assert.ok(task.rules.some(([id]) => id === 'OA-16'));
  assert.ok(task.rules.some(([id]) => id === 'OA-17'));
  assert.ok(PatentRules.groups.RC.some(([id]) => id === '07'));
  assert.equal(task.priorVersions[0].version.claims[0].text, '센서를 갖는 장치');
  assert.equal(task.version.claims[0].text, '온도 센서를 갖는 장치');
  const incomplete = PatentDiagnosis.prepare({ ...record, historyStatus: 'pagination' });
  assert.ok(incomplete.findings.some(row => row.rule === 'OA-15' && row.level === '확인 불가'));
});

test('OA-15는 선행·최후통지에 연결된 원문을 보내고 두 통지만 인용한 응답을 보류', async () => {
  const priorNumber = '1020990000001';
  const finalNumber = '1020990000002';
  const document = (id, kind, title, date, page, text) => ({ id, kind, title, date,
    status: 'verified', identityVerified: true, pages: [{ page, text }] });
  const filing = { ...document('app', 'APP', '특허출원서', '20990101', 1, '출원 명세서의 장치 구성'), serial: '1' };
  const prior = document('prior', 'OA', '의견제출통지서', '20990102', 1, '진보성 거절이유와 KR 10-2099-0000001의 적용');
  const amendment = { ...document('am', 'AM', '보정서', '20990103', 1, '보정서의 온도 센서 구성'), serial: '2' };
  const final = document('final', 'OA', '최후의견제출통지서', '20990104', 1, '특허법 제29조 제2항, KR 10-2099-0000002의 적용');
  const cited = [prior, final].map((notice, i) => ({
    ...document('citation-' + i, 'CITATION', '인용발명 ' + i, '', i + 2, '인용발명 ' + i + '의 원문 대조 구성'),
    citationNumber: [priorNumber, finalNumber][i], citedBy: [notice.id]
  }));
  const record = { application: app, docs: [filing, prior, amendment, final, ...cited], historyStatus: 'complete',
    collectionStatus: 'complete', claimStatus: 'complete', claimHistory: { events: [filing, amendment], changes: [
      { ...filing, claim: '1', change: '신규', text: '센서를 갖는 장치' },
      { ...amendment, claim: '1', change: '수정', text: '온도 센서를 갖는 장치' }
    ] } };
  const reference = doc => ({ document: doc.id, page: doc.pages[0].page, quote: doc.pages[0].text });
  const noFinding = '검토한 규칙에서 발견되지 않음';
  let requested;
  const run = async (docs, evidence, level = noFinding) => {
    requested = undefined;
    const { PatentDiagnosis } = testRuntime(async (_, options) => {
      const input = JSON.parse(JSON.parse(options.body).messages[1].content);
      const checksFinal = input.rules.some(([rule]) => rule === 'OA-15');
      if (checksFinal) requested = input;
      const rows = checksFinal ? [{ rule: 'OA-15', level, evidence,
        comparison: '비교', analysis: '분석', verdict: '판정' }] : [];
      return Response.json({ choices: [{ message: { content: JSON.stringify(rows) }, finish_reason: 'stop' }] });
    });
    const report = await PatentDiagnosis.evaluate({ ...record, docs }, exa, new AbortController().signal, async () => {});
    return report.findings.find(row => row.rule === 'OA-15');
  };
  const notices = [prior, final].map(reference);
  const originals = cited.map(reference);
  const noticesOnly = await run(record.docs, notices);
  assert.deepEqual(requested.documents.map(doc => doc.id), [final.id, prior.id, ...cited.map(doc => doc.id)]);
  assert.deepEqual(requested.requiredOriginals, cited.map(doc => doc.id));
  assert.equal(requested.priorVersions[0].version.claims[0].text, '센서를 갖는 장치');
  assert.equal(requested.version.claims[0].text, '온도 센서를 갖는 장치');
  assert.equal(noticesOnly.level, '확인 불가');
  assert.equal((await run(record.docs, [...notices, originals[0], { ...originals[1], page: 99 }], '조건부 점검')).level, '확인 불가');
  assert.equal((await run(record.docs, [notices[1], ...originals])).level, '확인 불가');
  assert.equal((await run(record.docs, [...notices, ...originals])).level, noFinding);
  for (const docs of [record.docs.slice(0, -1), [...record.docs.slice(0, -1), { ...cited[1], status: 'pdf_text' }]]) {
    const missing = await run(docs, [...notices, ...originals]);
    assert.equal(requested, undefined);
    assert.equal(missing.level, '확인 불가');
    assert.match(missing.verdict, /인용발명 원문을 모두 검증하지 못함/);
  }

  const formal = [prior, final].map(doc => ({ ...doc, pages: [{ page: 1, text: '청구항 인용번호 오기 관련 거절이유' }] }));
  assert.equal((await run([filing, amendment, ...formal], formal.map(reference))).level, noFinding);
  assert.deepEqual(requested.requiredOriginals, []);

  const enablement = { ...formal[1], pages: [{ page: 1, text: '특허법 제42조 제3항의 실시 가능 요건 관련 거절이유' }] };
  const specDocs = [filing, amendment, formal[0], enablement];
  const specNotices = [formal[0], enablement].map(reference);
  assert.equal((await run(specDocs, specNotices)).level, '확인 불가');
  assert.deepEqual(requested.requiredOriginals, [filing.id, amendment.id]);
  assert.equal((await run(specDocs, [...specNotices, ...[filing, amendment].map(reference)])).level, noFinding);
});

test('OA-15는 제42조 제4항 제1호 단독·병기·같은 항 참조에 명세서 원문을 요구', async () => {
  const noFinding = '검토한 규칙에서 발견되지 않음';
  const verified = { status: 'verified', identityVerified: true };
  const filing = { id: 'app', kind: 'APP', title: '특허출원서', date: '20990101', serial: '1' };
  const amendment = { id: 'am', kind: 'AM', title: '보정서', date: '20990103', serial: '2' };
  const notice = (id, title, date, text) => ({ ...verified, id, title, date, kind: 'OA', pages: [{ page: 1, text }] });
  const prior = notice('prior', '의견제출통지서', '20990102', '특허법 제42조 제4항 제2호');
  const final = notice('final', '최후의견제출통지서', '20990104', '특허법 제42조 제4항 제1호');
  const originals = [filing, amendment].map((doc, index) => ({ ...doc, ...verified,
    pages: [{ page: index + 2, text: '발명의 설명에 기재된 센서 구성 ' + index }] }));
  const record = { application: app, historyStatus: 'complete', collectionStatus: 'complete', claimStatus: 'complete',
    claimHistory: { events: [filing, amendment], changes: [
      { ...filing, claim: '1', change: '신규', text: '센서를 갖는 장치' },
      { ...amendment, claim: '1', change: '수정', text: '온도 센서를 갖는 장치' }
    ] } };
  const run = async (notices, filings, references = []) => {
    let request;
    const { PatentDiagnosis } = testRuntime(async (_, options) => {
      const input = JSON.parse(JSON.parse(options.body).messages[1].content);
      const checksOA15 = input.rules.some(([rule]) => rule === 'OA-15');
      if (checksOA15) request = input;
      const evidence = [...notices, ...references].map(doc => ({ document: doc.id,
        page: doc.pages[0].page, quote: doc.pages[0].text }));
      const rows = checksOA15 ? [{ rule: 'OA-15', level: noFinding, evidence,
        comparison: '비교', analysis: '분석', verdict: '판정' }] : [];
      return Response.json({ choices: [{ message: { content: JSON.stringify(rows) }, finish_reason: 'stop' }] });
    });
    const report = await PatentDiagnosis.evaluate({ ...record, docs: [...notices, ...filings] }, exa,
      new AbortController().signal, async () => {});
    return { request, finding: report.findings.find(row => row.rule === 'OA-15') };
  };

  const missing = await run([prior, final], [filing, amendment]);
  assert.equal(missing.finding.level, '확인 불가');
  assert.match(missing.finding.verdict, /명세서·도면 또는 보정서/);
  assert.equal(missing.request, undefined);
  const missingAmendment = await run([prior, final], [originals[0], amendment]);
  assert.equal(missingAmendment.finding.level, '확인 불가');
  assert.equal(missingAmendment.request, undefined);
  const noticesOnly = await run([prior, final], originals);
  assert.deepEqual(noticesOnly.request.requiredOriginals, [filing.id, amendment.id]);
  assert.deepEqual(noticesOnly.request.documents.map(doc => doc.id), [final.id, prior.id, filing.id, amendment.id]);
  assert.equal(noticesOnly.finding.level, '확인 불가');
  assert.equal((await run([prior, final], originals, originals)).finding.level, noFinding);

  const mixed = notice(final.id, final.title, final.date, '특허법 제４２조\n제４항 제２호 및 제１호');
  assert.equal((await run([prior, mixed], [filing, amendment])).finding.level, '확인 불가');
  const clarity = { ...final, pages: prior.pages };
  const clarityOnly = await run([prior, clarity], [filing, amendment]);
  assert.deepEqual(clarityOnly.request.requiredOriginals, []);
  assert.equal(clarityOnly.finding.level, noFinding);
  const priorSupport = { ...prior, pages: final.pages };
  const priorOnly = await run([priorSupport, clarity], [originals[0], amendment], [originals[0]]);
  assert.deepEqual(priorOnly.request.requiredOriginals, [filing.id]);
  assert.equal(priorOnly.finding.level, noFinding);

  for (const text of [
    '특허법 제42조 제4항 제1, 2호',
    '특허법 제42조 제4항 제2호 및 같은 항 제1호',
    '특허법 제42조 제4항 제2호 및 같은 항의 제1호',
    '특허법 제42조 제4항 제2ㆍ1호',
    '특허법 제４２조\n제４항 제２호, 제１호',
    '특허법 제42조 제4항 제2호 및 같은 조 제4항 제1호'
  ]) {
    const compound = { ...final, pages: [{ page: 1, text }] };
    const missing = await run([prior, compound], [filing, amendment]);
    assert.equal(missing.finding.level, '확인 불가', text);
    assert.equal(missing.request, undefined, text);
    const noticesOnly = await run([prior, compound], originals);
    assert.deepEqual(noticesOnly.request.requiredOriginals, [filing.id, amendment.id], text);
    assert.equal(noticesOnly.finding.level, '확인 불가', text);
    assert.equal((await run([prior, compound], originals, originals)).finding.level, noFinding, text);
  }
  for (const text of [
    '특허법 제42조 제4항 제2호 및 제2항 제1호',
    '특허법 제42조 제4항 제2호 및 제43조 제1항 제2호 및 같은 항 제1호',
    '특허법 제42조 제4항 제2호 및 제2항 제2호 및 같은 항 제1호',
    '특허법 제42조 제4항 제2호. 아래 제1호는 별도 항목입니다.',
    '특허법 제42조 제4항 제11호'
  ]) {
    const unrelated = { ...final, pages: [{ page: 1, text }] };
    const result = await run([prior, unrelated], [filing, amendment]);
    assert.deepEqual(result.request.requiredOriginals, [], text);
    assert.equal(result.finding.level, noFinding, text);
  }
});

test('긴 문서 대조는 여러 원문의 쪽별 발췌를 사용하고 발견 없음 판정은 보류', async () => {
  const quote = '청구항 제1항의 문언';
  const pages = [1, 2].map(page => ({ page, text: quote + ' 추가 문장'.repeat(7000) }));
  const notice = { id: 'oa', kind: 'OA', title: '의견제출통지서', date: '20990101',
    status: 'verified', identityVerified: true, pages };
  const decision = { ...notice, id: 'rd', kind: 'RD', title: '거절결정서', date: '20990102' };
  let cross = false;
  const outputs = [];
  const { PatentDiagnosis } = testRuntime(async (_, options) => {
    const body = JSON.parse(options.body);
    const input = JSON.parse(body.messages[1].content);
    if (input.rules.some(([rule]) => rule === 'RD-01')) {
      cross = body.messages[0].content.includes('쪽별 원문 발췌')
        && input.documents.length === 2 && input.documents.every(doc =>
          doc.pages.some(page => page.page === 2) && doc.pages.every(page => page.text.length < pages[0].text.length));
    }
    outputs.push(body.max_tokens);
    const evidence = input.documents.map(doc => ({ document: doc.id, page: 1, quote }));
    const rows = input.rules.map(([rule]) => ({ rule, evidence, comparison: '비교', analysis: '분석', verdict: '판정',
      level: rule === 'RD-02' ? '조건부 점검' : '검토한 규칙에서 발견되지 않음' }));
    return Response.json({ choices: [{ message: { content: JSON.stringify(rows) }, finish_reason: 'stop' }] });
  });
  const record = { application: app, collectionStatus: 'complete', historyStatus: 'complete', docs: [notice, decision] };
  const report = await PatentDiagnosis.evaluate(record, { ...exa, modelContextTokens: 4096, modelMaxOutputTokens: 512 },
    new AbortController().signal, async () => {});
  assert.equal(cross, true);
  assert.ok(outputs.length && outputs.every(value => value >= 256 && value <= 512));
  assert.deepEqual(plain(report.tokenBudget), { requested: 30000,
    outputPerCall: Math.max(...outputs), minOutputPerCall: Math.min(...outputs) });
  assert.equal(report.findings.find(row => row.rule === 'RD-01').level, '확인 불가');
  assert.equal(report.findings.find(row => row.rule === 'RD-02').level, '조건부 점검');
  assert.ok(report.omitted.some(row => row.document === notice.id && row.pages.includes(2)));
  assert.equal(report.status, 'partial');
});

test('출력과 입력 여유를 허용하는 설정에서는 진단 호출에 30000을 적용', async () => {
  let requested;
  const { PatentDiagnosis } = testRuntime(async (_, options) => {
    requested = JSON.parse(options.body).max_tokens;
    return Response.json({ choices: [{ message: { content: '[]' }, finish_reason: 'stop' }] });
  });
  const report = await PatentDiagnosis.evaluate({ application: app, collectionStatus: 'complete',
    historyStatus: 'complete', docs: [{ id: 'rd', kind: 'RD', title: '거절결정서', date: '20990102',
      status: 'verified', identityVerified: true, pages: [{ page: 1, text: '합성 문서 본문' }] }] },
  { ...exa, modelContextTokens: 65536, modelMaxOutputTokens: 30000 }, new AbortController().signal, async () => {});
  assert.equal(requested, 30000);
  assert.equal(report.tokenBudget.outputPerCall, 30000);
});

test('32k 컨텍스트와 30k 출력 요청에서도 OA-17의 긴 청구항 40개 전문을 먼저 확보', async () => {
  const filing = { id: 'app', kind: 'APP', title: '특허출원서', date: '20990101', serial: '1' };
  const quote = '청구항 문언의 명확성에 관한 검토';
  const notice = { id: 'oa', kind: 'OA', title: '의견제출통지서', date: '20990102',
    status: 'verified', identityVerified: true, pages: [{ page: 1, text: quote }] };
  const changes = Array.from({ length: 40 }, (_, index) => ({ ...filing, claim: String(index + 1), change: '신규',
    text: `바람직하게는 온도 센서를 포함하며 ${'측정값을 기록하고 분석하는 장치와 '.repeat(27)}최종 구성 ${index + 1}` }));
  const calls = [];
  const { PatentDiagnosis, computeRequestBudget } = testRuntime(async (_, options) => {
    const body = JSON.parse(options.body);
    const input = JSON.parse(body.messages[1].content);
    calls.push({ body, input });
    const rows = input.rules.map(([rule]) => ({ rule, level: '검토한 규칙에서 발견되지 않음',
      evidence: [{ document: notice.id, page: 1, quote }], comparison: '비교', analysis: '분석', verdict: '판정' }));
    return Response.json({ choices: [{ message: { content: JSON.stringify(rows) }, finish_reason: 'stop' }] });
  });
  const record = { application: app, docs: [filing, notice], historyStatus: 'complete',
    collectionStatus: 'complete', claimStatus: 'complete', claimHistory: { events: [filing], changes } };
  const config = { ...exa, maxTokens: 30000, modelMaxOutputTokens: 30000 };
  const evaluate = row => PatentDiagnosis.evaluate(row, config, new AbortController().signal, async () => {});
  const report = await evaluate(record);
  const request = calls.find(({ input }) => input.rules.some(([rule]) => rule === 'OA-17'));
  assert.ok(request);
  assert.deepEqual(request.input.version.claims.map(claim => claim.text), changes.map(claim => claim.text));
  assert.deepEqual(request.input.documents[0].pages, notice.pages);
  const { inputTokens, margin, contextLimit } = computeRequestBudget({ apiConfig: config, messages: request.body.messages });
  assert.ok(inputTokens + margin + Math.floor(contextLimit * 0.6) > contextLimit);
  assert.equal(request.body.max_tokens, contextLimit - inputTokens - margin);
  assert.ok(request.body.max_tokens < calls.find(({ input }) => !input.version).body.max_tokens);
  assert.equal(report.tokenBudget.requested, 30000);
  assert.equal(report.tokenBudget.minOutputPerCall, Math.min(...calls.map(({ body }) => body.max_tokens)));
  assert.equal(report.tokenBudget.outputPerCall, Math.max(...calls.map(({ body }) => body.max_tokens)));
  assert.equal(report.findings.find(row => row.rule === 'OA-17').level, '검토한 규칙에서 발견되지 않음');

  calls.length = 0;
  const tooLong = changes.map(change => ({ ...change, text: change.text.repeat(4) }));
  const limited = await evaluate({ ...record, claimHistory: { ...record.claimHistory, changes: tooLong } });
  assert.ok(!calls.some(({ input }) => input.rules.some(([rule]) => rule === 'OA-17')));
  assert.match(limited.findings.find(row => row.rule === 'OA-17').verdict, /청구항 판본도 모델 입력 한도를 초과/);
});

test('검증된 특허 원문이 없으면 출원번호만 모델에 전송하지 않음', async () => {
  let calls = 0;
  const { PatentDiagnosis } = testRuntime(async () => { calls++; });
  const report = await PatentDiagnosis.evaluate({ application: app, collectionStatus: 'partial',
    historyStatus: 'permission', docs: [{ id: 'oa', kind: 'OA', title: '통지서', status: 'permission' }] },
  exa, new AbortController().signal, async () => {});
  assert.equal(calls, 0);
  assert.equal(report.status, 'no_evidence');
  assert.match(PatentDiagnosis.format(report), /외부 모델에 원문을 전송하지 않았습니다/);
  assert.equal(report.findings.length, 16);
});

test('새 설치에서 웹 콘텐츠와 기억 전송이 기본 해제', () => {
  const context = vm.createContext({});
  const settings = vm.runInContext(readFileSync('config.js', 'utf8') + '\nDEFAULT_SETTINGS', context);
  assert.equal(settings.contentAwarenessEnabled, false);
  assert.equal(settings.sendMemoryToModel, false);
  assert.equal(settings.floatingAvatarEnabled, false);
  assert.equal(vm.runInContext('DEFAULT_API_SETTINGS.maxTokens', context), 30000);
});

test('실제 PDF 파서가 합성 한국어 원문과 페이지 경계를 읽음', async () => {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { testPdf } = require('./pdf-fixture.cjs');
  const loading = getDocument({ data: new TextEncoder().encode(testPdf()),
    useWasm: false, isEvalSupported: false, stopAtErrors: true });
  try {
    const pdf = await loading.promise;
    assert.equal(pdf.numPages, 1);
    const { items } = await (await pdf.getPage(1)).getTextContent();
    const text = items.map(item => item.str).join(' ');
    assert.match(text, /의견제출통지서/);
    assert.match(text, /시험\s+근거\s+문장입니다\./);
  } finally { await loading.destroy(); }
});

test('심판 문서와 증서·고객번호 정정이 심사 시점 청구항에 섞이지 않음', () => {
  const { Kipris, PatentRules } = testRuntime();
  const title = '[심판]보정서';
  const trial = { serial: '2', id: '202', date: '20990102', title };
  const initial = { serial: '1', id: '201', date: '20990101', title: '[특허출원]특허출원서' };
  assert.equal(Kipris.documentType(title), 'TRIAL_FILING');
  assert.equal(Kipris.documentType('의견서', { stage: '심판' }), 'TRIAL_FILING');
  assert.equal(Kipris.documentType('등록결정서', { stage: '출원', trialNumber: 'N/A' }), 'RG');
  assert.equal(Kipris.documentType('[등록증재발급]등록증 정정신청서'), 'OTHER');
  assert.equal(Kipris.documentType('[출원인코드]고객번호 정정'), 'OTHER');
  assert.equal(Kipris.documentType('청구범위 정정'), 'CORRECTION');
  const rows = [{ ...initial, kind: 'APP' }, { ...trial, kind: 'TRIAL_FILING' }];
  const result = PatentRules.restoreClaims({ events: [initial, trial], changes: [
    { ...initial, claim: '1', change: '신규', text: '센서 장치' },
    { ...trial, claim: '1', change: '수정', text: '심판 문언' }
  ] }, rows, { date: '20990102' });
  assert.equal(result.status, 'reconstructed');
  assert.equal(result.claims[0].text, '센서 장치');
  assert.match(Kipris.documentStatus({ kind: 'OPINION', status: 'manual' }), /원문 PDF 미제공/);
  assert.match(Kipris.documentStatus({ kind: 'REG', status: 'not_found' }), /원문 PDF가 조회되지 않음/);
});

test('정정공고와 심결문은 공식 식별자로 조회하고 PDF의 출원·종류·번호를 교차 검증', async () => {
  const trialNumber = '2099100000123';
  const urls = [];
  const { Kipris } = testRuntime(async url => {
    const request = new URL(url);
    urls.push(request);
    if (request.pathname.endsWith('/revisionfullDocPDFInfo')) return new Response(xml(
      '<items><revisionfullDocPDFInfo><applicationNumber>' + app + '</applicationNumber>'
      + '<number>2</number><date>20990102</date><typeCode>B0102</typeCode><typeDescription>정정공보(등록)전문</typeDescription>'
      + '<path>/correction.pdf</path></revisionfullDocPDFInfo></items>'));
    if (request.pathname.endsWith('/trialBibliographicSummaryInfo')) return new Response(xml(
      '<items><trialBibliographicSummaryInfo><TrialNumber>' + trialNumber + '</TrialNumber>'
      + '<ApplicationNumber>' + app + '</ApplicationNumber><TrialNumberName>2099당123</TrialNumberName>'
      + '<TrialdecisionDate>20990102</TrialdecisionDate></trialBibliographicSummaryInfo></items>'));
    return new Response(xml('<item><fileName>' + trialNumber + '.PDF</fileName><openYN>Y</openYN><path>/trial.pdf</path></item>'));
  });
  const signal = new AbortController().signal;
  const key = 'fixture';
  const [correction] = await Kipris.correctionLocations(app, key, signal);
  const decision = { kind: 'TRIAL_DECISION', trialNumber, date: '20990103' };
  const [location] = await Kipris.trialDecisionLocations(decision, app, key, signal);
  const summary = await Kipris.trialSummary(decision, app, key, signal);
  await assert.rejects(Kipris.trialDecisionLocations({ ...decision, trialNumber: app }, app, key, signal),
    { code: 'missing_trial_number' });
  assert.equal(location.path, '/trial.pdf');
  assert.equal(correction.kind, 'CORR_REG');
  assert.equal(urls[0].searchParams.get('applicationNumber'), app);
  assert.equal(urls[0].searchParams.get('accessKey'), key);
  assert.equal(urls[1].searchParams.get('trialNumber'), trialNumber);
  assert.equal(urls[1].searchParams.has('applicationNumber'), false);
  assert.equal(urls[1].searchParams.get('ServiceKey'), key);
  assert.equal(urls[2].searchParams.get('TrialNumber'), trialNumber);
  const bytes = new TextEncoder().encode(testPdf());
  const inspect = (doc, text) => Kipris.inspectPdf(bytes, app, doc, async () => ({ pageCount: 1, pages: [{ page: 1, text }] }));
  const original = { ...decision, ...summary };
  assert.equal((await inspect(original, '심결문\n사건 2099당123\n2099.01.02')).status, 'verified');
  assert.equal((await inspect(original, '심결문\n사건 2099당1234\n2099.01.02')).status, 'identity');
  const corrected = { ...correction, sameDateCorrection: true, correctionSerial: '2' };
  const header = '정정공고(등록)\n출원번호 ' + app + '\n등록번호 10-9999999\n2099.01.02';
  assert.equal((await inspect(corrected, header)).status, 'identity');
  assert.equal((await inspect(corrected, header + '\n정정공고순번 2')).status, 'verified');
});

test('코딩은 명시 언어의 기본 확장자와 여러 언어의 하위 폴더를 보존', () => {
  const { CodeProjects } = testRuntime();
  const one = CodeProjects.parse('```\nprint("hi")\n```', 'python');
  assert.equal(one[0].name, 'file-1.py');
  const project = CodeProjects.parse('File: 화면/index.html\n```html\n<p>Hi</p>\n```\n'
    + 'File: 화면/app.js\n```javascript\nconsole.log(1)\n```', 'html');
  assert.deepEqual(plain(project.map(file => [file.name, file.language])), [
    ['화면/index.html', 'html'], ['화면/app.js', 'javascript']
  ]);
});
