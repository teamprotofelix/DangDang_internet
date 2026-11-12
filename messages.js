// ============================================================
// messages.js — 컴포넌트 간 메시지 타입 상수
// ============================================================

// --- Side Panel → Background ---
const MSG_SEND_MESSAGE     = 'user_message';
const MSG_GET_HISTORY      = 'get_history';
const MSG_CLEAR_HISTORY    = 'clear_history';
const MSG_UPDATE_SETTINGS  = 'update_settings';
const MSG_GET_SETTINGS     = 'get_settings';
const MSG_WANDER_MONOLOGUE = 'wander_monologue';   // 혼자 구경하기 모놀로그
const MSG_CHAT_COMPLETED   = 'chat_completed';     // 사이드패널 스트리밍 완료
const MSG_GET_MEMORY       = 'get_memory';
const MSG_UPDATE_MEMORY    = 'update_memory';

// --- Content Script → Background ---
const MSG_PAGE_CONTENT     = 'page_content';
const MSG_AVATAR_CLICK     = 'avatar_click';
const MSG_AVATAR_DRAGGED   = 'avatar_dragged';
const MSG_AVATAR_DOUBLE_CLICK = 'avatar_double_click';

// --- Background → Content Script ---
const MSG_SHOW_BUBBLE      = 'show_bubble';
const MSG_UPDATE_MOOD      = 'update_mood';
const MSG_SET_AVATAR_VISIBLE = 'set_avatar_visible';
const MSG_CONTENT_SETTINGS_UPDATED = 'content_settings_updated'; // 비민감 설정 방송 (storage.local 접근 제한 대응)

// --- Background → Side Panel ---
const MSG_NEW_MESSAGE      = 'new_message';
const MSG_HISTORY_LOADED   = 'history_loaded';
const MSG_SETTINGS_LOADED  = 'settings_loaded';
const MSG_TYPING           = 'typing';
const MSG_ERROR            = 'error';

// --- 업무 모드 실행 상태 (P0-5: idle/running/succeeded/failed/timed_out/cancelled) ---

// --- 페이지 컨텍스트 (탭별 격리) ---
const MSG_REQUEST_PAGE_CONTENT = 'request_page_content'; // Background → Content
const MSG_PAGE_CONTENT_SENT    = 'page_content_sent';

// --- Message factories ---
function createMessage(type, data = {}) {
  return { type, data, timestamp: Date.now() };
}

function createPageContent(content) {
  return createMessage(MSG_PAGE_CONTENT, content);
}
