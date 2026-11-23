import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ADMIN_HOME_PATH,
  instituteSignOutViewState,
  surfaceHostnamesForLocalInstitutePreview,
  planSurfaceNavigation,
  requiredSurfaceForPath,
  surfaceForRole,
  urlForSurface,
  type DisclosedSurfaceHostnames,
  type SurfaceHostnames,
} from './surfaceNavigation.js';
import { PLATFORM_STAFF_DASHBOARD_PATH, PLATFORM_STAFF_LOGIN_PATH } from './staffAccess.js';

const hostnames: SurfaceHostnames = {
  marketing: 'portal.example.test',
  exam: 'exam.example.test',
  institution: 'institute.example.test',
  admin: 'admin.private.example.test',
};
/** What a public surface answers: never the Admin hostname. */
const publicDisclosure: DisclosedSurfaceHostnames = { marketing: hostnames.marketing, exam: hostnames.exam, institution: hostnames.institution };

test('Institute sign-out requires the owning surface and a live Institute session', () => {
  assert.equal(instituteSignOutViewState({ authLoading: true, hostnames, currentHostname: hostnames.institution, accountRole: 'center' }), 'checking');
  assert.equal(instituteSignOutViewState({ authLoading: false, hostnames: null, currentHostname: hostnames.institution, accountRole: 'center' }), 'checking');
  assert.equal(instituteSignOutViewState({ authLoading: false, hostnames, currentHostname: hostnames.marketing, accountRole: 'center' }), 'wrong_surface');
  assert.equal(instituteSignOutViewState({ authLoading: false, hostnames, currentHostname: hostnames.institution, accountRole: null }), 'signed_out');
  assert.equal(instituteSignOutViewState({ authLoading: false, hostnames, currentHostname: hostnames.institution, accountRole: 'candidate' }), 'signed_out');
  assert.equal(instituteSignOutViewState({ authLoading: false, hostnames, currentHostname: 'INSTITUTE.EXAMPLE.TEST', accountRole: 'center' }), 'confirm');
});

test('local live Institute preview keeps the Institute portal on localhost and leaves Student on its own surface', () => {
  const preview = surfaceHostnamesForLocalInstitutePreview(publicDisclosure, 'localhost', true);
  assert.deepEqual(preview, { ...publicDisclosure, marketing: 'localhost', institution: 'localhost' });
  assert.deepEqual(planSurfaceNavigation('http://localhost:3000/login/center', 'institution', preview), { action: 'stay' });
  assert.deepEqual(planSurfaceNavigation('http://localhost:3000/dashboard/center', 'institution', preview), { action: 'stay' });
  assert.deepEqual(planSurfaceNavigation('http://localhost:3000/', 'marketing', preview), { action: 'stay' });
  assert.deepEqual(planSurfaceNavigation('http://localhost:3000/login/candidate', 'exam', preview), {
    action: 'redirect', url: `http://${hostnames.exam}:3000/login/candidate`,
  });
  assert.equal(surfaceHostnamesForLocalInstitutePreview(publicDisclosure, 'localhost', false), publicDisclosure, 'off unless enabled');
  assert.equal(surfaceHostnamesForLocalInstitutePreview(publicDisclosure, hostnames.marketing, true), publicDisclosure, 'never on a real host');
});

test('local live preview exposes only read-only surface metadata and defines its UI warning flag', () => {
  const vite = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');
  assert.match(vite, /pathname === '\/api\/surface-hostnames'/);
  assert.match(vite, /'import\.meta\.env\.VITE_ELTNOY_LIVE_PREVIEW': JSON\.stringify\(livePreviewEnabled \? 'true' : 'false'\)/);
  assert.match(vite, /Writes are disabled in this local live preview\./);
});

test('each portal role maps to its session-owning surface', () => {
  assert.equal(surfaceForRole('candidate'), 'exam');
  assert.equal(surfaceForRole('center'), 'institution');
  assert.equal(surfaceForRole('official'), 'admin');
});

test('role login, dashboard and Platform Staff paths identify their required surface', () => {
  assert.equal(requiredSurfaceForPath('/login/candidate'), 'exam');
  assert.equal(requiredSurfaceForPath('/dashboard/center'), 'institution');
  assert.equal(requiredSurfaceForPath('/login/official/'), 'admin');
  assert.equal(requiredSurfaceForPath(ADMIN_HOME_PATH), 'admin');
  assert.equal(requiredSurfaceForPath(PLATFORM_STAFF_LOGIN_PATH), 'admin');
  assert.equal(requiredSurfaceForPath(`${PLATFORM_STAFF_DASHBOARD_PATH}/`), 'admin');
  assert.equal(requiredSurfaceForPath('/'), 'marketing');
  assert.equal(requiredSurfaceForPath('/login'), null);
  assert.equal(requiredSurfaceForPath('/dashboard/unknown'), null);
  assert.equal(requiredSurfaceForPath('/login/platform-staff-extra'), null);
});

test('surface navigation preserves the URL and returns null when already on target or config is invalid', () => {
  assert.equal(
    urlForSurface('https://portal.example.test/login/candidate?next=%2Fdashboard#form', 'exam', hostnames),
    'https://exam.example.test/login/candidate?next=%2Fdashboard#form',
  );
  assert.equal(urlForSurface('https://exam.example.test/login/candidate', 'exam', hostnames), null);
  assert.equal(urlForSurface('https://portal.example.test/login/candidate', 'exam', { ...hostnames, exam: 'admin..example.test' }), null);
  assert.equal(urlForSurface('https://portal.example.test/login/official', 'admin', publicDisclosure), null);
});

test('public hosts never route to Admin: every Admin page is "not found" there, even if a hostname leaked', () => {
  for (const host of [hostnames.marketing, hostnames.exam, hostnames.institution, 'preview.netlify.example']) {
    for (const path of [ADMIN_HOME_PATH, '/dashboard/official', PLATFORM_STAFF_LOGIN_PATH, PLATFORM_STAFF_DASHBOARD_PATH]) {
      const href = `https://${host}${path}`;
      assert.deepEqual(planSurfaceNavigation(href, requiredSurfaceForPath(path), publicDisclosure), { action: 'not_found' }, href);
      // Defence in depth: an older server that still disclosed the Admin hostname gets no redirect either.
      assert.deepEqual(planSurfaceNavigation(href, requiredSurfaceForPath(path), hostnames), { action: 'not_found' }, href);
    }
  }
});

test('the Admin host serves Admin pages and replaces public pages with Admin sign-in', () => {
  const admin = (path: string) => `https://${hostnames.admin}${path}`;
  assert.deepEqual(planSurfaceNavigation(admin(ADMIN_HOME_PATH), 'admin', hostnames), { action: 'stay' });
  assert.deepEqual(planSurfaceNavigation(admin(PLATFORM_STAFF_LOGIN_PATH), 'admin', hostnames), { action: 'stay' });
  assert.deepEqual(planSurfaceNavigation(admin('/'), 'marketing', hostnames), { action: 'admin_home' });
  assert.deepEqual(planSurfaceNavigation(admin('/'), null, hostnames), { action: 'admin_home' });
  assert.deepEqual(planSurfaceNavigation(admin('/login'), null, hostnames), { action: 'admin_home' });
  // A Student or Institute flow opened on the Admin host moves to its own public host.
  assert.deepEqual(planSurfaceNavigation(admin('/login/candidate'), 'exam', hostnames),
    { action: 'redirect', url: `https://${hostnames.exam}/login/candidate` });
});

test('public role flows move to their own public host; unknown paths stay', () => {
  const portal = (path: string) => `https://${hostnames.marketing}${path}`;
  assert.deepEqual(planSurfaceNavigation(portal('/login/candidate'), 'exam', publicDisclosure),
    { action: 'redirect', url: `https://${hostnames.exam}/login/candidate` });
  assert.deepEqual(planSurfaceNavigation(portal('/login/center'), 'institution', publicDisclosure),
    { action: 'redirect', url: `https://${hostnames.institution}/login/center` });
  assert.deepEqual(planSurfaceNavigation(portal('/'), 'marketing', publicDisclosure), { action: 'stay' });
  assert.deepEqual(planSurfaceNavigation(portal('/login'), null, publicDisclosure), { action: 'stay' });
  assert.deepEqual(planSurfaceNavigation(`https://${hostnames.exam}/`, 'marketing', publicDisclosure),
    { action: 'redirect', url: `https://${hostnames.marketing}/` });
  assert.deepEqual(planSurfaceNavigation(portal('/login/candidate'), 'exam', { marketing: hostnames.marketing }), { action: 'invalid' });
});

test('static: App renders Admin and Platform Staff pages only after the plan confirms the Admin host', () => {
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  const gate = app.indexOf("if (requiredSurface === 'admin' && navigationPlan?.action !== 'stay')");
  assert.ok(gate > 0, 'the Admin gate exists');
  for (const render of ['<PlatformStaffPortal', '<RoleLoginPage', '<RoleDashboard']) {
    assert.ok(app.indexOf(render) > gate, `${render} is rendered only after the Admin gate`);
  }
  assert.doesNotMatch(app, /'ai-proctoring'/, 'no public quick action opens Admin sign-in');
  assert.doesNotMatch(app, /onOpenAiProctoring/);
});
