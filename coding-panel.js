class CodingPanel {
  constructor(panel) {
    this.panel = panel;
    this.status = document.getElementById('code-status');
    this.prompt = document.getElementById('code-prompt');
    this.language = document.getElementById('code-language');
    this.chatMode = document.getElementById('chat-code-enabled');
    this.chatStatus = document.getElementById('chat-code-status');
    this.project = document.getElementById('code-files');
    this.filePicker = document.getElementById('code-file-picker');
    this.cancel = document.getElementById('btn-code-cancel');
    this.preferencesKey = CONFIG.storageKeys.codeSession + '_preferences';
    this.session = CodeProjects.migrate(null);
    this.languages = {
      tab: this.languageControl('code-language'),
      chat: this.languageControl('chat-code-language')
    };
    this.filePicker.onchange = () => this.renderFile();
    this.chatMode.onchange = () => {
      this.modeChanged = true;
      this.showChatLanguage();
      this.savePreferences();
    };
    document.getElementById('btn-code-gen').onclick = () => this.runFromTab(false);
    document.getElementById('btn-code-revise').onclick = () => this.runFromTab(true);
    document.getElementById('btn-code-regen').onclick = () => this.regenerate();
    document.getElementById('btn-code-zip').onclick = () => this.downloadZip();
    this.cancel.onclick = () => this.stop();
    this.ready = this.load();
    chrome.storage.onChanged.addListener((changes, area) => {
      const saved = changes[CONFIG.storageKeys.codeSession];
      if (area !== 'local' || !saved || this.controller) return;
      this.session = CodeProjects.migrate(saved.newValue);
      this.render();
    });
  }

  languageControl(id) {
    const select = document.getElementById(id);
    const custom = document.getElementById(id + '-custom');
    const labels = { html: 'HTML', css: 'CSS', javascript: 'JavaScript', typescript: 'TypeScript',
      sql: 'SQL', php: 'PHP', json: 'JSON', yaml: 'YAML', xml: 'XML', 'c++': 'C++', 'c#': 'C#',
      powershell: 'PowerShell', text: '일반 텍스트' };
    select.add(new Option('자동 감지', 'auto'));
    for (const name of Object.keys(CodeProjects.languages)) {
      select.add(new Option(labels[name] || name[0].toUpperCase() + name.slice(1), name));
    }
    select.add(new Option('직접 입력', '__custom__'));
    const control = { select, custom };
    const update = () => {
      control.changed = true;
      custom.hidden = select.hidden || select.value !== '__custom__';
      this.savePreferences();
    };
    select.onchange = () => {
      update();
      if (!custom.hidden) custom.focus();
    };
    custom.oninput = update;
    return control;
  }

  restoreLanguage(control, saved) {
    if (control.changed) return;
    const value = typeof saved === 'string' ? saved : saved?.value;
    const language = CodeProjects.language(value || 'auto');
    control.select.value = language === 'auto' || Object.hasOwn(CodeProjects.languages, language)
      ? language : '__custom__';
    control.custom.value = control.select.value === '__custom__' ? saved?.custom ?? value : saved?.custom || '';
    control.custom.hidden = control.select.hidden || control.select.value !== '__custom__';
  }

  showChatLanguage() {
    const { select, custom } = this.languages.chat;
    select.hidden = !this.chatMode.checked;
    custom.hidden = select.hidden || select.value !== '__custom__';
    if (select.hidden) this.chatStatus.textContent = '';
  }

  async load() {
    const key = CONFIG.storageKeys.codeSession;
    try {
      const data = await chrome.storage.local.get([key, this.preferencesKey]);
      this.session = CodeProjects.migrate(data[key]);
      const prefs = data[this.preferencesKey];
      if (!this.prompt.value) this.prompt.value = this.session.prompt;
      for (const [name, control] of Object.entries(this.languages)) {
        this.restoreLanguage(control, prefs?.[name] ?? this.session.language);
      }
      if (!this.modeChanged) this.chatMode.checked = !!prefs?.chatEnabled;
      this.showChatLanguage();
      this.render();
    } catch {
      this.status.textContent = '저장된 프로젝트를 불러오지 못했습니다.';
    }
  }

  savePreferences() {
    // Queue preference writes, including clicks that occur while the initial read is pending.
    this.preferenceWrite = (this.preferenceWrite || this.ready).then(() => {
      const { tab, chat } = this.languages;
      const value = ({ select, custom }) => ({ value: select.value, custom: custom.value });
      return chrome.storage.local.set({ [this.preferencesKey]: {
        tab: value(tab), chat: value(chat), chatEnabled: this.chatMode.checked
      } });
    }).catch(() => this.panel.showToast('코딩 설정을 저장하지 못했습니다.', 'info'));
  }

  selectedLanguage(control) {
    return control.select.value === '__custom__' ? control.custom.value.trim() : control.select.value;
  }

  runFromTab(revise) {
    return this.run(this.prompt.value, this.selectedLanguage(this.languages.tab), revise);
  }

  fromChat() {
    return this.run(this.panel.messageInput.value, this.selectedLanguage(this.languages.chat), true, 'new');
  }

  createChatOutput(text) {
    const output = document.createElement('div');
    output.className = 'message-bubble avatar code-chat-project';
    output.setAttribute('aria-live', 'polite');
    this.panel.renderMessage({ role: 'user', content: text, timestamp: nowISO() });
    this.panel.messagesContainer.append(output);
    this.panel.messageInput.value = '';
    this.panel.charCount.textContent = '0/100000';
    this.panel.autoResizeInput();
    this.panel.scrollToBottom();
    return output;
  }

  regenerate(output = null, request = this.session.last) {
    if (!request) { this.status.textContent = '다시 생성할 요청이 없습니다.'; return; }
    return this.run(request.prompt, request.language, request.revise, output, request);
  }

  stop() {
    if (!this.committing) this.controller?.abort();
  }

  async run(rawPrompt, rawLanguage, revise, output = null, retry = null) {
    await this.ready;
    const fromChat = output === 'new';
    const status = fromChat ? this.chatStatus : output?.querySelector('.code-chat-status') || this.status;
    const prompt = rawPrompt.trim();
    const language = rawLanguage.trim().slice(0, 60);
    if (this.controller) {
      if (fromChat) status.textContent = '코드 생성이 진행 중입니다.';
      return;
    }
    if (!prompt) { status.textContent = '무엇을 만들지 입력해 주세요.'; return; }
    if (!language) { status.textContent = '직접 입력할 언어 이름을 입력해 주세요.'; return; }
    const controller = new AbortController();
    this.controller = controller;
    try {
      await navigator.locks.request('dangdang-code-project', { ifAvailable: true }, async lock => {
        if (!lock) { status.textContent = '다른 패널에서 프로젝트 작업이 진행 중입니다.'; return; }
        const key = CONFIG.storageKeys.codeSession;
        const saved = (await chrome.storage.local.get(key))[key];
        const previous = this.session;
        this.session = CodeProjects.migrate(saved);
        if (JSON.stringify(previous) !== JSON.stringify(this.session)) this.render();
        const last = this.session.last;
        const currentRequest = retry?.id ? retry.id === last?.id
          : retry === previous.last && JSON.stringify(retry) === JSON.stringify(last);
        const updateProject = !retry || currentRequest;
        const base = (retry?.base ?? (revise ? this.session.files : [])).map(file => ({ ...file }));
        const request = { id: retry?.id || crypto.randomUUID(), prompt, language, revise, base };
        const chatOutput = fromChat ? this.createChatOutput(prompt) : output;
        if (fromChat) this.chatStatus.textContent = '';
        await this.generate(request, chatOutput, updateProject, controller);
      });
    } catch (error) {
      status.textContent = error.message || '프로젝트를 불러오지 못했습니다.';
    } finally {
      this.controller = null;
      this.committing = false;
      this.cancel.disabled = true;
    }
  }

  async generate(request, chatOutput, updateProject, controller) {
    const { prompt, language, base } = request;
    let chatStatus = chatOutput?.querySelector('.code-chat-status');
    if (chatOutput && !chatStatus) {
      chatStatus = document.createElement('div');
      chatStatus.className = 'code-chat-status';
      chatOutput.append(chatStatus);
    }
    const write = message => {
      this.status.textContent = message;
      if (chatStatus) chatStatus.textContent = message;
    };
    let stop;
    try {
      this.panel.behaviorController?.setBusy('code', true, 'study');
      this.cancel.disabled = false;
      write('코드를 생성하고 있습니다…');
      if (chatStatus) {
        stop = this.button('생성 취소', () => this.stop());
        chatStatus.after(stop);
      }
      const config = await StorageManager.getResolvedApiConfig();
      controller.signal.throwIfAborted();
      if (!hasApiReady(config)) { write('설정에서 모델과 API 키를 입력해 주세요.'); return; }
      const response = await fetch(chrome.runtime.getURL('prompts/codeprompt.txt'), { signal: controller.signal });
      if (!response.ok) throw new Error('코딩 지침을 불러오지 못했습니다.');
      const client = new LLMClient();
      client.applyConfig(config);
      const result = await CodeProjects.generate({ client, config, prompt, language, files: base,
        instruction: await response.text(), signal: controller.signal });
      controller.signal.throwIfAborted();
      if (!result.files.length) throw new Error('응답에 완성된 코드 블록이 없습니다.');
      const changed = new Map(result.files.map(file => [file.name.toLowerCase(), file]));
      const unchanged = base.filter(file => !changed.has(file.name.toLowerCase()));
      if (unchanged.some(file => result.files.some(change => CodeProjects.pathsConflict(file.name, change.name)))) {
        throw new Error('새 파일 경로가 기존 파일 또는 폴더 이름과 충돌합니다.');
      }
      const files = [...unchanged, ...result.files];
      if (updateProject) {
        const session = { version: 2, prompt, language, files, last: request };
        this.committing = true;
        this.cancel.disabled = true;
        if (stop) stop.disabled = true;
        write('프로젝트를 저장하고 있습니다…');
        try { await chrome.storage.local.set({ [CONFIG.storageKeys.codeSession]: session }); }
        catch { throw new Error('프로젝트를 저장하지 못했습니다. 이전 프로젝트를 보존했습니다.'); }
        this.session = session;
        if (!chatOutput) this.prompt.value = prompt;
        this.render();
      }
      write(`${files.length}개 파일을 준비했습니다.`);
      if (chatOutput) {
        chatOutput.replaceChildren(chatStatus);
        for (const file of files) chatOutput.append(this.fileCard(file, false));
        const actions = document.createElement('div');
        actions.className = 'code-gen-row';
        actions.append(this.button('프로젝트 ZIP', () => this.downloadZip(files)),
          this.button('수정 요청', () => this.panel.messageInput.focus()),
          this.button('다시 생성', () => this.regenerate(chatOutput, request)));
        chatOutput.append(actions);
        this.panel.scrollToBottom();
      }
    } catch (error) {
      write(controller.signal.aborted ? '코드 생성을 취소했습니다.'
        : (error.getUserMessage?.() || error.message || '코드 생성에 실패했습니다.'));
    } finally {
      stop?.remove();
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
    const selected = this.filePicker.value;
    this.filePicker.replaceChildren(...this.session.files.map(file => new Option(file.name, file.name)));
    if (this.session.files.some(file => file.name === selected)) this.filePicker.value = selected;
    this.filePicker.hidden = document.getElementById('code-file-label').hidden = !this.session.files.length;
    this.renderFile();
    document.getElementById('btn-code-zip').disabled = !this.session.files.length;
    document.getElementById('btn-code-regen').disabled = !this.session.last;
  }

  renderFile() {
    const file = this.session.files.find(item => item.name === this.filePicker.value);
    this.project.replaceChildren(...(file ? [this.fileCard(file, true)] : []));
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
        try {
          await navigator.locks.request('dangdang-code-project', { ifAvailable: true }, async lock => {
            if (!lock) { this.status.textContent = '프로젝트 작업이 진행 중입니다.'; return; }
            const key = CONFIG.storageKeys.codeSession;
            const saved = CodeProjects.migrate((await chrome.storage.local.get(key))[key]);
            if (JSON.stringify(saved.files) !== JSON.stringify(this.session.files) || !this.session.files.includes(file)) {
              this.session = saved;
              this.render();
              this.status.textContent = '파일 목록이 갱신되었습니다. 이름을 다시 입력해 주세요.';
              return;
            }
            const session = { ...saved, files: saved.files.map(item => item.name === file.name ? { ...item, name: safe } : item) };
            await chrome.storage.local.set({ [key]: session });
            this.session = session;
            this.render();
            this.filePicker.value = safe;
            this.renderFile();
          });
        } catch { this.status.textContent = '파일 이름을 저장하지 못했습니다.'; }
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
