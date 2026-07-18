/* Gruppenplan des Wiener Zentralfriedhofs
 *
 * Lädt die Umrisse der Grab-Gruppen einmalig von OpenStreetMap (Overpass API),
 * cached sie in localStorage und zeichnet sie als Overlay (Polygone + Labels)
 * auf die Leaflet-Karten. Labels werden erst ab Zoomstufe 16 eingeblendet.
 */
'use strict';

const Gruppen = (() => {
  const CACHE_KEY = 'zf-gruppen-v1';
  const CACHE_MAX_AGE = 1000 * 60 * 60 * 24 * 180; // ein halbes Jahr
  // Bounding-Box um den Zentralfriedhof (Süd, West, Nord, Ost)
  const BBOX = '48.137,16.416,48.163,16.463';
  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  const QUERY =
    `[out:json][timeout:90];` +
    `(` +
    `way["cemetery"="sector"](${BBOX});` +
    `relation["cemetery"="sector"](${BBOX});` +
    `way["name"~"^Gruppe ",i](${BBOX});` +
    `);` +
    `out tags geom;`;

  const POLY_STYLE = { color: '#3f7a4c', weight: 1.5, opacity: 0.8, fillColor: '#7fc98a', fillOpacity: 0.06 };
  const HILITE_STYLE = { color: '#e0b34c', weight: 3, opacity: 1, fillColor: '#e0b34c', fillOpacity: 0.18 };
  const LABEL_MIN_ZOOM = 16;

  let sectors = null;   // [{label, name, ring: [[lat,lon],...], center: [lat,lon]}]
  let loadPromise = null;
  const attached = [];  // [{map, polyGroup, labelGroup, polys: [{sector, poly}]}]

  const round5 = x => Math.round(x * 1e5) / 1e5;
  const normalize = s => String(s).toLowerCase().replace(/gruppe/g, '').replace(/[\s.]+/g, '');

  function shortLabel(tags) {
    const n = tags.name || tags.ref || '';
    const m = /^Gruppe\s+(.+)$/i.exec(n);
    return (m ? m[1] : n).trim();
  }

  function ringCenter(ring) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const [lat, lon] of ring) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
    return [round5((minLat + maxLat) / 2), round5((minLon + maxLon) / 2)];
  }

  function parseOverpass(osm) {
    const out = [];
    const seen = new Set();
    for (const el of osm.elements || []) {
      const tags = el.tags || {};
      const label = shortLabel(tags);
      if (!label) continue;

      let rings = [];
      if (el.type === 'way' && Array.isArray(el.geometry)) {
        rings = [el.geometry];
      } else if (el.type === 'relation' && Array.isArray(el.members)) {
        rings = el.members
          .filter(m => m.type === 'way' && m.role !== 'inner' && Array.isArray(m.geometry))
          .map(m => m.geometry);
      }

      for (const geom of rings) {
        const ring = geom.map(p => [round5(p.lat), round5(p.lon)]);
        if (ring.length < 3) continue;
        // Duplikate vermeiden (Way kann von mehreren Abfrage-Zweigen kommen)
        const key = label + ':' + ring[0][0] + ',' + ring[0][1] + ':' + ring.length;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          label,
          name: tags.name || ('Gruppe ' + label),
          ring,
          center: ringCenter(ring),
        });
      }
    }
    return out;
  }

  function load(statusCb) {
    if (sectors) return Promise.resolve(sectors);
    if (loadPromise) return loadPromise;

    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (c && c.ts && Date.now() - c.ts < CACHE_MAX_AGE &&
          Array.isArray(c.sectors) && c.sectors.length) {
        sectors = c.sectors;
        return Promise.resolve(sectors);
      }
    } catch { /* Cache kaputt -> neu laden */ }

    if (statusCb) statusCb('Lade Gruppenplan (einmalig, ein paar Sekunden)…');
    loadPromise = (async () => {
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
          if (!parsed.length) throw new Error('Antwort enthielt keine Gruppen');
          sectors = parsed;
          try {
            localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), sectors }));
          } catch { /* Speicher voll -> nur im RAM behalten */ }
          return sectors;
        } catch (e) {
          lastErr = e;
        }
      }
      loadPromise = null; // nächster Versuch darf neu starten
      throw lastErr || new Error('Gruppenplan nicht ladbar');
    })();
    return loadPromise;
  }

  function labelIcon(text) {
    return L.divIcon({
      className: 'gruppe-label',
      html: '<div>' + text.replace(/[<>&]/g, '') + '</div>',
      iconSize: [0, 0],
    });
  }

  function buildFor(map, secs) {
    if (attached.some(a => a.map === map)) return;
    const polyGroup = L.layerGroup();
    const labelGroup = L.layerGroup();
    const polys = [];

    for (const sector of secs) {
      const poly = L.polygon(sector.ring, POLY_STYLE)
        .bindTooltip(sector.name, { sticky: true });
      poly.addTo(polyGroup);
      polys.push({ sector, poly });
      L.marker(sector.center, { icon: labelIcon(sector.label), interactive: false })
        .addTo(labelGroup);
    }

    polyGroup.addTo(map);
    const syncLabels = () => {
      if (map.getZoom() >= LABEL_MIN_ZOOM) {
        if (!map.hasLayer(labelGroup)) labelGroup.addTo(map);
      } else if (map.hasLayer(labelGroup)) {
        map.removeLayer(labelGroup);
      }
    };
    map.on('zoomend', syncLabels);
    syncLabels();

    attached.push({ map, polyGroup, labelGroup, polys });
  }

  /* Overlay auf eine Karte legen (lädt die Daten beim ersten Mal). */
  function attach(map, statusCb) {
    load(statusCb)
      .then(secs => {
        buildFor(map, secs);
        if (statusCb) statusCb('');
      })
      .catch(() => {
        if (statusCb) statusCb('Gruppenplan konnte nicht geladen werden – bitte Internetverbindung prüfen und erneut öffnen.');
      });
  }

  /* Gruppe suchen und auf der Karte hervorheben. Gibt den Namen zurück oder null. */
  function focus(map, query) {
    const entry = attached.find(a => a.map === map);
    const nq = normalize(query);
    if (!entry || !nq) return null;

    let matches = entry.polys.filter(p => normalize(p.sector.label) === nq);
    if (!matches.length) matches = entry.polys.filter(p => normalize(p.sector.label).startsWith(nq));
    if (!matches.length) return null;

    const bounds = L.featureGroup(matches.map(m => m.poly)).getBounds();
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 18 });
    for (const m of matches) {
      m.poly.setStyle(HILITE_STYLE);
      setTimeout(() => m.poly.setStyle(POLY_STYLE), 4000);
    }
    return matches[0].sector.name;
  }

  function isLoaded() { return !!sectors; }

  return { attach, focus, isLoaded };
})();
