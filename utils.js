// ============================================================
// utils.js — 공통 유틸리티 함수
// ============================================================

/**
 * min 이상 max 미만의 랜덤 정수 반환
 */
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min)) + min;
}

/**
 * 현재 시간 기준 시간대 문자열 반환
 * @returns {'morning'|'afternoon'|'evening'|'night'}
 */
function getTimeOfDay(date = new Date()) {
  const hour = date.getHours();
  if (hour >= 6 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

/**
 * 시간대별 한글 라벨
 */
function getTimeOfDayLabel(date = new Date()) {
  const labels = {
    morning: '아침',
    afternoon: '오후',
    evening: '저녁',
    night: '밤'
  };
  return labels[getTimeOfDay(date)];
}

/**
 * ISO 8601 타임스탬프 생성
 */
function nowISO() {
  return new Date().toISOString();
}

/**
 * 고유 ID 생성 (타임스탬프 기반)
 */
function generateId() {
  return 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
}

/**
 * 보수적인 토큰 수 추정.
 * 한글은 토큰당 ~1자로 잡아 과대 추정(안전)하고, 그 외 문자는 4자/토큰.
 * 문자/4 단순 계산은 한글에서 과소 추정되어 예산 초과 위험이 있다.
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  const hangul = (s.match(/[가-힣ㄱ-ㅣ]/g) || []).length;
  const other = s.length - hangul;
  // 한글 1자/토큰(보수적) + 기타 4자/토큰 + 메시지 오버헤드
  return hangul + Math.ceil(other / 4) + 4;
}

/**
 * API 주소를 정규화된 origin으로 변환 (API 키 저장 키로 사용)
 * 실패 시 원문에서 스킴까지 소문자 정규화한 값을 반환
 */
function normalizeApiOrigin(apiBase) {
  if (!apiBase) return '';
  try {
    const url = new URL(apiBase);
    return url.origin.toLowerCase();
  } catch {
    return String(apiBase).toLowerCase().replace(/\/+$/, '');
  }
}

function isExaone(apiConfig) {
  try {
    return new URL(apiConfig.apiBase).origin === 'https://api.exaone.ai'
      && apiConfig.model === 'k-exaone_v2.5';
  } catch { return false; }
}

/** 공식 OpenAI Chat Completions 계약만 적용한다. 프리셋 ID/중계 모델명은 근거가 아니다. */
function isOpenAILuna(apiConfig) {
  if (apiConfig?.model !== 'gpt-6-luna') return false;
  try {
    const url = new URL(apiConfig.apiBase);
    return url.origin === 'https://api.openai.com'
      && url.pathname.replace(/\/+$/, '') === '/v1'
      && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}

/**
 * 요청별 토큰 예산 계산 (P0-4).
 * 입력 = 시스템 + 페르소나 + 기억 + 페이지/첨부 + 대화 이력 + 현재 지시 + 부가량
 * 입력 예상 토큰 + 출력 예약 토큰 + 안전 여유 <= 모델 컨텍스트 상한 을 강제한다.
 * @param {object} opts { apiConfig, messages, outputReserveTokens }
 * @returns {{contextLimit:number, maxOutput:number, margin:number,
 *            inputTokens:number, maxInputTokens:number, ok:boolean}}
 */
function computeRequestBudget({ apiConfig, messages = [], outputReserveTokens = 0 }) {
  const limits = CONFIG.modelLimits || {};
  const known = limits.known?.[apiConfig?.model];
  let contextLimit = Number(apiConfig?.modelContextTokens)
    || known?.contextTokens
    || limits.defaultContextTokens
    || 32768;
  let modelMaxOut = Number(apiConfig?.modelMaxOutputTokens)
    || known?.maxOutputTokens
    || limits.defaultMaxOutputTokens
    || 8192;
  if (isOpenAILuna(apiConfig)) {
    contextLimit = Math.min(contextLimit, limits.openaiLuna.contextTokens);
    modelMaxOut = Math.min(modelMaxOut, limits.openaiLuna.maxOutputTokens);
  }
  if (isExaone(apiConfig)) {
    contextLimit = Math.min(contextLimit, 524288);
    modelMaxOut = Math.min(modelMaxOut, contextLimit - 1);
  }
  // 생성 예약에 추론도 포함된다. 추론용 별도 예약을 더하지 않는다.
  const maxOutput = Math.max(256, Math.min(modelMaxOut, outputReserveTokens));
  const margin = Math.ceil(contextLimit * (limits.safetyMarginRatio ?? 0.08));
  const inputTokens = messages.reduce((sum, m) => sum + estimateTokens(m?.content || ''), 0);
  const maxInputTokens = Math.max(0, contextLimit - maxOutput - margin);
  return {
    contextLimit,
    maxOutput,
    margin,
    inputTokens,
    maxInputTokens,
    ok: inputTokens <= maxInputTokens
  };
}

/**
 * 최종 요청 전체를 예산 안으로 강제 축소 (P0-4 리뷰 보완).
 * 시스템 메시지는 유지하고, 뒤쪽 메시지부터 잘라내며 명시적 마커를 남긴다.
 * @returns {{messages, budget, trimmed: boolean|'hard'}}
 *   trimmed='hard': 시스템 지시 자체가 예산을 넘음 (호출부에서 오류 처리)
 */
function enforceRequestBudget({ apiConfig, messages, outputReserveTokens }) {
  const b0 = computeRequestBudget({ apiConfig, messages, outputReserveTokens });
  if (b0.ok) return { messages, budget: b0, trimmed: false };

  const out = messages.map((m) => ({ ...m }));
  let over = b0.inputTokens - b0.maxInputTokens;

  for (let i = out.length - 1; i >= 0 && over > 0; i--) {
    const m = out[i];
    if (m.role === 'system' || !m.content) continue;
    const t = estimateTokens(m.content);
    if (t <= over) {
      m.content = '(내용 생략: 예산 초과)';
      over -= t - estimateTokens(m.content);
    } else {
      const keepTokens = t - over;
      // 한글 1자=1토큰 보수적 기준으로 1:1 환산 — 과대 축소는 있지만 초과는 없음
      // (마커 분량 여유 40자 추가 확보)
      const maxChars = Math.max(40, Math.floor(keepTokens) - 40);
      m.content = truncateText(m.content, maxChars) + '\n…(예산 초과로 일부 생략됨)';
      over = 0;
    }
  }

  // 재검증: 그래도 초과면 한 번 더 축소 (시스템만 남으면 'hard')
  const b1a = computeRequestBudget({ apiConfig, messages: out, outputReserveTokens });
  if (b1a.inputTokens > b1a.maxInputTokens) {
    over = b1a.inputTokens - b1a.maxInputTokens;
    for (let i = out.length - 1; i >= 0 && over > 0; i--) {
      const m = out[i];
      if (m.role === 'system' || !m.content) continue;
      const t = estimateTokens(m.content);
      if (t <= over) {
        m.content = '(내용 생략: 예산 초과)';
        over -= t - estimateTokens(m.content);
      } else {
        m.content = truncateText(m.content, Math.max(40, Math.floor(t - over) - 40)) + '\n…(예산 초과로 일부 생략됨)';
        over = 0;
      }
    }
  }

  const b1 = computeRequestBudget({ apiConfig, messages: out, outputReserveTokens });
  return {
    messages: out,
    budget: b1,
    trimmed: b1.inputTokens > b1.maxInputTokens ? 'hard' : true
  };
}

/**
 * 키의 origin 소속 검사 (P0 리뷰 2차):
 * - 후보 키가 현재 origin의 저장 키와 같으면 그대로 사용
 * - 후보 키가 "다른 origin에 저장된 키"와 같으면 빈 문자열 (전송 차단)
 * - 그 외(새로 입력한 키)는 그대로 사용
 */
function resolveKeyForOrigin(keys, origin, candidateKey) {
  if (!candidateKey) return '';
  if (keys && typeof keys === 'object' && keys[origin] === candidateKey) return candidateKey;
  if (keys && typeof keys === 'object' &&
      Object.values(keys).some((k) => k === candidateKey)) {
    return ''; // 다른 origin 소속 키가 주소 변경으로 따라온 경우
  }
  return candidateKey;
}

/**
 * 대화 세대 불일치 검사: 요청 시작 시점 epoch와 현재 epoch가 다르면
 * 초기화가 끼어든 것 — 응답 저장·표시를 하지 않는다 (P1 리뷰 2차).
 */
function isEpochStale(requestEpoch, currentEpoch) {
  return requestEpoch !== undefined && requestEpoch !== null && requestEpoch !== currentEpoch;
}

/**
 * 기분 자연 감쇠 (1단계: 감정 지속성).
 * 시간이 지나면 격한 감정이 차분한 감정으로 돌아간다.
 * @param {string} mood 정식 mood 키
 * @param {number} elapsedMinutes 경과 분
 */
const MOOD_DECAY_RULES = [
  { from: 'excited', to: 'smile', afterMinutes: 10 },
  { from: 'smile', to: 'default', afterMinutes: 30 },
  { from: 'aegyo', to: 'default', afterMinutes: 20 },
  { from: 'blush', to: 'default', afterMinutes: 20 },
  { from: 'surprised', to: 'default', afterMinutes: 15 },
  { from: 'tremble', to: 'default', afterMinutes: 30 },
  { from: 'sad', to: 'default', afterMinutes: 60 },
  { from: 'think', to: 'default', afterMinutes: 45 },
  { from: 'yawn', to: 'default', afterMinutes: 30 },
  { from: 'study', to: 'default', afterMinutes: 120 },
  { from: 'sleepy', to: 'default', afterMinutes: 90 }
];

function decayMood(mood, elapsedMinutes) {
  let current = (typeof normalizeMood === 'function' ? normalizeMood(mood) : null) || 'default';
  const minutes = Math.max(0, Number(elapsedMinutes) || 0);
  for (const rule of MOOD_DECAY_RULES) {
    if (current === rule.from && minutes >= rule.afterMinutes) current = rule.to;
  }
  return current;
}

/**
 * 확장 내부 페이지(사이드 패널 등)에서 온 runtime 메시지인지 검사.
 * 콘텐츠 스크립트(sender.tab 존재)와 외부 확장은 신뢰하지 않는다.
 */
function isTrustedExtensionUI(sender) {
  if (!sender) return false;
  if (sender.id !== chrome.runtime.id) return false;
  const url = String(sender.url || '');
  return url.startsWith(chrome.runtime.getURL(''));
}

/**
 * 텍스트를 주어진 문자 수로 자르기 (말줄임표 추가)
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function truncateText(text, maxChars) {
  if (!text || text.length <= maxChars) return text || '';
  return text.substring(0, maxChars) + '...';
}

/**
 * 안전한 JSON 파싱 (실패 시 null 반환)
 */
function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * ms 동안 대기하는 Promise
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 페이지 URL에서 도메인 추출
 */
function extractDomain(url) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return '';
  }
}

/**
 * 날짜 포맷 (한국어)
 * @param {string|Date} date
 * @returns {string} 예: "오후 3:42"
 */
function formatTime(date) {
  const d = typeof date === 'string' ? new Date(date) : date;
  const hours = d.getHours();
  const minutes = d.getMinutes().toString().padStart(2, '0');
  const ampm = hours < 12 ? '오전' : '오후';
  const h = hours % 12 || 12;
  return `${ampm} ${h}:${minutes}`;
}

/**
 * 스트리밍 중인 JSON 응답에서 사용자에게 보여줄 message만 추출
 */
function extractStreamingVisibleText(accumulated) {
  if (!accumulated) return '';
  const key = accumulated.match(/"message"\s*:\s*"/);
  if (key) {
    const start = key.index + key[0].length;
    let out = '';
    let escape = false;
    for (let i = start; i < accumulated.length; i++) {
      const ch = accumulated[i];
      if (escape) {
        out += ch === 'n' ? '\n' : ch;
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') break;
      out += ch;
    }
    return out;
  }
  const trimmed = accumulated.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('```')) return '';
  return accumulated;
}

/**
 * 사용자 말에서 장기 기억 힌트 추출 (보수적)
 */
function extractMemoryHints(text) {
  const hints = { userName: '', likes: [], dislikes: [], notes: [] };
  if (!text || typeof text !== 'string' || text.length > 400) return hints;

  const nameMatch = text.match(/(?:내 이름은|나는|저는)\s*([가-힣A-Za-z]{2,10})(?:이야|예요|이에요|입니다|야)(?:요)?/);
  if (nameMatch) hints.userName = nameMatch[1];

  const callMe = text.match(/(?:나를|날)\s*([가-힣A-Za-z]{2,10})\s*(?:라고|이라(?:고)?)\s*불러/);
  if (callMe) hints.userName = callMe[1];

  const likeMatch = text.match(/(?:난|나|저는)?\s*([가-힣A-Za-z0-9 ]{2,16}?)\s*(?:좋아해|좋아|최애야|제일 좋아)/);
  if (likeMatch && likeMatch[1].length < 18) hints.likes.push(likeMatch[1].trim());

  const hateMatch = text.match(/(?:난|나|저는)?\s*([가-힣A-Za-z0-9 ]{2,16}?)\s*(?:싫어해|싫어|질색|별로야)/);
  if (hateMatch && hateMatch[1].length < 18) hints.dislikes.push(hateMatch[1].trim());

  return hints;
}

function mergeMemoryHints(memory, hints) {
  const next = {
    ...memory,
    likes: [...(memory.likes || [])],
    dislikes: [...(memory.dislikes || [])],
    notes: [...(memory.notes || [])]
  };
  if (hints.userName) next.userName = hints.userName;
  for (const item of hints.likes || []) {
    if (item && !next.likes.includes(item)) next.likes.push(item);
  }
  for (const item of hints.dislikes || []) {
    if (item && !next.dislikes.includes(item)) next.dislikes.push(item);
  }
  next.likes = next.likes.slice(-12);
  next.dislikes = next.dislikes.slice(-12);
  next.notes = next.notes.slice(-20);
  return next;
}

function needsApiKey(settings) {
  if (!settings) return true;
  const base = settings.apiBase || '';
  if (settings.apiPreset === 'ollama') return false;
  if (/localhost|127\.0\.0\.1/.test(base)) return false;
  return true;
}

function hasApiReady(settings) {
  if (!settings || !settings.apiBase || !settings.model) return false;
  if (!needsApiKey(settings)) return true;
  return !!(settings.apiKey && String(settings.apiKey).trim());
}

/**
 * 페이지 타입 감지
 */
function detectPageType(url, text) {
  const urlLower = (url || '').toLowerCase();
  const textLower = (text || '').toLowerCase();

  // 도메인 기반 빠른 판단
  const domain = extractDomain(url);

  const videoDomains = ['youtube.com', 'youtu.be', 'twitch.tv', 'vimeo.com', 'netflix.com', 'bilibili.com'];
  if (videoDomains.some(d => domain.includes(d))) return 'video';

  const shopDomains = ['coupang.com', '11st.co.kr', 'gmarket.co.kr', 'auction.co.kr', 'amazon.com', 'ebay.com', 'shop', 'store', 'mall'];
  if (shopDomains.some(d => domain.includes(d))) return 'shopping';

  const newsDomains = ['naver.com', 'daum.net', 'news.', 'joongang', 'chosun', 'donga', 'hani', 'kbs', 'mbc', 'sbs', 'ytn', 'yonhap'];
  if (newsDomains.some(d => domain.includes(d))) return 'news';

  const snsDomains = ['twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'reddit.com', 'tistory.com', 'brunch.co.kr', 'velog.io', 'medium.com'];
  if (snsDomains.some(d => domain.includes(d))) return 'sns';

  const docsDomains = ['github.com', 'gitlab.com', 'stackoverflow.com', 'wikipedia.org', 'namu.wiki', 'docs.google'];
  if (docsDomains.some(d => domain.includes(d))) return 'document';

  // URL 패턴 기반
  if (urlLower.match(/\/(news|article|story|post|blog|entry)\//)) return 'news';
  if (urlLower.match(/\/(product|item|goods|detail)\//)) return 'shopping';

  // 콘텐츠 내용 기반
  if (textLower.includes('기자') || textLower.includes('특파원') || textLower.includes('보도')) return 'news';
  if (textLower.includes('구매') || textLower.includes('가격') || textLower.includes('배송') || textLower.includes('주문')) return 'shopping';
  if (textLower.includes('댓글') && textLower.length > 1000) return 'sns';
  if (textLower.includes('function') || textLower.includes('class ') || textLower.includes('import ') || textLower.includes('코드')) return 'document';

  // 텍스트 길이 기반
  if (textLower.length > 800 && (textLower.match(/[.!?]/g) || []).length > 15) return 'article';
  if (textLower.length > 500) return 'article';

  return 'general';
}
