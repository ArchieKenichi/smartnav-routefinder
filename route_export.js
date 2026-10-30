/* Route geometry and route.json export for the 3D walkthrough.
   Turns a Wayfind plan into (a) walk runs along the camera clearance paths (camera-paths.json) with a metre
   position axis, the rides between them and the position of every step, and (b) the route.json the Unity
   RouteCameraFollower reads. Plain JS, no DOM: window.RouteExport in the browser, module.exports in Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RouteExport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const WALK_SPEED = 1.3;   // m/s for auto-walk and the Unity follower
  const RIDE_S = 3.0;       // seconds a lift / stair transition takes (fade out, card, fade in)
  const RIDE_EXTRA_S = 0.4; // added per further floor of the same ride
  const EYE_M = 1.6;        // camera height above the floor
  const ARRIVE_M = 3.0;     // the walk ends this far (straight line) from the destination door, whatever the door stub's length,
                            // so the door, the whole of its sign (seen obliquely from the corridor) and the floor ring are in
                            // view on arrival (camera-paths.json stops a long stub 3 m before the door; a short one is cut
                            // back here into the corridor edge before it, to the start of the final run if need be)
  const ARRIVE_NO_WALL_M = 3.5;   // ... and this far from a destination without an opening of its own (a zone's door, a point off
                                  // any wall): the walk ends turned to the hanging sign placed back along the stub
  const ARRIVE_MIN_WALK_M = 1.0;  // a final run that starts at a ride landing keeps at least this much walk (a door right beside the landing is simply closer)
  const SPOT_BEND_DEG = 20;       // the straight leg to the model's arrival spot in front of the door is walked only when it continues the approach
                                  // within this angle; a leg that bends more (the spot lies across the corridor from the stub's corridor end) would
                                  // read as a swerve away from the door, so the walk ends on the corridor instead, turned to the door ("stub") ...
  const SPOT_NEAR_M = 1.5;        // ... unless that end would be closer than this to the door (a ride landing right beside the door: the door would
                                  // fill the view; the builder's closest spot is 1.5 m), or the builder found the door out of sight from it (arrival.fallback_blind)

  /* the opening of node id in the model (a room's own door, a lift / stair entry, an entrance), if any */
  function openingOf(manifest, id) {
    return (manifest.openings || []).find(o => ((o.kind === 'door' && o.own_wall) || o.kind === 'lift' || o.kind === 'stairs' || o.kind === 'entrance') && (o.nodes || [o.node]).includes(id)) || null;
  }
  const hasOpening = (manifest, id) => !!openingOf(manifest, id);
  /* where the door of node is in the model: the centre of its opening (an opening re-centred inside its wall moves off the
     graph node by up to 0.43 m), else the node itself */
  function doorPoint(manifest, node) { const o = openingOf(manifest, node.id); return o ? { x: o.x, y: o.y, level: node.level } : { x: node.x, y: node.y, level: node.level }; }
  /* cut a polyline ({x, y, s}... ending near `door`) back so it ends exactly arriveM (straight line) from the door, keeping
     at least minKeep metres of walk from its first vertex (the end moves on along the path to that length when the circle
     crossing lies before it); returns the vertices cut off, last first */
  function arriveCut(pts, door, arriveM, minKeep) {
    const dd = p => Math.hypot(p.x - door.x, p.y - door.y), gone = [], keep = minKeep == null ? 0.5 : minKeep, s0 = pts[0].s;
    const endOn = (prev, g, t) => {   // end the walk at t along the segment prev -> g (g already cut off); t at or past g keeps g
      if (t >= 1 - 1e-6) { pts.push(g); gone.pop(); return; }
      if (t > 1e-3) pts.push({ x: prev.x + (g.x - prev.x) * t, y: prev.y + (g.y - prev.y) * t, s: prev.s + Math.hypot(g.x - prev.x, g.y - prev.y) * t, k: g.k, node: null });
    };
    while (pts.length > 1 && dd(pts[pts.length - 1]) < arriveM) {
      gone.push(pts.pop());
      const prev = pts[pts.length - 1], g = gone[gone.length - 1], L = Math.hypot(g.x - prev.x, g.y - prev.y);
      const tKeep = L > 1e-9 ? (keep - (prev.s - s0)) / L : 0;   // where along this segment the walk reaches minKeep (negative: already past it at prev)
      if (dd(prev) >= arriveM) {   // the path crosses the circle on this segment: end exactly there, or further on where the minimum walk is reached
        const ax = prev.x - door.x, ay = prev.y - door.y, vx = g.x - prev.x, vy = g.y - prev.y;
        const A = vx * vx + vy * vy, B = 2 * (ax * vx + ay * vy), C = ax * ax + ay * ay - arriveM * arriveM, disc = B * B - 4 * A * C;
        const t = A > 1e-9 && disc >= 0 ? Math.max(0, Math.min(1, (-B - Math.sqrt(disc)) / (2 * A))) : 0;
        endOn(prev, g, Math.max(t, tKeep));
        break;
      }
      if (tKeep > 0) { endOn(prev, g, tKeep); break; }   // cutting further would leave less than minKeep: end where the minimum walk is reached on this segment
    }
    return gone;
  }

  function index(paths) {
    if (!paths || !paths.levels) return null;
    if (!paths._edges) {
      paths._edges = new Map(); paths._nodes = new Map();
      for (const lv in paths.levels) {
        for (const e of paths.levels[lv].edges) paths._edges.set(e.from + '|' + e.to, e.pts);
        for (const id in paths.levels[lv].nodes) paths._nodes.set(id, paths.levels[lv].nodes[id]);
      }
    }
    return paths;
  }
  /* camera polyline from node a to node b: the precomputed clearance path, else the straight edge */
  function edgePath(paths, a, b) {
    const P = index(paths);
    if (P) {
      const f = P._edges.get(a.id + '|' + b.id); if (f) return f;
      const r = P._edges.get(b.id + '|' + a.id); if (r) return r.slice().reverse();
    }
    return [nodePos(paths, a), nodePos(paths, b)];
  }
  const nodePos = (paths, n) => { const P = index(paths); return (P && P._nodes.get(n.id)) || [n.x, n.y]; };

  /* venue: Wayfind.load() result; plan: Wayfind.plan() result; manifest: model-manifest.json; paths: camera-paths.json or null;
     meta: { startLabel, options }. Returns { json, runs, rides, length, stepS, stepOfEdge, N, E }. */
  function build(venue, plan, manifest, paths, meta) {
    meta = meta || {};
    const zOf = Object.fromEntries(manifest.levels.map(l => [l.id, l.z]));
    const N = plan.route.nodes.map(id => plan.nodeOf(id)), E = plan.route.edges;
    const stepOfEdge = new Array(E.length).fill(-1);
    plan.steps.forEach((st, i) => { for (let k = st.firstEdge; k < st.firstEdge + st.edgeCount && k < E.length; k++) if (stepOfEdge[k] < 0) stepOfEdge[k] = i; });
    for (let k = 0; k < E.length; k++) if (stepOfEdge[k] < 0) stepOfEdge[k] = k ? stepOfEdge[k - 1] : 0;
    const runs = [], rides = [], nodeS = new Array(N.length).fill(null);
    let s = 0, run = null;
    nodeS[0] = 0;
    const addPt = (x, y, k, nodeIndex) => {
      const last = run.pts[run.pts.length - 1];
      if (last && Math.hypot(last.x - x, last.y - y) < 1e-4) { if (nodeIndex != null) last.node = nodeIndex; return; }
      if (last) s += Math.hypot(last.x - x, last.y - y);
      run.pts.push({ x, y, s, k, node: nodeIndex == null ? null : nodeIndex }); run.s1 = s;
    };
    const lastOp = openingOf(manifest, N[N.length - 1].id), arrivalSpot = lastOp && lastOp.arrival ? lastOp.arrival : null;
    // The arrival spot's leg replaces the final walk edge only when that edge is the door stub the builder validated the
    // leg from: the route's second-to-last node must be arrival.from_node (a door reached over a bridged door-to-door
    // edge instead ends arrive_m back along that edge, mode "stub"). The leg runs from arrival.from (the stub's corridor-
    // end vertex) to arrival {x, y}. A Unity port mirrors exactly this rule.
    const spotStraight = () => {   // the leg to the spot continues the approach to the stub's corridor end within SPOT_BEND_DEG (nothing to compare with when the route starts there or lands there by a ride: then the leg is the whole walk)
      if (N.length < 3 || E[E.length - 2].edge.type !== 'walk') return true;
      const pts = edgePath(paths, N[N.length - 3], N[N.length - 2]);
      let j = pts.length - 1; while (j > 0 && Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]) < 0.05) j--;
      if (j === 0) return true;
      const a = pts[j - 1], b = pts[j];
      const t = ((Math.atan2(arrivalSpot.y - arrivalSpot.from[1], arrivalSpot.x - arrivalSpot.from[0]) - Math.atan2(b[1] - a[1], b[0] - a[0])) * 180 / Math.PI + 540) % 360 - 180;
      return Math.abs(t) < SPOT_BEND_DEG;
    };
    const spotBase = !!(arrivalSpot && E.length && E[E.length - 1].edge.type === 'walk' && N[N.length - 1].type === 'door' && N.length >= 2 && N[N.length - 2].id === arrivalSpot.from_node);
    const last = N[N.length - 1], doorPt = doorPoint(manifest, last);
    const fallbackEndM = (run, a, b, k) => {   // how far from the door the walk would end without the spot's leg: the final run so far plus the stub's camera path, cut back as the real one is (arriveCut)
      const probe = run.pts.map(p => ({ x: p.x, y: p.y, s: p.s, k: p.k, node: null })); let ss = run.s1;
      for (const [x, y] of edgePath(paths, a, b)) { const l = probe[probe.length - 1]; if (l && Math.hypot(l.x - x, l.y - y) < 1e-4) continue; if (l) ss += Math.hypot(l.x - x, l.y - y); probe.push({ x, y, s: ss, k, node: null }); }
      arriveCut(probe, doorPt, ARRIVE_M, rides.some(x => x.afterRun === runs.length - 2) ? ARRIVE_MIN_WALK_M : 0);
      const e = probe[probe.length - 1]; return Math.hypot(e.x - doorPt.x, e.y - doorPt.y);
    };
    // The leg is walked when it continues the approach within SPOT_BEND_DEG; also when the builder found that the stub fallback for
    // this approach cannot see the door (arrival.fallback_blind names such approach nodes), and when that fallback would end closer
    // than SPOT_NEAR_M to the door (a ride landing or the route's start right beside the door): a swerve is better than a door behind
    // a wall or filling the view.
    const spotWanted = (run, a, b, k) => spotBase && (spotStraight() || (N.length >= 3 && (arrivalSpot.fallback_blind || []).includes(N[N.length - 3].id)) || fallbackEndM(run, a, b, k) < SPOT_NEAR_M);
    let usedSpot = false;
    for (let k = 0; k < E.length; k++) {
      const e = E[k].edge, a = N[k], b = N[k + 1];
      if (e.type === 'walk') {
        if (!run) { run = { level: a.level, pts: [], s0: s, s1: s, k0: k, k1: k }; runs.push(run); }
        let pts = edgePath(paths, a, b);
        const legHere = k === E.length - 1 && spotWanted(run, a, b, k);
        if (legHere) { usedSpot = true; pts = [arrivalSpot.from, [arrivalSpot.x, arrivalSpot.y]]; }
        if (!run.pts.length || legHere) addPt(pts[0][0], pts[0][1], k, k);
        for (let i = 1; i < pts.length; i++) addPt(pts[i][0], pts[i][1], k, i === pts.length - 1 ? k + 1 : null);
        run.k1 = k; nodeS[k + 1] = s;
      } else {
        const last = rides[rides.length - 1], merge = last && last.type === e.type && last.k1 === k - 1;   // one more floor of the same ride
        if (!run && !merge) {   // the route starts with a ride (or a ride follows a ride of another kind): a zero-length run at the ride node, so the ride has a place to start from
          const p = nodePos(paths, a);
          run = { level: a.level, pts: [{ x: p[0], y: p[1], s, k, node: k }], s0: s, s1: s, k0: k, k1: k }; runs.push(run);
        }
        if (merge) { last.toLevel = b.level; last.b = b; last.floors++; last.k1 = k; last.seconds += RIDE_EXTRA_S; }
        else rides.push({ afterRun: runs.length - 1, type: e.type, fromLevel: a.level, toLevel: b.level, a, b, floors: 1, k, k1: k, step: stepOfEdge[k], s, seconds: RIDE_S });
        nodeS[k + 1] = s; run = null;
      }
    }
    const fin = runs[runs.length - 1];
    const opened = last.type === 'door' && hasOpening(manifest, last.id), arriveM = opened ? ARRIVE_M : ARRIVE_NO_WALL_M;
    // how the walk ends: on the builder's spot in front of the door ("front" / "oblique"), else 3 m back along the stub ("stub"), turned to the door (its opening's centre); or 3.5 m short at a destination without an opening ("along"), turned to its hanging sign (destination.face_x / face_y: the page and the follower turn to that point for both facings)
    const hg = (manifest.hanging || []).find(h => h.node === last.id), facePt = opened || !hg ? doorPt : { x: hg.x, y: hg.y };   // what the walk turns to at its end
    const arrive = { m: usedSpot ? arrivalSpot.distance_m : arriveM, facing: opened ? 'door' : 'along', opening: opened, door: doorPt, face: facePt, mode: usedSpot ? arrivalSpot.mode : (opened ? 'stub' : 'along'), tail: [{ x: doorPt.x, y: doorPt.y }] };   // tail: from the walk's end to the door, along what the arrival cut removed (the plan draws it dotted)
    if (!usedSpot && fin && last.type === 'door' && E.length && E[E.length - 1].edge.type === 'walk') {   // arrival: end arriveM from the door, back along the final run
      const afterRide = rides.some(x => x.afterRun === runs.length - 2);   // the final run follows a ride (afterRun is the run before the ride)
      const gone = arriveCut(fin.pts, doorPt, arriveM, afterRide ? ARRIVE_MIN_WALK_M : 0);   // a run that starts at a ride landing keeps at least ARRIVE_MIN_WALK_M of walk
      arrive.tail = gone.slice().reverse().map(g => ({ x: g.x, y: g.y })).concat([{ x: doorPt.x, y: doorPt.y }]);
      const end = fin.pts[fin.pts.length - 1], landing = afterRide && end === fin.pts[0];   // the cut stopped at the ride landing itself (the minimum walk): that vertex keeps the landing node
      const carry = ni => {   // a node whose vertex the cut removed is marked on a remaining unmarked vertex within 1 m of it, never the end vertex; otherwise it is not marked
        const nn = N[ni], q = fin.pts.filter(p => p.node == null && p !== end).map(p => [Math.hypot(p.x - nn.x, p.y - nn.y), p]).sort((a, b) => a[0] - b[0])[0];
        if (q && q[0] <= 1.0) q[1].node = ni;
      };
      for (const g of gone) {
        if (g.node == null || g.node === N.length - 1) continue;
        carry(g.node);
        nodeS[g.node] = Math.min(nodeS[g.node] == null ? end.s : nodeS[g.node], end.s);
      }
      if (!landing) {   // the last waypoint carries the destination door unless it is a ride landing: a node the cut happened to end on moves back like a cut-off one
        if (end.node != null && end.node !== N.length - 1) carry(end.node);
        end.node = N.length - 1;
      }
      fin.s1 = end.s; s = end.s; nodeS[N.length - 1] = s;
      arrive.m = +Math.hypot(end.x - doorPt.x, end.y - doorPt.y).toFixed(2);   // the cut only shortens: the walk ends at least arriveM from the door, this is the real distance
    }
    const length = s;
    const isRide = st => st.kind === 'lift' || st.kind === 'stairs' || st.kind === 'escalator';
    // the node a step's position (s) and first_waypoint refer to: the door for the arrival, the ride's own node for a ride (its leg may start
    // at the corner of a folded stub, Wayfind foldStubsIntoRides, but the ride happens at the lift), else the node its leg starts at
    const nodeIndexOfStep = st => st.kind === 'arrive' ? N.length - 1 : isRide(st) ? Math.max(0, N.findIndex(n => n.id === st.node)) : Math.min(st.firstEdge, N.length - 1);
    const stepS = plan.steps.map(st => { const v = nodeS[nodeIndexOfStep(st)]; return v == null ? length : v; });
    // Dense waypoints: every vertex of the camera path, graph nodes marked (node, type). Which step a waypoint carries:
    //   - a walk waypoint carries the step whose leg contains the edge it ends (stepOfEdge), so a turn node carries the
    //     leg *before* the turn and the first vertex after it carries the turn step; the step list's first_waypoint
    //     points at the waypoint of each step's own node;
    //   - the landing waypoint of a ride (action "lift" / "stairs", first vertex of the run after the ride) carries the
    //     step of the walk that follows the ride in `step` and the ride's own step ("Take the lift up to Level 4") in
    //     `ride_step`; a follower emits ride_step while riding and step once it walks on;
    //   - the first waypoint has action "start", the last "arrive"; the step index of the last is the final leg's.
    const waypoints = [], wpOfNode = new Map(), wpOfEdge = new Map();
    runs.forEach((r, ri) => {
      const ride = ri > 0 ? rides.find(x => x.afterRun === ri - 1) : null;
      r.pts.forEach((p, pi) => {
        const n = p.node != null ? N[p.node] : null;
        const w = { i: waypoints.length, level: r.level, x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: zOf[r.level], s: +p.s.toFixed(2),
          node: n ? n.id : '', type: n ? n.type : '', label: n ? (n.label || '').replace(/\s*\(.*\)$/, '') : '',
          action: waypoints.length === 0 ? 'start' : (pi === 0 && ride) ? ride.type : 'walk', step: stepOfEdge[p.k] };
        if (pi === 0 && ride) { w.ride_step = ride.step; ride.landing_waypoint = waypoints.length; }
        waypoints.push(w);
        if (p.node != null && !wpOfNode.has(p.node)) wpOfNode.set(p.node, waypoints.length - 1);
        if (!wpOfEdge.has(p.k)) wpOfEdge.set(p.k, waypoints.length - 1);
      });
    });
    if (waypoints.length) waypoints[waypoints.length - 1].action = 'arrive';
    const steps = plan.steps.map((st, i) => ({ i, kind: st.kind, text: st.text, hint: st.hint || '', level: st.level, to_level: st.toLevel || null, s: +stepS[i].toFixed(2),
      first_waypoint: wpOfNode.has(nodeIndexOfStep(st)) ? wpOfNode.get(nodeIndexOfStep(st)) : (st.kind === 'arrive' ? Math.max(0, waypoints.length - 1) : (wpOfEdge.get(Math.min(st.firstEdge, E.length - 1)) ?? 0)) }));   // a step whose node's vertex was cut off points at the first waypoint of its own edge
    const json = {
      venue: venue.json.id, venue_name: venue.json.name, generated: new Date().toISOString(),
      start: { node: plan.route.nodes[0], label: meta.startLabel || (N[0].label || N[0].id), level: N[0].level },
      destination: { id: plan.dest.id, name: plan.dest.name, door_node: plan.dest.door_node, level: N[N.length - 1].level,
        x: +doorPt.x.toFixed(3), y: +doorPt.y.toFixed(3), z: zOf[N[N.length - 1].level], facing: arrive.facing,
        face_x: +facePt.x.toFixed(3), face_y: +facePt.y.toFixed(3) },   // x, y: the door in the model (the centre of its opening, else the node); face_x, face_y: what the follower turns to at the end (the door, or the hanging sign at a door without an opening) 
      options: { step_free: !!(meta.options && meta.options.stepFree), avoid_lifts: !!(meta.options && meta.options.avoidLifts) },
      frame: { units: 'metres', x: 'east', y: 'north', z: 'up', floor_height_m: manifest.dimensions_m ? manifest.dimensions_m.floor_height : 4.5,
        unity: 'Both UnityGLTF and glTFast mirror X on import, so as imported Unity position = (-x, z + eye height, -y); RouteCameraFollower.cs does this with Flip X ticked (its default). After rotating the imported model 180 degrees about Y it is (x, z + eye height, y): untick Flip X.' },
      camera_path: paths ? { clearance_m: paths.clearance_m, door_stop_m: paths.door_stop_m, arrive_m: arrive.m, arrive_mode: arrive.mode, note: 'waypoints follow camera-paths.json: at least clearance_m from every wall face, stopping door_stop_m before a door. arrive_mode "front" / "oblique": the last waypoint is the spot in front of the destination door (arrive_m out along the corridor-side normal, or 45 degrees off it), reached by a straight leg from the door stub\'s corridor end that continues the approach within ' + SPOT_BEND_DEG + ' degrees; "stub": the walk ends arrive_m (straight line) from the door back along its stub (also when the spot\'s leg would bend more than that); "along": a destination without an opening, ' + ARRIVE_NO_WALL_M + ' m short, turned to its hanging sign (destination.face_x, face_y); a final run that starts at a lift or stair landing keeps at least ' + ARRIVE_MIN_WALK_M + ' m of walk; the last waypoint carries the destination door unless it is a ride landing' } : { arrive_m: arrive.m, arrive_mode: arrive.mode, note: 'camera-paths.json was not available: waypoints are the raw graph nodes' },
      walk_speed_mps: WALK_SPEED, eye_height_m: EYE_M, ride_seconds: RIDE_S,
      length_m: +length.toFixed(1), duration_s: +(length / WALK_SPEED + rides.reduce((t, r) => t + r.seconds, 0)).toFixed(1), levels: plan.levels,
      rides: rides.map(r => ({ type: r.type, from_level: r.fromLevel, to_level: r.toLevel, floors: r.floors, step: r.step, at_m: +r.s.toFixed(2), landing_waypoint: r.landing_waypoint == null ? null : r.landing_waypoint })),
      waypoints, steps,
    };
    return { json, runs, rides, length, stepS, stepOfEdge, N, E, arrive };
  }

  return { build, edgePath, nodePos, hasOpening, openingOf, doorPoint, arriveCut, WALK_SPEED, RIDE_S, EYE_M, ARRIVE_M, ARRIVE_NO_WALL_M, ARRIVE_MIN_WALK_M, SPOT_BEND_DEG, SPOT_NEAR_M };
});
