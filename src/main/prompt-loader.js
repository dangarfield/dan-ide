const fs = require('fs');
const path = require('path');

const PROMPTS_DIR = path.join(__dirname, 'prompts');

function loadPrompt(name, vars = {}) {
  const filePath = path.join(PROMPTS_DIR, `${name}.md`);
  let content = fs.readFileSync(filePath, 'utf8');

  // Strip the markdown title (first # heading) — it's for humans editing the file
  content = content.replace(/^#\s+.+\n\n?/, '');

  // Replace template variables
  for (const [key, value] of Object.entries(vars)) {
    content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value || '');
  }

  return content.trim();
}

function promptExists(name) {
  return fs.existsSync(path.join(PROMPTS_DIR, `${name}.md`));
}

module.exports = { loadPrompt, promptExists, PROMPTS_DIR };
