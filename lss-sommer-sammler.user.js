// ==UserScript==
// @name         LSS Sommer-Sammler (Sonnenblumen)
// @namespace    http://tampermonkey.net/
// @version      1.12
// @downloadURL  https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-sommer-sammler.user.js
// @updateURL    https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-sommer-sammler.user.js
// @description  Sammelt automatisch die Sommer-Event-Objekte (Sonnenblume 🌻) aus Einsatz-Headern ein. Zeigt an, bei welchen Einsätzen gesammelt wurde und wie viele insgesamt. Panel + Navbar-Badge.
// @match        https://www.leitstellenspiel.de/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';
    if (window.top !== window.self) return; // nur Hauptfenster

    const CONFIG = {
        scanIntervalMs: 45000,   // wie oft ein Hintergrund-Durchlauf über die offenen Einsätze startet
        autoCollect: true,       // automatisch einsammeln (sonst nur anzeigen/zählen)
        postDelayMs: 700,        // Pause zwischen zwei Sammel-POSTs
        fetchDelayMs: 900,       // Pause zwischen zwei Einsatzseiten-Abrufen (Server schonen)
        maxChecksPerRun: 40,     // max. Einsatzseiten je Durchlauf (Rest kommt beim nächsten Lauf dran)
        recheckMs: 180000,       // ein Einsatz ohne Blume wird frühestens nach dieser Zeit erneut geprüft
    };

    // ---- Persistenz (reload-fest, mit Quota-Notfall wie in den anderen Skripten) ----
    const LOG_KEY = 'sommer_collect_log';   // Liste { ts, missionId, name, addr }
    const SEEN_KEY = 'sommer_seen';         // Set bereits verarbeiteter <missionId>, gegen Doppel-POST
    let collectLog = [];
    let seen = new Set();
    try {
        const raw = JSON.parse(localStorage.getItem(LOG_KEY) || '[]') || [];
        collectLog = raw.map(e => ('t' in e)
            ? { ts: e.t, missionId: e.m, name: e.n, addr: e.a }   // kompaktes Format
            : { ts: e.ts, missionId: e.missionId, name: e.name, addr: e.addr }); // altes Format
    } catch (e) { collectLog = []; }
    try { seen = new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch (e) { seen = new Set(); }

    let persistBroken = false; // true = localStorage verweigert -> Zähler läuft nur für diese Sitzung
    // Nur die für Zähler+Historie nötigen Felder speichern (kompakt): ts gekürzt, name knapp.
    function compactLog() {
        return collectLog.slice(-400).map(e => ({ t: e.ts, m: e.missionId, n: (e.name || '').slice(0, 40), a: (e.addr || '').slice(0, 40) }));
    }
    function writeAll() {
        localStorage.setItem(LOG_KEY, JSON.stringify(compactLog()));
        localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-3000)));
        // Verifizieren, dass wirklich geschrieben wurde
        return localStorage.getItem(LOG_KEY) != null;
    }
    function persist() {
        try { if (writeAll()) { persistBroken = false; return true; } } catch (e) { /* Quota? */ }
        // Stufe 1: eigenes Log kürzen
        collectLog = collectLog.slice(-120);
        try { if (writeAll()) { persistBroken = false; return true; } } catch (e) {}
        // Stufe 2: die größten FREMD-Fresser opfern (Log/Audit der anderen Skripte). Statistiken
        // bauen sich neu auf – der Sommer-Zähler ist wichtiger als ein paar Zeilen Dispatch-Log.
        for (const k of ['ad_log_buffer', 'ad_audit_buffer', 'tv_send_log', 'tv_type_credits']) {
            try { localStorage.removeItem(k); } catch (e) {}
        }
        try {
            if (writeAll()) {
                persistBroken = false;
                console.warn('[Sommer-Sammler] Speicher war voll – Dispatch-Log/Audit-Cache geleert, Sammler-Zähler nun dauerhaft gespeichert.');
                return true;
            }
        } catch (e) {}
        persistBroken = true;
        console.warn('[Sommer-Sammler] localStorage verweigert trotz Aufräumen – Zähler nur für diese Sitzung. Bitte einmal localStorage.clear() in der Konsole ausführen.');
        return false;
    }

    // ---- Sonnenblumen finden und einsammeln ----
    // Der Link #easter-egg-link (bzw. summer_item-Bilder) trägt href="/missions/<id>/claim_found_object_sync".
    // Wir POSTen direkt auf /missions/<id>/claim_found_object – dieselbe Route wie der Original-Klick.
    function findSunflowerLinks() {
        const out = [];
        const seenIds = new Set();
        // a) explizite Event-Links
        for (const a of document.querySelectorAll('a[href*="claim_found_object"]')) {
            const m = (a.getAttribute('href') || '').match(/\/missions\/(\d+)\/claim_found_object/);
            if (m && !seenIds.has(m[1])) { seenIds.add(m[1]); out.push({ id: m[1], el: a }); }
        }
        // b) Fallback: Event-Bild ohne fassbaren Link -> nächstgelegene mission-ID aus dem Header
        for (const img of document.querySelectorAll('img[src*="summer_item"], img[src*="found_object"]')) {
            if (img.closest('a[href*="claim_found_object"]')) continue; // schon über (a) erfasst
            const host = img.closest('[data-mission-title], [id^="mission_"]');
            const idm = host && (host.id.match(/(\d{6,})/) || (host.querySelector('[id*="mission_bar_"]')?.id.match(/(\d{6,})/)));
            if (idm && !seenIds.has(idm[1])) { seenIds.add(idm[1]); out.push({ id: idm[1], el: img }); }
        }
        return out;
    }

    function csrfToken() {
        return document.querySelector('meta[name="csrf-token"]')?.content || '';
    }

    // IDs aller aktuell offenen EIGENEN Einsätze aus der Einsatzliste der Hauptseite.
    // (Nur eigene: freigegebene/Verband haben grünen Rand panel-success -> überspringen.)
    function openOwnMissionIds() {
        const ids = [];
        const allianceList = document.getElementById('mission_list_alliance');
        for (const panel of document.querySelectorAll('#mission_list [id^="mission_panel_"]')) {
            // Sicherheitshalber alles im Verbands-Container ausschließen
            if (allianceList && allianceList.contains(panel)) continue;
            if (panel.classList.contains('panel-success')) continue; // an Allianz freigegeben
            const id = panel.id.replace('mission_panel_', '');
            if (/^\d+$/.test(id)) ids.push(id);
        }
        return ids;
    }

    // Wann wurde ein Einsatz zuletzt (ergebnislos) auf eine Blume geprüft?
    const lastChecked = new Map(); // missionId -> ts

    // Eine Einsatzseite im Hintergrund abrufen und auf Sonnenblume prüfen; wenn vorhanden -> einsammeln.
    async function checkMissionPage(id) {
        try {
            const res = await fetch(`/missions/${id}`, { credentials: 'same-origin', cache: 'no-store' });
            if (!res.ok) return false;
            const html = await res.text();
            if (!/claim_found_object|summer_item|easter-egg-link/.test(html)) {
                lastChecked.set(id, Date.now()); // keine Blume -> Merker, erst nach recheckMs erneut
                return false;
            }
            // Blume vorhanden -> einsammeln (POST wie der Original-Klick)
            const res2 = await fetch(`/missions/${id}/claim_found_object`, {
                method: 'POST', credentials: 'same-origin',
                headers: { 'X-CSRF-Token': csrfToken(), 'X-Requested-With': 'XMLHttpRequest' },
            });
            const t = html.match(/data-mission-title="([^"]*)"/);
            const a = html.match(/data-address="([^"]*)"/);
            console.log(`[Sommer-Sammler] #${id} Blume gefunden, POST-Status ${res2.status}`);
            if (res2.status === 404 || res2.status === 422) {
                // schon gesammelt / nicht mehr da -> nur merken, nicht zählen
                seen.add(id); lastChecked.set(id, Date.now());
                return false;
            }
            // Alles andere (200, 201, 302, ...) als Erfolg werten und ZÄHLEN.
            collectLog.push({ ts: Date.now(), missionId: id, name: t ? t[1] : ('#' + id), addr: a ? a[1] : '' });
            seen.add(id);
            lastChecked.set(id, Date.now());
            return true;
        } catch (e) { /* Netz – nächster Lauf */ }
        return false;
    }

    function missionMeta(id) {
        // Name/Adresse für die Historie – aus dem Header, wenn verfügbar
        const gi = document.querySelector('#mission_general_info[data-mission-title]');
        if (gi && document.querySelector(`#mission_bar_${id}`)) {
            return { name: gi.getAttribute('data-mission-title') || '?', addr: gi.getAttribute('data-address') || '' };
        }
        const cap = document.getElementById('mission_caption_' + id);
        let name = '?';
        if (cap) { const c = cap.cloneNode(true); c.querySelectorAll('small').forEach(x => x.remove()); name = c.textContent.replace(/\s+/g, ' ').trim(); }
        return { name, addr: '' };
    }

    let collecting = false;
    // manual=true: die aktuell geöffnete Seite sofort abgrasen (DOM-Blume direkt einsammeln)
    async function collectAll(manual = false) {
        if (collecting) return 0;
        collecting = true;
        let got = 0;
        try {
            // a) Falls gerade eine Einsatzseite offen ist und eine Blume im DOM hat: sofort mitnehmen.
            for (const l of findSunflowerLinks()) {
                if (seen.has(l.id) && !manual) continue;
                try {
                    const res = await fetch(`/missions/${l.id}/claim_found_object`, {
                        method: 'POST', credentials: 'same-origin',
                        headers: { 'X-CSRF-Token': csrfToken(), 'X-Requested-With': 'XMLHttpRequest' },
                    });
                    if (res.ok) {
                        const meta = missionMeta(l.id);
                        collectLog.push({ ts: Date.now(), missionId: l.id, name: meta.name, addr: meta.addr });
                        seen.add(l.id); got++;
                        if (l.el && l.el.closest) { const box = l.el.closest('a') || l.el; box.style.display = 'none'; }
                    } else if (res.status === 404 || res.status === 422) { seen.add(l.id); }
                } catch (e) { /* nächster Lauf */ }
                await new Promise(r => setTimeout(r, CONFIG.postDelayMs));
            }

            // b) Hintergrund-Scan: offene eigene Einsätze abklappern (fällig, wenn noch nie oder lange
            //    nicht geprüft). Durchsatz gedeckelt, damit der Server nicht geflutet wird.
            if (CONFIG.autoCollect || manual) {
                const now = Date.now();
                const candidates = openOwnMissionIds()
                    .filter(id => !seen.has(id))
                    .filter(id => !lastChecked.has(id) || now - lastChecked.get(id) > CONFIG.recheckMs)
                    .slice(0, CONFIG.maxChecksPerRun);
                for (const id of candidates) {
                    const ok = await checkMissionPage(id);
                    if (ok) got++;
                    await new Promise(r => setTimeout(r, CONFIG.fetchDelayMs));
                }
            }

            if (got) { updateBadge(); renderPanelIfOpen(); persist(); } // erst anzeigen, dann speichern
            return got;
        } finally { collecting = false; }
    }

    // ---- UI: Navbar-Badge + Panel ----
    function total() { return collectLog.length; }

    function updateBadge() {
        const b = document.getElementById('sommer-badge-count');
        if (b) b.textContent = total();
    }

    function fmtDate(ts) {
        return new Date(ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    }

    function renderPanelIfOpen() {
        const body = document.getElementById('sommer-panel-body');
        if (!body) return;
        const n = total();
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const today = collectLog.filter(e => e.ts >= todayStart.getTime()).length;
        let html = `<div style="margin-bottom:8px;font-size:13px;">
            <b style="color:#f9e2af;font-size:18px;">🌻 ${n}</b> insgesamt gesammelt · <b>${today}</b> heute
            <span style="color:#9399b2;"> · Auto-Sammeln: ${CONFIG.autoCollect ? 'AN' : 'aus'}</span>
        </div>`;
        if (persistBroken) {
            html += `<div style="color:#f38ba8;font-size:11px;margin-bottom:6px;">⚠️ Speicher voll – Zähler geht nach einem Reload verloren. Einmal <code>localStorage.clear()</code> in der Konsole (F12) ausführen und neu laden.</div>`;
        }
        if (!collectLog.length) {
            html += '<div style="color:#9399b2;padding:6px;">Noch nichts gesammelt. Sobald eine 🌻 in einem Einsatz-Header auftaucht, wird sie automatisch eingesammelt.</div>';
        } else {
            html += '<div style="max-height:46vh;overflow:auto;">';
            for (const e of [...collectLog].reverse().slice(0, 200)) {
                html += `<div style="display:flex;gap:8px;align-items:baseline;padding:4px 2px;border-bottom:1px solid #313244;">
                    <span style="color:#9399b2;font-size:11px;white-space:nowrap;">${fmtDate(e.ts)}</span>
                    <a href="/missions/${e.missionId}" style="flex:1;min-width:0;color:#cdd6f4;text-overflow:ellipsis;overflow:hidden;white-space:nowrap;">${e.name || ('#' + e.missionId)}</a>
                    ${e.addr ? `<span style="color:#9399b2;font-size:11px;white-space:nowrap;">${e.addr}</span>` : ''}
                </div>`;
            }
            html += '</div>';
        }
        body.innerHTML = html;
    }

    function buildPanel() {
        let panel = document.getElementById('sommer-panel');
        if (panel) { panel.remove(); return; }
        panel = document.createElement('div');
        panel.id = 'sommer-panel';
        panel.style.cssText = 'position:fixed;top:150px;right:20px;z-index:99999;width:380px;max-height:78vh;display:flex;flex-direction:column;background:#1e1e2e;color:#cdd6f4;border:1px solid #45475a;border-radius:10px;padding:14px;font:13px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);';
        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <b style="font-size:14px;">🌻 Sommer-Sammler</b>
                <div>
                    <button id="sommer-toggle" title="Auto-Sammeln an/aus" style="background:none;border:1px solid #45475a;border-radius:4px;color:#cdd6f4;cursor:pointer;font-size:11px;padding:2px 6px;">Auto</button>
                    <button id="sommer-now" title="Jetzt auf dieser Seite einsammeln" style="background:none;border:1px solid #45475a;border-radius:4px;color:#cdd6f4;cursor:pointer;font-size:11px;padding:2px 6px;">Jetzt</button>
                    <button id="sommer-close" style="background:none;border:none;color:#cdd6f4;cursor:pointer;font-size:16px;">✕</button>
                </div>
            </div>
            <div id="sommer-panel-body"></div>
            <div style="color:#9399b2;font-size:10px;margin-top:8px;">Prüft offene eigene Einsätze im Hintergrund auf 🌻 und sammelt automatisch ein (die Blume erscheint nur auf der geöffneten Einsatzseite). Klick auf einen Eintrag öffnet den Einsatz.</div>
        `;
        document.body.appendChild(panel);
        panel.querySelector('#sommer-close').onclick = () => panel.remove();
        panel.querySelector('#sommer-now').onclick = () => collectAll(true).then(g => { if (g === 0) renderPanelIfOpen(); });
        panel.querySelector('#sommer-toggle').onclick = (e) => {
            CONFIG.autoCollect = !CONFIG.autoCollect;
            e.target.style.background = CONFIG.autoCollect ? '#a6e3a1' : 'none';
            e.target.style.color = CONFIG.autoCollect ? '#1e1e2e' : '#cdd6f4';
            renderPanelIfOpen();
        };
        const tgl = panel.querySelector('#sommer-toggle');
        tgl.style.background = CONFIG.autoCollect ? '#a6e3a1' : 'none';
        tgl.style.color = CONFIG.autoCollect ? '#1e1e2e' : '#cdd6f4';
        renderPanelIfOpen();
    }

    function addBadge() {
        if (document.getElementById('sommer-badge')) return;
        const navUl = document.querySelector('#main_navbar #navbar-main-collapse ul.navbar-nav');
        if (navUl) {
            const li = document.createElement('li');
            li.id = 'sommer-badge';
            li.innerHTML = `<a href="#" title="Sommer-Sammler: gesammelte 🌻 ansehen"><span style="font-size:15px;">🌻</span> <span id="sommer-badge-count" style="font-weight:600;">${total()}</span></a>`;
            li.querySelector('a').onclick = (e) => { e.preventDefault(); buildPanel(); };
            navUl.insertBefore(li, navUl.firstChild);
        } else {
            const btn = document.createElement('button');
            btn.id = 'sommer-badge';
            btn.innerHTML = `🌻 <span id="sommer-badge-count">${total()}</span>`;
            btn.style.cssText = 'position:fixed;top:150px;right:20px;z-index:99998;padding:8px 12px;background:#f9e2af;color:#1e1e2e;border:none;border-radius:8px;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.3);';
            btn.onclick = buildPanel;
            document.body.appendChild(btn);
        }
    }

    // ---- Start ----
    function start() {
        addBadge();
        collectAll(); // sofort beim Laden
        setInterval(() => { if (CONFIG.autoCollect) collectAll(); }, CONFIG.scanIntervalMs);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
