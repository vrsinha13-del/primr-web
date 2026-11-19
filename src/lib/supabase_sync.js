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

// ── 2. SESSION SAVE ────────────────────────────────────────────────────────
export async function saveSession({
  studentId, token, subject, questionsAnswered, correct, wrong,
  easyAttempted, mediumAttempted, hardAttempted, durationSeconds, level,
}) {
  if (!studentId || !token) return { success: false, error: 'No student session' };
  try {
    const { data, error } = await supabase.rpc('save_session', {
      p_student: studentId, p_token: token, p_subject: subject, p_level: level || '6',
      p_total: questionsAnswered || 0, p_correct: correct || 0, p_wrong: wrong || 0,
      p_easy: easyAttempted || 0, p_medium: mediumAttempted || 0, p_hard: hardAttempted || 0,
      p_duration: durationSeconds || 0,
    });
    if (error) {
      console.error('Session save error:', error);
      return { success: false, error: error.message || 'network' };
    }
    // The server answers "nothing" when the session token is no longer valid,
    // i.e. the student signed in somewhere else after this window.
    if (!data) return { success: false, error: 'session_replaced' };
    return { success: true, sessionId: data };
  } catch (err) {
    console.error('Session save exception:', err);
    return { success: false, error: err.message };
  }
}

// ── 3. SAVE STUDENT ANSWERS ─────────────────────────────────────────────────
export async function saveAnswers(studentId, token, sessionId, answers) {
  if (!studentId || !token || !sessionId || !answers?.length) return { success: false };
  try {
    const rows = answers.map(a => ({
      question_id:    a.question_id,
      subject:        a.subject,
      topic:          a.topic,
      difficulty:     a.difficulty,
      question_level: a.question_level,
      answer_given:   a.answer_given,
      correct_answer: a.correct_answer,
      is_correct:     a.is_correct,
      time_taken_sec: a.time_taken_sec,
      answered_at:    a.answered_at,
    }));

    // The server accepts up to 500 rows per call
    let saved = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const { data, error } = await supabase.rpc('save_answers', {
        p_student: studentId, p_token: token, p_session: sessionId, p_rows: rows.slice(i, i + 500),
      });
      if (error || typeof data !== 'number' || data < 0) {
        console.error('saveAnswers error:', error);
        return { success: false, error: error?.message || 'rejected' };
      }
      saved += data;
    }
    return { success: true, count: saved };
  } catch (err) {
    console.error('saveAnswers exception:', err);
    return { success: false, error: err.message };
  }
}

// ── 3b. FETCH ANSWERED QUESTION HISTORY ─────────────────────────────────────
// Rebuilds answeredCorrectly / answeredWrongly from the student's full answer
// history, and returns the raw rows so store.js can rebuild topic records.
// Paginated to avoid Supabase's 1000-row default limit.
export async function fetchAnsweredHistory(studentId, token) {
  const result = { answeredCorrectly: {}, answeredWrongly: {}, rows: [] };
  if (!studentId || !token) return result;

  try {
    let allRows = [];
    let from    = 0;
    const PAGE  = 1000;

    while (true) {
      const { data, error } = await supabase
        .rpc('fetch_my_answers', { p_student: studentId, p_token: token })
        .range(from, from + PAGE - 1);

      if (error) {
        console.error('fetchAnsweredHistory error:', error);
        break;
      }
      if (!data || data.length === 0) break;
      allRows = [...allRows, ...data];
      if (data.length < PAGE) break;
      from += PAGE;
    }

    result.rows = allRows;

    // Oldest to newest: a later correct attempt overrides an earlier wrong one.
    for (const row of allRows) {
      if (!row.question_id) continue;
      if (row.is_correct) {
        result.answeredCorrectly[row.question_id] = true;
        delete result.answeredWrongly[row.question_id];
      } else if (!result.answeredCorrectly[row.question_id]) {
        result.answeredWrongly[row.question_id] = 0;
      }
    }
    return result;
  } catch (err) {
    console.error('fetchAnsweredHistory exception:', err);
    return result;
  }
}

// ── 3. QUESTION FETCH ──────────────────────────────────────────────────────
// Called on app load or when subject is selected
// Loads questions from question_bank table
// Falls back to local questions.js if Supabase fails

export async function fetchQuestions(subject) {
  try {
    const today = new Date().toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('question_bank')
      .select('*')
      .eq('subject', subject.charAt(0).toUpperCase() + subject.slice(1))
      .eq('is_active', true)
      .or(`is_evergreen.eq.true,expires_at.gt.${today}`)
      .order('id');

    if (error) {
      console.error('Question fetch error:', error);
      return { success: false, questions: [] };
    }

    // Normalise to engine format
    // Engine expects: id, topic, question_level, difficulty, category,
    //                 q (or question), opts (or option_a/b/c/d),
    //                 ans (or answer), exp (or explanation)
    const normalised = data.map(q => ({
      id:             q.id,
      subject:        q.subject?.toLowerCase(),
      question_level: String(q.question_level || '6'),
      chapter:        q.chapter,
      category:       q.category,
      topic:          q.topic,
      difficulty:     q.difficulty?.toLowerCase(),
      q:              q.question,
      question:       q.question,
      opts:           [q.option_a, q.option_b, q.option_c, q.option_d],
      option_a:       q.option_a,
      option_b:       q.option_b,
      option_c:       q.option_c,
      option_d:       q.option_d,
      ans:            q.answer,
      answer:         q.answer,
      exp:            q.explanation,
      explanation:    q.explanation,
      is_evergreen:   q.is_evergreen,
      expires_at:     q.expires_at,
    }));

    return { success: true, questions: normalised };
  } catch (err) {
    console.error('Question fetch exception:', err);
    return { success: false, questions: [] };
  }
}

// ── 4. FETCH ALL SUBJECTS AT ONCE ──────────────────────────────────────────
// Fetches each subject separately to avoid Supabase 1000-row default limit
// Returns { maths: [...], reasoning: [...], english: [...], gk: [...] }

export async function fetchAllQuestions() {
  const today = new Date().toISOString().split('T')[0];

  try {
    const result = { maths: [], reasoning: [], english: [], gk: [] };

    // Fetch each subject separately — avoids 1000 row limit
    for (const [key, subjectName] of [['maths','Maths'],['reasoning','Reasoning'],['english','English'],['gk','GK']]) {
      let allRows = [];
      let from    = 0;
      const PAGE  = 1000;

      // Paginate until all rows fetched
      while (true) {
        const { data, error } = await supabase
          .from('question_bank')
          .select('*')
          .eq('subject', subjectName)
          .eq('is_active', true)
          .order('id')
          .range(from, from + PAGE - 1);

        if (error) {
          console.error(`Fetch ${subjectName} error:`, error);
          break;
        }

        if (!data || data.length === 0) break;
        allRows = [...allRows, ...data];
        if (data.length < PAGE) break;  // last page
        from += PAGE;
      }

      // Normalise
      result[key] = allRows.map(q => ({
        id:             q.id,
        subject:        key,
        question_level: String(q.question_level || '6'),
        chapter:        q.chapter,
        category:       q.category,
        topic:          q.topic,
        difficulty:     q.difficulty?.toLowerCase(),
        q:              q.question,
        question:       q.question,
        opts:           [q.option_a, q.option_b, q.option_c, q.option_d],
        option_a:       q.option_a,
        option_b:       q.option_b,
        option_c:       q.option_c,
        option_d:       q.option_d,
        ans:            q.answer,
        answer:         q.answer,
        exp:            q.explanation,
        explanation:    q.explanation,
        is_evergreen:   q.is_evergreen,
        expires_at:     q.expires_at,
      }));

      console.log(`PRIMR: Loaded ${result[key].length} ${subjectName} questions`);
    }

    return result;
  } catch (err) {
    console.error('Fetch all exception:', err);
    return null;
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
