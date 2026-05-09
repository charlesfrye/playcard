// Constants

const DEFAULT_URL = 'https://modal-labs-charles-dev--playcard-backend-vlmserver.us-west.modal.direct';

const DEFAULT_PROMPT = String.raw`The attached images were taken by a webcam pointing at an exhibition in San Francisco's Gray Area art space.

Your goal is to write something that will be displayed on a placard beneath the webcam. The placard should act as a dynamic description of its environment as it would be experienced by those in it, not as a description from the webcam's perspective, e.g. of the images per se or their composition. Its contents should be pretentious, laden with the argot of the gallery. It should appear as much as possible to be a description of a real piece of art in the exhibition.

Only produce one paragraph of description.

Be playful, be funny, be wry, be allusive, don't be cruel.

The webcam and the captured images are not visible to the attendees.`;

const MAX_BUFFER_SIZE = 4;
const RETRY_TIMEOUT_MS = 5 * 60 * 1000;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 5000;

const STRUCTURED_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'playcard',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        artist_name: { type: 'string' },
        medium: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['title', 'artist_name', 'medium', 'description'],
      additionalProperties: false,
    },
  },
};

// DOM refs

const $ = function (id) { return document.getElementById(id); };

var idleScreen = $('idleScreen');
var placard = $('placard');
var placardContent = $('placardContent');
var hoverZone = $('hoverZone');
var statusLine = $('statusLine');
var debugOverlay = $('debugOverlay');
var idleError = $('idleError');
var webcamVideo = $('webcamVideo');
var webcamCanvas = $('webcamCanvas');

var startBtn = $('startBtn');
var stopBtn = $('stopBtn');
var debugBtn = $('debugBtn');
var debugBtnIdle = $('debugBtnIdle');
var closeDebug = $('closeDebug');
var promptEl = $('promptEl');
var structuredToggle = $('structuredToggle');
var captureRate = $('captureRate');
var captureRateValue = $('captureRateValue');
var backendUrl = $('backendUrl');

// State

var webcamStream = null;
var captureTimer = null;
var frameBuffer = [];
var latestRequestId = 0;
var displayedRequestId = 0;
var currentAbortController = null;
var lastResponseTime = null;
var isRunning = false;

// Persistence

function loadSettings() {
  promptEl.value = localStorage.getItem('playcard-prompt') || DEFAULT_PROMPT;
  structuredToggle.checked = localStorage.getItem('playcard-structured') !== 'false';
  captureRate.value = parseInt(localStorage.getItem('playcard-captureRate'), 10) || 4;
  captureRateValue.textContent = captureRate.value + 's';
  backendUrl.value = localStorage.getItem('playcard-backendUrl') || DEFAULT_URL;
}

function saveSettings() {
  localStorage.setItem('playcard-prompt', promptEl.value);
  localStorage.setItem('playcard-structured', structuredToggle.checked);
  localStorage.setItem('playcard-captureRate', captureRate.value);
  localStorage.setItem('playcard-backendUrl', backendUrl.value.trim());
}

captureRate.addEventListener('input', function () {
  captureRateValue.textContent = captureRate.value + 's';
});

[promptEl, structuredToggle, captureRate, backendUrl].forEach(function (el) {
  el.addEventListener('input', saveSettings);
  el.addEventListener('change', saveSettings);
});

// Webcam life cycle

startBtn.addEventListener('click', startCapture);
stopBtn.addEventListener('click', stopCapture);

function startCapture() {
  navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 }, aspectRatio: 4 / 3 },
  }).then(function (stream) {
    webcamStream = stream;
    webcamVideo.srcObject = stream;

    idleScreen.classList.add('hidden');
    idleError.classList.remove('visible');
    placard.classList.remove('hidden');
    hoverZone.classList.remove('hidden');
    hoverZone.classList.remove('open');

    frameBuffer = [];
    latestRequestId = 0;
    displayedRequestId = 0;
    lastResponseTime = null;
    isRunning = true;

    var intervalMs = parseInt(captureRate.value, 10) * 1000;
    var canvas = webcamCanvas;
    var ctx = canvas.getContext('2d');

    function capture() {
      if (!isRunning || !webcamStream) return;
      if (webcamVideo.videoWidth === 0) return;

      canvas.width = webcamVideo.videoWidth;
      canvas.height = webcamVideo.videoHeight;
      ctx.drawImage(webcamVideo, 0, 0, canvas.width, canvas.height);

      if (isBlackFrame(ctx, canvas.width, canvas.height)) return;

      var dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      frameBuffer.push(dataUrl);
      while (frameBuffer.length > MAX_BUFFER_SIZE) frameBuffer.shift();

      latestRequestId++;
      currentAbortController = new AbortController();
      updateStatus();
      sendFrames([].concat(frameBuffer), latestRequestId, currentAbortController.signal);
    }

    webcamVideo.addEventListener('playing', function () {
      requestAnimationFrame(function () {
        capture();
        captureTimer = setInterval(capture, intervalMs);
      });
    }, { once: true });

    updateStatus();
  }).catch(function (e) {
    idleError.textContent = 'Could not access webcam: ' + e.message;
    idleError.classList.add('visible');
  });
}

function stopCapture() {
  isRunning = false;

  if (captureTimer) {
    clearInterval(captureTimer);
    captureTimer = null;
  }

  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }

  if (webcamStream) {
    webcamStream.getTracks().forEach(function (t) { t.stop(); });
    webcamStream = null;
  }

  webcamVideo.srcObject = null;
  frameBuffer = [];

  placard.classList.add('hidden');
  hoverZone.classList.add('hidden');
  idleScreen.classList.remove('hidden');
}

// Frame helpers

function isBlackFrame(ctx, w, h) {
  var imageData = ctx.getImageData(0, 0, w, h);
  var data = imageData.data;
  for (var i = 0; i < data.length; i += 16) {
    if (data[i] > 10 || data[i + 1] > 10 || data[i + 2] > 10) return false;
  }
  return true;
}

// Status line

function updateStatus() {
  if (!isRunning) return;
  var parts = ['● Live'];
  if (frameBuffer.length) {
    parts.push(frameBuffer.length + ' frame' + (frameBuffer.length !== 1 ? 's' : ''));
  }
  if (lastResponseTime !== null) {
    parts.push(Math.round((Date.now() - lastResponseTime) / 1000) + 's ago');
  }
  statusLine.textContent = parts.join(' · ');
}

// API calls

function sendFrames(frames, id, signal) {
  var url = backendUrl.value.trim();
  if (!url) return;

  var prompt = promptEl.value.trim();
  if (!prompt) return;

  var content = frames.map(function (dataUrl) {
    return { type: 'image_url', image_url: { url: dataUrl } };
  });
  content.push({ type: 'text', text: prompt });

  var body = {
    messages: [{ role: 'user', content: content }],
    stream: true,
    top_k: 20,
    temperature: 0.8,
  };

  if (structuredToggle.checked) {
    body.response_format = STRUCTURED_SCHEMA;
  }

  if (displayedRequestId === 0) showLoading();
  setStatus('');

  fetchWithRetry(url, body, signal).then(function (resp) {
    return streamResponse(resp);
  }).then(function (text) {
    if (id <= displayedRequestId) return;
    displayedRequestId = id;
    setStatus('ok');
    lastResponseTime = Date.now();
    updateStatus();
    renderResponse(text);
  }).catch(function (err) {
    if (err.name === 'AbortError') return;
    if (id <= displayedRequestId) return;
    setStatus('err');
    lastResponseTime = Date.now();
    updateStatus();
    renderResponse(null, err.message);
  });
}

function fetchWithRetry(url, body, signal) {
  var deadline = Date.now() + RETRY_TIMEOUT_MS;
  var attempt = 0;

  function tryFetch() {
    attempt++;
    return fetch(url + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: signal,
    }).then(function (resp) {
      if (resp.status === 503) {
        if (Date.now() >= deadline) {
          return resp.text().then(function (t) {
            throw new Error('HTTP 503: retry deadline exceeded');
          });
        }
        return sleep(Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS), signal).then(tryFetch);
      }

      if (!resp.ok) {
        return resp.text().then(function (t) {
          throw new Error('HTTP ' + resp.status + ': ' + t.slice(0, 300));
        });
      }

      return resp;
    }).catch(function (err) {
      if (err.name === 'AbortError') throw err;
      if (err instanceof TypeError) {
        if (Date.now() >= deadline) throw new Error('Server unreachable after 5 minutes');
        return sleep(Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS), signal).then(tryFetch);
      }
      throw err;
    });
  }

  return tryFetch();
}

function streamResponse(resp) {
  var reader = resp.body.getReader();
  var decoder = new TextDecoder();
  var buffer = '';
  var text = '';

  function read() {
    return reader.read().then(function (chunk) {
      if (chunk.done) return text;

      buffer += decoder.decode(chunk.value, { stream: true });
      var lines = buffer.split('\n');
      buffer = lines.pop();

      for (var i = 0; i < lines.length; i++) {
        var trimmed = lines[i].trim();
        if (!trimmed || trimmed.indexOf('data:') !== 0) continue;

        var data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;

        try {
          var parsed = JSON.parse(data);
          var content = (parsed.choices || [{}])[0].delta || {};
          content = content.content || '';
          if (content) text += content;
        } catch (_) {}
      }

      return read();
    });
  }

  return read();
}

// Rendering

function showLoading() {
  placardContent.innerHTML = '<div class="loading-dots"><span>.</span><span>.</span><span>.</span></div>';
}

function renderResponse(text, errorMsg) {
  if (errorMsg) {
    placardContent.innerHTML = '<p class="error-display">' + escapeHtml(errorMsg) + '</p>';
    return;
  }

  if (!text || !text.trim()) {
    placardContent.innerHTML = '<p class="empty-display">(No response)</p>';
    return;
  }

  text = text.trim();

  if (structuredToggle.checked) {
    try {
      var data = JSON.parse(text);
      if (data && typeof data === 'object' && data.title && data.artist_name && data.medium && data.description) {
        placardContent.innerHTML =
          '<h1>' + escapeHtml(data.title) + '</h1>' +
          '<h2 class="artist">' + escapeHtml(data.artist_name) + '</h2>' +
          '<h3>' + escapeHtml(data.medium) + '</h3>' +
          '<p>' + escapeHtml(data.description).replace(/\n/g, '<br>') + '</p>';
        return;
      }
    } catch (_) {}
  }

  placardContent.innerHTML = '<p class="raw-text">' + escapeHtml(text) + '</p>';
}

// Debug overlay

function openDebug() {
  debugOverlay.classList.remove('hidden');
}

function closeDebugOverlay() {
  debugOverlay.classList.add('hidden');
}

debugBtn.addEventListener('click', openDebug);
debugBtnIdle.addEventListener('click', openDebug);
closeDebug.addEventListener('click', closeDebugOverlay);

debugOverlay.addEventListener('click', function (e) {
  if (e.target === debugOverlay) closeDebugOverlay();
});

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && !debugOverlay.classList.contains('hidden')) {
    closeDebugOverlay();
  }
});

// Hover zone

hoverZone.addEventListener('click', function (e) {
  if (e.target === hoverZone) {
    hoverZone.classList.toggle('open');
  }
});

// Helpers

function sleep(ms, signal) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', function () {
        clearTimeout(timer);
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      }, { once: true });
    }
  });
}

function escapeHtml(str) {
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function setStatus(state) {
  if (state === 'ok') {
    statusLine.style.color = '#2e7d32';
  } else if (state === 'err') {
    statusLine.style.color = '#c0392b';
  } else {
    statusLine.style.color = '';
  }
}

// Init

loadSettings();
