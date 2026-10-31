/* Route finder for Research Techno Plaza: From / To search (../demo/wayfind.js), the route planned the moment both are
   set, shown in two views of one position — the 2D floor plan (view2d.js, Leaflet over ../plans2d) and the first-person
   3D model (view3d.js, rtp.glb) — driven by one "where I am along the route" value in metres: drag the marker on the
   plan, the slider under the 3D view, or sideways across the 3D view; a fly-through plays the whole route at 1x / 3x /
   10x pausing at each decision point; the steps list, captions ("Turn right in 6 m"), shareable ?from=&to=&s= links and
   route.json for Unity. Google Maps style: the plan fills the window with the 3D view as a live thumbnail (tap to swap, or
   side by side on a desktop), an Explore list of places by category and landmarks while no destination is set, and any
   room or point tapped on the plan (rooms.json) can be the destination or the start, named or not (a free point is
   routed to the corridor beside it). window.walkthrough exposes the page for the arrival test. */
(async function () {
  'use strict';
  // Survey notices — blank or delete these two constants after the site walk.
  const SURVEY_NOTICE = '';   // the header used to carry "Preview built from map data; positions typically within 1 m, doors not yet surveyed."; the team asked for a clean header (the caveat stays in the README and the handover)
  const BORROWED_CAPTION = 'Corridors on this level are not in the map data yet; the route is approximate.';
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const VENUE_URLS = ['hints/research-techno-plaza-with-hints.json'];
  const PLANS = 'plans2d/';
  const STEP_M = 3.0;             // metres per Forward / Back tap or arrow key
  const PAUSE_MS = 600;           // the fly-through pauses this long at each decision point
  const FLY_RIDE_MS = 600;        // ... and rides a lift / the stairs in this long (fade + card)
  const SWIPE_M_PER_PX = 0.04;    // sideways drag across the 3D view: metres per pixel
  const WHEEL_M_PER_PX = 0.02;    // mouse wheel over the 3D view
  const status = m => { const s = $('#status'); s.textContent = m; s.hidden = !m; };   // "Loading…" and load errors only; the header shows no counts once the data is in
  let toastTimer;
  function toast(msg, ms) { const t = $('#toast'); clearTimeout(toastTimer); if (!msg) { t.style.display = 'none'; return; } t.textContent = msg; t.style.display = 'block'; toastTimer = setTimeout(() => t.style.display = 'none', ms || 3500); }
  const fmtM = m => `${Math.round(m)} m`;
  const isPhone = () => window.matchMedia('(max-width: 760px)').matches;

  // ------------------------------------------------------------ data
  async function fetchFirst(urls) { for (const u of urls) { try { const r = await fetch(u); if (r.ok) return { url: u, json: await r.json() }; } catch (e) {} } throw new Error('venue package not found'); }
  let venueSrc, manifest, paths = null, plans = { levels: [] }, rooms = null, places = {}, photos = {};
  let viewMode = 'map';   // map | 3d | split (set below; declared here because the views' callbacks read it)
  let sheetState = 'peek';   // the phone sheet: peek | half | full
  try {
    venueSrc = await fetchFirst(VENUE_URLS);
    const r = await fetch('model-manifest.json'); if (!r.ok) throw new Error('model-manifest.json missing'); manifest = await r.json();
    try { const p = await fetch('camera-paths.json'); if (p.ok) paths = await p.json(); } catch (e) {}
    try { const p = await fetch(PLANS + 'manifest.json'); if (p.ok) plans = await p.json(); } catch (e) {}
    try { const p = await fetch('rooms.json'); if (p.ok) rooms = await p.json(); } catch (e) {}   // room polygons for taps on the plan (build_rooms.py); optional
    try { const p = await fetch('places.json'); if (p.ok) { const j = await p.json(); for (const k in j) if (k[0] !== '_') places[k] = j[k]; } } catch (e) {}   // hand-kept facts per place: name, access, note (photos/README.md); optional
    try { const p = await fetch('photos/manifest.json'); if (p.ok) photos = await p.json(); } catch (e) {}   // key → photo file, written by make_shotlist.py from the photos folder; optional
  } catch (e) { status('Could not load data. Serve the mapping folder (python3 -m http.server 8765) and open http://localhost:8765/preview3d/ — and run build_model.py once.'); return; }
  if (typeof THREE === 'undefined' || !THREE.GLTFLoader) { status('three.js could not be loaded; this page needs internet access for it once.'); return; }
  let V;
  try { V = Wayfind.load(venueSrc.json); } catch (e) { status('The venue package could not be read: ' + e.message); return; }
  for (const d of V.dests) { const o = places[d.id]; if (o && o.name) d.name = o.name; }   // places.json can correct a destination's name…
  if (rooms && rooms.levels) for (const L of Object.values(rooms.levels)) for (const rm of L.rooms || []) { const o = places[rm.id]; if (o && o.name) rm.name = o.name; }   // …and label a room the map data left unnamed
  const zOf = Object.fromEntries(manifest.levels.map(l => [l.id, l.z]));
  const byFloor = manifest.levels.slice().sort((a, b) => a.floor - b.floor);
  const SPEED = RouteExport.WALK_SPEED;
  const levelName = id => (V.levels.get(id) ? V.levels.get(id).name : id).replace(/\s*\(.*\)$/, '');
  const borrowedFrom = {};
  for (const l of manifest.levels) {
    const m = (V.levels.get(l.id) || { name: '' }).name.match(/copied from floor (\d+)/);
    borrowedFrom[l.id] = l.corridors_borrowed_from || (m ? 'L' + m[1] : null);
  }
  $('#notice').textContent = SURVEY_NOTICE; $('#notice').style.display = SURVEY_NOTICE ? 'block' : 'none';
  if (!paths) toast('camera-paths.json not found: walking the raw graph edges (run build_model.py)', 6000);
  // places: the entrances and every destination; an entrance can be the destination too (a route back out)
  const entranceName = (node, i) => /^main entrance/i.test(node.label || '') ? 'Main entrance' : `Entrance ${i + 1}`;   // the package lists the main entrance first (the glass doors into the Level 2 foyer); the others are numbered
  const entrancePlaces = V.entries.map((n, i) => ({ id: 'entrance:' + (i + 1), name: entranceName(V.nodes.get(n), i), door_node: n, node: V.nodes.get(n), category: 'entrance', entrance: i + 1 }));
  const Vplan = Object.assign({}, V, { dests: V.dests.concat(entrancePlaces) });
  const placeOfNode = new Map(); for (const d of V.dests) if (!placeOfNode.has(d.door_node)) placeOfNode.set(d.door_node, d); for (const e of entrancePlaces) placeOfNode.set(e.door_node, e);
  function placeFromParam(v) {   // "entrance:2", "entrance", "dest:RTP-XF-04-20", "node:L1-n21", a destination id or name
    if (!v) return null;
    let m;
    if ((m = v.match(/^entrance(?::(\d+))?$/))) return entrancePlaces[(+m[1] || 1) - 1] || null;
    if (v.startsWith('dest:')) return V.dests.find(d => d.id === v.slice(5)) || null;
    if (v.startsWith('node:')) { const id = v.slice(5), n = V.nodes.get(id); if (!n) return null; const lp = liftPlaces.find(x => x.door_node === id); return placeOfNode.get(id) || lp || { id: 'node:' + id, name: `Node ${id}${n.label ? ' (' + n.label.replace(/\s*\(.*\)$/, '') + ')' : ''}`, door_node: id, node: n, category: 'node' }; }
    if (v.startsWith('room:')) { const rm = roomIndex.get(v.slice(5)); return rm ? placeOfRoom(rm, rm.level) : null; }
    if ((m = v.match(/^pt:(L\d+),(-?[\d.]+),(-?[\d.]+)$/))) return V.levels.get(m[1]) ? placeAtPoint(m[1], +m[2], +m[3]) : null;
    return V.dests.find(d => d.id === v) || entrancePlaces.find(e => e.id === v) || (Wayfind.search(V, v, { max: 1 })[0] || {}).dest || null;
  }
  // a tapped room is a place too: its venue destination when it has one, else a free destination at the corridor point nearest to it (rooms.json anchor / face)
  const roomIndex = new Map(); if (rooms && rooms.levels) for (const lv in rooms.levels) for (const rm of rooms.levels[lv].rooms || []) roomIndex.set(rm.id, Object.assign({ level: lv }, rm));
  const KIND_LABEL = { lift: 'Lift', stairs: 'Stairs', toilet: 'Toilet', 'meeting room': 'Meeting room', 'seminar room': 'Seminar room', office: 'Office', lab: 'Lab', workshop: 'Workshop', 'research centre': 'Research centre', 'event space': 'Event space', lounge: 'Lounge', studio: 'Studio', school: 'School' };
  const kindLabel = rm => KIND_LABEL[rm.kind] || 'Room';
  // facts per place from places.json and the photo folder: a place's key is its destination id, its plan room id (room:… stripped), entrance:N or node:<id>
  const ACCESS = { keycard: 'Key card needed', staff: 'Staff only', closed: 'Closed to visitors' };
  const placeKey = p => String(p.id || '').replace(/^room:/, '');
  function infoOf(p) { const k = placeKey(p), o = places[k] || {}; return { photo: photos[k] || o.photo || null, access: ACCESS[o.access] ? o.access : null, note: o.note || '' }; }
  const lockSvg = a => `<svg class="lock" role="img" aria-label="${ACCESS[a]}"><use href="#i-lock"/></svg>`;
  const accChip = p => { const i = p ? infoOf(p) : {}; return i.access ? `<span class="acc ${i.access}"><svg aria-hidden="true"><use href="#i-lock"/></svg>${ACCESS[i.access]}</span>` : ''; };
  function placeOfRoom(rm, lv) {
    const d = rm.dest && V.dests.find(x => x.id === rm.dest); if (d) return d;
    if (rm.kind === 'lift' || rm.kind === 'stairs') {   // a lift or stair box: the graph's own node for it, so the route uses the ride
      const at = rm.anchor || rm.centroid, n = [...V.nodes.values()].filter(x => x.level === lv && x.type === rm.kind).map(x => ({ x, d: Math.hypot(x.x - at[0], x.y - at[1]) })).sort((a, b) => a.d - b.d)[0];
      if (n && n.d < 6) return { id: 'node:' + n.x.id, name: `${kindLabel(rm)} (${levelName(lv)})`, door_node: n.x.id, node: n.x, category: rm.kind };
    }
    if (!rm.anchor) return null;
    return { id: 'room:' + rm.id, name: rm.name || `${rm.name ? '' : 'Unnamed '}${kindLabel(rm).toLowerCase()} (${levelName(lv)})`, door_node: null, point: { level: lv, x: rm.anchor[0], y: rm.anchor[1] }, face: rm.face ? { x: rm.face[0], y: rm.face[1] } : null, node: { level: lv, x: rm.anchor[0], y: rm.anchor[1] }, category: rm.kind || 'room', room: rm };
  }
  function placeAtPoint(lv, x, y, name) { return { id: `pt:${lv},${x.toFixed(1)},${y.toFixed(1)}`, name: name || 'Dropped pin', door_node: null, point: { level: lv, x, y }, node: { level: lv, x, y }, category: 'point' }; }

  // ------------------------------------------------------------ the two views
  const canvas = $('#view');
  function headerPx() {   // what covers the top of the 3D view (the search card on phones): the arrival view keeps the destination sign below it
    const c = canvas.getBoundingClientRect(), s = $('#searchcard').getBoundingClientRect(), ov = s.bottom - c.top;
    return s.right > c.left && s.left < c.right && s.top < c.top + 10 && ov > 0 ? Math.min(c.height * 0.6, ov + 8) : 28;
  }
  const panelFrac = () => {   // the floating panel covers the left of a full-window 3D view on a desktop: targets are centred in the part it leaves free
    if (isPhone() || viewMode !== '3d') return 0;
    const c = canvas.getBoundingClientRect(), p = $('#panel').getBoundingClientRect(), ov = p.right - c.left;
    return ov > 0 && p.left < c.left + c.width * 0.5 && c.width > 0 ? Math.min(0.6, ov / c.width) : 0;
  };
  const rectOf = sel => { const b = $(sel).getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }; };
  const overlaps = () => viewMode === '3d' ? [] : isPhone() ? [rectOf('#searchcard'), rectOf('#sheet')] : [rectOf('#panel')];   // what covers the plan: the search card and the sheet on a phone, the floating panel on a desktop, nothing while the plan is the thumbnail
  function layoutVars() {   // CSS variables the phone layout needs: the sheet's height (the 3D-only view stops above it) and the search card's (the Map view starts under it)
    const app = $('#app'); app.style.setProperty('--sheet-h', (isPhone() ? sheetHeight(sheetState) : 0) + 'px');   // the sheet's target height, not its rect: it may still be sliding
    app.style.setProperty('--header-h', (isPhone() ? $('#searchcard').getBoundingClientRect().height + 16 : 0) + 'px');
  }
  const v3 = View3D({ canvas, manifest, V, paths, ui: { headerPx, panelFrac, levelName, borrowedFrom, borrowedCaption: BORROWED_CAPTION } });
  let v2 = null;
  if (typeof L !== 'undefined') v2 = View2D({ el: $('#map'), levelsEl: $('#levels'), msgEl: $('#mapmsg'), plans, PLANS, levels: byFloor.map(l => ({ id: l.id, name: levelName(l.id), floor: l.floor })), esc, onScrub: (s, run, lv) => { stopFly(); setS(s, lv); }, onClickStep: i => goToStep(i), overlaps, rooms, onPickRoom: (rm, lv) => pickRoom(rm, lv), onPickPoint: (lv, x, y) => pickPoint(lv, x, y), isThumb: () => viewMode === '3d', labelOf: rm => (rm.kind === 'lift' || rm.kind === 'stairs' ? kindLabel(rm) : 'Unnamed ' + kindLabel(rm).toLowerCase()) });
  else { $('#mapmsg').textContent = 'The map library (Leaflet) could not be loaded; the 2D plan needs internet access for it once.'; $('#mapmsg').style.display = 'block'; }
  status('Loading the 3D model…');
  try { await v3.load(); } catch (e) { status(e.message && /level/.test(e.message) ? e.message : 'rtp.glb could not be loaded. Run python3 build_model.py in preview3d/ first.'); return; }

  // ------------------------------------------------------------ search: From / To with instant suggestions
  const sel = { from: entrancePlaces[0] || null, to: null };
  const inputs = { from: $('#from'), to: $('#to') }, sug = $('#suggest');
  let sugFor = null, sugItems = [], sugActive = -1;
  const setField = (which, place) => { sel[which] = place; inputs[which].value = place ? place.name : ''; $('#field' + which).classList.toggle('filled', !!place); };
  const EXTRA_SYNONYMS = { accessible: 'handicap', disabled: 'handicap', wheelchair: 'handicap', handicapped: 'handicap', gents: 'male toilet', ladies: 'female toilet', mens: 'male toilet', womens: 'female toilet' };   // on top of wayfind's (wc, loo, restroom, washroom, bathroom -> toilet)
  const floorOf = lv => (V.levels.get(lv) || {}).floor || +String(lv).replace(/\D/g, '') || 0;
  function suggestions(q, which) {
    const nq = Wayfind.norm(q).split(' ').map(t => EXTRA_SYNONYMS[t] || t).join(' '), out = [];
    if (!nq) {   // nothing typed: an action to choose the place on the plan; the start also offers the entrances; a note says any room can be typed
      const rows = [{ id: 'pick', name: which === 'from' ? 'Choose the start on the plan' : 'Choose the destination on the plan', category: 'pick', action: 'pick' }];
      if (which === 'from') rows.push(...entrancePlaces);
      rows.push({ id: 'note', name: which === 'from' ? 'or type any room, lift or landmark' : 'or type a room code or name, or use Explore below', category: 'note', action: 'note' });
      return rows;
    }
    for (const e of entrancePlaces) if (`entrance ${e.entrance}`.startsWith(nq) || nq === String(e.entrance) || 'entrance'.startsWith(nq) || nq === 'exit' || Wayfind.norm(e.name).startsWith(nq) || (nq === 'main' && e.entrance === 1)) out.push(e);
    const category = /\b(toilet|toilets|wc|loo|restroom|washroom|bathroom|handicap)\b/.test(nq);
    const hits = Wayfind.search(V, nq, { max: category ? 80 : 10, preferLevel: v3.state().level }).map(r => r.dest).filter(d => !out.includes(d));
    if (!category) return out.concat(hits).slice(0, 12);
    // a category query ("toilet", "toilet level 5", "handicap toilet"): one row per toilet type per level, the levels nearest the start first
    const from = sel.from ? floorOf(sel.from.node.level) : 1, seen = new Set(), rows = [];
    for (const d of hits.slice().sort((a, b) => (Math.abs(floorOf(a.node.level) - from) - Math.abs(floorOf(b.node.level) - from)) || a.name.localeCompare(b.name))) {
      const key = d.node.level + '|' + d.name.replace(/\s*\(.*\)$/, '').toLowerCase(); if (seen.has(key)) continue; seen.add(key); rows.push(d);
    }
    return out.concat(rows).slice(0, 12);
  }
  function renderSug() {
    sug.innerHTML = '';
    for (const w of ['from', 'to']) { inputs[w].setAttribute('aria-expanded', String(sugFor === w && sugItems.length > 0)); if (sugFor !== w) inputs[w].removeAttribute('aria-activedescendant'); }
    if (!sugFor || !sugItems.length) { sug.style.display = 'none'; return; }
    const f = $('#searchcard .fields'); sug.style.top = (f.offsetTop + f.offsetHeight + 4) + 'px'; sug.style.display = 'block'; toast('');   // the list answers whatever a toast was prompting for
    if (sugActive >= 0) inputs[sugFor].setAttribute('aria-activedescendant', 'sug-' + sugActive);
    sugItems.forEach((p, i) => {
      const d = document.createElement('div'); d.className = (i === sugActive ? 'active' : '') + (p.action ? ' ' + (p.action === 'pick' ? 'act' : 'note') : ''); d.id = 'sug-' + i; d.setAttribute('aria-selected', String(i === sugActive));
      if (p.action) { d.innerHTML = p.action === 'pick' ? `<span class="ico"><svg aria-hidden="true"><use href="#i-target"/></svg></span><span class="name">${esc(p.name)}</span>` : `<span class="name">${esc(p.name)}</span>`; if (p.action === 'note') d.setAttribute('aria-disabled', 'true'); }
      else { const a = infoOf(p).access; d.innerHTML = `<span class="ico">${icon(p)}</span><span class="name">${esc(p.name)}${a ? lockSvg(a) : ''}</span>${p.category === 'entrance' ? '' : `<span class="code">${esc(p.id)}</span>`}<span class="lvl">${esc(p.node.level)}</span>`; }
      d.setAttribute('role', 'option');
      d.onmousedown = e => { e.preventDefault(); choose(sugFor, p); }; sug.appendChild(d);
    });
  }
  function setActive(i) { sugActive = Math.max(0, Math.min(sugItems.length - 1, i)); [...sug.children].forEach((d, k) => { d.classList.toggle('active', k === sugActive); d.setAttribute('aria-selected', String(k === sugActive)); if (k === sugActive) d.scrollIntoView({ block: 'nearest' }); }); if (sugFor && sugActive >= 0) inputs[sugFor].setAttribute('aria-activedescendant', 'sug-' + sugActive); }
  function openSug(which) { sugFor = which; sugItems = suggestions(inputs[which].value, which); sugActive = sugItems.length && !sugItems[0].action ? 0 : (sugItems.length > 1 && inputs[which].value ? 0 : -1); renderSug(); }
  function closeSug() { sugFor = null; sugItems = []; renderSug(); }
  function restoreField(which) { inputs[which].value = sel[which] ? sel[which].name : ''; $('#field' + which).classList.toggle('filled', !!sel[which]); }
  function choose(which, place) {
    if (place && place.action) { if (place.action === 'pick') startPick(which); return; }
    const same = !!(sel[which] && place && sel[which].id === place.id);
    setField(which, place); closeSug(); inputs[which].blur(); if (which === 'to' && !sel.from) setField('from', entrancePlaces[0] || null);
    route(same);   // the same place again keeps the position
    if (which === 'from' && !sel.to) inputs.to.focus();
  }
  for (const which of ['from', 'to']) {
    const inp = inputs[which];
    inp.addEventListener('focus', () => { inp.select(); openSug(which); });
    inp.addEventListener('input', () => { $('#field' + which).classList.toggle('filled', !!inp.value); openSug(which); });
    inp.addEventListener('blur', () => setTimeout(() => {   // typed text that was not chosen goes; on a phone the card shrinks back to the route header when nothing changed
      if (document.activeElement !== inp) { if (sugFor === which) closeSug(); restoreField(which); }
      if (isPhone() && (R || already) && document.activeElement !== inputs.from && document.activeElement !== inputs.to) setCollapsed(true);
    }, 120));
    inp.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { setActive(sugActive + 1); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { setActive(sugActive - 1); e.preventDefault(); }
      else if (e.key === 'Enter') { if (sugItems[sugActive]) choose(which, sugItems[sugActive]); e.preventDefault(); }
      else if (e.key === 'Escape') { closeSug(); restoreField(which); inp.blur(); }
    });
  }
  for (const b of document.querySelectorAll('.field .clear')) b.onclick = () => { const which = b.dataset.for; setField(which, null); route(); setCollapsed(false); inputs[which].focus(); };
  $('#collapse').onclick = () => setCollapsed(true);
  $('#swap').onclick = () => { const a = sel.from, b = sel.to; setField('from', b); setField('to', a); route(); };
  const opts = () => ({ stepFree: $('#stepfree').classList.contains('on'), avoidLifts: $('#nolifts').classList.contains('on') });
  for (const id of ['stepfree', 'nolifts']) $('#' + id).onclick = () => { const b = $('#' + id), on = b.classList.toggle('on'); b.setAttribute('aria-pressed', on); route(true); };
  setField('from', sel.from);

  // ------------------------------------------------------------ Explore: places by category, and the landmarks (shown while no destination is set)
  const liftPlaces = [...V.nodes.values()].filter(n => n.type === 'lift' || n.type === 'stairs').map(n => { const lab = (n.label || '').replace(/\s*\(.*\)$/, '').trim(); return { id: 'node:' + n.id, name: `${n.type === 'lift' ? 'Lift' : 'Stairs'}${lab && !/^(lift|lifts|stairs?|staircase)$/i.test(lab) ? ' · ' + lab : ''} (${levelName(n.level)})`, door_node: n.id, node: n, category: n.type }; });
  const isMeeting = d => /\b(meeting|discussion|breakout|board ?room|seminar|training|harvard|lecture|conference|tutorial|classroom)\b/i.test(d.name);
  const CATS = [
    { id: 'entrances', name: 'Entrances', ic: 'door', cls: 'g', items: entrancePlaces },
    { id: 'toilets', name: 'Toilets', ic: 'toilet', cls: 't', items: V.dests.filter(d => d.category === 'toilet') },
    { id: 'meeting', name: 'Meeting & seminar rooms', ic: 'meeting', cls: '', items: V.dests.filter(d => d.category !== 'toilet' && d.category !== 'lab' && isMeeting(d)) },
    { id: 'labs', name: 'Labs & cleanrooms', ic: 'lab', cls: 'l', items: V.dests.filter(d => d.category === 'lab') },
    { id: 'lifts', name: 'Lifts & stairs', ic: 'lift', cls: '', items: liftPlaces },
    { id: 'other', name: 'Offices & other rooms', ic: 'room', cls: 'r', items: V.dests.filter(d => d.category !== 'toilet' && d.category !== 'lab' && !isMeeting(d)) },
  ];
  const landmarks = V.dests.filter(d => /\[[^\]]+\]/.test(d.name) || d.category === 'lecture_theatre' || d.category === 'help_point').sort((a, b) => a.name.localeCompare(b.name));   // the institutes and centres (MazeMap titles with an acronym), the seminar room, the help point
  const ICON = { entrance: 'door', toilet: 'toilet', lab: 'lab', lift: 'lift', stairs: 'stairs', room: 'room', lecture_theatre: 'meeting', help_point: 'help', point: 'pin', node: 'dot', 'meeting room': 'meeting', 'seminar room': 'meeting', 'event space': 'meeting', 'research centre': 'star', workshop: 'lab', office: 'room', school: 'room', lounge: 'room', studio: 'room' };
  const icon = p => `<svg aria-hidden="true"><use href="#i-${ICON[p.category] || (isMeeting(p) ? 'meeting' : 'room')}"/></svg>`;
  function placeRow(p) {
    const li = document.createElement('li'); li.setAttribute('role', 'button'); li.tabIndex = 0;
    li.title = p.name;
    const info = infoOf(p);
    li.innerHTML = `<span class="ico">${icon(p)}</span><span class="name">${esc(p.name)}${info.access ? lockSvg(info.access) : ''}</span>${p.category === 'entrance' ? '' : `<span class="code">${esc(p.id.replace(/^node:/, ''))}</span>`}<span class="lvl">${esc(p.node.level)}</span>${info.photo ? `<img class="thumb" src="${esc(info.photo)}" alt="" loading="lazy">` : ''}`;
    li.onclick = () => choose('to', p); li.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose('to', p); } };
    return li;
  }
  function renderExplore() {
    const cats = $('#excats'); cats.innerHTML = '';
    for (const c of CATS) {
      if (!c.items.length) continue;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'excat';
      b.innerHTML = `<span class="ic ${c.cls}"><svg aria-hidden="true"><use href="#i-${c.ic}"/></svg></span><span class="tx"><div class="nm">${esc(c.name)}</div><div class="ct">${c.items.length} place${c.items.length === 1 ? '' : 's'}</div></span>`;
      b.onclick = () => openCat(c); cats.appendChild(b);
    }
    const lm = $('#exlm'); lm.innerHTML = ''; for (const d of landmarks) lm.appendChild(placeRow(d)); $('#exlandmarks').hidden = !landmarks.length;
  }
  function openCat(c) {   // one category: its places grouped by level, the levels nearest the start first
    $('#excats').hidden = true; $('#exlandmarks').hidden = true; $('#exlist').hidden = false; $('#exlisttitle').textContent = c.name;
    const ol = $('#exitems'); ol.innerHTML = '';
    const from = sel.from && sel.from.node ? floorOf(sel.from.node.level) : 1;
    const byLevel = new Map(); for (const p of c.items) { const k = p.node.level; if (!byLevel.has(k)) byLevel.set(k, []); byLevel.get(k).push(p); }
    const order = [...byLevel.keys()].sort((a, b) => (Math.abs(floorOf(a) - from) - Math.abs(floorOf(b) - from)) || floorOf(a) - floorOf(b));
    for (const lv of order) { const h = document.createElement('li'); h.className = 'lvlhead'; h.textContent = levelName(lv); ol.appendChild(h); for (const p of byLevel.get(lv).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) ol.appendChild(placeRow(p)); }
    if (isPhone() && sheetState === 'peek') setSheet('half');
    $('#explore').scrollTop = 0;
  }
  function closeCat() { $('#exlist').hidden = true; $('#excats').hidden = false; $('#exlandmarks').hidden = !landmarks.length; }
  $('#exback').onclick = closeCat;
  renderExplore();
  function showRouteBox(on) { $('#routebox').hidden = !on; $('#explore').hidden = !!on; }

  // ------------------------------------------------------------ a tapped room or point on the plan: a card with Directions / Start here, or, after "Choose … on the plan", the place itself
  let picked = null, pickMode = null;   // pickMode: 'from' | 'to' while the next tap on the plan sets that field
  function startPick(which) {
    pickMode = which; closeSug(); inputs[which].blur(); hidePlaceCard();
    if (viewMode === '3d') setView('map');
    $('#app').classList.add('picking'); if (isPhone()) setCollapsed(!!(R || already));
    toast(`Tap a room or a corridor on the plan to set the ${which === 'from' ? 'start' : 'destination'} (Esc cancels)`, 8000);
  }
  function endPick() { pickMode = null; $('#app').classList.remove('picking'); }
  function tookPick(p) {   // a tap while picking: the field is set at once, no card
    const which = pickMode; endPick(); toast('');
    if (which === 'from') { setField('from', p); route(); if (!sel.to) inputs.to.focus(); } else choose('to', p);
  }
  function pickRoom(rm, lv) {
    const p = placeOfRoom(rm, lv);
    if (!p) { toast('No corridor near that room in the map data'); return; }
    if (pickMode) { tookPick(p); return; }
    showPlaceCard(p, rm.name ? kindLabel(rm) : (rm.kind === 'lift' || rm.kind === 'stairs' ? kindLabel(rm) : 'Unnamed ' + kindLabel(rm).toLowerCase()), lv);
  }
  function pickPoint(lv, x, y) { if (viewMode === '3d') return; const p = placeAtPoint(lv, x, y); if (pickMode) { tookPick(p); return; } showPlaceCard(p, 'Point on the plan', lv); }
  function showPlaceCard(p, kind, lv) {
    picked = p; $('#pcname').textContent = p.name;
    $('#pcsub').textContent = `${kind.charAt(0).toUpperCase() + kind.slice(1)} · ${levelName(lv)}${p.door_node ? '' : ' · the route ends in the corridor beside it'}`;
    const info = infoOf(p), img = $('#pcphoto');   // a photo from the photos folder, an access warning or note from places.json, the map id of a room nobody has named yet
    if (info.photo) { img.src = info.photo; img.alt = 'Photo of ' + p.name; img.hidden = false; } else { img.removeAttribute('src'); img.hidden = true; }
    $('#pcaccess').hidden = !(info.access || info.note); $('#pcaccess').className = 'access ' + (info.access || 'info'); $('#pcaccessico').setAttribute('href', info.access ? '#i-lock' : '#i-info');
    $('#pcaccesstext').textContent = [info.access ? ACCESS[info.access] : '', info.note].filter(Boolean).join(' · ');
    const unnamed = p.room && !p.room.name; $('#pcid').hidden = !unnamed; $('#pcid').textContent = unnamed ? 'Map id ' + p.room.id : '';
    $('#placecard').hidden = false; $('#app').classList.add('has-card'); if (v2) v2.setPick(p.node, p.name);
  }
  function hidePlaceCard() { picked = null; $('#placecard').hidden = true; $('#app').classList.remove('has-card'); if (v2) v2.setPick(null); }
  $('#pcclose').onclick = hidePlaceCard;
  $('#pcgo').onclick = () => { if (!picked) return; const p = picked; hidePlaceCard(); choose('to', p); };
  $('#pcstart').onclick = () => { if (!picked) return; const p = picked; hidePlaceCard(); setField('from', p); route(); if (!sel.to) inputs.to.focus(); };

  // ------------------------------------------------------------ the route
  let plan = null, R = null, dest = null, already = null;
  let pos = { s: 0, run: 0 };
  const summary = html => { for (const id of ['sheethead', 'csummary']) $('#' + id).innerHTML = html; };
  // on phones the search card shrinks to a two-line route header once a route is set; tapping it opens the fields again
  function setCollapsed(on) { $('#searchcard').classList.toggle('collapsed', !!on && isPhone()); if (on) { $('#cfrom').textContent = sel.from ? sel.from.name : ''; $('#cto').textContent = sel.to ? sel.to.name : ''; } layoutVars(); }
  $('#compactrow').onclick = () => setCollapsed(false);
  function route(keepS) {
    const sPrev = keepS && R ? pos.s : 0;
    stopFly(); plan = null; R = null; dest = null; already = null; pos = { s: 0, run: 0 };
    v3.clear(); if (v2) v2.setRoute(null);
    $('#steps').innerHTML = ''; summary(''); setCaptionIdle(); enableControls(false); $('#scrub').value = 0; $('#scrub').max = 100; $('#pos').textContent = '0 m / 0 m';
    $('#app').classList.remove('has-route'); pinnedStep = -1;
    showRouteBox(!!sel.to && !!sel.from); if (!isPhone()) setCollapsed(false);   // a destination without a start shows Explore again, with a prompt for the start
    if (sel.to && !sel.from && !pickMode) toast('Where from? Type a room, tap the plan, or choose an entrance', 6000);
    if (!sel.from || !sel.to) { setSheet(sheetState); layoutVars(); updateUrl(); return; }
    dest = sel.to;
    // a place with a door node is a graph destination (or an entrance); a tapped room or point is a free destination, routed to the corridor beside it
    const fromArg = sel.from.door_node ? sel.from.door_node : sel.from.point;
    const inDests = Vplan.dests.some(d => d.id === dest.id);   // a venue destination or an entrance plans to its id; a lift or stair node and a tapped room or point are free destinations (snapped onto the node or the corridor)
    const toArg = inDests ? dest.id : dest.door_node ? { level: dest.node.level, x: dest.node.x, y: dest.node.y, name: dest.name } : Object.assign({ name: dest.name }, dest.point, dest.face ? { face: dest.face } : {});
    try { plan = Wayfind.plan(Vplan, fromArg, toArg, opts()); } catch (e) { toast(e.message); setSheet(sheetState); layoutVars(); updateUrl(); return; }
    if (!plan) { summary(`<b>No route</b> to ${esc(dest.name)} with these options.`); $('#steptext').textContent = `No route to ${dest.name} with these options`; setSheet(sheetState); layoutVars(); updateUrl(); return; }
    if (plan.dest && plan.dest.virtual) dest = Object.assign({}, dest, plan.dest, { id: dest.id, name: dest.name });   // the snapped point and its face, the place's own id for links
    if (plan.route.edges.length === 0) {   // start is the destination: show the place, no walk (a free destination too: view3d stands on the point)
      already = v3.setAlready(plan, dest);
      summary(`<b>You are already at ${esc(dest.name)}</b><span class="sep">·</span>${esc(levelName(already.level))}${accChip(dest)}`);
      $('#stepn').style.display = 'none'; $('#steptext').textContent = `You are already at ${dest.name}`; $('#hint').textContent = 'Pick another start or destination to see the way.'; $('#next').textContent = '';
      if (v2) v2.showDestination(already.door.x, already.door.y, already.level, dest.name);
      $('#app').classList.add('has-route'); setCollapsed(true); setSheet(sheetState); layoutVars(); updateUrl(); return;
    }
    R = RouteExport.build(Vplan, plan, manifest, paths, { startLabel: sel.from.name, options: opts() });
    const rides = {}; for (const r of R.rides) rides[r.type] = (rides[r.type] || 0) + 1;
    const rideText = Object.entries(rides).map(([t, n]) => `${n} ${t === 'lift' ? (n > 1 ? 'lifts' : 'lift') : 'stairs'}`).join(', ');
    const walkM = plan.route.edges.filter(x => x.edge.type === 'walk').reduce((t, x) => t + (x.edge.length_m || 0), 0) || R.length;   // the walk itself, the graph's walk edges (a ride step's length includes the short stub folded into it), not the camera path (a door beside the landing walks more than the cut path)
    const seconds = walkM / SPEED + R.rides.reduce((t, r) => t + r.seconds, 0);   // route_export's ride allowance: RIDE_S plus RIDE_EXTRA_S per further floor
    const levelsText = R.runs.map(r => r.level).filter((l, i, a) => i === 0 || l !== a[i - 1]).join(' → ');
    summary(`<b>${fmtM(walkM)}</b><span class="sep">·</span>${Math.max(1, Math.round(seconds / 60))} min<span class="sep">·</span>${levelsText}${rideText ? `<span class="sep">·</span>${rideText}` : ''}${accChip(dest)}`);
    plan.steps.forEach((st, i) => {
      const li = document.createElement('li'); li.className = st.kind;
      li.innerHTML = `<span class="n">${i + 1}</span><div><div class="t">${esc(st.text)}</div>${st.hint ? `<div class="h">${esc(st.hint)}</div>` : ''}</div><span class="lv">${esc(st.level)}${st.toLevel ? ' → ' + esc(st.toLevel) : ''}</span>`;
      li.onclick = () => goToStep(i); $('#steps').appendChild(li);
    });
    v3.setRoute(plan, R, dest);
    if (v2) v2.setRoute(R, plan, dest, sel.from.name);
    $('#scrub').max = R.length.toFixed(1); enableControls(true);
    setS(Math.min(sPrev, R.length), null, { snap: true });
    setSheet(sheetState); $('#sheetbody').scrollTop = 0; $('#steps').scrollTop = 0;
    $('#app').classList.add('has-route'); setCollapsed(true); layoutVars();
    updateUrl();
  }
  function enableControls(on) { for (const id of ['fwd', 'back', 'prevturn', 'nextturn', 'play', 'scrub']) $('#' + id).disabled = !on; }

  // ------------------------------------------------------------ one position for both views
  function runFor(s, levelHint, dir) {   // the run holding s: by level when given, else the current run while it still contains s (a ride boundary belongs to two runs), else in the direction of travel
    const c = R.runs.map((r, i) => i).filter(i => s >= R.runs[i].s0 - 1e-6 && s <= R.runs[i].s1 + 1e-6);
    if (!c.length) return s <= 0 ? 0 : R.runs.length - 1;
    if (levelHint) { const b = c.find(i => R.runs[i].level === levelHint); if (b != null) return b; }
    if (s >= R.length - 1e-6) return c[c.length - 1];   // the end of the route is on its last run (a free destination on a lift node lands there by the ride)
    if (c.includes(pos.run)) return pos.run;
    return dir < 0 ? c[0] : c[c.length - 1];
  }
  let urlDirty = false, urlAt = 0;   // the address bar follows the position once it has settled for a moment (not during a drag)
  function setS(s, levelHint, o) {   // -> whether the run (level) changed
    if (!R) return false; o = o || {};
    const ns = Math.max(0, Math.min(R.length, s)), dir = Math.sign(ns - pos.s) || 1, run = runFor(ns, levelHint, dir), changed = run !== pos.run;
    pos = { s: ns, run }; if (!o.pin) pinnedStep = -1;
    v3.setTarget(ns, run, { snap: o.snap, fadeMs: o.fly && changed ? FLY_RIDE_MS : undefined, card: !!(o.fly && changed) });
    const r = R.runs[run], p = v3.pointOnRun(r, ns);
    if (v2) v2.setPosition({ s: ns, run, x: p.x, y: p.y, level: r.level, heading: v3.headingAt(r, ns, p) });
    $('#scrub').value = ns.toFixed(1); $('#pos').textContent = `${fmtM(ns)} / ${fmtM(R.length)}`;
    updateCaption(r, p);
    urlDirty = true; urlAt = performance.now() + 800;
    return changed;
  }
  function nudge(dir) { if (!R) return; stopFly(); setS(pos.s + dir * STEP_M); }
  function jump(dir) {
    if (!R) return; stopFly();
    const marks = [0, R.length, ...R.stepS];
    const next = dir > 0 ? Math.min(...marks.filter(v => v > pos.s + 0.3)) : Math.max(...marks.filter(v => v < pos.s - 0.3));
    if (isFinite(next)) setS(next);
  }
  function goToStep(i) {
    if (!R) return; stopFly();
    const st = plan.steps[i]; pinnedStep = i; lastCaptionKey = '';
    if (st.kind === 'lift' || st.kind === 'stairs') setS(R.stepS[i], st.toLevel, { fly: true, pin: true });   // land at the top of the ride, with its card
    else setS(R.stepS[i], st.level, { pin: true });
    if (isPhone() && sheetState === 'full') setSheet('half');
  }
  // ---- captions that follow position: "Turn right in 6 m" -> "Turn right now" -> the next leg's hint; the steps list and the plan follow
  const noLen = t => t.replace(/\s*\(\d+ m\)$/, '');
  let lastCaptionKey = '', currentStep = -1, pinnedStep = -1;
  function updateCaption(run, p) {
    const steps = plan.steps;
    let leg = R.stepOfEdge[p.k]; if (leg == null || leg < 0) leg = 0;
    const atEnd = pos.s >= R.length - 0.5;
    let up = leg + 1, big, d;
    const legIsRide = steps[leg].kind === 'lift' || steps[leg].kind === 'stairs';
    if (legIsRide && run.level === steps[leg].level) up = leg;   // standing at a ride that starts the route: the ride itself is what comes next
    if (steps[leg].kind === 'arrive' || up >= steps.length) { up = steps.length - 1; d = R.length - pos.s; }
    else d = Math.max(0, R.stepS[up] - pos.s);
    const upStep = steps[up];
    if (upStep.kind === 'arrive') big = atEnd ? `You have arrived at ${plan.dest.name}` : `${noLen(upStep.text)} in ${fmtM(d)}`;
    else big = d <= 1.0 ? `${noLen(upStep.text)} now` : `${noLen(upStep.text)} in ${fmtM(d)}`;
    const hint = steps[leg].hint || '';
    const then = up + 1 < steps.length ? `Then: ${steps[up + 1].text}` : '';
    const current = pinnedStep >= 0 ? pinnedStep : up;   // the step the caption is about (or the row just tapped, until the position moves): the badge and the list agree
    const key = `${leg}|${up}|${big}|${hint}|${current}`;
    if (key !== lastCaptionKey) {
      lastCaptionKey = key;
      const n = $('#stepn'); n.style.display = 'flex'; n.textContent = `${current + 1}/${steps.length}`; n.className = 'n ' + steps[current].kind;
      $('#steptext').textContent = big; $('#hint').textContent = hint; $('#next').textContent = then;
      if (current !== currentStep) {
        currentStep = current;
        const list = $('#steps');
        document.querySelectorAll('#steps li').forEach((li, k) => {
          li.classList.toggle('current', k === current);
          if (k === current && !list.matches(':hover')) {   // keep the current step in view by scrolling the list alone (scrollIntoView would also scroll the sheet under the controls)
            const r = li.getBoundingClientRect(), lr = list.getBoundingClientRect();
            if (r.top < lr.top) list.scrollTop += r.top - lr.top; else if (r.bottom > lr.bottom) list.scrollTop += r.bottom - lr.bottom;
          }
        });
        if (v2) v2.setCurrentStep(current);
      }
    }
    // the amber marker stands at the next decision point; within 1 m of it ("now") it moves on to the one after
    const mk = d <= 1.0 && upStep.kind !== 'arrive' ? up + 1 : up;
    if (atEnd || mk >= steps.length || steps[mk].kind === 'arrive') { v3.setMarker(null); return; }
    const sNext = R.stepS[mk], ri = runFor(sNext, steps[mk].level, 1), r2 = R.runs[ri], q = v3.pointOnRun(r2, sNext);
    v3.setMarker(q.x, q.y, r2.level);
  }
  function setCaptionIdle() { lastCaptionKey = ''; currentStep = -1; $('#stepn').style.display = 'none'; $('#steptext').textContent = sel.to ? '' : 'Pick a destination to see the way'; $('#hint').textContent = ''; $('#next').textContent = ''; }

  // ------------------------------------------------------------ fly-through
  const fly = { on: false, pace: +$('#speed').value, pauseUntil: 0 };
  function setFly(on) { if (!R) return; fly.on = on; if (on && pos.s >= R.length - 1e-6) setS(0, null, { snap: true }); fly.pauseUntil = 0; updatePlay(); }
  function stopFly() { if (fly.on) { fly.on = false; updatePlay(); } }
  function updatePlay() { const b = $('#play'); b.classList.toggle('playing', fly.on); b.querySelector('.lbl').textContent = fly.on ? 'Pause' : 'Play'; b.title = fly.on ? 'Pause the fly-through (space)' : 'Fly through the route (space)'; b.setAttribute('aria-label', b.title); }
  $('#speed').onchange = () => { fly.pace = +$('#speed').value; };
  function flyTick(now, dt) {
    if (!fly.on || !R || now < fly.pauseUntil || v3.state().transition) return;
    let ns = pos.s + SPEED * fly.pace * dt;
    const marks = R.stepS.filter(m => m > pos.s + 0.05 && m <= ns + 1e-6);   // a decision point passed this frame: stop on it and pause with its caption
    if (marks.length) { ns = Math.min(...marks); fly.pauseUntil = now + PAUSE_MS; }
    if (ns >= R.length - 1e-6) { ns = R.length; fly.on = false; updatePlay(); }
    if (setS(ns, null, { fly: true })) fly.pauseUntil = Math.max(fly.pauseUntil, now + FLY_RIDE_MS + 50);   // a ride: its fade and card
  }

  // ------------------------------------------------------------ controls: buttons, keys, the slider, dragging across the 3D view
  $('#fwd').onclick = () => nudge(+1); $('#back').onclick = () => nudge(-1);
  $('#nextturn').onclick = () => jump(+1); $('#prevturn').onclick = () => jump(-1);
  $('#play').onclick = () => setFly(!fly.on);
  $('#scrub').addEventListener('input', () => { if (R) { stopFly(); setS(+$('#scrub').value); } });
  $('#scrub').addEventListener('change', () => $('#scrub').blur());
  const keyDir = { ArrowUp: +1, ArrowRight: +1, ArrowDown: -1, ArrowLeft: -1 };
  for (const b of document.querySelectorAll('.buttons button, .chip, .round, #thumbtap')) b.addEventListener('click', () => b.blur());   // a clicked button must not also eat the next space
  $('#compactrow').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed(false); inputs.to.focus(); } });
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && pickMode) { endPick(); toast(''); return; }
    if (e.defaultPrevented || (e.target && e.target.closest && e.target.closest('[role="button"], #placecard, .leaflet-container'))) return;   // a row, the route header, the card and the map handle their own keys
    const tag = e.target && e.target.tagName, isRange = tag === 'INPUT' && e.target.type === 'range';
    if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && !isRange)) return;
    if (isRange && !(e.key in keyDir)) return;
    if (e.code === 'Space') { setFly(!fly.on); e.preventDefault(); return; }
    if (e.key === 'PageDown') { jump(+1); e.preventDefault(); return; }
    if (e.key === 'PageUp') { jump(-1); e.preventDefault(); return; }
    const dir = keyDir[e.key]; if (!dir) return;
    e.preventDefault(); nudge(dir);
  });
  // the 3D view: a sideways drag moves along the route (right = forward), a drag that starts up or down, a two-finger drag,
  // a right-button or shift drag looks around (yaw and pitch); the wheel moves along the route; the look eases back when moving
  let drag = null; const pointers = new Set();
  canvas.addEventListener('pointerdown', e => {
    pointers.add(e.pointerId); if (e.button === 1) return;
    drag = { x: e.clientX, y: e.clientY, s: pos.s, yaw: v3.lookOffset(), pitch: v3.lookPitch(), axis: (e.button === 2 || e.shiftKey || pointers.size > 1) ? 'look' : null, id: e.pointerId };
    if (isPhone()) $('#hint3d').classList.add('seen');   // a phone shows the gesture hint once, until the first drag
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (pointers.size > 1 && drag.axis !== 'look') { drag.axis = 'look'; drag.x = e.clientX; drag.y = e.clientY; drag.yaw = v3.lookOffset(); drag.pitch = v3.lookPitch(); return; }
    if (!drag.axis && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) drag.axis = Math.abs(dx) >= Math.abs(dy) ? 'move' : 'look';
    if (drag.axis === 'look') v3.look(drag.yaw + (drag.x - e.clientX) / canvas.clientWidth * Math.PI, drag.pitch + (drag.y - e.clientY) / canvas.clientHeight * 1.2, true);
    else if (drag.axis === 'move' && R) { stopFly(); setS(drag.s + dx * SWIPE_M_PER_PX); }
  });
  const endDrag = e => { pointers.delete(e.pointerId); if (drag && e.pointerId === drag.id) drag = null; };
  canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', e => { if (!R) return; e.preventDefault(); stopFly(); setS(pos.s + (Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * WHEEL_M_PER_PX); }, { passive: false });

  // ------------------------------------------------------------ view modes: the plan with the 3D view as a thumbnail (map), the 3D view with the plan as a thumbnail (3d), side by side (split, desktops); and the phone sheet
  function setView(mode) {
    if (mode === 'both') mode = 'split';   // the earlier name in links
    viewMode = ['map', '3d', 'split'].includes(mode) ? mode : 'map';
    if (viewMode === 'split' && (isPhone() || window.innerWidth < 1100)) viewMode = '3d';   // side by side needs room for the panel beside half a plan
    for (const m of ['map', '3d', 'split']) $('#app').classList.toggle('view-' + m, m === viewMode);
    const to3d = viewMode !== '3d';
    $('#thumblbl').textContent = to3d ? '3D' : 'Map'; $('#thumbtap').setAttribute('aria-label', to3d ? '3D: switch to the 3D view' : 'Map: back to the plan');
    $('#thumbtap use').setAttribute('href', to3d ? '#i-cube' : '#i-map');
    $('#splitbtn').setAttribute('aria-pressed', String(viewMode === 'split'));
    if (viewMode === '3d') hidePlaceCard();
    v3.resize(); layoutVars();   // the canvas changed size: the camera's aspect follows at once, not at the next frame
    if (v2) { v2.refit(); setTimeout(() => { v2.refit(); v3.resize(); }, 240); }   // and again once the size transition has ended
    urlDirty = true;
  }
  $('#thumbtap').onclick = () => setView(viewMode === '3d' ? 'map' : '3d');
  $('#splitbtn').onclick = () => setView(viewMode === 'split' ? 'map' : 'split');
  const sheet = $('#sheet');
  function sheetHeight(st) {   // peek: the grip plus the route's summary, caption and controls (measured), or just the Explore heading; full stops under the search card
    if (st === 'half') return Math.round(window.innerHeight * 0.45);
    if (st === 'full') return Math.min(Math.round(window.innerHeight * 0.86), Math.round(window.innerHeight - $('#searchcard').getBoundingClientRect().bottom - 8));
    const nav = $('.navsticky'), grip = $('#sheetgrip').offsetHeight || 36;
    return sel.to && !$('#routebox').hidden ? grip + nav.offsetHeight + 2 : grip + ($('.exhead').offsetHeight || 64) + 8;
  }
  function setSheet(st) { sheetState = st; const h = sheetHeight(st); sheet.style.height = isPhone() ? h + 'px' : ''; $('#app').style.setProperty('--sheet-h', (isPhone() ? h : 0) + 'px'); $('#sheetbody').scrollTop = 0; }
  let sheetDrag = null;
  const grip = $('#sheetgrip');
  grip.addEventListener('pointerdown', e => { if (!isPhone()) return; sheetDrag = { y: e.clientY, h: sheet.getBoundingClientRect().height, moved: false }; sheet.classList.add('dragging'); try { grip.setPointerCapture(e.pointerId); } catch (err) {} });
  grip.addEventListener('pointermove', e => { if (!sheetDrag) return; const h = Math.max(60, Math.min(window.innerHeight * 0.9, sheetDrag.h + (sheetDrag.y - e.clientY))); if (Math.abs(sheetDrag.y - e.clientY) > 6) sheetDrag.moved = true; sheet.style.height = h + 'px'; });
  const endSheet = () => {
    if (!sheetDrag) return; sheet.classList.remove('dragging');
    if (!sheetDrag.moved) setSheet(sheetState === 'peek' ? 'half' : 'peek');
    else { const h = sheet.getBoundingClientRect().height; setSheet(['peek', 'half', 'full'].reduce((a, b) => Math.abs(sheetHeight(b) - h) < Math.abs(sheetHeight(a) - h) ? b : a)); }
    sheetDrag = null;
  };
  grip.addEventListener('pointerup', endSheet); grip.addEventListener('pointercancel', endSheet);
  window.addEventListener('resize', () => { if (viewMode === 'split' && (isPhone() || window.innerWidth < 1100)) setView('3d'); setSheet(sheetState); layoutVars(); if (v2) v2.refit(); });

  // ------------------------------------------------------------ share link, route.json, the URL
  function linkParams() {
    const p = new URLSearchParams();
    if (sel.from) p.set('from', sel.from.id); if (sel.to) p.set('to', sel.to.id);
    if (opts().stepFree) p.set('stepfree', '1'); if (opts().avoidLifts) p.set('nolifts', '1');
    if (R && pos.s > 0.05) { p.set('s', pos.s.toFixed(1)); p.set('lv', R.runs[pos.run].level); }   // the level too: at a ride boundary the same metre is on two floors
    if (viewMode !== 'map') p.set('view', viewMode);
    return p;
  }
  function updateUrl() { urlDirty = false; const q = linkParams().toString(); history.replaceState(null, '', q ? '?' + q : location.pathname); }
  $('#copy').onclick = async () => {
    if (!sel.to) { toast('Pick a destination first'); return; }
    const u = new URL(location.href); u.search = linkParams().toString(); u.hash = '';
    const link = u.toString(); let copied = false;
    try { await navigator.clipboard.writeText(link); copied = true; } catch (e) {}
    if (!copied) {
      const ta = document.createElement('textarea'); ta.value = link; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
      try { copied = document.execCommand('copy'); } catch (e) {} ta.remove();
    }
    toast(copied ? 'Link copied: ' + link : 'Copy the link from the address bar: ' + link, 6000);
  };
  $('#export').onclick = () => {
    if (!R) { toast('Plan a route first'); return; }
    const blob = new Blob([JSON.stringify(R.json, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `route-${dest.id}.json`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000); toast('route.json downloaded — see README for the Unity follower');
  };
  function applyUrl() {
    const p = new URLSearchParams(location.search);
    if (p.get('view')) setView(p.get('view'));
    for (const [id, key] of [['stepfree', 'stepfree'], ['nolifts', 'nolifts']]) { const on = p.get(key) === '1'; $('#' + id).classList.toggle('on', on); $('#' + id).setAttribute('aria-pressed', on); }
    const from = p.get('from'), to = p.get('to');
    if (from) { const pl = placeFromParam(from); if (pl) setField('from', pl); else toast(`Unknown start "${from}", using entrance 1`); }
    if (to) { const pl = placeFromParam(to); if (pl) setField('to', pl); else toast(`No destination matches "${to}"`); }
    route();
    const s = +p.get('s'); if (R && s > 0) setS(Math.min(s, R.length), p.get('lv') || null, { snap: true });
    if (p.get('play') === '1' && R) setFly(true);   // a link that flies the route as soon as it opens
    updateUrl();
  }

  // ------------------------------------------------------------ start
  status(venueSrc.url.includes('hints') && paths ? '' : `${venueSrc.url.includes('hints') ? '' : 'no hints'}${paths ? '' : ' no clearance paths'}`.trim());   // a quiet header; a word only when the package is incomplete
  {   // idle view before a route: look along the first entrance's corridor
    const n0 = V.nodes.get(V.entries[0]) || V.nodes.values().next().value, nb = (V.adj.get(n0.id) || []).map(a => V.nodes.get(a.to)).find(Boolean) || n0;
    v3.idleAt(n0, nb);
    if (v2) v2.showLevel(n0.level, true);
  }
  enableControls(false); showRouteBox(false); setView('map'); setSheet('peek'); layoutVars();
  $('#app').classList.add('loaded');   // the status line's job is done (a phone hides it from here on; a load error keeps it)
  applyUrl();
  if (v2) requestAnimationFrame(() => v2.refit());   // the plan fitted to the panel it really has (not the size it had before layout)
  if (!sel.to) inputs.to.focus();
  let lastNow = performance.now();
  v3.renderer.setAnimationLoop(now => {
    const dt = Math.min(0.2, (now - lastNow) / 1000); lastNow = now;
    flyTick(now, dt);
    v3.update(now);
    if (urlDirty && now > urlAt && !drag && !sheetDrag) updateUrl();
  });
  window.walkthrough = {
    V, manifest, places: entrancePlaces.concat(V.dests), plan: () => plan, timeline: () => R, seek: (s, lv) => setS(s, lv, { snap: true }), setS, nudge, jump, route, fly: setFly, setView,
    showLevel: v3.showLevel, scene: v3.scene, camera: v3.camera, renderer: v3.renderer, THREE, labels: v3.labels, look: a => v3.look(a, null, true), signs: v3.signs, pitch: v3.pitch, headerPx, panelFrac, map: v2 ? v2.map : null,
    frame: () => { const now = performance.now(); flyTick(now, 1 / 60); v3.update(now); },   // one animation step on demand (tests in a hidden pane, where requestAnimationFrame is paused)
    flyPause: ms => { fly.pauseUntil = performance.now() + (ms || 0); },   // hold the fly-through where it is (screenshots of a decision-point pause)
    setDest: id => { const d = V.dests.find(d => d.id === id) || entrancePlaces.find(e => e.id === id) || placeFromParam(id); if (d) choose('to', d); return !!d; },
    setStart: v => { const pl = placeFromParam(v); if (pl) { setField('from', pl); route(); } return !!pl; },
    pick: (lv, x, y) => pickPoint(lv, x, y), pickRoom: id => { const rm = roomIndex.get(id); if (rm) pickRoom(rm, rm.level); return !!rm; }, rooms: () => rooms, explore: openCat, categories: CATS,
    get debugCamera() { return v3.debugCamera; }, set debugCamera(c) { v3.debugCamera = c; },
    state: () => { const st = v3.state(); return { s: pos.s, run: pos.run, length: R ? R.length : 0, level: st.level, moving: st.moving, transition: st.transition, autoWalk: fly.on, arrivedHere: !!already, view: viewMode }; },
  };
})();
