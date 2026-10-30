import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { stdin, stdout } from 'node:process';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from './db.js';

function promptForHiddenValue(prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('Run this command directly in Terminal so it can securely prompt for a password.'));
  }

  stdout.write(prompt);
  stdin.setEncoding('utf8');
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          cleanup();
          reject(new Error('Password entry cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = Array.from(value).slice(0, -1).join('');
          continue;
        }
        if (character >= ' ') value += character;
      }
    };
    stdin.on('data', onData);
  });
}

const args = process.argv.slice(2);
const userSchema = z.object({
  loginId: z.string().trim().min(4).max(100),
  name: z.string().trim().min(2).max(120),
  role: z.enum(['candidate', 'center', 'official']),
});

const input = userSchema.safeParse({
  loginId: args[0],
  name: args[1],
  role: args[2],
});

if (!input.success) {
  console.error('Usage: npm run user:create -- <login-id> <display-name> <candidate|center|official>');
  process.exitCode = 1;
} else {
  try {
    const password = await promptForHiddenValue('Choose a password (12-128 characters; input is hidden): ');
    const validatedPassword = z.string().min(12).max(128).safeParse(password);
    if (!validatedPassword.success) {
      throw new Error('Password must be between 12 and 128 characters. Run the command again with a longer password.');
    }

    const confirmation = await promptForHiddenValue('Type the same password again to confirm: ');
    if (password !== confirmation) {
      throw new Error('Passwords do not match. Run the command again.');
    }

    const { loginId, name, role } = input.data;
    const passwordHash = await bcrypt.hash(password, 12);
    await pool.query(
      'INSERT INTO users (id, login_id, display_name, role, password_hash) VALUES ($1, $2, $3, $4, $5)',
      [randomUUID(), loginId.toUpperCase(), name, role, passwordHash],
    );
    console.log(`Created ${role} account ${loginId.toUpperCase()}.`);
  } catch (error) {
    console.error('Could not create user:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
