const DAILY_REPORT_TIMEZONE = process.env.DAILY_REPORT_TIMEZONE || 'Asia/Shanghai';

export function formatDailyReportDateLabel(date: Date, timeZone = DAILY_REPORT_TIMEZONE): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(date);
}

export function toDailyReportDate(date = new Date()): Date {
  const label = formatDailyReportDateLabel(date);
  return new Date(`${label}T00:00:00+08:00`);
}
