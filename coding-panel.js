class CodingPanel {
  constructor(panel) {
    this.panel = panel;
    this.status = document.getElementById('chat-code-status');
    this.chatLanguage = document.getElementById('chat-code-language');
    this.customLanguage = document.getElementById('chat-code-custom-language');
    this.chatMode = document.getElementById('chat-code-enabled');
    this.projectArea = document.getElementById('chat-code-project');
    this.project = document.getElementById('chat-code-files');
    this.cancel = document.getElementById('chat-code-cancel');
    this.newProject = document.getElementById('chat-code-new');
    this.session = CodeProjects.migrate(null);
    const labels = { javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python' };
    for (const language of Object.keys(CodeProjects.languages)) {
      this.chatLanguage.add(new Option(labels[language] || language.toUpperCase(), language));
    }
    this.customOption = new Option('직접 입력', '__custom__');
    this.chatLanguage.add(this.customOption);
    this.chatMode.onchange = () => this.showControls();
    this.chatLanguage.onchange = () => {
      this.showControls();
      if (!this.customLanguage.hidden) this.customLanguage.focus();
    };
    this.newProject.onclick = () => {
      const pending = this.newProject.getAttribute('aria-pressed') === 'true';
      this.newProject.setAttribute('aria-pressed', String(!pending));
      this.status.textContent = pending ? '' : '다음 요청은 빈 프로젝트에서 시작합니다.';
      this.panel.messageInput.focus();
    };
    document.getElementById('chat-code-regen').onclick = () => this.regenerate();
    document.getElementById('chat-code-zip').onclick = () => this.downloadZip();
    this.cancel.onclick = () => this.controller?.abort();
    this.ready = this.load();
  }

  async load() {
    const key = CONFIG.storageKeys.codeSession;
    try {
      const data = (await chrome.storage.local.get(key))[key];
      this.session = CodeProjects.migrate(data);
      if (data && data.version !== 2) await this.save();
      const language = this.session.language || 'auto';
      const known = language === 'auto' || Object.hasOwn(CodeProjects.languages, language);
      this.chatLanguage.value = known ? language : this.customOption.value;
      this.customLanguage.value = known ? '' : language;
      this.render();
    } catch {
      this.status.textContent = '저장된 프로젝트를 불러오지 못했습니다.';
    } finally { this.showControls(); }
  }

  showControls() {
    this.chatLanguage.hidden = !this.chatMode.checked;
    this.customLanguage.hidden = this.chatLanguage.hidden || this.chatLanguage.value !== this.customOption.value;
    this.projectArea.hidden = !this.chatMode.checked && !this.session.files.length;
  }

  save() {
    return chrome.storage.local.set({ [CONFIG.storageKeys.codeSession]: this.session });
  }

  async fromChat() {
    const input = this.panel.messageInput;
    const text = input.value.trim();
    if (!text || this.controller || this.panel.sending) return;
    await this.ready;
    if (this.controller || this.panel.sending || !this.chatMode.checked || input.value.trim() !== text) return;
    const language = this.chatLanguage.value === this.customOption.value
      ? this.customLanguage.value.trim() : this.chatLanguage.value;
    if (!language) {
      this.customLanguage.focus();
      this.panel.showToast('코딩 언어를 입력해 주세요.', 'info');
      return;
    }
    const revise = this.newProject.getAttribute('aria-pressed') !== 'true';
    const output = document.createElement('div');
    output.className = 'message-bubble avatar code-chat-project';
    output.setAttribute('aria-live', 'polite');
    this.panel.renderMessage({ role: 'user', content: text, timestamp: nowISO() });
    this.panel.messagesContainer.append(output);
    input.value = '';
    this.panel.charCount.textContent = '0/100000';
    this.panel.autoResizeInput();
    this.panel.scrollToBottom();
    await this.run(text, language, revise, output);
  }

  regenerate(output = null, request = this.session.last) {
    if (!request) { this.status.textContent = '다시 생성할 요청이 없습니다.'; return; }
    if (!output) {
      output = document.createElement('div');
      output.className = 'message-bubble avatar code-chat-project';
      this.panel.messagesContainer.append(output);
    }
    return this.run(request.prompt, request.language, request.revise, output, request);
  }

  async run(rawPrompt, rawLanguage, revise, chatOutput = null, retry = null) {
    await this.ready;
    if (this.controller) return;
    const prompt = rawPrompt.trim();
    const language = rawLanguage.trim().slice(0, 60) || 'auto';
    const updateProject = !retry || retry === this.session.last;
    let chatStatus = chatOutput?.querySelector('.code-chat-status');
    if (chatOutput && !chatStatus) {
      chatStatus = document.createElement('div');
      chatStatus.className = 'code-chat-status';
      chatOutput.append(chatStatus);
    }
    const write = message => {
      if (updateProject) this.status.textContent = message;
      if (chatStatus) chatStatus.textContent = message;
    };
    if (!prompt) { write('무엇을 만들지 입력해 주세요.'); return; }
    const controller = new AbortController();
    this.controller = controller;
    const base = retry?.base ?? (revise ? this.session.files.map(file => ({ ...file })) : []);
    const request = { prompt, language, revise, base };
    let stop;
    this.cancel.hidden = false;
    try {
      const config = await StorageManager.getResolvedApiConfig();
      if (!hasApiReady(config)) { write('설정에서 모델과 API 키를 입력해 주세요.'); return; }
      this.panel.behaviorController?.setBusy('code', true, 'study');
      controller.signal.throwIfAborted();
      write('코드를 생성하고 있습니다…');
      if (chatOutput) {
        stop = document.createElement('button');
        stop.type = 'button';
        stop.className = 'btn-small';
        stop.textContent = '생성 취소';
        stop.onclick = () => controller.abort();
        chatStatus.after(stop);
      }
      const response = await fetch(chrome.runtime.getURL('prompts/codeprompt.txt'), { signal: controller.signal });
      if (!response.ok) throw new Error('코딩 지침을 불러오지 못했습니다.');
      const client = new LLMClient();
      client.applyConfig(config);
      const result = await CodeProjects.generate({ client, config, prompt, language, files: base,
        instruction: await response.text(), signal: controller.signal });
      controller.signal.throwIfAborted();
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
      const files = [...unchanged, ...result.files];
      if (updateProject) {
        const session = { version: 2, prompt, language, files, last: request };
        await chrome.storage.local.set({ [CONFIG.storageKeys.codeSession]: session });
        this.session = session;
        if (!retry) this.newProject.setAttribute('aria-pressed', 'false');
        this.render();
      }
      write(`${files.length}개 파일을 준비했습니다.`);
      if (chatOutput) {
        chatOutput.replaceChildren(chatStatus);
        for (const file of result.files) chatOutput.append(this.fileCard(file, false));
        const actions = document.createElement('div');
        actions.className = 'code-gen-row';
        actions.append(createActionButton('프로젝트 ZIP', () => this.downloadZip(files)),
          createActionButton('수정 요청', () => {
            this.chatMode.checked = true;
            this.newProject.setAttribute('aria-pressed', 'false');
            this.showControls();
            this.panel.messageInput.focus();
          }),
          createActionButton('다시 생성', () => this.regenerate(chatOutput, request)));
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
      stop?.remove();
      this.controller = null;
      this.cancel.hidden = true;
      this.panel.behaviorController?.setBusy('code', false);
    }
  }

  render() {
    this.project.replaceChildren(...this.session.files.map(file => this.fileCard(file, true)));
    document.getElementById('chat-code-zip').disabled = !this.session.files.length;
    document.getElementById('chat-code-regen').disabled = !this.session.last;
    this.showControls();
  }

  fileCard(file, editable) {
    const card = document.createElement('section');
    card.className = 'code-file-card';
    const title = document.createElement('h4');
    title.textContent = `${file.name} · ${file.language}`;
    const actions = document.createElement('div');
    actions.className = 'code-gen-row';
    actions.append(createActionButton('복사', async () => {
      try { await navigator.clipboard.writeText(file.content); this.status.textContent = '복사했습니다.'; }
      catch { this.panel.showToast('코드를 선택해 복사해 주세요.', 'info'); }
    }), createActionButton('파일 다운로드', () => {
      FileIO.downloadBlob(new Blob([file.content], { type: file.mime + ';charset=utf-8' }), file.name.split('/').at(-1));
    }));
    if (editable) {
      const name = document.createElement('input');
      name.className = 'setting-input code-filename';
      name.setAttribute('aria-label', '파일명 ' + file.name);
      name.value = file.name;
      actions.append(name, createActionButton('파일명 적용', async () => {
        if (this.controller) return;
        const safe = CodeProjects.filename(name.value, file.language);
        if (safe !== name.value || this.session.files.some(item => item !== file && CodeProjects.pathsConflict(item.name, safe))) {
          this.status.textContent = '안전하고 중복되지 않는 파일명을 입력해 주세요.';
          return;
        }
        this.session.files = this.session.files.map(item => item === file ? { ...file, name: safe } : item);
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

  async downloadZip(files = this.session.files) {
    if (!files.length) return;
    const entries = files.map(file => ({ name: file.name, data: file.content }));
    FileIO.downloadBlob(await FileIO.zipStore(entries, 'application/zip'), 'dangdang-project.zip');
  }
}
