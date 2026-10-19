/* Feldbuch – Phase 1
   Daten bleiben auf dem Gerät (IndexedDB). Koordinaten intern immer WGS84 (lon, lat). */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const DEFAULT_ACTS = ["Flachgrubbern", "Scheibenegge", "Pflügen", "Säen", "Walzen", "Düngen", "Pflanzenschutz", "Striegeln", "Mähen", "Ernte"];

  // ---------- IndexedDB ----------
  const DB = {
    db: null,
    open() {
      return new Promise((res, rej) => {
        const r = indexedDB.open("feldbuch", 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          d.createObjectStore("fields", { keyPath: "id" });
          d.createObjectStore("entries", { keyPath: "id" });
          d.createObjectStore("photos", { keyPath: "id" });
          d.createObjectStore("meta", { keyPath: "key" });
        };
        r.onsuccess = () => { DB.db = r.result; res(); };
        r.onerror = () => rej(r.error);
      });
    },
    tx(store, mode, fn) {
      return new Promise((res, rej) => {
        const t = DB.db.transaction(store, mode);
        let out;
        const s = Array.isArray(store) ? store.map((n) => t.objectStore(n)) : t.objectStore(store);
        out = fn(s);
        t.oncomplete = () => res(out && out.result !== undefined && out instanceof IDBRequest ? out.result : out);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error || new Error("Speichern abgebrochen"));
      });
    },
    all(store) { return new Promise((res, rej) => { const r = DB.db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
    get(store, key) { return new Promise((res, rej) => { const r = DB.db.transaction(store).objectStore(store).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
    put(store, val) { return DB.tx(store, "readwrite", (s) => { s.put(val); }); },
    del(store, key) { return DB.tx(store, "readwrite", (s) => { s.delete(key); }); },
  };

  // ---------- Zustand ----------
  let fields = [], entries = [], acts = DEFAULT_ACTS.slice();
  let pos = null, acc = null, gpsState = "start";
  let detected = null, current = null, manual = false;
  let draft = null, photoURLs = new Map();
  let logField = "all", logYear = "all";

  // ---------- Geometrie ----------
  const polysOf = (g) => (g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []);
  function inRing(p, ring) {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  }
  const inField = (p, f) => polysOf(f.geom).some((pl) => inRing(p, pl[0]) && !pl.slice(1).some((h) => inRing(p, h)));
  // Fläche auf der Kugel (wie turf.js), Ergebnis in m²
  function ringArea(r) {
    const R = 6378137, rad = Math.PI / 180; let a = 0; const n = r.length;
    if (n < 3) return 0;
    for (let i = 0; i < n; i++) {
      const p1 = r[i], p2 = r[(i + 1) % n], p3 = r[(i + 2) % n];
      a += (p3[0] * rad - p1[0] * rad) * Math.sin(p2[1] * rad);
    }
    return Math.abs((a * R * R) / 2);
  }
  const areaHa = (g) => polysOf(g).reduce((s, pl) => s + ringArea(pl[0]) - pl.slice(1).reduce((t, h) => t + ringArea(h), 0), 0) / 1e4;
  // Abstand in Metern (lokal eben genähert, für ein paar km mehr als genau genug)
  function toM(p, ref) { const k = Math.cos((ref[1] * Math.PI) / 180); return [(p[0] - ref[0]) * 111320 * k, (p[1] - ref[1]) * 110574]; }
  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
    let t = l ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l : 0; t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }
  function distTo(f, p) {
    if (!p) return null;
    if (inField(p, f)) return 0;
    let m = Infinity; const o = [0, 0];
    polysOf(f.geom).forEach((pl) => pl.forEach((r) => { for (let i = 0; i < r.length - 1; i++) m = Math.min(m, segDist(o, toM(r[i], p), toM(r[i + 1], p))); }));
    return m;
  }
  function bboxOf(g) { let b = [Infinity, Infinity, -Infinity, -Infinity]; polysOf(g).forEach((pl) => pl[0].forEach(([x, y]) => { b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)]; })); return b; }
  function cleanGeom(g) {
    if (!g) return null;
    const closeRing = (r) => { r = r.map((c) => [+c[0], +c[1]]).filter((c) => isFinite(c[0]) && isFinite(c[1])); if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push(r[0].slice()); return r; };
    let polys = [];
    if (g.type === "Polygon") polys = [g.coordinates];
    else if (g.type === "MultiPolygon") polys = g.coordinates;
    else if (g.type === "LineString") polys = [[g.coordinates]];
    else if (g.type === "MultiLineString") polys = g.coordinates.map((l) => [l]);
    else if (g.type === "GeometryCollection") { g.geometries.forEach((x) => { const c = cleanGeom(x); if (c) polys.push(...polysOf(c)); }); }
    polys = polys.map((pl) => pl.map(closeRing).filter((r) => r.length >= 4)).filter((pl) => pl.length);
    if (!polys.length) return null;
    return polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys };
  }

  // ---------- Format ----------
  const fmtHa = (v) => v.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ha";
  const fmtDist = (m) => (m < 1000 ? Math.round(m / 10) * 10 + " m" : (m / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " km");
  const iso = (d) => { const z = (n) => String(n).padStart(2, "0"); return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate()); };
  const today = () => iso(new Date());
  const dDate = (s, opt) => new Date(s + "T12:00").toLocaleDateString("de-DE", opt || { day: "2-digit", month: "2-digit", year: "numeric" });
  function dayLabel(s) {
    const diff = Math.round((new Date(today() + "T12:00") - new Date(s + "T12:00")) / 864e5);
    const base = dDate(s, { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
    return diff === 0 ? "Heute · " + base : diff === 1 ? "Gestern · " + base : base;
  }
  const fieldById = (id) => fields.find((f) => f.id === id);
  const fieldName = (e) => (fieldById(e.fieldId) || {}).name || e.fieldName || "Gelöschtes Feld";
  const lastOf = (fid) => entries.filter((e) => e.fieldId === fid).sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created)[0];
  const byName = (a, b) => a.name.localeCompare(b.name, "de");

  function toast(t, ms) { const e = $("toast"); e.textContent = t; e.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (e.hidden = true), ms || 2800); }
  function confirmBox(title, text, yes) {
    return new Promise((res) => {
      $("confirmTitle").textContent = title; $("confirmText").textContent = text; $("confirmYes").textContent = yes || "Löschen";
      $("confirm").hidden = false;
      const done = (v) => { $("confirm").hidden = true; $("confirmYes").onclick = $("confirmNo").onclick = null; res(v); };
      $("confirmYes").onclick = () => done(true); $("confirmNo").onclick = () => done(false);
    });
  }

  // ---------- Karte ----------
  const map = L.map("map", { zoomControl: false, attributionControl: true, maxZoom: 20 }).setView([48.39, 11.0], 13);
  map.attributionControl.setPrefix(false);
  const BASES = [
    { name: "Luftbild Bayern", layer: L.tileLayer.wms("https://geoservices.bayern.de/od/wms/dop/v1/dop20?", { layers: "by_dop20c", format: "image/jpeg", maxZoom: 20, attribution: "© Bayerische Vermessungsverwaltung (CC BY 4.0)" }) },
    { name: "Luftbild Esri", layer: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, maxNativeZoom: 19, attribution: "© Esri, Maxar, Earthstar Geographics" }) },
    { name: "Straßenkarte", layer: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 20, maxNativeZoom: 19, attribution: "© OpenStreetMap-Mitwirkende" }) },
  ];
  let baseIdx = 0, tileErrors = 0;
  try { const b = +localStorage.getItem("feldbuch.base"); if (b >= 0 && b < BASES.length) baseIdx = b; } catch (e) {}
  function setBase(i, quiet) {
    BASES.forEach((b) => map.hasLayer(b.layer) && map.removeLayer(b.layer));
    baseIdx = i; tileErrors = 0; BASES[i].layer.addTo(map); BASES[i].layer.bringToBack();
    try { localStorage.setItem("feldbuch.base", i); } catch (e) {}
    if (!quiet) toast("Hintergrund: " + BASES[i].name);
  }
  BASES.forEach((b, i) => b.layer.on("tileerror", () => {
    if (i !== baseIdx || !navigator.onLine) return;
    if (++tileErrors === 6 && i === 0) { setBase(1, true); toast("Luftbild Bayern nicht erreichbar – Esri-Luftbild aktiv"); }
  }));
  setBase(baseIdx, true);
  $("btnLayer").onclick = () => setBase((baseIdx + 1) % BASES.length);

  const fieldLayer = L.layerGroup().addTo(map);
  let polyById = new Map();
  const meDot = L.circleMarker([0, 0], { radius: 8, color: "#fff", weight: 3, fillColor: "#2b6fd6", fillOpacity: 1, interactive: false });
  const meAcc = L.circle([0, 0], { radius: 1, color: "#2b6fd6", weight: 1, fillOpacity: 0.12, interactive: false });
  let follow = true;

  function styleFor(f) {
    const sel = current && current.id === f.id;
    return sel ? { color: "#f2c230", weight: 4, fillColor: "#f2c230", fillOpacity: 0.35 } : { color: "#ffffff", weight: 2, fillColor: "#7cd36a", fillOpacity: 0.12 };
  }
  function drawFields() {
    fieldLayer.clearLayers(); polyById = new Map();
    fields.forEach((f) => {
      const lyr = L.geoJSON({ type: "Feature", geometry: f.geom }, { style: () => styleFor(f) });
      lyr.on("click", () => pickField(f.id));
      lyr.bindTooltip(f.name, { permanent: true, direction: "center", className: "flabel" });
      lyr.addTo(fieldLayer); polyById.set(f.id, lyr);
    });
    updateLabels();
    $("mapEmpty").hidden = fields.length > 0;
    $("here").hidden = fields.length === 0;
  }
  function restyle() { fields.forEach((f) => { const l = polyById.get(f.id); if (l) l.setStyle(styleFor(f)); }); }
  function updateLabels() { map.getContainer().classList.toggle("nolabels", map.getZoom() < 15); }
  map.on("zoomend", updateLabels);
  map.on("dragstart", () => { follow = false; $("btnFollow").classList.remove("on"); });
  function fitAll() { if (!fields.length) return; let b = null; polyById.forEach((l) => { b = b ? b.extend(l.getBounds()) : l.getBounds(); }); if (b) map.fitBounds(b, { padding: [30, 30] }); }
  $("btnAll").onclick = () => { follow = false; $("btnFollow").classList.remove("on"); fitAll(); };
  $("btnFollow").onclick = () => {
    if (!pos) { toast(gpsState === "err" ? "Kein GPS – Standortfreigabe prüfen" : "Warte auf GPS …"); return; }
    follow = true; $("btnFollow").classList.add("on"); map.setView([pos[1], pos[0]], Math.max(map.getZoom(), 16));
  };
  function showField(f) { const l = polyById.get(f.id); if (l) { follow = false; $("btnFollow").classList.remove("on"); map.fitBounds(l.getBounds(), { padding: [40, 40], maxZoom: 18 }); } }

  // ---------- GPS ----------
  function setGps(state, text) { gpsState = state; const c = $("gpsChip"); c.className = "gps " + state; $("gpsText").textContent = text; }
  function startGps() {
    if (!("geolocation" in navigator)) { setGps("err", "Kein GPS"); return; }
    navigator.geolocation.watchPosition(
      (p) => {
        const first = !pos;
        pos = [p.coords.longitude, p.coords.latitude]; acc = p.coords.accuracy;
        meDot.setLatLng([pos[1], pos[0]]).addTo(map); meAcc.setLatLng([pos[1], pos[0]]).setRadius(acc).addTo(map);
        locate();
        if (first && follow) map.setView([pos[1], pos[0]], 16);
        else if (follow) map.panTo([pos[1], pos[0]], { animate: true });
      },
      (err) => {
        if (err.code === 1) setGps("err", "Standort nicht freigegeben");
        else if (!pos) setGps("weak", "Kein GPS-Signal");
        renderHere();
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 }
    );
  }
  function locate() {
    const before = detected && detected.id;
    detected = pos ? fields.find((f) => inField(pos, f)) || null : null;
    if (!manual) current = detected;
    if (pos) setGps(acc > 30 ? "weak" : "ok", (detected ? detected.name : "kein Feld") + " ±" + Math.round(acc) + " m");
    if ((detected && detected.id) !== before || !manual) restyle();
    renderHere();
  }
  function pickField(id) {
    manual = !(detected && detected.id === id); current = fieldById(id) || null;
    restyle(); renderHere();
    if (draft) { draft.fieldId = id; renderSheetField(); dieselCalc(); }
  }
  function renderHere() {
    const sub = $("hereSub");
    if (current) {
      $("hereLabel").textContent = manual ? "Gewähltes Feld" : "Du stehst auf";
      $("hereName").textContent = current.name;
      const l = lastOf(current.id);
      sub.textContent = fmtHa(current.ha) + (l ? " · zuletzt: " + l.act + ", " + dDate(l.date, { day: "2-digit", month: "2-digit" }) : "");
    } else if (!pos) {
      $("hereLabel").textContent = "Position";
      $("hereName").textContent = gpsState === "err" ? "Kein Standort" : "Warte auf GPS …";
      sub.textContent = gpsState === "err" ? "Standort für diese App erlauben oder Feld von Hand wählen." : "Du kannst das Feld auch von Hand wählen.";
    } else {
      $("hereLabel").textContent = "Kein Feld erkannt";
      $("hereName").textContent = "Feld wählen";
      sub.textContent = "Du stehst außerhalb deiner Feldgrenzen.";
    }
    $("changeField").textContent = current ? "Feld ändern" : "Feld wählen";
  }

  // ---------- Feldwahl ----------
  function openChooser() {
    $("chooserSearch").value = ""; renderChoices(); $("chooser").hidden = false;
    $("chooserNote").textContent = pos ? "Sortiert nach Entfernung" : "Alphabetisch (kein GPS)";
  }
  function renderChoices() {
    const q = $("chooserSearch").value.trim().toLowerCase();
    const curId = draft ? draft.fieldId : current && current.id;
    const list = fields.filter((f) => !q || f.name.toLowerCase().includes(q)).map((f) => ({ f, d: distTo(f, pos) }));
    list.sort((a, b) => (a.d == null || b.d == null ? byName(a.f, b.f) : a.d - b.d || byName(a.f, b.f)));
    const box = $("choiceList"); box.innerHTML = "";
    list.forEach(({ f, d }) => {
      const b = el("button", "choice" + (f.id === curId ? " cur" : "")); b.type = "button";
      b.append(el("b", null, f.name), el("span", null, (d == null ? "" : d === 0 ? "hier · " : fmtDist(d) + " · ") + fmtHa(f.ha)));
      b.onclick = () => { pickField(f.id); $("chooser").hidden = true; };
      box.append(b);
    });
    if (!list.length) box.append(el("div", "empty", "Kein Feld gefunden"));
  }
  $("chooserSearch").oninput = renderChoices;
  $("changeField").onclick = openChooser; $("sChangeField").onclick = openChooser;
  $("closeChooser").onclick = () => ($("chooser").hidden = true);
  document.querySelectorAll(".overlay").forEach((o) => o.addEventListener("click", (e) => { if (e.target === o && o.id !== "confirm") o.hidden = true; }));

  // ---------- Eintrag ----------
  function openSheet(entry) {
    if (!entry && !current) { openChooser(); toast("Erst ein Feld wählen"); return; }
    draft = entry
      ? { id: entry.id, fieldId: entry.fieldId, act: entry.act, photoIds: entry.photoIds.slice(), newPhotos: [], removed: [], created: entry.created, auto: entry.auto }
      : { id: null, fieldId: current.id, act: null, photoIds: [], newPhotos: [], removed: [], auto: !manual };
    $("sheetTitle").textContent = entry ? "Eintrag bearbeiten" : "Neuer Eintrag";
    $("sDate").value = entry ? entry.date : today();
    $("sAmount").value = entry ? entry.amount || "" : "";
    $("sUnit").value = entry ? entry.unit || "l/ha" : lastUnit();
    $("sNote").value = entry ? entry.note || "" : "";
    $("delEntry").hidden = !entry;
    $("newActRow").hidden = true; $("sNewAct").value = "";
    $("sDiesel").value = entry && entry.diesel ? +entry.diesel.toFixed(2) : "";
    $("sDieselMode").value = entry && entry.diesel ? "total" : dieselMode();
    dieselCalc();
    renderSheetField(); renderTiles(); renderPhotos(); updateSave();
    $("sheet").classList.add("open"); $("sheet").setAttribute("aria-hidden", "false");
    $("sheet").querySelector(".sheet-body").scrollTop = 0;
  }
  function closeSheet() {
    if (draft) draft.newPhotos.forEach((p) => URL.revokeObjectURL(p.url));
    draft = null; $("sheet").classList.remove("open"); $("sheet").setAttribute("aria-hidden", "true");
  }
  const dieselMode = () => { try { return localStorage.getItem("feldbuch.dieselMode") || "total"; } catch (e) { return "total"; } };
  const num = (v) => { const n = parseFloat(String(v).replace(",", ".")); return isFinite(n) && n > 0 ? n : null; };
  const fmtL = (v, d) => v.toLocaleString("de-DE", { maximumFractionDigits: d == null ? 1 : d });
  function dieselOf(fieldId) {
    const v = num($("sDiesel").value), f = fieldById(fieldId);
    if (v == null) return { total: null, perHa: null };
    if ($("sDieselMode").value === "ha") return { total: f ? v * f.ha : null, perHa: v };
    return { total: v, perHa: f && f.ha ? v / f.ha : null };
  }
  function dieselCalc() {
    if (!draft) return;
    const f = fieldById(draft.fieldId), d = dieselOf(draft.fieldId), t = $("sDieselCalc");
    if (d.total == null && d.perHa == null) { t.textContent = ""; return; }
    t.textContent = $("sDieselMode").value === "ha"
      ? (d.total != null ? "= " + fmtL(d.total) + " l gesamt bei " + fmtHa(f.ha) : "")
      : (d.perHa != null ? "= " + fmtL(d.perHa) + " l/ha bei " + fmtHa(f.ha) : "");
  }
  $("sDiesel").addEventListener("input", dieselCalc);
  $("sDieselMode").addEventListener("change", () => { try { localStorage.setItem("feldbuch.dieselMode", $("sDieselMode").value); } catch (e) {} dieselCalc(); });
  const lastUnit = () => { try { return localStorage.getItem("feldbuch.unit") || "l/ha"; } catch (e) { return "l/ha"; } };
  $("startEntry").onclick = () => openSheet(null);
  $("closeSheet").onclick = closeSheet;
  function renderSheetField() {
    const f = fieldById(draft.fieldId);
    $("sFieldName").textContent = f ? f.name : "–";
    const auto = !draft.id && detected && f && detected.id === f.id;
    const t = $("sFieldTag");
    t.textContent = draft.id ? (f ? fmtHa(f.ha) : "") : auto ? "per GPS erkannt" : "von Hand gewählt";
    t.className = "tag" + (auto ? " ok" : "");
  }
  function renderTiles() {
    const t = $("tiles"); t.innerHTML = "";
    const list = acts.slice(); if (draft.act && !list.includes(draft.act)) list.push(draft.act);
    list.forEach((a) => {
      const b = el("button", "tile", a); b.type = "button"; b.setAttribute("aria-pressed", draft.act === a ? "true" : "false");
      b.onclick = () => { draft.act = a; renderTiles(); updateSave(); }; t.append(b);
    });
    const add = el("button", "tile add", "+ Neu"); add.type = "button";
    add.onclick = () => { $("newActRow").hidden = false; $("sNewAct").focus(); };
    t.append(add);
  }
  async function addActFromSheet() {
    const v = $("sNewAct").value.trim(); if (!v || !draft) return;
    if (!acts.some((a) => a.toLowerCase() === v.toLowerCase())) { acts.push(v); try { await DB.put("meta", { key: "acts", value: acts }); } catch (e) {} }
    draft.act = acts.find((a) => a.toLowerCase() === v.toLowerCase());
    $("sNewAct").value = ""; $("newActRow").hidden = true;
    renderTiles(); updateSave(); renderActs(); toast("„" + draft.act + "“ hinzugefügt");
  }
  $("sNewActAdd").onclick = addActFromSheet;
  $("sNewAct").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addActFromSheet(); } });
  function updateSave() { const b = $("save"); b.disabled = !draft.act; b.textContent = draft.act ? "Speichern" : "Arbeitsschritt wählen"; }

  async function shrink(file) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      const max = 1600, k = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      return await new Promise((r) => c.toBlob((b) => r(b || file), "image/jpeg", 0.82));
    } catch (e) { return file; }
  }
  $("photoIn").addEventListener("change", async (e) => {
    const files = [...e.target.files]; e.target.value = "";
    for (const f of files) { if (!draft) return; const blob = await shrink(f); draft.newPhotos.push({ id: uid(), blob, url: URL.createObjectURL(blob) }); renderPhotos(); }
  });
  async function photoURL(id) {
    if (photoURLs.has(id)) return photoURLs.get(id);
    const p = await DB.get("photos", id); if (!p) return null;
    const u = URL.createObjectURL(p.blob); photoURLs.set(id, u); return u;
  }
  async function renderPhotos() {
    const box = $("photos"); box.querySelectorAll(".pwrap").forEach((x) => x.remove());
    const btn = box.querySelector(".photo-btn");
    const items = draft.photoIds.filter((id) => !draft.removed.includes(id)).map((id) => ({ id, old: true })).concat(draft.newPhotos.map((p) => ({ id: p.id, url: p.url })));
    for (const it of items) {
      const w = el("div", "pwrap"), img = el("img", "thumb"); img.alt = "Foto";
      img.src = it.url || (await photoURL(it.id)) || "";
      const x = el("button", null, "×"); x.type = "button"; x.setAttribute("aria-label", "Foto entfernen");
      x.onclick = () => { if (it.old) draft.removed.push(it.id); else draft.newPhotos = draft.newPhotos.filter((p) => p.id !== it.id); renderPhotos(); };
      w.append(img, x); box.insertBefore(w, btn);
    }
  }

  $("save").onclick = async () => {
    if (!draft || !draft.act) return;
    const f = fieldById(draft.fieldId);
    const ds = dieselOf(draft.fieldId);
    const e = {
      id: draft.id || uid(), fieldId: draft.fieldId, fieldName: f ? f.name : "", act: draft.act,
      date: $("sDate").value || today(), amount: $("sAmount").value.trim(), unit: $("sUnit").value, note: $("sNote").value.trim(),
      diesel: ds.total != null ? +ds.total.toFixed(2) : null, dieselHa: ds.perHa != null ? +ds.perHa.toFixed(2) : null,
      photoIds: draft.photoIds.filter((id) => !draft.removed.includes(id)).concat(draft.newPhotos.map((p) => p.id)),
      created: draft.created || Date.now(), updated: Date.now(), auto: draft.id ? !!draft.auto : !!draft.auto,
      pos: !draft.id && pos ? [+pos[0].toFixed(6), +pos[1].toFixed(6)] : undefined,
    };
    try {
      await DB.tx(["entries", "photos"], "readwrite", ([es, ps]) => {
        es.put(e);
        draft.newPhotos.forEach((p) => ps.put({ id: p.id, blob: p.blob, entryId: e.id }));
        draft.removed.forEach((id) => ps.delete(id));
      });
    } catch (err) { toast("Speichern fehlgeschlagen: Speicher voll? (" + err.message + ")", 5000); return; }
    if (e.amount) try { localStorage.setItem("feldbuch.unit", e.unit); } catch (x) {}
    const i = entries.findIndex((x) => x.id === e.id); if (i >= 0) entries[i] = e; else entries.push(e);
    toast((draft.id ? "Geändert: " : "Gespeichert: ") + e.act + " · " + fieldName(e));
    closeSheet(); renderHere(); renderLog(); renderFields();
  };
  $("delEntry").onclick = async () => {
    if (!draft || !draft.id) return;
    if (!(await confirmBox("Eintrag löschen?", "Der Eintrag und seine Fotos werden auf diesem Handy gelöscht."))) return;
    const e = entries.find((x) => x.id === draft.id);
    await DB.tx(["entries", "photos"], "readwrite", ([es, ps]) => { es.delete(e.id); e.photoIds.forEach((id) => ps.delete(id)); });
    entries = entries.filter((x) => x.id !== e.id);
    toast("Eintrag gelöscht"); closeSheet(); renderHere(); renderLog(); renderFields();
  };

  // ---------- Tagebuch ----------
  function renderLogFilters() {
    const fs = $("logField"), ys = $("logYear");
    fs.innerHTML = ""; fs.append(new Option("Alle Felder", "all"));
    fields.slice().sort(byName).forEach((f) => fs.append(new Option(f.name, f.id)));
    if (entries.some((e) => !fieldById(e.fieldId))) fs.append(new Option("Gelöschte Felder", "gone"));
    if (![...fs.options].some((o) => o.value === logField)) logField = "all";
    fs.value = logField;
    const years = [...new Set(entries.map((e) => e.date.slice(0, 4)))].sort().reverse();
    ys.innerHTML = ""; ys.append(new Option("Alle Jahre", "all")); years.forEach((y) => ys.append(new Option(y, y)));
    if (!years.includes(logYear)) logYear = "all";
    ys.value = logYear;
  }
  $("logField").onchange = (e) => { logField = e.target.value; renderLog(); };
  $("logYear").onchange = (e) => { logYear = e.target.value; renderLog(); };
  async function renderLog() {
    renderLogFilters();
    const rows = entries
      .filter((e) => logField === "all" || (logField === "gone" ? !fieldById(e.fieldId) : e.fieldId === logField))
      .filter((e) => logYear === "all" || e.date.startsWith(logYear))
      .sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created);
    $("logCount").textContent = rows.length === 1 ? "1 Eintrag" : rows.length + " Einträge";
    const list = $("logList"); list.innerHTML = "";
    if (!rows.length) { list.append(el("div", "empty", entries.length ? "Keine Einträge für diese Auswahl." : "Noch keine Einträge. Auf der Karte „Arbeitsschritt eintragen“ tippen.")); return; }
    let day = null, box = null;
    for (const e of rows) {
      if (e.date !== day) { day = e.date; box = el("div", "day"); box.append(el("div", "label", dayLabel(day))); list.append(box); }
      const c = el("button", "entry"); c.type = "button";
      const m = el("div", "entry-main");
      m.append(el("div", "entry-act", e.act));
      const f = fieldById(e.fieldId);
      m.append(el("div", "entry-meta", fieldName(e) + (f ? " · " + fmtHa(f.ha) : "") + (e.amount ? " · " + String(e.amount).replace(".", ",") + " " + e.unit : "")));
      if (e.diesel) m.append(el("div", "entry-meta", "Diesel " + fmtL(e.diesel) + " l" + (e.dieselHa ? " · " + fmtL(e.dieselHa) + " l/ha" : "")));
      if (e.note) m.append(el("div", "entry-note", e.note));
      if (e.photoIds.length > 1) m.append(el("div", "note", e.photoIds.length + " Fotos"));
      c.append(m);
      if (e.photoIds.length) { const i = el("img", "thumb"); i.alt = "Foto"; c.append(i); photoURL(e.photoIds[0]).then((u) => { if (u) i.src = u; }); }
      c.onclick = () => openSheet(e);
      box.append(c);
    }
  }

  // ---------- Felder ----------
  function thumbPath(g) {
    const b = bboxOf(g), k = Math.cos((((b[1] + b[3]) / 2) * Math.PI) / 180);
    const w = (b[2] - b[0]) * k, h = b[3] - b[1], s = 44 / Math.max(w, h, 1e-9);
    const ox = 4 + (44 - w * s) / 2, oy = 4 + (44 - h * s) / 2;
    return polysOf(g).map((pl) => pl.map((r) => "M" + r.map(([x, y]) => ((x - b[0]) * k * s + ox).toFixed(1) + " " + ((b[3] - y) * s + oy).toFixed(1)).join("L") + "Z").join("")).join("");
  }
  function renderFields() {
    const total = fields.reduce((s, f) => s + f.ha, 0);
    $("fieldsSum").textContent = fields.length ? fields.length + " Felder · " + fmtHa(total) : "";
    const l = $("fieldList"); l.innerHTML = "";
    if (!fields.length) l.append(el("div", "empty", "Noch keine Feldgrenzen geladen."));
    fields.slice().sort(byName).forEach((f) => {
      const b = el("button", "fcard"); b.type = "button";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 52 52");
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", thumbPath(f.geom)); svg.append(p);
      const mid = el("div"); const last = lastOf(f.id);
      mid.append(el("b", null, f.name), el("small", null, last ? "Zuletzt: " + last.act + ", " + dDate(last.date) : "Noch keine Einträge"));
      b.append(svg, mid, el("div", "ha", fmtHa(f.ha)));
      b.onclick = () => openField(f);
      l.append(b);
    });
    renderActs(); renderStorage();
  }
  let openFieldId = null;
  function openField(f) {
    openFieldId = f.id; $("fName").value = f.name;
    const n = entries.filter((e) => e.fieldId === f.id).length;
    const yr = String(new Date().getFullYear());
    const dsl = entries.filter((e) => e.fieldId === f.id && e.diesel && e.date.startsWith(yr)).reduce((s, e) => s + e.diesel, 0);
    $("fInfo").textContent = fmtHa(f.ha) + " · " + n + (n === 1 ? " Eintrag" : " Einträge") +
      (dsl ? " · Diesel " + yr + ": " + fmtL(dsl, 0) + " l (" + fmtL(dsl / f.ha) + " l/ha)" : "") + (f.source ? " · Quelle: " + f.source : "");
    const h = $("fHistory"); h.innerHTML = "";
    const hist = (f.history || []).slice().reverse();
    if (hist.length) {
      h.append(el("div", "label", "Grenzänderungen"));
      const box = el("div", "hist");
      hist.forEach((x) => box.append(el("div", null, new Date(x.replaced).toLocaleDateString("de-DE") + ": " + fmtHa(x.ha) + " → neue Grenze" + (x.source ? " (" + x.source + ")" : ""))));
      h.append(box);
    }
    $("fieldSheet").hidden = false;
  }
  async function saveFieldName() {
    const f = fieldById(openFieldId); const v = $("fName").value.trim();
    if (!f || !v || v === f.name) return;
    f.name = v; await DB.put("fields", f); drawFields(); renderFields(); renderHere();
    toast("Umbenannt in " + v);
  }
  $("fName").addEventListener("change", saveFieldName);
  $("closeField").onclick = async () => { await saveFieldName(); $("fieldSheet").hidden = true; };
  $("fShow").onclick = async () => { await saveFieldName(); const f = fieldById(openFieldId); $("fieldSheet").hidden = true; show("v-map"); setTimeout(() => { map.invalidateSize(); showField(f); }, 50); };
  $("fLog").onclick = async () => { await saveFieldName(); logField = openFieldId; $("fieldSheet").hidden = true; show("v-log"); };
  $("fDelete").onclick = async () => {
    const f = fieldById(openFieldId); if (!f) return;
    const n = entries.filter((e) => e.fieldId === f.id).length;
    if (!(await confirmBox("„" + f.name + "“ löschen?", "Die Feldgrenze wird entfernt." + (n ? " Die " + n + " Tagebucheinträge bleiben erhalten." : "")))) return;
    await DB.del("fields", f.id); fields = fields.filter((x) => x.id !== f.id);
    if (current && current.id === f.id) { current = null; manual = false; }
    $("fieldSheet").hidden = true; drawFields(); locate(); renderFields(); toast("Feld gelöscht");
  };

  function renderActs() {
    const box = $("actList"); box.innerHTML = "";
    acts.forEach((a) => {
      const c = el("span", "act"); c.append(document.createTextNode(a));
      const x = el("button", null, "×"); x.type = "button"; x.setAttribute("aria-label", a + " entfernen");
      x.onclick = async () => { acts = acts.filter((y) => y !== a); await DB.put("meta", { key: "acts", value: acts }); renderActs(); };
      c.append(x); box.append(c);
    });
  }
  $("actAdd").onclick = async () => {
    const v = $("actNew").value.trim(); if (!v) return;
    if (!acts.includes(v)) acts.push(v);
    await DB.put("meta", { key: "acts", value: acts }); $("actNew").value = ""; renderActs(); toast("„" + v + "“ hinzugefügt");
  };
  $("actNew").addEventListener("keydown", (e) => { if (e.key === "Enter") $("actAdd").click(); });

  async function renderStorage() {
    let t = "";
    try {
      if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); t = "Belegt: " + (e.usage / 1048576).toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " MB"; }
      if (navigator.storage && navigator.storage.persisted) t += (await navigator.storage.persisted()) ? " · Speicher dauerhaft" : " · Speicher nicht dauerhaft gesichert – App zum Startbildschirm hinzufügen";
    } catch (e) {}
    $("storageInfo").textContent = t;
    const lb = await DB.get("meta", "lastBackup");
    $("lastBackup").textContent = lb ? "Letztes Backup: " + new Date(lb.value).toLocaleDateString("de-DE") : entries.length ? "Noch kein Backup gespeichert." : "";
  }

  // ---------- Import ----------
  document.querySelectorAll('[data-action="import"]').forEach((b) => (b.onclick = () => $("fileIn").click()));
  const NAME_KEYS = ["field_name", "schlagname", "schlag", "feldname", "name", "bezeichnung", "flurname", "title", "fsname", "flik", "fid_name", "label"];
  function guessName(props, i) {
    const p = props || {}; const keys = Object.keys(p);
    for (const k of NAME_KEYS) { const hit = keys.find((x) => x.toLowerCase() === k); if (hit && p[hit] != null && String(p[hit]).trim()) return String(p[hit]).trim(); }
    const s = keys.find((k) => typeof p[k] === "string" && p[k].trim() && p[k].length < 60 && !/client|farm|betrieb|kunde/i.test(k));
    return s ? String(p[s]).trim() : "Feld " + (i + 1);
  }
  async function parseFile(file) {
    const name = file.name.toLowerCase();
    const buf = await file.arrayBuffer();
    const head = new Uint8Array(buf.slice(0, 4));
    const isZip = head[0] === 0x50 && head[1] === 0x4b;
    const xml = (txt) => new DOMParser().parseFromString(txt, "text/xml");
    let fc = null, src = "";
    if (isZip) {
      const zip = await JSZip.loadAsync(buf);
      const kml = Object.keys(zip.files).find((n) => n.toLowerCase().endsWith(".kml"));
      if (kml && !Object.keys(zip.files).some((n) => n.toLowerCase().endsWith(".shp"))) {
        fc = toGeoJSON.kml(xml(await zip.file(kml).async("string"))); src = "KMZ";
      } else {
        if (!Object.keys(zip.files).some((n) => n.toLowerCase().endsWith(".prj"))) toast("Keine .prj-Datei im Zip – Koordinaten werden als WGS84 angenommen", 5000);
        const r = await shp(buf); fc = Array.isArray(r) ? { type: "FeatureCollection", features: r.flatMap((x) => x.features) } : r; src = "Shapefile";
      }
    } else if (name.endsWith(".kml")) { fc = toGeoJSON.kml(xml(new TextDecoder().decode(buf))); src = "KML"; }
    else if (name.endsWith(".gpx")) { fc = toGeoJSON.gpx(xml(new TextDecoder().decode(buf))); src = "GPX"; }
    else if (name.endsWith(".shp")) { throw new Error("Bitte das Shapefile als .zip laden (mit .shp, .shx, .dbf und .prj)."); }
    else {
      const j = JSON.parse(new TextDecoder().decode(buf));
      if (j.app === "feldbuch") throw new Error("Das ist ein Backup – bitte über „Backup wiederherstellen“ laden.");
      fc = j.type === "FeatureCollection" ? j : j.type === "Feature" ? { type: "FeatureCollection", features: [j] } : { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: j }] };
      src = "GeoJSON";
    }
    const feats = (fc && fc.features) || [];
    const out = [];
    feats.forEach((ft, i) => {
      const g = cleanGeom(ft.geometry); if (!g) return;
      const b = bboxOf(g);
      if (Math.abs(b[0]) > 180 || Math.abs(b[3]) > 90) throw new Error("Die Koordinaten sind nicht in Grad (WGS84). Beim Shapefile die .prj-Datei mit ins Zip packen.");
      out.push({ name: guessName(ft.properties, i), geom: g, ha: areaHa(g), fileHa: ft.properties && (ft.properties.FIELD_AREA || ft.properties.flaeche || ft.properties.FLAECHE) });
    });
    if (!out.length) throw new Error("In der Datei wurden keine Flächen gefunden.");
    return { items: out, src: src + " · " + file.name };
  }
  let pending = null;
  $("fileIn").addEventListener("change", async (e) => {
    const file = e.target.files[0]; e.target.value = ""; if (!file) return;
    toast("Lese " + file.name + " …", 8000);
    try { pending = await parseFile(file); } catch (err) { toast(err.message || "Datei konnte nicht gelesen werden", 6000); return; }
    $("toast").hidden = true;
    const byN = new Map(fields.map((f) => [f.name.toLowerCase(), f]));
    pending.items.forEach((it) => { it.existing = byN.get(it.name.toLowerCase()) || null; it.on = true; });
    const upd = pending.items.filter((i) => i.existing).length;
    $("importNote").textContent = pending.items.length + " Flächen gefunden" + (upd ? ", davon " + upd + " schon vorhanden (Grenze wird aktualisiert, Einträge bleiben)" : "") + ". Fläche aus den Grenzen berechnet.";
    const box = $("importList"); box.innerHTML = "";
    pending.items.forEach((it) => {
      const lab = el("label", "choice"); const cb = el("input"); cb.type = "checkbox"; cb.checked = true; cb.onchange = () => (it.on = cb.checked);
      const g = el("div", "grow"); g.append(el("b", null, it.name), el("small", null, it.existing ? "Grenze aktualisieren (bisher " + fmtHa(it.existing.ha) + ")" : "Neu"));
      lab.append(cb, g, el("span", null, fmtHa(it.ha))); box.append(lab);
    });
    $("importSheet").hidden = false;
  });
  $("closeImport").onclick = () => { pending = null; $("importSheet").hidden = true; };
  $("importGo").onclick = async () => {
    if (!pending) return;
    const now = Date.now(); let added = 0, updated = 0;
    const src = pending.src;
    const sel = pending.items.filter((i) => i.on);
    const recs = sel.map((it) => {
      if (it.existing) {
        const f = it.existing; f.history = (f.history || []).concat([{ geom: f.geom, ha: f.ha, replaced: now, source: f.source }]);
        f.geom = it.geom; f.ha = it.ha; f.source = src; f.updated = now; updated++; return f;
      }
      added++; return { id: uid(), name: it.name, geom: it.geom, ha: it.ha, source: src, created: now, updated: now, history: [] };
    });
    await DB.tx("fields", "readwrite", (s) => recs.forEach((r) => s.put(r)));
    recs.forEach((r) => { if (!fieldById(r.id)) fields.push(r); });
    pending = null; $("importSheet").hidden = true;
    drawFields(); locate(); renderFields(); renderLog();
    show("v-map"); setTimeout(() => { map.invalidateSize(); if (pos && detected) { follow = true; $("btnFollow").classList.add("on"); map.setView([pos[1], pos[0]], 16); } else fitAll(); }, 60);
    toast((added ? added + " Felder neu" : "") + (added && updated ? ", " : "") + (updated ? updated + " aktualisiert" : "") || "Nichts übernommen");
    askPersist();
  };

  // ---------- Export / Backup ----------
  async function deliver(blob, filename) {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: filename }); return true; } catch (e) { if (e.name === "AbortError") return false; }
    }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); return true;
  }
  const blobToDataURL = (b) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
  const stamp = () => today();
  $("btnBackup").onclick = async () => {
    toast("Backup wird erstellt …", 8000);
    const photos = await DB.all("photos");
    const data = { app: "feldbuch", version: 1, exported: new Date().toISOString(), fields, entries, acts, photos: [] };
    for (const p of photos) data.photos.push({ id: p.id, entryId: p.entryId, data: await blobToDataURL(p.blob) });
    const ok = await deliver(new Blob([JSON.stringify(data)], { type: "application/json" }), "feldbuch-backup-" + stamp() + ".json");
    $("toast").hidden = true;
    if (ok) { await DB.put("meta", { key: "lastBackup", value: Date.now() }); renderStorage(); toast("Backup erstellt (" + entries.length + " Einträge, " + photos.length + " Fotos)"); }
  };
  $("btnCsv").onclick = async () => {
    const q = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
    const rows = [["Datum", "Feld", "Fläche ha", "Arbeitsschritt", "Menge", "Einheit", "Diesel l", "Diesel l/ha", "Notiz", "Fotos"].map(q).join(";")];
    const dc = (v) => (v ? String(v).replace(".", ",") : "");
    entries.slice().sort((a, b) => a.date.localeCompare(b.date)).forEach((e) => {
      const f = fieldById(e.fieldId);
      rows.push([dDate(e.date), fieldName(e), f ? f.ha.toFixed(2).replace(".", ",") : "", e.act, String(e.amount || "").replace(".", ","), e.amount ? e.unit : "", dc(e.diesel), dc(e.dieselHa), e.note, e.photoIds.length].map(q).join(";"));
    });
    await deliver(new Blob(["﻿" + rows.join("\r\n")], { type: "text/csv" }), "feldbuch-tagebuch-" + stamp() + ".csv");
  };
  $("btnGeo").onclick = async () => {
    const fc = { type: "FeatureCollection", features: fields.map((f) => ({ type: "Feature", properties: { name: f.name, flaeche_ha: +f.ha.toFixed(4) }, geometry: f.geom })) };
    await deliver(new Blob([JSON.stringify(fc)], { type: "application/geo+json" }), "feldgrenzen-" + stamp() + ".geojson");
  };
  $("btnRestore").onclick = () => $("restoreIn").click();
  $("restoreIn").addEventListener("change", async (e) => {
    const file = e.target.files[0]; e.target.value = ""; if (!file) return;
    let d; try { d = JSON.parse(await file.text()); } catch (x) { toast("Datei ist kein gültiges Backup", 5000); return; }
    if (d.app !== "feldbuch") { toast("Das ist kein Feldbuch-Backup", 5000); return; }
    if (!(await confirmBox("Backup wiederherstellen?", "Alle Daten auf diesem Handy werden ersetzt durch: " + d.fields.length + " Felder, " + d.entries.length + " Einträge, " + d.photos.length + " Fotos.", "Ersetzen"))) return;
    const photos = [];
    for (const p of d.photos) photos.push({ id: p.id, entryId: p.entryId, blob: await (await fetch(p.data)).blob() });
    await DB.tx(["fields", "entries", "photos", "meta"], "readwrite", ([fs, es, ps, ms]) => {
      fs.clear(); es.clear(); ps.clear();
      d.fields.forEach((x) => fs.put(x)); d.entries.forEach((x) => es.put(x)); photos.forEach((x) => ps.put(x));
      ms.put({ key: "acts", value: d.acts || DEFAULT_ACTS });
    });
    photoURLs.forEach((u) => URL.revokeObjectURL(u)); photoURLs = new Map();
    await loadAll(); drawFields(); locate(); renderFields(); renderLog(); fitAll();
    toast("Backup wiederhergestellt");
  });

  async function askPersist() { try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {} renderStorage(); }

  // ---------- Reiter ----------
  function show(v) {
    document.querySelectorAll(".view").forEach((s) => (s.hidden = s.id !== v));
    document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", t.dataset.v === v ? "true" : "false"));
    if (v === "v-map") setTimeout(() => map.invalidateSize(), 30);
    if (v === "v-log") renderLog();
    if (v === "v-fields") renderFields();
  }
  document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => show(t.dataset.v)));

  // ---------- Start ----------
  async function loadAll() {
    fields = await DB.all("fields"); entries = await DB.all("entries");
    const a = await DB.get("meta", "acts"); acts = a ? a.value : DEFAULT_ACTS.slice();
  }
  (async function init() {
    try { await DB.open(); await loadAll(); }
    catch (e) { toast("Speicher nicht verfügbar – im privaten Modus? Daten werden nicht gespeichert.", 8000); }
    drawFields(); renderHere(); renderFields();
    if (fields.length) fitAll();
    startGps();
    if (fields.length) askPersist();
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  })();
  window.__feldbuch = { get fields() { return fields; }, get entries() { return entries; } };
})();
