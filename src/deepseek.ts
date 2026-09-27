import { isTranslationBatch, type TranslationBatch, type TranslationResult, type Usage } from './shared';
import { TranslationError, TRANSLATION_PROMPT, validateTranslations } from './translation';

export { TranslationError } from './translation';

const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-flash';

export function parseTranslationResponse(data: unknown, batch: TranslationBatch): TranslationResult {
  if (!data || typeof data !== 'object') throw new TranslationError('DeepSeek 返回格式不正确', 'response');
  const payload = data as {
    choices?: { finish_reason?: string; message?: { content?: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const choice = payload.choices?.[0];
  if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string' || !choice.message.content.trim()) {
    throw new TranslationError('译文为空或被截断，请稍后重试', 'response');
  }
  const normalized = validateTranslations(choice.message.content, batch);
  const raw = payload.usage;
  const usage: Usage | null = raw && Number.isSafeInteger(raw.prompt_tokens) && Number.isSafeInteger(raw.completion_tokens) && Number.isSafeInteger(raw.total_tokens)
    ? { promptTokens: raw.prompt_tokens!, completionTokens: raw.completion_tokens!, totalTokens: raw.total_tokens! }
    : null;
  return { translations: normalized, usage };
}

export async function translateDeepSeek(apiKey: string, batch: TranslationBatch, signal: AbortSignal): Promise<TranslationResult> {
  if (!isTranslationBatch(batch)) throw new TranslationError('请求内容超过本版限制', 'response');
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) controller.abort();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        stream: false,
        max_tokens: 2048,
        messages: [
          { role: 'system', content: TRANSLATION_PROMPT },
          { role: 'user', content: JSON.stringify(batch) }
        ]
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new TranslationError('API Key 无效或无权限', 'key');
      if (response.status === 402) throw new TranslationError('DeepSeek 账户余额不足', 'quota');
      if (response.status === 429) throw new TranslationError('请求过于频繁，请稍后手动重试', 'rate');
      throw new TranslationError(`DeepSeek 请求失败（HTTP ${response.status}）`, 'network');
    }
    return parseTranslationResponse(await response.json(), batch);
  } catch (error) {
    if (error instanceof TranslationError) throw error;
    if (controller.signal.aborted) throw new TranslationError('请求已取消或超时；已发送请求可能仍计费', 'cancelled');
    throw new TranslationError('无法连接 DeepSeek；请求状态和费用可能未知', 'network');
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
  }
}
