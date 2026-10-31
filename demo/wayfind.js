/* Wayfind core: venue loading, destination search, A* routing and turn-by-turn instructions.
   Plain JS, no DOM. Works in the browser (window.Wayfind) and in Node (module.exports). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Wayfind = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FLOOR_M = 4.5;        // assumed floor-to-floor height for the heuristic

  // ------------------------------------------------------------ venue
  function load(json) {
    const nodes = new Map(json.nodes.map(n => [n.id, n]));
    const adj = new Map();
    const edges = json.edges.map((e, i) => {
      const a = nodes.get(e.from), b = nodes.get(e.to);
      if (!a || !b) throw new Error(`edge ${i} refers to an unknown node`);
      const len = e.length_m != null ? e.length_m : Math.hypot(a.x - b.x, a.y - b.y);
      return Object.assign({}, e, { i, length_m: len });
    });
    for (const e of edges) {
      if (!adj.has(e.from)) adj.set(e.from, []);
      if (!adj.has(e.to)) adj.set(e.to, []);
      adj.get(e.from).push({ edge: e, to: e.to, forward: true });
      if (!e.one_way) adj.get(e.to).push({ edge: e, to: e.from, forward: false });
    }
    const levels = new Map(json.levels.map(l => [l.id, l]));
    const dests = json.destinations.filter(d => nodes.has(d.door_node)).map(d => Object.assign({}, d, { node: nodes.get(d.door_node) }));
    const doorToDest = new Map(dests.map(d => [d.door_node, d]));
    return { json, nodes, edges, adj, levels, dests, doorToDest, entries: (json.entry_points || []).map(p => p.node) };
  }

  // ------------------------------------------------------------ search
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const compact = s => norm(s).replace(/ /g, '');
  function damerau(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const d = [];
    for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (let j = 0; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
    return d[a.length][b.length];
  }
  const SYNONYMS = { rm: 'room', mr: 'meeting room', dr: 'discussion room', cr: 'conference room', tr: 'tutorial room', lt: 'lecture theatre',
    sr: 'seminar room', wc: 'toilet', loo: 'toilet', restroom: 'toilet', washroom: 'toilet', bathroom: 'toilet', elevator: 'lift', lvl: 'level', lv: 'level', floor: 'level' };
  const STOP = new Set(['the', 'a', 'an', 'to', 'on', 'at', 'in', 'of', 'go', 'find', 'nearest']);
  function search(venue, query, opts) {
    opts = opts || {};
    const raw = norm(query).split(' ').map(t => SYNONYMS[t] || t).join(' ');
    let q = raw.split(' ').filter(t => t && !STOP.has(t)).join(' ') || raw;
    if (!q) return [];
    let levelFilter = null;
    const lm = q.match(/\b(?:level|lvl|lv|l)\s*(\d+)\b/) || q.match(/\b(\d+)(?:st|nd|rd|th)\s+(?:level|floor)\b/);
    if (lm) { levelFilter = 'L' + lm[1]; q = q.replace(lm[0], '').trim(); }
    q = q.replace(/\s+(?:l|lv|lvl|level)$/, '').trim();
    const qTokens = q.split(' ').filter(Boolean), qc = q.replace(/ /g, '');
    const out = [];
    for (const d of venue.dests) {
      if (levelFilter && d.node.level !== levelFilter) continue;
      const name = norm(d.name), id = norm(d.id), aliases = (d.aliases || []).map(norm);
      let score = 0, how = '';
      if (q === id || q === name || aliases.some(a => a === q && !/^\d+$/.test(a))) { score = 100; how = 'exact'; }
      else if (aliases.includes(q)) { score = 85; how = 'number alias'; }
      else if (qc && (compact(d.id) === qc || aliases.some(a => a.replace(/ /g, '') === qc) || name.replace(/ /g, '') === qc)) { score = 95; how = 'exact'; }
      else if (name.startsWith(q)) { score = 80; how = 'name prefix'; }
      else if (aliases.some(a => a.startsWith(q))) { score = 75; how = 'alias prefix'; }
      else {
        const nTokens = name.split(' ').filter(Boolean);
        const tok = (t, n) => /^\d+$/.test(t) ? n === t : n.startsWith(t);
        if (qTokens.length && qTokens.every(t => nTokens.some(n => tok(t, n)))) { score = 70; how = 'words'; }
        else if (name.includes(q) || aliases.some(a => a.includes(q))) { score = 60; how = 'contains'; }
        else if (qTokens.length && qTokens.every(t => nTokens.some(n => /^\d+$/.test(t) || t.length < 3 ? n === t : damerau(t, n, t.length > 5 ? 2 : 1) <= (t.length > 5 ? 2 : 1)))) { score = 40; how = 'fuzzy'; }
      }
      if (!score) continue;
      if (opts.preferLevel && d.node.level === opts.preferLevel) score += 5;
      out.push({ dest: d, score, how });
    }
    out.sort((a, b) => b.score - a.score || a.dest.name.length - b.dest.name.length || a.dest.name.localeCompare(b.dest.name));
    return out.slice(0, opts.max || 10);
  }

  // ------------------------------------------------------------ routing
  function allowed(e, opts) {
    if (opts.stepFree && e.step_free === false) return false;
    if (opts.avoidLifts && e.type === 'lift') return false;
    if (opts.avoidStairs && e.type === 'stairs') return false;
    return true;
  }
  function levelNum(venue, id) { const l = venue.levels.get(id); return l ? l.floor : 0; }
  function heuristic(venue, a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y) + Math.abs(levelNum(venue, a.level) - levelNum(venue, b.level)) * FLOOR_M;
  }
  function astar(venue, startId, goalId, opts) {
    opts = opts || {};
    const goal = venue.nodes.get(goalId);
    const g = new Map([[startId, 0]]), prev = new Map(), open = [[heuristic(venue, venue.nodes.get(startId), goal), startId]];
    while (open.length) {
      open.sort((x, y) => x[0] - y[0]);
      const [, cur] = open.shift();
      if (cur === goalId) break;
      for (const nb of venue.adj.get(cur) || []) {
        if (!allowed(nb.edge, opts)) continue;
        const ng = g.get(cur) + nb.edge.length_m;
        if (ng < (g.has(nb.to) ? g.get(nb.to) : Infinity) - 1e-9) {
          g.set(nb.to, ng); prev.set(nb.to, { from: cur, edge: nb.edge, forward: nb.forward });
          open.push([ng + heuristic(venue, venue.nodes.get(nb.to), goal), nb.to]);   // nodes may be re-opened
        }
      }
    }
    if (!g.has(goalId)) return null;
    const steps = [];
    for (let n = goalId; n !== startId;) { const p = prev.get(n); steps.unshift({ from: p.from, to: n, edge: p.edge, forward: p.forward }); n = p.from; }
    return { nodes: [startId].concat(steps.map(s => s.to)), edges: steps, length_m: g.get(goalId) };
  }

  /* Snap a free position to the nearest walk edge on its level; returns a temporary venue with a virtual node. */
  const SNAP_TO_NODE_M = 0.01;   // a position this close to a node starts at the node itself (as routing/ does)
  const MAX_SNAP_M = 50;         // beyond this the position is not on the map
  function snap(venue, level, x, y, opts) {
    let best = null;
    for (const e of venue.edges) {
      if (e.type !== 'walk' || !allowed(e, opts || {})) continue;
      const a = venue.nodes.get(e.from), b = venue.nodes.get(e.to);
      if (a.level !== level) continue;
      const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L2)) : 0;
      const px = a.x + t * dx, py = a.y + t * dy, d = Math.hypot(x - px, y - py);
      if (!best || d < best.d) best = { d, e, t, px, py };
    }
    if (!best) return null;
    return best;
  }
  function withVirtualStart(venue, level, x, y, opts) {
    if (!Number.isFinite(+x) || !Number.isFinite(+y)) throw new Error('a free start needs a level, x and y');
    const s = snap(venue, level, +x, +y, opts);
    if (!s) return null;
    if (s.d > MAX_SNAP_M) throw new Error(`That point is ${s.d.toFixed(0)} m from the nearest corridor (limit ${MAX_SNAP_M} m)`);
    const a0 = venue.nodes.get(s.e.from), b0 = venue.nodes.get(s.e.to);
    for (const n of [a0, b0]) if (Math.hypot(s.px - n.x, s.py - n.y) <= SNAP_TO_NODE_M) return { venue, startId: n.id, snapDistance: s.d };
    const id = '__start';
    const node = { id, level, x: s.px, y: s.py, type: 'junction', label: 'You are here' };
    const nodes = new Map(venue.nodes); nodes.set(id, node);
    const adj = new Map(venue.adj);
    const a = venue.nodes.get(s.e.from), b = venue.nodes.get(s.e.to);
    const ea = { from: id, to: a.id, type: 'walk', length_m: Math.hypot(s.px - a.x, s.py - a.y), i: -1, hint: s.e.hint_reverse || null, step_free: s.e.step_free };
    const eb = { from: id, to: b.id, type: 'walk', length_m: Math.hypot(s.px - b.x, s.py - b.y), i: -2, hint: s.e.hint || null, step_free: s.e.step_free };
    adj.set(id, [{ edge: ea, to: a.id, forward: true }, { edge: eb, to: b.id, forward: true }]);
    return { venue: Object.assign({}, venue, { nodes, adj }), startId: id, snapDistance: s.d, snap: s };
  }
  /* A free destination, snapped the same way: a virtual node __end joined by walk edges from the snapped edge's ends (hints of that
     edge in the walked direction) and, when a virtual start lies on the same edge, straight from it. A point within SNAP_TO_NODE_M
     of a node (or of the virtual start) ends at that node: the route is planned to it (goalId) and plan() renames it __end.
     start: withVirtualStart()'s result when the start is virtual, else null. */
  const END_ID = '__end';
  function withVirtualEnd(venue, level, x, y, opts, name, start) {
    const s = snap(venue, level, x, y, opts);
    if (!s) return null;
    if (s.d > MAX_SNAP_M) throw new Error(`That point is ${s.d.toFixed(0)} m from the nearest corridor (limit ${MAX_SNAP_M} m)`);
    const a = venue.nodes.get(s.e.from), b = venue.nodes.get(s.e.to);
    const vs = start && start.snap && start.snap.e === s.e ? venue.nodes.get(start.startId) : null;   // the virtual start, on this same edge
    const node = { id: END_ID, level, x: s.px, y: s.py, type: 'junction', label: name };
    const nodes = new Map(venue.nodes); nodes.set(END_ID, node);
    const at = [a, b, vs].find(n => n && Math.hypot(s.px - n.x, s.py - n.y) <= SNAP_TO_NODE_M);
    if (at) {   // on the node itself: no zero-length edge; same_as lets the 3D export use that node's camera path and position
      Object.assign(node, { x: at.x, y: at.y, same_as: at.id });
      return { venue: Object.assign({}, venue, { nodes }), goalId: at.id, snapDistance: s.d, node };
    }
    const adj = new Map(venue.adj);
    const link = (from, hint, i) => {
      const e = { from: from.id, to: END_ID, type: 'walk', length_m: Math.hypot(s.px - from.x, s.py - from.y), i, hint: hint || null, step_free: s.e.step_free };
      adj.set(from.id, (adj.get(from.id) || []).concat([{ edge: e, to: END_ID, forward: true }]));
    };
    link(a, s.e.hint, -3);                                  // a -> point walks the edge forwards
    if (!s.e.one_way) link(b, s.e.hint_reverse, -4);        // b -> point against it
    if (vs && (s.t > start.snap.t || !s.e.one_way)) link(vs, s.t > start.snap.t ? s.e.hint : s.e.hint_reverse, -5);   // start and end on one edge: one edge between them
    return { venue: Object.assign({}, venue, { nodes, adj }), goalId: END_ID, snapDistance: s.d, node };
  }

  // ------------------------------------------------------------ instructions (port of routing/InstructionBuilder.cs)
  const STRAIGHT_DEG = 20.0;   // heading changes below this continue the leg
  const SHORT_M = 5.0;         // pieces shorter than this between two bends are absorbed or merged
  const DOOR_STUB_M = 2.0;     // a piece this short touching a door folds whatever its angle
  const SIMPLIFY_M = 1.0;      // Douglas-Peucker tolerance over the corridor centreline
  const UTURN_DEG = 160.0;
  const bearing = (a, b) => (Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI + 360) % 360;  // 0 = north, clockwise
  const turnAngle = (from, to) => ((to - from + 540) % 360) - 180;                         // (-180,180], + = right
  const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  const compass = b => COMPASS[Math.round(b / 45) % 8];
  const fmt = m => `${Math.round(m)} m`;
  function hintFor(edge, forward) { return forward ? edge.hint || null : edge.hint_reverse || null; }
  const sameHint = (a, b) => a && b && norm(a).replace(/\b(up|down)\b/g, '').replace(/\s+/g, ' ').trim() === norm(b).replace(/\b(up|down)\b/g, '').replace(/\s+/g, ' ').trim();
  function pointToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  function simplify(pts, first, last) {        // Douglas-Peucker; returns kept indices in order
    const keep = new Array(last - first + 1).fill(false); keep[0] = keep[keep.length - 1] = true;
    (function rec(a, b) {
      if (b - a < 2) return;
      let maxD = -1, idx = -1;
      for (let i = a + 1; i < b; i++) { const d = pointToSegment(pts[i].x, pts[i].y, pts[a].x, pts[a].y, pts[b].x, pts[b].y); if (d > maxD) { maxD = d; idx = i; } }
      if (maxD <= SIMPLIFY_M) return;
      keep[idx - first] = true; rec(a, idx); rec(idx, b);
    })(first, last);
    const out = []; for (let i = 0; i < keep.length; i++) if (keep[i]) out.push(first + i);
    return out;
  }

  function instructions(venue, route, destName) {
    const N = route.nodes.map(id => venue.nodes.get(id));
    const E = route.edges;
    const pathLen = (i, j) => { let s = 0; for (let k = i; k < j; k++) s += E[k].edge.length_m; return s; };
    const angleAt = (verts, vi) => turnAngle(bearing(N[verts[vi - 1]], N[verts[vi]]), bearing(N[verts[vi]], N[verts[vi + 1]]));
    const list = [];
    let current = null;
    const append = (ins, k) => { ins.length_m += E[k].edge.length_m; ins.edgeCount++; if (!ins.hint) { const h = hintFor(E[k].edge, E[k].forward); if (h) ins.hint = h; } };
    let k = 0;
    while (k < E.length) {
      const e = E[k].edge;
      if (e.type !== 'walk') {
        const a = N[k], b = N[k + 1], hint = hintFor(e, E[k].forward);
        if (current && current.kind === e.type && current.toLevel === a.level) { current.toLevel = b.level; current.length_m += e.length_m; current.edgeCount++; current.hint = hint || current.hint; }
        else { current = { kind: e.type, node: a.id, level: a.level, toLevel: b.level, length_m: e.length_m, firstEdge: k, edgeCount: 1, hint }; list.push(current); }
        k++; continue;
      }
      let end = k; while (end < E.length && E[end].edge.type === 'walk') end++;
      // walk run over node indices [k, end]
      const verts = simplify(N, k, end);
      absorbShortPieces(verts, N[k].type === 'door');
      current = { kind: list.length === 0 ? 'start' : 'head', node: N[k].id, level: N[k].level, heading: bearing(N[verts[0]], N[verts[1]]), firstEdge: k, edgeCount: 0, length_m: 0, hint: null };
      list.push(current);
      let cursor = k;
      for (let vi = 1; vi < verts.length - 1; vi++) {
        const v = verts[vi], angle = angleAt(verts, vi);
        if (Math.abs(angle) < STRAIGHT_DEG) continue;
        while (cursor < v) append(current, cursor++);
        current = { kind: Math.abs(angle) >= UTURN_DEG ? 'uturn' : angle < 0 ? 'left' : 'right', node: N[v].id, level: N[v].level, heading: bearing(N[v], N[verts[vi + 1]]), turn: angle, firstEdge: v, edgeCount: 0, length_m: 0, hint: null };
        list.push(current);
      }
      while (cursor < end) append(current, cursor++);
      k = end;
    }
    foldStubsIntoRides(list);
    const last = N[N.length - 1];
    const arrive = { kind: 'arrive', node: last.id, level: last.level, firstEdge: E.length, edgeCount: 0, length_m: 0, hint: null };
    list.push(arrive);
    foldFinalStubIntoArrival(list, arrive, last.type === 'door');
    if (last.face && N.length >= 2 && Math.hypot(last.face.x - last.x, last.face.y - last.y) > 0.3) {   // a free destination with a face point (a room's wall): the side is where that wall lies from the final heading, not the folded corridor turn; a bare point keeps the turn's side
      const t = turnAngle(bearing(N[N.length - 2], last), bearing(last, last.face));
      arrive.turn = Math.abs(t) >= STRAIGHT_DEG ? t : null;
    }
    dropZeroLengthOpening(list);
    return list.map(ins => Object.assign(ins, { text: describe(ins) }));

    function absorbShortPieces(verts, startsAtDoor) {
      let changed = true;
      while (changed && verts.length > 2) {
        changed = false;
        const first = pathLen(verts[0], verts[1]);
        const doorStub = startsAtDoor && first <= DOOR_STUB_M;
        if (doorStub || (first < SHORT_M && Math.abs(angleAt(verts, 1)) < STRAIGHT_DEG)) { verts.splice(1, 1); changed = true; continue; }
        for (let i = 1; i + 2 < verts.length; i++) {
          if (Math.abs(angleAt(verts, i)) < STRAIGHT_DEG) continue;
          if (Math.abs(angleAt(verts, i + 1)) < STRAIGHT_DEG) continue;
          if (pathLen(verts[i], verts[i + 1]) >= SHORT_M) continue;
          const net = turnAngle(bearing(N[verts[i - 1]], N[verts[i]]), bearing(N[verts[i + 1]], N[verts[i + 2]]));
          verts.splice(i + 1, 1);
          if (Math.abs(net) < STRAIGHT_DEG) verts.splice(i, 1);
          changed = true; break;
        }
      }
    }
    function foldStubsIntoRides(list) {   // a turn onto a short piece that ends at a lift or stairs ("Turn right (2 m)", then "Take the lift") is not narrated: the ride says which side it is on, as the arrival does (its node stays the ride's; the corner is N[firstEdge])
      for (let i = 1; i < list.length; i++) {
        const ride = list[i], prev = list[i - 1];
        if (!(ride.kind === 'lift' || ride.kind === 'stairs' || ride.kind === 'escalator')) continue;
        if (!(prev.kind === 'left' || prev.kind === 'right') || prev.length_m >= SHORT_M) continue;
        ride.firstEdge = prev.firstEdge; ride.edgeCount += prev.edgeCount; ride.length_m += prev.length_m; ride.turn = prev.turn;
        const own = ride.hint && !/^take the (lift|stairs|escalator)\b/i.test(ride.hint);   // a ride hint that only repeats the ride ("Take the lift to Level 2") counts as none
        if (!own && prev.hint && !/^(the )?(lifts?|stairs?|staircase|escalators?)( straight)? ahead$/i.test(prev.hint.trim())) ride.hint = prev.hint;   // the piece's own hint (a landmark), unless it only pointed at the ride ("Lifts straight ahead" goes, "Pass ORTDS on your right, lifts ahead" stays)
        list.splice(i - 1, 1); i--;
      }
    }
    function foldFinalStubIntoArrival(list, arrive, endsAtDoor) {
      if (list.length < 2) return;
      const prev = list[list.length - 2];
      const isTurn = prev.kind === 'left' || prev.kind === 'right', isU = prev.kind === 'uturn';
      const doorStub = endsAtDoor && (isTurn || isU) && prev.length_m <= DOOR_STUB_M;
      const shortTurn = isTurn && prev.length_m < SHORT_M;
      if (!doorStub && !shortTurn) return;
      Object.assign(arrive, { firstEdge: prev.firstEdge, edgeCount: prev.edgeCount, length_m: prev.length_m, turn: prev.turn, heading: prev.heading, hint: prev.hint });
      list.splice(list.length - 2, 1);
    }
    function dropZeroLengthOpening(list) {
      if (list.length < 2 || list[0].kind !== 'start' || list[0].length_m > 1e-6) return;
      list[1].firstEdge = list[0].firstEdge; list[1].edgeCount += list[0].edgeCount; list[1].hint = list[1].hint || list[0].hint; list.splice(0, 1);
    }
    function describe(ins) {
      switch (ins.kind) {
        case 'start': case 'head': return `Head ${compass(ins.heading)} (${fmt(ins.length_m)})`;
        case 'left': return `Turn left (${fmt(ins.length_m)})`;
        case 'right': return `Turn right (${fmt(ins.length_m)})`;
        case 'uturn': return `Turn around (${fmt(ins.length_m)})`;
        case 'lift': case 'stairs': case 'escalator': {
          const from = levelNum(venue, ins.level), to = levelNum(venue, ins.toLevel);
          const text = `Take the ${ins.kind} ${to > from ? 'up ' : to < from ? 'down ' : ''}to Level ${to}`;
          if (sameHint(ins.hint, text)) ins.hint = null;
          const side = ins.turn == null || Math.abs(ins.turn) >= UTURN_DEG ? '' : ins.turn < 0 ? ' on your left' : ' on your right';   // set when the turn onto the ride's short stub was folded into it
          return side ? text.replace(`Take the ${ins.kind}`, `Take the ${ins.kind}${side}`) : text;
        }
        case 'arrive': {
          const side = ins.turn == null || Math.abs(ins.turn) >= UTURN_DEG ? '' : ins.turn < 0 ? ' on your left' : ' on your right';
          return `Arrive at ${destName}${side}`;
        }
      }
      return ins.kind;
    }
  }
  const instructionsWithSide = instructions;

  // ------------------------------------------------------------ public
  /* start: a node id or a free position { level, x, y }; destId: a destination id or a free point { level, x, y, name, face?: { x, y } }
     (snapped like a start; plan.dest is then { id: '__end', name, door_node: '__end', level, x, y (the snapped point), virtual: true,
     face, category: 'point', node }). snapDistance / endSnapDistance: how far the start / the free destination was snapped (0 otherwise). */
  function plan(venue, start, destId, opts) {
    opts = opts || {};
    const free = destId != null && typeof destId === 'object';
    let dest = null;
    if (!free) { dest = venue.dests.find(d => d.id === destId); if (!dest) throw new Error(`unknown destination ${destId}`); }
    else if (!Number.isFinite(+destId.x) || !Number.isFinite(+destId.y)) throw new Error('a free destination needs a level, x and y');
    let v = venue, startId, snapDistance = 0, vs = null;
    if (typeof start === 'string') startId = start;
    else { const s = withVirtualStart(venue, start.level, start.x, start.y, opts); if (!s) throw new Error('no walkable edge on that level'); v = s.venue; startId = s.startId; snapDistance = s.snapDistance; vs = s.startId === '__start' ? s : null; }
    let goalId = free ? null : dest.door_node, endSnapDistance = 0;
    if (free) {
      const name = destId.name != null && String(destId.name).trim() ? String(destId.name) : 'the selected point';
      const e = withVirtualEnd(v, destId.level, +destId.x, +destId.y, opts, name, vs);
      if (!e) throw new Error('no walkable edge on that level');
      v = e.venue; goalId = e.goalId; endSnapDistance = e.snapDistance;
      const f = destId.face && Number.isFinite(+destId.face.x) && Number.isFinite(+destId.face.y) ? { x: +destId.face.x, y: +destId.face.y } : { x: e.node.x, y: e.node.y };
      dest = { id: END_ID, name, door_node: END_ID, level: e.node.level, x: e.node.x, y: e.node.y, virtual: true, face: f, category: 'point', node: e.node };
    }
    const r = astar(v, startId, goalId, opts);
    if (!r) return null;
    if (free && goalId !== END_ID) {   // the point is a node (or the virtual start): that node is the route's end, renamed __end
      r.nodes[r.nodes.length - 1] = END_ID;
      if (r.edges.length) r.edges[r.edges.length - 1] = Object.assign({}, r.edges[r.edges.length - 1], { to: END_ID });
    }
    if (free) { const en = v.nodes.get(END_ID); if (en) v.nodes.set(END_ID, Object.assign({}, en, { face: dest.face })); }   // the end node carries the face point (a copy: the venue's own node is never touched), for the arrival's side
    const steps = instructionsWithSide(v, r, dest.name);
    const levels = []; for (const n of r.nodes) { const l = v.nodes.get(n).level; if (levels[levels.length - 1] !== l) levels.push(l); }
    return { route: r, steps, dest, levels, snapDistance, endSnapDistance, nodeOf: id => v.nodes.get(id) };
  }

  return { load, search, plan, astar, snap, instructions: instructionsWithSide, bearing, turnAngle, norm };
});
