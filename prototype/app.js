/* ============================================================================
 * app.js —— 飞书多维表格「卡片视图」UI 评审原型脚本
 * ----------------------------------------------------------------------------
 * ⚠️ 这是「UI 评审原型」的脚本，不是生产代码。
 *    - 仅负责：屏幕切换 / 抽屉开关 / 缩放控制 / 拖拽模拟 / 交互演示。
 *    - 不含任何飞书 SDK、网络请求、数据持久化逻辑。
 *    - 零依赖，file:// 协议下可直接运行（未使用 fetch / ES module import）。
 * ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* 0. 小工具                                                          */
  /* ------------------------------------------------------------------ */
  function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }
  function toggleClass(el, name, on) {
    if (!el) { return; }
    el.classList.toggle(name, !!on);
  }

  /* ------------------------------------------------------------------ */
  /* 1. 屏幕切换（左侧导航）                                             */
  /* ------------------------------------------------------------------ */
  var SCREEN_IDS = ['s1', 's2', 's3', 's4', 's5', 's6', 'demo'];
  var navItems = qsa('[data-screen]');
  var screens = SCREEN_IDS.map(function (id) { return document.getElementById(id); });
  var stage = document.querySelector('.stage');

  function showScreen(id) {
    if (SCREEN_IDS.indexOf(id) === -1) { return; }
    screens.forEach(function (s) { toggleClass(s, 'active', s && s.id === id); });
    navItems.forEach(function (b) { toggleClass(b, 'active', b.getAttribute('data-screen') === id); });
    if (stage) { stage.scrollTop = 0; }
    // 进入 S2 时，若处于「适应宽度」模式则重新按容器宽度计算缩放
    if (id === 's2' && fitToWidthEnabled) { fitToWidth(); }
  }

  navItems.forEach(function (btn) {
    btn.addEventListener('click', function () {
      showScreen(btn.getAttribute('data-screen'));
    });
  });

  /* ------------------------------------------------------------------ */
  /* 2. 详情抽屉开关（S2）                                              */
  /* ------------------------------------------------------------------ */
  var drawer = document.getElementById('detailDrawer');

  function setDrawer(open) {
    toggleClass(drawer, 'is-open', open);
  }

  qsa('[data-open-drawer]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      // 抽屉内部元素不应再次触发打开
      if (drawer && drawer.contains(el) && el !== drawer) { return; }
      e.stopPropagation();
      setDrawer(true);
    });
  });

  qsa('[data-close-drawer]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      setDrawer(false);
    });
  });

  // S1 卡片：单击后跳转到 S2 并打开详情抽屉（模拟「卡片展开详情」）
  qsa('.js-goto-detail').forEach(function (el) {
    el.addEventListener('click', function () {
      showScreen('s2');
      setDrawer(true);
    });
  });

  /* ------------------------------------------------------------------ */
  /* 3. 文档缩放控制（S2 抽屉工具条）                                   */
  /* ------------------------------------------------------------------ */
  var docCanvas = document.getElementById('docCanvas');
  var zoomLabel = document.getElementById('zoomLabel');
  var fitBtn = document.getElementById('fitBtn');
  var zoomOutBtn = document.getElementById('zoomOut');
  var zoomInBtn = document.getElementById('zoomIn');
  var ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5];
  var zoom = 0.95;
  var fitToWidthEnabled = true;

  function applyZoom() {
    if (!docCanvas) { return; }
    docCanvas.style.setProperty('--doc-zoom', String(zoom));
    if (zoomLabel) { zoomLabel.textContent = Math.round(zoom * 100) + '%'; }
    toggleClass(fitBtn, 'is-active', fitToWidthEnabled);
  }

  function fitToWidth() {
    if (!docCanvas) { return; }
    var avail = docCanvas.clientWidth - 48; // 减去左右 24px padding
    if (avail <= 0) { return; }
    var z = avail / 794;
    zoom = Math.max(0.5, Math.min(1.5, Math.round(z * 100) / 100));
    applyZoom();
  }

  function nearestPresetIndex() {
    var best = 0;
    var bestDiff = Infinity;
    ZOOM_PRESETS.forEach(function (p, i) {
      var d = Math.abs(p - zoom);
      if (d < bestDiff) { bestDiff = d; best = i; }
    });
    return best;
  }

  function stepZoom(dir) {
    fitToWidthEnabled = false;
    var idx = nearestPresetIndex() + dir;
    idx = Math.max(0, Math.min(ZOOM_PRESETS.length - 1, idx));
    zoom = ZOOM_PRESETS[idx];
    applyZoom();
  }

  if (zoomOutBtn) { zoomOutBtn.addEventListener('click', function () { stepZoom(-1); }); }
  if (zoomInBtn) { zoomInBtn.addEventListener('click', function () { stepZoom(1); }); }
  if (fitBtn) {
    fitBtn.addEventListener('click', function () {
      fitToWidthEnabled = true;
      fitToWidth();
    });
  }
  window.addEventListener('resize', function () {
    if (fitToWidthEnabled) { fitToWidth(); }
  });

  /* 打印按钮：原型仅给出提示，不真正调用打印 */
  var toast = document.getElementById('toast');
  function showToast(msg) {
    if (!toast) { return; }
    toast.textContent = msg;
    toast.classList.add('show');
    window.clearTimeout(showToast._t);
    showToast._t = window.setTimeout(function () { toast.classList.remove('show'); }, 2200);
  }
  qsa('[data-toast]').forEach(function (el) {
    el.addEventListener('click', function () { showToast(el.getAttribute('data-toast')); });
  });

  /* ------------------------------------------------------------------ */
  /* 3b. 抽屉调宽 + 全屏切换 + Esc 两级行为                              */
  /* ------------------------------------------------------------------ */
  var s2Wrap = document.querySelector('#s2 .s2-wrap');
  var resizeHandle = document.querySelector('#detailDrawer .resize-handle');
  var fullBtn = document.getElementById('drawerFullBtn');

  function isFull() { return !!drawer && drawer.classList.contains('is-full'); }

  function syncFullIcon() {
    if (!fullBtn) { return; }
    var full = isFull();
    fullBtn.innerHTML = '<svg><use href="#' + (full ? 'i-collapse' : 'i-expand') + '"/></svg>';
    fullBtn.title = full ? '退出全屏' : '全屏展开';
  }

  function toggleFull() {
    if (!drawer) { return; }
    if (isFull()) { drawer.classList.remove('is-full'); }
    else { drawer.classList.add('is-full'); }
    syncFullIcon();
    if (fitToWidthEnabled) { fitToWidth(); }
  }

  if (fullBtn) { fullBtn.addEventListener('click', toggleFull); }

  if (resizeHandle && drawer) {
    var dragging = false;
    var startX = 0;
    var startW = 0;
    var containerW = 0;

    resizeHandle.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      // 拖动期间关闭过渡，保证跟手无拖尾；若在全屏则先退出全屏
      drawer.classList.add('is-resizing');
      if (isFull()) { drawer.classList.remove('is-full'); syncFullIcon(); }
      startW = drawer.getBoundingClientRect().width;
      containerW = s2Wrap ? s2Wrap.clientWidth : window.innerWidth;
      try { resizeHandle.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    });

    resizeHandle.addEventListener('pointermove', function (e) {
      if (!dragging) { return; }
      var w = startW + (startX - e.clientX); // 向左拖 = 变宽
      w = Math.max(560, Math.min(containerW, Math.round(w)));
      drawer.style.setProperty('--drawer-w', w + 'px');
      if (fitToWidthEnabled) { fitToWidth(); }
    });

    function endResize(e) {
      if (!dragging) { return; }
      dragging = false;
      drawer.classList.remove('is-resizing');
      try { resizeHandle.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
    }
    resizeHandle.addEventListener('pointerup', endResize);
    resizeHandle.addEventListener('pointercancel', endResize);
  }

  // Esc 两级：全屏时先退全屏；否则关闭抽屉
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' && e.keyCode !== 27) { return; }
    if (!drawer || !drawer.classList.contains('is-open')) { return; }
    if (isFull()) {
      drawer.classList.remove('is-full');
      syncFullIcon();
      if (fitToWidthEnabled) { fitToWidth(); }
    } else {
      setDrawer(false);
    }
  });

  /* ------------------------------------------------------------------ */
  /* 3c. 卡片悬浮预览（真 hover + 150ms 延迟；移入气泡不消失）          */
  /* ------------------------------------------------------------------ */
  var sharedPreview = document.getElementById('sharedPreview');
  var cardRegion = document.querySelector('#s1 .card-region');
  var hoverCards = qsa('#s1 .card-grid > .card:not(.skeleton)');
  var hoverTimer = null;

  function showPreviewFor(card) {
    if (!sharedPreview) { return; }
    // 气泡作为卡片子元素 —— 鼠标移入气泡时不会触发 card 的 mouseleave
    if (sharedPreview.parentElement !== card) { card.appendChild(sharedPreview); }
    if (cardRegion) {
      var cr = card.getBoundingClientRect();
      var rr = cardRegion.getBoundingClientRect();
      if (cr.right + 300 > rr.right) { sharedPreview.classList.add('flip'); }
      else { sharedPreview.classList.remove('flip'); }
    }
    sharedPreview.classList.add('show');
  }

  function hidePreview() {
    if (sharedPreview) { sharedPreview.classList.remove('show'); }
  }

  hoverCards.forEach(function (card) {
    card.addEventListener('mouseenter', function () {
      window.clearTimeout(hoverTimer);
      hoverTimer = window.setTimeout(function () { showPreviewFor(card); }, 150);
    });
    card.addEventListener('mouseleave', function () {
      window.clearTimeout(hoverTimer);
      hidePreview();
    });
  });

  /* ------------------------------------------------------------------ */
  /* 4. S3 拖拽模拟开关                                                 */
  /* ------------------------------------------------------------------ */
  var editor3 = document.querySelector('#s3 .editor');
  var dragBtn = document.querySelector('[data-toggle-drag]');

  function setDragSim(on) {
    if (!editor3) { return; }
    editor3.classList.toggle('is-dragging', !!on);
    if (dragBtn) {
      dragBtn.classList.toggle('is-active', !!on);
      dragBtn.textContent = on ? '结束拖拽模拟' : '模拟拖拽中';
    }
  }

  if (dragBtn) {
    dragBtn.addEventListener('click', function () {
      setDragSim(!editor3.classList.contains('is-dragging'));
    });
  }

  /* ------------------------------------------------------------------ */
  /* 5. S3/S4 手风琴面板展开                                            */
  /* ------------------------------------------------------------------ */
  qsa('.accordion > .acc-head').forEach(function (head) {
    head.addEventListener('click', function () {
      var acc = head.parentElement;
      if (acc) { acc.classList.toggle('open'); }
    });
  });

  /* ------------------------------------------------------------------ */
  /* 6. S4 区块选中                                                     */
  /* ------------------------------------------------------------------ */
  var s4Blocks = qsa('#s4 .doc-block');
  s4Blocks.forEach(function (block) {
    block.addEventListener('click', function (e) {
      e.stopPropagation();
      s4Blocks.forEach(function (b) { b.classList.remove('is-selected'); });
      block.classList.add('is-selected');
    });
  });

  /* ------------------------------------------------------------------ */
  /* 7. 交互演示（导航最后一项）                                        */
  /* ------------------------------------------------------------------ */
  var demoSteps = qsa('#demo .demo-step');
  demoSteps.forEach(function (step) {
    step.addEventListener('click', function () {
      demoSteps.forEach(function (s) { s.classList.remove('is-active'); });
      step.classList.add('is-active');

      var targetScreen = step.getAttribute('data-demo-screen');
      if (targetScreen) { showScreen(targetScreen); }

      // 需要抽屉打开的步骤
      if (step.getAttribute('data-demo-drawer') === 'open') { setDrawer(true); }
      if (step.getAttribute('data-demo-drawer') === 'close') { setDrawer(false); }

      // 需要开启拖拽模拟的步骤
      if (step.getAttribute('data-demo-drag')) {
        setDragSim(step.getAttribute('data-demo-drag') === 'on');
      }

      // 高亮目标元素
      var targetId = step.getAttribute('data-demo-target');
      if (targetId) {
        var el = document.getElementById(targetId);
        if (el) {
          el.classList.remove('demo-pulse');
          void el.offsetWidth; // 触发重排以重放动画
          el.classList.add('demo-pulse');
          if (el.scrollIntoView) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
          window.setTimeout(function () { el.classList.remove('demo-pulse'); }, 1900);
        }
      }
    });
  });

  /* ------------------------------------------------------------------ */
  /* 8. 初始化                                                          */
  /* ------------------------------------------------------------------ */
  applyZoom();
  showScreen('s1');
})();
