/* Friedhofsplan für alle Wiener Friedhöfe
 *
 * Datenquelle (in dieser Reihenfolge):
 *  1. data/gruppen.json – wöchentlich per GitHub-Workflow aus OpenStreetMap
 *     erzeugt, liegt direkt bei der App (schnell, offline-fähig)
 *  2. zuletzt geladene Daten aus localStorage
 *  3. live von der Overpass API (Fallback)
 *
 * Zeichnet Friedhofs-Umrisse und Grab-Gruppen als Overlay auf Leaflet-Karten.
 * Gruppen-Nummern erscheinen ab Zoomstufe 16, Friedhofs-Namen darunter.
 */
'use strict';

const Gruppen = (() => {
  const DATA_URL = 'data/gruppen.json';
  const CACHE_KEY = 'zf-gruppen-v3';
  const BBOX = '48.11,16.18,48.33,16.58';
  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  const QUERY =
    `[out:json][timeout:120];(` +
    `way["landuse"="cemetery"]["name"](${BBOX});` +
    `relation["landuse"="cemetery"]["name"](${BBOX});` +
    `way["amenity"="grave_yard"]["name"](${BBOX});` +
    `relation["amenity"="grave_yard"]["name"](${BBOX});` +
    `nwr["cemetery"="sector"](${BBOX});` +
    `nwr["name"~"^(Gruppe|Gr\\\\.) ",i]["highway"!~"."]["public_transport"!~"."](${BBOX});` +
    // „out geom“ (nicht „out tags geom“), sonst fehlt Relationen die Geometrie
    `);out geom;`;

  const POLY_STYLE = { color: '#444444', weight: 1.5, opacity: 0.8, fillColor: '#999999', fillOpacity: 0.07 };
  const HILITE_STYLE = { color: '#000000', weight: 3.5, opacity: 1, fillColor: '#000000', fillOpacity: 0.22 };
  const CEM_STYLE = { color: '#666666', weight: 2, opacity: 0.6, dashArray: '4 6', fillColor: '#666666', fillOpacity: 0.04 };
  const LABEL_MIN_ZOOM = 16;      // ab hier: Gruppen-Nummern
  const CEM_LABEL_MIN_ZOOM = 12;  // ab hier: Friedhofs-Namen (bis LABEL_MIN_ZOOM)

  // sector: {kind:'gruppe'|'friedhof', label, name, friedhof?, labeled, ring|null, center}
  let sectors = null;
  let loadPromise = null;
  const attached = [];  // [{map, polyGroup, labelGroup, cemLabelGroup, polys:[{sector, poly|null}], visible, sync}]

  const round5 = x => Math.round(x * 1e5) / 1e5;
  const GRUPPE_RE = /^\s*(?:gruppe|gr\.)\s*(.+?)\s*$/i;

  /* „Gruppe 32 A“, „32a“, „032A“ -> „32a“ (muss zu normalize() im Export-Skript passen) */
  function normalize(s) {
    return String(s).toLowerCase()
      .replace(/gruppe|gr\./g, '')
      .replace(/[\s.]+/g, '')
      .replace(/^0+(?=\d)/, '');
  }

  /* „Gruppe 82, Tor 9“ -> {label:'82', codes:['82']},
   * „Gruppe 17/47 "MariaHilf"“ -> {label:'17/47', codes:['17','47']} */
  function gruppenLabel(name, ref) {
    const m = GRUPPE_RE.exec(name || '');
    const raw = (m ? m[1] : (ref || name || '')).trim();
    const core = raw.split(/[,„“"([]/)[0].trim() || raw;
    const codes = core.split(/\s*(?:\/|\+|&|\bund\b)\s*/).map(normalize).filter(Boolean);
    return { label: core, codes };
  }

  const codesOf = s => s.codes || [normalize(s.label)];

  // ---------- Geometrie ----------

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

  function ringArea(ring) {
    let s = 0;
    for (let i = 0; i < ring.length; i++) {
      const [y1, x1] = ring[i];
      const [y2, x2] = ring[(i + 1) % ring.length];
      s += x1 * y2 - x2 * y1;
    }
    return Math.abs(s) / 2;
  }

  function inside([y, x], ring) {
    let res = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i];
      const [yj, xj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi) res = !res;
    }
    return res;
  }

  /* Way-Stücke eines Multipolygons zu geschlossenen Ringen zusammensetzen */
  function mergeWays(ways) {
    const same = (a, b) => a[0] === b[0] && a[1] === b[1];
    const segs = ways.filter(w => w.length >= 2).map(w => w.slice());
    const rings = [];
    while (segs.length) {
      let cur = segs.shift();
      let changed = true;
      while (!same(cur[0], cur[cur.length - 1]) && changed) {
        changed = false;
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i];
          if (same(s[0], cur[cur.length - 1])) cur = cur.concat(s.slice(1));
          else if (same(s[s.length - 1], cur[cur.length - 1])) cur = cur.concat(s.slice(0, -1).reverse());
          else if (same(s[s.length - 1], cur[0])) cur = s.slice(0, -1).concat(cur);
          else if (same(s[0], cur[0])) cur = s.slice(1).reverse().concat(cur);
          else continue;
          segs.splice(i, 1);
          changed = true;
          break;
        }
      }
      if (cur.length >= 4) rings.push(cur);
    }
    return rings;
  }

  // ---------- Overpass-Fallback ----------

  function parseOverpass(osm) {
    const pt = p => [round5(p.lat), round5(p.lon)];
    const seen = new Set();
    const friedhoefe = [];
    const gruppen = [];
    for (const el of osm.elements || []) {
      const key = el.type + el.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const tags = el.tags || {};
      const name = (tags.name || '').trim();
      let rings = [];
      if (el.type === 'way' && el.geometry) rings = mergeWays([el.geometry.map(pt)]);
      else if (el.type === 'relation' && el.members) {
        rings = mergeWays(el.members
          .filter(m => m.type === 'way' && m.role !== 'inner' && m.geometry)
          .map(m => m.geometry.map(pt)));
      }
      if (tags.cemetery === 'sector' || GRUPPE_RE.test(name)) {
        const { label, codes } = gruppenLabel(name, tags.ref);
        if (!label || !codes.length) continue;
        const base = { kind: 'gruppe', label, codes, name: name || 'Gruppe ' + label, labeled: true };
        if (rings.length) {
          for (const r of rings) gruppen.push({ ...base, ring: r, center: ringCenter(r) });
        } else if (el.type === 'node') {
          gruppen.push({ ...base, ring: null, center: pt(el) });
        }
      } else if (name) {
        rings.forEach((r, i) => friedhoefe.push({ kind: 'friedhof', label: name, name, labeled: i === 0, ring: r, center: ringCenter(r), area: ringArea(r) }));
      }
    }
    // Größte umgebende Fläche = eigentlicher Friedhof (nicht Teilflächen darin)
    for (const g of gruppen) {
      let best = null;
      for (const f of friedhoefe) {
        if (inside(g.center, f.ring) && (!best || f.area > best.area)) best = f;
      }
      g.friedhof = best ? best.name : '';
    }
    friedhoefe.forEach(f => delete f.area);
    return friedhoefe.concat(gruppen);
  }

  async function fetchLocal() {
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    if (!Array.isArray(d.sectors) || !d.sectors.length) throw new Error('leer');
    return d.sectors;
  }

  async function fetchOverpass() {
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
        if (!parsed.length) throw new Error('keine Daten');
        return parsed;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('Overpass nicht erreichbar');
  }

  /* Daten laden (einmal pro Sitzung). statusCb bekommt Fortschrittstexte. */
  function load(statusCb) {
    if (sectors) return Promise.resolve(sectors);
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      try {
        sectors = await fetchLocal();
        return sectors;
      } catch { /* weiter mit Fallbacks */ }
      try {
        const c = JSON.parse(localStorage.getItem(CACHE_KEY));
        if (c && Array.isArray(c.sectors) && c.sectors.length) {
          sectors = c.sectors;
          return sectors;
        }
      } catch { /* Cache kaputt */ }
      if (statusCb) statusCb('Lade Friedhofsplan aus dem Internet (einmalig) …');
      try {
        sectors = await fetchOverpass();
        try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), sectors })); } catch { /* voll */ }
        return sectors;
      } catch (e) {
        loadPromise = null; // nächster Versuch darf neu starten
        throw e;
      }
    })();
    return loadPromise;
  }

  // ---------- Darstellung ----------

  function labelIcon(text, cls) {
    return L.divIcon({
      className: cls,
      html: '<div>' + String(text).replace(/[<>&]/g, '') + '</div>',
      iconSize: [0, 0],
    });
  }

  function tooltipText(s) {
    return s.kind === 'gruppe' && s.friedhof ? `${s.name} · ${s.friedhof}` : s.name;
  }

  function buildFor(map, secs) {
    if (attached.some(a => a.map === map)) return;
    const polyGroup = L.layerGroup();
    const labelGroup = L.layerGroup();     // Gruppen-Nummern
    const cemLabelGroup = L.layerGroup();  // Friedhofs-Namen
    const polys = [];

    for (const sector of secs) {
      const isFriedhof = sector.kind === 'friedhof';
      let poly = null;
      if (sector.ring) {
        poly = L.polygon(sector.ring, isFriedhof ? CEM_STYLE : POLY_STYLE)
          .bindTooltip(tooltipText(sector), { sticky: true });
        poly.addTo(polyGroup);
      }
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
        if (statusCb) statusCb('Friedhofsplan konnte nicht geladen werden – bitte Internetverbindung prüfen und die Seite neu laden.');
      });
  }

  // ---------- Suche ----------

  const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

  /* Gruppe suchen.
   *  opts.friedhof: Text, um den Friedhof einzugrenzen (z. B. „Hietzing“)
   *  opts.ref:      [lat, lon] – bevorzugt Treffer in der Nähe (Kartenmitte)
   * Ergebnis: {sector, others:[Friedhofsnamen mit gleicher Gruppe]} oder null */
  function findGruppe(query, opts = {}) {
    if (!sectors) return null;
    const nq = normalize(query);
    if (!nq) return null;
    const gruppen = sectors.filter(s => s.kind === 'gruppe');
    let hits = gruppen.filter(s => codesOf(s).includes(nq));
    const exact = hits.length > 0;
    // Kein exakter Treffer: „82“ findet auch „82A“, „82B“ … (nur Buchstaben-Zusatz)
    if (!exact) hits = gruppen.filter(s => codesOf(s).some(c => c.startsWith(nq) && /^[a-z]+$/.test(c.slice(nq.length))));
    if (!hits.length) return null;
    const byLabel = (a, b) => normalize(a.label).localeCompare(normalize(b.label), 'de', { numeric: true });
    hits.sort(byLabel);

    const hint = (opts.friedhof || '').trim().toLowerCase();
    if (hint) {
      const filtered = hits.filter(s => (s.friedhof || '').toLowerCase().includes(hint));
      if (filtered.length) hits = filtered;
    }

    let best = null;
    if (opts.ref) {
      // Treffer im Umkreis von ~2 km um die Kartenmitte bevorzugen
      const near = hits.filter(s => dist2(s.center, opts.ref) < 0.02 ** 2);
      if (near.length) best = near.sort((a, b) => dist2(a.center, opts.ref) - dist2(b.center, opts.ref))[0];
    }
    if (!best) best = hits.find(s => /zentralfriedhof/i.test(s.friedhof || '')) || hits[0];

    // Ungefährer Treffer: alphabetisch erste Variante auf diesem Friedhof nehmen
    if (!exact) best = hits.find(s => s.friedhof === best.friedhof) || best;

    const others = [...new Set(hits
      .filter(s => s.friedhof && s.friedhof !== best.friedhof)
      .map(s => s.friedhof))];
    // Alle Teilflächen derselben Gruppe auf demselben Friedhof
    const parts = hits.filter(s => s.label === best.label && s.friedhof === best.friedhof);
    // Bei ungefährem Treffer: alle Varianten auf diesem Friedhof (z. B. 82A, 82B)
    const variants = exact ? [] : [...new Set(hits.filter(s => s.friedhof === best.friedhof).map(s => s.label))];
    return { sector: best, parts, others, exact, variants };
  }

  /* Friedhof nach Namen suchen -> alle Teilflächen oder null.
   * Reihenfolge: exakter Name, Name beginnt so, Name enthält (größter zuerst). */
  function findFriedhof(text) {
    if (!sectors) return null;
    const q = String(text).trim().toLowerCase();
    if (q.length < 3) return null;
    const cems = sectors.filter(s => s.kind === 'friedhof');
    const lname = s => s.name.toLowerCase();
    const hit = cems.find(s => lname(s) === q) ||
      cems.find(s => lname(s).startsWith(q)) ||
      cems.filter(s => lname(s).includes(q))
        .sort((a, b) => (b.ring ? ringArea(b.ring) : 0) - (a.ring ? ringArea(a.ring) : 0))[0];
    return hit ? cems.filter(s => s.name === hit.name) : null;
  }

  /* Flächen auf einer Karte einrahmen und kurz hervorheben */
  function highlight(map, list) {
    const entry = attached.find(a => a.map === map);
    const pts = list.flatMap(s => s.ring || [s.center]);
    if (!pts.length) return;
    map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 18 });
    if (entry && !entry.visible) { entry.visible = true; entry.sync(); }
    for (const s of list) {
      const p = entry && entry.polys.find(x => x.sector === s);
      if (p && p.poly) {
        const restore = s.kind === 'friedhof' ? CEM_STYLE : POLY_STYLE;
        clearTimeout(p.hlTimer);  // Mehrfachsuche: alten Rücksetz-Timer verwerfen
        p.poly.setStyle(HILITE_STYLE);
        p.hlTimer = setTimeout(() => p.poly.setStyle(restore), 6000);
      } else {
        const c = L.circle(s.center, { radius: 30, ...HILITE_STYLE }).addTo(map);
        setTimeout(() => c.remove(), 5000);
      }
    }
  }

  function isLoaded() { return !!sectors; }

  // ---- Kompatibilität mit älterer app.js (falls der Browser beim Update
  //      kurzzeitig alte und neue Dateien mischt) ----

  /* alt: Gruppe/Friedhof suchen, hervorheben, Namen zurückgeben */
  function focus(map, query) {
    const g = findGruppe(query);
    if (g) { highlight(map, g.parts); return [g.sector.name, g.sector.friedhof].filter(Boolean).join(' · '); }
    const f = findFriedhof(query);
    if (f) { highlight(map, f); return f[0].name; }
    return null;
  }

  /* alt: Gruppe als Fläche mit Mitte zurückgeben */
  function findSector(query, ref) {
    const g = findGruppe(query, { ref });
    if (!g) return null;
    const s = g.sector;
    return { ...s, ring: s.ring || [s.center, s.center, s.center] };
  }

  return { attach, load, setVisible, isLoaded, findGruppe, findFriedhof, highlight, normalize, focus, findSector };
})();
