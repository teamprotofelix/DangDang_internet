// Code project format and generation for the side-panel chat.
const CodeProjects = (() => {
  const languages = Object.freeze({
    html: 'html', css: 'css', javascript: 'js', typescript: 'ts', python: 'py',
    java: 'java', kotlin: 'kt', c: 'c', 'c++': 'cpp', 'c#': 'cs', go: 'go',
    rust: 'rs', php: 'php', ruby: 'rb', swift: 'swift', sql: 'sql', bash: 'sh',
    powershell: 'ps1', json: 'json', yaml: 'yaml', xml: 'xml', markdown: 'md', text: 'txt'
  });
  const aliases = { js: 'javascript', ts: 'typescript', py: 'python', cpp: 'c++',
    csharp: 'c#', cs: 'c#', kt: 'kotlin', rs: 'rust', rb: 'ruby', sh: 'bash',
    ps1: 'powershell', yml: 'yaml', md: 'markdown', txt: 'text', plaintext: 'text' };

  function language(value) {
    const clean = String(value || '').trim().toLowerCase().slice(0, 60);
    return Object.hasOwn(aliases, clean) ? aliases[clean] : clean;
  }

  function filename(value, lang = 'text', index = 0) {
    const ext = (Object.hasOwn(languages, lang) ? languages[lang] : lang.replace(/[^a-z0-9]/g, '').slice(0, 12)) || 'txt';
    const fallback = `file-${index + 1}.${ext}`;
    const original = String(value || '').trim();
    if (/^(?:[\\/]|[a-z]:)|[\\\u0000-\u001f\u007f]/i.test(original)) return fallback;
    const parts = original.split('/');
    if (parts.length > 8 || parts.some(part => !part || part === '.' || part === '..')) return fallback;
    const clean = parts.map(part => part.replace(/[<>:"|?*]/g, '_').trim().replace(/[. ]+$/, ''));
    if (clean.some(part => !part || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return fallback;
    const result = clean.join('/');
    return new TextEncoder().encode(result).length > 180 ? fallback : result;
  }

  function pathsConflict(left, right) {
    const a = left.toLowerCase();
    const b = right.toLowerCase();
    return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
  }

  function mime(lang) {
    return ({ html: 'text/html', css: 'text/css', javascript: 'text/javascript',
      json: 'application/json', xml: 'application/xml', markdown: 'text/markdown' })[lang] || 'text/plain';
  }

  function parse(raw, preferred = 'auto', previous = []) {
    const files = [];
    const lines = String(raw || '').replace(/\r\n/g, '\n').split('\n');
    let block = null;
    let hint = '';
    for (const line of lines) {
      if (block) {
        if (new RegExp(`^ {0,3}${block.fence[0]}{${block.fence.length},}\\s*$`).test(line)) {
          const content = block.lines.join('\n');
          const index = files.length;
          const proposed = block.hint;
          const extension = proposed.split('/').at(-1)?.match(/\.([a-z0-9]+)$/i)?.[1];
          const lang = language(block.tag || (preferred !== 'auto' ? preferred : extension) || 'text');
          const name = filename(proposed, lang, index);
          if (content.trim() && (proposed || (block.tag && lang !== 'text'))) {
            if (files.some(file => pathsConflict(file.name, name))) {
              throw new Error(`응답에 같은 파일명이 반복됐습니다. 다시 생성해 주세요. (${name})`);
            }
            files.push({ name, language: lang, content, mime: mime(lang),
              status: previous.some(file => file.name === name) ? 'modified' : 'created', downloadable: true });
          }
          block = null;
          if (files.length >= 80) throw new Error('프로젝트 파일이 80개 이상입니다. 작업을 나누어 요청해 주세요.');
        } else {
          block.lines.push(line);
        }
        continue;
      }
      const open = line.match(/^ {0,3}(`{3,}|~{3,})\s*([^\s`~]*)\s*(.*?)\s*$/);
      if (open) {
        const inline = open[3].match(/^(?:file(?:name)?\s*[:=]\s*)?[`"']?([^"`']+?)[`"']?$/i);
        block = { fence: open[1], tag: open[2], hint: inline?.[1] || hint, lines: [] };
        hint = '';
      } else {
        const marker = line.match(/^\s*(?:#{1,6}\s+)?(?:\*\*)?(?:file(?:name)?|파일명?)\s*:\s*[`"']?(.+?)[`"']?(?:\*\*)?\s*$/i);
        hint = marker?.[1] || (line.trim() ? '' : hint);
      }
    }
    if (block) throw new Error('마지막 코드 블록이 닫히지 않았습니다. 다시 생성해 주세요.');
    return files;
  }

  function migrate(data) {
    if (!data || typeof data !== 'object') return { prompt: '', language: 'auto', files: [] };
    if (data.version === 2 && Array.isArray(data.files)) return data;
    return {
      version: 2, prompt: data.prompt || '', language: 'auto',
      files: typeof data.html === 'string' && data.html.trim()
        ? [{ name: 'app.html', language: 'html', content: data.html, mime: 'text/html',
          status: 'migrated', downloadable: true }] : []
    };
  }

  async function generate({ client, config, prompt, language: preferred, files, instruction, signal, onDelta }) {
    const output = Math.min(config.maxTokens || 4096, config.modelMaxOutputTokens || 8192);
    const user = JSON.stringify({ request: prompt, language: preferred,
      existingFiles: files.map(({ name, content }) => ({ name, content })) });
    const messages = [{ role: 'system', content: instruction }, { role: 'user', content: user }];
    const budget = computeRequestBudget({ apiConfig: config, messages, outputReserveTokens: output });
    if (!budget.ok) throw new Error('모델 예산에 프로젝트와 요청을 함께 넣을 수 없습니다. 입력을 줄이거나 모델 상한을 조정해 주세요.');
    const options = { temperature: 0.35, reasoningEffort: 'high', maxTokens: budget.maxOutput, signal };
    let result;
    try {
      result = await client.chatStream(messages, options, onDelta);
    } catch (error) {
      if (!error.canFallbackToChat?.()) throw error;
      result = await client.chatWithRetry(messages, options);
    }
    if (result.truncated) throw new Error('모델 응답이 생성 한도에서 잘렸습니다. 이전 프로젝트를 보존했습니다.');
    return { content: result.content, files: parse(result.content, preferred, files) };
  }

  return { languages, filename, pathsConflict, parse, migrate, generate };
})();
