const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

class TranscriptionManager extends EventEmitter {
  constructor(settings) {
    super();
    this._settings = settings || {};
    this._mode = null;
    this._running = false;
    this._transcript = [];
    this._startTime = null;
    this._audioBuffer = [];
    this._bufferBytes = 0;
    this._flushTimer = null;
    this._processing = false;
    this._tmpDir = path.join(os.tmpdir(), 'dan-ide-whisper');
  }

  get isRunning() { return this._running; }
  get mode() { return this._mode; }
  get elapsed() { return this._startTime ? Date.now() - this._startTime : 0; }

  getTranscript(windowMs) {
    if (!windowMs) return this._transcript;
    const cutoff = Date.now() - windowMs;
    return this._transcript.filter(t => t.timestamp >= cutoff);
  }

  getTranscriptText(windowMs) {
    return this.getTranscript(windowMs).map(t => t.text).join(' ');
  }

  start(mode) {
    if (this._running) this.stop();
    this._mode = mode || 'microphone';
    this._running = true;
    this._startTime = Date.now();
    this._transcript = [];
    this._audioBuffer = [];
    this._bufferBytes = 0;

    if (!fs.existsSync(this._tmpDir)) {
      fs.mkdirSync(this._tmpDir, { recursive: true });
    }

    switch (this._mode) {
      case 'microphone':
      case 'system-audio':
        this._startWhisperLoop();
        break;
      case 'teams':
        this.emit('error', { message: 'Teams transcription requires OAuth setup. Use System Audio mode to capture call audio directly.' });
        break;
      case 'manual':
        break;
      default:
        break;
    }

    this.emit('started', { mode: this._mode });
  }

  stop() {
    this._running = false;
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    // Process any remaining audio
    if (this._audioBuffer.length > 0 && !this._processing) {
      this._flushAndTranscribe();
    }
    this.emit('stopped');
  }

  feedManualTranscript(text, speaker) {
    if (!this._running) return;
    const chunk = {
      text: text.trim(),
      timestamp: Date.now(),
      speaker: speaker || null,
      isFinal: true,
    };
    this._transcript.push(chunk);
    this._trimTranscript();
    this.emit('transcript', chunk);
  }

  sendAudio(buffer) {
    if (!this._running) return;
    this._audioBuffer.push(Buffer.from(buffer));
    this._bufferBytes += buffer.byteLength;
  }

  _startWhisperLoop() {
    const intervalMs = this._settings.whisperIntervalMs || 3000;
    this._flushTimer = setInterval(() => {
      if (!this._processing && this._audioBuffer.length > 0) {
        this._flushAndTranscribe();
      }
    }, intervalMs);
  }

  async _flushAndTranscribe() {
    if (this._audioBuffer.length === 0) return;
    this._processing = true;

    const buffers = this._audioBuffer.splice(0);
    this._bufferBytes = 0;
    const pcmData = Buffer.concat(buffers);

    // Skip very short buffers (< 0.5s at 16kHz 16-bit mono = 16000 bytes)
    if (pcmData.length < 16000) {
      this._processing = false;
      return;
    }

    const wavPath = path.join(this._tmpDir, `chunk-${Date.now()}.wav`);

    try {
      this._writeWav(wavPath, pcmData, 16000, 1, 16);
      const text = await this._runWhisper(wavPath);
      if (text && text.trim()) {
        const chunk = {
          text: text.trim(),
          timestamp: Date.now(),
          speaker: null,
          isFinal: true,
        };
        this._transcript.push(chunk);
        this._trimTranscript();
        this.emit('transcript', chunk);
      }
    } catch (err) {
      this.emit('error', { message: `Whisper error: ${err.message}` });
    } finally {
      // Clean up temp file
      try { fs.unlinkSync(wavPath); } catch {}
      this._processing = false;
    }
  }

  _runWhisper(wavPath) {
    return new Promise((resolve, reject) => {
      const model = this._settings.whisperModel || 'base';
      const whisperBin = this._settings.whisperPath || 'whisper';
      const args = [
        wavPath,
        '--model', model,
        '--language', 'en',
        '--output_format', 'txt',
        '--output_dir', this._tmpDir,
        '--fp16', 'False',
      ];

      const proc = spawn(whisperBin, args, {
        env: { ...process.env },
        timeout: 30000,
      });

      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`whisper exited with code ${code}: ${stderr.slice(0, 200)}`));
          return;
        }
        // Whisper writes <basename>.txt next to the output
        const txtPath = wavPath.replace(/\.wav$/, '.txt');
        try {
          const text = fs.readFileSync(txtPath, 'utf-8');
          try { fs.unlinkSync(txtPath); } catch {}
          resolve(text);
        } catch (err) {
          reject(new Error(`Could not read whisper output: ${err.message}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn whisper: ${err.message}`));
      });
    });
  }

  _writeWav(filePath, pcmBuffer, sampleRate, channels, bitsPerSample) {
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const dataSize = pcmBuffer.length;
    const header = Buffer.alloc(44);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    fs.writeFileSync(filePath, Buffer.concat([header, pcmBuffer]));
  }

  _trimTranscript() {
    const maxAge = 10 * 60 * 1000;
    const cutoff = Date.now() - maxAge;
    this._transcript = this._transcript.filter(t => t.timestamp >= cutoff);
  }
}

module.exports = { TranscriptionManager };
