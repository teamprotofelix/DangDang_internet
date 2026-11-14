class KiprisPanel {
  constructor(panel) {
    this.panel = panel;
    this.input = document.getElementById('patent-application');
    this.status = document.getElementById('patent-status');
    this.list = document.getElementById('patent-docs');
    this.historyStatus = document.getElementById('patent-history-status');
    this.recent = document.getElementById('kipris-recent');
    this.lookup = document.getElementById('patent-lookup');
    this.cancel = document.getElementById('patent-cancel');
    this.zip = document.getElementById('patent-zip');
    this.clearOne = document.getElementById('patent-delete');
    this.clearAll = document.getElementById('kipris-clear-all');
    this.state = { recent: [], result: null };
    this.lookup.onclick = () => this.run('lookup');
    this.input.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) this.run('lookup'); };
    this.input.oninput = () => { this.status.textContent = ''; this.failureList([]); this.render(); };
    this.recent.onchange = () => {
      this.input.value = this.recent.value;
      this.render();
    };
    this.cancel.onclick = () => this.abort();
    this.zip.onclick = () => this.run('zip');
    this.clearOne.onclick = () => this.clear(false);
    this.clearAll.onclick = () => this.clear(true);
    this.bindKey();
    this.render();
    this.ready = this.restore();
    chrome.storage.onChanged.addListener((changes, area) => {
      const change = changes[Kipris.searchKey];
      if (area !== 'local' || !change) return;
      this.applySearch(change.newValue, change.oldValue);
    });
  }

  async send(type, data) {
    const result = await chrome.runtime.sendMessage({ type, data });
    if (!result || result.type === 'denied') throw new Error('확장 프로그램에서 작업을 실행할 수 없습니다.');
    if (result.error) throw new Error(result.error);
    return result;
  }

  async restore() {
    try {
      const state = await this.send('kipris_restore');
      if (this.changed) return;
      this.state = state;
      if (!this.input.value) this.input.value = state.result?.app || state.legacy || '';
      this.render();
    } catch (error) { this.status.textContent = error.message; }
  }

  applySearch(state, previous) {
    this.changed = true;
    this.state = state || { recent: [], result: null };
    if (state?.clearId !== previous?.clearId && state?.clearedApp !== undefined) {
      const removed = state.clearedApp;
      if (!removed || removed === this.job?.app) this.abort();
      if (!removed || removed === this.app()) {
        this.input.value = '';
        this.status.textContent = '';
        this.failureList([]);
      }
    }
    this.render();
  }

  app() {
    try { return Kipris.applicationNumber(this.input.value); }
    catch { return ''; }
  }

  abort() {
    if (!this.job) return;
    this.job.cancelled = true;
    this.status.textContent = '작업을 취소했습니다.';
    this.send('kipris_cancel', { requestId: this.job.id }).catch(() => {});
  }

  render() {
    const app = this.app();
    const result = this.state.result?.app === app ? this.state.result : null;
    const busy = !!this.job || this.clearing;
    this.lookup.disabled = busy;
    this.cancel.disabled = !this.job || this.job.cancelled;
    this.zip.disabled = busy || !result?.docs.some(Kipris.canDownload);
    this.zip.hidden = !result;
    this.clearOne.disabled = !app || this.clearing;
    this.clearAll.disabled = this.clearing;
    this.recent.replaceChildren(new Option('최근 조회 선택', ''), ...this.state.recent.map(item => new Option(item, item)));
    this.recent.value = this.state.recent.includes(app) ? app : '';
    this.historyStatus.textContent = result ? ['이력 · ' + Kipris.messages[result.historyStatus],
      ...result.warnings.map(({ title, status }) => title + ' · ' + Kipris.messages[status])].join(' / ') : '';
    this.list.replaceChildren();
    if (!result?.docs.length) return;
    const table = document.createElement('table');
    table.className = 'patent-table';
    const header = table.createTHead().insertRow();
    for (const text of ['서류 · 식별자', '원문']) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = text;
      header.append(th);
    }
    const tbody = table.createTBody();
    for (const doc of result.docs) {
      const row = tbody.insertRow();
      const details = row.insertCell();
      const title = document.createElement('strong');
      title.textContent = doc.title;
      const meta = document.createElement('div');
      const identifier = doc.gazetteNumber || (Kipris.isGazette(doc.kind) ? '공보번호 미표시' : doc.id);
      meta.textContent = [doc.date, identifier, Kipris.validTrialNumber(doc.trialNumber) && '심판번호 ' + doc.trialNumber,
        doc.processing].filter(Boolean).join(' · ');
      details.append(title, meta);
      const state = row.insertCell();
      state.textContent = Kipris.messages[doc.status];
      if (Kipris.canDownload(doc)) {
        const button = this.panel.coding.button('PDF 다운로드', () => this.run('pdf', doc));
        button.disabled = busy;
        state.append(document.createElement('br'), button);
      }
    }
    this.list.append(table);
  }

  filename(app, doc) {
    const title = Array.from(doc.title.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')).slice(0, 30).join('');
    const id = encodeURIComponent(doc.id).replace(/[%!'()*]/g, '_').slice(0, 100);
    return app + '_' + title + '_' + id + '.pdf';
  }

  failureList(failures) {
    const list = document.getElementById('kipris-download-failures');
    list.replaceChildren(...failures.map(({ doc, message }) => {
      const li = document.createElement('li');
      li.textContent = doc.title + ' (' + (doc.gazetteNumber || doc.id) + ') · ' + message;
      return li;
    }));
  }

  async run(type, doc) {
    await this.ready;
    if (this.job || this.clearing) return;
    const app = this.app();
    if (!app) { this.status.textContent = Kipris.messages.invalid_number; return; }
    const job = { id: crypto.randomUUID(), app };
    this.job = job;
    this.failureList([]);
    this.render();
    try {
      if (type === 'lookup') {
        this.status.textContent = '서류 조회 중…';
        const { result } = await this.send('kipris_lookup', { application: app, requestId: job.id });
        if (!job.cancelled && this.app() === app) {
          this.status.textContent = '서류 ' + result.docs.length + '건';
        }
      } else {
        await navigator.locks.request('dangdang-kipris-download', { ifAvailable: true }, async lock => {
          if (!lock) throw new Error(Kipris.messages.busy);
          const result = this.state.result;
          if (result?.app !== app || job.cancelled) return;
          if (type === 'pdf') {
            this.status.textContent = '원문 다운로드 중…';
            const bytes = await this.getPdf(job, doc);
            if (job.cancelled) return;
            FileIO.downloadBlob(new Blob([bytes], { type: 'application/pdf' }), this.filename(app, doc));
            this.status.textContent = 'PDF 다운로드를 시작했습니다.';
          } else {
            await this.downloadZip(job, result.docs.filter(Kipris.canDownload));
          }
        });
      }
    } catch (error) {
      if (!job.cancelled) this.status.textContent = error.message;
    } finally {
      if (this.job === job) this.job = null;
      this.render();
    }
  }

  async getPdf(job, doc) {
    const reply = await this.send('kipris_download', { application: job.app, documentId: doc.id, requestId: job.id });
    return Uint8Array.from(atob(reply.pdf), char => char.charCodeAt(0));
  }

  async downloadZip(job, docs) {
    const entries = [];
    const failures = [];
    const names = new Set();
    const maximum = 100 * 1024 * 1024;
    let size = 0;
    for (const [index, doc] of docs.entries()) {
      if (job.cancelled) return;
      this.status.textContent = 'ZIP 원문 다운로드 중… ' + (index + 1) + '/' + docs.length;
      try {
        const data = await this.getPdf(job, doc);
        if (job.cancelled) return;
        if (size + data.length > maximum) throw new Error('ZIP의 원문 한도 100 MB를 초과합니다.');
        const filename = this.filename(job.app, doc);
        let name = filename;
        for (let i = 2; names.has(name.toLowerCase()); i++) name = filename.replace(/\.pdf$/, '_' + i + '.pdf');
        names.add(name.toLowerCase());
        entries.push({ name, data });
        size += data.length;
      } catch (error) { failures.push({ doc, message: error.message }); }
    }
    if (job.cancelled) return;
    if (entries.length) {
      const zip = await FileIO.zipStore(entries, 'application/zip');
      if (job.cancelled) return;
      FileIO.downloadBlob(zip, job.app + '_KIPRIS.zip');
    }
    this.failureList(failures);
    this.status.textContent = (entries.length ? (failures.length ? '부분 ZIP 다운로드' : '전체 ZIP 다운로드')
      : 'ZIP에 담을 수 있는 PDF가 없습니다.') + ' · 성공 ' + entries.length + '건 · 실패 ' + failures.length + '건';
  }

  async clear(all) {
    await this.ready;
    if (this.clearing) return;
    const app = this.app();
    if (!all && !app) return;
    const scope = all ? '모든 KIPRIS 조회 기록과 결과, 이전 진단 원문·보고서를' : app + '의 조회 기록과 결과, 이전 진단 원문·보고서를';
    if (!confirm(scope + ' 지울까요? 다운로드 폴더의 파일과 API 키·설정은 보존됩니다.')) return;
    this.clearing = true;
    this.abort();
    this.render();
    try {
      this.state = await this.send(all ? 'kipris_clear_all' : 'kipris_clear', { application: app });
      this.input.value = '';
      this.failureList([]);
      this.status.textContent = all ? '검색 기록 전체를 지웠습니다.' : '이 출원의 조회 기록을 지웠습니다.';
    } catch (error) { this.status.textContent = error.message; }
    finally { this.clearing = false; this.render(); }
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
