// ==UserScript==
// @name         LSS Status 6 (nicht einsatzbereit) + Lehrgangs-Check
// @namespace    http://tampermonkey.net/
// @version      1.01
// @downloadURL  https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-status6.user.js
// @updateURL    https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-status6.user.js
// @description  Listet alle Fahrzeuge im FMS-Status 6 (nicht einsatzbereit) und zeigt pro Fahrzeug den Grund (kein Personal / Personal ohne Lehrgang / anderer) sowie den Lehrgangs-Abgleich des zugewiesenen Personals.
// @match        https://www.leitstellenspiel.de/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';
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
            <div style="display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap;">
                <button class="s6-f" data-r="all" style="flex:1;padding:4px;background:#89b4fa;color:#1e1e2e;border:none;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;">Alle</button>
                <button class="s6-f" data-r="kein-personal" style="flex:1;padding:4px;background:#45475a;color:#cdd6f4;border:none;border-radius:5px;font-size:11px;cursor:pointer;">Kein Personal</button>
                <button class="s6-f" data-r="lehrgang-fehlt" style="flex:1;padding:4px;background:#45475a;color:#cdd6f4;border:none;border-radius:5px;font-size:11px;cursor:pointer;">Lehrgang fehlt</button>
                <button class="s6-f" data-r="anderer" style="flex:1;padding:4px;background:#45475a;color:#cdd6f4;border:none;border-radius:5px;font-size:11px;cursor:pointer;">Anderer</button>
            </div>
            <div id="s6-status" style="margin-bottom:6px;font-size:12px;">Bereit – „⟳ Prüfen" durchsucht die Fahrzeuge.</div>
            <div id="s6-list" style="overflow:auto;flex:1;"></div>
            <div style="color:#9399b2;font-size:10px;margin-top:8px;">Status 6 = nicht einsatzbereit. Grund: kein Personal, Personal ohne benötigten Lehrgang, oder anderer. 🎓 = jemand in Ausbildung. Klick öffnet die Zuweisung.</div>
        `;
        document.body.appendChild(panel);
        panel.querySelector('#s6-close').onclick = () => panel.remove();
        panel.querySelector('#s6-scan').onclick = () => scan(panel);
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
        if (document.getElementById('s6-openbtn')) return;
        const navUl = document.querySelector('#main_navbar #navbar-main-collapse ul.navbar-nav');
        if (navUl) {
            const li = document.createElement('li');
            li.id = 's6-openbtn';
            li.innerHTML = `<a href="#" title="Status 6: nicht einsatzbereite Fahrzeuge + Lehrgangs-Check"><span style="font-size:15px;">🚫</span></a>`;
            li.querySelector('a').onclick = (e) => { e.preventDefault(); buildPanel(); };
            navUl.insertBefore(li, navUl.firstChild);
        } else {
            const btn = document.createElement('button');
            btn.id = 's6-openbtn';
            btn.textContent = '🚫 Status 6';
            btn.style.cssText = 'position:fixed;top:150px;right:20px;z-index:99998;padding:8px 12px;background:#f9e2af;color:#1e1e2e;border:none;border-radius:8px;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.3);';
            btn.onclick = buildPanel;
            document.body.appendChild(btn);
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addBadge);
    else addBadge();
})();
