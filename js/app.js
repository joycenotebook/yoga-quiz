/* =========================================================================
 *  app.js —— 页面逻辑
 *
 *  流程：开场 → 答题 → 结果 → 生成分享图
 *  刷新后恢复本机进度；题库换版本时自动作废旧答案。
 * ========================================================================= */

(function () {
  'use strict';

  const cfg = window.QUIZ_CONFIG ||
              (typeof QUIZ_CONFIG !== 'undefined' ? QUIZ_CONFIG : null);
  if (!cfg) { console.error('找不到 js/config.js 里的 QUIZ_CONFIG'); return; }

  const STORE_KEY = 'quiz_state';
  const QUESTIONS = cfg.questions || [];
  const TOTAL = QUESTIONS.length;
  const RESULTS = cfg.results || [];

  /* ------------------------------------------------------------------
   * 本地存取
   * ---------------------------------------------------------------- */
  const store = {
    read() {
      try {
        const raw = localStorage.getItem(STORE_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        // 版本不一致 → 视为无效，避免旧答案套新题库
        if (!data || data.version !== cfg.version) return null;
        return data;
      } catch (e) { return null; }
    },
    write(data) {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(Object.assign({ version: cfg.version }, data)));
      } catch (e) { /* 无痕模式等场景忽略 */ }
    },
    clear() {
      try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    }
  };

  /* ------------------------------------------------------------------
   * 状态
   * ---------------------------------------------------------------- */
  const state = {
    answers: {},      // { 题id: 选项id }
    order: {},        // { 题id: [选项id...] } 打乱后的展示顺序
    index: 0,
    resultId: null,
    shadowId: null,
    finished: false
  };

  /* ------------------------------------------------------------------
   * DOM
   * ---------------------------------------------------------------- */
  const $ = function (id) { return document.getElementById(id); };

  const el = {
    screens: { intro: $('screenIntro'), quiz: $('screenQuiz'), calc: $('screenCalc'), result: $('screenResult') },
    headerBrand: $('headerBrand'),
    footerText: $('footerText'),
    sampleBanner: $('sampleBanner'),

    introTitle: $('introTitle'), introSubtitle: $('introSubtitle'), introText: $('introText'),
    metaDuration: $('metaDuration'), metaCount: $('metaCount'),
    audienceBox: $('audienceBox'), audienceText: $('audienceText'),
    btnStart: $('btnStart'), btnResume: $('btnResume'),

    progressLabel: $('progressLabel'), progressFill: $('progressFill'),
    qTitle: $('qTitle'), options: $('options'),
    btnPrev: $('btnPrev'), btnNext: $('btnNext'), nextHint: $('nextHint'),
    btnRestartInline: $('btnRestartInline'),

    resultName: $('resultName'), resultTagline: $('resultTagline'), resultBadge: $('resultBadge'),
    scoreStrip: $('scoreStrip'),
    calcText: $('calcText'),
    pipe: $('pipe'), pipeNote: $('pipeNote'),
    stuckLabel: $('stuckLabel'), stuckDesc: $('stuckDesc'),
    resultSummary: $('resultSummary'),
    takeawayBox: $('takeawayBox'), takeawayText: $('takeawayText'),
    shadowBox: $('shadowBox'), shadowText: $('shadowText'),
    btnPoster: $('btnPoster'), btnRetest: $('btnRetest'), reviewHint: $('reviewHint'),
    followUp: $('followUp'), fuTitle: $('fuTitle'), fuDesc: $('fuDesc'), fuBody: $('fuBody'),

    posterModal: $('posterModal'), posterMask: $('posterMask'), posterClose: $('posterClose'),
    posterLoading: $('posterLoading'), posterError: $('posterError'), posterDone: $('posterDone'),
    loadingText: $('loadingText'), errText: $('errText'), btnRetry: $('btnRetry'),
    posterImg: $('posterImg'), btnDownload: $('btnDownload'), btnShare: $('btnShare'),
    copyBox: $('copyBox'), btnCopy: $('btnCopy'), copyTip: $('copyTip'),

    toast: $('toast')
  };

  /* ------------------------------------------------------------------
   * 小工具
   * ---------------------------------------------------------------- */
  let toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.add('hidden'); }, 2800);
  }

  function showScreen(name) {
    Object.keys(el.screens).forEach(function (k) {
      el.screens[k].classList.toggle('hidden', k !== name);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showIntro() {
    el.screens.intro.classList.remove('hidden');
    el.screens.quiz.classList.add('hidden');
    el.screens.result.classList.add('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ------------------------------------------------------------------
   * 轻埋点：window.dataLayer + localStorage（quiz_events，最多留 200 条）
   * ---------------------------------------------------------------- */
  function track(event, props) {
    try {
      const payload = Object.assign({ event: event, ts: Date.now() }, props || {});
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push(payload);
      const list = JSON.parse(localStorage.getItem('quiz_events') || '[]');
      list.push(payload);
      localStorage.setItem('quiz_events', JSON.stringify(list.slice(-200)));
    } catch (e) { /* 统计失败不影响答题 */ }
  }

  function findResult(id) {
    return RESULTS.find(function (r) { return r.id === id; }) || null;
  }

  // 二维码 / 文案里用的地址。
  // 优先用 config 里填的 meta.shareUrl；
  // 没填时自动推导「干净的规范网址」——去掉 ?r=xxx 之类的参数和 #片段，
  // 保证无论部署到哪个域名、用哪种路径打开，二维码都指向测试首页。
  function getShareUrl() {
    if (cfg.meta && cfg.meta.shareUrl) return cfg.meta.shareUrl;
    try {
      let p = location.pathname.replace(/index\.html$/i, '');
      if (!p) p = '/';
      return location.protocol + '//' + location.host + p;
    } catch (e) {
      return location.href.split('#')[0].split('?')[0];
    }
  }

  function isLocalPreview() {
    const h = location.hostname;
    return !h || h === 'localhost' || h === '127.0.0.1' || location.protocol === 'file:';
  }

  /* ------------------------------------------------------------------
   * 选项打乱：展示顺序随机，但计分永远按 option 上标注的类型
   * ---------------------------------------------------------------- */
  function buildOrder() {
    const order = {};
    QUESTIONS.forEach(function (q) {
      const ids = q.options.map(function (o) { return o.id; });
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = ids[i]; ids[i] = ids[j]; ids[j] = t;
      }
      order[q.id] = ids;
    });
    return order;
  }

  function orderedOptions(q) {
    const opts = q.options.slice();
    const ids = (state.order && state.order[q.id]) || null;
    if (!ids || !ids.length) return opts;
    const list = ids.map(function (id) {
      return opts.find(function (o) { return o.id === id; });
    }).filter(Boolean);
    return list.length === opts.length ? list : opts;
  }

  /* ------------------------------------------------------------------
   * 判定规则
   *   type = "types"     ：各类型计数，取最高；并列按 tieBreak 取更靠后的
   *   type = "sum"       ：累加分值，按区间取结果
   *   type = "dimension" ：按 dims 累加，取最高的维度
   * ---------------------------------------------------------------- */
  function computeScoreSet() {
    const rule = cfg.scoring || { type: 'types' };
    const out = { dims: {}, ranking: [], resultId: null, shadowId: null, total: 0, min: 0, max: 0 };

    /* ---- 类型计数（本项目使用） ---- */
    if (rule.type === 'types') {
      const counts = {};
      RESULTS.forEach(function (r) { counts[r.id] = 0; });

      QUESTIONS.forEach(function (q) {
        const picked = q.options.find(function (o) { return o.id === state.answers[q.id]; });
        if (!picked) return;
        if (picked.type) counts[picked.type] = (counts[picked.type] || 0) + 1;
        Object.keys(picked.dims || {}).forEach(function (k) {
          counts[k] = (counts[k] || 0) + (picked.dims[k] || 0);
        });
      });

      out.dims = counts;

      // 先按 tieBreak 排好，再用「稳定排序」降序 —— 同分自然取 tieBreak 中更靠前的
      const order = (rule.tieBreak && rule.tieBreak.length)
        ? rule.tieBreak : Object.keys(counts);
      const list = order.filter(function (k) { return k in counts; });
      list.sort(function (a, b) { return counts[b] - counts[a]; });

      out.ranking = list;
      out.resultId = list[0] || null;
      out.total = counts[out.resultId] || 0;
      out.shadowId = (rule.shadowEnabled !== false && list.length > 1 && counts[list[1]] > 0)
        ? list[1] : null;
      out.max = TOTAL;
      return out;
    }

    /* ---- 分值累加 ---- */
    let minSum = 0, maxSum = 0;
    QUESTIONS.forEach(function (q) {
      let lo = Infinity, hi = -Infinity;
      q.options.forEach(function (o) {
        const v = rule.type === 'dimension' ? 0 : (o.point || 0);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      });
      minSum += isFinite(lo) ? lo : 0;
      maxSum += isFinite(hi) ? hi : 0;
    });
    out.min = minSum;
    out.max = maxSum;

    if (rule.type === 'dimension') {
      const dims = {};
      (rule.dimensions || []).forEach(function (k) { dims[k] = 0; });
      QUESTIONS.forEach(function (q) {
        const picked = q.options.find(function (o) { return o.id === state.answers[q.id]; });
        if (!picked) return;
        Object.keys(picked.dims || {}).forEach(function (k) {
          dims[k] = (dims[k] || 0) + (picked.dims[k] || 0);
        });
      });
      out.dims = dims;
      const rank = Object.keys(dims);
      rank.sort(function (a, b) { return dims[b] - dims[a]; });
      out.ranking = rank;
      out.resultId = rank[0] || null;
      out.shadowId = (rule.shadowEnabled !== false && rank.length > 1 && dims[rank[1]] > 0)
        ? rank[1] : null;
      out.total = dims[out.resultId] || 0;
      return out;
    }

    // sum
    let total = 0;
    QUESTIONS.forEach(function (q) {
      const picked = q.options.find(function (o) { return o.id === state.answers[q.id]; });
      if (picked) total += (picked.point || 0);
    });
    out.total = total;

    const ranges = rule.ranges || [];
    const hit = ranges.find(function (r) { return total >= r.min && total <= r.max; });
    out.resultId = hit ? hit.resultId : (ranges.length ? ranges[ranges.length - 1].resultId : null);
    out.ranking = [];
    return out;
  }

  /* ------------------------------------------------------------------
   * 渲染
   * ---------------------------------------------------------------- */
  function renderStatic() {
    const m = cfg.meta || {};
    document.title = m.title || '测评';
    el.headerBrand.textContent = m.brandName || '';
    el.footerText.textContent = m.signature || m.brandName || '';
    el.introTitle.textContent = m.title || '';
    el.introSubtitle.textContent = m.subtitle || '';
    el.introText.textContent = m.intro || '';
    el.metaDuration.textContent = m.durationText || '';
    el.metaCount.textContent = m.questionCountText || (TOTAL + ' 道题目');

    if (m.audience) {
      el.audienceText.textContent = m.audience;
      el.audienceBox.classList.remove('hidden');
    } else {
      el.audienceBox.classList.add('hidden');
    }

    // version 里含 sample 时显示示例横幅，正式版自动隐藏
    const isSample = String(cfg.version || '').toLowerCase().indexOf('sample') >= 0;
    el.sampleBanner.classList.toggle('hidden', !isSample);
  }

  function renderQuestion() {
    clearAuto();
    const q = QUESTIONS[state.index];
    if (!q) return;

    el.progressLabel.textContent = '第 ' + (state.index + 1) + ' / ' + TOTAL + ' 题';
    el.progressFill.style.width = Math.round(((state.index + 1) / TOTAL) * 100) + '%';
    el.qTitle.textContent = q.title || '';

    el.options.innerHTML = '';
    orderedOptions(q).forEach(function (opt) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'opt';
      btn.setAttribute('role', 'radio');
      const checked = state.answers[q.id] === opt.id;
      btn.setAttribute('aria-checked', checked ? 'true' : 'false');
      btn.dataset.optId = opt.id;

      const mark = document.createElement('span');
      mark.className = 'opt-mark';
      const body = document.createElement('span');
      body.className = 'opt-body';
      body.appendChild(document.createTextNode(opt.label || ''));
      if (opt.desc) {
        const d = document.createElement('span');
        d.className = 'opt-desc';
        d.textContent = opt.desc;
        body.appendChild(d);
      }
      btn.appendChild(mark);
      btn.appendChild(body);

      btn.addEventListener('click', function () { pick(q.id, opt.id); });
      el.options.appendChild(btn);
    });

    el.btnPrev.disabled = state.index === 0;
    const picked = !!state.answers[q.id];
    setNextEnabled(picked);
    el.nextHint.textContent = picked
      ? ''
      : (state.index === TOTAL - 1 ? '选择一个选项后查看结果' : '选择一个选项后继续');
  }

  function setNextEnabled(on) {
    el.btnNext.disabled = !on;
    el.btnNext.setAttribute('aria-disabled', on ? 'false' : 'true');
    el.btnNext.textContent = (state.index === TOTAL - 1) ? '查看结果' : '下一题';
  }

  /* ---- 选中后自动进入下一题（约 300ms，让选中态被看见） ---- */
  let autoTimer = null;
  function clearAuto() {
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
  }

  function pick(qid, optId) {
    state.answers[qid] = optId;
    Array.prototype.forEach.call(el.options.children, function (btn) {
      btn.setAttribute('aria-checked', btn.dataset.optId === optId ? 'true' : 'false');
    });
    setNextEnabled(true);
    el.nextHint.textContent = '';
    save();

    const q = QUESTIONS[state.index];
    const opt = q ? q.options.find(function (o) { return o.id === optId; }) : null;
    track('question_answer', { question: state.index + 1, questionId: qid, type: opt ? (opt.type || '') : '' });

    // 自动跳下一题；最后一题自动出结果
    clearAuto();
    autoTimer = setTimeout(function () { autoTimer = null; next(); },
      state.index === TOTAL - 1 ? 480 : 320);
  }

  /* ---- 消化管道图 ---- */
  function renderPipe(result) {
    const segs = (cfg.pipeline && cfg.pipeline.segments) || [];
    el.pipe.innerHTML = '';
    if (!segs.length) { el.pipe.parentNode.classList.add('hidden'); return; }
    el.pipe.parentNode.classList.remove('hidden');

    segs.forEach(function (name, i) {
      if (i > 0) {
        const gap = document.createElement('span');
        gap.className = 'pipe-gap';
        gap.dataset.gap = String(i - 1);
        gap.textContent = '→';
        el.pipe.appendChild(gap);
      }
      const seg = document.createElement('span');
      seg.className = 'pipe-seg';
      seg.dataset.seg = String(i);
      seg.textContent = name;
      el.pipe.appendChild(seg);
    });

    const kind = result.stuckKind || 'gap';
    const idx = Number(result.stuckIndex) || 0;

    // 已通过 / 未到达的分段状态
    Array.prototype.forEach.call(el.pipe.querySelectorAll('.pipe-seg'), function (node) {
      const i = Number(node.dataset.seg);
      if (kind === 'node') {
        node.classList.add(i < idx ? 'pipe-done' : (i === idx ? 'pipe-stuck' : 'pipe-todo'));
      } else {
        node.classList.add(i <= idx ? 'pipe-done' : 'pipe-todo');
      }
    });

    const target = (kind === 'node')
      ? el.pipe.querySelector('.pipe-seg[data-seg="' + idx + '"]')
      : el.pipe.querySelector('.pipe-gap[data-gap="' + idx + '"]');
    if (target) target.classList.add('pipe-stuck');

    el.pipeNote.textContent = '你卡在这里';
  }

  function renderResult(result) {
    el.resultBadge.textContent = '你的类型';
    el.resultName.textContent = result.name || '';
    el.resultName.style.color = result.color || 'var(--ink)';
    el.resultTagline.textContent = result.tagline || '';

    renderPipe(result);

    el.stuckLabel.textContent = result.stuckLabel || '';
    el.stuckDesc.textContent = result.stuckDesc || '';

    el.resultSummary.innerHTML = '';
    (result.summary || []).forEach(function (p) {
      const node = document.createElement('p');
      node.textContent = p;
      el.resultSummary.appendChild(node);
    });

    if (result.takeaway) {
      el.takeawayText.textContent = result.takeaway;
      el.takeawayBox.classList.remove('hidden');
    } else {
      el.takeawayBox.classList.add('hidden');
    }

    // 影子类型
    const s = computeScoreSet();
    el.scoreStrip.classList.add('hidden');

    if (state.shadowId) {
      const shadow = findResult(state.shadowId);
      if (shadow && shadow.id !== result.id) {
        el.shadowText.textContent =
          '你的影子类型是「' + shadow.name + '」——除了「' + (result.stuckShort || '眼下的卡点') +
          '」，你还留着一点「' + (shadow.stuckShort || shadow.name) + '」的习惯。';
        el.shadowBox.classList.remove('hidden');
      } else {
        el.shadowBox.classList.add('hidden');
      }
    } else {
      el.shadowBox.classList.add('hidden');
    }

    el.reviewHint.textContent = '答案可以随时回去修改，结果会跟着重新计算';
    renderFollowUp();
  }

  function renderFollowUp() {
    const fu = cfg.followUp || {};
    if (!fu.enabled) { el.followUp.classList.add('hidden'); return; }
    el.followUp.classList.remove('hidden');

    el.fuTitle.textContent = fu.title || '下一步';
    el.fuDesc.textContent = fu.desc || '';
    el.fuBody.innerHTML = '';

    if (fu.qrcodeImage) {
      const img = document.createElement('img');
      img.className = 'fu-qr';
      img.src = fu.qrcodeImage;
      img.alt = '联系方式二维码';
      el.fuBody.appendChild(img);
      if (fu.qrcodeCaption) {
        const cap = document.createElement('p');
        cap.className = 'fu-qr-cap';
        cap.textContent = fu.qrcodeCaption;
        el.fuBody.appendChild(cap);
      }
    }

    if (fu.buttonUrl && fu.buttonText) {
      const a = document.createElement('a');
      a.className = 'btn btn-primary btn-block';
      a.href = fu.buttonUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = fu.buttonText;
      a.dataset.track = 'wechat_click';
      el.fuBody.appendChild(a);
    }

    // 微信号文字（点一下就复制，省得手动记）
    if (fu.wechatId) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'fu-wechat fu-wechat-btn';
      row.setAttribute('aria-label', '复制微信号 ' + fu.wechatId);
      row.innerHTML = '微信号 <b>' + escapeHtml(fu.wechatId) + '</b>' +
        (fu.wechatNote ? '<span class="fu-wechat-note">' + escapeHtml(fu.wechatNote) + '</span>' : '') +
        '<span class="fu-copy-tip">点一下复制</span>';
      row.dataset.track = 'wechat_click';
      row.addEventListener('click', async function () {
        track('wechat_click', { source: 'result_followup' });
        const ok = await copyToClipboard(fu.wechatId);
        if (ok) toast('微信号 ' + fu.wechatId + ' 已复制');
        else toast('复制失败，请长按上面的微信号手动复制');
      });
      el.fuBody.appendChild(row);
    }

    if (fu.secondary && fu.secondary.length) {
      const box = document.createElement('div');
      box.className = 'fu-secondary';
      const t = document.createElement('div');
      t.className = 'fu-sec-title';
      t.textContent = fu.secondaryTitle || '还可以';
      box.appendChild(t);

      fu.secondary.forEach(function (item) {
        const row = document.createElement('div');
        row.className = 'fu-sec-item';
        const label = document.createElement('p');
        label.className = 'fu-sec-label';
        label.textContent = item.label || '';
        row.appendChild(label);

        // 补充说明（比如「微信号 xxx，备注 yyy」）
        if (item.note) {
          const n = document.createElement('p');
          n.className = 'fu-sec-note';
          n.textContent = item.note;
          row.appendChild(n);
        }

        if (item.url && item.btnText) {
          const a = document.createElement('a');
          a.className = 'btn btn-secondary btn-sm';
          a.href = item.url;
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = item.btnText;
          a.dataset.track = item.track || 'external_click';
          row.appendChild(a);
        } else if (item.copy && item.btnText) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'btn btn-secondary btn-sm';
          b.textContent = item.btnText;
          b.dataset.track = item.track || 'external_click';
          b.addEventListener('click', async function () {
            track(b.dataset.track, { source: 'result_secondary' });
            const ok = await copyToClipboard(item.copy);
            if (ok) {
              toast(item.copyToast || '已复制');
              const old = b.textContent;
              b.textContent = '已复制 ✓';
              setTimeout(function () { b.textContent = old; }, 2200);
            } else {
              toast('复制失败，请长按上面的文字手动复制');
            }
          });
          row.appendChild(b);
        }
        box.appendChild(row);
      });
      el.fuBody.appendChild(box);
    }
  }

  /* ------------------------------------------------------------------
   * 存档
   * ---------------------------------------------------------------- */
  function save() {
    store.write({
      answers: state.answers,
      order: state.order,
      index: state.index,
      resultId: state.resultId,
      shadowId: state.shadowId,
      finished: state.finished
    });
  }

  function restoreIfAny() {
    const saved = store.read();
    if (saved && saved.finished && saved.resultId && findResult(saved.resultId)) {
      state.answers = saved.answers || {};
      state.order = saved.order && Object.keys(saved.order).length ? saved.order : buildOrder();
      state.index = saved.index || 0;
      state.resultId = saved.resultId;
      state.shadowId = saved.shadowId || null;
      state.finished = true;
      showResult();
      return true;
    }
    if (saved && Object.keys(saved.answers || {}).length) {
      el.btnResume.classList.remove('hidden');
    }
    return false;
  }

  function resumeSaved() {
    const saved = store.read();
    if (!saved) return;
    state.answers = saved.answers || {};
    state.order = saved.order && Object.keys(saved.order).length ? saved.order : buildOrder();
    state.index = Math.min(Math.max(0, saved.index || 0), TOTAL - 1);
    state.resultId = null;
    state.shadowId = null;
    state.finished = false;
    el.btnResume.classList.add('hidden');
    showScreen('quiz');
    renderQuestion();
    save();
  }

  /* ------------------------------------------------------------------
   * 流程
   * ---------------------------------------------------------------- */
  function startQuiz(fromIndex) {
    if (!(cfg.meta && cfg.meta.shuffleOptions === false)) {
      // 每次开新的一轮都重新打乱
      if (!state.order || !Object.keys(state.order).length) state.order = buildOrder();
    }
    state.index = fromIndex || 0;
    state.finished = false;
    state.resultId = null;
    state.shadowId = null;
    el.btnResume.classList.add('hidden');
    showScreen('quiz');
    renderQuestion();
    save();
  }

  function next() {
    clearAuto();
    const q = QUESTIONS[state.index];
    if (!q) return;
    if (!state.answers[q.id]) { toast('先选一个选项吧'); setNextEnabled(false); return; }

    if (state.index < TOTAL - 1) {
      state.index += 1;
      renderQuestion();
      save();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      finish();
    }
  }

  function prev() {
    clearAuto();
    if (state.index === 0) return;
    state.index -= 1;
    renderQuestion();
    save();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function finish() {
    clearAuto();
    const s = computeScoreSet();
    if (!s.resultId) {
      toast('判定规则有问题，请检查 config.js 的 scoring 与 results');
      return;
    }
    state.resultId = s.resultId;
    state.shadowId = s.shadowId || null;
    state.finished = true;
    save();

    // 过渡屏：约 1.2 秒的「计算中」
    el.calcText.textContent = (cfg.meta || {}).transitionText || '正在计算结果…';
    showScreen('calc');
    setTimeout(showResult, 1200);
  }

  function showResult() {
    const result = findResult(state.resultId);
    if (!result) { toast('结果配置有问题，请检查 config.js'); return; }
    renderResult(result);
    showScreen('result');
    lastResult = result;
    posterCache = null;   // 换了结果，缓存的图作废
    const shadow = state.shadowId ? findResult(state.shadowId) : null;
    track('result_view', { main: result.name, shadow: shadow ? shadow.name : '', via: state.via || 'quiz' });
  }

  function restart() {
    state.answers = {};
    state.order = buildOrder();
    state.index = 0;
    state.resultId = null;
    state.shadowId = null;
    state.finished = false;
    store.clear();
    posterCache = null;
    showIntro();
  }

  /* ------------------------------------------------------------------
   * 分享图片
   * ---------------------------------------------------------------- */
  let posterCache = null;
  let lastResult = null;
  let generating = false;

  function openPosterModal() {
    el.posterModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    if (posterCache) { showPoster(posterCache); return; }
    buildPoster();
  }

  function closePosterModal() {
    el.posterModal.classList.add('hidden');
    document.body.style.overflow = '';
  }

  function setPosterStage(stage) {
    el.posterLoading.classList.toggle('hidden', stage !== 'loading');
    el.posterError.classList.toggle('hidden', stage !== 'error');
    el.posterDone.classList.toggle('hidden', stage !== 'done');
  }

  function buildPoster() {
    if (generating) return;
    if (!lastResult) { setPosterStage('error'); el.errText.textContent = '还没有结果，先做完题目吧'; return; }

    generating = true;
    setPosterStage('loading');
    el.loadingText.textContent = '正在生成图片…';
    el.btnDownload.disabled = true;

    const timer = setTimeout(function () {
      el.loadingText.textContent = '正在排版，马上就好…';
    }, 1200);

    Poster.generate({
      title: (cfg.meta || {}).title || '',
      resultName: lastResult.name || '',
      typeColor: lastResult.color || '',
      tagline: lastResult.tagline || '',
      posterLine: lastResult.posterLine || lastResult.shareLine || '',
      stuckLabel: lastResult.stuckLabel || '',
      stuckDesc: lastResult.stuckDesc || '',
      stuckKind: lastResult.stuckKind || 'gap',
      stuckIndex: Number(lastResult.stuckIndex) || 0,
      segments: (cfg.pipeline && cfg.pipeline.segments) || [],
      takeaway: lastResult.takeaway || '',
      brandName: (cfg.meta || {}).brandName || '',
      signature: (cfg.meta || {}).signature || '',
      logo: (cfg.meta || {}).logo || '',
      shareUrl: getShareUrl(),
      qrCaption: (cfg.share || {}).posterCaption || '扫码测测你的',
      wechatId: (cfg.followUp || {}).wechatId || '',
      wechatNote: (cfg.followUp || {}).wechatNote || ''
    }).then(function (res) {
      clearTimeout(timer);
      generating = false;
      if (posterCache && posterCache.url) URL.revokeObjectURL(posterCache.url);
      const url = URL.createObjectURL(res.blob);
      posterCache = { blob: res.blob, dataURL: res.dataURL, url: url, width: res.width, height: res.height };
      showPoster(posterCache);
    }).catch(function (err) {
      clearTimeout(timer);
      generating = false;
      console.error(err);
      el.errText.textContent = '图片生成失败：' + (err && err.message ? err.message : '未知原因');
      setPosterStage('error');
    });
  }

  function showPoster(cache) {
    el.posterImg.src = cache.url;
    el.btnDownload.disabled = false;
    fillInviteText();
    if (isLocalPreview()) {
      console.warn('[提醒] 当前是本地预览，二维码指向本机地址。上线前请在 js/config.js 里填写 meta.shareUrl。');
    }
    setPosterStage('done');
  }

  function inviteText() {
    const url = getShareUrl();
    const fu = cfg.followUp || {};
    const wechatLine = fu.wechatId
      ? '\n加我微信 ' + fu.wechatId + (fu.wechatNote ? '（' + fu.wechatNote + '）' : '')
      : '';
    let body;
    if (lastResult && lastResult.shareLine) {
      body = lastResult.shareLine + '\n测测你：' + url;
    } else {
      const tpl = (cfg.share || {}).inviteTemplate || '我测了一下「{title}」，结果是【{resultName}】。\n{url}';
      body = tpl
        .replace(/\{title\}/g, (cfg.meta || {}).title || '')
        .replace(/\{resultName\}/g, lastResult ? lastResult.name : '')
        .replace(/\{url\}/g, url);
    }
    return body + wechatLine;
  }

  function fillInviteText() {
    el.copyBox.value = inviteText();
    el.copyTip.classList.add('hidden');
  }

  function downloadPoster() {
    if (!posterCache) return;
    const a = document.createElement('a');
    a.href = posterCache.url;
    a.download = ((cfg.meta || {}).title || '测评') + '-' + (lastResult ? lastResult.name : '结果') + '.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast('已开始下载，请查看下载文件夹');
  }

  async function sharePoster() {
    if (!posterCache) return;
    try {
      const file = new File([posterCache.blob], 'share.png', { type: 'image/png' });
      if (!navigator.canShare || !navigator.canShare({ files: [file] })) {
        toast('当前浏览器不支持直接分享，请长按图片保存');
        return;
      }
      await navigator.share({ files: [file], title: (cfg.meta || {}).title || '', text: inviteText() });
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('分享取消了，可以长按图片保存');
    }
  }

  /* 复制文字到剪贴板：优先 Clipboard API，失败降级到隐藏 textarea */
  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      throw new Error('no clipboard api');
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', 'readonly');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (e2) {
        return false;
      }
    }
  }

  async function copyInvite() {
    const text = el.copyBox.value;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        toast('文案已复制');
        return;
      }
      throw new Error('no clipboard api');
    } catch (e) {
      try {
        el.copyBox.removeAttribute('readonly');
        el.copyBox.select();
        el.copyBox.setSelectionRange(0, text.length);
        const ok = document.execCommand('copy');
        el.copyBox.setAttribute('readonly', 'readonly');
        if (ok) { toast('文案已复制'); return; }
      } catch (e2) { /* ignore */ }
      el.copyTip.classList.remove('hidden');
      el.copyBox.removeAttribute('readonly');
      el.copyBox.select();
    }
  }

  /* ------------------------------------------------------------------
   * 事件
   * ---------------------------------------------------------------- */
  el.btnStart.addEventListener('click', function () { track('test_start', {}); restart(); startQuiz(0); });
  el.btnResume.addEventListener('click', resumeSaved);
  el.btnNext.addEventListener('click', next);
  el.btnPrev.addEventListener('click', prev);
  el.btnRestartInline.addEventListener('click', restart);
  el.btnRetest.addEventListener('click', restart);

  el.btnPoster.addEventListener('click', function () { track('share_click', { action: 'open' }); openPosterModal(); });
  el.posterClose.addEventListener('click', closePosterModal);
  el.posterMask.addEventListener('click', closePosterModal);
  el.btnRetry.addEventListener('click', buildPoster);
  el.btnDownload.addEventListener('click', function () { track('share_click', { action: 'download' }); downloadPoster(); });
  el.btnShare.addEventListener('click', function () { track('share_click', { action: 'share' }); sharePoster(); });
  el.btnCopy.addEventListener('click', function () { track('copy_click', {}); copyInvite(); });

  // 后续引导区的链接点击统一埋点
  el.fuBody.addEventListener('click', function (e) {
    const a = e.target.closest ? e.target.closest('a[data-track]') : null;
    if (a) track(a.dataset.track || 'external_click', { href: a.href });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !el.posterModal.classList.contains('hidden')) closePosterModal();
    if (el.screens.quiz.classList.contains('hidden')) return;
    const n = parseInt(e.key, 10);
    if (!isNaN(n) && n >= 1 && n <= 9) {
      const q = QUESTIONS[state.index];
      const list = q ? orderedOptions(q) : [];
      if (list[n - 1]) pick(q.id, list[n - 1].id);
    }
  });

  /* ------------------------------------------------------------------
   * 启动
   * ---------------------------------------------------------------- */
  function boot() {
    if (isLocalPreview() && !(cfg.meta && cfg.meta.shareUrl)) {
      console.warn('[测评模板] 尚未配置 meta.shareUrl，二维码当前指向 ' + getShareUrl() + '。上线前请填入公开网址。');
    }
    renderStatic();
    const canShareFiles = typeof navigator !== 'undefined' &&
      typeof File !== 'undefined' && !!navigator.canShare;
    el.btnShare.classList.toggle('hidden', !canShareFiles);

    // ?r=类型名或id：直达某种结果（方便手动分享某一种结果）
    let rParam = null;
    try { rParam = new URLSearchParams(location.search).get('r'); } catch (e) { rParam = null; }
    if (rParam) {
      const hit = RESULTS.find(function (r) {
        return r.id === rParam || r.name === rParam;
      });
      if (hit) {
        state.resultId = hit.id;
        state.shadowId = null;
        state.finished = true;
        state.via = 'url';
        showResult();
        return;
      }
    }

    const restored = restoreIfAny();
    if (!restored) showIntro();
  }

  boot();
})();
