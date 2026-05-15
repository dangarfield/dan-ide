// File tree + Monaco editor logic
let monacoEditor = null;
let monacoInstance = null; // the require('monaco') object
let openFiles = new Map(); // path -> { content, model, modified }
let activeFilePath = null;

const fileTreeEl = document.getElementById('file-tree');
const fileTreeSearch = document.getElementById('file-tree-search');
const editorTabsEl = document.getElementById('editor-tabs');
const monacoContainerEl = document.getElementById('monaco-container');

// File tree search/filter
let _lastTreePath = null;
let _treeData = null; // store full tree data for search

if (fileTreeSearch) {
  fileTreeSearch.addEventListener('input', () => {
    const query = fileTreeSearch.value.toLowerCase().trim();
    filterFileTree(query);
  });
  fileTreeSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      // Open the first visible result
      const firstResult = fileTreeEl.querySelector('.tree-search-result');
      if (firstResult) firstResult.click();
    }
    if (e.key === 'Escape') {
      fileTreeSearch.value = '';
      filterFileTree('');
      fileTreeSearch.blur();
    }
  });
}

function filterFileTree(query) {
  if (!query) {
    // Restore normal tree view
    if (_treeData && _lastTreePath) {
      fileTreeEl.innerHTML = '';
      renderTree(_treeData, fileTreeEl, 0);
    }
    return;
  }

  if (!_treeData) return;

  // Collect all files matching query from full tree data
  const matches = [];
  function walkTree(nodes, pathParts) {
    for (const node of nodes) {
      if (node.type === 'dir') {
        if (node.children) {
          walkTree(node.children, [...pathParts, node.name]);
        }
      } else {
        const fullRelPath = [...pathParts, node.name].join('/');
        if (node.name.toLowerCase().includes(query) || fullRelPath.toLowerCase().includes(query)) {
          matches.push({ name: node.name, path: node.path, relPath: fullRelPath });
        }
      }
    }
  }
  walkTree(_treeData, []);

  // Render flat list of matching files
  fileTreeEl.innerHTML = '';
  if (matches.length === 0) {
    fileTreeEl.innerHTML = '<div style="padding:12px;color:#666;font-size:12px">No matches</div>';
    return;
  }

  const maxResults = 50;
  const shown = matches.slice(0, maxResults);
  for (const match of shown) {
    const item = document.createElement('div');
    item.className = 'tree-item tree-search-result';
    item.style.paddingLeft = '8px';
    const iconClass = getFileIconClass(match.name);
    // Show relative path with filename highlighted
    const dirPart = match.relPath.slice(0, match.relPath.length - match.name.length);
    item.innerHTML = `
      <span class="tree-icon file ${iconClass}">&#128196;</span>
      <span class="tree-name">${escHtml(match.name)}</span>
      <span class="tree-search-path">${escHtml(dirPart)}</span>
    `;
    item.addEventListener('click', () => {
      openFile(match.path);
      // Clear search and restore tree
      fileTreeSearch.value = '';
      filterFileTree('');
    });
    fileTreeEl.appendChild(item);
  }

  if (matches.length > maxResults) {
    const more = document.createElement('div');
    more.style.cssText = 'padding:8px 12px;color:#666;font-size:11px';
    more.textContent = `+${matches.length - maxResults} more results...`;
    fileTreeEl.appendChild(more);
  }
}

// ========== Monaco Setup ==========
async function initMonaco() {
  const nmPath = window.api.getNodeModulesPath();
  const monacoPath = `${nmPath}/monaco-editor/min/vs`;

  return new Promise((resolve) => {
    // Load AMD loader
    const loaderScript = document.createElement('script');
    loaderScript.src = `file://${monacoPath}/loader.js`;
    loaderScript.onload = () => {
      window.require.config({
        paths: { vs: `file://${monacoPath}` },
      });
      window.require(['vs/editor/editor.main'], (monaco) => {
        monacoInstance = monaco;

        // Set dark theme
        monaco.editor.defineTheme('dan-ide-dark', {
          base: 'vs-dark',
          inherit: true,
          rules: [],
          colors: {
            'editor.background': '#1a1a2e',
            'editorLineNumber.foreground': '#555',
            'editor.lineHighlightBackground': '#1f2a3e',
          },
        });

        monacoEditor = monaco.editor.create(monacoContainerEl, {
          value: '',
          language: 'plaintext',
          theme: 'dan-ide-dark',
          fontSize: 13,
          fontFamily: 'JetBrains Mono, Menlo, Monaco, monospace',
          minimap: { enabled: true },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          wordWrap: 'on',
        });

        // Save with Cmd+S / Ctrl+S
        monacoEditor.addCommand(
          monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
          () => saveCurrentFile()
        );

        resolve();
      });
    };
    document.head.appendChild(loaderScript);
  });
}

// ========== File Tree ==========
async function loadFileTree(projectPath) {
  if (!projectPath) {
    fileTreeEl.innerHTML = '<div style="padding:12px;color:#666">No project selected</div>';
    return;
  }
  _lastTreePath = projectPath;
  const tree = await window.api.getFileTree(projectPath);
  _treeData = tree;
  fileTreeEl.innerHTML = '';
  renderTree(tree, fileTreeEl, 0);
}

function getFileIconClass(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = {
    js: 'file-js', mjs: 'file-js', jsx: 'file-js',
    ts: 'file-ts', tsx: 'file-ts',
    json: 'file-json',
    html: 'file-html', htm: 'file-html',
    css: 'file-css', scss: 'file-css', less: 'file-css',
    md: 'file-md', markdown: 'file-md',
    py: 'file-py',
  };
  return map[ext] || '';
}

function renderTree(nodes, parentEl, depth) {
  // Sort: directories first, then alphabetical
  const sorted = [...nodes].sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (a.type !== 'dir' && b.type === 'dir') return 1;
    return a.name.localeCompare(b.name);
  });

  for (const node of sorted) {
    const item = document.createElement('div');
    item.className = 'tree-item';
    item.style.paddingLeft = `${4 + depth * 12}px`;

    if (node.type === 'dir') {
      item.innerHTML = `
        <span class="tree-chevron">&#9654;</span>
        <span class="tree-icon dir">&#128193;</span>
        <span class="tree-name">${escHtml(node.name)}</span>
      `;
      parentEl.appendChild(item);

      const childContainer = document.createElement('div');
      childContainer.className = 'tree-dir-children';
      parentEl.appendChild(childContainer);

      item.addEventListener('click', () => {
        const isOpen = childContainer.classList.toggle('open');
        const chevron = item.querySelector('.tree-chevron');
        chevron.classList.toggle('open', isOpen);
        if (isOpen && childContainer.children.length === 0) {
          renderTree(node.children, childContainer, depth + 1);
        }
      });
    } else {
      const iconClass = getFileIconClass(node.name);
      item.innerHTML = `
        <span class="tree-chevron spacer">&#9654;</span>
        <span class="tree-icon file ${iconClass}">&#128196;</span>
        <span class="tree-name">${escHtml(node.name)}</span>
      `;
      item.addEventListener('click', () => openFile(node.path));
      parentEl.appendChild(item);
    }
  }
}

// ========== File Opening/Editing ==========
async function openFile(filePath) {
  if (!monacoEditor) await initMonaco();

  // Already open?
  if (openFiles.has(filePath)) {
    switchToFile(filePath);
    return;
  }

  const content = await window.api.readFile(filePath);
  if (content === null) return;

  const language = await window.api.getFileLanguage(filePath);
  const model = monacoInstance.editor.createModel(content, language);

  model.onDidChangeContent(() => {
    const file = openFiles.get(filePath);
    if (file) {
      file.modified = model.getValue() !== file.originalContent;
      renderEditorTabs();
    }
  });

  openFiles.set(filePath, {
    content,
    originalContent: content,
    model,
    modified: false,
  });

  switchToFile(filePath);
  renderEditorTabs();
}

function switchToFile(filePath) {
  activeFilePath = filePath;
  const file = openFiles.get(filePath);
  if (file && monacoEditor) {
    monacoEditor.setModel(file.model);
  }
  renderEditorTabs();

  // Highlight in tree
  fileTreeEl.querySelectorAll('.tree-item').forEach((el) => el.classList.remove('active'));
}

async function saveCurrentFile() {
  if (!activeFilePath) return;
  const file = openFiles.get(activeFilePath);
  if (!file) return;

  const content = file.model.getValue();
  const success = await window.api.writeFile(activeFilePath, content);
  if (success) {
    file.originalContent = content;
    file.modified = false;
    renderEditorTabs();
  }
}

function closeFile(filePath) {
  const file = openFiles.get(filePath);
  if (file) {
    file.model.dispose();
    openFiles.delete(filePath);
  }

  if (activeFilePath === filePath) {
    const remaining = Array.from(openFiles.keys());
    if (remaining.length > 0) {
      switchToFile(remaining[remaining.length - 1]);
    } else {
      activeFilePath = null;
      if (monacoEditor) monacoEditor.setModel(null);
    }
  }
  renderEditorTabs();
}

// ========== Editor Tabs ==========
function getFileTabIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const icons = {
    js: { symbol: '<>', cls: 'icon-js' },
    mjs: { symbol: '<>', cls: 'icon-js' },
    jsx: { symbol: '<>', cls: 'icon-js' },
    ts: { symbol: '<>', cls: 'icon-ts' },
    tsx: { symbol: '<>', cls: 'icon-ts' },
    html: { symbol: '<>', cls: 'icon-html' },
    htm: { symbol: '<>', cls: 'icon-html' },
    css: { symbol: '#', cls: 'icon-css' },
    scss: { symbol: '#', cls: 'icon-css' },
    json: { symbol: '{}', cls: 'icon-json' },
    md: { symbol: '\u2193', cls: 'icon-md' },
    markdown: { symbol: '\u2193', cls: 'icon-md' },
    py: { symbol: '\u03BB', cls: 'icon-py' },
  };
  return icons[ext] || { symbol: '\u25C7', cls: '' };
}

function renderEditorTabs() {
  editorTabsEl.innerHTML = '';

  // Detect duplicate filenames for disambiguation
  const nameCount = new Map();
  for (const [filePath] of openFiles) {
    const name = filePath.split('/').pop();
    nameCount.set(name, (nameCount.get(name) || 0) + 1);
  }

  for (const [filePath, file] of openFiles) {
    const name = filePath.split('/').pop();
    const needsDisambig = nameCount.get(name) > 1;
    const icon = getFileTabIcon(name);

    // Get parent folder for disambiguation
    let disambig = '';
    if (needsDisambig) {
      const parts = filePath.split('/');
      const parent = parts[parts.length - 2] || '';
      disambig = `\u2026/${parent}`;
    }

    const tab = document.createElement('div');
    tab.className = `editor-tab${filePath === activeFilePath ? ' active' : ''}${file.modified ? ' modified' : ''}`;
    tab.innerHTML = `
      <span class="tab-icon ${icon.cls}">${icon.symbol}</span>
      <span class="editor-tab-name">${escHtml(name)}</span>
      ${disambig ? `<span class="tab-disambig">${escHtml(disambig)}</span>` : ''}
      <span class="tab-close">&times;</span>
    `;
    tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) {
        closeFile(filePath);
      } else {
        switchToFile(filePath);
      }
    });
    // Middle-click closes the file
    tab.addEventListener('mousedown', (e) => {
      if (e.button === 1) { e.preventDefault(); closeFile(filePath); }
    });
    editorTabsEl.appendChild(tab);
  }

  // Enable horizontal scroll with mouse wheel
  if (!editorTabsEl._hasHScroll) {
    editorTabsEl._hasHScroll = true;
    editorTabsEl.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        editorTabsEl.scrollLeft += e.deltaY;
      }
    }, { passive: false });
  }

  // Show/hide no-file message
  const noFileMsg = document.getElementById('no-file-msg');
  if (noFileMsg) {
    noFileMsg.style.display = openFiles.size === 0 ? 'flex' : 'none';
  }
}

// ========== Helpers ==========
function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Export for app.js
window.editorPanel = {
  initMonaco,
  loadFileTree,
  openFile,
};
