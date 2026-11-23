import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { addWorkbookSheet, readWorkbookSheet } from './adminWorkbook.js';

function workbookArchiveWithExpandedEntry(size: number): Buffer {
  const entryName = Buffer.from('large.xml');
  const localHeader = Buffer.alloc(30 + entryName.length + 1);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt32LE(1, 18);
  localHeader.writeUInt32LE(size, 22);
  localHeader.writeUInt16LE(entryName.length, 26);
  entryName.copy(localHeader, 30);

  const centralDirectory = Buffer.alloc(46 + entryName.length);
  centralDirectory.writeUInt32LE(0x02014b50, 0);
  centralDirectory.writeUInt16LE(20, 4);
  centralDirectory.writeUInt16LE(20, 6);
  centralDirectory.writeUInt32LE(1, 20);
  centralDirectory.writeUInt32LE(size, 24);
  centralDirectory.writeUInt16LE(entryName.length, 28);
  entryName.copy(centralDirectory, 46);

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(1, 8);
  endRecord.writeUInt16LE(1, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(localHeader.length, 16);

  return Buffer.concat([localHeader, centralDirectory, endRecord]);
}

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

test('rejects uploads that are not valid XLSX archives', async () => {
  await assert.rejects(
    readWorkbookSheet(Buffer.from('not a workbook'), 'Results'),
    /not a valid XLSX archive/,
  );
});

test('enforces the 5 MB compressed workbook limit in the parser', async () => {
  await assert.rejects(
    readWorkbookSheet(Buffer.alloc(5 * 1024 * 1024 + 1), 'Results'),
    /exceeds the 5 MB upload limit/,
  );
});

test('rejects archives with entries that exceed the expanded size limit before parsing', async () => {
  const archive = workbookArchiveWithExpandedEntry(20 * 1024 * 1024 + 1);

  await assert.rejects(
    readWorkbookSheet(archive, 'Results'),
    /expanded size limit/,
  );
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
