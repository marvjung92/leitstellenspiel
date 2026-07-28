// ==UserScript==
// @name         LSS Wachen-Setup (Automatisch + Personalziel 300)
// @namespace    http://tampermonkey.net/
// @version      1.04
// @downloadURL  https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-wachen-setup.user.js
// @updateURL    https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-wachen-setup.user.js
// @description  Findet über /api/buildings alle Wachen mit Personalziel 0, klickt bei ihnen "Automatisch" (hire_do/automatic) und setzt das Personalziel auf 300. Mit Drosselung, CSRF-Token und Fortschritts-Panel.
// @match        https://www.leitstellenspiel.de/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';
    if (window.top !== window.self) return;

    const CONFIG = {
        targetValue: 300,       // Personalziel, das gesetzt wird
        onlyTarget0: true,      // nur Wachen anfassen, deren Personalziel aktuell 0 ist
        actionDelayMs: 800,     // Pause zwischen zwei Schreib-Aktionen (Server schonen)
        maxPerRun: 500,         // Sicherheitsobergrenze pro Durchlauf
        skipNamePatterns: ['schule', 'krankenhaus'], // Gebäude mit diesen Wörtern im Namen (case-egal) überspringen – haben kein Personalziel
    };

    function csrfToken() {
        return document.querySelector('meta[name="csrf-token"]')?.content || '';
    }

    // Alle Gebäude laden (paginiert absichern wie in den anderen Skripten).
    async function loadBuildings() {
        const all = [];
        const seen = new Set();
        const scan = (arr) => { for (const b of arr) if (!seen.has(b.id)) { seen.add(b.id); all.push(b); } };
        const res = await fetch('/api/buildings', { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) throw new Error(`/api/buildings HTTP ${res.status}`);
        const first = await res.json();
        if (Array.isArray(first)) {
            scan(first);
            const pageSize = first.length;
            if (pageSize >= 100) {
                for (let offset = pageSize; offset < 50000; offset += pageSize) {
                    const r = await fetch(`/api/buildings?limit=${pageSize}&offset=${offset}`, { credentials: 'same-origin', cache: 'no-store' });
                    if (!r.ok) break;
                    const page = await r.json();
                    if (!Array.isArray(page) || !page.length) break;
                    scan(page);
                    if (page.length < pageSize) break;
                }
            }
        } else if (first && Array.isArray(first.buildings)) { scan(first.buildings); }
        return all;
    }

    // Welche Wachen müssen eingerichtet werden? Kriterium: Personalziel 0 (unabhängig vom Typ).
    function isExcludedByName(b) {
        const name = (b.caption || '').toLowerCase();
        return CONFIG.skipNamePatterns.some(p => name.includes(p));
    }
    function needsSetup(all) {
        return all.filter(b => {
            if (isExcludedByName(b)) return false; // Schulen/Krankenhäuser haben kein Personalziel
            const target = Number(b.personal_count_target ?? 0);
            return CONFIG.onlyTarget0 ? target === 0 : target < CONFIG.targetValue;
        });
    }

    // "Automatisch"-Einstellung aktivieren (entspricht dem Klick auf den Automatisch-Button).
    async function setAutomatic(id) {
        const res = await fetch(`/buildings/${id}/hire_do/automatic`, {
            method: 'GET', credentials: 'same-origin',
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        return res.ok || res.status === 302;
    }

    // Personalziel setzen – als echtes Rails-Formular: erst die Edit-Seite laden, deren CSRF-Token
    // und das Feld building[personal_count_target] übernehmen, dann mit commit=Speichern absenden.
    // Gibt zurück: 'ok' | 'nofield' (Gebäude hat kein Personalziel, z.B. Krankenhaus) | 'fail'.
    async function setTarget(id, value) {
        let formHtml;
        try {
            const g = await fetch(`/buildings/${id}/personalCountTarget`, {
                credentials: 'same-origin', cache: 'no-store',
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
            });
            if (!g.ok) return 'fail';
            formHtml = await g.text();
        } catch (e) { return 'fail'; }

        // Kein Personalziel-Feld (z.B. Krankenhaus) -> überspringen, nicht als Fehler werten.
        if (!/name="building\[personal_count_target\]"/.test(formHtml)) return 'nofield';

        // Token, Action-URL und _method DIREKT aus dem geladenen Formular übernehmen (nicht raten).
        // Beleg (HAR): action="/buildings/<id>?personal_count_target_only=1", _method=patch,
        // Feld building[personal_count_target], commit=Speichern. Rails braucht _method=patch,
        // sonst wird die Anfrage abgelehnt (genau der bisherige Fehler).
        const tokM = formHtml.match(/name="authenticity_token"[^>]*value="([^"]+)"/)
                  || formHtml.match(/name="csrf-token"[^>]*content="([^"]+)"/);
        const token = tokM ? tokM[1] : csrfToken();
        const actM = formHtml.match(/<form[^>]*action="([^"]+)"/i);
        const action = actM ? actM[1].replace(/&amp;/g, '&') : `/buildings/${id}?personal_count_target_only=1`;
        const methM = formHtml.match(/name="_method"[^>]*value="([^"]+)"/);
        const method = methM ? methM[1] : 'patch';

        const body = new URLSearchParams();
        body.set('utf8', '✓');
        body.set('_method', method);           // <- entscheidend: Rails-Method-Override (patch)
        body.set('authenticity_token', token);
        body.set('building[personal_count_target]', String(value));
        body.set('commit', 'Speichern');
        try {
            const res = await fetch(action, {
                method: 'POST', credentials: 'same-origin', redirect: 'follow',
                headers: {
                    'X-CSRF-Token': token,
                    'X-Requested-With': 'XMLHttpRequest',
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                },
                body: body.toString(),
            });
            if (!(res.ok || res.status === 302)) return 'fail';
            // Erfolg gegenprüfen: die AJAX-Antwort enthält den neuen Wert (bei Fehler das Wort "error").
            let txt = '';
            try { txt = await res.text(); } catch (e) { /* egal */ }
            if (/\berror\b/i.test(txt) && !new RegExp('\\b' + value + '\\b').test(txt)) return 'fail';
            return 'ok';
        } catch (e) { return 'fail'; }
    }

    let running = false;
    async function runSetup(panel) {
        if (running) return;
        running = true;
        const $status = panel.querySelector('#ws-status');
        const $log = panel.querySelector('#ws-log');
        const setStatus = (t) => { if ($status) $status.innerHTML = t; };
        const addLog = (t, col = '#cdd6f4') => {
            if (!$log) return;
            const d = document.createElement('div');
            d.style.cssText = `color:${col};padding:2px 0;border-bottom:1px solid #313244;`;
            d.textContent = t;
            $log.prepend(d);
        };
        try {
            setStatus('Lade Gebäudeliste…');
            const all = await loadBuildings();
            const todo = needsSetup(all).slice(0, CONFIG.maxPerRun);
            if (!todo.length) { setStatus(`<b style="color:#a6e3a1;">Alles erledigt</b> – keine Wache mit Personalziel 0 gefunden (${all.length} Gebäude geprüft).`); running = false; return; }
            setStatus(`<b>${todo.length}</b> Wache(n) mit Personalziel 0 gefunden. Richte ein…`);
            let autoOk = 0, targetOk = 0, skipped = 0, fail = 0;
            for (let i = 0; i < todo.length; i++) {
                const b = todo[i];
                const name = b.caption || `#${b.id}`;
                try {
                    const a = await setAutomatic(b.id);
                    await new Promise(r => setTimeout(r, CONFIG.actionDelayMs));
                    const t = await setTarget(b.id, CONFIG.targetValue);
                    if (a) autoOk++;
                    if (t === 'ok') {
                        targetOk++;
                        addLog(`✅ ${name}: Automatisch ${a ? '✓' : '✗'}, Ziel ${CONFIG.targetValue} ✓`, a ? '#a6e3a1' : '#f9e2af');
                    } else if (t === 'nofield') {
                        skipped++;
                        addLog(`⏭️ ${name}: kein Personalziel-Feld (z.B. Krankenhaus) – übersprungen`, '#9399b2');
                    } else {
                        fail++;
                        addLog(`❌ ${name}: Ziel setzen fehlgeschlagen (Automatisch ${a ? '✓' : '✗'})`, '#f38ba8');
                    }
                } catch (e) { fail++; addLog(`❌ ${name}: ${e.message}`, '#f38ba8'); }
                setStatus(`Richte ein… <b>${i + 1}/${todo.length}</b> · Automatisch ${autoOk} · Ziel ${targetOk}${skipped ? ` · übersprungen ${skipped}` : ''}${fail ? ` · Fehler ${fail}` : ''}`);
                await new Promise(r => setTimeout(r, CONFIG.actionDelayMs));
            }
            setStatus(`<b style="color:#a6e3a1;">Fertig.</b> ${todo.length} Wache(n): Automatisch ${autoOk}×, Ziel ${CONFIG.targetValue} ${targetOk}×${skipped ? `, übersprungen ${skipped}` : ''}${fail ? `, <span style="color:#f38ba8;">${fail} Fehler</span>` : ''}.`);
        } catch (e) {
            setStatus(`<span style="color:#f38ba8;">Fehler: ${e.message}</span>`);
        } finally { running = false; }
    }

    // Vorschau: nur zählen und auflisten, nichts schreiben.
    async function preview(panel) {
        const $status = panel.querySelector('#ws-status');
        const $log = panel.querySelector('#ws-log');
        $status.innerHTML = 'Lade Gebäudeliste…';
        try {
            const all = await loadBuildings();
            const todo = needsSetup(all);
            $log.innerHTML = '';
            for (const b of todo.slice(0, 300)) {
                const d = document.createElement('div');
                d.style.cssText = 'color:#cdd6f4;padding:2px 0;border-bottom:1px solid #313244;';
                d.textContent = `${b.caption || '#' + b.id} (Ziel aktuell ${b.personal_count_target ?? 0})`;
                $log.appendChild(d);
            }
            $status.innerHTML = `<b>${todo.length}</b> Wache(n) hätten Personalziel 0 (von ${all.length} Gebäuden). Noch nichts geändert – "▶ Einrichten" startet.`;
        } catch (e) { $status.innerHTML = `<span style="color:#f38ba8;">Fehler: ${e.message}</span>`; }
    }

    function buildPanel() {
        let panel = document.getElementById('ws-panel');
        if (panel) { panel.remove(); return; }
        panel = document.createElement('div');
        panel.id = 'ws-panel';
        panel.style.cssText = 'position:fixed;top:150px;right:20px;z-index:99999;width:420px;max-height:80vh;display:flex;flex-direction:column;background:#1e1e2e;color:#cdd6f4;border:1px solid #45475a;border-radius:10px;padding:14px;font:13px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);';
        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <b style="font-size:14px;">🏗️ Wachen-Setup</b>
                <button id="ws-close" style="background:none;border:none;color:#cdd6f4;cursor:pointer;font-size:16px;">✕</button>
            </div>
            <div style="display:flex;gap:6px;margin-bottom:8px;">
                <button id="ws-preview" style="flex:1;padding:7px;background:#45475a;color:#cdd6f4;border:none;border-radius:6px;font-weight:600;cursor:pointer;">🔍 Vorschau</button>
                <button id="ws-run" style="flex:1;padding:7px;background:#a6e3a1;color:#1e1e2e;border:none;border-radius:6px;font-weight:600;cursor:pointer;">▶ Einrichten (Auto + Ziel ${CONFIG.targetValue})</button>
            </div>
            <div id="ws-status" style="margin-bottom:8px;font-size:12px;">Bereit. „Vorschau" zeigt, welche Wachen betroffen sind, „Einrichten" setzt Automatisch + Ziel ${CONFIG.targetValue}.</div>
            <div id="ws-log" style="overflow:auto;flex:1;font-size:12px;"></div>
            <div style="color:#9399b2;font-size:10px;margin-top:8px;">Quelle: /api/buildings. Betroffen sind alle Wachen mit Personalziel 0. Aktionen werden gedrosselt ausgeführt (${CONFIG.actionDelayMs} ms). Schulen &amp; Krankenhäuser werden übersprungen.</div>
        `;
        document.body.appendChild(panel);
        panel.querySelector('#ws-close').onclick = () => panel.remove();
        panel.querySelector('#ws-preview').onclick = () => preview(panel);
        panel.querySelector('#ws-run').onclick = () => {
            if (running) return;
            if (confirm(`Jetzt bei allen Wachen mit Personalziel 0 "Automatisch" aktivieren und Ziel auf ${CONFIG.targetValue} setzen?`)) runSetup(panel);
        };
    }

    function addButton() {
        if (document.getElementById('ws-openbtn')) return;
        const navUl = document.querySelector('#main_navbar #navbar-main-collapse ul.navbar-nav');
        if (navUl) {
            const li = document.createElement('li');
            li.id = 'ws-openbtn';
            li.innerHTML = `<a href="#" title="Wachen-Setup: Automatisch + Personalziel ${CONFIG.targetValue}"><span style="font-size:15px;">🏗️</span></a>`;
            li.querySelector('a').onclick = (e) => { e.preventDefault(); buildPanel(); };
            navUl.insertBefore(li, navUl.firstChild);
        } else {
            const btn = document.createElement('button');
            btn.id = 'ws-openbtn';
            btn.textContent = '🏗️ Wachen-Setup';
            btn.style.cssText = 'position:fixed;top:150px;right:20px;z-index:99998;padding:8px 12px;background:#f9e2af;color:#1e1e2e;border:none;border-radius:8px;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.3);';
            btn.onclick = buildPanel;
            document.body.appendChild(btn);
        }
    }

    // Auf der Seite "Mögliche Einsätze" (/einsaetze) NICHT anzeigen – dort stört der Button nur.
    const HIDE_ON = ['/einsaetze'];
    function startIfAllowed() {
        if (HIDE_ON.includes(location.pathname.replace(/\/$/, ''))) return;
        addButton();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startIfAllowed);
    else startIfAllowed();
})();
