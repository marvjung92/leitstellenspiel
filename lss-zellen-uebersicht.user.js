// ==UserScript==
// @name         LSS Zellen-Übersicht (Polizeiwachen)
// @namespace    http://tampermonkey.net/
// @version      1.01
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

    function csrfToken() {
        return document.querySelector('meta[name="csrf-token"]')?.content || '';
    }

    // Nächste freie type_id einer Wache bestimmen: kleinste 0..max-1, die noch keine Zelle-Extension hat.
    function nextCellTypeId(b) {
        const used = new Set();
        for (const ext of (b.extensions || [])) if (/zelle/i.test(ext.caption || '')) used.add(Number(ext.type_id));
        for (let i = 0; i < CONFIG.maxCellsPerStation; i++) if (!used.has(i)) return i;
        return null; // alle belegt
    }

    // Eine Zelle bauen. Beleg (HAR): POST /buildings/<id>/extension/credits/<typeId>?redirect_building_id=<id>
    // mit Body _method=post & authenticity_token. Kauf mit Credits. Erfolg = 302.
    async function buildCell(buildingId, typeId) {
        const url = `/buildings/${buildingId}/extension/credits/${typeId}?redirect_building_id=${buildingId}`;
        const body = new URLSearchParams();
        body.set('_method', 'post');
        body.set('authenticity_token', csrfToken());
        const res = await fetch(url, {
            method: 'POST', credentials: 'same-origin', redirect: 'manual',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
            body: body.toString(),
        });
        // 302 (Redirect) oder ok = Erfolg. Bei opaqueredirect (redirect:manual) ist status 0 -> auch ok.
        return res.status === 302 || res.ok || res.status === 0;
    }

    // Rohdaten der Gebäude behalten, damit wir extensions/type_id fürs Bauen zur Hand haben.
    let rawById = {};

    let lastData = null;

    async function scan(panel) {
        const $status = panel.querySelector('#zl-status');
        try {
            $status.innerHTML = 'Lade Gebäude…';
            const all = await loadBuildings();
            // building_type 6 = Polizeiwache (aus deinem API-Objekt bestätigt)
            rawById = {};
            const stations = all.filter(b => Number(b.building_type) === 6).map(b => {
                rawById[String(b.id)] = b;
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
            const canBuild = s.free > 0;
            html += `<div style="padding:6px 4px;border-bottom:1px solid #313244;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <a href="/buildings/${s.id}" style="color:#cdd6f4;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${s.name}</a>
                    <span style="font-size:12px;white-space:nowrap;margin:0 8px;"><b style="color:#a6e3a1;">${s.ready}</b><span style="color:#9399b2;">/${CONFIG.maxCellsPerStation}</span>${s.building ? ` <span style="color:#f9e2af;">(+${s.building})</span>` : ''}</span>
                    ${canBuild ? `<button class="zl-build" data-id="${s.id}" title="Eine Zelle mit Credits bauen" style="background:#a6e3a1;color:#1e1e2e;border:none;border-radius:4px;font-size:11px;font-weight:600;padding:3px 7px;cursor:pointer;white-space:nowrap;">+1 Zelle</button>` : `<span style="font-size:11px;color:#9399b2;white-space:nowrap;">voll</span>`}
                </div>
                <div style="margin-top:3px;">${bar.join('')}</div>
            </div>`;
        }
        $list.innerHTML = html;
        // Bau-Buttons verdrahten
        for (const btn of $list.querySelectorAll('.zl-build')) {
            btn.onclick = async () => {
                const id = btn.getAttribute('data-id');
                const b = rawById[id];
                if (!b) return;
                const typeId = nextCellTypeId(b);
                if (typeId == null) { btn.textContent = 'voll'; return; }
                if (!confirm(`In "${b.caption || id}" eine Zelle mit Credits bauen?`)) return;
                btn.disabled = true; btn.textContent = '…';
                try {
                    const ok = await buildCell(id, typeId);
                    if (ok) {
                        // lokalen Zustand aktualisieren: als "im Bau" markieren, dann neu rendern
                        b.extensions = b.extensions || [];
                        b.extensions.push({ caption: 'Zelle', available: false, type_id: typeId });
                        const st = lastData.find(x => x.id === id);
                        if (st) { const c = countCells(b); st.ready = c.ready; st.building = c.building; st.free = c.free; }
                        render(panel);
                    } else {
                        btn.disabled = false; btn.textContent = '+1 Zelle';
                        alert('Bau fehlgeschlagen – vermutlich zu wenig Credits oder Maximum erreicht.');
                    }
                } catch (e) {
                    btn.disabled = false; btn.textContent = '+1 Zelle';
                    alert('Fehler beim Bauen: ' + e.message);
                }
            };
        }
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
