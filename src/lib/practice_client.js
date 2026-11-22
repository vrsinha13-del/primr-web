// src/lib/practice_client.js
// Runs one practice session against the server.
//
// The server chooses the questions (6 to start, then 5 at a time) and judges the
// answers. This file keeps a small buffer of questions ahead of the student,
// remembers answers that have not reached the server yet (also across a closed
// tab), and keeps trying when the connection is weak.

import { practiceServe, guestServe } from './supabase_sync';

const QUEUE_KEY = 'primr-answer-queue';
const REFILL_AT = 3;          // ask for more when this many questions are left
const MAX_WAIT  = 30000;      // longest pause between retries (ms)

// ── answers waiting to be saved, kept in this browser ───────────────────────
function readQueues() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch (e) { return []; }
}
function writeQueues(list) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(list.slice(-30))); } catch (e) { /* storage blocked: carry on */ }
}
function saveQueue(owner, subject, sessionId, answers) {
  const rest = readQueues().filter(e => !(e.owner === owner && e.subject === subject));
  if (answers.length) rest.push({ owner, subject, sessionId, answers });
  writeQueues(rest);
}

// Send answers left over from an earlier practice (closed tab, lost connection).
// Best effort: whatever cannot be sent stays queued for next time.
export async function flushLeftoverAnswers(studentId, token) {
  if (!studentId || !token) return 0;
  let sent = 0;
  for (const e of readQueues().filter(x => x.owner === studentId)) {
    const r = await practiceServe({ studentId, token, subject: e.subject, sessionId: e.sessionId, answers: e.answers, mode: 'submit' });
    if (r.ok) { saveQueue(studentId, e.subject, e.sessionId, []); sent += e.answers.length; }
  }
  return sent;
}

export function clearLeftoverAnswers(studentId) {
  writeQueues(readQueues().filter(e => e.owner !== studentId));
}

// ── the shape the practice screen already knows ──────────────────────────────
function normalise(q) {
  return {
    ...q,
    q:     q.question,
    opts:  [q.option_a, q.option_b, q.option_c, q.option_d],
    ans:   q.answer,        // letter A-D
    exp:   q.explanation,
  };
}

export class PracticeClient {
  // auth: { kind:'student', studentId, token } or { kind:'guest' }
  // guestApi: { get(), create(), reset(), softSeen() }   (guests only)
  constructor({ subject, auth, guestApi, onChange, onUnlock, onGuest }) {
    this.subject  = subject;
    this.auth     = auth;
    this.guestApi = guestApi;
    this.onChange = onChange || (() => {});
    this.onUnlock = onUnlock || (() => {});
    this.onGuest  = onGuest  || (() => {});
    this.buffer     = [];
    this.queue      = [];       // answers not yet confirmed by the server
    this.sessionId  = null;
    this.started    = false;
    this.inflight   = false;
    this.terminal   = null;     // 'trial_ended' | 'daily_limit' | 'guest_limit' | 'no_questions' | 'replaced' | 'error'
    this.waiting    = false;    // true while the connection is failing
    this.retries    = 0;
    this.timer      = null;
    this.destroyed  = false;
    this.finishing  = false;
    this.answered   = 0;
    this.correct    = 0;
    this.lastLevel  = '6';
    this.lostAnswers = false;
    this._onOnline  = () => this.retryNow();
    this._onHide    = () => { if (document.visibilityState === 'hidden') this._flush(); };
    window.addEventListener('online', this._onOnline);
    document.addEventListener('visibilitychange', this._onHide);
  }

  get isStudent() { return this.auth.kind === 'student'; }

  _emit() { if (!this.destroyed) this.onChange(); }

  _persist() {
    if (this.isStudent) saveQueue(this.auth.studentId, this.subject, this.sessionId, this.queue);
  }

  async _call(mode, answers) {
    if (this.isStudent) {
      return practiceServe({
        studentId: this.auth.studentId, token: this.auth.token, subject: this.subject,
        sessionId: this.sessionId, answers, mode,
      });
    }
    let g = this.guestApi.get();
    if (!g) g = await this.guestApi.create();
    if (!g) return { ok: false };
    return guestServe({
      guestId: g.id, guestToken: g.token, subject: this.subject, answers, mode,
      softSeen: this.guestApi.softSeen(),
    });
  }

  // one round trip: send the waiting answers, receive more questions
  async _serve(mode) {
    if (this.inflight || this.destroyed) return;
    this.inflight = true;
    const snapshot = this.queue.slice();
    let res = await this._call(mode, snapshot);
    if (res.ok && !this.isStudent && res.data?.status === 'guest_expired') {
      // the guest record expired on the server: start a fresh guest, old answers are gone
      await this.guestApi.reset();
      this.queue = [];
      this.lostAnswers = true;
      res = await this._call('start', []);
    }
    this.inflight = false;
    if (this.destroyed) return;

    if (!res.ok) {
      this.retries += 1;
      this.waiting = this.buffer.length === 0;
      this._emit();
      this._scheduleRetry(mode === 'start' || !this.started ? 'start' : 'next');
      return;
    }

    this.retries = 0;
    this.waiting = false;
    const d = res.data;

    if (d.status === 'session_replaced') {
      this.terminal = 'replaced';
      this.lostAnswers = this.lostAnswers || this.queue.length > 0;
      this._emit();
      return;
    }
    if (d.status === 'bad_subject') { this.terminal = 'error'; this._emit(); return; }

    // the server has seen these answers (counted, or already counted before)
    const done = new Set(snapshot.map(a => a.question_id));
    this.queue = this.queue.filter(a => !done.has(a.question_id));
    if (d.session_id) this.sessionId = d.session_id;
    this._persist();

    if (Array.isArray(d.questions) && d.questions.length) {
      this.buffer.push(...d.questions.map(normalise));
      this.lastLevel = String(d.questions[d.questions.length - 1].question_level || this.lastLevel);
    }
    (d.unlocks || []).forEach(u => this.onUnlock(u.message));
    if (d.guest) this.onGuest(d.guest);
    if (mode === 'start') this.started = true;
    if (mode !== 'submit' && ['trial_ended', 'daily_limit', 'guest_limit', 'no_questions'].includes(d.status)) {
      this.terminal = d.status;
      this.started = true;
    }
    this._emit();
    this._maybeRefill();
  }

  _scheduleRetry(mode) {
    clearTimeout(this.timer);
    if (this.destroyed || this.terminal) return;
    const wait = Math.min(MAX_WAIT, 1500 * Math.pow(2, Math.max(0, this.retries - 1)));
    this.timer = setTimeout(() => this._serve(mode), wait);
  }

  retryNow() {
    if (this.destroyed || this.terminal || this.inflight) return;
    clearTimeout(this.timer);
    if (this.buffer.length === 0 || !this.started || this.queue.length) {
      this._serve(this.started ? 'next' : 'start');
    }
  }

  _maybeRefill() {
    if (this.destroyed || this.inflight || this.terminal || this.finishing || !this.started) return;
    if (this.buffer.length <= REFILL_AT) this._serve('next');
  }

  async _flush() {
    if (this.destroyed || this.inflight || !this.queue.length || !this.started) return;
    this._serve('submit');
  }

  // ── what the screen calls ──
  async start() {
    if (this.isStudent) {
      await Promise.race([
        flushLeftoverAnswers(this.auth.studentId, this.auth.token),
        new Promise(r => setTimeout(r, 4000)),
      ]);
    }
    await this._serve('start');
  }

  // next question, or null when none is ready yet
  take() {
    const q = this.buffer.shift() || null;
    if (q) { this._maybeRefill(); this._emit(); }
    return q;
  }

  // the student answered: remember it and, when needed, ask for more questions
  answer(question, answerGivenLetter, timeTakenSec, isCorrect) {
    this.queue.push({
      question_id:    question.id,
      answer_given:   answerGivenLetter || null,
      time_taken_sec: Math.max(0, Math.round(timeTakenSec || 0)),
      answered_at:    new Date().toISOString(),
    });
    this.answered += 1;
    if (isCorrect) this.correct += 1;
    this._persist();
    this._maybeRefill();
  }

  // a reported question must not be shown again from the buffer
  drop(questionId) {
    this.buffer = this.buffer.filter(q => q.id !== questionId);
    this._emit();
  }

  // end of practice: hand over the last answers
  async finish() {
    this.finishing = true;
    clearTimeout(this.timer);
    for (let i = 0; i < 40 && this.inflight; i++) await new Promise(r => setTimeout(r, 250));
    for (let attempt = 0; attempt < 3 && this.queue.length && this.terminal !== 'replaced' && this.terminal !== 'error'; attempt++) {
      await this._serve('submit');
      if (this.queue.length) await new Promise(r => setTimeout(r, 1200));
    }
    const replaced = this.terminal === 'replaced';
    return { saved: this.queue.length === 0 && !replaced, replaced, lost: this.lostAnswers };
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.timer);
    window.removeEventListener('online', this._onOnline);
    document.removeEventListener('visibilitychange', this._onHide);
  }
}
