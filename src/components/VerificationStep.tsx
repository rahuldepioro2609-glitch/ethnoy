// AUTH-1: mobile/email verification step for Student and Institute sign-in and registration.
// Shown ONLY when the server has started a verification (it has sent, or is ready to send, a code
// through a configured provider). It never decides success: only the server's answer does.
import React, { useEffect, useState } from 'react';
import { ApiError, apiRequestWithMeta } from '../api';
import { isChallenge, secondsUntil, verificationMessage, type VerificationChallengeView } from '../utils/authVerification';

interface VerificationStepProps {
  challenge: VerificationChallengeView;
  /** The server issued a verified portal session. */
  onSignedIn: () => void;
  /** Institute contacts verified (no session); show the server's message. */
  onContactsVerified: (message: string) => void;
  /** Verification ended (expired, locked or lost); return to the sign-in form. */
  onRestart: (message: string) => void;
}

const channelLabel = (challenge: VerificationChallengeView) => (challenge.channel === 'sms' ? 'mobile number' : 'email address');

export const VerificationStep: React.FC<VerificationStepProps> = ({ challenge: initial, onSignedIn, onContactsVerified, onRestart }) => {
  const [challenge, setChallenge] = useState(initial);
  const [code, setCode] = useState('');
  const [mobile, setMobile] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => { setChallenge(initial); }, [initial]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const handleError = (caught: unknown) => {
    if (caught instanceof ApiError) {
      const message = verificationMessage(caught.code, caught.message);
      if (['TOO_MANY_ATTEMPTS', 'VERIFICATION_EXPIRED', 'NO_VERIFICATION_IN_PROGRESS', 'PROVIDER_DELIVERY_FAILED', 'TOO_MANY_RESENDS'].includes(caught.code ?? '')) {
        onRestart(message);
        return;
      }
      setError(message);
      return;
    }
    setError('The request could not be completed. Please try again.');
  };

  const post = async (path: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      return (await apiRequestWithMeta<Record<string, unknown>>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })).data;
    } finally {
      setBusy(false);
    }
  };

  const submitDestination = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      // An email destination is asked only for Student sign-in while mobile verification is off.
      const data = await post('/api/auth/verification/destination', challenge.channel === 'email' ? { email } : { mobile });
      if (isChallenge(data)) setChallenge(data);
    } catch (caught) {
      handleError(caught);
    }
  };

  const submitCode = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const data = await post('/api/auth/verification/verify', { code });
      setCode('');
      if (data?.status === 'signed_in') onSignedIn();
      else if (isChallenge(data)) {
        setChallenge(data);
        setNotice(`Your ${data.channel === 'sms' ? 'mobile number' : 'email address'} is next.`);
      } else if (data?.status === 'contacts_verified') onContactsVerified(String(data.message ?? 'Verification complete.'));
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'INVALID_CODE') {
        // The server reports the remaining attempts in its error body; refresh the challenge view.
        try {
          const latest = await apiRequestWithMeta<VerificationChallengeView>('/api/auth/verification');
          setChallenge(latest.data);
          setError(verificationMessage('INVALID_CODE', caught.message, latest.data.attemptsRemaining));
        } catch (refreshError) {
          handleError(refreshError);
        }
        return;
      }
      handleError(caught);
    }
  };

  const resend = async () => {
    try {
      const data = await post('/api/auth/verification/resend');
      if (isChallenge(data)) {
        setChallenge(data);
        setNotice('A new code has been sent.');
      }
    } catch (caught) {
      handleError(caught);
    }
  };

  const wait = secondsUntil(challenge.resendAvailableAt, now);

  return (
    <div className="space-y-5" aria-live="polite">
      <div>
        <h2 className="text-xl font-extrabold text-[#0B2E59]">
          {challenge.channel === 'sms' ? 'Verify your mobile number' : 'Verify your email address'}
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          {challenge.step === 'destination'
            ? challenge.channel === 'email'
              ? 'Your account does not have a verified email address yet. Enter it to receive a one-time code; it is saved only after the code is confirmed.'
              : 'Your account does not have a verified mobile number yet. Enter it to receive a one-time code.'
            : `Enter the 6-digit code sent to your ${channelLabel(challenge)} ${challenge.destination ?? ''}. ${challenge.purpose === 'student_email_capture' ? 'This email is marked verified only after the code is confirmed.' : 'Your session starts only after the code is verified.'}`}
        </p>
      </div>
      {error && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}
      {notice && <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</div>}

      {challenge.step === 'destination' ? (
        <form className="space-y-4" onSubmit={(event) => void submitDestination(event)}>
          {challenge.channel === 'email' ? (
            <>
              <label htmlFor="verification-email" className="block text-sm font-semibold text-slate-700">Email address</label>
              <input id="verification-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} className="w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm outline-none focus:border-emerald-600 focus:bg-white focus:ring-2 focus:ring-emerald-600/15" />
            </>
          ) : (
            <>
              <label htmlFor="verification-mobile" className="block text-sm font-semibold text-slate-700">Mobile number</label>
              <input id="verification-mobile" type="tel" inputMode="numeric" autoComplete="tel-national" required maxLength={16} value={mobile} onChange={(event) => setMobile(event.target.value)} placeholder="10-digit mobile number" className="w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm outline-none focus:border-emerald-600 focus:bg-white focus:ring-2 focus:ring-emerald-600/15" />
            </>
          )}
          <button type="submit" disabled={busy} className="w-full rounded-lg bg-emerald-700 px-4 py-3 text-sm font-bold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60">{busy ? 'Please wait…' : 'Send code'}</button>
        </form>
      ) : (
        <form className="space-y-4" onSubmit={(event) => void submitCode(event)}>
          <label htmlFor="verification-code" className="block text-sm font-semibold text-slate-700">One-time code</label>
          <input id="verification-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} className="w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-center font-mono text-lg tracking-[0.4em] outline-none focus:border-emerald-600 focus:bg-white focus:ring-2 focus:ring-emerald-600/15" />
          <p className="text-xs text-slate-500">{challenge.attemptsRemaining} attempt{challenge.attemptsRemaining === 1 ? '' : 's'} left · Expires {new Date(challenge.expiresAt).toLocaleTimeString()}</p>
          <button type="submit" disabled={busy || code.length !== 6} className="w-full rounded-lg bg-emerald-700 px-4 py-3 text-sm font-bold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60">{busy ? 'Verifying…' : 'Verify code'}</button>
          <button type="button" disabled={busy || wait > 0} onClick={() => void resend()} className="w-full text-center text-sm font-bold text-emerald-800 hover:underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
            {wait > 0 ? `Resend code in ${wait}s` : 'Resend code'}
          </button>
        </form>
      )}
    </div>
  );
};
