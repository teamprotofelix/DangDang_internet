// ============================================================
// api.js — OpenAI 호환 LLM 클라이언트
// 모든 OpenAI 호환 API 지원 (DeepSeek, OpenAI, Groq, Ollama 등)
// ============================================================

/** 모든 최종 Chat Completions 본문은 이 함수를 통과한다. */
function buildChatCompletionRequest(apiConfig, messages, options = {}, stream = false) {
  const body = { model: apiConfig.model, messages, stream };
  const requested = options.maxTokens ?? apiConfig.maxTokens ?? CONFIG.api.maxTokens;
  if (isOpenAILuna(apiConfig)) {
    if (!Number.isInteger(requested) || requested <= 0) {
      throw new APIError('생성 예산은 양수여야 합니다.', 400);
    }
    const enforced = enforceRequestBudget({ apiConfig, messages, outputReserveTokens: requested });
    if (enforced.trimmed === 'hard') {
      throw new APIError('모델 컨텍스트 상한을 넘어 요청을 만들 수 없어요.', 400,
        JSON.stringify({ error: { code: 'context_length_exceeded' } }));
    }
    body.messages = enforced.messages;
    // 짧은 테스트/말 걸기 예산은 예산 계산기의 최소 예약(256)보다 작게 유지한다.
    body.max_completion_tokens = Math.floor(Math.min(requested, enforced.budget.maxOutput));
    body.reasoning_effort = options.reasoningEffort ?? 'low';
    if (body.reasoning_effort === 'none') {
      body.temperature = options.temperature ?? CONFIG.api.temperature;
    }
  } else if (isExaone(apiConfig)) {
    if (!Number.isInteger(requested) || requested <= 0) throw new APIError('생성 예산은 양수여야 합니다.', 400);
    const budget = computeRequestBudget({ apiConfig, messages, outputReserveTokens: requested });
    if (!budget.ok) throw new APIError('EXAONE 컨텍스트 상한을 초과했습니다.', 400,
      '{"error":{"code":"context_length_exceeded"}}');
    body.max_tokens = Math.min(requested, budget.maxOutput);
    body.reasoning_effort = ['low', 'high', 'max'].includes(options.reasoningEffort)
      ? options.reasoningEffort : 'low';
    body.temperature = options.temperature ?? 1;
  } else {
    body.max_tokens = requested;
    body.temperature = options.temperature ?? CONFIG.api.temperature;
  }
  return body;
}

function chatCompletionURL(apiConfig) {
  let url;
  try { url = new URL(apiConfig.apiBase); }
  catch { throw new APIError('API 주소 형식을 확인해 주세요.', 422); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback
      && (!apiConfig.apiKey || apiConfig.apiKey === 'ollama')))) {
    throw new APIError('API 주소에 HTTPS를 사용해 주세요. 키 없는 로컬 연결에는 HTTP를 사용할 수 있습니다.', 422);
  }
  const basePath = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  if (apiConfig.apiPreset === 'exaone' && (!isExaone(apiConfig) || basePath !== '/v1')) {
    throw new APIError('EXAONE 주소와 모델이 공식 프리셋과 일치해야 합니다.', 422);
  }
  if (isExaone(apiConfig) && !apiConfig.apiKey) {
    throw new APIError('설정에서 EXAONE API 키를 입력해 주세요.', 422);
  }
  url.pathname = basePath + '/chat/completions';
  return url.href;
}

function retryDelay(header, now = Date.now()) {
  if (!header) return null;
  const ms = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

function waitForRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    function abort() {
      clearTimeout(timer);
      cleanup();
      reject(new APIError('요청을 취소했습니다.', 499));
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** 오류 본문은 최대 16 KiB만 읽고, 원문은 APIError에 보관하지 않는다. */
async function readAPIErrorBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  const limit = 16384;
  let text = '', bytes = 0;
  try {
    while (bytes < limit) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      const part = value.subarray(0, limit - bytes);
      text += decoder.decode(part, { stream: true });
      bytes += part.byteLength;
    }
    await reader.cancel();
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

// 외부 본문/대화/키를 보관하거나 로그에 남기지 않고 진단용 식별자만 취한다.
function parseAPIErrorDetails(responseBody) {
  let error;
  try { error = JSON.parse(String(responseBody).slice(0, 16384))?.error; } catch { return {}; }
  if (!error || typeof error !== 'object') return {};
  const message = typeof error.message === 'string' ? error.message.slice(0, 4096) : '';
  const code = typeof error.code === 'string' && /^[a-z_]{1,64}$/.test(error.code) ? error.code : '';
  const candidate = typeof error.param === 'string' ? error.param
    : message.match(/(?:parameter|argument|option)\s*:?\s*['"]([a-z_]+)['"]/i)?.[1];
  const allowed = ['max_tokens', 'max_completion_tokens', 'max_output_tokens', 'temperature',
    'top_p', 'top_logprobs', 'logprobs', 'reasoning_effort', 'stream', 'model', 'messages',
    'seed', 'stop', 'response_format', 'tools', 'tool_choice', 'frequency_penalty', 'presence_penalty'];
  const param = allowed.includes(candidate) ? candidate : '';
  let kind = 'invalid_request';
  if (/context_length|context_window|too_many_tokens/.test(code)
      || /context (?:length|window)|maximum context|too many tokens/i.test(message)) kind = 'context';
  else if (/model_not_found/.test(code) && /access|permission/i.test(message)) kind = 'model_unavailable';
  else if (/model.*(?:access|permission)|(?:access|permission).*model/i.test(message)
      || /model_access|permission_denied/.test(code)) kind = 'model_access';
  else if (/model_not_found|invalid_model|model_not_available/.test(code)
      || /model.*(?:does not exist|not found|access|permission)|(?:access|permission).*model/i.test(message)) kind = 'model';
  else if (/unsupported_(?:parameter|value)/.test(code)
      || /(?:unsupported|not supported|does not support).*(?:parameter|option|argument)|(?:parameter|option|argument).*not supported/i.test(message)) kind = 'parameter';
  const safeCodes = ['unsupported_parameter', 'unsupported_value', 'context_length_exceeded',
    'context_window_exceeded', 'too_many_tokens', 'model_not_found', 'invalid_model',
    'model_not_available', 'model_access_denied', 'permission_denied', 'invalid_request_error'];
  return { kind, param, code: safeCodes.includes(code) ? code : '' };
}

class LLMClient {

  constructor() {
    this.apiBase = '';
    this.model = '';
    this.apiKey = '';
    this.maxTokens = CONFIG.api.maxTokens;
    this.timeoutMs = CONFIG.api.timeoutMs;
    this.maxRetries = CONFIG.api.retries;
    this.retryBackoffMs = CONFIG.api.retryBackoffMs;
  }

  /**
   * API 설정 적용 (apiBase, model, apiKey, maxTokens 모두)
   * @param {object} config { apiBase, model, apiKey, maxTokens }
   */
  applyConfig(config) {
    if (config.apiBase) this.apiBase = config.apiBase.replace(/\/+$/, '');
    if (config.model)   this.model = config.model;
    if (config.apiKey !== undefined) this.apiKey = config.apiKey;
    if (config.maxTokens !== undefined) this.maxTokens = config.maxTokens;
    this.apiPreset = config.apiPreset ?? 'custom';
    this.modelContextTokens = config.modelContextTokens;
    this.modelMaxOutputTokens = config.modelMaxOutputTokens;
  }

  /**
   * 현재 설정 반환
   */
  getConfig() {
    return {
      apiBase: this.apiBase,
      model: this.model,
      hasApiKey: !!this.apiKey
    };
  }

  /**
   * 채팅 완성 요청 (OpenAI 호환)
   * @param {Array<{role: string, content: string}>} messages
   * @param {object} options { temperature, maxTokens, signal, timeoutMs, bodyTimeoutMs }
   *   - signal: 외부 AbortSignal (취소 연결) — P0-5
   *   - timeoutMs: 요청 시작부터의 총 시간 제한
   *   - bodyTimeoutMs: 응답 헤더 수신 후 본문 읽기 제한 (헤더 후 무한 대기 방지)
   * @returns {Promise<{content: string, raw: object, finishReason: string, truncated: boolean}>}
   */
  async chat(messages, options = {}) {
    if (!this.apiBase) throw new APIError('API 주소가 설정되지 않았어요! 설정에서 입력해주세요.', 0);
    if (!this.model)   throw new APIError('모델명이 설정되지 않았어요! 설정에서 입력해주세요.', 0);

    const url = chatCompletionURL(this);

    const body = buildChatCompletionRequest(this, messages, options, false);

    const totalTimeoutMs = options.timeoutMs ?? this.timeoutMs;
    const bodyTimeoutMs = options.bodyTimeoutMs ?? Math.min(30000, totalTimeoutMs);
    const controller = new AbortController();
    let timeoutId = setTimeout(() => controller.abort(), totalTimeoutMs);
    let bodyTimer = null;
    const onExternalAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', onExternalAbort);
    }

    try {
      const headers = { 'Content-Type': 'application/json' };
      // API 키가 있는 경우에만 Authorization 헤더 추가 (로컬 LLM 등은 불필요)
      if (this.apiKey && this.apiKey !== 'ollama') {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        headers: headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });

      // 오류 응답 본문에도 시간 제한을 적용한다.
      bodyTimer = setTimeout(() => controller.abort(), bodyTimeoutMs);

      if (!response.ok) {
        const errorText = await readAPIErrorBody(response);
        const error = new APIError(`HTTP ${response.status}`, response.status, errorText);
        error.retryAfterMs = retryDelay(response.headers.get('Retry-After'));
        throw error;
      }

      // 본문 읽기에도 위에서 시작한 제한 적용 (P0-5)
      const data = await response.json();
      clearTimeout(bodyTimer);
      bodyTimer = null;

      // OpenAI 호환 응답 파싱
      let content = '';
      if (data.choices?.[0]?.message?.content) {
        content = data.choices[0].message.content;
      } else if (data.response) {
        // 일부 API의 대체 응답 형식
        content = data.response;
      } else if (data.content) {
        content = data.content;
      } else if (typeof data === 'string') {
        content = data;
      }

      const finishReason = data.choices?.[0]?.finish_reason || '';

      content = typeof content === 'string' ? content.trim() : '';
      if (!content) throw new APIError('모델이 빈 응답을 반환했어요. 생성 예산과 추론 설정을 확인해주세요.', 422);

      return {
        content,
        raw: isExaone(this) ? null : data,
        finishReason,
        truncated: finishReason === 'length'
      };

    } catch (err) {
      if (options.signal?.aborted) throw new APIError('요청을 취소했습니다.', 499);
      if (err.name === 'AbortError') {
        throw new APIError('요청 시간이 초과되었어요... 잠시 후 다시 해볼까요?', 408);
      }
      if (err instanceof APIError) {
        throw err;
      }
      throw new APIError('네트워크 연결 오류', 0);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (bodyTimer) clearTimeout(bodyTimer);
      if (options.signal) options.signal.removeEventListener('abort', onExternalAbort);
    }
  }

  /**
   * 스트리밍 채팅 (사이드 패널용). 각 토큰마다 onDelta(accumulated, piece) 호출.
   * 총 시간 제한(timeoutMs)과 스트리밍 무응답 제한(idleTimeoutMs)을 구분한다 (P0-5).
   * @returns {Promise<{content: string, raw: object|null, finishReason: string, truncated: boolean}>}
   */
  async chatStream(messages, options = {}, onDelta) {
    try { return await this.readChatStream(messages, options, onDelta); }
    catch (error) {
      if (!isExaone(this) || options.retries === 0 || error.partialContent || !error.retryableResponse
        || error.retryAfterMs > 5000) throw error;
      await waitForRetry(Math.max(error.retryAfterMs || 0, this.retryBackoffMs), options.signal);
      return this.readChatStream(messages, options, onDelta);
    }
  }

  async readChatStream(messages, options, onDelta) {
    if (!this.apiBase) throw new APIError('API 주소가 설정되지 않았어요! 설정에서 입력해주세요.', 0);
    if (!this.model)   throw new APIError('모델명이 설정되지 않았어요! 설정에서 입력해주세요.', 0);

    const url = chatCompletionURL(this);
    const body = buildChatCompletionRequest(this, messages, options, true);

    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey && this.apiKey !== 'ollama') {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const timeoutMs = options.timeoutMs ?? CONFIG.api.timeoutMs ?? 90000;
    const idleTimeoutMs = options.idleTimeoutMs ?? 30000;
    const controller = new AbortController();
    let timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let idleId = null;
    const bumpTimeout = () => {
      clearTimeout(idleId);
      idleId = setTimeout(() => controller.abort(), idleTimeoutMs);
    };
    const onExternalAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', onExternalAbort);
    }

    let finishReason = '';
    let full = '';
    let finished = false;

    try {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await readAPIErrorBody(response);
        const error = new APIError(`HTTP ${response.status}`, response.status, errorText);
        error.retryAfterMs = retryDelay(response.headers.get('Retry-After'));
        error.retryableResponse = response.status === 429 || response.status >= 500;
        throw error;
      }
      if (!response.body || /application\/json/i.test(response.headers?.get('content-type') || '')) {
        const err = new APIError('이 API는 스트리밍을 지원하지 않아요.', 0);
        err.streamingUnsupported = true;
        await response.body?.cancel();
        throw err;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const consume = line => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') { finished = true; return; }
        let json;
        try { json = JSON.parse(data); } catch { return; }
        if (json.error) throw new APIError('스트리밍 중 모델 오류가 발생했습니다.', 502);
        const choice = json.choices?.[0];
        const piece = choice?.delta?.content || choice?.message?.content;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (typeof piece === 'string' && piece) {
          full += piece;
          onDelta?.(full, piece);
        }
      };
      bumpTimeout();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bumpTimeout();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) consume(line);
        if (finished) { await reader.cancel(); break; }
      }
      consume(buffer + decoder.decode());
      if (!finished && !finishReason) throw new APIError('완료 신호 없이 스트리밍이 끊겼습니다.', 502);

      if (!full.trim()) throw new APIError('모델이 빈 응답을 반환했어요. 생성 예산과 추론 설정을 확인해주세요.', 422);
      return {
        content: full.trim(),
        raw: null,
        finishReason,
        truncated: finishReason === 'length'
      };
    } catch (err) {
      if (options.signal?.aborted) throw new APIError('요청을 취소했습니다.', 499);
      if (err.name === 'AbortError') {
        throw new APIError('요청 시간이 초과되었어요... 잠시 후 다시 해볼까요?', 408);
      }
      if (full.trim()) {
        const error = new APIError('스트리밍이 중단됐습니다. 화면의 답변은 일부입니다.', 502);
        error.partialContent = full.trim();
        throw error;
      }
      if (err instanceof APIError) throw err;
      const error = new APIError('네트워크 연결 오류', 0);
      error.streamTransportFailure = !isExaone(this);
      throw error;
    } finally {
      clearTimeout(timeoutId);
      clearTimeout(idleId);
      if (options.signal) options.signal.removeEventListener('abort', onExternalAbort);
    }
  }

  /**
   * 재시도 포함 채팅 요청. 재시도 횟수는 요청별 options.retries로 전달한다 (P0-5:
   * 공유 클라이언트 속성을 임시 변경하지 않음).
   */
  async chatWithRetry(messages, options = {}) {
    const configuredRetries = Number.isInteger(options.retries) ? options.retries : this.maxRetries;
    const exaone = isExaone(this);
    const retries = exaone ? Math.min(1, configuredRetries) : configuredRetries;
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.chat(messages, options);
      } catch (err) {
        lastError = err;
        console.warn(`[LLMClient] 시도 ${attempt + 1}/${retries + 1} 실패 (HTTP ${err.statusCode || 0})`);

        // 4xx 에러는 재시도하지 않음 (인증 오류 등)
        if (err.statusCode >= 400 && err.statusCode < 500 && !(exaone && err.statusCode === 429)) {
          throw err;
        }

        // 마지막 시도가 아니면 대기 후 재시도
        if (attempt < retries) {
          if (err.retryAfterMs > 5000) throw err;
          const delay = Math.max(err.retryAfterMs || 0, this.retryBackoffMs * 2 ** attempt);
          await waitForRetry(delay, options.signal);
        }
      }
    }

    throw lastError;
  }

  /**
   * 프롬프트 파일에서 읽은 컨텍스트로 채팅
   * @param {Array<{role: string, content: string}>} contextMessages
   * @returns {Promise<{mood: string, message: string, raw: object}>}
   */
  async sendWithMood(contextMessages) {
    const result = await this.chatWithRetry(contextMessages);
    const parsed = parseMoodFromResponse(result.content);
    return {
      ...parsed,
      raw: result.raw
    };
  }

  /**
   * 주기적 말 걸기용 짧은 프롬프트 전송
   */
  async sendProactive(prompt) {
    const messages = [
      {
        role: 'system',
        content:
          `당신은 '댕댕이'라는 귀여운 반려 AI입니다. ` +
          `사용자에게 자연스럽게 말을 걸어주세요. ` +
          `짧게 1~2문장으로, 아래 JSON 형식으로 응답하세요:\n` +
          `{"mood": "기분키워드", "message": "대사"}\n` +
          `사용 가능한 mood: smile, tremble, yawn, study, aegyo, surprised, sad, think, sleepy, excited, blush, default`
      },
      { role: 'user', content: prompt }
    ];

    const result = await this.chatWithRetry(messages, { maxTokens: isExaone(this) ? 1200 : 220, reasoningEffort: 'none' });
    return parseMoodFromResponse(result.content);
  }
}

// --- 전역 인스턴스 ---
const llmClient = new LLMClient();

// --- 에러 클래스 ---
class APIError extends Error {
  constructor(message, statusCode = 0, responseBody = '') {
    super(message);
    this.name = 'APIError';
    this.statusCode = statusCode;
    this.details = parseAPIErrorDetails(responseBody);
    this.responseBody = JSON.stringify(this.details); // 제한된 진단 정보만 보관
  }

  /**
   * 사용자 친화적 오류 메시지
   */
  canFallbackToChat() {
    return this.statusCode === 0
      && (this.streamingUnsupported === true || this.streamTransportFailure === true);
  }

  getUserMessage() {
    if (this.details.kind === 'model_unavailable') {
      return '선택한 모델을 사용할 수 없어요. 모델명과 해당 모델의 접근 권한을 확인해주세요.';
    }
    if (this.details.kind === 'model_access') {
      return '선택한 모델의 접근 권한이 없어요. API 프로젝트와 모델 사용 권한을 확인해주세요.';
    }
    if (this.details.kind === 'model') {
      return '선택한 모델을 찾을 수 없어요. 모델명이 올바른지 확인해주세요.';
    }
    if (this.statusCode === 400) {
      if (this.details.kind === 'parameter') {
        return '선택한 모델에서 지원하지 않는 요청 옵션입니다' + (this.details.param ? ': ' + this.details.param : '.');
      }
      if (this.details.kind === 'context') return '모델의 컨텍스트 상한을 초과했어요. 입력 길이와 생성 예산을 줄여주세요.';
      return 'API 요청 형식이나 설정이 올바르지 않아요.' + (this.details.param ? ' 확인할 옵션: ' + this.details.param : '');
    }
    if (this.partialContent || this.statusCode === 422 || this.statusCode === 499) return this.message;
    if (this.statusCode === 429 && this.retryAfterMs != null) {
      return `서비스가 혼잡하거나 요청 한도에 도달했습니다. 약 ${Math.ceil(this.retryAfterMs / 1000)}초 후 다시 시도해 주세요.`;
    }
    switch (this.statusCode) {
      case 401:
        return 'API 키가 올바르지 않아요... 설정에서 확인해주시겠어요? (´•ω•̥`)';
      case 403:
        return 'API 접근 권한이 없어요... 설정을 확인해주세요!';
      case 404:
        return 'API 주소를 찾을 수 없어요... URL이 올바른지 확인해볼까요?';
      case 429:
        return '서비스가 혼잡하거나 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.';
      case 500:
      case 502:
      case 503:
        return '서버가 좀 아픈가 봐요... 곧 나아질 거예요! 조금만 기다려주세요 ♡';
      case 408:
        return '응답이 너무 오래 걸려요... 인터넷 연결을 확인해볼까요?';
      case 0:
        return 'API 연결에 실패했어요... 주소와 인터넷 연결을 확인해볼까요? (•́︿•̀)';
      default:
        return `무언가 오류가 났어요... (${this.statusCode}) 다시 시도해볼까요?`;
    }
  }
}
