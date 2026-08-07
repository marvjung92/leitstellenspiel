// ==UserScript==
// @name         LSS Zellen-Übersicht (Polizeiwachen)
// @namespace    http://tampermonkey.net/
// @version      1.10
// @downloadURL  https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-zellen-uebersicht.user.js
// @updateURL    https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-zellen-uebersicht.user.js
// @description  Zeigt pro Wache die Erweiterungen (Polizei, Feuerwehr, THW, BePol, SEG, Krankenhaus). Polizei zusätzlich mit Zellen-Zählung. Update-Filter blendet Wachen aus, die eine gewählte Erweiterung schon haben. Aus /api/buildings + Wachenseite.
// @match        https://www.leitstellenspiel.de/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';
    if (window.top !== window.self) return;

    const CONFIG = {
        maxCellsPerStation: 10,
    };
    const BUILDING_TYPES = {
        police: { id: 6, label: '🚔 Polizei', icon: '🚔' },
        fire:   { id: 0, label: '🚒 Feuerwehr', icon: '🚒' },
        thw:    { id: 9, label: '🔧 THW', icon: '🔧' },
        bepol:  { id: 11, label: '👮 BePol', icon: '👮' },
        seg:    { id: 12, label: '🚑 SEG', icon: '🚑' },
        kh:     { id: 4, label: '🏥 Krankenhaus', icon: '🏥' },
    };
    let activeType = 'police';

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

    // Update-Filter-Cache: buildingId -> Map(Erweiterungsname -> 'not_built' | 'building' | 'built').
    // Wird beim Laden einer Wachen-Detailseite nebenbei mitbefüllt (kein Extra-Request).
    let statusByStation = {};

    // Erweiterungs-Zeilen der Detailseite finden. Verlässlicher Anker (per HAR verifiziert):
    // jede Erweiterungszeile hat im ERSTEN <td> direkt ein <b>Name</b>, gefolgt vom Beschreibungs-<div>.
    // Das ist der einzige Ort, an dem der Name OHNE Beschreibungstext steht.
    function collectExtensionRows(doc) {
        const rows = [];
        for (const tr of doc.querySelectorAll('tr')) {
            const firstTd = tr.querySelector(':scope > td:first-child');
            const b = firstTd ? firstTd.querySelector(':scope > b') : null;
            if (!b) continue;
            const name = b.textContent.replace(/\s+/g, ' ').trim();
            if (!name) continue;
            rows.push({ tr, name });
        }
        return rows;
    }

    // Status einer Erweiterungszeile aus der letzten Tabellenspalte ableiten (Beleg: HAR-Analyse
    // /buildings/<id>): Kauf-Link = noch nicht gebaut, Restzeit-Timer = im Bau, sonst gebaut
    // (z.B. "Nicht einsatzbereit"-Label oder bereits fertig & einsatzbereit ohne weiteren Hinweis).
    function deriveExtStatus(tr) {
        const tds = tr.querySelectorAll('td');
        const lastTd = tds[tds.length - 1];
        if (!lastTd) return 'built';
        if (lastTd.querySelector('a[href*="/extension/credits/"], a[href*="/extension/coins/"]')) return 'not_built';
        if (lastTd.querySelector('.extension-timer') || /Restzeit/i.test(lastTd.textContent)) return 'building';
        return 'built';
    }

    // Erweiterungen einer Wache von ihrer Detailseite lesen (/buildings/<id>).
    // Nur der credits-Kauf wird angeboten (coins gesperrt). Liefert je baubarer Erweiterung Name,
    // type_id und Preis (Credits). Befüllt nebenbei statusByStation[buildingId] für den Update-Filter.
    async function loadExtensions(buildingId) {
        const res = await fetch(`/buildings/${buildingId}`, { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) throw new Error(`/buildings/${buildingId} HTTP ${res.status}`);
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const exts = [];
        const statusMap = new Map();
        for (const { tr, name } of collectExtensionRows(doc)) {
            const status = deriveExtStatus(tr);
            statusMap.set(name, status);
            if (status !== 'not_built') continue; // nur baubare Erweiterungen in die Kauf-Liste
            const link = tr.querySelector('a[href*="/extension/credits/"]');
            if (!link) continue;
            const m = (link.getAttribute('href') || '').match(/\/extension\/credits\/(\d+)/);
            if (!m) continue;
            const typeId = parseInt(m[1], 10);
            const linkTxt = (link.textContent || '').replace(/\s+/g, ' ').trim(); // z.B. "200.000 Credits"
            const priceNum = /credits/i.test(linkTxt) ? parseInt(linkTxt.replace(/[^\d]/g, ''), 10) : null;
            const priceTxt = priceNum ? priceNum.toLocaleString('de-DE') + ' Credits' : (linkTxt || 'bauen');
            exts.push({ typeId, name, priceTxt, priceNum });
        }
        statusByStation[buildingId] = statusMap;
        return exts;
    }

    // Alle (noch ungeprüften) Wachen des aktuellen Typs nacheinander abfragen, um statusByStation
    // für den Update-Filter zu befüllen. Mit Fortschrittsanzeige, einzelne Fehler werden übersprungen.
    async function loadAllStatuses(panel) {
        const $status = panel.querySelector('#zl-status');
        const stations = lastData || [];
        const todo = stations.filter(s => !statusByStation[s.id]);
        for (let i = 0; i < todo.length; i++) {
            const s = todo[i];
            $status.innerHTML = `Prüfe Update-Status… <b>${i + 1}/${todo.length}</b> – ${s.name}`;
            try { await loadExtensions(s.id); } catch (e) { /* einzelne Wache überspringen, Rest weiterlaufen lassen */ }
        }
        populateFilterOptions(panel);
        render(panel);
    }

    // Filter-Dropdown mit allen bisher bekannten Erweiterungsnamen (aus dem Status-Cache) befüllen.
    function populateFilterOptions(panel) {
        const sel = panel.querySelector('#zl-filter-select');
        if (!sel) return;
        const names = new Set();
        for (const s of (lastData || [])) {
            const m = statusByStation[s.id];
            if (m) for (const n of m.keys()) names.add(n);
        }
        const prev = sel.value;
        const sorted = [...names].sort((a, b) => a.localeCompare(b, 'de'));
        sel.innerHTML = '<option value="">— kein Filter —</option>' +
            sorted.map(n => `<option value="${n.replace(/"/g, '&quot;')}">${n}</option>`).join('');
        if (sorted.includes(prev)) sel.value = prev;
    }

    // Eine Erweiterung mit CREDITS bauen (coins gesperrt). Beleg (HAR):
    // POST /buildings/<id>/extension/credits/<typeId>?redirect_building_id=<id>, Body _method=post + Token.
    async function buildExtension(buildingId, typeId) {
        const url = `/buildings/${buildingId}/extension/credits/${typeId}?redirect_building_id=${buildingId}`;
        const body = new URLSearchParams();
        body.set('_method', 'post');
        body.set('authenticity_token', csrfToken());
        const res = await fetch(url, {
            method: 'POST', credentials: 'same-origin', redirect: 'manual',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
            body: body.toString(),
        });
        return res.status === 302 || res.ok || res.status === 0;
    }

    let lastData = null;

    async function scan(panel) {
        const $status = panel.querySelector('#zl-status');
        try {
            $status.innerHTML = 'Lade Gebäude…';
            const all = await loadBuildings();
            // building_type 6 = Polizeiwache (aus deinem API-Objekt bestätigt)
            rawById = {};
            const wantType = BUILDING_TYPES[activeType].id;
            const stations = all.filter(b => Number(b.building_type) === wantType).map(b => {
                rawById[String(b.id)] = b;
                const c = activeType === 'police' ? countCells(b) : { ready: 0, building: 0, free: 0 };
                return { id: String(b.id), name: b.caption || `#${b.id}`, ...c };
            });
            lastData = stations;
            populateFilterOptions(panel);
            render(panel);
        } catch (e) {
            $status.innerHTML = `<span style="color:#f38ba8;">Fehler: ${e.message}</span>`;
        }
    }

    function render(panel) {
        const $status = panel.querySelector('#zl-status');
        const $list = panel.querySelector('#zl-list');
        if (!lastData) { $status.innerHTML = 'Bereit – „⟳ Prüfen" liest die Polizeiwachen.'; $list.innerHTML = ''; return; }
        if (!lastData.length) { $status.innerHTML = `<b>0</b> ${BUILDING_TYPES[activeType].label}-Wachen.`; $list.innerHTML = `<div style="color:#9399b2;padding:8px;">Keine ${BUILDING_TYPES[activeType].label}-Wachen gefunden.</div>`; return; }

        const filterName = panel.querySelector('#zl-filter-select')?.value || '';
        const hideBuilding = panel.querySelector('#zl-filter-building')?.checked ?? true;
        let rows = [...lastData].sort((a, b) => a.name.localeCompare(b.name, 'de'));
        let hiddenCount = 0;
        if (filterName) {
            rows = rows.filter(s => {
                const st = statusByStation[s.id]?.get(filterName);
                if (!st) return true; // Status dieser Wache noch nicht geprüft -> sichtbar lassen
                const has = st === 'built' || (hideBuilding && st === 'building');
                if (has) hiddenCount++;
                return !has;
            });
        }

        $status.innerHTML = filterName
            ? `<b>${rows.length}</b> von <b>${lastData.length}</b> ${BUILDING_TYPES[activeType].label}-Wachen ohne „${filterName}"${hiddenCount ? ` (<b>${hiddenCount}</b> ausgeblendet)` : ''}.`
            : `<b>${lastData.length}</b> ${BUILDING_TYPES[activeType].label}-Wachen. Klick auf eine Wache lädt ihre Erweiterungen.`;
        if (!rows.length) { $list.innerHTML = `<div style="color:#9399b2;padding:8px;">Alle Wachen haben „${filterName}" bereits (oder im Bau).</div>`; return; }
        let html = '';
        for (const s of rows) {
            html += `<div class="zl-station" data-id="${s.id}" style="padding:6px 4px;border-bottom:1px solid #313244;">
                <div class="zl-head" style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;">
                    <b style="color:#cdd6f4;">▶ ${s.name}</b>
                    ${activeType === 'police' ? `<span style="font-size:11px;color:#9399b2;">Zellen ${s.ready}/${CONFIG.maxCellsPerStation}${s.building ? ` (+${s.building})` : ''}</span>` : ''}
                </div>
                <div class="zl-exts" style="display:none;margin-top:6px;padding-left:10px;"></div>
            </div>`;
        }
        $list.innerHTML = html;
        // Aufklapp-Logik: beim ersten Öffnen die Erweiterungen der Wache laden
        for (const st of $list.querySelectorAll('.zl-station')) {
            const id = st.getAttribute('data-id');
            const head = st.querySelector('.zl-head');
            const box = st.querySelector('.zl-exts');
            head.onclick = async () => {
                const open = box.style.display !== 'none';
                if (open) { box.style.display = 'none'; head.querySelector('b').textContent = head.querySelector('b').textContent.replace('▼', '▶'); return; }
                box.style.display = 'block';
                head.querySelector('b').textContent = head.querySelector('b').textContent.replace('▶', '▼');
                if (box.getAttribute('data-loaded')) return;
                box.innerHTML = '<span style="color:#9399b2;font-size:11px;">lade Erweiterungen…</span>';
                try {
                    const allExts = await loadExtensions(id);
                    box.setAttribute('data-loaded', '1');
                    // Bei aktivem Update-Filter nur die gefilterte Erweiterung zeigen, nicht alle
                    // fehlenden – der Filter fragt ja gezielt nach genau dieser einen.
                    const activeFilter = panel.querySelector('#zl-filter-select')?.value || '';
                    const exts = activeFilter ? allExts.filter(e => e.name === activeFilter) : allExts;
                    if (!exts.length) {
                        box.innerHTML = activeFilter
                            ? `<span style="color:#9399b2;font-size:11px;">„${activeFilter}" ist hier nicht (mehr) baubar.</span>`
                            : '<span style="color:#9399b2;font-size:11px;">Keine baubaren Erweiterungen (alles ausgebaut).</span>';
                        return;
                    }
                    box.innerHTML = exts.map(e => `
                        <div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;">
                            <span style="font-size:12px;">${e.name}</span>
                            <button class="zl-buildext" data-bid="${id}" data-tid="${e.typeId}" title="Mit Credits bauen"
                                style="background:#a6e3a1;color:#1e1e2e;border:none;border-radius:4px;font-size:11px;font-weight:600;padding:3px 8px;cursor:pointer;white-space:nowrap;">
                                ${e.priceTxt || 'bauen'}
                            </button>
                        </div>`).join('');
                    // Bau-Buttons verdrahten (Ein-Klick, Credits, keine Bestätigung)
                    for (const bb of box.querySelectorAll('.zl-buildext')) {
                        bb.onclick = async () => {
                            const bid = bb.getAttribute('data-bid'), tid = parseInt(bb.getAttribute('data-tid'), 10);
                            bb.disabled = true; const old = bb.textContent; bb.textContent = '…';
                            try {
                                const ok = await buildExtension(bid, tid);
                                if (ok) { bb.textContent = '✓ im Bau'; bb.style.background = '#f9e2af'; }
                                else { bb.disabled = false; bb.textContent = old; alert('Bau fehlgeschlagen – zu wenig Credits oder nicht baubar.'); }
                            } catch (err) { bb.disabled = false; bb.textContent = old; alert('Fehler: ' + err.message); }
                        };
                    }
                } catch (e) { box.innerHTML = `<span style="color:#f38ba8;font-size:11px;">Fehler: ${e.message}</span>`; }
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
                <b style="font-size:14px;">🏗️ Gebäude-Erweiterungen</b>
                <div>
                    <button id="zl-scan" title="Polizeiwachen prüfen" style="background:none;border:1px solid #45475a;border-radius:4px;color:#cdd6f4;cursor:pointer;font-size:13px;padding:2px 7px;">⟳ Prüfen</button>
                    <button id="zl-close" style="background:none;border:none;color:#cdd6f4;cursor:pointer;font-size:16px;">✕</button>
                </div>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
                <button class="zl-type" data-t="police" style="flex:1 1 30%;padding:6px;border:none;border-radius:6px;font-weight:600;cursor:pointer;font-size:12px;background:#89b4fa;color:#1e1e2e;">🚔 Polizei</button>
                <button class="zl-type" data-t="fire" style="flex:1 1 30%;padding:6px;border:none;border-radius:6px;font-weight:600;cursor:pointer;font-size:12px;background:#45475a;color:#cdd6f4;">🚒 Feuerwehr</button>
                <button class="zl-type" data-t="thw" style="flex:1 1 30%;padding:6px;border:none;border-radius:6px;font-weight:600;cursor:pointer;font-size:12px;background:#45475a;color:#cdd6f4;">🔧 THW</button>
                <button class="zl-type" data-t="bepol" style="flex:1 1 30%;padding:6px;border:none;border-radius:6px;font-weight:600;cursor:pointer;font-size:12px;background:#45475a;color:#cdd6f4;">👮 BePol</button>
                <button class="zl-type" data-t="seg" style="flex:1 1 30%;padding:6px;border:none;border-radius:6px;font-weight:600;cursor:pointer;font-size:12px;background:#45475a;color:#cdd6f4;">🚑 SEG</button>
                <button class="zl-type" data-t="kh" style="flex:1 1 30%;padding:6px;border:none;border-radius:6px;font-weight:600;cursor:pointer;font-size:12px;background:#45475a;color:#cdd6f4;">🏥 Krankenhaus</button>
            </div>
            <div style="display:flex;gap:6px;margin-bottom:4px;align-items:center;">
                <select id="zl-filter-select" title="Nur Wachen OHNE diese Erweiterung anzeigen" style="flex:1;background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:4px;font-size:11px;padding:4px;">
                    <option value="">— kein Update-Filter —</option>
                </select>
                <button id="zl-filter-load" title="Update-Status aller Wachen laden (ein Request je Wache)" style="background:none;border:1px solid #45475a;border-radius:4px;color:#cdd6f4;cursor:pointer;font-size:11px;padding:4px 7px;white-space:nowrap;">🔎 Status laden</button>
            </div>
            <label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#9399b2;margin-bottom:6px;">
                <input type="checkbox" id="zl-filter-building" checked> auch „im Bau" ausblenden
            </label>
            <div id="zl-status" style="margin-bottom:6px;font-size:12px;">Bereit – „⟳ Prüfen" liest die Wachen.</div>
            <div id="zl-list" style="overflow:auto;flex:1;"></div>
            <div style="color:#9399b2;font-size:10px;margin-top:8px;">Klick auf eine Wache zeigt ihre Erweiterungen mit Preis. Bauen erfolgt mit CREDITS (Coins gesperrt), ohne Rückfrage. Update-Filter: „🔎 Status laden" prüft jede Wache einmal und merkt sich das Ergebnis. Quelle: /api/buildings + Wachenseite.</div>
        `;
        document.body.appendChild(panel);
        panel.querySelector('#zl-close').onclick = () => panel.remove();
        panel.querySelector('#zl-scan').onclick = () => scan(panel);
        panel.querySelector('#zl-filter-load').onclick = () => loadAllStatuses(panel);
        panel.querySelector('#zl-filter-select').onchange = () => render(panel);
        panel.querySelector('#zl-filter-building').onchange = () => render(panel);
        for (const tb of panel.querySelectorAll('.zl-type')) {
            tb.onclick = () => {
                activeType = tb.getAttribute('data-t');
                for (const b of panel.querySelectorAll('.zl-type')) { b.style.background = '#45475a'; b.style.color = '#cdd6f4'; }
                tb.style.background = '#89b4fa'; tb.style.color = '#1e1e2e';
                lastData = null;
                panel.querySelector('#zl-filter-select').value = '';
                scan(panel);
            };
        }
        render(panel);
    }

    ensureToolsMenu().add('zl-openbtn', '🏗️ Gebäude-Erweiterungen', () => buildPanel(), 60);
})();
