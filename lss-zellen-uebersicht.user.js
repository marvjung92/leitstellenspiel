// ==UserScript==
// @name         LSS Zellen-Übersicht (Polizeiwachen)
// @namespace    http://tampermonkey.net/
// @version      1.07
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
        maxCellsPerStation: 10,
    };
    const BUILDING_TYPES = {
        police: { id: 6, label: '🚔 Polizei', icon: '🚔' },
        fire:   { id: 0, label: '🚒 Feuerwehr', icon: '🚒' },
        thw:    { id: 9, label: '🔧 THW', icon: '🔧' },
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


    // Erweiterungen einer Polizeiwache von ihrer Detailseite lesen (/buildings/<id>).
    // Nur der credits-Kauf wird angeboten (coins gesperrt). Liefert je Erweiterung Name, type_id,
    // Preis (Credits) und ob sie bereits gebaut/ausgebaut ist.
    async function loadExtensions(buildingId) {
        const res = await fetch(`/buildings/${buildingId}`, { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) throw new Error(`/buildings/${buildingId} HTTP ${res.status}`);
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const exts = [];
        const seen = new Set();
        // Der Preis steht DIREKT im Link-Text: <a href=".../extension/credits/N">75.000 Credits</a>.
        // Das ist der zuverlässige Anker. Coins-Links (.../coins/N) werden bewusst ignoriert.
        for (const a of doc.querySelectorAll('a[href*="/extension/credits/"]')) {
            const m = (a.getAttribute('href') || '').match(/\/extension\/credits\/(\d+)/);
            if (!m) continue;
            const typeId = parseInt(m[1], 10);
            if (seen.has(typeId)) continue;
            seen.add(typeId);
            const linkTxt = (a.textContent || '').replace(/\s+/g, ' ').trim(); // z.B. "75.000 Credits"
            const priceNum = /credits/i.test(linkTxt) ? parseInt(linkTxt.replace(/[^\d]/g, ''), 10) : null;
            const priceTxt = priceNum ? priceNum.toLocaleString('de-DE') + ' Credits' : (linkTxt || 'bauen');
            // Namen aus dem Zeilen-/Zellenkontext holen: nächstgelegene Tabellenzeile oder Überschrift.
            let name = '';
            const tr = a.closest('tr');
            if (tr) {
                const cellTxt = tr.textContent.replace(/\s+/g, ' ').trim();
                const known = cellTxt.match(/(Zelle|Diensthundestaffel|Diensthundstaffel|Motorradstaffel|Großwache|Großgewahrsam|Reiterstaffel|SEK|Wasserschutzpolizei|Rettungswache|Löschzug|Stellplatz[^,]*|Schlauchwagen|AB-[A-Za-zÄÖÜ/]+|Anh [A-Za-zÄÖÜ]+|Fachgruppe[^,]*|Zugtrupp|Notversorgung|Brückenbau|Räumen|Ortung|Wassergefahren|Bergung|Führung[^,]*|Logistik[^,]*)/);
                if (known) name = known[1].trim();
                // sonst: erste Tabellenzelle (oft der Erweiterungsname)
                if (!name) { const td = tr.querySelector('td'); if (td) name = td.textContent.replace(/\s+/g, ' ').trim().slice(0, 40); }
            }
            if (!name) {
                // Fallback: bekannter Name irgendwo im 400-Zeichen-Fenster vor dem Link
                const idx = html.indexOf(a.getAttribute('href'));
                const before = idx > 0 ? html.slice(Math.max(0, idx - 500), idx).replace(/<[^>]+>/g, ' ') : '';
                const known = before.match(/(Zelle|Diensthundestaffel|Diensthundstaffel|Motorradstaffel|Großwache|Großgewahrsam|Reiterstaffel|SEK|Wasserschutzpolizei)(?![\s\S]*\1)/);
                name = known ? known[1] : `Erweiterung ${typeId}`;
            }
            const builtM = (a.closest('tr')?.textContent || '').match(/Gebaut\s*(\d+)\s*\/\s*(\d+)/i);
            const builtInfo = builtM ? `${builtM[1]}/${builtM[2]}` : '';
            exts.push({ typeId, name, priceTxt, priceNum, builtInfo });
        }
        return exts;
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
            render(panel);
        } catch (e) {
            $status.innerHTML = `<span style="color:#f38ba8;">Fehler: ${e.message}</span>`;
        }
    }

    function render(panel) {
        const $status = panel.querySelector('#zl-status');
        const $list = panel.querySelector('#zl-list');
        if (!lastData) { $status.innerHTML = 'Bereit – „⟳ Prüfen" liest die Polizeiwachen.'; $list.innerHTML = ''; return; }
        $status.innerHTML = `<b>${lastData.length}</b> ${BUILDING_TYPES[activeType].label}-Wachen. Klick auf eine Wache lädt ihre Erweiterungen.`;
        if (!lastData.length) { $list.innerHTML = `<div style="color:#9399b2;padding:8px;">Keine ${BUILDING_TYPES[activeType].label}-Wachen gefunden.</div>`; return; }
        const rows = [...lastData].sort((a, b) => a.name.localeCompare(b.name, 'de'));
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
                    const exts = await loadExtensions(id);
                    box.setAttribute('data-loaded', '1');
                    if (!exts.length) { box.innerHTML = '<span style="color:#9399b2;font-size:11px;">Keine baubaren Erweiterungen (alles ausgebaut).</span>'; return; }
                    box.innerHTML = exts.map(e => `
                        <div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;">
                            <span style="font-size:12px;">${e.name}${e.builtInfo ? ` <span style="color:#9399b2;">${e.builtInfo}</span>` : ''}</span>
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
            <div style="display:flex;gap:6px;margin-bottom:8px;">
                <button class="zl-type" data-t="police" style="flex:1;padding:6px;border:none;border-radius:6px;font-weight:600;cursor:pointer;font-size:12px;background:#89b4fa;color:#1e1e2e;">🚔 Polizei</button>
                <button class="zl-type" data-t="fire" style="flex:1;padding:6px;border:none;border-radius:6px;font-weight:600;cursor:pointer;font-size:12px;background:#45475a;color:#cdd6f4;">🚒 Feuerwehr</button>
                <button class="zl-type" data-t="thw" style="flex:1;padding:6px;border:none;border-radius:6px;font-weight:600;cursor:pointer;font-size:12px;background:#45475a;color:#cdd6f4;">🔧 THW</button>
            </div>
            <div id="zl-status" style="margin-bottom:6px;font-size:12px;">Bereit – „⟳ Prüfen" liest die Wachen.</div>
            <div id="zl-list" style="overflow:auto;flex:1;"></div>
            <div style="color:#9399b2;font-size:10px;margin-top:8px;">Klick auf eine Wache zeigt ihre Erweiterungen mit Preis. Bauen erfolgt mit CREDITS (Coins gesperrt), ohne Rückfrage. Quelle: /api/buildings + Wachenseite.</div>
        `;
        document.body.appendChild(panel);
        panel.querySelector('#zl-close').onclick = () => panel.remove();
        panel.querySelector('#zl-scan').onclick = () => scan(panel);
        for (const tb of panel.querySelectorAll('.zl-type')) {
            tb.onclick = () => {
                activeType = tb.getAttribute('data-t');
                for (const b of panel.querySelectorAll('.zl-type')) { b.style.background = '#45475a'; b.style.color = '#cdd6f4'; }
                tb.style.background = '#89b4fa'; tb.style.color = '#1e1e2e';
                lastData = null;
                scan(panel);
            };
        }
        render(panel);
    }

    ensureToolsMenu().add('zl-openbtn', '🏗️ Gebäude-Erweiterungen', () => buildPanel(), 60);
})();
