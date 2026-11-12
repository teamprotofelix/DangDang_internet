// ============================================================
// file-io.js — 문서 텍스트 추출 / 내보내기
// 지원: txt, md, json, xml, pdf, hwpx (글자 중심)
// ============================================================

const FileIO = {
  ACCEPT: '.pdf,.hwpx,.txt,.md,.json,.xml,.text,.markdown',
  MAX_BYTES: 20 * 1024 * 1024,
  CHAT_MAX_CHARS: 100000,
  WORK_MAX_CHARS: 200000,

  async parseFile(file, { maxChars = this.WORK_MAX_CHARS } = {}) {
    if (!file) throw new Error('파일이 없어요');
    if (file.size > this.MAX_BYTES) {
      throw new Error('파일이 너무 커요 (최대 20MB)');
    }
    const name = file.name || '파일';
    const ext = this.extOf(name);
    const buf = await file.arrayBuffer();

    let text = '';
    let meta = null; // hwpx/pdf 진단 정보 (warnings/stats)
    if (ext === 'pdf') {
      const parsed = await this.parsePdf(buf);
      text = parsed.text;
      meta = { warnings: parsed.warnings || [], stats: parsed.stats || null };
    }
    else if (ext === 'hwpx') {
      const parsed = await this.parseHwpx(buf);
      text = parsed.text;
      meta = { warnings: parsed.warnings || [], stats: parsed.stats || null };
    }
    else if (ext === 'hwp') {
      throw new Error('옛 HWP(바이너리)는 못 읽어요. HWPX로 저장해서 올려줘!');
    } else if (['txt', 'md', 'markdown', 'text', 'json', 'xml', 'html', 'htm', 'csv'].includes(ext)) {
      text = this.decodeText(buf);
      if (ext === 'json') text = this.prettyJson(text);
      if (ext === 'xml' || ext === 'html' || ext === 'htm') text = this.stripXmlToText(text);
    } else {
      throw new Error(`아직 ${ext || '이 형식'}은 못 읽어. pdf, hwpx, txt, md, json, xml 을 올려줘!`);
    }

    text = this.cleanExtracted(text);
    if (!text) {
      const extra = meta?.warnings?.length ? ` (${meta.warnings[0]})` : '';
      throw new Error(`글자를 찾지 못했어${extra}. 스캔본이거나 암호 문서일 수 있어.`);
    }

    let truncated = false;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + '\n\n… (너무 길어서 앞부분만 넣었어)';
      truncated = true;
    }
    return { name, ext, text, truncated, chars: text.length, warnings: meta?.warnings || [], stats: meta?.stats || null };
  },

  extOf(name) {
    const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  },

  decodeText(buf) {
    const bytes = new Uint8Array(buf);
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
      return new TextDecoder('utf-16le').decode(bytes);
    }
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
      return new TextDecoder('utf-16be').decode(bytes);
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  },

  prettyJson(text) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  },

  stripXmlToText(xml) {
    return String(xml)
      .replace(/<\?xml[\s\S]*?\?>/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, '\u00A0')
      .replace(/&nbsp;/g, '\u00A0')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
  },

  cleanExtracted(text) {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/\u0000/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  },

  wrapForChat(name, text) {
    return `[첨부 파일: ${name}]\n${text}`;
  },

  // ----------------------------------------------------------
  // ZIP (읽기 / 쓰기) — HWPX용. 압축 해제는 DecompressionStream
  // ----------------------------------------------------------

  // ZIP bomb 방지 상한 (HWPX포맷forLLM.md §3-1)
  _zipLimits() {
    return { maxEntries: 4096, maxNameBytes: 512, maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024 };
  },

  async unzip(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    const L = this._zipLimits();
    const eocd = this._findEocd(view, bytes.length);
    if (eocd < 0) throw new Error('ZIP(HWPX) 구조를 찾지 못했어');

    const count = view.getUint16(eocd + 10, true);
    if (count === 0) throw new Error('ZIP이 비어 있어');
    if (count === 0xFFFF || count > L.maxEntries) {
      throw new Error(`ZIP 항목이 너무 많아 (${count}개, 최대 ${L.maxEntries}개)`);
    }
    let cdOff = view.getUint32(eocd + 16, true);
    if (cdOff === 0xFFFFFFFF) throw new Error('ZIP64는 지원하지 않아');

    const files = {};
    const dec = new TextDecoder('utf-8');
    let total = 0;

    for (let n = 0; n < count; n++) {
      if (cdOff + 46 > bytes.length || view.getUint32(cdOff, true) !== 0x02014b50) {
        throw new Error('ZIP 중앙 디렉터리가 손상됐어');
      }
      const flags = view.getUint16(cdOff + 8, true);
      if (flags & 0x1) throw new Error('항목이 암호화된 ZIP은 읽을 수 없어');
      const method = view.getUint16(cdOff + 10, true);
      const crcStored = view.getUint32(cdOff + 16, true);
      const compSize = view.getUint32(cdOff + 20, true);
      const uncompSize = view.getUint32(cdOff + 24, true);
      const nameLen = view.getUint16(cdOff + 28, true);
      const extraLen = view.getUint16(cdOff + 30, true);
      const commentLen = view.getUint16(cdOff + 32, true);
      const localOff = view.getUint32(cdOff + 42, true);
      if (!nameLen || nameLen > L.maxNameBytes) throw new Error('ZIP 항목 이름이 비었거나 너무 길어');

      const nameRaw = bytes.subarray(cdOff + 46, cdOff + 46 + nameLen);
      if (nameRaw.indexOf(0) >= 0) throw new Error('ZIP 항목 이름에 잘못된 문자가 있어');
      const name = dec.decode(nameRaw).replace(/\\/g, '/');
      this._assertSafeZipPath(name);

      if (localOff + 30 > bytes.length || view.getUint32(localOff, true) !== 0x04034b50) {
        throw new Error(`ZIP 항목이 손상됐어: ${name}`);
      }
      const localNameLen = view.getUint16(localOff + 26, true);
      const localExtra = view.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + localNameLen + localExtra;
      const end = dataStart + compSize;
      if (end > bytes.length) throw new Error(`ZIP 항목 크기가 파일보다 커: ${name}`);

      cdOff += 46 + nameLen + extraLen + commentLen;

      // 디렉터리 표시 항목은 데이터가 없음
      if (name.endsWith('/')) continue;
      if (files[name] !== undefined) throw new Error(`ZIP에 같은 경로가 두 번 있어: ${name}`);
      if (uncompSize > L.maxEntryBytes) {
        throw new Error(`압축을 풀면 너무 큰 항목이 있어: ${name} (${Math.round(uncompSize / 1024 / 1024)}MB)`);
      }
      total += uncompSize;
      if (total > L.maxTotalBytes) throw new Error(`압축 해제 총량이 너무 커 (${Math.round(total / 1024 / 1024)}MB)`);

      const comp = bytes.subarray(dataStart, end);
      let raw;
      if (method === 0) raw = comp;
      else if (method === 8) raw = await this._inflate(comp, 'deflate-raw');
      else throw new Error(`지원하지 않는 ZIP 압축 방식 (${method})`);

      if (raw.length !== uncompSize) throw new Error(`ZIP 압축 해제 크기가 안 맞아: ${name}`);
      if (this.crc32(raw) !== crcStored) throw new Error(`ZIP 검사합(CRC)이 안 맞아: ${name}`);

      files[name] = this.decodeText(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
      files['__bin__:' + name] = raw;
    }
    return files;
  },

  _assertSafeZipPath(name) {
    if (name.startsWith('/') || /^[a-zA-Z]:\//.test(name)) {
      throw new Error(`위험한 ZIP 경로가 있어: ${name}`);
    }
    if (name.split('/').includes('..')) {
      throw new Error(`ZIP 경로에 ..이 들어 있어: ${name}`);
    }
  },

  _findEocd(view, length) {
    const min = Math.max(0, length - 22 - 65535);
    for (let i = length - 22; i >= min; i--) {
      if (view.getUint32(i, true) === 0x06054b50) return i;
    }
    return -1;
  },

  async _inflate(data, format) {
    const ds = new DecompressionStream(format);
    const stream = new Blob([data]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  },

  crc32(bytes) {
    if (!this._crcTable) {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c >>> 0;
      }
      this._crcTable = t;
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc = this._crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  },

  async _deflateRaw(data) {
    const cs = new CompressionStream('deflate-raw');
    const stream = new Blob([data]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  },

  /**
   * HWPX용 ZIP. mimetype/version.xml 은 저장(store), 나머지는 deflate.
   * entries: [{ name, data: Uint8Array|string, store?: boolean }]
   */
  async zipPackage(entries, mime = 'application/hwp+zip') {
    const enc = new TextEncoder();
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const ent of entries) {
      const nameBytes = enc.encode(ent.name);
      const raw = typeof ent.data === 'string' ? enc.encode(ent.data) : ent.data;
      const crc = this.crc32(raw);
      const store = !!ent.store;
      const payload = store ? raw : await this._deflateRaw(raw);
      const method = store ? 0 : 8;

      const local = new Uint8Array(30 + nameBytes.length + payload.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // UTF-8 file names
      lv.setUint16(8, method, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, payload.length, true);
      lv.setUint32(22, raw.length, true);
      lv.setUint16(26, nameBytes.length, true);
      local.set(nameBytes, 30);
      local.set(payload, 30 + nameBytes.length);
      locals.push(local);

      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true); // UTF-8 file names
      cv.setUint16(10, method, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, payload.length, true);
      cv.setUint32(24, raw.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      central.set(nameBytes, 46);
      centrals.push(central);
      offset += local.length;
    }

    const cdSize = centrals.reduce((s, c) => s + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    return new Blob([...locals, ...centrals, eocd], { type: mime });
  },

  zipStore(entries, mime) {
    return this.zipPackage(entries.map((e) => ({ ...e, store: true })), mime);
  },

  // ----------------------------------------------------------
  // HWPX
  // ----------------------------------------------------------

  // HWPX namespace 인식: 접두어가 아니라 namespace URI로 판별 (HWPX포맷forLLM.md §2)
  HW_NS_RE: /(hancom\.co\.kr|owpml\.org)/,

  async parseHwpx(arrayBuffer) {
    const files = await this.unzip(arrayBuffer);
    const warnings = [];
    const stats = { sections: 0, paragraphs: 0, tables: 0, images: 0, footnotes: 0, unsupported: 0 };
    const unknown = new Map(); // 미지원 요소명 -> 횟수

    // 1) mimetype 입력 검사
    const mt = files['mimetype'];
    if (typeof mt !== 'string' || !/^application\/hwp\+zip\b/i.test(mt.trim())) {
      throw new Error('HWPX 형식이 아니야 (mimetype 항목이 없거나 달라)');
    }

    // 2) 암호화 문서 감지
    const encManifest = files['META-INF/manifest.xml'];
    if (typeof encManifest === 'string' && /encryption/i.test(encManifest) && /algorithm/i.test(encManifest)) {
      throw new Error('암호가 걸린 HWPX는 열 수 없어');
    }

    // 3) 패키지 인덱스: content.hpf의 manifest와 spine으로 본문 구역 순서 결정
    const pkg = this._parseHwpxPackage(files, warnings);

    // 4) 서식 인덱스: header.xml 참조 테이블을 ID 사전으로
    const fmt = this._parseHwpxHeader(files, warnings);
    if (fmt.secCnt != null && pkg.sections.length !== fmt.secCnt) {
      warnings.push(`header.xml의 secCnt(${fmt.secCnt})와 실제 구역 수(${pkg.sections.length})가 달라`);
    }

    // 5) 구역별 IR 파싱 → 텍스트 렌더
    const ctx = { files, fmt, warnings, stats, unknown };
    const parts = [];
    for (const href of pkg.sections) {
      const xml = files[href];
      if (xml == null) {
        warnings.push(`manifest에는 있지만 패키지에 없는 구역: ${href}`);
        continue;
      }
      const rendered = this._parseHwpxSectionXml(xml, href, ctx);
      if (rendered) parts.push(rendered);
    }

    if (!parts.length) {
      const preview = Object.keys(files).find((n) => /^Preview\/PrvText/i.test(n));
      if (preview) {
        warnings.push('본문 구역을 찾지 못해 Preview/PrvText의 텍스트를 사용했어 (서식·표·그림 손실 가능)');
        return { text: this.cleanExtracted(files[preview]), warnings, stats };
      }
      throw new Error('HWPX 본문(section.xml)을 찾지 못했어');
    }

    for (const [el, n] of unknown) {
      warnings.push(`지원하지 않는 요소 <${el}> (${n}회) — 안의 텍스트는 보존했어`);
      stats.unsupported += n;
    }

    return { text: parts.join('\n\n'), warnings, stats };
  },

  // content.hpf → { manifest: id→{href,mediaType}, sections: [본문 href...] }
  _parseHwpxPackage(files, warnings) {
    const out = { manifest: new Map(), sections: [] };
    const byNumber = () => Object.keys(files)
      .filter((n) => /section\d+\.xml$/i.test(n))
      .sort((a, b) => {
        const na = Number((a.match(/section(\d+)/i) || [])[1] || 0);
        const nb = Number((b.match(/section(\d+)/i) || [])[1] || 0);
        return na - nb;
      });
    const hpfXml = files['Contents/content.hpf'];
    if (!hpfXml) {
      warnings.push('content.hpf가 없어 구역을 파일명 숫자 순서로 읽었어');
      out.sections = byNumber();
      return out;
    }
    const doc = this._xmlDoc(hpfXml, 'Contents/content.hpf');
    if (!doc) {
      warnings.push('content.hpf를 해석하지 못해 구역을 파일명 숫자 순서로 읽었어');
      out.sections = byNumber();
      return out;
    }

    for (const item of Array.from(doc.getElementsByTagNameNS('*', 'item'))) {
      const id = item.getAttribute('id');
      const href = item.getAttribute('href');
      if (id == null || href == null) continue;
      out.manifest.set(id, {
        href: String(href).replace(/\\/g, '/'),
        mediaType: item.getAttribute('media-type') || ''
      });
    }

    const spine = doc.getElementsByTagNameNS('*', 'spine')[0];
    if (spine) {
      const seen = new Set();
      for (const ref of Array.from(spine.getElementsByTagNameNS('*', 'itemref'))) {
        const item = out.manifest.get(ref.getAttribute('idref'));
        const href = item ? item.href : '';
        if (item && /(^|\/)section\d+\.xml$/i.test(href) && !seen.has(href)) {
          seen.add(href);
          out.sections.push(href);
        }
      }
    }
    if (!out.sections.length) {
      warnings.push('content.hpf의 spine에서 본문 구역을 찾지 못해 파일명 숫자 순서로 읽었어');
      out.sections = byNumber();
    }
    return out;
  },

  // header.xml → 글꼴/charPr/paraPr/styles ID 사전 (ID를 배열 위치로 가정하지 않음)
  _parseHwpxHeader(files, warnings) {
    const fmt = { secCnt: null, paraPr: new Map(), charPr: new Map(), fonts: new Map() };
    const xml = files['Contents/header.xml'];
    if (!xml) {
      warnings.push('header.xml이 없어 글자·문단 서식을 해석하지 못했어');
      return fmt;
    }
    const doc = this._xmlDoc(xml, 'Contents/header.xml');
    if (!doc) {
      warnings.push('header.xml을 해석하지 못했어 (서식 무시)');
      return fmt;
    }

    const head = doc.getElementsByTagNameNS('*', 'head')[0];
    if (head && head.getAttribute('secCnt') != null) {
      const n = Number(head.getAttribute('secCnt'));
      if (Number.isFinite(n)) fmt.secCnt = n;
    }

    // 글꼴: 언어별 font id → face 이름 (bold 판정용)
    for (const ff of Array.from(doc.getElementsByTagNameNS('*', 'fontface'))) {
      const lang = String(ff.getAttribute('lang') || '').toUpperCase();
      for (const f of Array.from(ff.getElementsByTagNameNS('*', 'font'))) {
        const id = f.getAttribute('id');
        if (id == null) continue;
        if (!fmt.fonts.has(lang)) fmt.fonts.set(lang, new Map());
        fmt.fonts.get(lang).set(id, String(f.getAttribute('face') || ''));
      }
    }

    for (const cp of Array.from(doc.getElementsByTagNameNS('*', 'charPr'))) {
      const id = cp.getAttribute('id');
      if (id == null) continue;
      const fr = cp.getElementsByTagNameNS('*', 'fontRef')[0];
      const refs = {};
      if (fr) for (const a of Array.from(fr.attributes)) refs[a.name] = a.value;
      fmt.charPr.set(id, { refs, bold: this._hwpxIsBold(refs, fmt.fonts) });
    }

    for (const pp of Array.from(doc.getElementsByTagNameNS('*', 'paraPr'))) {
      const id = pp.getAttribute('id');
      if (id == null) continue;
      const h = pp.getElementsByTagNameNS('*', 'heading')[0];
      let outline = 0;
      if (h && h.getAttribute('type') === 'OUTLINE') {
        outline = Math.min(6, Number(h.getAttribute('level')) || 0);
      }
      fmt.paraPr.set(id, { outline });
    }
    return fmt;
  },

  _hwpxIsBold(refs, fonts) {
    if (!refs) return false;
    for (const lang of ['hangul', 'latin']) {
      const fid = refs[lang];
      if (fid == null) continue;
      const face = (fonts.get(lang.toUpperCase()) || new Map()).get(fid);
      if (face && /(bold|black|heavy|semibold|extra|굵|볼드)/i.test(face)) return true;
    }
    return false;
  },

  _xmlDoc(xml, label) {
    try {
      const doc = new DOMParser().parseFromString(String(xml), 'application/xml');
      if (doc.getElementsByTagName('parsererror').length) {
        console.warn('[FileIO] XML 파싱 오류:', label);
        return null;
      }
      return doc;
    } catch (e) {
      console.warn('[FileIO] XML 파싱 예외:', label, e);
      return null;
    }
  },

  _hwpxNsOk(el) {
    const ns = el.namespaceURI || '';
    return !ns || this.HW_NS_RE.test(ns);
  },

  // 구역 XML → IR 블록 → 텍스트
  _parseHwpxSectionXml(xml, href, ctx) {
    const { warnings, stats } = ctx;
    const doc = this._xmlDoc(xml, href);
    if (!doc) {
      warnings.push(`구역 XML을 해석하지 못했어: ${href}`);
      return null;
    }
    const sec = doc.getElementsByTagNameNS('*', 'sec')[0];
    if (!sec) {
      warnings.push(`sec 요소가 없는 구역: ${href}`);
      return null;
    }
    stats.sections++;

    const blocks = [];
    const notes = [];
    for (const el of Array.from(sec.children)) {
      const ln = el.localName;
      if (ln === 'secPr') continue;
      if (ln === 'ctrl') {
        if (!ctx.ctrlSkipped) {
          ctx.ctrlSkipped = true;
          warnings.push('머리말·꼬리말·쪽번호(ctrl)는 본문에서 생략했어');
        }
        continue;
      }
      if (!this._hwpxNsOk(el)) {
        this._hwpxNoteUnknown(el, ctx);
        const text = this._hwpxInlineText(el, ctx).trim();
        if (text) blocks.push({ type: 'p', text });
        continue;
      }
      if (ln === 'p') {
        const para = this._hwpxParagraph(el, ctx);
        if (para.blocks.length) blocks.push(...para.blocks);
        if (para.notes.length) notes.push(...para.notes);
        continue;
      }
      if (ln === 'tbl') {
        const rows = this._hwpxTableRows(el, ctx, 0);
        if (rows.length) {
          blocks.push({ type: 'table', rows });
          stats.tables++;
        }
        continue;
      }
      if (ln === 'pic') {
        blocks.push({ type: 'image', label: this._hwpxImageLabel(el, ctx) });
        continue;
      }
      if (ln === 'footNote' || ln === 'endNote') {
        notes.push(this._hwpxNote(el, ln, ctx));
        continue;
      }
      this._hwpxNoteUnknown(el, ctx);
      const text = this._hwpxInlineText(el, ctx).trim();
      if (text) blocks.push({ type: 'p', text });
    }

    // 각주/미주 본문을 구역 끝에 붙임
    for (const n of notes) {
      blocks.push({ type: 'p', text: `[${n.kind === 'footNote' ? '각주' : '미주'} ${n.id}] ${n.text}` });
    }

    return this._renderHwpxBlocks(blocks);
  },

  // 문단 → 텍스트 블록(들). run 안의 표는 별도 표 블록으로 분리
  _hwpxParagraph(el, ctx) {
    const { fmt, stats } = ctx;
    stats.paragraphs++;
    const blocks = [];
    const notes = [];
    let text = '';

    const prRef = el.getAttribute('paraPrIDRef');
    const pr = prRef != null ? fmt.paraPr.get(prRef) : null;
    const outline = pr ? pr.outline : 0;

    const flush = () => {
      if (text.trim()) blocks.push({ type: 'p', text: text.trim(), outline });
      text = '';
    };

    for (const ch of Array.from(el.children)) {
      const ln = ch.localName;
      if (!this._hwpxNsOk(ch)) {
        this._hwpxNoteUnknown(ch, ctx);
        text += this._hwpxInlineText(ch, ctx);
        continue;
      }
      if (ln === 'run') {
        const crRef = ch.getAttribute('charPrIDRef');
        const cp = crRef != null ? fmt.charPr.get(crRef) : null;
        const bold = !!(cp && cp.bold);
        for (const rc of Array.from(ch.children)) {
          const rl = rc.localName;
          if (!this._hwpxNsOk(rc)) {
            this._hwpxNoteUnknown(rc, ctx);
            text += this._hwpxInlineText(rc, ctx);
          } else if (rl === 't') {
            const s = this._hwpxTText(rc, ctx);
            text += (bold && s.trim()) ? '**' + s.trim() + '**' : s;
          } else if (rl === 'tab') text += '\t';
          else if (rl === 'lineBreak') text += '\n';
          else if (rl === 'nbSpace') text += '\u00A0';
          else if (rl === 'fwSpace') text += '\u3000';
          else if (rl === 'pic') text += this._hwpxImageLabel(rc, ctx);
          else if (rl === 'footNote' || rl === 'endNote') {
            const n = this._hwpxNote(rc, rl, ctx);
            text += `[${rl === 'footNote' ? '각주' : '미주'} ${n.id}]`;
            notes.push(n);
          } else if (rl === 'tbl') {
            flush();
            const rows = this._hwpxTableRows(rc, ctx, 0);
            if (rows.length) {
              blocks.push({ type: 'table', rows });
              stats.tables++;
            }
          } else if (rl === 'secPr' || rl === 'ctrl') {
            continue;
          } else {
            this._hwpxNoteUnknown(rc, ctx);
            text += this._hwpxInlineText(rc, ctx);
          }
        }
      } else if (ln === 'tbl') {
        flush();
        const rows = this._hwpxTableRows(ch, ctx, 0);
        if (rows.length) {
          blocks.push({ type: 'table', rows });
          stats.tables++;
        }
      } else if (ln === 'pic') text += this._hwpxImageLabel(ch, ctx);
      else if (ln === 'tab') text += '\t';
      else if (ln === 'lineBreak') text += '\n';
      else if (ln === 'nbSpace') text += '\u00A0';
      else if (ln === 'fwSpace') text += '\u3000';
      else if (ln === 'footNote' || ln === 'endNote') {
        const n = this._hwpxNote(ch, ln, ctx);
        text += `[${ln === 'footNote' ? '각주' : '미주'} ${n.id}]`;
        notes.push(n);
      } else if (ln === 'secPr' || ln === 'ctrl') {
        continue;
      } else {
        this._hwpxNoteUnknown(ch, ctx);
        text += this._hwpxInlineText(ch, ctx);
      }
    }
    flush();
    return { blocks, notes };
  },

  // hp:t mixed content: text → 자식 의미 변환 → tail 순서로 순회
  _hwpxTText(el, ctx) {
    let s = '';
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3 || n.nodeType === 4) s += n.nodeValue; // text/CDATA
      else if (n.nodeType === 1) {
        const ln = n.localName;
        if (ln === 'tab') s += '\t';
        else if (ln === 'lineBreak') s += '\n';
        else if (ln === 'nbSpace') s += '\u00A0';
        else if (ln === 'fwSpace') s += '\u3000';
        else if (ln === 'pic') s += this._hwpxImageLabel(n, ctx);
        else if (ln === 'footNote' || ln === 'endNote') {
          const note = this._hwpxNote(n, ln, ctx);
          s += `[${ln === 'footNote' ? '각주' : '미주'} ${note.id}]`;
        } else {
          this._hwpxNoteUnknown(n, ctx);
          s += this._hwpxInlineText(n, ctx);
        }
      }
    }
    return s;
  },

  // 알 수 없는 요소의 텍스트 보존용 재귀 추출 (경고는 호출부에서 기록)
  _hwpxInlineText(el, ctx) {
    let s = '';
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3 || n.nodeType === 4) s += n.nodeValue;
      else if (n.nodeType === 1) {
        const ln = n.localName;
        if (ln === 'tab') s += '\t';
        else if (ln === 'lineBreak') s += '\n';
        else if (ln === 'nbSpace') s += '\u00A0';
        else if (ln === 'fwSpace') s += '\u3000';
        else s += this._hwpxInlineText(n, ctx);
      }
    }
    return s;
  },

  // 미지원 요소를 조용히 지우지 않고 유형·횟수를 기록
  _hwpxNoteUnknown(el, ctx) {
    if (!el || el.nodeType !== 1) return;
    const ln = el.localName;
    if (ln === 'insert' || ln === 'delete' || ln === 'update') {
      const key = '(변경 추적: ' + ln + ')';
      ctx.unknown.set(key, (ctx.unknown.get(key) || 0) + 1);
      return;
    }
    const key = (el.prefix ? el.prefix + ':' : '') + ln;
    ctx.unknown.set(key, (ctx.unknown.get(key) || 0) + 1);
  },

  _hwpxImageLabel(el, ctx) {
    ctx.stats.images++;
    const ole = el.getElementsByTagNameNS('*', 'ole')[0];
    if (ole) {
      ctx.warnings.push('OLE 개체는 실행하지 않고 [OLE 개체]로 표시했어');
      return '[OLE 개체]';
    }
    const img = el.getElementsByTagNameNS('*', 'img')[0];
    const href = img ? String(img.getAttribute('href') || '').replace(/\\/g, '/') : '';
    const base = href.split('/').pop();
    if (!base) {
      ctx.warnings.push('그림 참조(href)가 없어 [그림]으로 표시했어');
      return '[그림]';
    }
    if (ctx.files['__bin__:' + href] === undefined) {
      ctx.warnings.push(`그림 파일이 패키지에 없어: ${href}`);
    }
    return `[그림: ${base}]`;
  },

  _hwpxNote(el, kind, ctx) {
    ctx.stats.footnotes++;
    const id = el.getAttribute('id') || '?';
    const lines = [];
    for (const p of Array.from(el.getElementsByTagNameNS('*', 'p'))) {
      const t = this._hwpxInlineText(p, ctx).replace(/\s+/g, ' ').trim();
      if (t) lines.push(t);
    }
    return { kind, id, text: lines.join(' ') };
  },

  // 표: 직계 행·셀만 따라가며 셀 문단·중첩 표를 재귀 처리
  _hwpxTableRows(el, ctx, depth) {
    if (depth > 3) {
      ctx.warnings.push('중첩 표가 너무 깊어(3단계 초과) 안쪽 내용을 생략했어');
      return [['[표(중첩 초과)]']];
    }
    const rows = [];
    for (const tr of Array.from(el.children)) {
      if (tr.localName !== 'tr') {
        this._hwpxNoteUnknown(tr, ctx);
        continue;
      }
      const row = [];
      for (const tc of Array.from(tr.children)) {
        if (tc.localName !== 'tc') {
          this._hwpxNoteUnknown(tc, ctx);
          continue;
        }
        const pieces = [];
        for (const ch of Array.from(tc.children)) {
          const ln = ch.localName;
          if (ln === 'p') {
            const para = this._hwpxParagraph(ch, ctx);
            for (const b of para.blocks) {
              pieces.push(b.type === 'table' ? this._renderHwpxTableInline(b.rows) : b.text);
            }
          } else if (ln === 'tbl') {
            ctx.stats.tables++;
            pieces.push(this._renderHwpxTableInline(this._hwpxTableRows(ch, ctx, depth + 1)));
          } else if (ln === 'pic') {
            pieces.push(this._hwpxImageLabel(ch, ctx));
          } else if (ln === 'secPr' || ln === 'ctrl') {
            continue;
          } else {
            this._hwpxNoteUnknown(ch, ctx);
            pieces.push(this._hwpxInlineText(ch, ctx));
          }
        }
        let cell = pieces.filter((p) => String(p).trim()).join(' / ').replace(/\s+/g, ' ').trim();
        const rs = Math.max(1, Number(tc.getAttribute('rowSpan')) || 1);
        const cs = Math.max(1, Number(tc.getAttribute('colSpan')) || 1);
        if (rs > 1 || cs > 1) cell += ` [병합 ${rs}x${cs}]`;
        row.push(cell);
      }
      if (row.length) rows.push(row);
    }
    return rows;
  },

  _renderHwpxBlocks(blocks) {
    const lines = [];
    for (const b of blocks) {
      if (b.type === 'table') {
        const t = this._renderHwpxTable(b.rows);
        if (t) lines.push(t);
      } else if (b.type === 'image') {
        lines.push(b.label);
      } else {
        const t = String(b.text || '');
        if (!t.trim()) continue;
        lines.push(b.outline > 0 ? '#'.repeat(b.outline) + ' ' + t : t);
      }
    }
    return lines.join('\n');
  },

  _renderHwpxTable(rows) {
    if (!rows || !rows.length) return '';
    const esc = (c) => String(c == null ? '' : c).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim() || ' ';
    const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
    if (!width) return '';
    const lines = [];
    lines.push('| ' + rows[0].map(esc).join(' | ') + ' |');
    lines.push('| ' + Array(width).fill('---').join(' | ') + ' |');
    for (const r of rows.slice(1)) {
      const cells = [];
      for (let i = 0; i < width; i++) cells.push(esc(r[i]));
      lines.push('| ' + cells.join(' | ') + ' |');
    }
    return lines.join('\n');
  },

  _renderHwpxTableInline(rows) {
    if (!rows || !rows.length) return '';
    return rows.map((r) => r.map((c) => String(c == null ? '' : c).replace(/\|/g, '\\|')).join(' | ')).join(' / ');
  },

  escapeXml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  _hwpxNs() {
    return 'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';
  },

  _hwpxSecPrInner() {
    return `<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0"><hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/><hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/><hp:pagePr landscape="WIDELY" width="59528" height="84188" gutterType="LEFT_ONLY"><hp:margin header="4252" footer="4252" gutter="0" left="8504" right="8504" top="5668" bottom="4252"/></hp:pagePr><hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr><hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr><hp:pageBorderFill type="BOTH" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill><hp:pageBorderFill type="EVEN" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill><hp:pageBorderFill type="ODD" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill></hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>`;
  },

  _hwpxParaXml(id, text) {
    const t = this.escapeXml(text == null || text === '' ? '\u00A0' : text);
    return '<hp:p id="' + id + '" paraPrIDRef="3" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">' +
      '<hp:run charPrIDRef="0"><hp:t>' + t + '</hp:t></hp:run></hp:p>';
  },

  async _loadHwpxTemplate(name) {
    const url = (typeof chrome !== 'undefined' && chrome.runtime?.getURL)
      ? chrome.runtime.getURL('hwpx-template/' + name)
      : ('hwpx-template/' + name);
    const res = await fetch(url);
    if (!res.ok) throw new Error('HWPX 템플릿을 불러오지 못했어: ' + name);
    return await res.text();
  },

  async buildHwpxBlob(title, body, meta = {}) {
    const safeTitle = title || '댕댕이 결과';
    const dateStr = new Date().toLocaleString('ko-KR');
    const mode = meta.mode || meta['검토 유형'] || '';
    const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
    if (!lines.length) lines.push('\u00A0');

    const [headerXml, versionXml, settingsXml, containerXml] = await Promise.all([
      this._loadHwpxTemplate('header.xml'),
      this._loadHwpxTemplate('version.xml'),
      this._loadHwpxTemplate('settings.xml'),
      this._loadHwpxTemplate('container.xml')
    ]);

    const ns = this._hwpxNs();
    const metaLine = (mode ? mode + '  ·  ' : '') + dateStr + '  ·  반려 AI 댕댕이';
    const parts = [];
    parts.push(this._hwpxParaXml(0, safeTitle));
    parts.push(this._hwpxParaXml(1, metaLine));
    lines.forEach((line, i) => {
      parts.push(this._hwpxParaXml(i + 2, line.length ? line : '\u00A0'));
    });

    // secPr/ctrl(colPr)는 사양상 hs:sec의 직계 자식 — 문단(run) 안에 넣지 않음
    const section = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hs:sec ' + ns + '>' + this._hwpxSecPrInner() + parts.join('') + '</hs:sec>';

    // spine에는 본문 구역(section0)만 — header는 참조 테이블이지 본문 순서가 아님
    const hpf = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><opf:package ' + ns + ' version="" unique-identifier="" id=""><opf:metadata><opf:title>' + this.escapeXml(safeTitle) + '</opf:title><opf:language>ko</opf:language><opf:meta name="creator" content="반려 AI 댕댕이"/><opf:meta name="CreatedDate" content="text">' + dateStr + '</opf:meta></opf:metadata><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/><opf:item id="settings" href="settings.xml" media-type="application/xml"/><opf:item id="PrvText" href="Preview/PrvText.txt" media-type="text/plain"/></opf:manifest><opf:spine><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>';

    const preview = safeTitle + '\n' + metaLine + '\n\n' + lines.slice(0, 20).join('\n');

    return await this.zipPackage([
      { name: 'mimetype', data: 'application/hwp+zip', store: true },
      { name: 'version.xml', data: versionXml, store: true },
      { name: 'Contents/header.xml', data: headerXml },
      { name: 'Contents/section0.xml', data: section },
      { name: 'Preview/PrvText.txt', data: preview },
      { name: 'settings.xml', data: settingsXml },
      { name: 'META-INF/container.xml', data: containerXml },
      { name: 'Contents/content.hpf', data: hpf }
    ]);
  },

  // ----------------------------------------------------------
  // PDF (텍스트 추출 / 단순 생성)
  // ----------------------------------------------------------

  /**
   * PDF 텍스트 추출 (P1-1 개선):
   * - trailer/Root/Pages/Kids로 페이지 순서를 결정해 페이지별 추출
   * - 컨텐츠 스트림을 operator 순서대로 한 번에 순회 (Tj/TJ 순서 오류 해결)
   * - 페이지별 추출 실패·빈 텍스트를 경고로 남기고, 스캔본은 OCR 필요로 표시
   * @returns {Promise<{text: string, warnings: string[], stats: {pages, pagesWithText}}>}
   */
  async parsePdf(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const head = this._latin1(bytes.subarray(0, 8));
    if (!head.startsWith('%PDF')) throw new Error('PDF 파일이 아니야');

    const latin = this._latin1(bytes);
    const warnings = [];
    const stats = { pages: 0, pagesWithText: 0 };

    // 페이지 순서 결정 (객체 그래프 순회). 실패 시 전체 스트림 스캔으로 대체.
    const pageRefs = this._pdfPageOrder(latin);
    const pageTexts = [];

    if (pageRefs.length) {
      for (let i = 0; i < pageRefs.length; i++) {
        const ref = pageRefs[i];
        const text = await this._pdfExtractPageText(latin, ref);
        pageTexts.push({ page: i + 1, text });
      }
      stats.pages = pageRefs.length;
    } else {
      // 객체 그래프 해석 실패: 기존 방식(전체 스트림 스캔)으로 대체
      warnings.push('페이지 구조를 해석하지 못해 스트림 순서로 추출했어 (페이지 순서가 어긋날 수 있음)');
      const text = await this._pdfExtractAllStreams(latin);
      pageTexts.push({ page: 1, text });
      stats.pages = 1;
    }

    const parts = [];
    for (const p of pageTexts) {
      const t = String(p.text || '').trim();
      if (t) {
        stats.pagesWithText++;
        parts.push(pageTexts.length > 1 ? `\n\n[${p.page} 페이지]\n\n${t}` : t);
      } else if (pageRefs.length) {
        warnings.push(`${p.page}페이지에서 텍스트를 추출하지 못했어 (스캔 이미지·표 전용 페이지일 수 있음)`);
      }
    }

    const text = parts.join('\n').trim();
    if (!text) {
      warnings.push('스캔본(이미지) PDF라 텍스트가 없어 — OCR이 필요해');
    }
    return { text, warnings, stats };
  },

  /**
   * trailer → Root → Pages → Kids 순회로 페이지 객체 참조 목록을 순서대로 얻는다.
   */
  _pdfPageOrder(latin) {
    try {
      const trailerIdx = latin.lastIndexOf('trailer');
      if (trailerIdx < 0) return [];
      const trailer = latin.slice(trailerIdx, trailerIdx + 4000);
      const rootM = trailer.match(/\/Root\s+(\d+)\s+(\d+)\s+R/);
      if (!rootM) return [];
      const root = this._pdfDeref(latin, Number(rootM[1]));
      if (!root) return [];
      const pagesM = root.text.match(/\/Pages\s+(\d+)\s+(\d+)\s+R/);
      if (!pagesM) return [];
      const pages = this._pdfDeref(latin, Number(pagesM[1]));
      if (!pages) return [];

      const out = [];
      const walk = (dict) => {
        const kidsM = dict.match(/\/Kids\s*\[([\s\S]*?)\]/);
        if (!kidsM) return;
        for (const rm of kidsM[1].matchAll(/(\d+)\s+(\d+)\s+R/g)) {
          const obj = this._pdfDeref(latin, Number(rm[1]));
          if (!obj) continue;
          if (/\/Type\s*\/Pages\b/.test(obj.text)) {
            walk(obj.text);
          } else if (/\/Type\s*\/Page\b/.test(obj.text)) {
            out.push(rm[1]);
          }
        }
      };
      walk(pages.text);
      return out;
    } catch (_) {
      return [];
    }
  },

  /**
   * 'n 0 obj' 객체 조회 — 본문 텍스트와 바이트 범위 반환 (간접 참조 해석).
   * latin1 문자열은 바이트와 1:1이므로 인덱스가 곧 바이트 오프셋이다.
   */
  _pdfDeref(latin, objNum) {
    if (!objNum || objNum < 1) return null;
    const re = new RegExp('(?:^|\\n)' + objNum + '\\s+0\\s+obj([\\s\\S]*?)endobj');
    const m = latin.match(re);
    if (!m) return null;
    return {
      text: m[1],
      start: m.index + m[0].length - m[1].length - 'endobj'.length,
      end: m.index + m[0].length
    };
  },

  /**
   * 페이지 객체의 /Contents (단일·배열) 스트림에서 텍스트 추출
   */
  async _pdfExtractPageText(latin, pageRef) {
    const pageObj = this._pdfDeref(latin, Number(pageRef));
    if (!pageObj) return '';
    const refs = [];
    const single = pageObj.text.match(/\/Contents\s+(\d+)\s+0\s+R/);
    if (single) {
      refs.push(single[1]);
    } else {
      const arr = pageObj.text.match(/\/Contents\s*\[([\s\S]*?)\]/);
      if (arr) {
        for (const m of arr[1].matchAll(/(\d+)\s+0\s+R/g)) refs.push(m[1]);
      }
    }
    const parts = [];
    for (const ref of refs) {
      const streamObj = this._pdfDeref(latin, Number(ref));
      if (!streamObj) continue;
      const t = await this._pdfStreamToText(latin, streamObj);
      if (t.trim()) parts.push(t);
    }
    return parts.join('\n');
  },

  /**
   * 스트림 객체: 바이트 오프셋으로 데이터 범위를 잘라 필터 처리 후
   * 컨텐츠를 operator 순서대로 텍스트화. (압축 바이트 안의 'endstream' 유사
   * 시퀀스에 정규식이 끊기지 않도록 바이트 기준으로 자른다)
   */
  async _pdfStreamToText(latin, streamObj) {
    const info = this._pdfStreamBytesAndDict(latin, streamObj);
    if (!info) return '';
    let data = info.data;
    if (/\/FlateDecode|\/Fl\b/.test(info.dict)) {
      try {
        data = await this._inflatePdf(data);
      } catch (_) {
        return '';
      }
    } else if (/\/Filter\b/.test(info.dict)) {
      return ''; // 지원하지 않는 필터 — 조용히 무시하지 않고 빈 결과(경고는 페이지 단위에서)
    }
    return this._pdfContentToTextOrdered(this._latin1(data));
  },

  _pdfStreamBytesAndDict(latin, streamObj) {
    const bytes = this._enc(latin);
    const m = streamObj.text.match(/\bstream\r?\n/);
    if (!m) return null;
    const dict = streamObj.text.slice(0, m.index);
    let dataStart = streamObj.start + m.index + m[0].length;
    const eIdx = streamObj.text.lastIndexOf('endstream');
    let dataEnd = streamObj.start + eIdx;
    if (dataEnd > dataStart && bytes[dataEnd - 1] === 0x0a) dataEnd--;
    if (dataEnd > dataStart && bytes[dataEnd - 1] === 0x0d) dataEnd--;
    if (dataEnd <= dataStart) return null;
    return { dict, data: bytes.subarray(dataStart, dataEnd) };
  },

  async _inflatePdf(data) {
    try {
      return await this._inflate(data, 'deflate');
    } catch {
      return await this._inflate(data, 'deflate-raw');
    }
  },

  /**
   * 대체 경로: 전체 스트림 스캔 (객체 그래프 해석 실패 시)
   */
  async _pdfExtractAllStreams(latin) {
    const bytes = this._enc(latin);
    const needle = this._enc('stream');
    const endNeedle = this._enc('endstream');
    const parts = [];
    let from = 0;
    while (from < bytes.length) {
      const s = this._indexOfBytes(bytes, needle, from);
      if (s < 0) break;
      const dictFrom = Math.max(0, s - 1800);
      const dictStr = latin.slice(dictFrom, s);
      let dataStart = s + 6;
      if (bytes[dataStart] === 0x0d) dataStart++;
      if (bytes[dataStart] === 0x0a) dataStart++;
      const e = this._indexOfBytes(bytes, endNeedle, dataStart);
      if (e < 0) { from = s + 6; continue; }
      let data = bytes.subarray(dataStart, e);
      if (/\/FlateDecode|\/Fl\b/.test(dictStr)) {
        try {
          data = await this._inflatePdf(data);
        } catch {
          from = e + 9;
          continue;
        }
      } else if (/\/Filter\b/.test(dictStr)) {
        from = e + 9;
        continue;
      }
      const extracted = this._pdfContentToTextOrdered(this._latin1(data));
      if (extracted.trim()) parts.push(extracted);
      from = e + 9;
    }
    return parts.join('\n');
  },

  /**
   * 컨텐츠 스트림을 operator 순서대로 한 번에 순회해 텍스트화 (P1-1).
   * (…)Tj / <hex>Tj / […]TJ / string ' / aw ac string " / T* / Td / TD 를 문서 순서대로 처리한다.
   * PDF 표준에서 ' 와 " 는 문자열 뒤에 오는 연산자다: (text) ' , 12 24 (text) "
   * 기존처럼 TJ 전부 → Tj 전부 두 번 순회하지 않아 순서가 뒤섞이지 않는다.
   */
  _pdfContentToTextOrdered(src) {
    const out = [];
    const push = (s) => { if (s) out.push(s); };
    const pushNewline = () => { if (out.length && !out[out.length - 1].endsWith('\n')) out.push('\n'); };

    const re = /\((?:\\.|[^\\)])*\)\s*Tj|<[0-9A-Fa-f \t\r\n]+>\s*Tj|\[[\s\S]*?\]\s*TJ|\((?:\\.|[^\\)])*\)\s*'|\((?:\\.|[^\\)])*\)\s*"|T\*|Td\b|TD\b/g;

    let m;
    while ((m = re.exec(src))) {
      const tok = m[0];
      if (tok.endsWith('Tj')) {
        if (tok.startsWith('(')) {
          push(this._unescapePdf(tok.slice(1, tok.lastIndexOf(')'))));
        } else if (tok.startsWith('<')) {
          const hex = tok.slice(1, tok.indexOf('>'));
          push(this._pdfHexToText(hex));
        }
      } else if (tok.endsWith('TJ')) {
        const inner = tok.slice(tok.indexOf('[') + 1, tok.lastIndexOf(']'));
        const token = /\((?:\\.|[^\\)])*\)|<([0-9A-Fa-f \t\r\n]+)>/g;
        let t;
        while ((t = token.exec(inner))) {
          if (t[1] != null) push(this._pdfHexToText(t[1]));
          else push(this._unescapePdf(t[0].slice(1, t[0].lastIndexOf(')'))));
        }
        pushNewline();
      } else if (tok === 'T*') {
        pushNewline();
      } else if (tok.endsWith("'") || tok.endsWith('"')) {
        // ' / " 연산자 (문자열 뒤): 다음 줄로 이동 후 문자열 출력
        pushNewline();
        push(this._unescapePdf(tok.slice(tok.indexOf('(') + 1, tok.lastIndexOf(')'))));
      } else if (tok === 'Td' || tok === 'TD') {
        // 위치 이동 연산자 — 줄 구분으로 근사
        pushNewline();
      }
    }
    return out.join('');
  },

  _pdfHexToText(hex) {
    const h = String(hex).replace(/\s+/g, '');
    if (h.length < 2) return '';
    const bytes = [];
    for (let i = 0; i < h.length; i += 2) bytes.push(parseInt(h.substr(i, 2), 16));
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
      let s = '';
      for (let i = 2; i + 1 < bytes.length; i += 2) {
        s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      }
      return s;
    }
    return String.fromCharCode(...bytes.filter((b) => b >= 32 || b === 10));
  },

  _unescapePdf(s) {
    return s
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\b/g, '')
      .replace(/\\f/g, '')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\')
      .replace(/\\(\d{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  },

  buildPdfBlob(title, body, meta = {}) {
    const layout = this._pdfLayout();
    const safeTitle = title || '댕댕이 결과';
    const mode = meta.mode || meta['검토 유형'] || '';
    const dateStr = new Date().toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
    const bodyLines = this._wrapLines(String(body || '').replace(/\r\n/g, '\n'), layout.bodyChars);
    const metaLine = (mode ? mode + '  ·  ' : '') + dateStr;
    const titleLines = this._wrapLines(safeTitle, layout.titleChars);
    const metaLines = this._wrapLines(metaLine, layout.bodyChars);
    const headerH = titleLines.length * 18 + metaLines.length * 14 + 4;
    const firstPageLines = Math.max(6, Math.floor((layout.bodyTop - layout.bodyBottom - headerH) / layout.lineH));
    const rest = bodyLines.slice();
    const pages = [{ header: true, lines: rest.splice(0, firstPageLines) }];
    while (rest.length) pages.push({ header: false, lines: rest.splice(0, layout.pageLines) });

    const objects = [];
    const add = (str) => { objects.push(str); return objects.length; };
    add('<< /Type /Catalog /Pages 2 0 R >>');
    add('<< /Type /Pages /Kids [] /Count 0 >>');
    const fontHelv = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const fontCjkDesc = add('<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYSMyeongJo-Medium /CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 1 >> /DW 1000 >>');
    const fontCjk = add('<< /Type /Font /Subtype /Type0 /BaseFont /HYSMyeongJo-Medium /Encoding /UniKS-UCS2-H /DescendantFonts [' + fontCjkDesc + ' 0 R] >>');

    const pageIds = [];
    pages.forEach((pg, pi) => {
      const stream = this._pdfPageStream(pg, pi, pages.length, safeTitle, metaLine);
      const contentId = add('<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream');
      pageIds.push(add(
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + layout.pageW + '\u00A0' + layout.pageH + '] /Contents ' + contentId +
        ' 0 R /Resources << /Font << /F1 ' + fontHelv + ' 0 R /F2 ' + fontCjk + ' 0 R >> >> >>'
      ));
    });
    objects[1] = '<< /Type /Pages /Kids [' + pageIds.map((id) => id + ' 0 R').join('\u00A0') + '] /Count ' + pageIds.length + ' >>';

    const enc = new TextEncoder();
    let acc = '%PDF-1.4\n%\x80\x80\x80\x80\n';
    const offs = [0];
    objects.forEach((bodyStr, i) => {
      offs.push(enc.encode(acc).length);
      acc += (i + 1) + ' 0 obj\n' + bodyStr + '\nendobj\n';
    });
    const xrefPos = enc.encode(acc).length;
    let xref = 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
    for (let i = 1; i <= objects.length; i++) {
      xref += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
    }
    acc += xref;
    acc += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF';
    return new Blob([acc], { type: 'application/pdf' });
  },

  _pdfLayout() {
    const pageW = 595;
    const pageH = 842;
    const marginL = 64;
    const marginR = 64;
    const contentW = pageW - marginL - marginR;
    const bodySize = 10;
    const lineH = 15;
    const footerY = 36;
    const headerRuleY = pageH - 22;
    const bodyTop = pageH - 58;
    const bodyBottom = 58;
    const bodyChars = Math.max(20, Math.floor(contentW / bodySize));
    const titleChars = Math.max(12, Math.floor(contentW / 14));
    const usableH = bodyTop - bodyBottom;
    return {
      pageW,
      pageH,
      marginL,
      marginR,
      contentW,
      bodySize,
      lineH,
      footerY,
      headerRuleY,
      bodyTop,
      bodyBottom,
      bodyChars,
      titleChars,
      firstPageLines: Math.max(8, Math.floor((usableH - 36) / lineH)),
      pageLines: Math.max(10, Math.floor(usableH / lineH))
    };
  },

  _pdfPageStream(pg, pi, total, title, metaLine) {
    const L = this._pdfLayout();
    const x0 = L.marginL;
    const x1 = L.pageW - L.marginR;
    const out = [];
    out.push('0.94 0.55 0.63 RG 1 w ' + x0 + '\u00A0' + L.headerRuleY + ' m ' + x1 + '\u00A0' + L.headerRuleY + ' l S');
    out.push('BT');
    const put = (r, g, b, font, size, x, y, text) => {
      out.push(r + '\u00A0' + g + '\u00A0' + b + ' rg');
      out.push('/' + font + '\u00A0' + size + ' Tf');
      out.push('1 0 0 1 ' + x + '\u00A0' + y + ' Tm');
      out.push(this._pdfTj(text || '\u00A0'));
    };
    const putRight = (r, g, b, font, size, y, text) => {
      const w = String(text || '').length * size;
      put(r, g, b, font, size, Math.max(x0, x1 - w), y, text);
    };
    put(0.55, 0.42, 0.39, 'F2', 8, x0, L.pageH - 36, '반려 AI 댕댕이');
    putRight(0.55, 0.42, 0.39, 'F2', 8, L.pageH - 36, (pi + 1) + ' / ' + total);
    let y = L.bodyTop;
    if (pg.header) {
      const titleLines = this._wrapLines(title, L.titleChars);
      titleLines.forEach((ln) => {
        put(0.76, 0.09, 0.36, 'F2', 14, x0, y, ln);
        y -= 18;
      });
      this._wrapLines(metaLine, L.bodyChars).forEach((ln) => {
        put(0.55, 0.42, 0.39, 'F2', 9, x0, y, ln);
        y -= 14;
      });
      y -= 4;
    }
    pg.lines.forEach((ln) => {
      put(0.24, 0.15, 0.14, 'F2', L.bodySize, x0, y, ln || '\u00A0');
      y -= L.lineH;
    });
    put(0.63, 0.53, 0.50, 'F2', 8, x0, L.footerY - 8, '반려 AI 댕댕이 보고서');
    out.push('ET');
    out.push('0.94 0.84 0.86 RG 0.6 w ' + x0 + '\u00A0' + L.footerY + ' m ' + x1 + '\u00A0' + L.footerY + ' l S');
    return out.join('\n');
  },

  _pdfTj(text) {
    const s = String(text == null ? '' : text);
    if (!s) return '() Tj';
    if (/^[\x20-\x7E]*$/.test(s)) {
      return '(' + s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') + ') Tj';
    }
    let hex = 'FEFF';
    for (let i = 0; i < s.length; i++) {
      hex += s.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
    }
    return '<' + hex + '> Tj';
  },

  _wrapLines(text, width) {
    const max = Math.max(8, Number(width) || 46);
    const out = [];
    for (const raw of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
      if (!raw) { out.push(''); continue; }
      const chars = [...raw];
      let line = '';
      for (const ch of chars) {
        if (line.length + 1 > max) {
          out.push(line);
          line = ch;
        } else {
          line += ch;
        }
      }
      if (line) out.push(line);
    }
    return out;
  },

  _enc(str) {
    const a = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) & 0xFF;
    return a;
  },

  _latin1(bytes) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return s;
  },

  _indexOfBytes(hay, needle, from) {
    outer: for (let i = from; i <= hay.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (hay[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  },

  // ----------------------------------------------------------
  // 내보내기
  // ----------------------------------------------------------

  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  async exportResult({ format, title, body, meta = {} }) {
    const dateStr = new Date().toISOString().slice(0, 10);
    const safe = String(title || '결과').replace(/[\\/:*?"<>|]/g, '_');
    const fmt = String(format || 'md').toLowerCase();
    const header = [
      title || '결과',
      meta.mode ? `검토 유형: ${meta.mode}` : '',
      `작성: ${dateStr}`,
      '생성: 반려 AI - 댕댕이',
      ''
    ].filter((l, i, arr) => l || i === arr.length - 1).join('\n');

    if (fmt === 'md') {
      const md = [`# ${title || '결과'}`, '', ...Object.entries(meta).map(([k, v]) => `- **${k}:** ${v}`), '', '---', '', body, ''].join('\n');
      this.downloadBlob(new Blob([md], { type: 'text/markdown;charset=utf-8' }), `댕댕이_${safe}_${dateStr}.md`);
      return `댕댕이_${safe}_${dateStr}.md`;
    }
    if (fmt === 'txt') {
      this.downloadBlob(new Blob([header + '\n' + body], { type: 'text/plain;charset=utf-8' }), `댕댕이_${safe}_${dateStr}.txt`);
      return `댕댕이_${safe}_${dateStr}.txt`;
    }
    if (fmt === 'json') {
      const json = JSON.stringify({
        title, ...meta, createdAt: new Date().toISOString(), generator: '반려 AI - 댕댕이', content: body
      }, null, 2);
      this.downloadBlob(new Blob([json], { type: 'application/json;charset=utf-8' }), `댕댕이_${safe}_${dateStr}.json`);
      return `댕댕이_${safe}_${dateStr}.json`;
    }
    if (fmt === 'pdf') {
      const blob = await this.buildPdfBlob(title, body, meta);
      this.downloadBlob(blob, `댕댕이_${safe}_${dateStr}.pdf`);
      return `댕댕이_${safe}_${dateStr}.pdf`;
    }
    if (fmt === 'hwpx') {
      const blob = await this.buildHwpxBlob(title, body, meta);
      this.downloadBlob(blob, `댕댕이_${safe}_${dateStr}.hwpx`);
      return `댕댕이_${safe}_${dateStr}.hwpx`;
    }
    throw new Error('알 수 없는 내보내기 형식이야');
  }
};
