const fs = require('fs');
const path = require('path');

// Directories to skip when building file tree
const IGNORED = new Set([
  'node_modules', '.git', '.dan-ide', '__pycache__', '.DS_Store',
  'dist', 'build', '.next', '.nuxt', 'coverage', '.cache',
  'venv', '.venv', 'env', '.env',
]);

class FileManager {
  readTree(dirPath, depth = 0, maxDepth = 5) {
    if (depth > maxDepth) return [];
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return [];
    }

    const results = [];
    // Sort: directories first, then files, alphabetical
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;

      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        results.push({
          name: entry.name,
          path: fullPath,
          type: 'dir',
          children: this.readTree(fullPath, depth + 1, maxDepth),
        });
      } else {
        results.push({
          name: entry.name,
          path: fullPath,
          type: 'file',
        });
      }
    }
    return results;
  }

  readFile(filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      return null;
    }
  }

  writeFile(filePath, content) {
    try {
      fs.writeFileSync(filePath, content, 'utf8');
      return true;
    } catch (e) {
      return false;
    }
  }

  getLanguage(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const map = {
      '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
      '.ts': 'typescript', '.tsx': 'typescript',
      '.jsx': 'javascript',
      '.json': 'json',
      '.html': 'html', '.htm': 'html',
      '.css': 'css', '.scss': 'scss', '.less': 'less',
      '.md': 'markdown',
      '.py': 'python',
      '.rs': 'rust',
      '.go': 'go',
      '.rb': 'ruby',
      '.java': 'java',
      '.c': 'c', '.h': 'c',
      '.cpp': 'cpp', '.hpp': 'cpp',
      '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
      '.yaml': 'yaml', '.yml': 'yaml',
      '.toml': 'ini',
      '.xml': 'xml',
      '.sql': 'sql',
      '.dockerfile': 'dockerfile',
      '.swift': 'swift',
      '.kt': 'kotlin',
    };
    return map[ext] || 'plaintext';
  }
}

module.exports = { FileManager };
