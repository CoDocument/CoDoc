// Test file that imports from utils

import { processData, validateInput } from './utils';

export function handleRequest(request: string): string {
  if (!validateInput(request)) {
    return 'Invalid request';
  }
  
  const result = processData(request);
  return result;
}

export function logRequest(request: string): void {
  console.log('Request:', request);
  handleRequest(request);
}
