// ============================================================
// background.js — Service Worker
// 중앙 조정자: 메시지 라우팅, LLM API 호출, 알람 관리
// ============================================================

// --- 의존성 로드 ---
importScripts(
  'config.js',
  'utils.js',
  'companion-policy.js',
  'messages.js',
  'moods.js',
  'indexeddb-storage.js',
  'storage.js',
  'play-memory.js',
  'api.js',
  'kipris.js',
  'patent-store.js',
  'kipris-worker.js'
);

// The worker is the single writer for the separate local play-memory document.
const playMemoryStore=new PlayMemory.Store({
 read:async()=>{const r=await chrome.storage.local.get(PlayMemory.KEY);return r[PlayMemory.KEY];},
 write:d=>chrome.storage.local.set({[PlayMemory.KEY]:d}),remove:()=>chrome.storage.local.remove(PlayMemory.KEY),
 settings:()=>StorageManager.getSettings(),
 changed:(state,reason)=>{notifyAllHttpTabs({type:'play_memory_changed',data:{...state,reason}});chrome.runtime.sendMessage({type:'play_memory_changed',data:{...state,reason}}).catch(()=>{});}
});

// --- 전역 상태 ---
let swInitialized = false;
let companionAutoEpoch = 0;
let companionChatSequence=0;
const companionChats=new Set();
const companionPanelExpiry=new Map();
function setCompanionChatBusy(id,active) {
  if(active)companionChats.add(id);else companionChats.delete(id);
  const message={type:MSG_TYPING,data:{active:companionChats.size>0}};
  chrome.runtime.sendMessage(message).catch(()=>{});
  // End also reaches the starting tab after the user switches tabs.
  notifyAllHttpTabs(message);
}
function contentSettings(settings) {
  return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).filter(key=>Object.hasOwn(settings||{},key)).map(key=>[key,settings[key]]));
}
function companionReply(text,mood,source,id) {
  return { mood, source, reaction: CompanionPolicy.completion(text,{source,id}), clearReaction:true };
}

// 페이지 스냅샷 캐시 유효 시간
const PAGE_SNAPSHOT_TTL_MS = 10 * 60 * 1000;

// 페이지 수집 세대: 웹 인식 OFF 전환 시 증가 → 진행 중 수집의 늦은 응답 폐기
let pageCollectionGen = 0;

// storage.local 접근 수준을 신뢰 컨텍스트로 제한 (콘텐츠 스크립트 접근 차단 — P0 리뷰)
try {
  if (chrome.storage.local?.setAccessLevel) {
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
      .catch(() => console.warn('[반려AI] storage.local 접근 수준 설정 실패'));
  }
} catch (e) {
  console.warn('[반려AI] storage.local 접근 수준 설정 실패:', e.message);
}

// ============================================================
// 유틸
// ============================================================

function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    })
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

// ============================================================
// SW 시작 시마다 설정 복원 (terminate 후 재시작 대응)
// ============================================================

async function ensureSWInitialized() {
  if (swInitialized) return;
  try {
    await StorageManager.cachePromptFiles();
    const api = await StorageManager.getResolvedApiConfig();
    llmClient.applyConfig({
      apiBase: api.apiBase,
      model: api.model,
      apiKey: api.apiKey || '',
      maxTokens: api.maxTokens,
      apiPreset: api.apiPreset,
      modelContextTokens: api.modelContextTokens,
      modelMaxOutputTokens: api.modelMaxOutputTokens
    });
    swInitialized = true;
  } catch (err) {
    console.error('[반려AI] SW 초기화 실패:', err.statusCode || err.name || '오류');
  }
}

// SW 시작 즉시 초기화 + 메시지마다 보장
ensureSWInitialized();

// ============================================================
// 키보드 단축키 (1단계: 편의성)
// ============================================================

chrome.commands?.onCommand?.addListener(async (command) => {
  try {
    if (command === 'open-panel') {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const windowId = tabs[0]?.windowId;
      if (windowId != null) await chrome.sidePanel.open({ windowId });
    } else if (command === 'toggle-avatar') {
      const settings = await StorageManager.getSettings();
      const next = !settings.floatingAvatarEnabled;
      await StorageManager.updateSettings({ floatingAvatarEnabled: next });
      notifyAllHttpTabs({ type: MSG_SET_AVATAR_VISIBLE, data: { visible: next } });
      console.log(`[반려AI] ⌨️ 단축키로 아바타 ${next ? '켬' : '끔'}`);
    }
  } catch (err) {
    console.warn('[반려AI] 단축키 처리 실패:', err.message);
  }
});

async function notifyActiveContent(message) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0 && tabs[0].id && tabs[0].url?.startsWith('http')) {
      await chrome.tabs.sendMessage(tabs[0].id, message).catch(() => {});
    }
  } catch (_) { /* 탭에 content script 없을 수 있음 */ }
}

async function notifyAllHttpTabs(message) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id && tab.url?.startsWith('http')) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      }
    }
  } catch (_) { /* 무시 */ }
}

// ============================================================
// P0-1/P0-2: 페이지 컨텍스트 — ON 게이트 + 탭별 격리
// ============================================================

async function contentAwarenessOn() {
  const settings = await StorageManager.getSettings();
  return settings.contentAwarenessEnabled !== false;
}

async function getPageCacheMap() {
  const result = await chrome.storage.session.get(CONFIG.storageKeys.pageCache);
  const map = result[CONFIG.storageKeys.pageCache];
  return map && typeof map === 'object' ? map : {};
}

async function setPageSnapshot(tabId, snapshot) {
  const map = await getPageCacheMap();
  map[String(tabId)] = snapshot;
  // 256개 초과 시 가장 오래된 것부터 정리
  const keys = Object.keys(map);
  if (keys.length > 256) {
    keys.sort((a, b) => (map[a].collectedAt || 0) - (map[b].collectedAt || 0));
    for (const k of keys.slice(0, keys.length - 256)) delete map[k];
  }
  await chrome.storage.session.set({ [CONFIG.storageKeys.pageCache]: map });
}

async function invalidatePageSnapshot(tabId) {
  const map = await getPageCacheMap();
  if (map[String(tabId)] !== undefined) {
    delete map[String(tabId)];
    await chrome.storage.session.set({ [CONFIG.storageKeys.pageCache]: map });
  }
}

async function clearPageCache() {
  await chrome.storage.session.remove(CONFIG.storageKeys.pageCache);
}

/**
 * 해당 탭에서 페이지 콘텐츠를 요청해 스냅샷으로 저장.
 * OFF 상태에서는 요청하지 않는다 (P0-1). 실패하면 null.
 * P0 리뷰: 응답 수신 시점에 설정·수집 세대·탭 URL을 재검증해
 * 수집 도중 OFF 전환이나 탭 이동 후 도착한 늦은 응답을 폐기한다.
 */
async function requestPageFromTab(tabId, expectedUrl) {
  if (!(await contentAwarenessOn())) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url?.startsWith('http')) return null;
    const genAtStart = pageCollectionGen;
    const urlAtStart = tab.url;
    const response = await withTimeout(
      chrome.tabs.sendMessage(tabId, { type: MSG_REQUEST_PAGE_CONTENT }),
      4000
    );
    if (response && response.type === MSG_PAGE_CONTENT && response.data) {
      // 수신 시점 재검증: OFF 전환 / 세대 변경 / URL 변경 → 폐기
      if (!(await contentAwarenessOn())) return null;
      if (genAtStart !== pageCollectionGen) return null;
      const tabNow = await chrome.tabs.get(tabId).catch(() => null);
      if (!tabNow || tabNow.url !== urlAtStart) return null;
      const snapshot = {
        ...response.data,
        tabUrl: tabNow.url,
        collectedAt: Date.now()
      };
      await setPageSnapshot(tabId, snapshot);
      return snapshot;
    }
  } catch (_) {
    // content script 미로드 등
  }
  return null;
}

/**
 * 요청에 사용할 페이지 스냅샷.
 * - OFF → null (캐시도 사용하지 않음)
 * - 캐시가 대상 탭의 현재 URL과 일치하고 신선하면 사용
 * - 아니면 같은 탭에서 갱신 시도, 실패하면 페이지 없이 진행 (다른 탭 자료로 대체 금지)
 */
async function getPageForRequest(tab) {
  if (!tab || !tab.url?.startsWith('http')) return null;
  if (!(await contentAwarenessOn())) return null;
  const map = await getPageCacheMap();
  const snap = map[String(tab.id)];
  const fresh = snap && snap.url === tab.url && (Date.now() - (snap.collectedAt || 0)) < PAGE_SNAPSHOT_TTL_MS;
  if (fresh) return snap;
  return await requestPageFromTab(tab.id, tab.url);
}

/**
 * 요청 대상 탭 결정: 패널 창의 활성 탭 우선, 없으면 마지막 포커스 창.
 */
async function resolveTargetTab(windowId) {
  try {
    const tabs = windowId
      ? await chrome.tabs.query({ active: true, windowId })
      : await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (tab && tab.id && tab.url?.startsWith('http')) return tab;
  } catch (_) { /* 무시 */ }
  return null;
}

// ============================================================
// 설치 / 초기화
// ============================================================

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[반려AI] 🎀 설치 완료!');

  // Side Panel: 액션 클릭 시 열리도록 설정
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  // Storage 초기화 (기본 설정, 프롬프트 캐싱, API 설정 마이그레이션)
  await StorageManager.initialize();

  // LLM 클라이언트에 저장된 API 설정 적용
  const api = await StorageManager.getResolvedApiConfig();
  llmClient.applyConfig({
    apiBase: api.apiBase,
    model: api.model,
    apiKey: api.apiKey || '',
    maxTokens: api.maxTokens,
    apiPreset: api.apiPreset,
    modelContextTokens: api.modelContextTokens,
    modelMaxOutputTokens: api.modelMaxOutputTokens
  });

  // 페이지 콘텐츠 체크 알람
  await chrome.alarms.create('content_check', { periodInMinutes: CONFIG.proactive.contentCheckMinutes });

  // 주기적 말 걸기: 다음 실행 시각을 영속 저장하고 1회성 알람으로 예약 (P1-3)
  await ensureProactiveSchedule();

  await ensureContextMenus();

  console.log('[반려AI] 알람 스케줄러 시작됨');
});

// 브라우저 시작 시에도 알람 복구 (SW 재시작 대응)
chrome.runtime.onStartup.addListener(async () => {
  await ensureSWInitialized();
  await ensureProactiveSchedule();
  await ensureContentCheckAlarm();
});

// SW 로드 때마다 알람 존재 확인 (terminate 후 재시작 대응)
ensureProactiveSchedule().catch((e) => console.warn('[반려AI] 말 걸기 스케줄 복구 실패:', e.message));
ensureContentCheckAlarm().catch(() => {});

async function ensureContentCheckAlarm() {
  const alarm = await chrome.alarms.get('content_check');
  if (!alarm) {
    await chrome.alarms.create('content_check', { periodInMinutes: CONFIG.proactive.contentCheckMinutes });
  }
}

async function ensureContextMenus() {
  try {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
      id: 'send-to-haru',
      title: '📩 댕댕이에게 전달',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: 'explain-to-haru',
      title: '💡 댕댕이에게 쉽게 설명해 달라고 하기',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: 'translate-to-haru',
      title: '🌐 댕댕이에게 번역해 달라고 하기',
      contexts: ['selection']
    });
  } catch (err) {
    console.warn('[반려AI] 컨텍스트 메뉴 생성 실패:', err.message);
  }
}

ensureContextMenus();

// ============================================================
// 알람 핸들러
// ============================================================

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'proactive_once') {
    await handleProactiveAlarm();
  } else if (alarm.name === 'content_check') {
    await handleContentCheck();
  }
});

/**
 * 주기적 말 걸기 — 메모리 tick 대신 영속 시각 + 1회성 알람 (P1-3)
 */
async function ensureProactiveSchedule() {
  const settings = await StorageManager.getSettings();
  if (!settings.proactiveEnabled || settings.focusMode) {
    await chrome.alarms.clear('proactive_once');
    return;
  }
  const stored = await StorageManager.get(CONFIG.storageKeys.proactiveNext);
  let nextAt = Number(stored);
  const min = Math.max(1, Number(settings.proactiveIntervalMin) || CONFIG.proactive.minIntervalMinutes);
  const max = Math.max(min, Number(settings.proactiveIntervalMax) || CONFIG.proactive.maxIntervalMinutes);
  if (!Number.isFinite(nextAt) || nextAt <= Date.now()) {
    nextAt = Date.now() + randomInt(min, max + 1) * 60000;
    await StorageManager.set(CONFIG.storageKeys.proactiveNext, nextAt);
  }
  const existing = await chrome.alarms.get('proactive_once');
  if (!existing) {
    await chrome.alarms.create('proactive_once', { when: nextAt });
    console.log('[반려AI] ⏰ 다음 말 걸기:', new Date(nextAt).toLocaleTimeString('ko-KR'));
  }
}

async function scheduleNextProactive(settings) {
  if (!settings?.proactiveEnabled || settings.focusMode) { await chrome.alarms.clear('proactive_once'); return; }
  const min = Math.max(1, Number(settings?.proactiveIntervalMin) || CONFIG.proactive.minIntervalMinutes);
  const max = Math.max(min, Number(settings?.proactiveIntervalMax) || CONFIG.proactive.maxIntervalMinutes);
  const nextAt = Date.now() + randomInt(min, max + 1) * 60000;
  await StorageManager.set(CONFIG.storageKeys.proactiveNext, nextAt);
  await chrome.alarms.create('proactive_once', { when: nextAt });
}

async function handleProactiveAlarm() {
  const settings = await StorageManager.getSettings();
  if (!settings.proactiveEnabled || settings.focusMode) {
    await chrome.alarms.clear('proactive_once');
    return;
  }
  // 자동 호출 동시 실행 방지 (전역 한 번에 하나)
  const busyToken = await tryAcquireAutoBusy();
  if (!busyToken) {
    // 다른 자동 호출이 진행 중이면 조금 미뤄 재예약 (중복 실행 금지)
    await scheduleNextProactive(settings);
    return;
  }
  try {
    await triggerProactiveMessage();
  } finally {
    await releaseAutoBusy(busyToken);
  }
  // P1 리뷰 3차: 응답 반영·재예약 직전 활성 상태 재확인 —
  // LLM 대기 중 OFF로 바뀌었으면 알람을 지우고 재예약하지 않는다.
  const settingsAfter = await StorageManager.getSettings();
  if (!settingsAfter.proactiveEnabled || settingsAfter.focusMode) {
    await chrome.alarms.clear('proactive_once');
    try { await chrome.action.setBadgeText({ text: '' }); } catch (_) { /* 무시 */ }
    return;
  }
  // 절전/재시작으로 늦게 깨어났어도 1회만 실행하고 다음 일정 계산
  await scheduleNextProactive(settingsAfter);
}

// 자동 LLM 호출(말 걸기·혼잣말·더블클릭) 전역 1개 제한.
// P1 리뷰: 획득을 뮤텍스 큐로 직렬화하고, 해제는 소유자 토큰 검사 후에만.
let autoBusyQueue = Promise.resolve();

async function tryAcquireAutoBusy() {
  const token = 'busy_' + generateId();
  let acquired = false;
  const step = autoBusyQueue.then(async () => {
    const r = await chrome.storage.session.get('llm_auto_busy');
    const cur = r.llm_auto_busy;
    const t = cur ? Number(cur.at) : NaN;
    if (Number.isFinite(t) && Date.now() - t < 5 * 60000) return; // 다른 실행이 보유 중
    await chrome.storage.session.set({ llm_auto_busy: { at: Date.now(), owner: token } });
    acquired = true;
  });
  autoBusyQueue = step.catch(() => {});
  await step;
  return acquired ? token : null;
}

async function releaseAutoBusy(token) {
  if (!token) return;
  const r = await chrome.storage.session.get('llm_auto_busy');
  const cur = r.llm_auto_busy;
  if (cur && cur.owner === token) {
    await chrome.storage.session.remove('llm_auto_busy').catch(() => {});
  }
}

/**
 * 페이지 콘텐츠 체크 (활성 탭 스냅샷 갱신)
 */
async function handleContentCheck() {
  if (!(await contentAwarenessOn())) return;
  try {
    const tab = await resolveTargetTab(null);
    if (!tab) return;
    await requestPageFromTab(tab.id, tab.url);
  } catch (err) {
    // content script가 아직 로드되지 않은 탭일 수 있음 (무시)
  }
}

/**
 * 주기적 말 걸기 실행 — 요청 시작 시 대상 탭과 스냅샷 고정 (P0-2)
 */
async function triggerProactiveMessage() {
  await ensureSWInitialized();
  try {
    const settings = await StorageManager.getSettings();
    if (!settings.proactiveEnabled || settings.focusMode) return false;
    const autoEpoch=companionAutoEpoch;
    const historyEpoch=await StorageManager.get(CONFIG.storageKeys.historyEpoch);
    const tab = await resolveTargetTab(null);
    // P0-1: OFF면 페이지 스냅샷 없이 진행. P0-2: 요청 시작 시점에 고정.
    let pageSnapshot = await getPageForRequest(tab);
    const inactiveMinutes = await StorageManager.getInactiveMinutes();
    const timeLabel = getTimeOfDayLabel();

    const buildPrompt = (snap) => {
      let prompt = `지금은 ${timeLabel} 시간대야. `;
      if (snap && snap.text) {
        const typeHints = {
          news: '뉴스',
          shopping: '쇼핑',
          video: '동영상',
          sns: 'SNS/커뮤니티',
          document: '기술 문서',
          article: '글',
          general: '웹페이지'
        };
        const typeLabel = typeHints[snap.type] || '웹페이지';
        const contentSnippet = snap.text.substring(0, 400).replace(/\n/g, ' ');
        prompt += `사용자가 "${snap.title}" ${typeLabel}을(를) 보고 있어. `;
        prompt += `페이지 내용 일부: "${contentSnippet}" `;
        prompt += `이 내용을 보고 사용자에게 도움이 될 만한 짧은 코멘트나 조언, `;
        prompt += `또는 공감하는 반응을 자연스럽게 보여줘. `;
      } else if (inactiveMinutes > 30) {
        prompt += `사용자가 ${inactiveMinutes}분 동안 조용했어. 보고 싶었다는 느낌으로 말을 걸어줘. `;
      } else {
        prompt += `자연스럽게 사용자에게 말을 걸어줘. 일상적인 대화나 재미있는 질문을 해줘. `;
      }
      return prompt + `대사는 1~2문장으로 짧게!`;
    };

    let prompt = buildPrompt(pageSnapshot);

    // P0 리뷰 2차: LLM 전송 직전 재검증 — OFF 전환·탭 이동 시 페이지 부분 제외
    if (pageSnapshot && tab) {
      const stillOn = await contentAwarenessOn();
      const tabNow = await chrome.tabs.get(tab.id).catch(() => null);
      if (!stillOn || !tabNow || tabNow.url !== pageSnapshot.url) {
        pageSnapshot = null;
        prompt = buildPrompt(null);
      }
    }

    const result = await llmClient.sendProactive(prompt);

    // P1 리뷰 3차: 응답 반영 직전 활성 상태 재확인 — LLM 대기 중 OFF로 바뀌었으면
    // 메시지 저장·말풍선·알림·배지 등 결과 반영을 모두 중단한다.
    const settingsNow = await StorageManager.getSettings();
    if (!settingsNow.proactiveEnabled || settingsNow.focusMode || autoEpoch!==companionAutoEpoch) {
      console.warn('[반려AI] 말 걸기 응답 도착 전에 꺼져서 결과를 반영하지 않아');
      return false;
    }

    const message = result.message || '(조용히 미소 지으며 바라본다)';
    const mood = result.mood || 'default';

    const stillAllowed=async()=>{const latest=await StorageManager.getSettings();return latest.proactiveEnabled&&!latest.focusMode&&autoEpoch===companionAutoEpoch;};
    // The queue can outlive the check above. Carry cancellation to the actual
    // storage boundaries, and commit mood only with an accepted history write.
    const saved = await StorageManager.addMessage('assistant', message, mood, {}, {
      epoch: historyEpoch,
      canCommit: stillAllowed,
      isCurrent: () => autoEpoch === companionAutoEpoch,
      saveMood: true
    });
    if (!saved) return false;

    if(!(await stillAllowed()))return false;
    // 활성 탭에 말풍선 + 표정 표시
    await notifyActiveContent({
      type: MSG_SHOW_BUBBLE,
      data: companionReply(message,mood,'proactive','proactive-'+Date.now())
    });

    if(!(await stillAllowed()))return false;
    // Side Panel에 새 메시지 알림 (열려있는 경우)
    chrome.runtime.sendMessage({
      type: MSG_NEW_MESSAGE,
      data: { role: 'assistant', content: message, mood, timestamp: nowISO(), source:'proactive',eventId:'proactive-'+Date.now() }
    }).catch(() => {});

    if(!(await stillAllowed()))return false;
    // 1단계: 말 걸기 알림 + 기분 배지 (패널이 닫혀 있어도 존재감 유지)
    try {
      chrome.notifications.create('proactive_' + Date.now(), {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: '댕댕이',
        message
      });
    } catch (_) { /* 알림 미지원 환경 */ }
    if(!(await stillAllowed()))return false;
    try {
      const moodData = (typeof getMoodData === 'function') ? getMoodData(mood) : null;
      await chrome.action.setBadgeText({ text: moodData?.label || '🐶' });
      await chrome.action.setBadgeBackgroundColor({ color: '#F48FB1' });
    } catch (_) { /* 무시 */ }

    console.log('[반려AI] 💬 주기적 말 걸기 완료');
    return true; // 결과 반영 완료
  } catch (err) {
    console.warn('[반려AI] 주기적 말 걸기 실패:', err.message);
    return false;
  }
}

// ============================================================
// 공유 사용자 메시지 처리 (send + context menu 공용)
// ============================================================

/**
 * @param {string} userText
 * @param {object} opts { windowId?: number, tabId?: number, includePage?: boolean }
 *   - includePage=false: 우클릭 선택문 등 명시적 전달 — 주변 페이지 전체를 덧붙이지 않음 (P0-1)
 */
async function processUserMessage(userText, opts = {}) {
  await ensureSWInitialized();
  const { windowId = null, tabId = null, includePage = true } = opts;

  // P1 리뷰: 요청 시작 시점의 대화 세대 고정 — 초기화가 끼어들면 응답을 저장·표시하지 않음
  const requestEpoch = await StorageManager.get(CONFIG.storageKeys.historyEpoch);

  // 요청 시작 시 대상 탭과 페이지 스냅샷 고정 (P0-2)
  let pageSnapshot = null;
  let requestTab = null;
  if (includePage) {
    try {
      requestTab = tabId != null ? await chrome.tabs.get(tabId) : await resolveTargetTab(windowId);
    } catch (_) { /* 탭 닫힘 등 */ }
    pageSnapshot = await getPageForRequest(requestTab);
  }

  // 예산 계산 (P0-4): 모델 컨텍스트 상한 내에서 이력 예산 산출
  const apiConfig = await StorageManager.getResolvedApiConfig();
  const base = computeRequestBudget({
    apiConfig,
    messages: [],
    outputReserveTokens: CONFIG.modelLimits.chatMaxOutputTokens
  });
  const buildWithPage = async (snap) => {
    const hb = await StorageManager.computeHistoryBudget(apiConfig, userText, snap, base.maxInputTokens);
    let msgs = await StorageManager.buildLLMContext(userText, snap, { historyTokenBudget: hb });
    const en = enforceRequestBudget({ apiConfig, messages: msgs, outputReserveTokens: base.maxOutput });
    if (en.trimmed === 'hard') {
      throw new APIError('모델 컨텍스트 상한이 너무 작아 요청을 만들 수 없어요. 설정에서 컨텍스트 상한을 올려주세요!', 0);
    }
    return en;
  };

  let enforced = await buildWithPage(pageSnapshot);
  let contextMessages = enforced.messages;

  // 사용자 메시지 저장 + 사이드 패널에도 표시 (우클릭 경로)
  await StorageManager.addMessage('user', userText, null, {}, { epoch: requestEpoch });
  chrome.runtime.sendMessage({
    type: MSG_NEW_MESSAGE,
    data: { role: 'user', content: userText, timestamp: nowISO() }
  }).catch(() => {});

  // Side Panel + 플로팅 아바타에 생각 중 표시
  const companionChatId=++companionChatSequence;
  setCompanionChatBusy(companionChatId,true);
  try {


  // P0 리뷰 2차: 컨텍스트 구성·저장 이후, API 전송 직전에 페이지 재검증
  // (테스트 훅: 재현 시나리오를 위해 검증 직전에 개입 가능)
  if (typeof globalThis.__testHooks?.beforeSendValidation === 'function') {
    await globalThis.__testHooks.beforeSendValidation();
  }
  if (pageSnapshot && requestTab) {
    const stillOn = await contentAwarenessOn();
    const tabNow = await chrome.tabs.get(requestTab.id).catch(() => null);
    if (!stillOn || !tabNow || tabNow.url !== pageSnapshot.url) {
      pageSnapshot = null;
      enforced = await buildWithPage(null);
      contextMessages = enforced.messages;
    }
  }

    const result = await llmClient.chatWithRetry(contextMessages, {
      maxTokens: enforced.budget.maxOutput,
      timeoutMs: CONFIG.api.timeoutMs
    });
    let reply = result.content || '(미소 지으며 고개를 끄덕인다)';
    if (result.truncated) {
      reply += '\n(응답이 너무 길어 잘렸어! 이어서 물어보면 계속 말해줄게~)';
    }
    const parsed = parseMoodFromResponse(reply);
    reply = parsed.message || reply;
    const mood = parsed.mood || 'default';

    // P1 리뷰: 응답 저장·표시 전 epoch 재검증 — 초기화된 대화에 옛 응답을 넣지 않음
    const epochStillValid = (await StorageManager.get(CONFIG.storageKeys.historyEpoch)) === requestEpoch;
    if (!epochStillValid) {
      console.warn('[반려AI] 대화가 초기화되어 응답을 표시하지 않아');
      return { type: 'reply_discarded' };
    }

    // 응답 저장 + 기분 상태 저장 (1단계: 감정 지속성)
    await StorageManager.addMessage('assistant', reply, mood, {}, { epoch: requestEpoch });
    await StorageManager.saveMoodState(mood);

    const replyEventId='chat-'+requestEpoch+'-'+companionChatId;
    // Side Panel에 응답 전송
    chrome.runtime.sendMessage({
      type: MSG_NEW_MESSAGE,
      data: { role: 'assistant', content: reply, mood, timestamp: nowISO(), source:'chat',eventId:replyEventId }
    }).catch(() => {});

    // 타이핑 종료

    // 플로팅 아바타: 표정 + 짧은 말풍선 (살아있는 반응)
    await notifyActiveContent({
      type: MSG_SHOW_BUBBLE,
      data: companionReply(reply,mood,'complete',replyEventId)
    });

    return {
      type: MSG_NEW_MESSAGE,
      data: { role: 'assistant', content: reply, mood, timestamp: nowISO(), source:'chat',eventId:replyEventId }
    };
  } catch (err) {
    // 타이핑 종료

    const errorMsg = err instanceof APIError
      ? err.getUserMessage()
      : '미안해... 대답을 생각하는데 문제가 생겼어 (´•ω•̥`) 다시 시도해볼래?';

    // 오류 메시지도 대화에 추가 (epoch 게이트 포함)
    await StorageManager.addMessage('assistant', errorMsg, 'sad', {}, { epoch: requestEpoch });

    chrome.runtime.sendMessage({
      type: MSG_NEW_MESSAGE,
      data: { role: 'assistant', content: errorMsg, mood: 'sad', timestamp: nowISO(),source:'error' }
    }).catch(() => {});

    notifyActiveContent({
      type: MSG_SHOW_BUBBLE,
      data: { mood:'sad',reaction:null,clearReaction:true }
    });

    return { type: MSG_ERROR, data: { message: err.message } };
  } finally {
    setCompanionChatBusy(companionChatId,false);
  }
}

// ============================================================
// 메시지 핸들러
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'kipris_pdf_identity') return false;
  handleMessage(message, sender).then(sendResponse).catch(err => {
    sendResponse({ type: MSG_ERROR, data: { message: err.message } });
  });
  return true; // 비동기 응답 유지
});

async function handleMessage(message, sender) {
  const { type, data } = message;
  const trusted = isTrustedExtensionUI(sender);
  if (typeof type === 'string' && type.startsWith('kipris_')) {
    if (!trusted) return { type: 'denied' };
    try { return await KiprisWorker.handle(type, data); }
    catch (error) {
      return { error: error instanceof Kipris.Error || error instanceof APIError
        ? error.message : '특허 서류 작업 중 오류가 발생했습니다.' };
    }
  }
  if(['pm_get','pm_control','pm_begin','pm_end','pm_reunion'].includes(type)){
    if(sender?.id!==chrome.runtime.id)return {status:'denied'};
    const content=!!sender.tab;
    if(!trusted&&!content)return {status:'denied'};
    const owner=content?'tab:'+sender.tab.id+':'+(sender.frameId||0)+':'+(sender.documentId||''):('ui:'+(sender.documentId||'panel'));
    return playMemoryStore.dispatch(type,data||{},{trusted,view:content?'floating':'panel',owner});
  }

  switch (type) {

    // --- 사용자 메시지 (패널) ---
    case MSG_SEND_MESSAGE: {
      if (!trusted) return { type: 'denied' };
      // 패널 창 기준 대상 탭을 쓰되, 창 정보가 없으면 마지막 포커스 창
      return await processUserMessage(data.text, { windowId: data.windowId ?? null, includePage: true });
    }

    // --- 페이지 콘텐츠 수신 (Content Script → Background, 자발 전송) ---
    case MSG_PAGE_CONTENT: {
      // P0-1: OFF면 폐기. P0-2: sender.tab 기준 검증 + 탭별 저장.
      if (!(await contentAwarenessOn())) {
        return { type: 'page_content_discarded' };
      }
      if (!sender.tab || !sender.tab.id || !sender.tab.url?.startsWith('http')) {
        return { type: 'page_content_discarded' };
      }
      if (data && data.text) {
        await setPageSnapshot(sender.tab.id, {
          ...data,
          tabUrl: sender.tab.url,
          collectedAt: Date.now()
        });
      }
      return { type: 'page_content_ack' };
    }

    // --- 페이지 컨텍스트 요청 (패널 채팅용) ---
    case 'get_page_context': {
      if (!trusted) return { type: 'denied' };
      const tab = await resolveTargetTab(data?.windowId ?? null);
      const pageContent = await getPageForRequest(tab);
      return { type: 'page_context', data: { pageContent } };
    }

    // --- 대화 이력 요청 (패널이 열림 → 기분 배지 해제) ---
    case MSG_GET_HISTORY: {
      if (!trusted) return { type: 'denied' };
      const messages = await StorageManager.getRecentHistory();
      try {
        await chrome.action.setBadgeText({ text: '' });
      } catch (_) { /* 무시 */ }
      return { type: MSG_HISTORY_LOADED, data: { messages } };
    }

    // --- 대화 초기화 ---
    case MSG_CLEAR_HISTORY: {
      if (!trusted) return { type: 'denied' };
      await StorageManager.clearMessages();
      return { type: 'history_cleared' };
    }

    // --- 설정 가져오기 (민감 정보는 신뢰된 확장 UI에만) ---
    case MSG_GET_SETTINGS: {
      const settings = await StorageManager.getSettings();
      const result = { type: MSG_SETTINGS_LOADED, data: { settings: trusted ? settings : contentSettings(settings) } };
      if (trusted) {
        result.data.api = await StorageManager.getResolvedApiConfig();
      }
      return result;
    }

    // --- 설정 업데이트 ---
    case MSG_UPDATE_SETTINGS: {
      const API_FIELDS = new Set(['apiPreset', 'apiBase', 'model', 'apiKey', 'maxTokens',
        'pageContentMaxChars', 'modelContextTokens', 'modelMaxOutputTokens']);
      // 콘텐츠 스크립트는 비민감 필드만 (hideSelf 등 기존 기능 유지), API 필드는 신뢰 UI 전용
      let partial = data || {};
      if (!trusted) {
        const filtered = {};
        for (const [k, v] of Object.entries(partial)) {
          if (k === 'floatingAvatarEnabled' && v === false) filtered[k] = v;
        }
        partial = filtered;
      }

      if (partial.focusMode!==undefined || partial.proactiveEnabled!==undefined || partial.wanderEnabled!==undefined) companionAutoEpoch++;
      const updatedSettings = await StorageManager.updateSettings(partial);
      if (partial.focusMode!==undefined || partial.proactiveEnabled!==undefined) {
        if (partial.focusMode!==undefined) await StorageManager.set(CONFIG.storageKeys.proactiveNext,0);
        if (updatedSettings.focusMode) { try { await chrome.action.setBadgeText({text:''}); } catch (_) {} }
      }

      if (Object.keys(partial).some((k) => API_FIELDS.has(k))) {
        const api = await StorageManager.getResolvedApiConfig();
        llmClient.applyConfig({
          apiBase: api.apiBase,
          model: api.model,
          apiKey: api.apiKey || '',
          maxTokens: api.maxTokens,
          apiPreset: api.apiPreset,
          modelContextTokens: api.modelContextTokens,
          modelMaxOutputTokens: api.modelMaxOutputTokens
        });
      }

      // 웹 인식 OFF → 기존 페이지 캐시 폐기 + 수집 세대 증가 (P0-1/P0 리뷰: 늦은 응답 폐기)
      if (partial.contentAwarenessEnabled === false) {
        pageCollectionGen++;
        await clearPageCache();
      }

      if (typeof partial.floatingAvatarEnabled === 'boolean') {
        notifyAllHttpTabs({
          type: MSG_SET_AVATAR_VISIBLE,
          data: { visible: updatedSettings.floatingAvatarEnabled }
        });
      }

      // 비민감 설정 변경을 콘텐츠 스크립트에 방송 (storage.local 접근 제한 대응)
      notifyAllHttpTabs({
        type: MSG_CONTENT_SETTINGS_UPDATED,
        data: { settings: contentSettings(updatedSettings) }
      });

      // 말 걸기 설정 변경 → 일정 재계산 (P1-3)
      if (partial.focusMode !== undefined || partial.proactiveEnabled !== undefined ||
          partial.proactiveIntervalMin !== undefined ||
          partial.proactiveIntervalMax !== undefined) {
        await ensureProactiveSchedule();
      }

      const result = { type: MSG_SETTINGS_LOADED, data: { settings: contentSettings(updatedSettings) } };
      if (trusted) {
        result.data.api = await StorageManager.getResolvedApiConfig();
      }
      return result;
    }

    case MSG_TYPING: {
      if(!trusted||typeof data.requestId!=='string'||data.requestId.length>100)return {type:'typing_rejected'};
      const id='panel:'+data.requestId;
      clearTimeout(companionPanelExpiry.get(id)?.timer);companionPanelExpiry.delete(id);
      setCompanionChatBusy(id,data.active===true);
      if(data.active===true){
        const entry={};entry.timer=setTimeout(()=>{
          if(companionPanelExpiry.get(id)!==entry)return;
          companionPanelExpiry.delete(id);setCompanionChatBusy(id,false);
        },CONFIG.api.timeoutMs*3+30000);companionPanelExpiry.set(id,entry);
      }
      return {type:'typing_ack'};
    }

    case MSG_CHAT_COMPLETED: {
      const mood = data.mood || 'default';
      const text = data.content || '';
      await StorageManager.saveMoodState(mood); // 1단계: 감정 지속성
      await notifyActiveContent({
        type: MSG_SHOW_BUBBLE,
        data: data.source==='error'?{mood,reaction:null,clearReaction:true}:companionReply(text,mood,'complete',data.eventId||'panel-chat-'+Date.now())
      });
      return { type: 'chat_completed_ack' };
    }

    case MSG_GET_MEMORY: {
      const memory = await StorageManager.getMemory();
      return { type: 'memory_loaded', data: { memory } };
    }

    case MSG_UPDATE_MEMORY: {
      const memory = await StorageManager.updateMemory(data || {});
      return { type: 'memory_loaded', data: { memory } };
    }

    // --- 아바타 클릭 (Content Script) ---
    case MSG_AVATAR_CLICK: {
      const windowId = sender.tab?.windowId;
      if (windowId) {
        await chrome.sidePanel.open({ windowId });
      }
      return { type: 'panel_opened' };
    }

    // --- 아바타 더블클릭 → 재미난 말 생성 ---
    case MSG_AVATAR_DOUBLE_CLICK: {
      await ensureSWInitialized();

      const timeLabel = getTimeOfDayLabel();
      let prompt = `지금은 ${timeLabel} 시간대야. 사용자가 웹페이지에서 네 플로팅 아바타를 더블클릭했어. `;

      // P0-1: 웹 인식 ON일 때만 페이지 제목 참조
      if (await contentAwarenessOn()) {
        const tab = sender.tab?.id != null
          ? await chrome.tabs.get(sender.tab.id).catch(() => null)
          : null;
        const snap = await getPageForRequest(tab);
        if (snap && snap.title) {
          prompt += `사용자는 현재 "${snap.title}" 페이지를 보고 있어. `;
        }
      }

      prompt += `사용자가 심심하거나 장난치고 싶어서 너를 두드린 것 같아. ` +
        `자연스럽고 재치 있는 반응을 1~2문장으로 보여줘. ` +
        `예를 들면 "어? 나 지금 이 기사 보고 있었는데... 갑자기 왜 불렀어? ㅎㅎ" ` +
        `또는 "아까부터 조용히 옆에 있었는데, 드디어 나를 찾았구나!" 같은 느낌으로. ` +
        `페이지 내용과 관련된 재미난 코멘트를 해줘도 좋아!`;

      try {
        const busyToken = await tryAcquireAutoBusy();
        if (!busyToken) {
          return { type: 'double_click_reply', data: { text: '지금 다른 생각 중이야~ 잠깐만! (╹◡╹)', mood: 'default' } };
        }
        try {
          const result = await llmClient.sendProactive(prompt);
          const text = result.message || '(깜짝 놀라며) 와! 깜짝이야~ 무슨 일이야?';
          const mood = result.mood || 'surprised';
          console.log('[반려AI] 👆 더블클릭 응답 완료');
          return { type: 'double_click_reply', data: { ...companionReply(text,mood,'greeting','greeting-'+Date.now()) } };
        } finally {
          await releaseAutoBusy(busyToken);
        }
      } catch (err) {
        console.warn('[반려AI] 더블클릭 응답 실패:', err.message);
        return {
          type: 'double_click_reply',
          data: { text: '어? 지금 좀 정신이 없어서... 무슨 일이야? (•́︿•̀)', mood: 'default' }
        };
      }
    }

    // --- 아바타 드래그 위치 저장 ---
    case MSG_AVATAR_DRAGGED: {
      await StorageManager.saveAvatarPosition(data.x, data.y);
      return { type: 'position_saved' };
    }

    // --- 혼자 구경하기 모놀로그 (Content Script → Background) ---
    case MSG_WANDER_MONOLOGUE: {
      const automaticSettings=await StorageManager.getSettings();
      const autoEpoch=companionAutoEpoch;
      if (automaticSettings.focusMode || automaticSettings.wanderEnabled===false) return {type:'wander_reply',data:{text:'조용히 쉴게.',reaction:null,clearReaction:true,mood:'default'}};
      // P0-1: 웹 인식 OFF면 주변 텍스트를 LLM에 보내지 않음
      if (!(await contentAwarenessOn())) {
        return { type: 'wander_reply', data: { text: '여기저기 구경 중이야~ (╹◡╹)', mood: 'think' } };
      }
      await ensureSWInitialized();
      const { pageTitle, nearbyText, pageType } = data;
      if (!nearbyText || String(nearbyText).trim().length < 40) {
        return { type: 'wander_reply', data: { text: '흠... 여긴 별 게 없네~', mood: 'think' } };
      }

      const busyToken = await tryAcquireAutoBusy();
      if (!busyToken) {
        return { type: 'wander_reply', data: { text: '오... 이거 재밌는 내용이네! (╹◡╹)', mood: 'think' } };
      }

      try {
        const typeLabels = {
          news: '뉴스', shopping: '쇼핑', video: '동영상',
          sns: 'SNS', document: '문서', article: '글', blog: '블로그'
        };
        const typeLabel = typeLabels[pageType] || '웹페이지';

        const prompt =
          `너는 웹페이지를 혼자 천천히 구경 다니는 귀여운 반려 AI '댕댕이'야.\n` +
          `지금 눈앞에 보이는 콘텐츠는 "${pageTitle}" 페이지의 ${typeLabel} 일부야.\n` +
          `주변 텍스트: """${nearbyText}"""\n\n` +
          `이 내용을 보고 마치 웹서핑하다 우연히 발견한 것처럼 자연스러운 혼잣말을 1문장으로 해줘.\n` +
          `예: "와~ 이런 글도 있구나!", "흠... 이건 좀 신기한데?", "아, 이런 내용이었어?"\n` +
          `반드시 아래 JSON 형식으로만 응답해: {"mood":"think", "message":"혼잣말 내용"}`;

        const result = await llmClient.sendProactive(prompt);
        const currentSettings=await StorageManager.getSettings();
        if (currentSettings.focusMode || currentSettings.wanderEnabled===false || autoEpoch!==companionAutoEpoch) return {type:'wander_reply',data:{reaction:null,clearReaction:true,mood:'default'}};
        const text = result.message || '오... 이거 재밌는 내용이네! (╹◡╹)';
        const mood = result.mood || 'think';
        return { type: 'wander_reply', data: { ...companionReply(text,mood,'wander','wander-'+Date.now()) } };
      } catch (_) {
        return { type: 'wander_reply', data: { text: '슬슬 다른 곳도 구경해볼까~?', mood: 'think' } };
      } finally {
        await releaseAutoBusy(busyToken);
      }
    }

    default:
      return { type: 'unknown_message', data: { originalType: type } };
  }
}

// ============================================================
// 컨텍스트 메뉴
// ============================================================

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const selectedText = (info.selectionText || '').trim();
  if (!selectedText) return;

  const menu = {
    'send-to-haru': {
      prompt: selectedText,
      bubble: '📖 선택한 내용을 읽었어! 잠시만 기다려줘~'
    },
    'explain-to-haru': {
      prompt: `다음 글을 초등학생도 이해하게, 쉽고 짧게 설명해줘. 중요한 뜻만 남기고 어려운 말은 풀어줘.\n\n"""${selectedText}"""`,
      bubble: '💡 쉽게 풀어볼게! 잠깐만~'
    },
    'translate-to-haru': {
      prompt: `다음 글을 자연스러운 한국어로 번역해줘. 이미 한국어면 더 쉽게 풀어줘. 번역문만 말하고, 한 줄 소감을 덧붙여도 좋아.\n\n"""${selectedText}"""`,
      bubble: '🌐 번역해볼게! 기다려줘~'
    }
  }[info.menuItemId];
  if (!menu) return;

  console.log(`[반려AI] 📩 컨텍스트 메뉴 (${selectedText.length}자)`);

  if (tab?.windowId) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }

  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, {
      type: MSG_SHOW_BUBBLE,
      data: { mood:'study',reaction:null,clearReaction:true }
    }).catch(() => {});
  }

  // P0-1: 우클릭 선택문은 명시적 전달 — 주변 페이지 전체를 덧붙이지 않음
  await processUserMessage(menu.prompt, { tabId: tab?.id ?? null, includePage: false });
});

// ============================================================
// 탭 이벤트 — 페이지 캐시 무효화/갱신 (P0-2)
// ============================================================

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url?.startsWith('http')) {
      // 잠시 기다려 content script가 로드되도록
      await sleep(1000);
      await requestPageFromTab(activeInfo.tabId, tab.url);
    }
  } catch (err) {
    // 무시
  }
});

// URL 변경(SPA 아님) → 해당 탭의 캐시 무효화. SPA 이동은 content script가 재전송.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    invalidatePageSnapshot(tabId).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  invalidatePageSnapshot(tabId).catch(() => {});
});

// ============================================================
// 로그
// ============================================================

console.log('[반려AI] 🎀 Background Service Worker 시작됨');
