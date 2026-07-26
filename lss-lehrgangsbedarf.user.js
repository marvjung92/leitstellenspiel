// ==UserScript==
// @name         LSS Lehrgangs-Bedarf
// @namespace    http://tampermonkey.net/
// @version      1.04
// @downloadURL  https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-lehrgangsbedarf.user.js
// @updateURL    https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-lehrgangsbedarf.user.js
// @description  Listet Fahrzeuge, deren zugewiesenes Personal die benötigten Lehrgänge (noch) nicht erfüllt. Zeigt "(n/m) Lehrgang" pro Fahrzeug, markiert "im Unterricht" gesondert. Gruppiert nach Lehrgang und Wache.
// @match        https://www.leitstellenspiel.de/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';
    if (window.top !== window.self) return;

    const CONFIG = {
        concurrency: 4,          // parallele Seitenabrufe (Fallback, wenn API die Daten nicht liefert)
        fetchDelayMs: 150,       // kurze Pause pro Anfrage innerhalb eines Workers
        cacheMs: 6 * 3600000,    // Ergebnis so lange gültig
        // Fahrzeugtypen, die konstruktiv KEIN Personal (und damit keinen Lehrgangsbedarf) haben –
        // werden gar nicht geprüft. Deckungsgleich mit dem "ohne Personal"-Skript.
        skipNamePatterns: ['anh ', 'anhänger', 'ab-', 'ab ', 'nea', 'dekon-p', 'gw-anh', 'sata', 'fwa',
            'außenlastbehälter', 'aussenlastbehälter', 'fkh', 'brmg', 'mzb'],
    };

    const RES_KEY = 'lehrbedarf_results';
    const RES_VER = 1;
    let results = {}; // vehicleId -> { need:[{key,label,have,req,ok}], anyUnmet, inTraining, name, building, ts }
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

    // Gebäude-Namen (building_id -> caption). /api/vehicles liefert nur building_id, nicht den Namen.
    let buildingNames = {};
    const BLD_KEY = 'lehrbedarf_buildings';
    (function loadBldCache() {
        try { const c = JSON.parse(localStorage.getItem(BLD_KEY) || 'null'); if (c && Date.now() - c.ts < 24 * 3600000) buildingNames = c.map || {}; } catch (e) {}
    })();
    async function loadBuildingNames() {
        if (Object.keys(buildingNames).length) return; // Cache reicht
        try {
            const res = await fetch('/api/buildings', { credentials: 'same-origin', cache: 'no-store' });
            if (!res.ok) return;
            const first = await res.json();
            const map = {};
            const scan = (arr) => { for (const b of arr) map[String(b.id)] = b.caption || ('#' + b.id); };
            if (Array.isArray(first)) {
                scan(first);
                const pageSize = first.length;
                if (pageSize >= 100) {
                    for (let off = pageSize; off < 50000; off += pageSize) {
                        const r = await fetch(`/api/buildings?limit=${pageSize}&offset=${off}`, { credentials: 'same-origin', cache: 'no-store' });
                        if (!r.ok) break; const pg = await r.json();
                        if (!Array.isArray(pg) || !pg.length) break; scan(pg); if (pg.length < pageSize) break;
                    }
                }
            } else if (first && Array.isArray(first.buildings)) scan(first.buildings);
            buildingNames = map;
            try { localStorage.setItem(BLD_KEY, JSON.stringify({ ts: Date.now(), map })); } catch (e) {}
        } catch (e) { console.warn('[Lehrgangs-Bedarf] /api/buildings nicht ladbar:', e); }
    }

    async function loadVehicles() {
        await loadBuildingNames(); // Wachennamen bereitstellen
        const res = await fetch('/api/vehicles', { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) throw new Error(`/api/vehicles HTTP ${res.status}`);
        const all = await res.json();
        return all.map(v => ({
            id: String(v.id),
            name: v.caption || `#${v.id}`,
            building: buildingNames[String(v.building_id)] || '',
            typeId: Number(v.vehicle_type),
            typeName: v.vehicle_type_caption || '',
        }));
    }

    function cannotHavePersonnel(v) {
        const hay = ((v.name || '') + ' ' + (v.typeName || '')).toLowerCase();
        return CONFIG.skipNamePatterns.some(p => hay.includes(p));
    }

    // Lehrgangsbedarf einer Fahrzeugseite auslesen. Kern ist der Block
    //   <div id="required_personnel" class="alert alert-(danger|success)">
    //     Erforderliches Personal mit Ausbildungen: (n/m) Lehrgang, (n/m) Lehrgang2 …
    // danger = nicht erfüllt. "Im Unterricht: <Lehrgang>" zeigt laufende Ausbildungen.
    function parseRequirements(html) {
        const m = html.match(/id="required_personnel"[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/div>/i);
        if (!m) return { need: [], anyUnmet: false, hasBlock: false };
        const cls = m[1];
        // Text bereinigen (Tags raus)
        const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        // Alle "(n/m) Label"-Paare herausziehen
        const need = [];
        const re = /\((\d+)\s*\/\s*(\d+)\)\s*([A-Za-zÄÖÜäöüß0-9 .\-\/]+?)(?=\(|$|,)/g;
        let mm;
        while ((mm = re.exec(text)) !== null) {
            const have = parseInt(mm[1], 10), req = parseInt(mm[2], 10);
            need.push({ label: mm[3].trim(), have, req, ok: have >= req });
        }
        const anyUnmet = /alert-danger/i.test(cls) || need.some(n => !n.ok);
        return { need, anyUnmet, hasBlock: true };
    }

    function parseInTraining(html) {
        // "Im Unterricht: <a ...>Notarzt-Ausbildung</a>" -> Lehrgangsnamen sammeln
        const out = [];
        const re = /Im Unterricht:\s*<a[^>]*>([^<]+)<\/a>/gi;
        let m;
        while ((m = re.exec(html)) !== null) out.push(m[1].trim());
        return out;
    }

    async function checkVehicle(v) {
        const res = await fetch(`/vehicles/${v.id}/zuweisung`, { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) return null;
        const html = await res.text();
        const req = parseRequirements(html);
        const rec = {
            need: req.need,
            anyUnmet: req.anyUnmet,
            hasBlock: req.hasBlock,
            inTraining: parseInTraining(html),
            name: v.name, building: v.building, ts: Date.now(),
        };
        results[v.id] = rec;
        return rec;
    }

    let filterMode = 'all'; // 'all' = alle offenen | 'nostudy' = nur die OHNE jemanden im Unterricht

    let running = false;
    async function scan(panel, force) {
        if (running) return;
        running = true;
        const $status = panel.querySelector('#lb-status');
        try {
            if (force) { results = {}; persist(); }
            $status.innerHTML = 'Lade Fahrzeugliste…';
            const vehicles = await loadVehicles();
            console.log('[Lehrgangs-Bedarf] /api/vehicles lieferte', vehicles.length, 'Fahrzeuge');
            const checkable = vehicles.filter(v => !cannotHavePersonnel(v));
            const now = Date.now();
            const due = checkable.filter(v => force || !results[v.id] || now - results[v.id].ts > CONFIG.cacheMs);
            console.log('[Lehrgangs-Bedarf] prüfbar:', checkable.length, '| zu prüfen (due):', due.length, '| bereits im Cache:', checkable.length - due.length);
            if (!vehicles.length) { $status.innerHTML = '<span style="color:#f38ba8;">Keine Fahrzeuge von /api/vehicles erhalten – bist du eingeloggt? (Konsole prüfen)</span>'; running = false; return; }
            if (!due.length) {
                // Alles im Cache -> direkt rendern statt "nichts passiert"
                $status.innerHTML = 'Alle Fahrzeuge bereits im Cache – zeige Ergebnis (Shift+Klick erzwingt Neuprüfung).';
                render(panel, vehicles);
                running = false; return;
            }
            let done = 0, idx = 0;
            const total = due.length;
            const t0 = Date.now();
            const paint = () => {
                const rate = done / Math.max(0.1, (Date.now() - t0) / 1000);
                const eta = rate > 0 ? Math.round((total - done) / rate) : 0;
                const pct = Math.round(done / total * 100);
                const mm = Math.floor(eta / 60), ss = eta % 60;
                const etaTxt = eta > 0 ? (mm ? `${mm} min ${ss}s` : `${ss}s`) : '–';
                $status.innerHTML = `Prüfe Fahrzeuge… <b>${done}/${total}</b> (${pct}%) · noch ~${etaTxt}`
                    + `<div style="height:6px;background:#313244;border-radius:3px;margin-top:4px;overflow:hidden;">`
                    + `<div style="height:100%;width:${pct}%;background:#89b4fa;transition:width .2s;"></div></div>`;
            };
            paint(); // sofort 0/total anzeigen
            async function worker() {
                while (idx < total) {
                    const v = due[idx++];
                    try { await checkVehicle(v); } catch (e) { /* nächster */ }
                    done++;
                    paint(); // JEDES Fahrzeug -> Balken bewegt sich flüssig
                    if (done % 25 === 0) { persist(); render(panel, vehicles); } // teures Rendern seltener
                    if (CONFIG.fetchDelayMs) await new Promise(r => setTimeout(r, CONFIG.fetchDelayMs));
                }
            }
            await Promise.all(Array.from({ length: Math.max(1, CONFIG.concurrency) }, worker));
            persist();
            render(panel, vehicles);
        } catch (e) {
            $status.innerHTML = `<span style="color:#f38ba8;">Fehler: ${e.message}</span>`;
        } finally { running = false; }
    }

    function render(panel, vehicles) {
        const $status = panel.querySelector('#lb-status');
        const $list = panel.querySelector('#lb-list');
        const checkable = vehicles.filter(v => !cannotHavePersonnel(v));
        const checked = checkable.filter(v => results[v.id] && results[v.id].hasBlock);
        // Problemfälle: Anforderung nicht erfüllt
        const unmetAll = checked.filter(v => results[v.id].anyUnmet);
        // "niemand im Unterricht" = kein Personal in Ausbildung für dieses Fahrzeug
        const noStudy = unmetAll.filter(v => (results[v.id].inTraining || []).length === 0);
        const unmet = filterMode === 'nostudy' ? noStudy : unmetAll;
        $status.innerHTML = `<b style="color:#f38ba8;">${unmet.length}</b> Fahrzeug(e) mit offenem Lehrgangsbedarf `
            + `<span style="color:#9399b2;">(${filterMode === 'nostudy' ? 'ohne jemanden im Unterricht · ' : ''}von ${checked.length} geprüft`
            + `${filterMode === 'all' && noStudy.length ? ` · ${noStudy.length} davon ohne Unterricht` : ''})</span>`;
        if (!unmet.length) {
            $list.innerHTML = checked.length
                ? '<div style="color:#a6e3a1;padding:8px;">Alle geprüften Fahrzeuge haben ausreichend ausgebildetes Personal. 🎉</div>'
                : '<div style="color:#9399b2;padding:8px;">Noch nichts geprüft – „⟳ Prüfen" starten.</div>';
            return;
        }
        // Nach benötigtem Lehrgang gruppieren (erster unerfüllte Lehrgang bestimmt die Gruppe)
        const byCourse = new Map();
        for (const v of unmet) {
            const r = results[v.id];
            const firstUnmet = (r.need.find(n => !n.ok) || r.need[0] || { label: 'Lehrgang' });
            const key = firstUnmet.label;
            if (!byCourse.has(key)) byCourse.set(key, []);
            byCourse.get(key).push(v);
        }
        let html = '';
        for (const [course, list] of [...byCourse.entries()].sort((a, c) => c[1].length - a[1].length)) {
            html += `<div style="margin-top:10px;padding:5px 7px;background:#313244;border-radius:6px;">
                <b>${course}</b> <span style="color:#9399b2;">· ${list.length} Fahrzeug(e)</span></div>`;
            for (const v of list.sort((x, y) => x.name.localeCompare(y.name, 'de'))) {
                const r = results[v.id];
                const parts = r.need.map(n => `<span style="color:${n.ok ? '#a6e3a1' : '#f38ba8'};">(${n.have}/${n.req}) ${n.label}</span>`).join(', ');
                const train = r.inTraining.length ? ` <span style="color:#f9e2af;">· 🎓 ${r.inTraining.length} im Unterricht</span>` : '';
                html += `<div style="display:flex;flex-direction:column;padding:4px 6px 4px 16px;border-bottom:1px solid #313244;">
                    <a href="/vehicles/${v.id}/zuweisung" style="color:#cdd6f4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${r.name}${r.building ? ` <span style="color:#9399b2;">(${r.building})</span>` : ''}</a>
                    <div style="font-size:11px;">${parts}${train}</div>
                </div>`;
            }
        }
        $list.innerHTML = html;
    }

    function buildPanel() {
        let panel = document.getElementById('lb-panel');
        if (panel) { panel.remove(); return; }
        panel = document.createElement('div');
        panel.id = 'lb-panel';
        panel.style.cssText = 'position:fixed;top:150px;right:20px;z-index:99999;width:440px;max-height:82vh;display:flex;flex-direction:column;background:#1e1e2e;color:#cdd6f4;border:1px solid #45475a;border-radius:10px;padding:14px;font:13px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);';
        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <b style="font-size:14px;">🎓 Lehrgangs-Bedarf</b>
                <div>
                    <button id="lb-filter" title="Filter: alle offenen  /  nur Fahrzeuge ohne jemanden im Unterricht" style="background:none;border:1px solid #45475a;border-radius:4px;color:#cdd6f4;cursor:pointer;font-size:13px;padding:2px 7px;">Filter: Alle</button>
                    <button id="lb-scan" title="Prüfen (Shift+Klick = alles neu, Cache löschen)" style="background:none;border:1px solid #45475a;border-radius:4px;color:#cdd6f4;cursor:pointer;font-size:13px;padding:2px 7px;">⟳ Prüfen</button>
                    <button id="lb-close" style="background:none;border:none;color:#cdd6f4;cursor:pointer;font-size:16px;">✕</button>
                </div>
            </div>
            <div id="lb-status" style="margin-bottom:6px;font-size:12px;">Bereit – „⟳ Prüfen" durchsucht die Fahrzeuge.</div>
            <div id="lb-list" style="overflow:auto;flex:1;"></div>
            <div style="color:#9399b2;font-size:10px;margin-top:8px;">Prüft je Fahrzeug den Lehrgangsbedarf (gedrosselt). Rot = zu wenig ausgebildetes Personal. 🎓 = jemand ist im Unterricht. Klick öffnet die Zuweisung.</div>
        `;
        document.body.appendChild(panel);
        panel.querySelector('#lb-close').onclick = () => panel.remove();
        panel.querySelector('#lb-scan').onclick = (e) => scan(panel, e.shiftKey);
        const fbtn = panel.querySelector('#lb-filter');
        const paintFilterBtn = () => {
            fbtn.textContent = filterMode === 'nostudy' ? 'Filter: ohne Unterricht' : 'Filter: Alle';
            fbtn.style.background = filterMode === 'nostudy' ? '#f9e2af' : 'none';
            fbtn.style.color = filterMode === 'nostudy' ? '#1e1e2e' : '#cdd6f4';
        };
        fbtn.onclick = () => {
            filterMode = filterMode === 'nostudy' ? 'all' : 'nostudy';
            paintFilterBtn();
            loadVehicles().then(vs => render(panel, vs)).catch(() => {});
        };
        paintFilterBtn();
        loadVehicles().then(vs => render(panel, vs)).catch(() => {});
    }

    function addBadge() {
        if (document.getElementById('lb-openbtn')) return;
        const navUl = document.querySelector('#main_navbar #navbar-main-collapse ul.navbar-nav');
        if (navUl) {
            const li = document.createElement('li');
            li.id = 'lb-openbtn';
            li.innerHTML = `<a href="#" title="Lehrgangs-Bedarf: welche Fahrzeuge brauchen ausgebildetes Personal?"><span style="font-size:15px;">🎓</span></a>`;
            li.querySelector('a').onclick = (e) => { e.preventDefault(); buildPanel(); };
            navUl.insertBefore(li, navUl.firstChild);
        } else {
            const btn = document.createElement('button');
            btn.id = 'lb-openbtn';
            btn.textContent = '🎓 Lehrgänge';
            btn.style.cssText = 'position:fixed;top:150px;right:20px;z-index:99998;padding:8px 12px;background:#f9e2af;color:#1e1e2e;border:none;border-radius:8px;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.3);';
            btn.onclick = buildPanel;
            document.body.appendChild(btn);
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addBadge);
    else addBadge();
})();
