// ==UserScript==
// @name         LSS Lehrgangs-Bedarf
// @namespace    http://tampermonkey.net/
// @version      1.06
// @downloadURL  https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-lehrgangsbedarf.user.js
// @updateURL    https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-lehrgangsbedarf.user.js
// @description  Listet Fahrzeuge, deren zugewiesenes Personal die benötigten Lehrgänge (noch) nicht erfüllt. Zeigt "(n/m) Lehrgang" pro Fahrzeug, markiert "im Unterricht" gesondert. Gruppiert nach Lehrgang und Wache.
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
        // Zählt laufende Ausbildungen. Der Span trägt data-education-key (z.B. "notarzt") direkt vor
        // "Im Unterricht: <a>Notarzt-Ausbildung</a>". Wir nehmen key UND Namen mit.
        const out = [];
        const re = /data-education-key="([^"]*)"[^>]*>\s*Im Unterricht:\s*<a[^>]*>([^<]+)<\/a>/gi;
        let m;
        while ((m = re.exec(html)) !== null) out.push({ key: m[1], label: m[2].trim() });
        // Fallback ohne key (falls Markup mal abweicht)
        if (!out.length) {
            const r2 = /Im Unterricht:\s*<a[^>]*>([^<]+)<\/a>/gi; let mm;
            while ((mm = r2.exec(html)) !== null) out.push({ key: '', label: mm[1].trim() });
        }
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
    let viewMode = 'list';  // 'list' = Fahrzeuge | 'summary' = Lehrgangs-Gesamtübersicht

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

    // Aggregiert den Bedarf über alle Fahrzeuge: pro Lehrgang Summe der fehlenden Plätze (req-have),
    // Zahl der betroffenen Fahrzeuge und wie viele Personen dafür schon im Unterricht sind.
    function aggregate(vehicles) {
        const checkable = vehicles.filter(v => !cannotHavePersonnel(v));
        const byCourse = new Map(); // label -> { missing, vehicles, inTraining, key }
        let studyTotalByKey = new Map(), studyTotalByLabel = new Map();
        // Erst alle laufenden Ausbildungen über den ganzen Fuhrpark zählen (nach key und Label)
        for (const v of checkable) {
            const r = results[v.id]; if (!r) continue;
            for (const it of (r.inTraining || [])) {
                if (it.key) studyTotalByKey.set(it.key, (studyTotalByKey.get(it.key) || 0) + 1);
                if (it.label) studyTotalByLabel.set(it.label, (studyTotalByLabel.get(it.label) || 0) + 1);
            }
        }
        for (const v of checkable) {
            const r = results[v.id]; if (!r || !r.hasBlock) continue;
            for (const n of r.need) {
                if (n.ok) continue; // erfüllt -> kein Bedarf
                const miss = Math.max(0, n.req - n.have);
                if (!byCourse.has(n.label)) byCourse.set(n.label, { label: n.label, missing: 0, vehicles: 0, key: n.key || '' });
                const e = byCourse.get(n.label);
                e.missing += miss;
                e.vehicles += 1;
            }
        }
        // "in Ausbildung" je Lehrgang zuordnen (bevorzugt über den Namen-Anfang, sonst key)
        const rows = [...byCourse.values()].map(e => {
            // Label des Bedarfs (z.B. "Notarzt") vs. Ausbildungsname (z.B. "Notarzt-Ausbildung")
            let study = 0;
            for (const [lbl, cnt] of studyTotalByLabel) if (lbl.toLowerCase().startsWith(e.label.toLowerCase())) study += cnt;
            const net = Math.max(0, e.missing - study);
            return { ...e, study, net };
        });
        rows.sort((a, b) => b.net - a.net || b.missing - a.missing);
        return rows;
    }

    function renderSummary(panel, vehicles) {
        const $status = panel.querySelector('#lb-status');
        const $list = panel.querySelector('#lb-list');
        const rows = aggregate(vehicles);
        const totalMissing = rows.reduce((s, r) => s + r.missing, 0);
        const totalNet = rows.reduce((s, r) => s + r.net, 0);
        $status.innerHTML = `<b style="color:#f9e2af;">${rows.length}</b> Lehrgangs-Typen mit Bedarf · `
            + `<b>${totalMissing}</b> Plätze offen · <b style="color:#a6e3a1;">${totalNet}</b> nach Abzug laufender Ausbildungen`;
        if (!rows.length) { $list.innerHTML = '<div style="color:#a6e3a1;padding:8px;">Kein offener Lehrgangsbedarf. 🎉</div>'; return; }
        let html = '<div style="margin-top:4px;">';
        for (const r of rows) {
            const barMax = rows[0].missing || 1;
            const pct = Math.round(r.missing / barMax * 100);
            html += `<div style="padding:6px 4px;border-bottom:1px solid #313244;">
                <div style="display:flex;justify-content:space-between;align-items:baseline;">
                    <b>${r.label}</b>
                    <span style="font-size:12px;"><b style="color:#f38ba8;">${r.net}</b> <span style="color:#9399b2;">noch nötig</span></span>
                </div>
                <div style="font-size:11px;color:#9399b2;margin:2px 0;">
                    ${r.missing} Plätze offen in ${r.vehicles} Fahrzeug(en)${r.study ? ` · 🎓 ${r.study} in Ausbildung` : ''}
                </div>
                <div style="height:6px;background:#313244;border-radius:3px;overflow:hidden;">
                    <div style="height:100%;width:${pct}%;background:${r.net > 0 ? '#f38ba8' : '#a6e3a1'};"></div>
                </div>
            </div>`;
        }
        html += '</div>';
        $list.innerHTML = html;
    }

    function render(panel, vehicles) {
        if (viewMode === 'summary') { renderSummary(panel, vehicles); return; }
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
                    <button id="lb-view" title="Ansicht: Fahrzeug-Liste  /  Lehrgangs-Gesamtübersicht" style="background:none;border:1px solid #45475a;border-radius:4px;color:#cdd6f4;cursor:pointer;font-size:13px;padding:2px 7px;">📊 Übersicht</button>
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
        const vbtn = panel.querySelector('#lb-view');
        const fbtn = panel.querySelector('#lb-filter');
        const paintViewBtn = () => {
            vbtn.textContent = viewMode === 'summary' ? '📋 Fahrzeuge' : '📊 Übersicht';
            vbtn.style.background = viewMode === 'summary' ? '#89b4fa' : 'none';
            vbtn.style.color = viewMode === 'summary' ? '#1e1e2e' : '#cdd6f4';
            fbtn.style.display = viewMode === 'summary' ? 'none' : ''; // Filter nur in Fahrzeug-Liste
        };
        vbtn.onclick = () => {
            viewMode = viewMode === 'summary' ? 'list' : 'summary';
            paintViewBtn();
            loadVehicles().then(vs => render(panel, vs)).catch(() => {});
        };
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
        paintViewBtn();
        loadVehicles().then(vs => render(panel, vs)).catch(() => {});
    }

    function addBadge() {
        const menu = ensureToolsMenu();
        menu.add('lb-openbtn', '🎓 Lehrgangs-Bedarf', () => buildPanel(), 10);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addBadge);
    else addBadge();
})();
