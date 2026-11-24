/**
 * FLV 直播流录制核心（视频抓取器新增）
 *
 * - FlvDemuxer：把任意切分的字节流拆成 FLV tag
 * - LiveRemuxer：处理时间戳、断线重连、编码参数，把音视频帧送进 Mp4Segment / FlvWriter
 * - Mp4Segment：不重新编码，直接把 H.264/H.265 + AAC 封装成普通 MP4（moov 在前）
 * - FlvWriter：重新写出连续时间戳的 FLV，用于不支持封装 MP4 的编码或用户要求保留原始流
 *
 * 帧数据先存进 Blob（Chrome 会在内存紧张时把 Blob 放到磁盘），内存里只保留每帧的大小和时间，
 * 所以录几个小时也不会把页面内存撑爆。
 */
"use strict";

const FLV_TAG_AUDIO = 8;
const FLV_TAG_VIDEO = 9;
const FLV_TAG_SCRIPT = 18;

/* ---------- 小工具 ---------- */

function flvConcat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}
function flvSameBytes(a, b) {
    if (!a || !b || a.length !== b.length) { return false; }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) { return false; }
    }
    return true;
}
function flvSI24(d, o) {
    const v = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
    return v & 0x800000 ? v - 0x1000000 : v;
}

/** 按块累积数据并定期转成 Blob，JS 内存里只留最近几 MB */
class BlobStore {
    constructor(flushBytes = 8 * 1024 * 1024) {
        this.flushBytes = flushBytes;
        this.blobs = [];
        this.pending = [];
        this.pendingBytes = 0;
        this.size = 0;
    }
    append(u8) {
        if (!u8.length) { return; }
        this.pending.push(u8);
        this.pendingBytes += u8.length;
        this.size += u8.length;
        if (this.pendingBytes >= this.flushBytes) { this.flush(); }
    }
    flush() {
        if (!this.pending.length) { return; }
        this.blobs.push(new Blob(this.pending));
        this.pending = [];
        this.pendingBytes = 0;
    }
    parts() {
        this.flush();
        return this.blobs;
    }
}

/** 可增长的数值列，省内存地记录几十万帧的信息 */
class NumColumn {
    constructor(Type, capacity = 4096) {
        this.Type = Type;
        this.data = new Type(capacity);
        this.length = 0;
    }
    push(v) {
        if (this.length === this.data.length) {
            const bigger = new this.Type(this.data.length * 2);
            bigger.set(this.data);
            this.data = bigger;
        }
        this.data[this.length++] = v;
    }
    get(i) { return this.data[i]; }
    get last() { return this.data[this.length - 1]; }
}

/* ---------- 编码参数解析 ---------- */

class BitReader {
    constructor(bytes) {
        // 去掉防竞争字节 00 00 03
        const out = [];
        let zeros = 0;
        for (let i = 0; i < bytes.length; i++) {
            const b = bytes[i];
            if (zeros >= 2 && b === 3) { zeros = 0; continue; }
            out.push(b);
            zeros = b === 0 ? zeros + 1 : 0;
        }
        this.d = out;
        this.pos = 0;
    }
    u(n) {
        let v = 0;
        for (let i = 0; i < n; i++) {
            const byte = this.d[this.pos >> 3];
            if (byte === undefined) { throw new Error("BitReader EOF"); }
            v = v * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
            this.pos++;
        }
        return v;
    }
    skip(n) { this.pos += n; }
    ue() {
        let zeros = 0;
        while (this.u(1) === 0) {
            if (++zeros > 31) { throw new Error("bad exp-golomb"); }
        }
        return zeros ? (2 ** zeros - 1) + this.u(zeros) : 0;
    }
    se() {
        const k = this.ue();
        return k & 1 ? (k + 1) / 2 : -(k / 2);
    }
}

/** H.264 SPS → 宽高 */
function parseAvcSps(nal) {
    const r = new BitReader(nal.subarray(1));
    const profile = r.u(8);
    r.skip(8);
    const level = r.u(8);
    r.ue();
    let chroma = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
        chroma = r.ue();
        if (chroma === 3) { r.skip(1); }
        r.ue(); r.ue(); r.skip(1);
        if (r.u(1)) {
            for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
                if (!r.u(1)) { continue; }
                const size = i < 6 ? 16 : 64;
                let last = 8, next = 8;
                for (let j = 0; j < size; j++) {
                    if (next !== 0) { next = (last + r.se() + 256) % 256; }
                    last = next === 0 ? last : next;
                }
            }
        }
    }
    r.ue();
    const pocType = r.ue();
    if (pocType === 0) {
        r.ue();
    } else if (pocType === 1) {
        r.skip(1); r.se(); r.se();
        const n = r.ue();
        for (let i = 0; i < n; i++) { r.se(); }
    }
    r.ue(); r.skip(1);
    const wMbs = r.ue() + 1;
    const hMap = r.ue() + 1;
    const frameMbsOnly = r.u(1);
    if (!frameMbsOnly) { r.skip(1); }
    r.skip(1);
    let cl = 0, cr = 0, ct = 0, cb = 0;
    if (r.u(1)) { cl = r.ue(); cr = r.ue(); ct = r.ue(); cb = r.ue(); }
    const subW = chroma === 1 || chroma === 2 ? 2 : 1;
    const subH = chroma === 1 ? 2 : 1;
    const cropX = chroma === 0 ? 1 : subW;
    const cropY = (chroma === 0 ? 1 : subH) * (2 - frameMbsOnly);
    return {
        width: wMbs * 16 - (cl + cr) * cropX,
        height: (2 - frameMbsOnly) * hMap * 16 - (ct + cb) * cropY,
        profile, level
    };
}

/** H.265 SPS → 宽高 */
function parseHevcSps(nal) {
    const r = new BitReader(nal.subarray(2));
    r.skip(4);
    const maxSubLayersMinus1 = r.u(3);
    r.skip(1);
    // profile_tier_level
    r.skip(2 + 1);
    const profile = r.u(5);
    r.skip(32 + 48);
    const level = r.u(8);
    const subProfile = [], subLevel = [];
    for (let i = 0; i < maxSubLayersMinus1; i++) {
        subProfile.push(r.u(1));
        subLevel.push(r.u(1));
    }
    if (maxSubLayersMinus1 > 0) {
        for (let i = maxSubLayersMinus1; i < 8; i++) { r.skip(2); }
    }
    for (let i = 0; i < maxSubLayersMinus1; i++) {
        if (subProfile[i]) { r.skip(88); }
        if (subLevel[i]) { r.skip(8); }
    }
    r.ue();
    const chroma = r.ue();
    if (chroma === 3) { r.skip(1); }
    let width = r.ue();
    let height = r.ue();
    if (r.u(1)) {
        const subW = chroma === 1 || chroma === 2 ? 2 : 1;
        const subH = chroma === 1 ? 2 : 1;
        const l = r.ue(), rr = r.ue(), t = r.ue(), b = r.ue();
        width -= (l + rr) * subW;
        height -= (t + b) * subH;
    }
    return { width, height, profile, level };
}

/** AVCDecoderConfigurationRecord → 第一个 SPS */
function avcConfigSps(cfg) {
    if (cfg.length < 8) { return null; }
    const numSps = cfg[5] & 0x1f;
    if (!numSps) { return null; }
    const len = (cfg[6] << 8) | cfg[7];
    return cfg.subarray(8, 8 + len);
}

/** HEVCDecoderConfigurationRecord → 第一个 SPS（NAL type 33） */
function hevcConfigSps(cfg) {
    if (cfg.length < 23) { return null; }
    let o = 23;
    const arrays = cfg[22];
    for (let i = 0; i < arrays && o + 3 <= cfg.length; i++) {
        const type = cfg[o] & 0x3f;
        const n = (cfg[o + 1] << 8) | cfg[o + 2];
        o += 3;
        for (let j = 0; j < n && o + 2 <= cfg.length; j++) {
            const len = (cfg[o] << 8) | cfg[o + 1];
            o += 2;
            if (type === 33) { return cfg.subarray(o, o + len); }
            o += len;
        }
    }
    return null;
}

/** 视频编码参数（只解析，不影响封装：宽高读不出来时 MP4 仍可播放） */
function describeVideoConfig(codec, cfg) {
    const info = { codec, config: cfg.slice(), width: 0, height: 0 };
    try {
        if (codec === "avc") {
            const sps = avcConfigSps(cfg);
            if (sps) { Object.assign(info, parseAvcSps(sps)); }
        } else if (codec === "hevc") {
            const sps = hevcConfigSps(cfg);
            if (sps) { Object.assign(info, parseHevcSps(sps)); }
        }
    } catch (e) {
        console.warn("SPS 解析失败", e);
    }
    return info;
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
/** AudioSpecificConfig → 采样率、声道 */
function describeAacConfig(cfg) {
    const info = { codec: "aac", config: cfg.slice(), sampleRate: 44100, channels: 2, objectType: 2 };
    try {
        const r = new BitReader(cfg);
        let ot = r.u(5);
        if (ot === 31) { ot = 32 + r.u(6); }
        const fi = r.u(4);
        info.sampleRate = fi === 15 ? r.u(24) : (AAC_RATES[fi] || 44100);
        const ch = r.u(4);
        info.channels = ch === 7 ? 8 : (ch || 2);
        info.objectType = ot;
    } catch (e) {
        console.warn("AAC 参数解析失败", e);
    }
    return info;
}

/* ---------- FLV 拆包 ---------- */

class FlvDemuxer {
    constructor(onTag) {
        this.onTag = onTag;
        this.reset();
    }
    reset() {
        this.buf = new Uint8Array(0);
        this.headerDone = false;
        this.flags = 0;
    }
    push(chunk) {
        let buf = this.buf.length ? flvConcat(this.buf, chunk) : chunk;
        let pos = 0;
        if (!this.headerDone) {
            if (buf.length < 13) { this.buf = buf.slice(); return; }
            if (buf[0] !== 0x46 || buf[1] !== 0x4C || buf[2] !== 0x56) {
                throw new Error("NOT_FLV");
            }
            const headerSize = ((buf[5] << 24) | (buf[6] << 16) | (buf[7] << 8) | buf[8]) >>> 0;
            if (buf.length < headerSize + 4) { this.buf = buf.slice(); return; }
            this.flags = buf[4];
            this.headerDone = true;
            pos = headerSize + 4;
        }
        while (buf.length - pos >= 11) {
            const type = buf[pos] & 0x1f;
            const size = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
            if (buf.length - pos < 11 + size + 4) { break; }
            const ts = buf[pos + 7] * 16777216 + ((buf[pos + 4] << 16) | (buf[pos + 5] << 8) | buf[pos + 6]);
            this.onTag(type, ts, buf.subarray(pos + 11, pos + 11 + size));
            pos += 11 + size + 4;
        }
        this.buf = pos < buf.length ? buf.slice(pos) : new Uint8Array(0);
    }
}

/** 解析视频 tag：支持传统 FLV（H.264=7、国内 CDN 常用的 H.265=12）和 Enhanced RTMP（avc1/hvc1） */
function parseFlvVideo(d) {
    if (d.length < 2) { return { kind: "other" }; }
    const b0 = d[0];
    if (b0 & 0x80) {
        const frameType = (b0 >> 4) & 7;
        const pkt = b0 & 0x0f;
        if (frameType === 5 || d.length < 5) { return { kind: "other" }; }
        const fourcc = String.fromCharCode(d[1], d[2], d[3], d[4]);
        const codec = fourcc === "avc1" ? "avc" : fourcc === "hvc1" ? "hevc" : fourcc;
        const key = frameType === 1;
        if (pkt === 0) { return { kind: "config", codec, data: d.subarray(5) }; }
        if (pkt === 1) { return { kind: "frame", codec, key, cts: codec === "avc" || codec === "hevc" ? flvSI24(d, 5) : 0, data: d.subarray(codec === "avc" || codec === "hevc" ? 8 : 5) }; }
        if (pkt === 3) { return { kind: "frame", codec, key, cts: 0, data: d.subarray(5) }; }
        return { kind: "other" };
    }
    const frameType = b0 >> 4;
    const codecId = b0 & 0x0f;
    if (frameType === 5) { return { kind: "other" }; }
    const codec = codecId === 7 ? "avc" : codecId === 12 ? "hevc" : "flv-video-" + codecId;
    if (codec !== "avc" && codec !== "hevc") { return { kind: "frame", codec, key: frameType === 1, cts: 0, data: d.subarray(1) }; }
    if (d.length < 5) { return { kind: "other" }; }
    const pkt = d[1];
    if (pkt === 0) { return { kind: "config", codec, data: d.subarray(5) }; }
    if (pkt === 1) { return { kind: "frame", codec, key: frameType === 1, cts: flvSI24(d, 2), data: d.subarray(5) }; }
    return { kind: "other" };
}

const FLV_AUDIO_NAMES = ["pcm", "adpcm", "mp3", "pcm-le", "nellymoser", "nellymoser", "nellymoser", "g711a", "g711u", "ex-audio", "aac", "speex", "", "", "mp3-8k", "device"];
function parseFlvAudio(d) {
    if (!d.length) { return { kind: "other" }; }
    const fmt = d[0] >> 4;
    if (fmt === 10) {
        if (d.length < 2) { return { kind: "other" }; }
        return d[1] === 0 ? { kind: "config", codec: "aac", data: d.subarray(2) } : { kind: "frame", codec: "aac", data: d.subarray(2) };
    }
    return { kind: "frame", codec: FLV_AUDIO_NAMES[fmt] || ("flv-audio-" + fmt), data: d.subarray(1) };
}

/* ---------- MP4 封装 ---------- */

const MP4_SUPPORTED = { video: ["avc", "hevc"], audio: ["aac"] };

function mp4Ascii(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) { out[i] = s.charCodeAt(i); }
    return out;
}
class ByteWriter {
    constructor(size) {
        this.u8 = new Uint8Array(size);
        this.dv = new DataView(this.u8.buffer);
        this.o = 0;
    }
    u8v(v) { this.dv.setUint8(this.o, v); this.o += 1; return this; }
    u16(v) { this.dv.setUint16(this.o, v); this.o += 2; return this; }
    i16(v) { this.dv.setInt16(this.o, v); this.o += 2; return this; }
    u32(v) { this.dv.setUint32(this.o, v >>> 0); this.o += 4; return this; }
    i32(v) { this.dv.setInt32(this.o, v); this.o += 4; return this; }
    u64(v) { this.dv.setUint32(this.o, Math.floor(v / 4294967296)); this.dv.setUint32(this.o + 4, v >>> 0); this.o += 8; return this; }
    bytes(b) { this.u8.set(b, this.o); this.o += b.length; return this; }
    zeros(n) { this.o += n; return this; }
}
function mp4Box(type, ...payloads) {
    let size = 8;
    for (const p of payloads) { size += p.length; }
    const w = new ByteWriter(size);
    w.u32(size).bytes(mp4Ascii(type));
    for (const p of payloads) { w.bytes(p); }
    return w.u8;
}
function mp4FullBox(type, version, flags, ...payloads) {
    return mp4Box(type, new Uint8Array([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...payloads);
}
const MP4_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
function mp4Matrix(w) {
    for (const v of MP4_MATRIX) { w.u32(v); }
}
function mp4Descriptor(tag, payload) {
    // 长度用 4 字节扩展写法，兼容任何长度
    const len = payload.length;
    const out = new Uint8Array(5 + len);
    out[0] = tag;
    out[1] = 0x80 | ((len >> 21) & 0x7f);
    out[2] = 0x80 | ((len >> 14) & 0x7f);
    out[3] = 0x80 | ((len >> 7) & 0x7f);
    out[4] = len & 0x7f;
    out.set(payload, 5);
    return out;
}

/** 一个 MP4 文件（或分段中的一段） */
class Mp4Segment {
    constructor(video, audio) {
        this.video = video;   // describeVideoConfig 的结果，或 null
        this.audio = audio;   // describeAacConfig 的结果，或 null
        this.store = new BlobStore();
        this.bytes = 0;
        this.v = { offset: new NumColumn(Float64Array), size: new NumColumn(Uint32Array), dts: new NumColumn(Float64Array), cts: new NumColumn(Int32Array), keys: [] };
        this.a = { offset: new NumColumn(Float64Array), size: new NumColumn(Uint32Array), dts: new NumColumn(Float64Array) };
        this.firstMs = null;
        this.lastMs = 0;
    }
    get videoCount() { return this.v.size.length; }
    get audioCount() { return this.a.size.length; }
    get durationMs() { return this.firstMs === null ? 0 : this.lastMs - this.firstMs; }
    _write(data) {
        const offset = this.bytes;
        this.store.append(data);
        this.bytes += data.length;
        return offset;
    }
    addVideo(data, dts, cts, key) {
        if (!this.video) { return false; }
        if (!this.v.size.length && !key) { return false; }   // 第一帧必须是关键帧
        if (this.v.dts.length && dts <= this.v.dts.last) { dts = this.v.dts.last + 1; }
        this.v.offset.push(this._write(data));
        this.v.size.push(data.length);
        this.v.dts.push(dts);
        this.v.cts.push(cts);
        if (key) { this.v.keys.push(this.v.size.length); }
        this._time(dts + Math.max(cts, 0));
        return true;
    }
    addAudio(data, dts) {
        if (!this.audio) { return false; }
        if (this.video && !this.v.size.length) { return false; }   // 有画面时，从第一个关键帧开始
        if (this.a.dts.length && dts < this.a.dts.last) { dts = this.a.dts.last; }
        this.a.offset.push(this._write(data));
        this.a.size.push(data.length);
        this.a.dts.push(dts);
        this._time(dts);
        return true;
    }
    _time(ms) {
        if (this.firstMs === null || ms < this.firstMs) { this.firstMs = ms; }
        if (ms > this.lastMs) { this.lastMs = ms; }
    }

    /** 生成 MP4 Blob */
    finalize() {
        const tracks = [];
        if (this.video && this.videoCount) { tracks.push(this._videoTrack()); }
        if (this.audio && this.audioCount) { tracks.push(this._audioTrack()); }
        if (!tracks.length) { return null; }

        // 各轨开始时间对齐：最早出画/出声的时刻作为 0
        const t0 = Math.min(...tracks.map(t => t.startMs));
        let movieMs = 0;
        tracks.forEach((t, i) => {
            t.id = i + 1;
            t.emptyMs = Math.round(t.startMs - t0);
            t.editMs = Math.max(1, Math.round((t.mediaDuration - t.mediaTime) * 1000 / t.timescale));
            movieMs = Math.max(movieMs, t.emptyMs + t.editMs);
        });

        const ftyp = mp4Box("ftyp", new ByteWriter(24).bytes(mp4Ascii("isom")).u32(512).bytes(mp4Ascii("isomiso2avc1mp41")).u8);
        const mdatPayload = this.bytes;
        const mdatHeaderSize = mdatPayload + 8 > 0xFFFFFFFF ? 16 : 8;
        // 先用 0 偏移估算 moov 大小，再填入真实偏移（stco/co64 的大小与偏移值无关）
        const use64 = ftyp.length + mdatHeaderSize + mdatPayload + 64 * 1024 * 1024 > 0xFFFFFFFF;
        let moov = this._moov(tracks, movieMs, 0, use64);
        const base = ftyp.length + moov.length + mdatHeaderSize;
        moov = this._moov(tracks, movieMs, base, use64);

        const mdatHeader = new ByteWriter(mdatHeaderSize);
        if (mdatHeaderSize === 16) {
            mdatHeader.u32(1).bytes(mp4Ascii("mdat")).u64(mdatPayload + 16);
        } else {
            mdatHeader.u32(mdatPayload + 8).bytes(mp4Ascii("mdat"));
        }
        return new Blob([ftyp, moov, mdatHeader.u8, ...this.store.parts()], { type: "video/mp4" });
    }

    _videoTrack() {
        const n = this.videoCount;
        const dts = this.v.dts.data, cts = this.v.cts.data;
        const durations = new Uint32Array(n);
        for (let i = 0; i < n - 1; i++) { durations[i] = Math.max(1, dts[i + 1] - dts[i]); }
        durations[n - 1] = n > 1 ? durations[n - 2] : 40;
        let total = 0;
        for (let i = 0; i < n; i++) { total += durations[i]; }
        return {
            kind: "video", timescale: 1000, count: n,
            durations, cts: cts.subarray(0, n).some(v => v !== 0) ? cts.subarray(0, n) : null,
            sizes: this.v.size.data.subarray(0, n), offsets: this.v.offset.data.subarray(0, n),
            keys: this.v.keys.length === n ? null : this.v.keys,
            mediaDuration: total, mediaTime: Math.max(0, cts[0]),
            startMs: dts[0] + Math.max(0, cts[0])
        };
    }
    _audioTrack() {
        const n = this.audioCount;
        const sr = this.audio.sampleRate;
        const dts = this.a.dts.data;
        const frame = 1024;
        const tolerance = sr * 0.005;
        // 连续的 AAC 帧按 1024 采样计时，偏差超过 5ms（断档或时钟漂移）才跟随时间戳，避免毫秒取整带来的抖动
        const times = new Float64Array(n);
        times[0] = 0;
        for (let i = 1; i < n; i++) {
            const actual = Math.round((dts[i] - dts[0]) * sr / 1000);
            const expected = times[i - 1] + frame;
            times[i] = Math.abs(actual - expected) <= tolerance ? expected : Math.max(times[i - 1] + 1, actual);
        }
        const durations = new Uint32Array(n);
        for (let i = 0; i < n - 1; i++) { durations[i] = times[i + 1] - times[i]; }
        durations[n - 1] = frame;
        return {
            kind: "audio", timescale: sr, count: n, durations, cts: null,
            sizes: this.a.size.data.subarray(0, n), offsets: this.a.offset.data.subarray(0, n),
            keys: null, mediaDuration: times[n - 1] + frame, mediaTime: 0, startMs: dts[0]
        };
    }

    _moov(tracks, movieMs, base, use64) {
        const mvhd = new ByteWriter(96);
        const now = Math.floor(Date.now() / 1000) + 2082844800;
        mvhd.u32(now).u32(now).u32(1000).u32(movieMs).u32(0x00010000).u16(0x0100).zeros(10);
        mp4Matrix(mvhd);
        mvhd.zeros(24).u32(tracks.length + 1);
        const traks = tracks.map(t => this._trak(t, base, use64));
        return mp4Box("moov", mp4FullBox("mvhd", 0, 0, mvhd.u8), ...traks);
    }

    _trak(t, base, use64) {
        const isVideo = t.kind === "video";
        const now = Math.floor(Date.now() / 1000) + 2082844800;
        const tkhd = new ByteWriter(80);
        tkhd.u32(now).u32(now).u32(t.id).u32(0).u32(t.emptyMs + t.editMs).zeros(8).u16(0).u16(0).u16(isVideo ? 0 : 0x0100).u16(0);
        mp4Matrix(tkhd);
        tkhd.u32(isVideo ? (this.video.width || 0) * 65536 : 0).u32(isVideo ? (this.video.height || 0) * 65536 : 0);

        // 编辑列表：开头的空白 + 从第一帧的显示时间开始播放
        const edits = [];
        if (t.emptyMs > 0) { edits.push([t.emptyMs, -1]); }
        edits.push([t.editMs, t.mediaTime]);
        const elst = new ByteWriter(4 + edits.length * 12);
        elst.u32(edits.length);
        for (const [dur, mt] of edits) { elst.u32(dur).i32(mt).u16(1).u16(0); }
        const edts = mp4Box("edts", mp4FullBox("elst", 0, 0, elst.u8));

        const mdhdV1 = t.mediaDuration > 0xFFFFFFFF;
        const mdhd = new ByteWriter(mdhdV1 ? 32 : 20);
        if (mdhdV1) {
            mdhd.u64(now).u64(now).u32(t.timescale).u64(t.mediaDuration);
        } else {
            mdhd.u32(now).u32(now).u32(t.timescale).u32(t.mediaDuration);
        }
        mdhd.u16(0x55c4).u16(0);   // 语言 und
        const name = isVideo ? "VideoHandler" : "SoundHandler";
        const hdlr = new ByteWriter(20 + name.length + 1);
        hdlr.u32(0).bytes(mp4Ascii(isVideo ? "vide" : "soun")).zeros(12).bytes(mp4Ascii(name)).u8v(0);

        const mediaHeader = isVideo
            ? mp4FullBox("vmhd", 0, 1, new Uint8Array(8))
            : mp4FullBox("smhd", 0, 0, new Uint8Array(4));
        const dinf = mp4Box("dinf", mp4FullBox("dref", 0, 0, new ByteWriter(4).u32(1).u8, mp4FullBox("url ", 0, 1)));
        const stbl = mp4Box("stbl", ...this._stbl(t, base, use64));
        const minf = mp4Box("minf", mediaHeader, dinf, stbl);
        const mdia = mp4Box("mdia", mp4FullBox("mdhd", mdhdV1 ? 1 : 0, 0, mdhd.u8), mp4FullBox("hdlr", 0, 0, hdlr.u8), minf);
        return mp4Box("trak", mp4FullBox("tkhd", 0, 3, tkhd.u8), edts, mdia);
    }

    _sampleEntry(t) {
        if (t.kind === "video") {
            const v = this.video;
            const w = new ByteWriter(78);
            w.zeros(6).u16(1).zeros(16).u16(v.width || 0).u16(v.height || 0).u32(0x00480000).u32(0x00480000).u32(0).u16(1).zeros(32).u16(0x0018).i16(-1);
            return v.codec === "hevc"
                ? mp4Box("hvc1", w.u8, mp4Box("hvcC", v.config))
                : mp4Box("avc1", w.u8, mp4Box("avcC", v.config));
        }
        const a = this.audio;
        const w = new ByteWriter(28);
        w.zeros(6).u16(1).zeros(8).u16(a.channels).u16(16).u16(0).u16(0).u32(a.sampleRate < 65536 ? a.sampleRate * 65536 : 0);
        const dcd = new ByteWriter(13);
        dcd.u8v(0x40).u8v(0x15).zeros(3).u32(0).u32(0);
        const esPayload = flvConcat(
            new ByteWriter(3).u16(1).u8v(0).u8,
            flvConcat(
                mp4Descriptor(0x04, flvConcat(dcd.u8, mp4Descriptor(0x05, a.config))),
                mp4Descriptor(0x06, new Uint8Array([0x02]))
            )
        );
        return mp4Box("mp4a", w.u8, mp4FullBox("esds", 0, 0, mp4Descriptor(0x03, esPayload)));
    }

    _stbl(t, base, use64) {
        const n = t.count;
        const boxes = [mp4FullBox("stsd", 0, 0, new ByteWriter(4).u32(1).u8, this._sampleEntry(t))];

        // stts：时长相同的连续帧合并
        const runs = [];
        for (let i = 0; i < n; i++) {
            const d = t.durations[i];
            if (runs.length && runs[runs.length - 1][1] === d) { runs[runs.length - 1][0]++; } else { runs.push([1, d]); }
        }
        const stts = new ByteWriter(4 + runs.length * 8);
        stts.u32(runs.length);
        for (const [c, d] of runs) { stts.u32(c).u32(d); }
        boxes.push(mp4FullBox("stts", 0, 0, stts.u8));

        if (t.cts) {
            const cr = [];
            let negative = false;
            for (let i = 0; i < n; i++) {
                const c = t.cts[i];
                if (c < 0) { negative = true; }
                if (cr.length && cr[cr.length - 1][1] === c) { cr[cr.length - 1][0]++; } else { cr.push([1, c]); }
            }
            const ctts = new ByteWriter(4 + cr.length * 8);
            ctts.u32(cr.length);
            for (const [c, o] of cr) { ctts.u32(c).i32(o); }
            boxes.push(mp4FullBox("ctts", negative ? 1 : 0, 0, ctts.u8));
        }
        if (t.keys) {
            const stss = new ByteWriter(4 + t.keys.length * 4);
            stss.u32(t.keys.length);
            for (const k of t.keys) { stss.u32(k); }
            boxes.push(mp4FullBox("stss", 0, 0, stss.u8));
        }
        // 每帧一个 chunk，帧在 mdat 里按到达顺序交错存放
        boxes.push(mp4FullBox("stsc", 0, 0, new ByteWriter(16).u32(1).u32(1).u32(1).u32(1).u8));
        const stsz = new ByteWriter(8 + n * 4);
        stsz.u32(0).u32(n);
        for (let i = 0; i < n; i++) { stsz.u32(t.sizes[i]); }
        boxes.push(mp4FullBox("stsz", 0, 0, stsz.u8));
        const co = new ByteWriter(4 + n * (use64 ? 8 : 4));
        co.u32(n);
        for (let i = 0; i < n; i++) {
            const off = base + t.offsets[i];
            use64 ? co.u64(off) : co.u32(off);
        }
        boxes.push(mp4FullBox(use64 ? "co64" : "stco", 0, 0, co.u8));
        return boxes;
    }
}

/* ---------- FLV 重新写出 ---------- */

class FlvWriter {
    constructor(hasAudio, hasVideo) {
        this.store = new BlobStore();
        const header = new Uint8Array([0x46, 0x4C, 0x56, 1, (hasAudio ? 4 : 0) | (hasVideo ? 1 : 0), 0, 0, 0, 9, 0, 0, 0, 0]);
        this.store.append(header);
        this.firstMs = null;
        this.lastMs = 0;
        this.mediaTags = 0;
    }
    get size() { return this.store.size; }
    get durationMs() { return this.firstMs === null ? 0 : this.lastMs - this.firstMs; }
    addTag(type, ms, data) {
        const isMedia = type !== FLV_TAG_SCRIPT && !isFlvConfigTag(type, data);
        if (isMedia && this.firstMs === null) { this.firstMs = ms; }
        // 每个文件的时间戳都从 0 开始
        const ts = Math.max(0, Math.round(this.firstMs === null ? 0 : ms - this.firstMs)) % 4294967296;
        const head = new Uint8Array(11);
        head[0] = type;
        head[1] = (data.length >> 16) & 255; head[2] = (data.length >> 8) & 255; head[3] = data.length & 255;
        head[4] = (ts >> 16) & 255; head[5] = (ts >> 8) & 255; head[6] = ts & 255; head[7] = (ts / 16777216) & 255;
        const tail = new Uint8Array(4);
        new DataView(tail.buffer).setUint32(0, 11 + data.length);
        this.store.append(head);
        this.store.append(data);
        this.store.append(tail);
        if (isMedia) {
            this.mediaTags++;
            this.lastMs = Math.max(this.lastMs, ms);
        }
    }
    finalize() {
        return new Blob(this.store.parts(), { type: "video/x-flv" });
    }
}

function isFlvConfigTag(type, data) {
    if (type === FLV_TAG_VIDEO) { return parseFlvVideo(data).kind !== "frame"; }
    if (type === FLV_TAG_AUDIO) { return parseFlvAudio(data).kind !== "frame"; }
    return false;
}

/* ---------- 直播录制：时间戳、重连、分段 ---------- */

class LiveRemuxer {
    /**
     * @param {Object} opts
     * @param {Boolean} opts.keepFlv 同时保留 FLV
     * @param {Function} opts.onSegment (result) 一段完成时回调：{ mp4, flv, durationMs, reason }
     * @param {Function} opts.onCodec (info) 编码信息变化
     */
    constructor(opts = {}) {
        this.opts = opts;
        this.demuxer = new FlvDemuxer((type, ts, data) => this._onTag(type, ts, data));
        this.video = null;
        this.audio = null;
        this.unsupported = new Set();
        this.mode = null;           // null=尚未确定，"mp4" 或 "flv"
        this.decideTags = 0;
        this.segment = null;
        this.flv = null;
        this.segmentIndex = 0;
        this.splitRequested = null;
        this.segmentLimitMs = 0;
        // 时间戳
        this.anchorIn = null;
        this.anchorOut = 0;
        this.maxOut = null;
        this.lastOutByType = {};
        this.needKey = true;
        this.mediaTags = 0;
        this.metadata = null;
        this.videoConfigTag = null;   // 原样保存的配置 tag，重新开 FLV 文件时写在最前面
        this.audioConfigTag = null;
    }

    /** 已录总时长（毫秒，跨分段） */
    get totalMs() { return this.maxOut || 0; }

    /** 新连接（首次或重连） */
    newConnection() {
        this.demuxer.reset();
        this.anchorIn = null;
        this.needKey = true;
        this.mediaTags = 0;
    }
    push(chunk) { this.demuxer.push(chunk); }

    get hasData() {
        return !!((this.segment && (this.segment.videoCount || this.segment.audioCount)) || (this.flv && this.flv.durationMs > 0));
    }
    get durationMs() {
        return this.mode === "flv" && this.flv ? this.flv.durationMs : (this.segment ? this.segment.durationMs : 0);
    }
    get outputBytes() {
        return (this.segment ? this.segment.bytes : 0) + (this.flv ? this.flv.size : 0);
    }

    /** 请求在下一个关键帧处切分 */
    requestSplit(reason = "manual") { this.splitRequested = reason; }

    _ts(type, ts) {
        if (this.anchorIn === null) {
            this.anchorIn = ts;
            this.anchorOut = this.maxOut === null ? 0 : this.maxOut + 40;
        }
        let out = ts - this.anchorIn + this.anchorOut;
        const lastSame = this.lastOutByType[type];
        // 时间戳回退或跳跃过大（推流端重启、时间戳回绕）：接着已录内容往后排
        if ((lastSame !== undefined && out < lastSame - 1000) || (this.maxOut !== null && out > this.maxOut + 10000)) {
            this.anchorIn = ts;
            this.anchorOut = (this.maxOut === null ? 0 : this.maxOut) + 40;
            out = this.anchorOut;
        }
        this.lastOutByType[type] = out;
        if (this.maxOut === null || out > this.maxOut) { this.maxOut = out; }
        return out;
    }

    _onTag(type, ts, data) {
        if (type === FLV_TAG_SCRIPT) {
            if (!this.metadata) { this.metadata = data.slice(); }
            if (this.flv) { this.flv.addTag(type, this.maxOut || 0, data); }
            return;
        }
        if (type !== FLV_TAG_AUDIO && type !== FLV_TAG_VIDEO) { return; }
        const p = type === FLV_TAG_VIDEO ? parseFlvVideo(data) : parseFlvAudio(data);
        if (p.kind === "other") { return; }

        if (p.kind === "config") {
            if (type === FLV_TAG_VIDEO) { this.videoConfigTag = data.slice(); } else { this.audioConfigTag = data.slice(); }
            if (this.flv) { this.flv.addTag(type, this.maxOut || 0, data); }
            this._onConfig(type, p);
            return;
        }

        // 媒体帧
        const isVideo = type === FLV_TAG_VIDEO;
        const supported = isVideo ? MP4_SUPPORTED.video.includes(p.codec) : MP4_SUPPORTED.audio.includes(p.codec);
        if (!supported) {
            this.unsupported.add(p.codec);
        }
        if (isVideo && this.needKey) {
            if (!p.key) { return; }
            this.needKey = false;
        }
        const ms = this._ts(type, ts);
        this.mediaTags++;

        if (this.mode === null) {
            this._ensureFlv();
            this.decideTags++;
            this._maybeDecide();
        }
        if (this.flv) { this.flv.addTag(type, ms, data); }

        if (this.mode !== "flv") {
            // 有画面时只在关键帧处切分；纯音频随时可切
            const canSplit = isVideo ? p.key : !this.video;
            if (canSplit && this.segment && (this.segment.videoCount || this.segment.audioCount)) {
                const limit = this.segmentLimitMs;
                if (this.splitRequested || (limit && this.segment.durationMs >= limit)) {
                    this._finishSegment(this.splitRequested || "auto");
                }
            }
            if (!this.segment) { this._startSegment(); }
            // 只收和当前编码参数一致的帧（中途换成不支持的编码时，这些帧只进 FLV）
            if (isVideo && this.video && this.video.codec === p.codec) {
                this.segment.addVideo(p.data, ms, p.cts, p.key);
            } else if (!isVideo && this.audio && this.audio.codec === p.codec) {
                this.segment.addAudio(p.data, ms);
            }
        } else if (this.splitRequested || (this.segmentLimitMs && this.flv && this.flv.durationMs >= this.segmentLimitMs)) {
            if (!isVideo || p.key || !this.video) { this._finishSegment(this.splitRequested || "auto"); }
        }
    }

    _onConfig(type, p) {
        if (type === FLV_TAG_VIDEO) {
            if (!MP4_SUPPORTED.video.includes(p.codec)) { this.unsupported.add(p.codec); return; }
            if (this.video && this.video.codec === p.codec && flvSameBytes(this.video.config, p.data)) { return; }
            const changed = !!this.video;
            this.video = describeVideoConfig(p.codec, p.data);
            if (changed && this.segment && this.segment.videoCount) {
                // 分辨率或编码参数变化：前面的内容单独存一段，后面重新开始
                this._finishSegment("config");
            } else if (this.segment && !this.segment.videoCount) {
                this.segment.video = this.video;
            }
        } else {
            if (!MP4_SUPPORTED.audio.includes(p.codec)) { this.unsupported.add(p.codec); return; }
            if (this.audio && flvSameBytes(this.audio.config, p.data)) { return; }
            const changed = !!this.audio;
            this.audio = describeAacConfig(p.data);
            if (changed && this.segment && this.segment.audioCount) {
                this._finishSegment("config");
            } else if (this.segment && !this.segment.audioCount) {
                this.segment.audio = this.audio;
            }
        }
        this.opts.onCodec && this.opts.onCodec(this.codecInfo());
    }

    codecInfo() {
        return {
            video: this.video ? { codec: this.video.codec, width: this.video.width, height: this.video.height } : null,
            audio: this.audio ? { codec: this.audio.codec, sampleRate: this.audio.sampleRate, channels: this.audio.channels } : null,
            unsupported: [...this.unsupported],
            mode: this.mode
        };
    }

    _ensureFlv() {
        if (!this.flv) {
            const flags = this.demuxer.flags;
            this.flv = new FlvWriter(flags ? !!(flags & 4) : true, flags ? !!(flags & 1) : true);
            if (this.metadata) { this.flv.addTag(FLV_TAG_SCRIPT, 0, this.metadata); }
            if (this.videoConfigTag) { this.flv.addTag(FLV_TAG_VIDEO, 0, this.videoConfigTag); }
            if (this.audioConfigTag) { this.flv.addTag(FLV_TAG_AUDIO, 0, this.audioConfigTag); }
        }
    }

    /** 判断能否封装成 MP4：遇到不支持的编码就整段改存 FLV */
    _maybeDecide() {
        if (this.unsupported.size) {
            this.mode = "flv";
        } else {
            const flags = this.demuxer.flags;
            const wantVideo = flags ? !!(flags & 1) : true;
            const wantAudio = flags ? !!(flags & 4) : true;
            const ready = (!wantVideo || this.video) && (!wantAudio || this.audio);
            if (ready && this.decideTags >= 2) {
                this.mode = "mp4";
            } else if (this.decideTags >= 300 && (this.video || this.audio)) {
                // 头里声明了某个轨道但一直没有数据，按实际有的轨道来
                this.mode = "mp4";
            }
        }
        if (this.mode === "mp4" && !this.opts.keepFlv) {
            this.flv = null;
        }
        if (this.mode === "flv") {
            this.segment = null;
        }
        if (this.mode) {
            this.opts.onCodec && this.opts.onCodec(this.codecInfo());
        }
    }

    _startSegment() {
        this.segment = new Mp4Segment(this.video, this.audio);
    }

    _finishSegment(reason) {
        this.splitRequested = null;
        const result = this._collect(reason);
        if (result) {
            this.segmentIndex++;
            this.opts.onSegment && this.opts.onSegment(result);
        }
        if (this.mode !== "flv") { this._startSegment(); }
    }

    _collect(reason) {
        let mp4 = null, flv = null, durationMs = 0;
        if (this.segment && (this.segment.videoCount || this.segment.audioCount)) {
            durationMs = this.segment.durationMs;
            mp4 = this.segment.finalize();
        }
        this.segment = null;
        if (this.flv && this.flv.mediaTags > 0) {
            durationMs = durationMs || this.flv.durationMs;
            flv = this.flv.finalize();
            this.flv = null;
            if (this.mode !== "mp4" || this.opts.keepFlv) { this._ensureFlv(); }
        }
        if (!mp4 && !flv) { return null; }
        return { mp4, flv, durationMs, reason, index: this.segmentIndex + 1 };
    }

    /** 结束录制，返回最后一段 */
    finish(reason = "stop") {
        if (this.mode === null && (this.video || this.audio || this.flv)) {
            this.mode = this.unsupported.size ? "flv" : "mp4";
            if (this.mode === "flv") { this.segment = null; }
        }
        const result = this._collect(reason);
        this.flv = null;
        this.segment = null;
        if (result) { this.segmentIndex++; }
        return result;
    }
}

// 供 Node 测试使用
if (typeof module !== "undefined" && module.exports) {
    module.exports = { FlvDemuxer, LiveRemuxer, Mp4Segment, FlvWriter, parseFlvVideo, parseFlvAudio, describeVideoConfig, describeAacConfig };
}
