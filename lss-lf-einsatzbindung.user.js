// ==UserScript==
// @name         LSS LF-Einsatzbindung
// @namespace    http://tampermonkey.net/
// @version      1.05
// @downloadURL  https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-lf-einsatzbindung.user.js
// @updateURL    https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-lf-einsatzbindung.user.js
// @description  Zeigt alle LFs der Ausnahme-Leitstelle (siehe Top-Verband-Skript, 🔓-Button), die aktuell in einem Einsatz gebunden sind – inkl. WELCHER Einsatz (klickbar). Datenquelle: /api/vehicles (FMS + Einsatzziel je Fahrzeug). Verbandseinsätze werden markiert.
// @match        https://www.leitstellenspiel.de/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    if (window.top !== window.self) return; // nur im Hauptfenster (kein doppeltes Panel in Lightbox-Frames)

    // LF-Familie – identisch zum Dispatch-/Verband-Skript. Bei Bedarf IDs ergänzen.
    const LF_TYPE_IDS = [0, 1, 6, 7, 8, 30];
    const REFRESH_MS = 60000; // Auto-Aktualisierung, solange das Panel offen ist

    // FMS-Status: gebunden = zu/an einem Einsatz (3 Anfahrt, 4 vor Ort, 5 Sprechwunsch, 7 Patient, 9 Transport)
    const FMS_LABEL = { 1: 'frei (Funk)', 2: 'frei (Wache)', 3: 'Anfahrt', 4: 'vor Ort', 5: 'Sprechwunsch', 6: 'nicht bereit', 7: 'Patient', 8: 'Rückkehr', 9: 'Transport' };
    const FMS_COLOR = { 3: '#f9e2af', 4: '#fab387', 5: '#f38ba8', 7: '#f38ba8', 9: '#f38ba8' };

    // Ausnahme-Leitstelle: gleicher localStorage-Schlüssel wie im Top-Verband-Skript (🔓-Button dort
    // konfigurieren) – dieses Panel zeigt AUSSCHLIESSLICH die LFs der dort hinterlegten Leitstelle(n).
    const EXEMPT_KEY = 'tv_exempt_dispatch';        // { leitstellen: [ids], names: [namensteile] }
    const EXEMPTBLD_KEY = 'tv_exempt_buildings';    // Cache: { ts, ids: [gebäude-ids] }
    function exemptConfig() {
        try {
            const c = JSON.parse(localStorage.getItem(EXEMPT_KEY) || '{}');
            return { leitstellen: (c.leitstellen || []).map(String), names: (c.names || []).map(n => n.toLowerCase()) };
        } catch (e) { return { leitstellen: [], names: [] }; }
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
        } catch (e) { console.warn('[LF-Bindung] /api/buildings nicht ladbar (Ausnahme-Leitstelle):', e); }
    }

    async function fetchLfState() {
        const cfg = exemptConfig();
        if (!cfg.leitstellen.length) return { noExemptConfigured: true };
        if (!exemptBuildingIds.size) await refreshExemptBuildings(true);

        const res = await fetch('/api/vehicles', { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status} bei /api/vehicles`);
        const all = await res.json();
        const lfs = all.filter(v => LF_TYPE_IDS.includes(Number(v.vehicle_type)) && exemptBuildingIds.has(String(v.building_id)));
        const bound = [], free = [], notReady = [];
        for (const v of lfs) {
            const fms = Number(v.fms_real ?? v.fms_show ?? 0);
            const missionId = (v.target_type === 'mission' && v.target_id) ? String(v.target_id) : null;
            if (missionId) bound.push({ id: v.id, name: v.caption || `LF ${v.id}`, fms, missionId });
            else if (fms === 6) notReady.push(v);
            else free.push(v);
        }
        return { total: lfs.length, bound, free: free.length, notReady: notReady.length, buildingCount: exemptBuildingIds.size };
    }

    // Einsatzname aus der Sidebar (mit Verband-Kennung), sonst generisch.
    function missionInfo(missionId) {
        const capEl = document.getElementById('mission_caption_' + missionId);
        let name = null;
        if (capEl) {
            const c = capEl.cloneNode(true);
            c.querySelectorAll('small').forEach(x => x.remove());
            name = c.textContent.replace(/,\s*$/, '').replace(/\s+/g, ' ').trim();
        }
        const panel = document.getElementById('mission_panel_' + missionId);
        const isVerband = (panel && panel.classList.contains('panel-success')) || /^\s*\[Verband\]/i.test(name || '');
        let state = 'unbekannt';
        if (panel) {
            if (panel.classList.contains('mission_panel_green')) state = 'gruen';
            else if (panel.classList.contains('mission_panel_yellow')) state = 'gelb';
            else if (panel.classList.contains('mission_panel_red')) state = 'rot';
        }
        return { name: name || `Einsatz #${missionId}`, isVerband, inList: !!capEl, state };
    }

    function render(panel, data) {
        const $status = panel.querySelector('#lfb-status');
        const $result = panel.querySelector('#lfb-result');
        const $split = panel.querySelector('#lfb-split');

        if (data.noExemptConfigured) {
            $status.innerHTML = '<span style="color:#f38ba8;">Keine Ausnahme-Leitstelle konfiguriert.</span>';
            $split.innerHTML = '';
            $result.innerHTML = '<div style="color:#9399b2;padding:8px;">Bitte im Top-Verband-Skript über den 🔓-Button eine Ausnahme-Leitstelle (z.B. "Leitstelle Essen") hinterlegen – dieses Panel zeigt ausschließlich deren LFs.</div>';
            return;
        }
        if (!data.buildingCount) {
            $status.innerHTML = '<span style="color:#f38ba8;">Ausnahme-Leitstelle konfiguriert, aber 0 zugeordnete Gebäude gefunden.</span>';
            $split.innerHTML = '';
            $result.innerHTML = '<div style="color:#9399b2;padding:8px;">Bitte die Leitstellen-Gebäude-ID im Top-Verband-Skript (🔓-Button) prüfen.</div>';
            return;
        }

        $status.innerHTML = `<b>${data.total} LF gesamt</b> – `
            + `<span style="color:#f9e2af;">${data.bound.length} gebunden</span>, `
            + `<span style="color:#a6e3a1;">${data.free} frei</span>`
            + (data.notReady ? `, <span style="color:#f38ba8;">${data.notReady} nicht bereit</span>` : '');

        // Einsatz-Sicht (v1.01): Bei wie vielen Einsätzen ist schon mindestens 1 LF VOR ORT
        // (FMS 4/5), und wie viele werden aktuell erst noch ANGEFAHREN (nur FMS 3 unterwegs)?
        const perMission = new Map();
        for (const lf of data.bound) {
            const st = perMission.get(lf.missionId) || { onScene: false };
            if (lf.fms === 4 || lf.fms === 5) st.onScene = true;
            perMission.set(lf.missionId, st);
        }
        let onSceneMissions = 0, drivingMissions = 0;
        for (const st of perMission.values()) (st.onScene ? onSceneMissions++ : drivingMissions++);
        let greenMissions = 0;
        for (const mid of perMission.keys()) {
            const p = document.getElementById('mission_panel_' + mid);
            if (p && p.classList.contains('mission_panel_green')) greenMissions++;
        }
        $split.innerHTML = perMission.size
            ? `<span style="color:#a6e3a1;" title="Einsätze, an denen mindestens 1 eigenes LF angekommen ist (FMS 4/5)">📍 ${onSceneMissions} Einsätze mit LF vor Ort</span>`
              + ` · <span style="color:#f9e2af;" title="Einsätze, zu denen eigene LFs unterwegs sind, aber noch keins angekommen ist (nur FMS 3)">🚗 ${drivingMissions} noch in Anfahrt</span>`
              + (greenMissions ? ` · <span style="color:#a6e3a1;" title="Einsätze, die bereits GRÜN sind: kein weiterer Bedarf, läuft nur noch ab – LF ist sicher gebunden bis Abschluss">✅ ${greenMissions} grün</span>` : '')
            : '';

        if (!data.bound.length) {
            $result.innerHTML = '<div style="color:#9399b2;padding:8px;">Aktuell ist kein LF in einem Einsatz gebunden. 🎉</div>';
            return;
        }

        // Nach Einsatz gruppieren, Verband zuerst kenntlich machen
        const byMission = new Map();
        for (const lf of data.bound) {
            if (!byMission.has(lf.missionId)) byMission.set(lf.missionId, { info: missionInfo(lf.missionId), lfs: [] });
            byMission.get(lf.missionId).lfs.push(lf);
        }
        const groups = [...byMission.entries()].sort((a, b) => b[1].lfs.length - a[1].lfs.length);

        const verbandCount = groups.filter(([, g]) => g.info.isVerband).reduce((s, [, g]) => s + g.lfs.length, 0);
        if (verbandCount) {
            $status.innerHTML += ` · <span style="color:#89b4fa;">davon ${verbandCount} in Verbandseinsätzen 💰</span>`;
        }

        let html = '';
        for (const [mid, g] of groups) {
            const st = g.info.state;
            const stStyle = st === 'gruen' ? 'background:rgba(166,227,161,.14);border-left:3px solid #a6e3a1;'
                : st === 'gelb' ? 'background:#313244;border-left:3px solid #f9e2af;'
                : st === 'rot' ? 'background:#313244;border-left:3px solid #f38ba8;'
                : 'background:#313244;border-left:3px solid #45475a;';
            html += `<div class="lfb-mission" data-id="${mid}" title="${st === 'gruen' ? 'Grün: kein weiterer Bedarf – Einsatz läuft nur noch ab' : st === 'unbekannt' ? 'Status unbekannt (Einsatz nicht in der Liste sichtbar)' : ''}" style="display:flex;align-items:center;gap:6px;padding:6px;margin-top:6px;${stStyle}border-radius:6px;cursor:pointer;">
                <span>${st === 'gruen' ? '✅' : (g.info.isVerband ? '💰' : '📟')}</span>
                <b style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${g.info.name}</b>
                <span style="color:#9399b2;font-size:11px;">#${mid}${g.info.inList ? '' : ' (nicht in Liste)'}</span>
                <b style="color:#f9e2af;">${g.lfs.length}×</b>
            </div>`;
            for (const lf of g.lfs.sort((a, b) => a.name.localeCompare(b.name, 'de'))) {
                const col = FMS_COLOR[lf.fms] || '#cdd6f4';
                html += `<div style="display:flex;align-items:center;gap:8px;padding:3px 6px 3px 26px;border-bottom:1px solid #313244;">
                    <a href="/vehicles/${lf.id}" class="lightbox-open" style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#cdd6f4;">${lf.name}</a>
                    <span style="color:${col};font-size:11px;white-space:nowrap;">FMS ${lf.fms} · ${FMS_LABEL[lf.fms] || '?'}</span>
                </div>`;
            }
        }
        $result.innerHTML = html;
        $result.querySelectorAll('.lfb-mission').forEach(row => {
            row.addEventListener('click', () => {
                const id = row.getAttribute('data-id');
                const btn = document.getElementById('alarm_button_' + id) || document.getElementById('mission_caption_' + id);
                if (btn) btn.click(); else window.open('/missions/' + id, '_blank');
            });
        });
    }

    let refreshTimer = null;
    async function refresh(panel) {
        const $status = panel.querySelector('#lfb-status');
        const $icon = panel.querySelector('#lfb-refresh');
        const $stamp = panel.querySelector('#lfb-stamp');
        if ($icon) { $icon.style.opacity = '0.35'; $icon.disabled = true; }
        if ($stamp) $stamp.textContent = 'aktualisiere…';
        try {
            const data = await fetchLfState();
            render(panel, data);
            if ($stamp) $stamp.textContent = `Stand: ${new Date().toLocaleTimeString('de-DE')}`;
        } catch (e) {
            $status.innerHTML = `<span style="color:#f38ba8;">Fehler: ${e.message}</span>`;
            if ($stamp) $stamp.textContent = 'Abruf fehlgeschlagen';
            console.warn('[LF-Bindung]', e);
        } finally {
            if ($icon) { $icon.style.opacity = ''; $icon.disabled = false; }
        }
    }

    function buildPanel() {
        const existing = document.getElementById('lfb-panel');
        if (existing) { refresh(existing); return; }
        const panel = document.createElement('div');
        panel.id = 'lfb-panel';
        panel.style.cssText = 'position:fixed;top:160px;right:20px;z-index:99999;width:380px;max-height:74vh;display:flex;flex-direction:column;background:#1e1e2e;color:#cdd6f4;border:1px solid #45475a;border-radius:10px;padding:14px;font:13px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);';
        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <b style="font-size:14px;">📟 LF-Einsatzbindung <span style="color:#9399b2;font-weight:400;">(Ausnahme-Leitstelle)</span> <span id="lfb-stamp" style="color:#9399b2;font-size:10px;font-weight:400;margin-left:6px;"></span></b>
                <div>
                    <button id="lfb-refresh" title="Aktualisieren" style="background:none;border:none;color:#cdd6f4;cursor:pointer;font-size:15px;">⟳</button>
                    <button id="lfb-close" style="background:none;border:none;color:#cdd6f4;cursor:pointer;font-size:16px;">✕</button>
                </div>
            </div>
            <div id="lfb-status" style="margin-bottom:2px;font-size:12px;">Lade…</div>
            <div id="lfb-split" style="margin-bottom:6px;font-size:12px;"></div>
            <div id="lfb-result" style="overflow:auto;flex:1;"></div>
            <div style="color:#9399b2;font-size:10px;margin-top:8px;">Zeigt NUR LFs der im Top-Verband-Skript hinterlegten Ausnahme-Leitstelle (🔓-Button dort). Quelle: /api/vehicles (FMS + Einsatzziel je LF). 💰 = Verbandseinsatz, ✅/grüner Rand = Einsatz bereits grün (kein Bedarf mehr). Randfarbe = Einsatzstatus (rot/gelb/grün). Klick auf Einsatz öffnet ihn, Klick aufs LF öffnet die Fahrzeugseite. Aktualisiert sich jede Minute, solange offen. Hinweis: Die Spiel-API puffert kurz – direkt nach einer Alarmierung kann der Stand einige Sekunden hinterherhinken.</div>
        `;
        document.body.appendChild(panel);
        panel.querySelector('#lfb-close').onclick = () => { panel.remove(); if (refreshTimer) clearInterval(refreshTimer); refreshTimer = null; };
        panel.querySelector('#lfb-refresh').onclick = () => refresh(panel);
        refresh(panel);
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = setInterval(() => {
            const p = document.getElementById('lfb-panel');
            if (p) refresh(p); else { clearInterval(refreshTimer); refreshTimer = null; }
        }, REFRESH_MS);
    }

    function addButton() {
        if (document.getElementById('lfb-openbtn')) return;
        const navUl = document.querySelector('#main_navbar #navbar-main-collapse ul.navbar-nav');
        if (navUl) {
            const li = document.createElement('li');
            li.id = 'lfb-openbtn';
            li.innerHTML = `<a href="#" title="LF-Einsatzbindung: welche LFs sind wo gebunden?" style="font-size:16px;">📟</a>`;
            li.querySelector('a').onclick = (e) => { e.preventDefault(); buildPanel(); };
            navUl.insertBefore(li, navUl.firstChild);
            return;
        }
        const btn = document.createElement('button');
        btn.id = 'lfb-openbtn';
        btn.textContent = '📟 LF-Bindung';
        btn.style.cssText = 'position:fixed;top:160px;right:20px;z-index:99998;padding:8px 12px;background:#f9e2af;color:#1e1e2e;border:none;border-radius:8px;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.3);';
        btn.onclick = buildPanel;
        document.body.appendChild(btn);
    }

    // Auf der Seite "Mögliche Einsätze" (/einsaetze) NICHT anzeigen – dort stört das Panel nur.
    const HIDE_ON = ['/einsaetze'];
    function startIfAllowed() {
        if (HIDE_ON.includes(location.pathname.replace(/\/$/, ''))) return;
        addButton();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startIfAllowed);
    } else {
        startIfAllowed();
    }
})();
