/* =========================================================================
 *  poster.js —— Canvas 分享海报生成（按《网页制作任务指令》第七节规格）
 *
 *  自上而下：
 *  顶部小字（测试标题）→ 类型名（类型主色大字）→ 一句话定义
 *  → 消化管道图（标出卡点）→ 你卡在：XX → XX → 带走一句（高亮卡）
 *  → 底部卡片（二维码 + 微信号 + 备注）→ 右下署名
 *
 *  设计要点：
 *  1. 1080 宽竖版，内容多自动加高，绝不裁切；
 *  2. 中文逐字测量换行，标点可悬挂，不出现在行首；
 *  3. 二维码项目内 QRCode.js 生成，四周白边（quiet zone）；
 *  4. 素材图片必须加载完成后再画；
 *  5. 页面和海报读同一份 QUIZ_CONFIG，文案不会不一致。
 * ========================================================================= */

const Poster = (function () {

  /* ---------------- 常量：版式参数 ---------------- */
  const W          = 1080;   // 海报宽度
  const MIN_H      = 1440;   // 最小高度
  const MARGIN     = 90;     // 左右边距
  const TOP        = 88;     // 上边距
  const BOTTOM     = 84;     // 下边距

  const FONT_STACK = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif';

  /* 主题色（与 theme.css 暖色规范一致） */
  const C = {
    bg:       '#FAF8F4',
    card:     '#FFFFFF',
    ink:      '#2C2C2A',
    inkSoft:  '#6B6A65',
    inkFaint: '#A09E97',
    brand:    '#2F5D50',
    warn:     '#D97742',
    line:     '#ECE7DD',
    todoBg:   '#F3F0E9',
    todoText: '#B8B3A7',
    arrow:    '#C6C0B2'
  };

  /* ---------------- 工具函数 ---------------- */

  function font(size, weight) {
    return (weight || 400) + ' ' + size + 'px ' + FONT_STACK;
  }

  const NO_LINE_START = '，。、；：！？）」』】》”’%…·.,!?:;)]}';
  const NO_LINE_END = '（「『【《“‘([{';

  function wrapText(ctx, text, maxWidth) {
    const lines = [];
    const paragraphs = String(text == null ? '' : text).split('\n');
    const limit = maxWidth + 14;

    for (const para of paragraphs) {
      if (para === '') { lines.push(''); continue; }
      let line = '';
      for (let i = 0; i < para.length; i++) {
        const ch = para[i];
        const test = line + ch;
        if (ctx.measureText(test).width <= limit || line === '') {
          line = test;
          continue;
        }
        if (NO_LINE_START.indexOf(ch) >= 0) { line = test; continue; }
        lines.push(line);
        line = NO_LINE_END.indexOf(ch) >= 0 ? ch + (para[i + 1] || '') : ch;
        if (NO_LINE_END.indexOf(ch) >= 0) i++;
      }
      if (line !== '') lines.push(line);
    }
    return lines;
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function loadImage(src) {
    return new Promise(function (resolve) {
      if (!src) return resolve(null);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = src;
    });
  }

  function buildQrCanvas(text) {
    const holder = document.getElementById('qrHolder');
    if (!holder || typeof QRCode === 'undefined' || !text) return Promise.resolve(null);

    holder.innerHTML = '';
    try {
      // eslint-disable-next-line no-new
      new QRCode(holder, {
        text: text,
        width: 208,
        height: 208,
        colorDark: '#2C2C2A',
        colorLight: '#FFFFFF',
        correctLevel: QRCode.CorrectLevel.M
      });
    } catch (e) {
      return Promise.resolve(null);
    }
    return waitForQrPixels(holder);
  }

  function waitForQrPixels(holder, timeout) {
    const deadline = Date.now() + (timeout || 4000);
    return new Promise(function (resolve) {
      (function check() {
        const canvas = holder.querySelector('canvas');
        if (canvas && canvas.width > 0 && canvas.height > 0) {
          try {
            const ctx = canvas.getContext('2d');
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            for (let i = 0; i < data.length; i += 4) {
              if (data[i] < 128 && data[i + 3] > 0) return resolve(canvas);
            }
          } catch (e) { return resolve(canvas); }
        }
        if (Date.now() > deadline) return resolve(canvas || null);
        requestAnimationFrame(check);
      })();
    });
  }

  /* ---------------- 管道图量算与绘制 ---------------- */

  const PIPE = { segH: 74, padX: 26, arrowW: 46, fonts: [34, 30, 26, 23] };

  function measurePipe(ctx, segments, innerW) {
    for (const fs of PIPE.fonts) {
      ctx.font = font(fs, 700);
      const padX = Math.max(14, PIPE.padX - (34 - fs));
      const segWs = segments.map(function (s) { return ctx.measureText(s).width + padX * 2; });
      const total = segWs.reduce(function (a, b) { return a + b; }, 0) +
                    PIPE.arrowW * Math.max(0, segments.length - 1);
      if (total <= innerW || fs === PIPE.fonts[PIPE.fonts.length - 1]) {
        return { fontSize: fs, padX: padX, segWs: segWs, total: Math.round(total) };
      }
    }
  }

  function drawPipe(ctx, data, L, y) {
    const segs = data.segments || [];
    const P = L.pipe;
    const kind = data.stuckKind || 'gap';
    const idx = Number(data.stuckIndex) || 0;
    const typeColor = data.typeColor || C.brand;

    let x = (L.W - P.total) / 2;
    segs.forEach(function (name, i) {
      // 段与段之间的箭头 / 卡点 ✕
      if (i > 0) {
        const ax = x + PIPE.arrowW / 2;
        const ay = y + PIPE.segH / 2;
        const gapIdx = i - 1;
        if (kind === 'gap' && gapIdx === idx) {
          // 断点：画一个暖橘 ✕
          ctx.strokeStyle = C.warn;
          ctx.lineWidth = 7;
          ctx.lineCap = 'round';
          const s = 15;
          ctx.beginPath();
          ctx.moveTo(ax - s, ay - 6 - s);
          ctx.lineTo(ax + s, ay - 6 + s);
          ctx.moveTo(ax + s, ay - 6 - s);
          ctx.lineTo(ax - s, ay - 6 + s);
          ctx.stroke();
        } else {
          ctx.fillStyle = C.arrow;
          ctx.font = font(30, 400);
          ctx.textAlign = 'center';
          ctx.fillText('→', ax, ay - 20);
          ctx.textAlign = 'left';
        }
        x += PIPE.arrowW;
      }

      // 状态：已通过 / 卡住 / 未到达
      let state;   // 'done' | 'stuck' | 'todo'
      if (kind === 'node') {
        state = i < idx ? 'done' : (i === idx ? 'stuck' : 'todo');
      } else {
        state = i <= idx ? 'done' : 'todo';
      }

      const w = P.segWs[i];
      ctx.font = font(P.fontSize, 700);
      if (state === 'done') {
        ctx.fillStyle = typeColor;
        roundRect(ctx, x, y, w, PIPE.segH, 16);
        ctx.fill();
        ctx.fillStyle = '#FFFFFF';
      } else if (state === 'stuck') {
        ctx.fillStyle = C.warn;
        roundRect(ctx, x, y, w, PIPE.segH, 16);
        ctx.fill();
        ctx.fillStyle = '#FFFFFF';
        // 节点卡住：再加一道 ✕ 角标
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        const cx = x + w - 6, cy = y + 6, s = 11;
        ctx.beginPath();
        ctx.moveTo(cx - s, cy - s);
        ctx.lineTo(cx + s, cy + s);
        ctx.moveTo(cx + s, cy - s);
        ctx.lineTo(cx - s, cy + s);
        ctx.stroke();
      } else {
        ctx.fillStyle = C.todoBg;
        roundRect(ctx, x, y, w, PIPE.segH, 16);
        ctx.fill();
        ctx.strokeStyle = C.line;
        ctx.lineWidth = 2;
        roundRect(ctx, x + 1, y + 1, w - 2, PIPE.segH - 2, 15);
        ctx.stroke();
        ctx.fillStyle = C.todoText;
      }
      ctx.textAlign = 'center';
      ctx.fillText(name, x + w / 2, y + (PIPE.segH - P.fontSize) / 2 + 2);
      ctx.textAlign = 'left';

      x += w;
    });

    // 「你卡在这里」标注
    const labelY = y + PIPE.segH + 20;
    ctx.font = font(30, 700);
    ctx.fillStyle = C.warn;
    ctx.textAlign = 'center';
    ctx.fillText('▲ 你卡在这里', L.W / 2, labelY);
    ctx.textAlign = 'left';

    return PIPE.segH + 20 + 44;   // 管道图总高
  }

  /* ---------------- 布局计算：先量后画 ---------------- */

  function measureLayout(ctx, data) {
    const innerW = W - MARGIN * 2;
    const QR_SIZE = 208, QR_QUIET = 24;
    const qrBox = QR_SIZE + QR_QUIET * 2;
    const CARD_PAD = 40;

    ctx.textAlign = 'left';

    // 顶部小字：测试标题
    ctx.font = font(36, 500);
    const titleLines = wrapText(ctx, data.title, innerW);

    // 类型名（大字、主色）
    ctx.font = font(96, 700);
    const nameLines = wrapText(ctx, data.resultName, innerW);

    // 一句话定义
    ctx.font = font(38);
    const tagLines = wrapText(ctx, data.tagline || '', innerW);

    // 管道图
    const pipe = measurePipe(ctx, data.segments || [], innerW);

    // 你卡在
    ctx.font = font(42, 700);
    const stuckLine = data.stuckLabel ? '你卡在：' + data.stuckLabel : '';
    const stuckLines = wrapText(ctx, stuckLine, innerW);

    ctx.font = font(32);
    const stuckDescLines = wrapText(ctx, data.stuckDesc || '', innerW);

    // 带走一句卡片
    const TAKE_PAD = 46;
    ctx.font = font(40, 600);
    const takeLines = wrapText(ctx, data.takeaway || '', innerW - TAKE_PAD * 2);
    const takeCardH = data.takeaway
      ? 34 + 30 + takeLines.length * 62 + TAKE_PAD * 2 - 34   // label 34 + gap 30 + text + 上下 pad
      : 0;

    // 底部卡片文字
    const footTextW = innerW - CARD_PAD * 2 - qrBox - 36;
    ctx.font = font(34, 700);
    const capLines = wrapText(ctx, data.qrCaption || '', footTextW);
    const idLine = data.wechatId ? '微信号 ' + data.wechatId : '';
    const idLines = idLine ? wrapText(ctx, idLine, footTextW) : [];
    ctx.font = font(28);
    const noteLines = wrapText(ctx, data.wechatNote || '', footTextW);
    ctx.font = font(26);
    const sigLines = wrapText(ctx, data.signature || '', footTextW);

    const footTextH =
      capLines.length * 44 +
      (idLines.length ? 12 + idLines.length * 46 : 0) +
      (noteLines.length ? 8 + noteLines.length * 40 : 0) +
      (sigLines.length ? 16 + sigLines.length * 36 : 0);
    const footCardH = Math.max(qrBox, footTextH) + CARD_PAD * 2;

    // 总高
    const contentH =
      titleLines.length * 52 +          // 顶部小字
      30 +
      nameLines.length * 118 +          // 类型名
      22 +
      tagLines.length * 58 +            // 一句话定义
      56 +
      (PIPE.segH + 20 + 44) +           // 管道图 + 标注
      46 +
      stuckLines.length * 58 +          // 你卡在
      (stuckDescLines.length ? 12 + stuckDescLines.length * 48 : 0) +
      50 +
      takeCardH +                       // 带走一句卡
      60 +
      footCardH;                        // 底部卡片

    const H = Math.max(MIN_H, Math.ceil(TOP + contentH + BOTTOM + 40));

    return {
      W: W, H: H, innerW: innerW,
      titleLines: titleLines, nameLines: nameLines, tagLines: tagLines,
      pipe: pipe, stuckLines: stuckLines, stuckDescLines: stuckDescLines,
      takeLines: takeLines, takeCardH: takeCardH, TAKE_PAD: TAKE_PAD,
      capLines: capLines, idLines: idLines, noteLines: noteLines, sigLines: sigLines,
      footCardH: footCardH, footTextW: footTextW,
      QR_SIZE: QR_SIZE, QR_QUIET: QR_QUIET, CARD_PAD: CARD_PAD, qrBox: qrBox
    };
  }

  /* ---------------- 绘制 ---------------- */

  function draw(ctx, L, data) {
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, L.W, L.H);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';

    let y = TOP;

    // 顶部小字：测试标题
    ctx.fillStyle = C.inkSoft;
    ctx.font = font(36, 500);
    for (const line of L.titleLines) {
      ctx.fillText(line, L.W / 2, y);
      y += 52;
    }
    y += 30;

    // 类型名（类型主色）
    ctx.fillStyle = data.typeColor || C.ink;
    ctx.font = font(96, 700);
    for (const line of L.nameLines) {
      ctx.fillText(line, L.W / 2, y);
      y += 118;
    }
    y += 22;

    // 一句话定义
    ctx.fillStyle = C.ink;
    ctx.font = font(38);
    for (const line of L.tagLines) {
      ctx.fillText(line, L.W / 2, y);
      y += 58;
    }
    y += 56;

    // 管道图
    y += drawPipe(ctx, data, L, y);
    ctx.textAlign = 'center';   // drawPipe 结束时是 left，中部文案要居中
    y += 46;

    // 你卡在
    ctx.fillStyle = C.ink;
    ctx.font = font(42, 700);
    for (const line of L.stuckLines) {
      ctx.fillText(line, L.W / 2, y);
      y += 58;
    }
    if (L.stuckDescLines.length) {
      y += 12;
      ctx.fillStyle = C.inkSoft;
      ctx.font = font(32);
      for (const line of L.stuckDescLines) {
        ctx.fillText(line, L.W / 2, y);
        y += 48;
      }
    }
    y += 50;

    // 带走一句卡片
    if (data.takeaway && L.takeCardH) {
      const cw = L.innerW;
      ctx.fillStyle = C.card;
      roundRect(ctx, MARGIN, y, cw, L.takeCardH, 22);
      ctx.fill();
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 2;
      roundRect(ctx, MARGIN + 1, y + 1, cw - 2, L.takeCardH - 2, 21);
      ctx.stroke();

      // 左侧暖橘竖条
      ctx.fillStyle = C.warn;
      roundRect(ctx, MARGIN, y, 10, L.takeCardH, 5);
      ctx.fill();

      ctx.fillStyle = C.warn;
      ctx.font = font(30, 700);
      ctx.fillText('带走一句', L.W / 2, y + L.TAKE_PAD - 8);

      ctx.fillStyle = C.ink;
      ctx.font = font(40, 600);
      let ty = y + L.TAKE_PAD + 36;
      for (const line of L.takeLines) {
        ctx.fillText(line, L.W / 2, ty);
        ty += 62;
      }
      y += L.takeCardH;
    }
    y += 60;

    /* --- 底部卡片：二维码 + 引导 --- */
    const cw = L.innerW;
    const ch = L.footCardH;
    ctx.fillStyle = C.card;
    roundRect(ctx, MARGIN, y, cw, ch, 26);
    ctx.fill();
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 2;
    roundRect(ctx, MARGIN + 1, y + 1, cw - 2, ch - 2, 25);
    ctx.stroke();

    const qrX = MARGIN + L.CARD_PAD + L.QR_QUIET;
    const qrY = y + L.CARD_PAD + L.QR_QUIET;
    if (data.qrCanvas) {
      // 白底 + 白边，保证二维码扫得出来
      ctx.fillStyle = '#FFFFFF';
      roundRect(ctx, MARGIN + L.CARD_PAD - 6, y + L.CARD_PAD - 6, L.qrBox + 12, L.qrBox + 12, 18);
      ctx.fill();
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 2;
      roundRect(ctx, MARGIN + L.CARD_PAD - 5, y + L.CARD_PAD - 5, L.qrBox + 10, L.qrBox + 10, 17);
      ctx.stroke();
      ctx.drawImage(data.qrCanvas, qrX, qrY, L.QR_SIZE, L.QR_SIZE);
    }

    // 右侧文字（左对齐、垂直居中）
    const tx = MARGIN + L.CARD_PAD + L.qrBox + 36;
    const textH =
      L.capLines.length * 44 +
      (L.idLines.length ? 12 + L.idLines.length * 46 : 0) +
      (L.noteLines.length ? 8 + L.noteLines.length * 40 : 0) +
      (L.sigLines.length ? 16 + L.sigLines.length * 36 : 0);
    let ty = y + (ch - textH) / 2;
    ty = Math.max(y + L.CARD_PAD, ty);
    ctx.textAlign = 'left';

    ctx.fillStyle = C.brand;
    ctx.font = font(34, 700);
    for (const line of L.capLines) { ctx.fillText(line, tx, ty); ty += 44; }
    if (L.idLines.length) {
      ty += 12;
      ctx.fillStyle = C.ink;
      ctx.font = font(33, 700);
      for (const line of L.idLines) { ctx.fillText(line, tx, ty); ty += 46; }
    }
    if (L.noteLines.length) {
      ty += 8;
      ctx.fillStyle = C.inkSoft;
      ctx.font = font(28);
      for (const line of L.noteLines) { ctx.fillText(line, tx, ty); ty += 40; }
    }
    if (L.sigLines.length) {
      ty += 16;
      ctx.fillStyle = C.inkFaint;
      ctx.font = font(26);
      for (const line of L.sigLines) { ctx.fillText(line, tx, ty); ty += 36; }
    }

    return true;
  }

  /* ---------------- 主入口 ---------------- */

  /**
   * @param {Object} opts
   *   title      测试标题（顶部小字）
   *   resultName 类型名
   *   typeColor  类型主色
   *   tagline    一句话定义
   *   segments   管道五段
   *   stuckKind / stuckIndex / stuckLabel / stuckDesc  卡点信息
   *   takeaway   带走一句
   *   brandName  品牌名（未用顶部行，保留兼容）
   *   signature  署名
   *   logo       项目内 logo 路径（保留兼容）
   *   shareUrl   二维码指向的公开地址
   *   qrCaption  二维码旁引导语
   *   wechatId / wechatNote  微信号与备注语
   * @returns {Promise<{canvas, blob, dataURL, width, height}>}
   */
  async function generate(opts) {
    const data = Object.assign({
      title: '', resultName: '', typeColor: '', tagline: '',
      segments: [], stuckKind: 'gap', stuckIndex: 0,
      stuckLabel: '', stuckDesc: '', takeaway: '',
      brandName: '', signature: '', logo: '',
      shareUrl: '', qrCaption: '扫码测测你的',
      wechatId: '', wechatNote: ''
    }, opts || {});

    const qrCanvas = await buildQrCanvas(data.shareUrl);
    data.qrCanvas = qrCanvas;

    // 顶部小字旁的小 logo（可选，加载失败不阻塞）
    data.logoImg = await loadImage(data.logo);

    const probe = document.createElement('canvas');
    const pctx = probe.getContext('2d');
    const layout = measureLayout(pctx, data);

    const canvas = document.createElement('canvas');
    canvas.width = layout.W;
    canvas.height = layout.H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前浏览器不支持 Canvas，无法生成图片');

    draw(ctx, layout, data);

    const blob = await new Promise(function (resolve, reject) {
      if (!canvas.toBlob) return reject(new Error('浏览器不支持导出图片'));
      canvas.toBlob(function (b) {
        b ? resolve(b) : reject(new Error('图片导出失败'));
      }, 'image/png');
    });

    let dataURL = '';
    try { dataURL = canvas.toDataURL('image/png'); } catch (e) { dataURL = ''; }

    return { canvas: canvas, blob: blob, dataURL: dataURL, width: layout.W, height: layout.H };
  }

  return { generate: generate, wrapText: wrapText, W: W, MIN_H: MIN_H };
})();
