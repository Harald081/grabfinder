/* Grabfinder – Wiener Zentralfriedhof
 * Speichert Gräber (Position + Infos) lokal am Gerät und navigiert per GPS dorthin.
 */
'use strict';

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

function renderList() {
  listEl.innerHTML = '';
  emptyHint.classList.toggle('hidden', graves.length > 0);

  const sorted = [...graves].sort((a, b) => a.name.localeCompare(b.name, 'de'));
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
      sub.push(fmtDistance(distanceM(lastKnownPos.lat, lastKnownPos.lon, g.lat, g.lon)) + ' entfernt');
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
  pickMap.on('click', e => setEditPos(e.latlng.lat, e.latlng.lng, null, 'Position manuell gesetzt'));
  Gruppen.attach(pickMap);
}

function setEditPos(lat, lon, acc, label) {
  editPos = { lat, lon, acc: acc ?? null };
  if (!pickMarker) {
    pickMarker = L.marker([lat, lon], { draggable: true, icon: pickIcon }).addTo(pickMap);
    pickMarker.on('dragend', () => {
      const ll = pickMarker.getLatLng();
      editPos = { lat: ll.lat, lon: ll.lng, acc: null };
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
      setEditPos(latitude, longitude, accuracy, 'GPS-Position erfasst');
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

function openEdit(id) {
  editId = id || null;
  const g = graves.find(x => x.id === id);

  document.getElementById('edit-title').textContent = g ? 'Grab bearbeiten' : 'Grab speichern';
  btnDelete.classList.toggle('hidden', !g);
  fName.value = g?.name || '';
  fGruppe.value = g?.gruppe || '';
  fReihe.value = g?.reihe || '';
  fNummer.value = g?.nummer || '';
  fNotiz.value = g?.notiz || '';
  fPhoto.value = '';
  editPhoto = g?.photo || null;
  editPos = g && g.lat != null ? { lat: g.lat, lon: g.lon, acc: g.acc ?? null } : null;
  showPhotoPreview();

  showView('edit');
  initPickMap();
  // Karte braucht nach dem Einblenden ein Resize
  setTimeout(() => {
    pickMap.invalidateSize();
    if (editPos) {
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

editForm.addEventListener('submit', e => {
  e.preventDefault();
  if (!editPos) {
    alert('Bitte zuerst die Position des Grabs erfassen (GPS-Knopf oder auf die Karte tippen).');
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
  currentBearing = bearingDeg(lat, lon, navGrave.lat, navGrave.lon);

  routeLine.setLatLngs([[lat, lon], [navGrave.lat, navGrave.lon]]);
  if (mapFollowUser) {
    navMap.fitBounds(routeLine.getBounds(), { padding: [40, 40], maxZoom: 19 });
  }

  navDistance.textContent = fmtDistance(d);
  if (d <= 8) {
    navDetail.textContent = '🎯 Du bist da! Schau dich um.';
  } else {
    const dir = heading == null ? ` – Richtung ${cardinal(currentBearing)}` : '';
    navDetail.textContent = `GPS ±${Math.round(accuracy)} m${dir}`;
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
  navGrave = graves.find(g => g.id === id);
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
  showView('list');
}

document.getElementById('btn-nav-back').addEventListener('click', closeNav);

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
}

function openPlan() {
  showView('plan');
  initPlanMap();
  setTimeout(() => planMap.invalidateSize(), 50);
}

document.getElementById('btn-plan').addEventListener('click', openPlan);
document.getElementById('btn-plan-back').addEventListener('click', () => showView('list'));

document.getElementById('plan-search-form').addEventListener('submit', e => {
  e.preventDefault();
  const q = planSearchInput.value.trim();
  if (!q) return;
  if (!Gruppen.isLoaded()) {
    setPlanStatus('Gruppenplan lädt noch – bitte kurz warten.');
    return;
  }
  const found = Gruppen.focus(planMap, q);
  setPlanStatus(found ? found + ' – auf der Karte markiert' : `Gruppe „${q}“ nicht gefunden.`);
  planSearchInput.blur();
});

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
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
