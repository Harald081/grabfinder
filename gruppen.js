/* Friedhofsplan für alle Wiener Friedhöfe
 *
 * Lädt einmalig von OpenStreetMap (Overpass API):
 *  - die Umrisse aller Friedhöfe in Wien (mit Namen)
 *  - alle erfassten Grab-Gruppen (am Zentralfriedhof vollständig,
 *    bei kleineren Friedhöfen je nach Datenlage)
 * cached alles in localStorage und zeichnet es als Overlay auf die
 * Leaflet-Karten. Gruppen-Labels erscheinen ab Zoomstufe 16,
 * Friedhofs-Namen bei niedrigeren Zoomstufen.
 */
'use strict';

const Gruppen = (() => {
  const CACHE_KEY = 'zf-gruppen-v2';
  const CACHE_MAX_AGE = 1000 * 60 * 60 * 24 * 180; // ein halbes Jahr
  // Bounding-Box um ganz Wien (Süd, West, Nord, Ost)
  const BBOX = '48.11,16.18,48.33,16.58';
  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  const QUERY =
    `[out:json][timeout:120];` +
    `(` +
    `way["cemetery"="sector"](${BBOX});` +
    `relation["cemetery"="sector"](${BBOX});` +
    `way["name"~"^Gruppe ",i]["landuse"!~"."]["building"!~"."](${BBOX});` +
    `way["landuse"="cemetery"]["name"](${BBOX});` +
    `relation["landuse"="cemetery"]["name"](${BBOX});` +
    `);` +
    `out tags geom;`;

  const POLY_STYLE = { color: '#444444', weight: 1.5, opacity: 0.8, fillColor: '#999999', fillOpacity: 0.07 };
  const HILITE_STYLE = { color: '#000000', weight: 3.5, opacity: 1, fillColor: '#000000', fillOpacity: 0.22 };
  const CEM_STYLE = { color: '#666666', weight: 2, opacity: 0.6, dashArray: '4 6', fillColor: '#666666', fillOpacity: 0.04 };
  const LABEL_MIN_ZOOM = 16;      // ab hier: Gruppen-Nummern
  const CEM_LABEL_MIN_ZOOM = 12;  // ab hier: Friedhofs-Namen (bis LABEL_MIN_ZOOM)

  let sectors = null;   // [{kind:'gruppe'|'friedhof', label, name, ring: [[lat,lon],...], center}]
  let loadPromise = null;
  const attached = [];  // [{map, polyGroup, labelGroup, cemLabelGroup, polys: [{sector, poly}]}]

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
      const isFriedhof = tags.landuse === 'cemetery';
      const label = isFriedhof ? (tags.name || '').trim() : shortLabel(tags);
      if (!label) continue;

      let rings = [];
      if (el.type === 'way' && Array.isArray(el.geometry)) {
        rings = [el.geometry];
      } else if (el.type === 'relation' && Array.isArray(el.members)) {
        rings = el.members
          .filter(m => m.type === 'way' && m.role !== 'inner' && Array.isArray(m.geometry))
          .map(m => m.geometry);
      }

      let first = true;
      for (const geom of rings) {
        const ring = geom.map(p => [round5(p.lat), round5(p.lon)]);
        if (ring.length < 3) continue;
        // Duplikate vermeiden (Way kann von mehreren Abfrage-Zweigen kommen)
        const key = label + ':' + ring[0][0] + ',' + ring[0][1] + ':' + ring.length;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          kind: isFriedhof ? 'friedhof' : 'gruppe',
          label,
          name: isFriedhof ? label : (tags.name || ('Gruppe ' + label)),
          // Bei mehrteiligen Friedhöfen nur den ersten Teil beschriften
          labeled: !isFriedhof || first,
          ring,
          center: ringCenter(ring),
        });
        first = false;
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

  function labelIcon(text, cls) {
    return L.divIcon({
      className: cls,
      html: '<div>' + text.replace(/[<>&]/g, '') + '</div>',
      iconSize: [0, 0],
    });
  }

  function buildFor(map, secs) {
    if (attached.some(a => a.map === map)) return;
    const polyGroup = L.layerGroup();
    const labelGroup = L.layerGroup();     // Gruppen-Nummern
    const cemLabelGroup = L.layerGroup();  // Friedhofs-Namen
    const polys = [];

    for (const sector of secs) {
      const isFriedhof = sector.kind === 'friedhof';
      const poly = L.polygon(sector.ring, isFriedhof ? CEM_STYLE : POLY_STYLE)
        .bindTooltip(sector.name, { sticky: true });
      poly.addTo(polyGroup);
      polys.push({ sector, poly });
      if (isFriedhof) {
        if (sector.labeled) {
          L.marker(sector.center, { icon: labelIcon(sector.label, 'friedhof-label'), interactive: false })
            .addTo(cemLabelGroup);
        }
      } else {
        L.marker(sector.center, { icon: labelIcon(sector.label, 'gruppe-label'), interactive: false })
          .addTo(labelGroup);
      }
    }

    const entry = { map, polyGroup, labelGroup, cemLabelGroup, polys, visible: true };
    entry.sync = () => {
      if (!entry.visible) {
        [polyGroup, labelGroup, cemLabelGroup].forEach(g => { if (map.hasLayer(g)) map.removeLayer(g); });
        return;
      }
      if (!map.hasLayer(polyGroup)) polyGroup.addTo(map);
      const z = map.getZoom();
      const showGruppen = z >= LABEL_MIN_ZOOM;
      const showFriedhoefe = z >= CEM_LABEL_MIN_ZOOM && z < LABEL_MIN_ZOOM;
      if (showGruppen) { if (!map.hasLayer(labelGroup)) labelGroup.addTo(map); }
      else if (map.hasLayer(labelGroup)) map.removeLayer(labelGroup);
      if (showFriedhoefe) { if (!map.hasLayer(cemLabelGroup)) cemLabelGroup.addTo(map); }
      else if (map.hasLayer(cemLabelGroup)) map.removeLayer(cemLabelGroup);
    };
    map.on('zoomend', entry.sync);
    entry.sync();

    attached.push(entry);
  }

  function setVisible(map, visible) {
    const entry = attached.find(a => a.map === map);
    if (!entry) return;
    entry.visible = visible;
    entry.sync();
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

  /* Gruppe oder Friedhof suchen und auf der Karte hervorheben.
   * Gibt den gefundenen Namen zurück oder null. */
  function focus(map, query) {
    const entry = attached.find(a => a.map === map);
    const nq = normalize(query);
    if (!entry || !nq) return null;

    const gruppen = entry.polys.filter(p => p.sector.kind === 'gruppe');
    let matches = gruppen.filter(p => normalize(p.sector.label) === nq);
    if (!matches.length) matches = gruppen.filter(p => normalize(p.sector.label).startsWith(nq));
    if (!matches.length) {
      // Kein Gruppen-Treffer -> Friedhöfe nach Namen durchsuchen
      const cems = entry.polys.filter(p => p.sector.kind === 'friedhof');
      const ql = String(query).trim().toLowerCase();
      let cemMatch = cems.filter(p => p.sector.name.toLowerCase().includes(ql));
      if (cemMatch.length) {
        // Alle Teile desselben Friedhofs gemeinsam einrahmen
        const name = cemMatch[0].sector.name;
        matches = cems.filter(p => p.sector.name === name);
      }
    }
    if (!matches.length) return null;

    const bounds = L.featureGroup(matches.map(m => m.poly)).getBounds();
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 18 });
    for (const m of matches) {
      const restore = m.sector.kind === 'friedhof' ? CEM_STYLE : POLY_STYLE;
      m.poly.setStyle(HILITE_STYLE);
      setTimeout(() => m.poly.setStyle(restore), 4000);
    }
    return matches[0].sector.name;
  }

  function isLoaded() { return !!sectors; }

  return { attach, focus, setVisible, isLoaded };
})();
