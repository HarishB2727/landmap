// Land Map — shared map engine used by the user and admin screens.
/* global L */
const LM = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    let j = {}; try { j = await r.json(); } catch (e) {}
    if (r.status === 401 && !url.includes('/login')) { location.href = '/login'; throw new Error('Please log in.'); }
    if (!r.ok) throw new Error(j.error || 'Request failed.');
    return j;
  }
  let toastTimer;
  function toast(msg) {
    let t = document.querySelector('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2600);
  }

  // ---------------- geometry & units ----------------
  const COLORS = { available: '#2e9e5b', hold: '#ee8a12', sold: '#8a8f8c' };
  const STATUS = { available: 'Available', hold: 'Hold / negotiation', sold: 'Sold' };
  function sphericalArea(ll) {
    const R = 6378137, rad = Math.PI / 180; let a = 0;
    for (let i = 0; i < ll.length; i++) { const p1 = ll[i], p2 = ll[(i + 1) % ll.length]; a += (p2.lng - p1.lng) * rad * (2 + Math.sin(p1.lat * rad) + Math.sin(p2.lat * rad)); }
    return Math.abs(a * R * R / 2);
  }
  function areaParts(m2) {
    const acres = m2 / 4046.8564224; let a = Math.floor(acres), g = Math.round((acres - a) * 40 * 10) / 10;
    if (g >= 40) { a++; g = 0; }
    return { acres, a, g, sqyd: m2 * 1.19599, sqft: m2 * 10.7639, m2 };
  }
  function areaText(m2) { const p = areaParts(m2); return p.a + ' ac ' + (p.g % 1 ? p.g.toFixed(1) : p.g) + ' gt'; }
  const fmt = n => Math.round(n).toLocaleString('en-IN');
  function dist(a, b) { return L.latLng(a).distanceTo(L.latLng(b)); }
  function pathLength(ll, closed) { let d = 0; for (let i = 1; i < ll.length; i++) d += dist(ll[i - 1], ll[i]); if (closed && ll.length > 2) d += dist(ll[ll.length - 1], ll[0]); return d; }
  const mid = (a, b) => L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
  function centroid(ll) { let x = 0, y = 0; ll.forEach(p => { x += p.lat; y += p.lng; }); return L.latLng(x / ll.length, y / ll.length); }
  const toLL = coords => coords.map(c => L.latLng(c[0], c[1]));
  const toCoords = ll => ll.map(p => [+p.lat.toFixed(7), +p.lng.toFixed(7)]);
  const num = v => Number(String(v || '').replace(/[^\d.]/g, '')) || 0;
  const rupee = v => num(v) ? '₹' + fmt(num(v)) : '—';
  function rupeeShort(v) { const n = num(v); if (!n) return '—'; if (n >= 1e7) return '₹' + (n / 1e7).toFixed(2).replace(/\.?0+$/, '') + ' Cr'; if (n >= 1e5) return '₹' + (n / 1e5).toFixed(2).replace(/\.?0+$/, '') + ' L'; return '₹' + fmt(n); }

  // ---------------- map context ----------------
  function createMap(el, settings) {
    const ctx = { settings, unit: lsGet('lm.unit') || 'ft', showLengths: lsGet('lm.lengths') !== '0', listeners: [] };
    const map = L.map(el, { zoomControl: true, maxZoom: 21, zoomSnap: 0.5, wheelPxPerZoomLevel: 90, tap: false })
      .setView(settings.center || [17.31, 78.13], settings.zoom || 14);
    ctx.map = map;
    map.attributionControl.addAttribution('Survey lines © NRSC/ISRO Bhuvan · Search © OpenStreetMap');
    const esri = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 21, maxNativeZoom: 18, attribution: 'Imagery © Esri' });
    const labels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 21, maxNativeZoom: 18, opacity: 0.8 });
    const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 21, maxNativeZoom: 19, attribution: '© OpenStreetMap contributors' });
    L.control.scale({ imperial: true, metric: true, position: 'bottomright' }).addTo(map);
    // Keep Leaflet's size in step with the layout (panel sliding, top bar hiding) without moving the map under the user.
    if (window.ResizeObserver) new ResizeObserver(() => map.invalidateSize({ pan: false })).observe(el);
    ctx.unitText = m => lenText(m, ctx.unit);
    ctx.setUnit = u => { ctx.unit = u; lsSet('lm.unit', u); ctx.emit(); };
    ctx.setShowLengths = v => { ctx.showLengths = v; lsSet('lm.lengths', v ? '1' : '0'); ctx.emit(); };
    ctx.onChange = fn => ctx.listeners.push(fn);
    ctx.emit = () => ctx.listeners.forEach(fn => fn());
    // Focus = a drawing tool is running; the page hides everything the tool does not need.
    const focusFns = [];
    ctx.onFocus = fn => focusFns.push(fn);
    ctx.setFocus = on => focusFns.forEach(fn => fn(!!on));

    // Base maps: Esri satellite and OSM street always; Google satellite / map when the admin has added a key.
    const BASES = { esri: 'Satellite', google: 'Google satellite', groad: 'Google map', osm: 'Street map' };
    const BASE_INFO = { esri: 'Esri imagery, works everywhere', google: 'Google imagery with roads and names', groad: 'Roads, places and landmarks', osm: 'OpenStreetMap roads and villages' };
    // Why Google is unavailable, in words an admin can act on (Google reports most key problems only in the console).
    const GOOGLE_ERR = { nokey: 'Needs a Google Maps key (Admin › Settings)', loading: 'Loading…', BillingNotEnabledMapError: 'Not working: turn on billing for this key in Google Cloud',
      ApiNotActivatedMapError: 'Not working: enable “Maps JavaScript API” for this key', RefererNotAllowedMapError: 'Not working: this website is not allowed on the key', rejected: 'Not working: Google rejected the key', failed: 'Could not load Google maps' };
    const gLayers = {}; let pendingBase = null;
    ctx.base = null; ctx.googleReady = false; ctx.googleError = settings.googleKey ? 'loading' : 'nokey';
    const isGoogle = w => w === 'google' || w === 'groad';
    const layersOf = w => w === 'esri' ? [esri, labels] : w === 'osm' ? [osm] : gLayers[w] ? [gLayers[w]] : [];
    ctx.setBase = (which, quiet) => {
      if (!BASES[which]) which = 'esri';
      if (isGoogle(which) && !ctx.googleReady) {
        if (ctx.googleError === 'loading') { pendingBase = which; if (!quiet) toast('Google maps are still loading…'); renderPick(); return; }
        if (!quiet) toast(GOOGLE_ERR[ctx.googleError] || GOOGLE_ERR.rejected);
        which = ctx.base || 'esri';
      }
      pendingBase = null;
      if (ctx.base !== which) {
        if (ctx.base) layersOf(ctx.base).forEach(l => map.removeLayer(l));
        layersOf(which).forEach(l => l.addTo(map));
        ctx.base = which;
      }
      if (!quiet) lsSet('lm.base', which);
      renderPick(); ctx.emit();
    };
    function googleBroken(code) {
      if (ctx.googleError && ctx.googleError !== 'loading') return;
      ctx.googleReady = false; ctx.googleError = GOOGLE_ERR[code] ? code : 'rejected'; pendingBase = null;
      if (isGoogle(ctx.base)) { ctx.setBase('esri', true); toast('Google maps: ' + GOOGLE_ERR[ctx.googleError].replace(/^Not working: /, '') + '. Showing satellite instead.'); }
      else renderPick();
      ctx.emit();
    }
    ctx.loadGoogle = key => new Promise(resolve => {
      if (!key) return resolve(false);
      const ready = () => {
        gLayers.google = L.gridLayer.googleMutant({ type: 'hybrid', maxZoom: 21 });
        gLayers.groad = L.gridLayer.googleMutant({ type: 'roadmap', maxZoom: 21 });
        if (ctx.googleError !== 'loading') return resolve(false); // key already failed
        ctx.googleReady = true; ctx.googleError = null;
        if (pendingBase) ctx.setBase(pendingBase, true); else { renderPick(); ctx.emit(); }
        resolve(true);
      };
      const fail = () => { googleBroken('failed'); resolve(false); };
      window.__lmGoogleReady = () => {
        const s = document.createElement('script');
        s.src = '/vendor/Leaflet.GoogleMutant.js'; s.onload = ready; s.onerror = fail;
        document.head.appendChild(s);
      };
      window.gm_authFailure = () => googleBroken('rejected');
      // Billing / API-not-enabled errors never reach gm_authFailure; Google only logs them, e.g. "Google Maps JavaScript API error: BillingNotEnabledMapError".
      const origError = console.error;
      console.error = function (...args) {
        const m = /Google Maps JavaScript API error: (\w+MapError)/.exec(args.map(String).join(' '));
        if (m) googleBroken(m[1]);
        return origError.apply(this, args);
      };
      const g = document.createElement('script');
      g.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) + '&loading=async&callback=__lmGoogleReady';
      g.async = true; g.onerror = fail; document.head.appendChild(g);
    });

    // Map-style picker (bottom-left of the map)
    const pick = document.createElement('div'); pick.className = 'basepick';
    pick.innerHTML = '<div class="basemenu" hidden></div><button type="button" class="basebtn" title="Map style"><i class="bsw"></i><span></span>' +
      '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 15l6-6 6 6"/></svg></button>';
    el.parentElement.appendChild(pick);
    L.DomEvent.disableClickPropagation(pick); L.DomEvent.disableScrollPropagation(pick);
    const menu = pick.querySelector('.basemenu'), pbtn = pick.querySelector('.basebtn');
    function renderPick() {
      const cur = pendingBase || ctx.base || 'esri';
      pbtn.querySelector('.bsw').className = 'bsw ' + cur;
      pbtn.querySelector('span').textContent = BASES[cur];
      const off = k => isGoogle(k) && ctx.googleError && ctx.googleError !== 'loading';
      menu.innerHTML = '<div class="small" style="padding:4px 8px 2px">Map style</div>' + ['esri', 'google', 'groad', 'osm'].map(k =>
        '<button type="button" data-base="' + k + '" class="' + (k === cur ? 'on' : '') + (off(k) ? ' off' : '') + '"><i class="bsw ' + k + '"></i><span><b>' + BASES[k] + '</b><small>' +
        (isGoogle(k) && ctx.googleError ? GOOGLE_ERR[ctx.googleError] : BASE_INFO[k]) + '</small></span></button>').join('');
    }
    pbtn.addEventListener('click', () => { menu.hidden = !menu.hidden; pick.classList.toggle('open', !menu.hidden); });
    menu.addEventListener('click', e => { const b = e.target.closest('[data-base]'); if (!b) return; ctx.setBase(b.dataset.base); if (!b.classList.contains('off')) { menu.hidden = true; pick.classList.remove('open'); } });
    document.addEventListener('click', e => { if (!menu.hidden && !pick.contains(e.target)) { menu.hidden = true; pick.classList.remove('open'); } });
    ctx.setBase('esri', true);
    { const saved = lsGet('lm.base'); if (saved && saved !== 'esri') ctx.setBase(saved, true); }

    // Survey-number overlay from Bhuvan (fixed EPSG:4326 grid: origin -180,-90, 256px, 0.703125/2^n deg per px)
    map.createPane('cad'); map.getPane('cad').style.zIndex = 420; map.getPane('cad').style.pointerEvents = 'none';
    const cad = { on: false, opacity: 0.9, tiles: new Map(), loaded: 0, failed: 0 };
    ctx.cad = cad;
    const chip = document.createElement('div'); chip.className = 'status-chip'; chip.hidden = true; el.parentElement.appendChild(chip);
    function cadStatus(text, bad) { chip.textContent = text; chip.className = 'status-chip' + (bad ? ' bad' : ''); chip.hidden = !text; }
    function clearCad() { cad.tiles.forEach(t => map.removeLayer(t)); cad.tiles.clear(); }
    function updateCad() {
      if (!cad.on) { clearCad(); cadStatus(''); return; }
      const z = Math.round(map.getZoom());
      if (z < 14) { clearCad(); cadStatus('Zoom in to see survey numbers'); return; }
      const n = Math.min(z - 1, 18), t = 256 * 0.703125 / Math.pow(2, n), b = map.getBounds();
      const x0 = Math.floor((b.getWest() + 180) / t), x1 = Math.floor((b.getEast() + 180) / t);
      const y0 = Math.floor((b.getSouth() + 90) / t), y1 = Math.floor((b.getNorth() + 90) / t);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 160) { clearCad(); cadStatus('Zoom in to see survey numbers'); return; }
      const want = new Set(); cad.loaded = 0; cad.failed = 0;
      const base = settings.cadUrl, layer = settings.cadLayer;
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const key = n + '/' + x + '/' + y; want.add(key);
        if (cad.tiles.has(key)) { cad.loaded++; continue; }
        const w = -180 + x * t, s = -90 + y * t;
        const url = base + (base.includes('?') ? '&' : '?') + 'LAYERS=' + encodeURIComponent(layer) +
          '&TRANSPARENT=TRUE&SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&STYLES=&FORMAT=image%2Fpng&SRS=EPSG%3A4326&BBOX=' + [w, s, w + t, s + t].join(',') + '&WIDTH=256&HEIGHT=256';
        const ov = L.imageOverlay(url, [[s, w], [s + t, w + t]], { pane: 'cad', opacity: cad.opacity, interactive: false });
        ov.on('load', () => { cad.loaded++; report(); }); ov.on('error', () => { cad.failed++; report(); });
        ov.addTo(map); cad.tiles.set(key, ov);
      }
      cad.tiles.forEach((ov, key) => { if (!want.has(key)) { map.removeLayer(ov); cad.tiles.delete(key); } });
      report();
    }
    function report() { if (cad.failed && !cad.loaded) cadStatus('Survey numbers could not load here', true); else cadStatus(''); }
    map.on('moveend', updateCad);
    ctx.setSurvey = on => { cad.on = !!on; updateCad(); ctx.emit(); };
    ctx.setSurveyOpacity = o => { cad.opacity = o; cad.tiles.forEach(t => t.setOpacity(o)); };
    ctx.refreshSurvey = () => { clearCad(); updateCad(); };
    return ctx;
  }
  function lenText(m, unit) {
    if (unit === 'm') return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : (m < 100 ? m.toFixed(1) : fmt(m)) + ' m';
    const ft = m * 3.28084;
    return ft >= 5280 ? (ft / 5280).toFixed(2) + ' mi' : (ft < 100 ? ft.toFixed(1) : fmt(ft)) + ' ft';
  }

  // ---------------- labels ----------------
  function label(latlng, text, cls) {
    return L.marker(latlng, { interactive: false, keyboard: false, icon: L.divIcon({ className: 'leaflet-div-icon lbl', html: '<span class="seg-label ' + (cls || '') + '">' + text + '</span>', iconSize: [0, 0] }) });
  }
  // Side lengths (and optional area tag) for a ring or path
  function edgeLabels(ctx, group, ll, closed, withArea) {
    group.clearLayers();
    if (ctx.showLengths) {
      const n = closed ? ll.length : ll.length - 1;
      for (let i = 0; i < n; i++) { const a = ll[i], b = ll[(i + 1) % ll.length]; group.addLayer(label(mid(a, b), ctx.unitText(dist(a, b)))); }
    }
    if (withArea && closed && ll.length >= 3) group.addLayer(label(centroid(ll), areaText(sphericalArea(ll)), 'area'));
  }
  function sideList(ctx, ll, closed) {
    const n = closed ? ll.length : ll.length - 1, out = [];
    for (let i = 0; i < n; i++) out.push(ctx.unitText(dist(ll[i], ll[(i + 1) % ll.length])));
    return out;
  }

  // ---------------- draw tool (plots and distances) ----------------
  // Tap to drop points; drag/zoom freely between taps. Live length label follows the cursor.
  function DrawTool(ctx, mapWrap) {
    const map = ctx.map;
    const bar = document.createElement('div'); bar.className = 'drawbar'; bar.hidden = true;
    bar.innerHTML = '<div class="ttl"></div><div class="stats"></div><div class="hint"></div><div class="row">' +
      '<button type="button" data-a="center">+ Point at crosshair</button><button type="button" data-a="undo">Undo</button>' +
      '<button type="button" class="primary" data-a="finish">Finish</button><button type="button" data-a="cancel">Cancel</button></div>';
    const cross = document.createElement('div'); cross.className = 'crosshair'; cross.hidden = true;
    mapWrap.appendChild(bar); mapWrap.appendChild(cross);
    const group = L.featureGroup().addTo(map);
    const T = { mode: null, pts: [], cursor: null, onFinish: null, active: false };
    let line, live, liveLbl, labels, verts;
    function start(mode, onFinish, title) {
      cancel(true, true);
      T.mode = mode; T.pts = []; T.cursor = null; T.onFinish = onFinish; T.active = true;
      bar.querySelector('.ttl').textContent = title || (mode === 'plot' ? 'Measure area' : 'Measure distance');
      ctx.setFocus(true);
      const color = mode === 'plot' ? '#ffd23f' : '#3fb6ff';
      line = (mode === 'plot' ? L.polygon([], { color, weight: 3, fillOpacity: 0.15 }) : L.polyline([], { color, weight: 3 })).addTo(group);
      live = L.polyline([], { color, weight: 2, dashArray: '6 6', interactive: false }).addTo(group);
      labels = L.featureGroup().addTo(group); verts = L.featureGroup().addTo(group);
      map.doubleClickZoom.disable(); map.getContainer().style.cursor = 'crosshair';
      bar.hidden = false; cross.hidden = false; render();
    }
    function add(latlng) {
      if (!T.active) return;
      if (T.mode === 'plot' && T.pts.length >= 3) {
        const p0 = map.latLngToContainerPoint(T.pts[0]), p = map.latLngToContainerPoint(latlng);
        if (p0.distanceTo(p) < 16) return finish();
      }
      T.pts.push(L.latLng(latlng)); render();
    }
    function undo() { if (T.pts.length) { T.pts.pop(); render(); } }
    function render() {
      const pts = T.pts, plot = T.mode === 'plot';
      line.setLatLngs(pts);
      labels.clearLayers();
      if (ctx.showLengths) {
        for (let i = 1; i < pts.length; i++) labels.addLayer(label(mid(pts[i - 1], pts[i]), ctx.unitText(dist(pts[i - 1], pts[i]))));
        if (plot && pts.length >= 3) labels.addLayer(label(mid(pts[pts.length - 1], pts[0]), ctx.unitText(dist(pts[pts.length - 1], pts[0]))));
      }
      verts.clearLayers();
      pts.forEach((p, i) => {
        const first = i === 0 && plot && pts.length >= 3;
        const v = L.circleMarker(p, { radius: first ? 9 : 6, color: '#18241d', weight: 2, fillColor: first ? '#fff' : (plot ? '#ffd23f' : '#3fb6ff'), fillOpacity: 1, bubblingMouseEvents: false });
        if (first) v.on('click', finish);
        verts.addLayer(v);
      });
      renderLive();
      let html;
      if (plot) {
        html = '<span>Corners <b>' + pts.length + '</b></span><span>Boundary <b>' + ctx.unitText(pathLength(pts, pts.length >= 3)) + '</b></span>';
        if (pts.length >= 3) { const a = areaParts(sphericalArea(pts)); html += '<span>Area <b>' + areaText(a.m2) + '</b></span><span><b>' + fmt(a.sqyd) + '</b> sq yd</span>'; }
      } else html = '<span>Points <b>' + pts.length + '</b></span><span>Total <b>' + ctx.unitText(pathLength(pts, false)) + '</b></span>';
      bar.querySelector('.stats').innerHTML = html;
      bar.querySelector('.hint').textContent = !pts.length ? 'Tap the map to drop the first point. Drag or zoom any time.'
        : plot ? (pts.length < 3 ? 'Keep tapping corners. Zoom in for accuracy.' : 'Tap the first corner (white dot) or Finish to close.')
        : 'Keep tapping points. Finish when done.';
      bar.querySelector('[data-a=finish]').disabled = plot ? pts.length < 3 : pts.length < 2;
      bar.querySelector('[data-a=undo]').disabled = !pts.length;
    }
    function renderLive() {
      if (liveLbl) { group.removeLayer(liveLbl); liveLbl = null; }
      const last = T.pts[T.pts.length - 1];
      if (!last || !T.cursor) { live.setLatLngs([]); return; }
      const seg = [last, T.cursor]; if (T.mode === 'plot' && T.pts.length >= 2) seg.push(T.pts[0]);
      live.setLatLngs(seg);
      const s = dist(last, T.cursor);
      let txt = ctx.unitText(s);
      if (T.mode === 'line') txt += ' · total ' + ctx.unitText(pathLength(T.pts, false) + s);
      if (T.mode === 'plot' && T.pts.length >= 2) txt += ' · ' + areaText(sphericalArea(T.pts.concat([T.cursor])));
      liveLbl = label(T.cursor, txt, 'live').addTo(group);
    }
    function finish() {
      if (!T.active) return;
      const pts = T.pts.slice(), mode = T.mode, cb = T.onFinish;
      if ((mode === 'plot' && pts.length < 3) || (mode === 'line' && pts.length < 2)) return;
      cancel(); if (cb) cb(pts, mode);
    }
    function cancel(silent, keepFocus) {
      const was = T.active;
      T.active = false; T.mode = null; T.pts = []; T.cursor = null;
      group.clearLayers(); liveLbl = null;
      map.doubleClickZoom.enable(); map.getContainer().style.cursor = '';
      bar.hidden = true; cross.hidden = true;
      if (was && !keepFocus) ctx.setFocus(false);
      if (was && !silent && T.onCancel) T.onCancel();
    }
    let raf = false;
    map.on('mousemove', e => { if (!T.active || !T.pts.length) return; T.cursor = e.latlng; if (!raf) { raf = true; requestAnimationFrame(() => { raf = false; if (T.active) renderLive(); }); } });
    map.on('mouseout', () => { if (T.active) { T.cursor = null; renderLive(); } });
    map.on('click', e => { if (T.active) add(e.latlng); });
    ctx.onChange(() => { if (T.active) render(); });
    bar.addEventListener('click', e => {
      const a = e.target.closest('[data-a]'); if (!a) return;
      ({ center: () => add(map.getCenter()), undo, finish, cancel: () => cancel() })[a.dataset.a]();
    });
    document.addEventListener('keydown', e => {
      if (!T.active || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
      if (e.key === 'Escape') cancel(); else if (e.key === 'Enter') finish();
      else if (e.key === 'Backspace' || (e.key === 'z' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); undo(); }
    });
    T.start = start; T.cancel = cancel; T.add = add; T.finish = finish;
    return T;
  }

  // ---------------- freehand sketch ----------------
  function Sketch(ctx, mapWrap) {
    const map = ctx.map, layer = L.featureGroup();
    const S = { items: [], tool: 'move', color: '#e53935', width: 4, active: false, history: [], dirty: false, onDirty: null };
    const COLORS_ = ['#e53935', '#ffd23f', '#1e88e5', '#ffffff', '#111111'];
    const bar = document.createElement('div'); bar.className = 'sketchbar'; bar.hidden = true;
    const ic = {
      move: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3"/></svg>',
      pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21l3-1 12-12-2-2L4 18z"/><path d="M14 6l2 2"/></svg>',
      line: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20L20 4"/></svg>',
      text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 6V4h14v2M12 4v16M9 20h6"/></svg>',
      erase: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 3l5 5-11 11H5l-2-2z"/><path d="M8 21h13"/></svg>',
      undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/></svg>'
    };
    bar.innerHTML =
      ['move', 'pen', 'line', 'text', 'erase'].map(t => '<button type="button" data-tool="' + t + '" title="' + ({ move: 'Move / zoom map', pen: 'Draw freehand', line: 'Straight line', text: 'Add text', erase: 'Tap a drawing to remove it' })[t] + '">' + ic[t] + '<span class="tl">' + ({ move: 'Move', pen: 'Pen', line: 'Line', text: 'Text', erase: 'Erase' })[t] + '</span></button>').join('') +
      '<span class="sep"></span>' + COLORS_.map(c => '<button type="button" class="swatch" data-color="' + c + '" style="background:' + c + '" title="Colour"></button>').join('') +
      '<span class="sep"></span><button type="button" data-w="3" title="Thin">S</button><button type="button" data-w="6" title="Thick">L</button>' +
      '<span class="sep"></span><button type="button" data-a="undo" title="Undo">' + ic.undo + '</button>' +
      '<button type="button" class="primary" data-a="save" title="Save this sketch">Save</button>';
    mapWrap.appendChild(bar);
    const textPop = document.createElement('form'); textPop.className = 'text-pop'; textPop.hidden = true;
    textPop.innerHTML = '<input id="sketchTextIn" placeholder="Type a label" maxlength="60"><button class="primary" type="submit">Add</button>';
    mapWrap.appendChild(textPop);
    let textAt = null;

    function render() {
      layer.clearLayers();
      S.items.forEach((it, idx) => {
        let l;
        if (it.type === 'text') {
          l = L.marker(it.pts[0], { icon: L.divIcon({ className: 'leaflet-div-icon lbl', html: '<span class="sketch-text" style="color:' + esc(it.color) + '">' + esc(it.text) + '</span>', iconSize: [0, 0] }) });
        } else {
          l = L.polyline(it.pts, { color: it.color, weight: it.width, lineCap: 'round', lineJoin: 'round', smoothFactor: 1 });
        }
        l.on('click', e => { if (S.active && S.tool === 'erase') { L.DomEvent.stop(e); push(); S.items.splice(idx, 1); markDirty(); render(); } });
        layer.addLayer(l);
      });
    }
    function push() { S.history.push(JSON.stringify(S.items)); if (S.history.length > 60) S.history.shift(); }
    function markDirty() { S.dirty = true; if (S.onDirty) S.onDirty(); }
    function setTool(t) {
      S.tool = t;
      bar.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
      const drawing = S.active && (t === 'pen' || t === 'line');
      if (drawing) map.dragging.disable(); else map.dragging.enable();
      map.getContainer().style.cursor = S.active && t !== 'move' ? 'crosshair' : '';
    }
    function setColor(c) { S.color = c; bar.querySelectorAll('[data-color]').forEach(b => b.classList.toggle('on', b.dataset.color === c)); }
    function setWidth(w) { S.width = w; bar.querySelectorAll('[data-w]').forEach(b => b.classList.toggle('on', +b.dataset.w === w)); }
    bar.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.tool) setTool(b.dataset.tool);
      else if (b.dataset.color) setColor(b.dataset.color);
      else if (b.dataset.w) setWidth(+b.dataset.w);
      else if (b.dataset.a === 'undo') undo();
      else if (b.dataset.a === 'save' && S.onSave) S.onSave();
    });

    // Pointer drawing: one finger/mouse draws; a second finger cancels the stroke so pinch-zoom still works.
    const el = map.getContainer(), pointers = new Set();
    let cur = null, curLine = null;
    el.addEventListener('pointerdown', e => {
      pointers.add(e.pointerId);
      if (!S.active) return;
      if (pointers.size > 1) { abortStroke(); return; }
      if (e.target.closest('.leaflet-control, .sketchbar, .text-pop')) return;
      if (S.tool === 'pen' || S.tool === 'line') {
        const ll = map.mouseEventToLatLng(e);
        cur = { type: S.tool, color: S.color, width: S.width, pts: [ll] };
        curLine = L.polyline(S.tool === 'line' ? [ll, ll] : [ll], { color: S.color, weight: S.width, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(map);
        try { el.setPointerCapture(e.pointerId); } catch (err) {}
      } else if (S.tool === 'text') {
        textAt = map.mouseEventToLatLng(e);
        const r = el.getBoundingClientRect(), wr = mapWrap.getBoundingClientRect();
        textPop.style.left = Math.min(e.clientX - wr.left, wr.width - 260) + 'px'; textPop.style.top = (e.clientY - wr.top + 10) + 'px';
        textPop.hidden = false; setTimeout(() => $('sketchTextIn').focus(), 0);
      }
    });
    el.addEventListener('pointermove', e => {
      if (!cur || pointers.size > 1) return;
      const ll = map.mouseEventToLatLng(e);
      if (cur.type === 'line') { cur.pts[1] = ll; curLine.setLatLngs(cur.pts); return; }
      const lastPx = map.latLngToContainerPoint(cur.pts[cur.pts.length - 1]), px = map.latLngToContainerPoint(ll);
      if (lastPx.distanceTo(px) >= 2) { cur.pts.push(ll); curLine.addLatLng(ll); }
    });
    const endStroke = e => {
      pointers.delete(e.pointerId);
      if (!cur) return;
      if (curLine) map.removeLayer(curLine);
      if (cur.type === 'line' && cur.pts.length < 2) cur.pts.push(cur.pts[0]);
      const ok = cur.pts.length >= 2 && !(cur.type === 'line' && cur.pts[0].equals(cur.pts[1]));
      if (ok) { push(); cur.pts = cur.pts.map(p => [+p.lat.toFixed(7), +p.lng.toFixed(7)]); S.items.push(cur); markDirty(); render(); }
      cur = null; curLine = null;
    };
    function abortStroke() { if (curLine) map.removeLayer(curLine); cur = null; curLine = null; }
    el.addEventListener('pointerup', endStroke); el.addEventListener('pointercancel', endStroke); el.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') endStroke(e); });
    textPop.addEventListener('submit', e => {
      e.preventDefault(); const v = $('sketchTextIn').value.trim();
      if (v && textAt) { push(); S.items.push({ type: 'text', color: S.color, width: S.width, pts: [[+textAt.lat.toFixed(7), +textAt.lng.toFixed(7)]], text: v }); markDirty(); render(); }
      $('sketchTextIn').value = ''; textPop.hidden = true;
    });
    $('sketchTextIn').addEventListener('keydown', e => { if (e.key === 'Escape') textPop.hidden = true; });
    function undo() { if (!S.history.length) return; S.items = JSON.parse(S.history.pop()); markDirty(); render(); }

    S.enable = () => { S.active = true; bar.hidden = false; layer.addTo(map); setTool(S.tool === 'move' ? 'pen' : S.tool); };
    S.disable = () => { S.active = false; bar.hidden = true; textPop.hidden = true; abortStroke(); map.dragging.enable(); map.getContainer().style.cursor = ''; };
    S.hideLayer = () => map.removeLayer(layer);
    S.load = items => { S.items = JSON.parse(JSON.stringify(items || [])); S.history = []; S.dirty = false; render(); };
    S.clear = () => { if (!S.items.length) return; push(); S.items = []; markDirty(); render(); };
    S.undo = undo;
    setColor(S.color); setWidth(S.width);
    return S;
  }

  // ---------------- search ----------------
  function Search(ctx, input, results) {
    const map = ctx.map; let marker = null;
    function parseLatLng(q) {
      const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/); if (!m) return null;
      let a = +m[1], b = +m[2]; if (Math.abs(a) > 90 && Math.abs(b) <= 90) [a, b] = [b, a];
      return Math.abs(a) <= 90 && Math.abs(b) <= 180 ? L.latLng(a, b) : null;
    }
    function go(ll, name, zoom) {
      map.setView(ll, zoom || 16); if (marker) map.removeLayer(marker);
      marker = L.marker(ll).addTo(map).bindPopup(esc(name) + '<br><span class="small">' + ll.lat.toFixed(6) + ', ' + ll.lng.toFixed(6) + '</span>').openPopup();
      results.hidden = true;
    }
    function show(items, note) {
      results.innerHTML = '';
      if (!items.length) { results.innerHTML = '<div class="small" style="padding:10px 12px">' + esc(note || 'No places found. Try adding the mandal or district.') + '</div>'; results.hidden = false; return; }
      items.forEach(it => { const b = document.createElement('button'); b.type = 'button'; b.innerHTML = esc(it.name) + '<small>' + esc(it.detail) + '</small>'; b.onclick = () => go(L.latLng(it.lat, it.lng), it.name, 16); results.appendChild(b); });
      results.hidden = false;
    }
    async function google(q) {
      if (!(window.google && google_ok())) return [];
      return new Promise(res => new window.google.maps.Geocoder().geocode({ address: q, region: 'in' }, (out, st) => res(st === 'OK' && out ? out.slice(0, 5).map(o => ({ name: o.formatted_address.split(',')[0], detail: o.formatted_address, lat: o.geometry.location.lat(), lng: o.geometry.location.lng() })) : [])));
    }
    const google_ok = () => window.google && window.google.maps && window.google.maps.Geocoder;
    async function photon(q) {
      const c = map.getCenter();
      const j = await (await fetch('https://photon.komoot.io/api/?limit=6&lang=en&q=' + encodeURIComponent(q) + '&lat=' + c.lat.toFixed(3) + '&lon=' + c.lng.toFixed(3))).json();
      return (j.features || []).map(f => { const p = f.properties; return { name: p.name || p.street || q, detail: [p.district, p.city, p.county, p.state].filter(Boolean).join(', '), lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }; });
    }
    async function nominatim(q) {
      const j = await (await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=in&q=' + encodeURIComponent(q))).json();
      return j.map(o => ({ name: o.display_name.split(',')[0], detail: o.display_name, lat: +o.lat, lng: +o.lon }));
    }
    async function run() {
      const q = input.value.trim(); if (!q) return;
      const ll = parseLatLng(q); if (ll) return go(ll, 'Location', 18);
      show([], 'Searching…'); let items = [];
      try { items = await google(q); } catch (e) {}
      if (!items.length) try { items = await photon(q); } catch (e) {}
      if (!items.length) try { items = await nominatim(q); } catch (e) {}
      show(items);
    }
    input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); if (e.key === 'Escape') results.hidden = true; });
    document.addEventListener('click', e => { if (!input.parentElement.contains(e.target)) results.hidden = true; });
    return { run };
  }

  // ---------------- live location ----------------
  function Locate(ctx, btn) {
    const map = ctx.map; let watch = null, dot = null, circle = null, follow = true;
    function stop() { if (watch !== null) navigator.geolocation.clearWatch(watch); watch = null; if (dot) map.removeLayer(dot); if (circle) map.removeLayer(circle); dot = circle = null; btn.classList.remove('on'); }
    btn.addEventListener('click', () => {
      if (watch !== null) return stop();
      if (!navigator.geolocation) return toast('This browser cannot share location.');
      follow = true; btn.classList.add('on');
      watch = navigator.geolocation.watchPosition(pos => {
        const ll = L.latLng(pos.coords.latitude, pos.coords.longitude), acc = pos.coords.accuracy;
        if (!dot) {
          circle = L.circle(ll, { radius: acc, color: '#1a73e8', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
          dot = L.marker(ll, { icon: L.divIcon({ className: 'leaflet-div-icon lbl', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 }).addTo(map);
          map.setView(ll, Math.max(map.getZoom(), 18));
        } else { dot.setLatLng(ll); circle.setLatLng(ll).setRadius(acc); if (follow) map.panTo(ll); }
        dot.bindPopup('You are here<br>' + ll.lat.toFixed(6) + ', ' + ll.lng.toFixed(6) + '<br>Accuracy about ' + ctx.unitText(acc));
      }, err => { stop(); toast(err.code === 1 ? 'Location is blocked. Allow location for this site in your browser.' : 'Could not get your location.'); },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
    });
    map.on('dragstart', () => { follow = false; });
  }

  // ---------------- layers popover ----------------
  // opts: { surveyAllowed, onSurvey }
  function LayersControl(ctx, btn, pop, opts) {
    pop.innerHTML =
      '<label class="switch" id="lcSurveyRow">Survey numbers <input type="checkbox" id="lcSurvey"></label>' +
      '<label class="switch">Side lengths <input type="checkbox" id="lcLengths"></label>' +
      '<div><label>Units</label><div class="seg"><button type="button" data-u="ft">Feet</button><button type="button" data-u="m">Metres</button></div></div>';
    pop.hidden = true;
    btn.addEventListener('click', e => { e.stopPropagation(); pop.hidden = !pop.hidden; btn.classList.toggle('on', !pop.hidden); });
    document.addEventListener('click', e => { if (!pop.hidden && !pop.contains(e.target) && e.target !== btn) { pop.hidden = true; btn.classList.remove('on'); } });
    $('lcSurvey').onchange = e => ctx.setSurvey(e.target.checked);
    $('lcLengths').onchange = e => ctx.setShowLengths(e.target.checked);
    pop.querySelectorAll('[data-u]').forEach(b => b.onclick = () => ctx.setUnit(b.dataset.u));
    function sync() {
      $('lcSurveyRow').hidden = !opts.surveyAllowed();
      $('lcSurvey').checked = ctx.cad.on;
      $('lcLengths').checked = ctx.showLengths;
      pop.querySelectorAll('[data-u]').forEach(b => b.classList.toggle('on', b.dataset.u === ctx.unit));
    }
    ctx.onChange(sync); sync();
    return { sync };
  }

  // ---------------- measure tab (nothing saved) ----------------
  function Measure(ctx, draw, listEl) {
    const map = ctx.map, group = L.featureGroup(); const shapes = [];
    function addShape(pts, mode) {
      const color = mode === 'plot' ? '#ffd23f' : '#3fb6ff';
      const layer = mode === 'plot' ? L.polygon(pts, { color, weight: 3, fillOpacity: 0.18 }) : L.polyline(pts, { color, weight: 3 });
      const lbl = L.featureGroup();
      const s = { pts, mode, layer, lbl, n: shapes.length + 1 };
      group.addLayer(layer); group.addLayer(lbl); shapes.push(s); refresh();
    }
    function refresh() {
      shapes.forEach(s => {
        if (s.mode === 'plot') edgeLabels(ctx, s.lbl, s.pts, true, true);
        else { edgeLabels(ctx, s.lbl, s.pts, false, false); s.lbl.addLayer(label(s.pts[s.pts.length - 1], 'Total ' + ctx.unitText(pathLength(s.pts, false)), 'area')); }
      });
      if (!listEl) return;
      if (!shapes.length) { listEl.innerHTML = '<p class="empty">Nothing measured yet. Use the buttons above, then tap points on the map.</p>'; return; }
      listEl.innerHTML = shapes.map((s, i) => {
        if (s.mode === 'plot') {
          const a = areaParts(sphericalArea(s.pts));
          return '<div class="card"><div class="row" style="justify-content:space-between"><b>Plot ' + s.n + '</b><button type="button" class="ghost danger" data-del="' + i + '">Remove</button></div>' +
            '<div class="kv"><span>Area</span><b>' + areaText(a.m2) + '</b><span>Acres</span><b>' + a.acres.toFixed(3) + '</b><span>Guntas</span><b>' + (a.acres * 40).toFixed(1) + '</b>' +
            '<span>Sq yards</span><b>' + fmt(a.sqyd) + '</b><span>Sq feet</span><b>' + fmt(a.sqft) + '</b><span>Boundary</span><b>' + ctx.unitText(pathLength(s.pts, true)) + '</b></div>' +
            '<div class="small">Sides</div><div class="sides">' + sideList(ctx, s.pts, true).map((t, k) => '<span>' + String.fromCharCode(65 + (k % 26)) + ': ' + t + '</span>').join('') + '</div></div>';
        }
        return '<div class="card"><div class="row" style="justify-content:space-between"><b>Distance ' + s.n + '</b><button type="button" class="ghost danger" data-del="' + i + '">Remove</button></div>' +
          '<div class="kv"><span>Total</span><b>' + ctx.unitText(pathLength(s.pts, false)) + '</b></div><div class="sides">' + sideList(ctx, s.pts, false).map(t => '<span>' + t + '</span>').join('') + '</div></div>';
      }).join('');
      listEl.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { const s = shapes.splice(+b.dataset.del, 1)[0]; group.removeLayer(s.layer); group.removeLayer(s.lbl); refresh(); });
    }
    ctx.onChange(refresh);
    return {
      show() { group.addTo(map); refresh(); },
      hide() { map.removeLayer(group); },
      start(mode) { draw.start(mode, (pts, m) => addShape(pts, m), mode === 'plot' ? 'Measure area' : 'Measure distance'); },
      clear() { shapes.splice(0).forEach(s => { group.removeLayer(s.layer); group.removeLayer(s.lbl); }); refresh(); }
    };
  }

  // ---------------- side panel ----------------
  // Desktop: slides off to the right. Phone: bottom sheet. While a drawing tool runs, the top bar and panel step aside;
  // the panel button on the map brings the panel back, and it returns to how it was when the tool ends.
  function Panel(ctx, panel, head, headLbl, btn) {
    const map = ctx.map, mapEl = map.getContainer();
    let wasOpen = null, focused = false;
    const isOpen = () => !panel.classList.contains('collapsed');
    function set(open) {
      panel.classList.toggle('collapsed', !open);
      if (headLbl) headLbl.textContent = open ? 'Hide' : 'Show';
      btn.classList.toggle('on', open); btn.title = open ? 'Hide panel' : 'Show panel'; btn.setAttribute('aria-label', btn.title);
    }
    // Hiding the top bar moves the map up; pan by the same amount so nothing jumps under the finger.
    function steady(fn) { const t0 = mapEl.getBoundingClientRect().top; fn(); const t1 = mapEl.getBoundingClientRect().top; if (t1 !== t0) map.panBy([0, t1 - t0], { animate: false }); }
    head.addEventListener('click', () => set(!isOpen()));
    btn.addEventListener('click', () => set(!isOpen()));
    ctx.onFocus(on => {
      if (on === focused) return; focused = on;
      steady(() => {
        document.body.classList.toggle('focus', on);
        if (on) { wasOpen = isOpen(); set(false); } else if (wasOpen !== null) { set(wasOpen); wasOpen = null; }
      });
    });
    set(isOpen());
    return { open: () => set(true), close: () => set(false), isOpen };
  }

  return { $, esc, api, toast, lsGet, lsSet, COLORS, STATUS, sphericalArea, areaParts, areaText, fmt, dist, pathLength, mid, centroid, toLL, toCoords, num, rupee, rupeeShort,
    createMap, lenText, label, edgeLabels, sideList, DrawTool, Sketch, Search, Locate, LayersControl, Measure, Panel };
})();
