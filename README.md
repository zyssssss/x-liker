# X Like → Article Outline (Chrome Extension)

当你在 **X（x.com / Twitter）** 给一条推文点 **Like** 时：

- 如果推文里有外链文章：抓取文章（标题/摘要/正文节选）并生成「文章纲要」
- 如果没有外链：用推文内容 + 当前页面可见的 thread 文本生成「线程纲要」
- 结果保存在本地历史记录里（最近 N 条；默认只保留最新 1 条，自动清理上一条），在 Side Panel 里查看/复制

## 为什么不会把最终提交/自动行为做得更激进？

这是一个“个人效率”插件，不做任何自动发布/评论/转发。
仅在你主动 Like 时触发总结。

## 安装

1. 打开 `chrome://extensions/`
2. 右上角打开【开发者模式】
3. 点击【加载已解压的扩展程序】
4. 选择本项目文件夹 `x-like-outline/`

## 配置 DeepSeek / OpenAI

1. 安装后，点击插件 → Options
2. Provider 选择：`DeepSeek`（默认）或 `OpenAI`
3. 填入对应的 API Key
4. 模型默认：
   - DeepSeek：`deepseek-chat`
   - OpenAI：`gpt-4o-mini`

> API Key 保存在 `chrome.storage.sync`（浏览器同步存储）。建议使用单独 key。

## 使用

### 1) 点赞总结（Like → Outline）
1. 打开 https://x.com
2. 点击浏览器工具栏的扩展图标（会打开右侧 Side Panel，可一直挂着）
3. 找一条包含文章链接的推文，点击 Like
4. 等待几秒
5. 在 Side Panel 里查看状态为 `done` 的总结；可 Copy/打开文章

### 2) 收藏下载（Bookmark → Crawl → Download）
1. 在推文上点击“收藏/Bookmark”按钮
2. 插件会自动抓取：推文/线程文本 +（如有）外链文章正文
   - 优先用 fetch 抓取
   - 如果遇到站点反爬导致 `failed to fetch`，会自动改用“后台打开页面 → DOM 抓取”的方式
3. Side Panel 会出现一条记录，并提供 **Download .txt** 按钮
4. 点击 Download .txt，会把抓取内容以纯文本下载到本地

## 注意

- X 页面结构常变；如果按钮识别失效，需要更新 selector。
- 抓取文章正文使用简化版 HTML 文本提取，可能不如专业阅读模式准确，但足够快速出大纲。
- 部分站点可能禁止抓取（反爬/CORS/需要登录）。这种情况下会退化为仅总结推文/thread。
