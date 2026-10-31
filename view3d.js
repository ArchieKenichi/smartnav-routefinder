/* The 3D view: rtp.glb (build_model.py) in three.js, first person along the route's camera path (camera-paths.json via
   route_export.js), the route ribbon and pins, the signs the route needs (destination, hinted landmarks, the lifts /
   stairs / entrance used) mounted at the builder's sign mounts, the arrival composition (door + sign in view) and a
   short fade at lifts and stairs. The view follows one position in metres set by the page (setTarget): the camera
   snaps to it with ~120 ms smoothing, no walking-speed easing. Exposes window.View3D(deps) and window.RouteGeom. */
window.RouteGeom = {
  pointOnRun(run, s) {
    const P = run.pts;
    if (s <= P[0].s) return { x: P[0].x, y: P[0].y, k: P[0].k };
    for (let i = 1; i < P.length; i++) if (s <= P[i].s) { const a = P[i - 1], b = P[i], f = (s - a.s) / ((b.s - a.s) || 1); return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, k: P[i].k }; }
    const e = P[P.length - 1]; return { x: e.x, y: e.y, k: e.k };
  },
  segHeading(run, atEnd, fallback) { const P = run.pts; if (P.length < 2) return fallback || 0; const a = atEnd ? P[P.length - 2] : P[0], b = atEnd ? P[P.length - 1] : P[1]; return Math.atan2(b.y - a.y, b.x - a.x); },
};
window.View3D = function (deps) {
  'use strict';
  const { canvas, manifest, V, paths, ui } = deps;   // ui: { headerPx(), panelFrac(), levelName(id), borrowedFrom, borrowedCaption, onLevel(lv) }
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const LOOK_AHEAD_M = 2.5;     // the camera looks at the path this far ahead: smooth turns at corners
  const TURN_RATE = 6.0;        // yaw follows the look-ahead with this time constant (1/s)
  const SMOOTH_S = 0.12;        // the camera reaches a new position with this time constant (s): immediate, not a walk
  const NEAR_PLANE = 0.05;
  const FADE_MS = 350;          // a ride scrubbed through: a short fade, the level switches at its darkest point
  const { pointOnRun, segHeading } = window.RouteGeom;
  const zOf = Object.fromEntries(manifest.levels.map(l => [l.id, l.z]));
  const EYE = RouteExport.EYE_M;
  const levelName = ui.levelName;
  const toWorld = (x, y, z) => new THREE.Vector3(x, z, -y);   // venue (x east, y north, z up) -> three.js (Y up)
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

  // ------------------------------------------------------------ scene
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xdfe6ea);
  scene.fog = new THREE.Fog(0xdfe6ea, 40, 180);
  const camera = new THREE.PerspectiveCamera(70, 1, NEAR_PLANE, 500);
  scene.add(new THREE.HemisphereLight(0xcfe3f5, 0x8a8f94, 0.9));                       // pale-blue sky, grey ground
  const sun = new THREE.DirectionalLight(0xfff6ec, 0.6); sun.position.set(60, 120, 40); scene.add(sun);   // no shadows: performance
  const lamp = new THREE.PointLight(0xfff1dc, 0.45, 11, 1.6); scene.add(lamp);         // a soft ceiling light that follows the camera
  const lin = hex => new THREE.Color(hex).convertSRGBToLinear();
  {   // a small procedural room as environment map: the polished floor and the glass pick up reflections from it
      const env = new THREE.Scene(); env.background = new THREE.Color(0xdfe6ea);
      const room = new THREE.Mesh(new THREE.BoxGeometry(40, 12, 40), new THREE.MeshStandardMaterial({ color: lin(0xcfd3d4), side: THREE.BackSide, roughness: 1 })); env.add(room);
      for (let i = 0; i < 6; i++) { const p = new THREE.Mesh(new THREE.PlaneGeometry(4, 2), new THREE.MeshBasicMaterial({ color: 0xffffff })); p.position.set(-15 + i * 6, 5.9, 0); p.rotation.x = Math.PI / 2; env.add(p); }
      env.add(new THREE.HemisphereLight(0xffffff, 0x888888, 1.4));
      const pmrem = new THREE.PMREMGenerator(renderer); scene.environment = pmrem.fromScene(env, 0.04).texture; pmrem.dispose();
  }
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const pr = renderer.getPixelRatio();
    if (canvas.width !== Math.floor(w * pr) || canvas.height !== Math.floor(h * pr)) {   // as setSize() sets the buffer: no resize every frame at a fractional pixel ratio
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.fov = w < h ? 80 : 70; camera.updateProjectionMatrix();
    }
  }

  // ------------------------------------------------------------ model
  const levelObj = {}, ENV_STRENGTH = { corridor: 0.55, facade_glass: 1.0, glass_pane: 1.0, lift: 0.8, metal: 0.8, frame_dark: 0.4 };
  const overlay = {}, labels = {}, marks = {};
  async function load() {
    const gltf = await new Promise((res, rej) => new THREE.GLTFLoader().load((window.RTP_GLB_URL || 'rtp.glb'), res, undefined, rej));
    scene.add(gltf.scene);
    gltf.scene.traverse(o => {
      if (zOf[o.name] != null && !levelObj[o.name]) levelObj[o.name] = o;
      if (o.isMesh && o.material) {
        const m = o.material, name = m.name || '';
        m.envMapIntensity = ENV_STRENGTH[name] != null ? ENV_STRENGTH[name] : 0.25;
        if (name === 'downlight' || name === 'skylight') { m.emissiveIntensity = name === 'skylight' ? 1.2 : 2.0; m.toneMapped = false; }
        if (m.map) m.map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      }
    });
    for (const id in zOf) if (!levelObj[id]) throw new Error(`The model has no node for level ${id}; rebuild it with build_model.py`);
    // Polished floor: a planar Reflector per level over the corridor plate, blended over the terrazzo with a Fresnel-weighted
    // alpha (faint straight down, strong at grazing angles), so ceiling lights, balustrades and glass mirror in the floor.
    if (THREE.Reflector) {
      const shader = {
        uniforms: { color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null }, strength: { value: 0.16 }, grazing: { value: 0.62 } },
        vertexShader: `uniform mat4 textureMatrix; varying vec4 vUv; varying vec3 vWorldPos;
          #include <common>
          #include <logdepthbuf_pars_vertex>
          void main() { vUv = textureMatrix * vec4(position, 1.0); vec4 wp = modelMatrix * vec4(position, 1.0); vWorldPos = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp;
          #include <logdepthbuf_vertex>
          }`,
        fragmentShader: `uniform vec3 color; uniform sampler2D tDiffuse; uniform float strength; uniform float grazing; varying vec4 vUv; varying vec3 vWorldPos;
          #include <logdepthbuf_pars_fragment>
          void main() {
          #include <logdepthbuf_fragment>
          vec4 base = texture2DProj(tDiffuse, vUv); vec3 v = normalize(cameraPosition - vWorldPos);
          float fres = pow(1.0 - clamp(v.y, 0.0, 1.0), 2.0); gl_FragColor = vec4(base.rgb * color, mix(strength, grazing, fres));
          #include <tonemapping_fragment>
          #include <encodings_fragment>
          }`,
      };
      const dpr = renderer.getPixelRatio(), rw = Math.round(Math.min(1280, window.innerWidth * dpr * 0.75)), rh = Math.round(Math.min(960, window.innerHeight * dpr * 0.75));
      for (const id in levelObj) {
        levelObj[id].traverse(o => {
          if (!o.isMesh || !o.material || o.material.name !== 'corridor') return;
          const pos = o.geometry.attributes.position, idx = o.geometry.index, pts = [], top = [];
          for (let t = 0; t < idx.count; t += 3) {     // the plate's top faces (normal +Y) become the mirror plane, in the plane's local XY
            const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
            const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a), bx = pos.getX(b), bz = pos.getZ(b), cx = pos.getX(c), cz = pos.getZ(c);
            const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);   // y component of (b-a) x (c-a)
            if (ny <= 1e-6) continue;
            top.push(ay); pts.push(ax, -az, 0, bx, -bz, 0, cx, -cz, 0);
          }
          if (!pts.length) return;
          const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
          const mirror = new THREE.Reflector(g, { color: 0xd6d6d4, textureWidth: rw, textureHeight: rh, clipBias: 0.003, shader });
          mirror.rotation.x = -Math.PI / 2; mirror.position.y = Math.max(...top) + 0.004;
          mirror.material.transparent = true; mirror.material.depthWrite = false; mirror.material.name = 'corridor_reflector'; mirror.renderOrder = 0.5;
          o.parent.add(mirror);
        });
      }
    }
    for (const id in zOf) { overlay[id] = new THREE.Group(); labels[id] = new THREE.Group(); marks[id] = new THREE.Group(); scene.add(overlay[id], labels[id], marks[id]); }
    // doors whose position was guessed: the whole corridor-facing wall gets a dashed amber outline (the translucent
    // panel in the opening itself is in the model, material door_uncertain)
    const dashed = new THREE.LineDashedMaterial({ color: lin(0xd97706), dashSize: 0.35, gapSize: 0.2 });
    for (const u of manifest.uncertain_doors || []) {
      const [a, b] = u.wall_segment, ox = u.outward[0] * 0.14, oy = u.outward[1] * 0.14, z0 = u.z + 0.05, z1 = u.z + (u.wall_height || 3);
      const pts = [[a[0] + ox, a[1] + oy, z0], [b[0] + ox, b[1] + oy, z0], [b[0] + ox, b[1] + oy, z1], [a[0] + ox, a[1] + oy, z1], [a[0] + ox, a[1] + oy, z0]].map(p => toWorld(...p));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), dashed); line.computeLineDistances();
      marks[u.level].add(line);
    }
    marker = pin(0, 0, 0, 'next'); marker.visible = false; scene.add(marker);
  }

  // ------------------------------------------------------------ signs (the sign policy: unchanged from the walkthrough)
  // Not one per room: the route's destination, the landmarks its hints name, and the lifts, stairs and entrance it uses,
  // built per route from the venue data, mounted above the relevant opening on the corridor side (never in the doorway),
  // short names where the title has a bracketed one, faded out when the camera is within 1.5 m.
  const neighbourOf = id => { const nb = (V.adj.get(id) || []).find(n => n.edge.type === 'walk'); return nb ? V.nodes.get(nb.to) : null; };
  const SIGN_LINE_M = 0.3, SIGN_MAX_W_M = 2.4, SIGN_MAX_W_HANGING_M = 2.4, SIGN_TOP_MAX_M = 2.95, SIGN_HANG_H = 2.3, SIGN_HANG_BACK_M = 0.8, SIGN_FADE_NEAR = 1.5, SIGN_FADE_FAR = 2.6;
  const BILLBOARD_COS = 0.5;   // a destination plate seen more than 60 degrees off its normal from the arrival spot becomes a billboard
  const CLEAN_OVERRIDES = { 'Tank / Reading / Refence Room': 'Reading Room', 'Discussion Room 1 - SRC II': 'Discussion Room 1', 'Discussion Room 2 - SRC II': 'Discussion Room 2' };
  const bracket = n => { const m = String(n).match(/\[([^\]]+)\]/); return m ? m[1].trim() : null; };
  const plainName = n => String(n).replace(/\s*\[[^\]]*\]/g, '').replace(/\s*\(.*?\)/g, '').replace(/\xa0/g, ' ').replace(/\s+/g, ' ').trim();
  const displayName = n => CLEAN_OVERRIDES[plainName(n).replace(/\s*-\s*L\d$/, '').replace(/\s*@\s*Level \d+$/, '')] || plainName(n).replace(/\s*-\s*L\d$/, '').replace(/\s*@\s*Level \d+$/, '');   // "Conference Room - L6" -> "Conference Room" (the drafting's cleaning, without its abbreviation step)
  const shortName = n => bracket(n) || displayName(n);
  const FONT = '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', SIGN_MIN_SCALE = 0.55, SIGN_OVERFLOW_M = 0.3;
  function tagSprite(main, subs, bg, flat, maxW) {
    const c = document.createElement('canvas'), ctx = c.getContext('2d');
    const limit = Math.floor((maxW || SIGN_MAX_W_M) / SIGN_LINE_M * 64) - 40, extra = Math.floor(SIGN_OVERFLOW_M / SIGN_LINE_M * 64);
    const font = (px, weight) => `${weight} ${px}px ${FONT}`;
    const wrapAt = (text, f, maxPx) => {   // by words; a word wider than the line stays whole on its own line (never cut)
      ctx.font = f; const lines = []; let line = '';
      for (const word of text.split(' ')) { const t = line ? line + ' ' + word : word; if (!line || ctx.measureText(t).width <= maxPx) line = t; else { lines.push(line); line = word; } }
      lines.push(line); return lines;
    };
    const fits = (lines, f, maxPx) => { ctx.font = f; return lines.every(l => ctx.measureText(l).width <= maxPx); };
    // the largest font scale (1 .. 0.55) at which every block wraps within its lines and width; at 0.55 the plate may take more lines, then widen up to 0.3 m, then simply grow
    const blocks = [{ text: main, px: 40, weight: 600, maxLines: 3, h: 52 }, ...(subs || []).map(t => ({ text: t, px: 26, weight: 500, maxLines: 2, h: 34 }))];
    let scale = 1, maxPx = limit, rows = null, overflow = 0;
    for (let s = 1; s >= SIGN_MIN_SCALE - 1e-6 && !rows; s = +(s - 0.05).toFixed(2)) {
      const out = []; let ok = true;
      for (const b of blocks) { const f = font(Math.round(b.px * s), b.weight), lines = wrapAt(b.text, f, maxPx); if (lines.length > b.maxLines || !fits(lines, f, maxPx)) { ok = false; break; } for (const l of lines) out.push({ t: l, font: f, h: Math.round(b.h * s) }); }
      if (ok) { rows = out; scale = s; }
    }
    if (!rows) {   // still too wide at 55 %: more lines, then a wider plate (up to 0.3 m past its span), then just as wide as the widest word, however many lines that takes (the last pass always yields rows)
      scale = SIGN_MIN_SCALE;
      let widest = 0; for (const b of blocks) { ctx.font = font(Math.round(b.px * scale), b.weight); for (const wd of b.text.split(' ')) widest = Math.max(widest, ctx.measureText(wd).width); }
      const widens = [0, extra, Math.max(extra, Math.ceil(widest) - limit)];
      for (let wi = 0; wi < widens.length && !rows; wi++) {
        const widen = widens[wi], last = wi === widens.length - 1, out = []; let ok = true;
        for (const b of blocks) { const f = font(Math.round(b.px * scale), b.weight), lines = wrapAt(b.text, f, limit + widen); if (!last && (lines.length > b.maxLines + 2 || !fits(lines, f, limit + widen))) { ok = false; break; } for (const l of lines) out.push({ t: l, font: f, h: Math.round(b.h * scale) }); }
        if (ok) { rows = out; overflow = Math.min(widen, extra) / 64 * SIGN_LINE_M; }
      }
    }
    let wpx = 0; for (const r of rows) { ctx.font = r.font; wpx = Math.max(wpx, ctx.measureText(r.t).width); }
    if (wpx > limit) overflow = (wpx - limit) / 64 * SIGN_LINE_M;
    const wdt = Math.ceil(wpx) + 40, hgt = rows.reduce((a, r) => a + r.h, 0) + 12;
    c.width = wdt; c.height = hgt;
    ctx.fillStyle = bg; const r = 14; ctx.beginPath(); ctx.moveTo(r, 0); ctx.lineTo(wdt - r, 0); ctx.quadraticCurveTo(wdt, 0, wdt, r); ctx.lineTo(wdt, hgt - r); ctx.quadraticCurveTo(wdt, hgt, wdt - r, hgt); ctx.lineTo(r, hgt); ctx.quadraticCurveTo(0, hgt, 0, hgt - r); ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; let y = 6;
    for (const row of rows) { ctx.font = row.font; ctx.fillText(row.t, 20, y + row.h / 2); y += row.h; }
    const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding; tex.minFilter = THREE.LinearFilter;
    const W = SIGN_LINE_M * wdt / 64, H = SIGN_LINE_M * hgt / 64;
    if (flat) {   // a plate in the wall plane, so it never sinks into the wall at an angle (a sprite would)
      const m = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
      m.renderOrder = 2; Object.assign(m.userData, { height: H, width: W, scale, overflow_m: +overflow.toFixed(2), ellipsis: false }); return m;
    }
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false }));
    sp.scale.set(W, H, 1); sp.renderOrder = 2; Object.assign(sp.userData, { height: H, width: W, scale, overflow_m: +overflow.toFixed(2), ellipsis: false });
    return sp;
  }
  // where a sign for a node hangs: above its opening (door, lift / stair entry, entrance) on the corridor side, else above the node
  const openingOf = new Map();
  for (const o of manifest.openings || []) {
    if (!o.node || !o.dir) continue;
    if ((o.kind === 'door' && o.own_wall) || o.kind === 'lift' || o.kind === 'stairs' || o.kind === 'entrance') for (const id of o.nodes || [o.node]) if (!openingOf.has(id)) openingOf.set(id, o);
  }
  const hangingOf = new Map((manifest.hanging || []).map(h => [h.node, h]));
  function signPlace(node, way) {   // -> position, height and the direction the plate faces (into the corridor / toward the approach); way: for a free destination (not in the venue graph) the unit direction { x, y } it is approached from and how far back along it the plate hangs (back, default SIGN_HANG_BACK_M)
    const nb = way ? null : neighbourOf(node.id), o = openingOf.get(node.id);
    let dx = 0, dy = 0;
    if (nb) { const L = Math.hypot(nb.x - node.x, nb.y - node.y) || 1; dx = (nb.x - node.x) / L; dy = (nb.y - node.y) / L; }
    else if (way) { dx = way.x; dy = way.y; }
    if (o && o.sign) { const s = o.sign, off = s.hanging ? 0 : s.face_m + 0.03, ox = s.x != null ? s.x : o.x, oy = s.y != null ? s.y : o.y, d = s.dir || o.dir; return { x: ox + s.nx * off, y: oy + s.ny * off, h: s.h || 2.55, nx: s.nx, ny: s.ny, dx: d[0], dy: d[1], free: s.free_m, hanging: !!s.hanging }; }   // just in front of the wall's real face, within the free span along it (s.x/y/dir: a mount moved to another wall; s.hanging: a plate hanging in the corridor before a door whose both sides are inside a room or a box, at x, y itself)
    if (o) { let nx = -o.dir[1], ny = o.dir[0]; if (nx * dx + ny * dy < 0) { nx = -nx; ny = -ny; } return { x: o.x + nx * 0.13, y: o.y + ny * 0.13, h: 2.55, nx, ny }; }
    const hg = hangingOf.get(node.id);
    if (hg) return { x: hg.x, y: hg.y, h: hg.h || SIGN_HANG_H, nx: hg.nx, ny: hg.ny, dx: hg.ny, dy: -hg.nx, free: hg.free_m };
    if (nb || way) { const back = way && way.back != null ? way.back : SIGN_HANG_BACK_M; return { x: node.x + dx * back, y: node.y + dy * back, h: SIGN_HANG_H, nx: dx, ny: dy }; }   // no wall of its own (a zone's door, a point off any wall): a hanging plate before the spot, facing the way in, clear of the neighbours' walls the spot touches
    return { x: node.x, y: node.y, h: 2.3 };
  }
  const signed = new Set();
  function addSign(node, main, subs, bg, extra, place) {   // one sign per place: `extra` nodes (the rest of a lift bank or toilet cluster) count as signed too
    if (!node || signed.has(node.id)) return;
    signed.add(node.id); for (const id of extra || []) signed.add(id);
    const p = place || signPlace(node), hanging = !openingOf.has(node.id) || !!p.hanging;
    const span = p.free ? p.free[1] - p.free[0] - 0.1 : null;   // the plate must not run through a side wall: no wider than the free span, and shifted along the wall to fit in it
    const sp = tagSprite(main, subs, bg || 'rgba(107,45,143,0.92)', p.nx != null, p.maxW || (span != null ? Math.max(0.6, Math.min(SIGN_MAX_W_M, span)) : (hanging ? SIGN_MAX_W_HANGING_M : undefined)));
    const H = sp.userData.height, h = Math.min(p.h, SIGN_TOP_MAX_M - H + SIGN_LINE_M / 2);   // a tall sign hangs lower, under the ceiling plate
    const zc = zOf[node.level] + h + (H - SIGN_LINE_M) / 2;
    let px = p.x, py = p.y;
    if (p.free && p.dx != null) { const W = sp.userData.width, shift = Math.max(p.free[0] + 0.05 + W / 2, Math.min(p.free[1] - 0.05 - W / 2, 0)); px += p.dx * shift; py += p.dy * shift; sp.userData.shift = +shift.toFixed(2); }
    sp.position.copy(toWorld(px, py, zc));
    if (p.nx != null) sp.lookAt(toWorld(px + p.nx, py + p.ny, zc));   // face the corridor
    sp.userData.node = node.id; sp.userData.text = main; sp.userData.nx = p.nx; sp.userData.ny = p.ny; labels[node.level].add(sp);
    return sp;
  }
  const nearestOnRing = (ring, px, py) => {   // nearest point of a polygon ring ([[x, y], ...]) to (px, py)
    let best = null;
    for (let i = 0; i + 1 < ring.length; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[i + 1], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
      const x = ax + t * dx, y = ay + t * dy, d = Math.hypot(px - x, py - y);
      if (!best || d < best.d) best = { x, y, d };
    }
    return best;
  };
  const zonesOf = new Map(); for (const zn of manifest.zones || []) { if (!zonesOf.has(zn.id)) zonesOf.set(zn.id, []); zonesOf.get(zn.id).push(zn); }
  function clearSigns() { signed.clear(); for (const id in labels) for (const o of [...labels[id].children]) labels[id].remove(o); }
  const segDist = (px, py, a, b) => { const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / L2)) : 0; return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy)); };
  // The hints were drafted by hints/draft_hints.py: clauses joined by ", " in the forms "Pass X on your left", "X on your
  // right", "X straight ahead", "X ahead", "X left" (after a comma), "Toilets on both sides", "Keep left around the lift
  // core", "Lifts / Stairs / Building exit straight ahead", "continue straight", "more ahead". Landmark names in them are
  // the display names clean_title() makes from the MazeMap titles (" - L6" and "@ Level N" stripped, the [abbreviation]
  // used when the full name is long, a few overrides), so the same cleaning is applied to the destinations before a
  // whole-name comparison: a hint naming "Meeting Room 4.4" never tags "Meeting Room", nor the same name on another level.
  function cleanTitle(title) {   // hints/draft_hints.py clean_title()
    const t = String(title).replace(/\xa0/g, ' ').replace(/\s*\(RTP\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    const m = t.match(/\[([^\]]+)\]/);
    let rest = t.replace(/\s*\[[^\]]+\]/g, ' ').replace(/\s+/g, ' ').trim().replace(/\s*-\s*L\d$/, '').replace(/\s*@\s*Level \d+$/, '');
    if (m && rest.length > 24) rest = (m[1].trim() + ' ' + t.slice(m.index + m[0].length).trim().replace(/\s*@\s*Level \d+$/, '')).trim();
    return CLEAN_OVERRIDES[rest] || rest;
  }
  const norm = s => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
  function hintPhrases(text) {   // -> [{kind: 'room' | 'toilet' | 'lift' | 'stairs' | 'exit', name, ahead}]
    const out = [];
    for (let c of String(text).split(/,\s*/)) {
      c = c.trim().replace(/\.$/, '');
      if (!c || /^\(/.test(c) || /^(take the |keep (left|right) around|continue straight$|more ahead$)/i.test(c)) continue;
      let m, name, ahead = false;
      if ((m = c.match(/^pass (.+?) on your (left|right)$/i))) name = m[1];
      else if ((m = c.match(/^(.+?) on your (left|right)$/i))) name = m[1];
      else if ((m = c.match(/^(.+?) on both sides$/i))) name = m[1];
      else if ((m = c.match(/^(.+?) (?:straight )?ahead$/i))) { name = m[1]; ahead = true; }
      else if ((m = c.match(/^(.+?) (left|right)$/i))) name = m[1];
      else continue;
      name = name.replace(/^the /i, '').trim(); const low = norm(name);
      if (low === 'toilets' || low === 'toilet') out.push({ kind: 'toilet', ahead });
      else if (low === 'lifts' || low === 'lift') out.push({ kind: 'lift', ahead });
      else if (low === 'stairs' || low === 'stair') out.push({ kind: 'stairs', ahead });
      else if (low === 'building exit') out.push({ kind: 'exit', ahead });
      else if (low !== 'lift core' && low !== 'more' && low.length >= 3) out.push({ kind: 'room', name, ahead });
    }
    return out;
  }
  const LANDMARK_BESIDE_M = 16, LANDMARK_AHEAD_M = 30, ZONE_WALL_M = 8, ZONE_PLATE_OFF_M = 0.3, FIXTURE_NEAR_M = 10, CLUSTER_M = 6;
  function findLandmark(name, level, a, b, ahead) {   // the destination whose display name is the phrase: on the hint's level with its door nearest the hinted edge, or an area (zone, big room) that reaches this level; `far`: its door is beyond the limit
    const want = norm(name); let best = null;
    for (const d of V.dests) {
      const names = [cleanTitle(d.name), plainName(d.name), bracket(d.name), ...(d.aliases || [])].filter(n => n && n.length >= 3).map(norm);
      if (!names.includes(want)) continue;
      const onLevel = d.node.level === level, area = (zonesOf.get(d.id) || []).some(z => z.level === level);
      if (!onLevel && !area) continue;
      const dist = onLevel ? segDist(d.node.x, d.node.y, a, b) : Infinity;
      if (!best || dist < best.dist) best = { d, dist, far: dist > (ahead ? LANDMARK_AHEAD_M : LANDMARK_BESIDE_M) };
    }
    return best;
  }
  function zoneWallSign(d, a, b) {   // an area named by a hint but entered far away (a zone, the Foyer, NTUpreneur): its plate hangs on the area's wall beside the hinted edge
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2; let best = null;
    for (const zn of zonesOf.get(d.id) || []) { if (zn.level !== a.level) continue; const q = nearestOnRing(zn.polygon, mx, my); if (q && (!best || q.d < best.d)) best = q; }
    if (!best || best.d > ZONE_WALL_M) return;
    const L = best.d || 1, nx = (mx - best.x) / L, ny = (my - best.y) / L;   // facing the corridor, 0.3 m off the area's boundary (its wall may be 0.3 m deep there), a short plate
    addSign({ id: 'zone:' + d.id + ':' + a.level, level: a.level, x: best.x, y: best.y }, shortName(d.name), null, null, null, { x: best.x + nx * ZONE_PLATE_OFF_M, y: best.y + ny * ZONE_PLATE_OFF_M, h: 2.55, nx, ny, maxW: 1.6 });
  }
  function clusters(items, radius) {   // single-linkage groups of {id, x, y} within radius of one another
    const parent = items.map((_, i) => i), find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (Math.hypot(items[i].x - items[j].x, items[i].y - items[j].y) < radius) parent[find(i)] = find(j);
    const g = new Map(); items.forEach((it, i) => { const r = find(i); if (!g.has(r)) g.set(r, []); g.get(r).push(it); });
    return [...g.values()];
  }
  function clusterSign(members, text, prefer, a, b) {   // one sign per bank / cluster: at the node the route uses, else the one nearest the hinted edge
    if (!members.length || members.some(m => signed.has(m.id))) { for (const m of members) signed.add(m.id); return; }
    const at = members.find(m => prefer && prefer.has(m.id)) || (a ? members.reduce((p, m) => segDist(m.x, m.y, a, b) < segDist(p.x, p.y, a, b) ? m : p) : members[0]);
    addSign(at, text, null, null, members.map(m => m.id));
  }
  function buildSigns(plan, dest, endPt, way) {   // endPt: where the walk ends, so a hanging destination plate (no opening) faces the viewer there; way: a free destination's approach (signPlace)
    clearSigns();
    const last = plan.nodeOf(plan.route.nodes[plan.route.nodes.length - 1]), free = isFree(plan);
    dest = dest || plan.dest;
    const guessed = !free && /door position guessed/.test(last.label || '');
    const short = shortName(dest.name), subs = [];
    if (short !== displayName(dest.name)) subs.push(displayName(dest.name));
    if (guessed) subs.push('door position unknown');
    let place = null, maxW;
    if (endPt) { const dEnd = Math.hypot(endPt.x - last.x, endPt.y - last.y); maxW = Math.max(1.2, Math.min(SIGN_MAX_W_M, 0.8 * dEnd)); }   // a close arrival spot (1.5-2.5 m) gets a narrower plate, so the whole sign fits in the view
    const hg = hangingOf.get(last.id);
    if (free) { place = signPlace(last, way); if (maxW) place.maxW = maxW; }   // a free destination (a tapped point): a hanging plate at the point, facing the approach
    else if (hg) place = { x: hg.x, y: hg.y, h: hg.h || SIGN_HANG_H, nx: hg.nx, ny: hg.ny, dx: hg.ny, dy: -hg.nx, free: hg.free_m, maxW: Math.min(maxW || SIGN_MAX_W_HANGING_M, Math.max(0.6, hg.free_m[1] - hg.free_m[0] - 0.1)) };   // the builder's hanging plate: back along the stub, clear of walls, no wider than its free span
    else if (!openingOf.has(last.id) && endPt) { const L = Math.hypot(endPt.x - last.x, endPt.y - last.y) || 1, ux = (endPt.x - last.x) / L, uy = (endPt.y - last.y) / L; place = { x: last.x + ux * SIGN_HANG_BACK_M, y: last.y + uy * SIGN_HANG_BACK_M, h: SIGN_HANG_H, nx: ux, ny: uy, maxW }; }
    else if (maxW) { place = signPlace(last); place.maxW = place.free ? Math.min(maxW, Math.max(0.6, place.free[1] - place.free[0] - 0.1)) : maxW; }
    let ds = addSign(last, short, subs, guessed ? 'rgba(180,83,9,0.92)' : undefined, null, place);   // (a) the destination: never faded, in view at arrival
    if (ds && endPt && !ds.isSprite && ds.userData.nx != null) {   // seen edge-on from where the walk ends (a door stub leaving at a shallow angle), or hidden behind a wall or another doorway's lintel from there: a billboard instead, drawn over the wall
      const sx = ds.position.x, sy = -ds.position.z, L = Math.hypot(endPt.x - sx, endPt.y - sy) || 1;
      const cos = Math.abs(ds.userData.nx * (endPt.x - sx) / L + ds.userData.ny * (endPt.y - sy) / L);
      if (cos < BILLBOARD_COS || signHidden(ds, endPt, last.level)) {
        const bb = tagSprite(short, subs, guessed ? 'rgba(180,83,9,0.92)' : 'rgba(107,45,143,0.92)', false, maxW || SIGN_MAX_W_M);
        bb.material.depthTest = false; bb.renderOrder = 10; bb.position.copy(ds.position); Object.assign(bb.userData, ds.userData, { billboard: true, cos: +cos.toFixed(2) });
        labels[last.level].remove(ds); labels[last.level].add(bb); ds = bb;
      }
    }
    if (ds) ds.userData.dest = true;
    const N = plan.route.nodes.map(id => plan.nodeOf(id)), E = plan.route.edges;
    const routeIds = new Set(N.map(n => n.id)), walked = new Set();
    E.forEach((e, k) => { if (e.edge.type === 'walk') { walked.add(N[k].level); walked.add(N[k + 1].level); } });
    const texts = [];                                                                                       // (b) what the hints name, on their own level
    E.forEach((e, k) => { const h = e.forward ? e.edge.hint : e.edge.hint_reverse; if (h) texts.push({ text: h, a: N[k], b: N[k + 1] }); });
    const edgeHints = new Set(texts.map(t => t.text));
    plan.steps.forEach(st => { if (st.hint && !edgeHints.has(st.hint)) { const k = Math.min(st.firstEdge + Math.max(0, st.edgeCount - 1), E.length - 1); texts.push({ text: st.hint, a: N[k], b: N[Math.min(k + 1, N.length - 1)] }); } });   // a step's hint repeats one of its edges' hints (matched there already); an own one belongs to the step's last edge
    const fixtures = [], farAreas = [], signedDests = new Set([dest.id]);
    for (const { text, a, b } of texts) {
      if (a.level !== b.level) continue;
      for (const ph of hintPhrases(text)) {
        if (ph.kind === 'room') { const m = findLandmark(ph.name, a.level, a, b, ph.ahead); if (m && !m.far) { if (addSign(m.d.node, shortName(m.d.name))) signedDests.add(m.d.id); } else if (m && zonesOf.has(m.d.id)) farAreas.push({ d: m.d, a, b }); }
        else fixtures.push({ kind: ph.kind, a, b, ahead: ph.ahead });
      }
    }
    for (const f of farAreas) if (!signedDests.has(f.d.id)) { zoneWallSign(f.d, f.a, f.b); signedDests.add(f.d.id); }   // one sign per place: never a wall plate for an area that already has its door sign or is the destination
    const liftsOn = lv => [...V.nodes.values()].filter(n => n.level === lv && n.type === 'lift'), stairsOn = lv => [...V.nodes.values()].filter(n => n.level === lv && n.type === 'stairs');
    const toiletsOn = lv => V.dests.filter(d => d.category === 'toilet' && d.node.level === lv).map(d => d.node);
    for (const n of N) {                                                                                    // (c) the route's own fixtures, one sign per bank
      if (!walked.has(n.level)) continue;
      if (n.type === 'lift' || n.type === 'stairs') { const bank = clusters(n.type === 'lift' ? liftsOn(n.level) : stairsOn(n.level), CLUSTER_M).find(c => c.some(m => m.id === n.id)) || [n]; clusterSign(bank, n.type === 'lift' ? 'Lifts' : 'Stairs', routeIds); }
      else if (n.type === 'entrance') addSign(n, 'Entrance');
    }
    for (const f of fixtures) {                                                                             // the fixtures the hints point at, one sign per cluster
      if (!walked.has(f.a.level)) continue;
      const pool = f.kind === 'toilet' ? toiletsOn(f.a.level) : f.kind === 'lift' ? liftsOn(f.a.level) : f.kind === 'stairs' ? stairsOn(f.a.level) : [];
      const ahead = m => (m.x - f.a.x) * (f.b.x - f.a.x) + (m.y - f.a.y) * (f.b.y - f.a.y) > 0;   // "lifts ahead": near the edge's end, not behind the walker
      const near = pool.filter(m => f.ahead ? ahead(m) && Math.hypot(m.x - f.b.x, m.y - f.b.y) < FIXTURE_NEAR_M : segDist(m.x, m.y, f.a, f.b) < FIXTURE_NEAR_M);
      for (const c of clusters(near, CLUSTER_M)) clusterSign(c, f.kind === 'toilet' ? 'Toilets' : f.kind === 'lift' ? 'Lifts' : 'Stairs', routeIds, f.a, f.b);
    }
  }
  const SOLID_MATS = new Set(['wall', 'lintel', 'lift', 'lift_lintel', 'stairs', 'stairs_lintel', 'facade_glass', 'facade_sill', 'column', 'frame_dark', 'roof', 'ceiling']);
  const sightRay = new THREE.Raycaster();
  function signHidden(sign, eyeXY, level) {   // is anything solid of this level between the arrival eye and the sign (its centre, four corners and two mid-edges)?
    const eye = toWorld(eyeXY.x, eyeXY.y, zOf[level] + EYE);
    const solids = []; (levelObj[level] || new THREE.Group()).traverse(o => { if (o.isMesh && o.material && SOLID_MATS.has(o.material.name)) solids.push(o); });
    for (const o of solids) o.updateMatrixWorld(true);
    sign.updateMatrixWorld(true); sightRay.camera = camera;
    const W = sign.userData.width || 0.3, H = sign.userData.height || 0.3;
    for (const [x, y] of [[0, 0], [-W / 2, H / 2], [W / 2, H / 2], [-W / 2, -H / 2], [W / 2, -H / 2], [0, H / 2], [0, -H / 2]]) {
      const p = new THREE.Vector3(x, y, 0).applyMatrix4(sign.matrixWorld), dir = p.sub(eye), dist = dir.length(); if (dist < 0.1) continue;
      dir.normalize(); sightRay.set(eye, dir); sightRay.far = dist - 0.05;
      if (sightRay.intersectObjects(solids, false).length) return true;
    }
    return false;
  }
  function fadeSigns(cx, cz) {
    const g = labels[shownLevel]; if (!g) return;
    for (const s of g.children) { const d = Math.hypot(s.position.x - cx, s.position.z - cz); const a = s.userData.dest ? 1 : Math.max(0, Math.min(1, (d - SIGN_FADE_NEAR) / (SIGN_FADE_FAR - SIGN_FADE_NEAR))); s.material.opacity = a; s.visible = a > 0.02; }
  }
  let shownLevel = null;
  const STRUCT = new Set((manifest.style && manifest.style.structural_materials) || ['floor', 'corridor', 'ceiling', 'roof', 'facade_glass', 'facade_sill', 'glass_pane', 'metal', 'column', 'skylight']);
  function showLevel(lv) {
    if (shownLevel === lv) return;
    shownLevel = lv;
    for (const id in levelObj) {   // the current level in full; every other level only its structure, seen through the atrium void and the glass facade
      levelObj[id].visible = true;
      levelObj[id].traverse(o => { if (o.isMesh) o.visible = id === lv || (o.material && STRUCT.has(o.material.name)); });
    }
    for (const id in labels) labels[id].visible = id === lv;
    for (const id in overlay) overlay[id].visible = id === lv;
    for (const id in marks) marks[id].visible = id === lv;
    $('#level').textContent = levelName(lv); $('#level').style.display = 'inline-block';
    const b = ui.borrowedFrom[lv];
    $('#banner').style.display = b && ui.borrowedCaption ? 'block' : 'none';
    $('#banner').innerHTML = b ? `${esc(ui.borrowedCaption)} <span class="dim">Translucent corridors are ${esc(levelName(b))}'s.</span>` : '';
    if (ui.onLevel) ui.onLevel(lv);
  }

  // ------------------------------------------------------------ route overlays (ribbon, pins, decision marker)
  const ribbonMat = new THREE.MeshBasicMaterial({ color: lin(0xd62828), depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const pinMat = { start: new THREE.MeshStandardMaterial({ color: lin(0x1d4ed8) }), dest: new THREE.MeshStandardMaterial({ color: lin(0x15803d) }), next: new THREE.MeshStandardMaterial({ color: lin(0xd97706), transparent: true }) };
  function ribbon(run) {
    const pos = [], W = 0.18, z = zOf[run.level] + 0.045;
    for (let i = 0; i + 1 < run.pts.length; i++) {
      const a = run.pts[i], b = run.pts[i + 1], L = Math.hypot(b.x - a.x, b.y - a.y) || 1, nx = -(b.y - a.y) / L * W, ny = (b.x - a.x) / L * W;
      const p = [[a.x + nx, a.y + ny], [b.x + nx, b.y + ny], [b.x - nx, b.y - ny], [a.x - nx, a.y - ny]].map(([x, y]) => [x, z, -y]);
      pos.push(...p[0], ...p[1], ...p[2], ...p[0], ...p[2], ...p[3]);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
    const m = new THREE.Mesh(g, ribbonMat); m.renderOrder = 1; return m;
  }
  function pin(x, y, z, which) {   // start: post with a ball; destination: floor ring at the door; next: amber post
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.35, 0.55, 32), which === 'next' ? pinMat.next : ribbonMat); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.05; g.add(ring);
    if (which !== 'dest') {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.0, 10), pinMat[which]); post.position.set(0, 1.0, 0); g.add(post);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), pinMat[which]); ball.position.y = 2.05; g.add(ball);
    }
    g.position.copy(toWorld(x, y, z)); return g;
  }
  let marker = null, markerLevel = null, markerWanted = false;
  function fadeMarker(cx, cz) {   // every frame: shown on its own level, faded like the signs (gone within 1.5 m, so the post never fills the view at the turn)
    if (!marker) return;
    if (!markerWanted || markerLevel !== shownLevel) { marker.visible = false; return; }
    const d = Math.hypot(marker.position.x - cx, marker.position.z - cz), a = Math.max(0, Math.min(1, (d - SIGN_FADE_NEAR) / (SIGN_FADE_FAR - SIGN_FADE_NEAR)));
    marker.traverse(o => { if (o.isMesh) o.material.opacity = a; }); marker.visible = a > 0.02;
  }
  function setMarker(x, y, level) {
    if (!marker) return;
    markerWanted = x != null;
    if (!markerWanted) { marker.visible = false; return; }
    marker.position.copy(toWorld(x, y, zOf[level])); markerLevel = level;
  }
  function clearOverlays() { for (const id in overlay) { for (const o of [...overlay[id].children]) overlay[id].remove(o); } markerWanted = false; if (marker) marker.visible = false; }
  function resetFade() { fade = null; const f = $('#fade'); f.style.opacity = 0; f.firstElementChild.style.display = 'none'; }

  // ------------------------------------------------------------ position: a target the page sets, a view that follows it in ~120 ms
  let plan = null, R = null, dest = null, arrivedHere = false;
  const target = { s: 0, run: 0 }, view = { s: 0, run: 0 };
  let yaw = 0, pitch = 0, lookYaw = 0, lookPitch = 0, fade = null, lastNow = performance.now();
  const moving = () => !!R && !fade && Math.abs(target.s - view.s) > 0.01;
  const arrivedAtDoor = () => !!R && !fade && view.s >= R.length - 0.3 && !moving();   // at a hanging plate too: the pitch is 0 unless the plate would sit under the header
  function arrivalPitch(px, py, z, door) {   // at a door: tilt up just enough to keep the whole destination sign (its nearer top corner, seen obliquely) under the header card; the floor ring at the door stays in view where both fit (a door right beside a lift landing cannot)
    const s = destSign(); if (!s || !door) return 0;
    const H = s.userData.height || SIGN_LINE_M, W = s.userData.width || SIGN_LINE_M;
    s.updateMatrixWorld(true);
    const h = yaw + lookYaw, fx = Math.cos(h), fy = Math.sin(h);   // screen height of a corner depends on its depth along the view axis, not its distance
    const elev = [[-W / 2, H / 2], [W / 2, H / 2]].map(([x, y]) => { const c = s.isSprite ? s.position.clone().setY(s.position.y + y) : new THREE.Vector3(x, y, 0).applyMatrix4(s.matrixWorld); return Math.atan2(c.y - z, Math.max(0.2, (c.x - px) * fx + (-c.z - py) * fy)); });
    const half = camera.fov / 2 * Math.PI / 180, usable = Math.atan(Math.tan(half) * (1 - 2 * ui.headerPx() / (canvas.clientHeight || 600)));
    const forSign = Math.max(0, Math.max(...elev) - usable + 0.03);
    const ringFar = Math.atan2(zOf[door.level] + 0.05 - z, Math.hypot(door.x - px, door.y - py) + 0.55);   // the far edge of the ring
    return Math.max(forSign, Math.min(forSign, Math.max(0, ringFar + half - 0.02)));
  }
  function headingAt(run, s, p) {
    const la = pointOnRun(run, Math.min(run.s1, s + LOOK_AHEAD_M));
    if (Math.hypot(la.x - p.x, la.y - p.y) > 0.05) return Math.atan2(la.y - p.y, la.x - p.x);
    const lastNode = R.N[R.N.length - 1], door = R.arrive.door, ds = destSign(), aim = ds ? { x: (door.x + ds.position.x) / 2, y: (door.y - ds.position.z) / 2 } : door;   // the door and its sign (a plate may sit shifted along the wall, inside the free span)
    if (run === R.runs[R.runs.length - 1] && lastNode.type === 'door' && R.arrive.facing === 'door' && Math.hypot(aim.x - p.x, aim.y - p.y) > 0.05) return framed(Math.atan2(aim.y - p.y, aim.x - p.x));
    if (run === R.runs[R.runs.length - 1] && ds) return framed(Math.atan2(-ds.position.z - p.y, ds.position.x - p.x));   // no opening of its own: turn to the hanging sign
    return segHeading(run, true, yaw);
  }
  // a panel overlaying the left of the view: a target is centred in the part it leaves free (none in the split layout)
  function framed(bearing) { const pf = ui.panelFrac(); if (!pf) return bearing; const halfH = Math.atan(Math.tan(camera.fov / 2 * Math.PI / 180) * camera.aspect); return bearing + Math.atan(pf * Math.tan(halfH)); }
  function destSign() { const g = labels[shownLevel]; return g ? g.children.find(o => o.userData.dest) : null; }
  const isFree = p => !!(p && p.dest && p.dest.virtual);   // a free destination: Wayfind's __end, a point with no door, no opening, not in the venue graph
  function approachWay(R, last, endPt) {   // a free destination's plate (signPlace's way): facing back to where the walk ends (the camera), hung SIGN_HANG_BACK_M back toward it, or ahead of the point when the walk ends within 1.5 m of it
    const pt = R.arrive.door, d = Math.hypot(endPt.x - pt.x, endPt.y - pt.y);
    if (d > 0.3) return { x: (endPt.x - pt.x) / d, y: (endPt.y - pt.y) / d, back: Math.min(SIGN_HANG_BACK_M, d - 1.5) };
    const back = P => { for (let i = P.length - 1; i > 0; i--) { const a = P[i - 1], b = P[i], L = Math.hypot(b.x - a.x, b.y - a.y); if (L > 0.05) return { x: (a.x - b.x) / L, y: (a.y - b.y) / L }; } return null; };
    let u = back(R.runs[R.runs.length - 1].pts);   // the walk reaches the point: back along its last segment
    if (!u && last.same_as) { const nb = neighbourOf(last.same_as), L = nb ? Math.hypot(nb.x - last.x, nb.y - last.y) : 0; if (L > 0.05) u = { x: (last.x - nb.x) / L, y: (last.y - nb.y) / L }; }   // a ride landing on the point (a lift / stair node): the plate ahead, out toward its corridor
    if (!u) u = back(R.runs.flatMap(r => r.pts));
    return u ? { x: u.x, y: u.y, back: d - 1.5 } : null;
  }
  function setRoute(plan_, R_, dest_) {
    clearOverlays(); clearSigns(); plan = plan_; R = R_; dest = dest_; arrivedHere = false; resetFade(); lookYaw = lookPitch = 0;
    target.s = view.s = 0; target.run = view.run = 0;
    if (!R) return;
    const last = plan.nodeOf(plan.route.nodes[plan.route.nodes.length - 1]), free = isFree(plan);
    for (const run of R.runs) overlay[run.level].add(ribbon(run));
    const first = R.runs[0].pts[0];
    overlay[R.runs[0].level].add(pin(first.x, first.y, zOf[R.runs[0].level], 'start'));
    const ring = free ? plan.dest.face || R.arrive.door : R.arrive.door;   // a free destination's ring: at its face point (the tapped spot), else the point
    overlay[last.level].add(pin(ring.x, ring.y, zOf[last.level], 'dest'));   // the arrival marker: the floor ring at the door (its opening's centre) plus the sign above it
    { const fr = R.runs[R.runs.length - 1], endPt = fr.pts[fr.pts.length - 1]; buildSigns(plan, dest, endPt, free ? approachWay(R, last, endPt) : undefined); }
    apply(0, true);
  }
  function setAlready(plan_, dest_) {   // start is the destination: show the room from where a walk to it would end, no walk
    clearOverlays(); clearSigns(); plan = plan_; R = null; dest = dest_; arrivedHere = true; resetFade(); lookYaw = lookPitch = 0;
    const last = plan.nodeOf(plan.route.nodes[plan.route.nodes.length - 1]);
    const nb = neighbourOf(last.id), opened = RouteExport.hasOpening(manifest, last.id), arriveM = opened ? RouteExport.ARRIVE_M : RouteExport.ARRIVE_NO_WALL_M, door = RouteExport.doorPoint(manifest, last);
    // stand where a walk to this door would end: the door stub's camera path and, when that is too short, the corridor edge before it, cut arriveM from the door
    const approach = [];
    if (nb) {   // walk back along the graph from the door until the polyline is long enough to be cut arriveM from the door
      const chain = [last, nb], seen = new Set([last.id, nb.id]); let len = Math.hypot(nb.x - last.x, nb.y - last.y);
      while (len < arriveM + 2 && chain.length < 12) {
        const cur = chain[chain.length - 1], next = (V.adj.get(cur.id) || []).filter(n => n.edge.type === 'walk').map(n => V.nodes.get(n.to)).find(n => n && !seen.has(n.id) && n.level === last.level);
        if (!next) break; seen.add(next.id); chain.push(next); len += Math.hypot(next.x - cur.x, next.y - cur.y);
      }
      chain.reverse();   // far end first, the door last
      let s = 0; for (let i = 0; i + 1 < chain.length; i++) for (const [x, y] of RouteExport.edgePath(paths, chain[i], chain[i + 1])) { const q = approach[approach.length - 1]; if (q && Math.hypot(q.x - x, q.y - y) < 1e-4) continue; if (q) s += Math.hypot(q.x - x, q.y - y); approach.push({ x, y, s }); }
      RouteExport.arriveCut(approach, door, arriveM, 0);
    }
    let cx, cy;
    const spot = (RouteExport.openingOf(manifest, last.id) || {}).arrival;
    if (spot && nb && nb.id === spot.from_node) ({ x: cx, y: cy } = spot);   // the spot in front of the door a walk would end on (over its own stub)
    else if (approach.length) ({ x: cx, y: cy } = approach[approach.length - 1]);
    else { const t = nb || last, L = Math.hypot(t.x - last.x, t.y - last.y) || 1; cx = last.x + (t.x - last.x) / L * Math.min(1.0, L); cy = last.y + (t.y - last.y) / L * Math.min(1.0, L); }
    showLevel(last.level);
    let way;
    if (isFree(plan)) {   // a free destination (no graph neighbour, no opening): the camera stands on the point, the plate 1.5 m ahead (toward its face point when that is elsewhere, else the way the view looks)
      const f = plan.dest.face, h = f && Math.hypot(f.x - cx, f.y - cy) > 0.3 ? Math.atan2(f.y - cy, f.x - cx) : yaw;
      way = { x: -Math.cos(h), y: -Math.sin(h), back: -1.5 };
    }
    const ring = way ? plan.dest.face || door : door;
    overlay[last.level].add(pin(ring.x, ring.y, zOf[last.level], 'dest')); buildSigns(plan, dest, { x: cx, y: cy }, way); fadeSigns(cx, -cy);
    const ds0 = destSign(), aim = ds0 ? { x: (door.x + ds0.position.x) / 2, y: (door.y - ds0.position.z) / 2 } : door;
    yaw = framed(opened || !ds0 ? Math.atan2(aim.y - cy, aim.x - cx) : Math.atan2(-ds0.position.z - cy, ds0.position.x - cx));
    pitch = arrivalPitch(cx, cy, zOf[last.level] + EYE, door);
    camera.position.copy(toWorld(cx, cy, zOf[last.level] + EYE)); camera.lookAt(toWorld(cx + Math.cos(yaw) * Math.cos(pitch), cy + Math.sin(yaw) * Math.cos(pitch), zOf[last.level] + EYE + Math.sin(pitch)));
    lamp.position.copy(toWorld(cx, cy, zOf[last.level] + EYE + 1.25));
    return { x: cx, y: cy, level: last.level, door };
  }
  function clear() { clearOverlays(); clearSigns(); plan = null; R = null; dest = null; arrivedHere = false; resetFade(); }
  function setTarget(s, run, o) {   // o: {snap, fadeMs, card}
    if (!R) return; o = o || {};
    target.s = Math.max(0, Math.min(R.length, s)); target.run = Math.max(0, Math.min(R.runs.length - 1, run));
    if (o.snap) { view.s = target.s; view.run = target.run; resetFade(); apply(0, true); return; }
    if (target.run !== view.run) {   // a level change: one fade, started once; a scrub that crosses another ride meanwhile keeps the same fade (its clock is never restarted, nothing is queued)
      if (!fade) fade = { t0: performance.now(), fromRun: view.run, ms: o.fadeMs || FADE_MS, card: !!o.card, ride: rideFor(view.run, target.run) };
      else { fade.card = fade.card || !!o.card; if (!fade.ride) fade.ride = rideFor(fade.fromRun, target.run); }
    } else if (fade && performance.now() - fade.t0 < fade.ms * 0.5) resetFade();   // scrubbed back before the darkest point: no fade after all
  }
  function rideFor(fromRun, toRun) { return R.rides.find(r => (toRun > fromRun ? r.afterRun === fromRun : r.afterRun === toRun)); }
  function apply(dt, snap) {
    if (!R) return;
    const fadeEl = $('#fade'), card = fadeEl.firstElementChild;
    if (fade) {   // a ride: fade out, switch run at the darkest point, fade in; with a card during the fly-through
      const ph = Math.min(1, (performance.now() - fade.t0) / fade.ms);
      if (ph >= 0.5) { if (view.run !== target.run) { view.run = target.run; snap = true; } view.s = target.s; }   // past the darkest point the view is wherever the target is, at once
      const a = ph < 0.5 ? ph * 2 : (1 - ph) * 2;
      fadeEl.style.opacity = Math.max(0, Math.min(1, a * 1.25)).toFixed(3);
      if (fade.card && fade.ride) {
        const ride = fade.ride, step = plan.steps[ride.step] || {};
        { const u = $('#fade .ico use'); if (u) u.setAttribute('href', ride.type === 'stairs' ? '#i-stairs' : '#i-lift'); }   // the card's icon (an SVG symbol in index.html) $('#cardtitle').textContent = step.text || `Take the ${ride.type} to ${levelName(ride.toLevel)}`; $('#cardsub').textContent = `${levelName(ride.fromLevel)} → ${levelName(ride.toLevel)}${step.hint ? ' · ' + step.hint : ''}`;
        card.style.display = a > 0.2 ? 'block' : 'none';
      } else card.style.display = 'none';
      if (ph >= 1) resetFade();
    } else {
      fadeEl.style.opacity = 0; card.style.display = 'none';
      if (snap) view.s = target.s; else { view.s += (target.s - view.s) * (1 - Math.exp(-dt / SMOOTH_S)); if (Math.abs(target.s - view.s) < 0.003) view.s = target.s; }
    }
    const run = R.runs[view.run], p = pointOnRun(run, view.s);
    showLevel(run.level);
    const heading = headingAt(run, view.s, p);
    if (snap) yaw = heading; else yaw += wrap(heading - yaw) * (1 - Math.exp(-TURN_RATE * dt));
    if (moving() || fade) { lookYaw *= Math.exp(-2.5 * dt); lookPitch *= Math.exp(-2.5 * dt); }          // moving again eases the view back onto the route
    const z = zOf[run.level] + EYE, h = yaw + lookYaw;
    camera.position.set(p.x, z, -p.y);
    const pt = (arrivedAtDoor() ? arrivalPitch(p.x, p.y, z, R.arrive.door) : 0) + lookPitch; pitch = snap ? pt : pitch + (pt - pitch) * (1 - Math.exp(-6 * dt));
    camera.lookAt(p.x + Math.cos(h) * Math.cos(pitch), z + Math.sin(pitch), -(p.y + Math.sin(h) * Math.cos(pitch)));
    lamp.position.set(p.x + Math.cos(h) * 1.5, z + 1.25, -(p.y + Math.sin(h) * 1.5));
    fadeSigns(p.x, -p.y); fadeMarker(p.x, -p.y);
  }
  function update(now) {
    const dt = Math.min(0.2, (now - lastNow) / 1000); lastNow = now;
    if (R) apply(dt, false);
    else if (arrivedHere) { lookYaw *= Math.exp(-1.5 * dt); const h = yaw + lookYaw; camera.lookAt(camera.position.x + Math.cos(h) * Math.cos(pitch), camera.position.y + Math.sin(pitch), camera.position.z - Math.sin(h) * Math.cos(pitch)); }
    resize(); renderer.render(scene, api.debugCamera || camera);   // debugCamera: an alternative view for screenshots / inspection
  }
  function idleAt(n0, nb) {   // before a route: look along the first entrance's corridor
    showLevel(n0.level);
    camera.position.copy(toWorld(n0.x, n0.y, zOf[n0.level] + EYE)); camera.lookAt(toWorld(nb.x, nb.y, zOf[n0.level] + EYE)); yaw = Math.atan2(nb.y - n0.y, nb.x - n0.x);
    lamp.position.copy(toWorld(n0.x, n0.y, zOf[n0.level] + EYE + 1.25));
  }
  const api = {
    load, setRoute, setAlready, clear, setTarget, update, showLevel, setMarker, idleAt, destSign, headingAt, pointOnRun, resize,
    look: (dy, dp, abs) => { lookYaw = abs ? dy : lookYaw + dy; if (dp != null) lookPitch = Math.max(-1.2, Math.min(1.2, abs ? dp : lookPitch + dp)); },
    lookOffset: () => lookYaw, lookPitch: () => lookPitch, pitch: () => pitch, heading: () => yaw,
    signs: () => Object.values(labels).flatMap(g => g.children.map(s => s.userData.node)),
    state: () => ({ s: view.s, run: view.run, target: target.s, moving: moving(), transition: !!fade, level: shownLevel, arrivedHere }),
    scene, camera, renderer, labels, levelObj, debugCamera: null,
  };
  return api;
};
