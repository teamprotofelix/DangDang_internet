// KIPRIS credentials, collection, and model dispatch run in the trusted extension worker.
const PatentWorker = (() => {
  const active = new Map();
  const keyName = CONFIG.storageKeys.kiprisKey;
  let offscreenOpening;

  async function extract(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    const encoded = btoa(binary);
    const ask = type => chrome.runtime.sendMessage({ type, encoded });
    let reply;
    try {
      const url = chrome.runtime.getURL('kipris-offscreen.html');
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
      if (!contexts.length) {
        offscreenOpening ||= chrome.offscreen.createDocument({
          url, reasons: ['WORKERS'], justification: 'Extract patent PDF text and page boundaries locally.'
        }).finally(() => { offscreenOpening = null; });
        await offscreenOpening;
      }
      reply = await ask('kipris_pdf_parse');
    } catch { /* An open extension panel can use the same local parser. */ }
    if (!reply || reply.error === 'pdf_engine_load') {
      try { reply = await ask('kipris_pdf_parse_panel') || reply; } catch { /* Preserve the original error. */ }
    }
    if (!reply) throw new Kipris.Error('pdf_parser');
    if (reply.error) throw new Kipris.Error(reply.error);
    return reply.result;
  }

  const restrictStorage = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).then(() => true, () => false);
  const getKey = async () => (await chrome.storage.local.get(keyName))[keyName] || '';
  const reason = error => error instanceof Kipris.Error ? error.code : 'response';

  function snapshot(record) {
    if (!record) return null;
    const { application, runId, phase, state, historyStatus, claimStatus, registeredClaimStatus,
      collectionStatus, queriedAt, docs, report, error } = record;
    return { application, runId, phase, state, historyStatus, claimStatus, registeredClaimStatus,
      collectionStatus, queriedAt, docs: docs.map(({ pages, identityVerified, ...doc }) => doc), report, error };
  }

  function newCase(application) {
    return { application, docs: [], state: 'idle', historyStatus: 'pending', claimStatus: 'pending',
      registeredClaimStatus: 'pending', collectionStatus: 'pending' };
  }

  function verifiedGazette(doc) {
    return Kipris.isGazette(doc.kind) && doc.hasFile && doc.status === 'verified' && doc.identityVerified && doc.gazetteNumber;
  }

  async function saveReconciledGazettes(record, docs, report, inspected, bytes) {
    const key = doc => doc.kind + ':' + doc.gazetteNumber;
    const kept = new Map();
    for (const doc of docs) {
      if (!verifiedGazette(doc)) continue;
      const existing = kept.get(key(doc));
      if (!existing || (doc.source === '수동 첨부' && (doc === inspected || existing.source !== '수동 첨부'))) {
        kept.set(key(doc), doc);
      }
    }
    const removed = docs.filter(doc => {
      const survivor = kept.get(key(doc));
      return survivor && survivor !== doc && (verifiedGazette(doc) || !doc.hasFile);
    });
    const removeIds = new Set(removed.map(doc => doc.id));
    const current = inspected && verifiedGazette(inspected) && kept.get(key(inspected));
    const reconciled = docs.filter(doc => !removeIds.has(doc.id)).map(doc =>
      doc === current && inspected.gazetteLocator && doc.gazetteLocator !== inspected.gazetteLocator
        ? { ...doc, gazetteLocator: inspected.gazetteLocator }
        : doc);
    const checkpoint = { ...record, report: removeIds.size ? null : report, docs: reconciled };
    const writeId = bytes && !removeIds.has(inspected.id) ? inspected.id : null;
    if (writeId || removeIds.size) await PatentStore.saveWithFile(checkpoint, writeId, bytes, [...removeIds]);
    else await PatentStore.save(checkpoint);
    record.docs = reconciled;
    record.report = checkpoint.report;
  }

  async function inspectStoredPdf(record, doc, bytes) {
    const inspection = await Kipris.inspectPdf(bytes, record.application, doc, extract);
    const updated = { ...doc, ...inspection };
    const report = doc.status === inspection.status ? record.report : null;
    const docs = record.docs.map(item => item === doc ? updated : item);
    if (Kipris.isGazette(doc.kind)) await saveReconciledGazettes(record, docs, report, updated);
    else {
      await PatentStore.save({ ...record, report, docs });
      record.report = report;
    }
    Object.assign(doc, inspection);
  }

  async function savePdf(record, doc, bytes, source) {
    Kipris.checkPdfBytes(bytes);
    if (Kipris.isGazette(doc.kind) && record.docs.some(item => item !== doc && item.kind === doc.kind && verifiedGazette(item))) {
      // When a known gazette already exists, identify the candidate before writing a second copy.
      const inspection = await Kipris.inspectPdf(bytes, record.application, doc, extract);
      const updated = { ...doc, ...inspection, source, hasFile: true };
      const docs = record.docs.map(item => item === doc ? updated : item);
      await saveReconciledGazettes(record, docs, null, updated, bytes);
      Object.assign(doc, updated);
      return;
    }
    const saved = { ...doc, source, hasFile: true, status: 'pdf_extract_pending',
      size: bytes.length, pageCount: null, pages: [], identityVerified: false };
    const checkpoint = { ...record, report: null, docs: record.docs.map(item => item === doc ? saved : item) };
    await PatentStore.saveWithFile(checkpoint, doc.id, bytes);
    record.report = null;
    Object.assign(doc, saved);
    await inspectStoredPdf(record, doc, bytes);
  }

  function bindLegacyGazettes(record) {
    for (const doc of record.docs.filter(doc => Kipris.isGazette(doc.kind) && !doc.gazetteNumber)) {
      if (!doc.identityVerified) continue;
      const number = Kipris.gazetteNumberInPdf(doc.kind, doc.pages?.[0]?.text || '');
      if (number) doc.gazetteNumber = number;
      else Object.assign(doc, { status: 'identity', pages: [], identityVerified: false });
      record.report = null;
    }
  }

  async function collect(record, key, signal, onlyId) {
    const app = record.application;
    const cached = ['complete', 'empty'].includes(record.historyStatus)
      && Date.now() - Date.parse(record.queriedAt) < 10 * 60 * 1000;
    if (!cached && !onlyId) {
      record.queriedAt = new Date().toISOString();
      try {
        const { status, rows } = await Kipris.getHistory(app, key, signal);
        record.historyStatus = status;
        const old = new Map(record.docs.map(doc => [doc.id, doc]));
        record.docs = rows.map(row => {
          const saved = old.get(row.id);
          return saved?.hasFile && saved.kind === row.kind && saved.date === row.date && saved.title === row.title
            ? { ...row, ...saved, processing: row.processing }
            : { ...row, status: ['OA', 'RD', 'RG'].includes(row.kind) ? 'pending'
              : ['APP', 'AM', 'OPINION', 'CORRECTION'].includes(row.kind) ? 'manual' : 'other' };
        }).concat(record.docs.filter(doc => ['PUB', 'REG'].includes(doc.kind) || doc.kind === 'CITATION'));
        record.claimStatus = record.registeredClaimStatus = 'pending';
        record.claimHistory = null;
        record.registeredClaims = null;
      } catch (error) {
        signal.throwIfAborted();
        record.historyStatus = reason(error);
      }
      await PatentStore.save(record);
    }
    if (!onlyId && !['complete', 'empty', 'pagination'].includes(record.historyStatus)) {
      record.collectionStatus = record.historyStatus;
      if (['auth', 'missing_key'].includes(record.historyStatus)) return;
    }

    for (const doc of record.docs.filter(doc => doc.hasFile && Kipris.canRetryExtraction(doc.status)
      && (!onlyId || doc.id === onlyId))) {
      signal.throwIfAborted();
      const bytes = await PatentStore.file(app, doc.id);
      if (bytes) await inspectStoredPdf(record, doc, bytes);
    }

    async function fetchDocument(doc, path) {
      signal.throwIfAborted();
      try {
        if (!path) throw new Kipris.Error('missing_path');
        const bytes = await Kipris.download(path, signal);
        signal.throwIfAborted();
        await savePdf(record, doc, bytes, 'KIPRIS PLUS');
        signal.throwIfAborted();
      } catch (error) {
        signal.throwIfAborted();
        Object.assign(doc, { status: reason(error), pages: [], pageCount: null, identityVerified: false });
      }
      await PatentStore.save(record);
    }

    async function locationsFor(kind, id) {
      try { return { rows: await Kipris.pdfLocations(kind, app, key, signal, id), error: '' }; }
      catch (error) {
        signal.throwIfAborted();
        return { rows: error.partial || [], error: reason(error) };
      }
    }

    for (const kind of ['OA', 'RD', 'RG']) {
      const wanted = record.docs.filter(doc => doc.kind === kind && (!onlyId || doc.id === onlyId) && !doc.hasFile);
      if (!wanted.length) continue;
      const listed = onlyId ? null : await locationsFor(kind);
      for (const doc of wanted) {
        let lookup = listed;
        let matches = listed?.rows.filter(location => location.id === doc.id) || [];
        if (!onlyId && listed.error && !['pagination', 'not_found'].includes(listed.error) && !matches.length) {
          doc.status = listed.error;
          continue;
        }
        if (!matches.length || matches.every(match => !match.path)) {
          lookup = await locationsFor(kind, doc.id);
          matches = lookup.rows.filter(location => location.id === doc.id);
        }
        if (matches.length && matches.every(match => (!match.application || match.application === app)
          && match.path === matches[0].path)) {
          await fetchDocument(doc, matches[0].path);
        } else {
          doc.status = matches.length ? 'identity' : lookup.error || (lookup.rows.length ? 'missing_path' : 'not_found');
        }
      }
      await PatentStore.save(record);
    }

    bindLegacyGazettes(record);
    await saveReconciledGazettes(record, record.docs, record.report);
    for (const kind of ['PUB', 'REG']) {
      const stored = record.docs.filter(doc => doc.kind === kind);
      const target = onlyId && stored.find(doc => doc.id === onlyId && !doc.hasFile);
      if (onlyId && !target) continue;
      if (kind === 'REG' && !record.docs.some(doc => doc.kind === 'RG' || doc.kind === 'REG'
        || /등록료|설정등록/.test(doc.title))) continue;
      if (!onlyId && cached && stored.length && stored.every(doc => doc.hasFile || doc.status === 'not_found')) continue;
      const { rows: locations, error: lookupError } = await locationsFor(kind);
      const title = kind === 'PUB' ? '공개공보' : '등록공보';
      const candidates = locations.filter(row => !row.ambiguous && (!row.application || row.application === app)
        && (row.gazetteNumber || row.gazetteLocator));
      const matches = (doc, location) => doc.gazetteNumber && location.gazetteNumber
        ? doc.gazetteNumber === location.gazetteNumber
        : !!doc.gazetteLocator && doc.gazetteLocator === location.gazetteLocator;
      if (target) {
        const match = candidates.find(location => matches(target, location));
        if (match) {
          target.gazetteNumber ||= match.gazetteNumber;
          await fetchDocument(target, match.path);
        } else target.status = lookupError || 'gazette_unmatched';
      } else if (candidates.length) {
        const visited = new Set();
        let allVerified = true;
        for (const location of candidates) {
          let doc = record.docs.find(item => item.kind === kind && matches(item, location));
          if (!doc) {
            const id = kind + '-' + (location.gazetteNumber || location.gazetteLocator);
            doc = { id, kind, title, date: '', status: 'pending',
              gazetteNumber: location.gazetteNumber, gazetteLocator: location.gazetteLocator };
            record.docs.push(doc);
          }
          if (visited.has(doc.id)) continue;
          visited.add(doc.id);
          doc.gazetteNumber ||= location.gazetteNumber;
          if (!doc.hasFile) await fetchDocument(doc, location.path);
          if (!verifiedGazette(doc)) allVerified = false;
        }
        if (!lookupError && candidates.length === locations.length && allVerified) {
          const current = record.docs.filter(doc => doc.kind !== kind || doc.hasFile || doc.gazetteNumber || visited.has(doc.id));
          if (current.length !== record.docs.length) {
            record.docs = current;
            record.report = null;
          }
        }
      } else {
        const doc = stored.find(item => item.id === kind) || { id: kind, kind, title, date: '' };
        if (!record.docs.includes(doc) && !stored.length) record.docs.push(doc);
        for (const item of stored.length ? stored : [doc]) {
          if (!item.hasFile) item.status = lookupError || (locations.length ? 'gazette_unmatched' : 'not_found');
        }
      }
      await PatentStore.save(record);
    }

    if (!onlyId && record.claimStatus !== 'complete' && record.docs.some(doc => doc.kind === 'OA')) {
      try {
        record.claimHistory = await Kipris.getClaimHistory(app, key, signal);
        record.claimStatus = record.claimHistory.events.length && record.claimHistory.changes.length ? 'complete' : 'not_found';
      } catch (error) { signal.throwIfAborted(); record.claimStatus = reason(error); }
    }
    if (!onlyId && record.registeredClaimStatus !== 'complete' && record.docs.some(doc => doc.kind === 'REG')) {
      try {
        record.registeredClaims = await Kipris.registeredClaims(app, key, signal);
        record.registeredClaimStatus = record.registeredClaims.length ? 'complete' : 'not_found';
      } catch (error) { signal.throwIfAborted(); record.registeredClaimStatus = reason(error); }
    }
  }

  function refreshCollection(record) {
    if (['auth', 'missing_key'].includes(record.historyStatus)) return;
    for (const notice of record.docs.filter(doc => ['OA', 'RD'].includes(doc.kind) && doc.identityVerified)) {
      for (const citation of Kipris.citations(notice.pages)) {
        const id = 'CIT-' + citation.citationNumber;
        let doc = record.docs.find(item => item.id === id);
        if (!doc) {
          doc = { id, title: '인용발명 ' + citation.citationLabel, citationNumber: citation.citationNumber,
            kind: 'CITATION', status: 'manual', citedBy: [] };
          record.docs.push(doc);
        }
        if (!doc.citedBy.includes(notice.id)) doc.citedBy.push(notice.id);
      }
    }
    record.collectionStatus = ['complete', 'empty'].includes(record.historyStatus)
      && record.docs.every(doc => ['verified', 'other', 'not_found'].includes(doc.status)
        && (!['OA', 'RD', 'RG', 'REG'].includes(doc.kind) || doc.hasFile))
      ? 'complete' : 'partial';
  }

  async function run(record, job, config, onlyId, localRetry) {
    const { signal } = job.controller;
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
    try {
      if (localRetry) {
        const doc = record.docs.find(item => item.id === onlyId);
        const bytes = await PatentStore.file(record.application, doc.id);
        if (!bytes) throw new Kipris.Error('pdf_empty');
        signal.throwIfAborted();
        await inspectStoredPdf(record, doc, bytes);
      } else {
        await collect(record, await getKey(), signal, onlyId);
      }
      signal.throwIfAborted();
      refreshCollection(record);
      if (config) {
        record.phase = '진단 규칙 준비';
        await PatentStore.save(record);
        record.report = await PatentDiagnosis.evaluate(record, config, signal, async id => {
          record.phase = `규칙 점검 중 · ${id}`;
          await PatentStore.save(record);
        });
      }
      record.state = (config && record.report?.status) || record.collectionStatus;
    } catch (error) {
      record.state = signal.aborted ? 'cancelled' : 'failed';
      record.error = signal.aborted ? Kipris.messages.cancelled : Kipris.messages[reason(error)];
    } finally {
      clearInterval(keepAlive);
      record.phase = '';
      try { await PatentStore.save(record); }
      finally { active.delete(record.application); }
    }
  }

  async function status(app) {
    const job = active.get(app);
    const record = job?.record || await PatentStore.get(app);
    if (record?.state === 'running' && !job && !active.has(app)) {
      // Render the persisted checkpoint without writing over a concurrent restart.
      return snapshot({ ...record, state: 'interrupted', phase: '', error: Kipris.messages.interrupted });
    }
    return snapshot(record);
  }

  async function handle(type, data = {}) {
    if (!await restrictStorage) return { error: '로컬 키 저장소를 보호할 수 없어 요청을 중단했습니다.' };
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

    const app = Kipris.applicationNumber(data.application);
    if (type === 'kipris_key_test') {
      const result = await Kipris.getHistory(app, await getKey(), AbortSignal.timeout(25000));
      return { status: result.status, count: result.rows.length };
    }
    if (type === 'kipris_status') return { record: await status(app) };
    if (type === 'kipris_cancel') {
      const job = active.get(app);
      if (job?.record?.runId === data.runId) job.controller.abort();
      return { record: await status(app) };
    }

    if (type === 'kipris_file') {
      const record = await PatentStore.get(app);
      const doc = record?.docs.find(item => item.id === data.id && item.hasFile);
      const bytes = doc && await PatentStore.file(app, doc.id);
      // The trusted extension page reads the local IndexedDB file after receiving its metadata.
      return bytes ? { doc: { id: doc.id, title: doc.title } } : { error: '로컬 원문이 없습니다.' };
    }

    if (!['kipris_delete', 'kipris_attach', 'kipris_start', 'kipris_extract_retry'].includes(type)) return { error: '지원하지 않는 요청입니다.' };
    if (active.has(app)) return { record: await status(app), error: '이 출원번호의 작업이 이미 진행 중입니다.' };
    if (['kipris_start', 'kipris_extract_retry'].includes(type) && active.size) return { error: '다른 출원번호의 작업이 진행 중입니다.' };
    const job = { controller: new AbortController() };
    active.set(app, job);
    let started = false;
    try {
      if (type === 'kipris_delete') {
        await PatentStore.remove(app);
        return { record: null };
      }
      const record = await PatentStore.get(app) || newCase(app);
      if (type === 'kipris_attach') {
        const doc = record.docs.find(item => item.id === data.id);
        if (!doc || !['APP', 'AM', 'OPINION', 'CORRECTION', 'OA', 'RD', 'RG', 'PUB', 'REG', 'CITATION'].includes(doc.kind)) {
          return { error: '첨부할 문서를 목록에서 선택해 주세요.' };
        }
        if (typeof data.encoded !== 'string' || data.encoded.length > Math.ceil(Kipris.maxPdf / 3) * 4) throw new Kipris.Error('pdf');
        await savePdf(record, doc, Uint8Array.from(atob(data.encoded), ch => ch.charCodeAt(0)), '수동 첨부');
        return { record: snapshot(record) };
      }

      let config;
      const onlyId = data.documentId;
      const onlyDoc = record.docs.find(doc => doc.id === onlyId);
      const localRetry = type === 'kipris_extract_retry';
      if (localRetry && (data.diagnose || !onlyDoc?.hasFile || !Kipris.canRetryExtraction(onlyDoc.status))) {
        return { error: '텍스트를 다시 추출할 저장된 PDF를 선택해 주세요.' };
      }
      if (!localRetry && onlyId && (data.diagnose || !onlyDoc || onlyDoc.hasFile || !Kipris.apiPdfKinds.includes(onlyDoc.kind))) {
        return { error: 'API로 다시 조회할 원문을 선택해 주세요.' };
      }
      if (data.diagnose === true) {
        config = await StorageManager.getResolvedApiConfig();
        if (!hasApiReady(config)) return { error: '설정에서 분석에 사용할 LLM을 먼저 연결해 주세요.' };
        if (data.consent?.model !== config.model || data.consent?.apiBase !== config.apiBase) {
          return { error: '현재 모델과 전송 대상에 대해 다시 동의해 주세요.' };
        }
        chatCompletionURL(config);
      }
      if (!localRetry && !await getKey()) throw new Kipris.Error('missing_key');
      record.runId = crypto.randomUUID();
      record.state = 'running';
      record.phase = localRetry ? '저장된 PDF에서 텍스트 추출 중' : 'KIPRIS PLUS 조회 및 원문 확인 중';
      record.error = '';
      await PatentStore.save(record);
      job.record = record;
      started = true;
      void run(record, job, config, onlyId, localRetry).catch(() => {});
      return { record: snapshot(record) };
    } finally {
      if (!started) active.delete(app);
    }
  }

  return { handle };
})();
