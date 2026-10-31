import ExcelJS from 'exceljs';

export const WORKBOOK_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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

export async function readWorkbookSheet(buffer: Uint8Array, sheetName: string): Promise<WorkbookRow[]> {
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
