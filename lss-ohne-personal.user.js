// ==UserScript==
// @name         LSS Fahrzeuge ohne festes Personal
// @namespace    http://tampermonkey.net/
// @version      1.06
// @downloadURL  https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-ohne-personal.user.js
// @updateURL    https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-ohne-personal.user.js
// @description  Listet alle eigenen Fahrzeuge auf, denen KEIN Personal fest zugewiesen ist ("Zugewiesenes Personal: 0" auf der Personalzuweisungs-Seite). Prüft die Fahrzeuge im Hintergrund, mit Drosselung. Panel + Navbar-Badge.
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
        concurrency: 4,         // parallele Abrufe (statt einzeln nacheinander) -> ~4x schneller
        fetchDelayMs: 150,      // kurze Pause pro Anfrage innerhalb eines Workers
        maxChecksPerRun: 5000,  // reicht für den gesamten Fuhrpark
        cacheMs: 12 * 3600000,  // Ergebnis so lange gültig
        // Fahrzeugtyp-IDs, die KONSTRUKTIV kein eigenes Personal haben (Anhänger, Abrollbehälter,
        // Aggregate). Diese werden NIE per Seitenabruf geprüft und tauchen nicht in der Liste auf.
        // IDs bitte ergänzen (aus /api/vehicles, Feld vehicle_type). Beispiele werden vom Nutzer geliefert.
        noPersonnelTypeIds: [
            // <<< HIER Typ-IDs eintragen, z.B. AB-Sonderlöschmittel, Anh Sonderlöschmittel, NEA50 >>>
        ],
        // Zusätzlich Namensmuster als Netz (case-egal), falls eine Typ-ID mal fehlt:
        noPersonnelNamePatterns: ['anh ', 'anhänger', 'ab-', 'ab ', 'nea', 'dekon-p', 'gw-anh', 'sata', 'fwa',
            'außenlastbehälter', 'aussenlastbehälter', 'fkh', 'brmg', 'mzb'],
    };

    // Cache: vehicleId -> { assigned: <zahl>, name, building, ts }
    const RES_KEY = 'nopers_results';
    const RES_VER = 2; // hochzählen, wenn sich die Erkennungslogik ändert -> alter Cache wird verworfen
    let results = {};
    try {
        const raw = JSON.parse(localStorage.getItem(RES_KEY) || 'null');
        if (raw && raw.__ver === RES_VER) { results = raw.data || {}; }
        else { results = {}; } // andere/fehlende Version -> mit falscher Logik erzeugte Alt-Daten ignorieren
    } catch (e) { results = {}; }
    function persist() {
        const payload = JSON.stringify({ __ver: RES_VER, data: results });
        try { localStorage.setItem(RES_KEY, payload); return true; }
        catch (e) {
            for (const k of ['ad_log_buffer', 'ad_audit_buffer', 'tv_send_log']) { try { localStorage.removeItem(k); } catch (x) {} }
            try { localStorage.setItem(RES_KEY, payload); return true; } catch (x) { return false; }
        }
    }

    // Alle eigenen Fahrzeuge (id, caption, building, typeId) via /api/vehicles.
    async function loadVehicles() {
        const res = await fetch('/api/vehicles', { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) throw new Error(`/api/vehicles HTTP ${res.status}`);
        const all = await res.json();
        return all.map(v => ({
            id: String(v.id),
            name: v.caption || `#${v.id}`,
            building: v.building_name || v.building || '',
            typeId: Number(v.vehicle_type),
            typeName: v.vehicle_type_caption || '',
            // Festes Personal steht DIREKT in der API: assigned_personnel_count.
            // null/0 = kein festes Personal. max_personnel_override=0 kann ein personalloser Typ sein.
            assignedRaw: v.assigned_personnel_count,
            maxOverride: v.max_personnel_override,
        }));
    }

    // Kann dieses Fahrzeug konstruktiv KEIN eigenes Personal haben? (Anhänger/AB/Aggregat)
    function cannotHavePersonnel(v) {
        if (CONFIG.noPersonnelTypeIds.includes(v.typeId)) return true;
        const hay = ((v.name || '') + ' ' + (v.typeName || '')).toLowerCase();
        return CONFIG.noPersonnelNamePatterns.some(p => hay.includes(p));
    }

    // Personalzuweisungs-Seite eines Fahrzeugs prüfen: wie viel Personal ist FEST zugewiesen?
    // Auf /vehicles/<id>/zuweisung hat JEDE fest zugewiesene Person einen Link "Fahrzeugbindung
    // entfernen" (href .../zuweisungDo/<personal_id>). Anzahl dieser Links = zugewiesenes Personal.
    // (Der Zähler #count_personal wird erst per JS gefüllt und ist im abgerufenen Roh-HTML leer –
    //  deshalb wird er NICHT verwendet; Beleg 25.07.: DLK mit 2 Personen wurde sonst als 0 gelesen.)
    async function checkVehicle(v) {
        const res = await fetch(`/vehicles/${v.id}/zuweisung`, { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) return null;
        const html = await res.text();
        // Primär: "Fahrzeugbindung entfernen"-Links zählen (robust gegen Whitespace/Umbrüche)
        let assigned = (html.match(/Fahrzeugbindung entfernen/gi) || []).length;
        // Fallback (falls Wortlaut variiert): Personen-Zeilen mit "zuweisung aufheben/entfernen"
        if (!assigned) assigned = (html.match(/zuweisung\s*(aufheben|entfernen)/gi) || []).length;
        const rec = { assigned, name: v.name, building: v.building, ts: Date.now() };
        results[v.id] = rec;
        return rec;
    }

    let running = false;
    async function scan(panel) {
        // Keine Seitenabrufe mehr nötig: assigned_personnel_count kommt direkt aus /api/vehicles.
        if (running) return;
        running = true;
        const $status = panel.querySelector('#np-status');
        try {
            $status.innerHTML = 'Lade Fahrzeugliste…';
            const vehicles = await loadVehicles();
            for (const v of vehicles) {
                const n = (v.assignedRaw == null) ? 0 : Number(v.assignedRaw) || 0;
                results[v.id] = { assigned: n, name: v.name, building: v.building, ts: Date.now() };
            }
            persist();
            render(panel, vehicles);
        } catch (e) {
            $status.innerHTML = `<span style="color:#f38ba8;">Fehler: ${e.message}</span>`;
        } finally { running = false; }
    }

    function render(panel, vehicles, excluded) {
        const $status = panel.querySelector('#np-status');
        const $list = panel.querySelector('#np-list');
        const checkable = vehicles.filter(v => !cannotHavePersonnel(v));
        const checked = checkable.filter(v => results[v.id]);
        const without = checked.filter(v => (results[v.id].assigned || 0) === 0);
        const exTxt = (excluded != null ? excluded : (vehicles.length - checkable.length));
        $status.innerHTML = `<b style="color:#f9e2af;">${without.length}</b> Fahrzeug(e) ohne festes Personal `
            + `<span style="color:#9399b2;">(von ${checkable.length} personalfähigen · ${exTxt} Anhänger/AB ausgeblendet)</span>`;
        if (!without.length) {
            $list.innerHTML = checked.length
                ? '<div style="color:#a6e3a1;padding:8px;">Alle geprüften Fahrzeuge haben festes Personal. 🎉</div>'
                : '<div style="color:#9399b2;padding:8px;">Noch nichts geprüft – „⟳ Prüfen" starten.</div>';
            return;
        }
        // Nach Wache gruppieren
        const byBuilding = new Map();
        for (const v of without) {
            const b = results[v.id].building || '—';
            if (!byBuilding.has(b)) byBuilding.set(b, []);
            byBuilding.get(b).push(v);
        }
        let html = '';
        for (const [b, list] of [...byBuilding.entries()].sort((a, c) => c[1].length - a[1].length)) {
            html += `<div style="margin-top:8px;padding:4px 6px;background:#313244;border-radius:6px;">
                <b>${b}</b> <span style="color:#9399b2;">· ${list.length}×</span></div>`;
            for (const v of list.sort((x, y) => x.name.localeCompare(y.name, 'de'))) {
                html += `<div style="display:flex;gap:8px;padding:3px 6px 3px 16px;border-bottom:1px solid #313244;">
                    <a href="/vehicles/${v.id}/zuweisung" style="flex:1;min-width:0;color:#cdd6f4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${results[v.id].name}</a>
                    <span style="color:#f38ba8;font-size:11px;white-space:nowrap;">0 Personal</span>
                </div>`;
            }
        }
        $list.innerHTML = html;
    }

    function buildPanel() {
        let panel = document.getElementById('np-panel');
        if (panel) { panel.remove(); return; }
        panel = document.createElement('div');
        panel.id = 'np-panel';
        panel.style.cssText = 'position:fixed;top:150px;right:20px;z-index:99999;width:400px;max-height:80vh;display:flex;flex-direction:column;background:#1e1e2e;color:#cdd6f4;border:1px solid #45475a;border-radius:10px;padding:14px;font:13px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);';
        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <b style="font-size:14px;">👤 Fahrzeuge ohne festes Personal</b>
                <div>
                    <button id="np-scan" title="Jetzt prüfen (liest Personal direkt aus /api/vehicles)" style="background:none;border:1px solid #45475a;border-radius:4px;color:#cdd6f4;cursor:pointer;font-size:13px;padding:2px 7px;">⟳ Prüfen</button>
                    <button id="np-close" style="background:none;border:none;color:#cdd6f4;cursor:pointer;font-size:16px;">✕</button>
                </div>
            </div>
            <div id="np-status" style="margin-bottom:6px;font-size:12px;">Bereit.</div>
            <div id="np-list" style="overflow:auto;flex:1;"></div>
            <div style="color:#9399b2;font-size:10px;margin-top:8px;">Prüft je Fahrzeug die Personalzuweisungs-Seite (gedrosselt). „0 Personal" = kein festes Personal zugewiesen. Klick öffnet die Zuweisung.</div>
        `;
        document.body.appendChild(panel);
        panel.querySelector('#np-close').onclick = () => panel.remove();
        panel.querySelector('#np-scan').onclick = () => scan(panel);
        // Sofort das zeigen, was schon im Cache ist
        loadVehicles().then(vs => render(panel, vs)).catch(() => {});
    }

    function addBadge() {
        const menu = ensureToolsMenu();
        menu.add('np-openbtn', '👤 Fahrzeuge ohne Personal', () => buildPanel(), 20);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addBadge);
    else addBadge();
})();
