import { loadSettings, models, saveSettings, testProvider } from './options-service';
import { TranslationError } from './translation';

const form = document.getElementById('settings') as HTMLFormElement;
const keyInput = document.getElementById('api-key') as HTMLInputElement;
const rememberInput = document.getElementById('remember') as HTMLInputElement;
const originInput = document.getElementById('ollama-origin') as HTMLInputElement;
const modelInput = document.getElementById('ollama-model') as HTMLInputElement;
const modelList = document.getElementById('ollama-models') as HTMLDataListElement;
const refreshButton = document.getElementById('refresh-models') as HTMLButtonElement;
const deepseekSettings = document.getElementById('deepseek-settings') as HTMLDivElement;
const ollamaSettings = document.getElementById('ollama-settings') as HTMLDivElement;
const statusElement = document.getElementById('status') as HTMLParagraphElement;
const testButton = document.getElementById('test') as HTMLButtonElement;
const saveButton = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
document.getElementById('build-version')!.textContent = `v${chrome.runtime.getManifest().version}`;
document.getElementById('ollama-extension-origin')!.textContent = `chrome-extension://${chrome.runtime.id}`;

function setStatus(message: string): void { statusElement.textContent = message; }
function errorMessage(error: unknown, fallback: string): string { return error instanceof TranslationError ? error.message : fallback; }
function selectedProvider(): 'deepseek' | 'ollama' {
  return (form.querySelector('input[name="provider"]:checked') as HTMLInputElement)?.value === 'ollama' ? 'ollama' : 'deepseek';
}
function fields() {
  return { provider: selectedProvider(), apiKey: keyInput.value, remember: rememberInput.checked,
    ollamaOrigin: originInput.value, ollamaModel: modelInput.value };
}
function updateProvider(): void {
  const local = selectedProvider() === 'ollama';
  deepseekSettings.hidden = local;
  ollamaSettings.hidden = !local;
  testButton.textContent = local ? '测试 Ollama 模型' : '测试 DeepSeek';
}
for (const radio of form.querySelectorAll<HTMLInputElement>('input[name="provider"]')) radio.addEventListener('change', updateProvider);

void loadSettings().then(result => {
  keyInput.value = result.apiKey;
  rememberInput.checked = result.remember;
  originInput.value = result.ollamaOrigin;
  modelInput.value = result.ollamaModel;
  const radio = form.querySelector<HTMLInputElement>(`input[name="provider"][value="${result.provider}"]`);
  if (radio) radio.checked = true;
  updateProvider();
}).catch(error => setStatus(errorMessage(error, '暂时无法读取设置，请重新打开此页')));

form.addEventListener('submit', event => {
  event.preventDefault();
  saveButton.disabled = true;
  void saveSettings(fields())
    .then(() => setStatus('已保存。打开或刷新普通网页，在右侧中间点击“译”，也可点击工具栏插件图标。'))
    .catch(error => setStatus(errorMessage(error, '保存失败，请稍后重试')))
    .finally(() => { saveButton.disabled = false; });
});

refreshButton.addEventListener('click', () => {
  refreshButton.disabled = true;
  setStatus('正在读取本机 Ollama 模型…');
  void models(originInput.value)
    .then(names => {
      modelList.replaceChildren(...names.map(name => {
        const option = document.createElement('option');
        option.value = name;
        return option;
      }));
      if (names.length === 1 && !modelInput.value.trim()) modelInput.value = names[0];
      setStatus(names.length ? `找到 ${names.length} 个本机模型，请选择或填写名称。` : '没有找到模型；请先运行 ollama pull 下载。');
    })
    .catch(error => setStatus(errorMessage(error, '无法连接本机 Ollama，请确认服务已启动')))
    .finally(() => { refreshButton.disabled = false; });
});

testButton.addEventListener('click', () => {
  testButton.disabled = true;
  const provider = selectedProvider();
  setStatus(provider === 'ollama' ? '正在调用本机 Ollama 测试翻译…' : '正在调用 DeepSeek 测试连接…');
  void testProvider(fields())
    .then(result => setStatus(`连接成功。样例标题译为“${result.preview}”；本次 ${result.usage?.totalTokens ?? '用量未知'} token。`))
    .catch(error => setStatus(errorMessage(error, '连接失败，请检查服务与设置')))
    .finally(() => { testButton.disabled = false; });
});
