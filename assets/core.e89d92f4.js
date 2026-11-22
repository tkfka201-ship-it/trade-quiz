/* core.js — pure logic for the practice app. No DOM, no storage, no Date.now(), no Math.random().
   Loaded as a classic script in the page (window.TQCore) and via require() in node tests. */
(function (root) {
  'use strict';

  var SUBJ = { R: '무역규범', P: '무역결제', C: '무역계약', E: '무역영어' };
  var SUBJ_CODES = ['R', 'P', 'C', 'E'];
  var GAP = 8;                 // a missed concept returns after this many other answers
  var MIX_NEW_EVERY = 3;       // when reviews are due, every 3rd question is a new one
  var DAY_START_H = 4;         // a study day rolls over at 04:00 KST
  var INTERVAL = { relearn: 1, shaky: 2, known: 3, mastered: 5 };   // days
  var TARGET_SHARE = { R: 0.35, P: 0.25, C: 0.20, E: 0.20 };        // share of new questions per subject
  var PASS = { perSubject: 12, total: 72, n: 30 };

  function studyDay(ms) { return Math.floor((ms + (9 - DAY_START_H) * 3600000) / 86400000); }
  function calDayKST(ms) { return Math.floor((ms + 9 * 3600000) / 86400000); }
  function subjOf(item) { return item && item.id ? item.id.charAt(0) : '?'; }

  // deterministic PRNG (mulberry32) seeded from a string
  function hashStr(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function rng(seed) {
    var a = (typeof seed === 'string' ? hashStr(seed) : seed) >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // perm[j] = original option index shown at screen position j
  function makePerm(item, r) {
    var p = [0, 1, 2, 3];
    if (item.shuffle !== true) return p;
    for (var i = 3; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var t = p[i]; p[i] = p[j]; p[j] = t; }
    return p;
  }
  function shownPos(perm, originalIndex) { return perm.indexOf(originalIndex); }

  function isWeak(e) { return e.ok === 0 || e.cf === 'u' || e.tag === 'm'; }

  function nextConcept(c, weak, step, day) {
    if (weak) return { box: 1, dueStep: step + GAP, dueDay: day, streak: 0 };
    if (!c) return { box: 2, dueStep: 0, dueDay: day + INTERVAL.known, streak: 1 };
    if (c.box === 1 && c.dueStep > 0) return { box: 1, dueStep: 0, dueDay: day + INTERVAL.relearn, streak: (c.streak || 0) + 1 };
    if (c.box === 1) return { box: 2, dueStep: 0, dueDay: day + INTERVAL.shaky, streak: (c.streak || 0) + 1 };
    return { box: 3, dueStep: 0, dueDay: day + INTERVAL.mastered, streak: (c.streak || 0) + 1 };
  }

  // events: array of objects {n,t,k,...}; pool: Map id -> item
  function fold(events, pool, now) {
    var S = {
      step: 0, lastConcept: null, lastId: null,
      items: new Map(), concepts: new Map(), flagged: new Set(), acks: new Set(), pretest: false,
      first: { R: [], P: [], C: [], E: [] },
      today: { answered: 0, correct: 0, newConcepts: 0, bySubj: { R: 0, P: 0, C: 0, E: 0 }, newBySubj: { R: 0, P: 0, C: 0, E: 0 } }
    };
    var today = studyDay(now);
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.k === 'f') { S.flagged.add(e.id + '@' + e.rev); continue; }
      if (e.k === 'p') { S.pretest = !!e.done; continue; }
      if (e.k === 'c') {
        S.acks.add(e.id + '@' + e.rev);
        var ci = pool.get(e.id);
        if (ci) S.concepts.set(ci.concept, { box: 1, dueStep: 0, dueDay: studyDay(e.t), streak: 0 });
        continue;
      }
      if (e.k !== 'a') continue;
      var it = pool.get(e.id);
      if (!it) continue;
      if (it.correction && (it.correction.kind === 'answer' || it.correction.kind === 'options') && e.rev < it.rev) continue;
      if (e.tag === 'm') { S.lastConcept = it.concept; S.lastId = it.id; }
      S.step += 1;
      var day = studyDay(e.t);
      var weak = isWeak(e);
      var prev = S.items.get(e.id);
      S.items.set(e.id, { n: (prev ? prev.n : 0) + 1, weak: weak, step: S.step, day: day, lastOk: e.ok, firstOk: prev ? prev.firstOk : e.ok });
      var c = S.concepts.get(it.concept);
      S.concepts.set(it.concept, nextConcept(c, weak, S.step, day));
      S.lastConcept = it.concept; S.lastId = it.id;
      var sj = subjOf(it);
      if (!prev && S.first[sj] && e.tag !== 'm') S.first[sj].push(e.ok ? 1 : 0);
      if (day === today) {
        S.today.answered++;
        if (e.ok) S.today.correct++;
        if (S.today.bySubj[sj] !== undefined) S.today.bySubj[sj]++;
        if (!c) { S.today.newConcepts++; if (S.today.newBySubj[sj] !== undefined) S.today.newBySubj[sj]++; }
      }
    }
    return S;
  }

  function recentAcc(arr, n) {
    var a = arr.slice(-n);
    if (!a.length) return null;
    var s = 0; for (var i = 0; i < a.length; i++) s += a[i];
    return s / a.length;
  }
  function riskFactor(S, sj) {
    var arr = S.first[sj] || [];
    if (arr.length < 10) return 1;
    var acc = recentAcc(arr, 40);
    if (acc < 0.45) return 1.6;
    if (acc < 0.55) return 1.3;
    return 1;
  }

  function cmpKeys(a, b) {
    for (var i = 0; i < a.length; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return 0;
  }
  function minBy(list, keyFn) {
    var best = null, bk = null;
    for (var i = 0; i < list.length; i++) {
      var k = keyFn(list[i]);
      if (best === null || cmpKeys(k, bk) < 0) { best = list[i]; bk = k; }
    }
    return best;
  }

  // ctx: {pool: Map, order: [ids in set order], S, filter: 'ALL'|'R'|'P'|'C'|'E', day, r}
  function pickNext(ctx) {
    var pool = ctx.pool, S = ctx.S, filter = ctx.filter || 'ALL', day = ctx.day;
    var byConcept = new Map(), firstPos = new Map(), pos = 0;
    for (var i = 0; i < ctx.order.length; i++) {
      var it = pool.get(ctx.order[i]);
      if (!it) continue;
      if (filter !== 'ALL' && subjOf(it) !== filter) continue;
      if (S.flagged.has(it.id + '@' + it.rev)) continue;
      var arr = byConcept.get(it.concept);
      if (!arr) { arr = []; byConcept.set(it.concept, arr); firstPos.set(it.concept, pos++); }
      arr.push(it);
    }
    if (!byConcept.size) return null;
    var keys = Array.from(byConcept.keys());
    var E = keys.filter(function (k) { return k !== S.lastConcept; });
    if (!E.length) E = keys;
    var st = function (k) { return S.concepts.get(k); };

    function pickItem(k) {
      var items = byConcept.get(k);
      var unseen = items.filter(function (x) { return !S.items.has(x.id); });
      if (unseen.length) return unseen[0];
      var missed = items.filter(function (x) { var s = S.items.get(x.id); return s && s.weak; });
      var cand = missed.length ? missed : items;
      return minBy(cand, function (x) { var s = S.items.get(x.id); return [s ? s.step : 0, x.id]; });
    }
    function choose(k, reason) { return k === null || k === undefined ? null : { item: pickItem(k), concept: k, reason: reason }; }

    var A = E.filter(function (k) { var c = st(k); return c && c.box >= 1 && c.dueStep > 0 && c.dueStep <= S.step; });
    if (A.length) return choose(minBy(A, function (k) { return [st(k).dueStep, firstPos.get(k)]; }), 'retry');
    var B = E.filter(function (k) { var c = st(k); return c && c.dueStep === 0 && c.dueDay <= day; });
    var C = E.filter(function (k) { return !st(k); });
    if (C.length && (!B.length || S.today.answered % MIX_NEW_EVERY === MIX_NEW_EVERY - 1)) {
      return choose(pickNewConcept(C, S, firstPos, byConcept), 'new');
    }
    if (B.length) return choose(minBy(B, function (k) { var c = st(k); return [c.box, c.dueDay, firstPos.get(k)]; }), 'review');
    var D = E.filter(function (k) { var c = st(k); return c && c.dueStep > S.step; });
    if (D.length) return choose(minBy(D, function (k) { return [st(k).dueStep, firstPos.get(k)]; }), 'early');
    return choose(minBy(E, function (k) {
      var c = st(k);
      var last = 0;
      byConcept.get(k).forEach(function (x) { var s = S.items.get(x.id); if (s && s.step > last) last = s.step; });
      return [c ? c.box : 0, last, firstPos.get(k)];
    }), 'extra');
  }

  function pickNewConcept(C, S, firstPos, byConcept) {
    var present = {};
    C.forEach(function (k) { present[subjOf(byConcept.get(k)[0])] = true; });
    var totalNew = 0;
    SUBJ_CODES.forEach(function (s) { totalNew += S.today.newBySubj[s] || 0; });
    var best = null, bestDef = -Infinity, shareSum = 0;
    SUBJ_CODES.forEach(function (s) { if (present[s]) shareSum += TARGET_SHARE[s] * riskFactor(S, s); });
    SUBJ_CODES.forEach(function (s) {
      if (!present[s]) return;
      var share = TARGET_SHARE[s] * riskFactor(S, s) / shareSum;
      var def = share * (totalNew + 1) - (S.today.newBySubj[s] || 0);
      if (def > bestDef + 1e-9) { bestDef = def; best = s; }
    });
    var inSubj = C.filter(function (k) { return subjOf(byConcept.get(k)[0]) === best; });
    return minBy(inSubj, function (k) { return [firstPos.get(k)]; });
  }

  // review mode: concepts whose last attempt was weak, oldest first
  function pickReview(ctx) {
    var pool = ctx.pool, S = ctx.S, filter = ctx.filter || 'ALL';
    var cand = [];
    S.items.forEach(function (s, id) {
      var it = pool.get(id);
      if (!it || !s.weak) return;
      if (filter !== 'ALL' && subjOf(it) !== filter) return;
      if (S.flagged.has(it.id + '@' + it.rev)) return;
      cand.push({ it: it, s: s });
    });
    if (!cand.length) return null;
    var notLast = cand.filter(function (x) { return x.it.concept !== S.lastConcept; });
    var list = notLast.length ? notLast : cand;
    var best = minBy(list, function (x) { return [x.s.step, x.it.id]; });
    return { item: best.it, concept: best.it.concept, reason: 'wrongnote' };
  }

  function summary(S, pool, order, day) {
    var concepts = new Set(), out = { newLeft: 0, due: 0, learning: 0, known: 0, weakItems: 0 };
    order.forEach(function (id) { var it = pool.get(id); if (it) concepts.add(it.concept); });
    concepts.forEach(function (k) {
      var c = S.concepts.get(k);
      if (!c) out.newLeft++;
      else {
        if ((c.dueStep > 0 && c.dueStep <= S.step) || (c.dueStep === 0 && c.dueDay <= day)) out.due++;
        if (c.box === 1) out.learning++; else out.known++;
      }
    });
    S.items.forEach(function (s, id) { if (s.weak && pool.has(id)) out.weakItems++; });
    return out;
  }

  function predict(S) {
    var res = { subjects: {}, total: null, ready: true, pass: null };
    var total = 0;
    SUBJ_CODES.forEach(function (s) {
      var arr = S.first[s] || [];
      var acc = recentAcc(arr, 40);
      var n = arr.length;
      var est = acc === null ? null : Math.round(acc * PASS.n);
      var level = est === null || n < 10 ? 'unknown' : (est < PASS.perSubject ? 'fail' : (est < 15 ? 'risk' : 'safe'));
      res.subjects[s] = { n: n, acc: acc, est: est, level: level };
      if (est === null || n < 10) res.ready = false; else total += est;
    });
    if (res.ready) {
      res.total = total;
      res.pass = total >= PASS.total && SUBJ_CODES.every(function (s) { return res.subjects[s].est >= PASS.perSubject; });
    }
    return res;
  }

  // ---- export codec ----
  var CRC_TABLE = (function () {
    var t = new Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(str) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < str.length; i++) c = CRC_TABLE[(c ^ str.charCodeAt(i)) & 0xFF] ^ (c >>> 8);
    return ((c ^ 0xFFFFFFFF) >>> 0).toString(16).toUpperCase().padStart(8, '0');
  }
  function utf8ToB64url(s) {
    var bytes;
    if (typeof TextEncoder !== 'undefined') bytes = new TextEncoder().encode(s);
    else bytes = Buffer.from(s, 'utf8');
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    var b64 = typeof btoa !== 'undefined' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlToUtf8(s) {
    var b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bin = typeof atob !== 'undefined' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    return Buffer.from(bytes).toString('utf8');
  }
  function evToRow(e) {
    if (e.k === 'a') return [e.n, e.t, 'a', e.id, e.rev, e.c, e.ok, e.cf || '', e.tag || '', e.ms || 0, e.m || 'p'];
    if (e.k === 'f') return [e.n, e.t, 'f', e.id, e.rev, e.code || 'x', e.note || ''];
    if (e.k === 'c') return [e.n, e.t, 'c', e.id, e.rev];
    if (e.k === 'p') return [e.n, e.t, 'p', e.done ? 1 : 0];
    return [e.n, e.t, e.k];
  }
  function encodeExport(events, header) {
    var payload = utf8ToB64url(JSON.stringify({ v: 1, ev: events.map(evToRow) }));
    var head = 'TQ1 x=' + header.x + ' n=' + header.from + '-' + header.to + ' data=' + header.data + ' app=' + header.app + ' pre=' + (header.pre ? 1 : 0);
    return head + '\n' + payload + '\n#' + events.length + ' ' + crc32(payload);
  }
  function decodeExport(text) {
    var i = text.indexOf('TQ1 ');
    if (i < 0) throw new Error('no header');
    var rest = text.slice(i);
    var lines = rest.split(/\r?\n/);
    var head = lines[0];
    var hashLine = -1;
    for (var j = 1; j < lines.length; j++) if (/^#\d+ [0-9A-F]{8}/.test(lines[j].trim())) { hashLine = j; break; }
    if (hashLine < 0) throw new Error('no footer');
    var payload = lines.slice(1, hashLine).join('').replace(/\s+/g, '');
    var m = lines[hashLine].trim().match(/^#(\d+) ([0-9A-F]{8})/);
    if (crc32(payload) !== m[2]) throw new Error('crc mismatch');
    var obj = JSON.parse(b64urlToUtf8(payload));
    if (obj.ev.length !== Number(m[1])) throw new Error('count mismatch');
    return { header: head, events: obj.ev };
  }

  var api = {
    SUBJ: SUBJ, SUBJ_CODES: SUBJ_CODES, GAP: GAP, PASS: PASS, INTERVAL: INTERVAL,
    studyDay: studyDay, calDayKST: calDayKST, subjOf: subjOf, hashStr: hashStr, rng: rng,
    makePerm: makePerm, shownPos: shownPos, isWeak: isWeak, nextConcept: nextConcept, fold: fold,
    pickNext: pickNext, pickReview: pickReview, summary: summary, predict: predict, recentAcc: recentAcc,
    crc32: crc32, utf8ToB64url: utf8ToB64url, b64urlToUtf8: b64urlToUtf8, encodeExport: encodeExport, decodeExport: decodeExport, evToRow: evToRow
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TQCore = api;
})(typeof window !== 'undefined' ? window : this);
