// Makes an admin token: prints the token (give it to the admin) and the line for the
// admins credential file (only the hash is stored on the server).
//   node src/admin-token.js <name>
import { createHash, randomBytes } from 'node:crypto';

const name = process.argv[2];
if (!name || !/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
  console.error('usage: node src/admin-token.js <name>   (letters, digits, _ or -)');
  process.exit(1);
}
const token = randomBytes(24).toString('base64url');
console.log(`token (give to the admin):  ${token}`);
console.log(`admins line (server):       ${name}:${createHash('sha256').update(token).digest('hex')}`);
