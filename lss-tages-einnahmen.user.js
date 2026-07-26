// ==UserScript==
// @name         LSS Tages-Einnahmen
// @namespace    http://tampermonkey.net/
// @version      1.06
// @downloadURL  https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-tages-einnahmen.user.js
// @updateURL    https://raw.githubusercontent.com/marvjung92/leitstellenspiel/main/lss-tages-einnahmen.user.js
// @description  Zeigt die heutigen Einnahmen (aus /credits/daily) dauerhaft in der Navbar an. Grün ab Tagesziel (Standard 5 Mio.), sonst rot. Tooltip mit Fortschritt, Klick öffnet die Tagesübersicht.
// @match        https://www.leitstellenspiel.de/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // Nur im Hauptfenster laufen (nicht in Iframes/Lightboxen), sonst gibt es das Badge mehrfach.
    if (window.top !== window.self) return;

    const CONFIG = {
        goal: 5_000_000,          // Tagesziel in Credits
        refreshMs: 5 * 60000,     // automatisches Update-Intervall
        colorOk: '#5cb85c',       // grün: Ziel erreicht
        colorLow: '#d9534f',      // rot: unter Ziel
        storageKey: 'te_last',    // letzter bekannter Wert (für Sofortanzeige nach Reload)
    };

    const fmt = (n) => n.toLocaleString('de-DE');

    // Heutige Einnahmen aus /credits/daily ("Tageszusammenfassung") ermitteln.
    // Struktur (verifiziert 07.07.2026): Tabelle #daily_table, eine Zeile pro Einsatztyp.
    // Erste Spalte = Credits gesamt, Betrag maschinenlesbar im sortvalue-Attribut.
    // Einnahmen-Zellen tragen die Klasse text-success, Ausgaben text-danger.
    // Achtung: ?page=N ist TAGES-Navigation (page=-1 = Vortag), keine Pagination – ohne Parameter = heute.
    async function fetchToday() {
        const res = await fetch('/credits/daily', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');

        const rows = doc.querySelectorAll('#daily_table tbody tr');
        if (!rows.length) throw new Error('Tabelle #daily_table nicht gefunden – Seitenstruktur geändert?');

        let income = 0, expense = 0, counted = 0;
        for (const tr of rows) {
            const td = tr.querySelector('td');
            if (!td) continue;
            let n = parseInt(td.getAttribute('sortvalue') ?? td.getAttribute('sortValue') ?? '', 10);
            if (!Number.isFinite(n)) { // Fallback, falls das Attribut mal fehlt: Zellentext parsen
                const m = (td.textContent || '').match(/-?[\d.]+/);
                n = m ? parseInt(m[0].replace(/\./g, ''), 10) : NaN;
                if (!Number.isFinite(n)) continue;
            }
            counted++;
            if (td.classList.contains('text-danger') || n < 0) expense += Math.abs(n);
            else income += n;
        }
        if (!counted) throw new Error('Keine auswertbaren Zeilen in #daily_table');
        console.debug(`[Tages-Einnahmen] ${counted} Zeilen: Einnahmen ${fmt(income)}, Ausgaben ${fmt(expense)}`);
        return { income, expense };
    }

    // "Geld in der Pipeline" (v1.06): Summe der geschätzten Verdienste (LSSM Ø-Credits-Spalte)
    // NUR der GRÜNEN Einsätze – also alle Anforderungen erfüllt, der Einsatz läuft nur noch ab.
    // Das ist die "sichere" Prognose: Diese Credits kommen, ohne dass noch etwas fehlt.
    function pipelineSum() {
        let sum = 0, counted = 0, open = 0, verband = 0, verbandSum = 0, noValue = 0;
        for (const panel of document.querySelectorAll('[id^="mission_panel_"]')) {
            const id = panel.id.replace('mission_panel_', '');
            if (!/^\d+$/.test(id)) continue;
            if (!panel.classList.contains('mission_panel_green')) continue; // nur grüne = fertig, läuft ab
            open++;
            const wrap = panel.querySelector('[class*="average-credits"]');
            const digits = wrap ? wrap.textContent.replace(/[^\d]/g, '') : '';
            if (!digits) { noValue++; continue; }
            const val = parseInt(digits, 10);
            sum += val; counted++;
            const capEl = document.getElementById('mission_caption_' + id);
            const isVerband = panel.classList.contains('panel-success') || /^\s*\[Verband\]/i.test(capEl ? capEl.textContent : '');
            if (isVerband) { verband++; verbandSum += val; }
        }
        return { sum, counted, open, verband, verbandSum, noValue };
    }

    function render(data, stale, err) {
        const span = document.getElementById('te-value');
        if (!span) return;
        if (data === null) {
            span.textContent = '–';
            span.style.color = '';
            const msg = err ? `Fehler: ${err.message}` : 'Tages-Einnahmen konnten nicht geladen werden';
            span.title = msg;
            const link = span.closest('a');
            if (link) link.title = msg + ' (nächster Versuch in 30 s – Details in der Konsole)';
            return;
        }
        const { income, expense } = data;
        const ok = income >= CONFIG.goal;
        const pct = Math.min(999, Math.round((income / CONFIG.goal) * 100));
        const pipe = pipelineSum();
        span.textContent = fmt(income) + (pipe.counted ? ` ⏳${fmt(pipe.sum)}` : '');
        span.style.color = ok ? CONFIG.colorOk : CONFIG.colorLow;
        span.style.fontWeight = '600';
        const link = span.closest('a');
        if (link) link.title = `Heute: ${fmt(income)} Credits Einnahmen – ${pct}% vom Tagesziel (${fmt(CONFIG.goal)})${ok ? ' ✅' : ''}`
            + (expense ? ` | Ausgaben: ${fmt(expense)} | Bilanz: ${fmt(income - expense)}` : '')
            + (pipe.counted ? ` | ⏳ sicher in der Pipeline: ~${fmt(pipe.sum)} aus ${pipe.counted} grünen Einsätzen`
                + (pipe.verband ? ` (davon ${pipe.verband} Verband: ~${fmt(pipe.verbandSum)} – real nur eigener Anteil)` : '')
                + (pipe.noValue ? ` | ${pipe.noValue} ohne Ø-Wert` : '') : '')
            + (stale ? ' [letzter bekannter Wert]' : '');
    }

    let refreshing = false;
    async function refresh() {
        if (refreshing) return;
        refreshing = true;
        const icon = document.getElementById('te-refresh-icon');
        if (icon) icon.style.opacity = '0.4';
        try {
            const v = await fetchToday();
            // Cache-Schreiben strikt vom Anzeigen trennen: Safari wirft bei localStorage
            // schnell Exceptions (privates Fenster, Datenschutz-Einstellungen) – das darf
            // die Anzeige nicht verhindern (führte auf dem Mac zu "–" trotz korrektem Fetch).
            try {
                localStorage.setItem(CONFIG.storageKey, JSON.stringify({ v, ts: Date.now(), day: new Date().toDateString() }));
            } catch (e) { /* Cache optional */ }
            render(v, false);
        } catch (e) {
            console.warn('[Tages-Einnahmen]', e);
            render(null, false, e);
            setTimeout(refresh, 30000); // transienter Fehler? in 30 s erneut versuchen
        } finally {
            if (icon) icon.style.opacity = '';
            refreshing = false;
        }
    }

    function addBadge() {
        if (document.getElementById('te-badge')) return true;
        const navUl = document.querySelector('#main_navbar #navbar-main-collapse ul.navbar-nav');
        if (!navUl) return false;
        const li = document.createElement('li');
        li.id = 'te-badge';
        li.innerHTML = `
            <a class="lightbox-open" href="/credits/daily" style="display:flex;align-items:center;gap:4px;">
                <span style="font-size:14px;">📈</span>
                <span id="te-value" style="font-variant-numeric:tabular-nums;">…</span>
                <span id="te-refresh-icon" title="Jetzt aktualisieren" style="cursor:pointer;font-size:12px;">⟳</span>
            </a>`;
        li.querySelector('#te-refresh-icon').addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.shiftKey) { // Diagnose: Shift+Klick lädt das HTML herunter, das der Fetch tatsächlich liefert
                try {
                    const res = await fetch('/credits/daily', { credentials: 'same-origin' });
                    const html = await res.text();
                    const blob = new Blob([html], { type: 'text/html' });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = 'credits_daily_fetch.html';
                    a.click();
                    URL.revokeObjectURL(a.href);
                } catch (err) { console.warn('[Tages-Einnahmen] Diagnose fehlgeschlagen', err); }
                return;
            }
            refresh();
        });
        navUl.insertBefore(li, navUl.firstChild);

        // Sofortanzeige: letzter bekannter Wert von heute (bis der Fetch durch ist)
        try {
            const last = JSON.parse(localStorage.getItem(CONFIG.storageKey) || 'null');
            if (last && last.day === new Date().toDateString() && last.v && typeof last.v === 'object') render(last.v, true);
        } catch (e) { /* egal */ }
        return true;
    }

    function start() {
        // Navbar kann beim Laden noch fehlen -> kurz pollen, dann Badge einhängen.
        let tries = 0;
        const t = setInterval(() => {
            if (addBadge() || ++tries > 40) {
                clearInterval(t);
                if (document.getElementById('te-badge')) {
                    refresh();
                    setInterval(refresh, CONFIG.refreshMs);
                    // Um Mitternacht auf den neuen Tag umschalten
                    setInterval(() => {
                        try {
                            const last = JSON.parse(localStorage.getItem(CONFIG.storageKey) || 'null');
                            if (last && last.day !== new Date().toDateString()) refresh();
                        } catch (e) { /* egal */ }
                    }, 60000);
                }
            }
        }, 500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
