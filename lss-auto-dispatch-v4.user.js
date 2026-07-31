// ==UserScript==
// @name         LSS Auto-Dispatch (ELW + Fahrzeuge + Patiententransport)
// @namespace    marvin.lss.tools
// @version      5.60
// @downloadURL  https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-auto-dispatch-v4.user.js
// @updateURL    https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-auto-dispatch-v4.user.js
// @description  ELW-Erstalarmierung, fehlende Fahrzeuge nachalarmieren, Funk abarbeiten, Patiententransporte – Debug-Logging und Log-Export. Log-/Audit-Speicher mit Verified-Write (Safari-Quota-sicher), kürzt statt löscht, meldet Kürzungen sichtbar im Panel. Neu: 🔍 Speicher-Diagnose-Button, erkennt fehlende Pumpenleistung (Wassereinbruch/Pumpe-Einsätze).
// @match        https://www.leitstellenspiel.de/
// @match        https://www.leitstellenspiel.de/?*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ===================== Konfiguration =====================
    const CONFIG = {
        scanInterval: 8000,        // ms zwischen Scans
        alarmDelay: 1500,          // ms Basis-Pause zwischen Alarmierungen (+/- Jitter)
        transportDelay: 1200,      // ms Basis-Pause zwischen Transport-Abarbeitungen (+/- Jitter)
        cooldown: 90000,           // ms pro Einsatz, bevor erneut alarmiert wird
        retryEmptyCooldown: 300000, // ms Wartezeit, wenn beim letzten Versuch NICHTS verfügbar war (Flotte leer)
        ignoreRequirements: [],     // Anforderungen, die nie bedient werden sollen (z. B. ['Radlader (BRmG R)'])
        vehicleCooldown: 60000,    // ms pro Fahrzeug-Sprechwunsch
        elwTypeIds: [3, 34],       // ELW 1, ELW 2 für Erstalarmierung
        elwFallbacks: ['GW-Bergrettung', 'Seenotrettungsboot', 'RTW', 'KdoW', 'FuStW'],  // wenn kein ELW frei: diese Typen als Erstschlag (öffnet den Einsatz, echte Anforderungen erscheinen dann)
        maxPerScan: 30,            // max. Alarmierungen pro Durchlauf (bei voller Lage sonst werden hintere Einsätze nie erreicht)
        pauseThreshold: 0,         // ALT (0 = aus): Überlast-Pause übernimmt jetzt die Tempo-Treppe (speedPauseAbove/speedResumeAt in autoSpeed)
        prioritizeSpeakRequests: true, // LEITSTELLEN-PRINZIP: Status 5 (Sprechwunsch) hat Vorrang – erst
                                   //   Kräfte freigeben (Patient/Gefangener abmelden), dann neue Einsätze alarmieren.
                                   //   So kommen gebundene RTW/FuStW schneller in den Pool zurück.
        maxTransportsPerScan: 60,  // Sicherheitsnetz gegen Rate-Limits (nicht als Bremse gedacht). Bei aktivem
                                   //   prioritizeSpeakRequests werden Sprechwünsche darüber hinaus als überfällig behandelt.
        maxSpeakWaitMs: 300000,    // spätestens nach 5 min ist ein Sprechwunsch ohnehin "überfällig" -> am Limit/Cooldown vorbei
        maxPrisonerTransportsPerScan: 5, // max. Gefangenentransporte pro Durchlauf (eigener Topf, hat Vorrang)
        maxVehiclesPerAlarm: 40,   // Sicherheits-Notbremse pro POST (Großeinsätze brauchen mehr als 20)
        auditDispatch: true,       // [AUDIT]-Zeilen pro Alarm ins Log schreiben (Über-Alarmierungs-Analyse). Auswertung: window.adAudit() in der Konsole oder Button im Panel.
        soloTrailerTypeIds: [101, 102, 96, 70, 174, 44, 183, 43, 146, 136], // Anhänger-Typen, die ALLEINE gesendet werden (Spiel wählt Zugfahrzeug selbst): Anh SwPu=101, Anh 7=102, Außenlastbehälter=96, Boot/MZB=70, Anh TeSi=174, Anh Drucklufterzeugung=44, Anh Plattform (FGr BrB)=183, Radlader (BRmG R)=43, Anh FüLa=146, Anh Pferdetransport=136 (vom Nutzer bestätigt: Träger kommt automatisch mit).
        // Zugfahrzeug-Anforderung überspringen, wenn der zugehörige Anhänger im selben Einsatz
        // gefordert wird: der allein gesendete Anhänger bringt sein Zugfahrzeug automatisch mit
        // und deckt damit BEIDE Anforderungen. Format: { ZugfahrzeugTypId: AnhängerTypId }
        tractorCoveredByTrailer: { 181: 183, 42: 43, 145: 146, 171: 174, 173: 174 }, // MzGW (FGr BrB)=181 kommt automatisch mit Anh Plattform (FGr BrB)=183; LKW Kipper (LKW K 9)=42 kommt automatisch mit Radlader (BRmG R)=43; FüKomKW=145 kommt automatisch mit Anh FüLa=146; GW-TeSi=171 und MTW-TeSi=173 kommen automatisch mit Anh TeSi=174 (nicht separat senden!)
        trailerRetryCooldownMs: 5 * 60000, // Nach Server-Ablehnung ("Trägerfahrzeug nicht verfügbar") diesen Anhänger-Typ pro Einsatz erst nach Ablauf erneut versuchen – verhindert Alarm-Schleifen im Minutentakt
        // Krankenhauswahl:
        preferSpecialty: true,     // Fachabteilung bevorzugen (sonst Credit-Abzug)
        maxHospitalKm: 50,         // Deckel: RTW fährt max. so weit ins Krankenhaus. Nur wenn KEIN Haus
                                   //   mit freier (Fach-)Abteilung innerhalb dieser Grenze frei ist, wird
                                   //   weiter gefahren. Verhindert 300-km-Fernfahrten, die RTW lange binden.
        maxAllianceTax: 20,
        maxOnePerMission: ['LNA', 'OrgL'],     // diese Anforderungen pro Einsatz nur 1x bedienen
        ktVehicles: ['KTW', 'RTW'],            // Krankentransporte: diese Typen der Reihe nach versuchen
        swLeadTime: 15 * 60000,                // Sicherheitswachen erst alarmieren, wenn Beginn < 15 min entfernt
        handleYellow: true,                    // gelbe Einsätze mit fehlenden Fahrzeugen nachalarmieren (false = alte Regel)
        predictive: true,                      // neue Einsätze sofort mit der richtigen Flotte alarmieren (aus /einsaetze.json)
        predictiveChanceMin: 100,              // Wahrscheinlichkeits-Anforderungen erst ab diesem %-Wert vorab senden (100 = nur sichere)
        sentMemory: 10 * 60000,                // bereits gesendete Fahrzeuge je Anforderung so lange anrechnen (Anzeige sinkt erst bei ANKUNFT!)
        vehicleRealarmGuard: 8 * 60000,        // kürzlich alarmiertes Fahrzeug so lange NICHT an einen anderen Einsatz vergeben (verhindert Selbst-Umleitung/Fahrzeug-Klau zwischen eigenen Einsätzen)
        vehicleFailBlacklistAfter: 3,          // Fahrzeug nach so vielen NICHT bestätigten Alarmen IN FOLGE vorübergehend sperren
        vehicleFailBlacklistMs: 60 * 60000,    // Sperrdauer für Problemfahrzeuge (danach neuer Versuch)
        travelSlowSec: 600,                    // Anfahrten über dieser Dauer (Sekunden) gelten als "Langläufer" und werden einzeln geloggt (🐢)
        travelGoalSec: 1800,                   // ZIELMARKE: keine Anfahrt über 30 min. Verstöße werden mit Einsatzadresse in der Bau-Liste gesammelt (🚨)
        travelSpeedKmh: 72.5,                  // Ø-Tempo für die Fahrzeit-Schätzung aus Luftlinie (kalibriert: MTF Drohne 12,8 km ↔ 634 s)
        maxTravelSec: 0,                       // ETA-Deckel AUS (0 = deaktiviert). Hatte Einsätze blockiert – bei Bedarf wieder auf z.B. 2700 (=45 min) setzen. Fernfahrt-Schutz übernimmt serveVerbandMissions.
        serveVerbandMissions: false,           // false = "[Verband]"-Einsätze anderer Mitglieder nicht voll bedienen (das 1-LF-Mitverdienen macht das Top-Verband-Skript)
        serveTvFarmedMissions: false,          // false = Einsätze, die das Top-Verband-Skript angefahren hat (24h-Speicher tv_lf_sent), nicht voll bedienen – schließt die Beteiligt-Schleife für chat-geteilte Fern-Lagen (Beleg 19.07.: LF 181 min zum "Strohballenstapelbrand")
        useVerbandVehicles: false,             // false = freigegebene Fahrzeuge ANDERER Mitglieder (Wache "(VER)") nicht alarmieren – sonst fährt bei leerem eigenen Pool ein LF aus Düsseldorf 3 h zum eigenen Waldbrand (Befund 13.07.)
        cityOnly: false,                       // true = für EIGENE Einsätze NUR Fahrzeuge der Innenstadt-Leitstelle(n) verwenden (Gegenstück zur Verband-Regel). Zustand wird aus localStorage 'ad_city_only' geladen; Leitstellen-ID(s) über 🏙-Button.
        sentMemoryPersonnel: 60 * 60000,       // Personal/Betreuung: viel länger merken (Langläufer, kein vor-Ort-Abgleich möglich)
        waterRetry: 5 * 60000,                 // Wasser/Schaum: wenn die Menge nach so langer Zeit nicht gesunken ist, erneut schicken
        personnelRetry: 8 * 60000,             // Personal (z.B. Betreuungshelfer): wenn nach so langer Zeit nichts vor Ort ist, erneut schicken (gegen Geist-Einträge)
        crewPerVehicle: 6,                     // Personal-Anforderungen: so viele Kräfte pro Fahrzeug rechnen
        autostart: true,           // automatisch starten, wenn es beim letzten Mal lief (kein Klick nötig)
        autostartDelay: 5000,      // ms warten, bis Spielseite/Typlisten geladen sind, bevor automatisch gestartet wird
        autoReload: 25 * 60000,    // Seite alle X ms neu laden (0 = aus); räumt Speicher auf, läuft per Autostart weiter
        healthCheck: true,         // periodische Auffälligkeits-Prüfung ins Log (Hänger + Über-Alarmierung)
        alarmDiagnostics: true,    // Server-Antwort auf Alarme auswerten und ins Log schreiben (Fehlersuche)
        prisonerDiagnostics: true, // Gefangenentransport detailliert loggen (Sprechwunsch, Zellen, Klick-Ergebnis)
        helpAllianceChat: false,   // AUS: Verbandseinsätze werden jetzt vom separaten Top-Verband-Script übernommen (Doppel-Alarme vermeiden)
        healthCheckInterval: 60000,// wie oft der Health-Check läuft (ms)
        hangThreshold: 12 * 60000, // ab welcher Offen-Dauer ein Einsatz als "Hänger" gemeldet wird (ms)
        // Adaptive Spielgeschwindigkeit: Tempo-Treppe nach Anzahl eigener offener Einsätze (rot+gelb).
        // Bei Überschreiten von speedPauseAbove wird die Einsatzgenerierung pausiert (speed=6) und erst
        // wieder freigegeben, wenn die Last auf speedResumeAt oder weniger gesunken ist (tiefe Hysterese).
        autoSpeed: true,
        speedLadder: [                 // Stufen: bis upTo Einsätze -> speed-Parameter (siehe SPEED_LABEL)
            { upTo: 35, speed: 3 },    // 0-35  -> 3x   (Band weiter verlängert: volles Tempo bis 35 offene Einsätze)
            { upTo: 50, speed: 2 },    // 36-50 -> 2x
            { upTo: 62, speed: 1 },    // 51-62 -> 1x
            { upTo: 69, speed: 7 },    // 63-69 -> 0.5x
        ],                             // > 69 -> Pause (endet erst wieder bei <= speedResumeAt)
        speedPauseAbove: 70,           // > so viele Einsätze -> Pause (keine neuen Einsätze)
        speedResumeAt: 35,             // Pause erst beenden, wenn wieder <= so viele Einsätze offen sind (passt zum 3x-Band)
        speedMinHoldMs: 90000,         // Mindesthaltezeit zwischen zwei Stufenwechseln (Flatter-Schutz an Stufengrenzen)
        speedNormal: 1,                // /missionSpeed?speed=1  = 1x (Fallback, z.B. beim Aufheben der Pause im manuellen Modus)
        speedPause: 6,                 // /missionSpeed?speed=6  = Pause (es werden keine Einsätze generiert)
        logMaxLines: 12000,        // max. Zeilen im Logpuffer (Export/Datei) – deckt jetzt ganze Nächte
        verboseDebug: false,       // true = auch die hochfrequenten Routine-Debugzeilen loggen (Scan-Details je Einsatz)
        auditMaxLines: 20000,      // max. Datensätze im DAUERHAFTEN Audit-Speicher (überlebt Reloads, eigener localStorage-Schlüssel; eine Zeile pro Alarm-Welle)
    };
    // Anzeige-Label je speed-Parameter (aus dem Spiel-Dropdown)
    const SPEED_LABEL = { 3: '3x', 2: '2x', 1: '1x', 7: '0.5x', 0: '0.33x', 4: '0.20x', 8: '0.15x', 5: '0.10x', 6: 'Pause' };

    const VEHICLE_TYPES = {
        'LF 20': [0], 'LF 10': [1], 'DLK 23': [2], 'ELW 1': [3], 'RW': [4],
        'GW-A': [5], 'LF 8/6': [6], 'LF 20/16': [7], 'LF 10/6': [8],
        'GW-Öl': [9], 'GW-L2 Wasser': [10], 'GW-Messtechnik': [12],
        'SW 1000': [12], 'SW 2000': [13], 'SW 2000-Tr': [14], 'SW Kats': [15],
        'TLF 2000': [16], 'TLF 3000': [17], 'TLF 8/8': [18], 'TLF 8/18': [19],
        'TLF 16/24-Tr': [20], 'TLF 16/25': [21], 'TLF 16/45': [22],
        'TLF 20/40': [23], 'TLF 20/40-SL': [24], 'TLF 16': [25],
        'GW-Gefahrgut': [27], 'GW-Höhenrettung': [26], 'RTW': [28], 'NEF': [29],
        'HLF 20': [30], 'RTH': [31], 'FuStW': [32], 'GW-San': [33], 'ELW 2': [34],
        'leBefKw': [35], 'GruKw': [36], 'FüKw': [37], 'GefKw': [38],
        'Dekon-P': [39], 'AB-Dekon-P': [40], 'KdoW-LNA': [55], 'KdoW-OrgL': [56],
        'FwK': [43], 'KTW': [44], 'Gerätekraftwagen (GKW)': [45],
        'THW-Einsatzleitung (MTW-TZ)': [46], 'MzGW (FGr N)': [47],
    };

    const REQUIREMENT_ALIASES = {
        'Löschfahrzeug (LF)': [0, 1, 6, 7, 8, 30, 'HLF 10', 'LF 20 KatS', 'LF KatS'],
        'Löschfahrzeuge (LF)': [0, 30, 1, 6, 7, 8, 'HLF 10', 'LF 20 KatS', 'LF KatS'],
        'Löschfahrzeug oder Rüstwagen': [0, 30, 1, 6, 7, 8, 'HLF 10'], // = LF
        // "Uns fehlt: 1 Feuerlöschpumpe (z. B. LF)" – Klammerzusatz wird in lookup() gestrippt,
        // Plural ("Feuerlöschpumpen") über die pumpen->pumpe-Normalisierung abgedeckt.
        // Eng gemappt auf die LF-Familie (Spiel-Hinweis "z. B. LF"). Falls das Spiel auch TLFs
        // anrechnet, hier die TLF-IDs (16-25) ergänzen.
        'Feuerlöschpumpe': [0, 30, 1, 6, 7, 8, 'HLF 10', 'LF 20 KatS', 'LF KatS'],
        // "4x Flugfeldlöschfahrzeuge" (z.B. Flugzeug von Start-/Landebahn abgekommen):
        // Der Fahrzeugtyp heißt im Spiel "FLF" – Auflösung über die LSSM-Typliste.
        // Plural wird über die fahrzeuge->fahrzeug-Normalisierung abgedeckt.
        'Flugfeldlöschfahrzeug': ['FLF'],
        'Rüstwagen oder HLF': [4],                                     // = RW
        'Rüstwagen': [4],
        'Betreuungs- und Verpflegungsausstattung': [138], // GW-Verpflegung
        'GW-Verpflegung': [138],
        'GW-TeSi': [171],
        'GW TeSi': [171],
        'MTW-TeSi': [173],
        'MTW TeSi': [173],
        'Seenotrettungsboot': ['Seenotrettungsboot'],
        'Seenotrettungsboot oder Seenotrettungskreuzer': ['Seenotrettungsboot', 'Seenotrettungskreuzer'],
        'Seenotrettungskreuzer': ['Seenotrettungskreuzer'],
        'NEA50': [110, 111], // Anhänger-Varianten THW/FW
        'Drehleiter (DLK 23)': [2],
        'Polizeipferde': [ // "Beliebiger Pferdetransporter": ALLE Typen zählen (AAO police_horse_count)
            136, 134, // Anh Pferdetransport, Pferdetransporter klein (IDs aus Log verifiziert)
            'Pferdetransporter', 'Pferdetransporter groß' // großer Transporter – Name je nach LSSM-Caption
        ],
        'Wasserführendes Fahrzeug': [
            'LF 20',
            'HLF 20',
            'TLF 3000',
            'TLF 4000',
            'TLF 20/40',
            'TLF 20/40-SL',
            'TLF 16/25'
        ],
        'Drehleitern (DLK 23)': [2],
        'LNA': ['KdoW-LNA', 55],
        'OrgL': ['KdoW-OrgL', 56],
        'GW-Atemschutz': [5],
        'Schlauchwagen (GW-L2 Wasser oder SW)': ['GW-L2-Wasser', 'SW 1000', 'SW 2000', 'SW 2000-Tr', 'SW Kats'],
        'GW-L2 Wasser': ['GW-L2-Wasser'],
        'GW-L2-Wasser': ['GW-L2-Wasser'],
        'Sonderlöschmittel': [169],
        'AB-Sonderlöschmittel': [169],
        'Drehleiter (DLK)': [2],
        'Rettungswagen': [28],
        'Funkstreifenwagen': [32],
        'SEK-Fahrzeuge': ['SEK - ZF', 'SEK - MTF'],
        'SEK-Fahrzeug': ['SEK - ZF', 'SEK - MTF'],
        'Reiterstaffel': [136, 134, 'Pferdetransporter', 'Pferdetransporter groß'],
        'Seenotrettung': ['Seenotrettungsboot', 'Seenotrettungskreuzer'],
        'Wasserwerfer': [72],
        'Boot': [70],
        'Boote': [70],               // Mehrzahl (z.B. "3x Boote" bei Hochwasserlagen) – fehlte bisher
        'MZB': [70],                 // Mehrzweckboot
        'Mehrzweckboot': [70],
        'Betreuungshelfer': [130, 131],
        'GW-Bt': [130],
        'Bt-Kombi': [131],
        'SEK Fahrzeug': ['SEK - ZF'],
        'Hubschrauber mit Winde': ['RTH-Winde'],
        'Höhenrettung (Bergrettung)': ['GW-Höhenrettung (Bergrettung)'],
        'GW-Höhenrettung': ['GW-Höhenrettung', 26],
        'Rettungshubschrauber mit Winde': ['RTH-Winde'],
        'RTH mit Winde': ['RTH-Winde'],
        'Funkstreifenwagen (Dienstgruppenleitung)': ['FuStW (DGL)', 'Funkstreifenwagen (Dienstgruppenleitung)'],
        'Polizeimotorrad': ['Polizeimotorrad'],
        'Polizeimotorräder': ['Polizeimotorrad'],
        'Gerätekraftwagen (GKW)': ['GKW'],
        'THW-Einsatzleitung (MTW-TZ)': ['MTW-TZ'],
        'Lüfter': [114, 116],
        'GW-Lüfter': [114],
        'Bergrettung': ['GW-Bergrettung'],
        'Bahnrettungsfahrzeug': [162, 163],
        'Rettungshundestaffel': [91],
        'Rettungshundestaffeln': [91],   // Mehrzahl (z.B. "3x Rettungshundestaffeln") – fehlte bisher
        'Rettungshundefahrzeug': [91],
        'Schmutzwasserpumpen': [101, 102],  // Typ 101 = Anh SwPu, Typ 102 = Anh 7 – BEIDE tragen die
        'Schmutzwasserpumpe': [101, 102],   //   Schmutzwasserpumpe. Typ 102 fehlte bisher -> Engpass, obwohl
        'Anh SwPu': [101],                  //   Anh-7-Fahrzeuge frei waren (Beleg 29.07.: 3 Einsätze offen, Bestand 101:0).
        'Anh 7': [102],
        'MEK-Fahrzeug': [81],
        'MEK-Fahrzeuge': [81],
        'MEK': [81],
        'Anh FüLa': [146],
        'FüKomKW': [145],
        'Radlader (BRmG R)': ['BRmG R'],
        'BRmG R': ['BRmG R'],
        'Anhänger Drucklufterzeugung': ['Anh DLE'],
        'Anh DLE': ['Anh DLE'],
        'LKW Kipper (LKW K 9)': ['LKW K 9'],
        'LKW K 9': ['LKW K 9'],
        'Drohneneinheit': ['GW-UAS', 'ELW Drohne', 'MTW-UAS', 126, 127, 128], // 126 = MTF Drohne (vom Nutzer bestätigt, Checkbox trägt drone="1")
        'Drohneneinheiten': ['GW-UAS', 'ELW Drohne', 'MTW-UAS', 126, 127, 128], // Mehrzahl – fehlte (gleiches Muster wie Boote/Rettungshundestaffeln)
        // Personal-Anforderungen -> Fahrzeuge mit passender Besatzung
        'Feuerwehrmann': [0, 30, 1, 6, 7, 8],
        'Feuerwehrmänner': [0, 30, 1, 6, 7, 8],
        'Feuerwehrleute': [0, 30, 1, 6, 7, 8],
        'Polizist': [32],
        'Polizisten': [32],
        'Einsatzleiter 2': ['ELW 2'],
        'Verpflegungshelfer': ['GW-Verpflegung', 'GW-Küche'],
        'THW-Einsatzkräfte': ['GKW', 'MTW-TZ'],
        'Personen mit Dekon-P-Ausbildung': ['Dekon-P', 'AB-Dekon-P'],
        'Person mit Dekon-P-Ausbildung': ['Dekon-P', 'AB-Dekon-P'],
        'Dekon-P-Ausbildung': ['Dekon-P', 'AB-Dekon-P'],
        'Person mit GW-Gefahrgut-Ausbildung': [27],
        'Personen mit GW-Gefahrgut-Ausbildung': [27],
        'GW-Gefahrgut-Ausbildung': [27],
    };
    // Ersatzfahrzeuge, wenn die eigentliche Anforderung nicht (voll) bedient werden kann.
    // Reihenfolge = Priorität. Greift erst NACH dem Originaltyp.
    // Einträge: 'Name' oder { name: 'Name', max: n } (max = höchstens n Ersatzfahrzeuge)
    const REQUIREMENT_FALLBACKS = {
        'NEF': ['GW-Bergrettung (NEF)'],
    };
    // Anforderungen, bei denen unabhängig von der geforderten Personenzahl EIN Fahrzeug genügt
    // (die Ausbildung steckt in der Fahrzeugbesatzung). Wird auf max. 1 gedeckelt.
    const ONE_VEHICLE_COVERS = ['Dekon-P-Ausbildung', 'Personen mit Dekon-P-Ausbildung',
        'GW-Gefahrgut-Ausbildung', 'Person mit GW-Gefahrgut-Ausbildung', 'Personen mit GW-Gefahrgut-Ausbildung'];
    // Helfer pro Betreuungsfahrzeug (für die Mengen-Umrechnung von "Nx Betreuungshelfer")
    const CREW_PER_CARE_VEHICLE = 6;
    // ===== Sofort-Dispatch: Anforderungs-Schlüssel aus /einsaetze.json -> Fahrzeugtypen =====
    // Werte: Typ-IDs (Zahlen) oder Fahrzeugnamen (werden via LSSM aufgelöst).
    const REQ_KEY_TYPES = {
        // deutsche Schlüssel
        lf: [0, 30, 1, 6, 7, 8], hlf: [30], dlk: [2], elw: [3], elw2: [34], rw: [4],
        gwa: [5], gw_atemschutz: [5],
        gwl2wasser: ['GW-L2-Wasser', 'SW 1000', 'SW 2000', 'SW 2000-Tr', 'SW Kats'],
        gwoil: ['GW-Öl'], gw_oel: ['GW-Öl'], gwmess: ['GW-Messtechnik', 12], gwmesstechnik: ['GW-Messtechnik', 12],
        dekon_p: ['Dekon-P'], gwgefahrgut: [27], gw_gefahrgut: [27], hazmat_vehicles: [27], hazmat_dekon: ['Dekon-P'],
        gwhoehenrettung: ['GW-Höhenrettung', 26], fwk: ['FwK'], wasserwerfer: [72],
        rtw: [28], ktw: ['KTW'], nef: [29], rth: [31],
        kdow_lna: [55], kdow_orgl: [56], gwsan: ['GW-San'], gw_san: ['GW-San'],
        fustw: [32], fukw: [37], gefkw: [38], grukw: [36], lebefkw: [35],
        polizeihubschrauber: [61, 156], polizeimotorrad: ['Polizeimotorrad'],
        sek_zf: ['SEK - ZF'], sek_mtf: ['SEK - MTF'], k9: ['DHuFüKW'],
        gkw: ['GKW'], thw_mtw: ['MTW-TZ'], thw_mtwtz: ['MTW-TZ'], thw_gkw: ['GKW'],
        thw_mzkw: ['MzGW (FGr N)'], thw_lkw: ['LKW K 9'], thw_brmg_r: ['BRmG R'], thw_dle: ['Anh DLE'],
        drone: [126, 127, 128], seg_elw: ['ELW 1 (SEG)'], // 126 = MTF Drohne
        care_service: [130, 131], care_service_equipment: [130],
        seenotrettungsboot: ['Seenotrettungsboot'], seenotrettungskreuzer: ['Seenotrettungskreuzer'],
        mountain: ['GW-Bergrettung'], mountain_height_rescue: ['GW-Höhenrettung (Bergrettung)'],
        mountain_equipment: ['GW-Bergrettung'], mountain_atv: ['ATV', 152],
        // englische Schlüssel (aus /einsaetze.json, per Log bestätigt)
        firetrucks: [0, 30, 1, 6, 7, 8], platform_trucks: [2],
        battalion_chief_vehicles: [3], mobile_command_vehicles: [34],
        mobile_air_vehicles: [5], heavy_rescue_vehicles: [4],
        police_cars: [32], police_service_group_leader: [103],
        oneof_police_patrol_or_motorcycle: [32, 'Polizeimotorrad'],
        oneof_fire_engine_or_rescue: ['Löschfahrzeug oder Rüstwagen'],
        oneof_police_patrol_or_civil_patrol: [32, 98],
        police_helicopters: [61, 156], energy_supply: [110, 111],
        oneof_coastal_rescue_boat_or_boat_large: ['Seenotrettungsboot', 'Seenotrettungskreuzer'],
        // --- Vollständige Abdeckung aus einsaetze.json (3581 Einsätze, 86 Schlüssel) ---
        water_tankers: ['GTLF', 'TLF 3000', 'TLF 4000', 'TLF 16/25', 'TLF 20/40', 'TLF 20/40-SL'],
        height_rescue_units: ['GW-Höhenrettung', 26],
        heavy_rescue: [4], // schwere Rüstwagen-Komponente -> RW
        rescue_dog_units: [91, 'Rettungshundefahrzeug'],
        ventilation: [114, 116, 'GW-Lüfter', 'AB-Lüfter'],
        gw_werkfeuerwehr: ['GW-Werkfeuerwehr'],
        ulf: [84],
        teleskopmast: [85, 'TMF'],
        rettungstreppe: ['Rettungstreppe'],
        turboloescher: [86],
        boats: [70],
        diver_units: [63, 64],
        water_damage_pump: ['GW-Wasserschaden', 'GW-Pumpe', 'AB-Pumpe'],
        pump: ['GW-Wasserschaden', 'GW-Pumpe', 'AB-Pumpe'],
        lift: ['RTH-Winde'], // Windenrettung -> RTH mit Rettungswinde
        helicopter_bucket: ['Löschhubschrauber'],
        railway_fire: [162, 163],
        arff: [75, 'GFLF'],
        gefkw: [38],
        // Polizei
        police_motorcycle: ['Polizeimotorrad'],
        police_speaker: ['Lautsprecherkraftwagen', 'LautKW'],
        police_horse: [136, 134, 'Pferdetransporter', 'Pferdetransporter groß'], // beliebiger Pferdetransporter
        highway_police: [32, 'FuStW (Autobahnpolizei)'],
        civil_patrolcar: [98],
        mek: [81], sek: [79, 'SEK - MTF'],
        oneof_police_patrol_or_civil_patrol_or_motorcycle: [32, 98, 'Polizeimotorrad'],
        // THW Katastrophenschutz
        disaster_response_technology_equipment: ['GW-Bau', 'GKW'],
        disaster_response_technology_crew: ['GKW', 'MTW-TZ'],
        disaster_response_technology_trailer: ['Anh DLE', 'Anh Schäden'],
        thw_command: ['MTW-TZ'], thw_command_2: ['MTW-TZ'],
        thw_command_3: ['MTW-TZ'], thw_command_4: ['MTW-TZ'],
        thw_command_trailer: [146],
        thw_bridge_construction_equipment: ['GKW'],
        thw_bridge_construction_crane: ['FwK', 'GW-Kran'],
        thw_bridge_construction_trailer: ['Anh DLE'],
        energy_supply_2: [110, 111], // NEA50
        // Berg/Küste
        mountain_command: ['ELW Bergrettung', 'GW-Bergrettung'],
        mountain_snow: ['Schneefahrzeug', 'ATV'],
        coastal_helicopter: ['RTH', 'Polizeihubschrauber'],
        coastal_boat_large: ['Seenotrettungskreuzer'],
        oneof_fire_engine_or_rescue_or_oil_equipment: ['Löschfahrzeug oder Rüstwagen', 'GW-Öl'],
        gw_san: ['GW-San'], seg_elw: ['ELW 1 (SEG)'],
        ambulances: [28],
    };
    // Schlüssel, die KEINE Fahrzeuganzahl tragen (z. B. Liter) -> nie vorab senden
    const REQ_KEY_SKIP = new Set([
        'water_needed', 'foam_needed', 'min_pump_speed', // reine Mengen-/Schwellenwerte, keine Fahrzeuganzahl
        'personnel_educations' // verschachteltes Objekt -> wird separat über die Anzeige nachalarmiert
    ]);

    let missionTypes = null; // mission_type_id -> { requirements, chances, name }
    fetch('/einsaetze.json', { credentials: 'same-origin' })
        .then(r => r.json())
        .then(arr => {
            missionTypes = {};
            for (const t of arr) missionTypes[String(t.id)] = t;
            log(`Einsatztypen geladen (${arr.length}) – Sofort-Dispatch aktiv`, '#89b4fa');
        })
        .catch(() => log('einsaetze.json nicht ladbar – Sofort-Dispatch aus, nutze ELW-Erstalarm', '#f9e2af'));

    // Anforderungen eines Einsatztyps in unser reqs-Format übersetzen
    function predictRequirements(typeId, missionId) {
        const t = missionTypes && missionTypes[String(typeId)];
        if (!t || !t.requirements) return null;
        const chances = t.chances || {};
        const reqs = [];
        for (const [key, count] of Object.entries(t.requirements)) {
            if (!count || count <= 0) continue;
            if (REQ_KEY_SKIP.has(key)) { dbg(`[#${missionId}] Vorhersage: "${key}" (${count}) ist keine Fahrzeuganzahl – überlasse Nachalarm`); continue; }
            const chance = chances[key];
            if (chance != null && chance < CONFIG.predictiveChanceMin) {
                dbg(`[#${missionId}] Vorhersage: ${key} (${count}x) nur ${chance}% – überlasse Nachalarm`);
                continue;
            }
            const map = REQ_KEY_TYPES[key];
            if (!map) {
                // unbekannter Schlüssel: erst LSSM-Namensauflösung probieren, sonst nur loggen
                const ids = resolveTypeIds(key);
                if (ids && ids.length) { reqs.push({ count, caption: key, typeIds: ids, predicted: true }); }
                else dbg(`[#${missionId}] Vorhersage: unbekannter Anforderungsschlüssel "${key}" (${count}x) – bitte melden`);
                continue;
            }
            const ids = [...new Set(map.flatMap(e => typeof e === 'number' ? [e] : (resolveTypeIds(e) || [])))];
            if (ids.length) reqs.push({ count, caption: key, typeIds: ids, predicted: true });
        }
        return reqs.length ? reqs : null;
    }
    // ==========================================================

    const STATE_KEY = 'ad_mission_state';
    const state = new Map();          // missionId -> { lastAction, signature, lastEmpty, sent }
    const trailerRetryAfter = new Map(); // `${missionId}:${memKey}` -> Timestamp, ab dem dieser Anhänger-Typ nach Server-Ablehnung wieder versucht werden darf
    // Fahrzeug-Umleitungs-Schutz (Fix v5.22): kürzlich alarmierte Fahrzeuge dürfen für die Dauer von
    // vehicleRealarmGuard nicht an einen ANDEREN Einsatz vergeben werden. Das Spiel listet Fahrzeuge
    // auf Anfahrt (Status 3) auf anderen Einsatzseiten als anklickbar – ein erneuter Alarm leitet sie
    // um, der ursprüngliche Einsatz reißt wieder auf und es entsteht eine Nachalarmierungs-Kette.
    // Reload-fest über localStorage.
    const VGUARD_KEY = 'ad_vehicle_alarms';
    const vehicleAlarmed = new Map(); // vehicleId -> { ts, missionId }
    try {
        const saved = JSON.parse(localStorage.getItem(VGUARD_KEY) || '{}');
        const cutoff = Date.now() - 30 * 60000;
        for (const [vid, e] of Object.entries(saved)) if (e && (e.ts || 0) > cutoff) vehicleAlarmed.set(vid, e);
    } catch (e) { /* egal */ }
    function persistVehicleAlarms() {
        try {
            const cutoff = Date.now() - 30 * 60000;
            const obj = {};
            for (const [vid, e] of vehicleAlarmed) if (e.ts > cutoff) obj[vid] = e;
            localStorage.setItem(VGUARD_KEY, JSON.stringify(obj));
        } catch (e) { /* voll – egal */ }
    }

    // Fahrzeug-Verifikation (v5.26): Nach jedem Alarm bestätigt die Antwortseite, welche Fahrzeuge
    // wirklich losgefahren sind. Fahrzeuge, die wiederholt NICHT starten (Werkstatt, fehlendes
    // Personal, kaputte Zuordnung), werden hier gezählt und nach mehreren Fehlversuchen in Folge
    // vorübergehend gesperrt – inkl. Logmeldung, damit man sie im Spiel untersuchen kann.
    const VFAIL_KEY = 'ad_vehicle_fails';
    const vehicleFails = new Map(); // vehicleId -> { fails, lastTs, typeId, blockedUntil }
    try {
        const saved = JSON.parse(localStorage.getItem(VFAIL_KEY) || '{}');
        const cutoff = Date.now() - 24 * 3600000;
        for (const [vid, e] of Object.entries(saved)) if (e && (e.lastTs || 0) > cutoff) vehicleFails.set(vid, e);
    } catch (e) { /* egal */ }
    // Manuelle Fahrzeug-Sperrliste (v5.43): Fahrzeuge, die NIE automatisch alarmiert werden
    // sollen (z.B. personalstarke Fahrzeuge, deren Besatzung auf der Wache gebraucht wird).
    // Gemeinsamer Schlüssel 'lss_vehicle_blacklist' – wird auch vom Top-Verband-Skript beachtet.
    // Vom Top-Verband-Skript in den letzten 24 h angefahrene Einsätze (gemeinsamer Speicher).
    let tvFarmedIds = new Set();
    function loadTvFarmedIds() {
        try {
            const obj = JSON.parse(localStorage.getItem('tv_lf_sent') || '{}');
            const cutoff = Date.now() - 24 * 3600000;
            tvFarmedIds = new Set(Object.keys(obj).filter(id => obj[id] > cutoff));
        } catch (e) { tvFarmedIds = new Set(); }
    }
    loadTvFarmedIds();

    // Innenstadt-Leitstelle (v5.47): Bei cityOnly=true werden für EIGENE Einsätze NUR Fahrzeuge
    // der Innenstadt-Leitstelle verwendet (Gegenstück zur Verband-Regel). Konfiguration + Gebäude-
    // Cache teilen sich den Speicher mit dem Top-Verband-Skript, damit beide dieselbe Definition nutzen.
    const CITY_CFG_KEY = 'tv_city_dispatch';
    const CITY_BLD_KEY = 'tv_city_buildings';
    function cityConfig() {
        try {
            const c = JSON.parse(localStorage.getItem(CITY_CFG_KEY) || '{}');
            return { leitstellen: (c.leitstellen || []).map(String), names: (c.names || []).map(n => n.toLowerCase()) };
        } catch (e) { return { leitstellen: [], names: [] }; }
    }
    let cityBuildingIds = new Set();
    function loadCityBuildingCache() {
        try {
            const c = JSON.parse(localStorage.getItem(CITY_BLD_KEY) || 'null');
            if (c && c.ids && c.ids.length && Date.now() - c.ts < 24 * 3600000) cityBuildingIds = new Set(c.ids.map(String));
        } catch (e) { /* egal */ }
    }
    loadCityBuildingCache();
    async function refreshCityBuildings() {
        const cfg = cityConfig();
        if (!cfg.leitstellen.length) { cityBuildingIds = new Set(); return; }
        if (cityBuildingIds.size) return; // 24h-Cache reicht (vom TV-Skript oder von uns befüllt)
        const LEIT_FIELDS = ['leitstelle_building_id', 'leitstelle_id', 'dispatch_center_building_id', 'dispatch_center_id', 'building_leitstelle_id'];
        const leit = new Set(cfg.leitstellen);
        const set = new Set();
        const scan = (arr) => {
            for (const b of arr) {
                let lid = null;
                for (const f of LEIT_FIELDS) if (b[f] != null) { lid = String(b[f]); break; }
                if (leit.has(String(b.id)) || (lid && leit.has(lid))) set.add(String(b.id));
            }
        };
        try {
            const res = await fetch('/api/buildings', { credentials: 'same-origin', cache: 'no-store' });
            if (!res.ok) { dbg(`/api/buildings HTTP ${res.status}`); return; }
            const first = await res.json();
            if (Array.isArray(first)) {
                scan(first);
                const pageSize = first.length;
                if (pageSize >= 100) {
                    for (let offset = pageSize; offset < 20000; offset += pageSize) {
                        let page;
                        try {
                            const r = await fetch(`/api/buildings?limit=${pageSize}&offset=${offset}`, { credentials: 'same-origin', cache: 'no-store' });
                            if (!r.ok) break; page = await r.json();
                        } catch (e) { break; }
                        if (!Array.isArray(page) || !page.length) break;
                        scan(page);
                        if (page.length < pageSize) break;
                    }
                }
            } else if (first && Array.isArray(first.buildings)) { scan(first.buildings); }
            cityBuildingIds = set;
            try { localStorage.setItem(CITY_BLD_KEY, JSON.stringify({ ts: Date.now(), ids: [...set] })); } catch (e) { /* egal */ }
            dbg(`Innenstadt-Leitstelle ${cfg.leitstellen.join(', ')}: ${set.size} zugeordnete Gebäude erkannt`);
        } catch (e) { dbg(`/api/buildings nicht ladbar: ${e.message}`); }
    }
    // Gehört ein Fahrzeug (box) zur Innenstadt-Leitstelle?
    function isCityBox(b, cfg) {
        if (b.buildingId) {
            for (const part of String(b.buildingId).split(/[^0-9]+/)) {
                if (!part) continue;
                if (cityBuildingIds.has(part)) return true;
                if (cfg.leitstellen.includes(part)) return true;
            }
        }
        const name = (b.building || '').toLowerCase();
        if (name && cfg.names.some(n => n && name.includes(n))) return true;
        return false;
    }

    const MBL_KEY = 'lss_vehicle_blacklist';
    let manualBlacklist = new Set();
    let mblPersistFailed = false; // true = Speichern scheiterte -> RAM-Liste ist die Wahrheit, nicht der (leere) Speicher
    function loadManualBlacklist() {
        if (mblPersistFailed) return; // sonst würde die frisch eingetragene Liste vom leeren Speicher überschrieben
        try {
            const arr = JSON.parse(localStorage.getItem(MBL_KEY) || '[]');
            manualBlacklist = new Set((Array.isArray(arr) ? arr : []).map(String));
        } catch (e) { /* Lese-Fehler: RAM-Stand behalten */ }
    }
    loadManualBlacklist();
    function saveManualBlacklist(ids) {
        manualBlacklist = new Set(ids.map(String));
        const payload = JSON.stringify([...manualBlacklist]);
        const tryWrite = () => { localStorage.setItem(MBL_KEY, payload); return localStorage.getItem(MBL_KEY) === payload; };
        try {
            if (tryWrite()) { mblPersistFailed = false; return true; }
        } catch (e) { /* weiter zum Notfall-Aufräumen */ }
        // Quota voll? Erst den verzichtbaren Debug-Logpuffer kürzen (nicht komplett löschen) und erneut versuchen.
        if (shrinkLogBuffer()) { try { localStorage.setItem(LOG_KEY, JSON.stringify(logBuffer)); } catch (e) { /* egal */ } }
        try {
            if (tryWrite()) {
                mblPersistFailed = false;
                log('⚠️ Speicher war knapp – Log gekürzt, Sperrliste dann erfolgreich gespeichert (Log-Export der aktuellen Sitzung bleibt vollständig)', '#f9e2af');
                return true;
            }
        } catch (e) { /* egal */ }
        // Immer noch voll -> zusätzlich den kleineren Audit-Puffer kürzen.
        if (shrinkAuditBuffer()) { try { localStorage.setItem(AUDIT_KEY, JSON.stringify(auditBuffer)); } catch (e) { /* egal */ } }
        try {
            if (tryWrite()) {
                mblPersistFailed = false;
                log('⚠️ Speicher war knapp – Log/Audit gekürzt, Sperrliste dann erfolgreich gespeichert', '#f9e2af');
                return true;
            }
        } catch (e) { /* egal */ }
        mblPersistFailed = true;
        log('⚠️ Sperrliste konnte NICHT dauerhaft gespeichert werden (localStorage verweigert). Sie gilt für diese Sitzung – nach einem Reload bitte neu eintragen. Ursache meist: Speicher-Quota oder privater Modus.', '#f38ba8');
        return false;
    }

    function persistVehicleFails() {
        try {
            const cutoff = Date.now() - 24 * 3600000;
            const obj = {};
            for (const [vid, e] of vehicleFails) if (e.lastTs > cutoff) obj[vid] = e;
            localStorage.setItem(VFAIL_KEY, JSON.stringify(obj));
        } catch (e) { /* voll – egal */ }
    }

    // Fahrzeit-Telemetrie (v5.33): Für jede BESTÄTIGTE Alarmierung wird die Anfahrtszeit (aus dem
    // sortvalue/timevalue der Einsatzseite) je Fahrzeugtyp und je Wache gesammelt. Ziel: erkennen,
    // welche Typen regelmäßig zu weit fahren -> dort lohnt Zubau. Reload-fest in localStorage.
    const TRAVEL_KEY = 'ad_travel_stats';
    let travelStats = { since: Date.now(), types: {}, buildings: {} };
    try {
        const saved = JSON.parse(localStorage.getItem(TRAVEL_KEY) || 'null');
        if (saved && saved.types) travelStats = saved;
    } catch (e) { /* egal */ }
    function persistTravelStats() {
        try { localStorage.setItem(TRAVEL_KEY, JSON.stringify(travelStats)); } catch (e) { /* voll – egal */ }
    }

    // Einsatzdauer-Tracking (v5.38): Ersterfassung -> Verschwinden je Einsatz, aggregiert je Einsatztyp.
    // Zeigt, welche Einsatztypen überdurchschnittlich lange offen bleiben (Flotten-/Fahrzeit-Kosten).
    const MSTART_KEY = 'ad_mission_starts';
    const MDUR_KEY = 'ad_mission_durations';
    let missionStarts = {};   // missionId -> { ts, caption }
    let durationStats = { since: Date.now(), types: {} }; // caption -> { n, sum, max }
    try { missionStarts = JSON.parse(localStorage.getItem(MSTART_KEY) || '{}') || {}; } catch (e) { missionStarts = {}; }
    try {
        const saved = JSON.parse(localStorage.getItem(MDUR_KEY) || 'null');
        if (saved && saved.types) durationStats = saved;
    } catch (e) { /* egal */ }
    function persistDurations() {
        try {
            const cutoff = Date.now() - 48 * 3600000; // verwaiste Starteinträge nach 48 h verwerfen
            for (const id of Object.keys(missionStarts)) if ((missionStarts[id].ts || 0) < cutoff) delete missionStarts[id];
            localStorage.setItem(MSTART_KEY, JSON.stringify(missionStarts));
            localStorage.setItem(MDUR_KEY, JSON.stringify(durationStats));
        } catch (e) { /* voll – egal */ }
    }
    const fmtDur = (ms) => {
        const m = Math.round(ms / 60000);
        return m >= 90 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}min` : `${m} min`;
    };
    // Einsatzadresse aus der Einsatzliste lesen (steht im <small> unter dem Einsatznamen).
    function getMissionAddress(missionId) {
        try {
            const small = document.querySelector(`#mission_caption_${missionId} small`);
            if (small) return small.textContent.replace(/\s+/g, ' ').trim().replace(/,\s*$/, '');
        } catch (e) { /* egal */ }
        return null;
    }
    function recordTravel(b, mission) {
        if (!b || b.eta == null || !Number.isFinite(b.typeId)) return;
        const missionId = mission.id;
        const slow = b.eta > (CONFIG.travelSlowSec || 600);
        const overGoal = b.eta > (CONFIG.travelGoalSec || 1800);
        const t = travelStats.types[b.typeId] || (travelStats.types[b.typeId] = { n: 0, sum: 0, max: 0, slow: 0, overGoal: 0 });
        t.n++; t.sum += b.eta; t.max = Math.max(t.max, b.eta); if (slow) t.slow++; if (overGoal) t.overGoal = (t.overGoal || 0) + 1;
        if (b.building) {
            const w = travelStats.buildings[b.building] || (travelStats.buildings[b.building] = { n: 0, sum: 0, slow: 0 });
            w.n++; w.sum += b.eta; if (slow) w.slow++;
        }
        if (overGoal) {
            // ZIEL-Verstoß (>30 min): mit Einsatzname + Adresse in die persistente Bau-Liste.
            const addr = getMissionAddress(missionId);
            const entry = {
                ts: Date.now(), typeId: b.typeId, eta: Math.round(b.eta),
                building: b.building || null, missionId: String(missionId),
                name: (mission.caption || '?').slice(0, 60), addr: addr || null,
            };
            travelStats.worst = travelStats.worst || [];
            travelStats.worst.push(entry);
            if (travelStats.worst.length > 80) travelStats.worst = travelStats.worst.slice(-80); // Ringpuffer
            log(`🚨 [#${missionId}] ZIEL VERFEHLT (>30 min): ${vtName(b.typeId)} ${b.value} fährt ${fmtEta(b.eta)}${b.building ? ` von "${b.building}"` : ''} zu "${entry.name}"${addr ? ` – ${addr}` : ''} → hier fehlt ein näherer Standort für diesen Typ`, '#f38ba8');
        } else if (slow) {
            const addr = getMissionAddress(missionId);
            log(`🐢 [#${missionId}] ${vtName(b.typeId)} ${b.value}${b.building ? ` (${b.building})` : ''}: ${fmtEta(b.eta)} Anfahrt${addr ? ` nach ${addr}` : ''}`, '#f9e2af');
        }
    }
    const fmtEta = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')} min`;
    function travelReport() {
        const hours = Math.round((Date.now() - (travelStats.since || Date.now())) / 3600000 * 10) / 10;
        const lines = [`🚗 Fahrzeit-Report (seit ${hours} h):`];
        const types = Object.entries(travelStats.types)
            .filter(([, t]) => t.n >= 3)
            .map(([id, t]) => ({ id, avg: t.sum / t.n, ...t }))
            .sort((a, b) => b.avg - a.avg);
        if (!types.length) { lines.push('  noch zu wenig Daten (min. 3 Alarmierungen je Typ).'); }
        for (const t of types.slice(0, 15)) {
            lines.push(`  ${vtName(Number(t.id))}: ø ${fmtEta(t.avg)}, max ${fmtEta(t.max)}, ${t.n}×${t.slow ? `, davon ${t.slow}× >${Math.round((CONFIG.travelSlowSec || 600) / 60)} min (${Math.round(t.slow / t.n * 100)}%)` : ''}`);
        }
        const slowB = Object.entries(travelStats.buildings)
            .filter(([, w]) => w.slow >= 2)
            .sort((a, b) => b[1].slow - a[1].slow).slice(0, 8);
        if (slowB.length) {
            lines.push('  Wachen, deren Fahrzeuge am häufigsten weit fahren (Zubau-Kandidaten in deren Umgebung prüfen):');
            for (const [name, w] of slowB) lines.push(`    ${name}: ${w.slow}× Langläufer bei ${w.n} Alarmierungen (ø ${fmtEta(w.sum / w.n)})`);
        }
        const worst = (travelStats.worst || []).slice(-30).reverse();
        if (worst.length) {
            lines.push(`  🚨 Bau-Liste: Ziel-Verstöße >${Math.round((CONFIG.travelGoalSec || 1800) / 60)} min (neueste zuerst, max. 30):`);
            for (const e of worst) {
                const when = new Date(e.ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
                lines.push(`    ${when} – ${vtName(e.typeId)} ${fmtEta(e.eta)} → "${e.name}"${e.addr ? `, ${e.addr}` : ''}${e.building ? ` (kam von ${e.building})` : ''}`);
            }
            lines.push('    → Häufen sich Adressen in derselben Gegend, gehört dort eine Wache mit dem betreffenden Typ hin.');
        }
        // Einsatzdauern (v5.38): welche Einsatztypen bleiben am längsten offen?
        const durs = Object.entries(durationStats.types)
            .filter(([, d]) => d.n >= 3)
            .map(([cap, d]) => ({ cap, avg: d.sum / d.n, ...d }))
            .sort((a, b) => b.avg - a.avg).slice(0, 12);
        if (durs.length) {
            lines.push(`  ⏱ Einsatzdauern (Ersterfassung bis Abschluss, seit ${Math.round((Date.now() - (durationStats.since || Date.now())) / 3600000)} h, min. 3 Abschlüsse):`);
            for (const d of durs) lines.push(`    ${d.cap}: ø ${fmtDur(d.avg)}, max ${fmtDur(d.max)}, ${d.n}×`);
        }
        return lines;
    }
    // Reload-fest: State aus localStorage wiederherstellen (sonst vergisst die
    // Über-Alarmierungs-Bremse bei jedem Script-Update, was schon unterwegs ist)
    try {
        const saved = JSON.parse(localStorage.getItem(STATE_KEY) || '{}');
        const cutoff = Date.now() - 60 * 60000;
        for (const [id, st] of Object.entries(saved)) {
            if (st && (st.lastAction || 0) > cutoff) state.set(id, st);
        }
        if (state.size) console.log(`[Auto-Dispatch] ${state.size} Einsatz-Zustände wiederhergestellt`);
    } catch (e) { /* egal */ }
    function persistState() {
        try {
            const cutoff = Date.now() - 60 * 60000;
            const obj = {};
            for (const [id, st] of state) if (st.lastAction > cutoff) obj[id] = st;
            localStorage.setItem(STATE_KEY, JSON.stringify(obj));
        } catch (e) { /* voll – egal */ }
    }
    const vehicleState = new Map();   // vehicleId -> lastAction-Timestamp
    const dynTypes = {};
    let running = false;
    let timer = null;
    let rateLimitedUntil = 0;
    const PAUSE_KEY = 'ad_overload_paused';
    let overloadPaused = false;        // true, solange die Einsatzgenerierung wegen Überlast pausiert ist
    try { overloadPaused = localStorage.getItem(PAUSE_KEY) === '1'; } catch (e) { /* egal */ }
    if (overloadPaused) console.log('[Auto-Dispatch] Überlast-Pause aus voriger Sitzung wiederhergestellt (Freigabe erst bei niedriger Last)');
    function setOverloadPaused(v) {
        overloadPaused = v;
        try { localStorage.setItem(PAUSE_KEY, v ? '1' : '0'); } catch (e) { /* egal */ }
    }
    const swAnnounced = new Set(); // Sicherheitswachen, die schon im Log angekündigt wurden
    const releasedAnnounced = new Set(); // an Allianz freigegebene Einsätze, schon im Log vermerkt
    const alarmedThisScan = new Set();   // Fahrzeug-IDs, die in diesem Scan-Durchlauf schon alarmiert wurden
    // Statistik: erledigte Einsätze erkennen (ID war aktiv, ist nun aus der Liste verschwunden)
    const STATS_KEY = 'ad_stats';
    let stats = { completed: 0, sessionStart: Date.now() };
    try { const sv = JSON.parse(localStorage.getItem(STATS_KEY) || '{}'); stats.completed = sv.completed || 0; } catch (e) {}
    let speedMode = null;              // adaptive Geschwindigkeit: aktueller speed-Parameter der Tempo-Treppe (null = noch nicht gesetzt)
    let lastSpeedSwitch = 0;           // Zeitpunkt des letzten Stufenwechsels (Flatter-Schutz)
    let lastProblemVehiclesTxt = '';   // zuletzt geloggte Problemfahrzeug-Liste (Health-Check nur bei Änderung)
    let pendingSpeedTarget = null;     // vorgemerktes Tempo-Ziel (Bestätigungs-Prinzip gegen transiente Zählungen)
    let knownActive = new Set();       // zuletzt in der Seitenleiste gesehene eigene Einsätze
    const openSince = new Map();       // missionId -> Zeitpunkt, seit dem eine offene Anforderung besteht
    const stuckSince = new Map();      // missionId -> seit wann "nichts Passendes verfügbar" (echter Hänger)
    let lastHealthCheck = 0;
    function persistStats() { try { localStorage.setItem(STATS_KEY, JSON.stringify({ completed: stats.completed })); } catch (e) {} }
    function renderStats() { /* Erledigt-Anzeige entfernt – Zähler läuft intern weiter, wird aber nicht mehr angezeigt */ }

    // Vergleichsnormalisierung: NBSP/Bindestrich-Varianten und Mehrfach-Leerzeichen vereinheitlichen
    const norm = (s) => s.replace(/\u00a0/g, ' ').replace(/[-–]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // Menschlicher wirkende, unregelmäßige Pausen: Basiswert +/- 40 %
    const jitter = (ms) => Math.round(ms * (0.6 + Math.random() * 0.8));

    // ===================== Logging =====================
    // Puffer überlebt Reloads (localStorage). Export als Datei oder
    // fortlaufendes Schreiben in eine gewählte Datei (Chrome/Edge, File System Access API).
    const LOG_KEY = 'ad_log_buffer';
    const DEBUG_KEY = 'ad_debug';
    let logBuffer = [];
    try { logBuffer = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch (e) { logBuffer = []; }
    // Dauerhafter, SEPARATER Audit-Speicher: enthält NUR die [AUDIT]-Zeilen (eine pro Alarm-Welle).
    // Liegt unter eigenem localStorage-Schlüssel, wird daher NICHT von den vielen Debug-Zeilen
    // aus dem normalen Logpuffer verdrängt -> über Tage auswertbar ("schicke ich immer zu viele?").
    const AUDIT_KEY = 'ad_audit_buffer';
    let auditBuffer = [];
    try { auditBuffer = JSON.parse(localStorage.getItem(AUDIT_KEY) || '[]'); } catch (e) { auditBuffer = []; }
    let auditSaveTimer = null;
    let debugMode = localStorage.getItem(DEBUG_KEY) === '1';
    const CITYONLY_KEY = 'ad_city_only';
    function saveCityOnly(on) {
        const val = on ? '1' : '0';
        const tryWrite = () => { localStorage.setItem(CITYONLY_KEY, val); return localStorage.getItem(CITYONLY_KEY) === val; };
        try { if (tryWrite()) return true; } catch (e) { /* Quota? */ }
        // Speicher voll -> erst den verzichtbaren Debug-Logpuffer kürzen (nicht komplett löschen).
        if (shrinkLogBuffer()) {
            try { localStorage.setItem(LOG_KEY, JSON.stringify(logBuffer)); } catch (e) { /* egal */ }
            try { if (tryWrite()) { log('⚠️ Speicher war knapp – Log gekürzt, Nur-City-Zustand nun gespeichert', '#f9e2af'); return true; } } catch (e) {}
        }
        // Immer noch voll -> zusätzlich den kleineren Audit-Puffer kürzen.
        if (shrinkAuditBuffer()) {
            try { localStorage.setItem(AUDIT_KEY, JSON.stringify(auditBuffer)); } catch (e) { /* egal */ }
            try { if (tryWrite()) { log('⚠️ Speicher war knapp – Log/Audit gekürzt, Nur-City-Zustand nun gespeichert', '#f9e2af'); return true; } } catch (e) {}
        }
        log('⚠️ Nur-City-Zustand konnte NICHT gespeichert werden (localStorage verweigert) – nach Reload bitte neu setzen', '#f38ba8');
        return false;
    }
    try { CONFIG.cityOnly = localStorage.getItem(CITYONLY_KEY) === '1'; } catch (e) { /* egal */ }
    if (CONFIG.cityOnly) refreshCityBuildings();
    let fileHandle = null;     // FileSystemFileHandle (nur Chrome/Edge)
    let saveTimer = null;

    // Verified-Write-Muster (CLAUDE.md): Safari lässt setItem bei vollem Quota still fehlschlagen,
    // ohne Fehler/Throw. Deshalb nach jedem Schreiben zurücklesen und vergleichen – nie annehmen,
    // dass es geklappt hat. Bei Quota-Druck erst den verzichtbaren Debug-Logpuffer halbieren
    // (nicht komplett leeren, damit möglichst viel Historie überlebt), erst wenn das nicht reicht
    // auch den kleineren, aber für Kaufentscheidungen wertvolleren Audit-Puffer kürzen.
    function shrinkLogBuffer() {
        if (logBuffer.length < 20) return false;
        logBuffer = logBuffer.slice(-Math.max(200, Math.floor(logBuffer.length / 2)));
        return true;
    }
    function shrinkAuditBuffer() {
        if (auditBuffer.length < 20) return false;
        auditBuffer = auditBuffer.slice(-Math.max(200, Math.floor(auditBuffer.length / 2)));
        return true;
    }
    function verifiedSet(key, value) {
        try {
            localStorage.setItem(key, value);
            if (localStorage.getItem(key) === value) return true;
        } catch (e) { /* fällt durch zur Notfall-Bereinigung */ }
        return false;
    }

    function pushLog(line, lvl) {
        // Lokale Zeit statt UTC, damit Log-Zeitstempel zur Spielzeit/Anzeige passen
        const d = new Date();
        const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().replace('T', ' ').slice(0, 19);
        logBuffer.push(`${local} [${lvl}] ${line}`);
        if (logBuffer.length > CONFIG.logMaxLines) logBuffer.splice(0, logBuffer.length - CONFIG.logMaxLines);
        // [AUDIT]-Zeilen zusätzlich in den dauerhaften Audit-Speicher (eigener Schlüssel, lange Vorhaltung)
        if (lvl === 'AUDIT') {
            auditBuffer.push(`${local} [${lvl}] ${line}`);
            if (auditBuffer.length > CONFIG.auditMaxLines) auditBuffer.splice(0, auditBuffer.length - CONFIG.auditMaxLines);
            clearTimeout(auditSaveTimer);
            auditSaveTimer = setTimeout(persistAudit, 1500);
        }
        clearTimeout(saveTimer);
        saveTimer = setTimeout(persistLog, 1500);
    }

    // Zählt, wie oft Log/Audit wegen Speicherdrucks gekürzt werden mussten – sichtbar im Panel,
    // damit man nicht raten muss, ob/wie oft die Safari-Quota gerade zuschlägt.
    let shrinkStats = { log: 0, audit: 0 };

    function persistAudit() {
        if (verifiedSet(AUDIT_KEY, JSON.stringify(auditBuffer))) return;
        // Quota voll: erst den verzichtbaren Debug-Logpuffer opfern (Audit ist die Kaufentscheidungs-Basis)
        if (shrinkLogBuffer()) {
            shrinkStats.log++;
            log(`⚠️ Speicher knapp – Debug-Log gekürzt auf ${logBuffer.length} Zeilen, um Audit-Historie zu retten (bisher ${shrinkStats.log}× gekürzt)`, '#f9e2af');
            if (verifiedSet(LOG_KEY, JSON.stringify(logBuffer)) && verifiedSet(AUDIT_KEY, JSON.stringify(auditBuffer))) return;
        }
        // Immer noch voll: Audit-Puffer selbst halbieren statt ihn komplett zu verlieren.
        if (shrinkAuditBuffer()) {
            shrinkStats.audit++;
            log(`⚠️ Speicher weiterhin knapp – Audit-Historie gekürzt auf ${auditBuffer.length} Wellen (bisher ${shrinkStats.audit}× gekürzt)`, '#f38ba8');
            verifiedSet(AUDIT_KEY, JSON.stringify(auditBuffer));
        }
    }

    function persistLog() {
        if (!verifiedSet(LOG_KEY, JSON.stringify(logBuffer))) {
            // Quota voll: eigenen Puffer halbieren (meist reicht das) und erneut versuchen.
            if (shrinkLogBuffer()) {
                shrinkStats.log++;
                log(`⚠️ Speicher knapp – Debug-Log gekürzt auf ${logBuffer.length} Zeilen (Audit-Historie bleibt unberührt, bisher ${shrinkStats.log}× gekürzt)`, '#f9e2af');
                if (!verifiedSet(LOG_KEY, JSON.stringify(logBuffer))) {
                    // Immer noch voll: zusätzlich den kleineren Audit-Puffer kürzen.
                    if (shrinkAuditBuffer()) {
                        shrinkStats.audit++;
                        log(`⚠️ Speicher weiterhin knapp – zusätzlich Audit-Historie gekürzt auf ${auditBuffer.length} Wellen (bisher ${shrinkStats.audit}× gekürzt)`, '#f38ba8');
                        verifiedSet(AUDIT_KEY, JSON.stringify(auditBuffer));
                    }
                    verifiedSet(LOG_KEY, JSON.stringify(logBuffer));
                }
            }
        }
        flushToFile();
    }

    async function flushToFile() {
        if (!fileHandle) return;
        try {
            const w = await fileHandle.createWritable(); // überschreibt mit komplettem Puffer
            await w.write(logBuffer.join('\n') + '\n');
            await w.close();
        } catch (e) {
            fileHandle = null;
            log('Datei-Logging beendet (Berechtigung verloren?) – Export-Button nutzen', '#f9e2af');
        }
    }

    function exportLog() {
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
        const blob = new Blob([logBuffer.join('\n') + '\n'], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `lss-auto-dispatch_${stamp}.log`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        log(`💾 Log exportiert (${logBuffer.length} Zeilen)`, '#89b4fa');
    }

    // ---------- Über-Alarmierungs-Audit ----------
    // Lesbare Namen für die geläufigsten Fahrzeugtyp-IDs (für [AUDIT]-Zeilen + Auswertung).
    const VEHICLE_TYPE_NAMES = {
        0: 'LF', 1: 'LF', 6: 'LF', 7: 'LF', 8: 'LF', 30: 'LF',
        28: 'RTW', 29: 'NEF', 31: 'RTH', 3: 'ELW 1', 34: 'ELW 2',
        32: 'FuStW', 81: 'MEK', 70: 'Boot/MZB', 72: 'WaWe', 64: 'GW-Wasserrettung',
        101: 'Anh SwPu', 102: 'Anh 7', 96: 'Außenlastbehälter', 110: 'NEA50', 156: 'Polizeihubschrauber',
    };
    const dynTypeNames = {}; // ID -> Caption aus der LSSM-Typliste (füllt sich beim Laden)
    const vtName = id => VEHICLE_TYPE_NAMES[id] || dynTypeNames[id] || ('Typ ' + id);

    // Wertet die [AUDIT]-Zeilen im Logpuffer aus und beantwortet: Schicke ich zu viele Fahrzeuge?
    // Zeilenformat (siehe dispatch): [AUDIT] m#<id> "<Einsatz>" mode=<m> wave=<n> sent=<k> types=<...> reqs=<...>
    // Gibt eine Klartext-Auswertung zurück (Array von Zeilen) und schreibt sie ins Panel-Log.
    function adAudit(quiet) {
        // Volle Historie: dauerhafter Audit-Speicher + aktueller Logpuffer, dedupliziert.
        // (Beim Upgrade älterer Sitzungen liegen alte Zeilen evtl. nur im logBuffer.)
        const seen = new Set();
        const lines = [...auditBuffer, ...logBuffer].filter(l => {
            if (!l.includes('[AUDIT] m#')) return false;
            if (seen.has(l)) return false;
            seen.add(l); return true;
        });
        if (!lines.length) {
            const msg = 'Noch keine [AUDIT]-Daten vorhanden. Lass das Script laufen – pro Alarm entsteht eine Zeile.';
            if (!quiet) log(`📊 ${msg}`, '#f9e2af');
            return [msg];
        }
        let totalEvents = 0, totalVehicles = 0, redundant = 0, openerVehicles = 0, openerEvents = 0;
        const waveBuckets = { '1': 0, '2': 0, '3': 0, '4+': 0 };
        const byMission = {}; // name -> { events, vehicles, waves, multiWave }
        const byType = {};    // typeName -> Anzahl
        const seenMission = {}; // name -> Set der schon gezählten Wellen-1-Events (für events)

        for (const l of lines) {
            const mName = (l.match(/m#\d+\s+"([^"]*)"/) || [])[1] || '?';
            const mode = (l.match(/mode=(\S+)/) || [])[1] || '?';
            const wave = parseInt((l.match(/wave=(\d+)/) || [])[1] || '1', 10);
            const sent = parseInt((l.match(/sent=(\d+)/) || [])[1] || '0', 10);
            const typesRaw = (l.match(/types=([^\s]+)/) || [])[1] || '';
            totalEvents++;
            totalVehicles += sent;
            // Wellen-Verteilung
            if (wave >= 4) waveBuckets['4+']++; else waveBuckets[String(wave)]++;
            // Türöffner (ELW/KT-Modus = blind ohne Requirements gesendet)
            if (mode === 'elw' || mode === 'kt') { openerVehicles += sent; openerEvents++; }
            // Pro Einsatztyp
            const m = byMission[mName] || (byMission[mName] = { events: 0, vehicles: 0, maxWave: 0, multiWave: 0 });
            m.events++; m.vehicles += sent; m.maxWave = Math.max(m.maxWave, wave);
            if (wave >= 2) m.multiWave++;
            // Fahrzeugtypen
            for (const part of typesRaw.split(',')) {
                const mm = part.match(/^(.+?):(\d+)$/);
                if (mm) byType[mm[1]] = (byType[mm[1]] || 0) + parseInt(mm[2], 10);
            }
            // Redundanz: reqs-Abschnitt nach "da>=Bedarf, aber neu>0" durchsuchen
            const reqsRaw = (l.match(/reqs=\[(.*)\]/) || [])[1] || '';
            for (const seg of reqsRaw.split(' | ')) {
                const r = seg.match(/Bedarf(\d+) da(\d+) neu(\d+)/);
                if (r) { const need = +r[1], da = +r[2], neu = +r[3]; if (neu > 0 && da >= need && need > 0) redundant += neu; }
            }
        }

        const out = [];
        // Zeitspanne aus den Zeitstempeln am Zeilenanfang bestimmen (Strings vergleichen sich chronologisch)
        let tsMin = null, tsMax = null;
        for (const l of lines) {
            const ts = (l.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/) || [])[1];
            if (!ts) continue;
            if (tsMin === null || ts < tsMin) tsMin = ts;
            if (tsMax === null || ts > tsMax) tsMax = ts;
        }
        out.push(`📊 Über-Alarmierungs-Audit (${lines.length} Alarm-Wellen erfasst)`);
        if (tsMin && tsMax) out.push(`   Zeitraum: ${tsMin}  bis  ${tsMax}`);
        out.push(`   Fahrzeuge gesamt gesendet: ${totalVehicles}  |  ø ${(totalVehicles / totalEvents).toFixed(1)} pro Welle`);
        out.push(`   Wellen pro Einsatz-Welle: 1×=${waveBuckets['1']}  2×=${waveBuckets['2']}  3×=${waveBuckets['3']}  4+×=${waveBuckets['4+']}`);
        const multiTotal = waveBuckets['2'] + waveBuckets['3'] + waveBuckets['4+'];
        out.push(`   Folge-Wellen (Nachschieben, Welle ≥2): ${multiTotal} (${((multiTotal / totalEvents) * 100).toFixed(0)}% aller Wellen)`);
        out.push(`   Türöffner blind gesendet (ELW/KT-Modus): ${openerVehicles} Fahrzeuge in ${openerEvents} Einsätzen`);
        const redPct = totalVehicles ? (redundant / totalVehicles * 100) : 0;
        out.push(`   Redundant (geschickt, obwohl Bedarf schon gedeckt war): ${redundant} Fahrzeuge (${redPct.toFixed(1)}% aller gesendeten)`);
        // Klartext-Urteil zur Ausgangsfrage "Schicke ich zu viele?"
        let verdict;
        if (redPct < 3) verdict = `   ➤ Urteil: Alarmierung ist effizient – kaum überflüssige Fahrzeuge (${redPct.toFixed(1)}%).`;
        else if (redPct < 10) verdict = `   ➤ Urteil: leichte Über-Alarmierung (${redPct.toFixed(1)}%) – im vertretbaren Rahmen.`;
        else verdict = `   ➤ Urteil: deutliche Über-Alarmierung (${redPct.toFixed(1)}%) – hier lohnt sich Optimierung (knappe RTW/MEK/FuStW werden unnötig gebunden).`;
        out.push(verdict);
        // Top-Einsätze nach Nachschiebe-Quote
        const topMulti = Object.entries(byMission)
            .filter(([, m]) => m.multiWave > 0)
            .sort((a, b) => b[1].multiWave - a[1].multiWave)
            .slice(0, 8);
        if (topMulti.length) {
            out.push(`   ── Einsätze mit den meisten Folge-Wellen (hier wird am ehesten zu viel geschickt):`);
            for (const [name, m] of topMulti) out.push(`      ${name}: ${m.multiWave} Folge-Wellen, max Welle ${m.maxWave}, ø ${(m.vehicles / m.events).toFixed(1)} Fzg/Welle`);
        }
        // Fahrzeugtypen-Verteilung
        const topTypes = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 10);
        if (topTypes.length) out.push(`   ── Gesendete Fahrzeugtypen: ${topTypes.map(([k, n]) => `${k}×${n}`).join(', ')}`);

        if (!quiet) { for (const l of out) log(l, '#89dceb'); console.log('%c' + out.join('\n'), 'color:#89dceb'); }
        return out;
    }
    // In der Konsole aufrufbar machen
    try { window.adAudit = adAudit; } catch (e) { /* egal */ }

    // Lesbare Audit-Zusammenfassung als .txt-Datei speichern (volle Historie aus dem Audit-Speicher).
    function exportAudit() {
        const summary = adAudit(true); // Array von Zeilen, ohne ins Panel zu schreiben
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
        const header = [
            'LSS Auto-Dispatch – Über-Alarmierungs-Audit',
            'Erstellt am: ' + new Date().toLocaleString('de-DE'),
            'Frage: Schicke ich zu viele Einsatzfahrzeuge?',
            '',
            'Lesehilfe:',
            '  • "Redundant" = Fahrzeuge, die rausgingen, obwohl der Bedarf schon gedeckt war.',
            '    Das ist der direkte Indikator für Über-Alarmierung.',
            '  • "Folge-Wellen" = Nachschieben nach Welle 1. Viele Folge-Wellen bei einem',
            '    Einsatztyp deuten darauf hin, dass dort zu früh/zu viel geschickt wird.',
            '  • "Türöffner" = bewusst blind gesendete ELW/KT (zählen nicht als Fehler).',
            '='.repeat(64),
            ''
        ];
        const body = header.concat(summary).join('\n') + '\n';
        const blob = new Blob([body], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `lss-audit_${stamp}.txt`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        log('📊 Audit-Zusammenfassung als Datei gespeichert', '#89b4fa');
    }
    // Audit-Speicher in der Konsole zurücksetzen: window.adAuditReset()
    try {
        window.adAuditReset = () => {
            auditBuffer = [];
            try { localStorage.removeItem(AUDIT_KEY); } catch (e) { /* egal */ }
            log('📊 Audit-Speicher geleert', '#f9e2af');
        };
    } catch (e) { /* egal */ }

    async function chooseLogFile() {
        if (!window.showSaveFilePicker) {
            alert('Dieser Browser unterstützt die File System Access API nicht (Safari/Firefox).\nBitte den 💾 Export-Button nutzen – die Datei landet dann im Downloads-Ordner.');
            return;
        }
        try {
            fileHandle = await window.showSaveFilePicker({
                suggestedName: 'lss-auto-dispatch.log',
                types: [{ description: 'Logdatei', accept: { 'text/plain': ['.log', '.txt'] } }],
            });
            log(`📁 Datei-Logging aktiv: ${fileHandle.name}`, '#89b4fa');
            flushToFile();
        } catch (e) { /* Abbruch im Dialog */ }
    }

    // ---------- UI ----------
    const panel = document.createElement('div');
    panel.style.cssText = `
        position:fixed; bottom:12px; right:12px; z-index:99999;
        background:#1e1e2e; color:#cdd6f4; font:12px/1.5 monospace;
        border:1px solid #45475a; border-radius:8px; padding:10px 12px;
        width:330px; box-shadow:0 4px 14px rgba(0,0,0,.4);
    `;
    panel.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:6px;">
            <b style="white-space:nowrap;">🚨 Auto-Dispatch v5.56</b>
            <span style="display:flex;gap:4px;">
                <button id="ad-toggle" style="cursor:pointer;border:none;border-radius:4px;padding:2px 10px;background:#a6e3a1;color:#1e1e2e;font-weight:bold;">Start</button>
                <button id="ad-minimize" title="Panel minimieren/maximieren" style="cursor:pointer;border:1px solid #45475a;border-radius:4px;padding:2px 8px;background:#313244;color:#cdd6f4;font-weight:bold;">–</button>
            </span>
        </div>
        <div id="ad-body">
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;">
            <button id="ad-debug" title="Debug-Logging an/aus (alle Entscheidungen protokollieren)" style="cursor:pointer;border:1px solid #45475a;border-radius:4px;padding:1px 7px;background:#313244;color:#cdd6f4;">Debug</button>
            <button id="ad-export" title="Log als Datei herunterladen (Downloads-Ordner)" style="cursor:pointer;border:1px solid #45475a;border-radius:4px;padding:1px 7px;background:#313244;color:#cdd6f4;">💾 Export</button>
            <button id="ad-audit" title="Über-Alarmierung auswerten: schicke ich zu viele Fahrzeuge? (wertet die [AUDIT]-Zeilen aus)" style="cursor:pointer;border:1px solid #45475a;border-radius:4px;padding:1px 7px;background:#313244;color:#cdd6f4;">📊 Audit</button>
            <button id="ad-audit-file" title="Audit-Zusammenfassung als lesbare .txt-Datei speichern (volle Historie, überlebt Reloads)" style="cursor:pointer;border:1px solid #45475a;border-radius:4px;padding:1px 7px;background:#313244;color:#cdd6f4;">📊 Audit-Datei</button>
            <button id="ad-audit-clear" title="Audit-Speicher leeren (alle [AUDIT]-Zeilen verwerfen – z.B. für eine frische Vorher/Nachher-Messung)" style="cursor:pointer;border:1px solid #45475a;border-radius:4px;padding:1px 7px;background:#313244;color:#cdd6f4;">📊🗑</button>
            <button id="ad-travel" title="Fahrzeit-Report: ø/max Anfahrt je Fahrzeugtyp und auffällige Wachen (Shift+Klick = Statistik zurücksetzen)" style="cursor:pointer;border:1px solid #45475a;border-radius:4px;padding:1px 7px;background:#313244;color:#cdd6f4;">🚗 Fahrzeiten</button>
            <button id="ad-mbl" title="Manuelle Fahrzeug-Sperrliste: diese Fahrzeug-IDs werden von Auto-Dispatch UND Top-Verband nie alarmiert (z.B. personalstarke Fahrzeuge für die Wache)" style="cursor:pointer;border:1px solid #45475a;border-radius:4px;padding:1px 7px;background:#313244;color:#cdd6f4;">🚫 Sperrliste</button>
            <button id="ad-city" title="Nur-Innenstadt-Modus: eigene Einsätze werden NUR mit Fahrzeugen der Innenstadt-Leitstelle bedient. Klick = an/aus, Shift+Klick = Leitstellen-ID(s) eintragen." style="cursor:pointer;border:1px solid #45475a;border-radius:4px;padding:1px 7px;background:#313244;color:#cdd6f4;">🏙 Nur City</button>
            <button id="ad-file" title="Logdatei wählen, in die fortlaufend geschrieben wird (nur Chrome/Edge)" style="cursor:pointer;border:1px solid #45475a;border-radius:4px;padding:1px 7px;background:#313244;color:#cdd6f4;">📁 Datei</button>
            <button id="ad-clear" title="Logpuffer leeren" style="cursor:pointer;border:1px solid #45475a;border-radius:4px;padding:1px 7px;background:#313244;color:#cdd6f4;">🗑</button>
            <button id="ad-reset" title="Gedächtnis zurücksetzen (Über-Alarmierungs-Bremse, Cooldowns, gesendete Fahrzeuge)" style="cursor:pointer;border:1px solid #45475a;border-radius:4px;padding:1px 7px;background:#313244;color:#cdd6f4;">🧠 Reset</button>
            <button id="ad-storage" title="Speicher-Diagnose: alle localStorage-Schlüssel dieser Domain mit Größe (findet, was die Quota auffrisst)" style="cursor:pointer;border:1px solid #45475a;border-radius:4px;padding:1px 7px;background:#313244;color:#cdd6f4;">🔍 Speicher</button>
        </div>
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;color:#cdd6f4;">
            <span title="Steuert die Spielgeschwindigkeit. Automatisch = Skript drosselt bei vielen Einsätzen; Manuell = Spiel-Einstellung bleibt unangetastet.">⏱ Tempo:</span>
            <select id="ad-speedmode" style="cursor:pointer;border:1px solid #45475a;border-radius:4px;padding:1px 6px;background:#313244;color:#cdd6f4;">
                <option value="auto">Automatisch (Skript)</option>
                <option value="manual">Manuell (Spiel)</option>
            </select>
        </div>
        <div id="ad-status" style="color:#f9e2af;">gestoppt</div>
        <div id="ad-log" style="margin-top:6px;max-height:180px;overflow-y:auto;border-top:1px solid #45475a;padding-top:4px;"></div>
        </div>
    `;
    document.body.appendChild(panel);
    const $status = panel.querySelector('#ad-status');
    const $log = panel.querySelector('#ad-log');
    const $toggle = panel.querySelector('#ad-toggle');
    const $debug = panel.querySelector('#ad-debug');
    const $body = panel.querySelector('#ad-body');
    const $minimize = panel.querySelector('#ad-minimize');
    // Geschwindigkeits-Modus: 'auto' (Skript drosselt) oder 'manual' (Spiel-Einstellung bleibt)
    const SPEEDMODE_KEY = 'ad_speedmode';
    const $speedMode = panel.querySelector('#ad-speedmode');
    const savedSpeedMode = localStorage.getItem(SPEEDMODE_KEY) || (CONFIG.autoSpeed ? 'auto' : 'manual');
    CONFIG.autoSpeed = savedSpeedMode === 'auto';
    if ($speedMode) {
        $speedMode.value = savedSpeedMode;
        $speedMode.addEventListener('change', () => {
            CONFIG.autoSpeed = $speedMode.value === 'auto';
            localStorage.setItem(SPEEDMODE_KEY, $speedMode.value);
            if (CONFIG.autoSpeed) {
                speedMode = null; // erzwingt Neubewertung im nächsten Scan
                log('⏱ Tempo: Automatisch – Skript steuert die Geschwindigkeit', '#89b4fa');
            } else {
                log('⏱ Tempo: Manuell – Spiel-Einstellung bleibt unangetastet', '#89b4fa');
            }
        });
    }
    const MIN_KEY = 'ad_minimized';
    const RUN_KEY = 'ad_running';
    function applyMinimized(min) {
        $body.style.display = min ? 'none' : '';
        panel.style.width = min ? 'auto' : '330px';
        $minimize.textContent = min ? '+' : '–';
        const header = panel.querySelector('div'); // erste Zeile
        header.style.marginBottom = min ? '0' : '6px';
    }
    let minimized = localStorage.getItem(MIN_KEY) === '1';
    applyMinimized(minimized);
    $minimize.addEventListener('click', () => {
        minimized = !minimized;
        localStorage.setItem(MIN_KEY, minimized ? '1' : '0');
        applyMinimized(minimized);
    });

    function uiLine(text, color, small) {
        const line = document.createElement('div');
        line.style.color = color;
        if (small) line.style.cssText += 'font-size:10px;opacity:.8;';
        line.textContent = text;
        $log.prepend(line);
        while ($log.children.length > 80) $log.lastChild.remove();
    }

    function log(msg, color = '#cdd6f4') {
        uiLine(`${new Date().toLocaleTimeString('de-DE')} ${msg}`, color);
        pushLog(msg, 'INFO');
    }

    // Debug: landet immer im Puffer (Export!), im Panel nur bei aktivem Debug-Modus
    function dbgv(msg) { if (CONFIG.verboseDebug) dbg(msg); } // hochfrequente Routine-Zeilen (Scan-Details)
    function dbg(msg) {
        pushLog(msg, 'DEBUG');
        if (debugMode) uiLine(`${new Date().toLocaleTimeString('de-DE')} 🐞 ${msg}`, '#9399b2', true);
    }

    function refreshDebugBtn() {
        $debug.style.background = debugMode ? '#f9e2af' : '#313244';
        $debug.style.color = debugMode ? '#1e1e2e' : '#cdd6f4';
    }
    refreshDebugBtn();
    renderStats();

    let reloadTimer = null;
    function scheduleReload() {
        clearTimeout(reloadTimer);
        if (running && CONFIG.autoReload > 0) {
            reloadTimer = setTimeout(() => {
                if (running) { // Lauf-Zustand ist persistiert -> Autostart greift nach dem Reload
                    log(`🔄 geplanter Seiten-Reload (${Math.round(CONFIG.autoReload / 60000)} min)`, '#89b4fa');
                    persistState(); persistStats(); persistLog();
                    setTimeout(() => location.reload(), 300);
                }
            }, CONFIG.autoReload);
        }
    }
    function setRunning(run, auto) {
        running = run;
        $toggle.textContent = running ? 'Stop' : 'Start';
        $toggle.style.background = running ? '#f38ba8' : '#a6e3a1';
        $status.textContent = running ? 'läuft…' : 'gestoppt';
        localStorage.setItem(RUN_KEY, running ? '1' : '0');
        log(running ? (auto ? '▶ automatisch gestartet' : '▶ gestartet') : '⏸ gestoppt', '#89b4fa');
        if (running) { scanLoop(); scheduleReload(); } else { clearTimeout(timer); clearTimeout(reloadTimer); }
    }
    $toggle.addEventListener('click', () => setRunning(!running));

    // Autostart: nur wenn es beim letzten Mal lief und nicht bewusst gestoppt wurde
    if (CONFIG.autostart && localStorage.getItem(RUN_KEY) === '1') {
        $status.textContent = `Autostart in ${Math.round(CONFIG.autostartDelay / 1000)} s…`;
        setTimeout(() => { if (!running) setRunning(true, true); }, CONFIG.autostartDelay);
    }
    $debug.addEventListener('click', () => {
        debugMode = !debugMode;
        localStorage.setItem(DEBUG_KEY, debugMode ? '1' : '0');
        refreshDebugBtn();
    renderStats();
        log(`Debug-Modus ${debugMode ? 'AN' : 'AUS'}`, '#89b4fa');
    });
    panel.querySelector('#ad-export').addEventListener('click', exportLog);
    panel.querySelector('#ad-audit').addEventListener('click', () => adAudit(false));
    const paintCityBtn = () => {
        const b = panel.querySelector('#ad-city');
        if (!b) return;
        b.style.background = CONFIG.cityOnly ? '#a6e3a1' : '#313244';
        b.style.color = CONFIG.cityOnly ? '#1e1e2e' : '#cdd6f4';
        b.textContent = CONFIG.cityOnly ? '🏙 Nur City: AN' : '🏙 Nur City';
    };
    panel.querySelector('#ad-city').addEventListener('click', async (e) => {
        if (e.shiftKey) {
            const c = cityConfig();
            const idIn = window.prompt(
                'NUR-INNENSTADT-MODUS – eigene Einsätze nur mit Fahrzeugen der Innenstadt-Leitstelle bedienen.\n\n' +
                'Leitstellen-Gebäude-ID(s) (aus der URL /buildings/<ID> der Leitstelle), mehrere mit Komma.\n' +
                'Diese Einstellung teilt sich das Skript mit dem Top-Verband-Skript.', c.leitstellen.join(', '));
            if (idIn === null) return;
            const leitstellen = (idIn.match(/\d+/g) || []);
            try {
                const prev = JSON.parse(localStorage.getItem(CITY_CFG_KEY) || '{}');
                localStorage.setItem(CITY_CFG_KEY, JSON.stringify({ leitstellen, names: prev.names || [] }));
                localStorage.removeItem(CITY_BLD_KEY); // Cache verwerfen -> Neuauflösung
            } catch (err) { /* egal */ }
            cityBuildingIds = new Set();
            await refreshCityBuildings();
            log(`🏙 Innenstadt-Leitstelle gespeichert: ${leitstellen.join(', ') || '—'} → ${cityBuildingIds.size} zugeordnete Gebäude`, '#89b4fa');
            return;
        }
        CONFIG.cityOnly = !CONFIG.cityOnly;
        saveCityOnly(CONFIG.cityOnly);
        if (CONFIG.cityOnly) refreshCityBuildings();
        paintCityBtn();
        log(`🏙 Nur-Innenstadt-Modus ${CONFIG.cityOnly ? 'AN – eigene Einsätze nur mit Innenstadt-Fahrzeugen' : 'aus – alle eigenen Wachen verfügbar'}`, '#f9e2af');
    });
    paintCityBtn();
    panel.querySelector('#ad-mbl').addEventListener('click', () => {
        loadManualBlacklist();
        const current = [...manualBlacklist].join(', ');
        const input = window.prompt(
            'Fahrzeug-IDs, die NIE automatisch alarmiert werden sollen (Auto-Dispatch & Top-Verband).\n' +
            'IDs mit Komma/Leerzeichen/Zeilenumbruch trennen. Die ID steht in der Fahrzeug-URL (/vehicles/<ID>)\n' +
            'und im 📟 LF-Bindungs-Panel. Leeren = Liste löschen.',
            current
        );
        if (input === null) return; // abgebrochen
        const ids = (input.match(/\d{5,}/g) || []);
        saveManualBlacklist(ids);
        log(`🚫 Manuelle Sperrliste gespeichert: ${ids.length} Fahrzeug${ids.length === 1 ? '' : 'e'}${ids.length ? ' (' + ids.slice(0, 8).join(', ') + (ids.length > 8 ? ', …' : '') + ')' : ''}`, '#f9e2af');
    });
    panel.querySelector('#ad-travel').addEventListener('click', (e) => {
        if (e.shiftKey) {
            if (!confirm('Fahrzeit-Statistik zurücksetzen?')) return;
            travelStats = { since: Date.now(), types: {}, buildings: {} };
            persistTravelStats();
            durationStats = { since: Date.now(), types: {} };
            persistDurations();
            log('🚗 Fahrzeit- und Einsatzdauer-Statistik zurückgesetzt – Messung beginnt frisch', '#f9e2af');
            return;
        }
        for (const line of travelReport()) log(line, '#89b4fa');
    });
    panel.querySelector('#ad-audit-clear').addEventListener('click', () => {
        const n = auditBuffer.length;
        if (!confirm(`Audit-Speicher wirklich leeren? (${n} Alarm-Wellen werden verworfen)\nTipp: Vorher mit „📊 Audit-Datei" exportieren.`)) return;
        auditBuffer = [];
        try { localStorage.removeItem(AUDIT_KEY); } catch (e) { /* egal */ }
        // Auch die [AUDIT]-Zeilen aus dem Logpuffer entfernen, damit adAudit() nicht
        // sofort wieder die alten Wellen aus dem Log einsammelt.
        logBuffer = logBuffer.filter(l => !l.includes('[AUDIT] m#'));
        persistLog();
        log(`📊 Audit-Speicher geleert (${n} Wellen verworfen) – die Messung beginnt ab jetzt frisch`, '#f9e2af');
    });
    panel.querySelector('#ad-audit-file').addEventListener('click', exportAudit);
    panel.querySelector('#ad-file').addEventListener('click', chooseLogFile);
    panel.querySelector('#ad-clear').addEventListener('click', () => {
        logBuffer = [];
        persistLog();
        $log.innerHTML = '';
        log('Logpuffer geleert', '#89b4fa');
    });
    panel.querySelector('#ad-reset').addEventListener('click', () => {
        if (!confirm('Gedächtnis komplett zurücksetzen?\n\nLöscht: Über-Alarmierungs-Bremse, Cooldowns, gesendete Fahrzeuge, Hänger-Erkennung und Sicherheitswachen-Ankündigungen.\n\nDas Spiel selbst ist nicht betroffen. Laufende Einsätze werden beim nächsten Scan neu bewertet.')) return;
        state.clear();
        stuckSince.clear();
        openSince.clear();
        swAnnounced.clear();
        vehicleAlarmed.clear();
        vehicleFails.clear();
        setOverloadPaused(false);
        knownActive = new Set();
        try { localStorage.removeItem(STATE_KEY); } catch (e) {}
        try { localStorage.removeItem(VGUARD_KEY); } catch (e) {}
        try { localStorage.removeItem(VFAIL_KEY); } catch (e) {}
        log('🧠 Gedächtnis zurückgesetzt – alle Einsätze werden neu bewertet', '#89b4fa');
    });
    panel.querySelector('#ad-storage').addEventListener('click', () => {
        let total = 0;
        const rows = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            const v = localStorage.getItem(k) || '';
            rows.push({ k, bytes: v.length });
            total += v.length;
        }
        rows.sort((a, b) => b.bytes - a.bytes);
        log(`🔍 Speicher-Diagnose: ${rows.length} Schlüssel, ~${(total / 1024).toFixed(0)} KB gesamt auf dieser Domain (alle LSS-Skripte zusammen)`, '#89b4fa');
        for (const r of rows.slice(0, 15)) log(`   ${r.k}: ~${(r.bytes / 1024).toFixed(1)} KB`, '#9399b2');
        if (rows.length > 15) log(`   … und ${rows.length - 15} weitere Schlüssel`, '#9399b2');
    });

    // ---------- Typliste der LSSM-API (optional) ----------
    fetch('https://api.lss-manager.de/de_DE/vehicles')
        .then(r => r.json())
        .then(data => {
            for (const [id, v] of Object.entries(data)) {
                if (!v || !v.caption) continue;
                const key = norm(v.caption);
                (dynTypes[key] = dynTypes[key] || []).push(Number(id)); // Duplikate (z. B. NEA50) zusammenführen
                dynTypeNames[Number(id)] = v.caption; // Rückrichtung: ID -> Name (für Reports)
            }
            log(`Typliste geladen (${Object.keys(dynTypes).length} Fahrzeugtypen)`, '#89b4fa');
        })
        .catch(() => log('LSSM-API nicht erreichbar – nutze internes Mapping', '#f9e2af'));

    // ================= FUNK: Verstanden & Sprechwünsche =================

    // "Verstanden"-Buttons klicken (z. B. wenn sich ein Einsatz ausgebreitet hat)
    function acknowledgeRadioMessages() {
        const buttons = document.querySelectorAll('#radio_messages_important li:not([style*="display:none"]) a.radio_message_close');
        let n = 0;
        for (const btn of buttons) {
            const li = btn.closest('li');
            if (li && li.classList.contains('radio_message_alliance')) continue;
            btn.click();
            n++;
        }
        if (n) log(`📻 ${n}× "Verstanden" bestätigt`, '#89b4fa');
    }

    // Erstsichtung je Fahrzeug-Sprechwunsch: erlaubt eine Alterungs-Garantie (nach maxSpeakWaitMs
    // wird vorrangig abgearbeitet). Wird geleert, sobald der Sprechwunsch verschwunden ist.
    const speakFirstSeen = new Map(); // vehicleId -> ts der ersten Sichtung

    // Eigene Sprechwünsche (FMS 5) aus dem Funk einsammeln
    function getSprechwuensche() {
        const result = [];
        let skippedCooldown = 0;
        const seenNow = new Set();
        const items = document.querySelectorAll('#radio_messages_important li:not(.radio_message_alliance)');
        for (const li of items) {
            if (li.style.display === 'none') continue;
            const fms5 = li.querySelector('span.building_list_fms_5');
            if (!fms5 || !/Sprechwunsch/i.test(fms5.getAttribute('title') || '')) continue;
            const m = li.className.match(/radio_message_vehicle_(\d+)/);
            const vehicleId = m ? m[1] : li.querySelector('img.vehicle_search')?.getAttribute('vehicle_id');
            if (!vehicleId) continue;
            const vehicleName = li.querySelector(`a[href="/vehicles/${vehicleId}"]`)?.textContent?.trim() || vehicleId;
            const missionId = li.querySelector('a.mission-radio-button')?.getAttribute('href')?.match(/\/missions\/(\d+)/)?.[1] || null;
            seenNow.add(vehicleId);
            if (!speakFirstSeen.has(vehicleId)) speakFirstSeen.set(vehicleId, Date.now());
            const waited = Date.now() - speakFirstSeen.get(vehicleId);
            const overdue = CONFIG.prioritizeSpeakRequests || waited >= (CONFIG.maxSpeakWaitMs || 300000); // Vorrang-Prinzip oder zu lange gewartet
            const last = vehicleState.get(vehicleId);
            if (!overdue && last && Date.now() - last < CONFIG.vehicleCooldown) {
                skippedCooldown++;
                if (CONFIG.prisonerDiagnostics) dbg(`[Fzg ${vehicleId}] ${vehicleName}: Sprechwunsch übersprungen (Cooldown, noch ${Math.round((CONFIG.vehicleCooldown - (Date.now() - last)) / 1000)}s)`);
                continue;
            }
            result.push({ vehicleId, vehicleName, missionId, waited, overdue });
        }
        for (const id of [...speakFirstSeen.keys()]) if (!seenNow.has(id)) speakFirstSeen.delete(id); // erledigte vergessen
        // Überfällige (>maxSpeakWaitMs) zuerst, dann nach Wartezeit absteigend – ältester zuerst.
        result.sort((a, b) => (b.overdue - a.overdue) || (b.waited - a.waited));
        const overdueN = result.filter(r => r.overdue).length;
        if (CONFIG.prisonerDiagnostics && (result.length || skippedCooldown)) {
            dbg(`Sprechwünsche: ${result.length} aktiv${overdueN ? ` (${overdueN} überfällig >5min – Vorrang)` : ''}, ${skippedCooldown} im Cooldown`);
        }
        return result;
    }

    // Krankenhaus-Tabellenzeile parsen
    function parseHospitalRow(tr, isAlliance) {
        const link = tr.querySelector('a[href*="/patient/"]');
        if (!link) return null;
        const href = link.getAttribute('href');
        if (href.endsWith('/patient/-1')) return null; // "Ohne Transport entlassen"
        const text = tr.textContent.replace(/\u00a0/g, ' ');
        const beds = text.match(/(\d+)\s*\/\s*\d+/);
        const freeBeds = beds ? parseInt(beds[1], 10) : 0;
        const dist = text.match(/([\d.,]+)\s*km/);
        const taxM = isAlliance ? text.match(/(\d+)\s*%/) : null;
        return {
            href,
            name: tr.querySelector('td')?.childNodes[0]?.textContent?.trim() || 'Krankenhaus',
            freeBeds,
            distance: dist ? parseFloat(dist[1].replace(',', '.')) : 9999,
            specialty: !!tr.querySelector('.label-success'),
            tax: taxM ? parseInt(taxM[1], 10) : 0,
            isAlliance,
        };
    }

    // ---- Gefangenentransport-Helfer ----
    function collectPrisonLinks(root) {
        return [...root.querySelectorAll('a[data-prison-id], a[href*="/gefangener/"]')]
            .filter(a => !/\/gefangener\/-1/.test(a.getAttribute('href') || ''));
    }

    function parsePrisonLinks(links) {
        return links.map(a => {
            const text = (a.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
            const cells = text.match(/Freie\s+Zellen:\s*(\d+)/i);
            const dist = text.match(/Entfernung:\s*([\d.,]+)\s*km/i);
            const taxM = text.match(/Abgabe[^:]*:\s*(\d+)\s*%/i);
            return {
                href: a.getAttribute('href'),
                name: text.split('(')[0].trim() || 'Polizeiwache',
                free: cells ? parseInt(cells[1], 10) : 0,
                distance: dist ? parseFloat(dist[1].replace(',', '.')) : 9999,
                tax: taxM ? parseInt(taxM[1], 10) : 0,   // eigene Wachen ohne Abgabe-Angabe -> 0
                green: a.classList.contains('btn-success'),
            };
        });
    }

    // Seite in unsichtbarem iframe laden, damit das Spiel-JS die Inhalte
    // (z. B. Zellen-Buttons) nachladen kann. ready(doc) prüft, ob es soweit ist.
    function loadViaIframe(url, ready, timeout = 10000) {
        return new Promise((resolve) => {
            const f = document.createElement('iframe');
            f.style.cssText = 'position:fixed;width:2px;height:2px;left:-9999px;top:-9999px;visibility:hidden;';
            f.src = url;
            document.body.appendChild(f);
            const t0 = Date.now();
            const iv = setInterval(() => {
                let d = null;
                try { d = f.contentDocument; } catch (e) { /* noch nicht bereit */ }
                if (d && ready(d)) {
                    clearInterval(iv);
                    resolve({ doc: d, cleanup: () => f.remove() });
                } else if (Date.now() - t0 > timeout) {
                    clearInterval(iv);
                    f.remove();
                    resolve(null);
                }
            }, 300);
        });
    }

    // Gefangenentransport: Zellen-Buttons werden vom Spiel-JS nachgeladen,
    // daher 1) statisches HTML versuchen, 2) iframe-Fallback.
    async function handlePrisoner(v, vehicleDoc) {
        // 1) Statisch: Fahrzeugseite, dann Einsatzseite
        let prisons = parsePrisonLinks(collectPrisonLinks(vehicleDoc));
        if (!prisons.length && v.missionId) {
            try {
                const res = await fetch(`/missions/${v.missionId}`, { credentials: 'same-origin' });
                if (res.ok) {
                    const mdoc = new DOMParser().parseFromString(await res.text(), 'text/html');
                    prisons = parsePrisonLinks(collectPrisonLinks(mdoc));
                }
            } catch (e) { /* weiter mit iframe */ }
        }

        // 2) iframe: Fahrzeugseite mit laufendem Spiel-JS
        if (!prisons.length) {
            dbg(`[Fzg ${v.vehicleId}] Gefangener: statisch keine Zellen, versuche iframe`);
            const frame = await loadViaIframe(`/vehicles/${v.vehicleId}`,
                d => collectPrisonLinks(d).length > 0, 15000);
            if (frame) {
                prisons = parsePrisonLinks(collectPrisonLinks(frame.doc));
                frame.cleanup();
            }
        }
        dbg(`[Fzg ${v.vehicleId}] Gefangener: ${prisons.length} Zellen-Optionen gefunden`);
        if (!prisons.length) {
            if (CONFIG.prisonerDiagnostics) dbg(`[Fzg ${v.vehicleId}] Gefangener: WEDER statisch NOCH per iframe Zellen-Buttons gefunden – evtl. lädt das Spiel-JS die Liste nicht, oder das Fahrzeug hält keinen Gefangenen mehr`);
            return { ok: false, reason: 'keine Zellen-Buttons gefunden (auch nicht via iframe)' };
        }

        // Nur GRÜNE (btn-success) Zellen sind für DIESEN Gefangenen zulässig. Orange (btn-warning)
        // zeigt zwar "Freie Zellen", ist aber für diesen Gefangenen nicht anklickbar (falsche Kategorie/
        // Auslastung) – diese müssen ausgeschlossen werden, sonst läuft der Transport ins Leere.
        const greenCells = prisons.filter(p => p.green && p.free > 0);
        if (CONFIG.prisonerDiagnostics) {
            const orange = prisons.filter(p => !p.green);
            dbg(`[Fzg ${v.vehicleId}] Gefangener: ${prisons.length} Zellen gesamt – ${greenCells.length} grün/nutzbar, ${orange.length} orange/gesperrt`);
            // die 3 nächsten grünen und die 3 nächsten orangen zeigen
            const fmt = p => `${p.name}@${p.distance}km(frei${p.free}${p.tax ? ',Abg' + p.tax + '%' : ''})`;
            const g3 = greenCells.slice().sort((a, b) => a.distance - b.distance).slice(0, 3).map(fmt).join(' ');
            const o3 = orange.slice().sort((a, b) => a.distance - b.distance).slice(0, 3).map(fmt).join(' ');
            if (g3) dbg(`[Fzg ${v.vehicleId}] nächste grüne: ${g3}`);
            if (o3) dbg(`[Fzg ${v.vehicleId}] nächste orange: ${o3}`);
        }
        // Abgabefreie (eigene) zuerst, dann Verband bis maxAllianceTax – je nach Distanz
        const pick = greenCells.filter(p => p.tax === 0).sort((a, b) => a.distance - b.distance)[0]
                  || greenCells.filter(p => p.tax <= CONFIG.maxAllianceTax).sort((a, b) => a.distance - b.distance)[0];
        if (!pick) {
            if (CONFIG.prisonerDiagnostics && greenCells.length) {
                dbg(`[Fzg ${v.vehicleId}] grüne Zellen vorhanden, aber alle über maxAllianceTax=${CONFIG.maxAllianceTax}% – keine genommen`);
            }
            return { ok: false, reason: `keine GRÜNE freie Zelle (${prisons.length} Zellen gesehen, ${greenCells.length} grün)` };
        }

        if (CONFIG.prisonerDiagnostics) dbg(`[Fzg ${v.vehicleId}] wähle Zelle: ${pick.name} @ ${pick.distance}km, URL ${pick.href}`);
        const go = await fetch(pick.href, { credentials: 'same-origin' });
        if (go.status === 409) return { ok: false, reason: 'Zelle belegt (HTTP 409) – später erneut' };
        if (!go.ok) throw new Error(`Einliefern: HTTP ${go.status}`);
        if (CONFIG.prisonerDiagnostics) dbg(`[Fzg ${v.vehicleId}] Einliefern bestätigt: HTTP ${go.status}`);
        return { ok: true, info: `🚔 ${pick.name} (${pick.distance} km${pick.tax ? ', Abgabe ' + pick.tax + '%' : ''})` };
    }

    // Zwischentransport: Patient zum Übergabepunkt fahren.
    // Struktur (bestätigt): #own-intermediate-stations / #alliance-intermediate-stations,
    // Zeilen mit Name, "x,xx km" und <a class="btn-success" href="/vehicles/<vid>/patient/<stationId>">Anfahren</a>
    async function handleIntermediate(v, doc, requestEl) {
        const parseKm = (s) => parseFloat((s || '99999').replace(/\./g, '').replace(',', '.'));
        const parseRow = (tr, isAlliance) => {
            const a = tr.querySelector(`a.btn-success[href*="/vehicles/${v.vehicleId}/patient/"]`);
            if (!a) return null;
            const name = tr.querySelector('td')?.textContent.replace(/\s+/g, ' ').trim() || 'Übergabepunkt';
            const dist = parseKm(tr.textContent.match(/([\d.,]+)\s*km/)?.[1]);
            return { href: a.getAttribute('href'), name, dist, isAlliance };
        };
        const fromTables = (root) => [
            ...[...root.querySelectorAll('#own-intermediate-stations tbody tr')].map(tr => parseRow(tr, false)),
            ...[...root.querySelectorAll('#alliance-intermediate-stations tbody tr')].map(tr => parseRow(tr, true)),
        ].filter(Boolean).sort((a, b) => a.dist - b.dist || (a.isAlliance ? 1 : 0) - (b.isAlliance ? 1 : 0));

        let stations = fromTables(doc);

        // Fallback 1: generisch alle passenden Links einsammeln (falls Layout abweicht)
        if (!stations.length) {
            stations = [...(requestEl.closest('div') || doc).querySelectorAll(`a[href*="/vehicles/${v.vehicleId}/patient/"]`)]
                .map(a => ({ href: a.getAttribute('href'), name: 'Übergabepunkt', dist: 0, isAlliance: false }));
        }
        // Fallback 2: iframe, falls die Buttons per Spiel-JS nachgeladen werden
        if (!stations.length) {
            const frame = await loadViaIframe(`/vehicles/${v.vehicleId}`,
                d => d.querySelector(`a[href*="/vehicles/${v.vehicleId}/patient/"]`));
            if (frame) {
                try { stations = fromTables(frame.doc); } finally { frame.cleanup(); }
            }
        }
        dbg(`[Fzg ${v.vehicleId}] Zwischentransport: ${stations.length} Übergabepunkte: ${stations.slice(0, 3).map(s => `${s.name}@${s.dist}km${s.isAlliance ? '(V)' : ''}`).join(', ')}`);
        if (!stations.length) return { ok: false, reason: 'Zwischentransport: kein "Anfahren"-Ziel gefunden' };

        const pick = stations[0]; // nächstgelegener freier Übergabepunkt, eigene vor Verband bei Gleichstand
        const go = await fetch(pick.href, { credentials: 'same-origin' });
        if (go.status === 409) return { ok: false, reason: 'Übergabepunkt belegt (HTTP 409) – später erneut' };
        if (!go.ok) throw new Error(`Anfahren: HTTP ${go.status}`);
        return { ok: true, info: `Zwischentransport → ${pick.name} (${pick.dist} km${pick.isAlliance ? ', Verband' : ''})` };
    }

    // Sprechwunsch eines Fahrzeugs abarbeiten (Patient -> Krankenhaus, Gefangener -> Zelle)
    async function handleTransport(v, limitReached = false) {
        const res = await fetch(`/vehicles/${v.vehicleId}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status} (Fahrzeugseite)`);
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');

        const requests = [...doc.querySelectorAll('[data-transport-request]')];
        if (!requests.length) return { ok: false, reason: 'kein Transport-Request (evtl. schon erledigt)' };
        const types = requests.map(r => r.getAttribute('data-transport-request-type') || '');
        dbg(`[Fzg ${v.vehicleId}] ${v.vehicleName}: Transporttypen = [${types.join(', ')}]`);

        // Gefangenentransport (FuStW & Co.) – hat Vorrang und einen eigenen Slot-Topf, wird also auch bei
        // erreichtem Patienten-Limit abgearbeitet (sonst bleibt der Gefangenen-Einsatz ewig rot).
        if (types.some(t => t.startsWith('prisoner'))) {
            const pr = await handlePrisoner(v, doc);
            return { ...pr, wasPrisoner: true };
        }

        // Ab hier nur Patienten/Zwischentransporte: Bei erreichtem Patienten-Limit zurückstellen.
        if (limitReached) return { ok: false, reason: 'limit' };

        // Zwischentransport (z. B. GW-Bergrettung -> Übergabepunkt)
        const intermediate = requests.find(r => (r.getAttribute('data-transport-request-type') || '') === 'patient-intermediate');
        if (intermediate) return handleIntermediate(v, doc, intermediate);

        const request = requests.find(r => (r.getAttribute('data-transport-request-type') || '') === 'patient');
        if (!request) return { ok: false, reason: `Transporttyp "${types.join(',')}" wird noch nicht unterstützt` };

        const needsSpecialty = /folgender Erweiterung/i.test(request.textContent);

        const own = [...doc.querySelectorAll('#own-hospitals tbody tr')]
            .map(tr => parseHospitalRow(tr, false)).filter(Boolean);
        const alliance = [...doc.querySelectorAll('#alliance-hospitals tbody tr')]
            .map(tr => parseHospitalRow(tr, true)).filter(Boolean);
        dbg(`[Fzg ${v.vehicleId}] KH-Auswahl: ${own.length} eigene, ${alliance.length} Verband; Fachabteilung nötig: ${needsSpecialty}`);

        // Auswahl: Tabellen sind bereits nach Entfernung sortiert.
        // Entfernungs-Deckel: bevorzugt Krankenhäuser innerhalb maxHospitalKm, damit RTW nicht für
        // 300+ km gebunden werden (Nebeneffekt des Sprechwunsch-Vorrangs bei vollen lokalen Kliniken).
        // Nur wenn KEIN Haus innerhalb des Deckels frei ist, wird die Grenze fallengelassen.
        const cap = CONFIG.maxHospitalKm || 0;
        const within = (h) => !cap || (Number(h.distance) || 0) <= cap;
        const buildCandidates = (distFilter) => [
            ...(CONFIG.preferSpecialty && needsSpecialty
                ? [ own.filter(h => h.freeBeds > 0 && h.specialty && distFilter(h)),
                    alliance.filter(h => h.freeBeds > 0 && h.specialty && h.tax <= CONFIG.maxAllianceTax && distFilter(h)) ]
                : []),
            own.filter(h => h.freeBeds > 0 && distFilter(h)),
            alliance.filter(h => h.freeBeds > 0 && h.tax <= CONFIG.maxAllianceTax && distFilter(h)),
        ];
        // 1. Versuch: nur innerhalb des Deckels. 2. Versuch (Fallback): ohne Entfernungsgrenze.
        let hospital = buildCandidates(within).find(list => list.length)?.[0];
        let cappedFallback = false;
        if (!hospital && cap) {
            hospital = buildCandidates(() => true).find(list => list.length)?.[0];
            if (hospital) {
                cappedFallback = true;
                dbg(`[Fzg ${v.vehicleId}] kein Krankenhaus ≤ ${cap} km frei – weiche auf ${hospital.name} (${hospital.distance} km) aus`);
            }
        }
        if (!hospital) return { ok: false, reason: 'kein Krankenhaus mit freien Betten gefunden' };

        const go = await fetch(hospital.href, { credentials: 'same-origin' });
        if (go.status === 409) return { ok: false, reason: 'Ziel belegt/Fahrzeug verplant (HTTP 409) – nächster Versuch später' };
        if (!go.ok) throw new Error(`Anfahren: HTTP ${go.status}`);

        const flags = [
            needsSpecialty ? (hospital.specialty ? 'Fachabt. ✓' : 'ohne Fachabt.!') : null,
            hospital.isAlliance ? `Verband ${hospital.tax}%` : null,
            cappedFallback ? `⚠️ >${CONFIG.maxHospitalKm} km – kein näheres frei` : null,
        ].filter(Boolean).join(', ');
        return { ok: true, info: `${hospital.name} (${hospital.distance} km${flags ? ', ' + flags : ''})` };
    }

    // ================= EINSÄTZE (wie v2) =================

    function resolveTypeIds(caption) {
        caption = caption.replace(/\u00a0/g, ' ').trim();
        const out = new Set();
        const addEntry = (e) => {
            if (typeof e === 'number') { out.add(e); return; }

            // Spezial-Anforderung: RTH mit Rettungswinde
            if (e === 'RTH-Winde') {
                out.add('RTH-Winde');
                return;
            }

            const hit = dynTypes[norm(e)] || VEHICLE_TYPES[e];
            if (hit) hit.forEach(id => out.add(id));
        };
        const lookup = (name) => {
            // Klammerzusätze wie "(z. B. LF)" strippen – das Spiel hängt sie an manche
            // Anforderungen an (z.B. "Feuerlöschpumpe (z. B. LF)"). Aliase bleiben so schlank.
            const stripped = name.replace(/\s*\(z\.\s?B\..*?\)\s*$/i, '').trim();
            const candidates = [name,
                stripped,
                name.replace(/fahrzeuge/i, 'fahrzeug'),
                name.replace(/leitern/i, 'leiter'),
                name.replace(/pumpen/i, 'pumpe'), // Plural: "2 Feuerlöschpumpen", "Schmutzwasserpumpen"
                name.replace(/ausstattungen/i, 'ausstattung'),
                stripped.replace(/pumpen/i, 'pumpe'),
                stripped.replace(/fahrzeuge/i, 'fahrzeug')];
            for (const c of candidates) {
                if (REQUIREMENT_ALIASES[c]) { REQUIREMENT_ALIASES[c].forEach(addEntry); return true; }
                if (dynTypes[norm(c)]) { dynTypes[norm(c)].forEach(id => out.add(id)); return true; }
                if (VEHICLE_TYPES[c]) { VEHICLE_TYPES[c].forEach(id => out.add(id)); return true; }
            }
            return false;
        };
        if (!lookup(caption)) {
            let any = false;
            for (const part of caption.split(/\s+oder\s+/i)) any = lookup(part.trim()) || any;
            if (!any) return null;
        }
        return [...out];
    }

    function parseRequirements(entry, id) {
        const reqs = [];
        const missing = entry.querySelector(`#mission_missing_${id} [data-requirement-type="vehicles"]`);
        if (missing) {
            const text = missing.textContent.replace(/\u00a0/g, ' ');
            const m = text.match(/Fehlende Fahrzeuge:\s*(.+)/);
            if (m) {
                for (const item of m[1].split(',')) {
                    const im = item.trim().match(/^(\d+)\s+(.+)$/);
                    if (im) reqs.push({ count: +im[1], caption: im[2].trim(), typeIds: resolveTypeIds(im[2]), fromMissing: true });
                }
            }
        }
        // Fehlendes Personal erkennen, z. B. "11x Betreuungshelfer"
        const missingPersonnel = entry.querySelector(`#mission_missing_${id} [data-requirement-type="personnel"]`);
        if (missingPersonnel) {
            const text = missingPersonnel.textContent.replace(/\u00a0/g, ' ');

            // Beide Formate: "11x Betreuungshelfer" und "1 Feuerwehrmann"
            const matches = [...text.replace(/^.*?Fehlendes Personal:\s*/i, '').matchAll(/(\d+)\s*x?\s+([^,]+)/g)];

            for (const m of matches) {
                const caption = m[2].trim();

                reqs.push({
                    count: parseInt(m[1], 10),
                    caption,
                    typeIds: resolveTypeIds(caption),
                    fromPersonnel: true
                });
            }
        }
        // Fehlendes Wasser erkennen und wasserführende Fahrzeuge nachalarmieren
        const missingWater = entry.querySelector(`#mission_missing_${id} [data-requirement-type="other"]`);
        if (missingWater) {
            const text = missingWater.textContent.replace(/\u00a0/g, ' ');
            const wm = text.match(/Uns fehlt:\s*([\d.]+)\s*(?:l\.\s*)?Wasser/i);

            if (wm) {
                const liters = parseInt(wm[1].replace(/\./g, ''), 10);

                // grob: pro wasserführendem Fahrzeug ca. 4.000 l rechnen
                const count = Math.ceil(liters / 4000);

                reqs.push({
                    count,
                    caption: 'Wasser', // literunabhängig, damit memKey/Anrechnung stabil bleibt
                    liters,
                    typeIds: resolveTypeIds('Wasserführendes Fahrzeug'),
                    isWater: true
                });
            }

            // Sonderlöschmittel/Schaum: echtes Format "Uns fehlt: 1250 Sonderlöschmittel" (ohne "l.")
            const fm = text.match(/Uns fehlt:\s*([\d.]+)\s*(?:l\.\s*)?(?:Sonderlöschmittel|Schaum)/i);
            if (fm) {
                const liters = parseInt(fm[1].replace(/\./g, ''), 10);
                // Ein AB-Sonderlöschmittel führt i. d. R. ~10.000 l -> meist genügt einer.
                const count = Math.max(1, Math.ceil(liters / 10000));
                reqs.push({
                    count,
                    caption: 'Sonderlöschmittel', // literunabhängig für stabilen memKey
                    liters,
                    typeIds: resolveTypeIds('Sonderlöschmittel'),
                    isWater: true // wie Wasser: Mengen-Anforderung, nicht über vor-Ort doppelzählen
                });
            }

            // Fehlende Pumpenleistung erkennen, echtes Format "Uns fehlt: 4600 l/min Pumpenleistung"
            // (Beleg: DOM von #4354288656 – Wassereinbruch Großbaustelle). Bisher komplett ungeprüft,
            // deshalb blieb der Einsatz für immer offen, obwohl genug LF vorhanden waren.
            // LF/HLF liefern laut Fahrzeug-DOM (water_damage_pump_value) je 1.000–2.000 l/min.
            const pm = text.match(/Uns fehlt:\s*([\d.]+)\s*l\s*\/\s*min\s*Pumpenleistung/i);
            if (pm) {
                const missingRate = parseInt(pm[1].replace(/\./g, ''), 10);
                const count = Math.max(1, Math.ceil(missingRate / 2000));
                reqs.push({
                    count,
                    caption: 'Pumpenleistung', // literunabhängig für stabilen memKey
                    liters: missingRate,
                    typeIds: resolveTypeIds('Feuerlöschpumpe'),
                    isWater: true // wie Wasser: Mengen-Anforderung, nicht über vor-Ort doppelzählen
                });
            }
        }
        // Gefangene/Verdächtige, die abtransportiert werden sollen: Dieser Hinweis steht im
        // mission_missing-Feld OHNE data-requirement-type und ohne Stückzahl ("Gefangene sollen
        // abtransportiert werden."). Er bedeutet: ein Polizeifahrzeug (FuStW) muss zum Einsatz, um
        // die Person aufzunehmen – sonst bleibt der Einsatz rot. Wir fordern dafür einen FuStW an.
        const missingBox = entry.querySelector(`#mission_missing_${id}`);
        if (missingBox && /Gefangene?\s+soll|abtransportiert\s+werden|Verdächtige?\s+soll/i.test(missingBox.textContent)) {
            // Anzahl wartender Personen aus dem Gefangenen-Feld zählen (jede genannte Person = 1)
            const prisonerBox = entry.querySelector(`#mission_prisoners_${id}`);
            const names = prisonerBox ? (prisonerBox.textContent.match(/\S+\s+\w\./g) || []) : [];
            const count = Math.max(1, names.length);
            reqs.push({
                count,
                caption: 'Gefangenentransport',
                typeIds: [32], // Funkstreifenwagen nimmt Gefangene auf
                fromPrisoner: true
            });
        }
        for (const p of entry.querySelectorAll(`#mission_patients_${id} .alert-danger`)) {
            const full = p.textContent.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ');
            const pm = full.match(/Wir benötigen:\s*(.+)/);
            if (!pm) continue;
            // Präfix-Multiplikator vor "Wir benötigen" lesen, z. B. "19x Wir benötigen: RTW"
            const mult = full.match(/(\d+)\s*x\s*Wir benötigen/i);
            const factor = mult ? parseInt(mult[1], 10) : 1;
            for (const name of pm[1].split(',')) {
                const cap = name.trim();
                if (!cap) continue;
                // Pro Patient höchstens 1 RTW sinnvoll; Sonderrollen (LNA/OrgL) nur 1x je Einsatz.
                const isOnePerMission = CONFIG.maxOnePerMission.some(n => norm(cap).includes(norm(n)));
                const add = isOnePerMission ? 1 : factor;
                const existing = reqs.find(r => r.caption === cap && r.fromPatient);
                if (existing) {
                    if (!isOnePerMission) existing.count += add;
                } else {
                    reqs.push({ count: add, caption: cap, typeIds: resolveTypeIds(cap), fromPatient: true });
                }
            }
        }
        return reqs;
    }

    function collectMissions() {
        loadTvFarmedIds(); // je Scan frisch – neue Farming-Ziele des Verband-Skripts sofort respektieren
        const result = [];
        const seenIds = new Set();
        const lists = [
            { sel: '#mission_list', kind: 'normal' },
            { sel: '#mission_list_krankentransporte', kind: 'kt' },
            { sel: '#mission_list_sicherheitswache', kind: 'sw' },
        ];
        for (const { sel, kind } of lists) {
        for (const el of document.querySelectorAll(`${sel} .missionSideBarEntry`)) {
            const id = el.getAttribute('mission_id');
            if (!id || el.style.display === 'none') continue;
            if (seenIds.has(id)) continue; // Einsatz kann doppelt im DOM stehen
            seenIds.add(id);
            // An die Allianz/Gruppe freigegebene Einsätze tragen am Panel die Klasse "panel-success"
            // (grüner Rand). Dort sollen KEINE eigenen Kräfte hin – komplett überspringen.
            const panelEl = el.querySelector(`#mission_panel_${id}`);
            // Verbandseinsätze anderer Mitglieder ("[Verband]"-Präfix, kein grüner Rand!) NICHT voll
            // bedienen – sonst fährt die eigene Flotte quer durch Deutschland (Befund 12.07.: NEF mit
            // 138-169 min nach Dortmund/Bottrop, nachdem das Top-Verband-Skript 1 LF geschickt hatte
            // und der Einsatz dadurch "beteiligt" wurde). Das 1-LF-Mitverdienen übernimmt weiterhin
            // das Top-Verband-Skript. Über serveVerbandMissions=true wieder aktivierbar.
            const capRaw = el.querySelector(`#mission_caption_${id}`)?.textContent || '';
            const isShared = (panelEl && panelEl.classList.contains('panel-success')) || /^\s*\[Verband\]/i.test(capRaw);
            // Vom Top-Verband-Skript angefahrene Einsätze (Farming-Ziele) nicht voll bedienen – ABER
            // NUR wenn der Einsatz auch wirklich ein geteilter/Verbandseinsatz ist (grüner Rand oder
            // [Verband]-Präfix). Fix (22.07.): Bei Farming bis Schwelle 5.000 landen auch EIGENE
            // Einsätze im tv_lf_sent-Speicher, wenn dort mal 1 LF hinging – die wurden dann fälschlich
            // still übersprungen und nie bedient (Beleg: eigener Einsatz #4345360632 kam nie ins Log).
            if (!CONFIG.serveTvFarmedMissions && tvFarmedIds.has(id) && isShared) {
                if (!releasedAnnounced.has(id)) {
                    releasedAnnounced.add(id);
                    dbg(`[#${id}] Verbands-Farming-Ziel (Top-Verband-Skript hat 1 LF geschickt) – wird vom Auto-Dispatch nicht bedient`);
                }
                continue;
            }
            if (!CONFIG.serveVerbandMissions && /^\s*\[Verband\]/i.test(capRaw)) {
                if (!releasedAnnounced.has(id)) {
                    releasedAnnounced.add(id);
                    dbg(`[#${id}] Verbandseinsatz ([Verband]-Präfix) – wird vom Auto-Dispatch nicht bedient (serveVerbandMissions=false)`);
                }
                continue;
            }
            if (panelEl && panelEl.classList.contains('panel-success')) {
                if (!releasedAnnounced.has(id)) {
                    releasedAnnounced.add(id);
                    const cap = el.querySelector(`#mission_caption_${id}`)?.textContent?.trim().split(',')[0] || id;
                    dbg(`[#${id}] ${cap}: an Allianz freigegeben (grüner Rand) – wird ignoriert`);
                }
                continue;
            }
            const isRed = !!el.querySelector('.mission_panel_red');
            const isYellow = !!el.querySelector('.mission_panel_yellow');
            const participating = el.querySelector(`#mission_participant_${id}`)?.classList.contains('hidden') === false;
            const timeleft = Number(el.querySelector('.mission_overview_countdown')?.getAttribute('timeleft') || 0);
            const reqs = parseRequirements(el, id);
            // Gelbe Einsätze mit fehlenden Fahrzeugen: standardmäßig nachalarmieren (handleYellow)
            if (!CONFIG.handleYellow && isYellow && reqs.length > 0) continue;
            const caption = el.querySelector(`#mission_caption_${id}`)?.textContent?.trim().split(',')[0] || id;

            // Sicherheitswachen: erst kurz vor Beginn alarmieren, sonst stehen Fahrzeuge stundenlang gebunden
            if (kind === 'sw' && timeleft > CONFIG.swLeadTime) {
                if (!swAnnounced.has(id)) {
                    swAnnounced.add(id);
                    const when = new Date(Date.now() + timeleft - CONFIG.swLeadTime);
                    log(`⏰ [#${id}] ${caption}: Sicherheitswache erkannt – Alarm ca. ${when.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr`, '#89b4fa');
                }
                dbg(`[#${id}] ${caption}: Sicherheitswache, Beginn in ${Math.round(timeleft / 60000)} min – warte (Vorlauf ${CONFIG.swLeadTime / 60000} min)`);
                continue;
            }
            // Krankentransporte mit Countdown: noch nicht fällig
            if (kind === 'kt' && timeleft > 0) {
                dbg(`[#${id}] ${caption}: Krankentransport in ${Math.round(timeleft / 60000)} min – warte`);
                continue;
            }

            let mode = null;
            let useReqs = reqs;
            if (reqs.length) mode = 'requirements';
            else if (kind === 'kt' && isRed && !participating) mode = 'kt';
            else if (kind === 'normal' && isRed && !participating) {
                // Sofort-Dispatch: Anforderungen aus dem Einsatztyp vorhersagen statt ELW vorzuschicken
                const typeId = el.getAttribute('mission_type_id');
                const predicted = (CONFIG.predictive && typeId) ? predictRequirements(typeId, id) : null;
                if (predicted) {
                    mode = 'requirements';
                    useReqs = predicted;
                    dbg(`[#${id}] ${caption}: Sofort-Dispatch (Typ ${typeId}): ` +
                        predicted.map(r => `${r.count}x ${r.caption} → [${r.typeIds.join(',')}]`).join('; '));
                } else {
                    mode = 'elw';
                }
            }
            if (!mode) continue;

            const signature = mode + '|' + useReqs.map(r => `${r.count}x${r.caption}`).join(';');
            const st = state.get(id);
            const cd = (st && st.lastEmpty) ? CONFIG.retryEmptyCooldown : CONFIG.cooldown;
            if (st && st.signature === signature && Date.now() - st.lastAction < cd) continue;
            if (st && st.signature === signature && (mode === 'elw' || mode === 'kt')) continue;

            // Debug: Erkennung jedes relevanten Einsatzes protokollieren
            dbgv(`[#${id}] ${caption}: mode=${mode}, rot=${isRed}, beteiligt=${participating}; ` +
                (useReqs.length ? 'Anforderungen: ' + useReqs.map(r => `${r.count}x ${r.caption} → [${(r.typeIds || []).join(',') || '?'}]`).join('; ') : 'keine Anforderungen'));

            result.push({ id, caption, mode, reqs: useReqs, signature });
        }
        }
        return result;
    }

    // Erledigte Einsätze zählen: IDs, die wir zuvor als eigene aktive Einsätze kannten
    // (rot/gelb/grün, an denen wir beteiligt waren) und die jetzt nicht mehr in der Liste stehen.
    function updateCompletedStats() {
        const nowActive = new Set();
        for (const el of document.querySelectorAll('#mission_list .missionSideBarEntry')) {
            const id = el.getAttribute('mission_id');
            if (!id || el.style.display === 'none') continue;
            // nur eigene Einsätze, an denen wir beteiligt sind (sonst zählen wir fremde mit)
            const participating = el.querySelector(`#mission_participant_${id}`)?.classList.contains('hidden') === false;
            if (participating) nowActive.add(id);
        }
        // Dauer-Tracking: neue Einsätze mit Startzeit + Name registrieren
        let startsChanged = false;
        for (const id of nowActive) {
            if (!missionStarts[id]) {
                const capEl = document.getElementById(`mission_caption_${id}`);
                let caption = '?';
                if (capEl) {
                    const c = capEl.cloneNode(true);
                    c.querySelectorAll('small').forEach(x => x.remove());
                    caption = c.textContent.replace(/,\s*$/, '').replace(/\s+/g, ' ').trim().slice(0, 60) || '?';
                }
                missionStarts[id] = { ts: Date.now(), caption };
                startsChanged = true;
            }
        }
        let finished = 0;
        for (const id of knownActive) {
            if (!nowActive.has(id) && !document.querySelector(`.missionSideBarEntry[mission_id="${id}"]`)) {
                finished++;
                const st = missionStarts[id];
                if (st && st.ts) { // Dauer je Einsatztyp verbuchen
                    const d = durationStats.types[st.caption] || (durationStats.types[st.caption] = { n: 0, sum: 0, max: 0 });
                    d.n++; d.sum += Date.now() - st.ts; d.max = Math.max(d.max, Date.now() - st.ts);
                    delete missionStarts[id];
                    startsChanged = true;
                }
            }
        }
        if (finished > 0) {
            stats.completed += finished;
            persistStats();
            log(`🏁 ${finished} Einsatz${finished > 1 ? 'e' : ''} abgeschlossen (gesamt ${stats.completed})`, '#a6e3a1');
        }
        if (startsChanged) persistDurations();
        knownActive = nowActive;
        renderStats();
    }

    // Checkbox -> einfaches Objekt inkl. Entfernungs-Sortwert (aus der Tabellenzeile)
    let boxMissionCoords = null; // von loadVehicleBoxes gesetzt; boxToItem nutzt sie für die ETA-Schätzung
    function boxToItem(b) {
        let sort = 999999;
        let building = null;
        try {
            // Robust über Element-IDs statt closest('tr'): Der "Mehr Fahrzeuge laden"-Nachladepfad
            // liefert nackte <tr>-Schnipsel, die der HTML-Parser auflöst – closest('tr') läuft dann
            // ins Leere (Befund 10.07.: "ohne ETA: 13/13"). Die IDs vehicle_sort_<id> und
            // vehicle_element_content_<id> überleben die Umstrukturierung.
            const od = b.ownerDocument || document;
            const ownTr = b.closest('tr');
            const sv = (ownTr && ownTr.querySelector('td[sortvalue]'))
                || od.getElementById('vehicle_sort_' + b.value); // Fallback (ID-Suche kann bei Fragmenten auf die Hauptseite zeigen -> nur wenn kein tr da ist)
            if (sv) {
                const raw = Number(sv.getAttribute('sortvalue'));
                if (Number.isFinite(raw) && raw >= 0 && raw < 900000) sort = raw;
            }
            const tr = ownTr || od.getElementById('vehicle_element_content_' + b.value);
            building = (tr && tr.getAttribute('building')) || null;
            // sortvalue fehlt im rohen HTML (wird erst vom Spiel-JS berechnet) -> selbst rechnen:
            // Wachen-Koordinaten stehen serverseitig an der Zeile (data-lat/data-lon), Missions-
            // koordinaten kommen aus extractMissionCoords. Ø-Tempo kalibriert an realem Wert
            // (MTF Drohne: 12,8 km in 634 s ≈ 72,5 km/h).
            if (sort >= 900000 && tr && boxMissionCoords) {
                const vla = parseFloat(tr.getAttribute('data-lat')), vlo = parseFloat(tr.getAttribute('data-lon'));
                if (Number.isFinite(vla) && Number.isFinite(vlo)) {
                    const km = haversineKm(vla, vlo, boxMissionCoords.lat, boxMissionCoords.lng);
                    sort = Math.round(km / (CONFIG.travelSpeedKmh || 72.5) * 3600);
                }
            }
        } catch (e) { /* egal */ }
        const isTrailer = b.getAttribute('trailer') === '1';
        const tractive = b.getAttribute('tractive_vehicle_id');
        const tractiveRandom = b.getAttribute('tractive_random') === '1';
        // Harte Absicherung: disabled-Checkboxen können NICHT alarmiert werden (z.B. Anhänger ohne
        // freies Trägerfahrzeug). Über manche Nachladepfade rutschen sie trotz :not([disabled])-Selektor
        // durch -> hier zusätzlich am Attribut erkennen und später ausfiltern.
        const isDisabled = b.hasAttribute('disabled') || b.getAttribute('disabled') === 'disabled';
        // possible_tractive = Liste der Fahrzeugtyp-IDs, die diesen Anhänger ziehen können (z.B. [64,63]).
        let possibleTractive = [];
        try { possibleTractive = JSON.parse(b.getAttribute('possible_tractive') || '[]'); } catch (e) { /* egal */ }
        // Rettungswinde: genau die anklickbare Instanz ermitteln (Checkbox ohne disabled),
        // Standard-Winde bevorzugen – entspricht dem manuellen "Anklicken" im Formular
        let winchEq = null;
        try {
            const tr2 = b.closest('tr');
            for (const cb of (tr2?.querySelectorAll('input.equipment-checkbox[data-equipment-caption="Rettungswinde"]:not([disabled])') || [])) {
                const eid = cb.getAttribute('data-equipment-id');
                if (!winchEq || cb.getAttribute('data-equipment-is-default') === 'true') winchEq = eid;
            }
        } catch (e) { /* egal */ }
        // building_id (Checkbox), kann zusammengesetzt sein: "<wache>_<leitstelle>"
        const buildingId = b.getAttribute('building_id') || (b.closest('tr') && b.closest('tr').getAttribute('building_id')) || null;
        return {
            value: b.value,
            typeId: Number(b.getAttribute('vehicle_type_id')),
            sort,
            eta: sort < 900000 ? sort : null, // Anfahrtszeit in Sekunden (sortvalue=timevalue); 999999 = unbekannt/Anhänger; 0 = gleiche Wache
            building,
            buildingId,
            isTrailer,
            isDisabled,
            // Konkretes Trägerfahrzeug, das das Spiel diesem Anhänger zuordnet (ID einer Fahrzeuginstanz).
            // Wird beim Alarm explizit mitgesendet – der Server hängt es sonst NICHT zuverlässig an
            // (z.B. Boot/MZB). Bei tractive_random kann die ID veralten -> wird vor dem Senden gegen
            // die aktuelle Fahrzeugliste geprüft (siehe pick()).
            tractiveId: (isTrailer && tractive && tractive !== '0') ? tractive : null,
            possibleTractive,
            tractiveRandom,
            // Anhänger ohne jegliches Trägerfahrzeug (tractive=0, nicht random) kann nicht fahren.
            noTractive: isTrailer && !tractiveRandom && (!tractive || tractive === '0'),
            winchEq,
            hasRescueLift:
            b.getAttribute('lift') === '1'
            || (b.getAttribute('data-equipment-types') || '').includes('rescue_lift')
            || !!winchEq,
        };
    }

    // Luftlinien-Distanz in km (Haversine)
    function haversineKm(lat1, lon1, lat2, lon2) {
        const R = 6371, toRad = (d) => d * Math.PI / 180;
        const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(a));
    }

    // Missionskoordinaten aus der Einsatzseite ziehen. Mehrere Muster, weil das Markup variieren kann;
    // welches griff, steht im Debug-Log (Selbstdiagnose).
    function extractMissionCoords(doc, html) {
        const map = doc.getElementById('mission_map') || doc.querySelector('[data-latitude][data-longitude]');
        if (map) {
            const la = parseFloat(map.getAttribute('data-latitude')), lo = parseFloat(map.getAttribute('data-longitude'));
            if (Number.isFinite(la) && Number.isFinite(lo)) return { lat: la, lng: lo, src: 'data-attr' };
        }
        for (const re of [
            /latitude["']?\s*[:=]\s*["']?(-?\d{1,2}\.\d+)["']?\s*,\s*["']?longitude["']?\s*[:=]\s*["']?(-?\d{1,3}\.\d+)/i,
            /setView\(\s*\[\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*\]/i,
            /L\.marker\(\s*\[\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*\]/i,
        ]) {
            const m = html.match(re);
            if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]), src: re.source.slice(0, 20) };
        }
        return null;
    }

    async function loadVehicleBoxes(missionId) {
        const res = await fetch(`/missions/${missionId}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status} (Einsatzseite)`);
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        // Missionskoordinaten für die Fahrzeit-Schätzung (sortvalue wird erst vom Spiel-JS berechnet
        // und fehlt im rohen HTML – wir rechnen selbst: Haversine + Ø-Geschwindigkeit).
        const missionCoords = extractMissionCoords(doc, html);
        if (missionCoords) dbgv(`[#${missionId}] Missionskoordinaten: ${missionCoords.lat.toFixed(5)}, ${missionCoords.lng.toFixed(5)} (Quelle: ${missionCoords.src})`);
        else dbg(`[#${missionId}] ⚠️ Missionskoordinaten NICHT gefunden – Fahrzeit-Telemetrie für diesen Einsatz ohne Daten`);
        boxMissionCoords = missionCoords; // Closure-Variable für boxToItem (nur innerhalb dieses Aufrufs relevant)

        const token = doc.querySelector('form[action*="alarm"] input[name="authenticity_token"]')?.value
                   || doc.querySelector('meta[name="csrf-token"]')?.content;
        if (!token) throw new Error('Kein CSRF-Token gefunden');

        // Bereits zu diesem Einsatz fahrende/anwesende eigene Fahrzeuge je Typ zählen.
        // Das ist die verlässliche Wahrheit – unabhängig von Reloads, Stop/Start oder mehreren Tabs.
        // WICHTIG: am Einsatz (at_mission) und fahrend (driving) getrennt halten:
        //  - "Fehlende Fahrzeuge" (fromMissing) hat die ANGEKOMMENEN bereits abgezogen -> die dürfen
        //    NICHT erneut gegengerechnet werden (sonst gilt eine Eskalation fälschlich als gedeckt).
        //  - Die FAHRENDEN sind dort NICHT abgezogen (Anzeige sinkt erst bei Ankunft) -> die MÜSSEN
        //    angerechnet werden, sonst sendet das Script nach Ablauf des 10-min-Gedächtnisses doppelt
        //    (z.B. 42 GruKw statt 18, weil Bereitschaftspolizei länger als 10 min unterwegs ist).
        const enRoute = {};        // typeId -> Anzahl (am Einsatz + fahrend) – für Vorhersage-Anforderungen
        const enRouteDriving = {}; // typeId -> Anzahl (NUR fahrend) – für "Fehlende Fahrzeuge"
        for (const a of doc.querySelectorAll('#mission_vehicle_at_mission a[vehicle_type_id]')) {
            const t = Number(a.getAttribute('vehicle_type_id'));
            if (!isNaN(t)) enRoute[t] = (enRoute[t] || 0) + 1;
        }
        for (const a of doc.querySelectorAll('#mission_vehicle_driving a[vehicle_type_id]')) {
            const t = Number(a.getAttribute('vehicle_type_id'));
            if (!isNaN(t)) { enRoute[t] = (enRoute[t] || 0) + 1; enRouteDriving[t] = (enRouteDriving[t] || 0) + 1; }
        }

        const items = new Map(); // vehicleId -> item
        const addBoxes = (list) => { for (const b of list) { const it = boxToItem(b); if (!items.has(it.value)) items.set(it.value, it); } };
        addBoxes(doc.querySelectorAll('.vehicle_checkbox:not([disabled])'));
        const staticCount = items.size;

        // "Fahrzeuganzeige begrenzt! Mehr Fahrzeuge laden!" IMMER abarbeiten
        const more = doc.querySelector('a.missing_vehicles_load');
        let loadPath = more ? '' : 'kein Nachlade-Button';
        if (more) {
            let extra = [];
            // 1) Direkt fetchen (Antwort kann HTML ODER ein Rails-JS-Snippet mit escaped HTML sein)
            try {
                const r2 = await fetch(more.getAttribute('href'), {
                    credentials: 'same-origin',
                    headers: { 'X-Requested-With': 'XMLHttpRequest' }
                });
                if (r2.ok) {
                    const txt = await r2.text();
                    // WICHTIG (v5.36): Die Antwort enthält <tr>-Schnipsel OHNE umgebende <table>.
                    // DOMParser verwirft Tabellenelemente außerhalb einer Tabelle KOMPLETT (inkl.
                    // sortvalue/Wachenname) – deshalb in einen Tabellenkontext einbetten. <template>
                    // erlaubt beliebige Fragmente und erhält tr/td unverändert.
                    const parseFragment = (html) => {
                        const tpl = document.createElement('template');
                        tpl.innerHTML = html;
                        if (tpl.content.querySelector('.vehicle_checkbox')) return tpl.content;
                        // Fallback: explizit als Tabelleninhalt parsen
                        const tpl2 = document.createElement('template');
                        tpl2.innerHTML = `<table><tbody>${html}</tbody></table>`;
                        return tpl2.content;
                    };
                    let root = parseFragment(txt);
                    let found = root.querySelectorAll('.vehicle_checkbox:not([disabled])');
                    if (!found.length && txt.includes('vehicle_checkbox')) {
                        // JS-Antwort: HTML steckt escaped im Script -> entpacken und erneut parsen
                        const un = txt
                            .replace(/\\u003c/gi, '<').replace(/\\u003e/gi, '>').replace(/\\u0026/gi, '&')
                            .replace(/\\"/g, '"').replace(/\\'/g, "'")
                            .replace(/\\\//g, '/').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
                        root = parseFragment(un);
                        found = root.querySelectorAll('.vehicle_checkbox:not([disabled])');
                    }
                    extra = [...found];
                    loadPath = `fetch lieferte ${extra.length}`;
                }
            } catch (e) { loadPath = 'fetch fehlgeschlagen'; }

            // 2) Fallback: Einsatzseite im iframe laden und den Button vom Spiel-JS klicken lassen
            if (!extra.length) {
                const frame = await loadViaIframe(`/missions/${missionId}`,
                    d => d.querySelector('.vehicle_checkbox') || d.querySelector('a.missing_vehicles_load'));
                if (frame) {
                    try {
                        const d = frame.doc;
                        const btn = d.querySelector('a.missing_vehicles_load');
                        if (btn) {
                            const before = d.querySelectorAll('.vehicle_checkbox').length;
                            btn.click();
                            const t0 = Date.now();
                            while (Date.now() - t0 < 8000) {
                                await sleep(300);
                                const now = d.querySelectorAll('.vehicle_checkbox').length;
                                if (now > before || !d.querySelector('a.missing_vehicles_load')) break;
                            }
                        }
                        const fromFrame = [...d.querySelectorAll('.vehicle_checkbox:not([disabled])')].map(b => boxToItem(b));
                        for (const it of fromFrame) if (!items.has(it.value)) items.set(it.value, it);
                        loadPath += `${loadPath ? ' + ' : ''}iframe lieferte ${fromFrame.length}`;
                        extra = []; // bereits gemergt
                    } finally { frame.cleanup(); }
                }
            }
            addBoxes(extra);
        }

        // Nach Entfernung sortieren, damit immer das nächste Fahrzeug gewählt wird
        const boxes = [...items.values()].sort((a, b) => a.sort - b.sort);
        const enRouteTotal = Object.values(enRoute).reduce((a, b) => a + b, 0);
        dbg(`[#${missionId}] Fahrzeugliste: ${staticCount} statisch, gesamt ${boxes.length} (${loadPath}); ${enRouteTotal} eigene bereits unterwegs/vor Ort`);
        return { token, boxes, enRoute, enRouteDriving };
    }

    // Übersicht: wie viele Boxen je Typ-ID vorhanden sind (für Debug-Ausgaben)
    function countByType(boxes, typeIds) {
        const counts = {};
        for (const t of typeIds) counts[t] = 0;
        for (const b of boxes) if (typeIds.includes(b.typeId)) counts[b.typeId]++;
        return Object.entries(counts).map(([t, n]) => `${t}:${n}`).join(' ');
    }

    // Gefangene, die ein eigenes Fahrzeug VOR ORT am Einsatz hält, direkt zur Zelle schicken.
    // Manche Gefangenen lösen KEINEN Funk-Sprechwunsch aus – die Zellen-Buttons liegen dann direkt
    // auf der Einsatzseite (/vehicles/<fzg>/gefangener/<id>). Dieser Weg ergänzt den Sprechwunsch-Pfad.
    async function transportPrisonersAtMission(missionId) {
        let sent = 0;
        try {
            let doc = null;
            const res = await fetch(`/missions/${missionId}`, { credentials: 'same-origin' });
            if (res.ok) doc = new DOMParser().parseFromString(await res.text(), 'text/html');
            // Zellen-Buttons evtl. erst per iframe (Spiel-JS) verfügbar
            if (!doc || !collectPrisonLinks(doc).length) {
                const frame = await loadViaIframe(`/missions/${missionId}`,
                    d => collectPrisonLinks(d).length > 0, 15000);
                if (frame) { doc = frame.doc; }
                else if (!doc) return 0;
            }
            const links = collectPrisonLinks(doc);
            if (!links.length) return 0;
            // Links nach haltendem Fahrzeug + Gefangenem gruppieren (href: /vehicles/<fzg>/gefangener/<gid>)
            const byPrisoner = new Map();
            for (const a of links) {
                const m = (a.getAttribute('href') || '').match(/\/vehicles\/(\d+)\/gefangener\/(\d+)/);
                if (!m) continue;
                const key = `${m[1]}:${m[2]}`;
                if (!byPrisoner.has(key)) byPrisoner.set(key, []);
                byPrisoner.get(key).push(a);
            }
            if (CONFIG.prisonerDiagnostics) dbg(`[#${missionId}] vor Ort: ${byPrisoner.size} transportbereite Gefangene`);
            for (const [key, group] of byPrisoner) {
                if (sent >= CONFIG.maxPrisonerTransportsPerScan) break;
                const cells = parsePrisonLinks(group).filter(p => p.green && p.free > 0);
                const pick = cells.filter(p => p.tax === 0).sort((a, b) => a.distance - b.distance)[0]
                          || cells.filter(p => p.tax <= CONFIG.maxAllianceTax).sort((a, b) => a.distance - b.distance)[0];
                if (!pick) {
                    if (CONFIG.prisonerDiagnostics) dbg(`[#${missionId}] Gefangener ${key}: keine grüne Zelle (${group.length} Optionen)`);
                    continue;
                }
                const go = await fetch(pick.href, { credentials: 'same-origin' });
                if (go.status === 409) { if (CONFIG.prisonerDiagnostics) dbg(`[#${missionId}] Gefangener ${key}: Zelle belegt (409)`); continue; }
                if (!go.ok) { if (CONFIG.prisonerDiagnostics) dbg(`[#${missionId}] Gefangener ${key}: HTTP ${go.status}`); continue; }
                sent++;
                log(`🚔 [#${missionId}] Gefangener → ${pick.name} (${pick.distance} km${pick.tax ? ', Abgabe ' + pick.tax + '%' : ''})`, '#a6e3a1');
                await sleep(jitter(CONFIG.transportDelay));
            }
        } catch (e) {
            dbg(`[#${missionId}] Gefangenen-Direkttransport fehlgeschlagen: ${e.message}`);
        }
        return sent;
    }

    async function dispatch(mission) {
        const { token, boxes: allBoxes, enRoute, enRouteDriving } = await loadVehicleBoxes(mission.id);
        // Fahrzeuge, die in diesem Scan-Durchlauf bereits für einen anderen Einsatz alarmiert wurden,
        // hier ausschließen – sonst würde dasselbe (knappe) Fahrzeug doppelt verplant.
        const boxes = allBoxes.filter(b => !alarmedThisScan.has(b.value));
        const picked = [];
        const pickedSet = new Set();
        const byId = new Map(boxes.map(b => [b.value, b]));
        const equipToSend = {}; // vehicleId -> equipmentId (z. B. Rettungswinde)
        const sent = { ...((state.get(mission.id) || {}).sent || {}) }; // caption -> {count, ts}
        const notes = [];
        const trailerMemKeys = new Set(); // memKeys, deren Alarm einen Anhänger enthielt (für Fehlschlag-Rücknahme)
        const auditReqs = []; // [AUDIT] pro Anforderung: { cap, need (Wellen-Bedarf), already, got }

        let hitVehicleLimit = false;
        let etaCapSkipped = 0; // Kandidaten, die am ETA-Deckel (maxTravelSec) gescheitert sind
        let verSkipped = 0;    // übersprungene Verbandsfahrzeuge anderer Mitglieder ("(VER)")
        let manualSkipped = 0; // übersprungene Fahrzeuge von der manuellen Sperrliste
        let cityOnlySkipped = 0; // übersprungene Nicht-Innenstadt-Fahrzeuge (cityOnly)
        loadManualBlacklist(); // frisch je Welle – Änderungen (auch aus anderem Tab) greifen sofort
        loadCityBuildingCache(); // Innenstadt-Gebäudecache (kann vom TV-Skript aktualisiert worden sein)
        const cityCfg = cityConfig();
        const pick = (typeIds, count, label, silent = false) => {
            // DIAGNOSE: bei Anhänger-Anforderungen alle Kandidaten mit Status auflisten (Fehlersuche)
            if (CONFIG.alarmDiagnostics) {
                const trailerCands = boxes.filter(b => typeIds.includes(b.typeId) && b.isTrailer);
                if (trailerCands.length) {
                    const desc = trailerCands.slice(0, 8).map(b =>
                        `${b.value}(sort${b.sort}${b.isDisabled ? ',disabled' : ''}${b.tractiveRandom ? ',random' : ''}${b.tractiveId ? ',träger=' + b.tractiveId : ''})`).join(' ');
                    dbg(`[#${mission.id}] Anhänger-Kandidaten Typ ${typeIds.join('/')}: ${desc}`);
                }
            }
            let got = 0;
            for (const b of boxes) {
                if (got >= count) break;
                if (picked.length >= CONFIG.maxVehiclesPerAlarm) { hitVehicleLimit = true; break; }
                const needsRthLift = typeIds.includes('RTH-Winde');

                if (
                    pickedSet.has(b.value)
                    || b.isDisabled  // nicht alarmierbar (z.B. Anhänger ohne freien Träger) – harte Absicherung
                    || b.noTractive  // Anhänger ohne verfügbares Trägerfahrzeug -> kann nicht fahren
                    || (() => { // Umleitungs-Schutz: kürzlich an einen ANDEREN Einsatz alarmiert?
                        const va = vehicleAlarmed.get(b.value) || vehicleAlarmed.get(String(b.value));
                        return va && String(va.missionId) !== String(mission.id)
                            && Date.now() - va.ts < CONFIG.vehicleRealarmGuard;
                    })()
                    || (() => { // Problemfahrzeug-Sperre: fuhr mehrfach in Folge nicht los
                        const vf = vehicleFails.get(String(b.value));
                        return vf && vf.blockedUntil && vf.blockedUntil > Date.now();
                    })()
                    || (Number.isFinite(b.eta) && b.eta > (CONFIG.maxTravelSec || Infinity) && (etaCapSkipped++, true)) // ETA-Deckel: absurde Anfahrten (ferne Verbandseinsätze) gar nicht erst antreten
                    || (!CONFIG.useVerbandVehicles && b.building && b.building.includes('(VER)') && (verSkipped++, true)) // Verbandsfahrzeuge anderer Mitglieder nicht verplanen
                    || (manualBlacklist.has(String(b.value)) && (manualSkipped++, true)) // manuelle Sperrliste (Panel-Button 🚫)
                    || (CONFIG.cityOnly && cityCfg.leitstellen.length && !isCityBox(b, cityCfg) && (cityOnlySkipped++, true)) // nur Innenstadt-Leitstelle für eigene Einsätze
                    || (
                        needsRthLift
                        // Windenrettung: jedes Fahrzeug mit Rettungswinde zählt – RTH (31) mit anklickbarer
                        // Winde ODER Polizeihubschrauber (156/61) mit fest verbauter Winde (lift="1").
                        ? !b.hasRescueLift
                        : !typeIds.includes(b.typeId)
                    )
                ) continue;
                // Anhänger-Logik (zwei Fälle, anhand der Spiel-Attribute unterschieden):
                if (b.isTrailer) {
                    // Cooldown nach Server-Ablehnung: hat das Spiel diesen Anhänger-Typ für diesen
                    // Einsatz zuletzt mit "Trägerfahrzeug nicht verfügbar" abgelehnt, erst nach Ablauf
                    // erneut versuchen (Träger muss erst wieder frei werden) statt jede Runde zu alarmieren.
                    const retryKey = `${mission.id}:${typeIds.slice().sort().join(',')}`;
                    const retryAt = trailerRetryAfter.get(retryKey);
                    if (retryAt && retryAt > Date.now()) {
                        dbg(`[#${mission.id}] Anhänger ${b.value} (Typ ${b.typeId}): Server-Ablehnungs-Cooldown noch ${Math.ceil((retryAt - Date.now()) / 60000)} min – übersprungen`);
                        continue;
                    }
                    // Zwei Fälle:
                    // a) Bestimmte Zufallsträger-Anhänger werden ALLEINE gesendet – das Spiel hängt beim
                    //    Alarmieren selbst ein freies Zugfahrzeug an (z.B. Anh SwPu, Außenlastbehälter,
                    //    Boot/MZB). Welche Typen das dürfen, steht in CONFIG.soloTrailerTypeIds. Ist kein
                    //    Träger frei, sperrt das Spiel die Checkbox (isDisabled) -> oben schon aussortiert.
                    // b) Alle anderen Anhänger mit FESTEM Träger: das zugeordnete Trägerfahrzeug
                    //    (tractive_vehicle_id) MUSS explizit mitgesendet werden, sonst fährt das Gespann
                    //    nicht ("Trägerfahrzeug nicht verfügbar").
                    if (b.tractiveRandom && CONFIG.soloTrailerTypeIds.includes(b.typeId)) {
                        pickedSet.add(b.value); picked.push(b.value);
                        trailerMemKeys.add(typeIds.slice().sort().join(','));
                        dbg(`[#${mission.id}] Anhänger ${b.value} (Typ ${b.typeId}): alleine alarmiert (Spiel wählt Zugfahrzeug)`);
                        got++;
                        continue;
                    }
                    const tractor = (b.tractiveId && byId.has(b.tractiveId)
                        && !pickedSet.has(b.tractiveId) && !byId.get(b.tractiveId).isDisabled)
                        ? b.tractiveId : null;
                    if (!tractor || picked.length + 2 > CONFIG.maxVehiclesPerAlarm) {
                        dbg(`[#${mission.id}] Anhänger ${b.value} (Typ ${b.typeId}): kein zugeordnetes Trägerfahrzeug frei – übersprungen`);
                        continue;
                    }
                    pickedSet.add(b.value); picked.push(b.value);
                    pickedSet.add(tractor); picked.push(tractor);
                    trailerMemKeys.add(typeIds.slice().sort().join(','));
                    dbg(`[#${mission.id}] Anhänger ${b.value} (Typ ${b.typeId}): mit zugeordnetem Trägerfahrzeug ${tractor} alarmiert`);
                    got++;
                    continue;
                }
                pickedSet.add(b.value);
                picked.push(b.value);
                // Windenanforderung: anklickbare Rettungswinde dieses RTH "anklicken" (mitsenden)
                if (needsRthLift && b.winchEq) equipToSend[b.value] = b.winchEq;
                got++;
            }
            if (got < count && !silent) {
                notes.push(`${label}: nur ${got}/${count} verfügbar`);
                if (typeIds.includes('RTH-Winde')) {
                    const rth = boxes.filter(b => b.typeId === 31);
                    dbg(`[#${mission.id}] ${label}: RTH gesamt ${rth.length}, davon mit Winde ${rth.filter(b => b.hasRescueLift).length}`);
                } else {
                    dbg(`[#${mission.id}] ${label}: gesucht [${typeIds.join(',')}], Bestand: ${countByType(boxes, typeIds.filter(t => typeof t === 'number')) || 'keiner'}`);
                }
            }
            return got;
        };

        if (mission.mode === 'kt') {
            // Krankentransport: Typen der Reihe nach versuchen (Standard: KTW, dann RTW)
            for (const name of CONFIG.ktVehicles) {
                const ids = resolveTypeIds(name);
                if (!ids || !ids.length) { notes.push(`KT-Typ „${name}" unbekannt`); continue; }
                if (pick(ids, 1, name)) {
                    if (name !== CONFIG.ktVehicles[0]) notes.push(`${CONFIG.ktVehicles[0]} nicht frei – ${name} geschickt`);
                    break;
                }
            }
        } else if (mission.mode === 'elw') {
            let got = pick(CONFIG.elwTypeIds, 1, 'ELW');
            if (!got) {
                // Kein ELW frei -> Fallback-Typen probieren (z. B. GW-Bergrettung)
                for (const name of CONFIG.elwFallbacks) {
                    const ids = resolveTypeIds(name);
                    if (!ids || !ids.length) { notes.push(`Fallback „${name}" unbekannt`); continue; }
                    got = pick(ids, 1, name);
                    if (got) { notes.push(`ELW nicht frei – ${name} geschickt`); break; }
                }
            }
        } else {
            // Trägertyp-bewusste Deckung (v5.38): Jeder mitgeforderte Anhänger bringt genau EIN
            // Zugfahrzeug mit – aber welcher TYP das ist, hängt am fest zugeordneten Träger des
            // konkreten Anhängers. Wir sagen daher voraus, welche Anhänger der Picker wählen wird,
            // und rechnen deren Trägertypen exakt gegen die Träger-Anforderungen (Beleg 09.07. MANV:
            // beide gewählten Anhänger brachten GW-TeSi -> MTW-TeSi ging leer aus, wurde aber als
            // "gedeckt" übersprungen). Für bereits fahrende Anhänger (keine Kandidaten mehr sichtbar)
            // bleibt die typ-agnostische Deckung als Joker erhalten.
            const towPredictions = {}; // trailerType -> { <towTypeId>: n, _wild: n }
            const predictTows = (trailerType, trailerNeed) => {
                if (towPredictions[trailerType]) return towPredictions[trailerType];
                const cands = allBoxes
                    .filter(x => x.isTrailer && x.typeId === trailerType && !x.isDisabled
                        && !manualBlacklist.has(String(x.value))
                        && !((vehicleFails.get(String(x.value)) || {}).blockedUntil > Date.now()))
                    .sort((a, b) => a.sort - b.sort)
                    .slice(0, trailerNeed);
                const map = { _wild: Math.max(0, trailerNeed - cands.length) }; // fahrende/unsichtbare Anhänger: Typ unbekannt -> Joker
                for (const c of cands) {
                    const towType = c.tractiveId ? (byId.get(c.tractiveId) || {}).typeId : null;
                    if (Number.isFinite(towType)) map[towType] = (map[towType] || 0) + 1;
                    else map._wild++;
                }
                dbg(`[#${mission.id}] Träger-Vorhersage Anhänger-Typ ${trailerType}: ${Object.entries(map).map(([k, v]) => `${k === '_wild' ? 'unbekannt' : vtName(Number(k))}×${v}`).join(', ')}`);
                return (towPredictions[trailerType] = map);
            };
            for (const r of mission.reqs) {
                if (CONFIG.ignoreRequirements.some(n => norm(r.caption) === norm(n))) {
                    dbg(`[#${mission.id}] ${r.caption}: auf Ignorier-Liste – übersprungen`);
                    continue;
                }
                if (!r.typeIds || !r.typeIds.length) {
                    notes.push(`„${r.caption}" unbekannt – bitte ins Mapping aufnehmen`);
                    continue;
                }
                // Zugfahrzeug durch mitgeforderten Anhänger abgedeckt?
                if (r.typeIds.length === 1 && CONFIG.tractorCoveredByTrailer[r.typeIds[0]] != null) {
                    const tractorType = r.typeIds[0];
                    const trailerType = CONFIG.tractorCoveredByTrailer[tractorType];
                    let trailerCount = 0;
                    for (const o of mission.reqs) if (o !== r && (o.typeIds || []).includes(trailerType)) trailerCount += (o.count || 1);
                    if (trailerCount > 0) {
                        const pred = predictTows(trailerType, trailerCount);
                        const exact = Math.min(r.count, pred[tractorType] || 0);
                        if (exact > 0) pred[tractorType] -= exact;
                        const wild = Math.min(r.count - exact, pred._wild || 0);
                        if (wild > 0) pred._wild -= wild;
                        const covered = exact + wild;
                        if (covered >= r.count) {
                            dbg(`[#${mission.id}] ${r.caption}: wird vom mitgeforderten Anhänger (Typ ${trailerType}) automatisch mitgebracht – übersprungen (${exact}x exakter Trägertyp, ${wild}x Joker)`);
                            continue;
                        }
                        if (covered > 0) {
                            r.count -= covered; // Rest explizit bedienen
                            dbg(`[#${mission.id}] ${r.caption}: ${covered}x durch Anhänger (Typ ${trailerType}) gedeckt, ${r.count}x wird explizit alarmiert`);
                        } else {
                            dbg(`[#${mission.id}] ${r.caption}: gewählte Anhänger bringen andere Trägertypen mit – ${r.count}x wird explizit alarmiert`);
                        }
                    }
                }
                // Personal: Kräfte -> Fahrzeuge umrechnen und bereits gewählte passende Fahrzeuge anrechnen
                let need = r.count;
                if (r.fromPersonnel) {
                    if (ONE_VEHICLE_COVERS.some(n => norm(r.caption).includes(norm(n)))) {
                        need = 1; // ein Fahrzeug mit passend ausgebildeter Besatzung genügt
                    } else if (norm(r.caption).includes(norm('Betreuungshelfer'))) {
                        need = Math.ceil(need / CREW_PER_CARE_VEHICLE); // Mengen-Anforderung: Helfer -> Betreuungsfahrzeuge
                    } else {
                        need = Math.ceil(need / CONFIG.crewPerVehicle);
                    }
                    const covered = picked.filter(v => { const b = byId.get(v); return b && r.typeIds.includes(b.typeId); }).length;
                    if (covered) { dbg(`[#${mission.id}] ${r.caption}: ${covered} passende Fahrzeuge bereits in dieser Welle`); }
                    need = Math.max(0, need - covered);
                }
                // Über-Alarmierungs-Bremse: kürzlich für diese Anforderung gesendete Fahrzeuge anrechnen,
                // denn "Fehlende Fahrzeuge" sinkt erst, wenn sie ANKOMMEN.
                // Schlüssel über sortierte Typ-IDs -> funktioniert auch, wenn dieselbe Anforderung
                // mal als Vorhersage (engl. caption) und mal als "Fehlende Fahrzeuge" (dt. caption) kommt.
                // Über-Alarmierungs-Bremse: Die "Fehlende Fahrzeuge"-Anzeige ist TRÄGE – sie sinkt erst
                // bei ANKUNFT, nicht bei Alarmierung (im Log: 11 Scans lang konstant "18 LF").
                // Daher immer anrechnen, was schon unterwegs ist. Beste Schätzung = Maximum aus:
                //   - onSite: tatsächlich an/zur Einsatzstelle gezählte Fahrzeuge dieser Typen (Wahrheit)
                //   - remembered: was diese Script-Instanz kürzlich selbst geschickt hat (deckt die
                //     Lücke, solange die Fahrzeuge noch nicht in der Einsatztabelle auftauchen)
                // memKey trennt verschiedene Anforderungsarten, auch wenn sie auf dieselben Fahrzeugtypen
                // auflösen: Eine "1x Feuerwehrmann"-Personalanforderung (durch irgendein LF erfüllbar) darf
                // NICHT denselben Schlüssel wie eine "firetrucks"-Fahrzeuganforderung teilen – sonst gilt
                // der Feuerwehrmann fälschlich als gedeckt, weil vorher schon ein LF geschickt wurde.
                const memKey = r.typeIds.slice().sort().join(',')
                    + (r.fromPersonnel ? '|personnel' : '')
                    + (r.fromPatient ? '|patient' : '')
                    + (r.fromPrisoner ? '|prisoner' : '')
                    + (r.isWater ? '|amount' : '');
                let onSite;
                if (r.isWater || r.fromPersonnel || r.fromPrisoner) {
                    // Wasser/Personal/Gefangenentransport sind keine zählbaren Fahrzeug-vor-Ort-Anforderungen.
                    // Anwesende Fahrzeuge nicht anrechnen – nur das eigene Sende-Gedächtnis bremst.
                    onSite = 0;
                } else if (r.fromMissing) {
                    // "Fehlende Fahrzeuge" aus mission_missing ist der NETTO-Restbedarf NACH Abzug der
                    // bereits ANGEKOMMENEN Fahrzeuge – aber NICHT nach Abzug der noch fahrenden (die Anzeige
                    // sinkt erst bei Ankunft). Daher die FAHRENDEN (driving) anrechnen, die angekommenen NICHT:
                    //  - angekommene NICHT anrechnen -> Eskalation (5 LF zusätzlich zu 15 anwesenden) wird bedient.
                    //  - fahrende anrechnen -> keine Doppel-Alarmierung mehr, wenn das 10-min-Gedächtnis abläuft,
                    //    bevor Langläufer (z.B. GruKw quer über die Karte) ankommen (Bug: 42 GruKw statt 18).
                    onSite = r.typeIds.reduce((sum, t) => sum + (typeof t === 'number' ? (enRouteDriving[t] || 0) : 0), 0);
                } else {
                    onSite = r.typeIds.reduce((sum, t) => sum + (typeof t === 'number' ? (enRoute[t] || 0) : 0), 0);
                }
                const mem = sent[memKey];
                let memWindow = (r.fromPersonnel || r.isWater || r.fromPrisoner) ? CONFIG.sentMemoryPersonnel : CONFIG.sentMemory;
                // Wasser/Schaum: Fortschritt über die Litermenge prüfen. Ist die Menge seit dem letzten
                // Versand NICHT gesunken und sind > waterRetry ms vergangen (Fahrzeug wäre angekommen),
                // gilt das Gedächtnis als "wirkungslos" -> erneut schicken statt blockieren.
                if (r.isWater && mem) {
                    // Fortschritt erkennen: Ist die geforderte Menge seit dem Merken GESUNKEN, hat das
                    // gesendete Wasser gewirkt -> Stillstands-Uhr auf das neue, niedrigere Niveau neu stellen.
                    // Ohne das würde ein erneuter Stillstand auf einem Restwert (z.B. 2000 l -> 400 l, dann
                    // 400 l dauerhaft) nie erkannt, weil "400 >= 2000" immer false ist -> Nachschub bliebe bis
                    // zum Ablauf des 60-min-Gedächtnisses aus, obwohl der Einsatz rot steht.
                    if (mem.liters != null && r.liters != null && r.liters < mem.liters) {
                        mem.liters = r.liters;
                        mem.ts = Date.now();
                    }
                    const stagnant = mem.liters != null && r.liters != null && r.liters >= mem.liters;
                    if (stagnant && Date.now() - mem.ts > CONFIG.waterRetry) {
                        dbg(`[#${mission.id}] ${r.caption}: Menge seit ${Math.round((Date.now()-mem.ts)/60000)} min nicht gesunken (${r.liters} l) – schicke erneut`);
                        memWindow = 0; // Gedächtnis verwerfen
                    }
                }
                // Personal-Anforderungen (z.B. Betreuungshelfer): Wenn nach personnelRetry ms NICHTS vor
                // Ort ist, kam das gemerkte Fahrzeug nicht an (Geist-Eintrag) -> Gedächtnis verwerfen und
                // erneut versuchen, statt 60 min blind zu blockieren. (Gleiche Idee wie Wasser-Fortschritt.)
                // WICHTIG (Fix v5.32): Vorher die ANFAHRT-Liste prüfen! Bei langen Anfahrten (Stadion-
                // Folgeeinsätze wie "Tor gefallen") ist nach 10 min noch nichts vor Ort, obwohl das
                // Fahrzeug längst rollt – ohne diese Prüfung stapelte sich alle 10 min ein weiteres LF.
                if ((r.fromPersonnel || r.fromPrisoner) && mem && onSite === 0 && Date.now() - mem.ts > CONFIG.personnelRetry) {
                    const drivingMatch = (r.typeIds || []).reduce((s, t) => s + (enRouteDriving[t] || 0), 0);
                    if (drivingMatch > 0) {
                        dbg(`[#${mission.id}] ${r.caption}: nichts vor Ort, aber ${drivingMatch} passendes Fzg. auf Anfahrt – Gedächtnis verlängert, warte auf Ankunft`);
                        mem.ts = Date.now(); // Uhr neu stellen, solange erkennbar etwas unterwegs ist
                    } else {
                        dbg(`[#${mission.id}] ${r.caption}: seit ${Math.round((Date.now()-mem.ts)/60000)} min gemerkt, aber nichts vor Ort UND nichts auf Anfahrt – schicke erneut`);
                        memWindow = 0;
                    }
                }
                const remembered = (mem && Date.now() - mem.ts < memWindow) ? mem.count : 0;
                // Anrechnung gegen Doppel-Alarmierung, ABER ohne Dauerblockade bei erneuerbaren
                // Anforderungen (Brand fordert nach Ausbreitung frische LF, obwohl alte vor Ort stehen):
                //  - Haben wir selbst kürzlich geschickt (remembered>0): voll anrechnen (max mit onSite),
                //    deckt Reload (onSite ist Wahrheit) und Mehrfachscans (remembered).
                //  - Haben wir NICHTS geschickt (remembered=0): vor-Ort nur bis zur aktuell geforderten
                //    Menge anrechnen. So wird eine frische Anforderung (need) nicht durch eine bereits
                //    abgeschlossene, gleich große Altwelle dauerhaft blockiert – ein erneuter Bedarf in
                //    gleicher Höhe wird bedient, eine schon gedeckte Anforderung aber nicht überfüllt.
                let already;
                if (remembered > 0) {
                    already = Math.max(onSite, remembered);
                } else if (r.fromMissing) {
                    // onSite ist hier die Zahl der FAHRENDEN (noch nicht angekommenen) Fahrzeuge – die
                    // kommen an und decken den Restbedarf, also voll anrechnen (kein need-1-Deckel).
                    // Verhindert die Doppel-Alarmierung von Langläufern nach Gedächtnis-Ablauf.
                    already = onSite;
                } else {
                    already = Math.min(onSite, Math.max(0, need - 1)); // lässt mind. 1 frisches Fahrzeug zu
                }
                if (already >= need) {
                    dbg(`[#${mission.id}] ${r.caption}${r.isWater ? ` (${r.liters} l)` : ''}: ${already} Fzg. bereits unterwegs (vor Ort ${onSite}, gemerkt ${remembered}) – warte auf Ankunft`);
                    continue;
                }
                need -= already;

                const fb = Object.entries(REQUIREMENT_FALLBACKS)
                    .find(([k]) => norm(r.caption) === norm(k))?.[1] || null;
                let got = pick(r.typeIds, need, r.caption, !!fb);
                if (fb && got < need) {
                    for (const entry of fb) {
                        const name = typeof entry === 'string' ? entry : entry.name;
                        const cap = typeof entry === 'string' ? Infinity : (entry.max || Infinity);
                        const ids = resolveTypeIds(name);
                        if (!ids || !ids.length) { notes.push(`Fallback „${name}" unbekannt`); continue; }
                        const more = pick(ids, Math.min(need - got, cap), `${r.caption}→${name}`, true);
                        if (more) notes.push(`${r.caption} nicht frei – ${more}x ${name} geschickt`);
                        got += more;
                        if (got >= need) break;
                    }
                    if (got < need) notes.push(`${r.caption}: nur ${got}/${need} verfügbar (inkl. Fallback)`);
                }
                if (got) sent[memKey] = { count: Math.max(already + got, remembered), ts: Date.now(), liters: r.isWater ? r.liters : null };
                // [AUDIT] Bedarf dieser Welle (need ist hier bereits Rest nach Abzug; +already = ursprünglicher Wellen-Bedarf)
                if (CONFIG.auditDispatch && got > 0) auditReqs.push({ cap: r.caption, need: need + already, already, got });
            }
        }

        if (hitVehicleLimit) notes.push(`Sicherheitslimit ${CONFIG.maxVehiclesPerAlarm} erreicht – Rest folgt im nächsten Scan`);

        // Gefangene, die ein eigenes Fahrzeug VOR ORT bereits hält, direkt zur Zelle schicken
        // (zusätzlich zum Sprechwunsch-Pfad – manche lösen keinen Funk-Sprechwunsch aus).
        if ((mission.reqs || []).some(r => r.fromPrisoner)) {
            try {
                const moved = await transportPrisonersAtMission(mission.id);
                if (moved > 0) return { ok: true, count: moved, notes, prisonersMoved: moved };
            } catch (e) { dbg(`[#${mission.id}] Gefangenen-Direkttransport: ${e.message}`); }
        }

        if (!picked.length) {
            const prev = state.get(mission.id) || {};
            state.set(mission.id, { ...prev, sent });
            const anyPending = Object.values(sent).some(m => Date.now() - m.ts < CONFIG.sentMemory);
            return { ok: false, reason: notes.join(' | ') || (anyPending ? 'alles Benötigte bereits unterwegs – warte auf Ankunft' : (boxes.length ? 'nichts Passendes verfügbar' : 'keine alarmierbaren Fahrzeuge auf der Einsatzseite (Verbandseinsatz/fertig?)')) };
        }
        dbg(`[#${mission.id}] alarmiere ${picked.length} Fahrzeuge: ${picked.join(', ')}`);

        const body = new URLSearchParams();
        body.append('authenticity_token', token);
        body.append('commit', 'Alarmieren');
        body.append('next_mission', '0');
        picked.forEach(v => body.append('vehicle_ids[]', v));
        // Vorgemerkte Ausrüstung (z. B. Rettungswinde) wie das Original-Formular mitsenden
        for (const [vid, eid] of Object.entries(equipToSend)) {
            body.append(`equipments[${vid}][]`, eid);
            dbg(`[#${mission.id}] Fzg ${vid}: Rettungswinde ${eid} angeklickt/mitgesendet`);
        }

        const post = await fetch(`/missions/${mission.id}/alarm`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });
        if (post.status === 429) {
            rateLimitedUntil = Date.now() + 120000;
            throw new Error('Rate-Limit (HTTP 429) – pausiere 2 Minuten');
        }
        if (!post.ok && post.status !== 302) throw new Error(`Alarm-POST: HTTP ${post.status}`);
        // WICHTIG (Fix v5.22): Gesendete Fahrzeuge scanweit sperren. Das fehlte im Haupt-Dispatch
        // (nur der Verbandschat-Pfad tat es) – dadurch konnte derselbe Scan ein bereits alarmiertes
        // Fahrzeug Sekunden später einem ANDEREN Einsatz zuteilen (Umleitung!). Beleg im Log vom
        // 04.07.: Fzg 122479654 wurde 13:12:54/13:13:04/13:13:11 an drei Einsätze vergeben.
        for (const v of picked) {
            alarmedThisScan.add(v);
            vehicleAlarmed.set(v, { ts: Date.now(), missionId: String(mission.id) });
        }
        persistVehicleAlarms();

        // DIAGNOSE: Server-Antwort auswerten. Das Spiel liefert auch bei HTTP 200 manchmal Fehler/
        // Hinweise im Body (z.B. wenn ein Anhänger ohne Träger nicht ausrücken kann). Diese sichtbar machen.
        let trailerFailed = false; // gesendeter Anhänger kam NICHT an (Träger nicht verfügbar o.ä.)
        if (CONFIG.alarmDiagnostics) {
            try {
                const respText = await post.clone().text();
                const lower = respText.toLowerCase();
                // Bekannte Fehlerhinweise im Antwort-HTML suchen
                const hints = [];
                for (const re of [
                    /trägerfahrzeug nicht verfügbar/i,
                    /kein (zugfahrzeug|trägerfahrzeug)/i,
                    /nicht (verfügbar|einsatzbereit|alarmiert)/i,
                    /fehler/i,
                    /alert[^>]*>([^<]{5,120})</i,
                ]) {
                    const m = respText.match(re);
                    if (m) hints.push((m[1] || m[0]).replace(/\s+/g, ' ').trim().slice(0, 120));
                }
                // Wurde mein gesendeter Anhänger in der Antwort als "anfahrend" bestätigt?
                const trailerIds = picked.filter(v => (byId.get(v) || {}).isTrailer);
                for (const tid of trailerIds) {
                    const inDriving = respText.includes(`vehicle_drive_${tid}`) || respText.includes(`vehicle_row_${tid}`);
                    if (!inDriving) trailerFailed = true; // Anhänger fuhr NICHT los
                    dbg(`[#${mission.id}] Diagnose: Anhänger ${tid} nach Alarm ${inDriving ? 'als anfahrend bestätigt ✓' : 'NICHT in Anfahrt-Liste ✗'}`);
                }
                // v5.26: ALLE gesendeten Fahrzeuge gegen die Antwortseite verifizieren – das ist die
                // direkte Rückmeldung des Spiels, ob ein Fahrzeug wirklich losgefahren ist.
                // Wiederholt scheiternde Fahrzeuge (Werkstatt? kein Personal? defekte Zuordnung?)
                // werden gezählt und nach N Fehlschlägen in Folge vorübergehend gesperrt.
                let failsChanged = false;
                let travelChanged = false;
                const tt = { confirmed: 0, recorded: 0, noItem: 0, noEta: 0, error: null }; // Telemetrie-Selbstdiagnose (v5.35)
                for (const vid of picked) {
                    const confirmed = respText.includes(`vehicle_drive_${vid}`) || respText.includes(`vehicle_row_${vid}`);
                    const key = String(vid);
                    if (confirmed) {
                        if (vehicleFails.has(key)) { vehicleFails.delete(key); failsChanged = true; } // Erfolg -> Fehlerserie beendet
                        tt.confirmed++;
                        try {
                            const item = byId.get(vid);
                            if (!item) tt.noItem++;
                            else if (item.eta == null) tt.noEta++;
                            else { recordTravel(item, mission); tt.recorded++; travelChanged = true; }
                        } catch (e) { tt.error = e.message; }
                        continue;
                    }
                    const b = byId.get(vid) || {};
                    const e = vehicleFails.get(key) || { fails: 0, typeId: b.typeId };
                    e.fails++; e.lastTs = Date.now(); e.typeId = b.typeId ?? e.typeId;
                    if (e.fails >= (CONFIG.vehicleFailBlacklistAfter || 3)) {
                        e.blockedUntil = Date.now() + (CONFIG.vehicleFailBlacklistMs || 3600000);
                        log(`🚫 [#${mission.id}] Fahrzeug ${vid} (${vtName(e.typeId)}) fuhr zum ${e.fails}. Mal in Folge NICHT los – für ${Math.round((CONFIG.vehicleFailBlacklistMs || 3600000) / 60000)} min gesperrt. Bitte im Spiel prüfen (Werkstatt/Personal/Zuordnung)!`, '#f38ba8');
                    } else {
                        log(`⚠️ [#${mission.id}] Fahrzeug ${vid} (${vtName(b.typeId)}) wurde vom Spiel NICHT losgeschickt (${e.fails}. Fehlversuch)`, '#f9e2af');
                    }
                    vehicleFails.set(key, e);
                    failsChanged = true;
                    // Sende-Gedächtnis korrigieren: Das Fahrzeug zählt nicht als "unterwegs" für seine
                    // Anforderung, sonst wartet der Einsatz 10 min auf ein Fahrzeug, das nie kommt.
                    if (!b.isTrailer && Number.isFinite(b.typeId)) {
                        for (const mk of Object.keys(sent)) {
                            if (mk.split(',').map(Number).includes(b.typeId) && sent[mk].count > 0) {
                                sent[mk].count--;
                                break;
                            }
                        }
                    }
                }
                if (failsChanged) persistVehicleFails();
                if (travelChanged) persistTravelStats();
                if (etaCapSkipped > 0) dbg(`[#${mission.id}] ETA-Deckel: ${etaCapSkipped} Kandidat(en) über ${Math.round((CONFIG.maxTravelSec || 0) / 60)} min Anfahrt übersprungen`);
                if (verSkipped > 0) dbg(`[#${mission.id}] ${verSkipped} Verbandsfahrzeug(e) anderer Mitglieder übersprungen (useVerbandVehicles=false)`);
                if (manualSkipped > 0) dbg(`[#${mission.id}] ${manualSkipped} Fahrzeug(e) von der manuellen Sperrliste übersprungen`);
                if (cityOnlySkipped > 0) dbg(`[#${mission.id}] ${cityOnlySkipped} Nicht-Innenstadt-Fahrzeug(e) übersprungen (cityOnly)`);
                dbgv(`[#${mission.id}] Fahrzeit-Telemetrie: ${tt.recorded}/${tt.confirmed} erfasst (ohne Fahrzeugdaten: ${tt.noItem}, ohne ETA: ${tt.noEta})`);
                if (tt.confirmed > 0 && tt.recorded === 0) {
                    log(`⚠️ [#${mission.id}] Fahrzeit-Telemetrie leer: ${tt.confirmed} bestätigte Fahrzeuge, aber 0 erfasst (ohne Fahrzeugdaten: ${tt.noItem}, ohne ETA: ${tt.noEta}${tt.error ? `, Fehler: ${tt.error}` : ''})`, '#f9e2af');
                }
                if (hints.length && trailerFailed) log(`🔎 [#${mission.id}] Server-Antwort (Anhänger fuhr nicht): ${[...new Set(hints)].join(' | ')}`, '#f9e2af');
                dbg(`[#${mission.id}] Alarm-Antwort: HTTP ${post.status}, ${respText.length} Bytes, URL ${post.url}`);
            } catch (e) {
                log(`⚠️ [#${mission.id}] Diagnose-Auswertung fehlgeschlagen: ${e.message}`, '#f9e2af');
            }
        }
        // Anhänger, die laut Server NICHT angefahren sind, aus dem Sende-Gedächtnis nehmen, damit sie
        // im nächsten Scan erneut versucht werden (sonst blockiert ein falsches "gemerkt 1" dauerhaft,
        // obwohl gar nichts fährt). sent ist ein Objekt memKey->{...}; betroffene memKeys entfernen.
        if (trailerFailed && trailerMemKeys.size) {
            for (const mk of trailerMemKeys) {
                delete sent[mk];
                // Cooldown setzen: gleicher Anhänger-Typ für diesen Einsatz erst wieder nach Ablauf,
                // sonst entsteht eine Alarm-Schleife (Alarm -> "Trägerfahrzeug nicht verfügbar" -> Alarm ...).
                trailerRetryAfter.set(`${mission.id}:${mk}`, Date.now() + (CONFIG.trailerRetryCooldownMs || 300000));
            }
            dbg(`[#${mission.id}] Anhänger-Alarm nicht bestätigt – Sende-Gedächtnis zurückgesetzt, erneuter Versuch in ${Math.round((CONFIG.trailerRetryCooldownMs || 300000) / 60000)} min`);
        }
        {
            const prev = state.get(mission.id) || {};
            const wave = (prev.waves || 0) + 1;
            state.set(mission.id, { ...prev, sent, waves: wave });
            // Fix v5.22: Zustand SOFORT sichern statt erst am Scan-Ende. Ein Scan kann bei voller Lage
            // 8+ Minuten laufen (bis 30 Alarme mit Delays + Seitenabrufe); ein Reload mittendrin verlor
            // bisher ALLE Dispatches dieses Scans -> Nachalarmierungs-Welle direkt nach dem Neustart
            // (Beleg 04.07. 13:25:42: Reload, danach 13:25:50-13:26:38 Doppel-Alarme mit wave=1/gemerkt 0).
            persistState();
            // [AUDIT] Eine maschinell auswertbare Zeile pro Alarm-Welle ins Log schreiben.
            if (CONFIG.auditDispatch) {
                const byType = {};
                for (const v of picked) { const b = byId.get(v); const n = b ? vtName(b.typeId) : '?'; byType[n] = (byType[n] || 0) + 1; }
                const typesStr = Object.entries(byType).map(([k, n]) => `${k}:${n}`).join(',') || '–';
                const reqsStr = auditReqs.length
                    ? auditReqs.map(a => `${a.cap} Bedarf${a.need} da${a.already} neu${a.got}`).join(' | ')
                    : '(keine Requirements)';
                pushLog(`[AUDIT] m#${mission.id} "${mission.caption || '?'}" mode=${mission.mode || '?'} wave=${wave} sent=${picked.length} types=${typesStr} reqs=[${reqsStr}]`, 'AUDIT');
            }
        }
        // Erfolg: Der Alarm-POST ging raus. Rückgabe ist PFLICHT – fehlt sie, liest der Scan-Loop
        // r.ok auf undefined (Absturz, als ❌ geloggt) und speichert lastAction/signature NICHT.
        // Folge: Der Cooldown (90s / retryEmpty 5min) greift nie -> der Einsatz wird alle 8s erneut
        // alarmiert -> Wellen-Flut (im Audit als sehr viele Folge-Wellen sichtbar). Das hier behebt das.
        return { ok: true, count: picked.length, notes };
    }

    // ================= Health-Check =================
    // Schreibt periodisch nur AUFFÄLLIGE Einsätze ins Log, als Grundlage für Log-Reviews:
    //  - Hänger: Einsatz hat seit > hangThreshold eine offene Fahrzeug-Anforderung
    //  - Über-Alarmierung: für eine Anforderung sind mehr eigene Fahrzeuge unterwegs/vor Ort als gefordert
    // Bewusst NICHT geloggt: sauber versorgte (grüne) Einsätze – die wären nur Rauschen.
    async function healthCheck(missionsRaw) {
        if (!CONFIG.healthCheck) return;
        if (Date.now() - lastHealthCheck < CONFIG.healthCheckInterval) return;
        lastHealthCheck = Date.now();

        // Problemfahrzeuge (v5.26): Fahrzeuge mit wiederholten Fehlstarts der letzten 24h auflisten,
        // damit man sie im Spiel prüfen kann (Werkstatt, fehlendes Personal, defekte Anhänger-Zuordnung).
        const problems = [...vehicleFails.entries()].filter(([, e]) => e.fails >= 2)
            .sort((a, b) => b[1].fails - a[1].fails).slice(0, 10);
        if (problems.length) {
            const txt = problems.map(([vid, e]) => `${vid} (${vtName(e.typeId)}: ${e.fails}×${e.blockedUntil && e.blockedUntil > Date.now() ? ', gesperrt' : ''})`).join(', ');
            if (txt !== lastProblemVehiclesTxt) { // nur bei Änderung loggen, sonst spammt der 60s-Check das Log voll
                lastProblemVehiclesTxt = txt;
                log(`📊 Health-Check Problemfahrzeuge (24h): ${txt}`, '#f9e2af');
            }
        } else {
            lastProblemVehiclesTxt = '';
        }

        // Echte Hänger: Einsätze, bei denen das Script seit > hangThreshold "nichts Passendes verfügbar"
        // meldet (NICHT "bereits unterwegs" – das ist gesunde Wartezeit). Quelle ist der Dispatch-Zustand,
        // nicht nur das DOM, damit versorgte Großeinsätze nicht fälschlich als Hänger erscheinen.
        const hangers = [];
        for (const [id, since] of stuckSince) {
            const stuckMs = Date.now() - since;
            if (stuckMs <= CONFIG.hangThreshold) continue;
            const st = state.get(id) || {};
            const caption = st.lastCaption || id;
            hangers.push(`#${id} "${caption}" seit ${Math.round(stuckMs / 60000)} min ohne Lösung: ${st.lastReason || '?'}`);
        }

        if (hangers.length) {
            log(`🩺 Health-Check: ${hangers.length} echte Hänger (> ${Math.round(CONFIG.hangThreshold / 60000)} min ohne Lösung)`, '#f38ba8');
            hangers.slice(0, 10).forEach(h => log(`   ⏱ ${h}`, '#f38ba8'));
        } else {
            dbg('🩺 Health-Check: keine echten Hänger (versorgte Einsätze zählen nicht)');
        }
    }

    // ================= Hauptschleife =================
    // ================= Adaptive Spielgeschwindigkeit =================
    // Tempo-Treppe (CONFIG.speedLadder): 0-10 -> 3x, 11-20 -> 2x, 21-30 -> 1x, 31-40 -> 0.5x,
    // > 40 -> Pause; Pause endet erst, wenn wieder <= speedResumeAt (10) Einsätze offen sind.
    // (speedMode ist bereits oben deklariert)

    function countOpenMissions() {
        let n = 0;
        for (const el of document.querySelectorAll('#mission_list .missionSideBarEntry')) {
            if (el.style.display === 'none') continue;
            if (el.querySelector('.mission_panel_red') || el.querySelector('.mission_panel_yellow')) n++;
        }
        return n;
    }

    // Wie countOpenMissions, aber OHNE die an die Gruppe freigegebenen Einsätze (grüner Rand =
    // panel-success). Für die Überlast-Pause zählt nur, was ICH selbst noch bearbeiten muss.
    function countOwnOpenMissions() {
        let n = 0;
        for (const el of document.querySelectorAll('#mission_list .missionSideBarEntry')) {
            if (el.style.display === 'none') continue;
            const panel = el.querySelector('.mission_panel_red, .mission_panel_yellow');
            if (!panel) continue;
            // freigegebene Einsätze (panel-success) überspringen
            const wrapper = el.querySelector('[id^="mission_panel_"]');
            if (wrapper && wrapper.classList.contains('panel-success')) continue;
            n++;
        }
        return n;
    }

    function currentSpeedLabel() {
        return (document.querySelector('#mission_speed_value_label')?.textContent || '').trim();
    }

    async function setSpeed(speedParam, why) {
        const label = SPEED_LABEL[speedParam] || `speed ${speedParam}`;
        if (currentSpeedLabel() === label) return; // schon eingestellt
        try {
            const r = await fetch(`/missionSpeed?speed=${speedParam}`, { credentials: 'same-origin' });
            if (!r.ok && r.status !== 302) throw new Error(`HTTP ${r.status}`);
            log(`⏩ Geschwindigkeit → ${label} (${why})`, '#89b4fa');
        } catch (e) {
            log(`⚠️ Geschwindigkeit konnte nicht auf ${label} gesetzt werden: ${e.message}`, '#f9e2af');
        }
    }

    async function adjustSpeed() {
        if (!CONFIG.autoSpeed) return;
        // Gezählt werden nur EIGENE offene rote/gelbe Einsätze (freigegebene mit grünem Rand nicht) –
        // dieselbe Basis wie die Statusanzeige, damit Pause und Tempo konsistent schalten.
        const count = countOwnOpenMissions();

        // Bestätigungs-Prinzip (v5.30): Jede Zustandsänderung braucht ZWEI aufeinanderfolgende
        // Messungen mit demselben Ziel. Direkt nach einem Reload ist #mission_list noch leer und
        // die Zählung liefert transient 0 – ohne Bestätigung sprang das Tempo dann auf 3x mitten
        // in der Volllast (Beleg 08.07. 15:10:54: "0 offene Einsätze" 29 s nach 31).
        const confirmTarget = (key) => {
            if (pendingSpeedTarget === key) { pendingSpeedTarget = null; return true; }
            pendingSpeedTarget = key;
            dbg(`Geschwindigkeit: Ziel „${key}" vorgemerkt (${count} offene Einsätze) – warte auf Bestätigung im nächsten Scan`);
            return false;
        };

        // Pause-Zustand mit tiefer Hysterese: > speedPauseAbove rein, erst <= speedResumeAt wieder raus.
        if (overloadPaused) {
            if (count > CONFIG.speedResumeAt) {
                pendingSpeedTarget = null;
                dbg(`Geschwindigkeit: Pause aktiv (${count} offene Einsätze, Freigabe erst bei ≤ ${CONFIG.speedResumeAt})`);
                return;
            }
            if (!confirmTarget('resume')) return;
            setOverloadPaused(false); // Last ist bestätigt gesunken -> unten setzt die Treppe das passende Tempo
        } else if (count > CONFIG.speedPauseAbove) {
            if (!confirmTarget('pause')) return;
            setOverloadPaused(true);
            speedMode = null;
            lastSpeedSwitch = Date.now();
            await setSpeed(CONFIG.speedPause, `${count} offene Einsätze > ${CONFIG.speedPauseAbove} – Einsatzgenerierung pausiert bis ≤ ${CONFIG.speedResumeAt}`);
            return;
        }

        // Tempo-Treppe: erste Stufe, deren Obergrenze die aktuelle Last abdeckt.
        const step = CONFIG.speedLadder.find(s => count <= s.upTo) || CONFIG.speedLadder[CONFIG.speedLadder.length - 1];
        if (speedMode === step.speed) {
            pendingSpeedTarget = null; // Zustand stabil -> Vormerkung verwerfen
            dbgv(`Geschwindigkeit: ${count} offene Einsätze, Stufe unverändert (${SPEED_LABEL[step.speed] || step.speed})`);
            return;
        }
        // Flatter-Schutz: An Stufengrenzen (20↔21 Einsätze) nicht im Sekundentakt hin- und
        // herschalten – zwischen zwei Stufenwechseln müssen mindestens speedMinHoldMs liegen.
        if (speedMode !== null && Date.now() - lastSpeedSwitch < (CONFIG.speedMinHoldMs || 90000)) {
            dbg(`Geschwindigkeit: Stufenwechsel (${count} Einsätze) zurückgestellt – Mindesthaltezeit läuft noch`);
            return;
        }
        if (!confirmTarget(`speed${step.speed}`)) return;
        speedMode = step.speed;
        lastSpeedSwitch = Date.now();
        await setSpeed(step.speed, `${count} offene Einsätze → Stufe ≤ ${step.upTo}`);
    }

    // ===== Verbandschat: geteilte Einsätze automatisch unterstützen =====
    // Im Chat geteilte Einsätze erscheinen als <a href="/missions/ID"> mit Glocken-Icon.
    // Pro geteiltem Einsatz schicken wir EINMAL, was frei ist: 1 LF und/oder 1 FuStW.
    const LF_TYPE_IDS = [0, 1, 6, 7, 8, 30]; // alle LF-Varianten (LF, HLF, TLF, ...)
    const FUSTW_TYPE_ID = 32;
    const CHAT_DONE_KEY = 'ad_chat_missions_done';
    let chatMissionsHandled = {}; // missionId -> { lf:bool, fustw:bool, ts }
    try { chatMissionsHandled = JSON.parse(localStorage.getItem(CHAT_DONE_KEY) || '{}'); } catch (e) { chatMissionsHandled = {}; }
    const saveChatDone = () => { try { localStorage.setItem(CHAT_DONE_KEY, JSON.stringify(chatMissionsHandled)); } catch (e) {} };

    function getChatSharedMissionIds() {
        const ids = new Set();
        for (const a of document.querySelectorAll('#mission_chat_messages a[href^="/missions/"]')) {
            // nur echte Einsatz-Teilungen (mit Glocken-Icon), keine sonstigen Links
            if (!a.querySelector('.glyphicon-bell')) continue;
            const m = (a.getAttribute('href') || '').match(/\/missions\/(\d+)/);
            if (m) ids.add(m[1]);
        }
        return [...ids];
    }

    async function handleAllianceChatMissions() {
        if (!CONFIG.helpAllianceChat) return;
        const ids = getChatSharedMissionIds();
        for (const id of ids) {
            const done = chatMissionsHandled[id] || { lf: false, fustw: false };
            if (done.lf && done.fustw) continue; // für diesen Einsatz schon beides geschickt
            let token, allBoxes;
            try {
                const r = await loadVehicleBoxes(id);
                token = r.token; allBoxes = r.boxes;
            } catch (e) {
                dbg(`[Chat #${id}] Einsatzseite nicht ladbar: ${e.message}`);
                continue;
            }
            const free = allBoxes.filter(b => !alarmedThisScan.has(b.value) && !b.isTrailer && !b.isDisabled && !b.noTractive);
            const picked = [];
            if (!done.lf) {
                const lf = free.find(b => LF_TYPE_IDS.includes(b.typeId) && !picked.includes(b.value));
                if (lf) { picked.push(lf.value); done.lf = true; }
            }
            if (!done.fustw) {
                const fu = free.find(b => b.typeId === FUSTW_TYPE_ID && !picked.includes(b.value));
                if (fu) { picked.push(fu.value); done.fustw = true; }
            }
            if (!picked.length) continue; // nichts Passendes frei – beim nächsten Scan erneut versuchen

            try {
                const body = new URLSearchParams();
                body.append('authenticity_token', token);
                body.append('commit', 'Alarmieren');
                body.append('next_mission', '0');
                picked.forEach(v => body.append('vehicle_ids[]', v));
                const post = await fetch(`/missions/${id}/alarm`, {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: body.toString(),
                });
                if (post.status === 429) { rateLimitedUntil = Date.now() + 120000; return; }
                if (!post.ok && post.status !== 302) throw new Error(`HTTP ${post.status}`);
                for (const v of picked) {
                    alarmedThisScan.add(v);
                    vehicleAlarmed.set(v, { ts: Date.now(), missionId: String(id) });
                }
                persistVehicleAlarms();
                chatMissionsHandled[id] = { ...done, ts: Date.now() };
                saveChatDone();
                const what = [done.lf ? 'LF' : null, done.fustw ? 'FuStW' : null].filter(Boolean).join(' + ');
                log(`🤝 [Chat #${id}] unterstützt: ${picked.length} Fzg (${what})`, '#89dceb');
                await sleep(jitter(CONFIG.alarmDelay));
            } catch (e) {
                dbg(`[Chat #${id}] Alarm fehlgeschlagen: ${e.message}`);
            }
        }
        // Aufräumen: Einträge älter als 6h entfernen, damit der Speicher nicht unbegrenzt wächst
        const cutoff = Date.now() - 6 * 3600 * 1000;
        let changed = false;
        for (const [mid, v] of Object.entries(chatMissionsHandled)) {
            if (v.ts && v.ts < cutoff) { delete chatMissionsHandled[mid]; changed = true; }
        }
        if (changed) saveChatDone();
    }

    async function scanLoop() {
        if (!running) return;
        if (Date.now() < rateLimitedUntil) {
            $status.textContent = 'Rate-Limit – pausiert…';
            timer = setTimeout(scanLoop, 10000);
            return;
        }

        // 1) Funk: "Verstanden" bestätigen
        try { acknowledgeRadioMessages(); } catch (e) { /* unkritisch */ }

        // 2) Funk: Sprechwünsche -> Patienten- und Gefangenentransport
        const wishes = getSprechwuensche();
        let transports = 0;
        let prisonerTransports = 0;
        for (const v of wishes) {
            if (!running) break;
            // Patiententransporte sind durch maxTransportsPerScan begrenzt. Gefangenentransporte bekommen
            // einen EIGENEN Topf (maxPrisonerTransportsPerScan), damit sie bei vielen gleichzeitigen
            // Patienten-Sprechwünschen nicht verdrängt werden und der Einsatz nicht ewig rot bleibt.
            // Überfällige Sprechwünsche (>maxSpeakWaitMs) ignorieren das Scan-Limit, damit sie
            // garantiert innerhalb der Wartegrenze rauskommen – auch bei sehr vielen Einsätzen.
            const limitReached = !v.overdue && transports >= CONFIG.maxTransportsPerScan;
            try {
                const r = await handleTransport(v, limitReached);
                if (r.reason !== 'limit') vehicleState.set(v.vehicleId, Date.now());
                if (r.ok) {
                    // Überfällige Transporte laufen "außer Konkurrenz" – sie zählen nicht auf das
                    // reguläre Scan-Limit an, damit sie die frischen nicht verdrängen (und umgekehrt).
                    if (r.wasPrisoner) prisonerTransports++; else if (!v.overdue) transports++;
                    log(`🏥 [#${v.missionId || '?'}] ${v.vehicleName} → ${r.info}${v.overdue ? ' (überfällig, vorrangig)' : ''}`, '#a6e3a1');
                    await sleep(jitter(CONFIG.transportDelay));
                } else if (r.reason !== 'limit') {
                    log(`⚠️ [#${v.missionId || '?'}] ${v.vehicleName}: ${r.reason}`, '#f9e2af');
                }
            } catch (e) {
                log(`❌ [#${v.missionId || '?'}] ${v.vehicleName}: ${e.message}`, '#f38ba8');
            }
            // Bei aktivem Vorrang-Prinzip NIE vorzeitig abbrechen – alle Sprechwünsche abarbeiten,
            // damit konsequent zuerst Kräfte freigegeben werden, bevor neue Einsätze alarmiert werden.
            if (!CONFIG.prioritizeSpeakRequests
                && prisonerTransports >= CONFIG.maxPrisonerTransportsPerScan
                && transports >= CONFIG.maxTransportsPerScan) break;
        }

        // 2b) Überlast-Schutz ZUERST: Ab CONFIG.pauseThreshold offenen Einsätzen (gelb+rot) wird die
        // EINSATZGENERIERUNG des Spiels pausiert (/missionSpeed?speed=6) – es kommen keine neuen Einsätze
        // mehr rein. Das Script arbeitet die bestehenden Einsätze normal weiter ab, damit die Last sinkt.
        // Fällt sie wieder unter den Schwellwert, wird die Generierung wieder freigegeben.
        // Gezählt werden NUR eigene rote/gelbe Einsätze – freigegebene (grüner Rand) und fertige
        // (grüne) Einsätze zählen NICHT mit.
        const openCount = countOwnOpenMissions();
        if (CONFIG.pauseThreshold > 0) {
            if (openCount >= CONFIG.pauseThreshold && !overloadPaused) {
                overloadPaused = true;
                await setSpeed(CONFIG.speedPause, `Überlast: ${openCount} Einsätze ≥ ${CONFIG.pauseThreshold} – Einsatzgenerierung pausiert`);
            } else if (openCount < CONFIG.pauseThreshold && overloadPaused) {
                overloadPaused = false;
                speedMode = null; // bei Auto setzt adjustSpeed gleich das passende Tempo
                if (CONFIG.autoSpeed) {
                    await setSpeed(CONFIG.speedNormal, `Last gesunken: ${openCount} < ${CONFIG.pauseThreshold} – Einsatzgenerierung wieder frei`);
                } else {
                    // Manueller Tempo-Modus: nur aus der Pause holen (auf 1x), Nutzer kann selbst weiter regeln
                    await setSpeed(CONFIG.speedNormal, `Last gesunken: ${openCount} < ${CONFIG.pauseThreshold} – Pause aufgehoben (manuelles Tempo, bitte ggf. selbst anpassen)`);
                }
            }
        }

        // 2c) Spielgeschwindigkeit an die Last anpassen (setzt während der Überlast-Pause nichts)
        try { await adjustSpeed(); } catch (e) { /* unkritisch */ }

        // 3) Einsätze: ELW-Erstalarm & fehlende Fahrzeuge
        try { updateCompletedStats(); } catch (e) { /* unkritisch */ }
        try { await healthCheck(); } catch (e) { /* unkritisch */ }
        const missions = collectMissions();
        $status.textContent = overloadPaused
            ? `⏸️ Einsätze pausiert (${openCount} offen)`
            : `läuft… (${missions.length} Einsätze, ${wishes.length} Sprechwünsche)`;

        let sent = 0;
        let limited = false;
        // Scanweiter Merker: welche Fahrzeuge wurden in DIESEM Durchlauf bereits alarmiert? Verhindert,
        // dass dasselbe Fahrzeug (z.B. das einzige Seenotrettungsboot) an zwei Einsätze gleichzeitig
        // geschickt wird – der zweite Alarm würde sonst verpuffen, weil das Fzg schon gebunden ist.
        alarmedThisScan.clear();
        // Verbandschat: geteilte Einsätze zuerst unterstützen (ihre Alarme blockieren die Fahrzeuge
        // dann im scanweiten Merker, damit eigene Einsätze sie nicht doppelt verplanen).
        try { await handleAllianceChatMissions(); } catch (e) { dbg(`Chat-Unterstützung: ${e.message}`); }
        for (const m of missions) {
            if (!running) break;
            if (sent >= CONFIG.maxPerScan) { limited = true; break; }
            try {
                const r = await dispatch(m);
                state.set(m.id, { ...(state.get(m.id) || {}), lastAction: Date.now(), signature: m.signature, lastEmpty: !r.ok,
                    lastReason: r.ok ? null : (r.reason || ''), lastCaption: m.caption });
                // Zeitpunkt der ersten "echt nichts passiert"-Lage merken (für Health-Check)
                const isStuck = !r.ok && !/bereits unterwegs/.test(r.reason || '');
                const prevStuck = stuckSince.get(m.id);
                if (isStuck && !prevStuck) stuckSince.set(m.id, Date.now());
                if (!isStuck && prevStuck) stuckSince.delete(m.id);
                if (r.ok) {
                    sent++;
                    log(`✅ [#${m.id}] ${m.caption}: ${r.count} Fzg. alarmiert${m.mode === "elw" ? " (ELW)" : m.mode === "kt" ? " (KT)" : ""}`, '#a6e3a1');
                    r.notes?.forEach(n => log(`   ↳ [#${m.id}] ${n}`, '#f9e2af'));
                    await sleep(jitter(CONFIG.alarmDelay));
                } else {
                    log(`⚠️ [#${m.id}] ${m.caption}: ${r.reason}`, '#f9e2af');
                }
            } catch (e) {
                log(`❌ [#${m.id}] ${m.caption}: ${e.message}`, '#f38ba8');
            }
        }
        if (limited) log(`⏳ Limit ${CONFIG.maxPerScan}/Scan erreicht – ${missions.length - sent} weitere Einsätze folgen im nächsten Durchlauf`, '#f9e2af');
        persistState();
        timer = setTimeout(scanLoop, jitter(CONFIG.scanInterval));
    }

    log('v5.56 geladen – Start drücken.');
})();
