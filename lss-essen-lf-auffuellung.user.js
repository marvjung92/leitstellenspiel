// ==UserScript==
// @name         LSS Essen LF-Auffüllung
// @namespace    http://tampermonkey.net/
// @version      1.00
// @downloadURL  https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-essen-lf-auffuellung.user.js
// @updateURL    https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-essen-lf-auffuellung.user.js
// @description  Listet Feuerwachen einer konfigurierbaren Leitstelle (🔧-Button) mit weniger als 10 Fahrzeugen und Stufe ≥10, füllt sie per Knopfdruck mit LF 20 (Credits) bis auf 10 Fahrzeuge auf.
// @match        https://www.leitstellenspiel.de/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';
    // ==== Gemeinsames Analyse-Menü (geteilt über alle Analyse-Skripte) ====
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
                const dd = document.createElement('div');
                dd.id = 'lss-tools-dropdown';
                dd.style.cssText = 'position:fixed;display:none;z-index:100000;background:#1e1e2e;border:1px solid #45475a;border-radius:8px;padding:4px 0;box-shadow:0 6px 24px rgba(0,0,0,.4);min-width:190px;';
                document.body.appendChild(dd);
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
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => api.mount());
        else api.mount();
        return api;
    }

    if (window.top !== window.self) return;

    const CONFIG = {
        targetVehicles: 10,   // Ziel-Fahrzeuganzahl je Wache
        minLevel: 10,         // Stufe muss mindestens so hoch sein (genug Stellplätze)
        vehicleTypeId: 30,    // LF 20 – verifiziert aus dem Fahrzeugmarkt-Kauflink
        concurrency: 4,
        checkDelayMs: 200,    // Pause zwischen Wachen-Seitenabrufen (Prüfen)
        buyDelayMs: 700,      // Pause zwischen zwei Käufen (Kauf ist ein echter Credits-Spend)
    };

    // Leitstelle konfigurieren (🔧-Button) – gleiches Muster wie Innenstadt-/Ausnahme-Leitstelle
    // im Top-Verband-Skript, aber eigener Schlüssel (anderer Zweck).
    const LEIT_KEY = 'essenlf_leitstelle';
    function leitstelleConfig() {
        try {
            const c = JSON.parse(localStorage.getItem(LEIT_KEY) || '{}');
            return { id: c.id ? String(c.id) : null, name: c.name || '' };
        } catch (e) { return { id: null, name: '' }; }
    }
    function saveLeitstelleConfig(id, name) {
        const payload = JSON.stringify({ id, name });
        try { localStorage.setItem(LEIT_KEY, payload); return true; } catch (e) { return false; }
    }

    // Zugeordnete Feuerwachen (building_type 0) der konfigurierten Leitstelle, 24h-Cache
    // (identischer Auflösungs-Mechanismus wie im Top-Verband-Skript über /api/buildings).
    const BLD_KEY = 'essenlf_buildings';
    let buildingIds = new Set();
    (function loadCachedBuildings() {
        try {
            const c = JSON.parse(localStorage.getItem(BLD_KEY) || 'null');
            if (c && c.ids && c.ids.length && Date.now() - c.ts < 24 * 3600000) buildingIds = new Set(c.ids.map(String));
        } catch (e) { /* egal */ }
    })();
    async function refreshBuildingIds(force = false) {
        const cfg = leitstelleConfig();
        if (!cfg.id) { buildingIds = new Set(); return; }
        if (!force && buildingIds.size) return;
        try {
            const res = await fetch('/api/buildings', { credentials: 'same-origin' });
            if (!res.ok) return;
            const all = await res.json();
            const LEIT_FIELDS = ['leitstelle_building_id', 'leitstelle_id', 'dispatch_center_building_id', 'dispatch_center_id', 'building_leitstelle_id'];
            const set = new Set();
            for (const b of all) {
                if (Number(b.building_type) !== 0) continue; // nur Feuerwachen (LF 20 gehört dort hin)
                let lid = null;
                for (const f of LEIT_FIELDS) if (b[f] != null) { lid = String(b[f]); break; }
                if (lid === cfg.id) set.add(String(b.id));
            }
            buildingIds = set;
            try { localStorage.setItem(BLD_KEY, JSON.stringify({ ts: Date.now(), ids: [...set] })); } catch (e) { /* egal */ }
        } catch (e) { console.warn('[Essen LF-Auffüllung] /api/buildings nicht ladbar:', e); }
    }

    // Wachen-Seite selbst lesen: Stufe und "Fahrzeuge: X von maximal Y" stehen nur dort,
    // nicht in /api/buildings.
    async function checkBuilding(id) {
        const res = await fetch(`/buildings/${id}`, { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) return null;
        const html = await res.text();
        const nameMatch = html.match(/<h1[^>]*>\s*([^<]+?)\s*(?:<|$)/i);
        const stufeMatch = html.match(/Stufe:<\/strong><\/dt>\s*<dd>\s*(\d+)/i);
        const fzMatch = html.match(/Fahrzeuge:<\/strong><\/dt>\s*<dd>\s*(\d+)\s*von maximal\s*(\d+)/i);
        if (!stufeMatch || !fzMatch) return null;
        return {
            id: String(id),
            name: nameMatch ? nameMatch[1].trim() : `#${id}`,
            level: parseInt(stufeMatch[1], 10),
            count: parseInt(fzMatch[1], 10),
            max: parseInt(fzMatch[2], 10),
        };
    }

    // Kauf: einfacher GET-Link ohne data-method="post" (verifiziert aus dem Fahrzeugmarkt-HTML) –
    // anders als Ausbau/Erweiterung auf derselben Gebäudeseite, die alle POST sind.
    async function buyLf20(buildingId) {
        try {
            const res = await fetch(
                `/buildings/${buildingId}/vehicle/${buildingId}/${CONFIG.vehicleTypeId}/credits?building=${buildingId}&return_tab=fire_engine`,
                { credentials: 'same-origin' }
            );
            return res.ok;
        } catch (e) { return false; }
    }

    // Protokoll aller Käufe (Verified-Write, geteilte Ringpuffer-Logik wie in den anderen Skripten).
    const LOG_KEY = 'essenlf_log';
    let buyLog = [];
    try { buyLog = JSON.parse(localStorage.getItem(LOG_KEY) || '[]') || []; } catch (e) { buyLog = []; }
    function addLog(entry) {
        buyLog.push({ ts: Date.now(), ...entry });
        if (buyLog.length > 400) buyLog = buyLog.slice(-400);
        const payload = JSON.stringify(buyLog);
        try { localStorage.setItem(LOG_KEY, payload); if (localStorage.getItem(LOG_KEY) === payload) return; } catch (e) { /* Quota? */ }
        try { localStorage.removeItem(BLD_KEY); localStorage.setItem(LOG_KEY, payload); } catch (e) { /* egal, bleibt nur im Speicher */ }
    }
    function downloadLog() {
        const lines = [`Essen LF-Auffüllung – Kauf-Protokoll – ${new Date().toLocaleString('de-DE')}`, `${buyLog.length} Einträge`, ''];
        for (const e of [...buyLog].reverse()) {
            const when = new Date(e.ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
            lines.push(`${when} [#${e.buildingId}] ${e.name || ''}: ${e.text}`);
        }
        const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = `essenlf-protokoll_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
        a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }

    let lastList = [];
    let scanning = false;
    async function scan(panel) {
        if (scanning) return;
        scanning = true;
        const $status = panel.querySelector('#elf-status');
        const $list = panel.querySelector('#elf-list');
        try {
            const cfg = leitstelleConfig();
            if (!cfg.id) {
                $status.innerHTML = '<span style="color:#f38ba8;">Keine Leitstelle konfiguriert – 🔧-Button.</span>';
                $list.innerHTML = '';
                return;
            }
            $status.innerHTML = 'Löse Feuerwachen der Leitstelle auf…';
            await refreshBuildingIds(true);
            const ids = [...buildingIds];
            if (!ids.length) {
                $status.innerHTML = '<span style="color:#f38ba8;">0 Feuerwachen gefunden – Leitstellen-Gebäude-ID prüfen (🔧).</span>';
                $list.innerHTML = '';
                return;
            }
            let done = 0;
            const total = ids.length;
            const results = [];
            const paint = () => { $status.innerHTML = `Prüfe Wachen… <b>${done}</b> von <b>${total}</b>`; };
            paint();
            let idx = 0;
            async function worker() {
                while (idx < ids.length) {
                    const id = ids[idx++];
                    try { const r = await checkBuilding(id); if (r) results.push(r); } catch (e) { /* egal, einzelne Wache überspringen */ }
                    done++; paint();
                    if (CONFIG.checkDelayMs) await new Promise(r => setTimeout(r, CONFIG.checkDelayMs));
                }
            }
            await Promise.all(Array.from({ length: CONFIG.concurrency }, worker));
            lastList = results
                .filter(r => r.level >= CONFIG.minLevel && r.count < CONFIG.targetVehicles)
                .sort((a, b) => a.count - b.count);
            render(panel);
        } catch (e) {
            $status.innerHTML = `<span style="color:#f38ba8;">Fehler: ${e.message}</span>`;
        } finally { scanning = false; }
    }

    function render(panel) {
        const $status = panel.querySelector('#elf-status');
        const $list = panel.querySelector('#elf-list');
        $status.innerHTML = `<b style="color:#f38ba8;">${lastList.length}</b> Feuerwache(n) mit &lt;${CONFIG.targetVehicles} Fahrzeugen (Stufe ≥ ${CONFIG.minLevel})`;
        if (!lastList.length) {
            $list.innerHTML = '<div style="color:#9399b2;padding:8px;">Keine passenden Wachen gefunden – „⟳ Prüfen" starten.</div>';
            return;
        }
        let html = '';
        for (const b of lastList) {
            html += `<div style="display:flex;align-items:center;gap:8px;padding:6px;border-bottom:1px solid #313244;">
                <a href="/buildings/${b.id}" style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#cdd6f4;">${b.name}</a>
                <span style="color:#9399b2;font-size:11px;white-space:nowrap;">Stufe ${b.level} · ${b.count}/${b.max}</span>
            </div>`;
        }
        $list.innerHTML = html;
    }

    let fillRunning = false;
    async function fillAll(panel) {
        if (fillRunning) return;
        if (!lastList.length) { window.alert('Erst „⟳ Prüfen" ausführen.'); return; }
        const totalNeed = lastList.reduce((s, b) => s + (CONFIG.targetVehicles - b.count), 0);
        if (!window.confirm(`${lastList.length} Wache(n) auf je ${CONFIG.targetVehicles} Fahrzeuge auffüllen – insgesamt ${totalNeed}× LF 20 kaufen (kostet Credits)?`)) return;
        fillRunning = true;
        const $status = panel.querySelector('#elf-status');
        let bought = 0, failed = 0;
        try {
            for (const b of lastList) {
                const need = CONFIG.targetVehicles - b.count;
                for (let i = 0; i < need; i++) {
                    $status.innerHTML = `🚒 Kaufe für ${b.name}… (${i + 1}/${need})`;
                    const ok = await buyLf20(b.id);
                    addLog({ buildingId: b.id, name: b.name, text: ok ? 'LF 20 gekauft' : 'Kauf fehlgeschlagen (Credits/Stellplatz voll?)' });
                    if (ok) bought++; else { failed++; break; } // z.B. Credits alle -> restliche Käufe für diese Wache abbrechen
                    await new Promise(r => setTimeout(r, CONFIG.buyDelayMs));
                }
            }
            $status.innerHTML = `✅ Fertig: ${bought} LF 20 gekauft${failed ? `, ${failed} Wache(n) mit Fehlschlag abgebrochen` : ''}.`;
        } finally {
            fillRunning = false;
            await scan(panel); // frisch neu prüfen – erledigte Wachen fallen aus der Liste
        }
    }

    function buildPanel() {
        let panel = document.getElementById('elf-panel');
        if (panel) { panel.remove(); return; }
        panel = document.createElement('div');
        panel.id = 'elf-panel';
        panel.style.cssText = 'position:fixed;top:150px;right:20px;z-index:99999;width:420px;max-height:78vh;display:flex;flex-direction:column;background:#1e1e2e;color:#cdd6f4;border:1px solid #45475a;border-radius:10px;padding:14px;font:13px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);';
        const cfg = leitstelleConfig();
        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <b style="font-size:14px;">🚒 LF-Auffüllung${cfg.name ? ` – ${cfg.name}` : ''}</b>
                <div>
                    <button id="elf-config" title="Leitstelle festlegen" style="background:none;border:1px solid #45475a;border-radius:4px;color:#cdd6f4;cursor:pointer;font-size:13px;padding:2px 7px;">🔧</button>
                    <button id="elf-log" title="Kauf-Protokoll herunterladen" style="background:none;border:1px solid #45475a;border-radius:4px;color:#cdd6f4;cursor:pointer;font-size:13px;padding:2px 7px;">📋</button>
                    <button id="elf-scan" title="Jetzt prüfen" style="background:none;border:1px solid #45475a;border-radius:4px;color:#cdd6f4;cursor:pointer;font-size:13px;padding:2px 7px;">⟳ Prüfen</button>
                    <button id="elf-close" style="background:none;border:none;color:#cdd6f4;cursor:pointer;font-size:16px;">✕</button>
                </div>
            </div>
            <button id="elf-fill" title="Alle unten gelisteten Wachen auf ${CONFIG.targetVehicles} Fahrzeuge auffüllen" style="width:100%;padding:7px;margin-bottom:8px;background:#a6e3a1;color:#1e1e2e;border:none;border-radius:6px;font-weight:600;cursor:pointer;">🚒 Alle auffüllen (LF 20, Credits)</button>
            <div id="elf-status" style="margin-bottom:6px;font-size:12px;">Bereit – „⟳ Prüfen" durchsucht die Feuerwachen.</div>
            <div id="elf-list" style="overflow:auto;flex:1;"></div>
            <div style="color:#9399b2;font-size:10px;margin-top:8px;">Nur Feuerwachen (building_type 0) der konfigurierten Leitstelle, Stufe ≥ ${CONFIG.minLevel} und &lt; ${CONFIG.targetVehicles} Fahrzeuge. Kauf ist ein echter Credits-Spend, kein Testmodus.</div>
        `;
        document.body.appendChild(panel);
        panel.querySelector('#elf-close').onclick = () => panel.remove();
        panel.querySelector('#elf-scan').onclick = () => scan(panel);
        panel.querySelector('#elf-fill').onclick = () => fillAll(panel);
        panel.querySelector('#elf-log').onclick = () => downloadLog();
        panel.querySelector('#elf-config').onclick = async () => {
            const c = leitstelleConfig();
            const idIn = window.prompt(
                'LEITSTELLE – Feuerwachen-Gebäude-ID(s) dieser Leitstelle werden geprüft.\n' +
                'Leitstellen-Gebäude-ID eintragen (aus der URL /buildings/<ID> der Leitstelle).', c.id || '');
            if (idIn === null) return;
            const id = (idIn.match(/\d+/) || [])[0] || null;
            const nameIn = window.prompt('Optionaler Anzeigename (z.B. "Leitstelle Essen"):', c.name || '');
            if (nameIn === null) return;
            saveLeitstelleConfig(id, nameIn.trim());
            buildingIds = new Set();
            const p = document.getElementById('elf-panel');
            if (p) { p.remove(); buildPanel(); }
        };
        scan(panel);
    }

    function addBadge() {
        const menu = ensureToolsMenu();
        menu.add('elf-openbtn', '🚒 Essen LF-Auffüllung', () => buildPanel(), 35);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addBadge);
    else addBadge();
})();
