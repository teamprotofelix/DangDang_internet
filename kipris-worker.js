// The worker owns the API key and never persists download URLs or document bytes.
const KiprisWorker = (() => {
  const keyName = CONFIG.storageKeys.kiprisKey;
  const searchKey = Kipris.searchKey;
  const legacyKey = 'kipris_last_application';
  const restrictStorage = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).then(() => true, () => false);
  let active;
  let clearing = false;

  const readSearch = async () => (await chrome.storage.local.get(searchKey))[searchKey] || { recent: [], result: null };
  const getKey = async () => (await chrome.storage.local.get(keyName))[keyName] || '';
  const reason = error => error instanceof Kipris.Error ? error.code : 'response';

  const belongs = (row, app) => !row.application || row.application === app;

  async function resolve(query, signal) {
    try { return { rows: await query() }; }
    catch (error) {
      signal.throwIfAborted();
      return { rows: error.partial || [], error: reason(error) };
    }
  }

  function checkedPath(rows, absent = 'not_found') {
    if (!rows.length) throw new Kipris.Error(absent);
    const paths = new Set(rows.map(row => row.path ? Kipris.safePdfURL(row.path).href : ''));
    if (paths.size !== 1) throw new Kipris.Error('identity');
    const [path] = paths;
    if (!path) throw new Kipris.Error('missing_path');
    return path;
  }

  // A path advertised for multiple identities cannot establish any of those identities.
  function separatePaths(matches, rows) {
    const normalize = path => {
      try { return path && Kipris.safePdfURL(path).href; }
      catch { return path; }
    };
    const paths = new Set(matches.map(row => normalize(row.path)).filter(Boolean));
    const identities = new Map();
    for (const row of rows) {
      if (!row.path) continue;
      const path = normalize(row.path);
      if (!paths.has(path)) continue;
      if (!identities.has(path)) identities.set(path, new Set());
      identities.get(path).add(row.id);
    }
    return matches.some(match => identities.get(normalize(match.path))?.size > 1) ? [] : matches;
  }

  function noticePath(rows, app, id) {
    const matches = rows.filter(row => row.id === id);
    if (matches.some(row => !belongs(row, app))) throw new Kipris.Error('identity');
    return checkedPath(separatePaths(matches, rows), matches.length ? 'identity' : 'not_found');
  }

  function gazettes(kind, rows, app) {
    return rows.filter(row => !row.ambiguous && belongs(row, app) && (row.gazetteNumber || row.gazetteLocator))
      .map(row => ({ ...row, id: kind + '-' + (row.gazetteNumber || row.gazetteLocator) }));
  }

  function corrections(rows, app) {
    return rows.filter(row => row.application === app && row.kind && row.date && /^\d+$/.test(row.serial)
      && /^[A-Z0-9]+$/i.test(row.typeCode))
      .map(row => ({ ...row, id: [row.kind, row.typeCode, row.date, row.serial].join('-') }));
  }

  function indexedPath(rows, doc) {
    const matches = rows.filter(row => row.id === doc.id);
    const distinct = separatePaths(matches, rows);
    return checkedPath(distinct, matches.length || rows.length ? 'identity' : 'not_found');
  }

  async function trialPath(doc, app, key, signal) {
    const rows = await Kipris.trialDecisionLocations(doc, app, key, signal);
    const publicRows = rows.filter(row => doc.kind === 'TRIAL_SUPPLEMENT' || row.open.toUpperCase() === 'Y');
    const matches = publicRows.filter(row => (!row.trialNumber || row.trialNumber === doc.trialNumber)
      && row.fileName.toLowerCase() === doc.trialNumber + '.pdf');
    const path = checkedPath(matches, publicRows.length ? 'identity' : 'not_found');
    await Kipris.trialSummary(doc, app, key, signal);
    return path;
  }

  async function documentPath(doc, app, key, signal) {
    if (Kipris.isGazette(doc.kind)) {
      const rows = await Kipris.pdfLocations(doc.kind, app, key, signal);
      if (rows.some(row => row.gazetteNumber && row.gazetteNumber === doc.gazetteNumber && !belongs(row, app))) {
        throw new Kipris.Error('identity');
      }
      return indexedPath(gazettes(doc.kind, rows, app), doc);
    }
    if (Kipris.isCorrectionGazette(doc.kind)) return indexedPath(corrections(
      await Kipris.correctionLocations(app, key, signal), app), doc);
    if (Kipris.isTrialDecision(doc.kind)) return trialPath(doc, app, key, signal);
    return noticePath(await Kipris.pdfLocations(doc.kind, app, key, signal, doc.id), app, doc.id);
  }

  async function scan(app, key, signal) {
    let entry;
    try { entry = await Kipris.getHistory(app, key, signal); }
    catch (error) { signal.throwIfAborted(); entry = { status: reason(error), rows: [] }; }
    const historyStatus = entry.status;
    if (historyStatus === 'auth' || historyStatus === 'missing_key') throw new Kipris.Error(historyStatus);
    const docs = (entry.rows || []).map(row => ({ id: row.id, title: row.title, date: row.date,
      kind: row.kind, trialNumber: row.trialNumber, processing: row.processing, status: 'metadata_only' }));
    const warnings = [];
    const assign = (doc, getPath) => {
      try { getPath(); doc.status = 'available'; }
      catch (error) { doc.status = reason(error); }
    };

    for (const kind of ['OA', 'RD', 'RG']) {
      const group = docs.filter(doc => doc.kind === kind);
      if (!group.length) continue;
      const listed = await resolve(() => Kipris.pdfLocations(kind, app, key, signal), signal);
      for (const doc of group) {
        assign(doc, () => noticePath(listed.rows, app, doc.id));
        if (['not_found', 'missing_path'].includes(doc.status) && !listed.error) {
          const single = await resolve(() => documentPath(doc, app, key, signal).then(path => [path]), signal);
          doc.status = single.error || 'available';
        } else if (doc.status === 'not_found' && listed.error) doc.status = listed.error;
      }
    }
    for (const kind of ['PUB', 'REG']) {
      const title = kind === 'PUB' ? '공개공보' : '등록공보';
      const listed = await resolve(() => Kipris.pdfLocations(kind, app, key, signal), signal);
      const rows = gazettes(kind, listed.rows, app);
      for (const row of new Map(rows.map(row => [row.id, row])).values()) {
        const doc = { id: row.id, kind, title, gazetteNumber: row.gazetteNumber };
        assign(doc, () => indexedPath(rows, doc));
        docs.push(doc);
      }
      if (!rows.length || listed.error) warnings.push({ title, status: listed.error
        || (listed.rows.length ? 'identity' : 'not_found') });
    }
    const listed = await resolve(() => Kipris.correctionLocations(app, key, signal), signal);
    const corrected = corrections(listed.rows, app);
    for (const row of new Map(corrected.map(row => [row.id, row])).values()) {
      const doc = { id: row.id, kind: row.kind, date: row.date,
        title: row.kind === 'CORR_PUB' ? '정정공보(공개)' : '정정공보(등록)' };
      assign(doc, () => indexedPath(corrected, doc));
      docs.push(doc);
    }
    if (!corrected.length || listed.error) warnings.push({ title: '정정공보', status: listed.error
      || (listed.rows.length ? 'identity' : 'not_found') });
    for (const doc of docs.filter(doc => Kipris.isTrialDecision(doc.kind))) {
      const decision = await resolve(() => trialPath(doc, app, key, signal).then(path => [path]), signal);
      doc.status = decision.error || 'available';
    }
    return { app, docs, warnings, historyStatus };
  }

  async function start(type, data) {
    if (active || clearing) throw new Kipris.Error('busy');
    const app = Kipris.applicationNumber(data.application);
    const operation = { app, id: data.requestId, controller: new AbortController() };
    active = operation;
    const signal = AbortSignal.any([operation.controller.signal, AbortSignal.timeout(180000)]);
    try {
      const key = await getKey();
      if (!key) throw new Kipris.Error('missing_key');
      if (type === 'kipris_lookup') {
        const result = await scan(app, key, signal);
        await navigator.locks.request('dangdang-kipris-history', async () => {
          const state = await readSearch();
          signal.throwIfAborted();
          await chrome.storage.local.set({ [searchKey]: { ...state, result, recent: [app, ...state.recent.filter(item => item !== app)].slice(0, 20) } });
        });
        signal.throwIfAborted();
        return { result };
      }
      const { result } = await readSearch();
      const doc = result?.app === app && result.docs.find(row => row.id === data.documentId);
      if (!doc || !Kipris.canDownload(doc)) throw new Kipris.Error('lookup_required');
      let bytes;
      for (let attempt = 0; ; attempt++) {
        const path = await documentPath(doc, app, key, signal);
        try { bytes = await Kipris.download(path, signal); break; }
        catch (error) { if (attempt || error.code !== 'expired_path') throw error; }
      }
      Kipris.checkPdfBytes(bytes);
      signal.throwIfAborted();
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return { pdf: btoa(binary) };
    } catch (error) {
      throw new Kipris.Error(operation.controller.signal.aborted ? 'cancelled'
        : signal.aborted ? 'timeout' : reason(error));
    } finally {
      active = null;
    }
  }

  async function clear(app) {
    if (clearing) throw new Kipris.Error('busy');
    clearing = true;
    if (active && (!app || active.app === app)) active.controller.abort();
    try {
      await navigator.locks.request('dangdang-kipris-history', async () => {
        const state = await readSearch();
        const legacy = (await chrome.storage.local.get(legacyKey))[legacyKey];
        if (app) await PatentStore.remove(app);
        else await PatentStore.clear();
        if (!app || app === legacy) await chrome.storage.local.remove(legacyKey);
        await chrome.storage.local.set({ [searchKey]: {
          clearId: crypto.randomUUID(), clearedApp: app,
          recent: app ? state.recent.filter(item => item !== app) : [],
          result: app && state.result?.app !== app ? state.result : null
        } });
      });
      return await readSearch();
    } finally { clearing = false; }
  }

  async function handle(type, data = {}) {
    if (!await restrictStorage) return { error: '로컬 키 저장소를 보호할 수 없습니다.' };
    if (type === 'kipris_key_state') return { configured: !!await getKey() };
    if (type === 'kipris_key_set') {
      const key = String(data.key || '').trim();
      if (!key || key.length > 512 || /\s/.test(key)) return { error: 'KIPRIS PLUS API 키 형식을 확인해 주세요.' };
      await chrome.storage.local.set({ [keyName]: key });
      return { configured: true };
    }
    if (type === 'kipris_key_remove') {
      await chrome.storage.local.remove(keyName);
      return { configured: false };
    }
    if (type === 'kipris_key_test') {
      const result = await Kipris.getHistory(Kipris.applicationNumber(data.application), await getKey(), AbortSignal.timeout(25000));
      return { status: result.status, count: result.rows.length };
    }
    if (type === 'kipris_cancel') {
      if (active?.id === data.requestId) active.controller.abort();
      return {};
    }
    if (type === 'kipris_restore') {
      const state = await readSearch();
      const legacy = (await chrome.storage.local.get(legacyKey))[legacyKey];
      return { ...state, legacy };
    }
    if (type === 'kipris_clear') return clear(Kipris.applicationNumber(data.application));
    if (type === 'kipris_clear_all') return clear(null);
    if (type === 'kipris_lookup' || type === 'kipris_download') return start(type, data);
    return { error: '지원하지 않는 요청입니다.' };
  }
  return { handle };
})();
