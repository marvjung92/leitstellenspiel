// ==UserScript==
// @name         LSS Top-Verband-Einsätze
// @namespace    http://tampermonkey.net/
// @version      1.63
// @downloadURL  https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-top-verband.user.js
// @updateURL    https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-top-verband.user.js
// @description  Listet freigegebene/Verband-Einsätze, sendet per Knopf oder Automatik (alle 3 min) je 1 LF an alle über 4.999, mit 24h-Doppelsende-Schutz und Anfahr-Zähler. Neu: 🔓 Ausnahme-Leitstelle – deren LFs bedienen weiter Verbandseinsätze, auch wenn die 35er-Reserve erreicht ist.
// @match        https://www.leitstellenspiel.de/
// @match        https://www.leitstellenspiel.de/?*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const TOP_N = 5;
    const CREDIT_THRESHOLD = 4999;           // ab "höher als" diesem Verdienst je 1 LF senden (">" strikt -> 5.000 ist dabei)
    const LF_TYPE_IDS = [0, 1, 6, 7, 8, 30];  // alle LF-Varianten (LF, HLF, TLF, …) – identisch zum Dispatch-Script
    const SEND_DELAY = 1200;                  // ms Pause zwischen zwei Alarmierungen (gegen Rate-Limit)
    const AUTO_INTERVAL = 3 * 60 * 1000;      // Automatik-Takt: alle 3 Minuten aktualisieren + senden
    const MIN_FREE_LF = 35;                   // harter Stopp: darunter wird gar nichts mehr in den Verband geschickt (19.07.: von 20 angehoben – Stadion-Großlagen brauchen 8-16 LF an einem Ort)
    // Dynamische Schwelle (v1.49): je knapper die freien LFs, desto wertvoller muss ein Verbands-
    // einsatz sein, um noch ein LF zu bekommen. Über 60 freien LFs gilt CREDIT_THRESHOLD (Basis).
    const THRESHOLD_LADDER = [
        { maxFree: 30, min: 54999 },  // <= 30 frei -> nur noch über 54.999
        { maxFree: 40, min: 44999 },  // <= 40 frei -> nur noch über 44.999
        { maxFree: 50, min: 34999 },  // <= 50 frei -> nur noch über 34.999
        { maxFree: 60, min: 29999 },  // <= 60 frei -> nur noch über 29.999
    ];
    function effectiveThreshold(freeCount) {
        if (freeCount == null) return CREDIT_THRESHOLD; // API nicht verfügbar -> Basis-Schwelle
        for (const step of THRESHOLD_LADDER) if (freeCount <= step.maxFree) return step.min;
        return CREDIT_THRESHOLD;
    }

    // Automatik-Schalter merken (überlebt Reloads). Standard AUS – bewusst einmal einschalten.
    const AUTO_KEY = 'tv_auto';
    let autoMode = localStorage.getItem(AUTO_KEY) === '1';
    function setAuto(on) {
        autoMode = on;
        try { localStorage.setItem(AUTO_KEY, on ? '1' : '0'); } catch (e) { /* egal */ }
    }

    // Gesendete Einsatz-IDs 24 h lang merken (über Reloads hinweg), damit jeder Einsatz im
    // 24-h-Fenster nur EINMAL ein LF bekommt. Format: { "<missionId>": <timestamp_ms>, ... }
    const SENT_KEY = 'tv_lf_sent';
    const SENT_TTL = 24 * 60 * 60 * 1000;     // 24 Stunden
    function loadSent() {
        let obj = {};
        try { obj = JSON.parse(localStorage.getItem(SENT_KEY) || '{}'); } catch (e) { obj = {}; }
        const now = Date.now();
        let changed = false;
        for (const id in obj) { if (now - obj[id] > SENT_TTL) { delete obj[id]; changed = true; } }
        if (changed) { try { localStorage.setItem(SENT_KEY, JSON.stringify(obj)); } catch (e) { /* egal */ } }
        return obj;
    }
    let sentStore = loadSent();
    function isSent(id) {
        const ts = sentStore[id];
        return ts != null && (Date.now() - ts) < SENT_TTL;
    }
    function markSent(id) {
        sentStore[id] = Date.now();
        try { localStorage.setItem(SENT_KEY, JSON.stringify(sentStore)); } catch (e) { /* egal */ }
    }
    // 24-h-Speicher in der Konsole leeren: tvSentReset()
    try { window.tvSentReset = () => { sentStore = {}; try { localStorage.removeItem(SENT_KEY); } catch (e) {} console.log('Top-Verband: gesendete Einsätze zurückgesetzt.'); }; } catch (e) { /* egal */ }

    // Geräteübergreifender Doppelsende-Schutz (v1.44): localStorage ist pro Laptop/Browser isoliert –
    // bei Nutzung mehrerer Geräte schickte jede Automatik "ihr erstes" LF an denselben Einsatz.
    // Die Serverwahrheit kennt /api/vehicles: welche Einsätze haben BEREITS ein eigenes LF
    // (target_type=mission)? Diese werden vor dem Senden übersprungen und ins 24h-Gedächtnis
    // übernommen. Restrisiko: zwei Geräte, die in derselben Sekunde senden – das Fenster schrumpft
    // von Minuten auf Sekunden.
    async function fetchLfState() {
        try {
            const res = await fetch('/api/vehicles', { credentials: 'same-origin' });
            if (!res.ok) return null;
            const all = await res.json();
            const boundIds = new Set();
            let freeCount = 0;
            for (const v of all) {
                if (!LF_TYPE_IDS.includes(Number(v.vehicle_type))) continue;
                if (v.target_type === 'mission' && v.target_id != null) { boundIds.add(String(v.target_id)); continue; }
                const fms = Number(v.fms_real ?? v.fms_show ?? 0);
                if (fms === 1 || fms === 2) freeCount++; // frei auf Funk/Wache; Rückkehrer (8) und Werkstatt (6) zählen nicht
            }
            return { boundIds, freeCount };
        } catch (e) { return null; } // API nicht erreichbar -> Prüfungen entfallen, Rest wie bisher
    }

    // Typ-Durchschnitts-Credits aus /einsaetze.json (v1.51): Fallback für Einsätze ohne
    // LSSM-Ø-Wert (Befund: 1263 Verbandseinsätze fielen still raus). LSSM bleibt erste Wahl,
    // weil einsatz-genau – der Typ-Schnitt ist die Näherung (im Panel mit ≈ markiert).
    const TYPE_CREDITS_KEY = 'tv_type_credits';
    const normName = (t) => (t || '').toLowerCase().replace(/\s+/g, ' ').trim();
    let typeCredits = null;
    (function loadCachedTypeCredits() {
        try {
            const c = JSON.parse(localStorage.getItem(TYPE_CREDITS_KEY) || 'null');
            if (c && c.byId && Date.now() - c.ts < 24 * 3600000) typeCredits = c;
        } catch (e) { /* egal */ }
    })();
    async function loadTypeCredits() {
        if (typeCredits) return;
        try {
            const res = await fetch('/einsaetze.json', { credentials: 'same-origin' });
            if (!res.ok) return;
            const arr = await res.json();
            const byId = {}, byName = {};
            for (const t of arr) {
                const c = Number(t.average_credits);
                if (!Number.isFinite(c) || c <= 0) continue;
                byId[String(t.id)] = c;
                if (t.name) byName[normName(t.name)] = c;
            }
            typeCredits = { ts: Date.now(), byId, byName };
            try { localStorage.setItem(TYPE_CREDITS_KEY, JSON.stringify(typeCredits)); } catch (e) { /* voll – egal */ }
            console.log(`[Top-Verband] Typ-Durchschnitte geladen: ${Object.keys(byId).length} Einsatztypen`);
        } catch (e) { console.warn('[Top-Verband] einsaetze.json nicht ladbar:', e); }
    }

    // Im Verbandschat geteilte Einsätze (v1.54): Links auf /missions/<id> aus #mission_chat_messages.
    // Diese bekommen ihr LF UNABHÄNGIG von Credits-Schwelle und dynamischer Leiter – Verbands-Etikette.
    // Nur Nachrichten der letzten CHAT_MAX_AGE_H Stunden; gesendet wird ohnehin nur, wenn der Einsatz
    // noch offen in der Sidebar steht (alte/erledigte Links laufen also ins Leere, ohne Fehler).
    const CHAT_MAX_AGE_H = 12;
    function collectChatMissionIds() {
        const ids = new Set();
        const cutoff = Date.now() - CHAT_MAX_AGE_H * 3600000;
        for (const li of document.querySelectorAll('#mission_chat_messages > li')) {
            const ts = Date.parse(li.getAttribute('data-message-time') || '') || 0;
            if (ts && ts < cutoff) continue;
            for (const a of li.querySelectorAll('a[href^="/missions/"]')) {
                const m = (a.getAttribute('href') || '').match(/\/missions\/(\d+)/);
                if (m) ids.add(m[1]);
            }
        }
        return ids;
    }

    // Einen Einsatz als "freigegeben/Verband" einstufen:
    //  - mission_panel trägt die Klasse panel-success (= an den Verband freigegeben), ODER
    //  - der Einsatzname beginnt mit "[Verband]" (Verbands-/Großlage-Einsatz).
    function isShared(panel, caption) {
        if (panel.classList.contains('panel-success')) return true;
        if (/^\s*\[Verband\]/i.test(caption)) return true;
        return false;
    }

    // Nur offene Einsätze (rot oder gelb) – grüne/fertige braucht niemand mehr anzufahren.
    function isOpen(panel) {
        return panel.classList.contains('mission_panel_red') || panel.classList.contains('mission_panel_yellow');
    }

    // Namen ohne die Adresse (<small>) und ohne abschließendes Komma.
    function cleanName(capEl) {
        if (!capEl) return '?';
        const c = capEl.cloneNode(true);
        c.querySelectorAll('small').forEach(s => s.remove());
        return c.textContent.replace(/,\s*$/, '').replace(/\s+/g, ' ').trim() || '?';
    }

    // Den geschätzten Verdienst lesen: 1) LSSM-Addon (einsatz-genau), 2) Typ-Durchschnitt
    // aus einsaetze.json (per mission_type_id des Sidebar-Eintrags, sonst per Namensabgleich).
    // Rückgabe: { val, approx } oder null.
    function readCredits(panel, name) {
        const wrap = panel.querySelector('[class*="average-credits"]');
        if (wrap) {
            const digits = wrap.textContent.replace(/[^\d]/g, '');
            if (digits) return { val: parseInt(digits, 10), approx: false };
        }
        if (typeCredits) {
            const entry = panel.closest('.missionSideBarEntry');
            const mt = (entry && entry.getAttribute('mission_type_id'))
                || panel.getAttribute('mission_type_id');
            if (mt != null && typeCredits.byId[String(mt)] != null) {
                return { val: typeCredits.byId[String(mt)], approx: true };
            }
            const key = normName((name || '').replace(/^\s*\[Verband\]\s*/i, ''));
            if (key && typeCredits.byName[key] != null) {
                return { val: typeCredits.byName[key], approx: true };
            }
        }
        return null;
    }

    // Wie viele OFFENE Verbandseinsätze haben aktuell ein eigenes LF (unterwegs oder vor Ort)?
    // Schnittmenge aus 24h-Sende-Speicher und aktuell sichtbaren offenen freigegebenen/[Verband]-Einsätzen.
    function countActiveLfEngagements() {
        let n = 0;
        for (const panel of document.querySelectorAll('[id^="mission_panel_"]')) {
            const id = panel.id.replace('mission_panel_', '');
            if (!/^\d+$/.test(id) || !isSent(id) || !isOpen(panel)) continue;
            const capEl = document.getElementById('mission_caption_' + id);
            if (!isShared(panel, cleanName(capEl))) continue;
            n++;
        }
        return n;
    }

    function collectTop(withDiag = false) {
        const list = [];
        const diag = [];
        let lssmSeen = false;
        for (const panel of document.querySelectorAll('[id^="mission_panel_"]')) {
            const id = panel.id.replace('mission_panel_', '');
            if (!/^\d+$/.test(id)) continue;
            const capEl = document.getElementById('mission_caption_' + id);
            const name = cleanName(capEl);
            const shared = isShared(panel, name);
            const open = isOpen(panel);
            const cr = readCredits(panel, name);
            const credits = cr ? cr.val : null;
            if (cr && !cr.approx) lssmSeen = true;
            if (withDiag) {
                const container = panel.closest('[id^="mission_list"]');
                diag.push({
                    id, name,
                    liste: container ? container.id : '?',
                    farbe: open ? (panel.classList.contains('mission_panel_red') ? 'rot' : 'gelb')
                         : (panel.classList.contains('mission_panel_green') ? 'grün' : 'andere'),
                    panelSuccess: panel.classList.contains('panel-success'),
                    verbandPraefix: /^\s*\[Verband\]/i.test(name),
                    alsVerbandErkannt: shared,
                    creditsWert: credits,
                    creditsQuelle: cr ? (cr.approx ? 'Typ-Schnitt' : 'LSSM') : '—',
                    in24hSpeicher: isSent(id),
                    zielStatus: !shared ? 'nicht als Verband erkannt'
                        : !open ? 'nicht offen (grün/fertig)'
                        : credits == null ? 'KEIN Ø-WERT LESBAR -> fällt still raus!'
                        : credits <= CREDIT_THRESHOLD ? `unter Schwelle (${credits.toLocaleString('de-DE')})`
                        : isSent(id) ? 'schon angefahren (24h)'
                        : 'ZIEL',
                });
            }
            if (!shared || !open) continue;
            list.push({ id, name, credits: credits == null ? -1 : credits, approx: !!(cr && cr.approx) });
        }
        list.sort((a, b) => b.credits - a.credits);
        return { list, lssmSeen, diag };
    }

    // Diagnose als Textdatei herunterladen (Shift+Klick auf ⟳): zeigt für JEDEN Einsatz der
    // Sidebar, warum er (k)ein Ziel ist – insbesondere Verbandseinsätze ohne lesbaren Ø-Wert.
    const SENDLOG_KEY = 'tv_send_log';
    let sendLog = [];
    try { sendLog = JSON.parse(localStorage.getItem(SENDLOG_KEY) || '[]') || []; } catch (e) { sendLog = []; }
    function recordCitySkip(entry) {
        sendLog.push({ ts: Date.now(), ...entry });
        if (sendLog.length > 300) sendLog = sendLog.slice(-300);
        try { localStorage.setItem(SENDLOG_KEY, JSON.stringify(sendLog)); } catch (e) { /* egal */ }
    }
    function isCityName(building, cfg) {
        const n = (building || '').toLowerCase();
        return cfg.names.some(x => x && n.includes(x));
    }
    function downloadSendLog() {
        const cfg = cityConfig();
        const cityHits = sendLog.filter(e => e.building && (isCityName(e.building, cfg))).length;
        const lines = [];
        lines.push(`Top-Verband – Innenstadt-Sende-Protokoll – ${new Date().toLocaleString('de-DE')}`);
        lines.push(`Leitstelle(n): ${cfg.leitstellen.join(', ') || '—'} | erkannte Gebäude: ${cityBuildingIds.size}`);
        lines.push(`Sendungen: ${sendLog.length} | LF von Innenstadt-Wache (Namensheuristik): ${cityHits} | übersprungene Innenstadt-LF gesamt: ${sendLog.reduce((s,e)=>s+(e.citySkipped||0),0)}`);
        lines.push('');
        lines.push('=== Sendungen (neueste zuerst) ===');
        for (const e of [...sendLog].reverse()) {
            const when = new Date(e.ts).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
            lines.push(e.noLf
                ? `${when} #${e.id} "${e.name}"${e.fromChat?' [Chat]':''}: KEIN LF${e.citySkipped?` – ${e.citySkipped} Innenstadt übersprungen`:''}`
                : `${when} #${e.id} "${e.name}"${e.fromChat?' [Chat]':''}: LF von "${e.building||'?'}"${e.citySkipped?` (${e.citySkipped} Innenstadt übersprungen)`:''}`);
        }
        const blob = new Blob([lines.join('\n')], { type:'text/plain;charset=utf-8' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = `tv-sendeprotokoll_${new Date().toISOString().slice(0,16).replace(/[:T]/g,'-')}.txt`;
        a.click(); setTimeout(()=>URL.revokeObjectURL(a.href), 5000);
    }

    function downloadDiag() {
        const { diag } = collectTop(true);
        const shared = diag.filter(d => d.alsVerbandErkannt);
        const lines = [];
        lines.push(`Top-Verband Diagnose – ${new Date().toLocaleString('de-DE')}`);
        lines.push(`Schwelle: > ${CREDIT_THRESHOLD.toLocaleString('de-DE')} | Einsätze in Sidebar: ${diag.length} | als Verband erkannt: ${shared.length}`);
        lines.push(`Ziele: ${shared.filter(d => d.zielStatus === 'ZIEL').length} | ohne Ø-Wert: ${shared.filter(d => d.zielStatus.startsWith('KEIN')).length} | schon angefahren: ${shared.filter(d => d.zielStatus.startsWith('schon')).length}`);
        lines.push('');
        lines.push('=== Als Verband erkannte Einsätze ===');
        for (const d of shared) {
            lines.push(`#${d.id} "${d.name}" | Liste: ${d.liste} | ${d.farbe} | Ø: ${d.creditsWert == null ? '—' : d.creditsWert.toLocaleString('de-DE')} (${d.creditsQuelle}) | ${d.zielStatus}`);
        }
        lines.push('');
        lines.push('=== NICHT als Verband erkannte Einsätze (zum Abgleich: fehlt hier einer, der einer sein müsste?) ===');
        for (const d of diag.filter(x => !x.alsVerbandErkannt)) {
            lines.push(`#${d.id} "${d.name}" | Liste: ${d.liste} | ${d.farbe} | panel-success: ${d.panelSuccess} | [Verband]-Präfix: ${d.verbandPraefix}`);
        }
        const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `tv-diagnose_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }

    // Klick auf eine Zeile = den echten Spiel-Button des Einsatzes klicken -> Einsatzfenster öffnet sich.
    function openMission(id) {
        const btn = document.getElementById('alarm_button_' + id) || document.getElementById('mission_caption_' + id);
        if (btn) { btn.click(); }
        else { window.location.href = '/missions/' + id; }
    }

    // Manuelle Fahrzeug-Sperrliste (gemeinsamer Schlüssel mit dem Auto-Dispatch-Skript, dort
    // über den 🚫-Button gepflegt): diese IDs werden nie in den Verband geschickt.
    function manualBlacklist() {
        try {
            const arr = JSON.parse(localStorage.getItem('lss_vehicle_blacklist') || '[]');
            return new Set((Array.isArray(arr) ? arr : []).map(String));
        } catch (e) { return new Set(); }
    }

    // Innenstadt-Leitstelle (v1.56): deren zugeordnete Gebäude liefern KEINE LFs für Verbandseinsätze
    // (Hauptfeld-Reserve). Du hinterlegst nur die LEITSTELLEN-Gebäude-ID(s) über den 🏙-Button;
    // welche Wachen dazugehören, ermittelt das Skript dynamisch aus der Gebäudeliste (/api/buildings),
    // wo jedes Gebäude sein 'leitstelle_building_id' trägt. 24h-Cache, damit kein Dauer-Abruf.
    const CITY_KEY = 'tv_city_dispatch';        // { leitstellen: [ids], names: [namensteile] }
    const CITYBLD_KEY = 'tv_city_buildings';    // Cache: { ts, ids: [gebäude-ids] }
    function cityConfig() {
        try {
            const c = JSON.parse(localStorage.getItem(CITY_KEY) || '{}');
            return { leitstellen: (c.leitstellen || []).map(String), names: (c.names || []).map(n => n.toLowerCase()) };
        } catch (e) { return { leitstellen: [], names: [] }; }
    }
    function saveCityConfig(leitstellen, names) {
        const payload = JSON.stringify({ leitstellen: leitstellen.map(String), names });
        const tryWrite = () => { localStorage.setItem(CITY_KEY, payload); return localStorage.getItem(CITY_KEY) === payload; };
        try { if (tryWrite()) return true; } catch (e) { /* Quota? -> aufräumen */ }
        // Speicher voll: die größten eigenen, verzichtbaren Posten opfern und erneut versuchen.
        for (const k of ['tv_send_log', 'tv_type_credits', 'tv_city_buildings']) { try { localStorage.removeItem(k); } catch (e) {} }
        try {
            if (tryWrite()) { console.warn('[Top-Verband] Speicher war voll – Cache/Protokoll geleert, Leitstellen-ID nun gespeichert.'); return true; }
        } catch (e) { /* immer noch nicht */ }
        console.error('[Top-Verband] Leitstellen-ID konnte NICHT gespeichert werden (localStorage verweigert – privater Modus oder Quota voll).');
        return false;
    }
    let cityBuildingIds = new Set();
    (function loadCachedCityBuildings() {
        try {
            const c = JSON.parse(localStorage.getItem(CITYBLD_KEY) || 'null');
            // Nur einen NICHT-leeren Cache übernehmen – ein leerer (0 Gebäude) soll eine echte
            // Neuauflösung nicht blockieren (Fix 22.07.: alter 0-Cache verhinderte die Erkennung).
            if (c && c.ids && c.ids.length && Date.now() - c.ts < 24 * 3600000) cityBuildingIds = new Set(c.ids.map(String));
        } catch (e) { /* egal */ }
    })();
    // Zugeordnete Gebäude der Innenstadt-Leitstelle(n) ermitteln (dynamisch, 24h-Cache).
    async function refreshCityBuildings(force = false) {
        const cfg = cityConfig();
        console.log(`[Top-Verband] Innenstadt-Auflösung startet (Leitstelle: ${cfg.leitstellen.join(', ') || 'KEINE gesetzt'}, Cache: ${cityBuildingIds.size} Gebäude, force=${force})`);
        if (!cfg.leitstellen.length) { cityBuildingIds = new Set(); return; }
        if (!force && cityBuildingIds.size) return; // Cache reicht
        try {
            const res = await fetch('/api/buildings', { credentials: 'same-origin' });
            if (!res.ok) return;
            const all = await res.json();
            const set = new Set();
            const leit = new Set(cfg.leitstellen);
            // Feldname der Leitstellen-Zuordnung variiert je nach API-Version -> mehrere probieren.
            const LEIT_FIELDS = ['leitstelle_building_id', 'leitstelle_id', 'dispatch_center_building_id', 'dispatch_center_id', 'building_leitstelle_id'];
            let usedField = null;
            for (const b of all) {
                let lid = null;
                for (const f of LEIT_FIELDS) if (b[f] != null) { lid = String(b[f]); usedField = usedField || f; break; }
                if (leit.has(String(b.id)) || (lid && leit.has(lid))) set.add(String(b.id));
            }
            cityBuildingIds = set;
            try { localStorage.setItem(CITYBLD_KEY, JSON.stringify({ ts: Date.now(), ids: [...set] })); } catch (e) { /* egal */ }
            console.log(`[Top-Verband] Innenstadt-Leitstelle: ${set.size} zugeordnete Gebäude erkannt (Leitstelle ${cfg.leitstellen.join(', ')}, Feld "${usedField || 'KEINES gefunden!'}"). API lieferte ${all.length} Gebäude.`);
            if (!set.size) {
                console.warn('[Top-Verband] ⚠️ 0 Innenstadt-Gebäude! Prüfen: stimmt die Leitstellen-ID? Verfügbare Felder eines Gebäudes:', all[0] ? Object.keys(all[0]).join(', ') : '(API leer)');
            }
        } catch (e) { console.warn('[Top-Verband] /api/buildings nicht ladbar:', e); }
    }
    // Gehört diese Fahrzeugzeile zu einem Innenstadt-Gebäude?
    function isCityVehicle(cb, cfg) {
        const tr = cb.closest('tr');
        const bid = cb.getAttribute('building_id') || (tr && tr.getAttribute('building_id'));
        if (bid) {
            for (const part of String(bid).split(/[^0-9]+/)) {
                if (!part) continue;
                if (cityBuildingIds.has(part)) return true;   // dynamisch ermittelte zugeordnete Gebäude
                if (cfg.leitstellen.includes(part)) return true; // die Leitstelle selbst (falls sie Fahrzeuge hätte)
            }
        }
        const name = (tr && tr.getAttribute('building') || '').toLowerCase();
        if (name && cfg.names.some(n => n && name.includes(n))) return true; // optionaler Namens-Fallback
        return false;
    }

    // Ausnahme-Leitstelle (v1.63): deren zugeordnete Gebäude dürfen LFs für Verbandseinsätze liefern,
    // auch wenn die 35er-Reserve (MIN_FREE_LF) schon erreicht ist – für Wachen mit viel Leerstand,
    // die die allgemeine Reserve nicht braucht (z.B. "Leitstelle Essen", Befund 31.07.: viele LF dort
    // standen komplett ungenutzt herum). Gleicher Auflösungs-Mechanismus wie Innenstadt-Leitstelle,
    // nur als eigener, unabhängiger Schlüssel.
    const EXEMPT_KEY = 'tv_exempt_dispatch';        // { leitstellen: [ids], names: [namensteile] }
    const EXEMPTBLD_KEY = 'tv_exempt_buildings';    // Cache: { ts, ids: [gebäude-ids] }
    function exemptConfig() {
        try {
            const c = JSON.parse(localStorage.getItem(EXEMPT_KEY) || '{}');
            return { leitstellen: (c.leitstellen || []).map(String), names: (c.names || []).map(n => n.toLowerCase()) };
        } catch (e) { return { leitstellen: [], names: [] }; }
    }
    function saveExemptConfig(leitstellen, names) {
        const payload = JSON.stringify({ leitstellen: leitstellen.map(String), names });
        const tryWrite = () => { localStorage.setItem(EXEMPT_KEY, payload); return localStorage.getItem(EXEMPT_KEY) === payload; };
        try { if (tryWrite()) return true; } catch (e) { /* Quota? -> aufräumen */ }
        for (const k of ['tv_send_log', 'tv_type_credits', 'tv_city_buildings', 'tv_exempt_buildings']) { try { localStorage.removeItem(k); } catch (e) {} }
        try {
            if (tryWrite()) { console.warn('[Top-Verband] Speicher war voll – Cache/Protokoll geleert, Ausnahme-Leitstellen-ID nun gespeichert.'); return true; }
        } catch (e) { /* immer noch nicht */ }
        console.error('[Top-Verband] Ausnahme-Leitstellen-ID konnte NICHT gespeichert werden (localStorage verweigert – privater Modus oder Quota voll).');
        return false;
    }
    let exemptBuildingIds = new Set();
    (function loadCachedExemptBuildings() {
        try {
            const c = JSON.parse(localStorage.getItem(EXEMPTBLD_KEY) || 'null');
            if (c && c.ids && c.ids.length && Date.now() - c.ts < 24 * 3600000) exemptBuildingIds = new Set(c.ids.map(String));
        } catch (e) { /* egal */ }
    })();
    async function refreshExemptBuildings(force = false) {
        const cfg = exemptConfig();
        if (!cfg.leitstellen.length) { exemptBuildingIds = new Set(); return; }
        if (!force && exemptBuildingIds.size) return; // Cache reicht
        try {
            const res = await fetch('/api/buildings', { credentials: 'same-origin' });
            if (!res.ok) return;
            const all = await res.json();
            const set = new Set();
            const leit = new Set(cfg.leitstellen);
            const LEIT_FIELDS = ['leitstelle_building_id', 'leitstelle_id', 'dispatch_center_building_id', 'dispatch_center_id', 'building_leitstelle_id'];
            for (const b of all) {
                let lid = null;
                for (const f of LEIT_FIELDS) if (b[f] != null) { lid = String(b[f]); break; }
                if (leit.has(String(b.id)) || (lid && leit.has(lid))) set.add(String(b.id));
            }
            exemptBuildingIds = set;
            try { localStorage.setItem(EXEMPTBLD_KEY, JSON.stringify({ ts: Date.now(), ids: [...set] })); } catch (e) { /* egal */ }
            console.log(`[Top-Verband] Ausnahme-Leitstelle: ${set.size} zugeordnete Gebäude erkannt (Leitstelle ${cfg.leitstellen.join(', ')}).`);
        } catch (e) { console.warn('[Top-Verband] /api/buildings nicht ladbar (Ausnahme-Leitstelle):', e); }
    }
    // Gehört diese Fahrzeugzeile zu einem Gebäude der Ausnahme-Leitstelle?
    function isExemptVehicle(cb, cfg) {
        const tr = cb.closest('tr');
        const bid = cb.getAttribute('building_id') || (tr && tr.getAttribute('building_id'));
        if (bid) {
            for (const part of String(bid).split(/[^0-9]+/)) {
                if (!part) continue;
                if (exemptBuildingIds.has(part)) return true;
                if (cfg.leitstellen.includes(part)) return true;
            }
        }
        const name = (tr && tr.getAttribute('building') || '').toLowerCase();
        if (name && cfg.names.some(n => n && name.includes(n))) return true;
        return false;
    }

    // Einsatzseite laden, CSRF-Token holen und ein einzelnes FREIES LF finden (erste anklickbare Checkbox
    // mit passendem vehicle_type_id). Gibt { token, lfId } zurück; lfId = null, wenn kein LF frei ist.
    // exemptOnly = true: nur LFs der Ausnahme-Leitstelle akzeptieren (wird genutzt, wenn die 35er-
    // Reserve schon erreicht ist – diese Wachen dürfen trotzdem weiter liefern, siehe doSend()).
    async function findFreeLf(missionId, exemptOnly = false) {
        const res = await fetch(`/missions/${missionId}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        const token = doc.querySelector('form[action*="alarm"] input[name="authenticity_token"]')?.value
                   || doc.querySelector('meta[name="csrf-token"]')?.content;
        if (!token) throw new Error('kein Token');
        let lfId = null, lfBuilding = null, citySkipped = 0;
        const blocked = manualBlacklist();
        const cfg = cityConfig();
        const exCfg = exemptOnly ? exemptConfig() : null;
        for (const cb of doc.querySelectorAll('.vehicle_checkbox:not([disabled])')) {
            const t = Number(cb.getAttribute('vehicle_type_id'));
            if (!LF_TYPE_IDS.includes(t)) continue;
            if (blocked.has(String(cb.value))) continue;   // manuelle Fahrzeug-Sperrliste
            if (isCityVehicle(cb, cfg)) { citySkipped++; continue; } // Innenstadt bleibt zu Hause
            if (exemptOnly && !isExemptVehicle(cb, exCfg)) continue; // Reserve knapp -> nur Ausnahme-Leitstelle
            lfId = cb.value;
            const tr = cb.closest('tr');
            lfBuilding = (tr && tr.getAttribute('building')) || null;
            break;
        }
        return { token, lfId, lfBuilding, citySkipped };
    }

    // Kern: an die übergebenen Ziele je 1 LF senden. onProgress(text) optional für Statusanzeige.
    // Gibt { sent, noLf, err, aborted } zurück. Keine Bestätigung – die macht ggf. der Aufrufer.
    async function doSend(targets, onProgress) {
        // Sicherstellen, dass die Innenstadt-Gebäude aufgelöst sind, BEVOR das erste LF gesucht wird.
        // (Fix: in v1.56 konnte die Auflösung ausbleiben -> Innenstadt-LFs rutschten durch.)
        if (cityConfig().leitstellen.length && !cityBuildingIds.size) await refreshCityBuildings(true);
        const hasExempt = exemptConfig().leitstellen.length > 0;
        if (hasExempt && !exemptBuildingIds.size) await refreshExemptBuildings(true);
        let sent = 0, exemptSent = 0, noLf = 0, err = 0, aborted = false, alreadyBound = 0, reserveHeld = 0;
        lastThresholdInfo = ''; // pro Durchlauf frisch (harter Stopp nutzt sonst veralteten Text)
        if (onProgress) onProgress('Prüfe LF-Reserve und laufende Einsätze…');
        const state = await fetchLfState(); // null = API nicht verfügbar
        const boundIds = state ? state.boundIds : null;
        let freeLeft = state ? state.freeCount : null;
        for (let i = 0; i < targets.length; i++) {
            const m = targets[i];
            if (boundIds && boundIds.has(String(m.id))) {
                markSent(m.id); // Serverwahrheit ins lokale 24h-Gedächtnis übernehmen
                alreadyBound++;
                continue;
            }
            // Harter Stopp: unter MIN_FREE_LF freien LFs wird nichts mehr in den Verband geschickt.
            // (Kein markSent – die Einsätze bleiben Ziele und werden bedient, sobald wieder Luft ist.)
            // Ausnahme (v1.63): ist eine Ausnahme-Leitstelle konfiguriert (z.B. Wachen mit viel
            // Leerstand), darf DEREN LF trotzdem raus – der Stopp gilt dann nur noch für alle anderen.
            const reserveTight = freeLeft != null && freeLeft <= MIN_FREE_LF;
            if (reserveTight && !hasExempt) {
                reserveHeld = targets.length - i; // alle ab hier unbearbeiteten Ziele bleiben für später
                break;
            }
            // Dynamische Schwelle: steigt, je weniger LFs frei sind. Chat-geteilte Einsätze sind
            // ausgenommen (stehen sortiert vorn). Da die übrigen Ziele nach Verdienst absteigend
            // sortiert sind und die Schwelle beim Senden nur steigen kann, dürfen wir beim ersten
            // Nicht-Chat-Ziel unterhalb der aktuellen Schwelle abbrechen. Bei knapper Reserve mit
            // Ausnahme-Leitstelle wird nicht abgebrochen, sondern nur die normale Suche übersprungen.
            const thr = effectiveThreshold(freeLeft);
            const belowThreshold = !m.fromChat && m.credits <= thr;
            if (belowThreshold && !reserveTight) {
                reserveHeld = targets.length - i;
                lastThresholdInfo = freeLeft != null ? `Schwelle ${thr.toLocaleString('de-DE')} bei ${freeLeft} freien LF` : '';
                break;
            }
            if (onProgress) onProgress(`Sende… (${i + 1}/${targets.length}) – #${m.id}`);
            try {
                // Reserve knapp -> nur noch nach einem LF der Ausnahme-Leitstelle suchen (bei
                // belowThreshold bleibt es sonst ohnehin bei "kein LF frei", also kein Sonderfall nötig).
                const { token, lfId, lfBuilding, citySkipped } = await findFreeLf(m.id, reserveTight);
                if (!lfId) {
                    noLf++;
                    if (reserveTight) reserveHeld++; // kein Ausnahme-LF für dieses Ziel -> für später vormerken
                    recordCitySkip({ id: m.id, name: m.name, building: null, citySkipped, noLf: true, fromChat: !!m.fromChat });
                    continue;
                }
                const body = new URLSearchParams();
                body.append('authenticity_token', token);
                body.append('commit', 'Alarmieren');
                body.append('next_mission', '0');
                body.append('vehicle_ids[]', lfId);
                const post = await fetch(`/missions/${m.id}/alarm`, {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: body.toString(),
                });
                if (post.status === 429) { aborted = true; break; } // Rate-Limit -> abbrechen
                if (!post.ok && post.status !== 302) { err++; continue; }
                markSent(m.id);
                sent++;
                if (reserveTight) exemptSent++;
                if (freeLeft != null) freeLeft--;
                recordCitySkip({ id: m.id, name: m.name, building: lfBuilding, citySkipped, noLf: false, fromChat: !!m.fromChat });
            } catch (e) {
                err++;
            }
            await new Promise(r => setTimeout(r, SEND_DELAY));
        }
        return { sent, exemptSent, noLf, err, aborted, alreadyBound, reserveHeld };
    }

    function resultText(r) {
        return `${r.sent} LF gesendet`
            + (r.exemptSent ? ` (davon ${r.exemptSent} von der Ausnahme-Leitstelle trotz knapper Reserve)` : '')
            + (r.alreadyBound ? `, ${r.alreadyBound}× übersprungen (eigenes LF schon unterwegs)` : '')
            + (r.reserveHeld ? `, ${r.reserveHeld} zurückgestellt (${lastThresholdInfo || `Reserve: min. ${MIN_FREE_LF} LF frei halten`})` : '')
            + (r.noLf ? `, ${r.noLf}× kein LF frei` : '')
            + (r.err ? `, ${r.err} Fehler` : '')
            + (r.aborted ? ' (Rate-Limit – Abbruch)' : '') + '.';
    }

    // Manueller Button: mit Bestätigung und Statusanzeige im Panel.
    async function sendLfToAll(panel) {
        const { list } = collectTop();
        const chatIds = collectChatMissionIds();
        const targets = list
            .filter(m => (m.credits > CREDIT_THRESHOLD || chatIds.has(m.id)) && !isSent(m.id))
            .map(m => ({ ...m, fromChat: chatIds.has(m.id) }))
            .sort((a, b) => (b.fromChat - a.fromChat) || (b.credits - a.credits)); // Chat zuerst, dann nach Wert
        const $status = panel.querySelector('#tv-status');

        if (!targets.length) {
            $status.innerHTML = `<span style="color:#f9e2af;">Keine (neuen) Einsätze über ${CREDIT_THRESHOLD.toLocaleString('de-DE')} 💰 gefunden.</span>`;
            return;
        }
        if (!window.confirm(`An ${targets.length} Einsätze über ${CREDIT_THRESHOLD.toLocaleString('de-DE')} 💰 je 1 LF senden?`)) {
            return;
        }
        const btn = panel.querySelector('#tv-sendlf');
        if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
        const r = await doSend(targets, t => { $status.innerHTML = t; });
        if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
        render(panel);
        panel.querySelector('#tv-status').innerHTML = `✅ Fertig: ${resultText(r)}`;
    }

    // Automatik-Tick: alle 3 min. Liste aktualisieren und – wenn Automatik AN – ohne Rückfrage senden.
    let autoRunning = false;
    async function autoTick() {
        if (cityConfig().leitstellen.length && !cityBuildingIds.size) await refreshCityBuildings(true);
        const panel = document.getElementById('tv-panel');
        if (panel) render(panel); // Anzeige auffrischen, falls offen
        if (!autoMode || autoRunning) return;
        const { list } = collectTop();
        const chatIds = collectChatMissionIds();
        const targets = list
            .filter(m => (m.credits > CREDIT_THRESHOLD || chatIds.has(m.id)) && !isSent(m.id))
            .map(m => ({ ...m, fromChat: chatIds.has(m.id) }))
            .sort((a, b) => (b.fromChat - a.fromChat) || (b.credits - a.credits)); // Chat zuerst, dann nach Wert
        if (!targets.length) { setAutoStamp(); return; }
        autoRunning = true;
        const r = await doSend(targets, t => { const p = document.getElementById('tv-panel'); if (p) p.querySelector('#tv-status').innerHTML = '🤖 ' + t; });
        autoRunning = false;
        setAutoStamp();
        console.log(`[Top-Verband] Automatik: ${resultText(r)}`);
        const p2 = document.getElementById('tv-panel');
        if (p2) { render(p2); p2.querySelector('#tv-status').innerHTML = `🤖 Automatik: ${resultText(r)}`; }
    }

    let lastAutoStamp = '';
    let lastThresholdInfo = ''; // zuletzt angewandte dynamische Schwelle (für Status-/Ergebnistexte)
    function setAutoStamp() { lastAutoStamp = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }); }


    function render(panel) {
        const { list, lssmSeen } = collectTop();
        const $status = panel.querySelector('#tv-status');
        const $result = panel.querySelector('#tv-result');

        if (list.length === 0) {
            $status.textContent = 'Keine offenen freigegebenen/Verband-Einsätze gefunden.';
            $result.innerHTML = '';
            return;
        }

        const noValue = list.filter(m => m.credits < 0).length;
        const overThreshold = list.filter(m => m.credits > CREDIT_THRESHOLD);
        const targets = overThreshold.filter(m => !isSent(m.id));   // echte Button-Ziele (noch nicht in 24h gesendet)
        const alreadyDone = overThreshold.filter(m => isSent(m.id)); // über Schwelle, aber in 24h schon angefahren
        const below = list.filter(m => m.credits <= CREDIT_THRESHOLD).slice(0, TOP_N);
        const shown = [...targets, ...alreadyDone, ...below]; // Ziele zuerst, dann erledigte, dann Kontext

        if (!lssmSeen) {
            $status.innerHTML = `<span style="color:#f9e2af;">${list.length} freigegebene Einsätze gefunden, aber kein Verdienst-Wert lesbar.</span> Ist im LSSM-Addon die „Ø Credits"-Spalte in der Einsatzliste aktiv?`;
        } else {
            const chatIds = collectChatMissionIds();
            const chatOpen = list.filter(m => chatIds.has(m.id) && !isSent(m.id)).length;
            const cityCfgNow = cityConfig();
            const cityWarn = cityCfgNow.leitstellen.length && !cityBuildingIds.size;
            const doneCount = Object.keys(sentStore).length; // alle in den letzten 24 h angefahrenen Verbandseinsätze
            const activeNow = countActiveLfEngagements();     // davon noch offen -> LF aktuell gebunden
            $status.innerHTML = `<b style="color:#f38ba8;">${targets.length}</b> über ${CREDIT_THRESHOLD.toLocaleString('de-DE')} 💰 offen`
                + ` · <b style="color:#89b4fa;" title="Offene Verbandseinsätze, die in den letzten 24 h ein eigenes LF bekommen haben – das LF ist dort unterwegs oder vor Ort gebunden">🚒 ${activeNow} LF aktuell gebunden</b>`
                + (chatOpen ? ` · <b style="color:#fab387;" title="Im Verbandschat geteilte Einsätze ohne eigenes LF – werden unabhängig von der Credits-Schwelle angefahren">💬 ${chatOpen} Chat-Einsätze offen</b>` : '')
                + ` · <b style="color:#a6e3a1;">${doneCount} angefahren (24 h)</b>`
                + ` · ${autoMode ? `<span style="color:#a6e3a1;">Automatik AN${lastAutoStamp ? ` (zuletzt ${lastAutoStamp})` : ''}</span>` : '<span style="color:#9399b2;">Automatik aus</span>'}`
                + (noValue ? `<br><span style="color:#f9e2af;" title="Diese Verbandseinsätze haben keinen lesbaren Ø-Credits-Wert (LSSM) und können deshalb NIE Ziel werden – Diagnose: Shift+Klick auf ⟳">⚠️ ${noValue} Verbandseinsatz${noValue > 1 ? 'e' : ''} ohne Ø-Wert – fallen still raus!</span>` : '');
        }

        let html = '';
        shown.forEach((m) => {
            const over = m.credits > CREDIT_THRESHOLD;
            const done = over && isSent(m.id);
            const target = over && !done;
            const credTxt = m.credits >= 0 ? (m.approx ? '≈ ' : '') + m.credits.toLocaleString('de-DE') + ' 💰' : '– kein Wert –';
            const icon = done ? '✓' : (target ? '🚒' : '·');
            const rowBg = target ? 'background:rgba(243,139,168,.10);' : (done ? 'opacity:.55;' : '');
            const credColor = target ? '#f38ba8' : (done ? '#9399b2' : '#a6e3a1');
            const sub = done ? ' · in 24 h schon angefahren' : (target ? ' · Button-Ziel' : '');
            html += `<div class="tv-row" data-id="${m.id}" style="display:flex;align-items:center;gap:8px;padding:7px 6px;border-bottom:1px solid #313244;cursor:pointer;${rowBg}">
                <div style="font-size:14px;min-width:18px;text-align:center;">${icon}</div>
                <div style="flex:1;min-width:0;">
                    <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${m.name}</div>
                    <div style="color:#9399b2;font-size:11px;">#${m.id}${sub} · zum Öffnen klicken</div>
                </div>
                <div style="text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;color:${credColor};font-weight:600;">${credTxt}</div>
            </div>`;
        });
        if (targets.length > 0 && below.length > 0) {
            html += `<div style="color:#9399b2;font-size:10px;padding:6px;">↑ 🚒 = Ziel des Sende-Buttons (über ${CREDIT_THRESHOLD.toLocaleString('de-DE')}). ✓ = in 24 h schon angefahren. Darunter: nächstgrößte zur Info.</div>`;
        }
        $result.innerHTML = html;
        $result.querySelectorAll('.tv-row').forEach(row => {
            const baseBg = row.style.background;
            row.addEventListener('click', () => openMission(row.getAttribute('data-id')));
            row.addEventListener('mouseenter', () => row.style.background = '#313244');
            row.addEventListener('mouseleave', () => row.style.background = baseBg);
        });
    }

    function buildPanel() {
        if (document.getElementById('tv-panel')) { render(document.getElementById('tv-panel')); return; }
        const panel = document.createElement('div');
        panel.id = 'tv-panel';
        panel.style.cssText = 'position:fixed;top:120px;right:20px;z-index:99999;width:340px;max-height:70vh;display:flex;flex-direction:column;background:#1e1e2e;color:#cdd6f4;border:1px solid #45475a;border-radius:10px;padding:14px;font:13px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);';
        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <b style="font-size:14px;">💰 Top-Verband-Einsätze</b>
                <div>
                    <button id="tv-refresh" title="Aktualisieren" style="background:none;border:none;color:#cdd6f4;cursor:pointer;font-size:15px;">⟳</button>
                    <button id="tv-close" style="background:none;border:none;color:#cdd6f4;cursor:pointer;font-size:16px;">✕</button>
                </div>
            </div>
            <div id="tv-status" style="margin-bottom:8px;font-size:12px;"></div>
            <div style="display:flex;gap:6px;margin-bottom:8px;">
                <button id="tv-sendlf" title="Jetzt einmalig an alle offenen Einsätze über der Schwelle je 1 LF senden" style="flex:1;padding:7px 10px;background:#f38ba8;color:#1e1e2e;border:none;border-radius:6px;font-weight:600;cursor:pointer;">🚒 Jetzt senden &gt; ${CREDIT_THRESHOLD.toLocaleString('de-DE')} 💰</button>
                <button id="tv-auto" title="Automatik: alle 3 Minuten aktualisieren und ohne Rückfrage je 1 LF senden" style="padding:7px 10px;border:none;border-radius:6px;font-weight:600;cursor:pointer;white-space:nowrap;">🤖 Auto</button>
                <button id="tv-city" title="Innenstadt-Leitstelle festlegen (deren LFs bleiben zu Hause). Shift+Klick = Sende-Protokoll herunterladen (zeigt, von welcher Wache jedes LF kam)." style="padding:7px 10px;border:none;border-radius:6px;font-weight:600;cursor:pointer;white-space:nowrap;background:#45475a;color:#cdd6f4;">🏙</button>
                <button id="tv-exempt" title="Ausnahme-Leitstelle festlegen: deren LFs dürfen weiter Verbandseinsätze bedienen, auch wenn die 35er-Reserve schon erreicht ist (für Wachen mit viel Leerstand, z.B. Leitstelle Essen)." style="padding:7px 10px;border:none;border-radius:6px;font-weight:600;cursor:pointer;white-space:nowrap;background:#45475a;color:#cdd6f4;">🔓</button>
            </div>
            <div id="tv-result" style="overflow:auto;flex:1;"></div>
            <div style="color:#9399b2;font-size:10px;margin-top:8px;">Wert = geschätzter Verdienst aus dem LSSM-Addon. Nur offene (rot/gelb) freigegebene bzw. Verband-Einsätze.</div>
        `;
        document.body.appendChild(panel);
        panel.querySelector('#tv-close').onclick = () => panel.remove();
        panel.querySelector('#tv-refresh').onclick = (e) => { if (e.shiftKey) { downloadDiag(); return; } render(panel); };
        panel.querySelector('#tv-refresh').title = 'Aktualisieren (Shift+Klick = Diagnose-Datei: warum ist welcher Einsatz (k)ein Ziel?)';
        panel.querySelector('#tv-sendlf').onclick = () => sendLfToAll(panel);
        panel.querySelector('#tv-city').onclick = async (e) => {
            if (e.shiftKey) { downloadSendLog(); return; }
            const c = cityConfig();
            const idIn = window.prompt(
                'INNENSTADT-LEITSTELLE(N) – alle zugeordneten Wachen liefern dann KEINE LFs für\n' +
                'Verbandseinsätze (Hauptfeld-Reserve). Welche Wachen dazugehören, findet das Skript selbst.\n\n' +
                'Leitstellen-Gebäude-ID(s) eintragen (aus der URL /buildings/<ID> der Leitstelle),\n' +
                'mehrere mit Komma. Leeren = Sperre aus.', c.leitstellen.join(', '));
            if (idIn === null) return;
            const nameIn = window.prompt(
                'Optionaler Namens-Fallback (falls die API mal nicht greift): Namensteile der Innenstadt-\n' +
                'Wachen, case-egal, mit Komma. Meist NICHT nötig. Leeren = kein Namens-Fallback.', c.names.join(', '));
            if (nameIn === null) return;
            const leitstellen = (idIn.match(/\d+/g) || []);
            const names = nameIn.split(',').map(x => x.trim()).filter(Boolean);
            const saved = saveCityConfig(leitstellen, names);
            const p = document.getElementById('tv-panel');
            const $s = p && p.querySelector('#tv-status');
            if (!saved) {
                if ($s) $s.innerHTML = '<span style="color:#f38ba8;">⚠️ Speichern fehlgeschlagen (localStorage). Leitstellen-ID konnte nicht abgelegt werden – Speicher voll oder privater Modus.</span>';
                return;
            }
            if ($s) $s.innerHTML = '🏙 Ermittle zugeordnete Wachen…';
            cityBuildingIds = new Set();
            await refreshCityBuildings(true);
            if ($s) $s.innerHTML = leitstellen.length
                ? `🏙 Innenstadt-Leitstelle gespeichert: ${leitstellen.length} Leitstelle(n), ${cityBuildingIds.size} zugeordnete Gebäude – deren LFs bleiben zu Hause.`
                : '🏙 Innenstadt-Sperre deaktiviert.';
        };
        panel.querySelector('#tv-exempt').onclick = async () => {
            const c = exemptConfig();
            const idIn = window.prompt(
                'AUSNAHME-LEITSTELLE(N) – alle zugeordneten Wachen dürfen weiter Verbandseinsätze mit LF\n' +
                'bedienen, auch wenn die 35er-Reserve (MIN_FREE_LF) schon erreicht ist. Gedacht für Wachen mit\n' +
                'viel Leerstand (z.B. "Leitstelle Essen"). Bei knapper Reserve gilt für diese LFs auch KEINE\n' +
                'Verdienst-Mindestschwelle mehr.\n\n' +
                'Leitstellen-Gebäude-ID(s) eintragen (aus der URL /buildings/<ID> der Leitstelle),\n' +
                'mehrere mit Komma. Leeren = Ausnahme aus.', c.leitstellen.join(', '));
            if (idIn === null) return;
            const nameIn = window.prompt(
                'Optionaler Namens-Fallback (falls die API mal nicht greift): Namensteile der Ausnahme-\n' +
                'Wachen, case-egal, mit Komma. Meist NICHT nötig. Leeren = kein Namens-Fallback.', c.names.join(', '));
            if (nameIn === null) return;
            const leitstellen = (idIn.match(/\d+/g) || []);
            const names = nameIn.split(',').map(x => x.trim()).filter(Boolean);
            const saved = saveExemptConfig(leitstellen, names);
            const p = document.getElementById('tv-panel');
            const $s = p && p.querySelector('#tv-status');
            if (!saved) {
                if ($s) $s.innerHTML = '<span style="color:#f38ba8;">⚠️ Speichern fehlgeschlagen (localStorage). Ausnahme-Leitstellen-ID konnte nicht abgelegt werden – Speicher voll oder privater Modus.</span>';
                return;
            }
            if ($s) $s.innerHTML = '🔓 Ermittle zugeordnete Wachen…';
            exemptBuildingIds = new Set();
            await refreshExemptBuildings(true);
            if ($s) $s.innerHTML = leitstellen.length
                ? `🔓 Ausnahme-Leitstelle gespeichert: ${leitstellen.length} Leitstelle(n), ${exemptBuildingIds.size} zugeordnete Gebäude – deren LFs dürfen auch bei knapper Reserve raus.`
                : '🔓 Ausnahme-Regel deaktiviert.';
        };
        const $auto = panel.querySelector('#tv-auto');
        const paintAuto = () => {
            $auto.style.background = autoMode ? '#a6e3a1' : '#45475a';
            $auto.style.color = autoMode ? '#1e1e2e' : '#cdd6f4';
            $auto.textContent = autoMode ? '🤖 Auto: AN' : '🤖 Auto: aus';
        };
        paintAuto();
        $auto.onclick = () => {
            setAuto(!autoMode);
            paintAuto();
            render(panel);
            if (autoMode) autoTick(); // sofort einmal laufen, wenn gerade eingeschaltet
        };
        render(panel);
    }

    function addButton() {
        if (document.getElementById('tv-openbtn')) return;
        // Bevorzugt in die obere Spielleiste (Navbar) – stört das Spielfeld nicht.
        const navUl = document.querySelector('#main_navbar #navbar-main-collapse ul.navbar-nav');
        if (navUl) {
            const li = document.createElement('li');
            li.id = 'tv-openbtn';
            li.innerHTML = `<a href="#" title="Top-Verband-Einsätze: wertvollste freigegebene Einsätze + Auto-LF" style="font-size:16px;">💰</a>`;
            li.querySelector('a').onclick = (e) => { e.preventDefault(); buildPanel(); };
            navUl.insertBefore(li, navUl.firstChild);
            return;
        }
        const btn = document.createElement('button');
        btn.id = 'tv-openbtn';
        btn.textContent = '💰 Top-Verband';
        btn.style.cssText = 'position:fixed;top:120px;right:20px;z-index:99998;padding:8px 12px;background:#f9e2af;color:#1e1e2e;border:none;border-radius:8px;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.3);';
        btn.onclick = buildPanel;
        document.body.appendChild(btn);
    }

    function startAuto() {
        loadTypeCredits(); // Typ-Durchschnitte im Hintergrund laden (24h-Cache)
        refreshCityBuildings(); // Innenstadt-Gebäude auflösen (nutzt 24h-Cache, lädt nur bei Bedarf)
        setInterval(autoTick, AUTO_INTERVAL);
        // Wenn Automatik schon eingeschaltet war (aus früherer Sitzung), nach kurzer Wartezeit
        // (Seite/LSSM müssen geladen sein) einmal sofort laufen.
        if (autoMode) setTimeout(autoTick, 15000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { addButton(); startAuto(); });
    } else {
        addButton();
        startAuto();
    }
})();