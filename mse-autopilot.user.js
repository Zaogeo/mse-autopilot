// ==UserScript==
// @name         MSE Autopilot S3（整单元自动连跑）
// @namespace    mse-autopilot
// @version      0.7.9
// @description  S3：Tree 建队列 → 逐节取题/AI 作答/交卷/回读 → 自动跳下一节 → 汇总报告。
// @match        https://microlesson.rcgtjy.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      api.deepseek.com
// @run-at       document-idle
// ==/UserScript==

/*
 * S2 与 S1 的差别：
 *   + 接 DeepSeek（真答案，不再用占位值）
 *   + 结构校验（条数 / 单选字母 / 填空词库原文 / 写作非空）
 *   + 直接交卷：SubmitAll 用 status=Examed（你已确认）
 *   - 仍然单节手动点按钮；队列、重试、起点定位留给 S4
 *
 * 交卷不可逆：该节若不允许重答，错分就定住了。建议先在一节"允许重答/无所谓"的节上跑。
 */

(function () {
  'use strict';

  const CFG = {
    apiBase: '/Adm',
    aiBase: 'https://api.deepseek.com/v1',
    aiModel: 'deepseek-chat',
    aiTimeout: 60000,
    actionDelay: [300, 600],
    logMax: 40,
    statusFinal: 'Examed',
  };

  const TYPES = {
    single: '单选', singleFeel: '单选(情感)', multi: '多选', multiFeel: '多选(情感)',
    fill: '填空', fillObj: '填空(题组选项)', shortAnswer: '简答/写作', aiWrite: 'AI 写作', aiTrans: 'AI 翻译',
  };

  let running = false;
  let stopped = false;
  let ctx = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = ([a, b]) => Math.floor(Math.random() * (b - a + 1)) + a;
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  function htmlToText(s) {
    const d = document.createElement('div');
    d.innerHTML = String(s || '');
    return norm(d.textContent);
  }

  function parseJsonArray(v) {
    if (Array.isArray(v)) return v;
    if (typeof v !== 'string' || !v.trim()) return [];
    try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }

  function splitBank(v) {
    if (!v || typeof v !== 'string') return [];
    return v.split(';').map((x) => htmlToText(x)).filter(Boolean);
  }

  async function waitStop(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (stopped) throw new Error('已停止');
      await sleep(Math.min(100, end - Date.now()));
    }
  }

  // ───────────────── 面板 ─────────────────
  const host = document.createElement('div');
  host.id = 'mse-ap-host';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap { position: fixed; top: 12px; right: 12px; width: 400px; z-index: 999999;
        font: 12px/1.5 "Microsoft YaHei", Arial, sans-serif; color: #e8eaed;
        background: #1f2430; border: 1px solid #3a4255; border-radius: 8px;
        box-shadow: 0 8px 24px rgba(0,0,0,.45); overflow: hidden; }
      .bar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; background: #262c3a; cursor: move; }
      .title { flex: 1; font-weight: 600; font-size: 13px; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #6b7280; }
      .dot.on { background: #22c55e; }
      .body { padding: 8px 10px; }
      .row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
      button { flex: 1 1 auto; min-width: 88px; padding: 6px 8px; cursor: pointer;
        color: #e8eaed; background: #323a4d; border: 1px solid #46516a; border-radius: 6px; font: inherit; }
      button:hover { background: #3b465e; }
      button:disabled { opacity: .45; cursor: not-allowed; }
      button.primary { background: #2563eb; border-color: #2563eb; }
      button.danger { background: #7f1d1d; border-color: #991b1b; }
      input, select { flex: 1 1 120px; min-width: 0; padding: 5px 7px; border-radius: 6px;
        border: 1px solid #46516a; background: #12161f; color: #e8eaed; font: inherit; }
      .chk { display: flex; align-items: center; gap: 4px; color: #9ca3af; cursor: pointer; white-space: nowrap; }
      .chk input { flex: 0 0 auto; width: 14px; height: 14px; padding: 0; margin: 0; }
      .stat { color: #9ca3af; margin-bottom: 6px; word-break: break-all; }
      .log { height: 220px; overflow: auto; background: #12161f; border: 1px solid #2b3344;
        border-radius: 6px; padding: 6px; font-family: Consolas, monospace; font-size: 11px;
        white-space: pre-wrap; word-break: break-all; }
      .ok { color: #22c55e; } .warn { color: #f59e0b; } .err { color: #ef4444; } .dim { color: #6b7280; }
    </style>
    <div class="wrap">
      <div class="bar"><span class="dot"></span><span class="title">MSE Autopilot S2</span><span id="mini" class="dim">—</span></div>
      <div class="body">
        <div class="stat" id="stat">等待操作</div>
        <div class="row" id="setRow">
          <input id="key" type="password" placeholder="DeepSeek API Key（存本机）" />
          <button data-act="savekey" style="max-width:70px">保存</button>
        </div>
        <div class="row">
          <select id="mode">
            <option value="ai">AI 作答（智能）</option>
            <option value="fixed">固定答案（测试用）</option>
          </select>
          <label class="chk"><input type="checkbox" id="force" checked />已交卷的节：</label>
          <select id="retryScope" style="max-width:150px">
            <option value="wrong_subj">重做错题+主观题</option>
            <option value="wrong">仅重做错题</option>
            <option value="subj">仅重做主观题</option>
          </select>
          <span class="chk">≥</span>
          <input id="retakeAt" type="number" min="0" max="30" step="1" value="2" style="max-width:52px" />
          <span class="chk">条时重做</span>
        </div>
        <div class="row">
          <span class="chk">节间间隔</span>
          <input id="gap" type="number" min="0" max="60" step="0.1" value="0" style="max-width:80px" />
          <span class="chk">秒（0 = 不等，填多少就等多少）</span>
        </div>
        <div class="row">
          <button class="primary" data-act="run">运行单节（交卷）</button>
          <button data-act="next">去下一节</button>
        </div>
        <div class="row">
          <button class="primary" data-act="startunit">开始整单元</button>
          <button class="danger" data-act="stopall">停止队列</button>
        </div>
        <div class="row">
          <button data-act="recon">侦察（只读）</button>
          <button data-act="preview">只求答案（不交卷）</button>
          <button class="danger" data-act="stop">停止</button>
        </div>
        <div class="log" id="log"></div>
      </div>
    </div>
  `;

  const $log = shadow.getElementById('log');
  const $stat = shadow.getElementById('stat');
  const $dot = shadow.querySelector('.dot');
  const $mini = shadow.getElementById('mini');
  const $key = shadow.getElementById('key');
  const $mode = shadow.getElementById('mode');
  const $force = shadow.getElementById('force');
  const $retryScope = shadow.getElementById('retryScope');
  const $retakeAt = shadow.getElementById('retakeAt');
  const $gap = shadow.getElementById('gap');

  function log(msg, cls) {
    const t = new Date().toTimeString().slice(0, 8);
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.textContent = `[${t}] ${msg}`;
    $log.appendChild(d);
    while ($log.childElementCount > CFG.logMax) $log.removeChild($log.firstChild);
    $log.scrollTop = $log.scrollHeight;
    console.log('[MSE-S2]', msg);
  }
  const setStat = (s) => { $stat.textContent = s; };
  function setBusy(on) {
    running = on;
    $dot.classList.toggle('on', on);
    $mini.textContent = on ? '运行中' : '就绪';
    shadow.querySelectorAll('button').forEach((b) => { if (b.dataset.act !== 'stop') b.disabled = on; });
  }

  // 面板拖动
  (function drag() {
    const bar = shadow.querySelector('.bar');
    const wrap = shadow.querySelector('.wrap');
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    bar.addEventListener('mousedown', (e) => {
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = wrap.getBoundingClientRect();
      ox = r.left; oy = r.top;
      wrap.style.right = 'auto'; wrap.style.left = ox + 'px'; wrap.style.top = oy + 'px';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      wrap.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
      wrap.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  })();

  // ───────────────── 配置 ─────────────────
  function getKey() { return norm(GM_getValue('mse_ap_key', '')); }
  function saveKey() {
    const v = norm($key.value);
    if (!v) return log('Key 为空，未保存', 'warn');
    GM_setValue('mse_ap_key', v);
    $key.value = '';
    log('Key 已保存到本机（不写日志、不上传）', 'ok');
  }

  // ───────────────── 取 id / 接口 ─────────────────
  function readField(n) {
    const el = document.querySelector(`input[name="${n}"], #${n}`);
    return el && el.value ? String(el.value).trim() : '';
  }
  function getIds() {
    const q = new URL(location.href).searchParams;
    return {
      courseStructId: q.get('courseStructId') || readField('courseStructId'),
      classId: q.get('classId') || readField('classId'),
      menuGroup: q.get('menuGroup') || 'CourseStudy',
      mseShell: q.get('mseShell') || '1',
      mseSection: q.get('mseSection') || 'course',
    };
  }

  async function callApi(path, params) {
    const url = `${CFG.apiBase}${path}?${new URLSearchParams(params)}`;
    const res = await fetch(url, {
      method: 'POST', credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
    try { return JSON.parse(text); } catch (e) {
      throw new Error(`${path} 返回非 JSON（可能跳到登录页）：${text.slice(0, 100)}`);
    }
  }
  async function postForm(path, params) {
    const res = await fetch(`${CFG.apiBase}${path}`, {
      method: 'POST', credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: params.toString(),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
    try { return JSON.parse(text); } catch (e) {
      throw new Error(`${path} 返回非 JSON：${text.slice(0, 100)}`);
    }
  }

  async function deleteHand(handId) {
    const body = new URLSearchParams();
    body.append('ids[]', String(handId));
    return postForm('/CourseStructHand/Delete', body);
  }

  const fetchDetail = (ids) => callApi('/CourseStruct/StudentDetail', { courseStructId: ids.courseStructId, classId: ids.classId });
  const fetchReply = (ids) => callApi('/CourseStruct/SubjectReply', { courseStructId: ids.courseStructId, classId: ids.classId, previewAnswerReview: 'false' });

  // ───────────────── 摊平题目 ─────────────────
  function flatten(reply) {
    const structs = (reply && reply.subjectPager && reply.subjectPager.SubjectStructs) || [];
    const items = [];
    structs.forEach((st) => {
      (st.Subjects || []).forEach((s) => {
        const bank = splitBank(s.Options);
        const qs = s.Questions && s.Questions.length ? s.Questions : [null];
        qs.forEach((q) => {
          items.push({
            no: items.length + 1,
            subjectId: (q && q.SubjectId) || s.Id,
            questionId: q ? q.Id : s.Id,
            type: String((q && q.Type) || s.Type || '').trim(),
            numText: htmlToText((q && q.NumText) || s.SubjectStructNunber || ''),
            stemHtml: s.Name || '',
            stem: htmlToText(s.Name || ''),
            options: parseJsonArray(q && q.Options),
            bank,
          });
        });
      });
    });
    return items;
  }

  const typeLabel = (t) => TYPES[t] || (t || '未知题型');
  // 主观题：服务端不自动判分（IsRight 常为空），无法验证对错
  const isSubjective = (it) => /shortAnswer|aiWrite|aiTrans|aiSpeech|voiceFollow|roleFollow|mindMap/i.test(String(it.type || ''));

  /**
   * 固定答案模式：只为"把流程走完"，不追求正确率。
   * 规则与契约 §7 对齐（单选大写字母、填空取词库原文、写作给一段固定文本）。
   */
  function fixedValue(it) {
    const t = it.type;
    if (t.indexOf('single') === 0) return 'A';
    if (t.indexOf('multi') === 0) return 'A';
    if (t === 'fill' || t === 'fillObj') return it.bank[0] || 'A';
    if (t === 'shortAnswer' || t === 'aiWrite' || t === 'aiTrans') {
      return 'This is a fixed placeholder answer used only for workflow testing.';
    }
    return 'A';
  }

  function fixedValues(items) {
    const v = {};
    items.forEach((it) => { v[it.no] = fixedValue(it); });
    return v;
  }

  // ───────────────── prompt ─────────────────
  /**
   * 组 prompt。
   * passage：阅读理解依赖原文，必须随题一起送（否则模型只能瞎猜）。
   * 没有原文的题型（填空已经在题干里、写作是开放题）不必送，省 token。
   */
  function buildPrompt(items, passage) {
    const payload = [];
    const fillGroups = {};

    items.forEach((it) => {
      const isFill = it.type === 'fill' || it.type === 'fillObj';
      if (isFill) {
        let g = fillGroups[it.subjectId];
        if (!g) {
          const marked = blankMarked(it.stemHtml);
          g = fillGroups[it.subjectId] = {
            task: 'fill-group',
            questions: [],
            passage_with_blanks: marked.text,
            marks: marked.count,
          };
          if (it.bank.length) g.word_bank = it.bank;
          payload.push(g);
        }
        g.questions.push(it.no);
        return;
      }
      const o = { no: it.no, type: it.type, question: it.stem.slice(0, 2000) };
      if (it.options.length) o.options = it.options.map((x, i) => `${String.fromCharCode(65 + i)}. ${htmlToText(x)}`);
      payload.push(o);
    });
    const sys = 'You are an exam solver for a Chinese university ENGLISH course. ' +
      'Return ONLY JSON: {"answers":[{"no":<int>,"value":"<string>"}]} with one entry for EVERY question number. ' +
      'LANGUAGE RULES (very important): ' +
      '(a) Writing / essay / composition -> answer in ENGLISH. ' +
      '(b) Translation: if the source text is English, translate INTO CHINESE (simplified); ' +
      'if the source text is Chinese, translate INTO ENGLISH. Never copy the source language. ' +
      '(c) Fill-in-the-blank and single choice -> answer tokens stay in English. ' +
      'OTHER RULES: ' +
      '(1) single choice -> ONE capital letter (A/B/C/D...) that exists in the given options. ' +
      '(2) fill-in-the-blank -> copy EXACTLY one item from word_bank, character for character, no case change, no punctuation. ' +
      'An entry with task="fill-group" is ONE passage with several blanks marked [__1__], [__2__] ... ; ' +
      'its "questions" array lists the question numbers in the SAME order, so marker [__i__] corresponds to questions[i-1]. ' +
      'Read the whole passage first, then assign one word_bank item to each marker and return one answer per question number. ' +
      '(3) short answer -> plain text, satisfy the word count stated in the question. ' +
      '(4) Reading comprehension MUST be grounded in the provided "passage": first locate the sentence that supports the answer, then choose. ' +
      'If the passage does not contain the needed information, say so is NOT allowed; make the best inference from the passage. ' +
      'Do not add explanations.';
    const userObj = { questions: payload };
    if (passage) userObj.passage = passage;
    return [
      { role: 'system', content: sys },
      { role: 'user', content: JSON.stringify(userObj) },
    ];
  }

  /**
   * 把 HTML 里的每个填空控件换成 [__1__] [__2__] … 标记。
   * 为什么必须这么做：填空题的 10 个空共用同一段文章，若只把 HTML 压成纯文本，
   * 空格在转换时会消失，模型看到的 10 条题面一模一样，只能乱猜第几空填哪个词。
   */
  function blankMarked(html) {
    const d = document.createElement('div');
    d.innerHTML = String(html || '');
    let n = 0;
    d.querySelectorAll('input, select, textarea, [class*="subject-input"], [class*="blank"], [class*="Blank"]').forEach((el) => {
      const isRadio = el.tagName === 'INPUT' && /^radio|checkbox$/i.test(el.type || '');
      if (isRadio) return;
      n += 1;
      el.replaceWith(document.createTextNode(` [__${n}__] `));
    });
    return { text: n ? norm(d.textContent) : htmlToText(html), count: n };
  }

  /** 从 StudentDetail 里取出阅读原文（纯文本，最多 5000 字） */
  function passageOf(detail) {
    const c = detail && detail.courseContent;
    if (!c) return '';
    if (c.ContentType && String(c.ContentType).toLowerCase() !== 'text') return '';
    return htmlToText(c.Text || '').slice(0, 5000);
  }

  function parseAiJson(text) {
    let t = String(text || '').trim();
    t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const s = t.indexOf('{'), e = t.lastIndexOf('}');
    if (s >= 0 && e > s) t = t.slice(s, e + 1);
    return JSON.parse(t);
  }

  function askAI(messages, maxTokens) {
    const key = getKey();
    if (!key) throw new Error('还没填 API Key：请在上方面板输入框粘贴后点「保存」');

    const body = JSON.stringify({
      model: CFG.aiModel,
      messages,
      temperature: 0.2,
      max_tokens: maxTokens || 1200,
      response_format: { type: 'json_object' },
    });

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${CFG.aiBase}/chat/completions`,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        data: body,
        timeout: CFG.aiTimeout,
        onload: (r) => {
          if (r.status < 200 || r.status >= 300) {
            const hint = r.status === 401 ? '（Key 无效或没填对）'
              : r.status === 402 ? '（余额不足）'
              : r.status === 429 ? '（请求过频/限流）' : '';
            reject(new Error(`AI HTTP ${r.status}${hint}: ${String(r.responseText || '').slice(0, 160)}`));
            return;
          }
          try {
            const j = JSON.parse(r.responseText);
            const ch = j.choices && j.choices[0];
            if (!ch) { reject(new Error('AI 响应里没有 choices：' + String(r.responseText).slice(0, 120))); return; }
            resolve({
              text: (ch.message && ch.message.content) || '',
              finish: ch.finish_reason || '',
              usage: j.usage || null,
              model: j.model || '',
            });
          } catch (e) { reject(new Error('AI 响应不是 JSON：' + String(r.responseText).slice(0, 120))); }
        },
        onerror: () => reject(new Error('AI 网络错误：跨域被拒或断网（检查 @connect 是否放行）')),
        ontimeout: () => reject(new Error('AI 超时 60s')),
      });
    });
  }

  // ───────────────── 校验 ─────────────────
  function requiredWords(stem) {
    const m = String(stem).match(/(\d{2,3})\s*[-–~—to]+\s*(\d{2,3})\s*(words?|词|单词)/i);
    if (m) return [Number(m[1]), Number(m[2])];
    const m2 = String(stem).match(/(?:at\s+least|不少于|至少)\s*(\d{2,3})\s*(words?|词|单词)/i);
    if (m2) return [Number(m2[1]), 9999];
    return null;
  }

  function validate(items, answers) {
    const errs = [];
    const byNo = {};
    (answers || []).forEach((a) => { byNo[String(a.no)] = String(a.value == null ? '' : a.value); });

    if (!answers || answers.length !== items.length) {
      errs.push(`答案条数 ${answers ? answers.length : 0} 与题目条数 ${items.length} 不等`);
    }

    items.forEach((it) => {
      const v = norm(byNo[String(it.no)]);
      if (!v) { errs.push(`#${it.no} 没有答案`); return; }

      if (it.type.indexOf('single') === 0) {
        if (!/^[A-Z]+$/.test(v)) errs.push(`#${it.no} 单选应为大写字母，收到「${v.slice(0, 20)}」`);
        else if (it.options.length && v.charCodeAt(0) - 65 >= it.options.length) {
          errs.push(`#${it.no} 字母 ${v} 超出 ${it.options.length} 个选项`);
        }
      } else if (it.type === 'fill' || it.type === 'fillObj') {
        if (it.bank.length && !it.bank.includes(v)) {
          errs.push(`#${it.no} 填空值「${v}」不在词库（须逐字相同）`);
        }
      } else if (it.type === 'shortAnswer' || it.type === 'aiWrite' || it.type === 'aiTrans') {
        const w = requiredWords(it.stem);
        if (w) {
          const n = v.split(/\s+/).filter(Boolean).length;
          if (n < w[0] || n > w[1]) log(`#${it.no} 字数 ${n}，题面要求 ${w[0]}–${w[1]}（仅告警，仍交卷）`, 'warn');
        }
      }
    });
    return errs;
  }

  function buildPayload(items, values, ids, handId) {
    const p = new URLSearchParams();
    items.forEach((it, i) => {
      p.append(`models[${i}][SubjectId]`, it.subjectId);
      p.append(`models[${i}][QuestionId]`, it.questionId);
      p.append(`models[${i}][Value]`, values[it.no]);
    });
    p.append('courseStructHandId', handId || '');
    p.append('courseStructId', ids.courseStructId);
    p.append('classId', ids.classId);
    p.append('status', CFG.statusFinal);
    return p;
  }

  // ───────────────── 流程 ─────────────────
  async function stepRecon() {
    const ids = getIds();
    if (!ids.courseStructId) throw new Error('URL 里没有 courseStructId，确认你在某一节课程页');
    log(`ids: courseStructId=${ids.courseStructId}, classId=${ids.classId}`, 'dim');

    const [detail, reply] = await Promise.all([fetchDetail(ids), fetchReply(ids)]);
    const items = flatten(reply);
    const name = (detail.courseStruct && detail.courseStruct.Name) || reply.courseStructShowName || '(未命名)';
    setStat(`${name} · ${items.length} 题`);

    const counts = {};
    items.forEach((it) => { counts[it.type] = (counts[it.type] || 0) + 1; });
    log(`本节：${name}`, 'ok');
    log(`题目 ${items.length} 道（${Object.keys(counts).map((k) => `${typeLabel(k)}×${counts[k]}`).join('，') || '无'}）`);
    log(`controls ${items.length}/${items.length}`, 'dim');

    const hand = reply.courseStructHand;
    if (hand) log(`已有记录：handId=${hand.Id}，ShowStatus=${hand.ShowStatus}，${(hand.CourseStructReplys || []).length} 条`, 'warn');
    else log('未提交过', 'dim');

    ctx = { ids, detail, reply, items, next: detail.nextCourseStruct || null, handId: hand ? hand.Id : '' };
    return ctx;
  }

  async function solve(items, detail) {
    setStat('求答案（DeepSeek）…');
    const passage = passageOf(detail);
    if (passage) log(`附带阅读原文 ${passage.length} 字`, 'dim');

    // token 预算：基础 + 每道小题 + 每道写作（写作最费 token）
    const writing = items.filter((it) => /shortAnswer|aiWrite|aiTrans/.test(it.type)).length;
    const maxTokens = Math.min(300 + items.length * 25 + writing * 600, 3000);

    let messages = buildPrompt(items, passage);
    log(`提示词：正文 ${messages[1].content.length} 字（原文 ${passage.length} 字 / 共 ${items.length} 题）`, 'dim');
    items.filter((it) => it.type.indexOf('single') === 0 && it.options.length).slice(0, 3).forEach((it) => {
      log(`  #${it.no} 选项顺序 ${it.options.map((x, i) => `${String.fromCharCode(65 + i)}.${htmlToText(x)}`).join(' | ').slice(0, 180)}`, 'dim');
    });
    const fillItems = items.filter((it) => it.type === 'fill' || it.type === 'fillObj');
    if (fillItems.length) {
      const m = blankMarked(fillItems[0].stemHtml);
      log(`填空组：${fillItems.length} 个空，题面里识别到 ${m.count} 个空格标记`, m.count === fillItems.length ? 'dim' : 'warn');
      if (m.count === 0) log('没识别到任何空格控件 —— 模型只能按顺序猜，这是填空题错得多的主因', 'warn');
    }
    let parsed = null;
    let errs = [];

    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await askAI(messages, maxTokens);
      if (stopped) throw new Error('已停止');
      log(`AI 第 ${attempt} 次：finish=${res.finish}，tokens=${res.usage ? res.usage.total_tokens : '?'}`, 'dim');

      if (res.finish === 'length') {
        throw new Error('AI 输出被 max_tokens 截断（题量或写作太长），请重试；仍有问题我调大上限');
      }

      try {
        parsed = parseAiJson(res.text);
      } catch (e) {
        parsed = null;
        errs = ['输出不是合法 JSON：' + e.message];
      }
      if (parsed) errs = validate(items, parsed.answers);

      if (!errs.length) { log('答案结构校验通过', 'ok'); break; }

      log(`校验不通过 ${errs.length} 条：${errs.slice(0, 3).join('；')}`, 'warn');
      if (attempt === 2) throw new Error('答案仍不合法：' + errs.slice(0, 3).join('；'));

      setStat('回修答案（第 2 次）…');
      messages = messages.concat([
        { role: 'assistant', content: parsed ? JSON.stringify(parsed) : String(res.text).slice(0, 1500) },
        {
          role: 'user',
          content: 'Your previous output is invalid:\n- ' + errs.join('\n- ') +
            '\nFix it and return the FULL JSON again, one entry for every question no.',
        },
      ]);
    }

    const values = {};
    items.forEach((it) => {
      const a = (parsed.answers || []).find((x) => String(x.no) === String(it.no));
      values[it.no] = a ? norm(a.value) : '';
    });
    return values;
  }

  async function runOnce() {
    stopped = false;
    setBusy(true);
    try {
      await stepRecon();
      const { items, ids, reply } = ctx;
      const name = (ctx.detail.courseStruct && ctx.detail.courseStruct.Name) || reply.courseStructShowName || '本节';
      const mode = $mode.value;
      const force = $force.checked;
      const hand = reply.courseStructHand;

      const retakeAt = Math.max(0, Number($retakeAt.value) || 0);
      const scope = $retryScope.value;
      const reuse = {};
      if (hand && hand.ShowStatus === '已提交') {
        if (!force) {
          log('本节已交卷，跳过（要重做请勾选「已交卷的节…」）', 'warn');
          setStat('已交卷，跳过');
          return { status: 'skipped', name };
        }
        const byQ = {};
        (hand.CourseStructReplys || []).forEach((x) => { byQ[String(x.QuestionId)] = x; });
        const needRedo = items.filter((it) => {
          const old = byQ[String(it.questionId)];
          const st = old ? String(old.IsRight) : '';
          const subj = isSubjective(it);
          if (scope === 'wrong') return st === '0';
          if (scope === 'subj') return subj && st !== '1';
          return st === '0' || st === '' || st === 'null' || (subj && st !== '1');
        });
        const nWrong = needRedo.filter((it) => {
          const old = byQ[String(it.questionId)];
          return old && String(old.IsRight) === '0';
        }).length;
        const nSubj = needRedo.length - nWrong;
        if (needRedo.length < retakeAt) {
          log(`本节已交卷，待重做 ${needRedo.length} 条（错 ${nWrong} / 主观 ${nSubj}，阈值 ${retakeAt}），保留原成绩`, 'warn');
          setStat(`已交卷，待重做 ${needRedo.length} 条，保留`);
          return { status: 'kept', name };
        }
        // 判为"对"的客观题直接沿用旧答案，不再让模型重算，避免越改越差
        items.forEach((it) => {
          const old = byQ[String(it.questionId)];
          if (old && String(old.IsRight) === '1' && String(old.Value == null ? '' : old.Value) !== '') {
            reuse[it.no] = String(old.Value);
          }
        });
        log(`本节已交卷 → 重做 ${needRedo.length} 条（错 ${nWrong} / 主观 ${nSubj}），沿用旧答案 ${Object.keys(reuse).length} 条`, 'warn');
        setStat('删除旧作答记录…');
        const del = await deleteHand(hand.Id || ctx.handId);
        if (del.Type !== 'Success') throw new Error('删除旧作答记录失败：' + htmlToText(del.Content || '').slice(0, 80));
        log('旧记录已删除（服务端返回：操作成功），旧成绩一并作废', 'warn');
        ctx.handId = '';
        await waitStop(rand(CFG.actionDelay));
      }
      if (!items.length) {
        log('本节没有题目（纯阅读页），无需作答', 'warn');
        return { status: 'empty', name };
      }

      let values;
      if (mode === 'fixed') {
        log('模式：固定答案（测试用），跳过 AI、跳过校验', 'warn');
        setStat('固定答案模式…');
        values = fixedValues(items);
      } else {
        if (!getKey()) throw new Error('AI 模式需要 Key：请在上方输入框粘贴后点「保存」');
        values = await solve(items, ctx.detail);
      }
      items.forEach((it) => {
        if (mode !== 'fixed' && reuse[it.no] !== undefined) {
          values[it.no] = reuse[it.no];
          log(`  #${it.no} ${typeLabel(it.type)} → ${String(values[it.no]).slice(0, 40)}（沿用旧答案）`, 'dim');
        } else {
          log(`  #${it.no} ${typeLabel(it.type)} → ${String(values[it.no]).slice(0, 40)}`, 'dim');
        }
      });

      await waitStop(rand(CFG.actionDelay));
      setStat('交卷中…');
      const payload = buildPayload(items, values, ids, ctx.handId);
      log(`提交体 ${payload.toString().length} 字节，status=${CFG.statusFinal}`, 'dim');
      const r = await postForm('/CourseStructReply/SubmitAll', payload);
      if (r.Type !== 'Success') {
        const msg = htmlToText(r.Content).slice(0, 100);
        if (msg.indexOf('已完成') >= 0) {
          log('服务端拒绝重交：' + msg + '（已交卷的节无法通过接口覆盖）', 'warn');
          setStat('已被服务端拒绝');
          return { status: 'rejected', name };
        }
        throw new Error(`交卷失败：Type=${r.Type}，${msg}`);
      }
      log(`交卷 OK：handId=${r.OtherInfo ? r.OtherInfo.CourseStructHandId : '?'}，Status=${r.OtherInfo ? r.OtherInfo.Status : '?'}`, 'ok');

      await waitStop(rand(CFG.actionDelay));
      setStat('回读判分…');
      const back = await fetchReply(ids);
      const handAfter = back.courseStructHand || {};
      const rs = handAfter.CourseStructReplys || [];
      const right = rs.filter((x) => String(x.IsRight) === '1').length;
      const wrong = rs.filter((x) => String(x.IsRight) === '0').length;
      log(`回读：ShowStatus=${handAfter.ShowStatus}，${rs.length}/${items.length} 条，对 ${right} / 错 ${wrong}`, right + wrong ? 'ok' : 'warn');
      rs.forEach((x) => log(`  Q=${x.QuestionId} IsRight=${x.IsRight} Value=${String(x.Value).slice(0, 30)}`, 'dim'));
      setStat(`完成：对 ${right} / 错 ${wrong} / 共 ${items.length}`);
      return { status: 'done', name, right, wrong, total: items.length };
    } catch (e) {
      log('失败：' + (e && e.message ? e.message : e), 'err');
      setStat('失败：' + (e && e.message ? e.message : e));
      return { status: 'failed', name: (ctx && ctx.detail && ctx.detail.courseStruct && ctx.detail.courseStruct.Name) || '本节', error: String(e && e.message ? e.message : e) };
    } finally {
      setBusy(false);
    }
  }

  async function reconOnly() {
    stopped = false;
    setBusy(true);
    try {
      await stepRecon();
      ctx.items.forEach((it) => log(`  #${it.no} ${typeLabel(it.type)} Q=${it.questionId}`, 'dim'));
      setStat('侦察完成（未发写请求）');
    } catch (e) {
      log('侦察失败：' + (e && e.message ? e.message : e), 'err');
    } finally {
      setBusy(false);
    }
  }

  /** 只求答案，不提交：用来验证 Key / 网络 / 提示词 / 答案质量 */
  async function previewOnly() {
    stopped = false;
    setBusy(true);
    try {
      await stepRecon();
      if (!ctx.items.length) { log('本节没有题目', 'warn'); return; }
      if ($mode.value === 'fixed') log('当前是固定答案模式，预览值即固定值', 'warn');
      const out = ctx.items.map((it) => ({ it, v: '' }));
      if ($mode.value === 'ai') {
        const vs = await solve(ctx.items, ctx.detail);
        out.forEach((o) => { o.v = vs[o.it.no]; });
      } else {
        const vs = fixedValues(ctx.items);
        out.forEach((o) => { o.v = vs[o.it.no]; });
      }
      out.forEach((o) => log(`  #${o.it.no} ${typeLabel(o.it.type)} → ${String(o.v).slice(0, 80)}`));
      setStat('预览完成（未提交）');
      log('以上是模型答案，本次没有发送任何写请求', 'ok');
    } catch (e) {
      log('预览失败：' + (e && e.message ? e.message : e), 'err');
      setStat('预览失败：' + (e && e.message ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  async function gotoNext() {
    if (!ctx || !ctx.next) return log('先点「侦察（只读）」拿到下一节', 'warn');
    const n = ctx.next;
    if (n.IsBeforeOpenStartDate) return log(`下一节「${n.Name}」未开放，停止`, 'warn');
    const { ids } = ctx;
    const qs = new URLSearchParams({
      courseStructId: n.Id, classId: ids.classId,
      menuGroup: ids.menuGroup, mseShell: ids.mseShell, mseSection: ids.mseSection,
    });
    setBusy(true);
    const raw = parseFloat($gap.value);
    const wait = Number.isFinite(raw) ? Math.min(60, Math.max(0, raw)) : 2;
    log(wait > 0 ? `下一节「${n.Name}」，等待 ${wait} 秒后跳转` : `下一节「${n.Name}」，不等待直接跳转`, 'dim');
    try {
      if (wait > 0) await waitStop([wait * 1000, wait * 1000]);
      location.href = `/Adm/CourseStruct/StudentDetail?${qs}`;
    } catch (e) {
      setBusy(false);
      log(e.message === '已停止' ? '已取消跳转' : '跳转失败：' + e.message, 'warn');
    }
  }

  // ───────────────── S3：整单元队列 ─────────────────
  const RUN_KEY = 'mse_s3_run';

  function loadRun() {
    try {
      const s = GM_getValue(RUN_KEY, '');
      return s ? JSON.parse(s) : null;
    } catch (e) { return null; }
  }
  function saveRun(s) { GM_setValue(RUN_KEY, JSON.stringify(s)); }

  function flattenTree(list, out) {
    out = out || [];
    (Array.isArray(list) ? list : []).forEach((n) => {
      out.push(n);
      flattenTree(n.Children || n.children || n.SubNodes || n.Items, out);
    });
    return out;
  }

  function treeRootList(raw) {
    if (Array.isArray(raw)) return raw;
    return (raw && (raw.Children || raw.children || raw.Data || raw.data)) || [];
  }

  /** 用 ParentId 从整棵树里捞出某个节点下的所有后代；嵌套结构则直接展开 Children */
  function subtreeOf(nodes, root) {
    const direct = root && (root.Children || root.children || root.SubNodes || root.Items);
    if (Array.isArray(direct) && direct.length) return flattenTree(direct);
    const keep = {};
    keep[String(root.Id)] = true;
    let changed = true;
    while (changed) {
      changed = false;
      nodes.forEach((n) => {
        const pid = String(n.ParentId);
        if (keep[pid] && !keep[String(n.Id)]) { keep[String(n.Id)] = true; changed = true; }
      });
    }
    return nodes.filter((n) => keep[String(n.Id)] && String(n.Id) !== String(root.Id));
  }

  function isOpenNow(n) {
    try {
      const r = typeof n.Remark === 'string' ? JSON.parse(n.Remark) : (n.Remark || {});
      if (!r.OpenStartDate) return true;
      const t = new Date(String(r.OpenStartDate).replace(/-/g, '/').replace('T', ' '));
      return isNaN(t.getTime()) ? true : t <= new Date();
    } catch (e) { return true; }
  }

  function jumpTo(id) {
    const ids = getIds();
    const qs = new URLSearchParams({
      courseStructId: id, classId: ids.classId,
      menuGroup: ids.menuGroup, mseShell: ids.mseShell, mseSection: ids.mseSection,
    });
    location.href = `/Adm/CourseStruct/StudentDetail?${qs}`;
  }

  function gapMs() {
    const raw = parseFloat($gap.value);
    const wait = Number.isFinite(raw) ? Math.min(60, Math.max(0, raw)) : 2;
    return { sec: wait, ms: wait * 1000 };
  }

  async function startUnit() {
    stopped = false;
    setBusy(true);
    try {
      if ($mode.value === 'ai' && !getKey()) throw new Error('AI 模式需要 Key：请先粘贴并点「保存」');
      const ids = getIds();
      if (!ids.courseStructId) throw new Error('URL 里没有 courseStructId，确认你在某一节课程页');

      setStat('拉取本节信息…');
      const detail = await fetchDetail(ids);
      const parents = detail.parents || [];
      const courseId = (parents[0] && parents[0].CourseId)
        || (detail.courseStruct && detail.courseStruct.CourseId)
        || readField('courseId');
      if (!courseId) throw new Error('取不到 courseId（目录树接口必需）');
      const tree = await postForm('/CourseStruct/Tree', new URLSearchParams({ courseId: String(courseId), classId: String(ids.classId) }));
      const nodes = flattenTree(treeRootList(tree));
      log(`目录树：${nodes.length} 个节点（courseId=${courseId}）`, 'dim');

      // 用目录树自己往上走：节点 → ParentId → … 直到顶层，顶层就是「单元」
      const byId = {};
      nodes.forEach((n) => { byId[String(n.Id || n.id)] = n; });
      const walkUp = (node) => {
        const seen = {};
        let top = null;
        let p = node;
        while (p && !seen[String(p.Id || p.id)]) {
          seen[String(p.Id || p.id)] = true;
          top = p;
          const pid = String(p.ParentId === undefined ? p.parentId : p.ParentId);
          p = pid && pid !== '0' && pid !== 'null' && pid !== '' ? byId[pid] : null;
        }
        return top;
      };
      const cs = detail.courseStruct || {};
      const startNode = byId[String(ids.courseStructId)]
        || (cs.ParentId ? byId[String(cs.ParentId)] : null)
        || (cs.Id ? byId[String(cs.Id)] : null);
      let unit = startNode ? walkUp(startNode) : null;
      log(`当前节 ${ids.courseStructId} 在目录树中：${byId[String(ids.courseStructId)] ? '是' : '否'}`, 'dim');
      if (!unit) {
        unit = parents.find((x) => /unit/i.test(String(x.Name || '')) && /[0-9一二三四五六七八九十]/.test(String(x.Name || ''))
          || /unit/i.test(String(x.Name || ''))) || parents[parents.length - 1] || null;
      }
      if (!unit) throw new Error(`找不到所属单元节点（当前节 ${ids.courseStructId} 不在目录树里，父链也为空）`);
      const unitName = unit.Name || unit.text || '（未命名单元）';

      const subs = subtreeOf(nodes, unit);
      const targets = subs.filter((n) => String(n.IsMustAnswerSubject) === '1' && Number(n.SubjectCount) > 0 && isOpenNow(n));
      if (!targets.length) throw new Error(`单元「${unitName}」下没有可做的必做练习`);

      const queue = targets.map((n) => ({ id: String(n.Id || n.id), name: n.Name || n.text || '（未命名）' }));
      let start = queue.findIndex((q) => q.id === String(ids.courseStructId));
      if (start < 0) start = 0;

      saveRun({ active: true, queue: queue, cursor: start, results: [], startedAt: Date.now() });
      log(`单元「${unitName}」：队列 ${queue.length} 节，从第 ${start + 1} 节开始`, 'ok');
      queue.forEach((q, i) => log(`  ${i + 1}. ${q.name}${i === start ? '  ← 当前' : ''}`, 'dim'));

      if (queue[start].id !== String(ids.courseStructId)) {
        jumpTo(queue[start].id);
        return;
      }
      await queueStep();
    } catch (e) {
      log('队列启动失败：' + String(e && e.message ? e.message : e), 'err');
      setStat('队列启动失败');
    } finally {
      setBusy(false);
    }
  }

  /** 跑当前节，然后推进游标并跳下一节 */
  async function queueStep() {
    const st = loadRun();
    if (!st || !st.active) { log('没有进行中的队列', 'warn'); return; }
    const cur = st.queue[st.cursor];
    if (!cur) { finishQueue(st); return; }

    log(`▶ 队列 ${st.cursor + 1}/${st.queue.length}：${cur.name}`, 'ok');
    const res = await runOnce();

    st.results = st.results || [];
    st.results.push({ name: cur.name, status: res.status, right: res.right, wrong: res.wrong, total: res.total, error: res.error });
    st.cursor += 1;
    saveRun(st);

    if (stopped) { st.active = false; saveRun(st); log('队列已停止，进度已保存', 'warn'); return; }
    if (st.cursor >= st.queue.length) { finishQueue(st); return; }

    const g = gapMs();
    if (g.ms > 0) {
      log(`等待 ${g.sec} 秒后进入「${st.queue[st.cursor].name}」`, 'dim');
      await new Promise((r) => setTimeout(r, g.ms));
    }
    jumpTo(st.queue[st.cursor].id);
  }

  function finishQueue(st) {
    st.active = false;
    saveRun(st);
    log('════ 单元汇总 ════', 'ok');
    let rSum = 0; let wSum = 0; let okCount = 0;
    (st.results || []).forEach((r) => {
      if (r.status === 'done') {
        okCount += 1; rSum += r.right || 0; wSum += r.wrong || 0;
        log(`  ✅ ${r.name}：对 ${r.right} / 错 ${r.wrong} / 共 ${r.total}`, 'ok');
      } else if (r.status === 'skipped') {
        log(`  ⏭ ${r.name}：已交卷，跳过`, 'warn');
      } else if (r.status === 'kept') {
        log(`  ⏭ ${r.name}：已交卷，错题未过阈值，保留`, 'warn');
      } else if (r.status === 'empty') {
        log(`  ⏭ ${r.name}：无题目`, 'warn');
      } else {
        log(`  ❌ ${r.name}：${r.status}${r.error ? '（' + r.error + '）' : ''}`, 'err');
      }
    });
    log(`合计：完成 ${okCount} 节，对 ${rSum} / 错 ${wSum}`, 'ok');
    setStat(`队列结束：完成 ${okCount} 节`);
  }

  function stopQueue() {
    stopped = true;
    const st = loadRun();
    if (st) { st.active = false; saveRun(st); }
    log('已请求停止：当前请求结束后不再进入下一节', 'warn');
  }

  // ───────────────── 绑定 ─────────────────
  shadow.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'run') runOnce();
    else if (act === 'recon') reconOnly();
    else if (act === 'preview') previewOnly();
    else if (act === 'next') gotoNext();
    else if (act === 'savekey') saveKey();
    else if (act === 'startunit') startUnit();
    else if (act === 'stopall') stopQueue();
    else if (act === 'stop') { stopped = true; log('已请求停止', 'warn'); }
  });

  const hasKey = !!getKey();
  if (!hasKey) log('首次使用：先粘贴 DeepSeek API Key 并点「保存」', 'warn');
  if (!/\/Adm\/CourseStruct\/StudentDetail/i.test(location.pathname)) {
    log('当前不是课程详情页，请打开某一节课程页', 'warn');
  } else {
    log(hasKey ? '就绪。AI 模式需 Key；固定答案模式不需要 Key。' : '就绪。固定答案模式不需要 Key；AI 模式请先填 Key。');
  }

  // 断点续跑：如果队列在跑、且当前页正好是游标指向的节，自动继续
  (function autoResume() {
    const st = loadRun();
    if (!st || !st.active) return;
    const cur = st.queue[st.cursor];
    if (!cur) return;
    const ids = getIds();
    if (String(ids.courseStructId) !== cur.id) {
      log(`队列进行中：第 ${st.cursor + 1}/${st.queue.length} 节「${cur.name}」，当前页不是这一节，未自动运行`, 'warn');
      return;
    }
    log(`续跑：${st.cursor + 1}/${st.queue.length}「${cur.name}」`, 'ok');
    setTimeout(() => { queueStep(); }, 1000);
  })();

  window.__mseap = { getIds, fetchDetail, fetchReply, flatten, validate, buildPayload, ctx: () => ctx, loadRun, startUnit };
})();
