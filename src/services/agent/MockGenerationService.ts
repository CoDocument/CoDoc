import * as vscode from 'vscode';
import * as path from 'path';

/**
 * MockGenerationService
 * 
 * Simulates AI code generation by creating files and functions step-by-step
 * Used for testing feedback decorations without OpenCode service
 */
export class MockGenerationService {
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Run the mock generation sequence based on example scenario
   * Creates files/folders incrementally with delays to show decorations building up
   */
  async runMockGeneration(onProgress?: (step: string) => void): Promise<void> {
    try {
      // Step 0: Ensure initial state (create placeholder files that will be modified/moved)
      onProgress?.('Setting up initial state...');
      await this.setupInitialState();
      await this.delay(1000);

      // Step 1: Generate Register.tsx
      onProgress?.('Generating Register.tsx...');
      await this.generateRegisterFile();
      await this.delay(1500);

      // Step 2: Generate Login.tsx
      onProgress?.('Generating Login.tsx...');
      await this.generateLoginFile();
      await this.delay(1500);

      // Step 3: Generate hashPSWD.ts (moved to utils folder)
      onProgress?.('Generating hashPSWD.ts...');
      await this.generateHashPasswordFile();
      await this.delay(1500);

      // Step 4: Modify App.tsx
      onProgress?.('Modifying App.tsx...');
      await this.modifyAppFile();
      await this.delay(1000);

      onProgress?.('Generation complete!');
    } catch (error) {
      console.error('Mock generation error:', error);
      throw error;
    }
  }

  /**
   * Step 0: Setup initial state with placeholder files
   */
  private async setupInitialState(): Promise<void> {
    // Create initial hashPSWD.ts in root src (will be moved to utils later)
    const initialHashPath = path.join(this.workspaceRoot, 'src', 'hashPSWD.ts');
    
    const initialHashContent = `/**
 * Simple password hashing (to be enhanced)
 */

export async function hashPassword(password: string): Promise<string> {
  // Basic implementation
  return btoa(password);
}
`;

    await this.ensureDirectoryExists(path.dirname(initialHashPath));
    await this.writeFile(initialHashPath, initialHashContent);
  }

  /**
   * Step 1: Create Register.tsx with functions (replaces component with functions)
   */
  private async generateRegisterFile(): Promise<void> {
    const filePath = path.join(this.workspaceRoot, 'src', 'components', 'Register.tsx');
    
    const content = `import React, { useState } from 'react';

export function Register() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  async function checkEmailExists(email: string): Promise<boolean> {
    // Check if email already exists in database
    const response = await fetch(\`/api/users/check-email?email=\${email}\`);
    const data = await response.json();
    return data.exists;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    
    // Validate email
    const emailExists = await checkEmailExists(email);
    if (emailExists) {
      alert('Email already registered');
      return;
    }

    // Submit registration
    const response = await fetch('/api/users/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    if (response.ok) {
      alert('Registration successful!');
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <input 
        type="email" 
        value={email} 
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
      />
      <input 
        type="password" 
        value={password} 
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
      />
      <button type="submit">Register</button>
    </form>
  );
}
`;

    await this.ensureDirectoryExists(path.dirname(filePath));
    await this.writeFile(filePath, content);
  }

  /**
   * Step 2: Create Login.tsx with functions
   */
  private async generateLoginFile(): Promise<void> {
    const filePath = path.join(this.workspaceRoot, 'src', 'components', 'Login.tsx');
    
    const content = `import React, { useState } from 'react';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [attempts, setAttempts] = useState(0);

  async function checkLockout(email: string): Promise<boolean> {
    // Check if user is locked out due to failed attempts
    const response = await fetch(\`/api/users/check-lockout?email=\${email}\`);
    const data = await response.json();
    return data.isLockedOut;
  }

  async function authenticateUser(email: string, password: string): Promise<boolean> {
    // Authenticate user credentials
    const response = await fetch('/api/users/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    return response.ok;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    
    // Check lockout status
    const isLockedOut = await checkLockout(email);
    if (isLockedOut) {
      alert('Account locked due to too many failed attempts');
      return;
    }

    // Authenticate
    const isAuthenticated = await authenticateUser(email, password);
    if (isAuthenticated) {
      alert('Login successful!');
      setAttempts(0);
    } else {
      setAttempts(prev => prev + 1);
      alert('Invalid credentials');
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <input 
        type="email" 
        value={email} 
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
      />
      <input 
        type="password" 
        value={password} 
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
      />
      <button type="submit">Login</button>
      {attempts > 0 && <p>Failed attempts: {attempts}</p>}
    </form>
  );
}
`;

    await this.writeFile(filePath, content);
  }

  /**
   * Step 3: Create hashPSWD.ts in utils folder (moved location)
   */
  private async generateHashPasswordFile(): Promise<void> {
    // Delete old location
    const oldPath = path.join(this.workspaceRoot, 'src', 'hashPSWD.ts');
    try {
      const oldUri = vscode.Uri.file(oldPath);
      await vscode.workspace.fs.delete(oldUri);
    } catch {
      // File might not exist, ignore
    }

    // Create in new location
    const filePath = path.join(this.workspaceRoot, 'src', 'utils', 'hashPSWD.ts');
    
    const content = `/**
 * Password hashing utilities using Web Crypto API
 */

export function generateSalt(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return arrayBufferToHex(array.buffer);
}

export function stringToArrayBuffer(str: string): ArrayBuffer {
  const encoder = new TextEncoder();
  return encoder.encode(str).buffer;
}

export function arrayBufferToHex(buffer: ArrayBuffer): string {
  const byteArray = new Uint8Array(buffer);
  const hexCodes = [...byteArray].map(value => {
    const hexCode = value.toString(16);
    return hexCode.padStart(2, '0');
  });
  return hexCodes.join('');
}

export async function deriveKey(password: string, salt: string): Promise<CryptoKey> {
  const passwordBuffer = stringToArrayBuffer(password);
  const saltBuffer = stringToArrayBuffer(salt);
  
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    { name: 'PBKDF2' },
    false,
    ['deriveBits', 'deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBuffer,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

export async function hashPassword(password: string, salt?: string): Promise<string> {
  const useSalt = salt || generateSalt();
  const key = await deriveKey(password, useSalt);
  const exportedKey = await crypto.subtle.exportKey('raw', key);
  return \`\${useSalt}:\${arrayBufferToHex(exportedKey)}\`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [salt, _] = hash.split(':');
  const newHash = await hashPassword(password, salt);
  return newHash === hash;
}

export async function createPasswordHash(password: string): Promise<{ hash: string; salt: string }> {
  const salt = generateSalt();
  const hash = await hashPassword(password, salt);
  return { hash, salt };
}

export function isCryptoSupported(): boolean {
  return typeof crypto !== 'undefined' && 
         typeof crypto.subtle !== 'undefined' &&
         typeof crypto.getRandomValues !== 'undefined';
}

export function validatePasswordStrength(password: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (password.length < 8) {
    errors.push('Password must be at least 8 characters');
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain uppercase letter');
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain lowercase letter');
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain number');
  }
  
  return { valid: errors.length === 0, errors };
}
`;

    await this.ensureDirectoryExists(path.dirname(filePath));
    await this.writeFile(filePath, content);
  }

  /**
   * Step 4: Modify App.tsx to add routing logic
   */
  private async modifyAppFile(): Promise<void> {
    const filePath = path.join(this.workspaceRoot, 'src', 'App.tsx');
    
    const content = `import React, { useState } from 'react';
import { Register } from './components/Register';
import { Login } from './components/Login';

export function App() {
  const [currentView, setCurrentView] = useState<'login' | 'register'>('login');

  function renderCurrentView() {
    switch (currentView) {
      case 'login':
        return <Login />;
      case 'register':
        return <Register />;
      default:
        return <Login />;
    }
  }

  return (
    <div className="app">
      <nav>
        <button onClick={() => setCurrentView('login')}>Login</button>
        <button onClick={() => setCurrentView('register')}>Register</button>
      </nav>
      <main>
        {renderCurrentView()}
      </main>
    </div>
  );
}
`;

    await this.writeFile(filePath, content);
  }

  /**
   * Helper: Ensure directory exists
   */
  private async ensureDirectoryExists(dirPath: string): Promise<void> {
    const uri = vscode.Uri.file(dirPath);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      await vscode.workspace.fs.createDirectory(uri);
    }
  }

  /**
   * Helper: Write file content
   */
  private async writeFile(filePath: string, content: string): Promise<void> {
    const uri = vscode.Uri.file(filePath);
    const contentBytes = Buffer.from(content, 'utf8');
    await vscode.workspace.fs.writeFile(uri, contentBytes);
  }

  /**
   * Helper: Delay for visual effect
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
