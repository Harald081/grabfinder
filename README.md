# 🕯️ Grabfinder – Wiener Zentralfriedhof

Nie wieder ewig ein Grab suchen: Diese App speichert die genaue GPS-Position
eines Grabs und führt dich beim nächsten Besuch direkt hin.

## Was die App kann

- **Grab speichern:** Direkt vorm Grab stehen, „+ Grab speichern" tippen und die
  GPS-Position übernehmen (mit Genauigkeitsanzeige; der Marker lässt sich auf der
  Karte feinjustieren). Dazu Name, Gruppe/Reihe/Nummer, Notiz und ein Foto.
- **Navigation:** Live-Karte (OpenStreetMap) mit Distanzanzeige und
  Richtungspfeil (Kompass), der dich zum Grab führt. Als Fallback lässt sich das
  Ziel auch in Google Maps öffnen.
- **Friedhofsplan mit Gruppen:** Alle Grab-Gruppen des Zentralfriedhofs als
  Overlay auf der Karte (Umrisse + Nummern, Daten von OpenStreetMap, werden beim
  ersten Öffnen einmalig geladen und dann lokal gecacht). Mit Gruppen-Suche:
  „40" oder „12A" eingeben → die Karte springt hin. Einzelne Grabnummern gibt es
  in keiner offenen Datenquelle – dafür ist die offizielle
  [Grabsuche der Friedhöfe Wien](https://www.friedhoefewien.at/grabsuche) verlinkt
  (dort Name eingeben → Gruppe/Reihe/Nummer herausfinden → in der App suchen).
- **Offline-tauglich:** Als PWA installierbar („Zum Home-Bildschirm hinzufügen");
  App-Dateien und besuchte Kartenausschnitte werden gecacht.
- **Privat:** Alle Daten bleiben lokal am Gerät (localStorage). Über
  „Sicherung exportieren/importieren" kannst du sie als JSON-Datei sichern oder
  auf ein neues Handy übertragen.

## Nutzung am Handy

1. Die App-URL im Browser öffnen (siehe unten) und den Standortzugriff erlauben.
2. Beim Grab: „+ Grab speichern" → ein paar Sekunden warten, bis die
   GPS-Genauigkeit unter ±10 m liegt → Speichern.
3. Beim nächsten Besuch: Grab in der Liste antippen (➤) und dem Pfeil bzw. der
   Karte folgen. Auf dem iPhone einmal „Kompass aktivieren" antippen.

## Veröffentlichen (GitHub Pages)

Die App wird bei jedem Push auf `main` automatisch per GitHub Actions
veröffentlicht: **https://harald081.github.io/grabfinder/**

## Technik

Bewusst ohne Build-Tools: reines HTML/CSS/JavaScript, [Leaflet](https://leafletjs.com)
(lokal eingebettet, kein CDN nötig) für die Karte, OpenStreetMap-Kacheln,
Service Worker für Offline-Betrieb.
Die Dateien lassen sich auch auf jeden beliebigen HTTPS-Webspace legen –
mehr braucht es nicht.
