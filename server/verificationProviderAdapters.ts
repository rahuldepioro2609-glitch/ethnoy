/** Approved external delivery adapters for Student and Institute verification. */
import {
  ProviderDeliveryError,
  registerEmailProviderAdapter,
  registerSmsProviderAdapter,
  type EmailDeliveryRequest,
  type ProviderAdapterConfig,
  type ProviderAdapterRegistration,
  type SmsDeliveryRequest,
} from './verificationProviders.js';

function requiredSetting(config: ProviderAdapterConfig, name: string): string {
  const value = config.settings[name]?.trim();
  if (!value) throw new Error('invalid provider configuration');
  return value;
}

function requiredSecret(config: ProviderAdapterConfig, name: string): string {
  const value = config.secrets[name]?.toString('utf8').trim();
  if (!value) throw new Error('invalid provider configuration');
  return value;
}

function classifyHttpFailure(status: number): ProviderDeliveryError {
  if (status === 401 || status === 403) return new ProviderDeliveryError('authentication');
  if (status === 429) return new ProviderDeliveryError('throttled');
  if (status >= 500) return new ProviderDeliveryError('provider_unavailable');
  if (status === 400 || status === 404 || status === 422) return new ProviderDeliveryError('rejected_destination');
  return new ProviderDeliveryError('unknown');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

const resendRegistration: ProviderAdapterRegistration<import('./verificationProviders.js').EmailVerificationProvider> = {
  settings: ['RESEND_FROM_EMAIL'],
  secretFiles: { apiKey: { env: 'RESEND_API_KEY_FILE', minBytes: 16 } },
  create(config) {
    const from = requiredSetting(config, 'RESEND_FROM_EMAIL');
    if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from)) throw new Error('invalid provider configuration');
    const apiKey = requiredSecret(config, 'apiKey');
    return {
      name: 'resend',
      async sendVerificationCode(request: EmailDeliveryRequest): Promise<void> {
        if (request.signal.aborted) throw new ProviderDeliveryError('provider_unavailable');
        const purpose = request.purpose === 'institute_email' ? 'Institute email verification' : 'Email verification';
        const code = escapeHtml(request.code);
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': request.correlationId,
          },
          body: JSON.stringify({
            from,
            to: [request.destination],
            subject: `ELTNOY ${purpose}`,
            text: `Your ELTNOY verification code is ${request.code}. Do not share this code. If you did not request it, ignore this email.`,
            html: `<p>Your ELTNOY verification code is <strong>${code}</strong>.</p><p>Do not share this code. If you did not request it, ignore this email.</p>`,
          }),
          signal: request.signal,
        });
        if (!response.ok) throw classifyHttpFailure(response.status);
      },
    };
  },
};

const twilioRegistration: ProviderAdapterRegistration<import('./verificationProviders.js').SmsOtpProvider> = {
  settings: ['TWILIO_ACCOUNT_SID', 'TWILIO_MESSAGING_SERVICE_SID'],
  secretFiles: { authToken: { env: 'TWILIO_AUTH_TOKEN_FILE', minBytes: 16 } },
  create(config) {
    const accountSid = requiredSetting(config, 'TWILIO_ACCOUNT_SID');
    const messagingServiceSid = requiredSetting(config, 'TWILIO_MESSAGING_SERVICE_SID');
    const authToken = requiredSecret(config, 'authToken');
    if (!/^AC[a-f0-9]{32}$/i.test(accountSid) || !/^MG[a-f0-9]{32}$/i.test(messagingServiceSid)) throw new Error('invalid provider configuration');
    const authorization = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    return {
      name: 'twilio',
      async sendOtp(request: SmsDeliveryRequest): Promise<void> {
        if (request.signal.aborted) throw new ProviderDeliveryError('provider_unavailable');
        const body = new URLSearchParams({
          To: request.destination,
          MessagingServiceSid: messagingServiceSid,
          Body: `Your ELTNOY verification code is ${request.code}. Do not share this code. If you did not request it, ignore this SMS.`,
        });
        const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
          method: 'POST',
          headers: { Authorization: `Basic ${authorization}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal: request.signal,
        });
        if (!response.ok) throw classifyHttpFailure(response.status);
      },
    };
  },
};

registerEmailProviderAdapter('resend', resendRegistration);
registerSmsProviderAdapter('twilio', twilioRegistration);

