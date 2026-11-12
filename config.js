// ============================================================
// config.js — 반려 AI 설정 상수 및 기본값
// ============================================================

const CONFIG = {
  // --- API 프리셋 (빠른 전환용) ---
  apiPresets: {
    deepseek: {
      label: '🔧 DeepSeek V4',
      apiBase: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      apiKey: '',  // 사용자 입력 필요
      description: 'DeepSeek V4 Flash — 빠르고 경제적인 개발용'
    },
    moip: {
      label: '🚀 gpt-oss-120b',
      apiBase: 'https://llm.moip.go.kr/api/v1',
      model: 'gpt-oss-120b',
      apiKey: '',
      description: 'gpt-oss-120b — moip.go.kr 프로덕션'
    },
    openrouter: {
      label: '🌐 OpenRouter',
      apiBase: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4',
      apiKey: '',
      description: 'OpenRouter — 다양한 모델 중계'
    },
    ollama: {
      label: '🏠 Ollama (로컬)',
      apiBase: 'http://localhost:11434/v1',
      model: 'llama3',
      apiKey: 'ollama',
      description: '로컬 LLM — 인터넷 없이 사용 가능'
    },
    exaone: {
      label: 'LG EXAONE (K-EXAONE 2.5)',
      apiBase: 'https://api.exaone.ai/v1',
      model: 'k-exaone_v2.5',
      apiKey: '',
      description: 'LG EXAONE · 텍스트 전용. 생성 예산에 추론 토큰이 포함됩니다.'
    },
    openai: {
      label: '🤖 OpenAI',
      apiBase: 'https://api.openai.com/v1',
      model: 'gpt-6-luna',
      apiKey: '',
      description: 'OpenAI GPT-6 Luna — 효율적인 대화·업무·코드 생성'
    },
    custom: {
      label: '✏️ 사용자 정의',
      apiBase: '',
      model: '',
      apiKey: '',
      description: '직접 입력한 API 사용'
    }
  },

  // --- API 요청 설정 ---
  api: {
    temperature: 0.85,
    maxTokens: 25000,
    timeoutMs: 90000,
    retries: 2,
    retryBackoffMs: 1000
  },

  // --- 주기적 말 걸기 타이밍 ---
  proactive: {
    minIntervalMinutes: 15,
    maxIntervalMinutes: 30,
    contentCheckMinutes: 5,
    bubbleAutoHideMs: 8000
  },

  // --- 컨텍스트 / 토큰 관리 ---
  // maxContextTokens: 대화 이력 전용 예산 (시스템/페이지/현재 입력은 별도)
  context: {
    maxStoredMessages: 200,
    maxContextMessages: 80,
    maxContextTokens: 16000,
    maxHistoryMessageChars: 4000,
    pageContentMaxChars: 5000,    // 기본값, 설정에서 조절 가능
    charsPerTokenEstimate: 4      // UI 표시용 (실제 추정은 estimateTokens의 보수적 계산 사용)
  },

  // --- 모델별 컨텍스트/출력 상한 ---
  // 확인 가능한 제공자 정보 우선, 모를 때는 사용자가 조절 가능한 보수적 기본값.
  // 입력 예상 토큰 + 출력 예약 + 안전 여유 <= modelContextTokens 를 항상 지킨다.
  modelLimits: {
    // 모델명 → { contextTokens, maxOutputTokens } (정확한 값은 제공자 문서 확인)
    known: {
      'gpt-oss-120b': { contextTokens: 65536, maxOutputTokens: 16384 },
      'gpt-4o-mini': { contextTokens: 128000, maxOutputTokens: 16384 },
      'anthropic/claude-sonnet-4': { contextTokens: 200000, maxOutputTokens: 64000 },
      'deepseek-v4-flash': { contextTokens: 65536, maxOutputTokens: 8192 }
    },
    // 공식 Luna 상한. 사용자 설정과 앱의 요청별 생성 예산은 별도로 더 낮게 제한한다.
    openaiLuna: { contextTokens: 1050000, maxOutputTokens: 128000 },
    defaultContextTokens: 32768,   // 모르는 모델의 보수적 컨텍스트 상한
    defaultMaxOutputTokens: 8192,  // 모르는 모델의 보수적 출력 상한
    safetyMarginRatio: 0.08,       // 안전 여유 (8%)
    chatMaxOutputTokens: 1200      // 짧은 일상 대화·혼잣말의 출력 예산
  },

  // --- 스토리지 키 ---
  storageKeys: {
    messages: 'messages',
    settings: 'settings',          // 비민감 설정 (아바타·테마 등 — apiKey 미포함)
    apiSettings: 'api_settings',   // apiPreset/apiBase/model/maxTokens 등 API 구성
    apiKeys: 'api_keys',           // { 정규화된 origin: apiKey } — 제공자별 분리
    historyEpoch: 'history_epoch', // 대화 초기화 세대 표식 (경쟁 조건 방지)
    avatarPosition: 'avatar_position',
    lastActive: 'last_active',
    memory: 'companion_memory',
    codeSession: 'code_session',
    kiprisKey: 'kipris_plus_key',
    lastAppMode: 'last_app_mode',
    proactiveNext: 'proactive_next_at', // 다음 말 걸기 실행 시각 (영속)
    pageCache: 'page_cache_by_tab' // tabId → 페이지 스냅샷 (chrome.storage.session)
  },

  wander: {
    minIntervalSec: 60,
    maxIntervalSec: 180
  }
};

// 기본 설정 (chrome.storage에 저장되는 형태) — 비민감 값만. API 값은 DEFAULT_API_SETTINGS 참조
const DEFAULT_SETTINGS = {
  // 기능 토글 — 배포 기본값: 모두 OFF (사용자가 켜면 그 값이 저장·유지됨)
  proactiveEnabled: false,
  contentAwarenessEnabled: false,
  sendMemoryToModel: false,
  approachEnabled: false,
  wanderEnabled: false,
  speechBubblesEnabled: false,
  floatingAvatarEnabled: false,
  poseCollapsed: false,
  movementLevel: 'normal',
  focusMode: false,
  onboardingDismissed: false,

  // 타이밍
  proactiveIntervalMin: 15,
  proactiveIntervalMax: 30,
  wanderIntervalMin: 60,
  wanderIntervalMax: 180,

  theme: 'auto'
};

// API 관련 설정 (민감 정보와 분리 보관: CONFIG.storageKeys.apiSettings)
const DEFAULT_API_SETTINGS = {
  apiPreset: 'deepseek',
  apiBase: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  maxTokens: 25000,              // 사용자 요청 기본값(의미 유지). 실제 요청은 예산에 맞게 조정됨
  pageContentMaxChars: 5000,     // 웹페이지 읽기 최대 글자 수 (설정에서 500~20000 조절)
  modelContextTokens: 32768,     // 모델 컨텍스트 상한 (모르는 모델의 보수적 기본값, 설정에서 조절)
  modelMaxOutputTokens: 8192     // 모델 최대 출력 상한 (보수적 기본값, 설정에서 조절)
};

const DEFAULT_MEMORY = {
  userName: '',
  likes: [],
  dislikes: [],
  notes: [],
  updatedAt: ''
};
