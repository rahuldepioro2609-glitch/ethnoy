import React, { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../api';
import { useTranslation } from '../i18n';

/**
 * "Continue with Google" using Google Identity Services. It shows nothing until the portal
 * has a GOOGLE_CLIENT_ID, so the login page works the same without it.
 */

interface GoogleIdApi {
  initialize: (options: {
    client_id: string;
    callback: (response: { credential?: string }) => void;
    ux_mode?: 'popup';
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
    context?: 'signin' | 'signup' | 'use';
  }) => void;
  renderButton: (element: HTMLElement, options: Record<string, unknown>) => void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdApi } };
  }
}

const SCRIPT_URL = 'https://accounts.google.com/gsi/client';
let scriptPromise: Promise<GoogleIdApi> | null = null;
let clientIdPromise: Promise<string | null> | null = null;

function loadGoogleScript(): Promise<GoogleIdApi> {
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id);
  scriptPromise ??= new Promise<GoogleIdApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => (window.google?.accounts?.id ? resolve(window.google.accounts.id) : reject(new Error('Google sign-in did not load.')));
    script.onerror = () => {
      scriptPromise = null;
      script.remove();
      reject(new Error('Google sign-in did not load.'));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/** The portal's public Google OAuth client ID, or null when Google sign-in is off. */
export function useGoogleClientId(): string | null {
  const [clientId, setClientId] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    clientIdPromise ??= apiRequest<{ googleClientId?: string | null }>('/api/auth/options')
      .then((options) => options.googleClientId ?? null)
      .catch(() => {
        clientIdPromise = null;
        return null;
      });
    void clientIdPromise.then((id) => {
      if (active) setClientId(id);
    });
    return () => {
      active = false;
    };
  }, []);
  return clientId;
}

const GOOGLE_LOCALES: Record<string, string> = { English: 'en', Hindi: 'hi', Kannada: 'kn', Bengali: 'bn', Marathi: 'mr' };

interface GoogleSignInButtonProps {
  clientId: string;
  /** Button wording: "Continue with Google" or "Sign up with Google". */
  text?: 'continue_with' | 'signup_with' | 'signin_with';
  onCredential: (credential: string) => void;
  onError?: (message: string) => void;
}

export const GoogleSignInButton: React.FC<GoogleSignInButtonProps> = ({ clientId, text = 'continue_with', onCredential, onError }) => {
  const { t, language } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const callback = useRef(onCredential);
  callback.current = onCredential;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    loadGoogleScript()
      .then((google) => {
        if (!active || !container.current) return;
        google.initialize({
          client_id: clientId,
          ux_mode: 'popup',
          auto_select: false,
          cancel_on_tap_outside: true,
          context: text === 'signup_with' ? 'signup' : 'signin',
          callback: (response) => {
            if (response.credential) callback.current(response.credential);
          },
        });
        container.current.replaceChildren();
        google.renderButton(container.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          shape: 'rectangular',
          text,
          logo_alignment: 'center',
          width: Math.min(400, Math.max(200, Math.floor(container.current.clientWidth || 320))),
          locale: GOOGLE_LOCALES[language] ?? 'en',
        });
      })
      .catch(() => {
        if (!active) return;
        setFailed(true);
        onError?.(t('login.googleError'));
      });
    return () => {
      active = false;
    };
    // onError is only used for the one-time load failure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, text, language]);

  if (failed) return null;
  return <div ref={container} className="flex min-h-11 w-full justify-center" />;
};
