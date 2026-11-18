import React from 'react';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from '../i18n';
import { BrandLogo } from './BrandLogo';

/**
 * Privacy notice and terms of use. They describe how this codebase actually handles data.
 * The operator must review them (ideally with legal advice) and keep them in step with any change.
 */
const LAST_UPDATED = '18 November 2026';

type Section = { heading: string; paragraphs?: string[]; items?: string[] };

const PRIVACY: Section[] = [
  {
    heading: 'Who we are',
    paragraphs: [
      'This notice explains how the ELTNOY Examination Portal ("ELTNOY", "we") handles personal information when you use this website. ELTNOY is an independent examination portal and is not affiliated with the National Testing Agency or any government body.',
      'For any privacy question or request, contact us through the candidate helpdesk on this website.',
    ],
  },
  {
    heading: 'What we collect',
    items: [
      'Account details: your login ID, name, email address and password. Passwords are stored only as a one-way hash; we cannot read them.',
      'If you choose to sign in with Google: your Google account ID, name and email address, which Google shares with us at your request. We never receive your Google password.',
      'Application details: name, father\'s or guardian\'s name, date of birth, gender, category, email address, mobile number, exam city preferences, question-paper language, photograph and signature.',
      'Examination records: your admit card details (roll number, centre, timings), check-in status recorded by your exam centre, online exam answers and scores, practice test attempts and published results.',
      'Answer-key objections: your reasons, cited references and any supporting document you upload.',
      'Helpdesk messages, including any name, email or application number you add.',
      'For institutes: institute name, contact email, registration number, address, website, form listings, wallet entries and withdrawal requests.',
      'Technical data: a sign-in cookie, and your network address, which is used briefly to limit repeated sign-in attempts.',
    ],
  },
  {
    heading: 'Why we use it',
    items: [
      'To create and secure your account and let you sign in (including with Google, if you choose), verify your email and reset your password.',
      'To process exam applications, issue admit cards, run online exams and publish results.',
      'To let your exam centre confirm your identity on exam day.',
      'To review answer-key objections and helpdesk requests.',
      'To send you account and application emails, such as verification links and application confirmations.',
    ],
  },
  {
    heading: 'Who can see your information',
    items: [
      'You, through your dashboard.',
      'ELTNOY officials who administer examinations, for the purposes above.',
      'Your allotted exam centre, which sees your name, father\'s or guardian\'s name, photograph, signature, roll number and exam timing when it checks you in.',
      'Anyone who has your application number, date of birth and exam code can open your admit card and published result, so keep these details private.',
      'Service providers that host the website and database, and send email on our behalf, only as needed to provide those services. If you use "Continue with Google", Google handles that sign-in under its own privacy policy.',
    ],
    paragraphs: ['We do not sell your information, show advertising, or use third-party analytics or tracking on this website.'],
  },
  {
    heading: 'Cookies and browser storage',
    paragraphs: [
      'We use one essential cookie, which keeps you signed in for up to 12 hours. It cannot be read by scripts on the page and is only sent to this website. Your language choice is saved in your browser so the site remembers it. We do not use advertising or analytics cookies.',
    ],
  },
  {
    heading: 'How long we keep it',
    paragraphs: [
      'We keep examination records for as long as needed to conduct the examination, publish and verify results, handle objections and disputes, and meet legal obligations. Signed-out and expired sessions stop working immediately.',
    ],
  },
  {
    heading: 'Your choices and rights',
    items: [
      'You can see your applications, results and account email in your dashboard, and change your email there.',
      'To correct an application, or to ask for a copy or deletion of your information, contact the candidate helpdesk. Some records may need to be kept where the law or the integrity of an examination requires it.',
    ],
  },
  {
    heading: 'Security',
    paragraphs: [
      'The website is served over HTTPS, passwords are hashed, access is limited by account role, and repeated sign-in attempts are rate-limited. No system is perfectly secure: use a unique password and do not share your login details.',
    ],
  },
  {
    heading: 'Changes to this notice',
    paragraphs: ['If we change this notice, we will update it on this page and change the date at the top.'],
  },
];

const TERMS: Section[] = [
  {
    heading: 'About these terms',
    paragraphs: [
      'These terms apply to your use of the ELTNOY Examination Portal. By creating an account or using the portal, you agree to them. ELTNOY is an independent examination portal and is not affiliated with the National Testing Agency or any government body.',
    ],
  },
  {
    heading: 'Your account',
    items: [
      'Create only one student account, in your own name.',
      'Keep your login ID and password private. You are responsible for activity on your account.',
      'Institute accounts may be used only by authorised staff of an approved institute.',
    ],
  },
  {
    heading: 'Applications and information you provide',
    items: [
      'Information in your application must be true and complete. Your photograph must be a recent, clear photo of you, and your signature must be your own.',
      'Applications with false or misleading information may be rejected, and results may be withheld or cancelled.',
      'Submitting an application does not guarantee approval, an exam seat or a particular centre.',
    ],
  },
  {
    heading: 'Exams, admit cards and results',
    items: [
      'Follow the instructions on your admit card and from exam centre staff.',
      'Online exams have a fixed time limit that keeps running if you disconnect, and each exam can be attempted once.',
      'Practice tests are for practice only and do not affect any result.',
      'Answer keys and results are published by the exam authority. Objections are reviewed by subject experts, and their decision on each question is final.',
    ],
  },
  {
    heading: 'Acceptable use',
    items: [
      'Do not try to access other people\'s accounts or information, or parts of the portal you are not authorised to use.',
      'Do not interfere with the portal, overload it, or try to bypass its security.',
      'Do not upload content that is unlawful, offensive or not your own to share.',
    ],
  },
  {
    heading: 'Institute listings and payments',
    paragraphs: [
      'Institute exam and recruitment listings are published by the institutes after review; applications for them are handled by the institute, not ELTNOY. Institute wallet withdrawals are processed manually after review.',
    ],
  },
  {
    heading: 'Availability and liability',
    paragraphs: [
      'We work to keep the portal available and accurate, but it may sometimes be unavailable or contain errors. Always confirm important details, such as exam dates and centres, from your admit card and official notices. To the extent the law allows, ELTNOY is not liable for losses caused by interruptions or errors outside our reasonable control.',
    ],
  },
  {
    heading: 'Suspension',
    paragraphs: ['We may suspend or close accounts that break these terms or put the integrity of an examination at risk.'],
  },
  {
    heading: 'Changes and contact',
    paragraphs: [
      'We may update these terms; the date at the top shows the latest version. For questions, contact the candidate helpdesk on this website. Personal information is handled as described in our privacy notice.',
    ],
  },
];

const LegalLayout: React.FC<{ title: string; sections: Section[]; onHome: () => void }> = ({ title, sections, onHome }) => {
  const { t, language } = useTranslation();
  return (
    <main className="min-h-screen bg-[#eef5fa] text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-2 sm:px-6">
          <BrandLogo />
          <button onClick={onHome} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-[#0B2E59] hover:bg-emerald-50">
            <ArrowLeft className="h-4 w-4" /> {t('account.home')}
          </button>
        </div>
      </header>
      <article lang="en" className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
        <div className="rounded-2xl bg-white p-6 shadow-sm sm:p-10">
          <h1 className="text-3xl font-black text-[#0B2E59]">{title}</h1>
          <p className="mt-2 text-sm text-slate-500">{t('legal.lastUpdated', { date: LAST_UPDATED })}</p>
          {language !== 'English' && (
            <p lang={document.documentElement.lang} className="mt-4 rounded-lg bg-sky-50 p-3 text-sm text-sky-900">{t('legal.englishOnly')}</p>
          )}
          {sections.map((section) => (
            <section key={section.heading} className="mt-8">
              <h2 className="text-lg font-extrabold text-[#0B2E59]">{section.heading}</h2>
              {section.items && (
                <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-slate-700">
                  {section.items.map((item) => <li key={item}>{item}</li>)}
                </ul>
              )}
              {section.paragraphs?.map((paragraph) => <p key={paragraph} className="mt-3 text-sm leading-6 text-slate-700">{paragraph}</p>)}
            </section>
          ))}
        </div>
      </article>
    </main>
  );
};

export const PrivacyPage: React.FC<{ onHome: () => void }> = ({ onHome }) => (
  <LegalLayout title="Privacy notice" sections={PRIVACY} onHome={onHome} />
);

export const TermsPage: React.FC<{ onHome: () => void }> = ({ onHome }) => (
  <LegalLayout title="Terms of use" sections={TERMS} onHome={onHome} />
);
