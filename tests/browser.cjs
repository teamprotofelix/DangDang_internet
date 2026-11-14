const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = process.env.DANGDANG_PLAYWRIGHT
  ? require(process.env.DANGDANG_PLAYWRIGHT) : require('playwright');

const { app, send, date, testPdf } = require('./pdf-fixture.cjs');
const pubNumbers = ['1099990000011', '1099990000012'];
const pubPdfs = pubNumbers.map(number => testPdf(['공개특허공보', '출원번호 ' + app, '공개번호 ' + number]));
const trial = '2099100000123';
const trialPdf = testPdf(['심결문', '사건 2099당123', '2099.01.09']);

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
    await worker.evaluate(({ app, send, date, pdf, pubNumbers, pubPdfs, trial, trialPdf }) => {
      const realFetch = globalThis.fetch;
      const historyRow = (number, title, extra = '') => '<item><applicationNumber>' + app
        + '</applicationNumber><documentNumber>' + number + '</documentNumber><documentTitle>' + title
        + '</documentTitle><documentDate>' + date + '</documentDate>' + extra + '</item>';
      const itemPath = (number, suffix) => '<item><publicationNumber>' + number
        + '</publicationNumber><path>https://plus.kipris.or.kr/fixture-' + suffix + '.pdf</path></item>';
      const xml = body => new Response('<response><header><resultCode>00</resultCode></header><body>'
        + body + '</body></response>');
      globalThis.fixture = { pdfs: [], gazette: 0, notice: 0, mode: 'normal' };
      globalThis.fetch = async (input, options) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.hostname !== 'plus.kipris.or.kr') return realFetch(input, options);
        const fixture = globalThis.fixture;
        if (url.pathname.includes('relatedDocsonfileInfo')) {
          if (fixture.hold) {
            fixture.waiting = true;
            await new Promise(resolve => { fixture.release = resolve; });
            fixture.hold = false;
          }
          return xml('<items>' + historyRow(send, '의견제출통지서')
            + historyRow('959999000000002', '특허등록결정서') + historyRow('119999000000003', '의견서')
            + historyRow('119999000000005', '권리범위확인심결(특실의)', '<step>심판</step><trialNumber>' + trial + '</trialNumber>')
            + '</items>');
        }
        if (url.pathname.includes('IntermediateDocumentOPService')) {
          const requested = url.searchParams.get('sendNumber');
          if (requested && requested !== send) throw new Error('Unexpected dispatch number');
          if (requested && fixture.mode === 'foreign') return xml('<items><item><applicationNumber>1099990000090</applicationNumber>'
            + '<sendNumber>' + send + '</sendNumber><filePath>/fixture-notice.pdf</filePath></item></items>');
          const ticket = requested ? ++fixture.notice : 0;
          return xml('<items><item><applicationNumber>' + app + '</applicationNumber><sendNumber>' + send
            + '</sendNumber><filePath>/fixture-notice.pdf?ticket=' + ticket + '</filePath></item></items>');
        }
        if (url.pathname.includes('IntermediateDocumentRGService')) {
          if (!fixture.allowRegistration) return new Response(null, { status: 403 });
          return xml('<items><item><sendNumber>959999000000002</sendNumber><filePath>/fixture-reg.pdf</filePath></item></items>');
        }
        if (url.pathname.includes('getPubFullTextInfoSearch')) {
          const turn = ++fixture.gazette;
          const order = turn % 2 === 1 ? [0, 1] : [1, 0];
          return xml('<items>' + order.map(i => itemPath(pubNumbers[i], i + '-' + turn)).join('') + '</items>');
        }
        if (url.pathname.includes('getJudDocumentInfoSearch')) {
          if (url.searchParams.get('trialNumber') !== trial || url.searchParams.has('applicationNumber'))
            throw new Error('Unexpected trial number');
          return xml('<item><fileName>' + trial + '.pdf</fileName><openYN>Y</openYN><path>/fixture-trial.pdf</path></item>');
        }
        if (url.pathname.includes('trialBibliographicSummaryInfo')) {
          if (url.searchParams.get('TrialNumber') !== trial) throw new Error('Unexpected trial number');
          return xml('<items><trialBibliographicSummaryInfo><ApplicationNumber>' + app
            + '</ApplicationNumber><TrialNumber>' + trial + '</TrialNumber></trialBibliographicSummaryInfo></items>');
        }
        if (!url.pathname.endsWith('.pdf')) return xml('<items/>');
        fixture.pdfs.push(url.pathname + url.search);
        if (fixture.mode === 'zero') return new Response('<html>error</html>');
        if (url.pathname === '/fixture-trial.pdf') return new Response(trialPdf);
        if (url.pathname === '/fixture-reg.pdf') return new Response(pdf);
        if (url.pathname === '/fixture-notice.pdf') {
          return url.searchParams.get('ticket') === '1' ? new Response(null, { status: 410 }) : new Response(pdf);
        }
        const index = Number(url.pathname.match(/fixture-(\d)-/)?.[1]);
        return new Response(fixture.mode === 'partial' && index === 1 ? 'not a PDF' : pubPdfs[index]);
      };
      return chrome.storage.local.set({
        last_app_mode: 'work',
        settings: { onboardingDismissed: true },
        code_session: { prompt: '레거시', html: '<p>이전 세션</p>' }
      });
    }, { app, send, date, pdf: testPdf(), pubNumbers, pubPdfs, trial, trialPdf });
    const browserCode = [];
    let delayed;
    let releaseDelayed;
    const held = new Promise(resolve => { releaseDelayed = resolve; });
    const requestedDelay = new Promise(resolve => { delayed = resolve; });
    let startReset;
    let releaseReset;
    const resetStarted = new Promise(resolve => { startReset = resolve; });
    const resetHeld = new Promise(resolve => { releaseReset = resolve; });
    await page.route('https://api.exaone.ai/v1/chat/completions', async route => {
      const body = route.request().postDataJSON();
      assert.equal(route.request().headers().authorization, 'Bearer fixture-exaone');
      const ordinary = body.messages.at(-1).content === '일반 대화 회귀';
      const coding = body.messages.length > 1 && /existingFiles/.test(body.messages[1].content)
        ? JSON.parse(body.messages[1].content) : null;
      if (coding?.request === '늦은 코드') {
        delayed();
        await held;
      }
      if (coding?.request === '초기화 중 늦은 코드') { startReset(); await resetHeld; }
      if (coding && !body.stream) browserCode.push(coding);
      if (coding?.request === '모델 오류') return route.fulfill({ status: 400, json: { error: { message: 'fixture' } } });
      const content = coding?.request === '잘못된 결과' ? '코드 블록 없음'
        : coding?.request === '새 웹 프로젝트' ? 'File: 화면/index.html\n```html\n<p>새 프로젝트</p>\n```\nFile: 화면/app.js\n```javascript\nconsole.log("웹");\n```'
        : ordinary ? JSON.stringify({ mood: 'smile', message: '대화 응답 확인' })
        : body.messages[0].role === 'user' ? 'OK'
        : coding?.request === '두 번째 파일을 추가해 주세요' ? 'File: second.py\n```python\nprint("second")\n```'
        : 'File: main.py\n```python\nprint("안녕")\n```\nFile: README.md\n```markdown\n사용법\n```';
      try { await route.fulfill({ json: { choices: [{ message: { content }, finish_reason: 'stop' }] } }); }
      catch (error) { if (!['늦은 코드', '초기화 중 늦은 코드'].includes(coding?.request)) throw error; }
    });
    await page.goto('chrome-extension://' + id + '/sidepanel.html');
    await page.locator('#btn-pet').waitFor({ state: 'attached' });
    await page.locator('#btn-mode-work[aria-selected="true"]').waitFor();
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
    assert.equal(await page.locator('#chat-code-language').isVisible(), false);
    assert.equal(await page.locator('#chat-file-input').count(), 1);
    await page.check('#chat-code-enabled');
    await page.locator('#chat-code-language').click();
    await page.locator('#chat-code-language').press('p');
    await page.locator('#chat-code-language').press('Enter');
    await page.selectOption('#chat-code-language', 'python');
    await page.fill('#message-input', 'Python으로 수정해 주세요');
    await page.click('#btn-send');
    await page.locator('.code-chat-project').first().getByText('3개 파일을 준비했습니다.').waitFor();
    const firstRequest = browserCode.find(request => request.request === 'Python으로 수정해 주세요');
    assert.match(firstRequest.existingFiles[0].content, /이전 세션/);
    assert.equal(firstRequest.language, 'python');
    await page.selectOption('#chat-code-language', '__custom__');
    await page.click('#btn-send');
    await page.locator('#chat-code-status').getByText('무엇을 만들지 입력해 주세요.').waitFor();
    await page.fill('#message-input', '직접 입력 누락');
    await page.click('#btn-send');
    await page.locator('#chat-code-status').getByText('직접 입력할 언어 이름을 입력해 주세요.').waitFor();
    await page.fill('#chat-code-language-custom', 'Elixir');
    await page.fill('#message-input', '두 번째 파일을 추가해 주세요');
    await page.click('#btn-send');
    await page.locator('.code-chat-project').nth(1).getByText('4개 파일을 준비했습니다.').waitFor();
    assert.equal(browserCode.at(-1).language, 'Elixir');
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

    await page.locator('#code-language').click();
    await page.locator('#code-language').press('Home');
    await page.locator('#code-language').press('ArrowDown');
    await page.locator('#code-language').press('Enter');
    await page.selectOption('#code-language', 'html');
    await page.fill('#code-prompt', '새 웹 프로젝트');
    await page.click('#btn-code-gen');
    await page.locator('#code-status').getByText('2개 파일을 준비했습니다.').waitFor();
    assert.deepEqual(browserCode.at(-1), { request: '새 웹 프로젝트', language: 'html', existingFiles: [] });
    assert.deepEqual(await downloadNames(page.locator('#btn-code-zip')), ['화면/app.js', '화면/index.html']);
    await page.selectOption('#code-file-picker', '화면/app.js');
    assert.match(await page.locator('#code-files code').textContent(), /console.log/);
    const javascript = page.waitForEvent('download');
    await page.locator('#code-files').getByRole('button', { name: '파일 다운로드' }).click();
    const sourceFile = await javascript;
    assert.equal(sourceFile.suggestedFilename(), 'app.js');
    assert.equal(await readFile(await sourceFile.path(), 'utf8'), 'console.log("웹");');

    await page.selectOption('#code-language', 'javascript');
    await page.fill('#code-prompt', '늦은 코드');
    await page.click('#btn-code-revise');
    await Promise.race([requestedDelay, page.locator('#code-status').getByText(/오류|실패|취소/).waitFor()]);
    await page.click('#btn-mode-chat');
    await page.fill('#message-input', '중복 요청');
    await page.click('#btn-send');
    await page.locator('#chat-code-status').getByText('코드 생성이 진행 중입니다.').waitFor();
    assert.equal(await page.inputValue('#message-input'), '중복 요청');
    await page.click('#btn-mode-code');
    await page.click('#btn-code-cancel');
    releaseDelayed();
    await page.locator('#code-status').getByText('코드 생성을 취소했습니다.').waitFor();
    for (const [prompt, expected] of [
      ['잘못된 결과', '응답에 완성된 코드 블록이 없습니다.'],
      ['모델 오류', /오류|실패|400|요청/]
    ]) {
      await page.fill('#code-prompt', prompt);
      await page.click('#btn-code-revise');
      await page.locator('#code-status').getByText(expected).waitFor();
      await page.waitForFunction(() => document.querySelector('#btn-code-cancel').disabled);
      assert.deepEqual(browserCode.at(-1).existingFiles.map(file => file.name).sort(), ['화면/app.js', '화면/index.html']);
    }

    await page.evaluate(() => {
      const store = chrome.storage.local.set.bind(chrome.storage.local);
      chrome.storage.local.set = data => Object.hasOwn(data, 'code_session') ? Promise.reject(new Error('fixture')) : store(data);
    });
    await page.fill('#code-prompt', '저장 실패');
    await page.click('#btn-code-gen');
    await page.locator('#code-status').getByText('프로젝트를 저장하지 못했습니다.', { exact: false }).waitFor();
    assert.deepEqual(await downloadNames(page.locator('#btn-code-zip')), ['화면/app.js', '화면/index.html']);
    await page.reload();
    await page.locator('#btn-mode-code[aria-selected="true"]').waitFor();
    assert.equal(await page.inputValue('#code-language'), 'javascript');
    assert.deepEqual(await downloadNames(page.locator('#btn-code-zip')), ['화면/app.js', '화면/index.html']);
    await page.click('#btn-mode-chat');
    await page.locator('#chat-code-language-custom').waitFor();
    assert.equal(await page.inputValue('#chat-code-language-custom'), 'Elixir');
    await page.uncheck('#chat-code-enabled');
    assert.equal(await page.locator('#chat-code-language').isVisible(), false);
    assert.equal(await page.locator('#chat-code-language-custom').isVisible(), false);
    await page.fill('#message-input', '일반 대화 회귀');
    await page.click('#btn-send');
    await page.waitForFunction(() => document.querySelector('#message-input').value === '');
    assert.ok(!browserCode.some(request => request.request === '중복 요청' || request.request === '일반 대화 회귀'));
    console.log('Coding project downloaded and recovered');


    const secondPanel = await context.newPage();
    await secondPanel.goto(page.url());
    await secondPanel.click('#btn-mode-code');
    await secondPanel.waitForSelector('#code-files code');
    await page.click('#btn-mode-code');
    await page.evaluate(() => {
      const remove = chrome.storage.local.remove.bind(chrome.storage.local);
      chrome.storage.local.remove = key => key === 'code_session' ? Promise.reject(new Error('test remove failure')) : remove(key);
    });
    const accept = dialog => dialog.accept();
    page.removeAllListeners('dialog');
    page.on('dialog', accept);
    await page.click('#btn-code-reset');
    await page.getByText('저장된 프로젝트를 지우지 못했습니다.').waitFor();
    assert.ok(await page.locator('#code-files code').count());
    await page.reload();
    await page.locator('#btn-mode-code[aria-selected="true"]').waitFor();
    await page.fill('#code-prompt', '초기화 중 늦은 코드');
    await page.click('#btn-code-revise');
    await Promise.race([resetStarted, page.locator('#code-status').getByText(/오류|실패/).waitFor()]);
    secondPanel.on('dialog', accept);
    await secondPanel.click('#btn-code-reset');
    await secondPanel.getByText('프로젝트를 초기화했습니다.').waitFor();
    releaseReset();
    await page.waitForFunction(() => !document.querySelector('#code-prompt').value && !document.querySelector('#code-files code'));
    assert.ok(!(await worker.evaluate(() => chrome.storage.local.get('code_session'))).code_session);
    await page.reload();
    await page.locator('#btn-mode-code[aria-selected="true"]').waitFor();
    assert.equal(await page.inputValue('#code-language'), 'javascript');
    assert.equal(await page.inputValue('#code-prompt'), '');
    assert.equal(await page.locator('#btn-code-regen').isDisabled(), true);
    await page.fill('#code-prompt', '새 웹 프로젝트');
    await page.click('#btn-code-gen');
    assert.deepEqual(await downloadNames(page.locator('#btn-code-zip')), ['화면/app.js', '화면/index.html']);
    await secondPanel.close();

    // Create only legacy rows to verify update preservation and both explicit removal scopes.
    const legacyOther = '1099990000009';
    const legacy = (write = false) => worker.evaluate(async ({ app, legacyOther, write }) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('dangdang-patent-diagnosis', 2);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('cases');
          request.result.createObjectStore('files');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(['cases', 'files'], write ? 'readwrite' : 'readonly');
          const cases = tx.objectStore('cases');
          const files = tx.objectStore('files');
          if (write) for (const id of [app, legacyOther]) {
            cases.put({ report: 'legacy' }, id);
            files.put(new Uint8Array([1, 2, 3]), [id, 'legacy']);
          }
          const keys = cases.getAllKeys();
          const fileKeys = files.getAllKeys();
          tx.oncomplete = () => resolve([keys.result, fileKeys.result]);
          tx.onabort = () => reject(tx.error);
        });
      } finally { db.close(); }
    }, { app, legacyOther, write });
    const before = await legacy(true);
    await page.click('#btn-mode-work');
    assert.equal((await page.locator('#btn-mode-work').textContent()).trim(), 'KIPRIS');
    assert.equal(await page.locator('#patent-start, #patent-report, [data-patent-format], #patent-attachment').count(), 0);
    await page.fill('#patent-application', app);
    await page.click('#patent-lookup');
    await page.getByText('서류 6건', { exact: true }).waitFor();
    assert.deepEqual(await worker.evaluate(() => globalThis.fixture.pdfs), []);
    const notice = page.getByRole('row').filter({ hasText: send });
    const opinion = page.getByRole('row').filter({ hasText: '119999000000003' });
    const denied = page.getByRole('row').filter({ hasText: '959999000000002' });
    assert.match(await opinion.textContent(), /원문 PDF 미제공/);
    assert.match(await denied.textContent(), /해당 상품 이용 권한 필요/);
    const readDownload = async button => {
      const event = page.waitForEvent('download');
      await button.click();
      const download = await event;
      return { name: download.suggestedFilename(), bytes: await readFile(await download.path()) };
    };
    const noticeButton = notice.getByRole('button', { name: 'PDF 다운로드' });
    const download = await readDownload(noticeButton);
    assert.equal(download.name, app + '_의견제출통지서_' + send + '.pdf');
    assert.equal(download.bytes.toString(), testPdf());
    assert.deepEqual(await worker.evaluate(() => globalThis.fixture.pdfs),
      ['/fixture-notice.pdf?ticket=1', '/fixture-notice.pdf?ticket=2']);
    const firstGazette = page.getByRole('row').filter({ hasText: pubNumbers[0] });
    assert.equal((await readDownload(firstGazette.getByRole('button', { name: 'PDF 다운로드' }))).bytes.toString(), pubPdfs[0]);

    const downloads = [];
    page.on('download', event => downloads.push(event.suggestedFilename()));
    await worker.evaluate(() => { globalThis.fixture.mode = 'foreign'; });
    await noticeButton.click();
    await page.getByText('PDF의 문서 식별자를 확인하지 못했거나 응답이 불일치함', { exact: true }).waitFor();
    assert.equal(downloads.length, 0);
    await worker.evaluate(() => { globalThis.fixture.mode = 'normal'; });
    const zipButton = page.locator('#patent-zip');
    const complete = await readDownload(zipButton);
    await page.getByText('부분 ZIP 다운로드 · 성공 4건 · 실패 1건').waitFor();
    assert.equal(complete.name, app + '_KIPRIS.zip');
    const zipFiles = async data => {
      const { inflateRawSync } = require('node:zlib');
      const files = {};
      for (let pos = 0; data.readUInt32LE(pos) === 0x04034b50;) {
        const size = data.readUInt32LE(pos + 18);
        const nameSize = data.readUInt16LE(pos + 26);
        const body = pos + 30 + nameSize + data.readUInt16LE(pos + 28);
        const name = data.subarray(pos + 30, pos + 30 + nameSize).toString();
        assert.ok(!Object.hasOwn(files, name));
        files[name] = (data.readUInt16LE(pos + 8) ? inflateRawSync(data.subarray(body, body + size))
          : data.subarray(body, body + size)).toString();
        pos = body + size;
      }
      return files;
    };
    const entries = await zipFiles(complete.bytes);
    assert.deepEqual(Object.values(entries).sort(), [testPdf(), ...pubPdfs, trialPdf].sort());
    assert.match(await page.locator('#kipris-download-failures').textContent(), /상품 이용 권한 필요/);

    await worker.evaluate(() => { globalThis.fixture.mode = 'partial'; globalThis.fixture.allowRegistration = true; });
    await page.click('#patent-lookup');
    await denied.getByText('원문 PDF 제공').waitFor();
    const partial = await readDownload(zipButton);
    await page.getByText('부분 ZIP 다운로드 · 성공 4건 · 실패 1건').waitFor();
    assert.equal(Object.keys(await zipFiles(partial.bytes)).length, 4);
    assert.match(await page.locator('#kipris-download-failures').textContent(), /PDF 파일 서명/);
    await worker.evaluate(() => { globalThis.fixture.mode = 'normal'; });
    const full = await readDownload(zipButton);
    await page.getByText('전체 ZIP 다운로드 · 성공 5건 · 실패 0건').waitFor();
    assert.equal(Object.keys(await zipFiles(full.bytes)).length, 5);
    await worker.evaluate(() => { globalThis.fixture.mode = 'zero'; });
    const beforeEmpty = downloads.length;
    await zipButton.click();
    await page.getByText('ZIP에 담을 수 있는 PDF가 없습니다. · 성공 0건 · 실패 5건').waitFor();
    assert.equal(downloads.length, beforeEmpty);
    assert.deepEqual(await legacy(), before);
    const saved = await worker.evaluate(() => chrome.storage.local.get('kipris_download_search'));
    assert.ok(!/fixture-|%PDF|signed|JVBER/.test(JSON.stringify(saved)));

    await page.reload();
    await page.locator('#btn-mode-work[aria-selected="true"]').waitFor();
    await notice.waitFor();
    assert.equal(await page.inputValue('#patent-application'), app);
    await worker.evaluate(() => { globalThis.fixture.mode = 'normal'; globalThis.fixture.hold = true; });
    await page.click('#patent-lookup');
    await page.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: 'kipris_restore' })).result?.docs.length === 6);
    for (let i = 0; i < 100 && !await worker.evaluate(() => globalThis.fixture.waiting); i++) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(await worker.evaluate(() => globalThis.fixture.waiting), true);
    await page.click('#patent-delete');
    await page.getByText('이 출원의 조회 기록을 지웠습니다.').waitFor();
    await worker.evaluate(() => globalThis.fixture.release());
    await page.waitForFunction(() => !document.querySelector('#patent-lookup').disabled);
    await page.reload();
    await page.locator('#btn-mode-work[aria-selected="true"]').waitFor();
    assert.equal(await page.inputValue('#patent-application'), '');
    assert.equal(await page.locator('#patent-docs tr').count(), 0);
    assert.deepEqual(await legacy(), [[legacyOther], [[legacyOther, 'legacy']]]);
    await page.click('#kipris-clear-all');
    await page.getByText('검색 기록 전체를 지웠습니다.').waitFor();
    assert.deepEqual(await legacy(), [[], []]);
    const after = await worker.evaluate(() => chrome.storage.local.get(['kipris_plus_key', 'api_settings', 'kipris_download_search']));
    assert.equal(after.kipris_plus_key, 'fixture-kipris');
    assert.equal(after.api_settings.model, 'k-exaone_v2.5');
    assert.deepEqual(after.kipris_download_search.recent, []);
    assert.equal(after.kipris_download_search.result, null);
    assert.deepEqual(errors, []);
    console.log('Chromium installed extension passed KIPRIS downloads, data deletion and cross-panel code reset.');
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
