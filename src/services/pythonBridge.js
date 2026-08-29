const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class PythonBridge {
  /**
   * Resolve appropriate Python executable path (venv preferred, fallback to system python3).
   */
  static getPythonPath() {
    const venvPythonMacLinux = path.join(__dirname, '../../.venv/bin/python');
    const venvPythonWin = path.join(__dirname, '../../.venv/Scripts/python.exe');

    if (fs.existsSync(venvPythonMacLinux)) {
      return venvPythonMacLinux;
    }
    if (fs.existsSync(venvPythonWin)) {
      return venvPythonWin;
    }
    return process.platform === 'win32' ? 'python' : 'python3';
  }

  /**
   * Execute Python quantitative pipeline action and return parsed JSON result.
   * 
   * @param {string} action - 'run_full_pipeline', 'run_fundamentals', 'run_technical', 'run_fracdiff', 'run_sentiment', 'run_purification', 'run_cpcv'
   * @param {object} payload - Configuration parameters and data inputs
   * @param {number} timeoutMs - Timeout limit in milliseconds (default 300s / 5min)
   */
  static runPipeline(action = 'run_full_pipeline', payload = {}, timeoutMs = 300000) {
    return new Promise((resolve, reject) => {
      const tickerCount = (payload && payload.tickers && Array.isArray(payload.tickers)) ? payload.tickers.length : 10;
      const effectiveTimeout = Math.max(timeoutMs || 300000, (tickerCount * 400) + 120000);
      const pythonPath = PythonBridge.getPythonPath();
      const scriptPath = path.join(__dirname, '../../scripts/run_quant_pipeline.py');


      if (!fs.existsSync(scriptPath)) {
        return reject(new Error(`Quant pipeline script not found at ${scriptPath}`));
      }

      const args = [scriptPath, '--action', action];
      const py = spawn(pythonPath, args, {
        cwd: path.join(__dirname, '../..'),
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          TRANSFORMERS_VERBOSITY: 'error',
          HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
        },
      });

      let stdoutData = '';
      let stderrData = '';
      let isTimedOut = false;

      const timer = setTimeout(() => {
        isTimedOut = true;
        py.kill('SIGKILL');
        reject(new Error(`Python pipeline execution timed out after ${effectiveTimeout}ms (Action: ${action})`));
      }, effectiveTimeout);


      // Write payload to stdin
      try {
        const payloadStr = JSON.stringify(payload || {});
        py.stdin.write(payloadStr);
        py.stdin.end();
      } catch (err) {
        clearTimeout(timer);
        return reject(new Error(`Failed to send payload to Python process: ${err.message}`));
      }

      py.stdout.on('data', (chunk) => {
        stdoutData += chunk.toString();
      });

      py.stderr.on('data', (chunk) => {
        stderrData += chunk.toString();
      });

      py.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to spawn Python process (${pythonPath}): ${err.message}`));
      });

      py.on('close', (code) => {
        clearTimeout(timer);
        if (isTimedOut) return;

        if (code !== 0) {
          return reject(new Error(`Python process exited with code ${code}.\nStderr: ${stderrData.trim()}`));
        }

        try {
          // Parse last valid JSON line from stdout
          const lines = stdoutData.trim().split('\n');
          let jsonLine = lines[lines.length - 1];
          for (let i = lines.length - 1; i >= 0; i--) {
            const l = lines[i].trim();
            if (l.startsWith('{') && l.endsWith('}')) {
              jsonLine = l;
              break;
            }
          }
          const parsed = JSON.parse(jsonLine);
          resolve(parsed);
        } catch (parseErr) {
          reject(new Error(`Failed to parse Python JSON output: ${parseErr.message}\nRaw stdout: ${stdoutData.slice(0, 500)}`));
        }
      });
    });
  }
}

module.exports = { PythonBridge };
