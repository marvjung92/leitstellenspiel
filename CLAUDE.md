# CLAUDE.md — Leitstellenspiel Userscripts

Kontext für Claude Code in diesem Repo. Bitte vor der ersten Änderung komplett lesen.

## Projekt

Tampermonkey-Userscripts für **leitstellenspiel.de**. Repo: `marvjung92/leitstellenspiel`, Branch `main`.
Alle Skripte werden über `@updateURL`/`@downloadURL` von
`https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/<dateiname>`
automatisch auf mehreren Geräten aktualisiert.

Gespielt wird auf **zwei Geräten**: Mac (Safari) und Windows-PC. Beide Umgebungen müssen funktionieren.

Sprache: **Deutsch** — Antworten, Commit-Messages, UI-Texte, Log-Ausgaben und Kommentare im Code.

## Dateien

| Datei | Zweck |
|---|---|
| `lss-auto-dispatch-v4.user.js` | Hauptskript: automatisches Disponieren |
| `lss-top-verband.user.js` | Top-Verband-Farming |
| `lss-sommer-sammler.user.js` | Sammelobjekte (Sonnenblumen etc.) einsammeln |
| `lss-zellen-uebersicht.user.js` | Gebäude-Erweiterungen (Polizei/FW/THW) mit Bau-Buttons |
| `lss-einsatz-voraussetzungen.user.js` | Fehlende Voraussetzungen auf `/einsaetze` |
| `lss-tages-einnahmen.user.js` | Tageseinnahmen-Tracking |
| `lss-lf-einsatzbindung.user.js` | LF-Einsatzbindung |
| `lss-wachen-setup.user.js` | Wachen-Grundeinrichtung |
| `lss-status6.user.js` | FMS-Status-6-Fahrzeuge mit Ursachen-Klassifizierung |
| Lehrgangs-Bedarf | offene Lehrgangs-Anforderungen |

## Harte Regeln

1. **`@version` bei JEDER Änderung hochzählen.** Ohne höhere Version erkennt Tampermonkey kein Update — die Änderung kommt auf keinem Gerät an. Patch-Stelle für Fixes, Minor für neue Features.
2. **Immer die komplette Datei ausgeben/schreiben**, keine Diffs oder Ausschnitte-zum-Einbauen.
3. **Syntaxprüfung vor dem Abschluss:** `node --check <datei>` für jede geänderte Datei. Ein Syntaxfehler bedeutet im Spiel ein totes Skript ohne Fehlermeldung.
4. **Kein `git push` ohne Rückfrage.** Änderungen schreiben, Syntax prüfen, kurz zusammenfassen — Commit/Push nur auf ausdrückliche Aufforderung.

## localStorage — Safari-Quota-Problem

Safari lässt `setItem` **stillschweigend fehlschlagen**, wenn das Quota voll ist: kein Fehler, kein Throw, der Wert ist einfach nicht da. Das ist ein chronisches Problem in diesem Setup.

Deshalb gilt für jeden Schreibvorgang das **Verified-Write-Muster**:

```js
function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
    if (localStorage.getItem(key) === value) return true;   // verifizieren!
  } catch (e) { /* fällt durch zur Notfall-Bereinigung */ }
  emergencyCleanup();                                        // Puffer anderer Skripte kürzen
  try {
    localStorage.setItem(key, value);
    return localStorage.getItem(key) === value;
  } catch (e) { return false; }
}
```

- Nach dem Schreiben **immer zurücklesen und vergleichen** — nie annehmen, dass es geklappt hat.
- Bei Fehlschlag: Notfall-Bereinigung (Logs/Puffer der anderen LSS-Skripte kürzen), dann ein Wiederholungsversuch.
- Logs und Ringpuffer klein halten und begrenzen, nicht unbegrenzt anwachsen lassen.
- Skripte teilen sich localStorage-Keys — vorhandene Keys nicht umbenennen, sonst gehen Einstellungen anderer Skripte verloren.
- Nutzereinstellungen (Sperrliste, Innenstadt-ID, Zähler) liegen ausschließlich in localStorage und dürfen von einem Skript-Update nie überschrieben werden.

## UI-Konventionen

- **Catppuccin Mocha**, dunkel. Panel-Hintergrund `#1e1e2e`, Akzente aus der Catppuccin-Palette. Kein helles Design, keine Standard-Bootstrap-Optik.
- Gemeinsames Werkzeug-Menü **`window.lssToolsMenu`** (🛠️-Dropdown). Darin gebündelt: Sommer-Sammler, ohne-Personal, Lehrgangs-Bedarf, Status 6, Zellen-Übersicht. Neue Hilfsskripte hängen sich dort ein statt einen eigenen Button zu setzen — es sei denn, es gibt einen Grund dagegen.
- Seitenabhängige Sichtbarkeit: `LF-Einsatzbindung` und `Wachen-Setup` sind auf `/einsaetze` **unterdrückt**. `Einsatz-Voraussetzungen` erscheint **nur** auf `/einsaetze`, als fest positionierter Button.
- Fortschrittsanzeigen bei allem, was über mehrere Seiten/Requests läuft.

## Verifizierte Spiel-Fakten (nicht neu erraten)

Diese Werte sind durch HAR-Analyse und API-Inspektion bestätigt:

**IDs**
- `building_type`: `0` = Feuerwehr, `6` = Polizei, `9` = THW
- `vehicle_type`: `101` = Anh SwPu, `102` = Anh 7 — **beide** zählen als Schmutzwasserpumpe (im Requirement-Mapping und in `soloTrailerTypeIds`)

**API / DOM**
- `/api/vehicles`: `assigned_personnel_count` ist die verlässliche Quelle für Personalbesetzung (`null` oder `0` = kein Personal)
- Personalziel setzen: **kein** direkter POST. Action-URL `/buildings/<id>?personal_count_target_only=1` mit `_method=patch`
- Sommer-Sammler: Sammelobjekte erscheinen nur auf **offenen Einsatzseiten**, nicht in der Liste → Einsatzseiten im Hintergrund fetchen, dann `POST /missions/<id>/claim_found_object`. Jede Antwort außer 404/422 gilt als Erfolg
- Eigene Einsätze im Verbands-Kontext erkennt man an `class="panel panel-default mission_panel_red"`
- Einsatz-Voraussetzungen: der Klammer-Marker `(n)` ist verlässlich, die CSS-Klasse `fulfilled` **nicht**. Seiten mit `check_requirements=true` durchpaginieren
- Lehrgangs-Bedarf: über `alert-danger`-Blöcke parsen, Gebäudenamen über `/api/buildings` auflösen

## Auto-Dispatch: Kernlogik

- **Leitstellen-Prinzip:** Status 5 (Sprechwunsch) hat immer Vorrang. Alle Sprechwünsche werden abgearbeitet, bevor neu disponiert wird — ohne Limit, ohne Cooldown. Alterungsgarantie: nach 5 Minuten wird ein Sprechwunsch in jedem Fall bearbeitet.
- **Speed-Ladder:** bis 35 offene Einsätze 3-fache Geschwindigkeit, Pause bei 70 offenen, Wiederaufnahme bei 35.
- **Krankenhaus-Distanzkappe:** max. 50 km; wenn nichts Näheres frei ist, Fallback auf das nächste verfügbare.
- Einsätze, die wegen fehlender Fahrzeuge nicht disponiert werden können, mit Typ und Fehlmenge loggen — diese Engpass-Logs sind die Grundlage für Kaufentscheidungen.

## Arbeitsweise

- Ursache vor Symptom: bei einem Bug erst im Log/DOM belegen, was tatsächlich passiert, dann fixen. Keine Spekulationsfixes.
- Neue Spiel-Fakten (Typ-IDs, Endpunkte, DOM-Marker) nach der Verifikation hier in dieser Datei ergänzen.
- Antworten knapp halten, ohne Füllsätze.
