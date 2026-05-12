const fs = require('fs');
const path = require('path');

// Extensions to index
const INDEXABLE_EXTS = new Set([
  '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.md',
  '.json', '.yaml', '.yml', '.html', '.css', '.scss',
]);

// Directories to skip
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  '__pycache__', '.cache', 'coverage', 'venv', '.venv', '.dan-ide',
]);

class SearchManager {
  constructor() {
    this._cache = new Map(); // projectPath -> { files: [], timestamp }
  }

  /**
   * Recursively collect all indexable source files.
   */
  _collectFiles(dirPath, files = []) {
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return files;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && IGNORED_DIRS.has(entry.name)) continue;
      if (IGNORED_DIRS.has(entry.name)) continue;

      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        this._collectFiles(fullPath, files);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (INDEXABLE_EXTS.has(ext)) {
          files.push(fullPath);
        }
      }
    }
    return files;
  }

  /**
   * Get indexed files for a project (with simple caching).
   */
  _getFiles(projectPath) {
    const cached = this._cache.get(projectPath);
    const now = Date.now();
    // Cache for 30 seconds
    if (cached && (now - cached.timestamp) < 30000) {
      return cached.files;
    }
    const files = this._collectFiles(projectPath);
    this._cache.set(projectPath, { files, timestamp: now });
    return files;
  }

  /**
   * Search across all indexed files for a text query.
   * Returns top 20 results as { file, line, content, matchCount }.
   */
  search(projectPath, query) {
    if (!query || !query.trim()) return [];

    const files = this._getFiles(projectPath);
    const results = [];
    const queryLower = query.toLowerCase();

    for (const filePath of files) {
      let content;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }

      const lines = content.split('\n');
      let matchCount = 0;
      let firstMatchLine = null;
      let firstMatchContent = null;

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(queryLower)) {
          matchCount++;
          if (!firstMatchLine) {
            firstMatchLine = i + 1;
            firstMatchContent = lines[i].trim();
          }
        }
      }

      if (matchCount > 0) {
        results.push({
          file: path.relative(projectPath, filePath),
          line: firstMatchLine,
          content: firstMatchContent.substring(0, 200),
          matchCount,
        });
      }
    }

    // Sort by match count descending, return top 20
    results.sort((a, b) => b.matchCount - a.matchCount);
    return results.slice(0, 20);
  }

  /**
   * Get a tree summary of the project structure.
   * Returns { directories: [...], totalFiles, summary }.
   */
  getFileStructure(projectPath) {
    const structure = {};

    const files = this._getFiles(projectPath);
    let totalFiles = files.length;

    for (const filePath of files) {
      const rel = path.relative(projectPath, filePath);
      const parts = rel.split(path.sep);
      const topDir = parts.length > 1 ? parts[0] : '.';
      structure[topDir] = (structure[topDir] || 0) + 1;
    }

    const directories = Object.entries(structure)
      .map(([name, count]) => ({ name, fileCount: count }))
      .sort((a, b) => b.fileCount - a.fileCount);

    return { directories, totalFiles };
  }

  /**
   * Get a summary of a specific file: first 50 lines + detected exports/functions.
   */
  getFileSummary(filePath) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }

    const lines = content.split('\n');
    const preview = lines.slice(0, 50).join('\n');

    // Detect exports and function declarations
    const symbols = [];
    const patterns = [
      /^export\s+(default\s+)?(function|class|const|let|var)\s+(\w+)/,
      /^(function|class)\s+(\w+)/,
      /^(const|let|var)\s+(\w+)\s*=\s*(async\s+)?\(/,
      /module\.exports\s*=\s*\{([^}]+)\}/,
      /exports\.(\w+)/,
      /def\s+(\w+)\s*\(/,
      /public\s+\w+\s+(\w+)\s*\(/,
    ];

    for (const line of lines) {
      const trimmed = line.trim();
      for (const pattern of patterns) {
        const match = trimmed.match(pattern);
        if (match) {
          // Extract the meaningful identifier
          const symbol = match[3] || match[2] || match[1];
          if (symbol && symbol.length < 60) {
            symbols.push(symbol);
          }
          break;
        }
      }
    }

    return {
      preview,
      lineCount: lines.length,
      symbols: [...new Set(symbols)].slice(0, 30),
    };
  }
}

module.exports = { SearchManager };
