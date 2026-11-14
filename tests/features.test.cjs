const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const { testPdf } = require('./pdf-fixture.cjs');

const paths = ['config.js', 'utils.js', 'api.js', 'coding.js', 'file-io.js', 'kipris.js', 'kipris-pdf-identity.js'];
const source = paths.map(path => readFileSync(path, 'utf8')).join('\n');
const testRuntime = fetch => {
  const ctx = vm.createContext({ URL, fetch, AbortController, AbortSignal, setTimeout, clearTimeout,
    TextDecoder, TextEncoder, Blob, Response, crypto, console: { warn() {} } });
  return vm.runInContext(source + `\n({ CONFIG, LLMClient, chatCompletionURL, buildChatCompletionRequest,
    CodeProjects, FileIO, Kipris, KiprisPdfIdentity, computeRequestBudget, resolveKeyForOrigin, isTrustedExtensionUI })`, ctx);
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

test('번호 없는 공보의 임시 토큰만 바뀌면 식별자를 유지하고 불투명 주소나 문서 선택자는 유지', async () => {
  let turn = 0;
  const { Kipris } = testRuntime(async () => {
    turn++;
    return new Response(xml('<items>' + [
      '/file.pdf?document=1&amp;token=' + turn,
      '/file.pdf?document=' + (turn + 1) + '&amp;token=' + turn,
      '/fileToss.jsp?arg=' + turn
    ].map(path => '<item><path>' + path + '</path></item>').join('') + '</items>'));
  });
  const query = () => Kipris.pdfLocations('PUB', app, 'fixture', AbortSignal.timeout(1000));
  const a = await query();
  const b = await query();
  assert.equal(a[0].gazetteLocator, b[0].gazetteLocator);
  assert.notEqual(a[1].gazetteLocator, b[1].gazetteLocator);
  assert.notEqual(a[2].gazetteLocator, b[2].gazetteLocator);
});

test('정정공보는 PDF 첫 쪽에서 출원·종류·일자·일련번호를 확인', () => {
  const { KiprisPdfIdentity } = testRuntime();
  const header = '정정공고(공개)\n출원번호 ' + app + '\n공개번호 10-9999-0000011\n2099.01.11\n';
  const doc = { kind: 'CORR_PUB', date: '20990111', serial: '1' };
  const match = text => KiprisPdfIdentity.matches(text, app, doc);
  assert.equal(match(header + '정정공고일련번호 ０１'), true);
  assert.equal(match(header + '정정공고일련번호 2'), false);
  assert.equal(match(header), false);
  assert.equal(match(header.replace(app, '1099990000002') + '정정공고번호 1'), false);
  assert.equal(match(header + '정정공고번호 1\n정정공고번호 2'), false);
});

test('PDF 다운로드는 서명·종료 표시·크기를 검사', () => {
  const { Kipris } = testRuntime();
  const bytes = new TextEncoder().encode(testPdf());
  assert.doesNotThrow(() => Kipris.checkPdfBytes(bytes));
  assert.throws(() => Kipris.checkPdfBytes(new TextEncoder().encode('<html>error</html>')), { code: 'pdf_format' });
  assert.throws(() => Kipris.checkPdfBytes(bytes.subarray(0, -6)), { code: 'pdf_incomplete' });
  assert.throws(() => Kipris.checkPdfBytes(new Uint8Array()), { code: 'pdf_empty' });
  assert.throws(() => Kipris.checkPdfBytes(new Uint8Array(Kipris.maxPdf + 1)), { code: 'pdf_size' });
});

test('새 설치에서 웹 콘텐츠와 기억 전송이 기본 해제', () => {
  const context = vm.createContext({});
  const settings = vm.runInContext(readFileSync('config.js', 'utf8') + '\nDEFAULT_SETTINGS', context);
  assert.equal(settings.contentAwarenessEnabled, false);
  assert.equal(settings.sendMemoryToModel, false);
  assert.equal(settings.floatingAvatarEnabled, false);
  assert.equal(vm.runInContext('DEFAULT_API_SETTINGS.maxTokens', context), 30000);
});

test('권리범위확인심결(특실의)은 심결문으로 분류하되 심판 청구서와 보정서는 구분', () => {
  const { Kipris } = testRuntime();
  const trial = { stage: '심판', trialNumber: '2099100000123' };
  assert.equal(Kipris.documentType('권리범위확인심결(특실의)', trial), 'TRIAL_DECISION');
  assert.equal(Kipris.documentType('[심판] 권리범위 확인심결（특실의）'), 'TRIAL_DECISION');
  assert.equal(Kipris.documentType('권리범위확인심판청구서', trial), 'TRIAL_FILING');
  assert.equal(Kipris.documentType('[심판]보정서', trial), 'TRIAL_FILING');
});

test('정정공고와 심결문은 공식 식별자로 조회', async () => {
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
  assert.equal(summary.trialNumberName, '2099당123');
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
