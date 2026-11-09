# 视频抓取器 Video Grabber

一个浏览器扩展：列出当前网页加载的视频和音频，并把它们下载下来。每条资源都显示自己的画面缩略图，一眼就能认出是哪个视频。

本项目基于开源项目 [cat-catch（猫抓）](https://github.com/xifangczy/cat-catch) 修改，**不是猫抓的官方版本**。使用中遇到问题请到本仓库提 Issue，不要打扰原作者。

![资源列表](README/popup.png)

截图中的画面来自公开测试素材，其中 Big Buck Bunny © Blender Foundation，CC BY 3.0。

## 功能

继承自猫抓：

- 嗅探页面加载的 MP4、WebM、FLV、MP3、M3U8、MPD 等资源
- 解析 HLS（m3u8）并多线程下载、合并成 MP4，支持 AES-128 解密
- 解析 DASH（mpd）
- 下载时带上页面原本的 Referer、Cookie 等请求头

本项目新增：

- 每条资源显示自己的画面缩略图和时长
- 鼠标悬停在缩略图上可放大查看，并显示时长和分辨率
- 没有画面的文件标记为「♪ 音频」
- 使用独立的名称和图标，方便与猫抓区分；安装后不再弹出欢迎页

## 安装

本扩展没有上架应用商店，需要手动加载：

1. 下载本仓库（`git clone https://github.com/huangyu741292/video-grabber.git`，或点 Code → Download ZIP 后解压）。
2. 打开 `chrome://extensions`，打开右上角的「开发者模式」。
3. 点「加载已解压的扩展程序」，选择本仓库所在的文件夹。

已在 Chrome 上使用和测试。Edge 等 Chromium 内核浏览器理论上也能用，建议内核版本 104 以上。仓库保留了 `manifest.firefox.json`，但 Firefox 未测试。

## 使用

1. 打开有视频的网页，开始播放。
2. 点工具栏上的扩展图标，查看抓到的资源。
3. 根据缩略图、时长和大小找到要的那一条，点下载。m3u8 资源会打开解析器页面完成下载和合并。

## 已知限制

- 扩展记录的是页面发出的媒体请求，所以没点播放时，页面素材和预加载的视频也会出现在列表里。
- 同一个视频可能出现多条，比如不同 CDN、不同清晰度，目前还不会自动归并。
- 抖音、B 站等网站把画面和声音分成两个文件，只下载画面的那条会没有声音。需要同时勾选这两条，再用「在线合并」，这个功能依赖下面提到的第三方页面。

## 隐私

抓到的资源信息只保存在你的浏览器本地，扩展不包含跟踪器。以下情况会连接外部地址：

- 缩略图和下载：扩展会直接向视频所在的网站发请求。
- 「在线合并」和边下边存：会使用猫抓作者提供的在线页面（`ffmpeg.bmmmd.com`、`ffmpeg.94cat.com`、`stream.bmmmd.com`）。
- aria2、MQTT、发送数据到本地服务等功能：默认关闭，只会连接你自己配置的地址。

## 免责声明

本扩展仅供下载用户拥有版权或已获授权的视频，禁止用于下载受版权保护且未经授权的内容。用户需自行承担使用本工具的全部法律责任，开发者不对用户的任何行为负责。本工具按“原样”提供，开发者不承担任何直接或间接责任。

## 版权保护与拒绝抓取声明

我们尊重网站的内容版权和运营方的合法权益。如果您不允许本工具运行在您的网站上，请在本仓库创建 Issue，标题格式为 `[Opt-Out Request] 您的网站域名`，并在正文写明网站域名和用于核实身份的联系邮箱。收到有效请求后，我们会在后续版本中把该域名加入避免抓取列表。

## 致谢

- [cat-catch（猫抓）](https://github.com/xifangczy/cat-catch)：本项目的基础，由 xifangczy 开发
- [hls.js](https://github.com/video-dev/hls.js)
- [jQuery](https://github.com/jquery/jquery)
- [mux.js](https://github.com/videojs/mux.js)
- [jquery.json-viewer](https://github.com/abodelot/jquery.json-viewer)
- [Momo707577045](https://github.com/Momo707577045)
- [mpd-parser](https://github.com/videojs/mpd-parser)
- [StreamSaver.js](https://github.com/jimmywarting/StreamSaver.js)
- [MQTT.js](https://github.com/mqttjs/MQTT.js)

## 赞赏

如果这个工具帮到了你，欢迎请作者喝杯咖啡。赞赏完全自愿，不赞赏也能使用全部功能。

赞赏归本项目维护者所有。如果想支持猫抓原作者，请前往 [cat-catch](https://github.com/xifangczy/cat-catch) 仓库。

<p>
  <img src="README/alipay.jpg" alt="支付宝收款码" height="260">
  &nbsp;&nbsp;
  <img src="README/wechat.jpg" alt="微信赞赏码" height="260">
</p>

## 许可证

[GPL-3.0](LICENSE)，与猫抓相同。相对上游的改动见 [FORK.md](FORK.md)。

## English

Video Grabber is a browser extension that lists the video and audio resources a page loads and downloads them. Each entry shows its own thumbnail, which enlarges on hover, so you can tell which video is which.

It is a modified version of [cat-catch](https://github.com/xifangczy/cat-catch) and is not an official release of that project. To install, load this folder as an unpacked extension from `chrome://extensions` with Developer mode on. Only download videos you own or are authorized to download. Licensed under GPL-3.0.

If you find it useful, you can support the maintainer through Alipay or WeChat using the QR codes in the 赞赏 section above. Donations go to this project's maintainer, not to the cat-catch author.
