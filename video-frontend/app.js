// --- Constants ---
const DEFAULT_URL = 'https://modal-labs-charles-dev--playcard-backend-vlmserver.us-west.modal.direct';
const MAX_CARDS = 50;
const MAX_BUFFER_SIZE = 4;
const RETRY_TIMEOUT_MS = 5 * 60 * 1000;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 5000;

// --- DOM refs ---
const $ = (id) => document.getElementById(id);

const backendUrl = $('backendUrl');
const statusDot = $('statusDot');
const webcamVideo = $('webcamVideo');
const webcamOverlay = $('webcamOverlay');
const captureBadge = $('captureBadge');
const startBtn = $('startBtn');
const stopBtn = $('stopBtn');
const captureInterval = $('captureInterval');
const intervalValue = $('intervalValue');
const intervalRow = $('intervalRow');
const promptEl = $('prompt');
const statusInfo = $('statusInfo');
const cardStack = $('cardStack');

// --- State ---
let webcamStream = null;
let captureTimer = null;
let frameBuffer = [];
let requestId = 0;
let activeTab = 'dashboard';

// --- Tabs ---

const tabBtns = document.querySelectorAll('.tab');

tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    if (tab === activeTab) return;
    stopCapture();
    activeTab = tab;
    tabBtns.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    intervalRow.style.display = tab === 'dashboard' ? '' : 'none';
  });
});

// --- Backend URL persistence ---

backendUrl.value = localStorage.getItem('vlmBackendUrl') || DEFAULT_URL;
backendUrl.addEventListener('input', () => {
  localStorage.setItem('vlmBackendUrl', backendUrl.value.trim());
});

// --- Interval slider ---

captureInterval.addEventListener('input', () => {
  intervalValue.textContent = captureInterval.value + 's';
});

// --- Frame capture ---

function isBlackFrame(ctx, w, h) {
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 16) {
    if (data[i] > 10 || data[i + 1] > 10 || data[i + 2] > 10) {
      return false;
    }
  }
  return true;
}

startBtn.addEventListener('click', startCapture);
stopBtn.addEventListener('click', stopCapture);

async function startCapture() {
  try {
    webcamStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, aspectRatio: 4 / 3 },
    });
  } catch (e) {
    alert('Could not access webcam: ' + e.message);
    return;
  }

  webcamVideo.srcObject = webcamStream;
  webcamOverlay.classList.add('hidden');

  frameBuffer = [];
  requestId = 0;

  const intervalMs = activeTab === 'dashboard'
    ? parseInt(captureInterval.value) * 1000
    : 4000;
  const canvas = $('webcamCanvas');
  const ctx = canvas.getContext('2d');

  const captureFrame = () => {
    if (!webcamStream) return;
    if (webcamVideo.videoWidth === 0) return;

    canvas.width = webcamVideo.videoWidth;
    canvas.height = webcamVideo.videoHeight;
    ctx.drawImage(webcamVideo, 0, 0, canvas.width, canvas.height);

    if (isBlackFrame(ctx, canvas.width, canvas.height)) return;

    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    frameBuffer.push(dataUrl);
    while (frameBuffer.length > MAX_BUFFER_SIZE) frameBuffer.shift();

    requestId++;
    statusInfo.textContent = 'Sending ' + frameBuffer.length + ' frame' + (frameBuffer.length !== 1 ? 's' : '') + '...';
    sendFrameStack([...frameBuffer], requestId);
  };

  webcamVideo.addEventListener('playing', () => {
    requestAnimationFrame(() => {
      captureFrame();
      captureTimer = setInterval(captureFrame, intervalMs);
    });
  }, { once: true });

  captureBadge.classList.add('visible');
  startBtn.disabled = true;
  stopBtn.disabled = false;
  captureInterval.disabled = true;
  setStatus('');
}

function stopCapture() {
  if (captureTimer) {
    clearInterval(captureTimer);
    captureTimer = null;
  }

  captureBadge.classList.remove('visible');
  startBtn.disabled = false;
  stopBtn.disabled = true;
  captureInterval.disabled = false;
  frameBuffer = [];
}

// --- Card management ---

function showEmptyState() {
  if (cardStack.querySelector('.empty-state')) return;
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.textContent = 'Capture a video to see responses...';
  cardStack.appendChild(div);
}

function hideEmptyState() {
  const emptyState = cardStack.querySelector('.empty-state');
  if (emptyState) emptyState.remove();
}

function createCard(id) {
  const card = document.createElement('div');
  card.className = 'response-card streaming';
  card.id = 'card-' + id;

  const header = document.createElement('div');
  header.className = 'response-card-header';

  const meta = document.createElement('div');
  meta.className = 'meta';

  const spinner = document.createElement('div');
  spinner.className = 'spinner';

  const statusLabel = document.createElement('span');
  statusLabel.className = 'status-label streaming';
  statusLabel.textContent = 'Streaming';

  const time = document.createElement('span');
  time.textContent = new Date().toLocaleTimeString();

  meta.appendChild(spinner);
  meta.appendChild(statusLabel);
  meta.appendChild(time);

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'dismiss-btn';
  dismissBtn.title = 'Dismiss';
  dismissBtn.innerHTML = '&times;';
  dismissBtn.addEventListener('click', () => removeCard(card));

  header.appendChild(meta);
  header.appendChild(dismissBtn);

  const body = document.createElement('div');
  body.className = 'response-card-body';

  card.appendChild(header);
  card.appendChild(body);

  prependCard(card);
  enforceMaxCards();

  return card;
}

function prependCard(card) {
  hideEmptyState();
  if (cardStack.firstChild) {
    cardStack.insertBefore(card, cardStack.firstChild);
  } else {
    cardStack.appendChild(card);
  }
}

function removeCard(card) {
  card.remove();
  if (cardStack.children.length === 0) showEmptyState();
}

function enforceMaxCards() {
  while (cardStack.querySelectorAll('.response-card').length > MAX_CARDS) {
    const cards = cardStack.querySelectorAll('.response-card');
    removeCard(cards[cards.length - 1]);
  }
}

function setCardStatus(card, status, message) {
  card.classList.remove('streaming');

  const label = card.querySelector('.status-label');
  const spinner = card.querySelector('.spinner');

  if (label) {
    label.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    label.className = 'status-label ' + status;
  }
  if (spinner) spinner.style.display = 'none';

  if (status === 'error' && message) {
    const body = card.querySelector('.response-card-body');
    if (body) {
      body.innerHTML = '<span class="error-text">' + escapeHtml(message) + '</span>';
    }
  }
}

// --- API ---

function buildRequest(frames, prompt) {
  const content = frames.map((dataUrl) => ({
    type: 'image_url',
    image_url: { url: dataUrl },
  }));
  content.push({ type: 'text', text: prompt });

  return {
    messages: [{ role: 'user', content }],
    stream: true,
    top_k: 20,
    temperature: 0.8,
  };
}

async function fetchWithRetry(url, body, signal) {
  const deadline = Date.now() + RETRY_TIMEOUT_MS;
  let attempt = 0;

  while (true) {
    attempt++;
    try {
      const resp = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal,
      });

      if (resp.status === 503) {
        if (Date.now() >= deadline) {
          const errText = await resp.text().catch(() => 'Unknown error');
          throw new Error('HTTP 503: retry deadline exceeded (' + errText.slice(0, 200) + ')');
        }
        await sleep(Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS), signal);
        continue;
      }

      if (!resp.ok) {
        const errText = await resp.text().catch(() => 'Unknown error');
        throw new Error('HTTP ' + resp.status + ': ' + errText.slice(0, 300));
      }

      return resp;
    } catch (err) {
      if (err.name === 'AbortError') throw err;

      if (err instanceof TypeError) {
        if (Date.now() >= deadline) {
          throw new Error('Retry deadline exceeded after 5 minutes (server unavailable).');
        }
        await sleep(Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS), signal);
        continue;
      }

      throw err;
    }
  }
}

async function streamResponse(resp, bodyEl) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let contentReceived = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;

      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        const content = parsed?.choices?.[0]?.delta?.content;
        if (content) {
          bodyEl.textContent += content;
          contentReceived = true;
        }
      } catch (_) {}
    }
  }

  if (!contentReceived && !bodyEl.textContent) {
    bodyEl.textContent = '(No content returned)';
  }
}

async function sendFrameStack(frames, id) {
  const url = backendUrl.value.trim();
  if (!url) {
    const card = createCard(id);
    setCardStatus(card, 'error', 'No backend URL configured.');
    return;
  }

  const prompt = promptEl.value.trim();
  if (!prompt) {
    const card = createCard(id);
    setCardStatus(card, 'error', 'Prompt is empty.');
    return;
  }

  const card = createCard(id);
  const bodyEl = card.querySelector('.response-card-body');
  const abortController = new AbortController();

  try {
    const body = buildRequest(frames, prompt);
    const resp = await fetchWithRetry(url, body, abortController.signal);
    setStatus('ok');
    await streamResponse(resp, bodyEl);
    setCardStatus(card, 'done');
  } catch (err) {
    if (err.name === 'AbortError') {
      bodyEl.textContent += '\n\n[Cancelled]';
      setCardStatus(card, 'done');
      return;
    }
    setCardStatus(card, 'error', err.message);
    setStatus('err');
  }
}

// --- Helpers ---

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      }, { once: true });
    }
  });
}

function setStatus(state) {
  statusDot.classList.remove('ok', 'err');
  if (state) statusDot.classList.add(state);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}