/* Grabfinder – Wiener Zentralfriedhof
 * Speichert Gräber (Position + Infos) lokal am Gerät und navigiert per GPS dorthin.
 */
'use strict';

// Passen alle Dateien zusammen? Beim Update kann der Browser kurzzeitig alte
// und neue Dateien mischen – dann einmal frisch laden statt still zu versagen.
(() => {
  const ok = typeof Gruppen === 'object' && typeof Gruppen.findGruppe === 'function' &&
    typeof Promis === 'object' && Promis.version === 9;
  try {
    if (ok) { sessionStorage.removeItem('zf-reload'); return; }
    if (!sessionStorage.getItem('zf-reload')) {
      sessionStorage.setItem('zf-reload', '1');
      location.reload();
    }
  } catch { /* sessionStorage gesperrt – weiter mit dem, was da ist */ }
})();

// Zentrum des Wiener Zentralfriedhofs als Karten-Startpunkt
const FRIEDHOF_CENTER = [48.1503, 16.4392];
const STORAGE_KEY = 'zf-graves-v1';
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

// ---------- Daten ----------

function loadGraves() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function persistGraves() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(graves));
  } catch {
    alert('Speichern fehlgeschlagen – vermutlich ist der Speicher voll. ' +
      'Lösche alte Fotos/Gräber oder exportiere eine Sicherung.');
  }
}

let graves = loadGraves();
let lastKnownPos = null; // {lat, lon} – für Distanzanzeige in der Liste

// ---------- Geometrie ----------

const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;

function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) -
    Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

function fmtDistance(m) {
  if (m >= 1000) return (m / 1000).toFixed(1).replace('.', ',') + ' km';
  return Math.round(m) + ' m';
}

function cardinal(b) {
  const dirs = ['Norden', 'Nordosten', 'Osten', 'Südosten', 'Süden', 'Südwesten', 'Westen', 'Nordwesten'];
  return dirs[Math.round(b / 45) % 8];
}

// ---------- Ansichten ----------

const views = {
  list: document.getElementById('view-list'),
  edit: document.getElementById('view-edit'),
  nav: document.getElementById('view-nav'),
  plan: document.getElementById('view-plan'),
};

function showView(name) {
  Object.entries(views).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
}

// ---------- Liste ----------

const listEl = document.getElementById('grave-list');
const emptyHint = document.getElementById('empty-hint');

function graveSubtitle(g) {
  const parts = [];
  if (g.gruppe) parts.push('Gruppe ' + g.gruppe);
  if (g.reihe) parts.push('Reihe ' + g.reihe);
  if (g.nummer) parts.push('Nr. ' + g.nummer);
  return parts.join(' · ');
}

/* Zerlegt Grab-Angaben wie „40/12/27“, „Gruppe 40 Reihe 12 Nr. 27“,
 * „Gr. 32 C, R. 3, Nr. 8“ oder „Hietzing 5/3/12“.
 * Ergebnis: {gruppe, reihe, nummer, friedhof}; leere gruppe = keine Grab-Angabe. */
function parseGrabAngabe(text) {
  const out = { gruppe: '', reihe: '', nummer: '', friedhof: '' };
  // „32 C“ -> „32C“ (außer g/n/r – das sind Abkürzungen für Gruppe/Nr./Reihe)
  let s = ' ' + String(text).toLowerCase()
    .replace(/(\d)\s+([a-fh-mo-qs-z])(?=$|[\s,;/])/g, '$1$2') + ' ';
  const take = (re, key) => {
    const m = re.exec(s);
    if (m) {
      out[key] = m[1].toUpperCase();
      s = s.slice(0, m.index) + '  ' + s.slice(m.index + m[0].length);
    }
  };
  const V = '([0-9]{1,3}[a-z]?)';
  const END = '(?=[\\s,;/-])';
  take(new RegExp(`[\\s,;/](?:grabnummer|grabnr|nummer|grab|nr|n)\\.?\\s*:?\\s*${V}${END}`), 'nummer');
  take(new RegExp(`[\\s,;/](?:reihe|r)\\.?\\s*:?\\s*${V}${END}`), 'reihe');
  take(new RegExp(`[\\s,;/](?:gruppe|gr|g)\\.?\\s*:?\\s*${V}${END}`), 'gruppe');
  take(new RegExp(`[\\s,;/]gruppe\\s*:?\\s*([a-z]{1,3})${END}`), 'gruppe');

  const STOP = new Set(['friedhof', 'wiener', 'wien', 'grab', 'gruppe', 'reihe', 'nummer', 'nr',
    'der', 'die', 'das', 'am', 'im', 'auf', 'und']);
  const words = [];
  for (const t of s.split(/[\s,;/-]+/).filter(Boolean)) {
    if (/^[0-9]{1,3}[a-z]?$/.test(t)) {
      const slot = ['gruppe', 'reihe', 'nummer'].find(k => !out[k]);
      if (slot) out[slot] = t.toUpperCase();
    } else if (/^[a-zäöüß.]{3,}$/.test(t) && !STOP.has(t.replace(/\.$/, ''))) {
      words.push(t.replace(/\.$/, ''));
    }
  }
  out.friedhof = words.join(' ');
  return out;
}

let sortMode = localStorage.getItem('zf-sort') || 'name';

function renderList() {
  listEl.innerHTML = '';
  emptyHint.classList.toggle('hidden', graves.length > 0);
  document.getElementById('sort-row').classList.toggle('hidden', graves.length < 2);
  document.getElementById('sort-name').classList.toggle('active', sortMode === 'name');
  document.getElementById('sort-dist').classList.toggle('active', sortMode === 'dist');

  const sorted = [...graves];
  if (sortMode === 'dist' && lastKnownPos) {
    sorted.sort((a, b) =>
      distanceM(lastKnownPos.lat, lastKnownPos.lon, a.lat, a.lon) -
      distanceM(lastKnownPos.lat, lastKnownPos.lon, b.lat, b.lon));
  } else {
    sorted.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }
  for (const g of sorted) {
    const card = document.createElement('div');
    card.className = 'grave-card';

    const thumb = g.photo
      ? Object.assign(document.createElement('img'), { className: 'grave-thumb', src: g.photo, alt: '' })
      : Object.assign(document.createElement('div'), { className: 'grave-thumb', textContent: '🕯️' });

    const meta = document.createElement('div');
    meta.className = 'grave-meta';
    const sub = [graveSubtitle(g)];
    if (lastKnownPos && g.lat != null) {
      sub.push((g.posQuelle === 'gruppe' ? '≈ ' : '') +
        fmtDistance(distanceM(lastKnownPos.lat, lastKnownPos.lon, g.lat, g.lon)) + ' entfernt');
    }
    meta.innerHTML = `<div class="g-name"></div><div class="g-sub"></div>`;
    meta.querySelector('.g-name').textContent = g.name;
    meta.querySelector('.g-sub').textContent = sub.filter(Boolean).join(' · ');

    const actions = document.createElement('div');
    actions.className = 'grave-actions';
    const goBtn = document.createElement('button');
    goBtn.className = 'go';
    goBtn.textContent = '➤';
    goBtn.title = 'Zum Grab navigieren';
    goBtn.onclick = () => openNav(g.id);
    const editBtn = document.createElement('button');
    editBtn.textContent = '✎';
    editBtn.title = 'Bearbeiten';
    editBtn.onclick = () => openEdit(g.id);
    actions.append(goBtn, editBtn);

    card.append(thumb, meta, actions);
    listEl.appendChild(card);
  }
}

function setSortMode(mode) {
  sortMode = mode;
  localStorage.setItem('zf-sort', mode);
  if (mode === 'dist' && !lastKnownPos) refreshListDistances();
  renderList();
}
document.getElementById('sort-name').addEventListener('click', () => setSortMode('name'));
document.getElementById('sort-dist').addEventListener('click', () => setSortMode('dist'));

// Einmalig still die Position holen, um Entfernungen in der Liste anzuzeigen
function refreshListDistances() {
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.getCurrentPosition(p => {
    lastKnownPos = { lat: p.coords.latitude, lon: p.coords.longitude };
    renderList();
  }, () => {}, { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 });
}

// ---------- Grab anlegen / bearbeiten ----------

const editForm = document.getElementById('edit-form');
const fName = document.getElementById('f-name');
const fGruppe = document.getElementById('f-gruppe');
const fReihe = document.getElementById('f-reihe');
const fNummer = document.getElementById('f-nummer');
const fNotiz = document.getElementById('f-notiz');
const fPhoto = document.getElementById('f-photo');
const photoPreviewWrap = document.getElementById('photo-preview-wrap');
const photoPreview = document.getElementById('photo-preview');
const gpsStatus = document.getElementById('gps-status');
const btnDelete = document.getElementById('btn-delete');

let editId = null;          // null = neues Grab
let editPhoto = null;       // Daten-URL
let editPos = null;         // {lat, lon, acc}
let editPosSource = null;   // 'gps' | 'manuell' | 'gruppe' (ungefähr: Gruppen-Mitte)
let pickMap = null;
let pickMarker = null;
const pickIcon = L.divIcon({
  className: '',
  html: '<div class="grave-pin">📍</div>',
  iconSize: [26, 26],
  iconAnchor: [13, 24],
});
let gpsWatchId = null;
let gpsTimeout = null;

function initPickMap() {
  if (pickMap) return;
  pickMap = L.map('pick-map', { zoomControl: true }).setView(FRIEDHOF_CENTER, 15);
  L.tileLayer(TILE_URL, { attribution: TILE_ATTRIB, maxZoom: 19 }).addTo(pickMap);
  pickMap.on('click', e => setEditPos(e.latlng.lat, e.latlng.lng, null, 'Position manuell gesetzt', 'manuell'));
  Gruppen.attach(pickMap);
}

function setEditPos(lat, lon, acc, label, source) {
  editPos = { lat, lon, acc: acc ?? null };
  if (source) editPosSource = source;
  if (!pickMarker) {
    pickMarker = L.marker([lat, lon], { draggable: true, icon: pickIcon }).addTo(pickMap);
    pickMarker.on('dragend', () => {
      const ll = pickMarker.getLatLng();
      editPos = { lat: ll.lat, lon: ll.lng, acc: null };
      editPosSource = 'manuell';
      updateGpsStatus('Position manuell verschoben');
    });
  } else {
    pickMarker.setLatLng([lat, lon]);
  }
  pickMap.setView([lat, lon], Math.max(pickMap.getZoom(), 18));
  updateGpsStatus(label);
}

function updateGpsStatus(label) {
  if (!editPos) {
    gpsStatus.textContent = 'Noch keine Position erfasst.';
    gpsStatus.className = 'gps-status';
    return;
  }
  let txt = label || 'Position erfasst';
  if (editPos.acc != null) txt += ` (Genauigkeit ±${Math.round(editPos.acc)} m)`;
  gpsStatus.textContent = txt + (gpsWatchId != null ? ' – GPS läuft…' : '');
  gpsStatus.className = 'gps-status ' + (editPos.acc == null || editPos.acc <= 12 ? 'ok' : 'warn');
}

function stopGpsCapture() {
  if (gpsWatchId != null) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
  clearTimeout(gpsTimeout);
  document.getElementById('btn-gps').textContent = '📍 Aktuelle GPS-Position übernehmen';
  updateGpsStatus(editPos ? 'Position erfasst' : null);
}

function startGpsCapture() {
  if (!('geolocation' in navigator)) {
    alert('Dieses Gerät unterstützt keine Standortabfrage.');
    return;
  }
  if (gpsWatchId != null) { // zweiter Tipp = Stopp
    stopGpsCapture();
    return;
  }
  document.getElementById('btn-gps').textContent = '⏹ GPS stoppen (Position übernehmen)';
  gpsStatus.textContent = 'Suche GPS-Signal…';
  gpsStatus.className = 'gps-status';

  let bestAcc = Infinity;
  gpsWatchId = navigator.geolocation.watchPosition(p => {
    const { latitude, longitude, accuracy } = p.coords;
    // Immer die genaueste Messung behalten
    if (accuracy <= bestAcc) {
      bestAcc = accuracy;
      setEditPos(latitude, longitude, accuracy, 'GPS-Position erfasst', 'gps');
    } else {
      updateGpsStatus('GPS-Position erfasst');
    }
    if (accuracy <= 6) stopGpsCapture(); // gut genug – automatisch stoppen
  }, err => {
    stopGpsCapture();
    gpsStatus.textContent = 'GPS-Fehler: ' + (err.code === 1
      ? 'Standortzugriff verweigert. Bitte in den Browser-Einstellungen erlauben.'
      : err.message);
    gpsStatus.className = 'gps-status warn';
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });

  gpsTimeout = setTimeout(stopGpsCapture, 30000);
}

function resizePhoto(file, cb) {
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    URL.revokeObjectURL(url);
    const maxDim = 1000;
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    cb(canvas.toDataURL('image/jpeg', 0.7));
  };
  img.onerror = () => { URL.revokeObjectURL(url); alert('Foto konnte nicht gelesen werden.'); };
  img.src = url;
}

function showPhotoPreview() {
  photoPreviewWrap.classList.toggle('hidden', !editPhoto);
  if (editPhoto) photoPreview.src = editPhoto;
}

/* id: bestehendes Grab bearbeiten; prefill: neues Grab mit Vorgaben
 * (z. B. aus der Plan-Suche: {gruppe, reihe, nummer, notiz, lat, lon, posQuelle}) */
function openEdit(id, prefill) {
  editId = id || null;
  const g = graves.find(x => x.id === id) || prefill || null;
  const existing = !!graves.find(x => x.id === id);

  document.getElementById('edit-title').textContent = existing ? 'Grab bearbeiten' : 'Grab speichern';
  btnDelete.classList.toggle('hidden', !existing);
  fName.value = g?.name || '';
  fGruppe.value = g?.gruppe || '';
  fReihe.value = g?.reihe || '';
  fNummer.value = g?.nummer || '';
  fNotiz.value = g?.notiz || '';
  fPhoto.value = '';
  editPhoto = g?.photo || null;
  editPos = g && g.lat != null ? { lat: g.lat, lon: g.lon, acc: g.acc ?? null } : null;
  editPosSource = editPos ? (g.posQuelle || 'gps') : null;
  showPhotoPreview();

  showView('edit');
  initPickMap();
  // Karte braucht nach dem Einblenden ein Resize
  setTimeout(() => {
    pickMap.invalidateSize();
    if (editPos && editPosSource === 'gruppe' && fGruppe.value.trim()) {
      setEditPos(editPos.lat, editPos.lon, null, '', 'gruppe');
      applyGruppePos(false);
    } else if (editPos) {
      setEditPos(editPos.lat, editPos.lon, editPos.acc, 'Gespeicherte Position');
    } else {
      if (pickMarker) { pickMarker.remove(); pickMarker = null; }
      const center = lastKnownPos ? [lastKnownPos.lat, lastKnownPos.lon] : FRIEDHOF_CENTER;
      pickMap.setView(center, lastKnownPos ? 17 : 15);
      updateGpsStatus(null);
    }
  }, 50);
}

function closeEdit() {
  stopGpsCapture();
  renderList();
  showView('list');
}

editForm.addEventListener('submit', async e => {
  e.preventDefault();
  // Keine Position, aber Gruppe eingetragen -> Gruppen-Mitte nehmen
  if (!editPos && fGruppe.value.trim()) await applyGruppePos(false);
  if (!editPos) {
    alert('Bitte die Position des Grabs festlegen: Gruppe eintragen, GPS-Knopf drücken oder auf die Karte tippen.');
    return;
  }
  const data = {
    id: editId || String(Date.now()) + Math.random().toString(36).slice(2, 7),
    name: fName.value.trim(),
    gruppe: fGruppe.value.trim(),
    reihe: fReihe.value.trim(),
    nummer: fNummer.value.trim(),
    notiz: fNotiz.value.trim(),
    photo: editPhoto,
    lat: editPos.lat,
    lon: editPos.lon,
    acc: editPos.acc,
    posQuelle: editPosSource || 'gps',
    created: graves.find(g => g.id === editId)?.created || Date.now(),
  };
  const idx = graves.findIndex(g => g.id === data.id);
  if (idx >= 0) graves[idx] = data; else graves.push(data);
  persistGraves();
  closeEdit();
});

btnDelete.addEventListener('click', () => {
  const g = graves.find(x => x.id === editId);
  if (!g) return;
  if (!confirm(`„${g.name}“ wirklich löschen?`)) return;
  graves = graves.filter(x => x.id !== editId);
  persistGraves();
  closeEdit();
});

fPhoto.addEventListener('change', () => {
  const file = fPhoto.files && fPhoto.files[0];
  if (!file) return;
  resizePhoto(file, dataUrl => {
    editPhoto = dataUrl;
    showPhotoPreview();
  });
});

document.getElementById('btn-photo-remove').addEventListener('click', () => {
  editPhoto = null;
  fPhoto.value = '';
  showPhotoPreview();
});

document.getElementById('btn-gps').addEventListener('click', startGpsCapture);

/* Position aus der eingegebenen Gruppe ableiten (Marker in die Gruppen-Mitte).
 * Gibt true zurück, wenn eine Position gesetzt wurde. */
async function applyGruppePos(fromButton) {
  // Automatisch nie eine genauere Position (GPS / manuell) überschreiben
  const hasBetterPos = () => !fromButton && editPos && editPosSource !== 'gruppe';
  if (hasBetterPos()) return false;
  const q = fGruppe.value.trim();
  if (!q) {
    if (fromButton) {
      alert('Bitte zuerst oben die Gruppe eintragen (z. B. 40).');
      fGruppe.focus();
    }
    return false;
  }
  if (!Gruppen.isLoaded()) {
    gpsStatus.textContent = 'Lade Friedhofsplan …';
    gpsStatus.className = 'gps-status';
  }
  try {
    await Gruppen.load();
  } catch {
    if (hasBetterPos()) return false;
    gpsStatus.textContent = 'Friedhofsplan konnte nicht geladen werden – Position bitte per Karte oder GPS setzen.';
    gpsStatus.className = 'gps-status warn';
    return false;
  }
  if (hasBetterPos()) return false;  // GPS kam während des Ladens
  // Gruppe kann es auf mehreren Friedhöfen geben: die beim aktuellen
  // Kartenausschnitt bevorzugen, sonst den Zentralfriedhof
  const c = pickMap.getCenter();
  const hit = Gruppen.findGruppe(q, { ref: [c.lat, c.lng] });
  if (!hit) {
    if (!fromButton && editPos) return false;  // vorhandene Position samt Status nicht stören
    gpsStatus.textContent = `Gruppe „${q}“ ist in den Kartendaten nicht verzeichnet – Position bitte per Karte oder GPS setzen.`;
    gpsStatus.className = 'gps-status warn';
    return false;
  }
  const s = hit.sector;
  setEditPos(s.center[0], s.center[1], null, '', 'gruppe');
  const pts = hit.parts.flatMap(p => p.ring || [p.center]);
  pickMap.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 18 });
  gpsStatus.textContent = `✓ ${s.name}${s.friedhof ? ' · ' + s.friedhof : ''} – Marker steht in der Gruppen-Mitte ` +
    '(ungefähr). Zum Grab ziehen oder beim Besuch per GPS genau speichern.';
  gpsStatus.className = 'gps-status ok';
  return true;
}

document.getElementById('btn-gruppe-pos').addEventListener('click', () => applyGruppePos(true));

// Automatisch beim Eintippen der Gruppe – solange keine genauere Position da ist
let gruppeTimer = null;
fGruppe.addEventListener('input', () => {
  clearTimeout(gruppeTimer);
  if (editPos && editPosSource !== 'gruppe') return;
  gruppeTimer = setTimeout(() => applyGruppePos(false), 600);
});
document.getElementById('btn-edit-back').addEventListener('click', closeEdit);
document.getElementById('btn-add').addEventListener('click', () => openEdit(null));

// ---------- Navigation ----------

const navName = document.getElementById('nav-name');
const navGrn = document.getElementById('nav-grn');
const navDistance = document.getElementById('nav-distance');
const navDetail = document.getElementById('nav-detail');
const navArrow = document.getElementById('nav-arrow');
const btnCompass = document.getElementById('btn-compass');
const btnNavPhoto = document.getElementById('btn-nav-photo');

let navMap = null;
let navGrave = null;
let navWatchId = null;
let userMarker = null;
let accCircle = null;
let graveMarker = null;
let routeLine = null;
let heading = null;          // Kompassrichtung des Geräts (0 = Norden)
let currentBearing = null;   // Richtung zum Grab
let mapFollowUser = true;

const userIcon = L.divIcon({ className: '', html: '<div class="user-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
const graveIcon = L.divIcon({ className: '', html: '<div class="grave-pin">🕯️</div>', iconSize: [26, 26], iconAnchor: [13, 24] });

function initNavMap() {
  if (navMap) return;
  navMap = L.map('nav-map', { zoomControl: false }).setView(FRIEDHOF_CENTER, 15);
  L.tileLayer(TILE_URL, { attribution: TILE_ATTRIB, maxZoom: 19 }).addTo(navMap);
  L.control.zoom({ position: 'bottomright' }).addTo(navMap);
  // Wenn der Nutzer die Karte selbst verschiebt, nicht mehr automatisch zentrieren
  navMap.on('dragstart', () => { mapFollowUser = false; });
  Gruppen.attach(navMap);
}

function updateArrow() {
  if (currentBearing == null) return;
  // Pfeil relativ zur Geräteausrichtung drehen, sonst relativ zu Norden
  const rot = heading != null ? currentBearing - heading : currentBearing;
  navArrow.style.transform = `rotate(${rot}deg)`;
}

function onNavPosition(p) {
  const { latitude: lat, longitude: lon, accuracy } = p.coords;
  lastKnownPos = { lat, lon };

  if (!userMarker) {
    userMarker = L.marker([lat, lon], { icon: userIcon }).addTo(navMap);
    accCircle = L.circle([lat, lon], { radius: accuracy, weight: 1, color: '#555555', fillOpacity: 0.1 }).addTo(navMap);
  } else {
    userMarker.setLatLng([lat, lon]);
    accCircle.setLatLng([lat, lon]).setRadius(accuracy);
  }

  const d = distanceM(lat, lon, navGrave.lat, navGrave.lon);
  const approx = navGrave.posQuelle === 'gruppe';
  currentBearing = bearingDeg(lat, lon, navGrave.lat, navGrave.lon);

  routeLine.setLatLngs([[lat, lon], [navGrave.lat, navGrave.lon]]);
  if (mapFollowUser) {
    navMap.fitBounds(routeLine.getBounds(), { padding: [40, 40], maxZoom: 19 });
  }

  navDistance.textContent = (approx ? '≈ ' : '') + fmtDistance(d);
  if (approx && d <= 40) {
    // Ziel ist nur die Gruppen-Mitte -> ab hier helfen Reihe/Nummer
    const rest = [navGrave.reihe && 'Reihe ' + navGrave.reihe, navGrave.nummer && 'Nr. ' + navGrave.nummer]
      .filter(Boolean).join(', ');
    navDetail.textContent = `📍 Du bist in ${navGrave.gruppe ? 'Gruppe ' + navGrave.gruppe : 'der Gruppe'}` +
      (rest ? ` – jetzt ${rest} suchen.` : ' – jetzt nach dem Grab umsehen.');
  } else if (!approx && d <= 8) {
    navDetail.textContent = '🎯 Du bist da! Schau dich um.';
  } else {
    const dir = heading == null ? ` – Richtung ${cardinal(currentBearing)}` : '';
    navDetail.textContent = `GPS ±${Math.round(accuracy)} m${dir}` + (approx ? ' · Ziel: Gruppen-Mitte' : '');
  }
  updateArrow();
}

function onOrientation(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number') {
    h = e.webkitCompassHeading; // iOS
  } else if (e.absolute && typeof e.alpha === 'number') {
    h = (360 - e.alpha) % 360; // Android (absolute Ausrichtung)
  }
  if (h != null) {
    heading = h;
    btnCompass.classList.add('hidden');
    updateArrow();
  }
}

function startCompass() {
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) return;
  if (typeof DOE.requestPermission === 'function') {
    // iOS: braucht eine Nutzer-Geste – Button anzeigen
    btnCompass.classList.remove('hidden');
  } else {
    window.addEventListener('deviceorientationabsolute', onOrientation);
    window.addEventListener('deviceorientation', onOrientation);
  }
}

btnCompass.addEventListener('click', () => {
  DeviceOrientationEvent.requestPermission().then(state => {
    if (state === 'granted') {
      window.addEventListener('deviceorientation', onOrientation);
      btnCompass.classList.add('hidden');
    }
  }).catch(() => {});
});

function openNav(id) {
  const g = graves.find(x => x.id === id);
  if (g) openNavObj(g);
}

let navReturnView = 'list';

/* Navigation zu einem beliebigen Ziel (gespeichertes Grab, Promi-Grab,
 * Suchergebnis). returnView: Ansicht, zu der „Zurück“ führt. */
function openNavObj(g, returnView = 'list') {
  navGrave = g;
  navReturnView = returnView;
  if (!navGrave || navGrave.lat == null) return;

  navName.textContent = navGrave.name;
  navGrn.textContent = [graveSubtitle(navGrave), navGrave.notiz].filter(Boolean).join(' – ');
  navDistance.textContent = '– m';
  navDetail.textContent = 'Warte auf GPS…';
  document.getElementById('link-gmaps').href =
    `https://www.google.com/maps/dir/?api=1&destination=${navGrave.lat},${navGrave.lon}&travelmode=walking`;
  btnNavPhoto.classList.toggle('hidden', !navGrave.photo);

  showView('nav');
  initNavMap();
  mapFollowUser = true;

  // Marker und Linie sofort anlegen – der GPS-Callback kann jederzeit feuern
  if (graveMarker) graveMarker.remove();
  if (routeLine) routeLine.remove();
  graveMarker = L.marker([navGrave.lat, navGrave.lon], { icon: graveIcon }).addTo(navMap)
    .bindPopup(navGrave.name);
  routeLine = L.polyline([[navGrave.lat, navGrave.lon], [navGrave.lat, navGrave.lon]],
    { color: '#111111', weight: 3, dashArray: '6 8' }).addTo(navMap);

  // Karte braucht nach dem Einblenden ein Resize
  setTimeout(() => {
    navMap.invalidateSize();
    navMap.setView([navGrave.lat, navGrave.lon], 17);
  }, 50);

  if ('geolocation' in navigator) {
    navWatchId = navigator.geolocation.watchPosition(onNavPosition, err => {
      navDetail.textContent = err.code === 1
        ? 'Standortzugriff verweigert – bitte im Browser erlauben.'
        : 'GPS-Fehler: ' + err.message;
    }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  } else {
    navDetail.textContent = 'Keine Standortabfrage möglich.';
  }
  startCompass();
}

function closeNav() {
  if (navWatchId != null) {
    navigator.geolocation.clearWatch(navWatchId);
    navWatchId = null;
  }
  window.removeEventListener('deviceorientationabsolute', onOrientation);
  window.removeEventListener('deviceorientation', onOrientation);
  heading = null;
  if (userMarker) { userMarker.remove(); userMarker = null; }
  if (accCircle) { accCircle.remove(); accCircle = null; }
  renderList();
  showView(navReturnView);
  if (navReturnView === 'plan' && planMap) setTimeout(() => planMap.invalidateSize(), 50);
}

document.getElementById('btn-nav-back').addEventListener('click', closeNav);

// Grab-Position teilen (z. B. per WhatsApp); Fallback: in Zwischenablage kopieren
document.getElementById('btn-share').addEventListener('click', async () => {
  if (!navGrave) return;
  const url = `https://www.google.com/maps/search/?api=1&query=${navGrave.lat},${navGrave.lon}`;
  const text = ['🕯️ ' + navGrave.name, graveSubtitle(navGrave), url].filter(Boolean).join('\n');
  if (navigator.share) {
    navigator.share({ title: navGrave.name, text }).catch(() => {});
  } else {
    try {
      await navigator.clipboard.writeText(text);
      alert('Link in die Zwischenablage kopiert!');
    } catch {
      prompt('Zum Kopieren:', url);
    }
  }
});

// Foto-Vollbild
const photoModal = document.getElementById('photo-modal');
btnNavPhoto.addEventListener('click', () => {
  document.getElementById('photo-modal-img').src = navGrave.photo;
  photoModal.classList.remove('hidden');
});
photoModal.addEventListener('click', () => photoModal.classList.add('hidden'));

// ---------- Friedhofsplan (Gruppen-Übersicht) ----------

const planStatus = document.getElementById('plan-status');
const planSearchInput = document.getElementById('plan-search');
let planMap = null;
let planUserMarker = null;

function setPlanStatus(msg) {
  planStatus.textContent = msg || '';
  planStatus.classList.toggle('hidden', !msg);
}

const WIEN_CENTER = [48.2082, 16.3738];

function initPlanMap() {
  if (planMap) return;
  // Mit bekannter Position dorthin, sonst Übersicht über ganz Wien
  const start = lastKnownPos ? [lastKnownPos.lat, lastKnownPos.lon] : WIEN_CENTER;
  planMap = L.map('plan-map').setView(start, lastKnownPos ? 15 : 12);
  L.tileLayer(TILE_URL, { attribution: TILE_ATTRIB, maxZoom: 19 }).addTo(planMap);
  Gruppen.attach(planMap, setPlanStatus);
  Promis.attach(planMap, setPlanStatus, poi => {
    openNavObj({
      id: 'promi', name: poi.name, lat: poi.lat, lon: poi.lon,
      gruppe: poi.gruppe || '', notiz: ['Promi-Grab', poi.friedhof].filter(Boolean).join(' · '),
    }, 'plan');
  });
}

// ----- Ergebnis-Karte der Plan-Suche -----

const planResult = document.getElementById('plan-result');
let planResultData = null;

function showPlanResult(r) {
  planResultData = r;
  planResult.classList.toggle('hidden', !r);
  if (!r) return;
  const { angabe, sector, others, exact, variants } = r;
  const gruppe = sector.label;
  document.getElementById('pr-title').textContent = [
    'Gruppe ' + gruppe,
    angabe.reihe && 'Reihe ' + angabe.reihe,
    angabe.nummer && 'Nr. ' + angabe.nummer,
  ].filter(Boolean).join(' · ');
  const sub = [(sector.friedhof || 'Friedhof unbekannt') + ' · Gruppe markiert.'];
  if (!exact && variants.length) {
    sub.unshift(`„${angabe.gruppe}“ gibt es nicht genau so` +
      (variants.length > 1 ? ` – es gibt ${variants.join(', ')}.` : '.'));
  }
  if (angabe.reihe || angabe.nummer) {
    sub.push('Reihe/Nr. verzeichnet keine öffentliche Karte – vor Ort helfen die Reihen-Schilder.');
  }
  if (others.length) {
    sub.push(`Auch auf: ${others.slice(0, 3).join(', ')}${others.length > 3 ? ' …' : ''} (Friedhof mit eintippen).`);
  }
  document.getElementById('pr-sub').textContent = sub.join(' ');
}

function planResultTarget() {
  const { angabe, sector } = planResultData;
  return {
    name: [sector.friedhof, 'Gruppe ' + sector.label].filter(Boolean).join(' · '),
    gruppe: sector.label,
    reihe: angabe.reihe,
    nummer: angabe.nummer,
    notiz: sector.friedhof || '',
    lat: sector.center[0],
    lon: sector.center[1],
    posQuelle: 'gruppe',
  };
}

document.getElementById('pr-close').addEventListener('click', () => showPlanResult(null));
document.getElementById('pr-nav').addEventListener('click', () => {
  if (planResultData) openNavObj({ id: 'suche', ...planResultTarget() }, 'plan');
});
document.getElementById('pr-save').addEventListener('click', () => {
  if (!planResultData) return;
  const t = planResultTarget();
  openEdit(null, { ...t, name: '' });
  setTimeout(() => fName.focus(), 300);
});

// Ebenen-Schalter
document.getElementById('tgl-gruppen').addEventListener('click', e => {
  const on = e.currentTarget.classList.toggle('active');
  Gruppen.setVisible(planMap, on);
});
document.getElementById('tgl-promis').addEventListener('click', e => {
  const on = e.currentTarget.classList.toggle('active');
  Promis.setVisible(planMap, on);
});

function openPlan() {
  showView('plan');
  initPlanMap();
  setTimeout(() => planMap.invalidateSize(), 50);
}

document.getElementById('btn-plan').addEventListener('click', openPlan);
document.getElementById('btn-plan-back').addEventListener('click', () => showView('list'));

let coordMarker = null;

document.getElementById('plan-search-form').addEventListener('submit', e => {
  e.preventDefault();
  // Nie still scheitern: jeden Fehler sichtbar melden
  planSearch().catch(err => {
    setPlanStatus('Bei der Suche ist ein Fehler aufgetreten (' + (err && err.message || err) +
      '). Bitte die Seite neu laden.');
  });
});

async function planSearch() {
  const q = planSearchInput.value.trim();
  if (!q) return;
  planSearchInput.blur();
  showPlanResult(null);
  setPlanStatus('Suche …');

  // 1) Koordinaten? (z. B. „48.1528, 16.4425“)
  const cm = /^(-?\d{1,2}[.,]\d+)[\s;,]+(-?\d{1,3}[.,]\d+)$/.exec(q);
  if (cm) {
    const lat = parseFloat(cm[1].replace(',', '.'));
    const lon = parseFloat(cm[2].replace(',', '.'));
    if (coordMarker) coordMarker.remove();
    coordMarker = L.marker([lat, lon], { icon: graveIcon }).addTo(planMap)
      .bindPopup(`${lat.toFixed(5)}, ${lon.toFixed(5)}`).openPopup();
    planMap.setView([lat, lon], 18);
    setPlanStatus('Koordinaten auf der Karte markiert.');
    return;
  }

  if (!Gruppen.isLoaded()) setPlanStatus('Lade Friedhofsplan …');
  try {
    await Gruppen.load(setPlanStatus);
  } catch {
    setPlanStatus('Friedhofsplan konnte nicht geladen werden – bitte Internetverbindung prüfen und neu laden.');
    return;
  }

  // 2) Grab-Angabe mit Gruppe („40“, „40/12/27“, „Gruppe 40 Reihe 12 Nr. 27“, „Hietzing 5/3/12“)
  const angabe = parseGrabAngabe(q);
  if (angabe.gruppe) {
    // Nur wenn hineingezoomt: Treffer in der Nähe des Kartenausschnitts bevorzugen
    const c = planMap.getCenter();
    const ref = planMap.getZoom() >= 14 ? [c.lat, c.lng] : null;
    const hit = Gruppen.findGruppe(angabe.gruppe, { friedhof: angabe.friedhof, ref });
    if (hit) {
      Gruppen.highlight(planMap, hit.parts);
      setPlanStatus('');
      showPlanResult({ angabe, ...hit });
      return;
    }
    setPlanStatus(`Gruppe „${angabe.gruppe}“ ist in den Kartendaten` +
      (angabe.friedhof ? ` für „${angabe.friedhof}“` : '') +
      ' nicht verzeichnet. Tipp: Friedhof auf der Karte suchen und das Grab per Fingertipp setzen.');
    return;
  }

  // 3) Friedhof nach Namen
  const cem = Gruppen.findFriedhof(q) || (angabe.friedhof && Gruppen.findFriedhof(angabe.friedhof));
  if (cem) {
    Gruppen.highlight(planMap, cem);
    setPlanStatus(cem[0].name + ' – auf der Karte markiert.');
    return;
  }

  // 4) Prominentengrab nach Namen
  try { await Promis.load(); } catch { /* ohne Promi-Daten weiter */ }
  const promi = Promis.focus(planMap, q);
  setPlanStatus(promi ? promi + ' – auf der Karte markiert.' : `„${q}“ nicht gefunden – weder als Gruppe, Friedhof noch Name.`);
}

document.getElementById('btn-plan-locate').addEventListener('click', () => {
  if (!('geolocation' in navigator)) return;
  setPlanStatus('Suche GPS-Signal…');
  navigator.geolocation.getCurrentPosition(p => {
    const ll = [p.coords.latitude, p.coords.longitude];
    lastKnownPos = { lat: ll[0], lon: ll[1] };
    if (!planUserMarker) {
      planUserMarker = L.marker(ll, { icon: userIcon }).addTo(planMap);
    } else {
      planUserMarker.setLatLng(ll);
    }
    planMap.setView(ll, 17);
    setPlanStatus('');
  }, () => setPlanStatus('Position konnte nicht ermittelt werden.'),
  { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
});

// ---------- Burger-Menü ----------

const menuPanel = document.getElementById('menu-panel');
document.getElementById('btn-menu').addEventListener('click', e => {
  e.stopPropagation();
  menuPanel.classList.toggle('hidden');
});
// Jeder Klick außerhalb des Burger-Knopfs (auch auf einen Menüpunkt) schließt das Menü
document.addEventListener('click', () => menuPanel.classList.add('hidden'));

// ---------- Sicherung (Export / Import) ----------

document.getElementById('btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(graves, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'grabfinder-sicherung.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById('input-import').addEventListener('change', e => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      if (!Array.isArray(imported)) throw new Error('kein Array');
      let added = 0;
      for (const g of imported) {
        if (!g || !g.id || g.lat == null || !g.name) continue;
        if (!graves.some(x => x.id === g.id)) { graves.push(g); added++; }
      }
      persistGraves();
      renderList();
      alert(added + ' Grab/Gräber importiert.');
    } catch {
      alert('Datei konnte nicht gelesen werden – ist das eine Grabfinder-Sicherung?');
    }
    e.target.value = '';
  };
  reader.readAsText(file);
});

// ---------- Start ----------

renderList();
refreshListDistances();

if ('serviceWorker' in navigator &&
    (location.protocol === 'https:' || location.hostname === 'localhost')) {
  // Neue Version bereit (neuer Service Worker übernimmt) -> einmal automatisch neu
  // laden, damit nie eine alte Version weiterläuft. Nicht beim allerersten Besuch.
  const hadController = !!navigator.serviceWorker.controller;
  let swReloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || swReloaded) return;
    swReloaded = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js')
    .then(reg => reg.update())   // bei jedem Start nach Updates fragen
    .catch(() => {});
}
