// ========== Browser Panel ==========
// Depends on window.IDE (set by app.js)

(function () {
  const IDE = window.IDE;

  const browserWebview = document.getElementById('browser-webview');
  const browserUrl = document.getElementById('browser-url');
  const browserGo = document.getElementById('browser-go');
  const browserBack = document.getElementById('browser-back');
  const browserForward = document.getElementById('browser-forward');
  const browserReload = document.getElementById('browser-reload');
  const browserInspect = document.getElementById('browser-inspect');
  const browserAnnotate = document.getElementById('browser-annotate');
  const browserCapture = document.getElementById('browser-capture');
  const browserClear = document.getElementById('browser-clear');
  const browserOverlay = document.getElementById('browser-overlay');
  const browserSelectionBox = document.getElementById('browser-selection-box');
  const browserAgentBar = document.getElementById('browser-agent-bar');
  const browserAgentPrompt = document.getElementById('browser-agent-prompt');
  const browserAgentTarget = document.getElementById('browser-agent-target');
  const browserAgentSend = document.getElementById('browser-agent-send');
  const browserAgentCancel = document.getElementById('browser-agent-cancel');

  // State
  let _browserMode = 'browse';
  let _browserScreenshotData = null;
  let _selectedElementInfo = null;
  let _selectStart = null;
  let _annotations = [];

  // ---- Navigation ----
  function navigateBrowser(input) {
    let url = input.trim();
    if (!url) return;
    if (!url.match(/^https?:\/\//)) {
      if (url.match(/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|(\d{1,3}\.){3}\d{1,3})(:\d+)?/)) {
        url = 'http://' + url;
      } else {
        url = 'https://' + url;
      }
    }
    browserWebview.src = url;
  }

  if (browserUrl) {
    browserUrl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); navigateBrowser(browserUrl.value); }
    });
  }
  if (browserGo) {
    browserGo.addEventListener('click', () => navigateBrowser(browserUrl.value));
  }

  if (browserWebview) {
    browserWebview.addEventListener('did-navigate', (e) => {
      browserUrl.value = e.url;
      IDE.saveSettings({ browserUrl: e.url });
    });
    browserWebview.addEventListener('did-navigate-in-page', (e) => {
      if (e.isMainFrame) {
        browserUrl.value = e.url;
        IDE.saveSettings({ browserUrl: e.url });
      }
    });

    browserWebview.addEventListener('did-fail-load', (e) => {
      if (e.errorCode === -3) return;
      const errorPage = `
        <html><body style="font-family:-apple-system,sans-serif;background:#1a1a2e;color:#e0e0e0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
          <div style="text-align:center;max-width:500px;padding:40px;">
            <div style="font-size:48px;margin-bottom:16px;">&#x26A0;</div>
            <h2 style="color:#e74c3c;margin-bottom:8px;">Failed to load</h2>
            <p style="color:#bbb;margin-bottom:12px;">${e.validatedURL || ''}</p>
            <p style="color:#888;font-size:14px;">${e.errorDescription || 'Unknown error'} (code ${e.errorCode})</p>
          </div>
        </body></html>`;
      browserWebview.executeJavaScript(`document.open();document.write(${JSON.stringify(errorPage)});document.close();`).catch(() => {});
    });

    browserWebview.addEventListener('did-navigate', (e) => {
      if (!e.httpResponseCode) return;
      if (e.httpResponseCode >= 400) {
        browserWebview.executeJavaScript(`
          (function() {
            let banner = document.getElementById('__dan_ide_error_banner__');
            if (!banner) {
              banner = document.createElement('div');
              banner.id = '__dan_ide_error_banner__';
              banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#e74c3c;color:white;padding:6px 12px;font:13px -apple-system,sans-serif;z-index:2147483647;text-align:center;';
              document.body.prepend(banner);
            }
            banner.textContent = 'HTTP ${e.httpResponseCode} — ${e.httpStatusText || 'Error'}';
            setTimeout(() => banner.remove(), 8000);
          })();
        `).catch(() => {});
      }
    });
  }

  if (browserBack) browserBack.addEventListener('click', () => { if (browserWebview.canGoBack()) browserWebview.goBack(); });
  if (browserForward) browserForward.addEventListener('click', () => { if (browserWebview.canGoForward()) browserWebview.goForward(); });
  if (browserReload) browserReload.addEventListener('click', () => browserWebview.reload());

  // Enable standard browser right-click context menu on webview
  if (browserWebview) {
    browserWebview.addEventListener('context-menu', (e) => {
      e.preventDefault();
      const params = e.params;
      const items = [];
      if (params.linkURL) {
        items.push({ label: 'Open Link', click: () => browserWebview.loadURL(params.linkURL) });
        items.push({ label: 'Copy Link', click: () => navigator.clipboard.writeText(params.linkURL) });
        items.push(null);
      }
      if (params.selectionText) {
        items.push({ label: 'Copy', click: () => browserWebview.copy() });
        items.push(null);
      }
      if (params.isEditable) {
        items.push({ label: 'Cut', click: () => browserWebview.cut() });
        items.push({ label: 'Copy', click: () => browserWebview.copy() });
        items.push({ label: 'Paste', click: () => browserWebview.paste() });
        items.push(null);
      }
      items.push({ label: 'Back', click: () => browserWebview.goBack(), enabled: browserWebview.canGoBack() });
      items.push({ label: 'Forward', click: () => browserWebview.goForward(), enabled: browserWebview.canGoForward() });
      items.push({ label: 'Reload', click: () => browserWebview.reload() });
      items.push(null);
      items.push({ label: 'Inspect Element', click: () => browserWebview.inspectElement(params.x, params.y) });

      // Build and show a simple context menu
      showBrowserContextMenu(e.params.x, e.params.y, items);
    });
  }

  function showBrowserContextMenu(x, y, items) {
    // Remove any existing menu
    const existing = document.getElementById('browser-context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'browser-context-menu';
    menu.style.cssText = `position:fixed;z-index:10000;background:#252530;border:1px solid #3a3a5a;border-radius:6px;padding:4px 0;min-width:160px;box-shadow:0 4px 12px rgba(0,0,0,0.4);font-size:12px;`;
    // Position relative to browser panel
    const panelRect = document.getElementById('browser-content').getBoundingClientRect();
    menu.style.left = (panelRect.left + x) + 'px';
    menu.style.top = (panelRect.top + y) + 'px';

    for (const item of items) {
      if (item === null) {
        const sep = document.createElement('div');
        sep.style.cssText = 'height:1px;background:#3a3a5a;margin:4px 0;';
        menu.appendChild(sep);
      } else {
        const el = document.createElement('div');
        el.textContent = item.label;
        el.style.cssText = `padding:6px 14px;cursor:pointer;color:${item.enabled === false ? '#555' : '#ddd'};`;
        if (item.enabled !== false) {
          el.addEventListener('mouseenter', () => { el.style.background = '#0f3460'; });
          el.addEventListener('mouseleave', () => { el.style.background = ''; });
          el.addEventListener('click', () => { item.click(); menu.remove(); });
        }
        menu.appendChild(el);
      }
    }

    document.body.appendChild(menu);
    const dismiss = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', dismiss); } };
    setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
  }

  // ---- Mode Management ----
  function setActiveToolBtn(btn) {
    document.querySelectorAll('#browser-toolbar .browser-tool-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
  }

  function exitBrowserMode() {
    _browserMode = 'browse';
    setActiveToolBtn(null);
    browserOverlay.classList.add('hidden');
    browserOverlay.classList.remove('active', 'annotating');
    browserSelectionBox.classList.add('hidden');
    if (browserWebview && browserWebview.src !== 'about:blank') {
      browserWebview.executeJavaScript(`
        (function() {
          const hl = document.getElementById('__dan_ide_highlight__');
          if (hl) hl.remove();
          document.removeEventListener('mousemove', window.__danIdeInspectMove);
          document.removeEventListener('click', window.__danIdeInspectClick, true);
          document.body.style.cursor = '';
        })();
      `).catch(() => {});
    }
  }

  // ---- Inspect (Select Element) ----
  if (browserInspect) {
    browserInspect.addEventListener('click', () => {
      if (_browserMode === 'inspect') { exitBrowserMode(); return; }
      exitBrowserMode();
      _browserMode = 'inspect';
      setActiveToolBtn(browserInspect);
      _selectedElementInfo = null;

      if (!browserWebview || browserWebview.src === 'about:blank') {
        IDE.showToast('Navigate to a page first');
        exitBrowserMode();
        return;
      }

      browserWebview.executeJavaScript(`
        (function() {
          let hl = document.getElementById('__dan_ide_highlight__');
          if (!hl) {
            hl = document.createElement('div');
            hl.id = '__dan_ide_highlight__';
            hl.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #3498db;background:rgba(52,152,219,0.1);z-index:2147483647;transition:all 0.05s;display:none;';
            document.body.appendChild(hl);
          }
          hl.style.display = 'none';
          document.body.style.cursor = 'crosshair';

          window.__danIdeInspectMove = function(e) {
            const el = document.elementFromPoint(e.clientX, e.clientY);
            if (!el || el === hl) return;
            const r = el.getBoundingClientRect();
            hl.style.display = 'block';
            hl.style.left = r.left + 'px';
            hl.style.top = r.top + 'px';
            hl.style.width = r.width + 'px';
            hl.style.height = r.height + 'px';
          };
          document.addEventListener('mousemove', window.__danIdeInspectMove);

          window.__danIdeInspectClick = function(e) {
            e.preventDefault();
            e.stopPropagation();
            const el = document.elementFromPoint(e.clientX, e.clientY);
            if (!el || el.id === '__dan_ide_highlight__') return;

            function getSelector(node) {
              if (node.id) return '#' + node.id;
              let path = node.tagName.toLowerCase();
              if (node.className && typeof node.className === 'string') {
                path += '.' + node.className.trim().split(/\\s+/).join('.');
              }
              return path;
            }

            const r = el.getBoundingClientRect();
            const info = {
              selector: getSelector(el),
              tagName: el.tagName.toLowerCase(),
              outerHTML: el.outerHTML.slice(0, 2000),
              text: (el.innerText || '').slice(0, 500),
              rect: { x: r.x, y: r.y, width: r.width, height: r.height },
            };

            hl.remove();
            document.removeEventListener('mousemove', window.__danIdeInspectMove);
            document.removeEventListener('click', window.__danIdeInspectClick, true);
            document.body.style.cursor = '';
            window.__danIdeSelectedElement = info;
          };
          document.addEventListener('click', window.__danIdeInspectClick, true);
        })();
      `).catch(() => {});

      const pollId = setInterval(async () => {
        if (_browserMode !== 'inspect') { clearInterval(pollId); return; }
        try {
          const info = await browserWebview.executeJavaScript('window.__danIdeSelectedElement');
          if (info) {
            clearInterval(pollId);
            await browserWebview.executeJavaScript('delete window.__danIdeSelectedElement;');
            _selectedElementInfo = info;
            _browserMode = 'browse';
            setActiveToolBtn(null);
            showAgentBarWithElement(info);
          }
        } catch {}
      }, 200);
    });
  }

  function refreshAgentDropdown() {
    if (!browserAgentTarget) return;
    const current = browserAgentTarget.value;
    browserAgentTarget.innerHTML = '';

    // Show only agents matching current view mode (same as header tabs)
    const viewMode = IDE.state ? IDE.state.viewMode : 'single';
    let visibleIds;
    if (viewMode === 'global') {
      visibleIds = Array.from(IDE.sessions.keys());
    } else {
      // project or single — show only current project's agents
      const projectId = IDE.state ? IDE.state.activeProjectId : null;
      visibleIds = [];
      for (const [id, entry] of IDE.sessions) {
        if (entry.meta && entry.meta.projectId === projectId) visibleIds.push(id);
      }
    }

    // Active session first
    if (IDE.activeSessionId && visibleIds.includes(IDE.activeSessionId)) {
      const entry = IDE.sessions.get(IDE.activeSessionId);
      const name = entry && entry.meta ? entry.meta.name : IDE.activeSessionId;
      const opt = document.createElement('option');
      opt.value = IDE.activeSessionId;
      opt.textContent = name;
      browserAgentTarget.appendChild(opt);
    }
    for (const id of visibleIds) {
      if (id === IDE.activeSessionId) continue;
      const entry = IDE.sessions.get(id);
      const m = entry.meta || entry;
      if (m.status === 'stopped') continue;
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = m.name || id;
      browserAgentTarget.appendChild(opt);
    }

    if (browserAgentTarget.options.length === 0) {
      const noOpt = document.createElement('option');
      noOpt.value = '';
      noOpt.textContent = 'No agents running';
      noOpt.disabled = true;
      browserAgentTarget.appendChild(noOpt);
    }

    if (current && browserAgentTarget.querySelector(`option[value="${current}"]`)) {
      browserAgentTarget.value = current;
    }
  }

  function showAgentBarWithElement(info) {
    refreshAgentDropdown();
    browserAgentBar.classList.remove('hidden');
    const selectorEl = document.getElementById('browser-selected-selector');
    const previewEl = document.getElementById('browser-selected-preview');
    if (selectorEl) selectorEl.textContent = info.selector;
    if (previewEl) previewEl.textContent = info.outerHTML.slice(0, 400);
    document.getElementById('browser-selected-info').style.display = 'flex';
    document.getElementById('browser-selected-preview').style.display = 'block';
    browserAgentPrompt.placeholder = 'Describe what you want the agent to do with this element...';
    browserAgentPrompt.focus();
  }

  function showAgentBarWithCapture() {
    refreshAgentDropdown();
    browserAgentBar.classList.remove('hidden');
    document.getElementById('browser-selected-info').style.display = 'none';
    const previewEl = document.getElementById('browser-selected-preview');
    if (previewEl && _browserScreenshotData) {
      previewEl.style.display = 'block';
      previewEl.innerHTML = `<img src="${_browserScreenshotData}" style="max-width:100%;max-height:120px;border-radius:4px;display:block;">`;
    } else if (previewEl) {
      previewEl.style.display = 'none';
    }
    browserAgentPrompt.placeholder = 'Describe what you want the agent to do with this capture...';
    browserAgentPrompt.focus();
  }

  // Copy selector button
  const browserSelectedCopy = document.getElementById('browser-selected-copy');
  if (browserSelectedCopy) {
    browserSelectedCopy.addEventListener('click', () => {
      const sel = document.getElementById('browser-selected-selector');
      if (sel && sel.textContent) {
        navigator.clipboard.writeText(sel.textContent);
        IDE.showToast('Selector copied');
      }
    });
  }

  // ---- Annotate Mode ----
  if (browserAnnotate) {
    browserAnnotate.addEventListener('click', () => {
      if (_browserMode === 'annotate') { exitBrowserMode(); return; }
      exitBrowserMode();
      _browserMode = 'annotate';
      setActiveToolBtn(browserAnnotate);
      browserOverlay.classList.remove('hidden');
      browserOverlay.classList.add('active', 'annotating');
      resizeOverlay();
    });
  }

  // ---- Capture Mode ----
  if (browserCapture) {
    browserCapture.addEventListener('click', () => {
      if (_browserMode === 'capture') { exitBrowserMode(); return; }
      exitBrowserMode();
      _browserMode = 'capture';
      setActiveToolBtn(browserCapture);
      browserOverlay.classList.remove('hidden');
      browserOverlay.classList.add('active');
      browserOverlay.classList.remove('annotating');
      IDE.showToast('Drag to select a region, or click "→ Agent" for full page');
    });
  }

  // ---- Clear Button ----
  if (browserClear) {
    browserClear.addEventListener('click', () => {
      _annotations = [];
      _browserScreenshotData = null;
      _selectedElementInfo = null;
      _selectStart = null;
      clearOverlay();
      browserAgentBar.classList.add('hidden');
      browserAgentPrompt.value = '';
      browserSelectionBox.classList.add('hidden');
      browserSelectionBox.style.width = '0';
      browserSelectionBox.style.height = '0';
      exitBrowserMode();
      IDE.showToast('Cleared');
    });
  }

  // ---- Overlay Helpers ----
  function resizeOverlay() {
    const content = document.getElementById('browser-content');
    if (!content || !browserOverlay) return;
    const rect = content.getBoundingClientRect();
    browserOverlay.width = rect.width * window.devicePixelRatio;
    browserOverlay.height = rect.height * window.devicePixelRatio;
    browserOverlay.style.width = rect.width + 'px';
    browserOverlay.style.height = rect.height + 'px';
  }

  function clearOverlay() {
    resizeOverlay();
    const ctx = browserOverlay.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, browserOverlay.width, browserOverlay.height);
  }

  // ---- Overlay Mouse Events ----
  if (browserOverlay) {
    let _drawing = false;
    let _lastX = 0, _lastY = 0;

    browserOverlay.addEventListener('mousedown', (e) => {
      const rect = browserOverlay.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (_browserMode === 'capture') {
        _selectStart = { x: e.clientX, y: e.clientY };
        browserSelectionBox.classList.remove('hidden');
        browserSelectionBox.style.left = x + 'px';
        browserSelectionBox.style.top = y + 'px';
        browserSelectionBox.style.width = '0';
        browserSelectionBox.style.height = '0';
      } else if (_browserMode === 'annotate') {
        _drawing = true;
        _lastX = x;
        _lastY = y;
      }
    });

    browserOverlay.addEventListener('mousemove', (e) => {
      const rect = browserOverlay.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (_browserMode === 'capture' && _selectStart) {
        const sx = Math.min(_selectStart.x - rect.left, x);
        const sy = Math.min(_selectStart.y - rect.top, y);
        const sw = Math.abs(e.clientX - _selectStart.x);
        const sh = Math.abs(e.clientY - _selectStart.y);
        browserSelectionBox.style.left = sx + 'px';
        browserSelectionBox.style.top = sy + 'px';
        browserSelectionBox.style.width = sw + 'px';
        browserSelectionBox.style.height = sh + 'px';
      } else if (_browserMode === 'annotate' && _drawing) {
        const ctx = browserOverlay.getContext('2d');
        const dpr = window.devicePixelRatio;
        ctx.strokeStyle = '#e74c3c';
        ctx.lineWidth = 3 * dpr;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(_lastX * dpr, _lastY * dpr);
        ctx.lineTo(x * dpr, y * dpr);
        ctx.stroke();
        _annotations.push({ x1: _lastX, y1: _lastY, x2: x, y2: y });
        _lastX = x;
        _lastY = y;
      }
    });

    browserOverlay.addEventListener('mouseup', async (e) => {
      if (_browserMode === 'capture' && _selectStart) {
        const rect = browserOverlay.getBoundingClientRect();
        const sx = Math.min(_selectStart.x, e.clientX) - rect.left;
        const sy = Math.min(_selectStart.y, e.clientY) - rect.top;
        const sw = Math.abs(e.clientX - _selectStart.x);
        const sh = Math.abs(e.clientY - _selectStart.y);
        _selectStart = null;

        if (sw > 10 && sh > 10) {
          try {
            const img = await browserWebview.capturePage();
            const size = img.getSize();
            if (!size || size.width === 0) {
              _browserScreenshotData = img.toDataURL();
              if (_annotations.length > 0) {
                _browserScreenshotData = await compositeAnnotations(_browserScreenshotData);
              }
              browserSelectionBox.classList.add('hidden');
              exitBrowserMode();
              showAgentBarWithCapture();
              return;
            }
            const fullDataUrl = img.toDataURL();
            const webviewRect = browserWebview.getBoundingClientRect();
            const dpr = size.width / webviewRect.width;
            const cropCanvas = document.createElement('canvas');
            cropCanvas.width = Math.round(sw * dpr);
            cropCanvas.height = Math.round(sh * dpr);
            const cropCtx = cropCanvas.getContext('2d');
            const tempImg = new Image();
            tempImg.onload = async () => {
              cropCtx.drawImage(tempImg, Math.round(sx * dpr), Math.round(sy * dpr), Math.round(sw * dpr), Math.round(sh * dpr), 0, 0, Math.round(sw * dpr), Math.round(sh * dpr));
              _browserScreenshotData = cropCanvas.toDataURL('image/png');
              if (_annotations.length > 0) {
                _browserScreenshotData = await compositeAnnotations(_browserScreenshotData, { x: sx, y: sy, w: sw, h: sh });
              }
              browserSelectionBox.classList.add('hidden');
              exitBrowserMode();
              showAgentBarWithCapture();
            };
            tempImg.onerror = () => {
              _browserScreenshotData = fullDataUrl;
              browserSelectionBox.classList.add('hidden');
              exitBrowserMode();
              showAgentBarWithCapture();
            };
            tempImg.src = fullDataUrl;
            return;
          } catch (err) {
            IDE.showToast('Capture failed: ' + err.message);
          }
        }
        browserSelectionBox.classList.add('hidden');
        exitBrowserMode();
      } else if (_browserMode === 'annotate') {
        _drawing = false;
      }
    });
  }

  function compositeAnnotations(dataUrl, cropOffset) {
    return new Promise((resolve) => {
      const tempImg = new Image();
      tempImg.onload = () => {
        const c = document.createElement('canvas');
        c.width = tempImg.width;
        c.height = tempImg.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(tempImg, 0, 0);
        ctx.strokeStyle = '#e74c3c';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';

        let scaleX, scaleY, offsetX = 0, offsetY = 0;
        if (cropOffset) {
          scaleX = tempImg.width / cropOffset.w;
          scaleY = tempImg.height / cropOffset.h;
          offsetX = cropOffset.x;
          offsetY = cropOffset.y;
        } else {
          const content = document.getElementById('browser-content');
          const rect = content.getBoundingClientRect();
          scaleX = tempImg.width / rect.width;
          scaleY = tempImg.height / rect.height;
        }

        for (const a of _annotations) {
          ctx.beginPath();
          ctx.moveTo((a.x1 - offsetX) * scaleX, (a.y1 - offsetY) * scaleY);
          ctx.lineTo((a.x2 - offsetX) * scaleX, (a.y2 - offsetY) * scaleY);
          ctx.stroke();
        }
        resolve(c.toDataURL('image/png'));
      };
      tempImg.src = dataUrl;
    });
  }

  // Ctrl+Enter in prompt triggers send
  if (browserAgentPrompt) {
    browserAgentPrompt.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (browserAgentSend) browserAgentSend.click();
      }
    });
  }

  // ---- Agent Send Action ----
  if (browserAgentSend) {
    browserAgentSend.addEventListener('click', async () => {
      const prompt = browserAgentPrompt.value.trim();
      if (!prompt) { IDE.showToast('Enter a prompt describing what to do'); return; }

      const project = IDE.projects.find((p) => p.id === IDE.activeProjectId);
      if (!project) { IDE.showToast('No project selected'); return; }

      let screenshotPath = '';
      if (_browserScreenshotData) {
        screenshotPath = await window.api.saveScreenshot(IDE.activeProjectId, _browserScreenshotData, null);
      }

      let contextMsg = '';
      if (_selectedElementInfo) {
        contextMsg += `Selected element: ${_selectedElementInfo.selector}\nHTML: ${_selectedElementInfo.outerHTML.slice(0, 1000)}\n`;
        if (_selectedElementInfo.text) contextMsg += `Text content: ${_selectedElementInfo.text.slice(0, 300)}\n`;
      }
      if (screenshotPath) contextMsg += `Screenshot: ${screenshotPath}\n`;
      contextMsg += `\n${prompt}`;

      const targetSessionId = browserAgentTarget.value;
      if (!targetSessionId) { IDE.showToast('No agent selected — start an agent first'); return; }

      window.api.writeSession(targetSessionId, contextMsg + '\n');
      setTimeout(() => window.api.writeSession(targetSessionId, '\r'), 200);
      const targetEntry = IDE.sessions.get(targetSessionId);
      const targetName = targetEntry && targetEntry.meta ? targetEntry.meta.name : 'agent';
      IDE.showToast(`Sent to ${targetName}`);

      browserAgentBar.classList.add('hidden');
      browserAgentPrompt.value = '';
      _browserScreenshotData = null;
      _selectedElementInfo = null;
      _annotations = [];
      clearOverlay();
      browserSelectionBox.classList.add('hidden');
      exitBrowserMode();
    });
  }

  if (browserAgentCancel) {
    browserAgentCancel.addEventListener('click', () => {
      browserAgentBar.classList.add('hidden');
      browserAgentPrompt.value = '';
      _browserScreenshotData = null;
      _selectedElementInfo = null;
      _selectStart = null;
      browserSelectionBox.classList.add('hidden');
      browserSelectionBox.style.width = '0';
      browserSelectionBox.style.height = '0';
    });
  }

  // Expose for app.js to call
  window.IDE.browser = {
    navigateBrowser,
    refreshAgentDropdown,
    exitBrowserMode,
  };
})();
