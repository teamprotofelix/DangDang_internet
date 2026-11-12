class CodingPanel {
  constructor(panel) {
    this.panel = panel;
    this.status = document.getElementById('code-status');
    this.prompt = document.getElementById('code-prompt');
    this.language = document.getElementById('code-language');
    this.chatLanguage = document.getElementById('chat-code-language');
    this.chatMode = document.getElementById('chat-code-enabled');
    this.project = document.getElementById('code-files');
    this.session = CodeProjects.migrate(null);
    const list = document.getElementById('code-languages');
    for (const language of ['auto', ...Object.keys(CodeProjects.languages)]) {
      const option = document.createElement('option');
      option.value = language;
      list.append(option);
    }
    this.chatMode.onchange = () => { this.chatLanguage.hidden = !this.chatMode.checked; };
    document.getElementById('btn-code-gen').onclick = () => this.run(this.prompt.value, this.language.value, false);
    document.getElementById('btn-code-revise').onclick = () => this.run(this.prompt.value, this.language.value, true);
    document.getElementById('btn-code-regen').onclick = () => this.regenerate();
    document.getElementById('btn-code-zip').onclick = () => this.downloadZip();
    document.getElementById('btn-code-cancel').onclick = () => this.controller?.abort();
    this.ready = this.load();
  }

  async load() {
    const key = CONFIG.storageKeys.codeSession;
    try {
      const data = (await chrome.storage.local.get(key))[key];
      this.session = CodeProjects.migrate(data);
      if (data && data.version !== 2) await this.save();
      if (!this.prompt.value) this.prompt.value = this.session.prompt;
      this.language.value = this.chatLanguage.value = this.session.language;
      this.render();
    } catch {
      this.status.textContent = '저장된 프로젝트를 불러오지 못했습니다.';
    }
  }

  save() {
    return chrome.storage.local.set({ [CONFIG.storageKeys.codeSession]: this.session });
  }

  async fromChat() {
    const input = this.panel.messageInput;
    const text = input.value.trim();
    if (!text || this.controller) return;
    await this.ready;
    const output = document.createElement('div');
    output.className = 'message-bubble avatar code-chat-project';
    output.setAttribute('aria-live', 'polite');
    this.panel.renderMessage({ role: 'user', content: text, timestamp: nowISO() });
    this.panel.messagesContainer.append(output);
    input.value = '';
    this.panel.charCount.textContent = '0/100000';
    this.panel.autoResizeInput();
    this.panel.scrollToBottom();
    await this.run(text, this.chatLanguage.value, true, output);
  }

  regenerate(output) {
    const last = this.session.last;
    if (!last) { this.status.textContent = '다시 생성할 요청이 없습니다.'; return; }
    return this.run(last.prompt, last.language, last.revise, output, last.base);
  }

  async run(rawPrompt, rawLanguage, revise, chatOutput = null, regenerationBase = null) {
    await this.ready;
    if (this.controller) return;
    const prompt = rawPrompt.trim();
    const language = rawLanguage.trim().slice(0, 60) || 'auto';
    const write = message => {
      this.status.textContent = message;
      if (chatOutput) chatOutput.textContent = message;
    };
    if (!prompt) { write('무엇을 만들지 입력해 주세요.'); return; }
    const controller = new AbortController();
    this.controller = controller;
    const cancel = document.getElementById('btn-code-cancel');
    const old = this.session.files;
    const base = regenerationBase || (revise ? old : []);
    try {
      const config = await StorageManager.getResolvedApiConfig();
      if (!hasApiReady(config)) { write('설정에서 모델과 API 키를 입력해 주세요.'); return; }
      this.panel.behaviorController?.setBusy('code', true, 'study');
      cancel.disabled = false;
      write('코드를 생성하고 있습니다…');
      if (chatOutput) {
        const stop = document.createElement('button');
        stop.type = 'button';
        stop.className = 'btn-small';
        stop.textContent = '생성 취소';
        stop.onclick = () => controller.abort();
        chatOutput.append(' ', stop);
      }
      const response = await fetch(chrome.runtime.getURL('prompts/codeprompt.txt'), { signal: controller.signal });
      if (!response.ok) throw new Error('코딩 지침을 불러오지 못했습니다.');
      const client = new LLMClient();
      client.applyConfig(config);
      const result = await CodeProjects.generate({ client, config, prompt, language, files: base,
        instruction: await response.text(), signal: controller.signal });
      if (!result.files.length) {
        write('응답에 완성된 코드 블록이 없습니다.');
        const note = document.createElement('pre');
        note.className = 'project-code';
        note.textContent = result.content;
        (chatOutput || this.project).prepend(note);
        return;
      }
      const changed = new Map(result.files.map(file => [file.name.toLowerCase(), file]));
      const unchanged = base.filter(file => !changed.has(file.name.toLowerCase()));
      if (unchanged.some(file => result.files.some(change => CodeProjects.pathsConflict(file.name, change.name)))) {
        throw new Error('새 파일 경로가 기존 파일 또는 폴더 이름과 충돌합니다.');
      }
      this.session = { version: 2, prompt, language, files: [...unchanged, ...result.files],
        last: { prompt, language, revise, base } };
      this.prompt.value = prompt;
      this.language.value = this.chatLanguage.value = language;
      await this.save();
      this.render();
      write(`${this.session.files.length}개 파일을 준비했습니다.`);
      if (chatOutput) {
        for (const file of result.files) chatOutput.append(this.fileCard(file, false));
        const actions = document.createElement('div');
        actions.className = 'code-gen-row';
        actions.append(this.button('프로젝트 ZIP', () => this.downloadZip()),
          this.button('수정 요청', () => this.panel.messageInput.focus()),
          this.button('다시 생성', () => this.regenerate(chatOutput)));
        chatOutput.append(actions);
        this.panel.scrollToBottom();
      }
    } catch (error) {
      write(controller.signal.aborted ? '코드 생성을 취소했습니다.'
        : (error.getUserMessage?.() || error.message || '코드 생성에 실패했습니다.'));
      if (error.partialContent && chatOutput) {
        const pre = document.createElement('pre');
        pre.className = 'project-code';
        pre.textContent = error.partialContent;
        chatOutput.append(pre);
      }
    } finally {
      this.controller = null;
      cancel.disabled = true;
      this.panel.behaviorController?.setBusy('code', false);
    }
  }

  button(label, callback) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'btn-small';
    element.textContent = label;
    element.onclick = callback;
    return element;
  }

  render() {
    this.project.replaceChildren(...this.session.files.map(file => this.fileCard(file, true)));
    document.getElementById('btn-code-zip').disabled = !this.session.files.length;
    document.getElementById('btn-code-regen').disabled = !this.session.last;
  }

  fileCard(file, editable) {
    const card = document.createElement('section');
    card.className = 'code-file-card';
    const title = document.createElement('h4');
    title.textContent = `${file.name} · ${file.language}`;
    const actions = document.createElement('div');
    actions.className = 'code-gen-row';
    actions.append(this.button('복사', async () => {
      try { await navigator.clipboard.writeText(file.content); this.status.textContent = '복사했습니다.'; }
      catch { this.panel.showToast('코드를 선택해 복사해 주세요.', 'info'); }
    }), this.button('파일 다운로드', () => {
      FileIO.downloadBlob(new Blob([file.content], { type: file.mime + ';charset=utf-8' }), file.name.split('/').at(-1));
    }));
    if (editable) {
      const name = document.createElement('input');
      name.className = 'setting-input code-filename';
      name.setAttribute('aria-label', '파일명 ' + file.name);
      name.value = file.name;
      actions.append(name, this.button('파일명 적용', async () => {
        if (this.controller) return;
        const safe = CodeProjects.filename(name.value, file.language);
        if (safe !== name.value || this.session.files.some(item => item !== file && CodeProjects.pathsConflict(item.name, safe))) {
          this.status.textContent = '안전하고 중복되지 않는 파일명을 입력해 주세요.';
          return;
        }
        file.name = safe;
        await this.save();
        this.render();
      }));
    }
    const pre = document.createElement('pre');
    pre.className = 'project-code';
    const code = document.createElement('code');
    code.textContent = file.content;
    pre.append(code);
    card.append(title, actions, pre);
    return card;
  }

  async downloadZip() {
    if (!this.session.files.length) return;
    const entries = this.session.files.map(file => ({ name: file.name, data: file.content }));
    FileIO.downloadBlob(await FileIO.zipStore(entries, 'application/zip'), 'dangdang-project.zip');
  }
}
