#!/usr/bin/env python3
"""Exportiert Friedhofsdaten für Wien aus OpenStreetMap (Overpass API) als
kompakte JSON-Dateien für die Grabfinder-App.

Aufruf: python3 tools/osm_export.py <zielordner>

Erzeugt:
  gruppen.json  – Friedhofs-Umrisse und Grab-Gruppen (mit zugehörigem Friedhof)
  promis.json   – einzeln erfasste (Prominenten-)Gräber mit Wikipedia-Link
  meta.json     – Zeitstempel und Anzahlen
  debug-zentral.json – Tag-Übersicht am Zentralfriedhof (zur Fehlersuche)
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

BBOX = '48.11,16.18,48.33,16.58'           # ganz Wien
ZF_BBOX = '48.137,16.416,48.163,16.463'    # Zentralfriedhof
ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
]
UA = 'Grabfinder/1.0 (+https://github.com/Harald081/grabfinder)'

GRUPPE_RE = re.compile(r'^\s*(?:gruppe|gr\.)\s*(.+?)\s*$', re.I)


def overpass(query):
    last = None
    for attempt in range(3):
        for ep in ENDPOINTS:
            try:
                body = urllib.parse.urlencode({'data': query}).encode()
                req = urllib.request.Request(ep, data=body, headers={'User-Agent': UA})
                with urllib.request.urlopen(req, timeout=240) as r:
                    data = json.load(r)
                print(f'  OK von {ep}: {len(data.get("elements", []))} Elemente')
                return data
            except Exception as e:  # noqa: BLE001 – nächsten Server probieren
                last = e
                print(f'  {ep}: {e}', file=sys.stderr)
        time.sleep(30)
    raise SystemExit(f'Overpass nicht erreichbar: {last}')


def pt(p):
    return (round(p['lat'], 6), round(p['lon'], 6))


def merge_ways(ways):
    """Fügt Way-Stücke (Listen von Punkten) zu geschlossenen Ringen zusammen."""
    segs = [list(w) for w in ways if len(w) >= 2]
    rings = []
    while segs:
        cur = segs.pop(0)
        changed = True
        while cur[0] != cur[-1] and changed:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == cur[-1]:
                    cur = cur + s[1:]
                elif s[-1] == cur[-1]:
                    cur = cur + s[-2::-1]
                elif s[-1] == cur[0]:
                    cur = s[:-1] + cur
                elif s[0] == cur[0]:
                    cur = s[:0:-1] + cur
                else:
                    continue
                segs.pop(i)
                changed = True
                break
        if len(cur) >= 4:
            rings.append(cur)
    return rings


def rings_of(el):
    if el['type'] == 'way' and el.get('geometry'):
        return merge_ways([[pt(p) for p in el['geometry']]])
    if el['type'] == 'relation':
        outer = [[pt(p) for p in m['geometry']] for m in el.get('members', [])
                 if m.get('type') == 'way' and m.get('role') != 'inner' and m.get('geometry')]
        return merge_ways(outer)
    return []


def area(ring):
    s = 0.0
    for (y1, x1), (y2, x2) in zip(ring, ring[1:] + ring[:1]):
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def centroid(ring):
    lats = [p[0] for p in ring]
    lons = [p[1] for p in ring]
    return [round((min(lats) + max(lats)) / 2, 5), round((min(lons) + max(lons)) / 2, 5)]


def inside(point, ring):
    y, x = point
    res = False
    n = len(ring)
    for i in range(n):
        y1, x1 = ring[i]
        y2, x2 = ring[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1:
            res = not res
    return res


def compact(ring):
    return [[round(a, 5), round(b, 5)] for a, b in ring]


def normalize(s):
    """„Gruppe 32 A“, „32a“, „032A“ -> „32a“ (muss zu normalize() in gruppen.js passen)"""
    s = re.sub(r'gruppe|gr\.', '', str(s).lower())
    s = re.sub(r'[\s.]+', '', s)
    return re.sub(r'^0+(?=\d)', '', s)


def gruppen_label(tags):
    """Liefert (Kurz-Label, Suchcodes) – z. B. „Gruppe 82, Tor 9“ -> („82“, [„82“]),
    „Gruppe 17/47 "MariaHilf"“ -> („17/47“, [„17“, „47“])."""
    name = (tags.get('name') or '').strip()
    m = GRUPPE_RE.match(name)
    raw = m.group(1) if m else (tags.get('ref') or name).strip()
    core = re.split(r'[,„“"(\[]', raw, maxsplit=1)[0].strip() or raw
    codes = [c for c in (normalize(p) for p in re.split(r'\s*(?:/|\+|&|\bund\b)\s*', core)) if c]
    return core, codes


def export_gruppen():
    # Wichtig: „out geom“ (nicht „out tags geom“) – sonst fehlen bei
    # Relationen (z. B. Zentralfriedhof) die Mitglieder samt Geometrie.
    q = (f'[out:json][timeout:200];('
         f'way["landuse"="cemetery"]["name"]({BBOX});'
         f'relation["landuse"="cemetery"]["name"]({BBOX});'
         f'way["amenity"="grave_yard"]["name"]({BBOX});'
         f'relation["amenity"="grave_yard"]["name"]({BBOX});'
         f'nwr["cemetery"="sector"]({BBOX});'
         f'nwr["name"~"^(Gruppe|Gr\\\\.) ",i]["highway"!~"."]["public_transport"!~"."]({BBOX});'
         f');out geom;')
    data = overpass(q)
    seen = set()
    friedhoefe, gruppen = [], []
    for el in data.get('elements', []):
        key = (el['type'], el['id'])
        if key in seen:
            continue
        seen.add(key)
        tags = el.get('tags', {})
        name = (tags.get('name') or '').strip()
        is_gruppe = tags.get('cemetery') == 'sector' or bool(GRUPPE_RE.match(name))
        if is_gruppe:
            label, codes = gruppen_label(tags)
            if not label or not codes:
                continue
            base = {'label': label, 'codes': codes, 'name': name or f'Gruppe {label}'}
            rs = rings_of(el)
            if rs:
                for r in rs:
                    gruppen.append({**base, 'ring': r, 'center': centroid(r)})
            elif el['type'] == 'node':
                gruppen.append({**base, 'ring': None,
                                'center': [round(el['lat'], 5), round(el['lon'], 5)]})
        elif name:
            for i, r in enumerate(rings_of(el)):
                friedhoefe.append({'name': name, 'ring': r, 'area': area(r), 'first': i == 0})

    # Jede Gruppe ihrem Friedhof zuordnen – der GRÖSSTEN umgebenden Fläche, damit
    # Teilflächen wie „Islamische Gruppen“ nicht den Zentralfriedhof verdrängen
    for g in gruppen:
        best = None
        for f in friedhoefe:
            if inside(tuple(g['center']), f['ring']) and (best is None or f['area'] > best['area']):
                best = f
        g['friedhof'] = best['name'] if best else ''

    sectors = []
    for f in friedhoefe:
        sectors.append({'kind': 'friedhof', 'label': f['name'], 'name': f['name'],
                        'labeled': f['first'], 'ring': compact(f['ring']),
                        'center': centroid(f['ring'])})
    for g in gruppen:
        sectors.append({'kind': 'gruppe', 'label': g['label'], 'codes': g['codes'],
                        'name': g['name'], 'friedhof': g['friedhof'], 'labeled': True,
                        'ring': compact(g['ring']) if g['ring'] else None,
                        'center': g['center']})
    return sectors


def wiki_url(tags):
    for k in ('wikipedia', 'subject:wikipedia', 'buried:wikipedia'):
        w = tags.get(k)
        if w and ':' in w:
            lang, title = w.split(':', 1)
            return f'https://{lang}.wikipedia.org/wiki/' + urllib.parse.quote(title.strip().replace(' ', '_'), safe='()_,:')
    for k in ('wikidata', 'subject:wikidata', 'buried:wikidata'):
        if tags.get(k):
            return 'https://www.wikidata.org/wiki/' + tags[k].split(';')[0].strip()
    return None


def export_promis(sectors):
    q = (f'[out:json][timeout:200];('
         f'nwr["historic"~"^(tomb|grave)$"]["name"]({BBOX});'
         f'nwr["cemetery"="grave"]["name"]({BBOX});'
         f'nwr["memorial"="grave"]["name"]({BBOX});'
         f');out tags center;')
    data = overpass(q)
    friedhoefe = [s for s in sectors if s['kind'] == 'friedhof']
    gruppen = [s for s in sectors if s['kind'] == 'gruppe' and s['ring']]
    seen, pois = set(), []
    for el in data.get('elements', []):
        tags = el.get('tags', {})
        name = (tags.get('name') or '').strip()
        lat = el.get('lat', (el.get('center') or {}).get('lat'))
        lon = el.get('lon', (el.get('center') or {}).get('lon'))
        if not name or lat is None:
            continue
        key = (name, round(lat, 4), round(lon, 4))
        if key in seen:
            continue
        seen.add(key)
        p = (lat, lon)
        cands = [f for f in friedhoefe if inside(p, [tuple(x) for x in f['ring']])]
        fh = max(cands, key=lambda f: area([tuple(x) for x in f['ring']]))['name'] if cands else ''
        gr = next((g['label'] for g in gruppen if inside(p, [tuple(x) for x in g['ring']])), '')
        pois.append({'name': name, 'lat': round(lat, 6), 'lon': round(lon, 6),
                     'wiki': wiki_url(tags), 'friedhof': fh, 'gruppe': gr})
    pois.sort(key=lambda x: x['name'])
    return pois


def export_debug():
    q = (f'[out:json][timeout:120];('
         f'way["name"]({ZF_BBOX});relation["name"]({ZF_BBOX});'
         f'way["ref"]({ZF_BBOX});way["cemetery"]({ZF_BBOX});node["cemetery"]({ZF_BBOX});'
         f');out tags;')
    data = overpass(q)
    return [{'t': e['type'][0], 'id': e['id'], 'tags': e.get('tags', {})} for e in data.get('elements', [])]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    out = args[0] if args else 'data'
    os.makedirs(out, exist_ok=True)
    ts = int(time.time() * 1000)

    print('Gruppen & Friedhöfe …')
    sectors = export_gruppen()
    n_g = sum(1 for s in sectors if s['kind'] == 'gruppe')
    n_f = sum(1 for s in sectors if s['kind'] == 'friedhof')
    print(f'  {n_f} Friedhofs-Flächen, {n_g} Gruppen')
    if n_f == 0:
        raise SystemExit('Keine Friedhöfe erhalten – Export abgebrochen, alte Daten bleiben.')
    with open(os.path.join(out, 'gruppen.json'), 'w', encoding='utf-8') as fh:
        json.dump({'ts': ts, 'sectors': sectors}, fh, ensure_ascii=False, separators=(',', ':'))

    print('Prominentengräber …')
    pois = export_promis(sectors)
    print(f'  {len(pois)} Gräber')
    with open(os.path.join(out, 'promis.json'), 'w', encoding='utf-8') as fh:
        json.dump({'ts': ts, 'pois': pois}, fh, ensure_ascii=False, separators=(',', ':'))

    if '--debug' in sys.argv:
      try:
        print('Debug-Übersicht Zentralfriedhof …')
        with open(os.path.join(out, 'debug-zentral.json'), 'w', encoding='utf-8') as fh:
            json.dump(export_debug(), fh, ensure_ascii=False, indent=0)
      except SystemExit as e:
        print(f'  übersprungen: {e}', file=sys.stderr)

    with open(os.path.join(out, 'meta.json'), 'w', encoding='utf-8') as fh:
        json.dump({'ts': ts, 'friedhoefe': n_f, 'gruppen': n_g, 'promis': len(pois)}, fh)
    print('Fertig.')


if __name__ == '__main__':
    main()
