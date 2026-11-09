# 来源与改动说明

本项目基于开源项目 **cat-catch（猫抓）** 修改，不是其官方版本。

- 上游仓库：https://github.com/xifangczy/cat-catch
- 基线版本：v2.7.2
- 上游 commit：`4e1a1586f12c9376d8c5aa7334318ff4ee19316f`
- 拉取日期：2026-10-21
- 许可证：**GPL-3.0**（见 `LICENSE`，本项目沿用）

## 相对上游的改动（2026-10-21 至 2026-11-06）

- **改名和换图标**：语言包里的产品名改为「视频抓取器 / Video Grabber」，`img/icon*.png` 换成紫色取景框加播放三角。`manifest.firefox.json` 的扩展 ID 改为本项目自己的。选项页「关于」保留上游链接，并增加本项目地址。
- **每条资源的画面缩略图**：`js/popup.js` 的 `setupThumb/pumpThumbs/runThumb`，用静音暂停的小 `<video>`（HLS 用 hls.js）加载资源本身并定格在开头附近，右下角标时长；纯音频文件标「♪ 音频」。条目进入可视区才加载，并发 2，请求头通过 `setRequestHeaders` 注入（规则生效前不放行任务，避免被防盗链拦截）。
- **悬停放大**：`showThumbZoom/hideThumbZoom`，鼠标移到缩略图上时把画面以 fixed 定位放大浮出，并显示时长和分辨率。样式见 `css/popup.css` 末尾。
- **去掉安装欢迎页**：`js/background.js` 的 `onInstalled` 不再打开欢迎页，并删除 `install.html`、`js/install.js`、`css/install.css`。免责声明和隐私说明移到 `README.md`。
- **文档和仓库配置**：重写 `README.md`，删除上游的多语言 README、赞助配置和 Issue 模板。

## 2026-11-09

- **版本号**：`manifest.json` 和 `manifest.firefox.json` 的版本号从上游的 2.7.2 改为 1.0.0，本项目的版本号从此独立编号。
- **发布包**：在 GitHub Release 提供 `video-grabber-1.0.0.zip`，解压即可加载。
- **README**：改为居中标题加徽章的排版，新增功能清单、工作原理图、更新重点和赞赏码。

## 继续修改

继续修改或分发本项目时请遵守 GPL-3.0：保留原始版权和许可声明，公开修改后的源码，并在本文件追加改动记录。
