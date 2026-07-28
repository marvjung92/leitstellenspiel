// ==UserScript==
// @name         LSS Zellen-Übersicht (Polizeiwachen)
// @namespace    http://tampermonkey.net/
// @version      1.00
// @downloadURL  https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-zellen-uebersicht.user.js
// @updateURL    https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-zellen-uebersicht.user.js
// @description  Zeigt pro Polizeiwache die Zellen: fertig, im Bau und frei (bis Maximum). Aus /api/buildings, ein schneller Abruf. Modular für weitere Gebäudetypen erweiterbar.
// @match        https://www.leitstellenspiel.de/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';
    if (window.top !== window.self) return;

    const CONFIG = {
        maxCellsPerStation: 10,   // maximal ausbaubare Zellen pro Polizeiwache (steht nicht in der API)
    };

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
                const openMenu = (rect) => {
                    const menu = document.getElementById('lss-tools-dropdown');
                    if (!menu) return;
                    const show = menu.style.display === 'none' || !menu.style.display;
                    menu.style.display = show ? 'block' : 'none';
                    if (show && rect) { menu.style.top = (rect.bottom + 4) + 'px'; menu.style.right = Math.max(8, window.innerWidth - rect.right) + 'px'; }
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

    // Alle Gebäude laden (paginiert absichern).
    async function loadBuildings() {
        const all = [];
        const seen = new Set();
        const scan = (arr) => { for (const b of arr) if (!seen.has(b.id)) { seen.add(b.id); all.push(b); } };
        const res = await fetch('/api/buildings', { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) throw new Error(`/api/buildings HTTP ${res.status}`);
        const first = await res.json();
        if (Array.isArray(first)) {
            scan(first);
            const ps = first.length;
            if (ps >= 100) for (let off = ps; off < 50000; off += ps) {
                const r = await fetch(`/api/buildings?limit=${ps}&offset=${off}`, { credentials: 'same-origin', cache: 'no-store' });
                if (!r.ok) break; const pg = await r.json(); if (!Array.isArray(pg) || !pg.length) break; scan(pg); if (pg.length < ps) break;
            }
        } else if (first && Array.isArray(first.buildings)) scan(first.buildings);
        return all;
    }

    // Zellen einer Polizeiwache aus dem extensions-Array zählen.
    // Jede {caption:"Zelle"} ist eine Zelle. available:true = fertig, available:false = im Bau.
    function countCells(b) {
        let ready = 0, building = 0;
        for (const ext of (b.extensions || [])) {
            if (!/zelle/i.test(ext.caption || '')) continue;
            if (ext.available === true) ready++;
            else building++;
        }
        return { ready, building, free: Math.max(0, CONFIG.maxCellsPerStation - ready - building) };
    }

    let lastData = null;

    async function scan(panel) {
        const $status = panel.querySelector('#zl-status');
        try {
            $status.innerHTML = 'Lade Gebäude…';
            const all = await loadBuildings();
            // building_type 6 = Polizeiwache (aus deinem API-Objekt bestätigt)
            const stations = all.filter(b => Number(b.building_type) === 6).map(b => {
                const c = countCells(b);
                return { id: String(b.id), name: b.caption || `#${b.id}`, prisoners: Number(b.prisoner_count) || 0, ...c };
            });
            lastData = stations;
            render(panel);
        } catch (e) {
            $status.innerHTML = `<span style="color:#f38ba8;">Fehler: ${e.message}</span>`;
        }
    }

    function render(panel) {
        const $status = panel.querySelector('#zl-status');
        const $list = panel.querySelector('#zl-list');
        if (!lastData) { $status.innerHTML = 'Bereit – „⟳ Prüfen" liest die Polizeiwachen.'; $list.innerHTML = ''; return; }
        const totalReady = lastData.reduce((s, x) => s + x.ready, 0);
        const totalBuilding = lastData.reduce((s, x) => s + x.building, 0);
        const totalFree = lastData.reduce((s, x) => s + x.free, 0);
        $status.innerHTML = `<b>${lastData.length}</b> Polizeiwachen · `
            + `<span style="color:#a6e3a1;">${totalReady} Zellen fertig</span> · `
            + `<span style="color:#f9e2af;">${totalBuilding} im Bau</span> · `
            + `<span style="color:#9399b2;">${totalFree} frei (bis ${CONFIG.maxCellsPerStation}/Wache)</span>`;
        if (!lastData.length) { $list.innerHTML = '<div style="color:#9399b2;padding:8px;">Keine Polizeiwachen gefunden.</div>'; return; }
        // Sortierung: wenigste fertige Zellen zuerst (dort lohnt Ausbau am meisten)
        const rows = [...lastData].sort((a, b) => a.ready - b.ready || b.building - a.building);
        let html = '';
        for (const s of rows) {
            const bar = [];
            for (let i = 0; i < CONFIG.maxCellsPerStation; i++) {
                const col = i < s.ready ? '#a6e3a1' : (i < s.ready + s.building ? '#f9e2af' : '#45475a');
                bar.push(`<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${col};margin-right:2px;"></span>`);
            }
            html += `<div style="padding:6px 4px;border-bottom:1px solid #313244;">
                <div style="display:flex;justify-content:space-between;align-items:baseline;">
                    <a href="/buildings/${s.id}" style="color:#cdd6f4;">${s.name}</a>
                    <span style="font-size:12px;"><b style="color:#a6e3a1;">${s.ready}</b><span style="color:#9399b2;">/${CONFIG.maxCellsPerStation}</span>${s.building ? ` <span style="color:#f9e2af;">(+${s.building} im Bau)</span>` : ''}</span>
                </div>
                <div style="margin-top:3px;">${bar.join('')}</div>
            </div>`;
        }
        $list.innerHTML = html;
    }

    function buildPanel() {
        let panel = document.getElementById('zl-panel');
        if (panel) { panel.remove(); return; }
        panel = document.createElement('div');
        panel.id = 'zl-panel';
        panel.style.cssText = 'position:fixed;top:150px;right:20px;z-index:99999;width:420px;max-height:82vh;display:flex;flex-direction:column;background:#1e1e2e;color:#cdd6f4;border:1px solid #45475a;border-radius:10px;padding:14px;font:13px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);';
        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <b style="font-size:14px;">🚔 Zellen-Übersicht</b>
                <div>
                    <button id="zl-scan" title="Polizeiwachen prüfen" style="background:none;border:1px solid #45475a;border-radius:4px;color:#cdd6f4;cursor:pointer;font-size:13px;padding:2px 7px;">⟳ Prüfen</button>
                    <button id="zl-close" style="background:none;border:none;color:#cdd6f4;cursor:pointer;font-size:16px;">✕</button>
                </div>
            </div>
            <div id="zl-status" style="margin-bottom:6px;font-size:12px;">Bereit – „⟳ Prüfen" liest die Polizeiwachen.</div>
            <div id="zl-list" style="overflow:auto;flex:1;"></div>
            <div style="color:#9399b2;font-size:10px;margin-top:8px;">🟩 fertig · 🟨 im Bau · ⬜ frei (Max ${CONFIG.maxCellsPerStation}/Wache). Quelle: /api/buildings. Klick öffnet die Wache.</div>
        `;
        document.body.appendChild(panel);
        panel.querySelector('#zl-close').onclick = () => panel.remove();
        panel.querySelector('#zl-scan').onclick = () => scan(panel);
        render(panel);
    }

    ensureToolsMenu().add('zl-openbtn', '🚔 Zellen-Übersicht', () => buildPanel(), 60);
})();
