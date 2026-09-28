import { isTranslationBatch, type TranslationBatch, type TranslationResult, type Usage } from './shared';
import { TranslationError, TRANSLATION_PROMPT, validateTranslations } from './translation';

export const DEFAULT_OLLAMA_ORIGIN = 'http://127.0.0.1:11434';

function ollamaHttpError(action: string, status: number): TranslationError {
  if (status === 403) {
    const id = globalThis.chrome?.runtime?.id;
    const origin = id ? `chrome-extension://${id}` : '当前扩展的 chrome-extension:// 来源';
    return new TranslationError(`Ollama 拒绝扩展来源（HTTP 403）。请将 ${origin} 加入 OLLAMA_ORIGINS，然后彻底退出并重启 Ollama。`, 'network');
  }
  return new TranslationError(`${action}（HTTP ${status}）`, 'network');
}

export function normalizeOllamaOrigin(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); }
  catch { throw new TranslationError('Ollama 地址无效', 'config'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new TranslationError('Ollama 只允许本机 http://localhost 或 http://127.0.0.1 地址', 'config');
  }
  if (!url.port) url.port = '11434';
  return url.origin;
}

export function validateOllamaModel(model: string): string {
  const value = model.trim();
  if (!/^[\w./:-]{1,120}$/.test(value) || /(?:^|[-/:])cloud(?:$|[-/:])/i.test(value)) {
    throw new TranslationError('请选择已下载的本机 Ollama 模型', 'config');
  }
  return value;
}

export async function listOllamaModels(originInput: string, signal?: AbortSignal): Promise<string[]> {
  const origin = normalizeOllamaOrigin(originInput);
  let response: Response;
  try {
    response = await fetch(`${origin}/api/tags`, { signal, redirect: 'error', credentials: 'omit' });
  } catch {
    throw new TranslationError('无法连接本机 Ollama；请确认服务已启动', 'network');
  }
  if (!response.ok) throw ollamaHttpError('读取 Ollama 模型失败', response.status);
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new TranslationError('Ollama 模型列表格式错误', 'response'); }
  const models = (payload as { models?: unknown })?.models;
  if (!Array.isArray(models)) throw new TranslationError('Ollama 模型列表格式错误', 'response');
  return models.flatMap(item => {
    const name = item && typeof item === 'object' ? (item as { name?: unknown }).name : undefined;
    if (typeof name !== 'string') return [];
    try { return [validateOllamaModel(name)]; }
    catch { return []; }
  });
}

export function parseOllamaResponse(data: unknown, batch: TranslationBatch): TranslationResult {
  if (!data || typeof data !== 'object') throw new TranslationError('Ollama 返回格式不正确', 'response');
  const payload = data as { done?: boolean; done_reason?: string; message?: { content?: string; thinking?: string }; prompt_eval_count?: number; eval_count?: number };
  const content = payload.message?.content?.trim() || payload.message?.thinking?.trim();
  if (payload.done !== true || (payload.done_reason && payload.done_reason !== 'stop') || !content) {
    throw new TranslationError('Ollama 译文为空或未完整生成', 'response');
  }
  // Some local model templates put even the final JSON in `thinking` when
  // `think:false`. Accept it only when it passes the same strict ID check.
  const translations = validateTranslations(content, batch);
  const prompt = payload.prompt_eval_count;
  const completion = payload.eval_count;
  const usage: Usage | null = Number.isSafeInteger(prompt) && Number.isSafeInteger(completion) && prompt! >= 0 && completion! >= 0
    ? { promptTokens: prompt!, completionTokens: completion!, totalTokens: prompt! + completion! }
    : null;
  return { translations, usage };
}

export async function translateOllama(originInput: string, modelInput: string, batch: TranslationBatch, signal: AbortSignal): Promise<TranslationResult> {
  if (!isTranslationBatch(batch)) throw new TranslationError('请求内容超过本版限制', 'response');
  const origin = normalizeOllamaOrigin(originInput);
  const model = validateOllamaModel(modelInput);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) controller.abort();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: TRANSLATION_PROMPT },
          { role: 'user', content: JSON.stringify(batch) }
        ],
        stream: false,
        format: 'json',
        think: false,
        options: { num_predict: 2048 }
      }),
      redirect: 'error',
      credentials: 'omit',
      signal: controller.signal
    });
    if (response.status === 404) throw new TranslationError('Ollama 未找到该模型；请先下载模型', 'config');
    if (!response.ok) throw ollamaHttpError('Ollama 请求失败', response.status);
    return parseOllamaResponse(await response.json(), batch);
  } catch (error) {
    if (error instanceof TranslationError) throw error;
    if (controller.signal.aborted) throw new TranslationError('Ollama 请求已取消或超时', 'cancelled');
    throw new TranslationError('无法连接本机 Ollama；请检查服务和扩展来源权限', 'network');
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
  }
}
