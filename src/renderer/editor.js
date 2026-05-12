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
if (fileTreeSearch) {
  fileTreeSearch.addEventListener('input', () => {
    const query = fileTreeSearch.value.toLowerCase();
    filterFileTree(query);
  });
}

function filterFileTree(query) {
  const items = fileTreeEl.querySelectorAll('.tree-item');
  const dirContainers = fileTreeEl.querySelectorAll('.tree-dir-children');

  if (!query) {
    // Show all items, collapse dirs back
    items.forEach((el) => el.style.display = '');
    dirContainers.forEach((el) => {
      // Keep previously-opened dirs open
    });
    return;
  }

  // Show items matching query, hide others
  items.forEach((el) => {
    const name = el.querySelector('.tree-name');
    if (name && name.textContent.toLowerCase().includes(query)) {
      el.style.display = '';
      // Ensure parent containers are visible
      let parent = el.parentElement;
      while (parent && parent !== fileTreeEl) {
        if (parent.classList.contains('tree-dir-children')) {
          parent.classList.add('open');
          parent.style.display = '';
        }
        parent = parent.parentElement;
      }
    } else {
      el.style.display = 'none';
    }
  });
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
  const tree = await window.api.getFileTree(projectPath);
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
function renderEditorTabs() {
  editorTabsEl.innerHTML = '';
  for (const [filePath, file] of openFiles) {
    const name = filePath.split('/').pop();
    const tab = document.createElement('div');
    tab.className = `editor-tab${filePath === activeFilePath ? ' active' : ''}${file.modified ? ' modified' : ''}`;
    tab.innerHTML = `
      <span>${escHtml(file.modified ? name + ' *' : name)}</span>
      <span class="tab-close">&times;</span>
    `;
    tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) {
        closeFile(filePath);
      } else {
        switchToFile(filePath);
      }
    });
    editorTabsEl.appendChild(tab);
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
