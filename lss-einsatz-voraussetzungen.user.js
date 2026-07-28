// ==UserScript==
// @name         LSS Einsatz-Voraussetzungen (was fehlt)
// @namespace    http://tampermonkey.net/
// @version      1.02
// @downloadURL  https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-einsatz-voraussetzungen.user.js
// @updateURL    https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-einsatz-voraussetzungen.user.js
// @description  Wertet die Einsatz-Übersicht (/einsaetze) aus und zeigt, welche Gebäude/Fachgruppen fehlen, um Einsätze zu generieren. Zwei Ansichten: Gesamtbedarf gebündelt und pro Einsatztyp.
// @match        https://www.leitstellenspiel.de/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';
    if (window.top !== window.self) return;

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

    let viewMode = 'summary'; // 'summary' = Gesamtbedarf gebündelt | 'byMission' = pro Einsatztyp
    let lastData = null;

    // Die /einsaetze-Liste ist PAGINIERT (viele Seiten, ?page=N). Alle Seiten laden und die
    // Einsatz-Zeilen zusammentragen – sonst sieht man nur die erste Seite (Beleg: nur Feuerwehr-
    // Einsätze sichtbar, THW-Brückenbau fehlte, weil auf späterer Seite).
    async function fetchPage(n, onProgress) {
        const res = await fetch(`/einsaetze?page=${n}`, { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) throw new Error(`/einsaetze?page=${n} HTTP ${res.status}`);
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        // Letzte Seitenzahl aus der Pagination bestimmen (einmalig auf Seite 1)
        let lastPage = 1;
        for (const a of doc.querySelectorAll('a[href*="einsaetze?page="]')) {
            const m = (a.getAttribute('href') || '').match(/page=(\d+)/);
            if (m) lastPage = Math.max(lastPage, parseInt(m[1], 10));
        }
        return { doc, lastPage };
    }

    async function loadAllMissions(onProgress) {
        const first = await fetchPage(1);
        let all = parse(first.doc);
        const last = first.lastPage;
        for (let p = 2; p <= last; p++) {
            if (onProgress) onProgress(p, last);
            const { doc } = await fetchPage(p);
            all = all.concat(parse(doc));
            await new Promise(r => setTimeout(r, 120)); // Server schonen
        }
        // Dedupe nach Einsatzname (Varianten-Zeilen desselben Einsatzes zusammenführen: schlimmster Fall zählt)
        const byName = new Map();
        for (const m of all) {
            if (!byName.has(m.name)) { byName.set(m.name, m); continue; }
            const ex = byName.get(m.name);
            // die Zeile mit mehr fehlenden Anforderungen behalten
            if (m.unmet.length > ex.unmet.length) byName.set(m.name, m);
        }
        return [...byName.values()];
    }

    // Parsen: pro Einsatztyp die fehlenden Anforderungen sammeln.
    // Zeile mit class "error" = Voraussetzung nicht erfüllt. Darin count-requirement-Divs:
    //   mit Klasse "fulfilled" = erfüllt; ohne = fehlt. Text z.B. "2 THW: Fachgruppen Brückenbau (1)"
    //   -> gebraucht 2, in Klammern (1) = es fehlt noch 1.
    function parse(doc) {
        const missions = [];
        const rows = doc.querySelectorAll('tr.mission_type_index_searchable');
        for (const row of rows) {
            const isError = row.classList.contains('error');
            const linkEl = row.querySelector('a[href^="/einsaetze/"]');
            const name = linkEl ? linkEl.textContent.trim() : '(unbekannt)';
            const reqs = [];
            for (const rq of row.querySelectorAll('.count-requirement')) {
                const raw = rq.textContent.replace(/\s+/g, ' ').trim();
                // Die "(n)"-Klammer am Ende ist der ZUVERLÄSSIGE Marker: sie erscheint NUR, wenn n fehlen.
                // Die CSS-Klasse "fulfilled" ist NICHT zuverlässig (fehlt teils auch bei erfüllten) –
                // Beleg (Brennender Abfallcontainer): "1 Feuerwache" ohne Klammer trotz vieler Wachen.
                const missM = raw.match(/\((\d+)\)\s*$/);
                const missing = missM ? parseInt(missM[1], 10) : 0;
                const label = raw.replace(/\s*\(\d+\)\s*$/, '').trim();
                reqs.push({ label, fulfilled: missing === 0, missing });
            }
            const unmet = reqs.filter(r => r.missing > 0);
            // Nur aufnehmen, wenn tatsächlich etwas fehlt. Die "error"-Klasse allein genügt NICHT
            // (sie steht auch an bereits erfüllten Varianten-Zeilen).
            if (unmet.length) missions.push({ name, reqs, unmet });
        }
        return missions;
    }

    // Label auf "Bausache" normalisieren: führende Zahl entfernen, damit gleiche Anforderungen
    // verschiedener Einsätze zusammengezählt werden ("2 THW: Fachgruppen Brückenbau" -> "THW: Fachgruppen Brückenbau").
    function baseLabel(label) {
        return label.replace(/^\s*\d+\s*/, '').trim();
    }

    function render(panel) {
        const $status = panel.querySelector('#ev-status');
        const $list = panel.querySelector('#ev-list');
        if (!lastData) { $status.innerHTML = 'Bereit – „⟳ Prüfen" liest die Einsatz-Übersicht.'; $list.innerHTML = ''; return; }
        const blocked = lastData.filter(m => m.unmet.length);
        if (viewMode === 'summary') {
            // Gesamtbedarf: fehlende Anforderungen über alle Einsätze bündeln (max. fehlende Anzahl je Typ,
            // denn wenn Einsatz A 2 und Einsatz B 3 braucht, deckt der Bau von 3 beide ab).
            const need = new Map(); // baseLabel -> { maxMissing, missions:Set }
            for (const m of blocked) {
                for (const r of m.unmet) {
                    const key = baseLabel(r.label);
                    const miss = r.missing || 1;
                    if (!need.has(key)) need.set(key, { maxMissing: 0, missions: new Set() });
                    const e = need.get(key);
                    e.maxMissing = Math.max(e.maxMissing, miss);
                    e.missions.add(m.name);
                }
            }
            const rows = [...need.entries()].map(([label, e]) => ({ label, missing: e.maxMissing, count: e.missions.size }))
                .sort((a, b) => b.count - a.count || b.missing - a.missing);
            $status.innerHTML = `<b style="color:#f9e2af;">${rows.length}</b> fehlende Gebäude/Fachgruppen blockieren `
                + `<b>${blocked.length}</b> Einsatztyp(en)`;
            if (!rows.length) { $list.innerHTML = '<div style="color:#a6e3a1;padding:8px;">Alle Einsatztypen sind freigeschaltet. 🎉</div>'; return; }
            let html = '';
            for (const r of rows) {
                html += `<div style="padding:6px 4px;border-bottom:1px solid #313244;">
                    <div style="display:flex;justify-content:space-between;align-items:baseline;">
                        <b>${r.label}</b>
                        <span style="color:#f38ba8;white-space:nowrap;">+${r.missing} bauen</span>
                    </div>
                    <div style="font-size:11px;color:#9399b2;">schaltet ${r.count} Einsatztyp(en) frei</div>
                </div>`;
            }
            $list.innerHTML = html;
        } else {
            // Pro Einsatztyp
            $status.innerHTML = `<b style="color:#f9e2af;">${blocked.length}</b> Einsatztyp(en) noch gesperrt`;
            if (!blocked.length) { $list.innerHTML = '<div style="color:#a6e3a1;padding:8px;">Alle Einsatztypen sind freigeschaltet. 🎉</div>'; return; }
            let html = '';
            for (const m of blocked.sort((a, b) => a.name.localeCompare(b.name, 'de'))) {
                const parts = m.unmet.map(r => `<span style="color:#f38ba8;">${r.label}${r.missing ? ` <b>(+${r.missing})</b>` : ''}</span>`).join(', ');
                html += `<div style="padding:5px 4px;border-bottom:1px solid #313244;">
                    <b>${m.name}</b>
                    <div style="font-size:11px;">fehlt: ${parts}</div>
                </div>`;
            }
            $list.innerHTML = html;
        }
    }

    let running = false;
    async function scan(panel) {
        if (running) return;
        running = true;
        const $status = panel.querySelector('#ev-status');
        try {
            $status.innerHTML = 'Lade Einsatz-Übersicht (Seite 1)…';
            lastData = await loadAllMissions((p, last) => {
                $status.innerHTML = `Lade Einsatz-Übersicht… <b>Seite ${p}/${last}</b>`;
            });
            render(panel);
        } catch (e) {
            $status.innerHTML = `<span style="color:#f38ba8;">Fehler: ${e.message}</span>`;
        } finally { running = false; }
    }

    function buildPanel() {
        let panel = document.getElementById('ev-panel');
        if (panel) { panel.remove(); return; }
        panel = document.createElement('div');
        panel.id = 'ev-panel';
        panel.style.cssText = 'position:fixed;top:150px;right:20px;z-index:99999;width:440px;max-height:82vh;display:flex;flex-direction:column;background:#1e1e2e;color:#cdd6f4;border:1px solid #45475a;border-radius:10px;padding:14px;font:13px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);';
        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <b style="font-size:14px;">🏗️ Einsatz-Voraussetzungen</b>
                <div>
                    <button id="ev-view" title="Ansicht: Gesamtbedarf / pro Einsatztyp" style="background:#89b4fa;border:none;border-radius:4px;color:#1e1e2e;cursor:pointer;font-size:13px;padding:2px 7px;font-weight:600;">📊 Gesamt</button>
                    <button id="ev-scan" title="Einsatz-Übersicht auslesen" style="background:none;border:1px solid #45475a;border-radius:4px;color:#cdd6f4;cursor:pointer;font-size:13px;padding:2px 7px;">⟳ Prüfen</button>
                    <button id="ev-close" style="background:none;border:none;color:#cdd6f4;cursor:pointer;font-size:16px;">✕</button>
                </div>
            </div>
            <div id="ev-status" style="margin-bottom:6px;font-size:12px;">Bereit – „⟳ Prüfen" liest die Einsatz-Übersicht.</div>
            <div id="ev-list" style="overflow:auto;flex:1;"></div>
            <div style="color:#9399b2;font-size:10px;margin-top:8px;">Quelle: /einsaetze. „+N bauen" = so viele fehlen noch. Gesamt-Ansicht bündelt, pro-Einsatztyp-Ansicht zeigt Details.</div>
        `;
        document.body.appendChild(panel);
        panel.querySelector('#ev-close').onclick = () => panel.remove();
        panel.querySelector('#ev-scan').onclick = () => scan(panel);
        const vbtn = panel.querySelector('#ev-view');
        const paintView = () => {
            vbtn.textContent = viewMode === 'summary' ? '📊 Gesamt' : '📋 Pro Einsatz';
        };
        vbtn.onclick = () => { viewMode = viewMode === 'summary' ? 'byMission' : 'summary'; paintView(); render(panel); };
        paintView();
        // Wenn schon Daten da sind (z.B. erneutes Öffnen), direkt zeigen
        render(panel);
    }

    ensureToolsMenu().add('ev-openbtn', '🏗️ Einsatz-Voraussetzungen', () => buildPanel(), 50);
})();
