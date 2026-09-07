/* ============================================================================
 *  push_swap visualizer  —  app.js
 *  Vanilla JS. No build step. No dependencies beyond Tailwind + Lucide CDNs.
 *
 *  Sections
 *    1. constants & dom refs
 *    2. push_swap engine (pure)
 *    3. parsing / validation
 *    4. state manager
 *    5. renderer (stacks, dashboard, log, controls)
 *    6. playback
 *    7. event wiring
 *    8. boot
 * ==========================================================================*/
'use strict';

/* ============================================================================
 * 1. CONSTANTS & DOM REFS
 * ==========================================================================*/

const OPS = ['sa', 'sb', 'ss', 'pa', 'pb', 'ra', 'rb', 'rr', 'rra', 'rrb', 'rrr'];

/** inverse of each operation — used for stepping backwards */
const INVERSE = {
  sa: 'sa', sb: 'sb', ss: 'ss',
  pa: 'pb', pb: 'pa',
  ra: 'rra', rb: 'rrb', rr: 'rrr',
  rra: 'ra', rrb: 'rb', rrr: 'rr',
};

/** which cue class to flash for a given op family */
const CUE = {
  sa: 'hl-swap', sb: 'hl-swap', ss: 'hl-swap',
  pa: 'hl-push', pb: 'hl-push',
  ra: 'hl-rotate', rb: 'hl-rotate', rr: 'hl-rotate',
  rra: 'hl-rotate', rrb: 'hl-rotate', rrr: 'hl-rotate',
};

const INT_MIN = -2147483648;
const INT_MAX = 2147483647;

/** above this element count the per-move FLIP animation is skipped */
const FLIP_LIMIT = 160;

const $ = (id) => document.getElementById(id);

const dom = {
  // inputs
  inputA: $('inputA'),
  inputOps: $('inputOps'),
  inputError: $('inputError'),
  opsError: $('opsError'),
  countBadge: $('countBadge'),
  btnLoad: $('btnLoad'),
  btnReverse: $('btnReverse'),
  btnClearOps: $('btnClearOps'),

  // badges
  modeBadge: $('modeBadge'),
  modeBadgeText: $('modeBadgeText'),
  sortedBadge: $('sortedBadge'),

  // dashboard
  statStep: $('statStep'),
  statTotal: $('statTotal'),
  statLastOp: $('statLastOp'),
  statSizeA: $('statSizeA'),
  statSizeB: $('statSizeB'),

  // stacks
  trackA: $('trackA'),
  trackB: $('trackB'),
  topA: $('topA'),
  topB: $('topB'),
  lenA: $('lenA'),
  lenB: $('lenB'),

  // replay panel
  panelReplay: $('panelReplay'),
  btnReset: $('btnReset'),
  btnPrev: $('btnPrev'),
  btnPlay: $('btnPlay'),
  btnPlayText: $('btnPlayText'),
  btnNext: $('btnNext'),
  btnEnd: $('btnEnd'),
  speed: $('speed'),
  speedVal: $('speedVal'),
  scrub: $('scrub'),
  scrubNow: $('scrubNow'),
  scrubTotal: $('scrubTotal'),

  // manual panel
  panelManual: $('panelManual'),
  btnUndo: $('btnUndo'),
  btnResetManual: $('btnResetManual'),
  chordHint: $('chordHint'),

  // log
  log: $('log'),
  logCount: $('logCount'),
};

/* ============================================================================
 * 2. PUSH_SWAP ENGINE (pure functions over {a, b})
 *    Convention: index 0 === TOP of the stack, last index === BOTTOM.
 *    Every element is {id, v} so the renderer can track identity across moves.
 * ==========================================================================*/

const swap = (s) => {
  if (s.length < 2) return false;
  const t = s[0];
  s[0] = s[1];
  s[1] = t;
  return true;
};

const push = (from, to) => {
  if (!from.length) return false;
  to.unshift(from.shift());
  return true;
};

const rotate = (s) => {
  if (s.length < 2) return false;
  s.push(s.shift());
  return true;
};

const reverseRotate = (s) => {
  if (s.length < 2) return false;
  s.unshift(s.pop());
  return true;
};

/**
 * Apply one operation, mutating `st` in place.
 * Returns true when the stacks actually changed — a `pa` on an empty B is a
 * no-op in the real checker, and the undo path needs to know that.
 * @param {{a: Array, b: Array}} st
 * @param {string} op
 * @returns {boolean}
 */
function applyOp(st, op) {
  switch (op) {
    case 'sa': return swap(st.a);
    case 'sb': return swap(st.b);
    case 'ss': { const x = swap(st.a); const y = swap(st.b); return x || y; }

    case 'pa': return push(st.b, st.a);
    case 'pb': return push(st.a, st.b);

    case 'ra': return rotate(st.a);
    case 'rb': return rotate(st.b);
    case 'rr': { const x = rotate(st.a); const y = rotate(st.b); return x || y; }

    case 'rra': return reverseRotate(st.a);
    case 'rrb': return reverseRotate(st.b);
    case 'rrr': { const x = reverseRotate(st.a); const y = reverseRotate(st.b); return x || y; }

    default: return false; /* unknown op */
  }
}

/** true when A is ascending from top to bottom and B is empty */
function isSolved(st) {
  if (st.b.length) return false;
  if (st.a.length === 0) return false;
  for (let i = 1; i < st.a.length; i++) {
    if (st.a[i - 1].v > st.a[i].v) return false;
  }
  return true;
}

/* ============================================================================
 * 3. PARSING / VALIDATION
 * ==========================================================================*/

/**
 * Parse the numbers field.
 * @returns {{ok: boolean, values?: number[], error?: string}}
 */
function parseNumbers(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: 'no numbers given — type some values or use a preset.' };

  const tokens = text.split(/[\s,;]+/).filter(Boolean);
  const values = [];
  const seen = new Set();

  for (const tok of tokens) {
    if (!/^[+-]?\d+$/.test(tok)) {
      return { ok: false, error: `"${tok}" is not a valid integer.` };
    }
    const n = Number(tok);
    if (!Number.isSafeInteger(n) || n < INT_MIN || n > INT_MAX) {
      return { ok: false, error: `"${tok}" is out of the 32-bit integer range.` };
    }
    if (seen.has(n)) {
      return { ok: false, error: `duplicate value "${n}" — push_swap requires unique numbers.` };
    }
    seen.add(n);
    values.push(n);
  }

  if (values.length < 1) return { ok: false, error: 'no numbers found.' };
  return { ok: true, values };
}

/**
 * Parse the operations field.
 * @returns {{ok: boolean, ops: string[], error?: string}}
 */
function parseOps(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: true, ops: [] };

  const tokens = text.toLowerCase().split(/[\s,;]+/).filter(Boolean);
  const ops = [];
  const bad = [];

  for (const tok of tokens) {
    if (OPS.includes(tok)) ops.push(tok);
    else if (!bad.includes(tok)) bad.push(tok);
  }

  if (bad.length) {
    const list = bad.slice(0, 4).map((t) => `"${t}"`).join(', ');
    return {
      ok: false,
      ops,
      error: `unknown operation${bad.length > 1 ? 's' : ''}: ${list}${bad.length > 4 ? '…' : ''}` +
             ` — skipped, replaying the ${ops.length} valid one${ops.length === 1 ? '' : 's'}.`,
    };
  }
  return { ok: true, ops };
}

/* ============================================================================
 * 4. STATE MANAGER
 * ==========================================================================*/

const state = {
  /** @type {number[]} the loaded numbers, top-first */
  initial: [],
  /** @type {{a: Array<{id:number,v:number}>, b: Array<{id:number,v:number}>}} */
  st: { a: [], b: [] },
  /** rank lookup: value -> 0..n-1 (used for bar width normalization) */
  ranks: new Map(),

  /** 'replay' | 'manual' */
  mode: 'manual',
  /** @type {string[]} the script (replay) or the applied history (manual) */
  ops: [],
  /** @type {boolean[]} did ops[i] actually mutate the stacks? (undo needs this) */
  effects: [],
  /** how many ops of `ops` are currently applied */
  step: 0,

  playing: false,
  timer: null,
  speed: 250,

  /** ops highlighted on the last transition, for cue rendering */
  cue: { cls: null, ids: [], enter: null },

  /** keyboard chord buffer */
  chord: null,
  chordTimer: null,

  wasSolved: false,
};

let uid = 0;

/** forward declaration — defined in the renderer section */
let dropRowCache = () => {};

/** build a fresh {a,b} from state.initial */
function freshStacks() {
  uid = 0;
  return {
    a: state.initial.map((v) => ({ id: uid++, v })),
    b: [],
  };
}

/** recompute rank map for bar normalization */
function computeRanks(values) {
  const sorted = [...values].sort((x, y) => x - y);
  const m = new Map();
  sorted.forEach((v, i) => m.set(v, i));
  return m;
}

/** load numbers into the visualizer and reset everything */
function loadNumbers(values) {
  state.initial = values.slice();
  state.ranks = computeRanks(values);
  // element ids restart at 0 for a new data set, so every cached node is stale
  dropRowCache();
  state.st = freshStacks();
  state.step = 0;
  state.effects = [];
  state.cue = { cls: null, ids: [], enter: null };
  state.wasSolved = false;
  if (state.mode === 'manual') state.ops = [];
  stopPlayback();
  renderAll(true);
}

/** rebuild {a,b} from scratch then apply ops[0..n) */
function seekTo(n) {
  const target = Math.max(0, Math.min(n, state.ops.length));
  state.st = freshStacks();
  state.effects = [];
  for (let i = 0; i < target; i++) {
    state.effects[i] = applyOp(state.st, state.ops[i]);
  }
  state.step = target;
  state.cue = { cls: null, ids: [], enter: null };
}

/** ids of the elements touched by `op`, captured BEFORE applying it */
function cueTargets(op, st) {
  const ids = [];
  const take = (s, k) => { for (let i = 0; i < k && i < s.length; i++) ids.push(s[i].id); };

  switch (op) {
    case 'sa': take(st.a, 2); break;
    case 'sb': take(st.b, 2); break;
    case 'ss': take(st.a, 2); take(st.b, 2); break;
    case 'pa': take(st.b, 1); break;
    case 'pb': take(st.a, 1); break;
    case 'ra': take(st.a, 1); break;
    case 'rb': take(st.b, 1); break;
    case 'rr': take(st.a, 1); take(st.b, 1); break;
    case 'rra': if (st.a.length) ids.push(st.a[st.a.length - 1].id); break;
    case 'rrb': if (st.b.length) ids.push(st.b[st.b.length - 1].id); break;
    case 'rrr':
      if (st.a.length) ids.push(st.a[st.a.length - 1].id);
      if (st.b.length) ids.push(st.b[st.b.length - 1].id);
      break;
    default: break;
  }
  return ids;
}

const enterClassFor = (op) => {
  if (op === 'pa' || op === 'pb') return 'enter-push';
  if (op === 'ra' || op === 'rb' || op === 'rr') return 'enter-rotate-up';
  if (op === 'rra' || op === 'rrb' || op === 'rrr') return 'enter-rotate';
  return null;
};

/** apply one op forward with cues; returns whether it mutated anything */
function doForward(op) {
  const ids = cueTargets(op, state.st);
  const changed = applyOp(state.st, op);
  state.cue = { cls: CUE[op] || null, ids, enter: changed ? enterClassFor(op) : null };
  return changed;
}

/* ============================================================================
 * 5. RENDERER
 * ==========================================================================*/

/**
 * Cache of live bar rows keyed by element id. Nodes are never recreated while a
 * data set is loaded, so CSS transitions and FLIP measurements stay valid.
 * @type {Map<number, HTMLElement>}
 */
const rowCache = new Map();

/** rows currently carrying a cue class, so we clear O(cue) instead of O(n) */
let cuedRows = [];
/**
 * Rows currently marked `.is-top`. Tracked globally rather than per track:
 * a push moves a node between tracks, so per-track bookkeeping can strip or
 * duplicate the marker depending on which track renders first.
 * @type {HTMLElement[]}
 */
let toppedRows = [];

function barWidthPct(v) {
  const n = state.initial.length;
  if (n <= 1) return 100;
  const rank = state.ranks.get(v) ?? 0;
  // 8% floor so the smallest value stays visible
  return 8 + (rank / (n - 1)) * 92;
}

/**
 * Build the row for one element. Width depends only on the loaded data set,
 * so it is computed once here rather than on every render.
 */
function makeRow(item) {
  const row = document.createElement('div');
  row.className = 'bar-row';
  row.dataset.id = String(item.id);

  const fill = document.createElement('div');
  fill.className = 'bar-fill';

  const pct = barWidthPct(item.v);
  fill.style.width = pct + '%';
  row.style.setProperty('--w', pct + '%');

  const label = document.createElement('span');
  label.className = 'bar-label' + (pct < 14 ? ' outside' : '');
  label.textContent = String(item.v);

  fill.appendChild(label);
  row.appendChild(fill);
  rowCache.set(item.id, row);
  return row;
}

const getRow = (item) => rowCache.get(item.id) || makeRow(item);

/** last computed fit per track, so we skip the layout read when nothing changed */
const fitState = new WeakMap();

/** thinnest a bar may get before the track is allowed to scroll instead */
const MIN_ROW_H = 1;

/**
 * Size both tracks and their rows for the current data set.
 *
 * Small sets keep comfortable, labelled bars and the panel shrinks to fit them.
 * Once the set is taller than the available height, rows are thinned so the
 * whole stack stays visible at once — that is what makes sortedness readable at
 * a glance. Both tracks always get the same height, computed from the full
 * element count, so pushing between them never resizes the panels.
 */
function fitTracks() {
  const total = state.initial.length;
  if (!total) return;

  const track = dom.trackA;
  const cs = getComputedStyle(track);
  const chrome = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) +
                 parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);

  // the cap declared in CSS (viewport-relative), minus the box's own chrome
  const cap = parseFloat(cs.maxHeight);
  if (!Number.isFinite(cap)) return;
  const usable = cap - chrome;
  if (usable <= 0) return;

  const baseH = parseFloat(cs.getPropertyValue('--bar-h')) || 22;
  const baseGap = parseFloat(cs.getPropertyValue('--bar-gap')) || 3;
  const natural = total * baseH + (total - 1) * baseGap;

  const key = `${total}:${usable.toFixed(0)}:${baseH}`;
  if (fitState.get(dom.trackA) === key) return;
  fitState.set(dom.trackA, key);

  let dense = false;
  let rowH = baseH;
  let gap = baseGap;

  if (natural > usable) {
    dense = true;
    // round down to 1/2 px so accumulated rounding never overflows the track
    const solve = (g) => Math.max(MIN_ROW_H, Math.floor(((usable - g * (total - 1)) / total) * 2) / 2);
    gap = 1;
    rowH = solve(gap);
    // once rows are hairline thin a 1px gap would eat half the space, so drop it
    if (rowH < 3) {
      gap = 0;
      rowH = solve(gap);
    }
  }

  // 1px rows are the floor: a very large set on a short viewport cannot fit,
  // so let the track scroll rather than silently cut elements off
  const needed = rowH * total + gap * (total - 1);
  const scrolls = needed > usable + 0.5;
  const height = (dense ? usable : natural) + chrome;

  for (const t of [dom.trackA, dom.trackB]) {
    t.classList.toggle('dense', dense);
    t.classList.toggle('flush', dense && rowH < 3);
    t.classList.toggle('scrolls', scrolls);
    t.style.setProperty('--track-h', height.toFixed(1) + 'px');
    if (dense) {
      t.style.setProperty('--fit-h', rowH + 'px');
      t.style.setProperty('--fit-gap', gap + 'px');
      t.style.setProperty('--bar-min', Math.min(rowH, 3) + 'px');
    } else {
      t.style.removeProperty('--fit-h');
      t.style.removeProperty('--fit-gap');
      t.style.removeProperty('--bar-min');
    }
  }
}

/** re-fit after a resize (the cap is viewport-relative) */
function refit() {
  fitState.delete(dom.trackA);
  fitTracks();
}

/** wipe every cached node — called when a new data set is loaded */
dropRowCache = function () {
  rowCache.clear();
  cuedRows = [];
  toppedRows = [];
  // the fit depends on the element count, so a new data set must re-apply it
  fitState.delete(dom.trackA);
  dom.trackA.replaceChildren();
  dom.trackB.replaceChildren();
};

/**
 * Longest increasing subsequence of `seq`, returned as a Set of the values it
 * contains. Used to find the rows that can stay put during reordering, so a
 * rotate costs one DOM move instead of n.
 * @param {number[]} seq
 * @returns {Set<number>}
 */
function lisValues(seq) {
  const keep = new Set();
  if (!seq.length) return keep;

  const tails = [];     // tails[k] = index into seq of the smallest tail of an LIS of length k+1
  const prev = new Array(seq.length).fill(-1);

  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }

  let k = tails.length ? tails[tails.length - 1] : -1;
  while (k >= 0) {
    keep.add(seq[k]);
    k = prev[k];
  }
  return keep;
}

/**
 * Bring `track`'s children in line with `items`, moving as few nodes as possible.
 * @param {HTMLElement} track
 * @param {Array<{id:number,v:number}>} items
 * @returns {HTMLElement[]} rows newly inserted into this track
 */
function reconcileTrack(track, items) {
  const wantIndex = new Map();
  for (let i = 0; i < items.length; i++) wantIndex.set(items[i].id, i);

  // 1. drop children that no longer belong here (moved to the other stack)
  for (let child = track.firstElementChild; child; ) {
    const next = child.nextElementSibling;
    const id = child.dataset ? Number(child.dataset.id) : NaN;
    if (!wantIndex.has(id)) child.remove();
    child = next;
  }

  // 2. desired position of each surviving child, in current DOM order
  const order = [];
  for (let child = track.firstElementChild; child; child = child.nextElementSibling) {
    order.push(wantIndex.get(Number(child.dataset.id)));
  }

  // 3. rows on the longest increasing run keep their place; everything else moves
  const stay = order.length > 1 ? lisValues(order) : new Set(order);

  // 4. walk backwards so `anchor` is always the already-correct next sibling
  const fresh = [];
  let anchor = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const el = getRow(items[i]);
    if (el.parentElement === track && stay.has(i)) {
      anchor = el;
      continue;
    }
    if (el.parentElement !== track) fresh.push(el);
    track.insertBefore(el, anchor);
    anchor = el;
  }
  return fresh;
}

/**
 * Render one stack track: reconcile order, apply cues, then FLIP-animate.
 * @param {HTMLElement} track
 * @param {Array<{id:number,v:number}>} items
 * @param {'a'|'b'} which
 */
function renderTrack(track, items, which) {
  track.classList.toggle('track-b', which === 'b');

  if (!items.length) {
    if (!track.querySelector('.empty-note')) {
      const p = document.createElement('p');
      p.className = 'empty-note';
      p.textContent = 'empty';
      track.replaceChildren(p);
    }
    return;
  }

  const note = track.querySelector('.empty-note');
  if (note) note.remove();

  const doFlip = items.length <= FLIP_LIMIT;

  // --- FIRST: offsets before the reorder (only for rows already in this track)
  const before = doFlip ? new Map() : null;
  if (doFlip) {
    for (const item of items) {
      const el = rowCache.get(item.id);
      if (el && el.parentElement === track) before.set(item.id, el.offsetTop);
    }
  }

  const fresh = reconcileTrack(track, items);

  // --- entry animation for rows that just arrived
  if (state.cue.enter) {
    for (const el of fresh) {
      el.classList.remove('enter-push', 'enter-rotate', 'enter-rotate-up');
      void el.offsetWidth;
      el.classList.add(state.cue.enter);
    }
  }

  // --- LAST + INVERT + PLAY
  if (doFlip && before.size) {
    const moved = [];
    for (const item of items) {
      const prev = before.get(item.id);
      if (prev === undefined) continue;
      const el = rowCache.get(item.id);
      if (!el) continue;
      const delta = prev - el.offsetTop;
      if (!delta) continue;
      el.style.transition = 'none';
      el.style.transform = `translateY(${delta}px)`;
      moved.push(el);
    }
    if (moved.length) {
      void track.offsetHeight; // flush the inverted positions
      for (const el of moved) {
        el.style.transition = '';
        el.style.transform = '';
      }
    }
  }
}

function renderStacks() {
  // clear the previous step's highlight cues (small, bounded set)
  for (const el of cuedRows) {
    el.classList.remove('hl-swap', 'hl-push', 'hl-rotate');
  }
  cuedRows = [];

  fitTracks();

  // clear the previous top markers before either track is reordered
  for (const el of toppedRows) el.classList.remove('is-top');
  toppedRows = [];

  renderTrack(dom.trackA, state.st.a, 'a');
  renderTrack(dom.trackB, state.st.b, 'b');

  // mark the new tops once both tracks are settled
  for (const s of [state.st.a, state.st.b]) {
    if (!s.length) continue;
    const head = rowCache.get(s[0].id);
    if (head) {
      head.classList.add('is-top');
      toppedRows.push(head);
    }
  }

  if (state.cue.cls) {
    for (const id of state.cue.ids) {
      const el = rowCache.get(id);
      if (!el || !el.parentElement) continue;
      el.classList.add(state.cue.cls);
      cuedRows.push(el);
    }
  }

  dom.lenA.textContent = String(state.st.a.length);
  dom.lenB.textContent = String(state.st.b.length);
  dom.topA.textContent = state.st.a.length ? String(state.st.a[0].v) : '—';
  dom.topB.textContent = state.st.b.length ? String(state.st.b[0].v) : '—';
}

function renderDashboard() {
  dom.statStep.textContent = String(state.step);
  dom.statTotal.textContent = String(state.ops.length);
  dom.statSizeA.textContent = String(state.st.a.length);
  dom.statSizeB.textContent = String(state.st.b.length);

  const last = state.step > 0 ? state.ops[state.step - 1] : null;
  dom.statLastOp.textContent = last || '—';

  dom.countBadge.textContent = `${state.initial.length} value${state.initial.length === 1 ? '' : 's'}`;

  // sorted badge
  const solved = isSolved(state.st);
  dom.sortedBadge.className = solved
    ? 'inline-flex items-center gap-1.5 rounded-md bg-emerald-500/15 px-2.5 py-1 font-semibold text-emerald-300 ring-1 ring-emerald-500/30'
    : 'inline-flex items-center gap-1.5 rounded-md bg-slate-500/15 px-2.5 py-1 font-semibold text-slate-400 ring-1 ring-slate-500/30';
  dom.sortedBadge.innerHTML =
    `<i data-lucide="${solved ? 'check-circle-2' : 'minus'}" class="h-3.5 w-3.5"></i>` +
    `<span>${solved ? 'sorted · b empty' : 'not sorted'}</span>`;

  if (solved && !state.wasSolved) {
    const panel = dom.trackA.parentElement;
    panel.classList.remove('sorted-pulse');
    void panel.offsetWidth;
    panel.classList.add('sorted-pulse');
  }
  state.wasSolved = solved;

  refreshIcons();
}

/* ---------- log: built once per script, then only classes are patched ---------- */

/** @type {HTMLElement[]} live row nodes, index-aligned with the rendered ops */
let logRows = [];
/** identity of the currently built list, so we know when a full rebuild is due */
let logKey = '';
/** index of the row currently wearing .active (-1 = none) */
let logActive = -1;

function makeLogRow(op, i) {
  const row = document.createElement('div');
  row.className = 'log-row ' + (i < state.step ? 'done' : 'pending');
  row.dataset.index = String(i);
  row.setAttribute('role', 'button');
  row.tabIndex = -1;
  row.title = `jump to step ${i + 1}`;

  const idx = document.createElement('span');
  idx.className = 'log-idx';
  idx.textContent = String(i + 1);

  const name = document.createElement('span');
  name.className = 'log-op';
  name.textContent = op;

  row.append(idx, name);
  return row;
}

function renderLog() {
  const replay = state.mode === 'replay';
  const shownCount = replay ? state.ops.length : state.step;

  dom.logCount.textContent = String(shownCount);

  if (!shownCount) {
    if (logKey !== 'empty:' + state.mode) {
      logKey = 'empty:' + state.mode;
      logRows = [];
      logActive = -1;
      const p = document.createElement('p');
      p.className = 'px-2 py-6 text-center text-slate-600';
      p.textContent = replay ? 'script is empty' : 'no operations yet';
      dom.log.replaceChildren(p);
    }
    return;
  }

  // rebuild only when the visible op list actually changed
  const key = state.mode + ':' + shownCount + ':' + (state.ops[0] || '') + ':' +
              (state.ops[shownCount - 1] || '') + ':' + state.ops.length;

  if (key !== logKey) {
    logKey = key;
    logActive = -1;

    if (state.mode === 'manual' && logRows.length && shownCount > logRows.length) {
      // manual mode only ever appends one row at a time — keep the existing nodes
      const frag = document.createDocumentFragment();
      for (let i = logRows.length; i < shownCount; i++) {
        const row = makeLogRow(state.ops[i], i);
        logRows.push(row);
        frag.appendChild(row);
      }
      dom.log.appendChild(frag);
    } else {
      const frag = document.createDocumentFragment();
      logRows = [];
      for (let i = 0; i < shownCount; i++) {
        const row = makeLogRow(state.ops[i], i);
        logRows.push(row);
        frag.appendChild(row);
      }
      dom.log.replaceChildren(frag);
    }
  } else if (logRows.length > shownCount) {
    // manual undo: drop the trailing nodes
    for (let i = shownCount; i < logRows.length; i++) logRows[i].remove();
    logRows.length = shownCount;
  }

  // patch state classes: only the boundary rows change between steps
  const nextActive = state.step - 1;
  if (nextActive !== logActive) {
    if (logActive >= 0 && logActive < logRows.length) {
      logRows[logActive].classList.remove('active');
      logRows[logActive].classList.add(logActive < state.step ? 'done' : 'pending');
    }
    // rows between the old and new position flip done/pending
    const lo = Math.min(logActive, nextActive);
    const hi = Math.max(logActive, nextActive);
    for (let i = Math.max(0, lo); i <= hi && i < logRows.length; i++) {
      const row = logRows[i];
      row.classList.remove('active');
      row.classList.toggle('done', i < state.step);
      row.classList.toggle('pending', i >= state.step);
    }
    if (nextActive >= 0 && nextActive < logRows.length) {
      const row = logRows[nextActive];
      row.classList.remove('done', 'pending');
      row.classList.add('active');
    }
    logActive = nextActive;
  }

  scrollLogToActive();
}

/**
 * Keep the active log row visible inside its own scroll container.
 * Done with offset math rather than scrollIntoView so the page itself never jumps.
 */
function scrollLogToActive() {
  const active = logActive >= 0 ? logRows[logActive] : null;
  if (!active) { dom.log.scrollTop = 0; return; }

  const box = dom.log;
  const top = active.offsetTop;
  const bottom = top + active.offsetHeight;

  if (top < box.scrollTop) {
    box.scrollTop = top;
  } else if (bottom > box.scrollTop + box.clientHeight) {
    box.scrollTop = bottom - box.clientHeight;
  }
}

function renderControls() {
  const replay = state.mode === 'replay';

  dom.panelReplay.classList.toggle('hidden', !replay);
  dom.panelManual.classList.toggle('hidden', replay);

  dom.modeBadge.className = replay
    ? 'inline-flex items-center gap-1.5 rounded-md bg-emerald-500/15 px-2.5 py-1 font-semibold text-emerald-300 ring-1 ring-emerald-500/30'
    : 'inline-flex items-center gap-1.5 rounded-md bg-sky-500/15 px-2.5 py-1 font-semibold text-sky-300 ring-1 ring-sky-500/30';
  dom.modeBadge.innerHTML =
    `<i data-lucide="${replay ? 'film' : 'gamepad-2'}" class="h-3.5 w-3.5"></i>` +
    `<span>${replay ? 'replay mode' : 'manual mode'}</span>`;

  if (replay) {
    const atStart = state.step === 0;
    const atEnd = state.step >= state.ops.length;

    dom.btnReset.disabled = atStart;
    dom.btnPrev.disabled = atStart;
    dom.btnNext.disabled = atEnd;
    dom.btnEnd.disabled = atEnd;
    dom.btnPlay.disabled = state.ops.length === 0;

    dom.btnPlayText.textContent = state.playing ? 'pause' : atEnd ? 'replay' : 'play';
    setIcon(dom.btnPlay, state.playing ? 'pause' : atEnd ? 'rotate-ccw' : 'play');

    dom.scrub.max = String(state.ops.length);
    dom.scrub.value = String(state.step);
    dom.scrub.disabled = state.ops.length === 0;
    dom.scrubNow.textContent = String(state.step);
    dom.scrubTotal.textContent = String(state.ops.length);
    dom.speedVal.textContent = `${state.speed} ms`;
  } else {
    dom.btnUndo.disabled = state.step === 0;
    dom.btnResetManual.disabled = state.step === 0;
  }

  refreshIcons();
}

let renderQueued = false;
function renderAll(force) {
  renderStacks();
  renderDashboard();
  renderControls();
  renderLog();
  if (force) refreshIcons();
}

/**
 * Swap the leading icon of a button.
 * Lucide replaces `<i data-lucide>` with an `<svg>`, so mutating the existing
 * node's attribute does nothing on later renders — we insert a fresh `<i>`.
 */
function setIcon(container, name, cls = 'h-4 w-4') {
  const current = container.firstElementChild;
  if (current && current.dataset && current.dataset.lucide === name) return;
  const i = document.createElement('i');
  i.setAttribute('data-lucide', name);
  i.className = cls;
  if (current) container.replaceChild(i, current);
  else container.prepend(i);
}

function refreshIcons() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (window.lucide?.createIcons) window.lucide.createIcons();
  });
}

/* ---------- inline error helpers ---------- */
function showError(el, msg) {
  if (!msg) {
    el.classList.add('hidden');
    el.classList.remove('flex');
    el.textContent = '';
    return;
  }
  el.textContent = msg;
  el.classList.remove('hidden');
  el.classList.add('flex');
}

/* ============================================================================
 * 6. PLAYBACK
 * ==========================================================================*/

function stepForward() {
  if (state.step >= state.ops.length) return false;
  const op = state.ops[state.step];
  state.effects[state.step] = doForward(op);
  state.step++;
  renderAll();
  return true;
}

function stepBack() {
  if (state.step === 0) return false;
  const i = state.step - 1;
  const op = state.ops[i];
  // only invert ops that actually mutated the stacks (e.g. `pa` on an empty B
  // is a no-op forward, so its inverse `pb` must not fire on the way back)
  if (state.effects[i] !== false) applyOp(state.st, INVERSE[op]);
  state.step--;
  // cue the elements that just moved back
  state.cue = { cls: CUE[op] || null, ids: cueTargets(op, state.st), enter: null };
  renderAll();
  return true;
}

function jumpToStart() {
  stopPlayback();
  seekTo(0);
  renderAll();
}

function jumpToEnd() {
  stopPlayback();
  seekTo(state.ops.length);
  renderAll();
}

function jumpTo(n) {
  seekTo(n);
  renderAll();
}

function startPlayback() {
  if (state.mode !== 'replay' || !state.ops.length) return;
  if (state.step >= state.ops.length) seekTo(0);
  state.playing = true;
  renderControls();
  tick();
}

function tick() {
  clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    if (!state.playing) return;
    if (!stepForward()) { stopPlayback(); return; }
    tick();
  }, state.speed);
}

function stopPlayback() {
  state.playing = false;
  clearTimeout(state.timer);
  state.timer = null;
  renderControls();
}

function togglePlayback() {
  if (state.playing) stopPlayback();
  else startPlayback();
}

/* ============================================================================
 * 7. EVENTS
 * ==========================================================================*/

/* ---------- numbers: load & presets ---------- */

function applyNumbersField() {
  const res = parseNumbers(dom.inputA.value);
  if (!res.ok) {
    showError(dom.inputError, res.error);
    return false;
  }
  showError(dom.inputError, null);
  loadNumbers(res.values);
  return true;
}

function randomSet(n) {
  const pool = [];
  for (let i = 1; i <= n; i++) pool.push(i);
  // Fisher-Yates
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  // shift part of the range negative so negatives are exercised too
  const offset = Math.floor(n / 2);
  return pool.map((v) => v - offset);
}

dom.btnLoad.addEventListener('click', () => {
  syncOpsField();
  applyNumbersField();
});

document.querySelectorAll('[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const n = Number(btn.dataset.preset);
    dom.inputA.value = randomSet(n).join(' ');
    showError(dom.inputError, null);
    applyNumbersField();
  });
});

dom.btnReverse.addEventListener('click', () => {
  const cur = parseNumbers(dom.inputA.value);
  const n = cur.ok && cur.values.length > 1 ? cur.values.length : 20;
  const offset = Math.floor(n / 2);
  const desc = [];
  for (let i = n; i >= 1; i--) desc.push(i - offset);
  dom.inputA.value = desc.join(' ');
  showError(dom.inputError, null);
  applyNumbersField();
});

dom.inputA.addEventListener('input', () => {
  const res = parseNumbers(dom.inputA.value);
  showError(dom.inputError, res.ok ? null : res.error);
});

dom.inputA.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    syncOpsField();
    applyNumbersField();
  }
});

/* ---------- ops script: mode switching ---------- */

function syncOpsField() {
  const res = parseOps(dom.inputOps.value);
  showError(dom.opsError, res.ok ? null : res.error);

  const nextMode = res.ops.length ? 'replay' : 'manual';
  const changed = nextMode !== state.mode || res.ops.join(' ') !== state.ops.join(' ');

  if (!changed) return;

  stopPlayback();
  state.mode = nextMode;
  state.ops = nextMode === 'replay' ? res.ops : [];
  seekTo(0);
  state.wasSolved = false;
  renderAll();
}

let opsDebounce = null;
dom.inputOps.addEventListener('input', () => {
  clearTimeout(opsDebounce);
  opsDebounce = setTimeout(syncOpsField, 220);
});

dom.btnClearOps.addEventListener('click', () => {
  dom.inputOps.value = '';
  syncOpsField();
});

/* ---------- replay controls ---------- */

dom.btnReset.addEventListener('click', jumpToStart);
dom.btnEnd.addEventListener('click', jumpToEnd);
dom.btnPlay.addEventListener('click', togglePlayback);

dom.btnPrev.addEventListener('click', () => { stopPlayback(); stepBack(); });
dom.btnNext.addEventListener('click', () => { stopPlayback(); stepForward(); });

dom.speed.addEventListener('input', () => {
  state.speed = Number(dom.speed.value);
  dom.speedVal.textContent = `${state.speed} ms`;
  if (state.playing) tick();
});

dom.scrub.addEventListener('input', () => {
  // read the requested step BEFORE stopPlayback(), which re-syncs the slider
  // from state and would otherwise clobber the value we just received
  const target = Number(dom.scrub.value);
  stopPlayback();
  jumpTo(target);
});

dom.log.addEventListener('click', (e) => {
  const row = e.target.closest('.log-row');
  if (!row || state.mode !== 'replay') return;
  stopPlayback();
  jumpTo(Number(row.dataset.index) + 1);
});

/* ---------- manual keypad ---------- */

function manualApply(op) {
  if (state.mode !== 'manual') return;
  if (!state.initial.length) {
    showError(dom.inputError, 'load some numbers first.');
    return;
  }
  // manual history is linear: truncate any redo tail (there is none by design)
  state.ops.length = state.step;
  state.effects.length = state.step;
  const changed = doForward(op);
  state.ops.push(op);
  state.effects.push(changed);
  state.step++;
  renderAll();
}

function flashOpButton(op) {
  const btn = document.querySelector(`.btn-op[data-op="${op}"]`);
  if (!btn) return;
  btn.classList.remove('fired');
  void btn.offsetWidth;
  btn.classList.add('fired');
  setTimeout(() => btn.classList.remove('fired'), 340);
}

document.querySelectorAll('.btn-op').forEach((btn) => {
  btn.addEventListener('click', () => {
    const op = btn.dataset.op;
    flashOpButton(op);
    manualApply(op);
  });
});

dom.btnUndo.addEventListener('click', () => {
  if (state.step === 0) return;
  stepBack();
  // manual undo discards the op entirely
  state.ops.length = state.step;
  state.effects.length = state.step;
  renderAll();
});

dom.btnResetManual.addEventListener('click', () => {
  state.ops = [];
  seekTo(0);
  state.wasSolved = false;
  renderAll();
});

/* ---------- keyboard ---------- */

const CHORD_GROUPS = { s: 'swap', p: 'push', r: 'rotate', v: 'reverse rotate' };

const CHORD_MAP = {
  s: { a: 'sa', b: 'sb', s: 'ss' },
  p: { a: 'pa', b: 'pb' },
  r: { a: 'ra', b: 'rb', r: 'rr' },
  v: { a: 'rra', b: 'rrb', r: 'rrr', v: 'rrr' },
};

function clearChord() {
  clearTimeout(state.chordTimer);
  state.chord = null;
  document.querySelectorAll('.btn-op.armed').forEach((b) => b.classList.remove('armed'));
  dom.chordHint.innerHTML =
    'press a group key then a target: <span class="kbd">s</span>+<span class="kbd">a</span> = sa &middot; ' +
    '<span class="kbd">p</span>+<span class="kbd">b</span> = pb &middot; ' +
    '<span class="kbd">r</span>+<span class="kbd">r</span> = rr &middot; ' +
    '<span class="kbd">v</span>+<span class="kbd">a</span> = rra';
}

function armChord(group) {
  clearChord();
  state.chord = group;
  const targets = Object.values(CHORD_MAP[group]);
  document.querySelectorAll('.btn-op').forEach((b) => {
    if (targets.includes(b.dataset.op)) b.classList.add('armed');
  });
  dom.chordHint.innerHTML =
    `<span class="text-sky-300">${CHORD_GROUPS[group]}</span> armed — ` +
    `now press ${Object.keys(CHORD_MAP[group]).map((k) => `<span class="kbd">${k}</span>`).join(' ')} ` +
    `&middot; <span class="kbd">esc</span> to cancel`;
  state.chordTimer = setTimeout(clearChord, 1600);
}

document.addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t instanceof HTMLElement &&
    (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

  const key = e.key.toLowerCase();

  // manual chords first
  if (state.mode === 'manual') {
    if (state.chord) {
      const op = CHORD_MAP[state.chord][key];
      if (op) {
        e.preventDefault();
        flashOpButton(op);
        manualApply(op);
        clearChord();
        return;
      }
      if (key === 'escape') { e.preventDefault(); clearChord(); return; }
      // fall through: an unrelated key cancels the chord
      clearChord();
    }
    if (CHORD_MAP[key]) { e.preventDefault(); armChord(key); return; }
    if (key === 'backspace') { e.preventDefault(); dom.btnUndo.click(); return; }
  }

  switch (e.key) {
    case 'ArrowRight':
      e.preventDefault();
      if (state.mode === 'replay') { stopPlayback(); stepForward(); }
      break;
    case 'ArrowLeft':
      e.preventDefault();
      stopPlayback();
      if (state.mode === 'replay') stepBack();
      else dom.btnUndo.click();
      break;
    case ' ':
      if (state.mode === 'replay') { e.preventDefault(); togglePlayback(); }
      break;
    case 'Home':
      e.preventDefault();
      if (state.mode === 'replay') jumpToStart();
      break;
    case 'End':
      e.preventDefault();
      if (state.mode === 'replay') jumpToEnd();
      break;
    case 'Escape':
      clearChord();
      break;
    default:
      break;
  }
});

/* pause autoplay when the tab is hidden */
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.playing) stopPlayback();
});

/* track heights are viewport-relative, so refit the bars after a resize */
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(refit, 120);
});

/* ============================================================================
 * 8. BOOT
 * ==========================================================================*/

function boot() {
  state.speed = Number(dom.speed.value) || 250;
  dom.speedVal.textContent = `${state.speed} ms`;

  // demo set + demo script so the page is alive on first paint
  dom.inputA.value = '3 -2 7 1 9 -5 4 8';
  const first = parseNumbers(dom.inputA.value);
  if (first.ok) loadNumbers(first.values);

  clearChord();
  syncOpsField();
  renderAll(true);
}

boot();
