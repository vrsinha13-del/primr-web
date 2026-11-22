// src/lib/store.js
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { calculateStreak, guestLimitReachedForSubject } from './engine';
import { registerStudent, linkStudentToSchool, guestStart, fetchProgress } from './supabase_sync';
import { recordsFromTopics } from './progress_view';
import { clearLeftoverAnswers } from './practice_client';

export const SUBJECTS = [
  { id:'maths',     label:'Mathematics',       short:'Maths',     icon:'∑',  color:'#F2A93B', light:'#FCE7C2' },
  { id:'reasoning', label:'Reasoning',         short:'Reasoning', icon:'⚡', color:'#F0654B', light:'#FBD9CE' },
  { id:'english',   label:'English',           short:'English',   icon:'Aa', color:'#16A38A', light:'#C5EFE4' },
  { id:'gk',        label:'General Knowledge', short:'GK',        icon:'🌍', color:'#7C4DFF', light:'#E1D6FF' },
];

// What a student sees of their progress is worked out on the server and only
// shown here. Nothing about questions, answers or marks is calculated on the phone.
const EMPTY_LEARNING = {
  topicRecords:   {},   // answered / correct per topic (for averages and hints)
  progressTopics: [],   // full per-topic report from the server (mastery, difficulty)
  rewardState:    {},   // buddies and monthly titles, per subject
};

export const useStore = create(
  persist(
    (set, get) => ({

      syncWarning:     false,

      // ── User ────────────────────────────────────────────────
      user:           null,
      isLoggedIn:     false,
      sessionToken:   null,

      // ── Guest tracking ──────────────────────────────────────
      guest:          null,   // { id, token } — a temporary guest record on the server
      guestCounts:    {},
      softPromptSeen: {},

      // ── Learning data (from the server) ─────────────────────
      ...EMPTY_LEARNING,
      sessionHistory: [],
      lastSession:    null,
      activeSession:  null,

      // ── Auth ────────────────────────────────────────────────
      // `token` is the session token issued by the server at sign-in.
      login: async (userData, token) => {
        // Never keep a password or PIN hanging around in the browser
        if (userData) { delete userData.password; }

        set({
          user:           { ...userData, sessionToken: token },
          isLoggedIn:     true,
          guest:          null,
          guestCounts:    {},
          softPromptSeen: {},
          sessionToken:   token,
          ...EMPTY_LEARNING,
          sessionHistory: [],
          lastSession:    null,
          activeSession:  null,
        });

        if (userData.supabaseId && token) {
          try {
            const { fetchStudentSessions } = await import('./supabase_sync');
            const sessions = await fetchStudentSessions(userData.supabaseId, token);
            set({
              sessionHistory: sessions,
              lastSession: sessions.length > 0 ? {
                questionsAnswered: sessions[0].questionsAnswered,
                date:              sessions[0].date,
                subject:           sessions[0].subject,
              } : null,
            });
          } catch (e) {
            console.error('login: could not load sessions', e);
          }
          await get().refreshProgress();
        }
      },

      // Ask the server for the latest progress, buddies and titles
      refreshProgress: async () => {
        const s = get();
        if (!s.isLoggedIn || !s.user?.supabaseId || !s.sessionToken) return false;
        const p = await fetchProgress(s.user.supabaseId, s.sessionToken);
        if (!p.ok) return false;
        set({
          topicRecords:   recordsFromTopics(p.topics),
          progressTopics: p.topics,
          rewardState:    p.rewards,
        });
        return true;
      },

      logout: async () => {
        const s = get();
        if (s.user?.supabaseId) {
          try {
            // hand over any answers still waiting, then sign out
            const { flushLeftoverAnswers } = await import('./practice_client');
            await Promise.race([
              flushLeftoverAnswers(s.user.supabaseId, s.sessionToken),
              new Promise(r => setTimeout(r, 4000)),
            ]);
            const { clearSessionToken } = await import('./supabase_sync');
            await clearSessionToken(s.user.supabaseId, s.sessionToken);
          } catch (e) { console.error('logout cleanup failed:', e); }
        }
        set({
          user:           null,
          isLoggedIn:     false,
          sessionToken:   null,
          ...EMPTY_LEARNING,
          sessionHistory: [],
          lastSession:    null,
          activeSession:  null,
          guestCounts:    {},
          softPromptSeen: {},
        });
      },

      // ── Verify session still valid ────────────────────────────────
      verifySession: async () => {
        const s = get();
        if (!s.isLoggedIn || !s.user?.supabaseId) return true;

        // Signed in before single-login existed: sign in again to get a proper token
        if (!s.sessionToken) {
          set({ user: null, isLoggedIn: false, sessionToken: null });
          return false;
        }

        try {
          const { verifySessionToken } = await import('./supabase_sync');
          const valid = await verifySessionToken(s.user.supabaseId, s.sessionToken);
          if (!valid) {
            set({ user: null, isLoggedIn: false, sessionToken: null });
            return false;
          }
          return true;
        } catch (e) {
          return true; // fail open on network error
        }
      },

      // ── Trial helpers ─────────────────────────────────────────
      isTrialExpired: () => {
        const s = get();
        if (!s.isLoggedIn || !s.user) return false;
        if (s.user.subscriptionStatus === 'active') return false;
        if (!s.user.trialEndsAt) return false;
        return new Date() > new Date(s.user.trialEndsAt);
      },

      trialDaysLeft: () => {
        const s = get();
        if (!s.isLoggedIn || !s.user?.trialEndsAt) return null;
        const diff = new Date(s.user.trialEndsAt) - new Date();
        return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
      },

      // ── Guests ────────────────────────────────────────────────
      // The server keeps the guest's questions and counts; the numbers here
      // only decide when to show the sign-in prompts.
      guestStatus: (subject) => {
        const s = get();
        if (s.isLoggedIn) return 'ok';
        const count = s.guestCounts[subject] || 0;
        if (count >= 20) return 'hard';
        if (count >= 10 && !s.softPromptSeen[subject]) return 'soft';
        return 'ok';
      },

      isGuestLimited: (subject) => {
        const s = get();
        if (s.isLoggedIn) return false;
        return guestLimitReachedForSubject(s.guestCounts, subject);
      },

      markSoftPromptSeen: (subject) => {
        const s = get();
        set({ softPromptSeen: { ...s.softPromptSeen, [subject]: true } });
      },

      createGuest: async () => {
        const g = await guestStart();
        if (!g.ok) return null;
        const guest = { id: g.guestId, token: g.guestToken };
        set({ guest, guestCounts: {}, softPromptSeen: {} });
        return guest;
      },

      resetGuest: async () => { set({ guest: null, guestCounts: {}, softPromptSeen: {} }); },

      // numbers the server reports for a guest (it is the truth when ours is lower)
      syncGuestCounts: (subject, answered) => {
        const s = get();
        if (s.isLoggedIn) return;
        if ((s.guestCounts[subject] || 0) < answered) {
          set({ guestCounts: { ...s.guestCounts, [subject]: answered } });
        }
      },

      // ── Register ─────────────────────────────────────────────
      register: async (userData) => {
        const email = userData.email.trim().toLowerCase();
        const result = await registerStudent({
          name:     userData.name,
          email,
          grade:    userData.grade,
          city:     userData.city || '',
          password: userData.password,
        });

        // No silent local-only accounts: if the server says no, tell the student
        if (!result.success) {
          const e = new Error(result.error || 'failed');
          e.code = result.error || 'failed';
          throw e;
        }

        const st = result.student;
        const newUser = {
          id:                 st.id,
          supabaseId:         st.id,
          name:               st.full_name,
          email:              st.email,
          grade:              st.grade,
          city:               st.city || '',
          // Shown once on the "welcome" screen; replaced when the parent sets a private PIN
          parentPin:          result.parentPin,
          parentPinChanged:   false,
          streak:             0,
          lastPracticeDate:   null,
          schoolId:           userData.schoolId || null,
          shareData:          userData.shareData || false,
          trialEndsAt:        st.trial_ends_at,
          subscriptionStatus: st.subscription_status || 'trial',
        };
        const token = result.sessionToken;

        if (userData.schoolId && userData.shareData) {
          await linkStudentToSchool(st.id, token, userData.schoolId);
        }

        // A brand-new account starts empty — never inherit a previous student's progress.
        set({
          user:           { ...newUser, sessionToken: token },
          isLoggedIn:     true,
          guest:          null,
          guestCounts:    {},
          sessionToken:   token,
          sessionHistory: [],
          lastSession:    null,
          ...EMPTY_LEARNING,
          activeSession:  null,
        });
        clearLeftoverAnswers(st.id);

        return { user: newUser, pin: result.parentPin };
      },

      // ── A practice session ───────────────────────────────────
      // The server saves every answer as it arrives; these are only the counters
      // for the "practice finished" screen.
      startSession: (subject) => set({
        activeSession: {
          subject,
          questionsAnswered: 0,
          correct:           0,
          wrong:             0,
          startedAt:         Date.now(),
        },
      }),

      recordLocalAnswer: (subject, isCorrect) => {
        const s = get();
        const guestCounts = s.isLoggedIn
          ? s.guestCounts
          : { ...s.guestCounts, [subject]: (s.guestCounts[subject] || 0) + 1 };
        const a = s.activeSession;
        set({
          guestCounts,
          activeSession: a ? {
            ...a,
            questionsAnswered: a.questionsAnswered + 1,
            correct:           a.correct + (isCorrect ? 1 : 0),
            wrong:             a.wrong   + (isCorrect ? 0 : 1),
          } : a,
        });
      },

      setSyncWarning: (v) => set({ syncWarning: !!v }),

      endSession: async (subject, questionsAnswered, level) => {
        const s     = get();
        const today = new Date().toDateString();
        const streak = calculateStreak(s.user?.streak || 0, s.user?.lastPracticeDate || null);
        const correct = s.activeSession?.correct || 0;
        const wrong   = s.activeSession?.wrong   || 0;

        const entry = {
          subject, questionsAnswered, correct, wrong,
          level: level || '6',
          date:  Date.now(),
        };

        set({
          activeSession:  null,
          lastSession:    questionsAnswered > 0 ? { questionsAnswered, date: Date.now(), subject } : s.lastSession,
          sessionHistory: questionsAnswered > 0 ? [entry, ...s.sessionHistory].slice(0, 200) : s.sessionHistory,
          user: s.user && questionsAnswered > 0 ? { ...s.user, streak, lastPracticeDate: today } : s.user,
        });

        // fresh progress, buddies and titles from the server
        if (s.isLoggedIn && questionsAnswered > 0) await get().refreshProgress();
        return { replaced: false };
      },

    }),

    {
      name: 'leapiq-v3',
      version: 2,
      // Older versions kept the whole question bank, answer history and
      // progress maths in the browser. None of that is used any more.
      migrate: (old) => ({
        user:           old?.user ?? null,
        isLoggedIn:     !!old?.isLoggedIn,
        sessionToken:   old?.sessionToken ?? null,
        sessionHistory: old?.sessionHistory ?? [],
        lastSession:    old?.lastSession ?? null,
        guest:          null,
        guestCounts:    {},
        softPromptSeen: {},
        ...EMPTY_LEARNING,
      }),
      partialize: (s) => ({
        user:           s.user,
        isLoggedIn:     s.isLoggedIn,
        sessionToken:   s.sessionToken,
        guest:          s.guest,
        guestCounts:    s.guestCounts,
        softPromptSeen: s.softPromptSeen,
        topicRecords:   s.topicRecords,
        progressTopics: s.progressTopics,
        rewardState:    s.rewardState,
        sessionHistory: s.sessionHistory,
        lastSession:    s.lastSession,
      }),
    }
  )
);
