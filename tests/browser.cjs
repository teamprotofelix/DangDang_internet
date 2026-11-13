const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = process.env.DANGDANG_PLAYWRIGHT
  ? require(process.env.DANGDANG_PLAYWRIGHT) : require('playwright');

const { app, send, date, testPdf } = require('./pdf-fixture.cjs');
const pubNumbers = ['1099990000011', '1099990000012'];
const pubPdfs = pubNumbers.map(number => testPdf(['공개특허공보', '출원번호 ' + app, '공개번호 ' + number]));
const opinionId = '119999000000001';
const opinionPdf = testPdf(['의견서', '출원번호 ' + app, '접수번호 ' + opinionId, '2099.01.03']);
const rotatingApp = '1099990000002';
const rotatingNumber = '1099990000013';
const rotatingPdf = testPdf(['공개특허공보', '출원번호 ' + rotatingApp, '공개번호 ' + rotatingNumber]);

async function main() {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'dangdang-chromium-'));
  const extension = path.resolve(process.env.DANGDANG_EXTENSION_DIR || path.resolve(__dirname, '..'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.DANGDANG_CHROMIUM || undefined,
      channel: process.env.DANGDANG_CHROMIUM ? undefined : 'chromium',
      headless: true,
      args: ['--no-sandbox', '--disable-extensions-except=' + extension, '--load-extension=' + extension]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(18000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.dismiss());
    await worker.evaluate(({ app, send, date, pdf, pubNumbers, pubPdfs, opinionId, rotatingApp, rotatingPdf }) => {
      const fetchOriginal = globalThis.fetch;
      globalThis.fixtureRequests = { kipris: 0, model: 0, pdf: 0, rotating: 0 };
      const createOffscreen = chrome.offscreen.createDocument.bind(chrome.offscreen);
      globalThis.fixtureParserUnavailable = true;
      globalThis.fixturePanelUnavailable = true;
      let gazetteLookups = 0;
      const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (...args) => {
        if (args[0]?.type === 'kipris_pdf_parse' && globalThis.fixtureParserUnavailable) {
          return Promise.reject(new Error('Fixture: parser unavailable'));
        }
        if (args[0]?.type === 'kipris_pdf_parse_panel') {
          if (globalThis.fixturePanelUnavailable) return Promise.reject(new Error('Fixture: panel unavailable'));
          globalThis.fixtureRequests.panel = (globalThis.fixtureRequests.panel || 0) + 1;
        }
        return sendMessage(...args);
      };
      chrome.offscreen.createDocument = options => {
        if (globalThis.fixtureParserUnavailable) return Promise.reject(new Error('Fixture: parser unavailable'));
        return createOffscreen(options);
      };
      globalThis.fetch = async (input, options) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.protocol === 'chrome-extension:') return fetchOriginal(input, options);
        const response = body => new Response('<response><header><resultCode>00</resultCode></header><body>'
          + body + '</body></response>', { headers: { 'content-type': 'application/xml' } });
        if (url.hostname === 'plus.kipris.or.kr') {
          globalThis.fixtureRequests.kipris++;
          if (url.searchParams.get('applicationNumber') === rotatingApp) {
            if (!url.pathname.includes('getPubFullTextInfoSearch')) return response('<items/>');
            const ticket = ++globalThis.fixtureRequests.rotating;
            return response('<items><item><docName>공개전문</docName><path>https://plus.kipris.or.kr/rotating.pdf?ticket='
              + ticket + '</path></item></items>');
          }
          if (url.pathname === '/rotating.pdf') {
            return url.searchParams.get('ticket') === '1' ? new Response(null, { status: 410 }) : new Response(rotatingPdf);
          }
          if (url.pathname.includes('relatedDocsonfileInfo')) return response('<items><item><applicationNumber>'
            + app + '</applicationNumber><documentNumber>' + send + '</documentNumber><documentDate>'
            + date + '</documentDate><documentTitle>의견제출통지서</documentTitle></item>'
            + '<item><applicationNumber>' + app + '</applicationNumber><documentNumber>' + opinionId
            + '</documentNumber><documentDate>20990103</documentDate><documentTitle>의견서</documentTitle></item></items>');
          if (url.pathname.includes('getPubFullTextInfoSearch')) {
            gazetteLookups++;
            const order = gazetteLookups === 1 ? [0, 1] : [1, 0];
            return response('<items>' + order.map(index => '<item><publicationNumber>' + pubNumbers[index]
              + '</publicationNumber><path>https://plus.kipris.or.kr/gazette-' + index + '.pdf?ticket='
              + gazetteLookups + '</path></item>').join('') + '</items>');
          }
          if (url.pathname === '/gazette-0.pdf') return new Response(pubPdfs[0]);
          if (url.pathname === '/gazette-1.pdf') {
            return url.searchParams.get('ticket') === '1' ? new Response(null, { status: 410 }) : new Response(pubPdfs[1]);
          }
          if (url.pathname.includes('IntermediateDocumentOPService') && !url.searchParams.get('sendNumber')) return response('<items/>');
          if (url.pathname.includes('IntermediateDocumentOPService') && url.searchParams.get('sendNumber') === send) return response('<pdfInfoV2><applicationNumber>'
            + app + '</applicationNumber><sendNumber>' + send
            + '</sendNumber><filePath>https://plus.kipris.or.kr/fixture.pdf</filePath></pdfInfoV2>');
          if (url.pathname === '/fixture.pdf') {
            globalThis.fixtureRequests.pdf++;
            if (globalThis.fixtureRequests.pdf === 1) return new Response(null, { status: 410 });
            return new Response(pdf, { headers: { 'content-type': 'application/pdf' } });
          }
          return response('<items/>');
        }
        if (url.hostname === 'api.exaone.ai') {
          globalThis.fixtureRequests.model++;
          const payload = JSON.parse(JSON.parse(options.body).messages[1].content);
          return Response.json({ choices: [{ message: { content: JSON.stringify(payload.rules.map(([rule]) => ({
            rule, level: '조건부 점검', evidence: [{ document: send, page: 1, quote: '시험 근거 문장입니다.' }],
            comparison: '원문 대비', analysis: '합성 데이터', verdict: '확인 필요'
          }))) }, finish_reason: 'stop' }] });
        }
        throw new Error('Unexpected fixture request');
      };
      return chrome.storage.local.set({
        settings: { onboardingDismissed: true },
        code_session: { prompt: '레거시', html: '<p>이전 세션</p>' }
      });
    }, { app, send, date, pdf: testPdf(), pubNumbers, pubPdfs, opinionId, rotatingApp, rotatingPdf });
    const browserCode = [];
    await page.route('https://api.exaone.ai/v1/chat/completions', async route => {
      const body = route.request().postDataJSON();
      assert.equal(route.request().headers().authorization, 'Bearer fixture-exaone');
      const ordinary = body.messages.at(-1).content === '일반 대화 회귀';
      const coding = body.messages.length > 1 && /existingFiles/.test(body.messages[1].content)
        ? JSON.parse(body.messages[1].content) : null;
      const content = ordinary ? JSON.stringify({ mood: 'smile', message: '대화 응답 확인' })
        : body.messages[0].role === 'user' ? 'OK'
        : coding?.request === '두 번째 파일을 추가해 주세요' ? 'File: second.py\n```python\nprint("second")\n```'
        : 'File: main.py\n```python\nprint("안녕")\n```\nFile: README.md\n```markdown\n사용법\n```';
      if (coding && !body.stream) browserCode.push(coding);
      return route.fulfill({ json: { choices: [{ message: { content }, finish_reason: 'stop' }] } });
    });
    await page.goto('chrome-extension://' + id + '/sidepanel.html');
    await page.locator('#btn-pet').waitFor({ state: 'attached' });
    console.log('Companion panel loaded');
    assert.equal(await page.locator('#toggle-content-aware').isChecked(), false);
    assert.equal(await page.locator('#input-max-tokens').inputValue(), '30000');
    await page.click('#btn-mode-code');
    await page.waitForSelector('#code-files code');
    assert.match(await page.locator('#code-files code').textContent(), /이전 세션/);
    await page.click('#btn-settings');
    await page.selectOption('#preset-selector', 'exaone');
    assert.equal(await page.inputValue('#input-model'), 'k-exaone_v2.5');
    await page.fill('#input-api-key', 'fixture-exaone');
    await page.click('#btn-save-api');
    await page.waitForFunction(() => document.querySelector('.haru-toast')?.textContent.includes('저장'));
    await page.click('#btn-test-api');
    await page.waitForFunction(() => document.querySelector('#api-test-result').classList.contains('success'));
    await page.fill('#kipris-key', 'fixture-kipris');
    await page.click('#kipris-key-save');
    await page.waitForFunction(() => document.querySelector('#kipris-key-status').textContent.includes('키가 저장'));
    await page.click('#btn-close-settings');
    console.log('Provider and KIPRIS settings saved');

    await page.click('#btn-mode-chat');
    await page.fill('#message-input', '일반 대화 회귀');
    await page.click('#btn-send');
    await page.waitForFunction(() => document.querySelector('#messages').textContent.includes('대화 응답 확인'));
    await page.check('#chat-code-enabled');
    await page.fill('#message-input', 'Python으로 수정해 주세요');
    await page.click('#btn-send');
    await page.waitForFunction(() => document.querySelectorAll('.code-chat-project code').length === 2);
    const firstRequest = browserCode[0];
    assert.match(firstRequest.existingFiles[0].content, /이전 세션/);
    await page.fill('#chat-code-language', 'python');
    await page.fill('#message-input', '두 번째 파일을 추가해 주세요');
    await page.click('#btn-send');
    await page.waitForFunction(() => document.querySelectorAll('.code-chat-project code').length === 3);
    const messages = page.locator('.code-chat-project');
    const downloadNames = async button => {
      const download = page.waitForEvent('download');
      await button.click();
      const file = await download;
      assert.equal(file.suggestedFilename(), 'dangdang-project.zip');
      const data = (await readFile(await file.path())).toString('base64');
      return page.evaluate(async encoded => {
        const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
        const contents = await FileIO.unzip(bytes.buffer);
        return Object.keys(contents).filter(name => !name.startsWith('__bin__:')).sort();
      }, data);
    };
    const firstZip = messages.first().getByRole('button', { name: '프로젝트 ZIP' });
    const secondZip = messages.nth(1).getByRole('button', { name: '프로젝트 ZIP' });
    assert.deepEqual(await downloadNames(firstZip), ['README.md', 'app.html', 'main.py']);
    assert.deepEqual(await downloadNames(secondZip), ['README.md', 'app.html', 'main.py', 'second.py']);
    const regenerated = page.waitForRequest(request => request.url() === 'https://api.exaone.ai/v1/chat/completions'
      && request.postDataJSON()?.stream === false);
    await messages.first().getByRole('button', { name: '다시 생성' }).click();
    await regenerated;
    await messages.first().getByText('3개 파일을 준비했습니다.').waitFor();
    assert.deepEqual(browserCode.at(-1), firstRequest);
    assert.deepEqual(await downloadNames(firstZip), ['README.md', 'app.html', 'main.py']);
    await page.click('#btn-mode-code');
    assert.deepEqual(await downloadNames(page.locator('#btn-code-zip')), ['README.md', 'app.html', 'main.py', 'second.py']);

    console.log('Coding project downloaded');
    await page.click('#btn-mode-work');
    await page.fill('#patent-application', '10-9999-0000001');
    await page.click('#patent-lookup');
    const notice = page.getByRole('row').filter({ hasText: '의견제출통지서' });
    await notice.getByText('PDF 다운로드 경로가 만료됐거나 서버에서 찾을 수 없음').waitFor();
    await notice.getByRole('button', { name: '원문 다시 조회', exact: true }).click();
    await notice.getByText('PDF 확보 · 추출 페이지에 연결할 수 없음', { exact: false }).waitFor();
    await page.waitForFunction(() => !document.querySelector('#patent-start').disabled);
    const unverified = page.waitForEvent('download');
    await notice.getByRole('button', { name: '미검증 PDF 다운로드', exact: true }).click();
    const original = await unverified;
    assert.equal((await readFile(await original.path())).toString('utf8'), testPdf());
    await worker.evaluate(() => { globalThis.fixturePanelUnavailable = false; });
    await notice.getByRole('button', { name: '텍스트 추출 재시도', exact: true }).click();
    await notice.getByText('원문과 문서 식별 확인', { exact: false }).waitFor();
    await page.waitForFunction(() => !document.querySelector('#patent-start').disabled);
    const lookup = await worker.evaluate(() => globalThis.fixtureRequests);
    assert.equal(lookup.model, 0);
    assert.equal(lookup.pdf, 2);
    assert.equal(lookup.panel, 1);
    await worker.evaluate(() => { globalThis.fixtureParserUnavailable = false; });
    const source = page.waitForEvent('download');
    await notice.getByRole('button', { name: 'PDF 다운로드', exact: true }).click();
    assert.match((await source).suggestedFilename(), /959999000000001\.pdf$/);
    const denied = await worker.evaluate(() => handleMessage({ type: 'kipris_key_state' },
      { id: chrome.runtime.id, url: 'https://fixture.invalid/', tab: { id: 1 } }));
    assert.equal(denied.type, 'denied');
    const gazetteA = page.getByRole('row').filter({ hasText: pubNumbers[0] });
    const gazetteB = page.getByRole('row').filter({ hasText: pubNumbers[1] });
    await gazetteA.getByRole('button', { name: '텍스트 추출 재시도', exact: true }).click();
    await gazetteA.getByText('원문과 문서 식별 확인', { exact: false }).waitFor();
    await gazetteB.getByRole('button', { name: '원문 다시 조회', exact: true }).click();
    await gazetteB.getByText('원문과 문서 식별 확인', { exact: false }).waitFor();
    for (const [index, row] of [gazetteA, gazetteB].entries()) {
      const event = page.waitForEvent('download');
      await row.getByRole('button', { name: 'PDF 다운로드', exact: true }).click();
      const file = await event;
      assert.ok(file.suggestedFilename().endsWith(pubNumbers[index] + '.pdf'));
      assert.equal((await readFile(await file.path())).toString('utf8'), pubPdfs[index]);
    }
    console.log('PDF matched and downloaded');

    await page.click('#patent-start');
    await page.waitForFunction(() => document.querySelector('#patent-status').textContent.includes('외부 분석을 취소'));
    assert.equal((await worker.evaluate(() => globalThis.fixtureRequests)).model, 0);
    page.removeAllListeners('dialog');
    page.on('dialog', dialog => dialog.accept());
    await page.click('#patent-start');
    await page.waitForFunction(() => document.querySelector('#patent-report').textContent.includes('시험 근거 문장입니다.'));
    const sent = await worker.evaluate(() => globalThis.fixtureRequests);
    assert.ok(sent.model > 0);
    const report = page.waitForEvent('download');
    await page.click('[data-patent-format="json"]');
    assert.match((await report).suggestedFilename(), /1099990000001\.json$/);
    for (const [format, magic] of [['pdf', '%PDF-'], ['hwpx', 'PK']]) {
      const event = page.waitForEvent('download');
      await page.click('[data-patent-format="' + format + '"]');
      const downloaded = await event;
      assert.equal(downloaded.suggestedFilename().split('.').at(-1), format);
      assert.ok((await readFile(await downloaded.path())).subarray(0, magic.length).equals(Buffer.from(magic)));
    }
    await page.reload();
    await page.click('#btn-mode-work');
    await page.waitForFunction(() => document.querySelector('#patent-report').textContent.includes('시험 근거 문장입니다.'));
    await worker.evaluate(async () => {
      globalThis.fixtureParserUnavailable = true;
      globalThis.fixturePanelUnavailable = true;
      await chrome.storage.local.remove(CONFIG.storageKeys.kiprisKey);
    });
    const opinion = page.getByRole('row').filter({ hasText: opinionId });
    const chooser = page.waitForEvent('filechooser');
    await opinion.getByRole('button', { name: 'PDF 첨부', exact: true }).click();
    await (await chooser).setFiles({ name: 'opinion.pdf', mimeType: 'application/pdf', buffer: Buffer.from(opinionPdf) });
    await opinion.getByText('PDF 확보 · 추출 페이지에 연결할 수 없음', { exact: false }).waitFor();
    const beforeRetry = await worker.evaluate(() => globalThis.fixtureRequests.kipris);
    await worker.evaluate(() => { globalThis.fixtureParserUnavailable = false; });
    await opinion.getByRole('button', { name: '텍스트 추출 재시도', exact: true }).click();
    await opinion.getByText('원문과 문서 식별 확인', { exact: false }).waitFor();
    assert.equal(await worker.evaluate(() => globalThis.fixtureRequests.kipris), beforeRetry);
    await page.click('#patent-delete');
    await opinion.waitFor({ state: 'detached' });

    await worker.evaluate(() => chrome.storage.local.set({ [CONFIG.storageKeys.kiprisKey]: 'fixture-kipris' }));
    await page.fill('#patent-application', rotatingApp);
    await page.click('#patent-lookup');
    const rotating = page.getByRole('row').filter({ hasText: '공개공보' });
    await rotating.getByText('PDF 다운로드 경로가 만료됐거나 서버에서 찾을 수 없음').waitFor();
    await rotating.getByRole('button', { name: '원문 다시 조회', exact: true }).click();
    await rotating.getByText('공보 식별자가 일치하는 경로가 없음', { exact: false }).waitFor();
    const oldId = await worker.evaluate(async app => (await PatentStore.get(app)).docs[0].id, rotatingApp);
    await page.click('#patent-lookup');
    await page.waitForFunction(() => document.querySelector('#patent-status').textContent === '조회 완료');
    assert.equal(await rotating.count(), 1);
    const recovered = await worker.evaluate(async app => {
      const record = await PatentStore.get(app);
      return { id: record.docs[0].id, number: record.docs[0].gazetteNumber, state: record.collectionStatus };
    }, rotatingApp);
    assert.notEqual(recovered.id, oldId);
    assert.equal(recovered.number, rotatingNumber);
    assert.equal(recovered.state, 'complete');
    await worker.evaluate(async app => {
      const record = await PatentStore.get(app);
      record.queriedAt = new Date(0).toISOString();
      await PatentStore.save(record);
    }, rotatingApp);
    await page.click('#patent-lookup');
    await page.waitForFunction(async app => {
      const record = await PatentStore.get(app);
      return record?.state === 'complete' && Date.parse(record.queriedAt) > 0
        && document.querySelector('#patent-status').textContent === '조회 완료';
    }, rotatingApp);
    assert.equal(await rotating.count(), 1);
    const finalGazette = await worker.evaluate(async app => {
      const record = await PatentStore.get(app);
      const doc = record.docs[0];
      const fileIds = await new Promise((resolve, reject) => {
        const open = indexedDB.open('dangdang-patent-diagnosis');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction('files').objectStore('files').getAllKeys(IDBKeyRange.bound([app], [app, []]));
          request.onsuccess = () => { db.close(); resolve(request.result.map(([, id]) => id)); };
          request.onerror = () => { db.close(); reject(request.error); };
        };
      });
      return { id: doc.id, state: record.collectionStatus, ticket: globalThis.fixtureRequests.rotating, fileIds };
    }, rotatingApp);
    assert.deepEqual(finalGazette, { id: recovered.id, state: 'complete', ticket: 4, fileIds: [recovered.id] });
    assert.deepEqual(errors, []);
    console.log('Chromium extension smoke passed: legacy migration, settings, code ZIP, PDF extraction, consent, diagnosis, restore, delete.');
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
