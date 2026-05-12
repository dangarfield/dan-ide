const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

class TestRunner {
  /**
   * Detect test framework in a project directory.
   * Returns { framework, command, configFile } or null.
   */
  detect(projectPath) {
    // Check package.json (Node.js projects)
    const pkgPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const allDeps = {
          ...(pkg.dependencies || {}),
          ...(pkg.devDependencies || {}),
        };

        // Check for specific frameworks in deps
        if (allDeps.vitest) {
          return { framework: 'vitest', command: 'npx vitest run', configFile: pkgPath };
        }
        if (allDeps.jest) {
          return { framework: 'jest', command: 'npx jest', configFile: pkgPath };
        }
        if (allDeps.mocha) {
          return { framework: 'mocha', command: 'npx mocha', configFile: pkgPath };
        }

        // Fallback: check for "test" script
        if (pkg.scripts && pkg.scripts.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
          return { framework: 'npm-test', command: 'npm test', configFile: pkgPath };
        }
      } catch (e) { /* ignore parse errors */ }
    }

    // Check for Python test frameworks
    const pytestIni = path.join(projectPath, 'pytest.ini');
    if (fs.existsSync(pytestIni)) {
      return { framework: 'pytest', command: 'pytest', configFile: pytestIni };
    }

    const pyprojectToml = path.join(projectPath, 'pyproject.toml');
    if (fs.existsSync(pyprojectToml)) {
      try {
        const content = fs.readFileSync(pyprojectToml, 'utf8');
        if (content.includes('[tool.pytest') || content.includes('pytest')) {
          return { framework: 'pytest', command: 'pytest', configFile: pyprojectToml };
        }
      } catch (e) { /* ignore */ }
    }

    const setupCfg = path.join(projectPath, 'setup.cfg');
    if (fs.existsSync(setupCfg)) {
      try {
        const content = fs.readFileSync(setupCfg, 'utf8');
        if (content.includes('[tool:pytest]')) {
          return { framework: 'pytest', command: 'pytest', configFile: setupCfg };
        }
      } catch (e) { /* ignore */ }
    }

    // Check for Makefile with test target
    const makefile = path.join(projectPath, 'Makefile');
    if (fs.existsSync(makefile)) {
      try {
        const content = fs.readFileSync(makefile, 'utf8');
        if (/^test\s*:/m.test(content)) {
          return { framework: 'make', command: 'make test', configFile: makefile };
        }
      } catch (e) { /* ignore */ }
    }

    return null;
  }

  /**
   * Run tests for the project and return parsed results.
   */
  run(projectPath) {
    const detected = this.detect(projectPath);
    if (!detected) {
      return Promise.resolve({ passed: 0, failed: 0, total: 0, duration: 0, failures: [], error: 'No test framework detected' });
    }
    return this._exec(detected.command, projectPath, detected.framework);
  }

  /**
   * Run tests for a specific file.
   */
  runSpecific(projectPath, testFile) {
    const detected = this.detect(projectPath);
    if (!detected) {
      return Promise.resolve({ passed: 0, failed: 0, total: 0, duration: 0, failures: [], error: 'No test framework detected' });
    }

    let command;
    switch (detected.framework) {
      case 'vitest':
        command = `npx vitest run ${testFile}`;
        break;
      case 'jest':
        command = `npx jest ${testFile}`;
        break;
      case 'mocha':
        command = `npx mocha ${testFile}`;
        break;
      case 'pytest':
        command = `pytest ${testFile}`;
        break;
      default:
        command = `${detected.command} -- ${testFile}`;
        break;
    }

    return this._exec(command, projectPath, detected.framework);
  }

  /**
   * Execute a test command and parse the output.
   */
  _exec(command, cwd, framework) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const parts = command.split(' ');
      const cmd = parts[0];
      const args = parts.slice(1);

      const child = spawn(cmd, args, {
        cwd,
        shell: true,
        env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => { stdout += data.toString(); });
      child.stderr.on('data', (data) => { stderr += data.toString(); });

      child.on('close', (code) => {
        const duration = Date.now() - startTime;
        const output = stdout + '\n' + stderr;
        const result = this._parse(output, framework, code, duration);
        resolve(result);
      });

      child.on('error', (err) => {
        resolve({ passed: 0, failed: 0, total: 0, duration: 0, failures: [], error: err.message });
      });
    });
  }

  /**
   * Parse test output based on framework.
   */
  _parse(output, framework, exitCode, duration) {
    const result = { passed: 0, failed: 0, total: 0, duration, failures: [] };

    switch (framework) {
      case 'jest': {
        // Jest: "Tests:  X passed, Y failed, Z total"
        const summary = output.match(/Tests:\s+(?:(\d+)\s+failed,?\s*)?(?:(\d+)\s+passed,?\s*)?(\d+)\s+total/);
        if (summary) {
          result.failed = parseInt(summary[1] || '0', 10);
          result.passed = parseInt(summary[2] || '0', 10);
          result.total = parseInt(summary[3], 10);
        }
        // Extract failures: "FAIL" lines
        const failMatches = output.matchAll(/FAIL\s+(.+)\n[\s\S]*?●\s+(.+?)(?:\n|$)/g);
        for (const m of failMatches) {
          result.failures.push({ test: m[2], message: m[1] });
        }
        break;
      }
      case 'vitest': {
        // Vitest: "Tests  X passed | Y failed (Z)"
        const summary = output.match(/Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+failed)?/);
        if (summary) {
          result.passed = parseInt(summary[1], 10);
          result.failed = parseInt(summary[2] || '0', 10);
          result.total = result.passed + result.failed;
        }
        // Failures: "FAIL" lines
        const failLines = output.matchAll(/FAIL\s+(.+?)(?:\n|$)/g);
        for (const m of failLines) {
          result.failures.push({ test: m[1], message: '' });
        }
        break;
      }
      case 'pytest': {
        // pytest: "X passed, Y failed" or "X passed"
        const passed = output.match(/(\d+)\s+passed/);
        const failed = output.match(/(\d+)\s+failed/);
        if (passed) result.passed = parseInt(passed[1], 10);
        if (failed) result.failed = parseInt(failed[1], 10);
        result.total = result.passed + result.failed;
        // Failure details: "FAILED test_file.py::test_name"
        const failMatches = output.matchAll(/FAILED\s+(.+?)(?:\s+-\s+(.+))?$/gm);
        for (const m of failMatches) {
          result.failures.push({ test: m[1], message: m[2] || '' });
        }
        break;
      }
      case 'mocha': {
        // Mocha: "X passing" and "Y failing"
        const passed = output.match(/(\d+)\s+passing/);
        const failed = output.match(/(\d+)\s+failing/);
        if (passed) result.passed = parseInt(passed[1], 10);
        if (failed) result.failed = parseInt(failed[1], 10);
        result.total = result.passed + result.failed;
        break;
      }
      default: {
        // Generic: try common patterns
        const passed = output.match(/(\d+)\s+pass(?:ed|ing)/i);
        const failed = output.match(/(\d+)\s+fail(?:ed|ing|ure)/i);
        if (passed) result.passed = parseInt(passed[1], 10);
        if (failed) result.failed = parseInt(failed[1], 10);
        result.total = result.passed + result.failed;
        break;
      }
    }

    // If we couldn't parse but exit code tells us something
    if (result.total === 0 && exitCode !== 0) {
      result.failed = 1;
      result.total = 1;
      result.failures.push({ test: 'unknown', message: 'Tests failed (could not parse output)' });
    }

    return result;
  }
}

module.exports = { TestRunner };
