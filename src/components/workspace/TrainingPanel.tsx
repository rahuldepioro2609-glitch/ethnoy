// Institute Workspace: training records (R-12) — courses, scheduled sessions and enrolled learners
// (GET /api/center/training, POST /api/center/training/courses|sessions|enrollments).
// - ELTNOY hosts no live session; a session is a date and time the Institute runs itself.
// - Learner progress is not tracked and certificates are not issued: R-13 requires certificate IDs that can
//   be verified, and no verification exists yet. Neither is offered here.
import React, { useMemo, useState } from 'react';
import { ApiError } from '../../api';
import { indiaToday } from './InterviewsPanel';
import { sendWorkspaceWrite, useWorkspaceResource } from './useWorkspaceResource';

interface CourseRow { id: string; title: string; category: string; module_count: number; created_at: string }
interface SessionRow { id: string; course_id: string | null; title: string; session_date: string; session_time: string }
interface EnrollmentRow { id: string; course_id: string; learner_name: string; learner_email: string; created_at: string }

const inputClass = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100';
const errorText = (error: unknown) => (error instanceof ApiError || error instanceof Error ? error.message : 'The request could not be completed.');
const dateLabel = (value: string) => {
  const [y, m, d] = value.split('-').map(Number);
  return y && m && d ? new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }) : value;
};

/** One small form with its own saving and error state. */
function useWrite() {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<void>) => {
    setSaving(true);
    setError(null);
    try { await work(); } catch (caught) { setError(errorText(caught)); } finally { setSaving(false); }
  };
  return { saving, error, run };
}

const FormError: React.FC<{ error: string | null }> = ({ error }) => (error ? <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 sm:col-span-4">{error}</p> : null);

export const TrainingPanel: React.FC = () => {
  const data = useWorkspaceResource<{ courses: CourseRow[]; sessions: SessionRow[]; enrollments: EnrollmentRow[] }>('/api/center/training');
  const [notice, setNotice] = useState<string | null>(null);
  const [course, setCourse] = useState({ title: '', category: 'General', moduleCount: '1' });
  const [session, setSession] = useState({ courseId: '', title: '', sessionDate: '', sessionTime: '10:00' });
  const [learner, setLearner] = useState({ courseId: '', learnerName: '', learnerEmail: '' });
  const courseWrite = useWrite();
  const sessionWrite = useWrite();
  const learnerWrite = useWrite();
  const today = indiaToday();

  const courses = data.state.status === 'success' ? data.state.data.courses : [];
  const sessions = data.state.status === 'success' ? data.state.data.sessions : [];
  const enrollments = data.state.status === 'success' ? data.state.data.enrollments : [];
  const courseTitle = useMemo(() => new Map(courses.map((row) => [row.id, row.title])), [courses]);
  const learnersByCourse = useMemo(() => {
    const map = new Map<string, EnrollmentRow[]>();
    for (const row of enrollments) map.set(row.course_id, [...(map.get(row.course_id) ?? []), row]);
    return map;
  }, [enrollments]);
  const upcoming = sessions.filter((row) => row.session_date >= today);
  const past = sessions.filter((row) => row.session_date < today).reverse();

  const moduleCount = Number(course.moduleCount);
  const courseReady = course.title.trim().length >= 3 && course.category.trim().length >= 2 && Number.isInteger(moduleCount) && moduleCount >= 1 && moduleCount <= 100;
  const sessionReady = session.title.trim().length >= 3 && session.sessionDate >= today && /^\d{2}:\d{2}$/.test(session.sessionTime);
  const learnerReady = learner.courseId !== '' && learner.learnerName.trim().length >= 2;

  const addCourse = (event: React.FormEvent) => {
    event.preventDefault();
    setNotice(null);
    void courseWrite.run(async () => {
      const saved = await sendWorkspaceWrite<{ course: CourseRow }>('/api/center/training/courses', 'POST', { title: course.title.trim(), category: course.category.trim(), moduleCount });
      setNotice(`Course "${saved.course.title}" added.`);
      setCourse({ title: '', category: course.category, moduleCount: '1' });
      data.reload();
    });
  };
  const addSession = (event: React.FormEvent) => {
    event.preventDefault();
    setNotice(null);
    void sessionWrite.run(async () => {
      const saved = await sendWorkspaceWrite<{ session: SessionRow }>('/api/center/training/sessions', 'POST', {
        courseId: session.courseId || null, title: session.title.trim(), sessionDate: session.sessionDate, sessionTime: session.sessionTime,
      });
      setNotice(`Session "${saved.session.title}" scheduled on ${dateLabel(saved.session.session_date)} at ${saved.session.session_time} IST.`);
      setSession({ ...session, title: '' });
      data.reload();
    });
  };
  const addLearner = (event: React.FormEvent) => {
    event.preventDefault();
    setNotice(null);
    void learnerWrite.run(async () => {
      const saved = await sendWorkspaceWrite<{ enrollment: EnrollmentRow }>('/api/center/training/enrollments', 'POST', {
        courseId: learner.courseId, learnerName: learner.learnerName.trim(), learnerEmail: learner.learnerEmail.trim(),
      });
      setNotice(`${saved.enrollment.learner_name} enrolled in "${courseTitle.get(saved.enrollment.course_id) ?? 'the course'}".`);
      setLearner({ ...learner, learnerName: '', learnerEmail: '' });
      data.reload();
    });
  };

  const courseOptions = (placeholder: string) => (
    <>
      <option value="">{data.state.status === 'loading' ? 'Loading courses…' : placeholder}</option>
      {courses.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}
    </>
  );
  const sessionList = (rows: SessionRow[]) => (
    <ul className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200">
      {rows.map((row) => (
        <li key={row.id} className="p-3 text-sm">
          <p className="font-semibold text-slate-900">{row.title}</p>
          <p className="text-xs text-slate-600">{dateLabel(row.session_date)} · {row.session_time} IST{row.course_id ? ` · ${courseTitle.get(row.course_id) ?? 'Course'}` : ''}</p>
        </li>
      ))}
    </ul>
  );

  return (
    <section className="space-y-5" aria-labelledby="workspace-training-heading">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h2 id="workspace-training-heading" className="text-lg font-extrabold text-[#0B2E59]">Training</h2>
        <p className="mt-1 text-sm text-slate-600">Keep records of your training courses, the sessions you schedule and the learners you enrol.</p>
        <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">ELTNOY does not host live sessions; run them yourself. Learner progress and training certificates are not available yet.</p>
        {notice && <p role="status" className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}
        {data.state.status === 'loading' && <p role="status" className="mt-4 rounded-xl bg-slate-50 p-5 text-sm text-slate-600">Loading training records…</p>}
        {data.state.status === 'error' && <div role="alert" className="mt-4 rounded-xl bg-rose-50 p-5 text-sm text-rose-800">Training records could not be loaded: {data.state.message}<button type="button" onClick={data.reload} className="ml-3 font-bold underline">Try again</button></div>}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h3 className="text-base font-extrabold text-[#0B2E59]">Courses and learners</h3>
        <form onSubmit={addCourse} className="mt-4 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-4" aria-label="Add a course">
          <label className="text-xs font-semibold text-slate-700 sm:col-span-2">Course title<input className={inputClass} value={course.title} onChange={(e) => setCourse({ ...course, title: e.target.value })} required minLength={3} maxLength={160} /></label>
          <label className="text-xs font-semibold text-slate-700">Category<input className={inputClass} value={course.category} onChange={(e) => setCourse({ ...course, category: e.target.value })} required minLength={2} maxLength={80} /></label>
          <label className="text-xs font-semibold text-slate-700">Modules<input type="number" min={1} max={100} step={1} className={inputClass} value={course.moduleCount} onChange={(e) => setCourse({ ...course, moduleCount: e.target.value })} required /></label>
          <div className="sm:col-span-4"><button type="submit" disabled={courseWrite.saving || !courseReady} className="rounded-lg bg-[#0B2E59] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{courseWrite.saving ? 'Saving…' : 'Add course'}</button></div>
          <FormError error={courseWrite.error} />
        </form>

        <form onSubmit={addLearner} className="mt-4 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-4" aria-label="Enrol a learner">
          <label className="text-xs font-semibold text-slate-700 sm:col-span-4">Course
            <select className={inputClass} value={learner.courseId} onChange={(e) => setLearner({ ...learner, courseId: e.target.value })} disabled={courses.length === 0} required>{courseOptions(courses.length === 0 ? 'Add a course first' : 'Choose a course')}</select>
          </label>
          <label className="text-xs font-semibold text-slate-700 sm:col-span-2">Learner name<input className={inputClass} value={learner.learnerName} onChange={(e) => setLearner({ ...learner, learnerName: e.target.value })} required minLength={2} maxLength={120} /></label>
          <label className="text-xs font-semibold text-slate-700 sm:col-span-2">Email (optional)<input type="email" className={inputClass} value={learner.learnerEmail} onChange={(e) => setLearner({ ...learner, learnerEmail: e.target.value })} maxLength={254} /></label>
          <div className="sm:col-span-4"><button type="submit" disabled={learnerWrite.saving || !learnerReady} className="rounded-lg bg-[#0B2E59] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{learnerWrite.saving ? 'Saving…' : 'Enrol learner'}</button></div>
          <FormError error={learnerWrite.error} />
        </form>

        {data.state.status === 'success' && (courses.length === 0 ? <p className="mt-4 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">No courses yet.</p> : (
          <ul className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-200">
            {courses.map((row) => {
              const learners = learnersByCourse.get(row.id) ?? [];
              return (
                <li key={row.id} className="p-4">
                  <p className="font-semibold text-slate-900">{row.title}</p>
                  <p className="text-xs text-slate-600">{row.category} · {row.module_count} {row.module_count === 1 ? 'module' : 'modules'} · {learners.length} {learners.length === 1 ? 'learner' : 'learners'}</p>
                  {learners.length > 0 && <ul className="mt-2 space-y-1 text-sm text-slate-700">{learners.map((item) => <li key={item.id}>{item.learner_name}{item.learner_email ? <span className="ml-2 text-xs text-slate-500">{item.learner_email}</span> : null}</li>)}</ul>}
                </li>
              );
            })}
          </ul>
        ))}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h3 className="text-base font-extrabold text-[#0B2E59]">Sessions</h3>
        <form onSubmit={addSession} className="mt-4 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-4" aria-label="Schedule a session">
          <label className="text-xs font-semibold text-slate-700 sm:col-span-2">Session title<input className={inputClass} value={session.title} onChange={(e) => setSession({ ...session, title: e.target.value })} required minLength={3} maxLength={160} /></label>
          <label className="text-xs font-semibold text-slate-700 sm:col-span-2">Course (optional)<select className={inputClass} value={session.courseId} onChange={(e) => setSession({ ...session, courseId: e.target.value })}>{courseOptions('No course')}</select></label>
          <label className="text-xs font-semibold text-slate-700">Date<input type="date" min={today} className={inputClass} value={session.sessionDate} onChange={(e) => setSession({ ...session, sessionDate: e.target.value })} required /></label>
          <label className="text-xs font-semibold text-slate-700">Time (IST)<input type="time" className={inputClass} value={session.sessionTime} onChange={(e) => setSession({ ...session, sessionTime: e.target.value })} required /></label>
          <div className="flex items-end sm:col-span-2"><button type="submit" disabled={sessionWrite.saving || !sessionReady} className="rounded-lg bg-[#0B2E59] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{sessionWrite.saving ? 'Saving…' : 'Schedule session'}</button></div>
          <FormError error={sessionWrite.error} />
        </form>
        {data.state.status === 'success' && (sessions.length === 0 ? <p className="mt-4 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">No sessions scheduled yet.</p> : (
          <div className="mt-4 space-y-4">
            <div><h4 className="text-sm font-extrabold text-slate-900">Today and upcoming ({upcoming.length})</h4>{upcoming.length === 0 ? <p className="mt-2 text-sm text-slate-600">None.</p> : sessionList(upcoming)}</div>
            <div><h4 className="text-sm font-extrabold text-slate-900">Past ({past.length})</h4>{past.length === 0 ? <p className="mt-2 text-sm text-slate-600">None.</p> : sessionList(past)}</div>
          </div>
        ))}
      </div>
    </section>
  );
};
