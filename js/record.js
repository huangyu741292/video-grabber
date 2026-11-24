// 录制 FLV 直播（视频抓取器新增）
// 持续拉取 FLV 流，断线自动重连，停止时不重新编码直接存成 MP4。核心逻辑见 js/flv-mp4.js。
"use strict";

const _params = new URL(location.href).searchParams;
const _requestId = _params.get("requestId");
const STALL_MS = 20000;                       // 这么久没收到数据就当作卡住，断开重连
const RETRY_DELAYS = [1, 2, 3, 5, 8, 10];     // 连续失败时的重连间隔（秒），用完就结束录制
const SPLIT_CHOICES = [0, 10, 30, 60, 120];   // 自动分段（分钟）

let _tabId = null;
let task = null;          // 要录制的资源 { url, requestHeaders, title, ... }
let rx = null;            // LiveRemuxer
let recording = false;
let controller = null;
let reconnectTimer = null;
let isLive = true;
let failures = 0;
let reconnects = 0;
let netBytes = 0;
let startedAt = null;
let lastError = "";
let releaseLock = null;
const rateSamples = [];   // 计算码率用 [时间, 累计字节]
const savedRows = [];
const pendingDownloads = new Map();   // downloadId → 保存记录

awaitG(function () {
    loadCSS();
    initOptions();
    chrome.tabs.getCurrent(function (tab) {
        _tabId = tab.id;
        // 录制时不要被浏览器的省内存功能丢弃
        chrome.tabs.update(_tabId, { autoDiscardable: false }).catch?.(() => { });

        if (!_requestId) {
            showUrlForm();
            return;
        }
        const cached = JSONparse(localStorage.getItem("recordData"), null);
        if (cached && cached.requestId == _requestId) {
            begin(cached);
            return;
        }
        chrome.runtime.sendMessage({ Message: "getData", requestId: [_requestId] }, function (data) {
            if (chrome.runtime.lastError || !Array.isArray(data) || !data.length) {
                $("#recBox").removeClass("hide");
                setStatus("error", i18n.dataFetchFailed);
                return;
            }
            begin(data[0]);
        });
    });
});

/* ---------- 选项 ---------- */

function initOptions() {
    const $split = $("#autoSplit");
    const savedSplit = parseInt(localStorage.getItem("recordAutoSplit")) || 0;
    for (const min of SPLIT_CHOICES) {
        const text = min ? i18n("recSplitMinutes", [String(min)]) : i18n.recSplitOff;
        $split.append($("<option>").val(min).text(text).prop("selected", min === savedSplit));
    }
    $split.on("change", function () {
        localStorage.setItem("recordAutoSplit", this.value);
        if (rx) { rx.segmentLimitMs = parseInt(this.value) * 60000; }
    });
    $("#keepFlv").prop("checked", localStorage.getItem("recordKeepFlv") === "1").on("change", function () {
        localStorage.setItem("recordKeepFlv", this.checked ? "1" : "0");
    });
    $("#autoReconnect").prop("checked", localStorage.getItem("recordAutoReconnect") !== "0").on("change", function () {
        localStorage.setItem("recordAutoReconnect", this.checked ? "1" : "0");
    });
    $("#stopSave").on("click", function () { finishRecording("stop"); });
    $("#savePart").on("click", function () {
        if (!rx || !recording) { return; }
        rx.requestSplit("manual");
        $(this).prop("disabled", true);
    });
    $("#openDir").on("click", function () {
        const last = savedRows.filter(r => r.downId).pop();
        last ? chrome.downloads.show(last.downId) : chrome.downloads.showDefaultFolder();
    });
    window.addEventListener("beforeunload", function (e) {
        if (recording || savedRows.some(r => r.state === "saving")) {
            e.preventDefault();
            e.returnValue = "";
        }
    });
    chrome.downloads.onChanged.addListener(onDownloadChanged);
}

/** 没有带 requestId 打开时，手动填地址录制 */
function showUrlForm() {
    $("#urlForm").removeClass("hide");
    $("#formStart").on("click", function () {
        const url = $("#formUrl").val().trim();
        if (!/^https?:\/\//i.test(url)) { $("#formUrl").focus(); return; }
        const data = { url, requestId: "1", title: getUrlFileName(url).replace(/\.flv$/i, "") };
        const referer = $("#formReferer").val().trim();
        if (referer) {
            data.requestHeaders = referer.startsWith("http") ? { referer } : JSONparse(referer);
        }
        $("#urlForm").addClass("hide");
        begin(data);
    });
}

/* ---------- 开始 / 连接 ---------- */

let fallbackReferer = false;   // Referer 是不是我们补上的（被拒时去掉重试）

function begin(data) {
    task = data;
    const hadReferer = !!(task.requestHeaders && task.requestHeaders.referer);
    task.requestHeaders = withFallbackReferer(task);
    fallbackReferer = !hadReferer && !!task.requestHeaders.referer;
    if (!Object.keys(task.requestHeaders).length) { delete task.requestHeaders; }
    $("#recBox").removeClass("hide");
    $("#recName").text(task._title || task.title || getUrlFileName(task.url));
    $("#recUrl").text(task.url).attr("title", task.url);
    setHeaders(task, start, _tabId);
}

/**
 * 扩展后台刚启动时可能错过请求头事件，记录里就没有 Referer，直播 CDN 会因此拒绝。
 * 这时按浏览器默认的规则补上：同源用网页完整地址，跨域只带源站。
 */
function withFallbackReferer(data) {
    const headers = data.requestHeaders && typeof data.requestHeaders === "object" ? { ...data.requestHeaders } : {};
    if (headers.referer) { return headers; }
    const page = data.webUrl || data.initiator;
    try {
        const pageUrl = new URL(page);
        if (!/^https?:$/.test(pageUrl.protocol)) { return headers; }
        headers.referer = pageUrl.origin === new URL(data.url).origin ? pageUrl.href : pageUrl.origin + "/";
    } catch (e) {
        return headers;
    }
    return headers;
}

function start() {
    rx = new LiveRemuxer({
        keepFlv: $("#keepFlv").prop("checked"),
        onSegment: function (result) { saveSegment(result, false); },
        onCodec: updateCodec
    });
    rx.segmentLimitMs = (parseInt($("#autoSplit").val()) || 0) * 60000;
    recording = true;
    startedAt = new Date();
    holdLock();
    setInterval(updateStats, 1000);
    connect();
}

async function connect() {
    if (!recording) { return; }
    controller = new AbortController();
    const signal = controller.signal;
    let watchdog = null;
    const kick = function () {
        clearTimeout(watchdog);
        watchdog = setTimeout(function () { controller.abort("stall"); }, STALL_MS);
    };
    let gotMedia = false;
    setStatus(reconnects ? "reconnecting" : "connecting", reconnects ? i18n.recConnecting : null);
    try {
        kick();
        const resp = await fetch(task.url, { signal, cache: "no-store" });
        if ((resp.status === 401 || resp.status === 403) && fallbackReferer) {
            // 补上的 Referer 被拒：这个网站可能本来就不发 Referer（no-referrer），去掉后马上重试
            fallbackReferer = false;
            clearTimeout(watchdog);
            delete task.requestHeaders.referer;
            if (!Object.keys(task.requestHeaders).length) { delete task.requestHeaders; }
            await new Promise(function (resolve) {
                chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [parseInt(task.requestId)] }, function () {
                    setHeaders(task, resolve, _tabId);
                });
            });
            return connect();
        }
        if (!resp.ok) {
            throw new Error(i18n("recHttpError", [String(resp.status)]));
        }
        // 有 Content-Length 的是普通 FLV 文件，下载完就结束；没有的是直播
        isLive = !parseInt(resp.headers.get("content-length"));
        rx.newConnection();
        const reader = resp.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) { break; }
            kick();
            netBytes += value.length;
            rx.push(value);
            if (!gotMedia && rx.mediaTags > 0) {
                gotMedia = true;
                failures = 0;
                lastError = "";
                setStatus("recording");
            }
        }
        clearTimeout(watchdog);
        if (!isLive && recording) {
            finishRecording("ended");
            return;
        }
        lastError = "";
    } catch (e) {
        clearTimeout(watchdog);
        if (!recording) { return; }   // 用户点了停止
        if (e && e.message === "NOT_FLV") {
            lastError = i18n.recNotFlv;
            if (!rx.hasData) {
                finishRecording("error");
                return;
            }
        } else {
            lastError = signal.aborted ? "timeout" : (e && e.message) || String(e);
        }
        console.warn("录制连接中断", e);
        if (!isLive) {
            finishRecording("ended");
            return;
        }
    }
    if (!recording) { return; }
    scheduleReconnect(gotMedia);
}

function scheduleReconnect(gotMedia) {
    if (!gotMedia) { failures++; }
    if (!$("#autoReconnect").prop("checked") || failures > RETRY_DELAYS.length) {
        finishRecording("ended");
        return;
    }
    const delay = RETRY_DELAYS[Math.max(0, failures - 1)];
    reconnects++;
    let left = delay;
    const tick = function () {
        if (!recording) { return; }
        if (left <= 0) {
            connect();
            return;
        }
        setStatus("reconnecting", i18n("recReconnecting", [String(left), String(reconnects)]) + (lastError ? `（${lastError}）` : ""));
        left--;
        reconnectTimer = setTimeout(tick, 1000);
    };
    tick();
}

/* ---------- 结束 / 保存 ---------- */

function finishRecording(reason) {
    if (!recording) { return; }
    recording = false;
    clearTimeout(reconnectTimer);
    controller && controller.abort("stop");
    $("#stopSave, #savePart").prop("disabled", true);
    setStatus("finishing", i18n.recFinishing);
    setTimeout(function () {
        let result = null;
        try {
            result = rx.finish(reason);
        } catch (e) {
            console.error(e);
            lastError = e.message;
        }
        if (result) { saveSegment(result, true); }
        if (releaseLock) { releaseLock(); releaseLock = null; }
        updateStats();
        if (!savedRows.length) {
            setStatus(reason === "error" ? "error" : "nodata", reason === "error" && lastError ? lastError : i18n.recNoData);
        } else {
            setStatus(reason === "stop" ? "stopped" : "ended", reason === "stop" ? i18n.recStopped : i18n.recEnded);
        }
        document.title = i18n.recordLiveTitle;
    }, 50);
}

function fileBaseName() {
    // 直播流地址里的文件名通常是一串编号，优先用网页标题（一般就是「某某的直播间」）
    let name = task._title || task.title || task.downFileName || task.name || getUrlFileName(task.url);
    name = String(name).replace(/\.(flv|mp4|m3u8|ts)$/i, "").trim();
    if (name.length > 80) { name = name.slice(0, 80); }
    name = stringModify(name) || "live";
    const d = startedAt || new Date();
    const stamp = `${d.getFullYear()}${appendZero(d.getMonth() + 1)}${appendZero(d.getDate())}-${appendZero(d.getHours())}${appendZero(d.getMinutes())}${appendZero(d.getSeconds())}`;
    return `${name}_${stamp}`;
}

function saveSegment(result, isFinal) {
    // 只有一段时不加 _part 后缀
    const suffix = isFinal && result.index === 1 ? "" : `_part${result.index}`;
    const base = fileBaseName() + suffix;
    for (const kind of ["mp4", "flv"]) {
        const blob = result[kind];
        if (!blob) { continue; }
        const row = { name: `${base}.${kind}`, blob, size: blob.size, durationMs: result.durationMs, state: "saving", downId: null, url: null };
        savedRows.push(row);
        renderRow(row);
        download(row, isFinal && G.saveAs);
    }
    $("#savePart").prop("disabled", !recording);
}

function download(row, saveAs) {
    row.state = "saving";
    row.url = URL.createObjectURL(row.blob);
    updateRow(row);
    chrome.downloads.download({ url: row.url, filename: row.name, saveAs: !!saveAs }, function (id) {
        if (chrome.runtime.lastError || !id) {
            row.state = "failed";
            row.error = chrome.runtime.lastError ? chrome.runtime.lastError.message : "";
            URL.revokeObjectURL(row.url);
            updateRow(row);
            return;
        }
        row.downId = id;
        pendingDownloads.set(id, row);
    });
}

function onDownloadChanged(delta) {
    const row = pendingDownloads.get(delta.id);
    if (!row || !delta.state) { return; }
    if (delta.state.current === "complete") {
        row.state = "saved";
    } else if (delta.state.current === "interrupted") {
        row.state = "failed";
    } else {
        return;
    }
    pendingDownloads.delete(delta.id);
    URL.revokeObjectURL(row.url);
    if (row.state === "saved") { row.blob = null; }   // 保存好了就释放
    updateRow(row);
}

function renderRow(row) {
    $("#savedSection").removeClass("hide");
    row.$el = $(`<div class="savedRow">
        <span class="savedName"></span>
        <span class="savedMeta"></span>
        <span class="savedState"></span>
        <button type="button" class="retry hide"></button>
    </div>`);
    row.$el.find(".savedName").text(row.name);
    row.$el.find(".savedMeta").text(`${secToTime(row.durationMs / 1000)} · ${byteToSize(row.size) || row.size + "B"}`);
    row.$el.find(".retry").text(i18n.retryDownload).on("click", function () {
        if (row.blob) { download(row, true); }
    });
    $("#savedList").append(row.$el);
}

function updateRow(row) {
    if (!row.$el) { return; }
    const text = { saving: i18n.recSaving, saved: i18n.recSaved, failed: i18n.recSaveFailed }[row.state];
    row.$el.find(".savedState").attr("data-state", row.state).text(text);
    row.$el.find(".retry").toggleClass("hide", !(row.state === "failed" && row.blob));
}

/* ---------- 界面 ---------- */

function setStatus(state, text) {
    const defaults = {
        connecting: i18n.recConnecting,
        reconnecting: i18n.recConnecting,
        recording: i18n.recRecording
    };
    $("#recStatus").attr("data-state", state);
    $("#recStatusText").text(text || defaults[state] || "");
}

function updateCodec(info) {
    const v = info.video;
    const a = info.audio;
    $("#statVideo").text(v ? `${v.codec === "hevc" ? "H.265" : "H.264"}${v.width ? ` ${v.width}x${v.height}` : ""}` : "-");
    $("#statAudio").text(a ? `AAC ${(a.sampleRate / 1000).toFixed(a.sampleRate % 1000 ? 1 : 0)}kHz ${a.channels}ch` : "-");
    if (info.mode === "flv") {
        $("#statFormat").text(i18n("recFormatFlv", [info.unsupported.join(", ") || "?"]));
    } else if (info.mode === "mp4") {
        $("#statFormat").text(rx && rx.opts.keepFlv ? "MP4 + FLV" : "MP4");
    }
}

function updateStats() {
    if (!rx) { return; }
    const now = Date.now();
    rateSamples.push([now, netBytes]);
    while (rateSamples.length > 6) { rateSamples.shift(); }
    const first = rateSamples[0];
    const bps = now > first[0] ? (netBytes - first[1]) * 8 * 1000 / (now - first[0]) : 0;
    const totalSize = savedRows.reduce((s, r) => s + r.size, 0) + rx.outputBytes;
    $("#statDuration").text(secToTime(rx.totalMs / 1000));
    $("#statSize").text(byteToSize(totalSize) || "0");
    $("#statBitrate").text(recording && bps ? formatBitrate(bps) : "-");
    $("#statReconnects").text(reconnects);
    if (recording) {
        document.title = `● ${secToTime(rx.totalMs / 1000)} ${i18n.recLiveHeading}`;
    }
}

/** 持有 Web Lock，避免页面在后台被浏览器冻结 */
function holdLock() {
    if (!navigator.locks) { return; }
    navigator.locks.request(`video-grabber-record-${Date.now()}`, function () {
        return new Promise(function (resolve) { releaseLock = resolve; });
    }).catch(function () { });
}
