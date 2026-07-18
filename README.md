# 🕯️ Grabfinder – Friedhöfe Wien

Nie wieder ewig ein Grab suchen: Diese App speichert die genaue GPS-Position
eines Grabs und führt dich beim nächsten Besuch direkt hin. Funktioniert auf
allen Wiener Friedhöfen (Grab speichern und Navigation sogar überall).

## Was die App kann

- **Grab speichern:** Direkt vorm Grab stehen, „+ Grab speichern" tippen und die
  GPS-Position übernehmen (mit Genauigkeitsanzeige; der Marker lässt sich auf der
  Karte feinjustieren). Dazu Name, Gruppe/Reihe/Nummer, Notiz und ein Foto.
- **Navigation:** Live-Karte (OpenStreetMap) mit Distanzanzeige und
  Richtungspfeil (Kompass), der dich zum Grab führt. Als Fallback lässt sich das
  Ziel auch in Google Maps öffnen.
- **Friedhofsplan für ganz Wien:** Alle Wiener Friedhöfe mit Umrissen und Namen
  sowie alle in OpenStreetMap erfassten Grab-Gruppen (am Zentralfriedhof
  vollständig) als Overlay auf der Karte – einmalig geladen, dann lokal gecacht.
  Suche nach Gruppen („40", „12A") oder Friedhofs-Namen („Simmering").
  Einzelne Grabnummern gibt es in keiner offenen Datenquelle – dafür ist die
  offizielle [Grabsuche der Friedhöfe Wien](https://www.friedhoefewien.at/grabsuche)
  verlinkt (dort Name eingeben → Gruppe/Reihe/Nummer herausfinden → in der App suchen).
- **⭐ Prominentengräber:** Alle in OpenStreetMap einzeln erfassten Gräber
  (Beethoven, Falco & Co) als zuschaltbare Ebene – mit Namenssuche,
  Wikipedia-Link und „Hinführen"-Navigation.
- **Komfort:** Grabliste sortierbar (A–Z oder nach Entfernung), Grab-Position
  teilen (WhatsApp & Co), Suche auch nach Koordinaten.
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

GPS funktioniert im Browser nur über **HTTPS** – am einfachsten via GitHub Pages:

1. In den Repository-Einstellungen: **Settings → Pages → Source: „GitHub Actions"**.
2. Diesen Branch nach `main` mergen (oder den Workflow „Deploy Grabfinder"
   manuell starten).
3. Die App ist dann unter `https://<benutzername>.github.io/<repo>/` erreichbar.

## Technik

Bewusst ohne Build-Tools: reines HTML/CSS/JavaScript, [Leaflet](https://leafletjs.com)
(lokal eingebettet, kein CDN nötig) für die Karte, OpenStreetMap-Kacheln,
Service Worker für Offline-Betrieb.
Einfach den Ordner `friedhof-app/` auf einen beliebigen HTTPS-Webspace legen –
mehr braucht es nicht.
