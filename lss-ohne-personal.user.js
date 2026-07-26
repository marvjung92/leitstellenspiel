// ==UserScript==
// @name         LSS Fahrzeuge ohne festes Personal
// @namespace    http://tampermonkey.net/
// @version      1.00
// @downloadURL  https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-ohne-personal.user.js
// @updateURL    https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-ohne-personal.user.js
// @description  Listet alle eigenen Fahrzeuge auf, denen KEIN Personal fest zugewiesen ist ("Zugewiesenes Personal: 0" auf der Personalzuweisungs-Seite). Prüft die Fahrzeuge im Hintergrund, mit Drosselung. Panel + Navbar-Badge.
// @match        https://www.leitstellenspiel.de/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';
    if (window.top !== window.self) return;

    const CONFIG = {
        fetchDelayMs: 700,      // Pause zwischen zwei Fahrzeug-Seiten-Abrufen (Server schonen)
        maxChecksPerRun: 300,   // Sicherheitsobergrenze je Durchlauf
        cacheMs: 6 * 3600000,   // Ergebnis je Fahrzeug so lange als gültig ansehen (kein Dauer-Abruf)
    };

    // Cache: vehicleId -> { assigned: <zahl>, name, building, ts }
    const RES_KEY = 'nopers_results';
    let results = {};
    try { results = JSON.parse(localStorage.getItem(RES_KEY) || '{}') || {}; } catch (e) { results = {}; }
    function persist() {
        try { localStorage.setItem(RES_KEY, JSON.stringify(results)); return true; }
        catch (e) {
            // Notfall: fremde Fresser opfern, dann erneut
            for (const k of ['ad_log_buffer', 'ad_audit_buffer', 'tv_send_log']) { try { localStorage.removeItem(k); } catch (x) {} }
            try { localStorage.setItem(RES_KEY, JSON.stringify(results)); return true; } catch (x) { return false; }
        }
    }

    // Alle eigenen Fahrzeuge (id, caption, building) via /api/vehicles.
    async function loadVehicles() {
        const res = await fetch('/api/vehicles', { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) throw new Error(`/api/vehicles HTTP ${res.status}`);
        const all = await res.json();
        return all.map(v => ({
            id: String(v.id),
            name: v.caption || `#${v.id}`,
            building: v.building_name || v.building || '',
            typeId: Number(v.vehicle_type),
        }));
    }

    // Personalzuweisungs-Seite eines Fahrzeugs prüfen: wie viel Personal ist FEST zugewiesen?
    // Auf /vehicles/<id>/zuweisung steht unten: "Zugewiesenes Personal: <span id=count_personal>N</span>".
    // Fest zugewiesen = Personen mit einem "Zuweisung entfernen"-Button (Klasse btn-assigned) bzw. der
    // Zähler count_personal. 0 => Fahrzeug hat kein festes Personal.
    async function checkVehicle(v) {
        const res = await fetch(`/vehicles/${v.id}/zuweisung`, { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) return null;
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        // Primär: der count_personal-Zähler
        let assigned = null;
        const cnt = doc.getElementById('count_personal');
        if (cnt) { const n = parseInt(cnt.textContent.replace(/[^\d]/g, ''), 10); if (Number.isFinite(n)) assigned = n; }
        // Fallback: Anzahl "Zuweisung entfernen"-Buttons (btn-assigned)
        if (assigned == null) assigned = doc.querySelectorAll('a.btn-assigned, .btn-assigned').length;
        const rec = { assigned, name: v.name, building: v.building, ts: Date.now() };
        results[v.id] = rec;
        return rec;
    }

    let running = false;
    async function scan(panel, force) {
        if (running) return;
        running = true;
        const $status = panel.querySelector('#np-status');
        try {
            $status.innerHTML = 'Lade Fahrzeugliste…';
            const vehicles = await loadVehicles();
            const now = Date.now();
            const due = vehicles.filter(v => force || !results[v.id] || now - results[v.id].ts > CONFIG.cacheMs)
                                 .slice(0, CONFIG.maxChecksPerRun);
            let done = 0;
            for (const v of due) {
                try { await checkVehicle(v); } catch (e) { /* nächster */ }
                done++;
                $status.innerHTML = `Prüfe Fahrzeuge… <b>${done}/${due.length}</b>`;
                if (done % 10 === 0) { persist(); render(panel, vehicles); }
                await new Promise(r => setTimeout(r, CONFIG.fetchDelayMs));
            }
            persist();
            render(panel, vehicles);
        } catch (e) {
            $status.innerHTML = `<span style="color:#f38ba8;">Fehler: ${e.message}</span>`;
        } finally { running = false; }
    }

    function render(panel, vehicles) {
        const $status = panel.querySelector('#np-status');
        const $list = panel.querySelector('#np-list');
        // Nur Fahrzeuge, die geprüft wurden UND 0 festes Personal haben
        const checked = vehicles.filter(v => results[v.id]);
        const without = checked.filter(v => (results[v.id].assigned || 0) === 0);
        $status.innerHTML = `<b style="color:#f9e2af;">${without.length}</b> Fahrzeug(e) ohne festes Personal `
            + `<span style="color:#9399b2;">(${checked.length}/${vehicles.length} geprüft)</span>`;
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
                    <button id="np-scan" title="Prüfen (Shift+Klick = alle neu prüfen, Cache ignorieren)" style="background:none;border:1px solid #45475a;border-radius:4px;color:#cdd6f4;cursor:pointer;font-size:13px;padding:2px 7px;">⟳ Prüfen</button>
                    <button id="np-close" style="background:none;border:none;color:#cdd6f4;cursor:pointer;font-size:16px;">✕</button>
                </div>
            </div>
            <div id="np-status" style="margin-bottom:6px;font-size:12px;">Bereit.</div>
            <div id="np-list" style="overflow:auto;flex:1;"></div>
            <div style="color:#9399b2;font-size:10px;margin-top:8px;">Prüft je Fahrzeug die Personalzuweisungs-Seite (gedrosselt). „0 Personal" = kein festes Personal zugewiesen. Klick öffnet die Zuweisung.</div>
        `;
        document.body.appendChild(panel);
        panel.querySelector('#np-close').onclick = () => panel.remove();
        panel.querySelector('#np-scan').onclick = (e) => scan(panel, e.shiftKey);
        // Sofort das zeigen, was schon im Cache ist
        loadVehicles().then(vs => render(panel, vs)).catch(() => {});
    }

    function addBadge() {
        if (document.getElementById('np-openbtn')) return;
        const navUl = document.querySelector('#main_navbar #navbar-main-collapse ul.navbar-nav');
        if (navUl) {
            const li = document.createElement('li');
            li.id = 'np-openbtn';
            li.innerHTML = `<a href="#" title="Fahrzeuge ohne festes Personal"><span style="font-size:15px;">👤</span></a>`;
            li.querySelector('a').onclick = (e) => { e.preventDefault(); buildPanel(); };
            navUl.insertBefore(li, navUl.firstChild);
        } else {
            const btn = document.createElement('button');
            btn.id = 'np-openbtn';
            btn.textContent = '👤 ohne Personal';
            btn.style.cssText = 'position:fixed;top:150px;right:20px;z-index:99998;padding:8px 12px;background:#f9e2af;color:#1e1e2e;border:none;border-radius:8px;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.3);';
            btn.onclick = buildPanel;
            document.body.appendChild(btn);
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addBadge);
    else addBadge();
})();
