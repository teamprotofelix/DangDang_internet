const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = process.env.DANGDANG_PLAYWRIGHT
  ? require(process.env.DANGDANG_PLAYWRIGHT) : require('playwright');

const { app, send, date, testPdf } = require('./pdf-fixture.cjs');

async function main() {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'dangdang-chromium-'));
  const extension = path.resolve(__dirname, '..');
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
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.dismiss());
    await worker.evaluate(({ app, send, date, pdf }) => {
      const fetchOriginal = globalThis.fetch;
      globalThis.fixtureRequests = { kipris: 0, model: 0 };
      globalThis.fetch = async (input, options) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.protocol === 'chrome-extension:') return fetchOriginal(input, options);
        const response = body => new Response('<response><header><resultCode>00</resultCode></header><body>'
          + body + '</body></response>', { headers: { 'content-type': 'application/xml' } });
        if (url.hostname === 'plus.kipris.or.kr') {
          globalThis.fixtureRequests.kipris++;
          if (url.pathname.includes('relatedDocsonfileInfo')) return response('<items><item><applicationNumber>'
            + app + '</applicationNumber><documentNumber>' + send + '</documentNumber><documentDate>'
            + date + '</documentDate><documentTitle>의견제출통지서</documentTitle></item></items>');
          if (url.pathname.includes('IntermediateDocumentOPService')) return response('<pdfInfoV2><applicationNumber>'
            + app + '</applicationNumber><sendNumber>' + send
            + '</sendNumber><filePath>https://plus.kipris.or.kr/fixture.pdf</filePath></pdfInfoV2>');
          if (url.pathname === '/fixture.pdf') return new Response(pdf, { headers: { 'content-type': 'application/pdf' } });
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
    }, { app, send, date, pdf: testPdf() });
    const browserCode = [];
    await page.route('https://api.exaone.ai/v1/chat/completions', async route => {
      const body = route.request().postDataJSON();
      assert.equal(route.request().headers().authorization, 'Bearer fixture-exaone');
      const content = body.messages[0].role === 'user' ? 'OK'
        : 'File: main.py\n```python\nprint("안녕")\n```\nFile: README.md\n```markdown\n사용법\n```';
      if (body.messages.length > 1 && /existingFiles/.test(body.messages[1].content)) browserCode.push(body.messages[1].content);
      return route.fulfill({ json: { choices: [{ message: { content }, finish_reason: 'stop' }] } });
    });
    await page.goto('chrome-extension://' + id + '/sidepanel.html');
    await page.waitForSelector('.pose-interaction-row button');
    assert.equal(await page.locator('#toggle-content-aware').isChecked(), false);
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

    await page.click('#btn-mode-chat');
    await page.check('#chat-code-enabled');
    await page.fill('#message-input', 'Python으로 수정해 주세요');
    await page.click('#btn-send');
    await page.waitForFunction(() => document.querySelectorAll('.code-chat-project code').length === 2);
    assert.match(browserCode[0], /이전 세션/);
    await page.click('#btn-mode-code');
    const zip = page.waitForEvent('download');
    await page.click('#btn-code-zip');
    assert.equal((await zip).suggestedFilename(), 'dangdang-project.zip');

    await page.click('#btn-mode-work');
    await page.fill('#patent-application', '10-9999-0000001');
    await page.click('#patent-lookup');
    await page.waitForFunction(() => document.querySelector('#patent-docs').textContent.includes('원문과 문서 식별 확인'));
    await page.waitForFunction(() => !document.querySelector('#patent-start').disabled);
    assert.equal((await worker.evaluate(() => globalThis.fixtureRequests)).model, 0);
    const source = page.waitForEvent('download');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    assert.match((await source).suggestedFilename(), /959999000000001\.pdf$/);
    const denied = await worker.evaluate(() => handleMessage({ type: 'kipris_key_state' },
      { id: chrome.runtime.id, url: 'https://fixture.invalid/', tab: { id: 1 } }));
    assert.equal(denied.type, 'denied');

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
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#patent-report').textContent.includes('시험 근거 문장입니다.'));
    await page.click('#patent-delete');
    await page.waitForFunction(() => document.querySelector('#patent-report').textContent === '');
    assert.deepEqual(errors, []);
    console.log('Chromium extension smoke passed: legacy migration, settings, code ZIP, PDF extraction, consent, diagnosis, restore, delete.');
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
