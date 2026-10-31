/* The 2D view: the clean floor plans of ../plans2d drawn with Leaflet (CRS.Simple, one image overlay per level, loaded
   the first time a level is shown), the route polyline per level (the walked camera path, plus a dotted tail from where the
   walk stops to the door itself), start and destination pins,
   numbered step markers, lift / stair markers and one draggable position marker that snaps to the route: dragging it
   moves the shared "where I am" value; clicking the route jumps there. The marker lives in its own layer, so a redraw
   of the step markers never removes it under the finger. The map follows the position (level and pan, with padding
   for whatever overlaps the map) unless the viewer is dragging the marker, has just panned or zoomed, or picked a
   level pill. The rooms of rooms.json are invisible polygons over the plan: hovering outlines one, tapping it (or any
   other point of the plan) hands it to the page as a place to go to or start from. Exposes window.View2D(deps). */
window.View2D = function (deps) {
  const { el, levelsEl, msgEl, plans, PLANS, levels, esc, onScrub, onClickStep, overlaps, rooms, onPickRoom, onPickPoint, isThumb, labelOf } = deps;   // labelOf(room): the label of a room without a name ("Lift", "Unnamed office")
  let suppressPickUntil = 0;   // a tap right after the position marker was dragged is the drag's release, not a pick   // levels: [{id, name, floor}], onScrub(s, run, level), onClickStep(i), overlaps(): [{left, top, right, bottom}] of panels covering the map, rooms: rooms.json or null, onPickRoom(room, level), onPickPoint(level, x, y), isThumb(): the plan is the small thumbnail (no picking)
  const planOf = Object.fromEntries((plans.levels || []).map(l => [l.id, l.plan]));
  const missing = levels.map(l => l.id).filter(id => !planOf[id]);
  const map = L.map(el, { crs: L.CRS.Simple, minZoom: -3, maxZoom: 3, zoomSnap: 0.25, attributionControl: false, zoomControl: false, tap: false });
  // stacking, bottom up: the plan images, the room shapes, the route (Leaflet's own overlay pane), the direction chevrons, the markers.
  // Panes keep that order however often a level's image is removed and added again (an image added later would otherwise paint over the route).
  map.createPane('plans').style.zIndex = 350; map.createPane('rooms').style.zIndex = 380; map.createPane('chevrons').style.zIndex = 450;
  const ARROW_M = 10;   // a direction chevron on the route every so many metres
  L.control.zoom({ position: 'bottomright' }).addTo(map);   // bottom right, above the view thumbnail (the panel covers the top left, the level pills the top right); phones pinch instead
  const overlays = {}, roomLayers = {}, routeLayer = L.layerGroup().addTo(map), markerLayer = L.layerGroup().addTo(map), posLayer = L.layerGroup().addTo(map), pickLayer = L.layerGroup().addTo(map);
  let pick = null;   // {node: {level, x, y}, name}: the tapped place, marked until the card closes
  let level = null, R = null, plan = null, dest = null, startLabel = '', current = -1, posMarker = null, dragging = false, pos = null;
  let stepMarkers = [], lastPan = 0, panTimer = null, userUntil = 0;
  const USER_PAUSE_MS = 4000, PILL_PAUSE_MS = 6000, MARGIN = 40;
  const toLL = (lv, x, y) => { const p = planOf[lv]; return [p.size_px[1] - (p.origin_px[1] - y * p.pixels_per_metre), p.origin_px[0] + x * p.pixels_per_metre]; };
  const fromLL = (lv, ll) => { const p = planOf[lv]; return { x: (ll.lng - p.origin_px[0]) / p.pixels_per_metre, y: (p.origin_px[1] - (p.size_px[1] - ll.lat)) / p.pixels_per_metre }; };
  if (missing.length) { msgEl.textContent = `No 2D plan for ${missing.join(', ')} (plans2d/manifest.json)`; msgEl.style.display = 'block'; }
  map.on('dragstart zoomstart', () => { userUntil = performance.now() + USER_PAUSE_MS; });   // the viewer is looking around: no following for a moment
  const userBusy = () => performance.now() < userUntil || (map.dragging && map.dragging.moving && map.dragging.moving());
  function padding() {   // {tl: [x, y], br: [x, y]} pixels covered at the map's edges by what floats over it (the panel on the left, the search card on top, the sheet at the bottom), plus a margin
    const r = el.getBoundingClientRect(); let top = 0, bottom = 0, left = 0, right = 0; const T = 28;
    for (const o of (overlaps ? overlaps() : [])) {
      if (o.right <= r.left || o.left >= r.right || o.bottom <= r.top || o.top >= r.bottom) continue;
      const tall = (Math.min(o.bottom, r.bottom) - Math.max(o.top, r.top)) > r.height * 0.5, wide = (Math.min(o.right, r.right) - Math.max(o.left, r.left)) > r.width * 0.5;
      if (tall && !wide && o.left <= r.left + T) left = Math.max(left, o.right - r.left);          // a panel hugging the left edge
      else if (tall && !wide && o.right >= r.right - T) right = Math.max(right, r.right - o.left);  // ... or the right edge
      else if (o.top <= r.top + T) top = Math.max(top, o.bottom - r.top);                           // a card along the top
      else if (o.bottom >= r.bottom - T) bottom = Math.max(bottom, r.bottom - o.top);               // a sheet along the bottom
    }
    return { tl: [Math.min(left, r.width * 0.5) + MARGIN, Math.min(top, r.height * 0.5) + MARGIN], br: [Math.min(right, r.width * 0.5) + MARGIN, Math.min(bottom, r.height * 0.5) + MARGIN] };
  }
  function showLevel(lv, fit, byUser) {
    if (!planOf[lv]) return;
    if (byUser) userUntil = performance.now() + PILL_PAUSE_MS;
    if (level !== lv) {
      level = lv; const p = planOf[lv];
      for (const id in overlays) if (id !== lv && map.hasLayer(overlays[id])) map.removeLayer(overlays[id]);
      if (!overlays[lv]) overlays[lv] = L.imageOverlay(PLANS + p.image, [[0, 0], [p.size_px[1], p.size_px[0]]], { pane: 'plans' });   // lazily, once per level
      overlays[lv].addTo(map);
      showRooms(lv);
      levelsEl.querySelectorAll('button').forEach(b => { const on = b.dataset.level === lv; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
      draw(); placePos(); placePick();
    }
    if (fit) fitPlan();
  }
  function showRooms(lv) {   // the level's room polygons, built once per level: invisible until hovered, a tap picks the room
    for (const id in roomLayers) if (id !== lv && map.hasLayer(roomLayers[id])) map.removeLayer(roomLayers[id]);
    const L_ = rooms && rooms.levels && rooms.levels[lv]; if (!L_) return;
    if (!roomLayers[lv]) {
      const g = L.layerGroup();
      for (const rm of (L_.rooms || []).slice().sort((a, b) => (b.area_m2 || 0) - (a.area_m2 || 0))) {   // large rooms first: a room inside another is drawn on top, so a tap picks the smallest
        if (!rm.poly || rm.poly.length < 3) continue;
        const rings = [rm.poly].concat(rm.holes || []).map(ring => ring.map(([x, y]) => toLL(lv, x, y)));   // holes (a lobby walled off inside a room) are not part of the room: a tap there falls through
        const poly = L.polygon(rings, { pane: 'rooms', stroke: false, fill: true, fillColor: '#2563eb', fillOpacity: 0, interactive: true, bubblingMouseEvents: false, className: 'room-hover' });
        poly.on('mouseover', () => poly.setStyle({ fillOpacity: 0.14 })); poly.on('mouseout', () => poly.setStyle({ fillOpacity: 0 }));
        poly.on('click', e => { L.DomEvent.stop(e); if (onPickRoom && !(isThumb && isThumb())) onPickRoom(rm, lv); });
        poly.bindTooltip(esc(rm.name || (labelOf ? labelOf(rm) : 'Unnamed room')), { sticky: true, direction: 'top', opacity: 0.95 });
        g.addLayer(poly);
      }
      roomLayers[lv] = g;
    }
    roomLayers[lv].addTo(map);
  }
  map.on('click', e => {   // a tap on the plan itself (rooms, the route and markers stop their own clicks): a free point
    if (!level || !planOf[level] || !onPickPoint || (isThumb && isThumb()) || performance.now() < suppressPickUntil) return;
    const m = fromLL(level, e.latlng); onPickPoint(level, m.x, m.y);
  });
  function placePick() {
    pickLayer.clearLayers();
    if (!pick || pick.node.level !== level || !planOf[level]) return;
    L.marker(toLL(level, pick.node.x, pick.node.y), { icon: pinIcon('pick', '<svg><use href="#i-pin"/></svg>'), interactive: false, zIndexOffset: 900 }).bindTooltip(esc(pick.name), { permanent: true, direction: 'top', offset: [0, -12], className: 'pin' }).addTo(pickLayer);
  }
  function setPick(node, name) { pick = node ? { node, name: name || '' } : null; if (node && node.level !== level) showLevel(node.level, false); placePick(); }
  function fitPlan() { if (!overlays[level]) return; map.invalidateSize(); const pd = padding(); map.fitBounds(overlays[level].getBounds(), { paddingTopLeft: pd.tl, paddingBottomRight: pd.br }); }
  for (const l of levels.slice().sort((a, b) => b.floor - a.floor)) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = l.id; b.dataset.level = l.id; b.title = l.name; b.setAttribute('aria-label', l.name); b.setAttribute('aria-pressed', 'false');
    b.onclick = () => showLevel(l.id, false, true); levelsEl.appendChild(b);
  }
  // ---- the route on the current level
  const runsOn = lv => R ? R.runs.map((r, i) => ({ r, i })).filter(x => x.r.level === lv && x.r.pts.length > 1) : [];
  function nearestOnRuns(lv, x, y) {   // the nearest point of the level's runs to (x, y): {s, run, x, y, d}
    let best = null;
    for (const { r, i } of runsOn(lv)) {
      const P = r.pts;
      for (let k = 0; k + 1 < P.length; k++) {
        const a = P[k], b = P[k + 1], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L2)) : 0;
        const qx = a.x + t * dx, qy = a.y + t * dy, d = Math.hypot(x - qx, y - qy);
        if (!best || d < best.d) best = { s: a.s + t * (b.s - a.s), run: i, x: qx, y: qy, d };
      }
    }
    return best;
  }
  const pinIcon = (cls, text) => L.divIcon({ className: '', html: `<div class="stephit"><div class="stepmark ${cls}">${text}</div></div>`, iconSize: [36, 36], iconAnchor: [18, 18] });   // a 36 px hit area around a 22 px mark
  function pointAt(s, lv) {   // the point at s on the level's run containing it
    for (const { r } of runsOn(lv)) if (s >= r.s0 - 1e-6 && s <= r.s1 + 1e-6) return window.RouteGeom.pointOnRun(r, s);
    return null;
  }
  function draw() {
    routeLayer.clearLayers(); markerLayer.clearLayers(); stepMarkers = [];
    if (!R || !level || !planOf[level]) return;
    for (const { r } of runsOn(level)) {
      const line = L.polyline(r.pts.map(p => toLL(level, p.x, p.y)), { color: '#d62828', weight: 6, opacity: 0.9, lineJoin: 'round', lineCap: 'round' }).addTo(routeLayer);
      line.on('click', e => { const m = fromLL(level, e.latlng), q = nearestOnRuns(level, m.x, m.y); if (q) onScrub(q.s, q.run, level); L.DomEvent.stop(e); });
      for (const c of chevronsOn(r)) L.marker(toLL(level, c.x, c.y), { pane: 'chevrons', interactive: false, keyboard: false, icon: L.divIcon({ className: '', html: `<div class="chev" style="transform:rotate(${(90 - c.heading * 180 / Math.PI).toFixed(1)}deg)"><svg viewBox="0 0 16 16"><path d="M4 10l4-5 4 5"/></svg></div>`, iconSize: [16, 16], iconAnchor: [8, 8] }) }).addTo(routeLayer);
    }
    const N = plan.nodeOf, first = R.runs[0], firstPt = first.pts[0], last = plan.nodeOf(plan.route.nodes[plan.route.nodes.length - 1]);
    if (first.level === level) L.marker(toLL(level, firstPt.x, firstPt.y), { icon: pinIcon('start', '<svg><use href="#i-dot"/></svg>'), interactive: false }).bindTooltip(esc(startLabel || 'Start'), { permanent: true, direction: 'top', offset: [0, -12], className: 'pin' }).addTo(markerLayer);
    if (last.level === level) L.marker(toLL(level, R.arrive.door.x, R.arrive.door.y), { icon: pinIcon('arrive', '<svg><use href="#i-flag"/></svg>'), interactive: false }).bindTooltip(esc(dest.name), { permanent: true, direction: 'top', offset: [0, -12], className: 'pin' }).addTo(markerLayer);
    const fin = R.runs[R.runs.length - 1], end = fin.pts[fin.pts.length - 1], tail = R.arrive.tail || [R.arrive.door];   // the last metres to the door itself, dotted, along the path the arrival cut removed (the walk stops short of the door, turned to it)
    if (fin.level === level && last.level === level && Math.hypot(R.arrive.door.x - end.x, R.arrive.door.y - end.y) > 0.2) L.polyline([end].concat(tail).map(p => toLL(level, p.x, p.y)), { color: '#d62828', weight: 4, opacity: 0.75, dashArray: '1 9', lineCap: 'round', interactive: false }).addTo(routeLayer);
    plan.steps.forEach((st, i) => {
      if (st.kind === 'arrive' || st.level !== level) return;
      const ride = st.kind === 'lift' || st.kind === 'stairs', n = N(st.node);
      const q = ride && n ? { x: n.x, y: n.y } : pointAt(R.stepS[i], st.level);
      if (!q) return;
      const glyph = ride ? `<svg><use href="#i-${st.kind}"/></svg>` : String(i + 1);
      const m = L.marker(toLL(level, q.x, q.y), { icon: pinIcon(st.kind + (i === current ? ' current' : ''), glyph), zIndexOffset: 100 }).addTo(markerLayer);
      m.bindTooltip(ride ? `${st.kind === 'lift' ? 'Lift' : 'Stairs'} → ${st.toLevel}` : esc(st.text.replace(/\s*\(\d+ m\)$/, '')), { direction: 'right', offset: [14, 0] });
      m.on('click', () => onClickStep(i));
      stepMarkers.push({ i, m, cls: st.kind, text: glyph });
    });
  }
  function chevronsOn(run) {   // points every ARROW_M along a run with the heading there, clear of its ends
    const out = [], P = run.pts; if (P.length < 2) return out;
    let next = Math.min(ARROW_M, Math.max(3, (run.s1 - run.s0) / 2));
    for (let k = 0; k + 1 < P.length; k++) {
      const a = P[k], b = P[k + 1], L_ = b.s - a.s; if (L_ < 1e-6) continue;
      while (next >= a.s - run.s0 && next <= b.s - run.s0 && run.s1 - run.s0 - next >= 3) {
        const t = (next - (a.s - run.s0)) / L_; out.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), heading: Math.atan2(b.y - a.y, b.x - a.x) }); next += ARROW_M;
      }
      if (next > b.s - run.s0 && next > run.s1 - run.s0 - 3) break;
    }
    return out;
  }
  function placePos() {   // the position marker on the shown level (hidden while the position is on another level)
    if (!pos || !R || !planOf[level] || !R.runs[pos.run] || R.runs[pos.run].level !== level) { if (posMarker) posMarker.setOpacity(0); return; }
    const ll = toLL(level, pos.x, pos.y);
    if (!posMarker) {
      posMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="posmark"><div class="dir"></div><div class="dot"></div></div>', iconSize: [44, 44], iconAnchor: [22, 22] }), draggable: true, zIndexOffset: 1000, title: 'Drag along the route' }).addTo(posLayer);
      posMarker.on('dragstart', () => { dragging = true; });
      posMarker.on('drag', e => { const m = fromLL(level, e.target.getLatLng()), q = nearestOnRuns(level, m.x, m.y); if (!q) return; e.target.setLatLng(toLL(level, q.x, q.y)); onScrub(q.s, q.run, level); });
      posMarker.on('dragend', () => { dragging = false; suppressPickUntil = performance.now() + 400; });
      posMarker.on('remove', () => { dragging = false; });
    } else posMarker.setLatLng(ll);
    posMarker.setOpacity(1);
    const d = posMarker.getElement() && posMarker.getElement().querySelector('.dir');
    if (d) d.style.transform = `rotate(${(90 - (pos.heading || 0) * 180 / Math.PI).toFixed(1)}deg)`;
  }
  function setRoute(R_, plan_, dest_, startLabel_) {
    R = R_; plan = plan_; dest = dest_; startLabel = startLabel_ || ''; current = -1; pos = null; dragging = false; userUntil = 0;
    if (posMarker) { posLayer.removeLayer(posMarker); posMarker = null; }
    levelsEl.querySelectorAll('button').forEach(b => { const on = !!(plan && plan.levels.includes(b.dataset.level)); b.classList.toggle('onroute', on); const nm = levels.find(l => l.id === b.dataset.level); b.title = (nm ? nm.name : b.dataset.level) + (on ? ' (on the route)' : ''); b.setAttribute('aria-label', b.title); });
    if (!R) { draw(); return; }
    const lv0 = R.runs[0].level; if (level !== lv0) showLevel(lv0, false); else draw();
    const pts = R.runs.filter(r => r.level === level).flatMap(r => r.pts.map(p => toLL(level, p.x, p.y)));
    map.invalidateSize(); const pd = padding();
    if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: pd.tl, paddingBottomRight: pd.br, maxZoom: 1 }); else if (pts.length === 1) map.setView(pts[0], 0.5);
  }
  function panTo(ll) { const pd = padding(); map.panInside(ll, { paddingTopLeft: pd.tl, paddingBottomRight: pd.br }); }
  function setPosition(p) {   // p: {s, run, x, y, level, heading}; the map follows unless the viewer is dragging the marker, looking around or chose a level
    pos = p; if (!R) return;
    const busy = dragging || userBusy();
    if (p.level !== level) { if (busy) { placePos(); return; } showLevel(p.level, false); }
    placePos();
    if (busy) return;
    const now = performance.now(), ll = toLL(level, p.x, p.y);
    if (now - lastPan > 120) { lastPan = now; clearTimeout(panTimer); panTimer = null; panTo(ll); }
    else if (!panTimer) panTimer = setTimeout(() => { panTimer = null; if (pos && R && !dragging && !userBusy() && R.runs[pos.run] && R.runs[pos.run].level === level) { lastPan = performance.now(); panTo(toLL(level, pos.x, pos.y)); } }, 130);   // a trailing pan: the last position of a burst is never left behind
  }
  function setCurrentStep(i) {   // restyle the step marks only: the position marker is untouched
    if (i === current) return; current = i;
    for (const sm of stepMarkers) sm.m.setIcon(pinIcon(sm.cls + (sm.i === current ? ' current' : ''), sm.text));
  }
  function showDestination(x, y, lv, name) {   // "already here": the destination pin alone
    setRoute(null); showLevel(lv, false);
    L.marker(toLL(lv, x, y), { icon: pinIcon('arrive', '<svg><use href="#i-flag"/></svg>'), interactive: false }).bindTooltip(esc(name), { permanent: true, direction: 'top', offset: [0, -12], className: 'pin' }).addTo(markerLayer);
    map.invalidateSize(); map.setView(toLL(lv, x, y), 1);
  }
  function refit() { map.invalidateSize(); if (R) { const pts = R.runs.filter(r => r.level === level).flatMap(r => r.pts.map(p => toLL(level, p.x, p.y))); const pd = padding(); if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: pd.tl, paddingBottomRight: pd.br, maxZoom: 1 }); } else fitPlan(); }
  return { map, showLevel, setRoute, setPosition, setCurrentStep, showDestination, refit, setPick, level: () => level, invalidate: () => map.invalidateSize(), fit: fitPlan };
};
