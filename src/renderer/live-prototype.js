// ========== Live Prototype Panel ==========
// Tabbed layout: "Listening" tab + prototype build tabs
// Listening tab has two columns: Transcript (left) and Thinking (right)

(function () {
  const IDE = window.IDE;

  // State
  let _listening = false;
  let _status = {};
  let _transcriptChunks = [];
  let _paragraphs = [];
  let _thoughts = [];
  let _proposal = null;
  let _attachments = [];
  let _mediaStream = null;
  let _audioContext = null;
  let _audioProcessor = null;
  let _activeTab = 'listening';
  let _prototypeTabs = []; // { id, name, status, url, log: [] }

  // ---- DOM Elements ----
  const tabBar = document.getElementById('prototype-tabs');
  const modeSelect = document.getElementById('prototype-mode-select');
  const listenBtn = document.getElementById('prototype-listen-btn');
  const statusLabel = document.getElementById('prototype-status-label');
  const transcriptList = document.getElementById('prototype-transcript-list');
  const thinkingList = document.getElementById('prototype-thinking-list');
  const feedInput = document.getElementById('prototype-feed-input');
  const feedSend = document.getElementById('prototype-feed-send');
  const answersBar = document.getElementById('prototype-answers-bar');
  const answersInput = document.getElementById('prototype-answers-input');
  const answersSend = document.getElementById('prototype-answers-send');
  const proposalArea = document.getElementById('prototype-proposal-area');
  const proposalName = document.getElementById('prototype-proposal-name');
  const proposalDesc = document.getElementById('prototype-proposal-desc');
  const attachmentsEl = document.getElementById('prototype-attachments');
  const attachDocBtn = document.getElementById('prototype-attach-doc');
  const attachScreenshotBtn = document.getElementById('prototype-attach-screenshot');
  const dismissBtn = document.getElementById('prototype-dismiss-btn');
  const buildBtn = document.getElementById('prototype-build-btn');

  // ---- Paragraph Organizer ----
  // Groups transcript chunks into paragraphs based on time gaps
  function organizeIntoParagraphs(chunks) {
    if (chunks.length === 0) return [];
    const GAP_MS = 4000; // 4 second gap = new paragraph
    const paragraphs = [];
    let current = { startTime: chunks[0].timestamp, texts: [chunks[0].text] };

    for (let i = 1; i < chunks.length; i++) {
      const gap = chunks[i].timestamp - chunks[i - 1].timestamp;
      if (gap > GAP_MS) {
        paragraphs.push(current);
        current = { startTime: chunks[i].timestamp, texts: [chunks[i].text] };
      } else {
        current.texts.push(chunks[i].text);
      }
    }
    paragraphs.push(current);
    return paragraphs;
  }

  // ---- Audio Capture ----
  async function startAudioCapture(mode) {
    try {
      if (mode === 'system-audio') {
        const sources = await window.api.getDesktopSources();
        if (!sources || sources.length === 0) {
          IDE.showToast('No screen sources available. Grant Screen Recording permission in System Settings > Privacy & Security.');
          return false;
        }
        const screenSource = sources.find(s => s.name === 'Entire Screen') || sources[0];
        _mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: screenSource.id,
            }
          },
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: screenSource.id,
              maxWidth: 1,
              maxHeight: 1,
            }
          }
        });
        _mediaStream.getVideoTracks().forEach(t => t.stop());
      } else {
        _mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            sampleRate: 16000,
            echoCancellation: true,
            noiseSuppression: true,
          }
        });
      }

      _audioContext = new AudioContext({ sampleRate: 16000 });
      const source = _audioContext.createMediaStreamSource(_mediaStream);
      _audioProcessor = _audioContext.createScriptProcessor(4096, 1, 1);
      _audioProcessor.onaudioprocess = (e) => {
        if (!_listening) return;
        const float32 = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          const s = Math.max(-1, Math.min(1, float32[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        window.api.livePrototypeSendAudio(int16.buffer);
      };
      source.connect(_audioProcessor);
      _audioProcessor.connect(_audioContext.destination);
      return true;
    } catch (err) {
      if (mode === 'microphone') {
        IDE.showToast('Microphone access denied. Enable in System Settings > Privacy & Security > Microphone.');
      } else {
        IDE.showToast(`System audio capture failed: ${err.message}`);
      }
      return false;
    }
  }

  function stopAudioCapture() {
    if (_audioProcessor) { _audioProcessor.disconnect(); _audioProcessor = null; }
    if (_audioContext) { _audioContext.close(); _audioContext = null; }
    if (_mediaStream) { _mediaStream.getTracks().forEach(t => t.stop()); _mediaStream = null; }
  }

  // ---- Toggle Listening ----
  async function toggleListening() {
    const mode = modeSelect ? modeSelect.value : 'manual';
    if (_listening) {
      await window.api.livePrototypeStop();
      stopAudioCapture();
      _listening = false;
    } else {
      if (mode === 'system-audio' || mode === 'microphone') {
        const ok = await startAudioCapture(mode);
        if (!ok) return;
      }
      await window.api.livePrototypeStart(mode);
      _listening = true;
    }
    updateUI();
  }

  // ---- Feed transcript manually ----
  function feedText() {
    const text = feedInput.value.trim();
    if (!text) return;
    window.api.livePrototypeFeed(text, null);
    feedInput.value = '';
  }

  // ---- Send answers/clarifications ----
  function sendAnswer() {
    const text = answersInput.value.trim();
    if (!text) return;
    window.api.livePrototypeFeed(`[CLARIFICATION]: ${text}`, 'user');
    answersInput.value = '';
  }

  // ---- Confirm Build ----
  async function confirmBuild() {
    const editedName = proposalName ? proposalName.value.trim() : null;
    const editedDescription = proposalDesc.value.trim();

    if (_autoConfirmTimer) { clearTimeout(_autoConfirmTimer); _autoConfirmTimer = null; }

    // Create tab immediately in researching state
    const tempId = 'research-' + Date.now();
    const tab = {
      id: tempId,
      name: editedName || 'Prototype',
      status: 'researching',
      researchMessage: 'Director starting...',
      url: null,
      description: editedDescription || (_proposal ? _proposal.description : ''),
      log: [{ time: Date.now(), message: 'Director: spawning subagents (knowledge + researcher)', type: 'phase' }],
    };
    _prototypeTabs.push(tab);
    _proposal = null;
    switchTab(tempId);
    updateTabBar();
    updateUI();

    const result = await window.api.livePrototypeConfirm(editedDescription || null, editedName || null);
    if (result && result.sessionId) {
      // Update the tab with the real session ID — don't override status if events already set it to live
      tab.id = result.sessionId;
      tab.name = result.name || tab.name;
      if (tab.status === 'researching') tab.status = 'building';
      if (result.spec) tab.description = result.spec;
      _activeTab = result.sessionId;
      updateTabBar();
      updateUI();

      // Wire builder session into the Agents pane
      if (IDE.restoreLiveSession) {
        await new Promise(r => setTimeout(r, 800));
        const sessions = await window.api.listAllSessions();
        const meta = sessions.find(s => s.id === result.sessionId);
        if (meta) {
          await IDE.restoreLiveSession(meta, { keepVisible: true });
          IDE.activateSession(result.sessionId);
          IDE.renderDrawer();
          IDE.renderTabs();
          IDE.updateStatusBar();
        }
      }

      // Watch for session exit to reactively update tab
      window.api.onSessionExit(result.sessionId, () => {
        if (tab.status !== 'live') {
          tab.status = 'stopped';
          updateUI();
        }
      });

      IDE.showToast(`Building: ${tab.name}`);
    }
  }

  // ---- Dismiss Proposal ----
  async function dismissProposal() {
    if (_autoConfirmTimer) { clearTimeout(_autoConfirmTimer); _autoConfirmTimer = null; }
    await window.api.livePrototypeDismiss();
    _proposal = null;
    updateUI();
  }

  // ---- Attachments ----
  async function attachDocument() {
    const filePath = await window.api.openFileDialog();
    if (filePath) {
      await window.api.livePrototypeAttach({ type: 'document', path: filePath, name: filePath.split('/').pop() });
      IDE.showToast('Document attached');
    }
  }

  async function attachScreenshot() {
    const webview = document.getElementById('browser-webview');
    if (webview && webview.src !== 'about:blank') {
      try {
        const img = await webview.capturePage();
        const dataUrl = img.toDataURL();
        await window.api.livePrototypeAttach({ type: 'screenshot', dataUrl, name: `screenshot-${Date.now()}.png` });
        IDE.showToast('Screenshot attached');
      } catch {
        IDE.showToast('Failed to capture screenshot');
      }
    } else {
      IDE.showToast('Navigate to a page in Browser panel first');
    }
  }

  // ---- Director Log Helper ----
  function logToActiveTab(message, type) {
    if (_prototypeTabs.length === 0) return;
    const tab = _prototypeTabs[_prototypeTabs.length - 1];
    if (!tab.log) tab.log = [];
    tab.log.push({ time: Date.now(), message, type: type || 'info' });
    if (tab.log.length > 50) tab.log.shift();
    if (_activeTab === tab.id) updateTabContent();
  }

  // ---- Tabs ----
  function switchTab(tabId) {
    _activeTab = tabId;
    updateTabBar();
    updateTabContent();
  }

  function updateTabBar() {
    if (!tabBar) return;
    tabBar.innerHTML = '';

    // Listening tab (always first)
    const listenTab = document.createElement('button');
    listenTab.className = `proto-tab ${_activeTab === 'listening' ? 'active' : ''}`;
    listenTab.dataset.tab = 'listening';
    listenTab.textContent = _listening ? 'Listening...' : 'Listening';
    listenTab.addEventListener('click', () => switchTab('listening'));
    tabBar.appendChild(listenTab);

    // Prototype build tabs
    for (const pt of _prototypeTabs) {
      const tab = document.createElement('button');
      tab.className = `proto-tab ${_activeTab === pt.id ? 'active' : ''}`;
      tab.dataset.tab = pt.id;
      tab.innerHTML = `${pt.name} <span class="proto-tab-close">&times;</span>`;
      tab.addEventListener('click', (e) => {
        if (e.target.classList.contains('proto-tab-close')) {
          _prototypeTabs = _prototypeTabs.filter(t => t.id !== pt.id);
          if (_activeTab === pt.id) switchTab('listening');
          else updateTabBar();
          return;
        }
        switchTab(pt.id);
      });
      tabBar.appendChild(tab);
    }
  }

  function updateTabContent() {
    const listeningContent = document.getElementById('prototype-tab-listening');
    if (!listeningContent) return;

    if (_activeTab === 'listening') {
      listeningContent.classList.add('active');
      document.querySelectorAll('.proto-build-tab-panel').forEach(el => el.remove());
    } else {
      listeningContent.classList.remove('active');
      document.querySelectorAll('.proto-build-tab-panel').forEach(el => el.remove());
      const pt = _prototypeTabs.find(t => t.id === _activeTab);
      if (pt) {
        const panel = document.createElement('div');
        panel.className = 'proto-build-tab-panel proto-tab-content active';

        let statusLabel, dotClass;
        switch (pt.status) {
          case 'live': statusLabel = 'Live'; dotClass = 'live'; break;
          case 'stopped': statusLabel = 'Stopped'; dotClass = 'stopped'; break;
          case 'done': statusLabel = 'Done'; dotClass = 'stopped'; break;
          case 'researching': statusLabel = pt.researchMessage || 'Researching...'; dotClass = 'researching'; break;
          default: statusLabel = 'Building...'; dotClass = 'building'; break;
        }

        const urlHtml = pt.url
          ? `<a href="#" class="proto-build-link" data-url="${pt.url}">${pt.url}</a>`
          : (pt.status === 'stopped' || pt.status === 'done')
            ? '<span class="proto-build-waiting">Server not running</span>'
            : '<span class="proto-build-waiting">Waiting for server...</span>';

        const stopBtnHtml = (pt.status === 'stopped' || pt.status === 'done')
          ? ''
          : '<button class="proto-build-stop-btn">Stop</button>';

        // Subagent status indicators
        let subagentHtml = '';
        if (pt.subagents && Object.keys(pt.subagents).length > 0) {
          const badges = Object.entries(pt.subagents).map(([name, status]) => {
            const stateClass = status === 'complete' ? 'complete' : status === 'failed' ? 'failed' : 'running';
            return `<span class="proto-subagent-badge ${stateClass}">${name}</span>`;
          }).join('');
          subagentHtml = `<div class="proto-subagents-bar">${badges}</div>`;
        }

        // Director activity log
        let logHtml = '';
        if (pt.log && pt.log.length > 0) {
          const entries = pt.log.map(entry => {
            const t = new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const cls = entry.type === 'subagent' ? 'proto-log-subagent' : entry.type === 'phase' ? 'proto-log-phase' : '';
            return `<div class="proto-log-entry ${cls}"><span class="proto-log-time">${t}</span>${entry.message}</div>`;
          }).join('');
          logHtml = `<div class="proto-director-log">${entries}</div>`;
        }

        panel.innerHTML = `
          <div class="proto-build-bar">
            <span class="proto-build-status-dot ${dotClass}"></span>
            <span class="proto-build-status-text">${statusLabel}</span>
            ${subagentHtml}
            <span class="proto-build-url">${urlHtml}</span>
            ${stopBtnHtml}
          </div>
          ${logHtml}
          <div class="proto-build-description">${pt.description || ''}</div>
        `;
        document.getElementById('prototype-panel').appendChild(panel);

        const link = panel.querySelector('.proto-build-link');
        if (link) {
          link.addEventListener('click', (e) => {
            e.preventDefault();
            window.api.openExternal(link.dataset.url);
          });
        }
        const stopBtn = panel.querySelector('.proto-build-stop-btn');
        if (stopBtn) {
          stopBtn.addEventListener('click', () => {
            window.api.livePrototypeStopBuild();
            pt.status = 'stopped';
            pt.url = null;
            updateUI();
          });
        }
      }
    }
  }

  // ---- UI Update ----
  function updateUI() {
    const mode = modeSelect ? modeSelect.value : 'manual';

    // Listen button
    if (listenBtn) {
      listenBtn.textContent = _listening ? 'Stop' : 'Start Listening';
      listenBtn.classList.toggle('active', _listening);
    }

    if (modeSelect) modeSelect.disabled = _listening;

    // Status label
    if (statusLabel) {
      if (_listening) {
        const secs = Math.floor((_status.elapsed || 0) / 1000);
        const mins = Math.floor(secs / 60);
        const secsPart = secs % 60;
        statusLabel.textContent = `Listening ${mins}:${secsPart.toString().padStart(2, '0')}`;
        statusLabel.className = 'proto-status-label listening';
      } else {
        statusLabel.textContent = 'Idle';
        statusLabel.className = 'proto-status-label';
      }
    }

    // Transcript (left column) — organized as paragraphs
    if (transcriptList) {
      _paragraphs = organizeIntoParagraphs(_transcriptChunks);
      if (_paragraphs.length === 0 && _listening) {
        transcriptList.innerHTML = '<div class="proto-paragraph" style="color:#555;font-style:italic;">Waiting for speech...</div>';
      } else {
        transcriptList.innerHTML = _paragraphs.map(p => {
          const time = new Date(p.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          return `<div class="proto-paragraph"><span class="proto-para-time">${time}</span>${p.texts.join(' ')}</div>`;
        }).join('');
      }
      transcriptList.scrollTop = transcriptList.scrollHeight;
    }

    // Thinking (right column)
    if (thinkingList) {
      if (_thoughts.length === 0 && _listening) {
        thinkingList.innerHTML = '<div class="proto-thought"><div class="proto-thought-label">Waiting</div>Analyzing transcript...</div>';
      } else {
        thinkingList.innerHTML = _thoughts.map(t => {
          const time = new Date(t.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          const levelClass = t.level === 'confident' ? 'confident' : t.level === 'interested' ? 'interested' : '';
          let html = `<div class="proto-thought ${levelClass}">`;
          html += `<div class="proto-thought-time">${time}</div>`;
          html += `<div class="proto-thought-label">${t.level}</div>`;
          html += `<div>${t.text}</div>`;
          if (t.questions && t.questions.length > 0) {
            html += `<div class="proto-thought-questions">${t.questions.map(q => '? ' + q).join('<br>')}</div>`;
          }
          html += `</div>`;
          return html;
        }).join('');
      }
      thinkingList.scrollTop = thinkingList.scrollHeight;
    }

    // Show answers bar when thinker is interested and has questions
    if (answersBar) {
      const latestWithQuestions = [..._thoughts].reverse().find(t => t.questions && t.questions.length > 0);
      if (latestWithQuestions && _listening) {
        answersBar.classList.remove('hidden');
      } else {
        answersBar.classList.add('hidden');
      }
    }

    // Proposal area
    if (proposalArea) {
      if (_proposal) {
        proposalArea.classList.remove('hidden');
        if (proposalName && !proposalName.matches(':focus')) {
          proposalName.value = _proposal.suggestedName || '';
        }
        if (proposalDesc && !proposalDesc.matches(':focus')) {
          proposalDesc.value = _proposal.description;
        }
        renderAttachments();
      } else {
        proposalArea.classList.add('hidden');
        if (proposalName) proposalName.value = '';
        if (proposalDesc) proposalDesc.value = '';
      }
    }

    updateTabBar();
    updateStatusPill();
  }

  function updateStatusPill() {
    const pill = document.getElementById('status-prototype');
    if (!pill) return;
    if (_listening || _prototypeTabs.some(t => t.status === 'building')) {
      pill.classList.remove('hidden');
      const label = pill.querySelector('.proto-label');
      const dot = pill.querySelector('.proto-dot');
      if (_prototypeTabs.some(t => t.status === 'building')) {
        label.textContent = 'Building...';
        dot.className = 'proto-dot generating';
      } else if (_listening) {
        label.textContent = 'Listening';
        dot.className = 'proto-dot listening';
      }
    } else {
      pill.classList.add('hidden');
    }
  }

  function renderAttachments() {
    if (!attachmentsEl) return;
    attachmentsEl.innerHTML = '';
    for (let i = 0; i < _attachments.length; i++) {
      const att = _attachments[i];
      const chip = document.createElement('span');
      chip.className = 'proto-attachment-chip';
      chip.innerHTML = `<span class="proto-att-icon">${att.type === 'screenshot' ? '📷' : '📄'}</span> ${att.name || 'file'} <button class="proto-att-remove" data-index="${i}">&times;</button>`;
      attachmentsEl.appendChild(chip);
    }
    attachmentsEl.querySelectorAll('.proto-att-remove').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const idx = parseInt(e.target.dataset.index);
        await window.api.livePrototypeRemoveAttachment(idx);
      });
    });
  }

  // ---- Status Pill ----
  function createStatusPill() {
    const statusBar = document.getElementById('status-bar');
    if (statusBar) {
      const pill = document.createElement('span');
      pill.id = 'status-prototype';
      pill.className = 'prototype-pill hidden';
      pill.innerHTML = '<span class="proto-dot"></span><span class="proto-label">Prototype</span>';
      statusBar.appendChild(pill);
    }
  }

  // ---- Wire Events ----
  if (listenBtn) listenBtn.addEventListener('click', toggleListening);
  if (feedSend) feedSend.addEventListener('click', feedText);
  if (feedInput) feedInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') feedText(); });
  if (answersSend) answersSend.addEventListener('click', sendAnswer);
  if (answersInput) answersInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAnswer(); });
  if (buildBtn) buildBtn.addEventListener('click', confirmBuild);
  if (dismissBtn) dismissBtn.addEventListener('click', dismissProposal);
  if (attachDocBtn) attachDocBtn.addEventListener('click', attachDocument);
  if (attachScreenshotBtn) attachScreenshotBtn.addEventListener('click', attachScreenshot);

  // ---- IPC Event Listeners ----
  window.api.onLivePrototypeState((state) => {
    _status = state;
    _listening = state.listening;
    if (state.pendingProposal) {
      _proposal = state.pendingProposal;
    }
    // Sync prototype tab status from state
    if (_prototypeTabs.length > 0) {
      const lastTab = _prototypeTabs[_prototypeTabs.length - 1];
      const ps = state.prototypeStatus;
      if (ps === 'serving' && lastTab.status !== 'live') {
        lastTab.status = 'live';
        if (state.serverUrl) lastTab.url = state.serverUrl;
      } else if (ps === 'idle' && (lastTab.status === 'building' || lastTab.status === 'researching')) {
        lastTab.status = 'stopped';
      } else if (ps === 'directing' && lastTab.status !== 'researching') {
        lastTab.status = 'researching';
      } else if (ps === 'building' && lastTab.status === 'researching') {
        lastTab.status = 'building';
      }
    }
    updateUI();
  });

  window.api.onLivePrototypeTranscript((chunk) => {
    _transcriptChunks.push(chunk);
    if (_transcriptChunks.length > 500) _transcriptChunks.shift();
    updateUI();
  });

  window.api.onLivePrototypeThought((thought) => {
    _thoughts.push(thought);
    if (_thoughts.length > 100) _thoughts.shift();
    updateUI();
  });

  let _autoConfirmTimer = null;

  window.api.onLivePrototypeProposal((proposal) => {
    _proposal = proposal;
    updateUI();

    // Auto-confirm after 5s countdown (user can dismiss to cancel)
    if (proposal.source === 'thinking') {
      IDE.showToast('Prototype detected — building in 5s (dismiss to cancel)');
      if (_autoConfirmTimer) clearTimeout(_autoConfirmTimer);
      _autoConfirmTimer = setTimeout(() => {
        if (_proposal) confirmBuild();
      }, 5000);
    } else {
      IDE.showToast('Prototype opportunity detected!');
    }
  });

  window.api.onLivePrototypeServerReady((info) => {
    const pt = _prototypeTabs.find(t => t.id === info.sessionId);
    if (pt) {
      pt.status = 'live';
      pt.url = info.url;
    }
    const webview = document.getElementById('browser-webview');
    const urlBar = document.getElementById('browser-url');
    if (webview && info.url) {
      webview.src = info.url;
      if (urlBar) urlBar.value = info.url;
    }
    updateUI();
    IDE.showToast(`Prototype ready: ${info.url}`);
  });

  window.api.onLivePrototypeAttachments((attachments) => {
    _attachments = attachments;
    updateUI();
  });

  window.api.onLivePrototypeError((err) => {
    IDE.showToast(err.message || 'Live prototype error');
  });

  window.api.onLivePrototypePrototypeStatus((status) => {
    if (_prototypeTabs.length > 0) {
      const lastTab = _prototypeTabs[_prototypeTabs.length - 1];
      if (status.status === 'serving') {
        lastTab.status = 'live';
        if (status.serverUrl) lastTab.url = status.serverUrl;
        logToActiveTab(`Server ready: ${status.serverUrl}`, 'phase');
      } else if (status.status === 'idle' || status.status === 'done') {
        if (lastTab.status !== 'live') lastTab.status = 'stopped';
        logToActiveTab('Director finished', 'phase');
      } else if (status.status === 'building') {
        lastTab.status = 'building';
        logToActiveTab(`Phase: ${status.phase || 'Building prototype...'}`, 'phase');
      } else if (status.status === 'directing') {
        lastTab.status = 'researching';
        lastTab.researchMessage = status.phase || 'Directing...';
        logToActiveTab(`Director: ${status.phase || 'Orchestrating...'}`, 'phase');
      }
      updateTabContent();
    }
  });

  window.api.onLivePrototypeSubagent((info) => {
    if (_prototypeTabs.length > 0) {
      const lastTab = _prototypeTabs[_prototypeTabs.length - 1];
      if (!lastTab.subagents) lastTab.subagents = {};
      lastTab.subagents[info.agent] = info.status;
      if (info.agent === 'builder' && info.status === 'serving' && info.url) {
        lastTab.status = 'live';
        lastTab.url = info.url;
      }
      const label = info.output || `${info.agent}: ${info.status}`;
      logToActiveTab(`[${info.agent}] ${label}`, 'subagent');
      updateTabContent();
    }
  });

  // Activity notifications (transcription, thinker, audio pipeline)
  let _activityTimeout = null;
  const activityEl = document.getElementById('prototype-activity-indicator');

  window.api.onLivePrototypeActivity((activity) => {
    if (!activityEl) return;

    let label = '';
    let cls = 'active';
    switch (activity.type) {
      case 'audio-received':
        label = 'Audio streaming...';
        cls = 'active';
        break;
      case 'transcribing':
        label = `Transcribing (${activity.duration}s)...`;
        cls = 'transcribing';
        break;
      case 'transcribed':
        label = `Transcribed: "${activity.text}"`;
        cls = 'active';
        break;
      case 'silence':
        label = 'Silence detected';
        cls = 'active';
        break;
      case 'thinker-running':
        label = 'Thinker analysing...';
        cls = 'thinking';
        break;
      case 'thinker-complete':
        label = 'Thinker done';
        cls = 'thinking';
        break;
      case 'thinker-empty':
        label = 'Thinker: no insight yet';
        cls = 'active';
        break;
      case 'thinker-error':
        label = `Thinker error: ${activity.message || ''}`;
        cls = 'active';
        break;
      case 'transcription-started':
        label = `Transcription started (${activity.mode})`;
        cls = 'active';
        break;
      default:
        label = activity.type;
        cls = 'active';
    }

    activityEl.textContent = label;
    activityEl.className = `proto-activity ${cls}`;
    activityEl.classList.remove('hidden');

    if (_activityTimeout) clearTimeout(_activityTimeout);
    _activityTimeout = setTimeout(() => {
      activityEl.classList.add('hidden');
    }, 8000);
  });

  // ---- Init ----
  createStatusPill();
  updateTabBar();

  // Periodic status refresh (for elapsed timer)
  setInterval(() => {
    if (_listening) {
      window.api.livePrototypeStatus().then((s) => {
        if (s) {
          _status = s;
          updateUI();
        }
      });
    }
  }, 1000);

  // Expose for external use
  window.IDE.livePrototype = {
    toggleListening,
    feedTranscript: (text, speaker) => window.api.livePrototypeFeed(text, speaker),
    getStatus: () => _status,
  };
})();
