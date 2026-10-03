/* Sesame site: language switch, theme-aware shots, copy buttons, the film, the typing bar, the count.
   No analytics, no network calls besides the page's own files. */
(function () {
  'use strict';
  var doc = document.documentElement;
  doc.classList.add('js');

  var dark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;
  var lang = function () { return doc.getAttribute('data-lang') === 'zh' ? 'zh' : 'en'; };
  var theme = function () { return dark && dark.matches ? 'dark' : 'light'; };

  /* ---------- the app shots: one file per language × theme, only the one in use is fetched ---------- */
  var shots = Array.prototype.slice.call(document.querySelectorAll('img[data-shot]'));
  function paintShots() {
    var l = lang(), t = theme();
    shots.forEach(function (img) {
      var ext = img.getAttribute('data-ext') || 'gif';
      var src = 'assets/' + img.getAttribute('data-shot') + '-' + l + '-' + t + '.' + ext;
      if (img.getAttribute('src') !== src) img.setAttribute('src', src);
      img.setAttribute('alt', img.getAttribute('data-alt-' + l) || '');
    });
  }

  /* ---------- the film ---------- */
  var FILM_V = '20261003';   // bump when site/media/promo-*.mp4 changes, so browsers and the Pages CDN fetch the new film
  var video = document.getElementById('promo');
  var player = document.getElementById('player');
  var playBtn = document.getElementById('playBtn');
  function paintFilm() {
    var l = lang();
    var src = 'media/promo-' + l + '.mp4?v=' + FILM_V;
    if (video.getAttribute('data-src') === src) return;
    var wasPlaying = !video.paused;
    video.pause();
    video.setAttribute('data-src', src);
    video.setAttribute('poster', 'media/poster-' + l + '.jpg');
    player.style.backgroundImage = 'url("media/poster-' + l + '.jpg")';
    if (wasPlaying || player.classList.contains('playing')) {
      video.setAttribute('src', src);
      video.load();
      video.play().catch(function () { video.controls = true; });
    } else {
      video.removeAttribute('src');
    }
  }
  playBtn.addEventListener('click', function () {
    if (!video.getAttribute('src')) video.setAttribute('src', video.getAttribute('data-src'));
    player.classList.add('playing');
    video.controls = true;
    var p = video.play();
    if (p && p.catch) p.catch(function () { video.controls = true; });
  });
  video.addEventListener('ended', function () { video.controls = true; });

  /* ---------- language ---------- */
  var titleEl = document.querySelector('title');
  var titles = { en: titleEl.getAttribute('data-en'), zh: titleEl.getAttribute('data-zh') };
  var langBtn = document.getElementById('langBtn');
  function setLang(l, remember) {
    doc.setAttribute('data-lang', l);
    doc.setAttribute('lang', l === 'zh' ? 'zh-CN' : 'en');
    document.title = titles[l] || titles.en;
    langBtn.setAttribute('aria-label', l === 'zh' ? 'Switch to English' : '切换到中文');
    if (remember) { try { localStorage.setItem('sesame-lang', l); } catch (e) { /* storage off: the choice lasts for this page only */ } }
    paintShots();
    paintFilm();
    restartSay();
  }
  langBtn.addEventListener('click', function () { setLang(lang() === 'zh' ? 'en' : 'zh', true); });
  if (dark) {
    var onTheme = function () { paintShots(); };
    if (dark.addEventListener) dark.addEventListener('change', onTheme); else if (dark.addListener) dark.addListener(onTheme);
  }

  /* ---------- copy ---------- */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (ok) { resolve(); } else { reject(new Error('copy failed')); }
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-copy]'), function (btn) {
    var label = btn.querySelector('.copy-t');
    var original = label ? label.innerHTML : '';
    var timer = 0;
    btn.addEventListener('click', function () {
      var el = document.getElementById(btn.getAttribute('data-copy'));
      copyText(el.textContent.trim()).then(function () {
        btn.classList.add('done');
        if (label) label.innerHTML = '<span data-l="zh">已复制</span><span data-l="en">Copied</span>';
        btn.setAttribute('data-copied', '1');
        clearTimeout(timer);
        timer = setTimeout(function () { btn.classList.remove('done'); if (label) label.innerHTML = original; }, 1800);
      }).catch(function () {
        var r = document.createRange(); r.selectNodeContents(el);
        var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      });
    });
  });

  /* ---------- install tabs ---------- */
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
  function selectTab(tab) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { selectTab(t); });
    t.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      selectTab(n); n.focus();
    });
  });

  /* ---------- the input bar types what you would say (sentences from the README) ---------- */
  var says = {
    zh: ['打开上周那个交易大盘', '上周那个看板在哪', '把我昨天做的报告打开'],
    en: ["Open last week's trading dashboard", 'Where is the trading dashboard from last week?', 'Open the report I made yesterday']
  };
  var sayEl = document.getElementById('sayText');
  var sayTimer = 0;
  function restartSay() {
    clearTimeout(sayTimer);
    var list = says[lang()];
    if (reduce) { sayEl.textContent = list[0]; return; }
    var i = 0, c = 0, del = false;
    (function tick() {
      var s = list[i];
      if (!del) {
        c++; sayEl.textContent = s.slice(0, c);
        if (c >= s.length) { del = true; sayTimer = setTimeout(tick, 1900); return; }
        sayTimer = setTimeout(tick, lang() === 'zh' ? 120 : 52);
      } else {
        c -= 2; if (c < 0) c = 0; sayEl.textContent = s.slice(0, c);
        if (c === 0) { del = false; i = (i + 1) % list.length; sayTimer = setTimeout(tick, 420); return; }
        sayTimer = setTimeout(tick, 22);
      }
    })();
  }

  /* ---------- the count rolls up once, like the app (1.2 s) ---------- */
  var num = document.getElementById('countNum');
  var target = parseInt(num.getAttribute('data-to'), 10) || 0;
  function roll() {
    if (reduce) { num.textContent = String(target); return; }
    var t0 = 0;
    function step(ts) {
      if (!t0) t0 = ts;
      var p = Math.min(1, (ts - t0) / 1200);
      var e = 1 - Math.pow(1 - p, 3);
      num.textContent = String(Math.round(target * e));
      if (p < 1) requestAnimationFrame(step);
    }
    num.textContent = '0';
    requestAnimationFrame(step);
  }

  /* ---------- reveal on scroll, nav hairline ---------- */
  var reveals = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
  if ('IntersectionObserver' in window && !reduce) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add('in');
        if (en.target.contains(num)) roll();
        io.unobserve(en.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add('in'); });
  }
  var nav = document.getElementById('nav');
  function onScroll() { nav.classList.toggle('scrolled', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  setLang(lang(), false);
})();
