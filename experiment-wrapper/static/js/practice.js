/*
 * Wrapper around <tone-phrase-trainer>.
 *
 * The component owns everything inside the white card: microphone, Praat/WASM
 * analysis, segmentation, classification, the contour drawing, and the
 * per-syllable verdict. This file owns everything around it — sequencing,
 * timers, the progress pips, and persistence — and treats the component's
 * `attempt` event as the only data contract between the two.
 *
 * Nothing here re-implements scoring. The server re-derives `passed` from the
 * payload; the response tells us whether to advance.
 */

const config = JSON.parse(document.getElementById('practice-config').textContent);
const trainer = document.getElementById('trainer');

const els = {
  verdict: document.querySelector('[data-el="verdict"]'),
  diagnostic: document.querySelector('[data-el="diagnostic"]'),
  itemTimer: document.querySelector('[data-el="item-timer"]'),
  totalTimer: document.querySelector('[data-el="total-timer"]'),
  prev: document.querySelector('[data-nav="prev"]'),
  next: document.querySelector('[data-nav="next"]'),
  pips: Array.from(document.querySelectorAll('[data-pip]'))
};

let index = 0;
let busy = false;
const attemptsUsed = config.phrases.map(() => 0);
const settled = config.phrases.map(() => false);

/* ------------------------------------------------------------- timers */

const sessionStart = Date.now();
let itemStart = Date.now();

function fmt (seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

setInterval(() => {
  els.itemTimer.textContent = fmt((Date.now() - itemStart) / 1000);
  els.totalTimer.textContent = fmt((Date.now() - sessionStart) / 1000);
}, 250);

/* --------------------------------------------------------------- csrf */

function csrfToken () {
  const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : '';
}

/* ------------------------------------------------------------ trainer */

trainer.phrases = config.phrases;

/*
 * Hand back a normalizer the student already established, so they calibrate
 * once rather than at the start of every session. The component skips its own
 * calibration when the normalizer it is given is already trusted.
 */
if (config.calibration && typeof trainer.normalizer?.fromJSON === 'function') {
  try {
    trainer.normalizer.fromJSON(config.calibration);
  } catch (err) {
    console.warn('could not restore calibration; recalibrating', err);
  }
}

function showIndex (i) {
  index = Math.max(0, Math.min(i, config.phrases.length - 1));
  trainer.phraseIndex = index;
  trainer.reset();
  itemStart = Date.now();
  clearFeedback();
  syncNav();
}

function clearFeedback () {
  els.verdict.hidden = true;
  els.verdict.textContent = '';
  els.diagnostic.textContent = '';
}

function syncNav () {
  els.prev.disabled = index === 0;
  // Forward movement is earned: you may not skip an item you haven't settled.
  els.next.disabled = !settled[index] && attemptsUsed[index] < config.maxAttempts;
}

function paintPip (i, state) {
  const pip = els.pips[i];
  if (!pip) return;
  pip.className = `pip pip--${state}`;
}

els.prev.addEventListener('click', () => showIndex(index - 1));
els.next.addEventListener('click', () => advance());

function advance () {
  if (index + 1 < config.phrases.length) {
    showIndex(index + 1);
  } else {
    finish();
  }
}

/* ------------------------------------------------------------ attempts */

trainer.addEventListener('attempt', async (event) => {
  if (busy) return;
  const at = index;

  if (attemptsUsed[at] >= config.maxAttempts) return;
  busy = true;

  const body = {
    itemId: config.itemIds[at],
    detail: event.detail,
    elapsedSec: (Date.now() - itemStart) / 1000
  };

  let result;
  try {
    const response = await fetch(config.attemptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrfToken() },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`server said ${response.status}`);
    result = await response.json();
  } catch (err) {
    console.error('could not save attempt', err);
    els.diagnostic.textContent = "Couldn't save that attempt — check your connection.";
    busy = false;
    return;
  }

  attemptsUsed[at] += 1;
  settled[at] = result.advance;

  els.verdict.hidden = false;
  els.verdict.textContent = result.label;
  els.verdict.style.background = result.color;
  els.verdict.classList.toggle('verdict--close', result.verdict === 'close');

  // After failing ONCE, a sentence appears to give advice. After the second
  // failure the learner moves on regardless — that is the July 22 rule.
  els.diagnostic.textContent = result.passed ? '' : (result.diagnostic || '');

  paintPip(at, result.passed ? 'good' : (result.attemptsRemaining > 0 ? 'close' : 'bad'));
  syncNav();

  if (result.advance) {
    setTimeout(() => { if (index === at) advance(); }, 1400);
  }
  busy = false;
});

trainer.addEventListener('error', (event) => {
  els.diagnostic.textContent = event.detail?.message || 'The analyzer had a problem.';
});

/* -------------------------------------------------------------- finish */

async function finish () {
  try {
    const response = await fetch(config.doneUrl.replace(/done\/$/, 'finish/'), {
      method: 'POST',
      headers: { 'X-CSRFToken': csrfToken() }
    });
    const data = await response.json();
    window.location.href = data.doneUrl || config.doneUrl;
  } catch (err) {
    console.error('could not close out the session', err);
    window.location.href = config.doneUrl;
  }
}

showIndex(0);
