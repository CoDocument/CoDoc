// Test file for dependency graph construction

export function validateInput(data: string): boolean {
  return data.length > 0;
}

export function parseData(input: string): any {
  if (!validateInput(input)) {
    throw new Error('Invalid input');
  }
  return JSON.parse(input);
}

export function processData(rawData: string): any {
  const parsed = parseData(rawData);
  return formatOutput(parsed);
}

function formatOutput(data: any): string {
  return JSON.stringify(data, null, 2);
}
