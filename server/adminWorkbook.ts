import ExcelJS from 'exceljs';

export const WORKBOOK_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_COMPRESSED_WORKBOOK_BYTES = 5 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2_000;
const MAX_ZIP_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_EXPANDED_BYTES = 50 * 1024 * 1024;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;

export interface WorkbookRow {
  [key: string]: string;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') return value.text.trim();
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue);
    return JSON.stringify(value);
  }
  return String(value).trim();
}

function validateXlsxContainer(buffer: Uint8Array): void {
  if (buffer.byteLength > MAX_COMPRESSED_WORKBOOK_BYTES) {
    throw new Error('The XLSX workbook exceeds the 5 MB upload limit.');
  }
  const zip = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const minimumEndRecordSize = 22;
  const maxCommentLength = 0xffff;
  const searchStart = Math.max(0, zip.length - minimumEndRecordSize - maxCommentLength);
  let endRecordOffset = -1;

  for (let offset = zip.length - minimumEndRecordSize; offset >= searchStart; offset -= 1) {
    if (
      zip.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY
      && offset + minimumEndRecordSize + zip.readUInt16LE(offset + 20) === zip.length
    ) {
      endRecordOffset = offset;
      break;
    }
  }
  if (endRecordOffset < 0) throw new Error('The uploaded file is not a valid XLSX archive.');

  const diskNumber = zip.readUInt16LE(endRecordOffset + 4);
  const centralDirectoryDisk = zip.readUInt16LE(endRecordOffset + 6);
  const entriesOnDisk = zip.readUInt16LE(endRecordOffset + 8);
  const entryCount = zip.readUInt16LE(endRecordOffset + 10);
  const centralDirectorySize = zip.readUInt32LE(endRecordOffset + 12);
  const centralDirectoryOffset = zip.readUInt32LE(endRecordOffset + 16);
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;

  if (
    diskNumber !== 0
    || centralDirectoryDisk !== 0
    || entriesOnDisk !== entryCount
    || entryCount === 0xffff
    || centralDirectorySize === 0xffffffff
    || centralDirectoryOffset === 0xffffffff
    || entryCount > MAX_ZIP_ENTRIES
    || centralDirectoryEnd > endRecordOffset
  ) {
    throw new Error('The XLSX archive structure is not supported.');
  }

  let offset = centralDirectoryOffset;
  let expandedBytes = 0;
  const entryNames = new Set<string>();
  const requiredEntries = new Set(['[Content_Types].xml', 'xl/workbook.xml']);

  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > centralDirectoryEnd
      || zip.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_HEADER
    ) {
      throw new Error('The XLSX archive contains an invalid directory entry.');
    }

    const flags = zip.readUInt16LE(offset + 8);
    const compressionMethod = zip.readUInt16LE(offset + 10);
    const compressedBytes = zip.readUInt32LE(offset + 20);
    const entryExpandedBytes = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const diskStart = zip.readUInt16LE(offset + 34);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > centralDirectoryEnd) {
      throw new Error('The XLSX archive contains a truncated directory entry.');
    }

    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    const invalidName = !name
      || name.includes('\0')
      || name.includes('\\')
      || name.startsWith('/')
      || name.split('/').includes('..');
    if (
      invalidName
      || entryNames.has(name)
      || diskStart !== 0
      || (flags & 0x41) !== 0
      || ![0, 8].includes(compressionMethod)
      || compressedBytes === 0xffffffff
      || entryExpandedBytes === 0xffffffff
      || localHeaderOffset === 0xffffffff
    ) {
      throw new Error('The XLSX archive contains an unsupported or unsafe entry.');
    }
    entryNames.add(name);

    if (entryExpandedBytes > MAX_ZIP_ENTRY_BYTES) {
      throw new Error('An XLSX archive entry exceeds the expanded size limit.');
    }
    expandedBytes += entryExpandedBytes;
    if (expandedBytes > MAX_ZIP_EXPANDED_BYTES) {
      throw new Error('The XLSX archive exceeds the expanded size limit.');
    }

    if (
      localHeaderOffset + 30 > centralDirectoryOffset
      || zip.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER
    ) {
      throw new Error('The XLSX archive contains an invalid file header.');
    }
    const localFlags = zip.readUInt16LE(localHeaderOffset + 6);
    const localMethod = zip.readUInt16LE(localHeaderOffset + 8);
    const localNameLength = zip.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = zip.readUInt16LE(localHeaderOffset + 28);
    const localDataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const localName = zip.toString('utf8', localHeaderOffset + 30, localDataOffset - localExtraLength);
    if (
      localFlags !== flags
      || localMethod !== compressionMethod
      || localName !== name
      || localDataOffset + compressedBytes > centralDirectoryOffset
    ) {
      throw new Error('The XLSX archive contains mismatched file headers.');
    }

    if (name === '[Content_Types].xml' || name === 'xl/workbook.xml') {
      requiredEntries.delete(name);
    }
    offset = entryEnd;
  }

  if (
    offset !== centralDirectoryEnd
    || requiredEntries.size > 0
  ) {
    throw new Error('The file is not a valid XLSX workbook.');
  }
}

export async function readWorkbookSheet(buffer: Uint8Array, sheetName: string): Promise<WorkbookRow[]> {
  validateXlsxContainer(buffer);
  const workbook = new ExcelJS.Workbook();
  const excelBuffer = Buffer.from(buffer) as unknown as Parameters<typeof workbook.xlsx.load>[0];
  await workbook.xlsx.load(excelBuffer);
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) throw new Error(`Workbook must contain a "${sheetName}" worksheet.`);
  if (sheet.rowCount > 5001) throw new Error('A worksheet can contain at most 5,000 data rows.');

  const headerRow = sheet.getRow(1);
  const headers = Array.from({ length: headerRow.cellCount }, (_, index) =>
    cellText(headerRow.getCell(index + 1).value));
  if (!headers.length || headers.some((header) => !header)) {
    throw new Error(`The "${sheetName}" worksheet must have column names in its first row.`);
  }

  const rows: WorkbookRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const record: WorkbookRow = {};
    headers.forEach((header, index) => {
      record[header] = cellText(row.getCell(index + 1).value);
    });
    if (Object.values(record).some(Boolean)) rows.push(record);
  });
  return rows;
}

export function addWorkbookSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  headers: string[],
  rows: Array<Record<string, unknown>> = [],
): void {
  const sheet = workbook.addWorksheet(name);
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2E59' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + headers.length)}1` };
  for (const row of rows) {
    sheet.addRow(headers.map((header) => {
      const value = row[header];
      return value && typeof value === 'object' ? JSON.stringify(value) : value ?? '';
    }));
  }
  headers.forEach((_, index) => {
    const column = sheet.getColumn(index + 1);
    column.width = Math.min(42, Math.max(14, ...column.values.map((value) => String(value ?? '').length + 2)));
  });
}
