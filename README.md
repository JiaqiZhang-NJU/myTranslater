# myTranslater

基于网页结构的轻量双语翻译扩展，支持桌面版 Chrome / Edge。打开普通网页后，点击右下角的「译」悬浮球即可开始翻译，再点一次恢复原文。悬浮球旁的状态与操作只在鼠标悬停、键盘聚焦或出现短暂提示时显示。右键悬浮球可在当前页面隐藏它。

项目地址：[JiaqiZhang-NJU/myTranslater](https://github.com/JiaqiZhang-NJU/myTranslater)。官网与安装包下载页：<https://translate.jqzhang.top/>。

## 功能

- **两种翻译方式**：在设置页选择 DeepSeek API 或本机 Ollama 模型。
- **结构上下文**：按页面标题、章节、文本角色及邻近内容组织请求。导航短词带导航语境；简单表格的单元格带关联表头或行标题。多个相关文本合并请求，不另发一次 AI 摘要请求。
- **双语网页**：标题、段落、列表、普通导航（原生 `nav`、面包屑、分页、标签页、菜单和自定义导航容器）、按钮、`label` / `summary` / `caption` 标签，以及有明确表头的简单表格。译文保留可识别的链接与强调标记，数字徽标（如 `Matches (34)` 里的 `(34)`）保持原样，源网页文本和原有点击事件不被替换。
- **划词翻译**：选中任意可见文字后，用浏览器右键菜单选择「用 myTranslater 翻译所选文字」，结果在页面内的小面板显示，可复制。此入口不要求先开启整页翻译，也不会把译文插回页面。
- **动态网页**：开启后监听页面新增或改动，合并频繁变化，重新翻译受影响的区域，并丢弃旧请求返回的过时结果；切换页面 URL 后结束旧会话。
- **当前页隐藏**：右键悬浮球选择「在当前页面隐藏悬浮球」会停止当前翻译并恢复原文；点工具栏扩展图标可在同一页恢复，刷新或切换页面后悬浮球也会重新出现。
- **费用控制**：优先处理视口附近内容，提供暂停、重试、缓存和 token 用量显示；DeepSeek 与本机 Ollama 分别计算当前页面预算，成功请求按实际 token 用量结算。整页翻译与划词翻译共用同一份预算。达到上限后由用户决定是否继续。

## 支持的识别范围与边界

- 原生语义结构优先于普通容器：`nav`、`[role="navigation"]`、`[role="tablist"]`、`[role="menu"]`、`footer` 里的链接和标签会被识别。
- 普通 `div` / `ul` 导航依据结构判断：多个重复的同级链接、短标签、链接之外几乎没有文字。正文链接、图片卡片和「阅读更多」不会被当作导航。
- 一个文字节点只有一个归属：父项直接文字、子段落、嵌套列表和按钮各自成块，不重复请求。
- 明确排除脚本、样式、代码、输入值、隐藏内容、`translate="no"` 和扩展自身节点；整个可编辑区域（`contenteditable`）按一块跳过，其中的 `contenteditable="false"` 子区同样跳过。不在编辑器内的 `contenteditable="false"` 元素属于普通内容。
- 纯数字与符号不单独请求：页码、评分、徽标不会发给模型。
- 暂不支持：Shadow DOM、iframe、Canvas 图片文字、PDF、字幕、虚拟化表格、合并表头与多级表头。

## 下载与安装

1. 在官网 <https://translate.jqzhang.top/> 或 [Releases](https://github.com/JiaqiZhang-NJU/myTranslater/releases/latest) 下载最新的 `myTranslater-vX.Y.Z-chrome-edge.zip`，解压到一个固定文件夹。两处是同一个安装包。
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

可选的浏览器回归检查会启动本机 Chromium 内核浏览器，用固定样例验证结构覆盖、动态更新、迟到结果和划词面板。通过环境变量 `MT_BROWSER` 指定浏览器路径；找不到浏览器时脚本会打印 `SKIP` 并正常退出。

```powershell
npm run build
npm run test:browser
```

`npm run test:install` 会把构建产物当作真实扩展加载到本机 Chromium 内核浏览器，检查 service worker、`contextMenus` 权限、内容脚本注入和后台往返。注意：Chrome 137 起，普通安装版 Chrome 会忽略命令行的 `--load-extension`，脚本会自动改用在测试用 Chromium 上验证并打印实际使用的浏览器；在真实 Chrome/Edge 中通过 `chrome://extensions` 手动加载仍是人工步骤，右键菜单的点击也需要人工确认。

构建完成后，可以按上述步骤加载本项目的 `dist` 目录。更新代码后重新构建、在扩展管理页点击「重新加载」，然后刷新目标网页。

打开扩展设置页，选择一种方式并保存：

- **DeepSeek API**：填写 API Key。默认只保留在当前浏览器会话；选择「在本机记住」后保存在扩展本地存储，后者不是加密保险箱。连接测试会调用 API，可能产生少量费用。
- **Ollama 本地模型**：先启动 Ollama 并下载模型。默认地址为 `http://127.0.0.1:11434`，支持 `localhost` 与自定义本机端口。刷新模型列表或填写模型名，再保存。连接测试使用本机模型，会占用本机资源。

英译中建议从 `qwen3.5:4b` 或 `gemma3:4b` 起步，例如先运行 `ollama pull qwen3.5:4b`。更小的模型虽然可能通过连接测试，仍可能漏译或误译术语；更大的模型也不保证每句话都更准确。请在实际网页上试译后选择。

本地模型会收到明确的译文 JSON 格式要求，点号式 API 名称会先变成占位符，翻译后还原。若一个批次的输出不合格，扩展会自动拆成更小批次重试。若模型反复破坏嵌套链接等行内标记，单条译文会改用纯文字显示；原网页的链接和格式仍保留。明显未译为中文的长段落会被视为失败。失败的本地请求不消耗页面预算。DeepSeek 请求若已开始但失败，因费用状态可能未知，页面预算仍会保守记入该次请求的估算用量。

打开或刷新普通 `http://`、`https://` 网页，右下角应出现「译」。悬停可查看进度、暂停/继续、重试和设置；点击浏览器工具栏图标也能切换翻译。设置页与 `chrome://` 等浏览器内部页面无法注入悬浮球。若普通网页看不到，检查该扩展的「网站访问权限」并刷新网页。

如果 Ollama 测试显示 **HTTP 403**：在扩展管理页打开 myTranslater 的「详细信息」复制扩展 ID；彻底退出 Ollama，在 Windows「编辑账户的环境变量」中新建或追加 `OLLAMA_ORIGINS=chrome-extension://<扩展 ID>`，再启动 Ollama。若已有 `OLLAMA_ORIGINS`，用英文逗号追加这一项。只放行本扩展即可，不必使用通配符。详见 [Ollama 官方来源设置说明](https://docs.ollama.com/faq#how-can-i-allow-additional-web-origins-to-access-ollama)。插件只接受本机回环地址，不接受网页指定任意服务地址。
