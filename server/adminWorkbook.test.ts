import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { addWorkbookSheet, readWorkbookSheet } from './adminWorkbook.js';

test('reads trimmed headers, strings, dates, and skips blank rows', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('AdmitCards');
  sheet.addRow([' applicationNumber ', 'examDate', 'rollNumber']);
  sheet.addRow([' APP-1001 ', new Date('2026-10-31T00:00:00.000Z'), ' R-1001 ']);
  sheet.addRow(['', '', '']);

  const bytes = await workbook.xlsx.writeBuffer();
  const rows = await readWorkbookSheet(new Uint8Array(bytes), 'AdmitCards');

  assert.deepEqual(rows, [{
    applicationNumber: 'APP-1001',
    examDate: '2026-10-31',
    rollNumber: 'R-1001',
  }]);
});

test('requires the requested worksheet and header columns', async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('WrongSheet').addRow(['value']);
  const bytes = await workbook.xlsx.writeBuffer();

  await assert.rejects(
    readWorkbookSheet(new Uint8Array(bytes), 'Results'),
    /must contain a "Results" worksheet/,
  );
});

test('builds a formatted Excel worksheet with its column headers', async () => {
  const workbook = new ExcelJS.Workbook();
  addWorkbookSheet(workbook, 'Accounts', ['login_id', 'role'], [{ login_id: 'STUDENT-1', role: 'candidate' }]);
  const bytes = await workbook.xlsx.writeBuffer();
  assert.deepEqual(await readWorkbookSheet(new Uint8Array(bytes), 'Accounts'), [
    { login_id: 'STUDENT-1', role: 'candidate' },
  ]);
});
