/* graphmind.ai — behaviour.
   1. The live demo: the real viewer (its fixture run, tour mode) in the hero
      on capable screens; a short clip otherwise. The viewer posts tour steps;
      the frame's state chip, the "you did it" CTA and the funnel events follow.
   2. Motion (GSAP + ScrollTrigger, vendored): the headline arrives word by
      word, the spine draws with scroll, each stage goes "live" as it enters,
      media drifts a little. All of it is skipped under prefers-reduced-motion
      (the page is complete without it) and every clip has a pause control.
   3. The funnel: eight anonymous events, no cookies, sent with sendBeacon.
   4. The small things: copy the command, release notes, the sticky bar. */
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var html = document.documentElement;
  if (reduce) html.classList.add('no-anim');

  /* ---------------------------------------------------------- events -- */
  var sid = (function () {
    try {
      var k = 'gm.sid';
      var v = sessionStorage.getItem(k);
      if (!v) {
        v = Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 8);
        sessionStorage.setItem(k, v);
      }
      return v;
    } catch (e) { return 'anon' + Math.random().toString(36).slice(2, 10); }
  })();
  var sent = {};
  function track(event, extra, once) {
    if (once && sent[event + (extra && extra.where || '')]) return;
    sent[event + (extra && extra.where || '')] = true;
    var body = JSON.stringify(Object.assign({ event: event, sid: sid }, extra || {}));
    try {
      if (navigator.sendBeacon) navigator.sendBeacon('/api/events', new Blob([body], { type: 'application/json' }));
      else fetch('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body, keepalive: true }).catch(function () {});
    } catch (e) { /* never in the visitor's way */ }
  }
  track('home-view', null, true);
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('[data-track]');
    if (a) track(a.getAttribute('data-track'), { where: a.getAttribute('data-where') || 'page' });
  });

  /* -------------------------------------------------------- the demo -- */
  var demo = document.getElementById('demo');
  var stateEl = document.getElementById('demo-state');
  var stateText = document.getElementById('demo-state-text');
  var after = document.getElementById('demo-after');
  var loadBtn = document.getElementById('demo-load');
  var STATE = {
    idle: 'Live demo',
    watch: 'Running',
    held: 'Held — your move',
    resumed: 'Resumed by you',
    done: 'Run finished',
  };
  function setStep(step) {
    if (!stateEl) return;
    stateEl.setAttribute('data-step', step);
    stateText.textContent = STATE[step] || step;
    if (step === 'resumed') { track('demo-inject', null, true); }
    if (step === 'done') { after.hidden = false; track('demo-done', null, true); }
  }
  var canEmbed = demo && window.innerWidth >= 900 && !(navigator.connection && navigator.connection.saveData);
  function loadDemo() {
    if (!demo || demo.classList.contains('is-live')) return;
    var frame = document.createElement('iframe');
    frame.src = demo.getAttribute('data-try');
    frame.title = 'GraphMind debugger: a live run you can fix';
    frame.loading = 'eager';
    frame.setAttribute('allow', 'clipboard-write');
    demo.querySelector('.demo-stage').appendChild(frame);
    demo.classList.add('is-live');
    setStep('watch');
    track('demo-start', null, true);
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data || e.data.source !== 'graphmind-tour') return;
    setStep(e.data.step);
  });
  if (demo) {
    if (canEmbed && !reduce) {
      // Load when the frame is about to be seen; most visitors see it in the first screen.
      if ('IntersectionObserver' in window) {
        var io = new IntersectionObserver(function (es) { es.forEach(function (x) { if (x.isIntersecting) { io.disconnect(); loadDemo(); } }); }, { rootMargin: '200px' });
        io.observe(demo);
      } else loadDemo();
    } else if (canEmbed) {
      loadBtn.hidden = false; // reduced motion: the clip stays still, the live demo is a click away
      loadBtn.addEventListener('click', loadDemo);
    }
  }

  /* ------------------------------------------------------------ clips -- */
  Array.prototype.forEach.call(document.querySelectorAll('video[data-clip]'), function (video) {
    var box = video.parentElement;
    var button = box.querySelector('.clip-toggle');
    var playable = video.canPlayType('video/webm') !== '';
    var userPaused = reduce;
    function sync() {
      if (!button) return;
      box.classList.toggle('is-paused', video.paused);
      button.textContent = video.paused ? '▶ Play' : '❚❚ Pause';
      button.setAttribute('aria-label', (video.paused ? 'Play' : 'Pause') + ' this clip');
    }
    if (!playable) { if (button) button.hidden = true; return; }
    if (button) {
      button.hidden = false;
      button.addEventListener('click', function () {
        if (video.paused) { userPaused = false; video.play().catch(function () {}); } else { userPaused = true; video.pause(); }
      });
    }
    video.addEventListener('play', sync);
    video.addEventListener('pause', sync);
    sync();
    if (!('IntersectionObserver' in window)) { if (!userPaused) video.play().catch(function () {}); return; }
    new IntersectionObserver(function (es) {
      es.forEach(function (x) {
        if (x.isIntersecting && !userPaused && !(demo && demo.classList.contains('is-live') && box.contains(demo.querySelector('iframe')))) video.play().catch(function () {});
        else if (!x.isIntersecting && !video.paused) video.pause();
      });
    }, { threshold: 0.35 }).observe(video);
  });

  /* ----------------------------------------------------------- motion -- */
  var top = document.getElementById('top');
  function onScroll() { top.classList.toggle('is-stuck', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  var canAnimate = !reduce && window.gsap && window.ScrollTrigger;
  if (!canAnimate) {
    html.classList.add('no-anim');
    Array.prototype.forEach.call(document.querySelectorAll('[data-stage]'), function (s) { s.classList.add('is-live'); });
  } else {
    var gsap = window.gsap;
    gsap.registerPlugin(window.ScrollTrigger);

    // The headline, word by word.
    var h1 = document.querySelector('[data-split]');
    if (h1) {
      var words = h1.textContent.trim().split(/\s+/);
      h1.textContent = '';
      words.forEach(function (w, i) {
        var span = document.createElement('span');
        span.className = 'w';
        span.textContent = w;
        h1.appendChild(span);
        if (i < words.length - 1) h1.appendChild(document.createTextNode(' '));
      });
    }
    var intro = gsap.timeline({ defaults: { ease: 'power3.out' } });
    intro
      .from('[data-split] .w', { y: 28, opacity: 0, duration: 0.7, stagger: 0.045 })
      .to('.hero-lede', { opacity: 1, duration: 0.6 }, '-=0.35')
      .to('.hero-actions', { opacity: 1, duration: 0.6 }, '-=0.45')
      .to('.hero-fine', { opacity: 1, duration: 0.5 }, '-=0.45')
      .fromTo('.demo', { opacity: 0, y: 26 }, { opacity: 1, y: 0, duration: 0.9 }, '-=0.4');

    // The spine draws as the story scrolls by.
    var wrap = document.querySelector('.story-wrap');
    gsap.fromTo('.spine-line', { strokeDashoffset: 1 }, {
      strokeDashoffset: 0,
      ease: 'none',
      scrollTrigger: { trigger: wrap, start: 'top 70%', end: 'bottom 60%', scrub: 0.6 },
    });

    // Each node comes alive as it enters, and its content settles in.
    document.querySelectorAll('[data-stage]').forEach(function (stage) {
      window.ScrollTrigger.create({
        trigger: stage,
        start: 'top 62%',
        onEnter: function () { stage.classList.add('is-live'); },
        onLeaveBack: function () { stage.classList.remove('is-live'); },
      });
      var copy = stage.querySelector('.stage-copy');
      var media = stage.querySelector('.shot, .nodes');
      gsap.fromTo(copy, { opacity: 0, y: 22 }, { opacity: 1, y: 0, duration: 0.7, ease: 'power3.out', scrollTrigger: { trigger: stage, start: 'top 75%' } });
      if (media) gsap.fromTo(media, { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.8, ease: 'power3.out', scrollTrigger: { trigger: stage, start: 'top 75%' } });
      var par = stage.querySelector('[data-parallax] .shot-media');
      if (par && window.innerWidth > 1020) {
        gsap.fromTo(par, { y: 24 }, { y: -24, ease: 'none', scrollTrigger: { trigger: stage, start: 'top bottom', end: 'bottom top', scrub: true } });
      }
    });
  }

  /* ---------------------------------------------------------- the rest -- */
  var copyBtn = document.getElementById('cmd-copy');
  var cmd = document.getElementById('cmd');
  if (copyBtn && cmd && navigator.clipboard) {
    copyBtn.addEventListener('click', function () {
      navigator.clipboard.writeText(cmd.textContent).then(function () {
        copyBtn.textContent = 'Copied';
        setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1600);
      }, function () {});
    });
  }

  var form = document.getElementById('waitlist-form');
  if (form) {
    var email = document.getElementById('email');
    var button = document.getElementById('waitlist-submit');
    var status = document.getElementById('form-status');
    var honeypot = document.getElementById('gm_extra');
    var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    var setStatus = function (m, kind) { status.textContent = m; status.className = 'form-status' + (kind ? ' is-' + kind : ''); };
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var value = (email.value || '').trim();
      if (honeypot && honeypot.value) { form.classList.add('is-done'); setStatus('You’re on the list.', 'ok'); return; }
      if (!EMAIL_RE.test(value) || value.length > 254) { setStatus('That email doesn’t look right.', 'error'); email.focus(); return; }
      var label = button.textContent;
      button.disabled = true;
      button.textContent = '…';
      setStatus('', null);
      fetch('/api/waitlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: value }) })
        .then(function (res) {
          if (res.ok) { form.classList.add('is-done'); setStatus('You’re on the list.', 'ok'); }
          else if (res.status === 400) setStatus('That email doesn’t look right.', 'error');
          else setStatus('Something went wrong — email hello@graphmind.ai.', 'error');
        })
        .catch(function () { setStatus('Network hiccup — try again.', 'error'); })
        .then(function () { button.disabled = false; button.textContent = label; });
    });
  }
})();
