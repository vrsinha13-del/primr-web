// src/lib/supabase_sync.js
// All Supabase reads/writes for PRIMR.
// Student data is NEVER read or written from the tables directly any more.
// Every call goes through a secure database function (see step1_student_functions.sql)
// and carries the student's id + session token, which the server checks.

import { supabase } from './supabase';

// Turn a server reply from register/login into a plain result object
function authResult(data, error) {
  if (error) return { success: false, error: error.message || 'network' };
  if (!data || data.ok !== true) return { success: false, error: data?.error || 'failed' };
  return { success: true, student: data.student, sessionToken: data.session_token, parentPin: data.parent_pin };
}

// ── 1. REGISTER / SIGN IN ───────────────────────────────────────────────────
export async function registerStudent({ name, email, grade, city, password }) {
  try {
    const { data, error } = await supabase.rpc('register_student', {
      p_name: name, p_email: email, p_grade: grade, p_city: city || '', p_password: password,
    });
    return authResult(data, error);
  } catch (err) {
    console.error('Registration exception:', err);
    return { success: false, error: 'network' };
  }
}

export async function loginStudent(email, password) {
  try {
    const { data, error } = await supabase.rpc('login_student', { p_email: email, p_password: password });
    return authResult(data, error);
  } catch (err) {
    console.error('loginStudent exception:', err);
    return { success: false, error: 'network' };
  }
}

export async function loginParent(email, pin) {
  try {
    const { data, error } = await supabase.rpc('login_parent', { p_email: email, p_pin: pin });
    return authResult(data, error);
  } catch (err) {
    console.error('loginParent exception:', err);
    return { success: false, error: 'network' };
  }
}

export async function changeParentPin(studentId, token, newPin) {
  try {
    const { data, error } = await supabase.rpc('change_parent_pin', {
      p_student: studentId, p_token: token, p_new_pin: newPin,
    });
    return { success: !error && data === true };
  } catch (err) {
    return { success: false };
  }
}

// ── 2. PRACTICE (all questions come from the server, a few at a time) ───────
// practice_serve: sends the answers made so far and returns the next questions.
// mode: 'start' (first batch), 'next' (refill), 'submit' (answers only).
// Returns { ok:true, data } or { ok:false } when the network or server failed
// (the caller keeps the answers and tries again).
export async function practiceServe({ studentId, token, subject, sessionId, answers, mode }) {
  try {
    const { data, error } = await supabase.rpc('practice_serve', {
      p_student: studentId, p_token: token, p_subject: subject,
      p_session: sessionId || null, p_answers: answers || [], p_mode: mode,
    });
    if (error || !data) { console.error('practice_serve error:', error); return { ok: false }; }
    return { ok: true, data };
  } catch (err) {
    console.error('practice_serve exception:', err);
    return { ok: false };
  }
}

export async function guestStart() {
  try {
    const { data, error } = await supabase.rpc('guest_start');
    if (error || !data?.guest_id) return { ok: false };
    return { ok: true, guestId: data.guest_id, guestToken: data.guest_token };
  } catch (err) {
    return { ok: false };
  }
}

export async function guestServe({ guestId, guestToken, subject, answers, mode, softSeen }) {
  try {
    const { data, error } = await supabase.rpc('guest_serve', {
      p_guest: guestId, p_token: guestToken, p_subject: subject,
      p_answers: answers || [], p_mode: mode, p_soft_seen: !!softSeen,
    });
    if (error || !data) { console.error('guest_serve error:', error); return { ok: false }; }
    return { ok: true, data };
  } catch (err) {
    console.error('guest_serve exception:', err);
    return { ok: false };
  }
}

// Progress per topic (accuracy, difficulty, mastery) and buddies / monthly titles
export async function fetchProgress(studentId, token) {
  try {
    const { data, error } = await supabase.rpc('my_progress', { p_student: studentId, p_token: token });
    if (error || !data || data.status !== 'ok') return { ok: false, status: data?.status };
    return { ok: true, topics: data.topics || [], rewards: data.rewards || {}, subjectTotals: data.subject_totals || {} };
  } catch (err) {
    console.error('fetchProgress exception:', err);
    return { ok: false };
  }
}

// ── 5. FETCH CITIES ─────────────────────────────────────────────────────────
// Returns unique list of cities from schools table — dynamic, no hardcoding

export async function fetchCities() {
  try {
    const { data, error } = await supabase
      .from('schools')
      .select('city')
      .eq('is_active', true)
      .order('city');

    if (error) { console.error('fetchCities error:', error); return []; }

    // Deduplicate cities
    const unique = [...new Set(data.map(r => r.city).filter(Boolean))];
    return unique;
  } catch (err) {
    console.error('fetchCities exception:', err);
    return [];
  }
}

// ── 6. FETCH SCHOOLS BY CITY ────────────────────────────────────────────────
// Returns schools for a given city — used in registration dropdown

export async function fetchSchools(city) {
  try {
    const { data, error } = await supabase
      .from('schools')
      .select('id, name, city')
      .eq('is_active', true)
      .eq('city', city)
      .order('name');

    if (error) { console.error('fetchSchools error:', error); return []; }
    return data || [];
  } catch (err) {
    console.error('fetchSchools exception:', err);
    return [];
  }
}

// ── 7. LINK STUDENT TO SCHOOL ───────────────────────────────────────────────
// Creates a pending request; the school admin must accept it.
export async function linkStudentToSchool(studentId, token, schoolId) {
  try {
    const { data, error } = await supabase.rpc('link_student_school', {
      p_student: studentId, p_token: token, p_school: schoolId,
    });
    if (error || data !== true) {
      console.error('linkStudentToSchool error:', error);
      return { success: false, error: error?.message || 'rejected' };
    }
    return { success: true };
  } catch (err) {
    console.error('linkStudentToSchool exception:', err);
    return { success: false, error: err.message };
  }
}

// ── 10. REPORT QUESTION ─────────────────────────────────────────────────────
// Records a report. The server switches the question off after 3 different students report it.
export async function reportQuestion(questionId, studentId, token, reason = 'student_report') {
  try {
    const { data, error } = await supabase.rpc('report_question', {
      p_student: studentId, p_token: token, p_question: questionId, p_reason: reason,
    });
    if (error || !data?.ok) {
      console.error('reportQuestion error:', error || data);
      return { success: false, error: error?.message || data?.error || 'rejected' };
    }
    return { success: true };
  } catch (err) {
    console.error('reportQuestion exception:', err);
    return { success: false, error: err.message };
  }
}

// ── 11. SESSION TOKEN — single login enforcement ─────────────────────────────
// The token is created by the server at sign-in. This only checks it / clears it.
// Returns true if still valid, false if another device has signed in.
export async function verifySessionToken(studentId, token) {
  try {
    const { data, error } = await supabase.rpc('verify_session', { p_student: studentId, p_token: token });
    if (error) { console.error('verifySessionToken error:', error); return true; } // fail open on network error
    return data === true;
  } catch (err) {
    console.error('verifySessionToken exception:', err);
    return true;
  }
}

export async function clearSessionToken(studentId, token) {
  try {
    await supabase.rpc('logout_student', { p_student: studentId, p_token: token });
  } catch (err) {
    console.error('clearSessionToken exception:', err);
  }
}

// ── 12. FETCH STUDENT SESSIONS ───────────────────────────────────────────────
export async function fetchStudentSessions(studentId, token) {
  try {
    const { data, error } = await supabase.rpc('fetch_my_sessions', { p_student: studentId, p_token: token });
    if (error) {
      console.error('fetchStudentSessions error:', error);
      return [];
    }
    return (data || []).map(s => ({
      subject:           (s.subject || '').toLowerCase(),
      questionsAnswered: s.total_attempted,
      correct:           s.total_correct,
      wrong:             s.total_wrong,
      level:             s.question_level || '6',
      date:              new Date(s.ended_at).getTime(),
      easyAttempted:     s.easy_attempted   || 0,
      mediumAttempted:   s.medium_attempted || 0,
      hardAttempted:     s.hard_attempted   || 0,
      durationSeconds:   s.duration_seconds || 0,
    }));
  } catch (err) {
    console.error('fetchStudentSessions exception:', err);
    return [];
  }
}
