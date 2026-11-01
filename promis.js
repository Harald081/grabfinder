/* Prominentengräber (POIs) auf Wiener Friedhöfen
 *
 * Lädt einmalig alle in OpenStreetMap einzeln erfassten Gräber mit Namen
 * (historic=tomb bzw. cemetery=grave) inklusive Wikipedia-Verknüpfung,
 * cached sie in localStorage und zeigt sie als ⭐-Marker mit Popup
 * (Name, Wikipedia-Link, „Hinführen"-Knopf).
 */
'use strict';

const Promis = (() => {
  const CACHE_KEY = 'zf-promis-v1';
  const CACHE_MAX_AGE = 1000 * 60 * 60 * 24 * 180;
  const BBOX = '48.11,16.18,48.33,16.58';
  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  const QUERY =
    `[out:json][timeout:120];` +
    `(` +
    `node["historic"="tomb"]["name"](${BBOX});` +
    `way["historic"="tomb"]["name"](${BBOX});` +
    `node["cemetery"="grave"]["name"](${BBOX});` +
    `way["cemetery"="grave"]["name"](${BBOX});` +
    `);` +
    `out tags center;`;

  const MARKER_MIN_ZOOM = 15;

  let pois = null;      // [{name, lat, lon, wiki}]
  let loadPromise = null;
  let onNavigateCb = null;
  const attached = [];  // [{map, group, markers: [{poi, marker}], visible, sync}]

  const round5 = x => Math.round(x * 1e5) / 1e5;

  function wikiUrl(tags) {
    const w = tags.wikipedia;
    if (w && w.includes(':')) {
      const [lang, ...rest] = w.split(':');
      return `https://${lang}.wikipedia.org/wiki/` +
        encodeURIComponent(rest.join(':').trim().replace(/ /g, '_'));
    }
    if (tags.wikidata) return 'https://www.wikidata.org/wiki/' + tags.wikidata;
    return null;
  }

  function parseOverpass(osm) {
    const out = [];
    const seen = new Set();
    for (const el of osm.elements || []) {
      const tags = el.tags || {};
      const name = (tags.name || '').trim();
      if (!name) continue;
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (lat == null || lon == null) continue;
      const key = name + ':' + Math.round(lat * 1e4) + ',' + Math.round(lon * 1e4);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, lat: round5(lat), lon: round5(lon), wiki: wikiUrl(tags) });
    }
    return out;
  }

  function load(statusCb) {
    if (pois) return Promise.resolve(pois);
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
      // 1) Mitgelieferte Daten (per GitHub-Workflow aus OpenStreetMap erzeugt)
      try {
        const res = await fetch('data/promis.json');
        if (res.ok) {
          const d = await res.json();
          if (Array.isArray(d.pois) && d.pois.length) { pois = d.pois; return pois; }
        }
      } catch { /* weiter mit Fallbacks */ }

      // 2) Zuletzt live geladene Daten
      try {
        const c = JSON.parse(localStorage.getItem(CACHE_KEY));
        if (c && c.ts && Date.now() - c.ts < CACHE_MAX_AGE && Array.isArray(c.pois) && c.pois.length) {
          pois = c.pois;
          return pois;
        }
      } catch { /* Cache kaputt -> neu laden */ }

      // 3) Live von der Overpass API
      if (statusCb) statusCb('Lade Prominentengräber (einmalig)…');
      let lastErr = null;
      for (const endpoint of ENDPOINTS) {
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(QUERY),
          });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const parsed = parseOverpass(await res.json());
          if (!parsed.length) throw new Error('keine POIs in Antwort');
          pois = parsed;
          try {
            localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), pois }));
          } catch { /* Speicher voll -> nur im RAM */ }
          return pois;
        } catch (e) {
          lastErr = e;
        }
      }
      loadPromise = null;
      throw lastErr || new Error('POIs nicht ladbar');
    })();
    return loadPromise;
  }

  const starIcon = L.divIcon({
    className: 'promi-pin',
    html: '<div>⭐</div>',
    iconSize: [0, 0],
  });

  function popupFor(poi) {
    const div = document.createElement('div');
    div.className = 'promi-popup';
    const strong = document.createElement('strong');
    strong.textContent = poi.name;
    div.appendChild(strong);
    const where = [poi.gruppe ? 'Gruppe ' + poi.gruppe : '', poi.friedhof || ''].filter(Boolean).join(' · ');
    if (where) {
      const small = document.createElement('span');
      small.className = 'promi-where';
      small.textContent = where;
      div.appendChild(small);
    }
    if (poi.wiki) {
      const a = document.createElement('a');
      a.href = poi.wiki;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = '📖 Wikipedia';
      div.appendChild(a);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '➤ Hinführen';
    btn.onclick = () => { if (onNavigateCb) onNavigateCb(poi); };
    div.appendChild(btn);
    return div;
  }

  function buildFor(map, list) {
    if (attached.some(a => a.map === map)) return;
    const group = L.layerGroup();
    const markers = [];
    for (const poi of list) {
      const marker = L.marker([poi.lat, poi.lon], { icon: starIcon })
        .bindTooltip(poi.name)
        .bindPopup(() => popupFor(poi));
      marker.addTo(group);
      markers.push({ poi, marker });
    }
    const entry = { map, group, markers, visible: true };
    entry.sync = () => {
      if (!entry.visible) { if (map.hasLayer(group)) map.removeLayer(group); return; }
      if (map.getZoom() >= MARKER_MIN_ZOOM) {
        if (!map.hasLayer(group)) group.addTo(map);
      } else if (map.hasLayer(group)) {
        map.removeLayer(group);
      }
    };
    map.on('zoomend', entry.sync);
    entry.sync();
    attached.push(entry);
  }

  /* Marker auf eine Karte legen. onNavigate wird beim „Hinführen"-Knopf gerufen. */
  function attach(map, statusCb, onNavigate) {
    if (onNavigate) onNavigateCb = onNavigate;
    load(statusCb)
      .then(list => { buildFor(map, list); if (statusCb) statusCb(''); })
      .catch(() => {
        if (statusCb) statusCb('Prominentengräber konnten nicht geladen werden – bitte Internetverbindung prüfen.');
      });
  }

  function setVisible(map, visible) {
    const entry = attached.find(a => a.map === map);
    if (!entry) return;
    entry.visible = visible;
    entry.sync();
  }

  /* Nach Namen suchen, hinzoomen und Popup öffnen. Gibt den Namen zurück oder null. */
  function focus(map, query) {
    const entry = attached.find(a => a.map === map);
    const q = String(query).trim().toLowerCase();
    if (!entry || !q || q.length < 2) return null;
    const hits = entry.markers.filter(m => m.poi.name.toLowerCase().includes(q));
    if (!hits.length) return null;
    // Kürzester Name = wahrscheinlich bester Treffer
    hits.sort((a, b) => a.poi.name.length - b.poi.name.length);
    const best = hits[0];
    entry.visible = true;
    map.setView([best.poi.lat, best.poi.lon], Math.max(map.getZoom(), 17));
    entry.sync();
    best.marker.openPopup();
    return best.poi.name;
  }

  function isLoaded() { return !!pois; }

  return { attach, load, focus, setVisible, isLoaded, version: 8 };
})();
