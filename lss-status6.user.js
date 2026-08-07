// ==UserScript==
// @name         LSS Status 6 (nicht einsatzbereit) + Lehrgangs-Check
// @namespace    http://tampermonkey.net/
// @version      1.05
// @downloadURL  https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-status6.user.js
// @updateURL    https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-status6.user.js
// @description  Listet alle Fahrzeuge im FMS-Status 6 (nicht einsatzbereit) und zeigt pro Fahrzeug den Grund (kein Personal / Personal ohne Lehrgang / anderer) sowie den Lehrgangs-Abgleich des zugewiesenen Personals. Neu: 🔧 Automatisch beheben – weist fehlendes Personal (nur wirklich freie Personen, nie von anderen Fahrzeugen abgezogen) automatisch zu und setzt einsatzbereite Fahrzeuge per API auf FMS 2. Alle Aktionen landen im 📋 Protokoll.
// @match        https://www.leitstellenspiel.de/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';
    // ==== Gemeinsames Analyse-Menü (geteilt über alle Analyse-Skripte) ====
    // Das erste Skript, das lädt, erstellt das 🛠️-Dropdown in der Navbar. Jedes Skript registriert
    // seinen Eintrag über window.lssToolsMenu.add(id, label, onClick). Reihenfolge stabil nach 'order'.
    function ensureToolsMenu() {
        if (window.lssToolsMenu) return window.lssToolsMenu;
        const api = {
            entries: [],
            add(id, label, onClick, order = 100) {
                if (this.entries.some(e => e.id === id)) return;
                this.entries.push({ id, label, onClick, order });
                this.entries.sort((a, b) => a.order - b.order);
                this.rebuild();
            },
            rebuild() {
                const menu = document.getElementById('lss-tools-dropdown');
                if (!menu) return;
                menu.innerHTML = '';
                for (const e of this.entries) {
                    const item = document.createElement('a');
                    item.href = '#';
                    item.textContent = e.label;
                    item.style.cssText = 'display:block;padding:7px 14px;color:#cdd6f4;text-decoration:none;white-space:nowrap;font-size:13px;';
                    item.onmouseenter = () => item.style.background = '#313244';
                    item.onmouseleave = () => item.style.background = 'transparent';
                    item.onclick = (ev) => { ev.preventDefault(); menu.style.display = 'none'; e.onClick(); };
                    menu.appendChild(item);
                }
            },
            mount() {
                if (document.getElementById('lss-tools-openbtn')) return;
                const navUl = document.querySelector('#main_navbar #navbar-main-collapse ul.navbar-nav');
                const openMenu = (anchorRect) => {
                    const menu = document.getElementById('lss-tools-dropdown');
                    if (!menu) return;
                    const show = menu.style.display === 'none' || !menu.style.display;
                    menu.style.display = show ? 'block' : 'none';
                    if (show && anchorRect) { menu.style.top = (anchorRect.bottom + 4) + 'px'; menu.style.right = Math.max(8, window.innerWidth - anchorRect.right) + 'px'; }
                };
                // Dropdown-Container (fixed, an den Button angedockt)
                const dd = document.createElement('div');
                dd.id = 'lss-tools-dropdown';
                dd.style.cssText = 'position:fixed;display:none;z-index:100000;background:#1e1e2e;border:1px solid #45475a;border-radius:8px;padding:4px 0;box-shadow:0 6px 24px rgba(0,0,0,.4);min-width:190px;';
                document.body.appendChild(dd);
                // Schließen bei Klick außerhalb
                document.addEventListener('click', (ev) => {
                    const btn = document.getElementById('lss-tools-openbtn');
                    if (dd.style.display === 'block' && !dd.contains(ev.target) && btn && !btn.contains(ev.target)) dd.style.display = 'none';
                });
                if (navUl) {
                    const li = document.createElement('li');
                    li.id = 'lss-tools-openbtn';
                    li.innerHTML = `<a href="#" title="Analyse-Tools"><span style="font-size:15px;">🛠️</span></a>`;
                    li.querySelector('a').onclick = (ev) => { ev.preventDefault(); openMenu(li.getBoundingClientRect()); };
                    navUl.insertBefore(li, navUl.firstChild);
                } else {
                    const btn = document.createElement('button');
                    btn.id = 'lss-tools-openbtn';
                    btn.textContent = '🛠️ Tools';
                    btn.style.cssText = 'position:fixed;top:150px;right:20px;z-index:99998;padding:8px 12px;background:#f9e2af;color:#1e1e2e;border:none;border-radius:8px;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.3);';
                    btn.onclick = () => openMenu(btn.getBoundingClientRect());
                    document.body.appendChild(btn);
                }
                this.rebuild();
            },
        };
        window.lssToolsMenu = api;
        // Menü aufbauen, sobald DOM bereit ist
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => api.mount());
        else api.mount();
        return api;
    }

    if (window.top !== window.self) return;

    const CONFIG = {
        concurrency: 4,
        fetchDelayMs: 150,
        cacheMs: 2 * 3600000,   // Status ändert sich häufiger -> kürzerer Cache als beim Lehrgangs-Skript
    };

    const RES_KEY = 'status6_results';
    const RES_VER = 1;
    let results = {};
    try {
        const raw = JSON.parse(localStorage.getItem(RES_KEY) || 'null');
        if (raw && raw.__ver === RES_VER) results = raw.data || {};
    } catch (e) { results = {}; }
    function persist() {
        const payload = JSON.stringify({ __ver: RES_VER, data: results });
        try { localStorage.setItem(RES_KEY, payload); return true; }
        catch (e) {
            for (const k of ['ad_log_buffer', 'ad_audit_buffer', 'tv_send_log']) { try { localStorage.removeItem(k); } catch (x) {} }
            try { localStorage.setItem(RES_KEY, payload); return true; } catch (x) { return false; }
        }
    }

    // Gebäude-Namen (building_id -> caption), 24h-Cache – wie im Lehrgangs-Skript.
    let buildingNames = {};
    const BLD_KEY = 'status6_buildings';
    (function () {
        try { const c = JSON.parse(localStorage.getItem(BLD_KEY) || 'null'); if (c && Date.now() - c.ts < 24 * 3600000) buildingNames = c.map || {}; } catch (e) {}
    })();
    async function loadBuildingNames() {
        if (Object.keys(buildingNames).length) return;
        try {
            const res = await fetch('/api/buildings', { credentials: 'same-origin', cache: 'no-store' });
            if (!res.ok) return;
            const first = await res.json();
            const map = {};
            const scan = (arr) => { for (const b of arr) map[String(b.id)] = b.caption || ('#' + b.id); };
            if (Array.isArray(first)) {
                scan(first);
                const ps = first.length;
                if (ps >= 100) for (let off = ps; off < 50000; off += ps) {
                    const r = await fetch(`/api/buildings?limit=${ps}&offset=${off}`, { credentials: 'same-origin', cache: 'no-store' });
                    if (!r.ok) break; const pg = await r.json(); if (!Array.isArray(pg) || !pg.length) break; scan(pg); if (pg.length < ps) break;
                }
            } else if (first && Array.isArray(first.buildings)) scan(first.buildings);
            buildingNames = map;
            try { localStorage.setItem(BLD_KEY, JSON.stringify({ ts: Date.now(), map })); } catch (e) {}
        } catch (e) { /* ohne Namen weiter */ }
    }

    // Nur Fahrzeuge im echten FMS-Status 6 (nicht einsatzbereit).
    async function loadStatus6() {
        await loadBuildingNames();
        const res = await fetch('/api/vehicles', { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) throw new Error(`/api/vehicles HTTP ${res.status}`);
        const all = await res.json();
        return all.filter(v => Number(v.fms_real) === 6).map(v => ({
            id: String(v.id),
            name: v.caption || `#${v.id}`,
            building: buildingNames[String(v.building_id)] || '',
            typeName: v.vehicle_type_caption || '',
        }));
    }

    // Zuweisungsseite auswerten: Personalzahl, Lehrgangsbedarf, laufende Ausbildung.
    function analyzeAssignment(html) {
        // 1) Zugewiesenes Personal = Anzahl "Fahrzeugbindung entfernen"-Links (wie im ohne-Personal-Skript)
        const assigned = (html.match(/Fahrzeugbindung entfernen/gi) || []).length;

        // 2) Lehrgangsbedarf-Block "(n/m) Lehrgang" (wie im Lehrgangs-Skript)
        let need = [], reqBlock = false, anyUnmet = false;
        const m = html.match(/id="required_personnel"[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/div>/i);
        if (m) {
            reqBlock = true;
            const cls = m[1];
            const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            const re = /\((\d+)\s*\/\s*(\d+)\)\s*([A-Za-zÄÖÜäöüß0-9 .\-\/]+?)(?=\(|$|,)/g;
            let mm;
            while ((mm = re.exec(text)) !== null) {
                const have = parseInt(mm[1], 10), req = parseInt(mm[2], 10);
                need.push({ label: mm[3].trim(), have, req, ok: have >= req });
            }
            anyUnmet = /alert-danger/i.test(cls) || need.some(n => !n.ok);
        }

        // 3) Laufende Ausbildungen
        const inTraining = [];
        const rt = /Im Unterricht:\s*<a[^>]*>([^<]+)<\/a>/gi; let t;
        while ((t = rt.exec(html)) !== null) inTraining.push(t[1].trim());

        // 4) Grund klassifizieren
        let reason;
        if (assigned === 0) reason = 'kein-personal';
        else if (reqBlock && anyUnmet) reason = 'lehrgang-fehlt';
        else reason = 'anderer';

        return { assigned, need, reqBlock, anyUnmet, inTraining, reason };
    }

    async function checkVehicle(v) {
        const res = await fetch(`/vehicles/${v.id}/zuweisung`, { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) return null;
        const html = await res.text();
        const a = analyzeAssignment(html);
        results[v.id] = { ...a, name: v.name, building: v.building, ts: Date.now() };
        return results[v.id];
    }

    // ==== Automatische Behebung (v1.03) ====
    // Ursache vor Symptom: alle drei Bausteine unten sind gegen echtes HTML von
    // /vehicles/<id>/zuweisung verifiziert (Endpunkt, CSRF, Button-Klassen, Lehrgangs-Mapping).

    // DOMParser statt Regex: die Attribut-Reihenfolge im <meta>-Tag ist nicht garantiert
    // (verifiziert: hier stand "content" VOR "name") – DOMParser ist davon unabhängig.
    function getCsrfToken(html) {
        try {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            return doc.querySelector('meta[name="csrf-token"]')?.content || null;
        } catch (e) { return null; }
    }

    // Lehrgangs-Schlüssel <-> Klartext-Name aus dem "Lehrgangsfilter"-Dropdown der Fahrzeugseite
    // (z.B. "disaster_response_technology" <-> "SEG - Technik und Sicherheit").
    function parseEducationKeyMap(html) {
        const map = {};
        const sel = html.match(/<select[^>]*class="[^"]*education-filter[^"]*"[\s\S]*?<\/select>/i);
        if (!sel) return map;
        const re = /<option value="([^"]+)"[^>]*>([^<]+)<\/option>/gi;
        let m;
        while ((m = re.exec(sel[0])) !== null) {
            const key = m[1], label = m[2].trim();
            if (key === 'all' || key === 'no-education') continue;
            map[label] = key;
        }
        return map;
    }

    // Personal-Tabelle: pro Zeile personalId, Name, Lehrgangs-Schlüssel + Zuweisungs-Zustand.
    // WICHTIG: die "Status"-Spalte (Verfügbar/Im Fahrzeug) zeigt nur, ob die Person GERADE
    // unterwegs ist – NICHT, wem sie zugewiesen ist. Nur die Button-Farbe ist verlässlich:
    // 'free' (btn-success) = nirgends zugewiesen, sicher zu greifen.
    // 'elsewhere' (btn-warning) = einem ANDEREN Fahrzeug zugewiesen – NIE anfassen (würde dort
    //   ein neues Status-6-Problem erzeugen).
    // 'here' (btn-assigned) = schon diesem Fahrzeug zugewiesen.
    function parsePersonnelRows(html) {
        const rows = [];
        const re = /<tr id="personal_(\d+)" data-filterable-by="(\[[^\]]*\])"[^>]*>([\s\S]*?)<\/tr>/gi;
        let m;
        while ((m = re.exec(html)) !== null) {
            const personalId = m[1];
            let filterableBy = [];
            try { filterableBy = JSON.parse(m[2].replace(/&quot;/g, '"')); } catch (e) { /* egal */ }
            const rowHtml = m[3];
            const nameMatch = rowHtml.match(/<td>([^<]*)<\/td>/);
            const name = nameMatch ? nameMatch[1].trim() : `#${personalId}`;
            let kind = 'unknown';
            if (/btn-assigned/i.test(rowHtml)) kind = 'here';
            else if (/btn-warning/i.test(rowHtml)) kind = 'elsewhere';
            else if (/btn-success/i.test(rowHtml)) kind = 'free';
            // Physischer Aufenthalt (Status-Spalte) getrennt von der Roster-Zuweisung ("Zugewiesen
            // an"): "Verfügbar" -> physicallyAt=null, "Im Fahrzeug: X" -> physicallyAt=Fahrzeug-ID.
            // Verifiziert (Beleg #124398995): eine Person kann diesem Fahrzeug zugewiesen sein
            // (kind='here'), aber gerade physisch in einem KOMPLETT ANDEREN Fahrzeug sitzen –
            // dann ist das Fahrzeug NICHT wirklich crewed, egal was der Roster-Zähler sagt.
            const inVehicleMatch = rowHtml.match(/Im Fahrzeug:\s*<a href="\/vehicles\/(\d+)"/i);
            const physicallyAt = inVehicleMatch ? inVehicleMatch[1] : null;
            rows.push({ personalId, name, filterableBy, kind, physicallyAt });
        }
        return rows;
    }

    // Hat dieses Fahrzeug mindestens eine ihm zugewiesene Person, die auch WIRKLICH da ist
    // (frei/"Verfügbar" oder physisch in genau diesem Fahrzeug) – nicht nur auf dem Papier?
    function hasPresentCrew(rows, vehicleId) {
        const here = rows.filter(r => r.kind === 'here');
        if (!here.length) return false;
        return here.some(r => r.physicallyAt === null || r.physicallyAt === String(vehicleId));
    }

    // Toggelt die Zuweisung (POST, kein Body – identisch zum jQuery-Aufruf im Spiel selbst).
    async function assignPersonnel(vehicleId, personalId, token) {
        try {
            const res = await fetch(`/vehicles/${vehicleId}/zuweisungDo/${personalId}`, {
                method: 'POST', credentials: 'same-origin',
                headers: { 'X-CSRF-Token': token || '', 'X-Requested-With': 'XMLHttpRequest' },
            });
            return res.ok;
        } catch (e) { return false; }
    }

    async function setVehicleFms(vehicleId, status) {
        try {
            const res = await fetch(`/vehicles/${vehicleId}/set_fms/${status}`, { credentials: 'same-origin' });
            return res.ok;
        } catch (e) { return false; }
    }

    // Automatisierungs-Protokoll (v1.03): jede Personal-Zuweisung + jedes FMS-Setzen wird
    // protokolliert, damit man in der Einführungsphase nachvollziehen kann, was das Skript
    // getan hat und ob dabei etwas Unerwartetes passiert ist.
    const ALOG_KEY = 'status6_action_log';
    let actionLog = [];
    try { actionLog = JSON.parse(localStorage.getItem(ALOG_KEY) || '[]') || []; } catch (e) { actionLog = []; }
    function logAction(entry) {
        actionLog.push({ ts: Date.now(), ...entry });
        if (actionLog.length > 500) actionLog = actionLog.slice(-500);
        const payload = JSON.stringify(actionLog);
        try { localStorage.setItem(ALOG_KEY, payload); if (localStorage.getItem(ALOG_KEY) === payload) return; } catch (e) { /* Quota? -> aufräumen */ }
        for (const k of ['status6_buildings']) { try { localStorage.removeItem(k); } catch (x) {} }
        try { localStorage.setItem(ALOG_KEY, payload); } catch (e) { /* egal, Log bleibt nur im Speicher dieser Sitzung */ }
    }
    function downloadActionLog() {
        const lines = [`Status 6 – Automatisierungs-Protokoll – ${new Date().toLocaleString('de-DE')}`, `${actionLog.length} Einträge`, ''];
        for (const e of [...actionLog].reverse()) {
            const when = new Date(e.ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
            lines.push(`${when} [#${e.vehicleId}] ${e.name || ''}${e.building ? ` (${e.building})` : ''}: ${e.text}`);
        }
        const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = `status6-protokoll_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
        a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }

    // Kernlogik pro Fahrzeug: fehlendes Personal/Lehrgang mit freiem, passendem Personal
    // auffüllen (nie 'elsewhere'-Personen abziehen!), danach neu prüfen und bei Bereitschaft
    // (oder "anderer Grund" – Beschluss: auch dort versuchen) den FMS-Status auf 2 setzen.
    async function autoFixVehicle(v) {
        const res = await fetch(`/vehicles/${v.id}/zuweisung`, { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) { logAction({ vehicleId: v.id, name: v.name, building: v.building, text: `Zuweisungsseite nicht ladbar (HTTP ${res.status})` }); return; }
        let html = await res.text();
        let a = analyzeAssignment(html);
        results[v.id] = { ...a, name: v.name, building: v.building, ts: Date.now() };

        let changed = false;
        if (a.reason === 'kein-personal' || a.reason === 'lehrgang-fehlt') {
            const token = getCsrfToken(html);
            const rows = parsePersonnelRows(html);
            if (!a.reqBlock || !a.need.length) {
                // Kein spezifischer Lehrgang nötig -> irgendeine wirklich freie Person reicht.
                const cand = rows.find(r => r.kind === 'free');
                if (cand) {
                    const ok = await assignPersonnel(v.id, cand.personalId, token);
                    logAction({ vehicleId: v.id, name: v.name, building: v.building, text: ok ? `Personal zugewiesen: ${cand.name}` : `Zuweisung fehlgeschlagen: ${cand.name}` });
                    if (ok) changed = true;
                } else {
                    logAction({ vehicleId: v.id, name: v.name, building: v.building, text: 'kein freies Personal verfügbar' });
                }
            } else {
                const eduMap = parseEducationKeyMap(html);
                for (const n of a.need) {
                    if (n.ok) continue;
                    const key = eduMap[n.label];
                    if (!key) {
                        logAction({ vehicleId: v.id, name: v.name, building: v.building, text: `kein Personal mit Lehrgang "${n.label}" im Pool – Lehrgang muss erst gelernt werden` });
                        continue;
                    }
                    const missing = n.req - n.have;
                    const cands = rows.filter(r => r.kind === 'free' && r.filterableBy.includes(key)).slice(0, missing);
                    if (!cands.length) {
                        logAction({ vehicleId: v.id, name: v.name, building: v.building, text: `kein freies Personal mit Lehrgang "${n.label}" verfügbar` });
                        continue;
                    }
                    for (const cand of cands) {
                        const ok = await assignPersonnel(v.id, cand.personalId, token);
                        logAction({ vehicleId: v.id, name: v.name, building: v.building, text: ok ? `Personal zugewiesen: ${cand.name} (${n.label})` : `Zuweisung fehlgeschlagen: ${cand.name}` });
                        if (ok) changed = true;
                    }
                }
            }
        }

        if (changed) {
            const res2 = await fetch(`/vehicles/${v.id}/zuweisung`, { credentials: 'same-origin', cache: 'no-store' });
            if (res2.ok) {
                html = await res2.text();
                a = analyzeAssignment(html);
                results[v.id] = { ...a, name: v.name, building: v.building, ts: Date.now() };
            }
        }
        // "anderer Grund" = Skript kennt die echte Ursache nicht (evtl. Werkstatt/Defekt) –
        // laut Entscheidung trotzdem versuchen. Sonst nur zurücksetzen, wenn wirklich bereit.
        // ZUSÄTZLICH (Beleg #124398995): Roster-Zuweisung reicht NICHT – die zugewiesene Person
        // muss auch wirklich da sein (frei oder physisch in genau diesem Fahrzeug), sonst ist
        // das Fahrzeug trotz "1 Personal" nicht wirklich crewed.
        const presumablyReady = a.reason === 'anderer' || (a.assigned > 0 && (!a.reqBlock || !a.anyUnmet));
        const present = hasPresentCrew(parsePersonnelRows(html), v.id);
        if (presumablyReady && present) {
            const ok = await setVehicleFms(v.id, 2);
            logAction({ vehicleId: v.id, name: v.name, building: v.building, text: ok ? '✅ FMS auf 2 gesetzt (einsatzbereit)' : '⚠️ FMS-2-Setzen fehlgeschlagen' });
        } else if (presumablyReady && !present) {
            logAction({ vehicleId: v.id, name: v.name, building: v.building, text: '⏸️ Personal zugewiesen, aber niemand vor Ort/frei (in anderem Fahrzeug gebunden) – FMS NICHT zurückgesetzt' });
        }
        persist();
    }

    let autoFixRunning = false;
    async function autoFixAll(panel) {
        if (autoFixRunning) return;
        autoFixRunning = true;
        const $status = panel.querySelector('#s6-status');
        try {
            const targets = lastList.filter(v => results[v.id]); // nur bereits geprüfte Fahrzeuge
            let done = 0;
            for (const v of targets) {
                $status.innerHTML = `🔧 Automatik läuft… (${done + 1}/${targets.length}) – ${v.name}`;
                try { await autoFixVehicle(v); } catch (e) { logAction({ vehicleId: v.id, name: v.name, building: v.building, text: `Fehler: ${e.message}` }); }
                done++;
                if (CONFIG.fetchDelayMs) await new Promise(r => setTimeout(r, CONFIG.fetchDelayMs));
            }
            await scan(panel); // neu laden – behobene Fahrzeuge (jetzt FMS 2) verschwinden aus der Liste
        } finally { autoFixRunning = false; }
    }

    const REASON_LABEL = {
        'kein-personal': { txt: 'kein Personal zugewiesen', col: '#f38ba8' },
        'lehrgang-fehlt': { txt: 'Personal ohne benötigten Lehrgang', col: '#fab387' },
        'anderer': { txt: 'anderer Grund', col: '#9399b2' },
    };

    let filterReason = 'all'; // all | kein-personal | lehrgang-fehlt | anderer
    let lastList = [];

    let running = false;
    async function scan(panel) {
        if (running) return;
        running = true;
        const $status = panel.querySelector('#s6-status');
        try {
            $status.innerHTML = 'Lade Fahrzeuge (Status 6)…';
            const list = await loadStatus6();
            lastList = list;
            if (!list.length) { $status.innerHTML = '<b style="color:#a6e3a1;">Kein Fahrzeug im Status 6 🎉</b>'; render(panel); running = false; return; }
            const due = list; // Status 6 ist überschaubar -> immer frisch prüfen
            $status.innerHTML = `<b>${due.length}</b> Fahrzeug(e) im Status 6 gefunden – starte Prüfung…`;
            let done = 0, idx = 0;
            const total = due.length, t0 = Date.now();
            const paint = () => {
                const rate = done / Math.max(0.1, (Date.now() - t0) / 1000);
                const eta = rate > 0 ? Math.round((total - done) / rate) : 0;
                const pct = Math.round(done / total * 100);
                $status.innerHTML = `Geprüft: <b>${done}</b> von <b>${total}</b> Fahrzeugen (${pct}%) · noch ~${eta}s`
                    + `<div style="height:6px;background:#313244;border-radius:3px;margin-top:4px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:#89b4fa;"></div></div>`;
            };
            paint();
            async function worker() {
                while (idx < total) {
                    const v = due[idx++];
                    try { await checkVehicle(v); } catch (e) {}
                    done++; paint();
                    if (done % 10 === 0) { persist(); render(panel); }
                    if (CONFIG.fetchDelayMs) await new Promise(r => setTimeout(r, CONFIG.fetchDelayMs));
                }
            }
            await Promise.all(Array.from({ length: CONFIG.concurrency }, worker));
            persist();
            render(panel);
        } catch (e) {
            $status.innerHTML = `<span style="color:#f38ba8;">Fehler: ${e.message}</span>`;
        } finally { running = false; }
    }

    function render(panel) {
        const $status = panel.querySelector('#s6-status');
        const $list = panel.querySelector('#s6-list');
        const checked = lastList.filter(v => results[v.id]);
        // Zählung je Grund
        const counts = { 'kein-personal': 0, 'lehrgang-fehlt': 0, 'anderer': 0 };
        for (const v of checked) counts[results[v.id].reason]++;
        const shown = filterReason === 'all' ? checked : checked.filter(v => results[v.id].reason === filterReason);

        $status.innerHTML = `<b style="color:#f38ba8;">${lastList.length}</b> Fahrzeug(e) im Status 6 `
            + `<span style="color:#9399b2;">(${checked.length} geprüft)</span><br>`
            + `<span style="font-size:11px;">`
            + `<span style="color:#f38ba8;">${counts['kein-personal']} kein Personal</span> · `
            + `<span style="color:#fab387;">${counts['lehrgang-fehlt']} Lehrgang fehlt</span> · `
            + `<span style="color:#9399b2;">${counts['anderer']} anderer</span></span>`;

        if (!shown.length) {
            $list.innerHTML = checked.length
                ? '<div style="color:#9399b2;padding:8px;">Keine Fahrzeuge in dieser Kategorie.</div>'
                : '<div style="color:#9399b2;padding:8px;">Noch nichts geprüft – „⟳ Prüfen" starten.</div>';
            return;
        }
        // Nach Wache gruppieren
        const byBuilding = new Map();
        for (const v of shown) {
            const b = results[v.id].building || '—';
            if (!byBuilding.has(b)) byBuilding.set(b, []);
            byBuilding.get(b).push(v);
        }
        let html = '';
        for (const [b, vs] of [...byBuilding.entries()].sort((a, c) => c[1].length - a[1].length)) {
            html += `<div style="margin-top:8px;padding:5px 7px;background:#313244;border-radius:6px;"><b>${b}</b> <span style="color:#9399b2;">· ${vs.length}</span></div>`;
            for (const v of vs.sort((x, y) => x.name.localeCompare(y.name, 'de'))) {
                const r = results[v.id];
                const rl = REASON_LABEL[r.reason];
                const parts = r.need.map(n => `<span style="color:${n.ok ? '#a6e3a1' : '#f38ba8'};">(${n.have}/${n.req}) ${n.label}</span>`).join(', ');
                const train = r.inTraining.length ? ` <span style="color:#f9e2af;">· 🎓 ${r.inTraining.length} im Unterricht</span>` : '';
                html += `<div style="padding:4px 6px 4px 16px;border-bottom:1px solid #313244;">
                    <a href="/vehicles/${v.id}/zuweisung" style="color:#cdd6f4;">${r.name}</a>
                    <span style="color:${rl.col};font-size:11px;"> — ${rl.txt}</span>
                    ${r.need.length ? `<div style="font-size:11px;">${parts}${train}</div>` : (r.inTraining.length ? `<div style="font-size:11px;color:#f9e2af;">🎓 ${r.inTraining.length} im Unterricht</div>` : '')}
                </div>`;
            }
        }
        $list.innerHTML = html;
    }

    function buildPanel() {
        let panel = document.getElementById('s6-panel');
        if (panel) { panel.remove(); return; }
        panel = document.createElement('div');
        panel.id = 's6-panel';
        panel.style.cssText = 'position:fixed;top:150px;right:20px;z-index:99999;width:460px;max-height:82vh;display:flex;flex-direction:column;background:#1e1e2e;color:#cdd6f4;border:1px solid #45475a;border-radius:10px;padding:14px;font:13px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);';
        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <b style="font-size:14px;">🚫 Status 6 – nicht einsatzbereit</b>
                <div>
                    <button id="s6-scan" title="Jetzt prüfen" style="background:none;border:1px solid #45475a;border-radius:4px;color:#cdd6f4;cursor:pointer;font-size:13px;padding:2px 7px;">⟳ Prüfen</button>
                    <button id="s6-close" style="background:none;border:none;color:#cdd6f4;cursor:pointer;font-size:16px;">✕</button>
                </div>
            </div>
            <div style="display:flex;gap:4px;margin-bottom:6px;">
                <button id="s6-autofix" title="Fehlendes Personal (nur wirklich freie Personen, nie von anderen Fahrzeugen abgezogen) auffüllen und einsatzbereite Fahrzeuge auf FMS 2 setzen" style="flex:1;padding:5px;background:#a6e3a1;color:#1e1e2e;border:none;border-radius:5px;font-size:12px;font-weight:600;cursor:pointer;">🔧 Automatisch beheben</button>
                <button id="s6-log" title="Automatisierungs-Protokoll herunterladen" style="padding:5px 9px;background:#45475a;color:#cdd6f4;border:none;border-radius:5px;font-size:12px;cursor:pointer;">📋</button>
            </div>
            <div style="display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap;">
                <button class="s6-f" data-r="all" style="flex:1;padding:4px;background:#89b4fa;color:#1e1e2e;border:none;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;">Alle</button>
                <button class="s6-f" data-r="kein-personal" style="flex:1;padding:4px;background:#45475a;color:#cdd6f4;border:none;border-radius:5px;font-size:11px;cursor:pointer;">Kein Personal</button>
                <button class="s6-f" data-r="lehrgang-fehlt" style="flex:1;padding:4px;background:#45475a;color:#cdd6f4;border:none;border-radius:5px;font-size:11px;cursor:pointer;">Lehrgang fehlt</button>
                <button class="s6-f" data-r="anderer" style="flex:1;padding:4px;background:#45475a;color:#cdd6f4;border:none;border-radius:5px;font-size:11px;cursor:pointer;">Anderer</button>
            </div>
            <div id="s6-status" style="margin-bottom:6px;font-size:12px;">Bereit – „⟳ Prüfen" durchsucht die Fahrzeuge.</div>
            <div id="s6-list" style="overflow:auto;flex:1;"></div>
            <div style="color:#9399b2;font-size:10px;margin-top:8px;">Status 6 = nicht einsatzbereit. Grund: kein Personal, Personal ohne benötigten Lehrgang, oder anderer. 🎓 = jemand in Ausbildung. Klick öffnet die Zuweisung. 🔧 weist nur nirgends zugewiesenes Personal zu und setzt danach FMS 2, wenn bereit.</div>
        `;
        document.body.appendChild(panel);
        panel.querySelector('#s6-close').onclick = () => panel.remove();
        panel.querySelector('#s6-scan').onclick = () => scan(panel);
        panel.querySelector('#s6-autofix').onclick = () => autoFixAll(panel);
        panel.querySelector('#s6-log').onclick = () => downloadActionLog();
        panel.querySelectorAll('.s6-f').forEach(btn => {
            btn.onclick = () => {
                filterReason = btn.getAttribute('data-r');
                panel.querySelectorAll('.s6-f').forEach(b => { b.style.background = '#45475a'; b.style.color = '#cdd6f4'; b.style.fontWeight = '400'; });
                btn.style.background = '#89b4fa'; btn.style.color = '#1e1e2e'; btn.style.fontWeight = '600';
                render(panel);
            };
        });
    }

    function addBadge() {
        const menu = ensureToolsMenu();
        menu.add('s6-openbtn', '🚫 Status 6', () => buildPanel(), 30);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addBadge);
    else addBadge();
})();
