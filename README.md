# myTranslater

基于网页结构的轻量双语翻译扩展，支持桌面版 Chrome / Edge。打开普通网页后，点击右下角的「译」悬浮球即可开始翻译，再点一次恢复原文。悬浮球旁的状态与操作只在鼠标悬停、键盘聚焦或出现短暂提示时显示。

项目地址：[JiaqiZhang-NJU/myTranslater](https://github.com/JiaqiZhang-NJU/myTranslater)。

## 功能

- **两种翻译方式**：在设置页选择 DeepSeek API 或本机 Ollama 模型。
- **结构上下文**：按页面标题、章节、文本角色及邻近内容组织请求。导航短词带导航语境；简单表格的单元格带关联表头或行标题。多个相关文本合并请求，不另发一次 AI 摘要请求。
- **双语网页**：标题、段落、列表、导航链接、普通按钮和有明确表头的简单表格。译文保留可识别的链接与强调标记，源网页文本和原有点击事件不被替换。
- **动态网页**：开启后监听页面新增或改动，合并频繁变化，重新翻译受影响的区域，并丢弃旧请求返回的过时结果；切换页面 URL 后结束旧会话。
- **费用控制**：优先处理视口附近内容，提供暂停、重试、缓存和 token 用量显示；达到页面预算上限后由用户决定是否继续。

## 下载与安装

1. 在 [Releases](https://github.com/JiaqiZhang-NJU/myTranslater/releases/latest) 下载 `myTranslater-v0.3.0-chrome-edge.zip`，解压到一个固定文件夹。
2. 在 Chrome 打开 `chrome://extensions`，或在 Edge 打开 `edge://extensions`，开启「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择**直接包含 `manifest.json`** 的解压文件夹。ZIP 本身和 GitHub 自动生成的 Source code 压缩包不能直接作为此步骤的安装目录。
4. 打开扩展设置页，选择 DeepSeek API 或 Ollama 本地模型并保存；刷新已经打开的普通网页，然后点击右下角「译」。

这是通过开发者模式加载的独立扩展，尚未通过浏览器扩展商店分发。升级时下载新版 ZIP、解压到原文件夹，再在扩展管理页点击「重新加载」。

## 从源码构建

需要 Node.js 22 或更新版本。

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

构建完成后，可以按上述步骤加载本项目的 `dist` 目录。更新代码后重新构建、在扩展管理页点击「重新加载」，然后刷新目标网页。

打开扩展设置页，选择一种方式并保存：

- **DeepSeek API**：填写 API Key。默认只保留在当前浏览器会话；选择「在本机记住」后保存在扩展本地存储，后者不是加密保险箱。连接测试会调用 API，可能产生少量费用。
- **Ollama 本地模型**：先启动 Ollama 并下载模型。默认地址为 `http://127.0.0.1:11434`，支持 `localhost` 与自定义本机端口。刷新模型列表或填写模型名，再保存。连接测试使用本机模型，会占用本机资源。

打开或刷新普通 `http://`、`https://` 网页，右下角应出现「译」。悬停可查看进度、暂停/继续、重试和设置；点击浏览器工具栏图标也能切换翻译。设置页与 `chrome://` 等浏览器内部页面无法注入悬浮球。若普通网页看不到，检查该扩展的「网站访问权限」并刷新网页。

如果 Ollama 报来源权限错误，请参考 [Ollama 官方说明](https://docs.ollama.com/faq#how-can-i-allow-additional-web-origins-to-access-ollama)，将扩展的 `chrome-extension://<扩展 ID>` 加入 `OLLAMA_ORIGINS` 后重启 Ollama。插件只接受本机回环地址，不接受网页指定任意服务地址。
