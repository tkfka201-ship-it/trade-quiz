/* app.js — UI of the practice app. Classic script; uses window.TQCore. All progress stays in this browser (localStorage). */
(function () {
  'use strict';
  var C = window.TQCore;
  var params = new URLSearchParams(location.search);
  var SELFTEST = params.get('selftest') === '1';
  var PREFIX = SELFTEST ? 'tqT.' : 'tq1.';
  var BUILD = document.documentElement.getAttribute('data-build') || 'dev';
  var EXAM_AT = Date.parse('2026-11-28T09:30:00+09:00');
  var PRE_FROM = Date.parse('2026-11-24T00:00:00+09:00');
  var PRE_TO = Date.parse('2026-11-27T18:00:00+09:00');
  var NUM = ['①', '②', '③', '④'];
  var NEG_RE = /(옳지\s*않은|잘못된|틀린|아닌\s*것|해당하지\s*않는|적절하지\s*않은|거리가\s*먼|NOT|EXCEPT|incorrect|INCORRECT)/;
  var TAGS = [['k', '몰랐음'], ['h', '헷갈림'], ['s', '실수']];
  var FLAGS = [['a', '정답이 틀린 것 같음'], ['e', '해설이 이상함'], ['o', '보기가 애매함'], ['t', '오타']];

  var state = {
    index: null, pool: new Map(), order: [], sets: [], demoOnly: false, loadError: null, loaded: false,
    events: [], meta: null, settings: null, cur: null, filter: 'ALL', storageError: false,
    lockUntil: 0, lastCheck: 0, exportText: '', backupText: '', confirmReset: false, flagOpen: false,
    notes: null, noteSubj: null, noteFocus: null, noteFrom: null
  };

  // ---------- storage ----------
  var store = {
    get: function (k, def) {
      try { var v = localStorage.getItem(PREFIX + k); return v === null ? def : JSON.parse(v); } catch (e) { return def; }
    },
    set: function (k, v) {
      try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); return true; } catch (e) { state.storageError = true; return false; }
    },
    del: function (k) { try { localStorage.removeItem(PREFIX + k); } catch (e) { /* ignore */ } },
    keys: function () {
      var out = [];
      try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf(PREFIX) === 0) out.push(k.slice(PREFIX.length)); } } catch (e) { /* ignore */ }
      return out;
    }
  };

  function loadLocal() {
    state.events = store.get('log', []);
    if (!Array.isArray(state.events)) state.events = [];
    state.meta = store.get('meta', { v: 1, xs: 0, xn: 0, xh: [] });
    state.settings = store.get('set', { fs: 1, theme: 'auto' });
    state.filter = store.get('filter', 'ALL');
    state.cur = store.get('cur', null);
    applySettings();
  }
  function lastN() { return state.events.length ? state.events[state.events.length - 1].n : 0; }
  function appendEvent(e) {
    var fresh = store.get('log', state.events);   // re-read: another tab may have written
    if (Array.isArray(fresh) && fresh.length >= state.events.length) state.events = fresh;
    e.n = lastN() + 1;
    e.t = Date.now();
    state.events.push(e);
    if (!store.set('log', state.events)) toast('저장 공간 문제로 기록이 저장되지 않았습니다. 지금 내보내기를 해 두세요.', 6000);
    return e;
  }
  function patchEvent(n, patch) {
    for (var i = state.events.length - 1; i >= 0; i--) {
      if (state.events[i].n === n) { for (var k in patch) state.events[i][k] = patch[k]; break; }
    }
    store.set('log', state.events);
  }
  function saveCur() { store.set('cur', state.cur); }

  function applySettings() {
    var fs = [15, 17, 19, 21][state.settings.fs] || 17;
    document.documentElement.style.fontSize = fs + 'px';
    document.documentElement.setAttribute('data-theme', state.settings.theme || 'auto');
  }

  // ---------- data ----------
  function fetchJSON(url) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 8000) : null;
    return fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined }).then(function (r) {
      if (timer) clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function applyIndex(idx, sets) {
    var retired = new Set((idx.retired || []).map(function (x) { return x.id; }));
    var real = sets.filter(function (s) { return s.id !== 'demo'; });
    var use = real.length ? real : sets;
    var pool = new Map(), order = [];
    use.forEach(function (s) {
      (s.items || []).forEach(function (it) {
        if (retired.has(it.id) || pool.has(it.id)) return;
        pool.set(it.id, it);
        order.push(it.id);
      });
    });
    state.index = idx; state.sets = use; state.pool = pool; state.order = order;
    state.demoOnly = !real.length && sets.length > 0;
    state.loaded = true;
  }
  function loadData() {
    var cached = store.get('idx', null);
    if (cached && cached.idx) {
      var sets = [];
      var okAll = (cached.idx.sets || []).every(function (s) { var d = store.get('ds:' + s.file, null); if (d) sets.push(d); return !!d; });
      if (okAll) applyIndex(cached.idx, sets);
    }
    return fetchJSON('data/index.json').then(function (idx) {
      if (!idx || idx.schema !== 1) throw new Error('알 수 없는 데이터 형식');
      return Promise.all((idx.sets || []).map(function (s) {
        var have = store.get('ds:' + s.file, null);
        if (have && have.count === s.count) return have;
        return fetchJSON('data/' + s.file).then(function (d) {
          if (!d || !Array.isArray(d.items) || d.items.length !== s.count) throw new Error('세트 파일 이상: ' + s.file);
          store.set('ds:' + s.file, d);
          return d;
        });
      })).then(function (sets) {
        // prune cached sets that are no longer listed
        var keep = new Set((idx.sets || []).map(function (s) { return 'ds:' + s.file; }));
        store.keys().forEach(function (k) { if (k.indexOf('ds:') === 0 && !keep.has(k)) store.del(k); });
        store.set('idx', { idx: idx, at: Date.now() });
        applyIndex(idx, sets);
        state.loadError = null;
        state.lastCheck = Date.now();
      });
    }).catch(function (err) {
      state.loadError = String(err && err.message || err);
      if (!state.loaded) state.loaded = false;
    });
  }

  // 개념 노트 (data/notes.json): optional; a saved copy is used offline or when the fetch fails
  function loadNotes() {
    return fetchJSON('data/notes.json').then(function (d) {
      if (d && d.schema === 1 && Array.isArray(d.subjects) && d.subjects.length) { state.notes = d; store.set('notes', d); }
    }).catch(function () { /* keep the saved copy */ });
  }

  // ---------- helpers ----------
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  function markNeg(text) {
    var parts = String(text).split(NEG_RE);
    return parts.map(function (p, i) { return i % 2 === 1 ? h('mark', { class: 'neg' }, p) : p; });
  }
  var toastTimer = null;
  function toast(msg, ms) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2500);
  }
  function now() { return Date.now(); }
  function fold() { return C.fold(state.events, state.pool, now()); }
  function subjName(code) { return C.SUBJ[code] || code; }
  function fmtDate(ms) {
    var d = new Date(ms + 9 * 3600000);
    return (d.getUTCMonth() + 1) + '/' + d.getUTCDate();
  }

  // ---------- routing ----------
  function go(route) { if (location.hash !== route) location.hash = route; else render(); }
  window.addEventListener('hashchange', render);

  function render() {
    var app = document.getElementById('app');
    var route = location.hash || '#/';
    var view;
    if (!state.loaded) view = viewLoading();
    else if (route === '#/q') view = state.cur ? viewQuestion() : viewHome();
    else if (route === '#/review') view = viewReview();
    else if (route === '#/export') view = viewExport();
    else if (route === '#/settings') view = viewSettings();
    else if (route === '#/notes') view = viewNotes();
    else view = viewHome();
    app.replaceChildren(view);
    window.scrollTo(0, 0);
  }

  function viewLoading() {
    return h('div', { class: 'screen center' },
      h('p', null, state.loadError ? '문제를 불러오지 못했습니다.' : '불러오는 중…'),
      state.loadError ? h('p', { class: 'muted small' }, state.loadError) : null,
      state.loadError ? h('button', { class: 'btn', onclick: function () { loadData().then(render); } }, '다시 시도') : null);
  }

  // ---------- home ----------
  function viewHome() {
    var S = fold();
    var day = C.studyDay(now());
    var sum = C.summary(S, state.pool, filteredOrder(), day);
    var pred = C.predict(S);
    var t = now();
    var dday = Math.ceil((C.calDayKST(EXAM_AT) - C.calDayKST(t)));
    var wrap = h('div', { class: 'screen home' });

    add(wrap, h('header', { class: 'top' },
      h('div', { class: 'title' }, '국제무역사 1급 연습'),
      h('div', { class: 'dday' }, dday > 0 ? 'D-' + dday : (dday === 0 ? 'D-DAY' : '시험 끝'), h('small', null, ' 11/28(토) 09:30'))));

    if (/KAKAOTALK|NAVER\(inapp|Instagram|FBAN|FBAV/i.test(navigator.userAgent)) {
      add(wrap, h('div', { class: 'card warn' }, '카카오톡 같은 앱 안에서 열면 기록이 따로 저장됩니다. 오른쪽 아래(또는 위) 메뉴에서 "다른 브라우저로 열기"를 눌러 Safari나 Chrome에서 여세요.'));
    }
    if (state.storageError) add(wrap, h('div', { class: 'card bad' }, '이 브라우저에 기록을 저장하지 못하고 있습니다. 시크릿 모드라면 일반 창에서 여세요. 지금까지 기록은 내보내기로 옮겨 두세요.'));
    if (state.demoOnly) add(wrap, h('div', { class: 'card info' }, '지금은 화면 확인용 예시 문제만 있습니다. 검증을 마친 진짜 문제는 올라오는 대로 이 자리에 바뀌어 나옵니다.'));

    // pre-test banner
    if (t < PRE_TO) {
      var pre = S.pretest;
      var inWin = t >= PRE_FROM;
      add(wrap, h('div', { class: 'card ' + (pre ? 'ok' : (inWin ? 'warn' : 'info')) },
        h('div', { class: 'row' },
          h('div', null,
            h('b', null, pre ? '사전테스트 완료' : (inWin ? '사전테스트 기간입니다' : '사전테스트 예정')),
            h('div', { class: 'small' }, '11/24(화)~11/27(금) 18:00 · 본 시험과 같은 PC · 안 하면 응시 불가')),
          h('button', { class: 'chip' + (pre ? ' on' : ''), 'data-act': 'pretest', onclick: function () {
            appendEvent({ k: 'p', done: !pre }); render();
          } }, pre ? '완료함' : '완료했어요'))));
    }
    if (t < EXAM_AT && dday <= 1) add(wrap, h('div', { class: 'card warn' }, '시험 당일 09:00까지 접속해야 합니다(지각 시 응시 불가). 신분증·A4 빈 종이 1장·펜·일반 계산기·폰 거치대.'));

    // corrections / retired / notices
    pendingCards(S).forEach(function (c) { add(wrap, c); });
    ((state.index && state.index.notices) || []).forEach(function (n) {
      if (n.until && Date.parse(n.until) < t) return;
      add(wrap, h('div', { class: 'card info' }, h('b', null, n.title || '알림'), h('div', { class: 'small pre' }, n.body || '')));
    });

    // prediction
    var pc = h('div', { class: 'card' });
    add(pc, h('div', { class: 'row between' }, h('b', null, '예상 점수'),
      h('span', { class: 'small muted' }, pred.ready ? (pred.total + ' / 120 · 합격선 72') : '과목마다 10문제 이상 풀면 나옵니다')));
    var grid = h('div', { class: 'grid4' });
    C.SUBJ_CODES.forEach(function (s) {
      var p = pred.subjects[s];
      var label = p.est === null ? '-' : (p.est + '/30');
      var lv = p.level === 'fail' ? '과락 위험' : (p.level === 'risk' ? '주의' : (p.level === 'safe' ? '안전' : (p.n + '문제')));
      add(grid, h('div', { class: 'cell lv-' + p.level }, h('div', { class: 'small' }, subjName(s)), h('div', { class: 'big' }, label), h('div', { class: 'small' }, lv)));
    });
    add(pc, grid);
    add(pc, h('div', { class: 'small muted' }, '처음 푼 문제의 정답률(과목별 최근 40문제) × 30. 과락 기준 12/30.'));
    add(wrap, pc);

    add(wrap, h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('span', null, '오늘 ' + S.today.answered + '문제' + (S.today.answered ? ' · 정답률 ' + Math.round(100 * S.today.correct / S.today.answered) + '%' : '')),
        h('span', { class: 'small muted' }, '복습 대기 ' + sum.due + ' · 새 개념 ' + sum.newLeft))));

    // filter chips
    var chips = h('div', { class: 'chips' });
    [['ALL', '전체']].concat(C.SUBJ_CODES.map(function (s) { return [s, subjName(s).replace('무역', '')]; })).forEach(function (p) {
      add(chips, h('button', { class: 'chip' + (state.filter === p[0] ? ' on' : ''), onclick: function () { state.filter = p[0]; store.set('filter', p[0]); render(); } }, p[1]));
    });
    add(wrap, chips);

    var newEvents = state.events.filter(function (e) { return e.n > (state.meta.xn || 0); }).length;
    add(wrap, h('div', { class: 'btnrow' },
      h('button', { class: 'btn', onclick: function () { go('#/review'); } }, '오답 복습 ' + sum.weakItems),
      h('button', { class: 'btn', 'data-act': 'notes', onclick: function () { state.noteFrom = null; state.noteFocus = null; go('#/notes'); } }, '개념 노트'),
      h('button', { class: 'btn', onclick: function () { go('#/export'); } }, '내보내기 ' + newEvents)));

    add(wrap, h('footer', { class: 'foot small muted' },
      h('div', null, '데이터 ' + ((state.index && state.index.dataVersion) || '-') + ' · ' + state.pool.size + '문제 · 앱 ' + BUILD),
      state.loadError ? h('div', { class: 'bad-text' }, '최신 문제 확인 실패: ' + state.loadError + ' (저장된 문제로 계속합니다)') : null,
      h('div', { class: 'row' },
        h('button', { class: 'link', onclick: function () { toast('새 문제 확인 중…'); loadData().then(loadNotes).then(function () { render(); toast('확인했습니다'); }); } }, '새 문제 확인'),
        h('button', { class: 'link', onclick: function () { go('#/settings'); } }, '설정')),
      h('div', null, '홈 화면에 추가하면 앱처럼 쓸 수 있습니다. Safari: 공유 → 홈 화면에 추가 / Chrome: ⋮ → 홈 화면에 추가')));

    add(wrap, h('div', { class: 'bottombar' },
      h('button', { class: 'btn primary', 'data-act': 'start', onclick: function () { startPractice('p'); } }, state.cur && state.cur.phase === 'q' ? '이어서 풀기' : '연습 시작')));
    return wrap;
  }

  function filteredOrder() {
    if (state.filter === 'ALL') return state.order;
    return state.order.filter(function (id) { return id.charAt(0) === state.filter; });
  }

  function pendingCards(S) {
    var cards = [];
    var idx = state.index || {};
    (idx.corrections || []).forEach(function (c) {
      var it = state.pool.get(c.id);
      var key = c.id + '@' + c.rev;
      if (!S.items.has(c.id) || S.acks.has(key)) return;
      cards.push(h('div', { class: 'card bad' },
        h('b', null, '정정 안내 · ' + (it ? subjName(it.id.charAt(0)) + ' · ' + (it.topic || '') : c.id)),
        h('div', { class: 'pre' }, c.text || ''),
        h('button', { class: 'chip', onclick: function () { appendEvent({ k: 'c', id: c.id, rev: c.rev }); render(); } }, '확인했습니다')));
    });
    (idx.retired || []).forEach(function (c) {
      var key = c.id + '@0';
      var answered = state.events.some(function (e) { return e.k === 'a' && e.id === c.id; });
      if (!answered || S.acks.has(key) || !c.text) return;
      cards.push(h('div', { class: 'card bad' },
        h('b', null, '폐기된 문제 안내'),
        h('div', { class: 'pre' }, c.text),
        h('button', { class: 'chip', onclick: function () { appendEvent({ k: 'c', id: c.id, rev: 0 }); render(); } }, '확인했습니다')));
    });
    return cards;
  }

  // ---------- practice flow ----------
  function startPractice(mode) {
    if (state.cur && state.cur.phase === 'q' && state.cur.mode === mode && state.pool.has(state.cur.id)) { go('#/q'); return; }
    nextQuestion(mode);
  }
  function nextQuestion(mode) {
    var S = fold();
    var ctx = { pool: state.pool, order: state.order, S: S, filter: state.filter, day: C.studyDay(now()) };
    var pick = mode === 'r' ? C.pickReview(ctx) : C.pickNext(ctx);
    if (!pick) {
      state.cur = null; saveCur();
      toast(mode === 'r' ? '복습할 오답이 없습니다.' : '풀 문제가 없습니다. 과목 선택을 확인해 주세요.', 3000);
      go('#/');
      return;
    }
    var it = pick.item;
    var seed = it.id + '|' + now();
    state.cur = { id: it.id, rev: it.rev, perm: C.makePerm(it, C.rng(seed)), phase: 'q', sel: null, t0: now(), mode: mode, reason: pick.reason, n: null, ok: null, cf: null, more: false };
    saveCur();
    state.lockUntil = SELFTEST ? 0 : now() + 350;
    go('#/q');
  }

  function viewQuestion() {
    var cur = state.cur;
    var it = state.pool.get(cur.id);
    if (!it) { state.cur = null; saveCur(); return viewHome(); }
    var wrap = h('div', { class: 'screen q' });
    var reasonLabel = { retry: '다시 풀기', review: '복습', new: '새 문제', early: '복습', extra: '복습', wrongnote: '오답 복습' }[cur.reason] || '';
    add(wrap, h('header', { class: 'qtop' },
      h('button', { class: 'icon', 'aria-label': '홈으로', onclick: function () { go('#/'); } }, '×'),
      h('div', { class: 'small' }, subjName(it.id.charAt(0)) + (it.topic ? ' · ' + it.topic : '')),
      h('div', { class: 'small muted' }, '오늘 ' + fold().today.answered)));
    var tags = h('div', { class: 'tags' });
    if (reasonLabel) add(tags, h('span', { class: 'tag' }, reasonLabel));
    if (it.neg) add(tags, h('span', { class: 'tag red' }, '옳지 않은 것'));
    if (state.demoOnly) add(tags, h('span', { class: 'tag' }, '화면 확인용'));
    add(wrap, tags);
    add(wrap, h('div', { class: 'stem' }, markNeg(it.stem)));
    if (it.passage) add(wrap, h('div', { class: 'passage' + (it.passage.mono ? ' mono' : ''), lang: /[가-힣]/.test(it.passage.text) ? 'ko' : 'en' },
      it.passage.label ? h('div', { class: 'plabel' }, it.passage.label) : null, it.passage.text));
    if (it.table) add(wrap, renderTable(it.table));

    if (cur.phase === 'q') {
      var opts = h('div', { class: 'opts' });
      cur.perm.forEach(function (orig, j) {
        add(opts, h('button', { class: 'opt' + (cur.sel === j ? ' sel' : ''), 'data-opt': String(j), lang: /[가-힣]/.test(it.options[orig]) ? 'ko' : 'en', onclick: function () {
          if (now() < state.lockUntil) return;
          cur.sel = j; saveCur(); render();
        } }, h('span', { class: 'num' }, NUM[j]), h('span', { class: 'otext' }, it.options[orig])));
      });
      add(wrap, opts);
      add(wrap, h('div', { class: 'flagline' }, h('button', { class: 'link small', onclick: function () { openFlag(it); } }, '문제 이상함')));
      add(wrap, h('div', { class: 'bottombar' },
        cur.sel === null ? h('div', { class: 'hint' }, '보기를 고른 뒤, 확실한지 애매한지 눌러 채점하세요') :
          h('div', { class: 'btnrow' },
            h('button', { class: 'btn', 'data-act': 'unsure', onclick: function () { submit('u'); } }, '애매해요'),
            h('button', { class: 'btn primary', 'data-act': 'sure', onclick: function () { submit('s'); } }, '확실해요'))));
    } else {
      add(wrap, renderFeedback(it, cur));
    }
    if (state.flagOpen) add(wrap, flagSheet(it));
    return wrap;
  }

  function renderTable(tb) {
    var t = h('table', { class: 'tbl' });
    if (tb.head) add(t, h('thead', null, h('tr', null, tb.head.map(function (c) { return h('th', null, c); }))));
    add(t, h('tbody', null, (tb.rows || []).map(function (r) { return h('tr', null, r.map(function (c) { return h('td', null, c); })); })));
    return h('div', { class: 'tblwrap' }, t);
  }

  function submit(cf) {
    var cur = state.cur;
    if (!cur || cur.phase !== 'q' || cur.sel === null) return;
    if (now() < state.lockUntil) return;
    var it = state.pool.get(cur.id);
    var orig = cur.perm[cur.sel];
    var ok = orig === it.answer ? 1 : 0;
    var ms = Math.min(now() - cur.t0, 600000);
    var e = appendEvent({ k: 'a', id: it.id, rev: it.rev, c: orig, ok: ok, cf: cf, tag: '', ms: ms, m: cur.mode });
    cur.phase = 'fb'; cur.n = e.n; cur.ok = ok; cur.cf = cf; cur.tag = '';
    saveCur();
    state.lockUntil = SELFTEST ? 0 : now() + 500;
    render();
  }

  function renderFeedback(it, cur) {
    var box = h('div', { class: 'fb' });
    var mineOrig = cur.perm[cur.sel];
    var ansPos = cur.perm.indexOf(it.answer);
    var ok = cur.ok === 1;
    var full = !ok || cur.cf === 'u' || cur.more;
    add(box, h('div', { class: 'verdict ' + (ok ? 'good' : 'badv') },
      h('b', null, ok ? '정답' : '오답'),
      ok ? (cur.cf === 'u' ? h('span', { class: 'small' }, ' · 애매했으니 다시 나옵니다') : null)
        : h('span', null, '  내 답 ' + NUM[cur.sel] + '  →  정답 ' + NUM[ansPos])));
    add(box, h('div', { class: 'core' }, h('div', { class: 'label' }, '핵심 근거'), h('div', null, it.core),
      it.refs && it.refs.length ? h('div', { class: 'refs' }, it.refs.map(function (r) { return h('span', { class: 'ref' }, r.src + (r.art ? ' ' + r.art : '')); })) : null));
    var noteCard = state.notes && state.notes.map ? state.notes.map[it.id] : null;
    if (noteCard) add(box, h('button', { class: 'btn ghost', 'data-act': 'note', onclick: function () {
      state.noteSubj = noteCard.charAt(0); state.noteFocus = noteCard; state.noteFrom = 'q'; go('#/notes');
    } }, '이 문제의 개념 카드 보기'));

    function row(orig, kind) {
      var pos = cur.perm.indexOf(orig);
      var label = kind === 'mine' ? '내 답 · 틀림' : (kind === 'ans' ? '정답' : '');
      return h('div', { class: 'orow ' + kind },
        h('div', { class: 'ohead' }, h('span', { class: 'num' }, NUM[pos]), label ? h('span', { class: 'olabel' }, label) : null),
        h('div', { class: 'otext', lang: /[가-힣]/.test(it.options[orig]) ? 'ko' : 'en' }, it.options[orig]),
        h('div', { class: 'why' }, it.why[orig]));
    }
    var others = [0, 1, 2, 3].filter(function (o) { return o !== it.answer && (ok || o !== mineOrig); })
      .sort(function (a, b) { return cur.perm.indexOf(a) - cur.perm.indexOf(b); });
    if (full) {
      if (!ok) add(box, row(mineOrig, 'mine'));
      add(box, row(it.answer, 'ans'));
      var det = h('details', { class: 'more' }, h('summary', null, '다른 보기 해설'));
      others.forEach(function (o) { add(det, row(o, 'other')); });
      add(box, det);
      add(box, h('div', { class: 'tip' }, h('div', { class: 'label' }, '시험장 요령'), h('div', null, it.tip)));
    } else {
      var det2 = h('details', { class: 'more' }, h('summary', null, '해설 더 보기'));
      add(det2, row(it.answer, 'ans'));
      others.forEach(function (o) { add(det2, row(o, 'other')); });
      add(det2, h('div', { class: 'tip' }, h('div', { class: 'label' }, '시험장 요령'), h('div', null, it.tip)));
      add(box, det2);
    }
    add(box, h('div', { class: 'flagline small muted' },
      h('span', null, it.id + ' r' + it.rev + (it.asof ? ' · 기준일 ' + it.asof : '') + ' · '),
      h('button', { class: 'link small', onclick: function () { openFlag(it); } }, '문제 이상함')));

    var bar = h('div', { class: 'bottombar fbbar' });
    add(bar, h('div', { class: 'memo' }, h('span', { class: 'label' }, '암기'), ' ', it.memo));
    if (!ok) {
      var tg = h('div', { class: 'chips' });
      TAGS.forEach(function (t) {
        add(tg, h('button', { class: 'chip' + (cur.tag === t[0] ? ' on' : ''), 'data-tag': t[0], onclick: function () {
          cur.tag = cur.tag === t[0] ? '' : t[0];
          patchEvent(cur.n, { tag: cur.tag }); saveCur(); render();
        } }, t[1]));
      });
      add(bar, tg);
    }
    add(bar, h('button', { class: 'btn primary', 'data-act': 'next', onclick: function () {
      if (now() < state.lockUntil) return;
      nextQuestion(cur.mode);
    } }, '다음'));
    add(box, bar);
    return box;
  }

  // ---------- flag ----------
  function openFlag() { state.flagOpen = true; state.flagCode = null; render(); }
  function flagSheet(it) {
    var note = h('input', { class: 'input', maxlength: '80', placeholder: '짧은 메모(선택)' });
    var codes = h('div', { class: 'chips' });
    FLAGS.forEach(function (f) {
      add(codes, h('button', { class: 'chip' + (state.flagCode === f[0] ? ' on' : ''), onclick: function (ev) {
        state.flagCode = f[0];
        Array.prototype.forEach.call(codes.children, function (b) { b.classList.remove('on'); });
        ev.currentTarget.classList.add('on');
      } }, f[1]));
    });
    return h('div', { class: 'sheet' }, h('div', { class: 'sheetbox' },
      h('b', null, '이 문제가 이상한가요?'),
      h('div', { class: 'small muted' }, '밤에 내보내기로 전달되면 원문과 다시 대조해 고칩니다. 신고한 문제는 다시 나오지 않습니다.'),
      codes, note,
      h('div', { class: 'btnrow' },
        h('button', { class: 'btn', onclick: function () { state.flagOpen = false; render(); } }, '취소'),
        h('button', { class: 'btn primary', onclick: function () {
          if (!state.flagCode) { toast('이유를 하나 골라 주세요'); return; }
          appendEvent({ k: 'f', id: it.id, rev: it.rev, code: state.flagCode, note: (note.value || '').slice(0, 80) });
          state.flagOpen = false; toast('신고를 남겼습니다'); render();
        } }, '남기기'))));
  }

  // ---------- 개념 노트 ----------
  function viewNotes() {
    var N = state.notes;
    var wrap = h('div', { class: 'screen notes' });
    add(wrap, h('header', { class: 'qtop' },
      h('button', { class: 'icon', 'aria-label': '닫기', onclick: function () {
        var back = state.noteFrom === 'q' && state.cur ? '#/q' : '#/';
        state.noteFrom = null; state.noteFocus = null; go(back);
      } }, '×'),
      h('b', null, '개념 노트'), h('span', null, '')));
    if (!N) {
      add(wrap, h('p', { class: 'muted center' }, '개념 노트를 아직 받지 못했습니다. 인터넷이 될 때 홈의 "새 문제 확인"을 눌러 주세요.'));
      return wrap;
    }
    var codes = N.subjects.map(function (s) { return s.code; });
    var cur = codes.indexOf(state.noteSubj) >= 0 ? state.noteSubj : (codes.indexOf(state.filter) >= 0 ? state.filter : codes[0]);
    state.noteSubj = cur;
    var chips = h('div', { class: 'chips' });
    N.subjects.forEach(function (s) {
      add(chips, h('button', { class: 'chip' + (s.code === cur ? ' on' : ''), onclick: function () {
        state.noteSubj = s.code; state.noteFocus = null; render();
      } }, s.title.replace('무역', '')));
    });
    add(wrap, chips);
    var subj = N.subjects.filter(function (s) { return s.code === cur; })[0];
    // cards of the concepts I got wrong (or was unsure about) go first, with their one-line memos
    var S = fold(), wrongBy = {}, memos = {};
    S.items.forEach(function (st, id) {
      if (!st.weak || id.charAt(0) !== cur) return;
      var cid = N.map ? N.map[id] : null, it = state.pool.get(id);
      if (!cid || !it) return;
      wrongBy[cid] = (wrongBy[cid] || 0) + 1;
      memos[cid] = memos[cid] || [];
      if (it.memo && memos[cid].indexOf(it.memo) < 0) memos[cid].push(it.memo);
    });
    if (subj.focus && subj.focus.length) add(wrap, h('div', { class: 'card info small' }, subj.focus.map(function (f) { return h('div', null, f); })));
    var order = subj.cards.map(function (c, i) { return { c: c, i: i, w: wrongBy[c.id] || 0 }; });
    order.sort(function (a, b) { return (b.w - a.w) || (a.i - b.i); });
    var nWeak = order.filter(function (x) { return x.w; }).length;
    if (nWeak) add(wrap, h('div', { class: 'small muted' }, '내가 틀리거나 애매했던 개념 ' + nWeak + '개를 맨 위에 모았습니다.'));
    order.forEach(function (x) {
      var c = x.c;
      add(wrap, h('div', { class: 'card note' + (x.w ? ' weak' : '') + (state.noteFocus === c.id ? ' focus' : ''), id: 'note-' + c.id },
        h('div', { class: 'row between' }, h('b', null, c.title), x.w ? h('span', { class: 'badge' }, '틀림 ' + x.w) : null),
        h('ul', { class: 'nlines' }, c.lines.map(function (l) { return h('li', null, l); })),
        c.ex ? h('div', { class: 'nex small' }, c.ex) : null,
        memos[c.id] && memos[c.id].length ? h('div', { class: 'nmemo small' }, h('div', { class: 'label' }, '내 오답의 암기 한 줄'),
          memos[c.id].slice(0, 3).map(function (m) { return h('div', null, m); })) : null));
    });
    add(wrap, h('div', { class: 'small muted center' }, '근거: 공식 정답으로 확인된 시험 문장 · 검증한 해설 · 현행 법령 원문 (' + String(N.updated || '').slice(0, 10) + ')'));
    if (state.noteFocus) {
      var fid = 'note-' + state.noteFocus;
      setTimeout(function () { var el = document.getElementById(fid); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start' }); }, 0);
    }
    return wrap;
  }

  // ---------- review list ----------
  function viewReview() {
    var S = fold();
    var list = [];
    S.items.forEach(function (s, id) { var it = state.pool.get(id); if (it && s.weak) list.push({ it: it, s: s }); });
    list.sort(function (a, b) { return a.s.step - b.s.step; });
    var lastTag = {};
    state.events.forEach(function (e) { if (e.k === 'a') lastTag[e.id] = e.tag || (e.ok ? (e.cf === 'u' ? '애매' : '') : ''); });
    var wrap = h('div', { class: 'screen' });
    add(wrap, h('header', { class: 'qtop' }, h('button', { class: 'icon', onclick: function () { go('#/'); } }, '×'), h('b', null, '오답 복습'), h('span', { class: 'small muted' }, list.length + '문제')));
    if (!list.length) add(wrap, h('p', { class: 'muted center' }, '아직 틀리거나 애매했던 문제가 없습니다.'));
    var tagName = { k: '몰랐음', h: '헷갈림', s: '실수', 애매: '애매' };
    list.forEach(function (x) {
      add(wrap, h('div', { class: 'card small' },
        h('div', { class: 'muted' }, subjName(x.it.id.charAt(0)) + ' · ' + (x.it.topic || '') + (lastTag[x.it.id] ? ' · ' + (tagName[lastTag[x.it.id]] || '') : '')),
        h('div', null, String(x.it.stem).slice(0, 70) + (x.it.stem.length > 70 ? '…' : '')),
        h('div', { class: 'memoline' }, '암기: ' + x.it.memo)));
    });
    if (list.length) add(wrap, h('div', { class: 'bottombar' }, h('button', { class: 'btn primary', onclick: function () { nextQuestion('r'); } }, '오답 복습 시작')));
    return wrap;
  }

  // ---------- export / backup ----------
  function copyText(text, ta) {
    function fallback() {
      try { ta.removeAttribute('readonly'); ta.focus(); ta.select(); ta.setSelectionRange(0, text.length); var ok = document.execCommand('copy'); ta.setAttribute('readonly', ''); return ok; } catch (e) { return false; }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallback(); });
    }
    return Promise.resolve(fallback());
  }
  function viewExport() {
    var pending = state.events.filter(function (e) { return e.n > (state.meta.xn || 0); });
    var wrap = h('div', { class: 'screen' });
    add(wrap, h('header', { class: 'qtop' }, h('button', { class: 'icon', onclick: function () { go('#/'); } }, '×'), h('b', null, '내보내기'), h('span', null, '')));
    add(wrap, h('div', { class: 'card' },
      h('div', null, '지난 내보내기 이후 기록 ' + pending.length + '개'),
      h('div', { class: 'small muted' }, '만든 글을 복사해서 Claude 대화창에 붙여 넣으세요. 틀린 문제와 신고가 전달되어 다음 날 문제에 반영됩니다.')));
    var ta = h('textarea', { class: 'ta', readonly: true, rows: '6' });
    ta.value = state.exportText || '';
    add(wrap, h('div', { class: 'btnrow' },
      h('button', { class: 'btn primary', 'data-act': 'mkexport', onclick: function () {
        if (!pending.length) { toast('보낼 새 기록이 없습니다'); return; }
        var S = fold();
        state.exportRange = { from: pending[0].n, to: pending[pending.length - 1].n };
        state.exportText = C.encodeExport(pending, { x: (state.meta.xs || 0) + 1, from: state.exportRange.from, to: state.exportRange.to,
          data: (state.index && state.index.dataVersion) || '-', app: BUILD, pre: S.pretest });
        render();
      } }, '내보내기 글 만들기')));
    if (state.exportText) {
      add(wrap, ta);
      var markDone = function () {
        state.meta.xs = (state.meta.xs || 0) + 1;
        state.meta.xh = (state.meta.xh || []).concat([[state.meta.xs, state.exportRange.from, state.exportRange.to, now()]]).slice(-30);
        state.meta.xn = state.exportRange.to;
        store.set('meta', state.meta);
      };
      add(wrap, h('div', { class: 'btnrow' },
        h('button', { class: 'btn primary', 'data-act': 'copy', onclick: function () {
          copyText(state.exportText, ta).then(function (ok) {
            if (ok) { markDone(); toast('복사했습니다. Claude 대화창에 붙여 넣으세요.', 3500); state.exportText = ''; render(); }
            else toast('자동 복사가 안 됩니다. 글을 길게 눌러 전체 선택 → 복사한 뒤 "복사했어요"를 누르세요.', 6000);
          });
        } }, '복사'),
        h('button', { class: 'btn', onclick: function () { markDone(); state.exportText = ''; toast('표시했습니다'); render(); } }, '복사했어요')));
    }
    var hist = state.meta.xh || [];
    if (hist.length) {
      var last = hist[hist.length - 1];
      add(wrap, h('div', { class: 'card small' },
        h('div', null, '마지막 내보내기: #' + last[0] + ' (기록 ' + last[1] + '~' + last[2] + ')'),
        h('button', { class: 'link', onclick: function () {
          var evs = state.events.filter(function (e) { return e.n >= last[1] && e.n <= last[2]; });
          state.exportRange = { from: last[1], to: last[2] };
          state.exportText = C.encodeExport(evs, { x: last[0], from: last[1], to: last[2], data: (state.index && state.index.dataVersion) || '-', app: BUILD, pre: fold().pretest });
          render();
        } }, '그 글 다시 만들기')));
    }
    // backup
    var bta = h('textarea', { class: 'ta', rows: '4', placeholder: '백업 글을 붙여 넣고 복원을 누르세요' });
    add(wrap, h('div', { class: 'card' },
      h('b', null, '백업 · 복원'),
      h('div', { class: 'small muted' }, '휴대폰을 바꾸거나 기록이 지워졌을 때 쓰는 전체 사본입니다.'),
      h('div', { class: 'btnrow' },
        h('button', { class: 'btn', onclick: function () {
          var dump = { v: 1, at: now(), log: state.events, meta: state.meta, set: state.settings, filter: state.filter };
          bta.value = 'TQB1 ' + C.utf8ToB64url(JSON.stringify(dump));
          copyText(bta.value, bta).then(function (ok) { toast(ok ? '백업 글을 복사했습니다' : '글을 길게 눌러 복사하세요', 3000); });
        } }, '백업 글 만들기'),
        h('button', { class: 'btn', onclick: function () {
          var txt = (bta.value || '').trim();
          var m = txt.match(/TQB1\s+([A-Za-z0-9_-]+)/);
          if (!m) { toast('백업 글이 아닙니다'); return; }
          if (!state.confirmRestore) { state.confirmRestore = true; toast('한 번 더 누르면 지금 기록을 백업 내용으로 바꿉니다', 4000); return; }
          try {
            var d = JSON.parse(C.b64urlToUtf8(m[1]));
            store.set('bak.before', { log: state.events, meta: state.meta });
            store.set('log', d.log || []); store.set('meta', d.meta || { v: 1, xs: 0, xn: 0, xh: [] });
            if (d.set) store.set('set', d.set);
            state.confirmRestore = false; loadLocal(); toast('복원했습니다'); go('#/');
          } catch (e) { toast('복원 실패: ' + e.message, 4000); }
        } }, '복원')),
      bta));
    return wrap;
  }

  // ---------- settings ----------
  function viewSettings() {
    var wrap = h('div', { class: 'screen' });
    add(wrap, h('header', { class: 'qtop' }, h('button', { class: 'icon', onclick: function () { go('#/'); } }, '×'), h('b', null, '설정'), h('span', null, '')));
    var fsRow = h('div', { class: 'chips' });
    ['작게', '보통', '크게', '아주 크게'].forEach(function (lbl, i) {
      add(fsRow, h('button', { class: 'chip' + (state.settings.fs === i ? ' on' : ''), onclick: function () { state.settings.fs = i; store.set('set', state.settings); applySettings(); render(); } }, lbl));
    });
    var thRow = h('div', { class: 'chips' });
    [['auto', '자동'], ['light', '밝게'], ['dark', '어둡게']].forEach(function (p) {
      add(thRow, h('button', { class: 'chip' + (state.settings.theme === p[0] ? ' on' : ''), onclick: function () { state.settings.theme = p[0]; store.set('set', state.settings); applySettings(); render(); } }, p[1]));
    });
    add(wrap, h('div', { class: 'card' }, h('b', null, '글자 크기'), fsRow));
    add(wrap, h('div', { class: 'card' }, h('b', null, '화면'), thRow));
    add(wrap, h('div', { class: 'card' },
      h('b', null, '이 기기 기록 지우기'),
      h('div', { class: 'small muted' }, '풀이 기록을 모두 지웁니다. 먼저 내보내기와 백업을 해 두세요.'),
      h('button', { class: 'btn danger', onclick: function () {
        if (!state.confirmReset) { state.confirmReset = true; toast('한 번 더 누르면 지웁니다', 4000); return; }
        ['log', 'meta', 'cur'].forEach(store.del); state.confirmReset = false; loadLocal(); toast('지웠습니다'); go('#/');
      } }, '기록 지우기')));
    add(wrap, h('div', { class: 'small muted center' }, '앱 ' + BUILD + ' · 데이터 ' + ((state.index && state.index.dataVersion) || '-') +
      ' · 오프라인 ' + (navigator.serviceWorker && navigator.serviceWorker.controller ? '준비됨' : '준비 안 됨')));
    return wrap;
  }

  // ---------- self test (?selftest=1) ----------
  function selftest() {
    var out = [], fail = 0;
    function check(name, cond) { out.push((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail++; }
    try {
      var r = C.rng('x');
      var item = { id: 'R-9999', shuffle: true, answer: 2 };
      var perm = C.makePerm(item, r);
      check('perm is a permutation', perm.slice().sort().join() === '0,1,2,3');
      check('shownPos inverse', C.shownPos(perm, perm[1]) === 1);
      check('no shuffle keeps order', C.makePerm({ shuffle: false }, r).join() === '0,1,2,3');
      check('studyDay rolls at 04:00 KST', C.studyDay(Date.parse('2026-11-24T03:59:59+09:00')) + 1 === C.studyDay(Date.parse('2026-11-24T04:00:00+09:00')));
      check('crc32 known value', C.crc32('123456789') === 'CBF43926');
      var evs = [{ n: 1, t: 1, k: 'a', id: 'R-0001', rev: 1, c: 2, ok: 1, cf: 's', tag: '', ms: 1000, m: 'p' }, { n: 2, t: 2, k: 'f', id: 'R-0001', rev: 1, code: 'a', note: '한글 메모' }];
      var exp = C.encodeExport(evs, { x: 1, from: 1, to: 2, data: 'd', app: 'a', pre: 0 });
      var dec = C.decodeExport('붙여넣기 앞 글\n' + exp + '\n뒤 글');
      check('export round trip', dec.events.length === 2 && dec.events[1][6] === '한글 메모');
      var w = C.nextConcept(null, true, 5, 100);
      check('weak goes to box 1 after GAP', w.box === 1 && w.dueStep === 5 + C.GAP);
      check('clean new goes to box 2', C.nextConcept(null, false, 1, 100).box === 2);
    } catch (e) { check('core threw: ' + e.message, false); }
    // UI flow on the loaded pool
    try {
      ['log', 'meta', 'cur'].forEach(store.del); loadLocal();
      check('data loaded', state.pool.size >= 2);
      nextQuestion('p'); render();
      var cur = state.cur, it = state.pool.get(cur.id);
      var ansPos = cur.perm.indexOf(it.answer);
      document.querySelector('[data-opt="' + ansPos + '"]').click();
      document.querySelector('[data-act="sure"]').click();
      check('correct answer shows 정답', /정답/.test(document.querySelector('.verdict').textContent));
      var firstConcept = it.concept;
      document.querySelector('[data-act="next"]').click();
      var it2 = state.pool.get(state.cur.id);
      check('next question differs in concept (if possible)', it2.concept !== firstConcept || state.pool.size < 2);
      var wrongPos = (state.cur.perm.indexOf(it2.answer) + 1) % 4;
      document.querySelector('[data-opt="' + wrongPos + '"]').click();
      document.querySelector('[data-act="unsure"]').click();
      check('wrong answer shows 오답', /오답/.test(document.querySelector('.verdict').textContent));
      check('my wrong option row shown', !!document.querySelector('.orow.mine'));
      check('correct row shows the keyed option text', document.querySelector('.orow.ans .otext').textContent === it2.options[it2.answer]);
      document.querySelector('[data-tag="k"]').click();
      check('tag saved to event', state.events[state.events.length - 1].tag === 'k');
      var pending = state.events.filter(function (e) { return e.n > 0; });
      var ex = C.decodeExport(C.encodeExport(pending, { x: 1, from: 1, to: pending.length, data: 'd', app: BUILD, pre: 0 }));
      check('export has 2 answers', ex.events.filter(function (e) { return e[2] === 'a'; }).length === 2);
    } catch (e) { check('ui threw: ' + e.message, false); }
    ['log', 'meta', 'cur', 'set', 'filter'].forEach(store.del);
    var pre = document.createElement('pre');
    pre.id = 'selftest';
    pre.setAttribute('data-status', fail ? 'fail' : 'pass');
    pre.textContent = out.join('\n') + '\n' + (fail ? fail + ' FAILED' : 'ALL PASS');
    document.body.appendChild(pre);
    document.title = (fail ? 'SELFTEST FAIL ' : 'SELFTEST PASS ') + document.title;
  }

  // ---------- offline shell (sw.js, written by build.py app next to the built index.html) ----------
  function offlineShell(on) {
    if (SELFTEST || BUILD === 'dev' || !('serviceWorker' in navigator)) return;
    try {
      if (on) navigator.serviceWorker.register('sw.js').catch(function () { /* the app still works online */ });
      else {
        navigator.serviceWorker.getRegistrations().then(function (rs) { rs.forEach(function (r) { r.unregister(); }); }).catch(function () {});
        if (window.caches) caches.keys().then(function (ks) { ks.forEach(function (k) { if (k.indexOf('tq-shell-') === 0) caches.delete(k); }); }).catch(function () {});
      }
    } catch (e) { /* ignore */ }
  }

  // ---------- boot ----------
  function boot() {
    var reset = params.get('reset') === '1';
    if (reset) {
      store.keys().forEach(function (k) { if (k === 'idx' || k.indexOf('ds:') === 0) store.del(k); });
      history.replaceState(null, '', location.pathname);
    }
    offlineShell(!reset);   // ?reset=1 also drops the saved page; the next normal open saves it again
    loadLocal();
    state.notes = store.get('notes', null);
    if (state.cur && state.cur.phase === 'fb') { /* resume feedback screen */ }
    render();
    loadData().then(function () {
      if (state.cur && !state.pool.has(state.cur.id)) { state.cur = null; saveCur(); }
      render();
      if (SELFTEST) selftest();
      else loadNotes().then(function () { if (location.hash === '#/notes') render(); });
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && now() - state.lastCheck > 10 * 60000 && !(state.cur && state.cur.phase === 'q')) {
        loadData().then(render);
      }
    });
    window.addEventListener('storage', function (ev) { if (ev.key === PREFIX + 'log') { loadLocal(); render(); } });
  }
  boot();
})();
