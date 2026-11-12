// ============================================================
// moods.js — 기분(Mood) 정의, 파싱, 이미지 경로 매핑
// ============================================================

/**
 * 기분별 메타데이터
 * image: 새 디자인 face 파일명 (assets/runtime/emotions)
 * label: 표시용 이모지
 * anim: CSS 애니메이션 클래스명
 * desc: 한글 설명
 */
const MOODS = {
  default:   { image: 'default-face.webp',   pose: 'default-poster.webp',   label: '😶', anim: 'none',      desc: '기본',   action: '편안히 서서 가끔 눈을 깜빡인다' },
  smile:     { image: 'smile-face.webp',     pose: 'smile-poster.webp',     label: '😊', anim: 'bounce',    desc: '웃는 모습', action: '혀를 살짝 내밀고 기분 좋게 웃고 있다' },
  tremble:   { image: 'tremble-face.webp',   pose: 'tremble-poster.webp',   label: '🥶', anim: 'shake',     desc: '떠는 모습', action: '몸을 낮추고 걱정스러운 눈으로 바라보고 있다' },
  yawn:      { image: 'yawn-face.webp',      pose: 'yawn-poster.webp',      label: '🥱', anim: 'yawnAnim',  desc: '하품하는 모습', action: '입을 크게 벌려 하품한 뒤 입을 다문다' },
  study:     { image: 'study-face.webp',     pose: 'study-poster.webp',     label: '📚', anim: 'none',      desc: '공부하는 모습', action: '책을 앞에 펼치고 집중해서 읽고 있다' },
  aegyo:     { image: 'aegyo-face.webp',     pose: 'aegyo-poster.webp',     label: '🥺', anim: 'wiggle',    desc: '애교있는 모습', action: '앞발을 들어 반갑게 인사하는 자세다' },
  surprised: { image: 'surprised-face.webp', pose: 'surprised-poster.webp', label: '😲', anim: 'pop',       desc: '놀란 모습', action: '깜짝 놀라 눈을 동그랗게 뜨고 있다' },
  sad:       { image: 'sad-face.webp',       pose: 'sad-poster.webp',       label: '😢', anim: 'fade',      desc: '슬픈 모습', action: '귀를 내리고 시선을 낮춘 채 조용히 앉아 있다' },
  think:     { image: 'think-face.webp',     pose: 'think-poster.webp',     label: '🤔', anim: 'none',      desc: '생각하는 모습', action: '고개를 살짝 갸웃하고 앞발을 턱에 대고 생각한다' },
  sleepy:    { image: 'sleepy-face.webp',    pose: 'sleepy-poster.webp',    label: '😴', anim: 'drift',     desc: '졸린 모습', action: '눈꺼풀을 천천히 내리며 졸고 있다' },
  excited:   { image: 'excited-face.webp',   pose: 'excited-poster.webp',   label: '🎉', anim: 'bounce',    desc: '신난 모습', action: '작게 폴짝 뛰고 편안히 내려앉는다' },
  blush:     { image: 'blush-face.webp',     pose: 'blush-poster.webp',     label: '😳', anim: 'glow',      desc: '부끄러운 모습', action: '앞발을 입 근처에 올리고 수줍게 시선을 피한다' }
};

// ============================================================
// 기분별 색상 팔레트 — 사이드 패널 :root CSS 변수에 적용
// ============================================================
const MOOD_COLORS = {
  default:   { primary: '#FFB5C2', primaryDark: '#F08FA0', primaryLight: '#FFE4E9', bg: '#FFF5F7', bubbleAvatar: '#FFF3E0', bubbleAvatarBorder: '#FFE0B2' },
  smile:     { primary: '#FFD54F', primaryDark: '#FFC107', primaryLight: '#FFF8E1', bg: '#FFFDE7', bubbleAvatar: '#FFF8E1', bubbleAvatarBorder: '#FFE082' },
  tremble:   { primary: '#81D4FA', primaryDark: '#4FC3F7', primaryLight: '#E1F5FE', bg: '#F3F8FF', bubbleAvatar: '#E3F2FD', bubbleAvatarBorder: '#90CAF9' },
  yawn:      { primary: '#CE93D8', primaryDark: '#BA68C8', primaryLight: '#F3E5F5', bg: '#FDF8FF', bubbleAvatar: '#F3E5F5', bubbleAvatarBorder: '#CE93D8' },
  study:     { primary: '#A5D6A7', primaryDark: '#81C784', primaryLight: '#E8F5E9', bg: '#F5FFF5', bubbleAvatar: '#E8F5E9', bubbleAvatarBorder: '#A5D6A7' },
  aegyo:     { primary: '#F48FB1', primaryDark: '#EC407A', primaryLight: '#FCE4EC', bg: '#FFF0F5', bubbleAvatar: '#FCE4EC', bubbleAvatarBorder: '#F48FB1' },
  surprised: { primary: '#FF8A65', primaryDark: '#FF7043', primaryLight: '#FBE9E7', bg: '#FFF5F0', bubbleAvatar: '#FFF3E0', bubbleAvatarBorder: '#FFAB91' },
  sad:       { primary: '#90A4AE', primaryDark: '#78909C', primaryLight: '#ECEFF1', bg: '#F5F7FA', bubbleAvatar: '#ECEFF1', bubbleAvatarBorder: '#B0BEC5' },
  think:     { primary: '#B39DDB', primaryDark: '#9575CD', primaryLight: '#EDE7F6', bg: '#F8F6FF', bubbleAvatar: '#EDE7F6', bubbleAvatarBorder: '#B39DDB' },
  sleepy:    { primary: '#FFCC80', primaryDark: '#FFB74D', primaryLight: '#FFF3E0', bg: '#FFFBF0', bubbleAvatar: '#FFF3E0', bubbleAvatarBorder: '#FFCC80' },
  excited:   { primary: '#FFB300', primaryDark: '#FF8F00', primaryLight: '#FFF8E1', bg: '#FFFDE7', bubbleAvatar: '#FFF8E1', bubbleAvatarBorder: '#FFD54F' },
  blush:     { primary: '#EF9A9A', primaryDark: '#E57373', primaryLight: '#FFEBEE', bg: '#FFF0F0', bubbleAvatar: '#FFEBEE', bubbleAvatarBorder: '#EF9A9A' }
};

/**
 * 유효한 mood 값 리스트
 */
const VALID_MOODS = Object.keys(MOODS);

/** LLM이 자주 쓰는 별칭 → 정식 mood 키 */
const MOOD_ALIASES = {
  happy: 'smile', joy: 'smile', glad: 'smile', cheerful: 'smile',
  angry: 'tremble', mad: 'tremble', scared: 'tremble', fear: 'tremble',
  curious: 'think', wondering: 'think', ponder: 'think', hmm: 'think',
  tired: 'sleepy', sleep: 'sleepy', drowsy: 'sleepy',
  bored: 'yawn', boring: 'yawn',
  shocked: 'surprised', wow: 'surprised', amaze: 'surprised',
  cute: 'aegyo', flirty: 'aegyo',
  shy: 'blush', embarrassed: 'blush',
  hype: 'excited', energetic: 'excited',
  '웃음': 'smile', '기쁨': 'smile', '행복': 'smile', '웃는': 'smile',
  '생각': 'think', '고민': 'think', '생각하는': 'think',
  '슬픔': 'sad', '우울': 'sad', '슬픈': 'sad',
  '놀람': 'surprised', '놀란': 'surprised',
  '졸림': 'sleepy', '피곤': 'sleepy', '졸린': 'sleepy',
  '신남': 'excited', '신난': 'excited',
  '부끄': 'blush', '쑥스': 'blush',
  '애교': 'aegyo',
  '화남': 'tremble', '화난': 'tremble',
  '하품': 'yawn', '공부': 'study', '집중': 'study'
};

/**
 * mood 문자열을 정식 키로 정규화. 모르면 null.
 */
function normalizeMood(mood) {
  if (!mood || typeof mood !== 'string') return null;
  const trimmed = mood.trim();
  const lower = trimmed.toLowerCase();
  if (VALID_MOODS.includes(lower)) return lower;
  if (MOOD_ALIASES[lower]) return MOOD_ALIASES[lower];
  if (MOOD_ALIASES[trimmed]) return MOOD_ALIASES[trimmed];
  return null;
}

/**
 * LLM 응답에서 기분(mood) 파싱
 *
 * 우선순위:
 *   1. 중괄호 카운팅으로 정확한 JSON 객체 추출 → { mood: "...", message: "..." }
 *   2. Markdown 코드 블록에서 JSON 추출 → ```json { ... } ```
 *   3. [mood] 브라켓 태그 형식 → [smile] 안녕!
 *   4. 텍스트 키워드 기반 감정 분석
 *   5. Fallback: 'default' (원본 텍스트 그대로 표시)
 *
 * @param {string} responseText - LLM 원본 응답
 * @returns {{ mood: string, message: string }}
 */
function parseMoodFromResponse(responseText) {
  if (!responseText || typeof responseText !== 'string') {
    return { mood: 'default', message: '' };
  }

  const trimmed = responseText.trim();

  // --- Priority 1: 중괄호 카운팅으로 JSON 추출 ---
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace >= 0) {
    const jsonStr = extractBalancedJSON(trimmed, firstBrace);
    if (jsonStr) {
      const parsed = safeJsonParse(jsonStr);
      if (parsed && (parsed.mood || parsed.message || parsed.text)) {
        let message = parsed.message || parsed.text || '';
        if (!message.trim()) {
          const afterJSON = trimmed.substring(firstBrace + jsonStr.length).trim();
          message = afterJSON || '';
        }
        if (!message.trim()) message = trimmed;
        const mood = normalizeMood(parsed.mood)
          || detectMoodByKeywords(message)
          || 'default';
        return { mood, message };
      }
    }
  }

  // --- Priority 2: Markdown 코드 블록에서 JSON 추출 ---
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    const blockContent = codeBlockMatch[1].trim();
    if (blockContent.startsWith('{')) {
      const jsonStr = extractBalancedJSON(blockContent, 0);
      if (jsonStr) {
        const parsed = safeJsonParse(jsonStr);
        if (parsed && (parsed.mood || parsed.message || parsed.text)) {
          let message = parsed.message || parsed.text || '';
          if (!message.trim()) {
            const afterJSON = blockContent.substring(jsonStr.length).trim();
            message = afterJSON || '';
          }
          if (!message.trim()) message = trimmed;
          const mood = normalizeMood(parsed.mood)
            || detectMoodByKeywords(message)
            || 'default';
          return { mood, message };
        }
      }
    }
  }

  // --- Priority 3: [mood] 브라켓 태그 ---
  const bracketMatch = trimmed.match(/^\s*\[(\w+)\]\s*([\s\S]*)$/);
  if (bracketMatch) {
    const mood = normalizeMood(bracketMatch[1]);
    if (mood) {
      return { mood, message: bracketMatch[2].trim() || trimmed };
    }
  }

  // --- Priority 4: 키워드 기반 fallback ---
  const keywordMood = detectMoodByKeywords(trimmed);
  if (keywordMood) {
    return { mood: keywordMood, message: trimmed };
  }

  // --- Priority 5: 완전 실패 — 원본 그대로 ---
  return { mood: 'default', message: trimmed };
}

/**
 * 중괄호 깊이 카운팅으로 균형 잡힌 JSON 문자열 추출
 * 메시지 내부에 } 가 있어도 정확히 매칭되는 지점을 찾는다.
 *
 * @param {string} text 전체 텍스트
 * @param {number} startPos 첫 { 의 위치
 * @returns {string|null} 균형 잡힌 JSON 문자열 또는 null
 */
function extractBalancedJSON(text, startPos) {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startPos; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        // 균형 찾음
        return text.substring(startPos, i + 1);
      }
    }
  }

  return null; // 균형을 찾지 못함
}

/**
 * 키워드 기반 기분 감지 (fallback)
 */
function detectMoodByKeywords(text) {
  const lower = text.toLowerCase();

  const keywordMap = {
    excited:   ['신난다', '와!', '대박', '짱', '최고야', '너무 좋아', 'awesome', 'wow', 'amazing', '축하'],
    smile:     ['좋아', '기뻐', '행복', '고마워', '좋은', 'happy', 'good', 'nice', 'great'],
    blush:     ['부끄', '쪽팔', '수줍', '쑥스', 'embarrassed', 'shy', 'blush'],
    sad:       ['슬퍼', '우울', '속상', '눈물', '힘들', 'sad', 'cry', 'miss you'],
    surprised: ['어머', '세상에', '헉', '진짜', '놀랐', 'wow', 'what', 'really', 'surprise'],
    tremble:   ['무서', '떨려', '긴장', '두려', 'scared', 'afraid', 'nervous', 'cold'],
    sleepy:    ['졸려', '피곤', '잠', '하품', 'sleepy', 'tired', 'yawn'],
    think:     ['음', '글쎄', '생각', '고민', '어떨까', 'think', 'hmm', 'wonder'],
    study:     ['공부', '배우', '읽', 'study', 'learn', 'read', '책'],
    aegyo:     ['앙', '뀨', '해줘', '보고 싶', '사랑', '럽', 'cutie', 'darling'],
    yawn:      ['심심', '지루', '따분', 'bored', 'boring']
  };

  for (const [mood, keywords] of Object.entries(keywordMap)) {
    if (keywords.some(kw => lower.includes(kw))) {
      return mood;
    }
  }

  return null;
}

/**
 * 이미지의 전체 URL 경로 반환 (Chrome Extension 리소스)
 * @param {string} mood - 기분 키
 * @returns {string} chrome-extension://... 이미지 URL
 */
function getImageUrl(mood) {
  const moodData = getMoodData(mood);
  return chrome.runtime.getURL(`assets/runtime/emotions/${moodData.image}`);
}

/**
 * 포즈 이미지 URL (큰 디스플레이용, 300x400)
 */
function getPoseUrl(mood) {
  const moodData = getMoodData(mood);
  return chrome.runtime.getURL(`assets/runtime/emotions/${moodData.pose}`);
}

/**
 * 기분 데이터 가져오기
 */
function getMoodData(mood) {
  return MOODS[normalizeMood(mood) || 'default'];
}
