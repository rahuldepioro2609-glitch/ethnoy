export interface EmailMessage {
  subject: string;
  text: string;
  html: string;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Builds an absolute link on the portal's public origin. */
export function portalLink(origin: string, path: string, params: Record<string, string> = {}): string {
  const url = new URL(path, origin.endsWith('/') ? origin : `${origin}/`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function layout(heading: string, paragraphs: string[], action?: { label: string; url: string }): string {
  const body = paragraphs.map((paragraph) => `<p style="margin:0 0 14px;line-height:1.5">${escapeHtml(paragraph)}</p>`).join('');
  const button = action
    ? `<p style="margin:22px 0"><a href="${escapeHtml(action.url)}" style="background:#047857;color:#ffffff;padding:11px 18px;border-radius:8px;text-decoration:none;font-weight:bold">${escapeHtml(action.label)}</a></p>
       <p style="margin:0 0 14px;font-size:12px;color:#64748b">If the button does not work, copy this link into your browser:<br>${escapeHtml(action.url)}</p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Arial,sans-serif;color:#0f172a">
<div style="max-width:560px;margin:0 auto;padding:24px">
<div style="background:#0B2E59;color:#ffffff;padding:16px 20px;border-radius:12px 12px 0 0;font-weight:bold;font-size:18px">ELTNOY Examination Portal</div>
<div style="background:#ffffff;padding:22px 20px;border-radius:0 0 12px 12px">
<h1 style="font-size:18px;margin:0 0 16px">${escapeHtml(heading)}</h1>${body}${button}
<p style="margin:18px 0 0;font-size:12px;color:#64748b">This is an automated message. Do not reply to this email.</p>
</div></div></body></html>`;
}

export function passwordResetEmail(name: string, loginId: string, url: string, minutes: number): EmailMessage {
  const paragraphs = [
    `Hello ${name},`,
    `We received a request to reset the password for ELTNOY account ${loginId}.`,
    `This link works once and expires in ${minutes} minutes. Resetting your password signs you out on every device.`,
    'If you did not ask for this, ignore this email. Your password will not change.',
  ];
  return {
    subject: 'Reset your ELTNOY password',
    text: `${paragraphs.join('\n\n')}\n\nReset your password: ${url}\n`,
    html: layout('Reset your password', paragraphs, { label: 'Choose a new password', url }),
  };
}

export function passwordChangedEmail(name: string, loginId: string): EmailMessage {
  const paragraphs = [
    `Hello ${name},`,
    `The password for ELTNOY account ${loginId} was just changed, and all previous sign-ins were ended.`,
    'If you did not do this, contact the ELTNOY helpdesk immediately.',
  ];
  return {
    subject: 'Your ELTNOY password was changed',
    text: paragraphs.join('\n\n'),
    html: layout('Password changed', paragraphs),
  };
}

export function verificationEmail(name: string, url: string, hours: number): EmailMessage {
  const paragraphs = [
    `Hello ${name},`,
    'Confirm this email address for your ELTNOY account. A verified email lets you reset your password and receive exam updates.',
    `This link expires in ${hours} hours.`,
  ];
  return {
    subject: 'Confirm your email for ELTNOY',
    text: `${paragraphs.join('\n\n')}\n\nConfirm your email: ${url}\n`,
    html: layout('Confirm your email address', paragraphs, { label: 'Confirm email', url }),
  };
}

export function applicationConfirmationEmail(details: {
  candidateName: string;
  applicationNumber: string;
  examCode: string;
  examName: string;
  dashboardUrl: string;
}): EmailMessage {
  const paragraphs = [
    `Hello ${details.candidateName},`,
    `Your application for ${details.examName} (${details.examCode}) has been received.`,
    `Application number: ${details.applicationNumber}`,
    'Keep this number safe. You need it with your date of birth to download your admit card and view results. You will be able to track your application status in your dashboard.',
  ];
  return {
    subject: `Application received: ${details.applicationNumber}`,
    text: `${paragraphs.join('\n\n')}\n\nOpen your dashboard: ${details.dashboardUrl}\n`,
    html: layout('Application received', paragraphs, { label: 'Open my dashboard', url: details.dashboardUrl }),
  };
}
