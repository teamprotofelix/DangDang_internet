class PatentPanel {
  constructor(panel) {
    this.panel = panel;
    this.input = document.getElementById('patent-application');
    this.status = document.getElementById('patent-status');
    this.list = document.getElementById('patent-docs');
    this.body = document.getElementById('patent-report');
    this.record = null;
    this.selected = '';
    this.request = 0;
    this.refreshTimer = null;
    this.input.oninput = () => {
      this.request++;
      clearTimeout(this.refreshTimer);
      this.selected = '';
      this.render(null);
    };
    this.input.onchange = () => this.restoreInput();
    document.getElementById('patent-lookup').onclick = () => this.start(false);
    document.getElementById('patent-start').onclick = () => this.start(true);
    document.getElementById('patent-cancel').onclick = () =>
      this.caseAction('kipris_cancel', { runId: this.record?.runId });
    document.getElementById('patent-delete').onclick = () => {
      if (confirm('이 출원번호의 원문과 보고서를 삭제할까요?')) this.caseAction('kipris_delete');
    };
    document.getElementById('patent-zip').onclick = () => this.downloadZip();
    document.querySelectorAll('[data-patent-format]').forEach(button =>
      button.onclick = () => this.downloadReport(button.dataset.patentFormat));
    this.fileInput = document.getElementById('patent-attachment');
    this.fileInput.onchange = () => this.attach();
    this.bindKey();
    chrome.storage.local.get('kipris_last_application').then(data => {
      if (!this.input.value && data.kipris_last_application) this.input.value = data.kipris_last_application;
      return this.restoreInput();
    }).catch(() => {});
  }

  async send(type, data) {
    const result = await chrome.runtime.sendMessage({ type, data });
    if (!result || result.type === 'denied') throw new Error('확장 프로그램에서 작업을 실행할 수 없습니다.');
    if (result.error) throw new Error(result.error);
    return result;
  }

  async restoreInput() {
    try {
      const app = Kipris.applicationNumber(this.input.value);
      const ticket = ++this.request;
      clearTimeout(this.refreshTimer);
      this.selected = app;
      await this.refresh(app, ticket);
    } catch { /* An unfinished number is normal while editing. */ }
  }

  async refresh(application, ticket) {
    try {
      const { record } = await this.send('kipris_status', { application });
      if (ticket !== this.request) return;
      this.render(record);
      if (record?.state === 'running') {
        this.refreshTimer = setTimeout(() => this.refresh(application, ticket), 1400);
      }
    } catch (error) {
      if (ticket === this.request) this.status.textContent = error.message;
    }
  }

  async start(diagnose) {
    if (this.starting) return;
    this.starting = true;
    try {
      const application = Kipris.applicationNumber(this.input.value);
      let consent;
      if (diagnose) {
        const config = await StorageManager.getResolvedApiConfig();
        if (!hasApiReady(config)) throw new Error('설정에서 분석에 사용할 LLM을 먼저 연결해 주세요.');
        const url = new URL(chatCompletionURL(config));
        const accepted = confirm(`원문에서 추출한 텍스트와 청구항을 분석을 위해 ${url.origin}의 ${config.model} 모델로 전송합니다. 상품 이용 조건상 전송할 권한이 있는 자료인지 확인해 주세요. 동의하시겠습니까?`);
        if (!accepted) {
          this.status.textContent = '외부 분석을 취소했습니다. 서류 조회와 다운로드는 이용할 수 있습니다.';
          return;
        }
        consent = { model: config.model, apiBase: config.apiBase };
      }
      await this.caseAction('kipris_start', { diagnose, consent }, application);
    } catch (error) { this.status.textContent = error.getUserMessage?.() || error.message; }
    finally { this.starting = false; }
  }

  async caseAction(type, data = {}, value = this.input.value) {
    const ticket = ++this.request;
    clearTimeout(this.refreshTimer);
    try {
      const application = Kipris.applicationNumber(value);
      this.selected = application;
      const { record } = await this.send(type, { application, ...data });
      if (ticket !== this.request) return;
      this.input.value = application;
      await chrome.storage.local.set({ kipris_last_application: application });
      this.render(record);
      if (record?.state === 'running') this.refreshTimer = setTimeout(() => this.refresh(application, ticket), 1400);
    } catch (error) {
      if (ticket !== this.request) return;
      this.status.textContent = error.message;
      if (this.record?.state === 'running') {
        this.refreshTimer = setTimeout(() => this.refresh(this.selected, ticket), 1400);
      }
    }
  }

  render(record) {
    this.record = record;
    const busy = record?.state === 'running';
    this.status.textContent = record?.error || record?.phase
      || (record?.state ? Kipris.messages[record.state] || ({ completed: '진단 완료', failed: '실패' })[record.state] || '' : '');
    for (const id of ['patent-lookup', 'patent-start']) document.getElementById(id).disabled = busy;
    document.getElementById('patent-cancel').disabled = !busy;
    document.getElementById('patent-delete').disabled = !record || busy;
    document.getElementById('patent-zip').disabled = !record?.docs.some(doc => doc.hasFile);
    document.querySelectorAll('[data-patent-format]').forEach(button => { button.disabled = !record?.report; });
    this.body.textContent = record?.report ? PatentDiagnosis.format(record.report) : '';
    this.list.replaceChildren();
    if (!record?.docs.length) return;
    const table = document.createElement('table');
    table.className = 'patent-table';
    const header = table.createTHead().insertRow();
    for (const label of ['서류 · 발송/접수 정보', '원문']) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = label;
      header.append(cell);
    }
    const tbody = table.createTBody();
    for (const doc of record.docs) {
      const row = tbody.insertRow();
      const label = row.insertCell();
      const title = document.createElement('strong');
      title.textContent = doc.title;
      const details = document.createElement('div');
      details.textContent = [doc.date, doc.id, doc.processing].filter(Boolean).join(' · ');
      label.append(title, details);
      const state = row.insertCell();
      state.textContent = (Kipris.messages[doc.status] || doc.status) + (doc.pageCount ? ` · ${doc.pageCount}쪽` : '');
      const actions = document.createElement('div');
      actions.className = 'code-gen-row';
      if (doc.hasFile) {
        actions.append(this.panel.coding.button('열기', () => this.openPdf(doc, record.application, true)),
          this.panel.coding.button('저장', () => this.openPdf(doc, record.application, false)));
      }
      if (!busy && doc.status !== 'verified' && ['APP', 'AM', 'OPINION', 'CORRECTION', 'OA', 'RD', 'RG', 'PUB', 'REG', 'CITATION'].includes(doc.kind)) {
        actions.append(this.panel.coding.button('PDF 첨부', () => {
          this.attachTo = { app: record.application, id: doc.id };
          this.fileInput.click();
        }));
      }
      state.append(actions);
    }
    this.list.append(table);
  }

  pdfName(app, doc) {
    return CodeProjects.filename(`${app}_${doc.title.slice(0, 30)}_${doc.id}.pdf`.replace(/[\\/]/g, '_'), 'pdf');
  }

  async openPdf(doc, app, open) {
    try {
      const bytes = await PatentStore.file(app, doc.id);
      if (!bytes) throw new Error('로컬 원문이 없습니다.');
      const blob = new Blob([bytes], { type: 'application/pdf' });
      if (!open) { FileIO.downloadBlob(blob, this.pdfName(app, doc)); return; }
      const url = URL.createObjectURL(blob);
      try { await chrome.tabs.create({ url }); }
      finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
    } catch (error) { this.status.textContent = error.message; }
  }

  async attach() {
    const file = this.fileInput.files?.[0];
    this.fileInput.value = '';
    const target = this.attachTo;
    if (!file || !target || target.app !== this.selected) return;
    if (file.size > Kipris.maxPdf) { this.status.textContent = '첨부 PDF 최대 크기는 20 MB입니다.'; return; }
    const encoded = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    }).catch(() => null);
    if (!encoded) { this.status.textContent = '첨부 PDF를 읽지 못했습니다.'; return; }
    if (target.app === this.selected) await this.caseAction('kipris_attach', { id: target.id, encoded }, target.app);
  }

  async downloadZip() {
    const record = this.record;
    if (!record) return;
    try {
      const docs = record.docs.filter(doc => doc.hasFile);
      if (docs.reduce((total, doc) => total + doc.size, 0) > 150 * 1024 * 1024) {
        throw new Error('일괄 ZIP은 150 MB까지 지원합니다. 파일별 저장을 사용해 주세요.');
      }
      const entries = [];
      for (const doc of docs) {
        const data = await PatentStore.file(record.application, doc.id);
        if (!data) throw new Error('원문이 삭제되었거나 일부를 찾지 못했습니다.');
        entries.push({ name: this.pdfName(record.application, doc), data });
      }
      if (entries.length) FileIO.downloadBlob(await FileIO.zipStore(entries, 'application/zip'), `${record.application}_원문.zip`);
    } catch (error) { this.status.textContent = error.message; }
  }

  async downloadReport(format) {
    const report = this.record?.report;
    if (!report) return;
    const title = `특허_심사품질_진단_${report.application}`;
    if (format === 'json') {
      FileIO.downloadBlob(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' }), title + '.json');
      return;
    }
    try { await FileIO.exportResult({ format, title, body: PatentDiagnosis.format(report) }); }
    catch { this.status.textContent = '보고서 파일을 생성하지 못했습니다.'; }
  }

  bindKey() {
    const key = document.getElementById('kipris-key');
    const status = document.getElementById('kipris-key-status');
    const action = async (type, data) => {
      try {
        const result = await this.send(type, data);
        if ('configured' in result) status.textContent = result.configured ? '로컬에 키가 저장되어 있습니다.' : '저장된 키가 없습니다.';
        else status.textContent = (Kipris.messages[result.status] || result.status) + ` · 이력 ${result.count}건`;
        if (type === 'kipris_key_set' || type === 'kipris_key_remove') { key.value = ''; key.type = 'password'; }
      } catch (error) { status.textContent = error.message; }
    };
    document.getElementById('kipris-key-visibility').onclick = () => { key.type = key.type === 'password' ? 'text' : 'password'; };
    document.getElementById('kipris-key-save').onclick = () => action('kipris_key_set', { key: key.value });
    document.getElementById('kipris-key-remove').onclick = () => action('kipris_key_remove');
    document.getElementById('kipris-key-test').onclick = () => action('kipris_key_test',
      { application: document.getElementById('kipris-test-application').value || this.input.value });
    action('kipris_key_state');
  }
}
