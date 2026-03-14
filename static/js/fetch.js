function canUseSessionStorage() {
    try {
        return typeof window !== 'undefined' && !!window.sessionStorage;
    } catch (e) {
        return false;
    }
}

function canUseLocalStorage() {
    try {
        return typeof window !== 'undefined' && !!window.localStorage;
    } catch (e) {
        return false;
    }
}

const OLLAMA_CHUNK_PROFILE_KEY = 'ppt.ollama.chunk_profile.v1';
const OLLAMA_CHUNK_DEFAULT = 1200;
const OLLAMA_CHUNK_MIN = 600;
const OLLAMA_CHUNK_MAX = 4000;
const OLLAMA_CHUNK_STEP = 200;
const OLLAMA_CHUNK_FAST_MS = 25000;
const OLLAMA_CHUNK_SLOW_MS = 90000;
const OLLAMA_CHUNK_FAST_PER_GROUP_MS = 12000;
const OLLAMA_CHUNK_SLOW_PER_GROUP_MS = 20000;

function getPageCacheKey() {
    return `ppt.pages.${encodeURIComponent(pdfName || '')}`;
}

function restorePageCacheFromSession() {
    if (!canUseSessionStorage()) return false;
    if (!bookData || !bookData.__json_mtime) return false;
    const key = getPageCacheKey();
    let raw = null;
    try {
        raw = window.sessionStorage.getItem(key);
    } catch (e) {
        return false;
    }
    if (!raw) return false;

    try {
        const payload = JSON.parse(raw);
        if (!payload || payload.mtime !== bookData.__json_mtime) return false;
        if (!payload.pages || typeof payload.pages !== 'object') return false;
        bookData.pages = payload.pages;
        return true;
    } catch (e) {
        return false;
    }
}

function savePageCacheToSession() {
    if (!canUseSessionStorage()) return false;
    if (!bookData || !bookData.__json_mtime) return false;
    if (!bookData.pages || typeof bookData.pages !== 'object') return false;
    const key = getPageCacheKey();
    const payload = {
        mtime: bookData.__json_mtime,
        pages: bookData.pages,
    };
    try {
        window.sessionStorage.setItem(key, JSON.stringify(payload));
        return true;
    } catch (e) {
        return false;
    }
}

function clearPageCacheForSession() {
    if (!canUseSessionStorage()) return;
    const key = getPageCacheKey();
    try {
        window.sessionStorage.removeItem(key);
    } catch (e) {
        // ignore
    }
}

let urlImportPollTimer = null;
let lastUrlImportEventId = null;
let lastOpenPageSaveTimer = null;
let lastOpenPageSent = null;
let pendingUrlImportProbeTimer = null;
let urlImportExtensionState = 'unknown';

function setUrlImportExtensionState(nextState) {
    const normalized = (nextState === 'available' || nextState === 'unavailable') ? nextState : 'unknown';
    if (urlImportExtensionState === normalized) return;
    urlImportExtensionState = normalized;
    window.urlImportExtensionState = normalized;
    if (typeof updateUrlImportButtonLabel === 'function') {
        updateUrlImportButtonLabel();
    }
}

window.setUrlImportExtensionState = setUrlImportExtensionState;
window.urlImportExtensionState = urlImportExtensionState;

function showUrlImportExtensionSetupGuide() {
    alert(
        'ブラウザ拡張のセットアップが必要です。\n\n'
        + '1) Chrome/Edge で extensions ページを開く\n'
        + '   - chrome://extensions または edge://extensions\n'
        + '2) デベロッパーモードを ON\n'
        + '3) 「パッケージ化されていない拡張機能を読み込む」\n'
        + '4) tools/chrome_extension_paraparatrans を選択\n\n'
        + '詳細: docs/URL_BOOK_GUIDE.md'
    );
}

function normalizePageNumberForSave(pageNum) {
    const page = parseInt(pageNum, 10);
    if (!Number.isFinite(page) || page < 1) return null;

    const max = parseInt(bookData?.page_count, 10);
    if (Number.isFinite(max) && max > 0) {
        return Math.min(Math.max(1, page), max);
    }
    return page;
}

function sendLastOpenedPage(pageNum) {
    const normalized = normalizePageNumberForSave(pageNum);
    if (!normalized || !pdfName) return Promise.resolve(false);
    if (normalized === lastOpenPageSent) return Promise.resolve(true);

    return fetch(`/api/update_last_page/${encodePdfNamePath(pdfName)}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ page_number: normalized }),
        keepalive: true,
    })
        .then((response) => response.json().catch(() => ({})).then((payload) => ({ response, payload })))
        .then(({ response, payload }) => {
            if (!response.ok || payload?.status !== 'ok') {
                console.warn('saveLastOpenedPage failed', {
                    status: response.status,
                    payload,
                    page_number: normalized,
                });
                return false;
            }
            lastOpenPageSent = normalized;
            if (bookData && typeof bookData === 'object') {
                bookData.last_open_page = normalized;
            }
            return true;
        })
        .catch(() => false);
}

function saveLastOpenedPage(pageNum, { immediate = false } = {}) {
    const normalized = normalizePageNumberForSave(pageNum);
    if (!normalized) return;

    if (immediate) {
        if (lastOpenPageSaveTimer) {
            clearTimeout(lastOpenPageSaveTimer);
            lastOpenPageSaveTimer = null;
        }
        void sendLastOpenedPage(normalized);
        return;
    }

    if (lastOpenPageSaveTimer) {
        clearTimeout(lastOpenPageSaveTimer);
    }
    lastOpenPageSaveTimer = setTimeout(() => {
        lastOpenPageSaveTimer = null;
        void sendLastOpenedPage(normalized);
    }, 400);
}

function saveLastOpenedPageImmediately(pageNum) {
    const normalized = normalizePageNumberForSave(pageNum);
    if (!normalized || !pdfName) return;
    if (normalized === lastOpenPageSent) return;

    if (navigator && typeof navigator.sendBeacon === 'function') {
        try {
            const url = `/api/update_last_page/${encodePdfNamePath(pdfName)}`;
            const body = JSON.stringify({ page_number: normalized });
            const blob = new Blob([body], { type: 'application/json' });
            const ok = navigator.sendBeacon(url, blob);
            if (ok) {
                lastOpenPageSent = normalized;
                if (bookData && typeof bookData === 'object') {
                    bookData.last_open_page = normalized;
                }
                return;
            }
        } catch (_) {
        }
    }

    saveLastOpenedPage(normalized, { immediate: true });
}

async function processUrlImportEvent(event) {
    if (!event || !event.id) return;
    if (lastUrlImportEventId === event.id) return;
    lastUrlImportEventId = event.id;

    if (pendingUrlImportProbeTimer) {
        clearTimeout(pendingUrlImportProbeTimer);
        pendingUrlImportProbeTimer = null;
    }
    setUrlImportExtensionState('available');

    if (event.kind === 'rule_update') {
        if (typeof loadUrlRuleDialog === 'function' && typeof isUrlRuleDialogOpen === 'function') {
            if (isUrlRuleDialogOpen()) {
                await loadUrlRuleDialog();
                if (typeof setUrlRuleStatus === 'function') {
                    setUrlRuleStatus('ルールが更新されました');
                }
            }
        }
        return;
    }

    const pageNum = Number(event.page_number || 0);
    if (!pageNum) return;

    if (event.exists) {
        if (typeof window.setUrlImportStatus === 'function') {
            window.setUrlImportStatus(`取込済みページです（${pageNum}）。`, 'warning', { clearAfterMs: 3000 });
        }
        if (confirm('すでに取り込み済みです。移動しますか？')) {
            await jumpToPage(pageNum, { updateUrl: true, preserveScroll: false });
        }
        return;
    }

    if (typeof window.setUrlImportStatus === 'function') {
        window.setUrlImportStatus(`取込が完了しました（${pageNum}ページ）。`, 'success', { clearAfterMs: 3500 });
    }

    if (event.page_count && bookData) {
        bookData.page_count = event.page_count;
        const pageCountEl = document.getElementById('pageCount');
        const pageInputEl = document.getElementById('pageInput');
        if (pageCountEl) pageCountEl.innerText = event.page_count;
        if (pageInputEl) pageInputEl.max = event.page_count;
    }
    if (bookData && bookData.page_url_map && event.url) {
        bookData.page_url_map[String(pageNum)] = event.url;
    }
    if (bookData && isUrlBookContext()) {
        if (!bookData.page_nav || typeof bookData.page_nav !== 'object') {
            bookData.page_nav = { root_children: [], nodes: {}, selected_node_id: '', revision: 1 };
        }
        if (typeof ensureUrlPageNavClientState === 'function') {
            ensureUrlPageNavClientState();
        }
    }

    await fetchAndApplyPage(pageNum);
    if (typeof fetchAndApplyToc === 'function') {
        await fetchAndApplyToc();
    }
    if (typeof showToc === 'function') {
        showToc();
    }
    await jumpToPage(pageNum, { updateUrl: true, preserveScroll: false });
}

async function fetchLatestUrlImportEvent() {
    if (!isUrlBookContext() || !pdfName) return;
    try {
        const res = await fetch(`/api/url_book/import_event/${encodePdfNamePath(pdfName)}`);
        const data = await res.json().catch(() => ({}));
        const event = data?.event || null;
        if (!event || !event.id) return;
        await processUrlImportEvent(event);
    } catch (e) {
        // ignore
    }
}

function stopUrlImportPolling() {
    if (urlImportPollTimer) {
        clearInterval(urlImportPollTimer);
        urlImportPollTimer = null;
    }
}

function startUrlImportPolling() {
    stopUrlImportPolling();
    if (!isUrlBookContext()) return;

    urlImportPollTimer = setInterval(async () => {
        await fetchLatestUrlImportEvent();
    }, 1500);
}

window.addEventListener('message', (event) => {
    if (!event || !event.data) return;
    if (event.data.type !== 'ppt-refresh') return;
    if (event.data.kind === 'rule_update') {
        if (typeof isUrlRuleDialogOpen === 'function' && isUrlRuleDialogOpen()) {
            if (typeof loadUrlRuleDialog === 'function') {
                loadUrlRuleDialog();
            }
            if (typeof setUrlRuleStatus === 'function') {
                setUrlRuleStatus('ルールが更新されました');
            }
        }
    }
    fetchLatestUrlImportEvent();
});

async function navigateUrlBook(targetUrl) {
    if (!bookData || bookData.source_type !== 'url') {
        return false;
    }
    const url = String(targetUrl || '').trim();
    if (!url) return false;

    try {
        const res = await fetch('/api/url_book/navigate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ book_name: pdfName, url }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.status !== 'ok') {
            alert(data.message || `URL遷移に失敗しました (${res.status})`);
            return false;
        }

        if (data.page_count) {
            bookData.page_count = data.page_count;
            const pageCountEl = document.getElementById('pageCount');
            const pageInputEl = document.getElementById('pageInput');
            if (pageCountEl) pageCountEl.innerText = data.page_count;
            if (pageInputEl) pageInputEl.max = data.page_count;
        }

        if (data.page_url_map) {
            bookData.page_url_map = data.page_url_map;
        }

        if (data.url_to_page_id) {
            bookData.url_to_page_id = data.url_to_page_id;
        }

        if (data.page_nav) {
            bookData.page_nav = data.page_nav;
        }

        if (data.trans_status_counts) {
            updateTransStatusCounts(data.trans_status_counts);
        }

        if (data.page) {
            applyBookDelta({ pages: { [String(data.page_number)]: data.page } });
        }

        if (typeof fetchAndApplyToc === 'function') {
            await fetchAndApplyToc();
        }
        if (typeof showToc === 'function') {
            showToc();
        }

        await jumpToPage(data.page_number, { updateUrl: true, preserveScroll: false });
        return true;
    } catch (e) {
        console.error('navigateUrlBook failed:', e);
        alert(`URL遷移に失敗しました: ${e}`);
        return false;
    }
}

async function importCurrentUrlPage() {
    if (!bookData || bookData.source_type !== 'url') return false;
    if (!pdfName) return false;

    const iframe = document.getElementById('urlPreviewIframe');
    if (!iframe || !iframe.contentWindow) {
        alert('URLパネルが利用できません');
        return false;
    }

    const importButton = document.getElementById('urlImportButton');
    if (importButton) importButton.disabled = true;

    if (typeof window.setUrlImportStatus === 'function') {
        window.setUrlImportStatus('再取込を実行中です…（拡張機能応答待ち）', 'loading');
    }

    if (urlImportExtensionState === 'unavailable') {
        if (importButton) importButton.disabled = false;
        if (typeof window.setUrlImportStatus === 'function') {
            window.setUrlImportStatus('拡張機能が未接続です。セットアップ案内を表示します。', 'error', { clearAfterMs: 5000 });
        }
        showUrlImportExtensionSetupGuide();
        return false;
    }

    const flaskUrl = String(window.location.origin || '');
    let flaskPort = '';
    try {
        const parsed = new URL(flaskUrl);
        flaskPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    } catch (e) {
        flaskPort = '';
    }
    const importUrl = String(
        urlPreviewCurrentUrl
        || iframe?.src
        || bookData?.pages?.[String(currentPage)]?.url
        || bookData?.page_url_map?.[String(currentPage)]
        || ''
    ).trim();
    const clickLabel = String(importButton?.textContent || '').trim() || '取込';
    const beforeEventId = lastUrlImportEventId;

    console.info('[url_panel_import_click]', {
        button: clickLabel,
        flaskUrl,
        flaskPort,
        importUrl,
        extensionState: 'requested',
    });

    if (pendingUrlImportProbeTimer) {
        clearTimeout(pendingUrlImportProbeTimer);
        pendingUrlImportProbeTimer = null;
    }

    pendingUrlImportProbeTimer = setTimeout(() => {
        if (beforeEventId === lastUrlImportEventId) {
            setUrlImportExtensionState('unavailable');
            console.warn('[url_panel_import_extension_unavailable]', {
                button: clickLabel,
                flaskUrl,
                flaskPort,
                importUrl,
                extensionState: 'not_available_or_no_response',
            });
            if (typeof window.setUrlImportStatus === 'function') {
                window.setUrlImportStatus('応答がありません。拡張機能の接続を確認してください。', 'error', { clearAfterMs: 6000 });
            }
            showUrlImportExtensionSetupGuide();
        }
        pendingUrlImportProbeTimer = null;
    }, 3500);

    try {
        setUrlImportExtensionState('unknown');
        window.postMessage({
            type: 'ppt-sync-settings',
            baseUrl: window.location.origin,
            bookName: pdfName,
        }, '*');

        iframe.contentWindow.postMessage({
            type: 'ppt-capture-request',
            force: true,
        }, '*');

        setTimeout(() => {
            if (importButton) importButton.disabled = false;
        }, 1200);
        return true;
    } catch (e) {
        console.error('[url_panel_import_postmessage_failed]', {
            button: clickLabel,
            flaskUrl,
            flaskPort,
            importUrl,
            error: String(e),
        });
        setUrlImportExtensionState('unavailable');
        if (typeof window.setUrlImportStatus === 'function') {
            window.setUrlImportStatus('再取込リクエスト送信に失敗しました。', 'error', { clearAfterMs: 6000 });
        }
        showUrlImportExtensionSetupGuide();
        return false;
    } finally {
        // re-enable is handled by timeout for asynchronous extension flow
    }
}

function findPageNumberByUrl(targetUrl) {
    if (!bookData || !bookData.page_url_map) return null;
    const url = String(targetUrl || '').trim();
    if (!url) return null;
    for (const [pageNum, pageUrl] of Object.entries(bookData.page_url_map)) {
        if (pageUrl === url) return parseInt(pageNum, 10);
    }
    return null;
}

async function confirmAndAddUrlPage(targetUrl) {
    if (!bookData || bookData.source_type !== 'url') return false;
    const url = String(targetUrl || '').trim();
    if (!url) return false;

    const exists = findPageNumberByUrl(url);
    const message = exists
        ? 'このURLは既にページ追加されています。移動しますか？'
        : 'ページを追加しますか？';
    if (!confirm(message)) return false;

    return await navigateUrlBook(url);
}

async function addUrlPageByPrompt() {
    if (!bookData || bookData.source_type !== 'url') return false;
    const url = prompt('追加するURLを入力してください');
    if (!url) return false;
    return await navigateUrlBook(url);
}

async function crawlUrlBookByPrompt() {
    if (!bookData || bookData.source_type !== 'url') return false;
    const pathPrefix = prompt('クロール範囲のパス（空白=サイト全体、例: /docs/）');
    if (pathPrefix === null) return false;

    const maxInput = prompt('最大ページ数（1～500、デフォルト100）', '100');
    if (maxInput === null) return false;
    const maxPages = parseInt(maxInput, 10) || 100;

    if (!confirm(`${pathPrefix || '（サイト全体）'}を最大${maxPages}ページまでクロールします。よろしいですか？`)) {
        return false;
    }

    try {
        const res = await fetch('/api/url_book/crawl', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                book_name: pdfName,
                path_prefix: pathPrefix.trim() || null,
                max_pages: maxPages,
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.status !== 'ok') {
            alert(data.message || `クロールに失敗しました (${res.status})`);
            return false;
        }

        if (data.page_count) {
            bookData.page_count = data.page_count;
            const pageCountEl = document.getElementById('pageCount');
            const pageInputEl = document.getElementById('pageInput');
            if (pageCountEl) pageCountEl.innerText = data.page_count;
            if (pageInputEl) pageInputEl.max = data.page_count;
        }

        if (data.trans_status_counts) {
            updateTransStatusCounts(data.trans_status_counts);
        }

        alert(`クロール完了: ${data.discovered}件発見、${data.added}件追加`);
        if (typeof fetchAndApplyToc === 'function') {
            await fetchAndApplyToc();
        }
        return true;
    } catch (e) {
        console.error('crawlUrlBookByPrompt failed:', e);
        alert(`クロールに失敗しました: ${e}`);
        return false;
    }
}

async function setCurrentUrlBook() {
    if (!bookData || bookData.source_type !== 'url') return false;
    if (!pdfName) return false;
    try {
        await fetch('/api/url_book/current', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ book_name: pdfName }),
        });
        return true;
    } catch (e) {
        console.warn('setCurrentUrlBook failed:', e);
        return false;
    }
}


async function fetchBookData() {
    try {
        const metaRes = await fetch(`/api/book_meta/${encodePdfNamePath(pdfName)}`);
        if (metaRes.status === 206) {
            // 未抽出のPDFの場合、自動的にパラグラフ抽出を実行
            console.log("未抽出のPDFです。パラグラフ抽出を自動実行します。");
            await extractParagraphs(true);
            return;
        }
        if (!metaRes.ok) {
            throw new Error(`HTTP error! status: ${metaRes.status}`);
        }

        const metaPayload = await metaRes.json();
        const meta = metaPayload?.meta ?? metaPayload;

        // bookData をメタ情報で初期化（pages はページ単位で遅延ロード）
        bookData = {
            ...(meta || {}),
            pages: {},
            toc: [],
        };
        bookData.__json_mtime = meta?.json_mtime ?? null;

        const pageFromUrl = (typeof getPageFromUrl === 'function') ? getPageFromUrl() : null;
        if (!pageFromUrl) {
            const savedLastPage = parseInt(bookData?.last_open_page, 10);
            if (Number.isFinite(savedLastPage) && savedLastPage >= 1) {
                currentPage = savedLastPage;
            }
        }

        setCurrentUrlBook();
        startUrlImportPolling();

        if (typeof applyBookTypeUi === 'function') {
            applyBookTypeUi();
        }

        // 抽出ボタンは常に有効（既存PDFの場合はページ再抽出として動作）
        const extractButton = document.querySelector('.btn-step-extract');
        if (extractButton && !isUrlBook()) {
            extractButton.disabled = false;
            extractButton.title = 'クリックでこのページを再抽出します';
        }

        document.getElementById("titleInput").value = bookData.title;
        document.getElementById("pageCount").innerText = bookData.page_count;
        document.getElementById("pageInput").max = bookData.page_count;
        if (typeof clampPage === 'function') {
            currentPage = clampPage(currentPage);
        }

        updateTransStatusCounts(bookData.trans_status_counts);
        updateBookStyles();

        const restored = restorePageCacheFromSession();
        const hasCachedPage = !!bookData.pages?.[String(currentPage)];

        // 目次と表示ページを並列に取得
        await Promise.all([
            fetchAndApplyToc(),
            (restored && hasCachedPage) ? Promise.resolve(true) : fetchAndApplyPage(currentPage),
        ]);

        showToc();
        await jumpToPage(currentPage, { replaceHistory: true, forceRender: true, preserveScroll: true });
        if (typeof enablePagePrefetch === 'function') {
            enablePagePrefetch();
        }
    } catch (error) {
        console.error("Error fetching book data:", error);
        alert("書籍データの取得中にエラーが発生しました。"); // ユーザーへの通知
    }
}

async function fetchAndApplyToc() {
    try {
        const response = await fetch(`/api/book_toc/${encodePdfNamePath(pdfName)}`);
        if (!response.ok) {
            return false;
        }
        const data = await response.json();
        if (data.status !== 'ok') {
            return false;
        }
        if (!Array.isArray(data.toc)) {
            return false;
        }
        bookData.toc = data.toc;
        bookData.__toc_stale = false;
        return true;
    } catch (e) {
        console.warn('fetchAndApplyToc failed:', e);
        return false;
    }
}

function applyBookDelta(delta) {
    if (!delta || typeof delta !== 'object') return false;

    let changed = false;

    if (delta.pages && typeof delta.pages === 'object') {
        if (!bookData.pages || typeof bookData.pages !== 'object') {
            bookData.pages = {};
        }
        if (bookData.__stale_token && !bookData.__page_fresh_token) {
            bookData.__page_fresh_token = {};
        }
        for (const [pageKey, pageObj] of Object.entries(delta.pages)) {
            bookData.pages[pageKey] = pageObj;
            if (bookData.__stale_token && bookData.__page_fresh_token) {
                bookData.__page_fresh_token[String(pageKey)] = bookData.__stale_token;
            }
            changed = true;

            // TOC の部分更新（該当ページに見出しがあれば反映）
            if (Array.isArray(bookData.toc) && pageObj && pageObj.paragraphs) {
                for (const p of Object.values(pageObj.paragraphs)) {
                    if (!p) continue;
                    const blockTag = p.block_tag;
                    const joinFlag = Number(p?.join ?? 0);
                    if (!/^h[1-6]$/.test(blockTag) || joinFlag === 1) continue;

                    const rowId = `${p.page_number}_${p.id}`;
                    const existing = bookData.toc.find((t) => t && t.rowId === rowId);
                    if (existing) {
                        existing.src_joined = p.src_joined;
                        existing.trans_text = p.trans_text;
                        existing.block_tag = p.block_tag;
                        existing.order = p.order || 0;
                        existing.column_order = p.column_order || 0;
                    }
                }
            }
        }
    }

    if (delta.trans_status_counts && typeof delta.trans_status_counts === 'object') {
        bookData.trans_status_counts = delta.trans_status_counts;
        updateTransStatusCounts(bookData.trans_status_counts);
        changed = true;
    }

    if (changed) {
        savePageCacheToSession();
    }

    return changed;
}

function markAllPagesStale() {
    // 全体更新系操作の後、他ページの表示が古くなるのを防ぐため
    // ページ遷移時に /api/book_page で最新を取る
    bookData.__stale_token = Date.now();
    bookData.__page_fresh_token = bookData.__page_fresh_token || {};
    bookData.__toc_stale = true;
    clearPageCacheForSession();
}

function markPageStale(pageNum) {
    // 特定のページをstaleにする
    if (!bookData) return;
    bookData.__page_fresh_token = bookData.__page_fresh_token || {};
    delete bookData.__page_fresh_token[String(pageNum)];
    clearPageCacheForSession();
}

async function fetchAndApplyPage(pageNum) {
    try {
        const tFetch = (window.PERF_NAV && typeof perfNow === 'function') ? perfNow() : null;
        const url = `/api/book_page/${encodePdfNamePath(pdfName)}/${encodeURIComponent(pageNum)}`;
        const response = await fetch(url);
        if (!response.ok) {
            return false;
        }
        let data = null;
        if (tFetch !== null && typeof perfLog === 'function') {
            const tRead = perfNow();
            const rawText = await response.text();
            const tParse = perfNow();
            data = JSON.parse(rawText);
            const tDone = perfNow();
            const sizeKb = (rawText.length / 1024).toFixed(1);
            if (typeof performance !== 'undefined' && typeof performance.getEntriesByName === 'function') {
                const absUrl = new URL(url, window.location.href).toString();
                const entries = performance.getEntriesByName(absUrl) || [];
                const entry = entries.length > 0 ? entries[entries.length - 1] : null;
                if (entry) {
                    const ttfb = (entry.responseStart - entry.startTime).toFixed(1);
                    const xfer = (entry.responseEnd - entry.responseStart).toFixed(1);
                    const net = entry.duration.toFixed(1);
                    perfLog("fetchAndApplyPage(net)", tFetch, `(page ${pageNum}, ttfb ${ttfb} ms, xfer ${xfer} ms, net ${net} ms)`);
                    const reqStart = (entry.requestStart - entry.startTime).toFixed(1);
                    const respStart = (entry.responseStart - entry.startTime).toFixed(1);
                    const respEnd = (entry.responseEnd - entry.startTime).toFixed(1);
                    perfLog("fetchAndApplyPage(timeline)", tFetch, `(page ${pageNum}, request ${reqStart} ms, response ${respStart}..${respEnd} ms)`);
                } else {
                    perfLog("fetchAndApplyPage(net)", tFetch, `(page ${pageNum}, no ResourceTiming entry)`);
                }
            }
            const serverTiming = response.headers.get('server-timing');
            if (serverTiming) {
                perfLog("fetchAndApplyPage(server)", tFetch, `(page ${pageNum}, ${serverTiming})`);
            }
            perfLog("fetchAndApplyPage(fetch)", tFetch, `(page ${pageNum})`);
            perfLog("fetchAndApplyPage(read)", tRead, `(page ${pageNum}, kb ${sizeKb})`);
            perfLog("fetchAndApplyPage(parse)", tParse, `(page ${pageNum})`);
            perfLog("fetchAndApplyPage(total)", tFetch, `(page ${pageNum})`);
        } else {
            data = await response.json();
        }
        if (data.status !== 'ok') {
            return false;
        }

        if (!bookData.pages || typeof bookData.pages !== 'object') {
            bookData.pages = {};
        }
        bookData.pages[String(data.page_key)] = data.page;

        if (data.trans_status_counts) {
            bookData.trans_status_counts = data.trans_status_counts;
            updateTransStatusCounts(bookData.trans_status_counts);
        }

        // stale 管理
        if (bookData.__stale_token) {
            bookData.__page_fresh_token = bookData.__page_fresh_token || {};
            bookData.__page_fresh_token[String(data.page_key)] = bookData.__stale_token;
        }

        savePageCacheToSession();

        return true;
    } catch (e) {
        console.warn('fetchAndApplyPage failed:', e);
        return false;
    }
}

async function ensurePageFresh(pageNum) {
    const tFresh = (window.PERF_NAV && typeof perfNow === 'function') ? perfNow() : null;
    const pageKey = String(pageNum);

    // 未ロードなら常に取得
    if (!bookData?.pages || !bookData.pages[pageKey]) {
        const ok = await fetchAndApplyPage(pageNum);
        if (tFresh !== null && typeof perfLog === 'function') {
            perfLog("ensurePageFresh(miss)", tFresh, `(page ${pageNum})`);
        }
        return ok;
    }

    const staleToken = bookData.__stale_token;
    if (!staleToken) {
        if (tFresh !== null && typeof perfLog === 'function') {
            perfLog("ensurePageFresh(hit)", tFresh, `(page ${pageNum})`);
        }
        return true;
    }

    const freshMap = bookData.__page_fresh_token || {};
    if (freshMap[pageKey] === staleToken) {
        if (tFresh !== null && typeof perfLog === 'function') {
            perfLog("ensurePageFresh(fresh)", tFresh, `(page ${pageNum})`);
        }
        return true;
    }
    const ok = await fetchAndApplyPage(pageNum);
    if (tFresh !== null && typeof perfLog === 'function') {
        perfLog("ensurePageFresh(refetch)", tFresh, `(page ${pageNum})`);
    }
    return ok;
}

let srcTranslateProgressHideTimer = null;
let srcTranslateProgressValue = 0;
let srcTranslateProgressMode = 'page';
let srcTranslateProgressSse = null;
let srcTranslateProgressRequestId = '';
let srcTranslateProgressElapsedTimer = null;
let srcTranslateProgressStartedAtMs = 0;
let srcTranslateProgressDone = 0;
let srcTranslateProgressTotal = 0;
let srcTranslateProgressPage = 0;
let srcTranslateProgressPhase = 'start';
let srcTranslateProgressMeasuredItems = 0;
let srcTranslateProgressMeasuredMs = 0;
let srcTranslateProgressLastDoneAtMs = 0;
let srcTranslateProgressEstimatedFinishAtMs = 0;

function createSrcTranslateProgressRequestId() {
    return `trans-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function stopSrcTranslateProgressStream() {
    if (!srcTranslateProgressSse) return;
    try {
        srcTranslateProgressSse.close();
    } catch (e) {
        // ignore
    }
    srcTranslateProgressSse = null;
}

function stopSrcTranslateProgressElapsedTimer() {
    if (!srcTranslateProgressElapsedTimer) return;
    clearInterval(srcTranslateProgressElapsedTimer);
    srcTranslateProgressElapsedTimer = null;
}

function formatClockHms(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '--:--:--';
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
}

function getSrcTranslateElapsedSeconds() {
    if (!srcTranslateProgressStartedAtMs) return 0;
    return Math.max(0, Math.floor((Date.now() - srcTranslateProgressStartedAtMs) / 1000));
}

function updateSrcTranslateProgressTiming(nextDone, nextTotal, phase = 'step') {
    const now = Date.now();
    if (!srcTranslateProgressStartedAtMs) {
        srcTranslateProgressStartedAtMs = now;
    }
    if (!srcTranslateProgressLastDoneAtMs) {
        srcTranslateProgressLastDoneAtMs = srcTranslateProgressStartedAtMs;
    }

    const prevDone = Math.max(0, Math.floor(Number(srcTranslateProgressDone) || 0));
    const done = Math.max(0, Math.floor(Number(nextDone) || 0));
    const total = Math.max(0, Math.floor(Number(nextTotal) || 0));
    const completedDelta = Math.max(0, done - prevDone);

    if (completedDelta > 0) {
        const segmentMs = Math.max(0, now - srcTranslateProgressLastDoneAtMs);
        srcTranslateProgressMeasuredMs += segmentMs;
        srcTranslateProgressMeasuredItems += completedDelta;
        srcTranslateProgressLastDoneAtMs = now;
    }

    if (phase === 'done' || (total > 0 && done >= total)) {
        srcTranslateProgressEstimatedFinishAtMs = now;
        return;
    }

    if (total > 0 && srcTranslateProgressMeasuredItems > 0) {
        const perItemMs = srcTranslateProgressMeasuredMs / srcTranslateProgressMeasuredItems;
        srcTranslateProgressEstimatedFinishAtMs = srcTranslateProgressStartedAtMs + (perItemMs * total);
        return;
    }

    srcTranslateProgressEstimatedFinishAtMs = 0;
}

function computeSrcTranslateEta() {
    const etaAtMs = Number(srcTranslateProgressEstimatedFinishAtMs || 0);
    if (!Number.isFinite(etaAtMs) || etaAtMs <= 0) return '--:--:--';
    return formatClockHms(new Date(etaAtMs));
}

function buildSrcTranslateProgressLabel(isFailed = false) {
    const inProgressLabel = srcTranslateProgressMode === 'all' ? '全ページ翻訳中' : 'ページ翻訳中';
    const doneLabel = srcTranslateProgressMode === 'all' ? '全ページ翻訳完了' : 'ページ翻訳完了';
    const done = Math.max(0, Math.floor(Number(srcTranslateProgressDone) || 0));
    const total = Math.max(0, Math.floor(Number(srcTranslateProgressTotal) || 0));
    const elapsedSec = getSrcTranslateElapsedSeconds();
    const eta = computeSrcTranslateEta();

    const head = srcTranslateProgressPhase === 'done' ? doneLabel : inProgressLabel;
    let label = `${head} ${done}/${total || '-'} | 経過 ${elapsedSec}秒 | 予想完了 ${eta}`;
    if (srcTranslateProgressPage > 0 && srcTranslateProgressPhase !== 'done') {
        label += ` (P${srcTranslateProgressPage})`;
    }
    if (isFailed) {
        label += ' [失敗]';
    }
    return label;
}

function refreshSrcTranslateProgressLabel(isFailed = false) {
    setSrcTranslateProgress(srcTranslateProgressValue, buildSrcTranslateProgressLabel(isFailed));
}

function startSrcTranslateProgressElapsedTimer() {
    stopSrcTranslateProgressElapsedTimer();
    srcTranslateProgressElapsedTimer = setInterval(() => {
        if (srcTranslateProgressPhase === 'done') return;
        refreshSrcTranslateProgressLabel(false);
    }, 1000);
}

function applyLiveSrcTranslateProgress(payload) {
    if (!payload || typeof payload !== 'object') return;

    const kind = String(payload.kind || '').toLowerCase();
    if (kind !== 'translation') return;

    const payloadId = String(payload.id || '').trim();
    if (srcTranslateProgressRequestId) {
        if (!payloadId || payloadId !== srcTranslateProgressRequestId) return;
    }

    const phase = String(payload.phase || '').toLowerCase();
    const done = Math.max(0, Math.floor(Number(payload.done ?? 0) || 0));
    const total = Math.max(0, Math.floor(Number(payload.total ?? 0) || 0));
    const page = Math.max(0, Math.floor(Number(payload.page ?? 0) || 0));

    updateSrcTranslateProgressTiming(done, total, phase || 'step');

    srcTranslateProgressPhase = phase || 'step';
    srcTranslateProgressDone = done;
    srcTranslateProgressTotal = total;
    if (page > 0) {
        srcTranslateProgressPage = page;
    }

    let nextValue = 0;
    if (phase === 'done') {
        nextValue = 100;
    } else if (total > 0) {
        nextValue = (done / total) * 100;
    }

    setSrcTranslateProgress(nextValue, buildSrcTranslateProgressLabel(false));
}

function handleSrcTranslateProgressLine(line) {
    const marker = '[PROGRESS]';
    const markerIndex = String(line || '').indexOf(marker);
    if (markerIndex < 0) return;

    const payloadText = String(line || '').slice(markerIndex + marker.length).trim();
    if (!payloadText || !payloadText.startsWith('{')) return;

    try {
        const payload = JSON.parse(payloadText);
        applyLiveSrcTranslateProgress(payload);
    } catch (e) {
        // ignore malformed progress payloads
    }
}

function startSrcTranslateProgressStream(requestId = '') {
    stopSrcTranslateProgressStream();
    srcTranslateProgressRequestId = String(requestId || '').trim();

    if (typeof EventSource === 'undefined') return;

    const sse = new EventSource('/logstream');
    srcTranslateProgressSse = sse;

    sse.onmessage = (event) => {
        const lines = String(event?.data || '').split('\n');
        for (const line of lines) {
            if (!line || !line.trim()) continue;
            handleSrcTranslateProgressLine(line);
        }
    };

    sse.onerror = () => {
        // EventSource は自動再接続されるため、ここでは何もしない
    };
}

function getSrcTranslateProgressElements() {
    return {
        container: document.getElementById('srcTranslateProgress'),
        label: document.getElementById('srcTranslateProgressLabel'),
        track: document.getElementById('srcTranslateProgressTrack'),
        bar: document.getElementById('srcTranslateProgressBar'),
    };
}

function setSrcTranslateProgress(value, labelText = null) {
    const { label, track, bar } = getSrcTranslateProgressElements();
    if (!track || !bar) return;

    const normalized = Math.max(0, Math.min(100, Number(value) || 0));
    srcTranslateProgressValue = normalized;
    bar.style.width = `${normalized}%`;
    track.setAttribute('aria-valuenow', String(Math.round(normalized)));

    if (label && typeof labelText === 'string') {
        label.textContent = labelText;
    }
}

function startSrcTranslateProgress(mode = 'page', requestId = '') {
    const { container } = getSrcTranslateProgressElements();
    if (!container) return;

    srcTranslateProgressMode = mode === 'all' ? 'all' : 'page';
    stopSrcTranslateProgressStream();
    stopSrcTranslateProgressElapsedTimer();

    if (srcTranslateProgressHideTimer) {
        clearTimeout(srcTranslateProgressHideTimer);
        srcTranslateProgressHideTimer = null;
    }

    srcTranslateProgressStartedAtMs = Date.now();
    srcTranslateProgressDone = 0;
    srcTranslateProgressTotal = 0;
    srcTranslateProgressPage = 0;
    srcTranslateProgressPhase = 'start';
    srcTranslateProgressMeasuredItems = 0;
    srcTranslateProgressMeasuredMs = 0;
    srcTranslateProgressLastDoneAtMs = srcTranslateProgressStartedAtMs;
    srcTranslateProgressEstimatedFinishAtMs = 0;

    container.style.display = 'block';
    setSrcTranslateProgress(0, buildSrcTranslateProgressLabel(false));

    startSrcTranslateProgressStream(requestId);
    startSrcTranslateProgressElapsedTimer();
}

function finishSrcTranslateProgress(success, customLabel = '') {
    const { container } = getSrcTranslateProgressElements();
    if (!container) return;

    stopSrcTranslateProgressStream();
    stopSrcTranslateProgressElapsedTimer();
    srcTranslateProgressRequestId = '';

    if (srcTranslateProgressHideTimer) {
        clearTimeout(srcTranslateProgressHideTimer);
        srcTranslateProgressHideTimer = null;
    }

    if (success) {
        srcTranslateProgressPhase = 'done';
        if (srcTranslateProgressTotal > 0) {
            srcTranslateProgressDone = srcTranslateProgressTotal;
        }
        srcTranslateProgressEstimatedFinishAtMs = Date.now();
    }

    const defaultLabel = success ? buildSrcTranslateProgressLabel(false) : buildSrcTranslateProgressLabel(true);
    const finalLabel = customLabel || defaultLabel;

    if (success) {
        setSrcTranslateProgress(100, finalLabel);
    } else {
        setSrcTranslateProgress(srcTranslateProgressValue, finalLabel);
    }

    srcTranslateProgressHideTimer = setTimeout(() => {
        container.style.display = 'none';
        setSrcTranslateProgress(0, '');
    }, success ? 700 : 1400);
}

function normalizeOllamaChunkChars(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return OLLAMA_CHUNK_DEFAULT;
    const floored = Math.floor(numeric);
    const clamped = Math.max(OLLAMA_CHUNK_MIN, Math.min(OLLAMA_CHUNK_MAX, floored));
    const stepped = Math.round(clamped / OLLAMA_CHUNK_STEP) * OLLAMA_CHUNK_STEP;
    return Math.max(OLLAMA_CHUNK_MIN, Math.min(OLLAMA_CHUNK_MAX, stepped));
}

function getCurrentTranslateEngineValue() {
    const cached = String(currentTranslateEngine || '').trim().toLowerCase();
    if (cached) return cached;
    const select = document.getElementById('dataExportTranslator');
    const selected = String(select?.value || '').trim().toLowerCase();
    return selected || 'google';
}

function getDefaultOllamaChunkProfile() {
    return {
        chunk_max_chars: OLLAMA_CHUNK_DEFAULT,
        success_streak: 0,
        updated_at: '',
    };
}

function loadOllamaChunkProfile() {
    const fallback = getDefaultOllamaChunkProfile();
    if (!canUseLocalStorage()) return fallback;

    try {
        const raw = window.localStorage.getItem(OLLAMA_CHUNK_PROFILE_KEY);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return fallback;
        return {
            chunk_max_chars: normalizeOllamaChunkChars(parsed.chunk_max_chars),
            success_streak: Math.max(0, Math.floor(Number(parsed.success_streak) || 0)),
            updated_at: String(parsed.updated_at || ''),
            last_elapsed_ms: Math.max(0, Math.floor(Number(parsed.last_elapsed_ms) || 0)),
            last_success: Boolean(parsed.last_success),
            last_failed_count: Math.max(0, Math.floor(Number(parsed.last_failed_count) || 0)),
            last_missing_count: Math.max(0, Math.floor(Number(parsed.last_missing_count) || 0)),
        };
    } catch (e) {
        return fallback;
    }
}

function saveOllamaChunkProfile(profile) {
    if (!canUseLocalStorage()) return false;
    try {
        window.localStorage.setItem(OLLAMA_CHUNK_PROFILE_KEY, JSON.stringify(profile));
        return true;
    } catch (e) {
        return false;
    }
}

function buildParaparatransRequestPayload(startPage, endPage, progressId = '') {
    const params = new URLSearchParams();
    params.set('start_page', String(startPage));
    params.set('end_page', String(endPage));
    if (progressId) {
        params.set('progress_id', String(progressId));
    }

    const engine = getCurrentTranslateEngineValue();
    let groupMaxChars = null;
    if (engine === 'ollama') {
        const profile = loadOllamaChunkProfile();
        groupMaxChars = normalizeOllamaChunkChars(profile.chunk_max_chars);
        params.set('group_max_chars', String(groupMaxChars));
    }

    return {
        engine,
        groupMaxChars,
        body: params.toString(),
    };
}

function updateOllamaChunkProfileWithResult({ success, elapsedMs = 0, stats = null, requestedGroupMaxChars = null }) {
    const profile = loadOllamaChunkProfile();
    const failed = Math.max(0, Math.floor(Number(stats?.failed ?? 0) || 0));
    const missing = Math.max(0, Math.floor(Number(stats?.missing_from_batch ?? 0) || 0));
    const elapsedTotalMs = Math.max(0, Math.floor(Number(elapsedMs) || 0));
    const groupsRaw = Number(stats?.groups ?? 0);
    const groups = Number.isFinite(groupsRaw) && groupsRaw > 0
        ? Math.max(1, Math.floor(groupsRaw))
        : 0;

    const tuningMode = groups > 0 ? 'per_group' : 'total';
    const tuningElapsedMs = groups > 0
        ? Math.max(1, Math.floor(elapsedTotalMs / groups))
        : elapsedTotalMs;
    const fastThresholdMs = groups > 0 ? OLLAMA_CHUNK_FAST_PER_GROUP_MS : OLLAMA_CHUNK_FAST_MS;
    const slowThresholdMs = groups > 0 ? OLLAMA_CHUNK_SLOW_PER_GROUP_MS : OLLAMA_CHUNK_SLOW_MS;

    const statsGroupRaw = Number(stats?.group_max_chars ?? 0);
    const statsGroup = Number.isFinite(statsGroupRaw) && statsGroupRaw > 0
        ? normalizeOllamaChunkChars(statsGroupRaw)
        : null;

    const requestedRaw = Number(requestedGroupMaxChars ?? 0);
    const requested = Number.isFinite(requestedRaw) && requestedRaw > 0
        ? normalizeOllamaChunkChars(requestedRaw)
        : null;

    const current = normalizeOllamaChunkChars(statsGroup || requested || profile.chunk_max_chars);

    let next = current;
    let successStreak = Math.max(0, Math.floor(Number(profile.success_streak) || 0));

    if (!success) {
        next = current - (OLLAMA_CHUNK_STEP * 2);
        successStreak = 0;
    } else if (failed > 0 || missing > 0) {
        next = current - OLLAMA_CHUNK_STEP;
        successStreak = 0;
    } else if (tuningElapsedMs >= slowThresholdMs) {
        next = current - OLLAMA_CHUNK_STEP;
        successStreak = 0;
    } else {
        successStreak += 1;
        const isFast = tuningElapsedMs > 0 && tuningElapsedMs <= fastThresholdMs;
        if (isFast || successStreak >= 2) {
            next = current + OLLAMA_CHUNK_STEP;
            successStreak = 0;
        }
    }

    next = normalizeOllamaChunkChars(next);
    const updated = {
        ...profile,
        chunk_max_chars: next,
        success_streak: successStreak,
        updated_at: new Date().toISOString(),
        last_elapsed_ms: elapsedTotalMs,
        last_tuning_elapsed_ms: tuningElapsedMs,
        last_tuning_mode: tuningMode,
        last_groups: groups,
        last_success: Boolean(success),
        last_failed_count: failed,
        last_missing_count: missing,
    };
    saveOllamaChunkProfile(updated);

    console.info('[OLLAMA_CHUNK_TUNER]', {
        success,
        elapsed_ms: updated.last_elapsed_ms,
        tuning_mode: tuningMode,
        groups,
        tuning_elapsed_ms: tuningElapsedMs,
        fast_threshold_ms: fastThresholdMs,
        slow_threshold_ms: slowThresholdMs,
        failed,
        missing,
        previous_chunk_max_chars: current,
        next_chunk_max_chars: next,
        success_streak: successStreak,
    });
}

/** @function transPage */
async function transPage() {
    await saveCurrentPageOrder(); // 順序を保存してから翻訳 (saveOrderもasyncにする必要あり)
    if (!confirm("現在のページを翻訳します。よろしいですか？")) return;
    showLog();

    let applied = false;
    let translationSucceeded = false;
    const progressRequestId = createSrcTranslateProgressRequestId();
    const translateRequest = buildParaparatransRequestPayload(currentPage, currentPage, progressRequestId);
    startSrcTranslateProgress('page', progressRequestId);
    const requestStartedAt = Date.now();

    try {
        const response = await fetch(`/api/paraparatrans/${encodePdfNamePath(pdfName)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: translateRequest.body
        });
        const data = await response.json();
        if (data.status === "ok") {
            console.log('翻訳が成功しました。');
            applied = applyBookDelta(data.delta || data.data);
            translationSucceeded = true;
            if (translateRequest.engine === 'ollama') {
                updateOllamaChunkProfileWithResult({
                    success: true,
                    elapsedMs: Date.now() - requestStartedAt,
                    stats: data.stats || null,
                    requestedGroupMaxChars: translateRequest.groupMaxChars,
                });
            }
            if (data.stats) {
                alert(formatTranslationStatsMessage("ページ翻訳が完了しました", data.stats));
            } else {
                alert("ページ翻訳が完了しました");
            }
        } else {
            console.error('エラー:', data.message);
            if (translateRequest.engine === 'ollama') {
                updateOllamaChunkProfileWithResult({
                    success: false,
                    elapsedMs: Date.now() - requestStartedAt,
                    stats: data.stats || null,
                    requestedGroupMaxChars: translateRequest.groupMaxChars,
                });
            }
            alert('翻訳エラー(response): ' + data.message);
        }
        hideLog();
    } catch (error) {
        console.error('Error:', error);
        if (translateRequest.engine === 'ollama') {
            updateOllamaChunkProfileWithResult({
                success: false,
                elapsedMs: Date.now() - requestStartedAt,
                requestedGroupMaxChars: translateRequest.groupMaxChars,
            });
        }
        alert('翻訳中にエラー(catch)');
    } finally {
        // 成功時は差分適用で全体再取得を回避。適用できなかった場合のみ従来通り全体再取得する。
        if (applied) {
            await jumpToPage(currentPage, { replaceHistory: true, forceRender: true, preserveScroll: true });
        } else {
            await fetchBookData();
        }
        finishSrcTranslateProgress(translationSucceeded);
    }
}

/** @function dictReplacePage */
async function dictReplacePage() {
    await saveCurrentPageOrder(); // 順序を保存してから置換
    if (!confirm("現在のページを対訳辞書で置換します。よろしいですか？")) return;
    showLog();

    let applied = false;

    try {
        const response = await fetch(`/api/dict_replace_pages/${encodePdfNamePath(pdfName)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: '&start_page=' + encodeURIComponent(currentPage) +
                '&end_page=' + encodeURIComponent(currentPage)
        });
        const data = await response.json();
        if (data.status === "ok") {
            console.log('ページ対訳置換が成功しました。');
            applied = applyBookDelta(data.delta);
        } else {
            console.error('エラー:', data.message);
            alert('ページ対訳置換エラー(response): ' + data.message);
        }
        hideLog();
    } catch (error) {
        console.error('Error:', error);
        alert('ページ対訳置換中にエラー(catch)');
    } finally {
        if (applied) {
            await jumpToPage(currentPage, { replaceHistory: true, forceRender: true, preserveScroll: true });
        } else {
            await fetchBookData();
        }
    }
}

/** @function alignTransBySrcJoined */
async function alignTransBySrcJoined() {
    await saveCurrentPageOrder();
    const msg = "同一src_joinedの訳を文書全体で揃えます。\nよろしいですか？";
    if (!confirm(msg)) return;
    showLog();

    let applied = false;

    try {
        const response = await fetch(`/api/align_trans_by_src_joined/${encodePdfNamePath(pdfName)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: ''
        });
        const data = await response.json();
        if (data.status === "ok") {
            console.log(`訳揃えが成功しました。updated=${data.changed}`);
            applied = applyBookDelta(data.delta);
            // 文書全体が対象なので目次も更新しておく
            await fetchAndApplyToc();
            showToc();
        } else {
            console.error('エラー:', data.message);
            alert('訳揃えエラー(response): ' + data.message);
        }
        hideLog();
    } catch (error) {
        console.error('Error:', error);
        alert('訳揃え中にエラー(catch)');
    } finally {
        if (applied) {
            await jumpToPage(currentPage, { replaceHistory: true, forceRender: true, preserveScroll: true });
        } else {
            await fetchBookData();
        }
    }
}

async function dictReplaceAll() {
    let msg = "全ページに対して対訳辞書による置換を行います";
    msg += "\nこの処理は時間がかかります。";
    msg += "\n応答がなくてもページを閉じないでください。";
    msg += "\n\nよろしいですか？";
    if (!confirm(msg)) return;
    showLog();

    let applied = false;

    try {
        const response = await fetch(`/api/dict_replace_pages/${encodePdfNamePath(pdfName)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: '&start_page=1' +
                '&end_page=' + bookData.page_count
        });
        const data = await response.json();
        if (data.status === "ok") {
            applied = applyBookDelta(data.delta);
            alert("全対訳置換が成功しました");
        } else {
            console.error("対訳置換エラー:", data.message);
            alert("対訳置換エラー: " + data.message);
        }
    } catch (error) {
        console.error("dictReplaceAllエラー:", error);
        alert("dictReplaceAll エラー: " + error);
    } finally {
        if (applied) {
            await jumpToPage(currentPage, { replaceHistory: true, forceRender: true, preserveScroll: true });
        } else {
            await fetchBookData();
        }
    }
}


async function transAllPages() {
    await saveCurrentPageOrder(); // saveOrderもasyncにする必要あり
    const totalPages = bookData.page_count;
    if (!confirm(`全 ${totalPages} ページを翻訳します。よろしいですか？`)) return;
    showLog();

    let applied = false;
    let translationSucceeded = false;
    const progressRequestId = createSrcTranslateProgressRequestId();
    const translateRequest = buildParaparatransRequestPayload(1, totalPages, progressRequestId);
    startSrcTranslateProgress('all', progressRequestId);
    const requestStartedAt = Date.now();

    try {
        const response = await fetch(`/api/paraparatrans/${encodePdfNamePath(pdfName)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: translateRequest.body
        });
        const data = await response.json();
        if (data.status === "ok") {
            console.log('翻訳が成功しました。');
            applied = applyBookDelta(data.delta || data.data);
            translationSucceeded = true;
            if (translateRequest.engine === 'ollama') {
                updateOllamaChunkProfileWithResult({
                    success: true,
                    elapsedMs: Date.now() - requestStartedAt,
                    stats: data.stats || null,
                    requestedGroupMaxChars: translateRequest.groupMaxChars,
                });
            }
            await fetchAndApplyToc();
            showToc();
            if (data.stats) {
                alert(formatTranslationStatsMessage("全ページ翻訳が完了しました", data.stats));
            } else {
                alert("全ページ翻訳が完了しました");
            }
        } else {
            console.error('エラー:', data.message);
            if (translateRequest.engine === 'ollama') {
                updateOllamaChunkProfileWithResult({
                    success: false,
                    elapsedMs: Date.now() - requestStartedAt,
                    stats: data.stats || null,
                    requestedGroupMaxChars: translateRequest.groupMaxChars,
                });
            }
            alert('翻訳エラー(response): ' + data.message);
        }
    } catch (error) {
        console.error('Error:', error);
        if (translateRequest.engine === 'ollama') {
            updateOllamaChunkProfileWithResult({
                success: false,
                elapsedMs: Date.now() - requestStartedAt,
                requestedGroupMaxChars: translateRequest.groupMaxChars,
            });
        }
        alert('翻訳中にエラー(catch)');
    } finally {
        if (applied) {
            await jumpToPage(currentPage, { replaceHistory: true, forceRender: true, preserveScroll: true });
        } else {
            await fetchBookData();
        }
        finishSrcTranslateProgress(translationSucceeded);
    }
}

function formatTranslationStatsMessage(title, stats) {
    const engine = String(stats.translation_engine || '').trim();
    const groupMaxCharsRaw = Number(stats.group_max_chars ?? 0);
    const groupMaxChars = Number.isFinite(groupMaxCharsRaw) ? Math.max(0, Math.floor(groupMaxCharsRaw)) : 0;
    const usedCharsRaw = Number(stats.characters_used ?? 0);
    const usedChars = Number.isFinite(usedCharsRaw) ? Math.max(0, Math.floor(usedCharsRaw)) : 0;
    const pages = stats.pages_processed ?? 0;
    const target = stats.paragraphs_target ?? 0;
    const translated = stats.translated ?? 0;
    const failed = stats.failed ?? 0;
    const fallback = stats.translated_fallback ?? 0;
    const skippedEmpty = stats.skipped_empty_src ?? 0;
    const skippedHF = stats.skipped_header_footer ?? 0;
    const missing = stats.missing_from_batch ?? 0;

    let msg = `${title}\n`;
    if (engine) msg += `翻訳エンジン: ${formatTranslateEngineLabel(engine)}\n`;
    if (groupMaxChars > 0) msg += `グループ上限文字数: ${groupMaxChars.toLocaleString('ja-JP')}\n`;
    msg += `利用文字数: ${usedChars.toLocaleString('ja-JP')}\n`;
    msg += `ページ数: ${pages}\n`;
    msg += `対象段落: ${target}\n`;
    msg += `翻訳成功: ${translated}\n`;
    msg += `翻訳失敗: ${failed}\n`;
    if (fallback > 0) msg += `フォールバック(単体翻訳): ${fallback}\n`;
    if (missing > 0) msg += `マーカー欠落(推定): ${missing}\n`;
    if (skippedEmpty > 0) msg += `スキップ(空): ${skippedEmpty}\n`;
    if (skippedHF > 0) msg += `スキップ(header/footer): ${skippedHF}\n`;
    return msg.trim();
}

async function extractParagraphs(auto = false){
    // bookData が存在する = 既存JSONあり
    const hasExistingData = bookData && bookData.pages;
    
    let message;
    if (hasExistingData) {
        // 既存JSONがある場合：現在のページを再抽出
        message = `このページ（${currentPage}ページ）を再抽出します。\n\n原文と構造情報は更新されますが、翻訳やタグ指定は保持されます。\n\nよろしいですか？`;
    } else {
        // 新規抽出
        message = "PDFを解析してJSONを新規生成します。よろしいですか？";
    }
    
    if(!auto && !confirm(message)) return;
    showLog();
    const originalCursor = document.body.style.cursor;
    document.body.style.cursor = 'wait';

    try {
        const body = hasExistingData 
            ? JSON.stringify({ current_page: currentPage })
            : JSON.stringify({});
        
        const response = await fetch(`/api/extract_paragraphs/${encodePdfNamePath(pdfName)}`, {
            method: "POST",
            headers: {
                'Content-Type': 'application/json'
            },
            body: body
        });
        const res = await response.json();
        if(res.status === "ok"){
            if (!auto) {
                alert(res.message || "パラグラフ抽出完了");
            }
            
            if (hasExistingData) {
                // ページ再抽出の場合：ブックデータを再読み込みして現在のページをリロード
                markPageStale(currentPage);
                await fetchBookData();
                await jumpToPage(currentPage, { replaceHistory: true, forceRender: true, preserveScroll: false });
            } else {
                // 新規抽出の場合：ページ全体をリロード
                location.reload();
            }
        } else {
            alert(res.message);
        }
    } catch (error) {
        console.error("extractParagraphs error:", error);
        alert("パラグラフ抽出中にエラーが発生しました。");
    } finally {
        document.body.style.cursor = originalCursor || 'auto';
    }
}


async function autoTagging() {
    let msg = "全ページのblock_tagがpであるパラグラフに対して独自ルールでおおまかなタグ付けを行います";
    msg += "\n1回だけの実行を推奨します。";
    msg += "\nすでにp以外に設定しているblock_tagは変更されませんが、見出しからpに変更したパラグラフは再度見出しに戻ります。";
    msg += "\n\nよろしいですか？";
    if (!confirm(msg)) return;

    try {
        const body = '&current_page=' + encodeURIComponent(currentPage);
        const response = await fetch(`/api/auto_tagging/${encodePdfNamePath(pdfName)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body
        });
        const result = await response.json();
        if (result.status === "ok") {
            alert("自動タグ付けが成功しました");
            markAllPagesStale();
            const applied = applyBookDelta(result.delta);
            await fetchAndApplyToc();
            showToc();
            if (applied) {
                await jumpToPage(currentPage, { replaceHistory: true, forceRender: true, preserveScroll: true });
            } else {
                await fetchBookData();
            }
        } else {
            alert("自動タグ付けエラー: " + result.message);
        }
    } catch (error) {
        console.error("autoTagging error:", error);
        alert("自動タグ付け中にエラーが発生しました");
    }
}


async function rebuildSrcTextFromHtml() {
    let msg = "全ページの段落について src_html から src_text を作り直し、シンボル置換（symbolfont_dict）を適用します";
    msg += "\n（辞書を更新した後に何度でも実行できます）";
    msg += "\n\nよろしいですか？";
    if (!confirm(msg)) return;

    await saveCurrentPageOrder();
    try {
        const body = '&current_page=' + encodeURIComponent(currentPage);
        const response = await fetch(`/api/rebuild_src_text/${encodePdfNamePath(pdfName)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body
        });
        const result = await response.json();
        if (result.status === "ok") {
            alert(result.message || "シンボル置換が完了しました");
            markAllPagesStale();
            const applied = applyBookDelta(result.delta);
            await fetchAndApplyToc();
            showToc();
            if (applied) {
                await jumpToPage(currentPage, { replaceHistory: true, forceRender: true, preserveScroll: true });
            } else {
                await fetchBookData();
            }
        } else {
            alert("シンボル置換エラー: " + (result.message || "unknown"));
        }
    } catch (error) {
        console.error("rebuildSrcTextFromHtml error:", error);
        alert("シンボル置換中にエラーが発生しました");
    }
}

async function deleteSelectedParagraphs() {
    if (typeof getSelectedParagraphsInOrder !== 'function') {
        alert("選択機能が利用できません");
        return;
    }

    const selected = getSelectedParagraphsInOrder();
    if (!selected || selected.length === 0) {
        alert("削除するパラグラフを選択してください");
        return;
    }

    const message = `選択した${selected.length}個のパラグラフを削除します。\n\nこの操作は取り消せません。\n\nよろしいですか？`;
    if (!confirm(message)) return;

    try {
        // DOM要素から id を取得し、bookData から paragraph を取得
        const paragraphs = selected
            .map(div => {
                const id = div.id.replace('paragraph-', '');
                const p = bookData?.pages?.[currentPage]?.paragraphs?.[id];
                if (!p) {
                    console.warn(`Paragraph with ID ${id} not found`);
                    return null;
                }
                return {
                    page_number: currentPage,
                    id: id
                };
            })
            .filter(p => p !== null);

        if (paragraphs.length === 0) {
            alert("削除対象のパラグラフが見つかりませんでした");
            return;
        }

        const response = await fetch(`/api/delete_paragraphs/${encodePdfNamePath(pdfName)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                paragraphs: paragraphs
            })
        });

        const result = await response.json();
        if (result.status === "ok") {
            alert(result.message || "パラグラフを削除しました");
            // ブックデータを再読み込みして現在のページを再描画
            markPageStale(currentPage);
            await fetchBookData();
            await jumpToPage(currentPage, { replaceHistory: true, forceRender: true, preserveScroll: false });
        } else {
            alert("削除エラー: " + (result.message || "unknown"));
        }
    } catch (error) {
        console.error("deleteSelectedParagraphs error:", error);
        alert("削除中にエラーが発生しました");
    }
}

async function taggingByStyle(targetStyle, targetTag) {
    try {
        const response = await fetch(`/api/update_block_tags_by_style/${encodePdfNamePath(pdfName)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                target_style: targetStyle,
                target_tag: targetTag,
                current_page: currentPage
            })
        });

        const result = await response.json();

        if (result.status === "ok") {
            alert("スタイルの一括更新が完了しました。");
            markAllPagesStale();
            const applied = applyBookDelta(result.delta);
            await fetchAndApplyToc();
            showToc();
            if (applied) {
                await jumpToPage(currentPage, { replaceHistory: true, forceRender: true, preserveScroll: true });
            } else {
                await fetchBookData();
            }
        } else {
            alert(`スタイルの一括更新に失敗しました: ${result.message}`);
        }
    } catch (error) {
        console.error('スタイル一括更新エラー:', error);
        alert('スタイルの一括更新中にエラーが発生しました。');
    }
}


async function taggingByStyleY(targetStyle, y0, y1, action) {
    try {
        const response = await fetch(`/api/update_block_tags_by_style_y/${encodePdfNamePath(pdfName)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                target_style: targetStyle,
                y0: y0,
                y1: y1,
                action: action,
                current_page: currentPage
            })
        });

        const result = await response.json();

        if (result.status === "ok") {
            alert(result.message || "スタイル+Y範囲の一括更新が完了しました。");
            markAllPagesStale();
            const applied = applyBookDelta(result.delta);
            await fetchAndApplyToc();
            showToc();
            if (applied) {
                await jumpToPage(currentPage, { replaceHistory: true, forceRender: true, preserveScroll: true });
            } else {
                await fetchBookData();
            }
        } else {
            alert(`スタイル+Y範囲の一括更新に失敗しました: ${result.message}`);
        }
    } catch (error) {
        console.error('スタイル+Y範囲 一括更新エラー:', error);
        alert('スタイル+Y範囲の一括更新中にエラーが発生しました。');
    }
}


async function joinParagraphs() {
    let msg = "全ページのパラグラフに対して結合処理を行います";
    msg += "\n「置換文」列の置換はいったんリセットされます。";
    msg += "\nこの処理で「訳文」列が変更されることはありません。";
    msg += "\n\nよろしいですか？";
    if (!confirm(msg)) return;

    // カーソルを砂時計に変更
    const originalCursor = document.body.style.cursor;
    document.body.style.cursor = 'wait';

    await saveCurrentPageOrder(); // 順序を保存してから翻訳 (saveOrderもasyncにする必要あり)
    try {
        const response = await fetch(`/api/join_replaced_paragraphs/${encodePdfNamePath(pdfName)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: '&current_page=' + encodeURIComponent(currentPage)
        });
        const data = await response.json();
        if (data.status === "ok") {
            const applied = applyBookDelta(data.delta);
            alert("「連結文」「置換文」列を更新しました");
            markAllPagesStale();
            await fetchAndApplyToc();
            showToc();
            if (applied) {
                await jumpToPage(currentPage, { replaceHistory: true, forceRender: true, preserveScroll: true });
            } else {
                await fetchBookData();
            }
        } else {
            alert("連結文結合エラー: " + data.message);
        }
    } catch (error) {
        console.error("autoTagging error:", error);
        alert("連結文結合中にエラーが発生しました");
    } finally {
        // カーソルを元に戻す
        document.body.style.cursor = originalCursor || 'auto';
    }
}

async function reextractTableFromSelectedLines(paragraphIds) {
    const ids = Array.isArray(paragraphIds)
        ? paragraphIds.map((id) => String(id || '').trim()).filter((id) => id.length > 0)
        : [];

    if (ids.length === 0) {
        alert('表再抽出の対象パラグラフが見つかりません。');
        return;
    }

    const originalCursor = document.body.style.cursor;
    document.body.style.cursor = 'wait';

    try {
        // 利用可能なAIプロバイダを取得（ダイアログのヒント表示用）
        let aiProviders = [];
        let currentAiProvider = 'ollama';
        try {
            const aiResp = await fetch('/api/ai_providers');
            if (aiResp.ok) {
                const aiData = await aiResp.json();
                aiProviders = Array.isArray(aiData.providers) ? aiData.providers : [];
                currentAiProvider = String(aiData.current || 'ollama');
            }
        } catch (err) {
            console.warn('AI プロバイダ情報の取得に失敗しました:', err);
        }

        const suggestResponse = await fetch(`/api/table_grid_suggest/${encodePdfNamePath(pdfName)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                current_page: currentPage,
                paragraph_ids: ids,
            })
        });

        const suggestData = await suggestResponse.json();
        if (suggestData.status !== 'ok') {
            alert(`表グリッド推測エラー: ${suggestData.message || 'unknown'}`);
            return;
        }

        const previewRects = Array.isArray(suggestData.preview_cell_rects) ? suggestData.preview_cell_rects : [];
        if (previewRects.length > 0 && typeof highlightRectsOnPage === 'function') {
            highlightRectsOnPage(currentPage, previewRects);
        }

        const guessedRows = Number(suggestData.rows) > 0 ? Number(suggestData.rows) : 1;
        const guessedCols = Number(suggestData.cols) > 0 ? Number(suggestData.cols) : 1;
        const headerText = String(suggestData.header_text || '').trim();

        // 専用ダイアログを表示
        const result = await showTableReextractDialog({
            guessedRows,
            guessedCols,
            headerText,
            paragraphIds: ids,
            pageNumber: currentPage,
            aiProviders,
            currentAiProvider,
        });

        if (!result) {
            if (typeof clearHighlights === 'function') {
                clearHighlights();
            }
            return;
        }

        let response;
        if (result.mode === 'roi') {
            // ROI ベース自動抽出
            response = await fetch(`/api/reextract_table_roi/${encodePdfNamePath(pdfName)}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    current_page: currentPage,
                    paragraph_ids: ids,
                    rows: result.rows || undefined,
                    cols: result.cols || undefined,
                })
            });
        } else if (result.mode === 'ai') {
            // AI による表再抽出
            response = await fetch(`/api/reextract_table_ai/${encodePdfNamePath(pdfName)}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    current_page: currentPage,
                    paragraph_ids: ids,
                    rows: result.rows || undefined,
                    cols: result.cols || undefined,
                })
            });
        } else {
            // 従来のグリッド指定による再抽出
            const { rows, cols, finalHeaderText } = result;
            response = await fetch(`/api/reextract_table_from_selection/${encodePdfNamePath(pdfName)}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    current_page: currentPage,
                    paragraph_ids: ids,
                    rows,
                    cols,
                    header_text: finalHeaderText,
                })
            });
        }

        const data = await response.json();
        if (data.status !== 'ok') {
            alert(`表再抽出エラー: ${data.message || 'unknown'}`);
            if (typeof clearHighlights === 'function') {
                clearHighlights();
            }
            return;
        }

        const applied = applyBookDelta(data.delta);
        if (applied) {
            await jumpToPage(currentPage, { replaceHistory: true, forceRender: true, preserveScroll: true });
        } else {
            await fetchBookData();
        }

        if (typeof clearHighlights === 'function') {
            clearHighlights();
        }
        alert(data.message || '表再抽出が完了しました');
    } catch (error) {
        console.error('reextractTableFromSelectedLines error:', error);
        alert('表再抽出中にエラーが発生しました');
        if (typeof clearHighlights === 'function') {
            clearHighlights();
        }
    } finally {
        document.body.style.cursor = originalCursor || 'auto';
    }
}

async function dictCreate() {
    try {
        const response = await fetch(`/api/dict_create/${encodePdfNamePath(pdfName)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
        const data = await response.json();
        if (data.status === "ok") {
            alert("辞書生成が成功しました");
        } else {
            alert("辞書生成エラー: " + data.message);
        }
    } catch (error) {
        console.error("dictCreate error:", error); // エラーログのタイポ修正
        alert("辞書生成中にエラーが発生しました");
    }
}

async function dictTrans() {
    try {
        const response = await fetch(`/api/dict_trans/${encodePdfNamePath(pdfName)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
        const data = await response.json();
        if (data.status === "ok") {
            alert("辞書翻訳が成功しました");
        } else {
            alert("辞書翻訳エラー: " + data.message);
        }
    } catch (error) {
        console.error("dictTrans error:", error); // エラーログのタイポ修正
        alert("辞書翻訳中にエラーが発生しました");
    }
}

/** * @function updateTransStatusCounts
 * @param {Object} counts - 翻訳ステータスのカウントオブジェクト
 * ページ内順序再発行＆保存処理
 */
async function saveCurrentPageOrder() {
    const originalCursor = document.body.style.cursor;
    document.body.style.cursor = 'wait';
    const container = document.getElementById('srcParagraphs');
    const children = container.children;
    sendParagraphs = [];

    // ページ内のパラグラフをループして、順序を取得
    for (let i = 0; i < children.length; i++) {
        const divP = children[i];
        const idElem = divP.querySelector('.paragraph-id');
        if (!idElem) continue;

        const id = idElem.innerText.trim();
        const groupClass = Array.from(divP.classList).find(cls => cls.startsWith('group-id-'));
        // group_id は文字列として扱う（数値にパースしない）
        const groupId = groupClass ? groupClass.replace('group-id-', '') : undefined;

        paragraphDict = bookData["pages"][currentPage]["paragraphs"][id];
        // 本当はpを更新してるのでorder以外の更新は不要
        if (paragraphDict) {
            paragraphDict.order = i + 1; // 1-based index
            // bookData["pages"][currentPage]["paragraphs"][id].block_tag = blockTag;
            paragraphDict.group_id = groupId;
        } else {
            throw new Error(`saveOrder: Paragraph data not found for ID ${currentPage} ${id} in paragraphs`);
        }

        // 送信用配列にデータを追加
        sendParagraphs.push(
            {
                id: id,
                page_number: paragraphDict.page_number,
                order: paragraphDict.order,
                block_tag: paragraphDict.block_tag,
                trans_status: paragraphDict.trans_status,
                group_id: paragraphDict?.group_id,
                join: paragraphDict?.join
            }
        );
    }

    try {
        if (typeof saveBookAutoToggleCache === 'function') {
            saveBookAutoToggleCache();
        }
        console.log("saveOrder: Sending updates:", sendParagraphs.length);
        await updateParagraphs(sendParagraphs); // updateParagraphsもasyncなのでawait
    } finally {
        document.body.style.cursor = originalCursor || 'auto';
    }
}

async function exportHtml() {
    // カーソルを砂時計に変更
    const originalCursor = document.body.style.cursor;
    document.body.style.cursor = 'wait';
    
    await saveCurrentPageOrder(); // saveOrderもasyncにする必要あり
    try {
        const displayUnit = document.getElementById('dataExportHtmlUnit')?.value || 'page';
        const body = new URLSearchParams({
            display_unit: displayUnit
        });
        const response = await fetch(`/api/export_html/${encodePdfNamePath(pdfName)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body
        });
        const data = await response.json();
        if (data.status === "ok") {
            // 生成後、ダウンロードも実行
            window.location.href = `/api/download_html/${encodePdfNamePath(pdfName)}?display_unit=${encodeURIComponent(displayUnit)}`;
            alert(`対訳HTMLを出力しました: ${data.path ?? ''}`);
        } else {
            alert("エラー: " + data.message);
        }
    } catch (error) {
        console.error("Error exporting HTML:", error);
        alert("対訳HTML出力中にエラーが発生しました");
    } finally {
        // カーソルを元に戻す
        document.body.style.cursor = originalCursor || 'auto';
    }
}


async function exportDocStructure() {
    // カーソルを砂時計に変更
    const originalCursor = document.body.style.cursor;
    document.body.style.cursor = 'wait';
    
    // 未保存の順序・group_id などが構造に含まれるため、先に保存
    await saveCurrentPageOrder();
    try {
        const response = await fetch(`/api/export_structure/${encodePdfNamePath(pdfName)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: ''
        });
        const data = await response.json();
        if (data.status === "ok") {
            // 生成後、ダウンロードも実行
            window.location.href = `/api/download_structure/${encodePdfNamePath(pdfName)}`;
            alert(`構造ファイルを出力しました: ${data.path}`);
        } else {
            alert("エラー: " + data.message);
        }
    } catch (error) {
        console.error("Error exporting doc structure:", error);
        alert("構造ファイル出力中にエラーが発生しました");
    } finally {
        // カーソルを元に戻す
        document.body.style.cursor = originalCursor || 'auto';
    }
}


function downloadBrowserExtensionPackage() {
    try {
        window.location.href = '/api/download_extension/chrome';
    } catch (error) {
        console.error('Error downloading browser extension package:', error);
        alert('ブラウザ拡張のダウンロード中にエラーが発生しました');
    }
}


async function openDataExportDialog() {
    let dialog = document.getElementById('dataExportDialog');
    
    // 初回呼び出し時にダイアログHTMLを動的にロード
    if (!dialog) {
        try {
            const response = await fetch('/partials/data_export_dialog');
            if (!response.ok) {
                console.error('Failed to load data export dialog');
                return;
            }
            const html = await response.text();
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = html;
            document.body.appendChild(tempDiv.firstElementChild);
            dialog = document.getElementById('dataExportDialog');
        } catch (error) {
            console.error('Error loading data export dialog:', error);
            return;
        }
    }
    
    if (!dialog) return;
    dialog.style.display = 'flex';
    updateDataExportFieldState();
    reloadTranslationEngineSelection();
    reloadDictSelection();
}


let currentTranslateEngine = 'google';

function formatTranslateEngineLabel(engine) {
    const value = String(engine || '').toLowerCase();
    if (value === 'deepl') return 'DeepL';
    if (value === 'google_v3') return 'Google v3';
    if (value === 'ollama') return 'Ollama';
    if (value === 'google') return 'Google';
    return value || '-';
}


function updateCurrentTranslateEngineLabel(engine) {
    const label = document.getElementById('currentTranslateEngine');
    if (!label) return;
    label.textContent = formatTranslateEngineLabel(engine);
}


function setTranslateEngineStatus(message, isError = false) {
    const status = document.getElementById('translateEngineStatus');
    if (!status) return;
    status.textContent = message || '';
    status.style.color = isError ? '#b00020' : '#0a7a0a';
}


async function reloadTranslationEngineSelection() {
    const select = document.getElementById('dataExportTranslator');
    if (!select) return;
    setTranslateEngineStatus('読み込み中...', false);
    try {
        const response = await fetch('/api/translate_engine');
        const data = await response.json();
        if (!response.ok || data.status !== 'ok') {
            throw new Error(data.message || `翻訳エンジンの取得に失敗しました (${response.status})`);
        }
        if (Array.isArray(data.supported) && data.supported.length > 0) {
            const options = Array.from(select.options).map((option) => option.value);
            const supported = data.supported.filter((item) => options.includes(item));
            if (supported.length > 0 && !supported.includes(select.value)) {
                select.value = supported[0];
            }
        }
        if (data.engine) {
            select.value = data.engine;
        }
        currentTranslateEngine = String(data.engine || select.value || 'google').toLowerCase();
        updateCurrentTranslateEngineLabel(data.engine || select.value);
        setTranslateEngineStatus(`現在: ${select.options[select.selectedIndex]?.text || select.value}`, false);
    } catch (error) {
        console.error('translate engine load error:', error);
        currentTranslateEngine = String(select.value || currentTranslateEngine || 'google').toLowerCase();
        updateCurrentTranslateEngineLabel('取得失敗');
        setTranslateEngineStatus(String(error), true);
    }
}


async function saveTranslationEngineFromDialog() {
    const select = document.getElementById('dataExportTranslator');
    if (!select) return;

    setTranslateEngineStatus('保存中...', false);
    try {
        const response = await fetch('/api/translate_engine', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                engine: select.value,
            }),
        });
        const data = await response.json();
        if (!response.ok || data.status !== 'ok') {
            throw new Error(data.message || `翻訳エンジン保存に失敗しました (${response.status})`);
        }
        if (data.engine) {
            select.value = data.engine;
        }
        currentTranslateEngine = String(data.engine || select.value || currentTranslateEngine || 'google').toLowerCase();
        updateCurrentTranslateEngineLabel(data.engine || select.value);
        setTranslateEngineStatus(`保存しました: ${select.options[select.selectedIndex]?.text || select.value}`, false);
    } catch (error) {
        console.error('translate engine save error:', error);
        currentTranslateEngine = String(select.value || currentTranslateEngine || 'google').toLowerCase();
        setTranslateEngineStatus(String(error), true);
    }
}


function buildDictMaintenanceUrl(dictPath, comparePath) {
    const params = new URLSearchParams();
    if (dictPath) {
        params.set('dict_path', dictPath);
    }
    if (comparePath) {
        params.set('compare_path', comparePath);
    }
    if (window.pdfName) {
        params.set('pdf_name', window.pdfName);
    }
    const suffix = params.toString();
    return suffix ? `/dict_maintenance?${suffix}` : '/dict_maintenance';
}


function openDictMaintenance() {
    const url = buildDictMaintenanceUrl('', '');
    window.open(url, '_blank', 'noopener');
}

function openDictMaintenanceForPath(dictPath) {
    if (!dictPath) {
        openDictMaintenance();
        return;
    }
    const url = buildDictMaintenanceUrl(dictPath, '');
    window.open(url, '_blank', 'noopener');
}

function openDictMaintenanceForPaths(dictPath, comparePath) {
    const url = buildDictMaintenanceUrl(dictPath, comparePath);
    window.open(url, '_blank', 'noopener');
}

async function createBookDictFromDialog() {
    if (!window.pdfName) {
        alert("固有辞書の対象ブックが指定されていません。");
        return;
    }
    if (!confirm("固有辞書を作成しますか?")) return;
    try {
        const response = await fetch(`/api/dict/create_book/${encodeURIComponent(window.pdfName)}`, {
            method: "POST",
        });
        const data = await response.json();
        if (!response.ok || data.status !== "ok") {
            throw new Error(data.message || `作成に失敗しました (${response.status})`);
        }
        alert(`固有辞書を作成しました: ${data.dict_path || ""}`);
        // 新規作成した辞書で dict_maintenance を開く
        const dictPath = data.dict_path;
        if (dictPath) {
            openDictMaintenanceForPath(dictPath);
        }
    } catch (error) {
        console.error("create book dict error:", error);
        alert(`エラー: ${String(error)}`);
    }
}

const dictSelectionState = {
    configDicts: [],
    bookDict: null,
    selectedPaths: [],
};

function setDictSelectionStatus(message, isError = false) {
    const status = document.getElementById('dictSelectionStatus');
    if (!status) return;
    status.textContent = message || '';
    status.style.color = isError ? '#b00020' : '#0a7a0a';
}

function getDictSelectionItems() {
    const items = [];
    dictSelectionState.configDicts.forEach((item) => {
        if (!item?.path) return;
        items.push({
            path: item.path,
            label: item.label || item.path,
        });
    });
    if (dictSelectionState.bookDict?.path && dictSelectionState.bookDict?.exists) {
        items.push({
            path: dictSelectionState.bookDict.path,
            label: dictSelectionState.bookDict.label || dictSelectionState.bookDict.path,
        });
    }
    return items;
}

function getDictTxtPath() {
    const match = dictSelectionState.configDicts.find((item) => {
        const label = (item?.label || '').toLowerCase();
        const path = (item?.path || '').toLowerCase();
        return label === 'dict.txt' || path.endsWith('/dict.txt') || path === 'dict.txt';
    });
    return match?.path || '';
}

function moveSelectedDict(path, delta) {
    const idx = dictSelectionState.selectedPaths.indexOf(path);
    if (idx < 0) return;
    const next = idx + delta;
    if (next < 0 || next >= dictSelectionState.selectedPaths.length) return;
    const temp = dictSelectionState.selectedPaths[idx];
    dictSelectionState.selectedPaths[idx] = dictSelectionState.selectedPaths[next];
    dictSelectionState.selectedPaths[next] = temp;
    renderDictSelection();
}

function toggleSelectedDict(path, checked) {
    const idx = dictSelectionState.selectedPaths.indexOf(path);
    if (checked && idx < 0) {
        dictSelectionState.selectedPaths.push(path);
    } else if (!checked && idx >= 0) {
        dictSelectionState.selectedPaths.splice(idx, 1);
    }
    renderDictSelection();
}

function renderDictSelection() {
    const container = document.getElementById('dictSelectionList');
    if (!container) return;
    container.innerHTML = '';

    const items = getDictSelectionItems();
    if (!items.length) {
        const empty = document.createElement('div');
        empty.textContent = '辞書がありません';
        container.appendChild(empty);
        return;
    }

    const selectedSet = new Set(dictSelectionState.selectedPaths);
    const selectedItems = dictSelectionState.selectedPaths
        .map((path) => items.find((entry) => entry.path === path))
        .filter((item) => item);
    const unselectedItems = items.filter((item) => !selectedSet.has(item.path));

    selectedItems.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = 'dict-selection-row';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        checkbox.addEventListener('change', (e) => {
            toggleSelectedDict(item.path, e.target.checked);
        });

        const label = document.createElement('span');
        label.className = 'dict-selection-label';
        label.textContent = item.label;

        const actions = document.createElement('span');
        actions.className = 'dict-selection-actions';

        const upButton = document.createElement('button');
        upButton.type = 'button';
        upButton.textContent = '↑';
        upButton.disabled = index === 0;
        upButton.addEventListener('click', () => moveSelectedDict(item.path, -1));

        const downButton = document.createElement('button');
        downButton.type = 'button';
        downButton.textContent = '↓';
        downButton.disabled = index === selectedItems.length - 1;
        downButton.addEventListener('click', () => moveSelectedDict(item.path, 1));

        actions.appendChild(upButton);
        actions.appendChild(downButton);

        const editButton = document.createElement('button');
        editButton.type = 'button';
        editButton.textContent = '編集';
        editButton.addEventListener('click', () => {
            const dictTxtPath = getDictTxtPath();
            const bookDictPath = dictSelectionState.bookDict?.exists
                ? dictSelectionState.bookDict.path
                : '';
            const isBaseDict = dictTxtPath && item.path === dictTxtPath;
            const comparePath = isBaseDict ? bookDictPath : dictTxtPath;
            openDictMaintenanceForPaths(item.path, comparePath);
        });

        row.appendChild(checkbox);
        row.appendChild(label);
        row.appendChild(actions);
        row.appendChild(editButton);
        container.appendChild(row);
    });

    unselectedItems.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'dict-selection-row';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = false;
        checkbox.addEventListener('change', (e) => {
            toggleSelectedDict(item.path, e.target.checked);
        });

        const label = document.createElement('span');
        label.className = 'dict-selection-label';
        label.textContent = item.label;

        const editButton = document.createElement('button');
        editButton.type = 'button';
        editButton.textContent = '編集';
        editButton.addEventListener('click', () => {
            const dictTxtPath = getDictTxtPath();
            const bookDictPath = dictSelectionState.bookDict?.exists
                ? dictSelectionState.bookDict.path
                : '';
            const isBaseDict = dictTxtPath && item.path === dictTxtPath;
            const comparePath = isBaseDict ? bookDictPath : dictTxtPath;
            openDictMaintenanceForPaths(item.path, comparePath);
        });

        row.appendChild(checkbox);
        row.appendChild(label);
        row.appendChild(editButton);
        container.appendChild(row);
    });
}

async function reloadDictSelection() {
    if (!window.pdfName) return;
    setDictSelectionStatus('読み込み中...', false);
    try {
        const response = await fetch(`/api/dict/selection/${encodePdfNamePath(pdfName)}`);
        const data = await response.json();
        if (!response.ok || data.status !== 'ok') {
            throw new Error(data.message || `辞書一覧の取得に失敗しました (${response.status})`);
        }
        dictSelectionState.configDicts = Array.isArray(data.config_dicts) ? data.config_dicts : [];
        dictSelectionState.bookDict = data.book_dict || null;
        dictSelectionState.selectedPaths = Array.isArray(data.selected_paths) ? data.selected_paths : [];
        renderDictSelection();
        setDictSelectionStatus('読み込み完了', false);
    } catch (error) {
        console.error('dict selection load error:', error);
        setDictSelectionStatus(String(error), true);
    }
}

async function saveDictSelection() {
    if (!window.pdfName) return;
    setDictSelectionStatus('保存中...', false);
    try {
        const response = await fetch(`/api/dict/selection/${encodePdfNamePath(pdfName)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                dict_paths: dictSelectionState.selectedPaths,
            }),
        });
        const data = await response.json();
        if (!response.ok || data.status !== 'ok') {
            throw new Error(data.message || `保存に失敗しました (${response.status})`);
        }
        dictSelectionState.selectedPaths = Array.isArray(data.selected_paths) ? data.selected_paths : dictSelectionState.selectedPaths;
        renderDictSelection();
        setDictSelectionStatus('保存しました', false);
    } catch (error) {
        console.error('dict selection save error:', error);
        setDictSelectionStatus(String(error), true);
    }
}


function closeDataExportDialog() {
    const dialog = document.getElementById('dataExportDialog');
    if (!dialog) return;
    dialog.style.display = 'none';
    setDataExportStatus('');
}


function getSelectedExportFields() {
    const inputs = document.querySelectorAll('.data-export-field');
    const selected = [];
    inputs.forEach((input) => {
        if (input.checked) selected.push(input.value);
    });
    return selected;
}


function updateDataExportFieldState() {
    const selected = getSelectedExportFields();

    const hint = document.getElementById('dataExportFieldHint');
    if (hint) {
        hint.textContent = `出力時に1〜2件でチェックしてください。現在 ${selected.length} 件選択中`;
    }
}


function setDataExportStatus(message, isError = false) {
    const status = document.getElementById('dataExportStatus');
    if (!status) return;
    status.textContent = message || '';
    status.style.color = isError ? '#b00020' : '#0a7a0a';
}


async function exportTextOrMd() {
    // カーソルを砂時計に変更
    const originalCursor = document.body.style.cursor;
    document.body.style.cursor = 'wait';
    
    await saveCurrentPageOrder();
    const formatSelect = document.getElementById('dataExportFormat');
    const includePage = document.getElementById('dataExportIncludePage');
    const includeHeader = document.getElementById('dataExportIncludeHeader');
    const includeFooter = document.getElementById('dataExportIncludeFooter');
    const includeRemove = document.getElementById('dataExportIncludeRemove');
    const fields = getSelectedExportFields();

    if (!fields.length || fields.length > 2) {
        alert('出力項目は1〜2件で選択してください。');
        document.body.style.cursor = originalCursor || 'auto';
        return;
    }

    const format = formatSelect ? formatSelect.value : 'md';
    const includePageNumbers = !!includePage?.checked;
    const includeHeaderFlag = !!includeHeader?.checked;
    const includeFooterFlag = !!includeFooter?.checked;
    const includeRemoveFlag = !!includeRemove?.checked;

    setDataExportStatus('出力中...', false);

    try {
        const response = await fetch(`/api/export_text/${encodePdfNamePath(pdfName)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                format: format,
                fields: fields,
                include_page_numbers: includePageNumbers,
                include_header: includeHeaderFlag,
                include_footer: includeFooterFlag,
                include_remove: includeRemoveFlag
            })
        });
        const data = await response.json();
        if (data.status === 'ok') {
            window.location.href = `/api/download_text/${encodePdfNamePath(pdfName)}/${encodeURIComponent(format)}`;
            setDataExportStatus(`出力しました: ${data.path ?? ''}`, false);
        } else {
            setDataExportStatus(data.message || '出力に失敗しました', true);
            alert('エラー: ' + data.message);
        }
    } catch (error) {
        console.error('Error exporting text:', error);
        setDataExportStatus('テキスト出力中にエラーが発生しました', true);
        alert('テキスト出力中にエラーが発生しました');
    } finally {
        // カーソルを元に戻す
        document.body.style.cursor = originalCursor || 'auto';
    }
}


document.addEventListener('DOMContentLoaded', function () {
    const inputs = document.querySelectorAll('.data-export-field');
    inputs.forEach((input) => {
        input.addEventListener('change', updateDataExportFieldState);
    });
    updateDataExportFieldState();
    reloadTranslationEngineSelection();
});


function openDocStructurePicker() {
    const input = document.getElementById('docStructureFileInput');
    if (!input) {
        alert('ファイル選択UIが見つかりません');
        return;
    }
    // 同じファイルを連続で選択しても change が発火するようにクリア
    input.value = '';
    input.click();
}


async function importDocStructureFile(fileList) {
    try {
        if (!fileList || fileList.length === 0) return;
        const file = fileList[0];
        if (!file) return;

        const form = new FormData();
        form.append('file', file);

        const response = await fetch(`/api/import_structure/${encodePdfNamePath(pdfName)}`, {
            method: 'POST',
            body: form
        });
        const data = await response.json();
        if (data.status === 'ok') {
            const msg = [
                '構造ファイルを取り込みました。',
                data.backup ? `バックアップ: ${data.backup}` : null,
                data.join_changed ? 'join変更が検出され、連結文を再構築しました。' : null,
            ].filter(Boolean).join('\n');
            alert(msg);
            await fetchBookData();
        } else {
            alert('エラー: ' + data.message);
        }
    } catch (error) {
        console.error('Error importing doc structure:', error);
        alert('構造ファイル取り込み中にエラーが発生しました');
    }
}

// updateParagraphs も fetch を使うので async にする
async function updateParagraphs(sendParagraphs, title = null) {
    const payload = {
        paragraphs: sendParagraphs,
        title: title || document.getElementById('titleInput').value
    };

    try {
        const response = await fetch(`/api/update_paragraphs/${encodePdfNamePath(pdfName)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (data.status === "ok") {
            isPageEdited = false;
            console.log("パラグラフ更新が成功しました");
            if (data.trans_status_counts) {
                updateTransStatusCounts(data.trans_status_counts);
            }
            if (data.reload_book_data) {
                await fetchBookData();
            }
        } else {
            console.error("パラグラフ更新エラー:", data.message);
            alert("パラグラフ更新エラー: " + data.message);
        }
    } catch (error) {
        console.error("パラグラフ更新中にエラーが発生しました:", error);
        alert("パラグラフ更新中にエラーが発生しました");
    }
}

async function transParagraph(paragraph, divSrc) {
    try {
        const pageNum = Number(paragraph?.page_number || currentPage || 1);
        const replaceResponse = await fetch(`/api/dict_replace_paragraph/${encodePdfNamePath(pdfName)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                page_number: pageNum,
                paragraph_id: String(paragraph?.id ?? ''),
            })
        });
        const replaceData = await replaceResponse.json();
        if (!replaceResponse.ok || replaceData.status !== 'ok') {
            throw new Error(replaceData.message || `翻訳前の対訳置換に失敗しました (${replaceResponse.status})`);
        }
        applyBookDelta(replaceData.delta);

        const paragraphId = String(paragraph?.id ?? '');
        const latestParagraph = bookData?.pages?.[String(pageNum)]?.paragraphs?.[paragraphId] || paragraph;
        if (divSrc?.querySelector) {
            const replacedNode = divSrc.querySelector('.src-replaced');
            if (replacedNode && latestParagraph?.src_replaced !== undefined) {
                replacedNode.innerHTML = latestParagraph.src_replaced;
            }
        }

        const textToTranslate = (latestParagraph?.src_replaced ?? '');
        const response = await fetch('/api/translate', {
            method: 'POST',
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ text: textToTranslate })
        });
        const data = await response.json();
        console.log("翻訳結果:", data.translated_text);
        if (data.status === "ok") {
            latestParagraph.trans_auto = data.translated_text;
            latestParagraph.trans_text = data.translated_text;
            latestParagraph.trans_status = "auto";
            if (paragraph !== latestParagraph && paragraph) {
                paragraph.trans_auto = data.translated_text;
                paragraph.trans_text = data.translated_text;
                paragraph.trans_status = "auto";
            }
            divSrc.querySelector('.trans-auto').innerHTML = latestParagraph.trans_auto;
            divSrc.querySelector('.trans-text').innerHTML = latestParagraph.trans_text;
            let autoRadio = divSrc.querySelector(`input[name='status-${latestParagraph.id}'][value='auto']`);
            updateEditUiBackground(divSrc, latestParagraph.trans_status);
            if (autoRadio) { autoRadio.checked = true; }

            // ページ翻訳などで再読込された際に「未保存の訳」が英語に戻らないよう、ここで永続化する
            if (typeof saveParagraphData === 'function') {
                await saveParagraphData(latestParagraph);
            } else {
                console.warn('saveParagraphData is not available; translation will not be persisted.');
            }
        } else {
            console.error("パラグラフ更新エラー:", data.message);
            alert("パラグラフ更新エラー: " + data.message);
        }
    } catch (error) {
        // ユーザーにポップアップでエラーを通知
        console.error('Error:', error);
        alert('翻訳中にエラーが発生しました。詳細はコンソールを確認してください。');
    }
}

async function updateBookInfo() {
    if (typeof isUrlBook === 'function' && isUrlBook()) {
        return;
    }
    try {
        const payload = {
            title: document.getElementById('titleInput').value,
            page_count: bookData.page_count, // ページ数を追加
            trans_status_counts: bookData.trans_status_counts // 翻訳ステータスカウントを追加
        };        
        const response = await fetch(`/api/update_book_info/${encodePdfNamePath(pdfName)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (data.status === "ok") {
            console.log("文書情報が正常に更新されました。");
        } else {
            console.error("文書情報更新エラー:", data.message);
            alert("文書情報更新エラー: " + data.message);
        }
    } catch (error) {
        console.error("文書情報更新中にエラーが発生しました:", error);
        alert("文書情報更新中にエラーが発生しました。");
    }
}

/**
 * テーブル再抽出用の専用ダイアログを表示
 * @param {Object} options - ダイアログのオプション
 * @param {number} options.guessedRows - 推測された行数
 * @param {number} options.guessedCols - 推測された列数
 * @param {string} options.headerText - 推測されたヘッダテキスト（カンマ区切り）
 * @returns {Promise<{rows: number, cols: number, finalHeaderText: string}|null>} ユーザーが入力した値、またはキャンセル時null
 */
async function showTableReextractDialog(options) {
    const { guessedRows, guessedCols, headerText, paragraphIds, pageNumber, aiProviders, currentAiProvider } = options;

    // AI プロバイダのヒントテキストを生成
    const hasProviders = Array.isArray(aiProviders) && aiProviders.length > 0;
    const aiList = hasProviders ? aiProviders.join('、') : '';
    const aiCurrent = String(currentAiProvider || 'ollama');
    const aiHint = hasProviders
        ? `利用可能なプロバイダ: <strong>${aiList}</strong><br>現在の設定（AI_PROVIDER）: <strong>${aiCurrent}</strong>`
        : '利用可能なAIプロバイダが見つかりません。<br>.env に <code>AI_PROVIDER</code> と APIキーを設定してください。';

    return new Promise((resolve) => {
        // ダイアログHTMLを作成
        const dialogHTML = `
            <style>
                #tableReextractDialog {
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    background: var(--trd-bg);
                    color: var(--trd-text);
                    border: 2px solid var(--trd-border);
                    padding: 20px;
                    z-index: 10000;
                    box-shadow: 0 4px 8px rgba(0,0,0,0.3);
                    min-width: 420px;
                    max-width: 680px;
                    border-radius: 8px;
                }
                #tableReextractDialogOverlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: rgba(0,0,0,0.5);
                    z-index: 9999;
                }
                #tableReextractDialog input[type="text"],
                #tableReextractDialog input[type="number"] {
                    width: 100%;
                    padding: 6px 8px;
                    font-size: 14px;
                    background: var(--trd-input-bg);
                    color: var(--trd-text);
                    border: 1px solid var(--trd-border);
                    border-radius: 4px;
                    box-sizing: border-box;
                }
                #tableReextractDialog .trd-hint {
                    color: var(--trd-subtext);
                }
                #tableReextractDialog .trd-guess {
                    padding: 10px;
                    background: var(--trd-guess-bg);
                    border-radius: 4px;
                    border: 1px solid var(--trd-border);
                }
                #tableReextractDialog .trd-mode-selector {
                    display: flex;
                    gap: 20px;
                    padding: 10px 12px;
                    background: var(--trd-guess-bg);
                    border-radius: 4px;
                    border: 1px solid var(--trd-border);
                }
                #tableReextractDialog .trd-mode-selector label {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    cursor: pointer;
                    font-weight: bold;
                    font-size: 14px;
                }
                #tableReextractDialog .trd-ai-info {
                    padding: 12px 14px;
                    background: var(--trd-guess-bg);
                    border-radius: 4px;
                    border: 1px solid var(--trd-border);
                    line-height: 1.7;
                    font-size: 13px;
                }
                #tableReextractDialog .trd-actions {
                    display: flex;
                    justify-content: flex-end;
                    gap: 10px;
                }
                #tableReextractDialog .trd-btn {
                    padding: 8px 16px;
                    cursor: pointer;
                    border-radius: 4px;
                    border: 1px solid var(--trd-border);
                    background: var(--trd-btn-bg);
                    color: var(--trd-text);
                }
                #tableReextractDialog .trd-btn-primary {
                    background: var(--trd-primary-bg);
                    color: var(--trd-primary-text);
                    border: 1px solid var(--trd-primary-bg);
                }
                @media (prefers-color-scheme: dark) {
                    #tableReextractDialog {
                        --trd-bg: #1e1e1e;
                        --trd-text: #f1f1f1;
                        --trd-subtext: #b8b8b8;
                        --trd-border: #3a3a3a;
                        --trd-input-bg: #2a2a2a;
                        --trd-guess-bg: #242424;
                        --trd-btn-bg: #2a2a2a;
                        --trd-primary-bg: #3b82f6;
                        --trd-primary-text: #ffffff;
                    }
                }
                @media (prefers-color-scheme: light) {
                    #tableReextractDialog {
                        --trd-bg: #ffffff;
                        --trd-text: #1a1a1a;
                        --trd-subtext: #666666;
                        --trd-border: #cccccc;
                        --trd-input-bg: #ffffff;
                        --trd-guess-bg: #f5f5f5;
                        --trd-btn-bg: #f5f5f5;
                        --trd-primary-bg: #2563eb;
                        --trd-primary-text: #ffffff;
                    }
                }
            </style>
            <div id="tableReextractDialog">
                <h3 style="margin-top: 0;">テーブル再抽出設定</h3>

                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 6px; font-weight: bold;">抽出方式:</label>
                    <div class="trd-mode-selector">
                        <label>
                            <input type="radio" name="trdMode" value="roi" checked />
                            ROI 自動抽出
                        </label>
                        <label>
                            <input type="radio" name="trdMode" value="grid" />
                            グリッド指定（従来）
                        </label>
                        <label>
                            <input type="radio" name="trdMode" value="ai" />
                            AI 抽出
                        </label>
                    </div>
                </div>

                <div id="trdRoiSection" style="margin-bottom: 15px;">
                    <div class="trd-ai-info">
                        <strong>選択段落の bbox 全体をひとつのテーブル領域として行・列を自動検出します。</strong><br>
                        行数・列数はヒントとして使用します（0 または空欄で自動推定）。
                    </div>
                </div>

                <div id="trdGridSection" style="display: none;">
                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">ヘッダ（カンマ区切り）:</label>
                        <input type="text" id="tableHeaderInput" value="${headerText || ''}" />
                        <small class="trd-hint">列見出しをカンマで区切って入力（例: Weapon,Damage,Price）</small>
                    </div>
                </div>

                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 5px; font-weight: bold;">行数:</label>
                    <input type="number" id="tableRowsInput" value="${guessedRows}" min="1" />
                    <small class="trd-hint">テーブルの行数（ROI / AI モードではヒントとして使用）</small>
                </div>
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 5px; font-weight: bold;">列数:</label>
                    <input type="number" id="tableColsInput" value="${guessedCols}" min="1" />
                    <small class="trd-hint">テーブルの列数（ROI / AI モードではヒントとして使用）</small>
                </div>
                <div id="trdGuessRow" style="margin-bottom: 15px;">
                    <div class="trd-guess">
                        <strong>推測値:</strong> ${guessedRows}行 × ${guessedCols}列
                    </div>
                </div>

                <div id="trdAiSection" style="display: none; margin-bottom: 15px;">
                    <div class="trd-ai-info">
                        <strong>AI を使って表領域の画像を認識し、各行をパイプ区切りの段落として追加します。</strong><br>
                        ${aiHint}
                    </div>
                </div>

                <div class="trd-actions">
                    <button id="tableDialogPreview" class="trd-btn" style="display: none;">枠線描画</button>
                    <button id="tableDialogCancel" class="trd-btn">キャンセル</button>
                    <button id="tableDialogOK" class="trd-btn trd-btn-primary">OK</button>
                </div>
            </div>
            <div id="tableReextractDialogOverlay"></div>
        `;

        // ダイアログを表示
        const container = document.createElement('div');
        container.innerHTML = dialogHTML;
        document.body.appendChild(container);

        const overlay = document.getElementById('tableReextractDialogOverlay');
        const rowsInput = document.getElementById('tableRowsInput');
        const colsInput = document.getElementById('tableColsInput');
        const headerInput = document.getElementById('tableHeaderInput');
        const okButton = document.getElementById('tableDialogOK');
        const cancelButton = document.getElementById('tableDialogCancel');
        const previewButton = document.getElementById('tableDialogPreview');
        const roiSection = document.getElementById('trdRoiSection');
        const gridSection = document.getElementById('trdGridSection');
        const aiSection = document.getElementById('trdAiSection');

        // モード切替ハンドラ
        const modeRadios = container.querySelectorAll('input[name="trdMode"]');
        const updateMode = () => {
            const mode = container.querySelector('input[name="trdMode"]:checked')?.value || 'roi';
            roiSection.style.display = mode === 'roi' ? '' : 'none';
            gridSection.style.display = mode === 'grid' ? '' : 'none';
            aiSection.style.display = mode === 'ai' ? '' : 'none';
            previewButton.style.display = mode === 'grid' ? '' : 'none';
            if (mode === 'grid') {
                setTimeout(() => headerInput.focus(), 50);
            }
        };
        modeRadios.forEach((r) => r.addEventListener('change', updateMode));

        const cleanup = () => {
            document.body.removeChild(container);
        };

        const getSelectedMode = () =>
            container.querySelector('input[name="trdMode"]:checked')?.value || 'roi';

        const resolveValues = () => {
            const mode = getSelectedMode();
            const rows = parseInt(rowsInput.value, 10) || guessedRows;
            const colsRaw = parseInt(colsInput.value, 10) || guessedCols;

            if (mode === 'roi') {
                return { mode: 'roi', rows, cols: colsRaw };
            }

            if (mode === 'ai') {
                return { mode: 'ai', rows, cols: colsRaw };
            }

            const headerTextValue = headerInput.value.trim();

            let cols = colsRaw;
            let finalHeaderText = null;

            if (headerTextValue && headerTextValue.includes(',')) {
                finalHeaderText = headerTextValue;
                const segmentCount = headerTextValue.split(',').filter(s => s.trim()).length;
                cols = segmentCount > 0 ? segmentCount : colsRaw;
            }

            return { mode: 'grid', rows, cols, finalHeaderText };
        };

        const handleOK = () => {
            const values = resolveValues();
            cleanup();
            resolve(values);
        };

        const handleCancel = () => {
            cleanup();
            resolve(null);
        };

        const handlePreview = async () => {
            if (!Array.isArray(paragraphIds) || paragraphIds.length === 0) {
                return;
            }
            const values = resolveValues();
            try {
                const response = await fetch(`/api/table_grid_suggest/${encodePdfNamePath(pdfName)}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        current_page: pageNumber,
                        paragraph_ids: paragraphIds,
                        rows: values.rows,
                        cols: values.cols,
                        header_text: values.finalHeaderText,
                    })
                });

                const data = await response.json();
                if (data.status !== 'ok') {
                    alert(`表グリッド推測エラー: ${data.message || 'unknown'}`);
                    return;
                }

                const previewRects = Array.isArray(data.preview_cell_rects) ? data.preview_cell_rects : [];
                if (previewRects.length > 0 && typeof highlightRectsOnPage === 'function') {
                    highlightRectsOnPage(pageNumber, previewRects);
                }
            } catch (error) {
                console.error('table grid preview error:', error);
                alert('枠線描画中にエラーが発生しました');
            }
        };

        // イベントリスナー
        okButton.addEventListener('click', handleOK);
        cancelButton.addEventListener('click', handleCancel);
        previewButton.addEventListener('click', handlePreview);
        overlay.addEventListener('click', handleCancel);

        // Enterキーで確定、Escapeキーでキャンセル
        const handleKeyDown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleOK();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                handleCancel();
            }
        };

        rowsInput.addEventListener('keydown', handleKeyDown);
        colsInput.addEventListener('keydown', handleKeyDown);
        headerInput.addEventListener('keydown', handleKeyDown);
    });
}
